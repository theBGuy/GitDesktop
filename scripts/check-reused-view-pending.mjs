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
//     same-file `use…(` call, and any spread (`...X`: JSX, object or argument)
//     of a whole hook result;
//   - any `useMutationState(` or `useIsMutating(` call (namespaced, under an
//     import alias, or as a bracket key too) and any `.isMutating(` call;
//   - a member with no named top-level declaration (empty, or a re-export
//     stub), or with a non-ASCII character in its code.
// A chained receiver (`ops.details.isPending`) reads as its whole chain, so it
// never matches an entry pinned to the bare name; a chained status receiver
// (`ops.save.status`) counts by its root.
//
// Run: node scripts/check-reused-view-pending.mjs [--root <dir>] [file…]
// Files are repo-relative and default to MEMBERS; --root points the scan at a
// copy of the tree (a negative control over pre-fix copies keeps their paths).
// Node stdlib only: CI's guards job runs it before installing anything.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  "a member whose body moved elsewhere still passes the declaration rule while it keeps a named const, an alias (`= Impl`) or a `lazy(…)` stub",
  "any spread of a whole hook result is flagged (`...m` or `...(m as P)`, in JSX, an object or an argument list, where `m` is `const m = useX(…)` or a hook destructure's rest element); indirection is not followed: an observer passed whole as a prop (`m={m}`) or argument (`f(m)`, `Object.assign({}, m)`), and so a status compare on it in the component or helper that receives it (hook-bound names are collected per top-level function), an aliased spread (`const p = m; {...p}`), a result held in an object literal (`{ m: useX() }`), a conditional or logical operand (`{...(c ? m : n)}`, `{...(flag && m)}`)",
  "a banned hook is caught under its own name, an import alias, a namespace or a bracket key; a hook taken as a value (`const h = useIsMutating; h()`), destructured off a namespace import (`const { useIsMutating: busy } = RQ`) or re-exported from a local module is not",
  'status forms other than an equality compare of a hook-bound name against a quoted "pending"/"idle" are not read: switch (m.status), ["pending"].includes(m.status), a named constant or an `as const` literal on the other side, a destructured status or an aliased receiver (p = m; p.status) compared later, useX().status, m["status"], a cast operand ((m.status as string) === "pending"), a parenthesised or cast receiver ((m as T).status === "pending"), a comment between the status and its compare, !m.isIdle and the other is* flags; nor is a status receiver bound by a destructure two levels deep. Conversely, a custom hook returning an entity whose own status is compared (`const { run } = useSelectedRun(); run.status === "pending"`) fails closed, and a status compare cannot be allowlisted: compare on `.data` or an isPending-free field, or restructure',
  "destructuring nested more than one level deep is not read, nor is a destructure whose sibling default holds nested braces (`{ isPending, opts = { a: {} } } = m`) or whose type annotation holds braces; a binding or destructure whose annotation holds an arrow type (`=>`) is not read (as hook-bound, or as a pending destructure), nor is an annotated declarator after a comma (`const a = 1, m: T = useX()`); type arguments nested four or more levels deep hide the hook call or banned hook they sit on, and a destructured pin over such a call skips its member-read check",
  'destructuring outside a declaration is not read: callback parameters (`[a, b].some(({ isPending }) => isPending)`), function parameters and for-of heads; nor is a computed key (`const { ["isPending"]: p } = m`), a variable bracket key (`m[k]`) or an array destructure of a hook result (a tuple-returning hook, `useQueries`)',
  "a legal shadow of an allowlisted name satisfies the entry's binding pin: a callback parameter (`writes.filter((details) => details.isPending)`), a nested function's own binding, a for / for-of loop binding, a block-scoped const or let, or a catch parameter",
  "an entry whose receiver is a prop (MainlineParentList's `choice`) is pinned by the prop's name only, never by the hook its type names; with a namespace admitted, a member named like the prop (`x.choice`) satisfies it too",
  "a top-level line that starts with neither a name nor a keyword (an IIFE) joins the preceding function's span, and code inside a multi-line template interpolation that sits at column 0 starts a new unnamed span: an allowlisted read there fails closed, while a status compare or spread there fails open, having lost its binding's span",
  "the masker reads a postfix `++`/`--` before `/` as a regex opener (a later `/` on that line closes it and blanks the code between), reads a regex literal right after a brace-less `if (…)`, `while (…)` or `for (…)` as a division (a quote inside it blanks to the next quote, and a non-ASCII character inside it fails closed), and lexes a generic arrow whose type parameter has a default (`<T = string>(x: T) => x`) or a generic function type in an annotation (`const f: <T>(x: T) => T = …`) as JSX, which fails closed",
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
 * `binding`). An entry whose binding is gone, or with an admitted prop no read
 * uses, fails. Only `receiver.prop` / `receiver?.prop` reads can be admitted: a
 * query's status compare or a destructured flag is rewritten to that form.
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
    ["details", "useDiscussionDetails", ["isPending", "isPaused"], QUERY],
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
// The access a receiver hangs off (`ops.` in `ops.details`), read backwards.
const CHAIN_LINK = /([\w$]+|\)|\])\s*!?\s*(?:\?\.|\.)\s*$/;
// One level of nested pattern (`createPr: { isPending }`) and a type annotation
// (`}: T =`) are admitted; a nested pattern's keys are read like the outer ones.
const DESTRUCTURE =
  /\{((?:[^{}]|\{[^{}]*\})*)\}\s*(?::[^=;{}]+)?=\s*(?:await\s+)?([A-Za-z_$][\w$.]*)\s*(<[^>]*>\s*)?(\()?/g;
const DESTRUCTURED_KEY = /(?:^|[,{])\s*(isPending|isPaused)\s*(?=[,:=}]|$)/g;
const STATUS_READ = /([\w$]+)\s*!?\s*(?:\?\.|\.)\s*status(?![\w$])/g;
const STATUS_AFTER = /^\s*[!=]==?\s*(['"`])(pending|idle)\1/;
const STATUS_BEFORE = /(['"`])(pending|idle)\1\s*[!=]==?\s*$/;
// Generic arguments (`<A<B<C>>, D>`), balanced to three levels; an arrow's `=>`
// inside a type never closes them.
const ANGLE_BODY = String.raw`(?:[^<>=]|=(?!>)|=>)`;
const GENERIC = String.raw`(?:<(?:${ANGLE_BODY}|<(?:${ANGLE_BODY}|<${ANGLE_BODY}*>)*>)*>\s*)?`;
// Any namespace (`api.`, `api?.`, `a.b.`) before a hook or a banned name.
const NAMESPACE = String.raw`(?:[\w$]+\s*(?:\?\.|\.)\s*)*`;
const BANNED_HOOKS = ["useMutationState", "useIsMutating"];
const BANNED_METHOD = new RegExp(
  String.raw`\.\s*(isMutating)\s*${GENERIC}\(`,
  "g",
);
// A banned name as a bracket key (`qc["isMutating"](`, `RQ["useIsMutating"](`):
// the bracket is read on masked text and its quoted key on the raw source.
const BANNED_KEY = /^(['"`])(isMutating|useIsMutating|useMutationState)\1\s*\]/;
// Read over MASKED text, so a comment inside the braces never reaches a
// specifier; the `from` string is masked too, so the raw text confirms it.
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])/g;
const RQ_SOURCE = /^(['"])@tanstack\/react-query\1/;
// Masked code holds `...` only in spreads and rest elements; the rest elements
// of a hook destructure are skipped where they are declared (see pendingReads),
// so every other `...name` is a spread. Parentheses and casts around the operand
// (`...(m as P)`) are read through; a member access or call on it (`...m.data`,
// `...(m as X).data`) spreads a field, not the result.
const SPREAD =
  /\.\.\.\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?![\w$])(?!(?:\s+as\s+[^)]*)?(?:\s*\))*\s*!?\s*(?:\?\.|\.|\[|\())/g;
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
  for (const [i, raw] of masked.split("\n").entries()) {
    // Line 1 may open with a blanked byte-order mark.
    const line = i === 0 ? raw.replace(/^ /, "") : raw;
    // A column-0 `${` is a multi-line template's interpolation, not a statement.
    if (/^[A-Za-z_$@]/.test(line) && !line.startsWith("${")) {
      const m = line.match(TOP_LEVEL);
      if (spans.length) spans[spans.length - 1].end = offset;
      spans.push({ name: m ? (m[1] ?? m[2]) : null, start: offset, end: -1 });
    }
    offset += raw.length + 1;
  }
  if (spans.length) spans[spans.length - 1].end = masked.length;
  return spans;
}

const spanAt = (spans, index) =>
  spans.find((s) => index >= s.start && index < s.end) ?? null;

// A destructure pattern's body, one nested level (`data: { x }`, `data = {}`).
const PATTERN_BODY = String.raw`((?:[^{}]|\{[^{}]*\})*)`;
// A nested pattern blanked, so only a pattern's own top-level keys are read.
const topKeys = (keys) =>
  keys.replace(/\{[^{}]*\}/g, (n) => " ".repeat(n.length));

/** Whether `body` binds `receiver` from `binding`: `const receiver = binding(`
 *  (namespace and generic arguments allowed) or `receiver` destructured, at the
 *  pattern's top level, from `binding` itself (never a member of it). */
export function bindsReceiver(body, receiver, binding) {
  const b = escapeRe(binding);
  const r = escapeRe(receiver);
  // `const` only: a `let` binding can be reassigned to another hook's result
  // after the line the pin reads.
  const direct = new RegExp(
    String.raw`const\s+${r}\s*(?::[^=]+)?=\s*(?:await\s+)?${NAMESPACE}${b}(?![\w$])`,
    "g",
  );
  for (const m of body.matchAll(direct)) {
    const end = callEnd(body, m.index + m[0].length);
    if (end !== null && wholeBinding(body, end)) return true;
  }
  const destructured = new RegExp(
    String.raw`const\s*\{${PATTERN_BODY}\}\s*(?::[^=;{}]+)?=\s*${NAMESPACE}${b}(?![\w$])`,
    "g",
  );
  for (const m of body.matchAll(destructured)) {
    const at = m.index + m[0].length;
    if (
      // The receiver is a key itself (`{ parents }`, `{ parents = d }`), never a
      // rename target of another key (`{ revert: parents }`).
      new RegExp(String.raw`(?:^|,)\s*${r}\s*(?=[,=}]|$)`).test(
        topKeys(m[1]),
      ) &&
      wholeBinding(body, callEnd(body, at) ?? at)
    )
      return true;
  }
  return false;
}

/** The index past the call that opens at `at` (generic arguments allowed),
 *  or null when no call opens there. */
function callEnd(text, at) {
  const open = text.slice(at).match(new RegExp(String.raw`^\s*${GENERIC}\(`));
  if (!open) return null;
  let depth = 0;
  for (let i = at + open[0].length - 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return null;
}

/** Whether the bound value ends at `end`: a member read after it
 *  (`= useChoice(a).parents`, `= choice.x`) binds a field, and a fallback
 *  (`?? other`, `|| other`) may bind something else entirely. */
function wholeBinding(text, end) {
  return !/^\s*!?\s*(?:\?\.|\.|\[|\?\?|\|\|)/.test(text.slice(end, end + 20));
}

// A hook call, namespaced (`api.useX(`, `api?.useX(`, `a.b.useX(`) or not, with
// optional generic arguments.
const HOOK_CALL = String.raw`${NAMESPACE}use[A-Z][\w$]*\s*${GENERIC}\(`;
// A declarator after `const`/`let` (type annotation allowed), or an unannotated
// one after a comma in a declaration list (`const a = 1,\n  m = useX()`): an
// annotation there would read an object key (`k: v, …`) as one.
const HOOK_RESULT = new RegExp(
  String.raw`(?:\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?|,\s*([A-Za-z_$][\w$]*)\s*)=\s*${HOOK_CALL}`,
  "g",
);
const HOOK_DESTRUCTURE = new RegExp(
  String.raw`(?:const|let)\s*\{${PATTERN_BODY}\}\s*(?::[^=;{}]+)?=\s*${HOOK_CALL}`,
  "g",
);
const REST_ELEMENT = /\.\.\.\s*([A-Za-z_$][\w$]*)/g;

/** Where each `{…}` pattern of a hook destructure sits: its rest elements are
 *  declared there, never spread. */
function hookPatterns(masked) {
  return [...masked.matchAll(HOOK_DESTRUCTURE)].flatMap((m) => {
    if (readsData(masked, m.index + m[0].length - 1)) return [];
    const from = m.index + m[0].indexOf("{") + 1;
    return [{ from, to: from + m[1].length, keys: topKeys(m[1]) }];
  });
}

/** Whether the hook call opening at `open` is read into its `data`
 *  (`useX(…).data`, `useX(…)!.data`, `useX(…)?.data`): what that binds is the
 *  query's data, not the observer (the reading the status scan gives a `data`
 *  link). */
function readsData(text, open) {
  const end = callEnd(text, open);
  return end !== null && /^\s*!?\s*\??\.\s*data(?![\w$])/.test(text.slice(end));
}

/** Same-file whole hook results: `const X = use…(` bindings and the top-level
 *  rest element of a hook destructure (`{ data, ...rest } = use…(`), which
 *  still carries the pending flags. These are the receivers a spread passes on. */
function hookResults(masked) {
  const out = new Set();
  for (const m of masked.matchAll(HOOK_RESULT))
    if (!readsData(masked, m.index + m[0].length - 1)) out.add(m[1] ?? m[2]);
  for (const { keys } of hookPatterns(masked))
    for (const r of keys.matchAll(REST_ELEMENT)) out.add(r[1]);
  return out;
}

/** {@link hookResults} plus the names destructured from a `use…(` call: the
 *  receivers a `.status` read counts as hook-bound. A name bound from the
 *  `data` key (`{ data }`, `{ data: run }`) is the query's data and is left out. */
function hookBound(masked) {
  const out = hookResults(masked);
  for (const { keys } of hookPatterns(masked))
    for (const k of keys.matchAll(/(?:^|,)\s*(?:([\w$]+)\s*:\s*)?([\w$]+)/g))
      if ((k[1] ?? k[2]) !== "data") out.add(k[2]);
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
  // Every receiver pattern reads ASCII identifiers, so a non-ASCII character in
  // code (text, strings and comments are masked) could hide a read or pose as
  // part of an allowlisted name: it fails rather than being read past.
  const wide = masked.search(/[^\x00-\x7F]/);
  if (wide !== -1)
    throw new Error(
      `could not scan ${file}: non-ASCII character in code at line ${lineOf(src, wide)}`,
    );
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
  // The whole access chain ending at `name` (`ops.details`), so a chained
  // receiver never satisfies an entry pinned to the bare name.
  const chainFrom = (index, name) => {
    let chain = name;
    let start = index;
    for (;;) {
      const from = Math.max(0, start - 200);
      const link = masked.slice(from, start).match(CHAIN_LINK);
      if (!link) return { chain, start };
      chain = `${recv(link[1])}.${chain}`;
      start = from + link.index;
      if (link[1] === ")" || link[1] === "]") return { chain, start };
    }
  };
  const chainAt = (index, name) => chainFrom(index, name).chain;
  for (const m of masked.matchAll(PROP_READ))
    push(
      m.index,
      chainAt(m.index, recv(m[1])),
      m[3],
      m[2] === "?." ? "optional" : "property",
    );
  for (const m of masked.matchAll(BRACKET_OPEN)) {
    const at = m.index + m[0].length;
    const key = src.slice(at).match(BRACKET_KEY);
    if (key && masked[at] === key[1])
      push(m.index, chainAt(m.index, recv(m[1])), key[2], "bracket");
  }
  for (const m of masked.matchAll(DESTRUCTURE)) {
    // A function's parameter list is followed by `)` or a type, never `=`:
    // only an assignment destructures a call result or an identifier.
    for (const k of m[1].matchAll(DESTRUCTURED_KEY))
      push(m.index, m[2], k[1], m[4] ? "destructure-call" : "destructure");
  }
  // Hook-bound names per top-level span, so a binding in one component never
  // marks a same-named one in another; code outside every span reads the file's.
  const scopes = new Map();
  const scopeOf = (index) => {
    const span = spanAt(spans, index);
    const key = span ?? "file";
    if (!scopes.has(key)) {
      const text = span ? masked.slice(span.start, span.end) : masked;
      scopes.set(key, { results: hookResults(text), bound: hookBound(text) });
    }
    return scopes.get(key);
  };
  // A hook result spread anywhere (`<Child {...m} />`, `{ ...m, x }`, `f(...m)`)
  // carries its pending flags past the scan, so it fails like a read.
  const patterns = hookPatterns(masked);
  const declaresRest = (at) => patterns.some((p) => at >= p.from && at < p.to);
  for (const m of masked.matchAll(SPREAD))
    if (scopeOf(m.index).results.has(m[1]) && !declaresRest(m.index))
      push(m.index, m[1], "...", "spread");
  for (const m of masked.matchAll(STATUS_READ)) {
    // A chained receiver (`ops.save.status`) counts by its root, unless the
    // chain runs through a query's `data`: that status is the entity's own.
    const { chain, start } = chainFrom(m.index, m[1]);
    const [root, ...links] = chain.split(".");
    if (!scopeOf(m.index).bound.has(root) || links.includes("data")) continue;
    const end = m.index + m[0].length;
    const after = src.slice(end).match(STATUS_AFTER);
    // A reversed compare (`"pending" === ops.save.status`) sits before the
    // chain's start, not before its last link.
    const before = src
      .slice(Math.max(0, start - 40), start)
      .match(STATUS_BEFORE);
    if (
      (after && masked[end + after[0].indexOf(after[1])] === after[1]) ||
      before
    )
      push(m.index, chain, "status", "status");
  }
  // The banned hooks by their own names and by any local alias an import from
  // the package gives them; `isMutating` is their imperative twin.
  const banned = new Set(BANNED_HOOKS);
  for (const imp of masked.matchAll(NAMED_IMPORT)) {
    const quoteAt = imp.index + imp[0].length - 1;
    if (!RQ_SOURCE.test(src.slice(quoteAt))) continue;
    for (const spec of imp[1].split(",")) {
      const [name, alias] = spec.replace(/^\s*type\s+/, "").split(/\s+as\s+/);
      if (alias && BANNED_HOOKS.includes(name.trim())) banned.add(alias.trim());
    }
  }
  // The real names may sit behind a namespace (`RQ.useIsMutating(`); a local
  // alias may not, since `editor.busy()` is another object's method.
  const aliases = [...banned].filter((n) => !BANNED_HOOKS.includes(n));
  const callOf = (names, lead) =>
    new RegExp(
      String.raw`${lead}(${names.map(escapeRe).join("|")})\s*${GENERIC}\(`,
      "g",
    );
  // An object-method shorthand (`{ busy() {} }`) declares the name, not a call.
  const isShorthand = (open) => {
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")" && --depth === 0)
        return /^\s*\{/.test(masked.slice(i + 1, i + 40));
    }
    return false;
  };
  const calls = [callOf(BANNED_HOOKS, String.raw`(?<![\w$])`)];
  if (aliases.length) calls.push(callOf(aliases, String.raw`(?<![\w$.])`));
  for (const call of calls)
    for (const m of masked.matchAll(call))
      if (!isShorthand(m.index + m[0].length - 1))
        push(m.index, m[1], m[1], "banned-call");
  for (const m of masked.matchAll(BANNED_METHOD))
    push(m.index, m[1], m[1], "banned-call");
  for (const m of masked.matchAll(BRACKET_OPEN)) {
    const at = m.index + m[0].length;
    const key = src.slice(at).match(BANNED_KEY);
    if (
      key &&
      masked[at] === key[1] &&
      new RegExp(String.raw`^\s*(?:\?\.)?\s*${GENERIC}\(`).test(
        masked.slice(at + key[0].length),
      )
    )
      push(m.index, key[2], key[2], "banned-call");
  }
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
      const scan = pendingReads(src, file);
      // A view declares its component (a function, or a const holding an arrow
      // or a memo): an empty, whitespace-only or re-export stub member has
      // nothing for the scan to read, so it fails.
      if (!scan.spans.some((s) => s.name !== null))
        errors.push(
          `${file}: no top-level declaration to scan (empty, or a re-export stub)`,
        );
      else scanned.set(file, scan);
    } catch (err) {
      errors.push(err.message);
    }
  }
  const bodyOf = (file, fn) => {
    const s = scanned.get(file);
    const span = s?.spans.find((x) => x.name === fn);
    return span ? s.masked.slice(span.start, span.end) : null;
  };
  const unbound = new Set();
  for (const [i, entry] of allowlist.entries()) {
    if (!scanned.has(entry.file)) continue;
    const body = bodyOf(entry.file, entry.fn);
    if (body === null || !bindsReceiver(body, entry.receiver, entry.binding)) {
      unbound.add(i);
      stale.push(
        `${entry.file} ${entry.fn}: ${entry.receiver} is no longer bound from ${entry.binding} (stale allowlist entry)`,
      );
    }
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
      // Usage is per (entry, prop): an admitted prop no read uses is stale too.
      if (idx >= 0) used.add(`${idx}:${read.prop}`);
      else violations.push(read);
    }
  }
  for (const [i, entry] of allowlist.entries()) {
    // An unbound entry already failed; each other entry reports on its own.
    if (!scanned.has(entry.file) || unbound.has(i)) continue;
    for (const prop of entry.props)
      if (!used.has(`${i}:${prop}`))
        stale.push(
          `${entry.file} ${entry.fn}: ${entry.receiver}.${prop} admits no read (unused allowlist entry)`,
        );
  }
  return { violations, stale, errors };
}

const formatRead = (r) =>
  `${r.file}:${r.line} ${r.receiver}.${r.prop} (${r.form}, in ${r.fn ?? "<top level>"})`;

/** A CLI file argument as the repo-relative posix key the allowlist uses:
 *  resolved against `root` (`./src/…` and an absolute path inside it alike),
 *  and on a case-insensitive filesystem (win32, and macOS's default APFS)
 *  matched to a member's spelling. */
export function fileKey(root, arg, platform = process.platform) {
  const rel = relative(root, resolve(root, arg)).split(sep).join("/");
  if (platform !== "win32" && platform !== "darwin") return rel;
  return MEMBERS.find((m) => m.toLowerCase() === rel.toLowerCase()) ?? rel;
}

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
    } else files.push(args[i]);
  }
  const sources = new Map();
  const keys = files.map((f) => fileKey(root, f));
  for (const file of keys.length ? keys : MEMBERS) {
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
  const checked = ALLOWLIST.filter((e) => sources.has(e.file)).length;
  process.stdout.write(
    `reused-view-pending: OK ${sources.size} files, ${checked} reviewed exceptions\n`,
  );
}

// Path comparison keeps this gate active without relying on import.meta.main.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
