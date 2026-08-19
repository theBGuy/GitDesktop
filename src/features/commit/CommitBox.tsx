import { InfoIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { AnimatePresence, m } from "motion/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { track } from "@/lib/analytics";
import { triggerAutomations } from "@/lib/automations/runner";
import { requiresPullRequest } from "@/lib/branch-rules/match";
import { useEffectiveBranchRules } from "@/lib/branch-rules/queries";
import { coAuthorTrailers } from "@/lib/git/co-authors";
import { useCommit, useRepoStatus } from "@/lib/git/queries";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useGenerateChordHint } from "@/lib/hotkeys/useGenerateChord";
import { quickTransition } from "@/lib/motion";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { commitDraftKey, useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { CoAuthorPicker } from "./CoAuthorPicker";
import { useGenerateCommitMessage } from "./useGenerateCommitMessage";

export function CommitBox({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const commit = useCommit(repoPath);
  const title = useUiStore((s) => s.commitTitle);
  const body = useUiStore((s) => s.commitBody);
  const amendingHash = useUiStore((s) => s.amendingHash);
  const coAuthors = useUiStore((s) => s.commitCoAuthors);
  const setCommitTitle = useUiStore((s) => s.setCommitTitle);
  const setCommitBody = useUiStore((s) => s.setCommitBody);
  const setCoAuthors = useUiStore((s) => s.setCommitCoAuthors);
  const clearCommitDraft = useUiStore((s) => s.clearCommitDraft);
  const restoreCommitDraft = useUiStore((s) => s.restoreCommitDraft);
  const activeDraftKey = useUiStore((s) => s.activeDraftKey);
  const loadCommitDraft = useUiStore((s) => s.loadCommitDraft);
  const commitAiGenerated = useUiStore((s) => s.commitAiGenerated);
  const { generate, cancel, generating } = useGenerateCommitMessage(repoPath);
  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const openSettings = useUiStore((s) => s.openSettings);
  const rulesConfig = useEffectiveBranchRules(repoPath);

  const amending = amendingHash !== null;
  const branchName = status.data?.branch?.name ?? null;

  // Point the commit box at this repo+branch's saved draft. Drafts are kept
  // per repo+branch, so switching repos/branches preserves each in-progress
  // message instead of clearing it.
  useEffect(() => {
    if (branchName) loadCommitDraft(commitDraftKey(repoPath, branchName));
  }, [repoPath, branchName, loadCommitDraft]);
  // A "require pull request" rule locks the branch against direct commits.
  const locked = branchName
    ? requiresPullRequest(rulesConfig, branchName)
    : false;
  const stagedCount =
    status.data?.entries.filter((e) => e.staged !== null).length ?? 0;
  // amending without staged changes is valid (message-only edit)
  const canCommit =
    title.trim().length > 0 &&
    (stagedCount > 0 || amending) &&
    !commit.isPending &&
    !locked;

  // The commit hotkey (Ctrl+Enter by default) fires through the global
  // dispatcher even from the title/body fields — modifier combos are
  // allowed in text fields — so rebinding it in Settings works everywhere.
  useHotkeyAction("commit", doCommit, canCommit && !generating);
  useHotkeyAction(
    "generate-commit-message",
    generate,
    aiEnabled && aiConfigured && stagedCount > 0 && !generating,
  );
  // Both button hints read the effective bindings rather than the defaults, so
  // a Settings → Keyboard rebind shows up here; null = the user unbound it and
  // there is no shortcut to name.
  const commitBinding = useEffectiveBindings().get("commit") ?? null;
  const generateHint = useGenerateChordHint();

  function doCommit() {
    const commitTitle = title.trim();
    // Trailers must be the final paragraph of the message.
    const fullBody = [body.trim(), coAuthorTrailers(coAuthors)]
      .filter(Boolean)
      .join("\n\n");
    // Snapshot everything the in-flight commit (and its analytics) needs, since
    // we clear the draft *before* the async commit resolves. `draftKey` is
    // captured too so an error restores to this branch's draft even if the user
    // switched branches while the commit was in flight.
    const snapshot = { title, body, coAuthors, aiGenerated: commitAiGenerated };
    const draftKey = activeDraftKey;
    const wasAmending = amendingHash !== null;
    const fileCount = stagedCount;
    // Clear optimistically so the fields empty the instant you commit (GitHub
    // Desktop feel) instead of snapping empty once the commit resolves. Also
    // flips canCommit false, which blocks an accidental double-submit.
    clearCommitDraft();
    commit.mutate(
      { title: commitTitle, body: fullBody || undefined, amend: wasAmending },
      {
        onSuccess: (result) => {
          if (!wasAmending) {
            track({
              name: "commit_created",
              properties: {
                file_count: fileCount,
                has_ai_message: snapshot.aiGenerated,
                has_co_authors: snapshot.coAuthors.length > 0,
              },
            });
          }
          toast.success(
            `${wasAmending ? "Amended" : "Committed"} ${result.hash.slice(0, 7)}`,
          );
          // Amending rewrites an existing commit; only new commits fire
          // on-commit automations.
          if (!wasAmending) {
            triggerAutomations({
              kind: "commit",
              repoPath,
              hash: result.hash,
              title: commitTitle,
              branch: branchName ?? "",
            });
          }
        },
        onError: (e) => {
          // The commit failed — put the message back so it isn't lost (restores
          // amending mode too).
          restoreCommitDraft({ ...snapshot, amendingHash }, draftKey);
          toastError(e);
        },
      },
    );
  }

  return (
    <div className="space-y-2 border-t p-3">
      {locked && (
        <div className="bg-muted px-2.5 py-2 text-xs text-muted-foreground">
          <p className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">
              <span className="font-medium">{branchName}</span> requires changes
              via a pull request — direct commits are blocked by a branch rule.
            </span>
          </p>
        </div>
      )}
      {amending && (
        <div className="bg-warning/10 px-2.5 py-2 text-xs text-warning">
          <p className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">
              Your changes will amend the most recent commit (
              <span className="font-mono">{amendingHash?.slice(0, 7)}</span>).{" "}
              <button
                type="button"
                className="font-medium underline underline-offset-2 hover:no-underline"
                onClick={clearCommitDraft}
              >
                Stop amending
              </button>{" "}
              to commit them separately instead.
            </span>
          </p>
        </div>
      )}
      <div className="relative">
        <Input
          placeholder="Commit title"
          value={title}
          onChange={(e) => setCommitTitle(e.target.value)}
          disabled={generating}
          className="ph-no-capture pr-12"
          autoComplete="off"
        />
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] tabular-nums",
            title.length > 72 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {title.length > 0 && `${title.length}/72`}
        </span>
      </div>
      <Textarea
        placeholder="Description (optional)"
        value={body}
        onChange={(e) => setCommitBody(e.target.value)}
        disabled={generating}
        rows={4}
        // cap the content-based auto-grow so a long generated body can't
        // swallow the changes list; resize-y lets the user drag it back down
        className="ph-no-capture max-h-48 min-h-16 resize-y"
      />
      <CoAuthorPicker
        repoPath={repoPath}
        value={coAuthors}
        onChange={setCoAuthors}
        disabled={generating}
      />
      <div className="flex gap-2">
        {aiEnabled && (
          <AnimatePresence mode="wait" initial={false}>
            {generating ? (
              <m.div
                key="cancel"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={quickTransition}
              >
                <Button variant="outline" size="sm" onClick={cancel}>
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
              </m.div>
            ) : (
              <m.div
                key="generate"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={quickTransition}
              >
                {aiConfigured ? (
                  <DisabledReasonButton
                    variant="outline"
                    size="sm"
                    disabled={stagedCount === 0}
                    reason="Stage changes to generate a commit message"
                    title={`Generate commit message with AI${generateHint}`}
                    onClick={generate}
                  >
                    <SparkleIcon data-icon="inline-start" />
                    Generate
                  </DisabledReasonButton>
                ) : (
                  // AI is on but no provider is set up yet — turn the dead-end
                  // Generate click into a one-time path to Settings → AI.
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openSettings("ai")}
                    title="Connect an AI provider to generate commit messages"
                  >
                    <SparkleIcon data-icon="inline-start" />
                    Set up AI
                  </Button>
                )}
              </m.div>
            )}
          </AnimatePresence>
        )}
        <DisabledReasonButton
          size="sm"
          wrapperClassName="min-w-0 flex-1"
          className="min-w-0 flex-1"
          disabled={!canCommit || generating}
          reason={
            locked
              ? "This branch requires changes via a pull request"
              : title.trim().length === 0
                ? "Enter a commit title first"
                : stagedCount === 0 && !amending
                  ? "Stage changes to commit"
                  : null
          }
          title={commitBinding ? formatBinding(commitBinding) : undefined}
          onClick={doCommit}
        >
          {commit.isPending && <Spinner data-icon="inline-start" />}
          <span className="truncate">
            {amending
              ? "Amend last commit"
              : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ""}${
                  branchName ? ` to ${branchName}` : ""
                }`}
          </span>
        </DisabledReasonButton>
      </div>
    </div>
  );
}
