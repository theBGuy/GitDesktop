import type { DroppedCommit, PullWouldDrop } from "@/lib/git/api";
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
  conflict: "Merge conflict",
  pullRebaseWouldDrop: "Pull blocked",
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

/** Conflict-family markers — the FALLBACK classifier, for `git`-kind errors from
 *  a producer that doesn't carry the structured `conflict` variant. Anchored to
 *  git's own diagnostic line shapes and
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
  // <sha>…` tail line (rebase); a revert says `could not revert` for the same
  // thing. The rest of that report (`CONFLICT (…`) rides stdout, which the
  // revert/cherry-pick/rebase cores now carry into the error alongside stderr,
  // so both markers arrive. Deliberately the same shape as SUBJECT_ECHO_LINE
  // below: the line that PROVES a conflict is the one that must not be read as
  // its NAME.
  /^(?:error: )?[Cc]ould not (?:apply|revert) /m,
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
 *  markers above would match. Read from the FIRST line only, since an unanchored
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
  // Plain `rebase` and `rebase --onto` refuse the same way, on ANY dirty tracked
  // file rather than an overlapping one. Kept at full length: the bare
  // "you have unstaged changes" suffix would subsume the two lines above and
  // widen the match against arbitrary git output.
  "cannot rebase: you have unstaged changes",
  "cannot rebase: your index contains uncommitted changes",
];

/** Force-push rejections whose reason git prints ONLY inside its per-ref
 *  `! [rejected]        main -> main (<reason>)` line — everything above and
 *  below that line is the remote URL and a generic "failed to push some refs",
 *  which is what a raw summary would otherwise show. Anchored to that line
 *  shape and matched case-sensitively, since the same blob echoes branch names
 *  and URLs. The leading space is optional: the Rust layer trims the whole
 *  report, so the line loses its indent whenever nothing precedes it.
 *
 *  Only the two guarded-force reasons are mapped. A plain non-fast-forward
 *  rejection (`(non-fast-forward)`, `(fetch first)`) means the branch is simply
 *  behind — different advice, and git's own hint already reads plainly — so it
 *  keeps its raw presentation.
 *
 *  Paired with the Rust canaries
 *  `force_push_rejection_stderr_still_matches_the_frontend_markers` and
 *  `force_push_refuses_fetched_but_unintegrated_remote_work` (git/remote.rs),
 *  which re-run real rejections and assert these reasons still hold — keep the
 *  two lists in step. */
const PUSH_REJECTION_SUMMARIES: readonly (readonly [RegExp, string])[] = [
  // The bare lease refused: the remote-tracking ref no longer describes the
  // remote, so git can't tell what the push would destroy. The advice has to
  // reach past a bare fetch — that satisfies the lease but leaves
  // `--force-if-includes` to reject the retry with the reason below.
  [
    /^[ \t]*! \[rejected\][^\n]*\(stale info\)/m,
    "Force push blocked — the remote moved since your last fetch. Fetch and review the new commits, then bring them into your branch before pushing.",
  ],
  // `--force-if-includes` refused: the remote tip was fetched but never merged
  // or rebased into this branch, so pushing would drop it.
  [
    /^[ \t]*! \[rejected\][^\n]*\(remote ref updated since checkout\)/m,
    "Force push blocked — the remote has commits your branch hasn't incorporated. Pull them in, then push again.",
  ],
];

/** The humanized line for a blocked force push, or null when the text carries
 *  no mapped rejection reason. */
function pushRejectionSummary(text: string): string | null {
  return PUSH_REJECTION_SUMMARIES.find(([m]) => m.test(text))?.[1] ?? null;
}

/** Windows MAX_PATH refusals. git prints its reason as the TAIL of a diagnostic
 *  (`fatal: cannot create directory at '<path>': Filename too long`, measured on
 *  git 2.51.1.windows.1), so the marker is end-anchored like `: needs merge`
 *  above — the same blob echoes paths and commit subjects, which an unanchored
 *  phrase would match. glibc spells the same errno "File name too long", which
 *  this deliberately does not match: the remedy below is Windows-only. */
const LONG_PATH_MARKERS = [/: Filename too long\s*$/m];

