// Source pins for the outside-HEAD-move refresh and its History neighbors:
// - workingtree.ts's headMoveAftermathKeys holds exactly the HEAD-dependent
//   families a commit's aftermath refreshes, minus the four StatusLogSync
//   handles itself, and commitAftermathKeys composes the two into the same set;
// - StatusLogSync re-reads that set plus the rewrite-status prefix on an
//   observed move, through the preMoveStale predicate, and the rewrite-status
//   key has one builder;
// - reset to upstream's carries-every-local-commit predicate is spelled only in
//   branches.ts, and its two refusals match across the Pull and branch menus;
// - Undo prunes a selection naming the undone commit through the non-bumping
//   clearSelectedCommit, and both routes that write a commit's message into
//   the commit box ask replacesMessageConfirm between the message read and the
//   write;
// - the frontend's UNDO_SHALLOW_BOUNDARY is byte-for-byte the backend's.
// Every check reads its source whole and fails closed on anything it can't
// find; each also runs against an in-memory mutated copy, so a green suite
// proves the pin bites. Runs in CI's installless guards job: Node built-ins only.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { maskNonCode } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

const WORKINGTREE = "src/lib/git/queries/workingtree.ts";
const CORE = "src/lib/git/queries/core.ts";
const PANEL = "src/features/history/HistoryPanel.tsx";
const AMEND = "src/features/history/useAmendCommit.ts";
const UI_STORE = "src/lib/stores/ui.ts";
const COMMIT_RS = "src-tauri/src/git/commit.rs";
const BRANCHES = "src/lib/git/queries/branches.ts";
const SYNC = "src/features/repository/SyncControls.tsx";
const SWITCHER = "src/features/repository/BranchSwitcher.tsx";

/** The HEAD-move set: every family a commit's aftermath refreshes except the
 *  four StatusLogSync already refreshes on a move. */
const HEAD_SET = [
  "commits",
  "branches",
  "log-search",
  "recent-commits",
  "commit-authors",
  "branch-stats",
  "stats",
  "divergence",
  "compare",
  "file-log",
  "blame",
  "file-b64/HEAD",
  "conflict-file",
  "merge-preview",
  "conflict-preview",
  "local-pr-merge-states",
  "oplog-check",
  "insights/contributors",
  "insights/commit-activity",
  "insights/code-frequency",
  "insights/punch-card",
];
const HANDLED = ["log", "unpushed-count", "unpushed-messages", "op-state"];

/** The text from `open` (a `{` or `[` index) through its matching close,
 *  skipping strings, template literals and comments. Throws when unbalanced. */
function balanced(src, open) {
  const pair = { "{": "}", "[": "]" }[src[open]];
  if (!pair) throw new Error(`no opening bracket at ${open}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) break;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === src[open]) depth++;
    else if (c === pair && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${src[open]} from ${open}`);
}

/** The balanced block whose opening `bracket` first follows `anchor` (and,
 *  when given, `lead` after it: a signature's `) {` past its own braces). */
function blockAfter(src, anchor, bracket = "{", lead = "") {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const from = lead ? src.indexOf(lead, at + anchor.length) : at;
  if (from < 0) throw new Error(`no ${lead} after: ${anchor}`);
  const open = src.indexOf(bracket, from + (lead ? 0 : anchor.length));
  if (open < 0) throw new Error(`no ${bracket} after: ${anchor}`);
  return { at, open, text: balanced(src, open) };
}

/** Top-level comma-separated entries of a `[ … ]` literal. */
function entries(list) {
  const inner = list.slice(1, -1);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out.filter((e) => e !== "");
}

/** repoKeys builders that are a bare `["repo", repo, "<family>"]`. */
function repoKeyBuilders(core) {
  const { text } = blockAfter(core, "export const repoKeys =");
  const builders = new Map();
  const re =
    /(\w+):\s*\(repo: string\)\s*=>\s*\[\s*"repo",\s*repo,\s*"([^"]+)"\s*\]\s*as const/g;
  for (const m of text.matchAll(re)) builders.set(m[1], m[2]);
  if (builders.size === 0) throw new Error("no repoKeys builders read");
  return builders;
}

