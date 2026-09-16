import { Popover } from "@base-ui/react/popover";
import { KanbanIcon, SparkleIcon, TagIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { LabeledGroup } from "@/components/form/labeled-group";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NO_ACCESS_REASON,
  projectScopeMissing,
  projectScopeReadOnly,
  READ_ONLY_SCOPE_REASON,
  ScopeGapBlock,
} from "@/features/conversations/ProjectsPopover";
import { LabelChip } from "@/features/conversations/Thread";
import { useFinishAndSurface } from "@/features/conversations/useAiStream";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { required, useAppForm } from "@/lib/form";
import { useActiveGhHost } from "@/lib/git/host";
import {
  useAddIssueToProjects,
  useAddSubIssue,
  useAvailableProjects,
  useCreateIssue,
  useForgeStatus,
  useGhScopes,
  useRepoLabels,
} from "@/lib/git/queries";
import type {
  ForgeUserRef,
  IssueType,
  ProjectV2Ref,
  RemoteLens,
} from "@/lib/git/types";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useRemoteSlug } from "@/lib/repo-lens/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import {
  AssigneesPopover,
  IssueTypeMenu,
  MilestoneMenu,
} from "./IssueMetaPickers";
import { useGenerateIssueDraft } from "./useGenerateIssueDraft";

/** One clause of the post-create disclosure, per link that can fail after the issue
 *  exists. The create itself succeeded in every case, which is why none of them
 *  re-arms the submit — and why more than one can fail in a single run, so these
 *  compose into a list rather than naming a single culprit. The plural arm is its
 *  own entry rather than a patched string: "the project" over two picked boards
 *  names the wrong thing. */
const LINK_FAILED: Record<"project" | "projects" | "sub-issue", string> = {
  project: "adding it to the project failed",
  projects: "adding it to the projects failed",
  "sub-issue": "linking as a sub-issue failed",
};

