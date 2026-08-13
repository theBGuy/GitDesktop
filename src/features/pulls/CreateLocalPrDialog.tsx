import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { REVIEWER_NOTES_MARKER } from "@/lib/ai/notes-context";
import { triggerAutomations } from "@/lib/automations/runner";
import { required, useAppForm } from "@/lib/form";
import {
  forgeFeatureReady,
  useCompareBranches,
  useDefaultBranch,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  eventToBinding,
  formatBinding,
  SUBMIT_HINT,
} from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { updateLocalPr } from "@/lib/pulls/local";
import { useCreateLocalPr } from "@/lib/pulls/queries";
import { deleteReviewNote } from "@/lib/review-notes/store";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { LinkedIssuesField } from "./LinkedIssuesField";
import { ReviewerNotesField } from "./ReviewerNotesField";
import { useBranchPickerOptions } from "./useBranchPickerOptions";
import { useGeneratePrDescription } from "./useGeneratePrDescription";
import {
  composeBodyWithRefs,
  useLinkedIssueChips,
} from "./useLinkedIssueChips";

// Rendered exactly ONCE, hoisted in RepositoryView — never render it inside a tab
// panel. Its success handler's `setRepoTab("pulls")` would hide a panel host's
// <Activity> subtree and defer the `onOpenChange(false)`, stranding the dialog open.
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

  const currentName = status.data?.branch?.name ?? null;
  // Branch options with per-branch worktree chips; drops the app-internal
  // `gd/session/*` branches (a local PR must never target one) and archived
  // branches, matching BranchSwitcher. `keep` retains the seeded defaults even
  // if archived, so the head/base defaults stay selectable.
  const { names, items, annotations } = useBranchPickerOptions(repoPath, open, [
    currentName,
    defaultHead,
    defaultBase,
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
            } catch {
              toast.error("Local PR created — adding reviewer notes failed.");
            }
          }
          // Consume the deposit — the create consumed the note. Best-effort.
          void deleteReviewNote(repoPath, value.head).catch(() => undefined);
        }
        toast.success(`Created local PR: ${pr.title}`);
        setRepoTab("pulls");
        selectPr({ kind: "local", id: pr.id });
        onOpenChange(false);
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
        toastError(e);
      }
    },
  });

  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // seeded head/base back to empty (untouched form).
  const seedOnOpen = useEffectEvent(() => {
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
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  // Live head/base drive the "N commits to merge" hint and AI generation.
  const head = useSelector(form.store, (s) => s.values.head);
  const base = useSelector(form.store, (s) => s.values.base);
  // Live notes feed the AI-description prompt and the ReviewerNotesField seeding.
  const notes = useSelector(form.store, (s) => s.values.notes);
  const comparison = useCompareBranches(repoPath, base || null, head || null);
  const ahead = comparison.data?.ahead ?? [];
  const sameBranch = base === head;

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
    );
  }
  // Context-sensitive reuse of the `generate-commit-message` binding (mod+g by
  // default) while this dialog is open — never a hardcoded chord, so a
  // Settings → Keyboard rebinding drives it. null = explicitly unbound.
  const generateBinding =
    useEffectiveBindings().get("generate-commit-message") ?? null;
  const generateHint = generateBinding
    ? ` (${formatBinding(generateBinding)})`
    : "";

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
            if (!generating) form.handleSubmit();
            return;
          }
          // The generate-commit-message chord (mod+g by default) runs this
          // dialog's own Generate while it's open. Only when AI is on (no
          // Generate surface otherwise) and the chord is bound. ALWAYS swallow
          // it: this dialog is hoisted over the Changes tab, where the global
          // generate-commit-message action has a live handler — without this the
          // chord would generate a COMMIT MESSAGE behind the dialog. Run Generate
          // only when its button would be enabled; while generating we swallow
          // but DON'T cancel (an accidental repeat must not abort a running one).
          if (
            aiEnabled &&
            generateBinding !== null &&
            eventToBinding(e) === generateBinding
          ) {
            e.preventDefault();
            if (!generating && !(sameBranch || ahead.length === 0)) {
              runGenerate();
            }
          }
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New local pull request</DialogTitle>
            <DialogDescription>
              Propose merging one branch into another and review it locally — no
              GitHub involved. Merge it later with a{" "}
              <span className="font-mono">--no-ff</span> commit.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
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
              {sameBranch ? (
                <p className="text-xs text-warning">
                  Pick two different branches.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {ahead.length} commit{ahead.length === 1 ? "" : "s"} to merge.
                </p>
              )}
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
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={sameBranch || ahead.length === 0}
                        onClick={runGenerate}
                        title={`Generate the title and description with AI${generateHint}`}
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Generate
                      </Button>
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
              <form.SubmitButton disabled={generating} title={SUBMIT_HINT}>
                Create local PR
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
