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

/** Strip a leading `error:` / `fatal:` prefix git tacks onto its diagnostics. */
function stripGitPrefix(line: string): string {
  return line.replace(/^(?:error|fatal):\s*/i, "").trim();
}

/** First meaningful line of a message, prefix-stripped. Falls back to the first
 *  non-empty line (then the whole trimmed text) so a summary is never blank. */
function firstMeaningfulLine(message: string): string {
  const lines = message.split("\n");
  const meaningful = lines.find((l) => !isNoiseLine(l));
  if (meaningful) return stripGitPrefix(meaningful);
  const nonEmpty = lines.find((l) => l.trim() !== "");
  return stripGitPrefix(nonEmpty ?? message).trim() || message.trim();
}

/** Conflict-family markers — a paused rebase/merge/cherry-pick/revert. When any
 *  appears we translate to a single calm line (the ConflictBanner already owns
 *  the durable surface); the raw text still flows to fullText untouched. */
const CONFLICT_MARKERS = [
  "could not apply",
  "Resolve all conflicts",
  "CONFLICT (",
  "needs merge",
];

/** The paused operation named in the text, capitalized for the summary. */
function conflictOp(text: string): string {
  const lower = text.toLowerCase();
  const idx = ["rebase", "merge", "cherry-pick", "revert"]
    .map((op) => ({ op, at: lower.indexOf(op) }))
    .filter((m) => m.at !== -1)
    .sort((a, b) => a.at - b.at)[0];
  if (!idx) return "Operation";
  const { op } = idx;
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
      stderr && !message.includes(stderr)
        ? `${message}\n\n${stderr}`
        : message;

    const combined = `${message}\n${stderr}`;
    const isConflict = CONFLICT_MARKERS.some((m) => combined.includes(m));
    const summary = isConflict
      ? `${conflictOp(combined)} paused — resolve the conflicts, then continue.`
      : firstMeaningfulLine(message);

    const distinctStderr = stderr !== "" && !message.includes(stderr);
    const long =
      nonEmptyLineCount(message) > 1 ||
      distinctStderr ||
      fullText.length > 140;

    return { label: KIND_LABELS[e.kind], summary, fullText, long };
  }

  const message = e instanceof Error ? e.message : String(e);
  const summary = firstMeaningfulLine(message);
  const long = nonEmptyLineCount(message) > 1 || message.length > 140;
  return { label: null, summary, fullText: message, long };
}
