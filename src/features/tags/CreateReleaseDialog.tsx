import {
  CaretDownIcon,
  GitBranchIcon,
  GitCommitIcon,
  PlusIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LabeledGroup } from "@/components/form/labeled-group";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useCancelOnIdentityChange,
  useFinishAndSurface,
} from "@/features/conversations/useAiStream";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import { useAppForm } from "@/lib/form";
import { normPath } from "@/lib/git/path";
import {
  useBranches,
  useCreateRelease,
  useForgeStatus,
  useGithubReleaseNotes,
  useRecentCommits,
  useRepoStatus,
  useTagList,
} from "@/lib/git/queries";
import type { CommitSummary, GeneratedNotes } from "@/lib/git/types";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { useGenerateReleaseNotes } from "./useGenerateReleaseNotes";
import { findPreviousTag } from "./version";

const RELEASE_DEFAULTS = {
  tag: "",
  title: "",
  notes: "",
  target: "",
  prerelease: false,
  latest: false,
  draft: false,
};

/**
 * Creates a GitHub release. The tag is a combobox — pick an existing tag, or
 * type a new one and click "Create new tag" to persist it (a Base UI combobox
 * reverts a free-typed value on blur, so the new tag must become a real item).
 * A newly-created tag exposes the tabbed Target picker (branches / recent
 * commits, à la GitHub). Notes can be hand-written (live Preview) or generated
 * from GitHub's auto-notes / AI relative to a previous tag we resolve via semver
 * and let the user override. Form state lives in `useAppForm`; the previous tag
 * is generation-only (not a create input) so it stays derived local state.
 */
