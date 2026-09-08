import { Popover } from "@base-ui/react/popover";
import { SparkleIcon, TagIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
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
import { LabelChip } from "@/features/conversations/Thread";
import { useFinishAndSurface } from "@/features/conversations/useAiStream";
import { required, useAppForm } from "@/lib/form";
import {
  useAddSubIssue,
  useCreateIssue,
  useForgeStatus,
  useRepoLabels,
} from "@/lib/git/queries";
import type { ForgeUserRef, IssueType, RemoteLens } from "@/lib/git/types";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { useRemoteSlug } from "@/lib/repo-lens/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import {
  AssigneesPopover,
  IssueTypeMenu,
  MilestoneMenu,
} from "./IssueMetaPickers";
import { useGenerateIssueDraft } from "./useGenerateIssueDraft";

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
  /** The lens the metadata pickers below were filled under. */
  const stateLensRef = useRef(lens);

  const form = useAppForm({
    defaultValues: { title: "", body: "" },
    onSubmit: async ({ value }) => {
      // Once the remote issue exists, the sub-issue link failing must NOT re-arm
      // the submit — retrying would open a duplicate. Track it so the catch can
      // disclose instead of re-running.
      let created: { number: number; url: string } | null = null;
      try {
        const { number, url } = await createIssue.mutateAsync({
          title: value.title.trim(),
          body: value.body,
          labels: [...labels],
          assignees: assignees.map((a) => a.id),
          milestone,
          type: issueType?.name ?? null,
        });
        created = { number, url };
        const action = { label: "View", onClick: () => openUrl(url) };
        if (subIssueParentId && number > 0) {
          // Link the new issue to its parent, then stay on the parent so it
          // appears in the sub-issue list (GitHub's behavior).
          await addSubIssue.mutateAsync({
            parentId: subIssueParentId,
            subNumber: number,
          });
          toast.success(`Created sub-issue #${number}`, {
            description: url,
            action,
          });
          onOpenChange(false);
          return;
        }
        toast.success(`Opened issue #${number}`, { description: url, action });
        onOpenChange(false);
        if (number > 0) selectIssue({ kind: "remote", id: String(number) });
      } catch (e) {
        if (created === null) {
          // The create itself failed — retrying is correct, keep the dialog open.
          toastError(e);
          return;
        }
        // The remote issue already exists but linking it as a sub-issue failed.
        // Close the dialog (leaving it open is a duplicate factory) and disclose.
        const { number, url } = created;
        onOpenChange(false);
        toast.error(
          `Created issue #${number}, but linking as a sub-issue failed: ${errorMessage(e)}`,
          {
            duration: 10000,
            action: { label: "View", onClick: () => openUrl(url) },
          },
        );
      }
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
      // Label sets, assignee ids, milestone numbers and org issue types are local
      // to the create target, and the lens can move while a kept draft holds the
      // seed off: the prose survives that switch, the picks can't.
      if (stateLensRef.current !== lens) {
        setLabels(new Set());
        setAssignees([]);
        setMilestone(null);
        setIssueType(null);
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
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {isUpstream && !subIssueParentId && (
              <p className="text-xs text-muted-foreground">
                This opens an issue on the upstream repository, not your fork.
              </p>
            )}
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the issue"
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
