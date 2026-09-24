import { presentError } from "@/lib/error-summary";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { emitNotification } from "./emit";

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
  const title = `The ${noun} for ${head} wasn't created`;
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
