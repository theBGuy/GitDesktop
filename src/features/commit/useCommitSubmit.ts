import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { triggerAutomations } from "@/lib/automations/runner";
import { requiresPullRequest } from "@/lib/branch-rules/match";
import {
  useEffectiveBranchRules,
  useEffectiveBranchRulesSettling,
} from "@/lib/branch-rules/queries";
import { headBranchPin } from "@/lib/git/api";
import { coAuthorTrailers } from "@/lib/git/co-authors";
import { repoKeys, useCommit, useRepoStatus } from "@/lib/git/queries";
import type { AmendRace, ChangeKind, FileEntry } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { commitDraftKey, useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useGenerateCommitMessage } from "./useGenerateCommitMessage";

/** Why an amend holds, for the surfaces' banner: the commit moved, then the branch;
 *  `"none"` while it can run, or when not amending. */
export type AmendHold = "none" | "commit" | "branch";

/** The report for an amend that landed after another Git process moved HEAD: where
 *  it landed (another branch, then a detached HEAD) outranks the commit it rewrote,
 *  and a commit the reflog couldn't name, or a pin that was never read, takes the
 *  generic form. */
function racedAmendMessage(
  raced: AmendRace,
  expectedHead: string | null,
): string {
  if (raced.branch !== null) {
    return `The branch switched to ${raced.branch} before the amend ran, so the amend landed there. The commit it replaced is in the reflog.`;
  }
  if (raced.detached) {
    return "HEAD was detached before the amend ran, so the amend landed there. The commit it replaced is in the reflog.";
  }
  if (raced.rewrote !== null && expectedHead !== null) {
    return `Another Git process committed first, so the amend rewrote ${raced.rewrote.slice(0, 7)} instead of ${expectedHead.slice(0, 7)}. The original ${raced.rewrote.slice(0, 7)} is in the reflog.`;
  }
  return "Another Git process committed first, so the amend rewrote a different commit than the one shown. The original is in the reflog.";
}

/**
 * The commit machinery behind both composing surfaces — the inline CommitBox and
 * the pop-out CommitDialog. Every field it exposes reads the shared ui-store
 * draft rather than local state, so the two stay in sync by construction and a
 * generation streams into whichever is on screen.
 *
 * Both surfaces register the `commit` / `generate-commit-message` actions while
 * `active`: the dispatcher runs the newest ENABLED handler, and with one store
 * behind them either registration does the same thing.
 */
