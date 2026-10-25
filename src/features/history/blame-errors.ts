// Pure: scripts/blame-errors.test.mjs loads this through the shared src hooks
// (its one import is the `@/` error-summary mirror of the Rust display leads).
// Both classifiers read the SERIALIZED AppError (`{kind, message[, code,
// stderr]}`, src-tauri/src/error.rs). An InvalidArgument's `message` is the
// Rust Display text, lead included, so those matches strip it through
// `appErrorDetail`; the git match reads `stderr`, which has no lead.
import { appErrorDetail } from "@/lib/error-summary";

type WireError = { kind: string; message: string; stderr?: string };

function wire(error: unknown): WireError | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { kind?: unknown; message?: unknown; stderr?: unknown };
  if (typeof e.kind !== "string" || typeof e.message !== "string") return null;
  return {
    kind: e.kind,
    message: e.message,
    stderr: typeof e.stderr === "string" ? e.stderr : undefined,
  };
}

/** The app-written detail of an InvalidArgument, or null for any other error. */
function invalidArgumentDetail(error: unknown): string | null {
  const e = wire(error);
  if (e?.kind !== "invalidArgument") return null;
  return appErrorDetail("invalidArgument", e.message);
}

/** Whether blame refused the rev itself: git/history.rs's "unknown revision"
 *  InvalidArgument, produced when `rev-parse --verify --quiet <rev>^{commit}`
 *  exits 1 (pinned by `blame_unknown_rev_says_unknown_revision`). */
export function isUnknownRevisionError(error: unknown): boolean {
  return (
    invalidArgumentDetail(error)?.startsWith("unknown revision: ") ?? false
  );
}

/** Whether a no-rev blame failed because the file has no history to blame:
 *  git refusing a path HEAD doesn't have (pinned by
 *  `blame_untracked_file_says_no_such_path_in_head`), or the app's own refusal
 *  in a repository with no commits yet (`blame_unborn_head_errors`). Any other
 *  failure is a failed read. */
export function isNoBlameHistoryError(error: unknown): boolean {
  if (invalidArgumentDetail(error)?.startsWith("repository has no commits yet"))
    return true;
  const e = wire(error);
  if (e?.kind !== "git") return false;
  return /no such path '.*' in HEAD/.test(e.stderr ?? e.message);
}