export function CreateReleaseDialog({
  repoPath,
  open,
  onOpenChange,
  initialTag,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill + lock the tag (creating a release for an existing tag). */
  initialTag?: string;
}) {
  const createRelease = useCreateRelease(repoPath);
  const githubNotes = useGithubReleaseNotes(repoPath);
  const aiNotes = useGenerateReleaseNotes(repoPath);
  const busyGenerating = githubNotes.isPending || aiNotes.generating;
  // The dialog is retained across repo AND tag switches, so nothing a run settles
  // may write this form or skip its seed for the identity now on screen: the
  // GitHub mutation validates start-vs-live identity; the AI stream is cancelled
  // at the switch and its settle swallowed.
  const tagIdentity = initialTag ?? "";
  const liveTagRef = useRef(tagIdentity);
  useLayoutEffect(() => {
    liveTagRef.current = tagIdentity;
  }, [tagIdentity]);
  const settleTagRef = useRef(tagIdentity);
  // Closing mid-generation never cancels the run: it finishes into the retained
  // form state, and this surfaces the result while the dialog is away. Both
  // hosts pass a plain open setter, so `onOpenChange(true)` reopens.
  const surface = useFinishAndSurface(repoPath, open, {
    cancel: aiNotes.cancel,
    // The AI stream alone: the From-GitHub mutation is not what a switch aborts.
    generating: aiNotes.generating,
    close: () => onOpenChange(false),
    readyTitle: "Release notes ready",
    readyDescription: "They're waiting in the dialog.",
    reopen: () => {
      // A tag switch drains the latch, so the notes are gone — say so instead of
      // opening an emptied dialog. Inert in TagsPanel, whose tagIdentity is "".
      if (liveTagRef.current !== settleTagRef.current) {
        toast.info(
          `Those notes were for ${settleTagRef.current} — they were discarded when you switched tags.`,
        );
        return;
      }
      onOpenChange(true);
    },
  });
  const tagSwitchAbortRef = useRef(false);
  useCancelOnIdentityChange(tagIdentity, () => {
    void surface.consumeSkipSeed();
    tagSwitchAbortRef.current = aiNotes.generating;
    aiNotes.cancel();
  });
  // The From-GitHub run's identity while it is in flight; nothing cancels it.
  const ghRunIdentityRef = useRef<{ repo: string; tag: string } | null>(null);
  const ghRunIsForThisIdentity = () => {
    const run = ghRunIdentityRef.current;
    return (
      run !== null && run.repo === normPath(repoPath) && run.tag === tagIdentity
    );
  };
  // GitLab has no draft/pre-release/latest concepts and no auto-notes API, so
  // those checkboxes and the "From GitHub" generator hide there (AI notes still
  // work — they fall back to local commits).
  const releaseProvider = useForgeStatus(repoPath).data?.provider;
  const isGitLab = releaseProvider === "gitlab";
  // GitHub (or an unrecognized host that still routes through gh) is the only
  // provider with an auto-changelog API — gates the `gh` call in the AI hook.
  const isGitHub =
    releaseProvider !== "gitlab" && releaseProvider !== "bitbucket";
  // Release notes autolink the same `@`/`#`/`!` references a comment does.
  // Releases are repo-wide, so the candidate lists come off origin.
  const mentions = useMentionCandidates({
    repoPath,
    lens: "origin",
    provider: releaseProvider,
  });
  const status = useRepoStatus(repoPath);
  const tagList = useTagList(repoPath);
  const branches = useBranches(repoPath);
  const recent = useRecentCommits(repoPath, 50, open);
  const aiEnabled = useAiEnabled();
  const selectTag = useUiStore((s) => s.selectTag);
  const repoName = useUiStore((s) => s.repoName) ?? "";
  const branch = status.data?.branch?.name ?? "";
  const existingTags = tagList.data ?? [];
  const tagNames = existingTags.map((t) => t.name);

  // Ephemeral UI state (not release inputs): the tag combobox's created entries
  // and open state, the previous-tag override (null = use the resolved default),
  // and which notes tab is showing.
  const [createdTags, setCreatedTags] = useState<string[]>([]);
  const [tagOpen, setTagOpen] = useState(false);
  const [previousTagOverride, setPreviousTagOverride] = useState<string | null>(
    null,
  );
  const notesEditorRef = useRef<MarkdownEditorHandle>(null);

  const form = useAppForm({
    defaultValues: RELEASE_DEFAULTS,
    onSubmit: async ({ value }) => {
      const tag = value.tag.trim();
      if (!tag) return;
      const hasTarget = !initialTag && createdTags.includes(tag);
      try {
        const url = await createRelease.mutateAsync({
          tag,
          title: value.title.trim(),
          notes: value.notes,
          target: hasTarget ? value.target.trim() : "",
          prerelease: value.prerelease,
          draft: value.draft,
          latest: value.latest,
        });
        toast.success(value.draft ? "Draft saved" : `Released ${tag}`, {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        });
        onOpenChange(false);
        // Adopt the new release's tag only while this repo is still on screen —
        // the create can settle after a repo switch.
        if (useUiStore.getState().repoPath === repoPath) selectTag({ tag });
      } catch (e) {
        toastError(e);
      }
    },
  });

  const tag = useSelector(form.store, (s) => s.values.tag);
  const target = useSelector(form.store, (s) => s.values.target);
  const notes = useSelector(form.store, (s) => s.values.notes);
  const draft = useSelector(form.store, (s) => s.values.draft);
  const tagTrimmed = tag.trim();

  // The tag combobox items must include user-created tags so a typed value
  // persists past blur. "Create" shows while the typed value is genuinely new.
  const tagItems = [...createdTags, ...tagNames].map((name) => ({ name }));
  const isExistingTag = tagNames.includes(tagTrimmed);
  const canCreate =
    !!tagTrimmed && !isExistingTag && !createdTags.includes(tagTrimmed);
  // Target only matters for a NEW (created) tag — and only once it's persisted,
  // so interacting with the target can't revert the tag input.
  const showTarget = !initialTag && createdTags.includes(tagTrimmed);

  // Previous tag for generated notes: the user's override, else the semver
  // resolution. Derived (not effect-synced) so it can't go stale across reopens.
  const defaultPreviousTag = findPreviousTag(tagTrimmed, tagNames);
  const previousTag = previousTagOverride ?? defaultPreviousTag;
  const effectivePreviousTag = tagNames.includes(previousTag.trim())
    ? previousTag.trim()
    : "";

  const seedOnOpen = useEffectEvent(() => {
    // A generation still streaming — or one that settled while the dialog was
    // closed — leaves the notes and the rest of the draft in form state, which
    // this reset would blank on reopen.
    if (
      surface.shouldSkipSeed(
        aiNotes.generating && !tagSwitchAbortRef.current,
      ) ||
      (githubNotes.isPending && ghRunIsForThisIdentity())
    )
      return;
    form.reset(
      {
        ...RELEASE_DEFAULTS,
        tag: initialTag ?? "",
        target: initialTag ? "" : branch,
      },
      { keepDefaultValues: true },
    );
    setCreatedTags([]);
    setPreviousTagOverride(null);
    // The editor remounts with the dialog (Write tab) — no explicit reset needed.
  });
  useSeedOnOpen(open, seedOnOpen);

  function createNewTag(name: string) {
    const n = name.trim();
    if (!n) return;
    if (!isExistingTag && !createdTags.includes(n)) {
      setCreatedTags((p) => [n, ...p]);
    }
    form.setFieldValue("tag", n);
    setTagOpen(false);
  }

  // Awaited like the submit above: react-query drops per-call callbacks once the
  // observer loses listeners, and this dialog's host panel hides with its tab
  // while generation is still in flight.
  async function generateFromGithub() {
    if (!tagTrimmed) return;
    const requestedFor = tagTrimmed;
    // This mutation outlives both axes, and no identity-cancel can abort it.
    const startRepo = normPath(repoPath);
    const startTag = tagIdentity;
    const switchedAway = () =>
      normPath(useUiStore.getState().repoPath ?? "") !== startRepo ||
      liveTagRef.current !== startTag;
    ghRunIdentityRef.current = { repo: startRepo, tag: startTag };
    let gen: GeneratedNotes;
    try {
      gen = await githubNotes.mutateAsync({
        tag: requestedFor,
        target: showTarget ? target.trim() : "",
        previousTag: effectivePreviousTag,
      });
    } catch (e) {
      if (switchedAway()) return;
      toastError(e);
      // Still a settle: the typed draft has to survive one reopen for a retry.
      surface.noteRunSettled(false);
      return;
    } finally {
      // The run is over on every arm, the foreign-refused ones included.
      ghRunIdentityRef.current = null;
    }
    // Nothing below awaits, so this one check covers every settle arm that follows.
    if (switchedAway()) return;
    // The response belongs to the tag it was requested for — a reseeded or
    // retyped form is another release, and stale notes must not touch it.
    if (form.getFieldValue("tag").trim() !== requestedFor) {
      surface.noteRunSettled(false);
      return;
    }
    if (gen.body) form.setFieldValue("notes", gen.body);
    if (gen.name && !form.getFieldValue("title").trim()) {
      form.setFieldValue("title", gen.name);
    }
    notesEditorRef.current?.showPreview();
    // Only a body is notes "waiting in the dialog" — a name-only response has
    // nothing for the toast to promise.
    settleTagRef.current = startTag;
    surface.noteRunSettled(Boolean(gen.body));
  }

  function generateWithAi() {
    if (!tagTrimmed) return;
    // Same requestedFor rule as From-GitHub: a retyped form is another release.
    const requestedFor = tagTrimmed;
    form.setFieldValue("notes", "");
    aiNotes
      .generate({
        tag: requestedFor,
        target: showTarget ? target.trim() : requestedFor,
        previousTag: effectivePreviousTag,
        repoName,
        isGitHub,
        onResult: (body) => {
          if (form.getFieldValue("tag").trim() === requestedFor) {
            form.setFieldValue("notes", body);
          }
        },
      })
      .then(
        (final) => {
          // The tag switch's own abort settles here — swallow it, never re-latch.
          // Exactly one swallow consumes a settle; the repo flag can't also arm
          // while tag hosts unmount on a repo switch — else, per-run tokens.
          if (tagSwitchAbortRef.current) {
            tagSwitchAbortRef.current = false;
            return;
          }
          if (form.getFieldValue("tag").trim() !== requestedFor) {
            surface.noteRunSettled(false);
            return;
          }
          // Resolves with the COMPLETE notes, or null — an aborted stream still
          // fired `onResult` with its partials, so that can't be the signal.
          settleTagRef.current = tagIdentity;
          surface.noteRunSettled(final !== null);
        },
        // Two-arm, never a trailing .catch: a settle must be reported exactly
        // once, and a throw in the arm above must not report a second time. The
        // swallow repeats here — only a settle clears the flag.
        () => {
          if (tagSwitchAbortRef.current) {
            tagSwitchAbortRef.current = false;
            return;
          }
          surface.noteRunSettled(false);
        },
      );
  }

  // The generate chord drives the AI item only — never the From-GitHub one, and
  // it never opens the dropdown. Mounted on DialogContent, not the <form>: the X
  // close button is a form SIBLING inside the Popup. It is swallowed here
  // whenever it may fire (the hook mirrors the global listener's own guards),
  // so the global generate-commit-message action can't run behind the dialog;
  // while generating it swallows but DOESN'T cancel.
  const generateChord = useGenerateChord({
    enabled: aiEnabled && Boolean(tagTrimmed) && !busyGenerating,
    run: generateWithAi,
  });
  // The chord's shortcut belongs on the item it drives; with AI off that item is
  // disabled and says why instead.
  const aiNotesHintTitle = generateChord.hint
    ? `Summarize with AI${generateChord.hint}`
    : undefined;
  const aiNotesTitle = aiEnabled
    ? aiNotesHintTitle
    : "Enable AI in Settings first.";

  // The one submit gate, shared by the button and the form's native submit:
  // Enter must submit exactly when the button would.
  const submitBlocked = !tagTrimmed || busyGenerating;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A fixed height (not a cap): release bodies routinely run thousands of
          lines, so the notes editor claims the dialog's whole spare height. */}
      <DialogContent
        className="flex h-[85vh] flex-col sm:max-w-2xl"
        onKeyDown={generateChord.onKeyDown}
      >
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (submitBlocked) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {initialTag ? `Release ${initialTag}` : "New release"}
            </DialogTitle>
            <DialogDescription>
              Publishes a {isGitLab ? "GitLab" : "GitHub"} release. A new tag is
              created from the target on publish.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rel-tag">Tag</Label>
                {initialTag ? (
                  <Input
                    id="rel-tag"
                    value={tag}
                    disabled
                    className="font-mono"
                  />
                ) : (
                  <Combobox
                    items={tagItems}
                    itemToStringLabel={(t: { name: string }) => t.name}
                    inputValue={tag}
                    onInputValueChange={(v: string) =>
                      form.setFieldValue("tag", v)
                    }
                    value={tagItems.find((t) => t.name === tagTrimmed) ?? null}
                    onValueChange={(t: { name: string } | null) =>
                      t && form.setFieldValue("tag", t.name)
                    }
                    open={tagOpen}
                    onOpenChange={setTagOpen}
                    openOnInputClick
                  >
                    <ComboboxInput
                      className="w-full font-mono"
                      placeholder="v1.2.0"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>
                        {canCreate ? null : "No matching tags."}
                      </ComboboxEmpty>
                      <ComboboxList>
                        {(t: { name: string }) => (
                          <ComboboxItem key={t.name} value={t}>
                            <span className="truncate font-mono">{t.name}</span>
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                      {canCreate && (
                        <button
                          type="button"
                          onClick={() => createNewTag(tagTrimmed)}
                          className="flex w-full items-center gap-1.5 border-t px-2 py-2 text-left text-xs hover:bg-accent"
                        >
                          <PlusIcon className="size-3.5 shrink-0" />
                          Create new tag{" "}
                          <span className="font-mono">{tagTrimmed}</span> on
                          release
                        </button>
                      )}
                    </ComboboxContent>
                  </Combobox>
                )}
              </div>
              {showTarget && (
                <LabeledGroup label="Target" className="space-y-1.5">
                  <TargetPicker
                    // Agent-session branches are app-internal — never a release
                    // target (same rule as BranchSwitcher).
                    branches={(branches.data ?? [])
                      .map((b) => b.name)
                      .filter((n) => !n.startsWith("gd/session/"))}
                    commits={recent.data ?? []}
                    value={target}
                    onChange={(v) => form.setFieldValue("target", v)}
                  />
                </LabeledGroup>
              )}
            </div>

            <form.AppField name="title">
              {(field) => (
                <field.TextField
                  label="Title (optional)"
                  placeholder={tagTrimmed || "Release title"}
                />
              )}
            </form.AppField>

            {/* `space-y-0` cancels LabeledGroup's default child margin, which
                would ADD to this group's own `gap-1.5` (tailwind-merge doesn't
                dedupe space-y against gap). */}
            <LabeledGroup
              label="Release notes"
              className="flex flex-1 flex-col gap-1.5 space-y-0"
              actions={
                existingTags.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="shrink-0">Previous tag</span>
                    <Combobox
                      items={tagNames.map((name) => ({ name }))}
                      itemToStringLabel={(t: { name: string }) => t.name}
                      inputValue={previousTag}
                      onInputValueChange={setPreviousTagOverride}
                      value={
                        existingTags.find(
                          (t) => t.name === previousTag.trim(),
                        ) ?? null
                      }
                      onValueChange={(t: { name: string } | null) =>
                        setPreviousTagOverride(t ? t.name : "")
                      }
                      openOnInputClick
                    >
                      <ComboboxInput
                        className="h-7 w-64 font-mono text-xs"
                        placeholder="Automatic"
                      />
                      <ComboboxContent>
                        <ComboboxEmpty>No matching tags.</ComboboxEmpty>
                        <ComboboxList>
                          {(t: { name: string }) => (
                            <ComboboxItem key={t.name} value={t}>
                              <span className="truncate font-mono">
                                {t.name}
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  </div>
                )
              }
            >
              <MarkdownEditor
                ref={notesEditorRef}
                aria-label="Release notes"
                value={notes}
                onChange={(v) => form.setFieldValue("notes", v)}
                placeholder="What's changed… (or generate notes above)"
                fill
                // No `rows`/`resize-y` in fill mode: the explicit floor plus
                // `flex-1` set the height, and a manual drag fights the flex sizing.
                textareaClassName="min-h-32 font-mono"
                mentions={mentions}
                actions={
                  // GitLab's only generator is the AI one — with AI hidden the
                  // menu would hold a single disabled item, so hide it entirely.
                  isGitLab && !aiEnabled ? undefined : busyGenerating ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => aiNotes.cancel()}
                    >
                      {githubNotes.isPending ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <XIcon data-icon="inline-start" />
                      )}
                      {githubNotes.isPending ? "Generating…" : "Cancel"}
                    </Button>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={!tagTrimmed}
                          />
                        }
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Generate notes
                        <CaretDownIcon data-icon="inline-end" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-56">
                        {!isGitLab && (
                          <DropdownMenuItem
                            onClick={() => void generateFromGithub()}
                          >
                            From GitHub (commits & PRs)
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          disabled={!aiEnabled}
                          title={aiNotesTitle}
                          onClick={generateWithAi}
                        >
                          Summarize with AI
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                }
              />
            </LabeledGroup>

            {/* GitLab computes "latest" itself and has no pre-release/draft. */}
            {!isGitLab && (
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <form.AppField name="latest">
                  {(field) => (
                    <field.CheckboxField
                      label="Set as the latest release"
                      className="flex cursor-pointer items-center gap-2 text-xs"
                    />
                  )}
                </form.AppField>
                <form.AppField name="prerelease">
                  {(field) => (
                    <field.CheckboxField
                      label="Pre-release"
                      className="flex cursor-pointer items-center gap-2 text-xs"
                    />
                  )}
                </form.AppField>
                <form.AppField name="draft">
                  {(field) => (
                    <field.CheckboxField
                      label="Save as draft"
                      className="flex cursor-pointer items-center gap-2 text-xs"
                    />
                  )}
                </form.AppField>
              </div>
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
                {draft ? "Save draft" : "Publish release"}
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * GitHub-style release target picker: a button that opens a popover with a
 * filter and Branches / Recent Commits tabs. Picking a row sets the target and
 * closes. Arrow keys move within the active tab's list.
 */
function TargetPicker({
  branches,
  commits,
  value,
  onChange,
}: {
  branches: string[];
  commits: CommitSummary[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"branches" | "commits">("branches");
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const q = filter.trim().toLowerCase();
  const isBranch = branches.includes(value);
  const selectedCommit = commits.find((c) => c.hash === value);

  const rows: { key: string; node: React.ReactNode }[] =
    tab === "branches"
      ? branches
          .filter((b) => b.toLowerCase().includes(q))
          .map((b) => ({
            key: b,
            node: (
              <>
                <GitBranchIcon className="shrink-0 text-muted-foreground" />
                <span className="truncate font-mono">{b}</span>
              </>
            ),
          }))
      : commits
          .filter(
            (c) => c.hash.startsWith(q) || c.subject.toLowerCase().includes(q),
          )
          .map((c) => ({
            key: c.hash,
            node: (
              <>
                <GitCommitIcon className="mt-0.5 shrink-0 self-start text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.subject}</span>
                  <span className="text-muted-foreground">
                    <span className="font-mono">{c.hash.slice(0, 7)}</span> ·{" "}
                    <RelativeTime date={c.date} />
                  </span>
                </span>
              </>
            ),
          }));

  function pick(key: string) {
    onChange(key);
    setOpen(false);
  }

  const onKeyDown = listKeyboardNav({
    items: rows,
    activeIndex,
    onActivate: (_row, to) => setActiveIndex(to),
    rowKey: (r) => r.key,
  });

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setFilter("");
          setActiveIndex(-1);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-2 font-normal"
          />
        }
      >
        {isBranch ? (
          <GitBranchIcon className="shrink-0 text-muted-foreground" />
        ) : (
          <GitCommitIcon className="shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-mono">
          {value
            ? isBranch
              ? value
              : `${value.slice(0, 7)}${
                  selectedCommit ? ` ${selectedCommit.subject}` : ""
                }`
            : "Choose a target"}
        </span>
        <CaretDownIcon className="ml-auto shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-0">
        <div className="p-2">
          <Input
            autoFocus
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActiveIndex(-1);
            }}
            placeholder={
              tab === "branches" ? "Filter branches…" : "Filter recent commits…"
            }
            className="h-8"
          />
        </div>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as "branches" | "commits");
            setActiveIndex(-1);
          }}
        >
          <TabsList variant="line" className="px-2">
            <TabsTrigger value="branches">Branches</TabsTrigger>
            <TabsTrigger value="commits">Recent Commits</TabsTrigger>
          </TabsList>
          <TabsContent value={tab} className="mt-0">
            <div onKeyDown={onKeyDown} className="max-h-64 overflow-y-auto p-1">
              {rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  data-row={r.key}
                  onClick={() => pick(r.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      pick(r.key);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs outline-hidden hover:bg-accent focus:bg-accent",
                    value === r.key && "bg-accent/50",
                  )}
                >
                  {r.node}
                </button>
              ))}
              {rows.length === 0 && (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No matches.
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