export function useCommitSubmit(
  repoPath: string,
  {
    active = true,
    commitHotkeyFallback = false,
    onCommitted,
  }: {
    /** Whether this surface's hotkey registrations are live. The dialog passes
     *  its open state so a closed-but-mounted instance registers nothing
     *  enabled; the inline box is live for as long as it's mounted. */
    active?: boolean;
    /** Keeps the `commit` chord alone live while this surface is closed, for
     *  the state where NO commit surface is mounted to hold it. Commit-only by
     *  design: a generation streams into a field, so it needs one on screen. */
    commitHotkeyFallback?: boolean;
    /** Runs when a commit lands — the dialog closes itself on it. */
    onCommitted?: () => void;
  } = {},
) {
  const queryClient = useQueryClient();
  const status = useRepoStatus(repoPath);
  const commit = useCommit(repoPath);
  const title = useUiStore((s) => s.commitTitle);
  const body = useUiStore((s) => s.commitBody);
  const amendingHash = useUiStore((s) => s.amendingHash);
  const amendingBranch = useUiStore((s) => s.amendingBranch);
  const coAuthors = useUiStore((s) => s.commitCoAuthors);
  const setCommitTitle = useUiStore((s) => s.setCommitTitle);
  const setCommitBody = useUiStore((s) => s.setCommitBody);
  const setCoAuthors = useUiStore((s) => s.setCommitCoAuthors);
  const clearCommitDraft = useUiStore((s) => s.clearCommitDraft);
  const clearAmending = useUiStore((s) => s.clearAmending);
  const restoreCommitDraft = useUiStore((s) => s.restoreCommitDraft);
  const activeDraftKey = useUiStore((s) => s.activeDraftKey);
  const loadCommitDraft = useUiStore((s) => s.loadCommitDraft);
  const commitAiGenerated = useUiStore((s) => s.commitAiGenerated);
  const { generate, cancel, generating } = useGenerateCommitMessage(repoPath);
  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const rulesConfig = useEffectiveBranchRules(repoPath);
  // While either rules scope is on its FIRST read the effective config stands in
  // as empty, so `locked` is vacuously false — commit holds on this instead.
  const rulesSettling = useEffectiveBranchRulesSettling(repoPath);

  const amending = amendingHash !== null;
  const branchName = status.data?.branch?.name ?? null;
  // The amend target is no longer HEAD; a null oid (unborn) holds too. Off while
  // status is unread, where the backend's expected-HEAD check is the backstop.
  // Cached status right after a repo switch can read "not moved" until the mount
  // refetch lands; that same check covers the window.
  const headMoved =
    amending &&
    status.data !== undefined &&
    status.data.branch?.oid !== amendingHash;
  // A switch between named branches loads the other branch's draft, but detaching
  // or reattaching HEAD keeps this one (no branch name to key by), so the branch
  // pin holds that flip here. A null pin (status unread at amend start) never does.
  const shownHead = status.data?.branch;
  const branchMoved =
    amending &&
    amendingBranch !== null &&
    shownHead != null &&
    headBranchPin(shownHead) !== amendingBranch;
  const amendHeld = headMoved || branchMoved;
  const amendHold = ((): AmendHold => {
    switch (true) {
      case headMoved:
        return "commit";
      case branchMoved:
        return "branch";
      default:
        return "none";
    }
  })();

  // Point the commit surfaces at this repo+branch's saved draft. Drafts are kept
  // per repo+branch, so switching repos/branches preserves each in-progress
  // message instead of clearing it. Idempotent (loadCommitDraft no-ops on the
  // active key), so the two surfaces running it together costs nothing — and the
  // dialog's copy keeps the key current while the box is Activity-hidden.
  useEffect(() => {
    if (branchName) loadCommitDraft(commitDraftKey(repoPath, branchName));
  }, [repoPath, branchName, loadCommitDraft]);
  // A "require pull request" rule locks the branch against direct commits.
  const locked = branchName
    ? requiresPullRequest(rulesConfig, branchName)
    : false;
  // Narrowed at the filter, so consumers read `staged` as a plain ChangeKind and
  // can't paper over a mis-typed entry with a fallback kind.
  const stagedEntries: (FileEntry & { staged: ChangeKind })[] =
    status.data?.entries.filter(
      (e): e is FileEntry & { staged: ChangeKind } => e.staged !== null,
    ) ?? [];
  const stagedCount = stagedEntries.length;
  // amending without staged changes is valid (message-only edit)
  const canCommit =
    title.trim().length > 0 &&
    (stagedCount > 0 || amending) &&
    !commit.isPending &&
    !locked &&
    !amendHeld &&
    !rulesSettling;
  const canGenerate = aiEnabled && aiConfigured && stagedCount > 0;
  // Why Commit is refused, most-blocking first: the still-unread rules, then a
  // branch rule or a moved amend target nothing the user types can lift, then
  // the missing title, then the empty stage.
  const commitDisabledReason = ((): string | null => {
    switch (true) {
      case rulesSettling:
        return "Checking branch protection rules…";
      case locked:
        return "This branch requires changes via a pull request";
      case headMoved:
        return "The latest commit changed since you started amending";
      case branchMoved:
        return "The checked-out branch changed since you started amending";
      case title.trim().length === 0:
        return "Enter a commit title first";
      case stagedCount === 0 && !amending:
        return "Stage changes to commit";
      default:
        return null;
    }
  })();
  const commitLabel = amending
    ? "Amend last commit"
    : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ""}${
        branchName ? ` to ${branchName}` : ""
      }`;

  // The commit hotkey (Ctrl+Enter by default) fires through the global
  // dispatcher even from the title/body fields — modifier combos are
  // allowed in text fields — so rebinding it in Settings works everywhere.
  useHotkeyAction(
    "commit",
    doCommit,
    (active || commitHotkeyFallback) && canCommit && !generating,
  );
  useHotkeyAction(
    "generate-commit-message",
    generate,
    active && canGenerate && !generating,
  );

  // Held, HEAD moved or switched without the user choosing to stop, so only amend
  // mode ends and the box keeps whatever it holds; unheld, stopping is the user's
  // choice and clears the draft.
  function stopAmending() {
    if (amendHeld) clearAmending();
    else clearCommitDraft();
  }

  // Awaited rather than per-call callbacks: both hosts can go while the commit
  // is in flight (the dialog closes itself, the inline box rides an
  // <Activity>-hidden tab), and react-query drops per-call callbacks once the
  // observer has no listeners.
  async function doCommit() {
    // Belt for a gate that flipped under an open surface: `canCommit` disables
    // the button and hotkey, but between the render that enabled them and the
    // press the rules can settle to "locked", or a status read can move HEAD
    // off the amend target.
    if (rulesSettling || locked || amendHeld) return;
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
    const expectedHead = amendingHash;
    const expectedBranch = amendingBranch;
    const fileCount = stagedCount;
    // Clear optimistically so the fields empty the instant you commit (GitHub
    // Desktop feel) instead of snapping empty once the commit resolves. Also
    // flips canCommit false, which blocks an accidental double-submit.
    clearCommitDraft();
    try {
      const result = await commit.mutateAsync({
        title: commitTitle,
        body: fullBody || undefined,
        amend: wasAmending,
        // The backend refuses the amend unless HEAD is still this commit, on the
        // branch HEAD was on when the amend started.
        expectedHead: wasAmending ? expectedHead : undefined,
        expectedBranch: wasAmending ? expectedBranch : undefined,
      });
      // First, so the pop-out closes the instant the commit lands rather
      // than behind the reporting work below.
      onCommitted?.();
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
      // A raced amend still landed, so it closes and clears like any other; only the
      // report differs, a warning since the commit itself succeeded.
      if (result.raced) {
        toast.warning(racedAmendMessage(result.raced, expectedHead));
      } else {
        toast.success(
          `${wasAmending ? "Amended" : "Committed"} ${result.hash.slice(0, 7)}`,
        );
      }
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
    } catch (e) {
      // The commit failed — put the message back so it isn't lost (restores
      // amending mode too).
      restoreCommitDraft(
        { ...snapshot, amendingHash, amendingBranch },
        draftKey,
      );
      toastError(e);
      // A failed commit doesn't refresh status, so a moved HEAD would otherwise
      // stay unheld until the next poll.
      void queryClient.invalidateQueries({
        queryKey: repoKeys.status(repoPath),
      });
    }
  }

  return {
    title,
    body,
    coAuthors,
    setCommitTitle,
    setCommitBody,
    setCoAuthors,
    stopAmending,
    amending,
    amendingHash,
    /** Amending, but HEAD is no longer `amendingHash` (`"commit"`) or no longer on
     *  the branch the amend started on (`"branch"`): the commit holds. `"none"`
     *  otherwise. */
    amendHold,
    branchName,
    locked,
    stagedEntries,
    stagedCount,
    canCommit,
    /** AI is on, a provider is set up, and there's something to describe. */
    canGenerate,
    commitDisabledReason,
    /** "Commit (3) to main" / "Amend last commit" — one label for both surfaces. */
    commitLabel,
    committing: commit.isPending,
    aiEnabled,
    aiConfigured,
    generate,
    cancel,
    generating,
    doCommit,
  };
}