/** The app's own git calls already pass `-c core.longpaths=true` (git/runner.rs),
 *  so a path this long fails only where that flag can't reach — hence the remedy
 *  is aimed at the user's other tools rather than at GitDesktop. */
const LONG_PATH_SUMMARY =
  "Paths in this repository are longer than Windows allows by default. GitDesktop's own Git commands handle them; other tools need Windows long paths and git config --global core.longpaths true.";

/** The humanized line for a path-length refusal, or null when the text carries
 *  none. */
function longPathSummary(text: string): string | null {
  return LONG_PATH_MARKERS.some((m) => m.test(text)) ? LONG_PATH_SUMMARY : null;
}

/** GitHub's secret push protection refusing a push. Measured verbatim from a
 *  real rejection (github.com over HTTPS, 2026-08-11): the block arrives as
 *  `remote:`-prefixed lines carrying a `- GITHUB PUSH PROTECTION` section whose
 *  violation bullet reads `- Push cannot contain secrets`.
 *
 *  The `GH013` code that heads the same block is deliberately NOT a marker: it
 *  covers every repository rule violation, so a branch-name or signature rule
 *  would borrow advice about secrets. The secret-type banner, the file locations
 *  and the unblock URL all vary per detection and stay in Details.
 *
 *  Anchored at line start only — GitHub pads every `remote:` line with trailing
 *  spaces, which an end-anchored marker would miss. Paired with the Rust canary
 *  `push_protection_stderr_still_matches_the_frontend_markers` (git/remote.rs),
 *  which pins these line shapes against the measured stderr. */
const PUSH_PROTECTION_MARKERS = [
  /^[ \t]*remote:[ \t]*-[ \t]*GITHUB PUSH PROTECTION\b/m,
  /^[ \t]*remote:[ \t]*-[ \t]*Push cannot contain secrets\b/m,
];

/** GitHub refuses the push whole, so the secret is still only local and the
 *  cheap remedy — rewriting the commit — is still open. Saying that is the
 *  point: a user who reads this as a transient failure retries past it. */
const PUSH_PROTECTION_SUMMARY =
  "GitHub blocked this push because it detected a likely secret, so nothing was pushed. Remove the secret from the commits and push again, or if it is a false positive, open the unblock link GitHub printed in the details.";

/** The humanized line for a push blocked by secret push protection, or null when
 *  the text carries no such block. */
function pushProtectionSummary(text: string): string | null {
  return PUSH_PROTECTION_MARKERS.some((m) => m.test(text))
    ? PUSH_PROTECTION_SUMMARY
    : null;
}

/** The `git` kind is the only one carrying a stderr blob distinct from its
 *  message; every other kind folds its detail into `message` itself. */
function gitStderr(e: AppError): string {
  return e.kind === "git" ? (e.stderr?.trim() ?? "") : "";
}

/**
 * Whether a thrown value is git refusing an operation because it would
 * overwrite uncommitted work — the pull / merge / rebase / switch dirty-tree
 * family that stash-and-reapply recovers from. Anything else (including real merge
 * conflicts) returns false and keeps its normal error presentation.
 */
export function isDirtyTreeRefusal(e: unknown): boolean {
  const text = isAppError(e)
    ? `${e.message ?? ""}\n${gitStderr(e)}`
    : e instanceof Error
      ? e.message
      : String(e);
  const lower = text.toLowerCase();
  return DIRTY_TREE_MARKERS.some((m) => lower.includes(m));
}

/** The `PullWouldDrop` string fields the decision flow actually consumes — the
 *  five SHAs and refs it hands back to git, plus the message it may present. */
const PULL_WOULD_DROP_STRINGS = [
  "message",
  "branch",
  "upstream",
  "branchTip",
  "newTip",
  "mergeBase",
  "forkPoint",
] as const satisfies readonly (keyof PullWouldDrop)[];

/** A commit entry the dialog can render. `author`/`authorDate` are declared on
 *  `DroppedCommit` but deliberately NOT checked: nothing displays them, so a
 *  Rust rename there should degrade an unread field rather than fail the whole
 *  classifier and strand the user on a dead-end toast. */
function isDroppedCommit(c: unknown): c is DroppedCommit {
  if (typeof c !== "object" || c === null) return false;
  const r = c as Record<string, unknown>;
  return typeof r.sha === "string" && typeof r.subject === "string";
}

