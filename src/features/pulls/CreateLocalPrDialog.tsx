import { SparkleIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffectEvent, useRef } from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CREATE_PENDING_GENERATE_REASON,
  useFinishAndSurface,
} from "@/features/conversations/useAiStream";
import { REVIEWER_NOTES_MARKER } from "@/lib/ai/notes-context";
import { triggerAutomations } from "@/lib/automations/runner";
import { required, useAppForm } from "@/lib/form";
import {
  forgeFeatureReady,
  useBranchAhead,
  useDefaultBranch,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { updateLocalPr } from "@/lib/pulls/local";
import { useCreateLocalPr } from "@/lib/pulls/queries";
import { deleteReviewNote } from "@/lib/review-notes/store";
import { useAiEnabled } from "@/lib/settings/queries";
import { originNoteFor } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import {
  toastComposedError,
  toastError,
  toastErrorWithNote,
} from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { LinkedIssuesField } from "./LinkedIssuesField";
import { ReviewerNotesField } from "./ReviewerNotesField";
import { useBranchPickerOptions } from "./useBranchPickerOptions";
import { useGeneratePrDescription } from "./useGeneratePrDescription";
import {
  composeBodyWithRefs,
  useLinkedIssueChips,
} from "./useLinkedIssueChips";

// Rendered exactly ONCE, hoisted in RepositoryView — never render it inside a tab
// panel. Its success handler's `setRepoTab("pulls")` conceals a panel host with the
// tab it left, so the close and unmount would wait until that tab is next shown.
export function CreateLocalPrDialog({
  repoPath,
  defaultBase,
  defaultHead,
  open,
  onOpenChange,
}: {
  repoPath: string;
  defaultBase?: string;
  defaultHead?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useRepoStatus(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const createPr = useCreateLocalPr(repoPath);
  const { generate, cancel, generating } = useGeneratePrDescription(repoPath);
  const aiEnabled = useAiEnabled();
  // Closing mid-generation never cancels the run: it finishes into the retained
  // form state, and this surfaces the result while the dialog is away. The host's
  // onOpenChange only ever CLOSES, so the reopen goes through the store action —
  // seedless, since the skip-seed latch keeps the retained draft.
  const surface = useFinishAndSurface(repoPath, open, {
    cancel,
    generating,
    close: () => onOpenChange(false),
    readyTitle: "PR description ready",
    readyDescription: "It's waiting in the dialog.",
    reopen: () => useUiStore.getState().openLocalPrCreate(),
  });
  // Linked issues: real repo issues to reference. A local PR's `Closes #N` lines
  // survive promotion verbatim into the real forge PR, so these become real
  // closing refs later — intended. Non-AI surface (shown under Hide-AI too),
  // gated only on the forge having a usable issue tracker.
  const ghStatus = useForgeStatus(repoPath);
  const canLinkIssues =
    !!ghStatus.data && forgeFeatureReady(ghStatus.data, "issues");
  const selectPr = useUiStore((s) => s.selectPr);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const queryClient = useQueryClient();
  // Which draft the form holds, bumped only where the seed actually reseeds. A
  // repo check can't tell drafts apart within one repo: closing and reopening
  // mid-create puts a fresh draft behind the same path.
  const seedGenRef = useRef(0);
  // Which repo's draft the form holds, stamped on every open: the dialog is
  // hoisted in RepositoryView and outlives a repository switch.
  const draftRepoRef = useRef(repoPath);

  const currentName = status.data?.branch?.name ?? null;
  // Retained on `open`, not on the values: an unseeded next open must resync to
  // undefined (before the seed effect runs) instead of leaving the previous
  // open's archived branch listed and selectable in both pickers.
  const shownDefaultHead = useRetained(defaultHead, open);
  const shownDefaultBase = useRetained(defaultBase, open);
  // Branch options with per-branch worktree chips; drops the app-internal
  // `gd/session/*` branches (a local PR must never target one) and archived
  // branches, matching BranchSwitcher. `keep` retains the seeded defaults even
  // if archived, so the head/base defaults stay selectable.
  const { names, items, annotations } = useBranchPickerOptions(repoPath, open, [
    currentName,
    shownDefaultHead,
    shownDefaultBase,
    defaultBranch.data,
  ]);

  const form = useAppForm({
    defaultValues: { head: "", base: "", title: "", body: "", notes: "" },
    validators: {
      // Same branch on both sides proposes nothing — gate the submit.
      onChange: ({ value }) =>
        value.head === value.base ? "Pick two different branches." : undefined,
    },
    onSubmit: async ({ value }) => {
      const submitGen = seedGenRef.current;
      try {
        // Append the linked-issue chips as their exact keyword lines via the
        // shared composer (the single ref-block composition every create/edit
        // save path uses). These `Closes #N` lines carry into a later promotion,
        // and the review event below reads the same composed body.
        const finalBody = composeBodyWithRefs(value.body, linkedIssues);
        const pr = await createPr.mutateAsync({
          title: value.title.trim(),
          body: finalBody,
          base: value.base,
          head: value.head,
        });
        const notes = value.notes.trim();
        // Reviewer notes are an AI-only surface (the field renders only when AI
        // is enabled), so append + consume are gated on `aiEnabled` — Hide-AI
        // adds no comment and consumes no deposit (no behavior change).
        if (aiEnabled) {
          // Append the author's reviewer notes as the local PR's first comment —
          // the marker header + blank line + notes, matching the remote wire
          // shape (notes-context.ts lifts them by that marker). Author-authored
          // shape (no synthetic `author`, mirroring useLocalConversation
          // .addComment), so it renders as the user's own comment. The
          // `updateLocalPr` path reloads disk first, so a concurrent write is
          // merged, not clobbered. For local PRs the event below is the ONLY
          // notes carrier the review sees (the runner's marker-comment fetchers
          // are remote-only), so this comment is for the user, not the AI.
          if (notes) {
            try {
              await updateLocalPr(repoPath, pr.id, (cur) => ({
                ...cur,
                comments: [
                  ...cur.comments,
                  {
                    id: crypto.randomUUID(),
                    body: `${REVIEWER_NOTES_MARKER}\n\n${notes}`,
                    createdAt: new Date().toISOString(),
                  },
                ],
              }));
              await queryClient.invalidateQueries({
                queryKey: ["local-prs", repoPath],
              });
            } catch (e) {
              // Read at settle time, like the success toast below: this can land
              // after a switch, and then names the repo it belongs to.
              toastComposedError({
                title: "Local PR created — adding reviewer notes failed.",
                errors: [e],
                description: originNoteFor(repoPath),
              });
            }
          }
          // Consume the deposit — the create consumed the note. Best-effort.
          void deleteReviewNote(repoPath, value.head).catch(() => undefined);
        }
        // This dialog is retained across repo switches, so a create settling
        // after one would aim the tab, the selection, and the close at whatever
        // repo is live now. The toast fires either way, naming its origin.
        const originNote = originNoteFor(repoPath);
        const stillHere = originNote === undefined;
        toast.success(`Created local PR: ${pr.title}`, {
          description: originNote,
        });
        if (stillHere) {
          setRepoTab("pulls");
          selectPr({ kind: "local", id: pr.id });
          // The generation pins the DRAFT: a close+reopen in this same repo
          // reseeds the form, and this settle must not close that new draft.
          if (seedGenRef.current === submitGen) onOpenChange(false);
        }
        // Local PRs have no draft concept — always fire. The event carries the
        // notes (the runner's marker-comment fetchers are remote-only, so for a
        // local PR this is the sole path the review sees them).
        triggerAutomations({
          kind: "pr-open",
          repoPath,
          base: value.base,
          head: value.head,
          // `ahead` (git log) is newest-first, so the head is the first entry.
          headSha: ahead[0]?.hash,
          title: value.title.trim(),
          body: finalBody,
          commitSubjects: ahead.map((c) => c.subject),
          target: { type: "local", id: pr.id },
          reviewNotes: notes || undefined,
        });
      } catch (e) {
        // Read at the failure, not before it: a create that fails after a repo
        // switch has to name the repo it belongs to, same as the success arm.
        const originNote = originNoteFor(repoPath);
        if (originNote) toastErrorWithNote(e, originNote);
        else toastError(e);
      }
    },
  });

  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // seeded head/base back to empty (untouched form).
  const seedOnOpen = useEffectEvent(() => {
    // A create still running in this repo keeps its draft with Create held; a
    // request naming a head or base still replaces it, and another repo resets.
    const sameRepoInFlight =
      form.state.isSubmitting && draftRepoRef.current === repoPath;
    draftRepoRef.current = repoPath;
    const isNewRequest = defaultHead !== undefined || defaultBase !== undefined;
    // A generation still streaming — or one that settled while the dialog was
    // closed — leaves the whole draft in form state, which this reset would blank
    // on reopen.
    if (surface.shouldSkipSeed(generating)) return;
    if (sameRepoInFlight && !isNewRequest) return;
    seedGenRef.current += 1;
    // Reset the linked-issue chips (and their dismissed/probed refs) to empty —
    // the dialog opens with no seeded body refs; extraction/AI seeding then
    // repopulates from the head branch + commits.
    resetLinkedIssues([]);
    const h = defaultHead ?? currentName ?? names[0] ?? "";
    const fallbackBase =
      defaultBranch.data && defaultBranch.data !== h
        ? defaultBranch.data
        : (names.find((n) => n !== h) ?? "");
    form.reset(
      {
        head: h,
        base: defaultBase ?? fallbackBase,
        title: "",
        body: "",
        // Cleared on open; ReviewerNotesField re-seeds from the head branch's
        // deposit (if any) once its query resolves.
        notes: "",
      },
      { keepDefaultValues: true },
    );
  });
  useSeedOnOpen(open, seedOnOpen);

  // Live head/base drive the "N commits to merge" hint and AI generation.
  const head = useSelector(form.store, (s) => s.values.head);
  const base = useSelector(form.store, (s) => s.values.base);
  // Live notes feed the AI-description prompt and the ReviewerNotesField seeding.
  const notes = useSelector(form.store, (s) => s.values.notes);
  // Both pickers offer local branches only; read them by full ref, as the local-PR
  // commands do, so a same-named tag can't stand in for either.
  const comparison = useBranchAhead(
    repoPath,
    base ? `refs/heads/${base}` : null,
    head ? `refs/heads/${head}` : null,
  );
  const ahead = comparison.data ?? [];
  const sameBranch = base === head;
  // Derived from the live pair's read only, never stored: the count's key carries
  // the pair, so a pair change resets `data` and the hold re-engages. A head
  // already in its base reads as merged the moment it is created.
  const noBase = !sameBranch && base === "";
  const counted = !sameBranch && !noBase;
  const nothingToMerge = counted && comparison.data?.length === 0;
  // A failed background refetch keeps the loaded count; only a read that never
  // answered for this pair counts as failed.
  const counting = counted && comparison.isPending;
  const countFailed = counted && comparison.isLoadingError;

  // Shared chip state machine — enabled while the dialog is open and the tracker
  // is usable. Local PRs have no lens concept, so read the forge's own issues
  // ("origin"). Reset to empty on open (seedOnOpen); extraction/AI seeding then
  // repopulates from the head branch + commits.
  const {
    chips: linkedIssues,
    resetWith: resetLinkedIssues,
    toggleKeyword: toggleIssueKeyword,
    remove: removeIssue,
    pick: pickIssue,
    buildCandidates: buildIssueCandidates,
    upsertFromDraft: upsertAiIssues,
  } = useLinkedIssueChips({
    repoPath,
    lens: "origin",
    enabled: open && canLinkIssues,
    headBranch: head || null,
    commitSubjects: ahead.map((c) => c.subject),
  });

  // AI title+description generation — shared by the Generate button's onClick and
  // the dialog-local generate chord below. Verbatim the button's prior body.
  function runGenerate() {
    generate(
      base,
      head,
      ahead.map((c) => c.subject),
      (d) => {
        form.setFieldValue("title", d.title);
        form.setFieldValue("body", d.body);
        // Union the model's proposed issue links into the chip cluster (same
        // rules as create — relate-default, dismissed-set, AI sparkle).
        upsertAiIssues({ closes: d.closes, relates: d.relates });
      },
      // Local PRs keep the base GitHub prompt wording (no provider) and propose
      // no labels. The trailing args are the author's reviewer notes (reflected
      // into the generated description) and the grounded issue candidates —
      // chips pinned first, then top-ranked open issues.
      undefined,
      [],
      notes.trim() || undefined,
      buildIssueCandidates(),
    ).then(
      // Resolves with the COMPLETE draft, or null on bail/abort/error.
      (final) => surface.noteRunSettled(final !== null),
      // Two-arm, never a trailing .catch: a settle must be reported exactly
      // once, and a throw in the arm above must not report a second time.
      () => surface.noteRunSettled(false),
    );
  }
  // Context-sensitive reuse of the `generate-commit-message` binding while this
  // dialog is open. `run` is undefined with AI off — no Generate surface, so
  // the chord falls through instead of being swallowed for nothing. A running
  // create holds it like the button: the draft it would revise has been sent.
  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
  const generateChord = useGenerateChord({
    enabled:
      !generating && !(sameBranch || ahead.length === 0) && !isSubmitting,
    run: aiEnabled ? runGenerate : undefined,
  });
  const generateHint = generateChord.hint;
  // The one submit gate, shared by the button, the mod+enter chord, and the
  // form's native submit: Enter must submit exactly when the button would. A
  // failed count never holds: it says so and leaves Create enabled.
  const holdReason = (() => {
    switch (true) {
      // An empty pair is no pick at all (no branches to offer); it stays disabled.
      case sameBranch && head !== "":
        return "Pick two different branches.";
      case noBase:
        return "Choose a base branch to merge into.";
      case nothingToMerge:
        return `Nothing to merge: ${head} is already in ${base}.`;
      case counting:
        return "Counting commits to merge…";
      default:
        return null;
    }
  })();
  const submitBlocked = generating || holdReason !== null;
  // A running create holds Create with its reason, ranked above the pair's hold
  // as in CreateIssueDialog, so the held button stays focusable and says why.
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled: submitBlocked || isSubmitting,
      reason: (() => {
        switch (true) {
          case isSubmitting:
            return ACT_PENDING_REASON;
          default:
            return holdReason;
        }
      })(),
      title: SUBMIT_HINT,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // mod+enter submits from anywhere in the dialog. It's captured on
        // DialogContent (the Popup), not the <form>: this dialog is hoisted in
        // RepositoryView and can sit open over the Changes tab, where the global
        // `commit` action (also mod+enter) has a live handler, and the X close
        // button renders as a SIBLING of the form inside the Popup — a chord
        // pressed with focus on the X would otherwise bypass a form-level
        // handler and commit behind the dialog. Capturing on the Popup covers
        // the X and every field, so the UNCONDITIONAL preventDefault here is
        // what actually contains the chord. Submit only when the SubmitButton
        // would be enabled (handleSubmit still enforces the field validators).
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            // Form-core doesn't refuse a submit while one runs, and the render-time
            // flag lags a fast second press, so the live store value decides.
            if (!e.repeat && !submitBlocked && !form.state.isSubmitting)
              form.handleSubmit();
            return;
          }
          // The generate chord runs this dialog's own Generate while it's open.
          // This dialog is hoisted over the Changes tab, where the global
          // generate-commit-message action has a live handler — so while that
          // Generate exists the chord is swallowed whenever it may fire,
          // enabled or not (the hook mirrors the global listener's own guards).
          // With Hide-AI on there's no Generate here at all and the chord falls
          // through instead, which is still safe: the same flag leaves
          // CommitBox's handler DISABLED and the listener only ever runs an
          // enabled one, and off the Changes tab CommitBox registers nothing.
          generateChord.onKeyDown(e);
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (submitBlocked || form.state.isSubmitting) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New local pull request</DialogTitle>
            <DialogDescription>
              Propose merging one branch into another and review it locally.
              Merge it later with a <span className="font-mono">--no-ff</span>{" "}
              commit.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className={cn(DIALOG_SCROLL, "min-h-0 flex-1 space-y-4")}>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-initial">
                <form.AppField name="head">
                  {(field) => (
                    <field.SelectField
                      label="Merge"
                      items={items}
                      annotations={annotations}
                      sizeToContent
                    />
                  )}
                </form.AppField>
              </div>
              <span className="shrink-0 pb-2 text-xs text-muted-foreground">
                into
              </span>
              <div className="min-w-0 flex-initial">
                <form.AppField name="base">
                  {(field) => (
                    <field.SelectField
                      label="Base"
                      items={items}
                      annotations={annotations}
                      sizeToContent
                    />
                  )}
                </form.AppField>
              </div>
            </div>
            <div className="space-y-0.5">
              <p className="font-mono text-xs wrap-break-word text-foreground/80">
                {head || "…"} <span className="text-muted-foreground">→</span>{" "}
                {base || "…"}
              </p>
              {(() => {
                switch (true) {
                  case sameBranch:
                    return (
                      <p className="text-xs text-warning">
                        Pick two different branches.
                      </p>
                    );
                  case noBase:
                    return (
                      <p className="text-xs text-muted-foreground">
                        Choose a base branch to merge into.
                      </p>
                    );
                  case nothingToMerge:
                    return (
                      <p className="flex items-start gap-1.5 text-xs text-warning">
                        <WarningIcon className="mt-px size-3.5 shrink-0" />
                        <span>
                          Nothing to merge: {head} is already in {base}.
                        </span>
                      </p>
                    );
                  case counting:
                    return (
                      <p className="text-xs text-muted-foreground">
                        Counting commits to merge…
                      </p>
                    );
                  case countFailed:
                    return (
                      <p className="text-xs text-muted-foreground">
                        Couldn't count the commits to merge.
                      </p>
                    );
                  default:
                    return (
                      <p className="text-xs text-muted-foreground">
                        {ahead.length} commit{ahead.length === 1 ? "" : "s"} to
                        merge.
                      </p>
                    );
                }
              })()}
            </div>

            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the change"
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Description"
                  placeholder="Describe what changed and why"
                  rows={7}
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
                      // Nothing to merge stays a plain disable; a running create
                      // says why.
                      <DisabledReasonButton
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={
                          sameBranch || ahead.length === 0 || isSubmitting
                        }
                        reason={
                          isSubmitting
                            ? CREATE_PENDING_GENERATE_REASON
                            : undefined
                        }
                        onClick={runGenerate}
                        // The chord is only offered while it would do something —
                        // a disabled Generate's shortcut is dead too.
                        title={
                          !(sameBranch || ahead.length === 0 || isSubmitting)
                            ? `Generate the title and description with AI${generateHint}`
                            : "Generate the title and description with AI"
                        }
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Generate
                      </DisabledReasonButton>
                    )
                  }
                />
              )}
            </form.AppField>

            {/* Linked issues: real repo issues referenced on create. Non-AI
                surface (shown under Hide-AI too), gated on the tracker being
                usable. Composed into the body as `Closes #N`/`Relates to #N`. */}
            {canLinkIssues && (
              <LinkedIssuesField
                repoPath={repoPath}
                lens="origin"
                chips={linkedIssues}
                onToggleKeyword={toggleIssueKeyword}
                onRemove={removeIssue}
                onPick={pickIssue}
                disabled={generating}
              />
            )}

            {/* Collapsed "Notes for reviewers": deposit-seeded author context,
                appended as the local PR's first comment and fed to the AI
                review via the event. AI-only. */}
            {aiEnabled && (
              <form.AppField name="notes">
                {(field) => (
                  <ReviewerNotesField
                    repoPath={repoPath}
                    head={head || null}
                    field={field}
                  />
                )}
              </form.AppField>
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
              <span
                className={cn(
                  "inline-flex",
                  blockedReason && "cursor-not-allowed",
                )}
                title={wrapperTitle}
              >
                <form.SubmitButton
                  focusableWhenDisabled={!!blockedReason}
                  disabled={submitBlocked}
                  aria-describedby={describedBy}
                  className={ARIA_DISABLED_CLASS}
                >
                  Create local PR
                </form.SubmitButton>
                {blockedReason ? (
                  <span id={reasonId} className="sr-only">
                    {blockedReason}
                  </span>
                ) : null}
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
