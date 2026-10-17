#!/usr/bin/env node
// Record-scoped pending reads in reused views. A detail view or strip that one
// mounted instance reuses across records must read a write's in-flight state from
// the mutation cache, matched on the record its variables name: an observer's
// `isPending`/`isPaused` is instance state, so the next record shows the previous
// one's spinner or held control. This gate fails on observer pending reads in the
// member files below unless a reviewed allowlist entry admits them.
//
// Fails on, in a member file (code only: comments, strings and JSX text masked):
//   - `X.isPending` / `X.isPaused`, optional (`X?.isPending`) or bracket
//     (`X["isPending"]`) access;
//   - destructuring `isPending`/`isPaused` (renamed, typed, or beside a nested
//     pattern) from a call or from an identifier;
//   - `X.status` compared with "pending"/"idle" when `X` is bound by a
//     same-file `use…(` call;
//   - any `useMutationState(` or `useIsMutating(` call.
//
// Run: node scripts/check-reused-view-pending.mjs [--root <dir>] [file…]
// Files are repo-relative and default to MEMBERS; --root points the scan at a
// copy of the tree (a negative control over pre-fix copies keeps their paths).
// Node stdlib only: CI's guards job runs it before installing anything.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { lineOf, maskNonCode, ScanError } from "./lib/ts-mask.mjs";

/** The reused views and strips this gate scans. Fixed by design: a new reused
 *  view is unguarded until it is added here. */
export const MEMBERS = [
  "src/features/issues/RemoteIssueView.tsx",
  "src/features/issues/RemoteIssueViewParts.tsx",
  "src/features/issues/LocalIssueView.tsx",
  "src/features/issues/JiraIssueView.tsx",
  "src/features/issues/PromoteLocalIssueDialog.tsx",
  "src/features/tags/TagDetailView.tsx",
  "src/features/discussions/DiscussionView.tsx",
  "src/features/pulls/LocalPrView.tsx",
  "src/features/pulls/PromoteLocalPrDialog.tsx",
  "src/features/pulls/RemotePrView.tsx",
  "src/features/pulls/CommitComments.tsx",
  "src/features/pulls/PendingReviewStrip.tsx",
  "src/features/pulls/PendingReviewBar.tsx",
  "src/features/pulls/ReviewHistory.tsx",
  "src/features/pulls/ResolveConflictsView.tsx",
  "src/features/pulls/SubmitReviewDialog.tsx",
  "src/features/projects/ProjectStatusStrip.tsx",
  "src/features/pulls/PullRequestsPanel.tsx",
  "src/features/history/HistoryDialogs.tsx",
];

/** What the gate cannot see, printed with every failure. */
export const LIMITATIONS = [
  "a plain useState busy flag is not machine-checkable (review-enforced)",
  "the member list is fixed: a new reused view is unguarded until added to MEMBERS",
  "an observer passed whole as a prop, or spread into a non-member child, escapes the scan",
  'status forms other than an equality compare are not read: switch (m.status), ["pending"].includes(m.status), a destructured or aliased status compared later, !m.isIdle and the other is* flags',
  "destructuring nested more than one level deep is not read",
];

const QUERY = "query read";
const WORKING_TREE = "repo-wide: one working tree";
const PROMOTE_PAUSED = "own-run paused axis under the record slot";
const DRAFT_CARD = "mounted keyed per draft (RemotePrViewParts.tsx)";
const SUBMIT_DIALOG =
  "dialog keyed per PR (RemotePrView.tsx); locks its own mount";

/** One file's entries for top-level function `fn`, as
 *  `[receiver, binding, props, reason]` rows. */
function entries(file, fn, rows) {
  return rows.map(([receiver, binding, props, reason]) => ({
    file,
    fn,
    receiver,
    binding,
    props,
    reason,
  }));
}

/**
 * Reviewed exceptions. Each admits reads of `props` on `receiver` inside the
 * top-level function `fn` of `file`, and only while `fn` still binds `receiver`
 * from `binding` (`const receiver = binding(…)`, or `receiver` destructured from
 * `binding`). An entry whose binding is gone, or that admits no read, fails.
 */
