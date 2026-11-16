import {
  GIT_PUSH_TIMEOUT_MESSAGE,
  mayHaveLanded,
  presentError,
} from "@/lib/error-summary";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { isAppError } from "@/lib/tauri/invoke";
import { emitNotification } from "./emit";

/**
 * Whether a create failed at pushing its head branch: every create route
 * returns the push's own git error unwrapped and any later failure under a
 * forge kind. A git-kind read before the push (the remote's URL, a config
 * read) lands here too; nothing was pushed then either.
 */
export function createFailedAtPush(error: unknown): boolean {
  return isAppError(error) && error.kind === "git";
}

/**
 * Whether a create timed out pushing its head branch: a bare git timeout after
 * the push's own budget. Every gh or glab call and git read runs under a
 * shorter budget, so a timeout before the push never matches, and a timed-out
 * write (`mayHaveLanded`) never carries the bare lead.
 */
export function createTimedOutAtPush(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.kind === "timeout" &&
    error.message === GIT_PUSH_TIMEOUT_MESSAGE
  );
}

/** The sentence a failed create's toast note and notification title share. */
export function prCreateFailedSentence(
  noun: string,
  head: string,
  error: unknown,
): string {
  if (createFailedAtPush(error))
    return `Pushing ${head} failed, so the ${noun} wasn't created`;
  if (createTimedOutAtPush(error))
    return `Pushing ${head} timed out, so the ${noun} wasn't created`;
  return `The ${noun} for ${head} wasn't created`;
}

/**
 * Announces a pull/merge request create that failed — inbox row plus an OS ping
 * while the window is unfocused, on whichever channels the `prCreate` source has
 * for this repo. Every input is captured by the caller at submit time: the create
 * can settle minutes later, after the dialog and even the repo view are gone, so
 * nothing here reads live UI state. Gating is `emitNotification`'s alone.
 */
export function notifyPrCreateFailed(input: {
  repoPath: string;
  head: string;
  /** "pull request" | "merge request" — the dialog's prNoun, passed through. */
  noun: string;
  error: unknown;
}): void {
  const { repoPath, head, noun, error } = input;
  const repoName = repoNameFromPath(repoPath);
  // Same one-liner the toast shows, so the visible row line and the OS body lead
  // with the reason; the full text rides the row's hover, since no other record of
  // a failed create outlives the toast.
  const presented = presentError(error);
  const reason = presented.summary;
  // A create that may have landed (timed out, or accepted with an unreadable
  // reply) may exist on the forge, so the title doesn't deny it.
  const title = mayHaveLanded(error)
    ? `The ${noun} for ${head} may have been created`
    : prCreateFailedSentence(noun, head, error);
  emitNotification({
    source: "prCreate",
    row: {
      kind: "pr-create-failed",
      tone: "danger",
      title,
      subtitle: reason,
      detail: presented.fullText,
      repoPath,
      repoName,
      // No dedupeKey: each create settles once, so a second failure inside the
      // dedupe window is a real retry failing, and it must still be recorded.
      target: { type: "repo", tab: "pulls" },
    },
    os: { title, body: `${repoName}: ${reason}`, focus: "unfocused" },
  });
}