/** Each entry as its family ("insights/contributors"), or a spread marker.
 *  `arg` is the repo identifier the list's key builders are called with. */
function families(list, builders, arg = "repo") {
  return entries(list).map((e) => {
    const builder = e.match(new RegExp(`^repoKeys\\.(\\w+)\\(${arg}\\)$`));
    if (builder) {
      const family = builders.get(builder[1]);
      if (!family) throw new Error(`unknown repoKeys builder: ${e}`);
      return family;
    }
    if (new RegExp(`^\\.\\.\\.headMoveAftermathKeys\\(${arg}\\)$`).test(e))
      return "...head-set";
    const literal = e.match(
      new RegExp(`^\\[\\s*"repo",\\s*${arg},((?:\\s*"[^"]+"\\s*,?)+)\\s*\\]$`),
    );
    if (literal)
      return [...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("/");
    throw new Error(`unreadable key entry: ${e}`);
  });
}

function checkWorkingtree(wt, core) {
  const builders = repoKeyBuilders(core);
  const head = families(
    blockAfter(
      wt,
      "export const headMoveAftermathKeys = (repo: string) =>",
      "[",
    ).text,
    builders,
  );
  const commit = families(
    blockAfter(wt, "const commitAftermathKeys = (repo: string) =>", "[").text,
    builders,
  );
  const problems = [];
  if (new Set(head).size !== head.length)
    problems.push("headMoveAftermathKeys lists a family twice");
  if (
    head.length !== HEAD_SET.length ||
    [...head].sort().join() !== [...HEAD_SET].sort().join()
  )
    problems.push(`headMoveAftermathKeys is [${head}], not the HEAD-move set`);
  const own = commit.filter((f) => f !== "...head-set");
  if (commit.length - own.length !== 1)
    problems.push("commitAftermathKeys must spread headMoveAftermathKeys once");
  if ([...own].sort().join() !== [...HANDLED].sort().join())
    problems.push(`commitAftermathKeys adds [${own}], not the four handled`);
  if (!/invalidateAfter:\s*commitAftermathKeys\(repo\)/.test(wt))
    problems.push("useCommit no longer invalidates commitAftermathKeys");
  return problems;
}

function checkStatusLogSync(panel, core) {
  const builders = repoKeyBuilders(core);
  const problems = [];
  if (
    !/import\s*\{[^}]*\bheadMoveAftermathKeys\b[^}]*\}\s*from\s*"@\/lib\/git\/queries";/.test(
      panel,
    )
  )
    problems.push("HistoryPanel doesn't import headMoveAftermathKeys");
  const body = blockAfter(
    panel,
    "export function StatusLogSync(",
    "{",
    ") {",
  ).text;
  const capture = body.indexOf("const prevStatusAt = lastStatusAt.current;");
  const advance = body.indexOf("lastStatusAt.current = statusAt;");
  if (capture < 0 || advance < 0 || advance < capture)
    problems.push("prevStatusAt isn't captured before lastStatusAt advances");
  const at = body.indexOf('actions.has("refresh-head-set")');
  if (at < 0)
    return [...problems, "no refresh-head-set block in StatusLogSync"];
  const block = balanced(body, body.indexOf("{", at));
  const watched = families(
    blockAfter(block, "for (const key of", "[").text,
    builders,
    "repoPath",
  );
  if ([...watched].sort().join() !== "...head-set,rewrite-status")
    problems.push(
      `refresh-head-set re-reads [${watched}], not the HEAD-move set + rewrite-status`,
    );
  if (
    !/invalidateQueries\(\{\s*queryKey: key,\s*predicate: \(q\) =>\s*preMoveStale\(\{[^}]*prevStatusAt,?\s*\}\)/.test(
      block,
    )
  )
    problems.push("refresh-head-set block doesn't gate on preMoveStale");
  return problems;
}

