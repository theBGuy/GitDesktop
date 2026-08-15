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

/** Conflict-family markers: anchored to git's own diagnostic line shapes and
 *  matched case-sensitively against the raw text, because git echoes commit
 *  subjects and file paths into the same blob, so an unanchored match would
 *  collapse ANY failure into the conflict summary — a commit titled "resolve
 *  all conflicts" is enough to do it.
 *  `m` is required: the Rust layer prepends app prose above git's output. A
 *  match translates to one calm line (the ConflictBanner already owns the
 *  durable surface); the raw text still flows to fullText untouched.
 *
 *  Paired with the Rust canary
 *  `conflict_output_still_matches_the_anchored_frontend_markers` (autostash.rs),
 *  which re-runs real conflicts and asserts these shapes still hold. */
const CONFLICT_MARKERS = [
  // git emits both `error: could not apply …` and a bare `Could not apply
  // <sha>…` tail line (rebase).
  /^(?:error: )?[Cc]ould not apply /m,
  /^(?:error: |hint: )Resolve all conflicts/m,
  // Git's own line is always uppercase; a path named "conflict (old)" is not.
  /^CONFLICT \(/m,
  // END-anchored on purpose: the PATH holds the line start here, so anchoring
  // this one to `^` would destroy the true positive.
  /: needs merge\s*$/m,
];

/** Verdict literals from the Rust rollback funnels, and the frontend half of
 *  that contract: a rolled-back or rollback-failed operation is NOT paused — no
 *  banner owns it, and "resolve the conflicts, then continue" is wrong advice in
 *  both states — yet those messages append git's raw output, which the conflict
 *  markers below would match. Read from the FIRST line only, since an unanchored
 *  literal is the same user-content hazard those markers are anchored against.
 *  `git/ops.rs` leads every such message with exactly one of these and its tests
 *  pin that placement (first line, ≤90 bytes) — keep the two in step. */
const ROLLBACK_VERDICTS = [
  "was rolled back",
  "rollback also failed",
  "rollback restored",
];

/** Markers for git's refuse-to-clobber-your-working-tree family — the errors a
 *  stash → run → reapply recovery can turn into a one-click fix. Measured
 *  verbatim on git 2.51.1.windows.1 (lower-cased here, matched
 *  case-insensitively; git prefixes them with `error:`).
 *
 *  Deliberately disjoint from CONFLICT_MARKERS: a real merge conflict already
 *  has ConflictBanner recovery, and stashing mid-conflict corrupts the resolve
 *  state. No conflict output observed on git 2.51 carries these strings.
 *
 *  Paired with the Rust canary `refusal_stderr_still_matches_the_frontend_markers`
 *  (autostash.rs), which re-runs each refusal and asserts these literals still
 *  match — keep the two lists in step. */
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

/** Lines that echo a commit subject behind a real diagnostic prefix: the op word
 *  in `could not apply <sha>… rebase the parser` is user text, not git's. */
const SUBJECT_ECHO_LINE = /^(?:error: )?[Cc]ould not (?:apply|revert) /;

/** git names the paused operation in its own continue-advice, which a bare
 *  subject mentioning an op word does not carry. `--continue` ONLY: our own
 *  recovery prose tells users to run `git cherry-pick --abort`, and an abort
 *  remedy inside another operation's message must not name the op. */
const OP_ADVICE = /\bgit (rebase|merge|cherry-pick|revert) --continue\b/;

/** The paused operation, capitalized for the summary. Read only from git's
 *  advice lines — never the whole blob — so a cherry-pick of a commit titled
 *  "rebase the parser" still reads "Cherry-pick". The split mirrors the markers'
 *  `m` flag, which ends a line at a bare CR too — git has been observed joining
 *  its `Rebasing (n/m)` progress to the diagnostic after it with one. */
function conflictOp(text: string): string {
  for (const line of text.split(/\r\n|[\n\r]/)) {
    if (SUBJECT_ECHO_LINE.test(line)) continue;
    const op = OP_ADVICE.exec(line)?.[1];
    if (op) {
      return op === "cherry-pick"
        ? "Cherry-pick"
        : op.charAt(0).toUpperCase() + op.slice(1);
    }
  }
  return "Operation";
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
    // git's `could not apply <sha>… <subject>` echo IS line one of a conflict,
    // so the verdict anchor has to reject that shape too — ops.rs pins that a
    // real verdict line never fronts git's own conflict output.
    const [verdictLine] = combined.split(/\r\n|[\n\r]/, 1);
    const rolledBack =
      !SUBJECT_ECHO_LINE.test(verdictLine) &&
      ROLLBACK_VERDICTS.some((v) => verdictLine.includes(v));
    const isConflict =
      !rolledBack && CONFLICT_MARKERS.some((m) => m.test(combined));
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