export function CreateIssueDialog({
  repoPath,
  lens,
  open,
  onOpenChange,
  initialDraft,
  subIssueParentId,
}: {
  repoPath: string;
  /** The issues surface's origin|upstream lens. Under "upstream" the issue is
   *  created ON THE PARENT — the dialog reframes to say so. */
  lens: RemoteLens;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seeds title/body (and labels, when duplicating) when opened — e.g.
   *  "Reference in new issue" or "Duplicate issue". */
  initialDraft?: { title: string; body: string; labels?: string[] };
  /** When set, the created issue is linked as a sub-issue of this node id
   *  (parent), and the view stays on the parent instead of navigating away. */
  subIssueParentId?: string;
}) {
  const createIssue = useCreateIssue(repoPath, lens);
  const addSubIssue = useAddSubIssue(repoPath, lens);
  const repoLabels = useRepoLabels(repoPath, open, lens);
  // Under the upstream lens the issue is created ON THE PARENT; name that repo
  // (the parent slug) so the create framing is unambiguous.
  const isUpstream = lens === "upstream";
  const parentSlug = useRemoteSlug(repoPath, "upstream", open && isUpstream);
  // The org issue type is a GitHub-only picker; the shared fields
  // (title/body/labels/assignees/milestone) work on both providers.
  const forge = useForgeStatus(repoPath);
  const isGitLab = forge.data?.provider === "gitlab";
  const remoteLabel = isGitLab ? "GitLab" : "GitHub";
  // The create target's display name: the parent slug under the upstream lens
  // (falling back to "the upstream repository" while it loads), else the forge.
  const targetLabel = isUpstream
    ? (parentSlug ?? "the upstream repository")
    : remoteLabel;
  const selectIssue = useUiStore((s) => s.selectIssue);
  const repoName = useUiStore((s) => s.repoName) ?? "";
  const aiEnabled = useAiEnabled();
  const { generate, cancel, generating } = useGenerateIssueDraft(repoPath);
  // Closing mid-generation never cancels the run: it finishes into the retained
  // form state, and this surfaces the result while the dialog is away.
  const surface = useFinishAndSurface(repoPath, open, {
    cancel,
    generating,
    close: () => onOpenChange(false),
    readyTitle: "Issue draft ready",
    readyDescription: "It's waiting in the dialog.",
    reopen: () => onOpenChange(true),
  });
  const [labels, setLabels] = useState<Set<string>>(new Set());
  const [assignees, setAssignees] = useState<ForgeUserRef[]>([]);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [issueType, setIssueType] = useState<IssueType | null>(null);
  // The picks carry their OWN records rather than being re-derived from the
  // catalog each render, the shape LinkedIssuesField's chips keep. A background
  // refetch can drop a board the user already picked (closed or deleted upstream),
  // and deriving the chips from the catalog made that pick vanish from the band
  // while its id stayed in the submit — invisible, unremovable, still sent. Held
  // here, the chip stands until the user removes it; if the board really is gone,
  // the add fails and the post-create disclosure names it. In PICK order, which is
  // also the one order a catalog refetch can't reshuffle.
  const [pickedProjects, setPickedProjects] = useState<ProjectV2Ref[]>([]);
  /** The lens the metadata pickers below were filled under. */
  const stateLensRef = useRef(lens);

  // The Projects row is GitHub-only and ORIGIN-only. `!isGitLab` would be the wrong
  // gate on both counts: Bitbucket mounts issue surfaces in some states and has no
  // Projects at all, and an upstream-lens issue is created on the PARENT, whose
  // boards are not the ones this catalog lists. Hidden there rather than wrong;
  // the PR flow is where an upstream item's boards are reachable.
  const isGitHub = forge.data?.provider === "github";
  const showProjects = isGitHub && lens === "origin";
  const ghHost = useActiveGhHost();
  const scopes = useGhScopes(ghHost);
  const openReconnect = useUiStore((s) => s.openReconnect);
  // The same gate every other Projects surface reads, so none fires a read another
  // one withholds.
  const projectScopeGap = projectScopeMissing(scopes.data);
  const projectReadOnly = projectScopeReadOnly(scopes.data);
  // The catalog is an owner-wide query; it waits for a first open of THIS popover
  // rather than firing for every issue the user drafts — the latch the shipped
  // Projects picker keeps, for the same cost. Unreset across dialog opens, also
  // like the sibling: a second open re-reads a cache it already paid for.
  const [projectsOpened, setProjectsOpened] = useState(false);
  const projects = useAvailableProjects(
    repoPath,
    open && showProjects && projectsOpened && !projectScopeGap,
    lens,
  );
  const addToProjects = useAddIssueToProjects();
  // Closed boards are out for the same reason the board's own switcher drops them:
  // a board nobody is working stands between the user and the one they came for.
  const openProjects = (projects.data?.projects ?? []).filter((p) => !p.closed);
  // Picked boards leave the list — the band already shows them, and a row that
  // can't change anything is noise in a popover this short. (LinkedIssuesField's
  // `exclude` set, one surface over.)
  const pickedProjectIds = new Set(pickedProjects.map((p) => p.id));
  const pickableProjects = openProjects.filter(
    (p) => !pickedProjectIds.has(p.id),
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // EVERY pickable row is navigable, held ones included — these rows are the
  // raw-button arm of the disabled-reason contract, which keeps a blocked control
  // focusable precisely so its reason can be reached and announced. Skipping them
  // is the rule for a NATIVELY-disabled control (the checkbox rows this band
  // replaced, which can't take focus at all); applying it here would put the
  // explanation out of keyboard reach, and under a read-only token — where every
  // row is held — it would drop the whole list out of the tab order. Activation
  // stays blocked in the row's own handler.
  const navProjects = pickableProjects;
  const navProjectIndex = new Map(navProjects.map((p, i) => [p.id, i]));
  const activeProjectIndex =
    activeProjectId === null
      ? -1
      : (navProjectIndex.get(activeProjectId) ?? -1);
  const onProjectKeyDown = listKeyboardNav<ProjectV2Ref>({
    items: navProjects,
    activeIndex: activeProjectIndex,
    onActivate: (p) => setActiveProjectId(p.id),
    rowKey: (p) => p.id,
  });
  const reconnectForProjectScope = () =>
    openReconnect({
      provider: "github",
      host: ghHost,
      mode: "refresh",
      scopes: ["project"],
    });
  // One remedy, one wording. Both scope arms — a sign-in with no project scope at
  // all, and a read-only one — are missing the same `project` scope and ask for it
  // the same way; only WHERE the block renders differs.
  const projectScopeRemedy = (
    <ScopeGapBlock host={ghHost} onReconnect={reconnectForProjectScope}>
      Adding an issue to a project needs the{" "}
      <span className="font-mono">project</span> scope, which your GitHub
      sign-in is missing.
    </ScopeGapBlock>
  );

  const form = useAppForm({
    defaultValues: { title: "", body: "" },
    onSubmit: async ({ value }) => {
      let created: { number: number; url: string };
      try {
        created = await createIssue.mutateAsync({
          title: value.title.trim(),
          body: value.body,
          labels: [...labels],
          assignees: assignees.map((a) => a.id),
          milestone,
          type: issueType?.name ?? null,
        });
      } catch (e) {
        // The create itself failed — nothing exists yet, so retrying is correct
        // and the dialog stays open holding the draft. This is the ONLY arm that
        // re-arms the submit; past it the issue is real and a second submit would
        // open a duplicate.
        toastError(e);
        return;
      }
      const { number, url } = created;
      const action = { label: "View", onClick: () => openUrl(url) };
      /** Open the new issue — but only if the app is still where it was created.
       *  Every path below sits after at least one await, and the dialog is closed
       *  by then; this one doesn't register the modal gate, so a chord can switch
       *  repos inside that window. `selectIssue` carries NO repo identity, so it
       *  would select this NUMBER in whatever repo is active now — somewhere else
       *  that is an unrelated issue, or a missing-issue view. The guard is the
       *  continuation rule's own shape, and the same one `CreateDiscussionDialog`
       *  puts on its post-create navigate.
       *
       *  The TOAST stays unconditional wherever the user ended up: it names the
       *  issue and carries its URL, which are true from any repo. */
      function openCreatedIssue() {
        if (number <= 0) return;
        if (useUiStore.getState().repoPath !== repoPath) return;
        selectIssue({ kind: "remote", id: String(number) });
      }
      // The post-create links are INDEPENDENT of each other: a board refusing the
      // issue says nothing about whether its parent will take it, so each runs on
      // its own and reports into `failed` rather than throwing past the other. A
      // shared try/catch let the first failure cancel the second link silently.
      // `number > 0` guards both — a forge that answered without one names no
      // issue to link.
      const failed: string[] = [];
      const addProjectIds = pickedProjects.map((p) => p.id);
      if (showProjects && addProjectIds.length > 0 && number > 0) {
        try {
          await addToProjects.mutateAsync({
            repo: repoPath,
            number,
            addProjectIds,
            lens,
          });
        } catch (e) {
          const key = addProjectIds.length === 1 ? "project" : "projects";
          failed.push(`${LINK_FAILED[key]}: ${errorMessage(e)}`);
        }
      }
      let subIssueLinked = false;
      if (subIssueParentId && number > 0) {
        try {
          await addSubIssue.mutateAsync({
            parentId: subIssueParentId,
            subNumber: number,
          });
          subIssueLinked = true;
        } catch (e) {
          failed.push(`${LINK_FAILED["sub-issue"]}: ${errorMessage(e)}`);
        }
      }
      // Closed either way: the issue exists, and leaving the dialog open over a
      // draft that already shipped is a duplicate factory.
      onOpenChange(false);
      if (failed.length > 0) {
        // Every failure in one message, so a run that lost both links doesn't
        // report one and hide the other.
        toast.error(`Created issue #${number}, but ${failed.join("; ")}`, {
          duration: 10000,
          action,
        });
        // The issue EXISTS whatever the links did, so it still opens — the same
        // navigate the clean path makes, under the same gate. A sub-issue keeps
        // its parent on screen either way (GitHub's own behavior).
        if (!subIssueParentId) openCreatedIssue();
        return;
      }
      if (subIssueLinked) {
        // Stay on the parent so the new issue appears in its sub-issue list
        // (GitHub's own behavior) — no navigate.
        toast.success(`Created sub-issue #${number}`, {
          description: url,
          action,
        });
        return;
      }
      toast.success(`Opened issue #${number}`, { description: url, action });
      openCreatedIssue();
    },
  });

  // Live title/body drive the AI drafter's input and its enabled state.
  const titleVal = useSelector(form.store, (s) => s.values.title);
  const bodyVal = useSelector(form.store, (s) => s.values.body);
  const notes = [titleVal, bodyVal].filter(Boolean).join("\n\n");

  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // reset values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    // The only host that seeds this dialog clears its request at close, so a
    // draft present here is always a fresh explicit ask (duplicate, reference)
    // and outranks any waiting or streaming run.
    const isNewRequest = initialDraft !== undefined;
    if (isNewRequest) {
      if (generating) cancel();
      void surface.consumeSkipSeed();
    } else if (surface.shouldSkipSeed(generating)) {
      // A generation still streaming — or one that settled while the dialog was
      // closed — leaves the whole draft in form state, which this reset would
      // blank on reopen.
      // Label sets, assignee ids, milestone numbers, org issue types and project
      // boards are all local to the create target, and the lens can move while a
      // kept draft holds the seed off: the prose survives that switch, the picks
      // can't. The boards doubly so — the row itself is origin-only.
      if (stateLensRef.current !== lens) {
        setLabels(new Set());
        setAssignees([]);
        setMilestone(null);
        setIssueType(null);
        setPickedProjects([]);
        stateLensRef.current = lens;
      }
      return;
    }
    form.reset(
      { title: initialDraft?.title ?? "", body: initialDraft?.body ?? "" },
      { keepDefaultValues: true },
    );
    setLabels(new Set(initialDraft?.labels ?? []));
    setAssignees([]);
    setMilestone(null);
    setIssueType(null);
    setPickedProjects([]);
    stateLensRef.current = lens;
  });
  useSeedOnOpen(open, seedOnOpen);

  function toggleLabel(name: string, on: boolean) {
    setLabels((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function pickProject(project: ProjectV2Ref) {
    setPickedProjects((prev) =>
      prev.some((p) => p.id === project.id) ? prev : [...prev, project],
    );
  }

  function removeProject(id: string) {
    setPickedProjects((prev) => prev.filter((p) => p.id !== id));
  }

  /** What the Projects popup shows instead of rows, or null when the rows stand.
   *  Ranked: a scope gap the picker can't work around, then a failed read, then
   *  the first load — an UNSETTLED read is not the same claim as a settled empty
   *  one, so "no open projects" waits for a complete answer. */
  const projectsNotice = (() => {
    switch (true) {
      case projectScopeGap:
        return projectScopeRemedy;
      case projects.error !== null:
        return (
          <div className="px-1 py-1 text-xs">
            <p className="text-muted-foreground">
              {presentError(projects.error).summary}
            </p>
            <Button
              variant="outline"
              size="xs"
              className="mt-1.5"
              onClick={() => void projects.refetch()}
            >
              Retry
            </Button>
          </div>
        );
      // A DISABLED query is permanently "pending", so this arm may only be read
      // where the query is live: the scope-gap arm above takes the one state that
      // withholds it, and this popup renders only inside an open dialog.
      case projects.isPending:
        return (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            Loading projects…
          </p>
        );
      case openProjects.length === 0:
        return (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            No open projects in this repository or its owner.
          </p>
        );
      // Distinct from the line above: this board HAS projects, they are all
      // already on the band, and saying "none" here would contradict the chips
      // one popover away.
      case pickableProjects.length === 0:
        return (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            Every open project is already picked.
          </p>
        );
      default:
        return null;
    }
  })();

  const selectedChips = (repoLabels.data ?? []).filter((l) =>
    labels.has(l.name),
  );

  // Shared by the Draft-with-AI button and the generate chord below.
  async function runGenerate() {
    // `generate` resolves void and fires onResult only on a usable draft, so the
    // flag is how the settle learns whether a result actually landed.
    let ok = false;
    // finally: a throw past the stream (draft extraction, these field writes)
    // must still settle, or the switch-abort latch stays armed for the next run.
    try {
      await generate({
        notes,
        repoName,
        onResult: (d) => {
          ok = true;
          if (d.title) form.setFieldValue("title", d.title);
          form.setFieldValue("body", d.body);
        },
      });
    } finally {
      surface.noteRunSettled(ok);
    }
  }
  // The generate chord drafts this issue while the dialog is open. It's mounted
  // on DialogContent, not the <form>: the X close button is a form SIBLING
  // inside the Popup, so a form-level handler would miss a chord pressed with
  // focus on X. It is swallowed here whenever it may fire (the hook mirrors the
  // global listener's own guards), so the global generate-commit-message action
  // can't run behind the dialog; while generating it swallows but DOESN'T
  // cancel.
  const generateChord = useGenerateChord({
    enabled: aiEnabled && !generating && notes.trim() !== "",
    run: runGenerate,
  });
  // The one submit gate, shared by the button and the form's native submit:
  // Enter must submit exactly when the button would.
  const submitBlocked = generating;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        onKeyDown={generateChord.onKeyDown}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (submitBlocked) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {subIssueParentId
                ? "Create sub-issue"
                : isUpstream
                  ? `New issue in ${targetLabel}`
                  : "Create issue"}
            </DialogTitle>
            <DialogDescription>
              {subIssueParentId
                ? "Opens a new issue on GitHub and links it as a sub-issue."
                : isUpstream
                  ? `Opens a new issue on ${targetLabel} (the upstream repository), not your fork.`
                  : `Opens a new issue on ${remoteLabel} for this repository.`}
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; the header and submit footer stay pinned so a long
              body or many metadata pickers can't push the dialog off-screen. */}
          <div className={cn(DIALOG_SCROLL, "min-h-0 flex-1 space-y-4")}>
            {isUpstream && !subIssueParentId && (
              <p className="text-xs text-muted-foreground">
                This opens an issue on the upstream repository, not your fork.
              </p>
            )}
            {/* Labels and assignees sit ABOVE the title, the shape CreatePrDialog
                keeps. Milestone, issue type and projects stay below the
                description: those are the pickers a draft is filed under once it
                says something, where these two are what you reach for while
                writing it. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Popover.Root>
                <Popover.Trigger
                  render={
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label="Add labels"
                    />
                  }
                >
                  <TagIcon data-icon="inline-start" />
                  Labels
                </Popover.Trigger>
                {/* Bare on purpose: this component's body renders above
                    DialogContent's PanelPortalReset, so a
                    usePanelPortalContainer() call here returns the panel
                    container and the popup would land behind the dialog
                    backdrop. (Pickers rendered as children inside the
                    dialog read undefined.) */}
                <Popover.Portal>
                  <Popover.Positioner
                    align="start"
                    sideOffset={4}
                    className="isolate z-50"
                  >
                    <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                      <p className="px-1 pb-1.5 text-xs font-medium">Labels</p>
                      {(repoLabels.data ?? []).length === 0 && (
                        <p className="px-1 py-1 text-xs text-muted-foreground">
                          {repoLabels.isPending
                            ? "Loading labels…"
                            : "This repository has no labels."}
                        </p>
                      )}
                      {(repoLabels.data ?? []).map((label) => (
                        <label
                          key={label.name}
                          className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
                        >
                          <Checkbox
                            checked={labels.has(label.name)}
                            onCheckedChange={(v) =>
                              toggleLabel(label.name, v === true)
                            }
                          />
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: `#${label.color}` }}
                          />
                          <span className="flex-1 truncate" title={label.name}>
                            {label.name}
                          </span>
                        </label>
                      ))}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              {selectedChips.map((label) => (
                <LabelChip key={label.name} label={label} />
              ))}
            </div>
            <AssigneesPopover
              repoPath={repoPath}
              enabled={open}
              value={assignees}
              lens={lens}
              onChange={setAssignees}
            />
            <MilestoneMenu
              repoPath={repoPath}
              enabled={open}
              value={milestone}
              lens={lens}
              onChange={setMilestone}
            />
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the issue"
                  // Explicit now that pickers sit above it. The dialog used to
                  // land focus here by accident — the title was simply the first
                  // focusable thing in the body — and the reorder would otherwise
                  // have opened the dialog with the Labels trigger focused.
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Description"
                  placeholder="Jot down rough notes, then draft with AI"
                  rows={8}
                  textareaClassName="max-h-72 min-h-24 resize-y font-mono"
                  actions={
                    !aiEnabled ? undefined : generating ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={cancel}
                      >
                        <XIcon data-icon="inline-start" />
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={!notes.trim()}
                        onClick={runGenerate}
                        // The chord is only offered while it would do something —
                        // a disabled Generate's shortcut is dead too.
                        title={
                          notes.trim()
                            ? `Expand your notes into a structured issue with AI${generateChord.hint}`
                            : "Expand your notes into a structured issue with AI"
                        }
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Draft with AI
                      </Button>
                    )
                  }
                />
              )}
            </form.AppField>
            {showProjects && (
              <ProjectsField
                picked={pickedProjects}
                rows={pickableProjects}
                notice={projectsNotice}
                readOnlyReason={
                  projectReadOnly ? READ_ONLY_SCOPE_REASON : undefined
                }
                scopeNotice={
                  projectReadOnly && !projectScopeGap
                    ? projectScopeRemedy
                    : null
                }
                truncated={projects.data?.truncated === true}
                rovingRowId={
                  navProjects[
                    activeProjectIndex === -1 ? 0 : activeProjectIndex
                  ]?.id ?? null
                }
                onRowsKeyDown={onProjectKeyDown}
                onRowFocus={setActiveProjectId}
                onPickerOpen={() => setProjectsOpened(true)}
                onPick={pickProject}
                onRemove={removeProject}
              />
            )}
            {!isGitLab && (
              <IssueTypeMenu
                repoPath={repoPath}
                enabled={open}
                value={issueType}
                lens={lens}
                onChange={setIssueType}
              />
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton disabled={submitBlocked}>
                {subIssueParentId
                  ? "Create sub-issue"
                  : isUpstream
                    ? `Create in ${targetLabel}`
                    : "Create issue"}
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One board's PICK row in the create dialog's Projects popover. Picking adds the
 *  chip and closes the popup, so the row is a button rather than a checkbox — the
 *  band below the caption is what carries the current set. Held rather than hidden
 *  when it can't be picked, through the raw-button arm of the disabled-reason
 *  contract, which keeps the row focusable so a keyboard reader is told WHY instead
 *  of finding a gap. `lockedReason` holds EVERY row (a read-only token) and
 *  outranks the per-board `viewerCanUpdate` one — the shipped picker's ranking. */
function ProjectPickRow({
  project,
  lockedReason,
  rovingTab,
  onPick,
  onFocus,
}: {
  project: ProjectV2Ref;
  lockedReason?: string;
  /** Roving tabindex: one tab stop for the whole list, on the active row. */
  rovingTab: number;
  onPick: () => void;
  onFocus: () => void;
}) {
  const held =
    lockedReason ?? (project.viewerCanUpdate ? undefined : NO_ACCESS_REASON);
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: held !== undefined,
      reason: held,
      onClick: onPick,
    });
  return (
    <button
      type="button"
      {...nativeProps}
      data-row={project.id}
      tabIndex={rovingTab}
      onFocus={onFocus}
      title={wrapperTitle}
      aria-describedby={describedBy}
      className={cn(
        "flex w-full items-center gap-2 px-1 py-1.5 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring",
        blockedReason && "cursor-not-allowed",
        ARIA_DISABLED_CLASS,
      )}
    >
      <KanbanIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {/* No clip title while the row is HELD: it would land on the child and win
          hover over the button's own `wrapperTitle`, hiding the reason behind the
          project's name.

          KEYED on that state because the flip is reachable in place — a scopes
          refetch moves `lockedReason`, a catalog refetch moves `viewerCanUpdate` —
          and `clipTitleFromText` writes the attribute IMPERATIVELY. A row hovered
          while live and then held would keep that stale title with no mouse-enter
          left to clear it, so the node itself is replaced instead. */}
      <span
        key={blockedReason === null ? "live" : "held"}
        className="min-w-0 flex-1 truncate"
        onMouseEnter={blockedReason === null ? clipTitleFromText : undefined}
      >
        {project.title}
      </span>
      {blockedReason !== null && (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      )}
    </button>
  );
}

