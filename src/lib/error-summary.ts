import { type AppError, isAppError } from "@/lib/tauri/invoke";

/** A humanized error, split into what a toast shows (a calm one-liner) and what
 *  the Details dialog shows (the full raw text). Pure — derived from the thrown
 *  value alone, no React/DOM. */
export interface ErrorPresentation {
  /** Kind badge text (e.g. "Git error"), or null for a non-AppError throwable. */
  label: string | null;
  /** One humanized line — never raw multi-line stderr noise. */
  summary: string;
  /** The full message (plus a distinct stderr appended) for the Details dialog. */
  fullText: string;
  /** Whether the error is long enough to route the toast through Details. */
  long: boolean;
}

/** Human labels for every AppError kind (mirrors the union in tauri/invoke.ts). */
const KIND_LABELS: Record<AppError["kind"], string> = {
  git: "Git error",
  notARepo: "Not a Git repository",
  gitNotFound: "Git not found",
  ghNotFound: "GitHub CLI not found",
  gh: "GitHub error",
  issuesDisabled: "Issues disabled",
  glabNotFound: "GitLab CLI not found",
  glab: "GitLab error",
  bitbucketNotConfigured: "Bitbucket not configured",
  bitbucket: "Bitbucket error",
  jira: "Jira error",
  keyring: "Credential storage error",
  invalidArgument: "Invalid input",
  command: "Command failed",
  io: "I/O error",
  timeout: "Timed out",
};

/** Lines that carry no signal for a one-line summary: git `hint:` guidance,
 *  `Rebasing (x/y)` progress counters, and blanks. */
function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (t.startsWith("hint:")) return true;
  if (/^Rebasing \(\d+\/\d+\)/.test(t)) return true;
  return false;
}

/** Strip the leading tool prefix a diagnostic carries — git's `error:`/`fatal:`,
 *  or `gh:` on a GitHub CLI failure. The kind label already names the tool, so
 *  the prefix only eats room in a one-line summary. */
function stripToolPrefix(line: string): string {
  return line.replace(/^(?:error|fatal|gh):\s*/i, "").trim();
}

/** First meaningful line of a message, prefix-stripped. Falls back to the first
 *  non-empty line (then the whole trimmed text) so a summary is never blank. */
function firstMeaningfulLine(message: string): string {
  const lines = message.split("\n");
  const meaningful = lines.find((l) => !isNoiseLine(l));
  if (meaningful) return stripToolPrefix(meaningful);
  const nonEmpty = lines.find((l) => l.trim() !== "");
  return stripToolPrefix(nonEmpty ?? message).trim() || message.trim();
}

/** Conflict-family markers (lowercase — matched case-insensitively, since git
 *  emits both `error: could not apply …` and `Could not apply <sha>…`). When any
 *  appears we translate to a single calm line (the ConflictBanner already owns
 *  the durable surface); the raw text still flows to fullText untouched. */
const CONFLICT_MARKERS = [
  "could not apply",
  "resolve all conflicts",
  "conflict (",
  "needs merge",
];

/** Markers for git's refuse-to-clobber-your-working-tree family — the errors a
 *  stash → run → reapply recovery can turn into a one-click fix. Measured
 *  verbatim on git 2.51.1.windows.1 (lower-cased here, matched
 *  case-insensitively; git prefixes them with `error:`).
 *
 *  Deliberately disjoint from CONFLICT_MARKERS: a real merge conflict already
 *  has ConflictBanner recovery, and stashing mid-conflict corrupts the resolve
 *  state. None of these strings appears in conflict output. */
const DIRTY_TREE_MARKERS = [
  // `pull` (--ff-only and --no-rebase) and plain `merge`, tracked overlap.
  "your local changes to the following files would be overwritten by merge",
  // Same flows, untracked overlap — the app stashes --include-untracked, so
  // this is recoverable for us even though git's own --autostash skips it.
  "the following untracked working tree files would be overwritten by merge",
  // `switch` / `checkout` (both emit "by checkout"), tracked and untracked.
  "your local changes to the following files would be overwritten by checkout",
  "the following untracked working tree files would be overwritten by checkout",
  // `pull --rebase` refuses up front, with a distinct line per dirty kind.
  "cannot pull with rebase: you have unstaged changes",
  "cannot pull with rebase: your index contains uncommitted changes",
];

/**
 * Whether a thrown value is git refusing an operation because it would
 * overwrite uncommitted work — the pull / merge / switch dirty-tree family that
 * stash-and-reapply recovers from. Anything else (including real merge
 * conflicts) returns false and keeps its normal error presentation.
 */
export function isDirtyTreeRefusal(e: unknown): boolean {
  const text = isAppError(e)
    ? `${e.message ?? ""}\n${e.stderr ?? ""}`
    : e instanceof Error
      ? e.message
      : String(e);
  const lower = text.toLowerCase();
  return DIRTY_TREE_MARKERS.some((m) => lower.includes(m));
}

/** The paused operation named in the text, capitalized for the summary. */
function conflictOp(text: string): string {
  const lower = text.toLowerCase();
  const found = ["rebase", "merge", "cherry-pick", "revert"]
    .map((op) => ({ op, at: lower.indexOf(op) }))
    .filter((m) => m.at !== -1)
    .sort((a, b) => a.at - b.at)[0];
  if (!found) return "Operation";
  const { op } = found;
  return op === "cherry-pick"
    ? "Cherry-pick"
    : op.charAt(0).toUpperCase() + op.slice(1);
}

/** Count of non-empty lines in a string. */
function nonEmptyLineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

/**
 * Humanize any thrown value into a toast-friendly summary plus the raw full
 * text. AppErrors get a kind label; plain Error/string values get label null and
 * their first line as the summary. Conflict-family errors collapse to one calm
 * "<Op> paused" line while preserving the raw dump in `fullText`.
 */
export function presentError(e: unknown): ErrorPresentation {
  if (isAppError(e)) {
    const message = e.message ?? "";
    const stderr = e.stderr?.trim() ?? "";
    // Append stderr only when it adds something the message doesn't already carry.
    const fullText =
      stderr && !message.includes(stderr) ? `${message}\n\n${stderr}` : message;

    const combined = `${message}\n${stderr}`;
    const combinedLower = combined.toLowerCase();
    const isConflict = CONFLICT_MARKERS.some((m) => combinedLower.includes(m));
    const label = KIND_LABELS[e.kind];
    const summary = isConflict
      ? `${conflictOp(combined)} paused — resolve the conflicts, then continue.`
      : firstMeaningfulLine(message) || label;

    const distinctStderr = stderr !== "" && !message.includes(stderr);
    const long =
      nonEmptyLineCount(message) > 1 || distinctStderr || fullText.length > 140;

    return { label, summary, fullText, long };
  }

  const message = e instanceof Error ? e.message : String(e);
  const summary = firstMeaningfulLine(message) || "Unexpected error";
  const long = nonEmptyLineCount(message) > 1 || message.length > 140;
  return { label: null, summary, fullText: message, long };
}