function checkUndoLast(panel) {
  const problems = [];
  const body = blockAfter(panel, "async function undoLast()").text;
  const live = body.indexOf("useUiStore.getState().repoPath === repoPath");
  const prune = body.search(
    /if \(\s*useUiStore\.getState\(\)\.selectedCommitHash === lastCommit\.hash\s*\)\s*\{\s*clearSelectedCommit\(\);\s*\}/,
  );
  if (prune < 0)
    problems.push(
      "undoLast doesn't clearSelectedCommit under the selectedCommitHash guard",
    );
  else if (live < 0 || live > prune)
    problems.push("the selection prune sits outside the live-repo guard");
  if (/selectCommit\(\s*null\s*\)/.test(body.replace(/\/\/[^\n]*/g, "")))
    problems.push("undoLast deselects through the bumping selectCommit");
  const detailsAt = body.indexOf("gitCommitDetails(");
  const ask = body.search(/ask\(\s*replacesMessageConfirm\(\s*"undo",/);
  const write = body.indexOf("undoCommit.mutateAsync(");
  if (ask < 0)
    problems.push('undoLast never asks replacesMessageConfirm("undo")');
  else if (!(detailsAt >= 0 && detailsAt < ask && ask < write))
    problems.push("undoLast's prompt isn't between the message read and undo");
  return problems;
}

function checkAmend(amend) {
  const problems = [];
  const body = blockAfter(
    amend,
    "export function useAmendCommit(",
    "{",
    ") {",
  ).text;
  const detailsAt = body.indexOf("gitCommitDetails(");
  const ask = body.search(/ask\(\s*replacesMessageConfirm\(\s*"amend",/);
  const write = body.indexOf("landAmend(hash");
  if (ask < 0)
    problems.push('useAmendCommit never asks replacesMessageConfirm("amend")');
  else if (!(detailsAt >= 0 && detailsAt < ask && ask < write))
    problems.push(
      "useAmendCommit's prompt isn't between the read and landAmend",
    );
  return problems;
}

function checkClearSelectedCommit(ui) {
  const setters = ui.match(/clearSelectedCommit:\s*\(\)\s*=>\s*set\([^\n]*/g);
  if (!setters || setters.length !== 1)
    return ["ui.ts doesn't define clearSelectedCommit once"];
  return /^clearSelectedCommit:\s*\(\)\s*=>\s*set\(\{\s*selectedCommitHash:\s*null\s*\}\),?$/.test(
    setters[0].trim(),
  )
    ? []
    : [`clearSelectedCommit writes more than the selection: ${setters[0]}`];
}

/** The one string constant `name` declares in `src`, by the given lead. */
function constant(src, lead) {
  const found = [...src.matchAll(new RegExp(`${lead}\\s*"([^"]*)";`, "g"))];
  if (found.length !== 1)
    throw new Error(`expected one ${lead} declaration, found ${found.length}`);
  return found[0][1];
}

function checkShallowTwin(rust, panel) {
  const backend = constant(rust, "const UNDO_SHALLOW_BOUNDARY: &str =");
  const frontend = constant(panel, "const UNDO_SHALLOW_BOUNDARY =");
  if (backend === "") return ["the Rust UNDO_SHALLOW_BOUNDARY is empty"];
  return Buffer.from(backend, "utf8").equals(Buffer.from(frontend, "utf8"))
    ? []
    : [`TS ${JSON.stringify(frontend)} != Rust ${JSON.stringify(backend)}`];
}

/** branchRewriteStatusOptions keys through the shared builder the watcher uses,
 *  which must resolve to the rewrite-status family. */
function checkRewriteStatusKey(branches, core) {
  if (repoKeyBuilders(core).get("rewriteStatus") !== "rewrite-status")
    return ["repoKeys.rewriteStatus is not the rewrite-status family"];
  const factory = blockAfter(
    branches,
    "export function branchRewriteStatusOptions(",
    "{",
    ") {",
  ).text;
  return /queryKey:\s*\[\.\.\.repoKeys\.rewriteStatus\(repo\),\s*branch\]/.test(
    factory,
  )
    ? []
    : ["branchRewriteStatusOptions doesn't key on repoKeys.rewriteStatus"];
}

/** Every .ts/.tsx under src/, by repo-relative path. */
function srcFiles() {
  const out = new Map();
  for (const rel of readdirSync(join(REPO_ROOT, "src"), { recursive: true })) {
    const path = `src/${String(rel).replaceAll("\\", "/")}`;
    if (/\.tsx?$/.test(path)) out.set(path, read(path));
  }
  if (out.size === 0) throw new Error("no src files read");
  return out;
}

const TRUE_VERDICT = String.raw`(?:remoteRewritten\s*===\s*true|true\s*===\s*[\w$?.]*remoteRewritten)`;
const NONE_LOCAL = String.raw`(?:localOnly\s*===\s*0|0\s*===\s*[\w$?.]*localOnly)`;
/** Both clauses of the pair in one expression, in either order and either
 *  operand order; comments and string text are masked out first. */
const PAIR = new RegExp(
  `${TRUE_VERDICT}[^;{}]{0,300}?${NONE_LOCAL}|${NONE_LOCAL}[^;{}]{0,300}?${TRUE_VERDICT}`,
  "g",
);

/** The carries-every-local-commit pair (reflog verdict + no unique local
 *  commit) is spelled only in branches.ts's carriesAllLocalCommits. */
function checkPredicateSpelledOnce(sources) {
  const problems = [];
  let home = 0;
  for (const [path, src] of sources) {
    const code = maskNonCode(src, path.endsWith(".tsx"));
    const hits = [...code.matchAll(PAIR)].length;
    if (path === BRANCHES) home = hits;
    else if (hits > 0) problems.push(`${path} re-spells the predicate`);
  }
  if (home !== 1)
    problems.push(`branches.ts spells it ${home} times, not once`);
  return problems;
}

/** Each reset-to-upstream refusal and the arguments each surface must toast it
 *  with: the upstream's name and the branch's, never one for the other. */
const RESET_NOTICES = {
  UPSTREAM_MOVED_NOTICE: { sync: "upstream", switcher: "base" },
  LOCAL_MOVED_NOTICE: { sync: "branch", switcher: "branch.name" },
  UNCONFIRMED_NOTICE: {
    sync: "upstream, branch",
    switcher: "base, branch.name",
  },
};

/** The reset-to-upstream refusals: each surface's twin matches the other's
 *  sentence and parameters but for the menu it names, and each surface toasts
 *  it at least once and only ever with the right arguments. */
function checkResetTwins(sync, switcher) {
  const notice = (src, name) => {
    const found = [
      ...src.matchAll(
        new RegExp(`const ${name} = \\(([^)]*)\\) =>\\s*\`([^\`]*)\`;`, "g"),
      ),
    ];
    if (found.length !== 1) throw new Error(`expected one ${name}`);
    return { params: found[0][1], text: found[0][2] };
  };
  const problems = [];
  for (const [name, args] of Object.entries(RESET_NOTICES)) {
    const pull = notice(sync, name);
    const branch = notice(switcher, name);
    if (pull.params !== branch.params)
      problems.push(`${name} twins take different parameters`);
    if (
      !pull.text.includes("the Pull menu") ||
      !branch.text.includes("the branch menu")
    )
      problems.push(`${name} names the wrong menu`);
    else if (
      pull.text.replace("the Pull menu", "the branch menu") !== branch.text
    )
      problems.push(`${name} twins drifted: ${pull.text} / ${branch.text}`);
    for (const [file, src, arg] of [
      [SYNC, sync, args.sync],
      [SWITCHER, switcher, args.switcher],
    ]) {
      const calls = src.split(`toast.info(${name}(`).length - 1;
      const right = src.split(`toast.info(${name}(${arg}));`).length - 1;
      if (calls === 0 || calls !== right)
        problems.push(`${file} must toast ${name} only as ${name}(${arg})`);
    }
  }
  return problems;
}

/** The confirm-time arms of a doResetToUpstream body, in order: an unmeasured
 *  upstream tip (the unconfirmed verdict), a moved upstream tip, then (only
 *  when the read no longer proves every commit carried) a measured local move
 *  or else the unconfirmed verdict, then the promotion re-check, then the reset
 *  itself. */
function checkResetArms(src, file, lead) {
  const body = blockAfter(
    src,
    "async function doResetToUpstream(",
    "{",
    lead,
  ).text;
  const problems = [];
  const nullArm = body.search(
    /if \(fresh\.upstreamTip === null\) \{\s*toast\.info\(UNCONFIRMED_NOTICE\(/,
  );
  if (nullArm < 0)
    problems.push(`${file}: an unmeasured upstream tip isn't unconfirmed`);
  if (
    !/if \(fresh\.upstreamTip !== tip\) \{\s*toast\.info\(UPSTREAM_MOVED_NOTICE\(/.test(
      body,
    )
  )
    problems.push(`${file}: the upstream arm isn't gated on the upstream tip`);
  if (
    !/if \(!carriesAllLocalCommits\(fresh\)\) \{\s*if \(fresh\.localTip !== null && fresh\.localTip !== localTip\) \{\s*toast\.info\(LOCAL_MOVED_NOTICE\([^)]*\)\);\s*\} else \{\s*toast\.info\(UNCONFIRMED_NOTICE\(/.test(
      body,
    )
  )
    problems.push(
      `${file}: the local arm isn't a measured local move under a failed verdict`,
    );
  const at = (needle) => body.indexOf(needle);
  const order = [
    nullArm,
    at("toast.info(UPSTREAM_MOVED_NOTICE("),
    at("toast.info(LOCAL_MOVED_NOTICE("),
    body.lastIndexOf("toast.info(UNCONFIRMED_NOTICE("),
    body.lastIndexOf("promotionBlocksCheckout(repoPath)"),
    at("hardReset.mutateAsync("),
  ];
  if (
    order.some((i) => i < 0) ||
    order.some((i, n) => n > 0 && i <= order[n - 1])
  )
    problems.push(
      `${file}: arms out of order (unmeasured, upstream, local, unconfirmed, promotion, reset): ${order}`,
    );
  return problems;
}

/** `src` with `snippet` (present exactly once) replaced, for a control. */
function mutate(src, snippet, replacement = "") {
  const parts = src.split(snippet);
  assert.equal(parts.length, 2, `control premise: one ${snippet}`);
  return parts.join(replacement);
}

/** `src` without the `if (anchor) { … }` block. */
function withoutBlock(src, anchor) {
  const at = src.indexOf(`if (${anchor})`);
  assert.ok(at >= 0, `control premise: ${anchor} present`);
  const block = balanced(src, src.indexOf("{", at));
  return src.slice(0, at) + src.slice(src.indexOf(block, at) + block.length);
}

test("headMoveAftermathKeys is the HEAD-move set; the commit set composes it", () => {
  const wt = read(WORKINGTREE);
  const core = read(CORE);
  assert.deepEqual(checkWorkingtree(wt, core), []);
  assert.notDeepEqual(
    checkWorkingtree(mutate(wt, '["repo", repo, "blame"],'), core),
    [],
    "control: a family dropped from the HEAD-move set",
  );
  assert.notDeepEqual(
    checkWorkingtree(mutate(wt, "repoKeys.unpushedMessages(repo),"), core),
    [],
    "control: a handled family dropped from the commit set",
  );
});

test("StatusLogSync re-reads the HEAD-move set through preMoveStale", () => {
  const panel = read(PANEL);
  const core = read(CORE);
  assert.deepEqual(checkStatusLogSync(panel, core), []);
  assert.notDeepEqual(
    checkStatusLogSync(
      withoutBlock(panel, 'actions.has("refresh-head-set")'),
      core,
    ),
    [],
    "control: the refresh-head-set block removed",
  );
  assert.notDeepEqual(
    checkStatusLogSync(mutate(panel, "predicate: (q) =>", "_: (q) =>"), core),
    [],
    "control: the predicate dropped",
  );
  assert.notDeepEqual(
    checkStatusLogSync(
      mutate(
        panel,
        "repoKeys.rewriteStatus(repoPath),",
        "repoKeys.log(repoPath),",
      ),
      core,
    ),
    [],
    "control: the rewrite-status family swapped out",
  );
});

test("the rewrite-status family has one key builder", () => {
  const core = read(CORE);
  const branches = read(BRANCHES);
  assert.deepEqual(checkRewriteStatusKey(branches, core), []);
  assert.notDeepEqual(
    checkRewriteStatusKey(
      mutate(
        branches,
        "[...repoKeys.rewriteStatus(repo), branch]",
        '["repo", repo, "rewrite-status", branch]',
      ),
      core,
    ),
    [],
    "control: the factory hand-builds its key",
  );
});

test("reset to upstream's predicate and refusals stay single-sourced", () => {
  const sync = read(SYNC);
  const switcher = read(SWITCHER);
  const sources = srcFiles();
  assert.deepEqual(checkPredicateSpelledOnce(sources), []);
  assert.deepEqual(checkResetTwins(sync, switcher), []);
  const inlined = new Map(sources);
  inlined.set(
    SYNC,
    `${sync}\nconst x = d?.remoteRewritten === true && d.localOnly === 0;\n`,
  );
  assert.notDeepEqual(
    checkPredicateSpelledOnce(inlined),
    [],
    "control: the predicate re-spelled inline",
  );
  assert.notDeepEqual(
    checkResetTwins(
      sync,
      mutate(
        switcher,
        "changed since you opened this",
        "moved since you opened this",
      ),
    ),
    [],
    "control: the local-moved twin drifts",
  );
  assert.notDeepEqual(
    checkResetTwins(
      mutate(
        sync,
        "${upstream} moved since you opened this,",
        "${upstream} moved,",
      ),
      switcher,
    ),
    [],
    "control: the upstream-moved twin drifts",
  );
  assert.notDeepEqual(
    checkResetTwins(
      mutate(sync, "Reopen the Pull menu to check again.", "Reopen it."),
      switcher,
    ),
    [],
    "control: the unconfirmed twin drifts",
  );
  assert.notDeepEqual(
    checkResetTwins(
      mutate(
        sync,
        "toast.info(LOCAL_MOVED_NOTICE(branch));",
        "toast.info(LOCAL_MOVED_NOTICE(upstream));",
      ),
      switcher,
    ),
    [],
    "control: the local-moved notice toasted with the upstream's name",
  );
  assert.notDeepEqual(
    checkResetTwins(
      sync,
      switcher.replaceAll(
        "toast.info(UNCONFIRMED_NOTICE(base, branch.name));",
        "toast.info(UNCONFIRMED_NOTICE(branch.name, base));",
      ),
    ),
    [],
    "control: the unconfirmed notice's arguments swapped",
  );
  const reversed = new Map(sources);
  reversed.set(
    SYNC,
    `${sync}\nconst y = 0 === d.localOnly && d?.remoteRewritten === true;\n`,
  );
  assert.notDeepEqual(
    checkPredicateSpelledOnce(reversed),
    [],
    "control: the predicate re-spelled with its clauses reversed",
  );
});

test("reset to upstream's confirm-time arms keep their order", () => {
  const sync = read(SYNC);
  const switcher = read(SWITCHER);
  assert.deepEqual(checkResetArms(sync, SYNC, ") {"), []);
  assert.deepEqual(checkResetArms(switcher, SWITCHER, ") {"), []);
  // The else arm's unconfirmed toast is the last one; the null arm's is first.
  const local = "toast.info(LOCAL_MOVED_NOTICE(branch.name));";
  const unconfirmed = "toast.info(UNCONFIRMED_NOTICE(base, branch.name));";
  const li = switcher.indexOf(local);
  const ui = switcher.lastIndexOf(unconfirmed);
  assert.ok(li >= 0 && ui > li, "control premise: local before unconfirmed");
  const swapped =
    switcher.slice(0, li) +
    unconfirmed +
    switcher.slice(li + local.length, ui) +
    local +
    switcher.slice(ui + unconfirmed.length);
  assert.notDeepEqual(
    checkResetArms(swapped, SWITCHER, ") {"),
    [],
    "control: the local and unconfirmed arms swapped",
  );
  for (const [src, file] of [
    [sync, SYNC],
    [switcher, SWITCHER],
  ]) {
    assert.notDeepEqual(
      checkResetArms(
        withoutBlock(src, "fresh.upstreamTip === null"),
        file,
        ") {",
      ),
      [],
      `control: ${file}'s unmeasured-upstream arm removed`,
    );
  }
  assert.notDeepEqual(
    checkResetArms(
      mutate(
        sync,
        "if (fresh.localTip !== null && fresh.localTip !== localTip) {",
        "if (fresh.localTip !== localTip) {",
      ),
      SYNC,
      ") {",
    ),
    [],
    "control: the local arm claims a move from an unmeasured tip",
  );
  assert.notDeepEqual(
    checkResetArms(
      mutate(
        sync,
        "if (fresh.upstreamTip !== tip) {",
        "if (!carriesAllLocalCommits(fresh) && fresh.upstreamTip !== tip) {",
      ),
      SYNC,
      ") {",
    ),
    [],
    "control: the upstream arm's gate drifts",
  );
  const marker = "// A promote can start during the re-read.";
  const at = switcher.indexOf(marker);
  assert.ok(at >= 0, "control premise: the promotion re-check is present");
  const recheck = switcher.indexOf(
    "if (promotionBlocksCheckout(repoPath))",
    at,
  );
  const block = balanced(switcher, switcher.indexOf("{", recheck));
  const noRecheck =
    switcher.slice(0, at) +
    switcher.slice(switcher.indexOf(block, recheck) + block.length);
  assert.notDeepEqual(
    checkResetArms(noRecheck, SWITCHER, ") {"),
    [],
    "control: the branch menu's promotion re-check removed",
  );
});

test("undo prunes the undone commit's selection without bumping", () => {
  const panel = read(PANEL);
  const ui = read(UI_STORE);
  assert.deepEqual(checkUndoLast(panel), []);
  assert.deepEqual(checkClearSelectedCommit(ui), []);
  assert.notDeepEqual(
    checkUndoLast(mutate(panel, "clearSelectedCommit();")),
    [],
    "control: the clearSelectedCommit call removed",
  );
  assert.notDeepEqual(
    checkClearSelectedCommit(
      mutate(
        ui,
        "clearSelectedCommit: () => set({ selectedCommitHash: null }),",
        "clearSelectedCommit: () => set((s) => ({ selectedCommitHash: null, interactionEpoch: s.interactionEpoch + 1 })),",
      ),
    ),
    [],
    "control: the prune bumps the epoch",
  );
});

test("amend and undo ask before replacing the commit box's message", () => {
  const panel = read(PANEL);
  const amend = read(AMEND);
  assert.deepEqual(checkAmend(amend), []);
  assert.notDeepEqual(
    checkUndoLast(
      mutate(
        panel,
        'ask(replacesMessageConfirm("undo", lastCommit.hash))',
        "true",
      ),
    ),
    [],
    "control: the undo prompt removed",
  );
  assert.notDeepEqual(
    checkAmend(
      mutate(amend, 'ask(replacesMessageConfirm("amend", hash))', "true"),
    ),
    [],
    "control: the amend prompt removed",
  );
});

test("UNDO_SHALLOW_BOUNDARY matches commit.rs byte for byte", () => {
  const rust = read(COMMIT_RS);
  const panel = read(PANEL);
  assert.deepEqual(checkShallowTwin(rust, panel), []);
  const tsSentence = constant(panel, "const UNDO_SHALLOW_BOUNDARY =");
  assert.notDeepEqual(
    checkShallowTwin(
      rust,
      mutate(panel, `"${tsSentence}"`, `"${tsSentence.replace("—", "-")}"`),
    ),
    [],
    "control: the TS sentence drifts",
  );
});