/**
 * The Projects band: the boards a new issue joins on create, as chips with an
 * "Add to project" picker opposite the caption. Structurally `LinkedIssuesField`'s
 * Jira variant — the mention-only one, since a project membership has no keyword to
 * toggle either: a single tab stop across the chips, ArrowLeft/Right to move,
 * Delete/Backspace to remove with focus handed to the chip that slides into the
 * slot, and X buttons out of the tab order behind it.
 *
 * Presentational. The dialog owns the catalog read, the scope gates and the picked
 * set, so the picker's own states arrive here already resolved.
 */
function ProjectsField({
  picked,
  rows,
  notice,
  scopeNotice,
  readOnlyReason,
  truncated,
  rovingRowId,
  onRowsKeyDown,
  onRowFocus,
  onPickerOpen,
  onPick,
  onRemove,
}: {
  /** The chips, in pick order, each carrying its own record — a board that leaves
   *  the catalog keeps its chip and stays removable. */
  picked: ProjectV2Ref[];
  /** The pickable rows — the catalog minus what's already on the band. */
  rows: ProjectV2Ref[];
  /** What the popover shows INSTEAD of rows (scope gap, error, loading, empty). */
  notice: ReactNode | null;
  /** The read-only-scope remedy, rendered ABOVE live rows rather than instead of
   *  them: the reads work, so the boards are worth showing even held. */
  scopeNotice: ReactNode | null;
  readOnlyReason?: string;
  truncated: boolean;
  /** The row that holds the list's single tab stop, or null when none can. */
  rovingRowId: string | null;
  onRowsKeyDown: (e: KeyboardEvent) => void;
  onRowFocus: (id: string) => void;
  /** Arms the owner-wide catalog read on the picker's FIRST open. */
  onPickerOpen: () => void;
  /** Takes the whole record, not its id: the chip carries its own title so a
   *  catalog refetch can't take a picked board off the band. */
  onPick: (project: ProjectV2Ref) => void;
  onRemove: (id: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Roving tabindex: the band is a single tab stop; ArrowLeft/Right move the roved
  // index, which sets which chip is focusable + focused.
  const [focusIndex, setFocusIndex] = useState(0);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Clamp the roved index at point of use: chips can shrink via the mouse ✕ without
  // touching `focusIndex`, and a stale index past the end would render EVERY chip
  // tabIndex=-1 — the band would drop out of the tab order entirely.
  const effectiveFocusIndex = Math.max(
    0,
    Math.min(focusIndex, picked.length - 1),
  );

  function focusChip(index: number) {
    const clamped = Math.max(0, Math.min(index, picked.length - 1));
    setFocusIndex(clamped);
    chipRefs.current[clamped]?.focus();
  }

  /**
   * Move focus to whatever survives removing the chip at `index`, BEFORE it goes.
   * Every removal route calls this and then removes — the keyboard's Delete and the
   * pointer's ✕ alike, which is why the selection lives here rather than in either.
   *
   * INSIDE A MODAL, FOCUS THE NEXT TARGET SYNCHRONOUSLY, BEFORE UNMOUNTING THE
   * FOCUSED ELEMENT. A deferred handoff loses: Base UI's dialog focus containment
   * recaptures to the dialog CONTAINER the moment a focused child unmounts, and that
   * recapture beat a one-rAF claim on both branches below (measured twice — the
   * empty-band case, then the surviving-chip case). Moving focus first makes the
   * race unwinnable rather than merely faster: nothing that is about to unmount is
   * the active element, so the containment never fires. Both targets are already
   * mounted here, which is what lets this do without `requestAnimationFrame`.
   *
   * The pointer path needs it for the same reason the keyboard path does, not a
   * weaker one: Chromium focuses a button on mousedown, so a clicked ✕ IS the
   * focused element when the removal unmounts it.
   *
   * `from` is any node still inside the band — the chip for Delete, the ✕ for a
   * click — and only has to be in the tree long enough for the `closest` walk.
   */
  function handOffFocusBeforeRemoving(index: number, from: HTMLElement) {
    const nextCount = picked.length - 1;
    if (nextCount === 0) {
      // Nothing survives in the row, so focus goes to the picker trigger — which is
      // where re-adding starts anyway.
      from
        .closest<HTMLElement>('[role="group"]')
        ?.querySelector<HTMLElement>("[data-add-project-trigger]")
        ?.focus();
      return;
    }
    // The chip that will slide into this slot, addressed at its CURRENT index:
    // removing `index` shifts everything after it left by one, so the survivor is
    // the next chip — except when the last of several goes, where it is the previous
    // one. Both are mounted now; only their index changes.
    const survivor = index < picked.length - 1 ? index + 1 : index - 1;
    chipRefs.current[survivor]?.focus();
    // The index that survivor will OCCUPY, so the roving tab stop still names the
    // focused chip after the list re-renders. Set on the pointer path too: the tab
    // stop and the focused chip must be the same chip whichever route removed one,
    // or a later Tab back into the band lands somewhere the user never was.
    setFocusIndex(Math.min(index, nextCount - 1));
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const chip = picked[index];
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < picked.length - 1) focusChip(index + 1);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      handOffFocusBeforeRemoving(index, e.currentTarget);
      onRemove(chip.id);
    }
    // Enter/Space intentionally do nothing — a membership has no state to toggle.
  }

  return (
    <LabeledGroup
      label="Projects"
      className="space-y-1.5"
      actions={
        <Popover.Root
          open={pickerOpen}
          onOpenChange={(o) => {
            setPickerOpen(o);
            if (o) onPickerOpen();
          }}
        >
          <Popover.Trigger
            render={
              // Marked so removing the LAST chip can hand focus here: a ref would
              // have to survive Base UI's own ref on the trigger, where the
              // attribute rides the same prop path as the `aria-label` beside it.
              <Button
                data-add-project-trigger=""
                variant="outline"
                size="xs"
                aria-label="Add to project"
              />
            }
          >
            <KanbanIcon data-icon="inline-start" />
            Add to project
          </Popover.Trigger>
          {/* Bare on purpose: this body renders above DialogContent's
              PanelPortalReset, so a usePanelPortalContainer() call here would
              return the panel container and land the popup behind the dialog
              backdrop. (The Labels picker above keeps the same note.) */}
          <Popover.Portal>
            <Popover.Positioner
              align="end"
              sideOffset={4}
              className="isolate z-50"
            >
              <Popover.Popup className="w-72 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                <p className="px-1 pb-1.5 text-xs font-medium">
                  Add to project
                </p>
                {scopeNotice !== null && (
                  <div className="mb-1 border-b pb-1">{scopeNotice}</div>
                )}
                {notice ?? (
                  <div
                    className="max-h-64 overflow-y-auto"
                    onKeyDown={onRowsKeyDown}
                  >
                    {rows.map((project) => (
                      <ProjectPickRow
                        key={project.id}
                        project={project}
                        lockedReason={readOnlyReason}
                        rovingTab={project.id === rovingRowId ? 0 : -1}
                        onPick={() => {
                          setPickerOpen(false);
                          onPick(project);
                        }}
                        onFocus={() => onRowFocus(project.id)}
                      />
                    ))}
                  </div>
                )}
                {truncated && (
                  <p className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                    Some projects aren't shown.
                  </p>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      }
    >
      {picked.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {picked.map((project, index) => (
              <span
                key={project.id}
                className="inline-flex items-center gap-1 border py-0.5 pr-0.5 pl-1.5 text-xs"
              >
                <KanbanIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  ref={(el) => {
                    chipRefs.current[index] = el;
                  }}
                  tabIndex={index === effectiveFocusIndex ? 0 : -1}
                  aria-label={`${project.title}. Press Delete to remove.`}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={(e) => onChipKeyDown(e, index)}
                  className="inline-flex cursor-default items-center gap-1 rounded-none outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                >
                  <span
                    className="max-w-40 truncate"
                    onMouseEnter={clipTitleFromText}
                  >
                    {project.title}
                  </span>
                </button>
                {/* Out of the tab order — the chip's own Delete is the keyboard
                    route — but it still hands focus on before removing: a click
                    FOCUSES this button first, so without the handoff it is the
                    focused node being unmounted and the dialog recaptures. */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  aria-label={`Remove ${project.title}`}
                  className="text-muted-foreground"
                  onClick={(e) => {
                    handOffFocusBeforeRemoving(index, e.currentTarget);
                    onRemove(project.id);
                  }}
                >
                  <XIcon />
                </Button>
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Added to these projects on create.
          </p>
        </>
      )}
    </LabeledGroup>
  );
}