/**
 * Whether a thrown value is the rebase-pull fork-point refusal, narrowed to the
 * payload the decision dialog reads. The fields it acts on are checked rather
 * than trusted — five of them go back to git as rebase arguments, and an empty
 * commit list would ask the user about nothing — so a payload that cannot answer
 * the question reads as `false` and keeps the ordinary error presentation.
 */
export function isPullWouldDrop(e: unknown): e is PullWouldDrop {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  if (r.kind !== "pullRebaseWouldDrop") return false;
  if (!PULL_WOULD_DROP_STRINGS.every((k) => typeof r[k] === "string"))
    return false;
  return (
    Array.isArray(r.commits) &&
    r.commits.length > 0 &&
    r.commits.every(isDroppedCommit)
  );
}

/** Marker the decided pull commands lead a moved-branch refusal with (Rust's
 *  `PULL_DECISION_STALE`, git/pull_guard.rs) — keep the literal in step. */
const PULL_DECISION_STALE_MARKER = "PULL_DECISION_STALE";

/** What to tell the user when a decision outlived the state it was made about.
 *  Every SHA the answer pinned is gone, so the remedy is a fresh pull rather
 *  than a retry — shared so the direct and stash-retry paths cannot drift. */
export const PULL_DECISION_STALE_MESSAGE = "The branch moved — pull again.";

/** Whether `e` is a decided pull refused because the branch moved underneath it.
 *  Reads the raw message: Rust prefixes the marker onto an ordinary `command`
 *  error rather than giving it a kind of its own. */
export function isStalePullDecision(e: unknown): boolean {
  const message = isAppError(e)
    ? (e.message ?? "")
    : e instanceof Error
      ? e.message
      : String(e);
  return message.includes(PULL_DECISION_STALE_MARKER);
}

/** Lines that echo a commit subject behind a real diagnostic prefix: the op word
 *  in `could not apply <sha>… rebase the parser` is user text, not git's. */
const SUBJECT_ECHO_LINE = /^(?:error: )?[Cc]ould not (?:apply|revert) /;

/** git names the paused operation in its own continue-advice, which a bare
 *  subject mentioning an op word does not carry. `--continue` ONLY: our own
 *  recovery prose tells users to run `git cherry-pick --abort`, and an abort
 *  remedy inside another operation's message must not name the op. */
const OP_ADVICE = /\bgit (rebase|merge|cherry-pick|revert) --continue\b/;

/** A conflicted merge is the one family git gives no `--continue` advice for —
 *  it prints this verdict instead, on stdout. Both the plain merge and a
 *  merge-mode `pull` carry that stdout into the error (`git_merge_core` and
 *  `run_git_mutating_with_creds`), so this names either one. Line-anchored,
 *  because the phrase is otherwise reachable as user text. Rebase and
 *  cherry-pick emit it on neither stream, so it means a merge unambiguously —
 *  all of it pinned by the Rust canary
 *  `conflict_output_still_matches_the_anchored_frontend_markers` (autostash.rs);
 *  keep the two in step. */
const MERGE_VERDICT = /^Automatic merge failed/;

/** The paused operation and the action that finishes it. The name is read only
 *  from git's advice and verdict lines — never the whole blob — so a cherry-pick
 *  of a commit titled "rebase the parser" still reads "Cherry-pick". The split
 *  mirrors the markers' `m` flag, which ends a line at a bare CR too — git has
 *  been observed joining its `Rebasing (n/m)` progress to the diagnostic after it
 *  with one.
 *
 *  A merge known only by its verdict ends in "commit", not "continue": that arm
 *  also covers `merge --squash`, which writes no MERGE_HEAD (pinned by
 *  `local_pr_finish_squash_all_ours_is_a_known_no_op`), so no banner Continue
 *  exists to point at — and committing is how a plain merge finishes anyway. */