export const ALLOWLIST = [
  ...entries("src/features/issues/RemoteIssueView.tsx", "RemoteIssueView", [
    ["forge", "useForgeStatus", ["isPending"], QUERY],
    ["targetDetails", "useIssueDetails", ["isPaused"], QUERY],
    ["details", "useIssueDetails", ["isPending", "isPaused"], QUERY],
  ]),
  ...entries(
    "src/features/issues/RemoteIssueViewParts.tsx",
    "IssueTimeTrackingSection",
    [["stats", "useGlIssueTimeStats", ["isPending"], QUERY]],
  ),
  ...entries(
    "src/features/issues/RemoteIssueViewParts.tsx",
    "IssueLinksSection",
    [["links", "useGlIssueLinks", ["isPending"], QUERY]],
  ),
  ...entries("src/features/issues/JiraIssueView.tsx", "StatusMenu", [
    ["transitions", "useJiraTransitions", ["isPaused"], QUERY],
  ]),
  ...entries("src/features/issues/JiraIssueView.tsx", "JiraAssigneePicker", [
    ["users", "useJiraUserSearch", ["isPending", "isPaused"], QUERY],
  ]),
  ...entries("src/features/issues/JiraIssueView.tsx", "JiraPriorityMenu", [
    ["priorities", "useJiraPriorities", ["isPaused"], QUERY],
  ]),
  ...entries("src/features/issues/JiraIssueView.tsx", "JiraLabelsPopover", [
    ["known", "useJiraLabels", ["isPaused"], QUERY],
  ]),
  ...entries("src/features/issues/JiraIssueView.tsx", "JiraIssueView", [
    ["link", "useJiraLink", ["isPending"], QUERY],
    ["details", "useJiraIssue", ["isPending", "isPaused"], QUERY],
  ]),
  ...entries(
    "src/features/issues/PromoteLocalIssueDialog.tsx",
    "PromoteLocalIssueDialog",
    [
      ["createIssue", "useCreateIssue", ["isPaused"], PROMOTE_PAUSED],
      ["jiraCreate", "useJiraCreateIssue", ["isPaused"], PROMOTE_PAUSED],
      ["jiraTypes", "useJiraIssueTypes", ["isPending"], QUERY],
    ],
  ),
  ...entries("src/features/tags/TagDetailView.tsx", "TagDetailView", [
    ["checkout", "useCheckoutCommit", ["isPending"], WORKING_TREE],
  ]),
  ...entries("src/features/discussions/DiscussionView.tsx", "DiscussionView", [
    ["details", "useDiscussionDetails", ["isPending"], QUERY],
  ]),
  ...entries("src/features/pulls/LocalPrView.tsx", "LocalPrView", [
    ["defaultBranch", "useDefaultBranch", ["isPending"], QUERY],
  ]),
  ...entries(
    "src/features/pulls/PromoteLocalPrDialog.tsx",
    "PromoteLocalPrDialog",
    [["createPr", "useCreatePr", ["isPaused"], PROMOTE_PAUSED]],
  ),
  ...entries("src/features/pulls/RemotePrView.tsx", "RemotePrView", [
    ["forge", "useForgeStatus", ["isPending"], QUERY],
    ["targetDetails", "usePrDetails", ["isPaused"], QUERY],
    ["defaultBranch", "useDefaultBranch", ["isPending"], QUERY],
    ["conflictPreview", "useConflictPreview", ["isPending"], QUERY],
    ["findResolve", "useFindRemotePrResolve", ["isPending"], QUERY],
    ["details", "usePrDetails", ["isPending", "isPaused"], QUERY],
    ["reviewThreads", "usePrReviewThreads", ["isPaused"], QUERY],
    ["approvals", "usePrApprovals", ["isPending"], QUERY],
    ["prDiff", "usePrDiff", ["isPending", "isPaused"], QUERY],
  ]),
  ...entries("src/features/pulls/CommitComments.tsx", "CommitComments", [
    ["comments", "useCommitComments", ["isPaused"], QUERY],
  ]),
  ...entries("src/features/pulls/CommitComments.tsx", "CommitLineComposer", [
    [
      "createLineComment",
      "useCreateCommitComment",
      ["isPending"],
      "reads isPending only on its own mount, which unmounts on submit (onClose on the same tick)",
    ],
  ]),
  ...entries("src/features/pulls/PendingReviewBar.tsx", "DraftCommentCard", [
    ["updateDraft", "useUpdateReviewDraft", ["isPending"], DRAFT_CARD],
    ["removeDraft", "useRemoveReviewDraft", ["isPending"], DRAFT_CARD],
  ]),
  ...entries(
    "src/features/pulls/SubmitReviewDialog.tsx",
    "SubmitReviewDialog",
    [
      [
        "submitReview",
        "useSubmitReview",
        ["isPending", "isPaused"],
        SUBMIT_DIALOG,
      ],
      ["clearDrafts", "useClearReviewDrafts", ["isPending"], SUBMIT_DIALOG],
    ],
  ),
  ...entries("src/features/pulls/PullRequestsPanel.tsx", "PullRequestsPanel", [
    [
      "reviewState",
      "usePrReviewState",
      ["isPaused"],
      "query read: lens-wide review state",
    ],
    ["gh", "useForgeStatus", ["isPending"], QUERY],
    ["prList", "usePrList", ["isPending"], QUERY],
  ]),
  ...entries("src/features/history/HistoryDialogs.tsx", "ResetCommitDialog", [
    ["resetMutation", "useResetToCommit", ["isPending"], WORKING_TREE],
  ]),
  ...entries("src/features/history/HistoryDialogs.tsx", "useMainlineChoice", [
    ["parents", "useCommitParents", ["isPending"], QUERY],
  ]),
  ...entries("src/features/history/HistoryDialogs.tsx", "MainlineParentList", [
    [
      "parents",
      "choice",
      ["isPending"],
      "query read, destructured from useMainlineChoice",
    ],
  ]),
  ...entries(
    "src/features/history/HistoryDialogs.tsx",
    "CherryPickOntoDialog",
    [["cherryPickOnto", "useCherryPickOnto", ["isPending"], WORKING_TREE]],
  ),
  ...entries("src/features/history/HistoryDialogs.tsx", "MergeParentDialog", [
    ["revertCommit", "useRevertCommit", ["isPending"], WORKING_TREE],
    ["cherryPick", "useCherryPick", ["isPending"], WORKING_TREE],
  ]),
];

