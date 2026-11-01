// Pins the fire-time push re-checks on the routes that move or remove a branch
// ref (rename, local delete, archive, reset to upstream, pull-drop, the
// stash-reapply reruns) or delete branches in bulk (Clean up), every HEAD push
// recording the branch it starts on, and the Ctrl+B modal gate. A dialog
// opened before a push started still submits after it, so each submit reads
// the pending pushes live; render state alone predates them.
//
// The source checker is a pure function over file text, so the suite feeds it
// the real files (must pass) and in-memory mutants with a check removed (must
// fail). It fails closed: a missing file, anchor or needle is a failure.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";
import { pushesBranch } from "../src/features/repository/branch-sync-state.ts";
import { elementInOpenModal } from "../src/lib/hotkeys/open-modal.ts";

const R = "src/features/repository/";
const DERIVED =
  "`A push is already running — ${fallback} is checked out and ${deleteTarget} was kept.`";

/** Each pin: a handler anchor in `file`, and needles that must appear in its
 *  body IN ORDER. `mutate` lists the needles whose removal must fail the pin. */
const PINS = [
  {
    name: "rename submit",
    file: `${R}RenameBranchDialog.tsx`,
    anchor: "onSubmit: async ({ value }) =>",
    seq: [
      "if (!target) return;",
      "refuseWhileBranchPushes(queryClient, repoPath, target, currentName)",
      "promotionBlocksCheckout(repoPath)",
      "await renameBranch.mutateAsync",
    ],
    mutate: [
      "refuseWhileBranchPushes(queryClient, repoPath, target, currentName)",
    ],
  },
  {
    name: "rename helper",
    file: `${R}RenameBranchDialog.tsx`,
    anchor: "function refuseWhileBranchPushes(",
    seq: [
      "branchPushKey(repoPath)",
      "pushesBranch(pushes, branch, currentName)",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: ["pushesBranch(pushes, branch, currentName)"],
  },
  {
    name: "local delete",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "async function doDelete() {",
    seq: [
      "isDeletionBlocked(rulesConfig, deleteTarget)",
      "if (refuseWhileBranchPushes(deleteTarget)) return;",
      "try {",
      "await listUserWorktrees(repoPath)",
      '"before the delete started"',
      "if (refuseWhileBranchPushes(deleteTarget)) return;",
      "await checkout.mutateAsync(fallback)",
      "`before ${deleteTarget} was deleted`",
      "refuseWhileBranchPushes(",
      DERIVED,
      "await deleteBranch.mutateAsync(deleteTarget)",
    ],
    mutate: ["if (refuseWhileBranchPushes(deleteTarget)) return;", DERIVED],
  },
  {
    name: "archive",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "async function setArchived(name: string, archived: boolean) {",
    seq: [
      "if (archived && refuseWhileBranchPushes(name)) return;",
      "await setBranchArchived.mutateAsync",
    ],
    mutate: ["if (archived && refuseWhileBranchPushes(name)) return;"],
  },
  {
    name: "switcher reset to upstream",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "async function doResetToUpstream(",
    seq: [
      "useConfirm.getState().ask",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (refuseWhileBranchPushes(branch.name)) return;",
      "branchRewriteStatusOptions(repoPath, branch.name)",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (refuseWhileBranchPushes(branch.name)) return;",
      "await hardReset.mutateAsync",
    ],
    mutate: ["if (refuseWhileBranchPushes(branch.name)) return;"],
  },
  {
    name: "switcher helper",
    file: `${R}BranchSwitcher.tsx`,
    anchor: "function refuseWhileBranchPushes(",
    seq: [
      "publishDetectRef.current",
      "branchPushKey(repoPath)",
      "detect.branch === branch",
      "!branchPushing(branch)",
      "!pushesBranch(live, branch, currentNameRef.current)",
      "toast.info(message)",
    ],
    mutate: [
      "detect.branch === branch",
      "!branchPushing(branch)",
      "!pushesBranch(live, branch, currentNameRef.current)",
    ],
  },
  {
    name: "show-branches modal gate",
    file: `${R}BranchSwitcher.tsx`,
    anchor: '"show-branches",',
    seq: ["if (focusInOpenModal()) return;", "setOpen(true)"],
    mutate: ["if (focusInOpenModal()) return;"],
  },
  {
    name: "sync reset to upstream",
    file: `${R}SyncControls.tsx`,
    anchor: "async function doResetToUpstream() {",
    seq: [
      "useConfirm.getState().ask",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (headNameRef.current !== branch) {",
      "if (refuseWhileBranchPushes(branch)) return;",
      "branchRewriteStatusOptions(repoPath, branch)",
      'if (refuseIfSwitched(resetIn, "nothing was reset")) return;',
      "if (refuseWhileBranchPushes(branch)) return;",
      "await hardReset.mutateAsync",
    ],
    mutate: ["if (refuseWhileBranchPushes(branch)) return;"],
  },
  {
    // The header's push is the one push that can name no branch.
    name: "sync header push records its start",
    file: `${R}SyncControls.tsx`,
    anchor: "async function doPush(",
    seq: [
      "await push.mutateAsync({",
      "branch,",
      "startedOn: branch === undefined ? headNameRef.current : undefined,",
      "});",
    ],
    mutate: [
      "startedOn: branch === undefined ? headNameRef.current : undefined,",
    ],
  },
  {
    name: "sync helper",
    file: `${R}SyncControls.tsx`,
    anchor: "function refuseWhileBranchPushes(branch: string): boolean {",
    seq: [
      "branchPushKey(repoPath)",
      "pushesBranch(pushes, branch, headNameRef.current ?? null)",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: ["pushesBranch(pushes, branch, headNameRef.current ?? null)"],
  },
  {
    name: "clean up batch",
    file: `${R}CleanupBranchesDialog.tsx`,
    anchor: "async function runBatch() {",
    seq: [
      "if (refuseWhilePushRuns(queryClient, repoPath)) return;",
      "setFailed(new Map());",
      "for (let i = 0; i < names.length; i++) {",
      "if (refuseWhilePushRuns(queryClient, repoPath)) {",
      "processed = i;",
      "break;",
      "await api.gitSetBranchArchived",
      "const ok = processed - fails.size;",
      "if (processed < names.length) {",
      "} else if (ok > 0) toast.success(`${verb} ${pluralBranches(ok)}`);",
      "return;",
      "if (fails.size === 0) {",
      "onClose();",
    ],
    mutate: [
      "if (refuseWhilePushRuns(queryClient, repoPath)) return;",
      "if (refuseWhilePushRuns(queryClient, repoPath)) {",
      "const ok = processed - fails.size;",
      "if (processed < names.length) {",
    ],
  },
  {
    name: "pull-drop decide",
    file: `${R}usePullDropGuard.tsx`,
    anchor: "async function decide(decision: PullDecision) {",
    seq: [
      "toast.info(PROMOTION_BLOCKS_CHECKOUT);",
      "if (refuseWhileBranchPushes(queryClient, repoPath, refusal.branch)) return;",
      "setRunning(decision);",
    ],
    mutate: [
      "if (refuseWhileBranchPushes(queryClient, repoPath, refusal.branch)) return;",
    ],
  },
  {
    name: "pull-drop helper",
    file: `${R}usePullDropGuard.tsx`,
    anchor: "function refuseWhileBranchPushes(",
    seq: [
      "repoKeys.branches(repoPath)",
      "b.isCurrent",
      "branchPushKey(repoPath)",
      "pushesBranch(pushes, branch, currentName)",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: ["pushesBranch(pushes, branch, currentName)"],
  },
  {
    name: "stash-reapply rerun",
    file: `${R}useStashReapplyRecovery.tsx`,
    anchor: "async function runRecovery(req: StashReapplyRequest) {",
    seq: [
      "refuseOutsideRepo(repoPath, req)",
      'if (req.run.op === "pull" && refuseWhileOffline()) return;',
      "if (refuseWhileRunPushes(queryClient, repoPath, req.run)) return;",
      "await runCompound(req.run)",
    ],
    mutate: [
      "if (refuseWhileRunPushes(queryClient, repoPath, req.run)) return;",
    ],
  },
  {
    name: "stash-reapply helper",
    file: `${R}useStashReapplyRecovery.tsx`,
    anchor: "function refuseWhileRunPushes(",
    seq: [
      'if (run.op === "pull" || run.op === "merge")',
      "return refuseWhilePushRuns(queryClient, repoPath);",
      "repoKeys.branches(repoPath)",
      'run.op === "pullRebaseDecided" ? run.branch : currentName',
      "branch === null",
      "isBranchPushActive(queryClient, repoPath)",
      "pushesBranch(",
      "toast.info(BRANCH_PUSH_ACTIVE_MESSAGE)",
    ],
    mutate: [
      "return refuseWhilePushRuns(queryClient, repoPath);",
      "isBranchPushActive(queryClient, repoPath)",
      'run.op === "pullRebaseDecided" ? run.branch : currentName',
    ],
  },
];

/** The brace-matched body that follows `anchor`, or null when either is
 *  missing. Sources are CRLF-normalized first. */
function bodyAfter(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const open = text.indexOf("{", at + anchor.length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** Failures for `pins` over `sources` (file → text); empty means every pin
 *  holds. */
function checkPins(pins, sources) {
  const fails = [];
  for (const pin of pins) {
    const text = sources[pin.file];
    if (typeof text !== "string") {
      fails.push(`${pin.name}: missing file ${pin.file}`);
      continue;
    }
    const body = bodyAfter(text.replace(/\r\n/g, "\n"), pin.anchor);
    if (body === null) {
      fails.push(`${pin.name}: anchor not found: ${pin.anchor}`);
      continue;
    }
    let from = 0;
    for (const needle of pin.seq) {
      const at = body.indexOf(needle, from);
      if (at < 0) {
        fails.push(`${pin.name}: missing or out of order: ${needle}`);
        break;
      }
      from = at + needle.length;
    }
  }
  return fails;
}

const FILES = [...new Set(PINS.map((p) => p.file))];
const realSources = () =>
  Object.fromEntries(
    FILES.map((f) => [
      f,
      readFileSync(new URL(`../${f}`, import.meta.url), "utf8"),
    ]),
  );

test("pushesBranch: own, other, HEAD and unknown-current pushes", () => {
  const own = [{ branch: "feat" }];
  const other = [{ branch: "main" }];
  const head = [{ branch: null }];
  assert.equal(pushesBranch(own, "feat", "main"), true);
  assert.equal(pushesBranch(other, "feat", "feat"), false);
  assert.equal(pushesBranch(head, "feat", "feat"), true);
  assert.equal(pushesBranch(head, "feat", "main"), false);
  assert.equal(pushesBranch(head, "feat", null), true);
  assert.equal(pushesBranch([], "feat", null), false);
  assert.equal(pushesBranch([...other, ...own], "feat", "main"), true);
  // A null start is an unrecorded one: the rows above hold.
  const unrecorded = [{ branch: null, startedOn: null }];
  assert.equal(pushesBranch(unrecorded, "feat", "feat"), true);
  assert.equal(pushesBranch(unrecorded, "feat", "main"), false);
  assert.equal(pushesBranch(unrecorded, "feat", null), true);
});

/** The truth table for HEAD pushes with a recorded start, as
 *  [name, pushes, branch, currentName, expected]. */
const START_ROWS = [
  // Started on A, then a checkout to B: both hold, pinned (-u) or not.
  ["start, start", [{ branch: null, startedOn: "a" }], "a", "b", true],
  ["start, current", [{ branch: null, startedOn: "a" }], "b", "b", true],
  ["start, other", [{ branch: null, startedOn: "a" }], "c", "b", false],
  ["start, unknown", [{ branch: null, startedOn: "a" }], "c", null, true],
  [
    "pinned start, current",
    [{ branch: null, startedOn: "a", setUpstream: true }],
    "b",
    "b",
    true,
  ],
  [
    "pinned start, unknown",
    [{ branch: null, startedOn: "a", setUpstream: true }],
    "c",
    null,
    true,
  ],
  // No start: the current branch, or any while it is unknown.
  ["no start, current", [{ branch: null, startedOn: null }], "b", "b", true],
  ["no start, other", [{ branch: null, startedOn: null }], "a", "b", false],
  ["no start, unknown", [{ branch: null, startedOn: null }], "a", null, true],
  // A named push ignores any start it carries, and the current branch.
  ["named, its start", [{ branch: "c", startedOn: "a" }], "a", "a", false],
  ["named, its branch", [{ branch: "c", startedOn: "a" }], "c", "a", true],
];

test("pushesBranch: a HEAD push holds its recorded start and the current branch", () => {
  for (const [name, pushes, branch, current, want] of START_ROWS)
    assert.equal(pushesBranch(pushes, branch, current), want, name);
});

// Each mutant drops or bends one arm of the HEAD-push rules (start, current,
// unknown current, named push); the table must catch every one.
const PUSHES_BRANCH_MUTANTS = {
  "start ignored": (pushes, branch, current) =>
    pushes.some((p) =>
      p.branch !== null
        ? p.branch === branch
        : current === null || current === branch,
    ),
  "a recorded start replaces the current branch": (pushes, branch, current) =>
    pushes.some((p) => {
      if (p.branch !== null) return p.branch === branch;
      if ((p.startedOn ?? null) !== null) return p.startedOn === branch;
      return current === null || current === branch;
    }),
  "a pinned start replaces the current branch": (pushes, branch, current) =>
    pushes.some((p) => {
      if (p.branch !== null) return p.branch === branch;
      if (p.startedOn === branch) return true;
      if ((p.startedOn ?? null) !== null && p.setUpstream === true)
        return false;
      return current === null || current === branch;
    }),
  "an unknown current widens nothing": (pushes, branch, current) =>
    pushes.some((p) =>
      p.branch !== null
        ? p.branch === branch
        : p.startedOn === branch || current === branch,
    ),
  "current dropped": (pushes, branch) =>
    pushes.some((p) =>
      p.branch !== null ? p.branch === branch : p.startedOn === branch,
    ),
  "a HEAD push holds every branch": (pushes, branch) =>
    pushes.some((p) => p.branch === null || p.branch === branch),
  "a named push reads its start": (pushes, branch, current) =>
    pushes.some((p) => {
      if (p.startedOn === branch) return true;
      if (p.branch !== null) return p.branch === branch;
      return current === null || current === branch;
    }),
  "a named push holds nothing": (pushes, branch, current) =>
    pushes.some(
      (p) =>
        p.branch === null &&
        (p.startedOn === branch || current === null || current === branch),
    ),
};

test("pushesBranch mutants each fail a truth row, and every row fails one", () => {
  const caught = new Set();
  for (const [name, fn] of Object.entries(PUSHES_BRANCH_MUTANTS)) {
    let failed = false;
    for (const [row, pushes, branch, current, want] of START_ROWS)
      if (fn(pushes, branch, current) !== want) {
        failed = true;
        caught.add(row);
      }
    assert.ok(failed, `mutant "${name}" passes every row`);
  }
  for (const [row] of START_ROWS)
    assert.ok(caught.has(row), `no mutant fails row "${row}"`);
});

/** Two views of `text`, each the same UTF-16 length with newlines kept, so an
 *  offset in one is the same offset in `text`: `code` drops comments; `bare`
 *  also blanks string and template-literal text (quotes, backticks and `${…}`
 *  expressions stay). One string-aware pass. A `/` opens a
 *  regex literal after an operator, `(`, `,` or a keyword; a quote with no
 *  closing quote on its line is JSX text, not a string. Memoized per text: the
 *  mutants re-scan the same tree. */
const lexed = new Map();
function lex(text) {
  const hit = lexed.get(text);
  if (hit !== undefined) return hit;
  const views = lexOnce(text);
  lexed.set(text, views);
  return views;
}
function lexOnce(text) {
  // Code units, never code points: every index below is a UTF-16 offset.
  const code = text.split("");
  const bare = text.split("");
  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  const REGEX_AFTER =
    /[(,=:[!&|?{;+\-*%~^]$|\b(?:return|typeof|case|in|of|void|yield|await|do|else)$|^$/;
  const braces = []; // template-expression brace depths, innermost last
  let depth = 0;
  let i = 0;
  const readTemplate = () => {
    // At a backtick or a `}` closing an expression: text up to `${` or "`".
    const start = i + 1;
    let j = start;
    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "$" && text[j + 1] === "{") break;
      else j++;
    }
    blank(bare, start, Math.min(j, text.length));
    if (text[j] === "$") {
      braces.push(depth);
      depth++;
      i = j + 2;
    } else i = j + 1;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const to = end < 0 ? text.length : end;
      blank(code, i, to);
      blank(bare, i, to);
      i = to;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? text.length : end + 2;
      blank(code, i, to);
      blank(bare, i, to);
      i = to;
    } else if (
      c === "/" &&
      REGEX_AFTER.test(text.slice(Math.max(0, i - 8), i).trimEnd())
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      blank(bare, i + 1, j);
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n")
        j += text[j] === "\\" ? 2 : 1;
      if (text[j] === c) {
        blank(bare, i + 1, j);
        i = j + 1;
      } else i++;
    } else if (c === "`") {
      readTemplate();
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      if (braces.length > 0 && braces[braces.length - 1] === depth) {
        braces.pop();
        readTemplate();
      } else i++;
    } else i++;
  }
  const views = { code: code.join(""), bare: bare.join("") };
  if (views.code.length !== text.length || views.bare.length !== text.length)
    throw new Error("lex: a view's length differs from its text's");
  return views;
}

/** JS identifier spellings as regex source for the `u` flag: a start (Unicode
 *  ID_Start, `$` or `_`), then ID_Continue or `$`. A name spelled with an
 *  escape or a ZWNJ/ZWJ doesn't match, so the scan fails on it instead. */
const ID_PART = String.raw`[\p{ID_Continue}$]`;
const ID = String.raw`[\p{ID_Start}$_]${ID_PART}*`;
const escapeId = (name) => name.replace(/\$/g, () => "\\$");

// The CI guards job runs this suite with no install, so a runtime import in a
// module it loads from src/ would fail; this pin bans every import so none can
// slip in, re-exports and dynamic imports included. Matched over `lex`'s bare
// view, so neither a comment nor text inside a string hides or fakes one.
const IMPORT_FREE = [
  `${R}branch-sync-state.ts`,
  "src/lib/hotkeys/open-modal.ts",
];
const IMPORT_SHAPES = [
  new RegExp(
    String.raw`(^|[^\w$.])import\s*(type\s+)?(?:${ID_PART}|[\\{*])`,
    "u",
  ),
  /(^|[^\w$.])import\s*["'`]/,
  new RegExp(
    String.raw`(^|[^\w$.])export\s*(type\s+)?(\*(\s*as\s+${ID})?|\{[^}]*\})\s*from\s*["'\x60]`,
    "u",
  ),
  new RegExp(
    String.raw`(^|[^\w$.])import\s*\(\s*(?:["'\x60\\]|${ID_PART})`,
    "u",
  ),
];
const importsIn = (src) => {
  const { bare } = lex(src);
  return IMPORT_SHAPES.filter((re) => re.test(bare));
};
for (const file of IMPORT_FREE)
  test(`${file} stays import-free`, () => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.deepEqual(importsIn(src), []);
  });

test("the import-free check catches each import shape, and only real ones", () => {
  const src = readFileSync(
    new URL(`../${IMPORT_FREE[0]}`, import.meta.url),
    "utf8",
  );
  for (const line of [
    'import { x } from "./x";',
    'import type { X } from "./x";',
    'import "./x";',
    'export { x } from "./x";',
    'export * from "./x";',
    'export {\n  x,\n} from "./x";',
    'const m = await import("./x");',
    // A `/*` inside a string opens no comment.
    'const s = "/*"; import { x } from "./x"; // */',
    'const t = `${"/*"}`;\nimport { x } from "./x";',
  ])
    assert.notDeepEqual(importsIn(`${src}\n${line}\n`), [], line);
  for (const line of [
    "const s = \"import { x } from './x'\";",
    "const s = 'export * from \"./x\"';",
    'const t = `import("./x")`;',
    "// import { x } from './x';",
    "/* export * from './x'; */",
  ])
    assert.deepEqual(importsIn(`${src}\n${line}\n`), [], line);
});

// The usePush call scan. What it proves, over every src/ file: each file that
// imports `usePush` (by any local name) from the module that defines it or the
// queries barrel re-exporting it binds it only as `const <x> = <name>(…)`, and
// uses `<x>` only as `<x>.mutateAsync(…)` / `<x>.mutate(…)` with an object
// literal, or a read-only member in READ_MEMBERS. Each such object names its
// branch (`branch:` with a value other than a bare identifier or `undefined`)
// or records its start (`startedOn:`, same rule); a shorthand, bare-identifier
// or `undefined` value counts only inside a function BARE_BRANCH lists, whose
// value it reviewed as a string. A HEAD push with neither would hold only the
// current branch. Names match any JS identifier spelling but escapes and
// ZWNJ/ZWJ. Anything else it meets fails closed: an import clause, specifier
// or `from` of either module it can't read, another binding shape, any other
// use of `<x>`, a spread, a template literal or unreadable entry, a namespace
// import or re-export of either module, zero calls, a stale entry.
// What it can't see: values beyond that syntactic rule (a non-bare expression
// that evaluates to undefined), a dynamic `import()` of the module, a use of
// `<x>` that reads as JSX text (see proseAt), comments or strings the
// regex-literal heuristic in `lex` misreads, and pushes outside usePush.
const BARE_BRANCH = {
  [`${R}SyncControls.tsx`]: ["beginBarePush", "pushFromMenu"],
  [`${R}ForkPrPublishGuard.tsx`]: ["pushToFork"],
};
const READ_MEMBERS = ["isPending", "isPaused"];
const USE_PUSH_MODULES = new Set([
  "src/lib/git/queries/sync",
  "src/lib/git/queries",
  "src/lib/git/queries/index",
]);
const USE_PUSH_BARREL = "src/lib/git/queries/index.ts";

/** `spec` imported from `file`, as a src-rooted path without extension. */
function resolveSpec(file, spec) {
  let path;
  if (spec.startsWith("@/")) path = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) path = posix.join(posix.dirname(file), spec);
  else return spec;
  return path.replace(/\.(tsx?|jsx?|mjs)$/, "");
}

/** The top-level entries of the object literal opening at `open` in `code`
 *  (comments already dropped), or null when it holds a template literal or
 *  doesn't close. */
function objectEntries(code, open) {
  const entries = [];
  let cur = "";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "`") return null;
    if (c === '"' || c === "'") {
      const from = i;
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      cur += code.slice(from, i + 1);
    } else if ("{[(".includes(c)) {
      if (depth++ > 0) cur += c;
    } else if ("}])".includes(c)) {
      if (--depth === 0) {
        entries.push(cur);
        return entries.map((e) => e.trim()).filter((e) => e !== "");
      }
      cur += c;
    } else if (c === "," && depth === 1) {
      entries.push(cur);
      cur = "";
    } else cur += c;
  }
  return null;
}

/** The innermost `function NAME(` whose body contains `at`, or null. */
function enclosingFunction(code, at) {
  let best = null;
  const re = new RegExp(
    String.raw`(?<!${ID_PART})function\s+(${ID})\s*\(`,
    "gu",
  );
  for (const m of code.matchAll(re)) {
    if (m.index > at) break;
    const body = bodyAfter(code.slice(m.index), m[0]);
    if (body === null) continue;
    const open = m.index + code.slice(m.index).indexOf(body);
    if (at > open && at < open + body.length) best = m[1];
  }
  return best;
}

/** A name's own start: no identifier char before it, and no member dot (a
 *  spread's `...` still counts as a use). For the `u` flag. */
const NOT_MEMBER = String.raw`(?<!${ID_PART})(?<!(?:^|[^.])\.)`;
/** Every use of the identifier `name`, as a `u`-flag global regex. */
const usesOf = (name) =>
  new RegExp(`${NOT_MEMBER}${escapeId(name)}(?!${ID_PART})`, "gu");
const BOUND = new RegExp(
  String.raw`(?<!${ID_PART})const\s+(${ID})\s*=\s*$`,
  "u",
);
const BARE_VALUE = new RegExp(`^${ID}$`, "u");
const SPECIFIER = new RegExp(
  String.raw`^(?:type\s+)?(${ID})(?:\s+as\s+(${ID}))?$`,
  "u",
);
const DEFAULT_PART = new RegExp(String.raw`^\s*(?:${ID}\s*,?\s*)?$`, "u");

const lineOf = (text, at) => text.slice(0, at).split("\n").length;

/** Whether [from, to) reads as JSX text: a word before it, and after it a
 *  word, or sentence punctuation then a tag or a word. */
function proseAt(bare, from, to) {
  const left = bare.slice(0, from).trimEnd();
  const right = bare.slice(to);
  return (
    /\w$/.test(left) && /^(\s*\w|[?!.,:;]*\s*<|[?!.,:;]+\s+\w)/.test(right)
  );
}

/** How an entry's key counts: "strong" (a value the rule trusts), "bare"
 *  (shorthand, a bare identifier or `undefined`), or null when absent. */
function keyStrength(keys, name) {
  const k = keys.find((e) => e.key === name);
  if (k === undefined) return null;
  if (k.value === null || BARE_VALUE.test(k.value)) return "bare";
  return "strong";
}

/** Failures for the usePush call scan over `sources` (src-relative path ->
 *  text); empty means every call names its branch or records its start. */
function checkPushCalls(sources, bareBranch = BARE_BRANCH) {
  const fails = [];
  let calls = 0;
  const used = new Set();
  for (const [file, raw] of Object.entries(sources)) {
    const text = raw.replace(/\r\n/g, "\n");
    const { code, bare } = lex(text);
    const at = (i) => `${file}:${lineOf(text, i)}`;
    const locals = [];
    const importRanges = [];
    for (const m of code.matchAll(
      new RegExp(
        String.raw`(^|[^\w$.])(import|export)\s+(type\s+)?([\p{ID_Continue}$\\\s,{}*]*?)\s*from\s*(["'])([^"'\n]+)\5`,
        "gu",
      ),
    )) {
      const start = m.index + m[1].length;
      // Text inside a string that only looks like an import.
      if (bare[start] !== m[2][0]) continue;
      const target = resolveSpec(file, m[6]);
      if (!USE_PUSH_MODULES.has(target)) continue;
      importRanges.push([start, start + m[0].length - m[1].length]);
      const clause = m[4];
      if (m[2] === "export") {
        if (file !== USE_PUSH_BARREL)
          fails.push(`${at(start)}: re-exports a usePush module`);
        continue;
      }
      if (/\*\s*as\s/.test(clause)) {
        fails.push(`${at(start)}: namespace import of a usePush module`);
        continue;
      }
      const named = clause.match(/\{([^}]*)\}/);
      const head = named ? clause.replace(named[0], () => "") : clause;
      if (/[{}]/.test(head) || !DEFAULT_PART.test(head)) {
        fails.push(`${at(start)}: an import clause it can't read`);
        continue;
      }
      for (const spec of named ? named[1].split(",") : []) {
        if (spec.trim() === "") continue;
        const parts = spec.trim().match(SPECIFIER);
        if (parts === null)
          fails.push(`${at(start)}: an import specifier it can't read`);
        else if (parts[1] === "usePush") locals.push(parts[2] ?? parts[1]);
      }
    }
    const inImport = (i) => importRanges.some(([a, b]) => i >= a && i < b);
    // Every `from '<usePush module>'` must sit in a statement read above.
    for (const m of code.matchAll(/(^|[^\w$.])from\s*(["'])([^"'\n]+)\2/g)) {
      const start = m.index + m[1].length;
      if (bare[start] !== "f" || inImport(start)) continue;
      if (USE_PUSH_MODULES.has(resolveSpec(file, m[3])))
        fails.push(
          `${at(start)}: imports or re-exports a usePush module in a form it can't read`,
        );
    }
    const bindings = [];
    for (const local of locals) {
      for (const m of bare.matchAll(usesOf(local))) {
        if (inImport(m.index)) continue;
        const bound = bare.slice(0, m.index).match(BOUND);
        if (bound && /^\s*\(/.test(bare.slice(m.index + local.length)))
          bindings.push({
            name: bound[1],
            at:
              m.index -
              bound[0].length +
              bound[0].indexOf(bound[1], "const".length),
          });
        else
          fails.push(
            `${at(m.index)}: usePush used other than as const <x> = usePush(…)`,
          );
      }
    }
    for (const binding of bindings) {
      for (const ref of bare.matchAll(usesOf(binding.name))) {
        if (ref.index === binding.at) continue;
        const end = ref.index + binding.name.length;
        const after = bare.slice(end);
        const member = after.match(/^\.(\w+)/);
        if (
          member &&
          READ_MEMBERS.includes(member[1]) &&
          !/^\s*[(=]/.test(after.slice(member[0].length))
        )
          continue;
        const call = after.match(/^\.(mutateAsync|mutate)\s*\(\s*/);
        if (!call) {
          if (proseAt(bare, ref.index, end)) continue;
          fails.push(
            `${at(ref.index)}: ${binding.name} used other than .mutateAsync/.mutate or a read-only member`,
          );
          continue;
        }
        const open = end + call[0].length;
        const verb = `${binding.name}.${call[1]}`;
        const fn = enclosingFunction(code, ref.index);
        const where = `${at(ref.index)}: ${verb} in ${fn ?? "(no function)"}`;
        if (code[open] !== "{") {
          fails.push(`${where}: without an object literal`);
          continue;
        }
        calls++;
        const entries = objectEntries(code, open);
        if (entries === null) {
          fails.push(`${where}: an object it can't read`);
          continue;
        }
        if (entries.some((e) => e.startsWith("..."))) {
          fails.push(`${where}: spread in the push variables`);
          continue;
        }
        const keys = entries.map((e) => {
          const m = e.match(/^(\w+)\s*(?::\s*([\s\S]+))?$/);
          return m ? { key: m[1], value: m[2]?.trim() ?? null } : null;
        });
        if (keys.some((k) => k === null)) {
          fails.push(`${where}: an entry it can't read`);
          continue;
        }
        const branch = keyStrength(keys, "branch");
        const started = keyStrength(keys, "startedOn");
        if (branch === "strong" || started === "strong") continue;
        const allowed = fn !== null && (bareBranch[file] ?? []).includes(fn);
        if (allowed && (branch === "bare" || started === "bare")) {
          used.add(`${file}#${fn}`);
          continue;
        }
        fails.push(`${where}: names no branch and records no start`);
      }
    }
  }
  for (const [file, fns] of Object.entries(bareBranch))
    for (const fn of fns)
      if (!used.has(`${file}#${fn}`))
        fails.push(`stale bare-branch entry: ${file}#${fn}`);
  if (calls === 0) fails.push("no usePush calls found");
  return fails;
}

function walkSrc(dir = "src", out = {}) {
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (/\.tsx?$/.test(entry.name))
      out[rel] = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  }
  return out;
}

test("every usePush call names its branch or records its start", () => {
  assert.deepEqual(checkPushCalls(walkSrc()), []);
});

test("the usePush call scan fails closed on every shape it can't prove", () => {
  const sources = walkSrc();
  const scanFailsWith = (srcs, fragment, bareBranch, label = fragment) => {
    const fails = checkPushCalls(srcs, bareBranch);
    assert.ok(
      fails.some((f) => f.includes(fragment)),
      `${label}: expected a failure naming ${fragment}, got ${JSON.stringify(fails)}`,
    );
  };
  const sc = `${R}SyncControls.tsx`;
  const startLine =
    "startedOn: branch === undefined ? headNameRef.current : undefined,";
  assert.ok(sources[sc].includes(startLine));
  // doPush's shorthand `branch` may be undefined, so it is not listed.
  scanFailsWith(
    { ...sources, [sc]: sources[sc].replace(startLine, "") },
    "in doPush: names no branch and records no start",
  );
  scanFailsWith(
    {
      ...sources,
      [sc]: sources[sc].replace(startLine, "startedOn: undefined,"),
    },
    "in doPush: names no branch and records no start",
  );
  const fg = `${R}ForkPrPublishGuard.tsx`;
  const probe = (body) => ({
    ...sources,
    [fg]: `${sources[fg]}\nasync function probe() {\n  ${body}\n}\n`,
  });
  for (const [body, fragment] of [
    [
      "await push.mutateAsync({ setUpstream: false });",
      "in probe: names no branch and records no start",
    ],
    [
      "await push.mutateAsync({ setUpstream: false, branch });",
      "in probe: names no branch and records no start",
    ],
    [
      "await push.mutateAsync({ setUpstream: false, branch: branch });",
      "in probe: names no branch and records no start",
    ],
    [
      "await push.mutateAsync({ setUpstream: false, startedOn: undefined });",
      "in probe: names no branch and records no start",
    ],
    ["await push.mutateAsync(vars);", "without an object literal"],
    ["await push.mutateAsync({ ...vars });", "spread in the push variables"],
    ["await push.mutateAsync({ branch: `${x}` });", "an object it can't read"],
    ['await push.mutateAsync({ ["branch"]: x });', "an entry it can't read"],
    // Every other use of the binding.
    ["const run = push.mutateAsync;", "push used other than"],
    ["const p2 = push;", "push used other than"],
    ["const { mutateAsync } = push;", "push used other than"],
    ["await push?.mutateAsync({ branch: x.name });", "push used other than"],
    ["helper(push);", "push used other than"],
    ["const o = { ...push };", "push used other than"],
    ["push.reset();", "push used other than"],
    // A call after a URL string on the same line is still read.
    [
      'const u = "https://x"; await push.mutateAsync({ setUpstream: false });',
      "in probe: names no branch and records no start",
    ],
    // usePush bound any other way.
    ["const [p] = [usePush(repoPath)];", "usePush used other than"],
    ["let p = usePush(repoPath);", "usePush used other than"],
  ])
    scanFailsWith(probe(body), fragment, undefined, body);
  // An aliased import is followed under its local name.
  const aliased = {
    ...sources,
    "src/features/probe.tsx": [
      'import { usePush as usePushAlias } from "@/lib/git/queries";',
      "function Probe() {",
      '  const p = usePushAlias("r");',
      "  p.mutate({ setUpstream: false });",
      "}",
    ].join("\n"),
  };
  scanFailsWith(aliased, "src/features/probe.tsx:4: p.mutate in Probe");
  // Relative and module paths resolve too.
  const relative = {
    ...sources,
    "src/lib/git/queries/probe.ts": [
      'import { usePush } from "./sync";',
      "export function useProbe() {",
      '  const p = usePush("r");',
      "  return p;",
      "}",
    ].join("\n"),
  };
  scanFailsWith(relative, "src/lib/git/queries/probe.ts:4: p used other than");
  for (const [line, fragment] of [
    ['import * as q from "@/lib/git/queries";', "namespace import"],
    [
      'export { usePush } from "./queries/sync";',
      "re-exports a usePush module",
    ],
  ])
    scanFailsWith({ ...sources, "src/lib/git/probe.ts": line }, fragment);
  // A `/*` in a string doesn't hide the call after it.
  scanFailsWith(
    probe(
      'const s = "/*"; await push.mutateAsync({ setUpstream: false }); // */',
    ),
    "in probe: names no branch and records no start",
  );
  scanFailsWith({}, "no usePush calls found");
  scanFailsWith(sources, "stale bare-branch entry", {
    ...BARE_BRANCH,
    [sc]: [...BARE_BRANCH[sc], "noSuchFunction"],
  });
});

// Non-BMP text and identifier spellings, one test per shape. Fixture text is
// built from code points so this file stays ASCII.
let srcTree;
const PROBE = "src/features/probe.tsx";
const scanWithProbe = (lines) =>
  checkPushCalls({ ...(srcTree ??= walkSrc()), [PROBE]: lines.join("\n") });
const failsNaming = (fails, fragment) =>
  assert.ok(
    fails.some((f) => f.includes(fragment)),
    `expected a failure naming ${fragment}, got ${JSON.stringify(fails)}`,
  );
const NO_BRANCH = "p.mutate in Probe: names no branch and records no start";
const UNSAFE = "{ setUpstream: false }";
const SAFE = "{ setUpstream: false, branch: b.name }";
const pushProbe = (alias, vars, lead = []) => [
  ...lead,
  alias === "usePush"
    ? 'import { usePush } from "@/lib/git/queries";'
    : `import { usePush as ${alias} } from "@/lib/git/queries";`,
  "function Probe() {",
  `  const p = ${alias}("r");`,
  `  p.mutate(${vars});`,
  "}",
];
const rocket = String.fromCodePoint(0x1f680);
const eAcute = String.fromCodePoint(0xe9);
const mathP = String.fromCodePoint(0x1d45d);
const backslash = String.fromCharCode(92);

for (const [where, lead] of [
  ["a string", `const label = "${rocket}";`],
  ["a line comment", `// ${rocket}${rocket}`],
  ["a block comment", `/* ${rocket.repeat(4)} */`],
])
  test(`a non-BMP character in ${where} before the import hides no push`, () => {
    failsNaming(scanWithProbe(pushProbe("usePush", UNSAFE, [lead])), NO_BRANCH);
    assert.deepEqual(scanWithProbe(pushProbe("usePush", SAFE, [lead])), []);
    const text = pushProbe("usePush", UNSAFE, [lead]).join("\n");
    const { code, bare } = lex(text);
    assert.deepEqual([code.length, bare.length], [text.length, text.length]);
  });

for (const alias of ["$usePush", "_p", `push${eAcute}`, mathP])
  test(`an import aliased as ${alias} is followed`, () => {
    failsNaming(scanWithProbe(pushProbe(alias, UNSAFE)), NO_BRANCH);
    assert.deepEqual(scanWithProbe(pushProbe(alias, SAFE)), []);
  });

for (const value of ["$b", `b${eAcute}`, mathP])
  test(`a bare branch value ${value} counts only through the allowlist`, () => {
    const vars = `{ setUpstream: false, branch: ${value} }`;
    failsNaming(scanWithProbe(pushProbe("usePush", vars)), NO_BRANCH);
  });

for (const [shape, line, fragment] of [
  [
    "an escaped specifier",
    `import { usePu${backslash}u0073h as p } from "@/lib/git/queries";`,
    "an import specifier it can't read",
  ],
  [
    "an escaped default binding",
    `import ${backslash}u0070, { usePush } from "@/lib/git/queries";`,
    "an import clause it can't read",
  ],
  [
    "a string-named specifier",
    'import { "usePush" as p } from "@/lib/git/queries";',
    "in a form it can't read",
  ],
  [
    "no spacing around the clause",
    'import{usePush as p}from"@/lib/git/queries";',
    "in a form it can't read",
  ],
])
  test(`an import of a usePush module with ${shape} fails`, () => {
    const lines = [line, "function Probe() {", `  p.mutate(${UNSAFE});`, "}"];
    failsNaming(scanWithProbe(lines), fragment);
  });

for (const line of [
  'import $x from "./x";',
  `import ${eAcute} from "./x";`,
  `import ${mathP} from "./x";`,
  'export * as $x from "./x";',
  `export * as ${eAcute} from "./x";`,
  "const m = await import($spec);",
])
  test(`the import-free check catches ${line}`, () => {
    const file = new URL(`../${IMPORT_FREE[0]}`, import.meta.url);
    const src = readFileSync(file, "utf8");
    assert.notDeepEqual(importsIn(`${src}\n${line}\n`), [], line);
  });

test("every route re-checks the running push where it fires", () => {
  assert.deepEqual(checkPins(PINS, realSources()), []);
});

test("each file's helper is the one pushesBranch caller in it", () => {
  const sources = realSources();
  for (const file of FILES) {
    if (file.endsWith("CleanupBranchesDialog.tsx")) continue;
    const calls = sources[file].split("pushesBranch(").length - 1;
    assert.equal(calls, 1, `${file}: ${calls} pushesBranch( calls`);
  }
});

// One mutant per OCCURRENCE of each needle in the pin's body, so a doubled
// check (a boundary re-run after an await) is proven at each of its sites.
test("mutants with a check removed fail", () => {
  const sources = realSources();
  let doubled = 0;
  for (const pin of PINS) {
    const text = sources[pin.file].replace(/\r\n/g, "\n");
    const body = bodyAfter(text, pin.anchor);
    assert.ok(body !== null, pin.anchor);
    const at = text.indexOf(body);
    for (const needle of pin.mutate) {
      const parts = body.split(needle);
      assert.ok(parts.length > 1, needle);
      if (parts.length > 2) doubled++;
      for (let k = 1; k < parts.length; k++) {
        const cut =
          parts.slice(0, k).join(needle) + parts.slice(k).join(needle);
        const mutant = {
          ...sources,
          [pin.file]: text.slice(0, at) + cut + text.slice(at + body.length),
        };
        assert.notDeepEqual(
          checkPins([pin], mutant),
          [],
          `${pin.name}: removing occurrence ${k} of ${needle} still passes`,
        );
      }
    }
  }
  // doDelete's and both doResetToUpstream's second boundaries.
  assert.equal(doubled, 3, "doubled needles");
});

test("fails closed on a missing file or anchor", () => {
  const sources = realSources();
  const [pin] = PINS;
  assert.notDeepEqual(checkPins([pin], {}), []);
  assert.notDeepEqual(
    checkPins([{ ...pin, anchor: "no such anchor" }], sources),
    [],
  );
});

// A minimal element tree: attribute-compound selector lists, `closest` from
// the node itself up, `querySelector` over descendants.
function matches(node, sel) {
  return sel.split(",").some((compound) => {
    const parts = [...compound.trim().matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (parts.length === 0) throw new Error(`unparsed selector: ${compound}`);
    return parts.every(([, k, v]) =>
      v === undefined ? k in node.attrs : node.attrs[k] === v,
    );
  });
}
function el(attrs, ...children) {
  const node = {
    attrs,
    parent: null,
    children,
    closest(sel) {
      for (let n = node; n; n = n.parent) if (matches(n, sel)) return n;
      return null;
    },
    querySelector(sel) {
      const stack = [...node.children];
      while (stack.length) {
        const n = stack.shift();
        if (matches(n, sel)) return n;
        stack.push(...n.children);
      }
      return null;
    },
  };
  for (const c of children) c.parent = node;
  return node;
}

test("elementInOpenModal: open slots, nested portaled popups, closed and other slots", () => {
  const input = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-open": "" }, input),
  );
  assert.equal(elementInOpenModal(input), true);

  // A picker's search input inside a modal: portaled beside the content.
  const search = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-open": "" }),
    el({}, el({ "data-slot": "popover-content", "data-open": "" }, search)),
  );
  assert.equal(elementInOpenModal(search), true);

  // The command palette is itself a dialog-content.
  const paletteInput = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-open": "" }, paletteInput),
  );
  assert.equal(elementInOpenModal(paletteInput), true);

  const closedInput = el({});
  el(
    { "data-slot": "dialog-portal" },
    el({ "data-slot": "dialog-content", "data-closed": "" }, closedInput),
  );
  assert.equal(elementInOpenModal(closedInput), false);

  // The switcher's own popover sets role="dialog" but is no matched slot.
  const popoverInput = el({});
  el(
    { "data-slot": "popover-content", role: "dialog", "data-open": "" },
    popoverInput,
  );
  assert.equal(elementInOpenModal(popoverInput), false);

  assert.equal(elementInOpenModal(null), false);

  const sheetInput = el({});
  el({ "data-slot": "sheet-content", "data-open": "" }, sheetInput);
  assert.equal(elementInOpenModal(sheetInput), true);

  const drawerInput = el({});
  el({ "data-slot": "drawer-content", "data-state": "open" }, drawerInput);
  assert.equal(elementInOpenModal(drawerInput), true);

  // Vaul spells open as data-state; a bare data-open is not its open state.
  const drawerClosed = el({});
  el(
    { "data-slot": "drawer-content", "data-state": "closed", "data-open": "" },
    drawerClosed,
  );
  assert.equal(elementInOpenModal(drawerClosed), false);
});

test("open-modal selector strings name every slot and portal", () => {
  const src = readFileSync(
    new URL("../src/lib/hotkeys/open-modal.ts", import.meta.url),
    "utf8",
  );
  for (const s of [
    '[data-slot="dialog-content"][data-open]',
    '[data-slot="sheet-content"][data-open]',
    '[data-slot="drawer-content"][data-state="open"]',
    '[data-slot="dialog-portal"]',
    '[data-slot="sheet-portal"]',
    '[data-slot="drawer-portal"]',
  ])
    assert.ok(src.includes(s), s);
  assert.doesNotMatch(src, /\[role=/);
});