function conflictSummary(text: string): string {
  const paused = (op: string, finish: string) =>
    `${op} paused — resolve the conflicts, then ${finish}.`;
  const lines = text.split(/\r\n|[\n\r]/);
  for (const line of lines) {
    if (SUBJECT_ECHO_LINE.test(line)) continue;
    const op = OP_ADVICE.exec(line)?.[1];
    if (op) {
      const name =
        op === "cherry-pick"
          ? "Cherry-pick"
          : op.charAt(0).toUpperCase() + op.slice(1);
      return paused(name, "continue");
    }
  }
  // Advice first: it is the stronger signal, and only its absence leaves the
  // merge verdict as the sole name for the paused operation.
  if (lines.some((line) => MERGE_VERDICT.test(line)))
    return paused("Merge", "commit");
  return paused("Operation", "continue");
}

/** What a paused operation is called and how the user finishes it, keyed by the
 *  `op` a structured conflict names. Same grammar as `conflictSummary` above,
 *  which has to read the name out of git's own advice instead. The stash trio
 *  has no `--continue` to point at, so each says where its changes ended up:
 *  pop and apply keep the entry (measured, git 2.51.1), while `stash-restore`
 *  recovers a DANGLING stash that is already off the list — promising a kept
 *  entry there would send the user looking for one that isn't coming back. */
const CONFLICT_SUMMARIES: Record<string, string> = {
  merge: "Merge paused — resolve the conflicts, then commit.",
  rebase: "Rebase paused — resolve the conflicts, then continue.",
  "cherry-pick": "Cherry-pick paused — resolve the conflicts, then continue.",
  revert: "Revert paused — resolve the conflicts, then continue.",
  "stash-pop": "Stash pop hit conflicts — resolve them; your stash was kept.",
  "stash-apply":
    "Stash apply hit conflicts — resolve them; your stash was kept.",
  "stash-restore":
    "Restore hit conflicts — resolve them; the recovered changes are in your working tree.",
};

/** Mirrors `conflictSummary`'s own unknown-operation line, so an `op` the Rust
 *  layer adds ahead of a table entry still reads as a paused operation. */
const UNKNOWN_CONFLICT_SUMMARY =
  "Operation paused — resolve the conflicts, then continue.";

/** Count of non-empty lines in a string. */
function nonEmptyLineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

/**
 * Humanize any thrown value into a toast-friendly summary plus the raw full
 * text. AppErrors get a kind label; plain Error/string values get label null and
 * their first line as the summary. Conflict-family errors collapse to one calm
 * "<Op> paused" line while preserving the raw dump in `fullText` — from the
 * structured `conflict` variant where the producer carries it, from the anchored
 * prose markers otherwise.
 */
export function presentError(e: unknown): ErrorPresentation {
  if (isAppError(e)) {
    const label = KIND_LABELS[e.kind];
    // Keyed on the kind rather than on `isPullWouldDrop`, so a payload too
    // malformed to open the decision dialog still gets the one human sentence
    // Rust already wrote for it instead of falling through to raw git output.
    if (e.kind === "pullRebaseWouldDrop") {
      const message = e.message ?? "";
      return { label, summary: message, fullText: message, long: false };
    }

    // The structured variant first: the Rust layer already named the paused
    // operation, so nothing is inferred from prose. The markers below stay for
    // `git`-kind errors — every producer not carrying the structured variant.
    if (e.kind === "conflict") {
      // The Rust layer substitutes a one-line stand-in into `message` when git
      // wrote to neither stream, so falling back to it keeps Details populated
      // in the one case `report` cannot fill — and `long` follows the report,
      // since that stand-in says no more than the summary already does.
      const report = (e.report ?? "").trim();
      return {
        label,
        summary: CONFLICT_SUMMARIES[e.op] ?? UNKNOWN_CONFLICT_SUMMARY,
        fullText: report || (e.message ?? ""),
        long: report !== "",
      };
    }

    const message = e.message ?? "";
    const stderr = gitStderr(e);
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
    // A rejection reason is read from the COMBINED text: it rides the `stderr`
    // blob, which the fall-through below deliberately never reads.
    // A path-length failure outranks conflict framing: git could not write the
    // tree, so no conflict flow is actually waiting to be resolved. Push
    // protection outranks both: the remote refused the push whole, which is
    // neither a conflict nor the non-fast-forward story below.
    const summary =
      pushProtectionSummary(combined) ??
      longPathSummary(combined) ??
      (isConflict
        ? conflictSummary(combined)
        : (pushRejectionSummary(combined) ??
          (firstMeaningfulLine(message) || label)));

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