const PENDING_PROPS = new Set(["isPending", "isPaused"]);
// `!?` admits a non-null assertion (`m!.isPending`, `m!["isPending"]`).
const PROP_READ =
  /([\w$]+|\)|\])\s*!?\s*(\?\.|\.)\s*(isPending|isPaused)(?![\w$])/g;
const BRACKET_OPEN = /([\w$]+|\)|\])\s*!?\s*(?:\?\.)?\s*\[\s*/g;
const BRACKET_KEY = /^(['"`])(isPending|isPaused)\1\s*\]/;
// One level of nested pattern (`variables: { tag } = {}`) and a type annotation
// (`}: T =`) are admitted; nested keys are blanked before the key match.
const DESTRUCTURE =
  /\{((?:[^{}]|\{[^{}]*\})*)\}\s*(?::[^=;{}]+)?=\s*(?:await\s+)?([A-Za-z_$][\w$.]*)\s*(<[^>]*>\s*)?(\()?/g;
const NESTED_PATTERN = /\{[^{}]*\}/g;
const DESTRUCTURED_KEY = /(?:^|,)\s*(isPending|isPaused)\s*(?=[,:=]|$)/g;
const STATUS_READ = /([\w$]+)\s*\??\.\s*status(?![\w$])/g;
const STATUS_AFTER = /^\s*[!=]==?\s*(['"`])(pending|idle)\1/;
const STATUS_BEFORE = /(['"`])(pending|idle)\1\s*[!=]==?\s*$/;
const BANNED_CALL =
  /(?<![\w$.])(useMutationState|useIsMutating)\s*(?:<[^>]*>\s*)?\(/g;
const TOP_LEVEL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The top-level declarations of masked source as `{name, start, end}` spans,
 *  each running to the next top-level statement: the sources are formatter-laid,
 *  so a top-level statement starts at column 0 and nothing nested does. Anything
 *  else at column 0 (types, imports, closers aside) starts an unnamed span. */
export function topLevelSpans(masked) {
  const spans = [];
  let offset = 0;
  for (const line of masked.split("\n")) {
    if (/^[A-Za-z_$@]/.test(line)) {
      const m = line.match(TOP_LEVEL);
      if (spans.length) spans[spans.length - 1].end = offset;
      spans.push({ name: m ? (m[1] ?? m[2]) : null, start: offset, end: -1 });
    }
    offset += line.length + 1;
  }
  if (spans.length) spans[spans.length - 1].end = masked.length;
  return spans;
}

const spanAt = (spans, index) =>
  spans.find((s) => index >= s.start && index < s.end) ?? null;

/** Whether `body` binds `receiver` from `binding`: `const receiver = binding(`
 *  (generic arguments allowed) or `receiver` destructured from `binding`. */
export function bindsReceiver(body, receiver, binding) {
  const b = escapeRe(binding);
  const r = escapeRe(receiver);
  const direct = new RegExp(
    String.raw`(?:const|let)\s+${r}\s*(?::[^=]+)?=\s*(?:await\s+)?${b}\s*(?:<[^>]*>\s*)?\(`,
  );
  if (direct.test(body)) return true;
  const destructured = new RegExp(
    String.raw`(?:const|let)\s*\{([^{}]*)\}\s*=\s*${b}(?![\w$])`,
    "g",
  );
  for (const m of body.matchAll(destructured))
    if (new RegExp(String.raw`(?:^|[,:\s])${r}\s*(?=[,=}]|$)`).test(m[1]))
      return true;
  return false;
}

/** Same-file `const X = use…(` bindings: the receivers a `.status` read counts
 *  as hook-bound. */
function hookBound(masked) {
  const out = new Set();
  for (const m of masked.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*use[A-Z][\w$]*\s*(?:<[^>]*>\s*)?\(/g,
  ))
    out.add(m[1]);
  for (const m of masked.matchAll(
    /(?:const|let)\s*\{([^{}]*)\}\s*=\s*use[A-Z][\w$]*\s*(?:<[^>]*>\s*)?\(/g,
  ))
    for (const k of m[1].matchAll(/(?:^|,)\s*(?:[\w$]+\s*:\s*)?([\w$]+)/g))
      out.add(k[1]);
  return out;
}

/**
 * The pending reads in one source file, each `{file, line, fn, receiver, prop,
 * form}`. `receiver` is the identifier before the access (`(call)` / `[index]`
 * when an expression), or the destructured source. Throws ScanError-backed
 * errors on code it cannot mask: an unreadable file fails, never passes.
 */
export function pendingReads(src, file) {
  let masked;
  try {
    masked = maskNonCode(src, file.endsWith(".tsx"));
  } catch (err) {
    if (err instanceof ScanError)
      throw new Error(`could not scan ${file}: ${err.message}`);
    throw err;
  }
  const spans = topLevelSpans(masked);
  const reads = [];
  const push = (index, receiver, prop, form) =>
    reads.push({
      file,
      line: lineOf(src, index),
      fn: spanAt(spans, index)?.name ?? null,
      receiver,
      prop,
      form,
    });
  const recv = (r) => {
    if (r === ")") return "(call)";
    if (r === "]") return "[index]";
    return r;
  };
  for (const m of masked.matchAll(PROP_READ))
    push(m.index, recv(m[1]), m[3], m[2] === "?." ? "optional" : "property");
  for (const m of masked.matchAll(BRACKET_OPEN)) {
    const at = m.index + m[0].length;
    const key = src.slice(at).match(BRACKET_KEY);
    if (key && masked[at] === key[1])
      push(m.index, recv(m[1]), key[2], "bracket");
  }
  for (const m of masked.matchAll(DESTRUCTURE)) {
    // A function's parameter list is followed by `)` or a type, never `=`:
    // only an assignment destructures a call result or an identifier.
    const keys = m[1].replace(NESTED_PATTERN, (n) => " ".repeat(n.length));
    for (const k of keys.matchAll(DESTRUCTURED_KEY))
      push(m.index, m[2], k[1], m[4] ? "destructure-call" : "destructure");
  }
  const bound = hookBound(masked);
  for (const m of masked.matchAll(STATUS_READ)) {
    if (!bound.has(m[1])) continue;
    const end = m.index + m[0].length;
    const after = src.slice(end).match(STATUS_AFTER);
    const before = src
      .slice(Math.max(0, m.index - 40), m.index)
      .match(STATUS_BEFORE);
    if (
      (after && masked[end + after[0].indexOf(after[1])] === after[1]) ||
      before
    )
      push(m.index, m[1], "status", "status");
  }
  for (const m of masked.matchAll(BANNED_CALL))
    push(m.index, m[1], m[1], "banned-call");
  return { reads, masked, spans };
}

const isAdmissible = (read) =>
  PENDING_PROPS.has(read.prop) &&
  (read.form === "property" || read.form === "optional");

/**
 * The verdict over `sources` (repo-relative path → text, or null when the file
 * could not be read) against `allowlist`: `violations` are reads no entry admits,
 * `stale` are entries whose binding is gone or that admit nothing, `errors` are
 * files that could not be read or scanned. Entries for files not in `sources`
 * are out of this run's scope.
 */
export function verdict(sources, allowlist = ALLOWLIST) {
  const violations = [];
  const errors = [];
  const used = new Set();
  const stale = [];
  if (sources.size === 0)
    errors.push("no files scanned; refusing to pass vacuously");
  const scanned = new Map();
  for (const [file, src] of sources) {
    if (typeof src !== "string") {
      errors.push(`${file}: missing or unreadable`);
      continue;
    }
    try {
      scanned.set(file, pendingReads(src, file));
    } catch (err) {
      errors.push(err.message);
    }
  }
  const bodyOf = (file, fn) => {
    const s = scanned.get(file);
    const span = s?.spans.find((x) => x.name === fn);
    return span ? s.masked.slice(span.start, span.end) : null;
  };
  for (const entry of allowlist) {
    if (!scanned.has(entry.file)) continue;
    const body = bodyOf(entry.file, entry.fn);
    if (body === null || !bindsReceiver(body, entry.receiver, entry.binding))
      stale.push(
        `${entry.file} ${entry.fn}: ${entry.receiver} is no longer bound from ${entry.binding} (stale allowlist entry)`,
      );
  }
  for (const { reads } of scanned.values()) {
    for (const read of reads) {
      const idx = isAdmissible(read)
        ? allowlist.findIndex(
            (e) =>
              e.file === read.file &&
              e.fn === read.fn &&
              e.receiver === read.receiver &&
              e.props.includes(read.prop),
          )
        : -1;
      if (idx >= 0) used.add(idx);
      else violations.push(read);
    }
  }
  for (const [i, entry] of allowlist.entries()) {
    if (!scanned.has(entry.file) || used.has(i)) continue;
    if (
      stale.some((s) =>
        s.startsWith(`${entry.file} ${entry.fn}: ${entry.receiver} `),
      )
    )
      continue;
    stale.push(
      `${entry.file} ${entry.fn}: ${entry.receiver}.{${entry.props.join(",")}} admits no read (unused allowlist entry)`,
    );
  }
  return { violations, stale, errors };
}

const formatRead = (r) =>
  `${r.file}:${r.line} ${r.receiver}.${r.prop} (${r.form}, in ${r.fn ?? "<top level>"})`;

function main() {
  const args = process.argv.slice(2);
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
      if (args[i + 1] === undefined) {
        process.stderr.write(
          "reused-view-pending: FAIL --root needs a directory\n",
        );
        process.exitCode = 1;
        return;
      }
      root = resolve(args[++i]);
    } else files.push(args[i].replaceAll("\\", "/"));
  }
  const sources = new Map();
  for (const file of files.length ? files : MEMBERS) {
    let src = null;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      // Recorded as unreadable; the verdict fails on it.
    }
    sources.set(file, src);
  }
  const { violations, stale, errors } = verdict(sources);
  if (violations.length || stale.length || errors.length) {
    const lines = [
      "reused-view-pending: FAIL",
      ...errors,
      ...violations.map(
        (r) =>
          `${formatRead(r)}: read the write's pending state from the mutation cache, matched on the record (usePendingRepoWrites + pendingWriteMatching), or add a reviewed ALLOWLIST entry`,
      ),
      ...stale,
      "Recorded limitations:",
      ...LIMITATIONS.map((l) => `  - ${l}`),
    ];
    process.stderr.write(`${lines.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `reused-view-pending: OK ${sources.size} files, ${ALLOWLIST.length} reviewed exceptions\n`,
  );
}

// Path comparison keeps this gate active without relying on import.meta.main.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
