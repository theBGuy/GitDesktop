// Pins, by source shape, where the PR and issue lists' row-state predicate
// reaches beyond the panels' own filter:
// - the two list hooks hand their placeholder through filterPlaceholderRows
//   with the previous key's state segment (index 4), so a page kept on the same
//   tab is filed by row state while another tab's page passes whole;
// - a merge (never a queued one), close or reopen re-files its row in every
//   cached list page of the repo's lens, inside its success callback and after
//   the list re-read (push-recheck-family.test.mjs pins the re-read and its
//   gate), and no other write does; of the issue lifecycle writes only close and
//   reopen hand the helper a state, and nothing else in src/ calls the five
//   forge state writes;
// - the issue picker offers open and closed issues unfiltered by state and
//   lists a number once, the linked-issue chips rank off the filtered open rows
//   alone, and the stack offer keeps its open page RAW (the detector's
//   fail-closed guards read the raw list) while the fork note files the row by
//   state.
//
// The src/-wide state-write scan sees a callee named as code (a call, a member
// access, an import or a re-export), a callee read through a string-literal key
// (`api["forgePrClose"]`), and any string literal holding one of the five Tauri
// command names (read from their definitions under lib/git/api/) outside that
// folder, an `invoke(…)` or not. It does NOT see: a name or command assembled at
// runtime (concatenation, a template with substitutions, `.join`), a computed
// key held in a variable (`api[name]`), a command name that lib/git/api/ itself
// exports under another binding, a state change made through some other
// command (a generic GraphQL or REST passthrough), or callers outside src/ (the
// MCP server). It attributes a mention to its top-level unit, so a nested
// function inside a patched hook counts as that hook.
//
// Not testable here: the live cache (which pages a write reaches, what a list
// shows during a preset switch). The checker is a pure function over source
// text, fed the real files (must pass) and in-memory mutants (must fail). It
// fails closed: a file, unit or statement it can't find is a problem, never a
// skip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  filterPlaceholderRows,
  patchRowState,
} from "../src/lib/remote-state-filter.ts";
import {
  escapeRe,
  maskNonCode,
  matchBrace,
  sourceFiles,
} from "./lib/ts-mask.mjs";

const Q = "lib/git/queries/";
const CORE = `${Q}core.ts`;
const PRS = `${Q}prs.ts`;
const ISSUES = `${Q}issues.ts`;
const PR_ACTIONS = `${Q}pr-actions.ts`;
const RELATIONS = "features/issues/IssueRelations.tsx";
const CHIPS = "features/pulls/useLinkedIssueChips.ts";
const VIEW = "features/pulls/RemotePrView.tsx";
/** The feature files the shape pins read beside the queries modules. */
const CORPUS_FILES = [RELATIONS, CHIPS, VIEW];

/** The list hooks whose placeholder is filed at its source. The family's key
 *  builder must stay three segments long and the key literal must put `state`
 *  right after `lens`, or index 4 stops being the state the callback reads. */
const PLACEHOLDER_SITES = [
  { file: PRS, unit: "usePrList", family: "prList", segment: "pr-list" },
  {
    file: ISSUES,
    unit: "useIssueList",
    family: "issueList",
    segment: "issue-list",
  },
];
const PLACEHOLDER =
  "placeholderData: (prev, prevQuery) => { const rows = keepPreviousDataForKeyAxes(repo, [[3, lens]])(prev, prevQuery); return rows && filterPlaceholderRows(rows, state, prevQuery?.queryKey[4]); }";

/** The cached-page patch helpers: module-private twins (the barrel re-exports
 *  both modules), each writing its own family under the lens predicate and
 *  bailing on an untouched page. */
const PATCH_HELPERS = [
  {
    file: PR_ACTIONS,
    name: "patchPrListState",
    family: "prList",
    row: "PrInfo",
  },
  {
    file: ISSUES,
    name: "patchIssueListState",
    family: "issueList",
    row: "IssueInfo",
  },
];
const helperWrite = ({ family, row }) =>
  `queryClient.setQueriesData<${row}[]>({ queryKey: repoKeys.${family}(repo), predicate: (q) => q.queryKey[3] === lens }, (page) => { const next = patchRowState(page, number, state); return next === page ? undefined : next; })`;

/** The PR state writes and the state each re-files its row under; `gate` is
 *  the condition the patch must sit under, sharing the block whose FIRST
 *  statement is the list re-read. */
const PR_HOOKS = {
  useMergePr: { state: "MERGED", gate: "if (!data.queued)" },
  useClosePr: { state: "CLOSED", gate: null },
  useReopenPr: { state: "OPEN", gate: null },
};
const prPatch = (state) =>
  `patchPrListState(queryClient, repo, args.lens, args.number, "${state}");`;

/** The issue lifecycle helper: its state parameter (index 7, after the re-read
 *  flag push-recheck-family reads at index 6) and the callers that pass one. */
const ISSUE_HELPER = {
  name: "useIssueLifecycleMutation",
  flagIndex: 6,
  stateIndex: 7,
  armed: { useCloseIssue: '"CLOSED"', useReopenIssue: '"OPEN"' },
};
const ISSUE_PATCH =
  "if (patchStateTo) patchIssueListState(queryClient, repo, lens, numberOf(args), patchStateTo);";

/** Every forge write that changes a remote row's open/closed state, and the one
 *  hook in all of src/ allowed to call it (beside its own definition under
 *  API). A new caller anywhere must join the patched set. */
const STATE_WRITES = {
  forgePrMerge: { file: PR_ACTIONS, hook: "useMergePr" },
  forgePrClose: { file: PR_ACTIONS, hook: "useClosePr" },
  forgePrReopen: { file: PR_ACTIONS, hook: "useReopenPr" },
  forgeIssueClose: { file: ISSUES, hook: "useCloseIssue" },
  forgeIssueReopen: { file: ISSUES, hook: "useReopenIssue" },
};
const API = "lib/git/api/";
const STATE_WRITE_NAMES = Object.keys(STATE_WRITES).join("|");
const STATE_WRITE_MENTION = new RegExp(`\\b(?:${STATE_WRITE_NAMES})\\b`);
/** A callee read through a string-literal key, matched on the string-keeping
 *  view (the masked one blanks the name); its `[` must be code. */
const STRING_KEY = new RegExp(
  `\\[\\s*(["'\`])(${STATE_WRITE_NAMES})\\1\\s*\\]`,
  "g",
);
/** The literal command an api definition hands `invoke`. */
const INVOKE_COMMAND = /\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*(["'`])([^"'`\s]+)\1/;
/** Text ending in an open `invoke(` call, generic arguments allowed. */
const INVOKE_OPEN = /\binvoke\s*(?:<[^()]*>)?\s*\(\s*$/;
const OUTSIDE = "(outside any function or binding)";
/** The files the shape pins read, beside the tree-wide STATE_WRITES scan. */
const NEEDED = [CORE, PRS, ISSUES, PR_ACTIONS, ...CORPUS_FILES];
/** Near src/'s real .ts/.tsx count: a reader that walked almost nothing must
 *  not pass the tree-wide scan by finding no callers. */
const TREE_FLOOR = 500;

/** Writes that deliberately patch nothing, each with its reason. */
const UNPATCHED = {
  useGlArmAutoMerge: {
    file: PR_ACTIONS,
    callee: "forgeGlMrAutoMerge",
    reason:
      "its void outcome can't tell armed from merged; the whole-repo invalidation covers an immediate merge",
  },
};

/** Whitespace collapsed, and the formatter's line-break artifacts (a space
 *  after an opening bracket, a trailing comma) dropped, so a pin reads the
 *  same text however the formatter wraps it. */
const norm = (s) =>
  s
    .replace(/\s+/g, " ")
    .replace(/,\s*([)\]])/g, "$1")
    .replace(/,\s*\}/g, " }")
    .replace(/([([]) /g, "$1")
    .replace(/ ([)\]])/g, "$1");

const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+))/;

/** Every top-level function and const/let binding of `code`, name → its
 *  `[start, end)` offsets. A unit runs from its column-0 declaration line to
 *  the next column-0 line that starts any other statement. */
function topLevelUnits(code) {
  const units = new Map();
  let current = null;
  let offset = 0;
  const flush = (end) => {
    if (current) units.set(current.name, { start: current.start, end });
  };
  for (const line of code.split("\n")) {
    if (/^[^\s)\]}]/.test(line)) {
      flush(offset);
      const m = DECLARATION.exec(line);
      current = m ? { name: m[1] ?? m[2], start: offset } : null;
    }
    offset += line.length + 1;
  }
  flush(code.length);
  return units;
}

/** `text` LF-normalized, its masked twin (comments, string text and JSX text
 *  blanked), and `code`: comments and JSX text blanked but string literals
 *  kept, so a commented-out call is no call while a state literal still
 *  reads. Offsets agree across all three. */
function readView(file, raw, problems) {
  if (typeof raw !== "string") {
    problems.push(`${file}: unreadable source`);
    return null;
  }
  const text = raw.replace(/\r\n/g, "\n");
  let masked;
  try {
    masked = maskNonCode(text, file.endsWith(".tsx"));
  } catch (e) {
    problems.push(`${file}: unreadable source (${e.message})`);
    return null;
  }
  let code = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const m = masked[i];
    if (quote) {
      code += text[i];
      if (m === quote) quote = null;
    } else if (m === '"' || m === "'" || m === "`") {
      quote = m;
      code += text[i];
    } else code += m === " " && !/\s/.test(text[i]) ? " " : text[i];
  }
  return { file, text, masked, code, units: topLevelUnits(code) };
}

/** Offsets of every `needle` in `view.code` within `[from, to)`. */
function indicesOf(view, needle, from, to) {
  const out = [];
  for (let i = view.code.indexOf(needle, from); i >= 0 && i < to; ) {
    out.push(i);
    i = view.code.indexOf(needle, i + 1);
  }
  return out;
}

/** The `{…}` block whose opening brace ends the first `re` match in
 *  `[from, to)`, as `[open, close]` offsets, or null. */
function blockAfter(view, re, from, to) {
  const g = new RegExp(re.source, "g");
  g.lastIndex = from;
  const m = g.exec(view.code);
  if (!m || m.index >= to) return null;
  const open = m.index + m[0].length - 1;
  if (view.code[open] !== "{") return null;
  const close = matchBrace(view.masked, open);
  return close < 0 ? null : [open, close];
}

/** The top-level argument texts (normalized) of the call or parameter list
 *  whose `(` sits at `open`, or null when it never closes. */
function argsAt(view, open) {
  const close = matchBrace(view.masked, open);
  if (close < 0) return null;
  const parts = [];
  let depth = 0;
  let at = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = view.masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(norm(view.code.slice(at, i)).trim());
      at = i + 1;
    }
  }
  const last = norm(view.code.slice(at, close)).trim();
  if (last) parts.push(last);
  return parts;
}

/** The statement starting at the first line-leading `const <name> =`, through
 *  its `;` at bracket depth 0, normalized; null when absent or unterminated. */
function constStatement(view, name) {
  const m = new RegExp(`^[ \\t]*const ${escapeRe(name)} =`, "m").exec(
    view.code,
  );
  if (!m) return null;
  let depth = 0;
  for (let i = m.index; i < view.masked.length; i++) {
    const c = view.masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0)
      return norm(view.code.slice(m.index, i + 1)).trim();
  }
  return null;
}

/** The unit of `view` whose text holds `offset`, or null outside every unit. */
function unitAt(view, offset) {
  for (const [name, at] of view.units)
    if (offset >= at.start && offset < at.end) return name;
  return null;
}

/** Problems found in `raw` (src-relative path → text, every .ts/.tsx under
 *  src/); empty means the wiring holds. Only NEEDED files and files whose text
 *  holds a STATE_WRITES callee or its command are lexed; an unreadable entry
 *  anywhere is a problem. */
function checkRemoteListState(raw) {
  const problems = [];
  const views = {};
  const files = Object.keys(raw);
  if (files.length < TREE_FLOOR)
    problems.push(
      `src/: read ${files.length} files, expected at least ${TREE_FLOOR}`,
    );
  for (const [file, text] of Object.entries(raw)) {
    if (typeof text !== "string") {
      problems.push(`${file}: unreadable source`);
      continue;
    }
    if (!NEEDED.includes(file) && !STATE_WRITE_MENTION.test(text)) continue;
    const view = readView(file, text, problems);
    if (view) views[file] = view;
  }
  for (const f of NEEDED)
    if (!(f in raw)) problems.push(`${f}: missing from the corpus`);
  const unit = (file, name) => {
    const view = views[file];
    const at = view?.units.get(name);
    if (!at) {
      problems.push(`${file} ${name}: not found`);
      return null;
    }
    return { view, ...at, code: view.code.slice(at.start, at.end) };
  };

  // Arm 1: the placeholder is filed where the previous key's state is readable.
  const core = views[CORE];
  for (const { file, unit: name, family, segment } of PLACEHOLDER_SITES) {
    if (
      core &&
      !norm(core.code).includes(
        `${family}: (repo: string) => ["repo", repo, "${segment}"] as const`,
      )
    )
      problems.push(`${CORE}: repoKeys.${family} is no longer three segments`);
    const u = unit(file, name);
    if (!u) continue;
    const n = norm(u.code);
    if (!n.includes(`queryKey: [...repoKeys.${family}(repo), lens, state,`))
      problems.push(
        `${file} ${name}: the key no longer puts state at index 4, after lens`,
      );
    if (!n.includes(PLACEHOLDER))
      problems.push(
        `${file} ${name}: placeholderData is not routed through filterPlaceholderRows with the previous key's queryKey[4]`,
      );
    if ((n.match(/placeholderData:/g) ?? []).length !== 1)
      problems.push(`${file} ${name}: expected exactly one placeholderData`);
  }

  // Arm 2: the patch helpers.
  for (const helper of PATCH_HELPERS) {
    const u = unit(helper.file, helper.name);
    if (!u) continue;
    if (!u.code.startsWith(`function ${helper.name}(`))
      problems.push(
        `${helper.file} ${helper.name}: must stay a module-private function (the barrel re-exports this module)`,
      );
    if (!norm(u.code).includes(helperWrite(helper)))
      problems.push(
        `${helper.file} ${helper.name}: does not write ${helper.family} pages under the lens predicate with an untouched-page bail`,
      );
  }

  // Arm 2: the PR hooks re-file their row on success, after the re-read.
  for (const [name, { state, gate }] of Object.entries(PR_HOOKS)) {
    const u = unit(PR_ACTIONS, name);
    if (!u) continue;
    const { view } = u;
    const success = blockAfter(
      view,
      /onSuccess:\s*\(\w+,\s*args\)\s*=>\s*\{/,
      u.start,
      u.end,
    );
    const patches = indicesOf(view, "patchPrListState(", u.start, u.end);
    if (!success) {
      problems.push(`${PR_ACTIONS} ${name}: onSuccess block not found`);
      continue;
    }
    const body = view.code.slice(success[0], success[1] + 1);
    if (patches.length !== 1)
      problems.push(
        `${PR_ACTIONS} ${name}: expected one patchPrListState call, found ${patches.length}`,
      );
    else if (patches[0] < success[0] || patches[0] > success[1])
      problems.push(`${PR_ACTIONS} ${name}: the patch is not in onSuccess`);
    if (!norm(body).includes(prPatch(state)))
      problems.push(
        `${PR_ACTIONS} ${name}: does not re-file its row as "${state}"`,
      );
    const reread = view.code.indexOf("recheckListsLater(", success[0]);
    if (reread < 0 || reread > success[1] || patches[0] < reread)
      problems.push(
        `${PR_ACTIONS} ${name}: the patch must follow the list re-read`,
      );
    if (gate !== null) {
      const adjacent = new RegExp(
        `${escapeRe(gate)}\\s*\\{\\s*recheckListsLater\\(`,
      );
      const gated = blockAfter(
        view,
        new RegExp(`${escapeRe(gate)}\\s*\\{`),
        success[0],
        success[1],
      );
      if (!adjacent.test(body) || !gated)
        problems.push(
          `${PR_ACTIONS} ${name}: \`${gate}\` must open a block whose first statement is the list re-read`,
        );
      else if (patches[0] < gated[0] || patches[0] > gated[1])
        problems.push(
          `${PR_ACTIONS} ${name}: the patch is not guarded by \`${gate}\``,
        );
    }
  }

  // Arm 2: the issue helper re-files on success, after its gated re-read.
  const helper = unit(ISSUES, ISSUE_HELPER.name);
  if (helper) {
    const { view } = helper;
    const sig = new RegExp(
      `function ${ISSUE_HELPER.name}(?:<[^>(]*>)?\\(`,
    ).exec(helper.code);
    const params = sig
      ? argsAt(view, helper.start + sig.index + sig[0].length - 1)
      : null;
    if (
      !params?.[ISSUE_HELPER.flagIndex]?.startsWith("recheckListLater") ||
      params[ISSUE_HELPER.stateIndex] !== 'patchStateTo?: "CLOSED" | "OPEN"'
    )
      problems.push(
        `${ISSUES} ${ISSUE_HELPER.name}: patchStateTo must be parameter ${ISSUE_HELPER.stateIndex}, after the re-read flag`,
      );
    const success = blockAfter(
      view,
      /onSuccess:\s*\(\w+,\s*args\)\s*=>\s*\{/,
      helper.start,
      helper.end,
    );
    const patches = indicesOf(
      view,
      "patchIssueListState(",
      helper.start,
      helper.end,
    );
    if (!success)
      problems.push(
        `${ISSUES} ${ISSUE_HELPER.name}: onSuccess block not found`,
      );
    else {
      const body = view.code.slice(success[0], success[1] + 1);
      const reread = view.code.indexOf("recheckListsLater(", success[0]);
      if (!/if \(recheckListLater\)\s*(?:\{\s*)?recheckListsLater\(/.test(body))
        problems.push(
          `${ISSUES} ${ISSUE_HELPER.name}: the re-read must stay directly under its gate`,
        );
      if (!norm(body).includes(ISSUE_PATCH))
        problems.push(
          `${ISSUES} ${ISSUE_HELPER.name}: does not re-file the row under patchStateTo`,
        );
      if (
        patches.length !== 1 ||
        patches[0] < success[0] ||
        patches[0] > success[1] ||
        reread < 0 ||
        patches[0] < reread
      )
        problems.push(
          `${ISSUES} ${ISSUE_HELPER.name}: expected one patch in onSuccess, after the list re-read`,
        );
    }
  }

  // Of the helper's callers, only close and reopen hand it a state.
  const issues = views[ISSUES];
  if (issues) {
    const callers = [...issues.units].filter(
      ([name, at]) =>
        name !== ISSUE_HELPER.name &&
        indicesOf(issues, `${ISSUE_HELPER.name}(`, at.start, at.end).length > 0,
    );
    for (const name of Object.keys(ISSUE_HELPER.armed))
      if (!callers.some(([n]) => n === name))
        problems.push(`${ISSUES} ${name}: does not call ${ISSUE_HELPER.name}`);
    if (callers.length <= Object.keys(ISSUE_HELPER.armed).length)
      problems.push(`${ISSUE_HELPER.name}: no unarmed callers found`);
    for (const [name, at] of callers) {
      for (const i of indicesOf(
        issues,
        `${ISSUE_HELPER.name}(`,
        at.start,
        at.end,
      )) {
        const args = argsAt(issues, i + ISSUE_HELPER.name.length);
        const passed = args?.[ISSUE_HELPER.stateIndex];
        const want = ISSUE_HELPER.armed[name];
        if (want && passed !== want)
          problems.push(`${ISSUES} ${name}: does not pass ${want}`);
        if (!want && passed !== undefined && passed !== "undefined")
          problems.push(
            `${ISSUES} ${name}: passes a patch state outside close and reopen`,
          );
      }
    }
  }

  // No other unit patches a list page.
  for (const [file, name, owners] of [
    [
      PR_ACTIONS,
      "patchPrListState(",
      ["patchPrListState", ...Object.keys(PR_HOOKS)],
    ],
    [
      ISSUES,
      "patchIssueListState(",
      ["patchIssueListState", ISSUE_HELPER.name],
    ],
  ]) {
    const view = views[file];
    if (!view) continue;
    for (const [unitName, at] of view.units)
      if (
        !owners.includes(unitName) &&
        indicesOf(view, name, at.start, at.end).length > 0
      )
        problems.push(
          `${file} ${unitName}: patches list pages outside the set`,
        );
  }

  // Each state write's Tauri command, read from its one definition under API.
  const commands = new Map();
  for (const callee of Object.keys(STATE_WRITES)) {
    const named = [];
    for (const [file, view] of Object.entries(views)) {
      const at = file.startsWith(API) ? view.units.get(callee) : undefined;
      if (at)
        named.push(INVOKE_COMMAND.exec(view.code.slice(at.start, at.end))?.[2]);
    }
    if (named.length !== 1)
      problems.push(
        `${callee}: expected one definition under ${API}, found ${named.length}`,
      );
    else if (!named[0])
      problems.push(
        `${callee}: its definition under ${API} invokes no literal command`,
      );
    else commands.set(named[0], callee);
  }
  for (const [file, text] of Object.entries(raw)) {
    if (views[file] || typeof text !== "string") continue;
    if (![...commands.keys()].some((c) => text.includes(c))) continue;
    const view = readView(file, text, problems);
    if (view) views[file] = view;
  }

  // Every open/closed state write anywhere in src/ is one of the patched hooks.
  // Names match on the masked text, so a comment or string naming one is no
  // call; string keys and command literals match on the string-keeping view,
  // with their opening bracket or quote confirmed as code in the masked one.
  const found = new Set();
  const strays = new Set();
  for (const [file, view] of Object.entries(views)) {
    for (const [callee, owner] of Object.entries(STATE_WRITES)) {
      for (const m of view.masked.matchAll(
        new RegExp(`\\b${callee}\\b`, "g"),
      )) {
        const name = unitAt(view, m.index);
        if (file.startsWith(API) && name === callee) continue;
        if (owner.file === file && owner.hook === name) found.add(callee);
        else
          strays.add(
            `${file} ${name ?? OUTSIDE}: calls ${callee} but is not the hook that re-files its row`,
          );
      }
    }
    for (const m of view.code.matchAll(STRING_KEY)) {
      if (view.masked[m.index] !== "[") continue;
      const callee = m[2];
      const name = unitAt(view, m.index);
      const owner = STATE_WRITES[callee];
      if (owner.file === file && owner.hook === name) found.add(callee);
      else
        strays.add(
          `${file} ${name ?? OUTSIDE}: calls ${callee} through a string key but is not the hook that re-files its row`,
        );
    }
    if (file.startsWith(API)) continue;
    for (const [command, callee] of commands) {
      const literal = new RegExp(`(["'\`])${escapeRe(command)}\\1`, "g");
      for (const m of view.code.matchAll(literal)) {
        if (view.masked[m.index] !== m[1]) continue;
        const name = unitAt(view, m.index);
        const head = view.code.slice(Math.max(0, m.index - 120), m.index);
        strays.add(
          `${file} ${name ?? OUTSIDE}: ${INVOKE_OPEN.test(head) ? "invokes" : "names"} ${command} (${callee}'s command) outside ${API}`,
        );
      }
    }
  }
  problems.push(...strays);
  for (const callee of Object.keys(STATE_WRITES))
    if (!found.has(callee))
      problems.push(`${STATE_WRITES[callee].hook}: ${callee} not found`);
  for (const [name, { file, callee, reason }] of Object.entries(UNPATCHED)) {
    const u = unit(file, name);
    if (!u) continue;
    if (!reason) problems.push(`${file} ${name}: exclusion has no reason`);
    if (!new RegExp(`\\b${callee}\\b`).test(u.code))
      problems.push(`${file} ${name}: no longer calls ${callee}`);
    if (/\bpatch\w*ListState\(/.test(u.code))
      problems.push(`${file} ${name}: patches list pages (${reason})`);
  }

  // Arm 3: the issue picker offers open and closed issues alike, unfiltered by
  // state (a just-closed issue may sit only in the lagging open page), and lists
  // each number once.
  const picker = unit(RELATIONS, "IssuePicker");
  if (picker) {
    const n = norm(picker.code);
    if (
      /\bremoteStateMatches\b/.test(n) ||
      /\((?:open|closed)\.data \?\? \[\]\)\.filter\(/.test(n)
    )
      problems.push(
        `${RELATIONS} IssuePicker: a read is filtered by state (the picker offers open and closed issues alike)`,
      );
    for (const tab of ["open", "closed"])
      if ((n.match(new RegExp(`\\(${tab}\\.data\\b`, "g")) ?? []).length !== 1)
        problems.push(
          `${RELATIONS} IssuePicker: the ${tab} read is used more than once`,
        );
    if (
      !n.includes("const seen = new Set<number>();") ||
      !n.includes(
        "const candidates = [...(open.data ?? []), ...(closed.data ?? [])].filter((i) => { if (seen.has(i.number)) return false; seen.add(i.number); return !exclude.has(i.number); })",
      )
    )
      problems.push(
        `${RELATIONS} IssuePicker: the merged candidates are not deduped by number`,
      );
  }

  // Arm 3: the linked-issue chips rank off the filtered rows only.
  const chips = unit(CHIPS, "useLinkedIssueChips");
  if (chips) {
    const { view } = chips;
    const n = norm(chips.code);
    if (
      !n.includes(
        'const openRows = issueList.data?.filter((i) => remoteStateMatches(i.state, "open"));',
      )
    )
      problems.push(
        `${CHIPS} useLinkedIssueChips: openRows is not the open page filed by state`,
      );
    const build = blockAfter(
      view,
      /function buildCandidates\(\)[^{]*\{/,
      chips.start,
      chips.end,
    );
    if (!build)
      problems.push(`${CHIPS} useLinkedIssueChips: buildCandidates not found`);
    else {
      const body = norm(view.code.slice(build[0], build[1] + 1));
      if (!body.includes("const ranked = (openRows ?? [])"))
        problems.push(
          `${CHIPS} useLinkedIssueChips: the ranking does not read openRows`,
        );
      if (body.includes("issueList.data"))
        problems.push(
          `${CHIPS} useLinkedIssueChips: the ranking reads the raw open page`,
        );
    }
    // The declaration plus the ranking: the number lookups only enrich a chip,
    // so they stay on the raw page.
    if ((n.match(/\bopenRows\b/g) ?? []).length !== 2)
      problems.push(
        `${CHIPS} useLinkedIssueChips: openRows is read outside the ranking`,
      );
  }

  // Arm 3: the stack offer's open page stays raw; the fork note files by state.
  const view = views[VIEW];
  if (view) {
    const open = constStatement(view, "openPrs");
    if (open !== "const openPrs = offerEnabled ? (offerList.data ?? []) : [];")
      problems.push(
        `${VIEW}: openPrs must stay the raw open page (the detector's guards read it), got ${JSON.stringify(open)}`,
      );
    const offer = constStatement(view, "stackOffer");
    if (
      offer !==
      "const stackOffer = currentRow ? detectStackOffer(currentRow, openPrs) : null;"
    )
      problems.push(`${VIEW}: the detector no longer reads the raw openPrs`);
    const fork = constStatement(view, "forkChild");
    if (
      !fork?.includes(
        'openPrs.some((p) => remoteStateMatches(p.state, "open") &&',
      )
    )
      problems.push(`${VIEW}: forkChild does not file the fork row by state`);
  }
  return problems;
}

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
let tree = null;

/** Every .ts/.tsx under src/, src-relative path → LF-normalized text (so the
 *  mutants below match the lines the checker reads), or null when a file can't
 *  be read, which the checker reports. Read once; each call hands back a fresh
 *  object, so one test's mutant never reaches the next. */
function realSources() {
  if (!tree) {
    tree = {};
    for (const full of sourceFiles(SRC_ROOT)) {
      const file = relative(SRC_ROOT, full).split(sep).join("/");
      try {
        tree[file] = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
      } catch {
        tree[file] = null;
      }
    }
  }
  return { ...tree };
}

/** `sources` with `file`'s text passed through `edit`, asserting it changed. */
function mutate(sources, file, edit) {
  const next = edit(sources[file]);
  assert.notEqual(next, sources[file], `mutant of ${file} changed nothing`);
  return { ...sources, [file]: next };
}

/** Asserts the checker flags `sources` with a problem containing every `part`. */
function assertFlags(sources, ...parts) {
  const problems = checkRemoteListState(sources);
  assert.ok(
    problems.some((p) => parts.every((part) => p.includes(part))),
    `expected a problem with ${JSON.stringify(parts)}, got ${JSON.stringify(problems)}`,
  );
}

test("the real sources hold the row-state wiring", () => {
  assert.deepEqual(checkRemoteListState(realSources()), []);
});

test("the list key's state segment is what the placeholder filter reads", () => {
  // The pinned key literal: ["repo", repo, "pr-list", lens, state, limit, filter].
  const keyOn = (state) => ["repo", "/r", "pr-list", "origin", state, 30, ""];
  const page = [
    { number: 1, state: "OPEN" },
    { number: 2, state: "MERGED" },
  ];
  assert.deepEqual(
    filterPlaceholderRows(page, "open", keyOn("open")[4]).map((r) => r.number),
    [1],
  );
  assert.equal(filterPlaceholderRows(page, "open", keyOn("closed")[4]), page);
});

test("the helpers' updater writes a changed page and bails on an untouched one", () => {
  // The updater both helpers pass setQueriesData (pinned as text above):
  // undefined makes query-core skip the write, so the page keeps its identity
  // and its observers stay quiet.
  const updater = (number, state) => (page) => {
    const next = patchRowState(page, number, state);
    return next === page ? undefined : next;
  };
  const page = [
    { number: 1, state: "OPEN" },
    { number: 2, state: "MERGED" },
  ];
  assert.deepEqual(
    updater(1, "MERGED")(page).map((r) => r.state),
    ["MERGED", "MERGED"],
  );
  assert.equal(updater(9, "MERGED")(page), undefined);
  assert.equal(updater(2, "MERGED")(page), undefined);
  assert.equal(updater(1, "CLOSED")(undefined), undefined);
});

test("a list hook placeholder that skips the filter, or reads the lens segment, fails", () => {
  assertFlags(
    mutate(realSources(), PRS, (t) =>
      t.replace(
        "placeholderData: (prev, prevQuery) => {",
        "placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),\n    _old: (prev, prevQuery) => {",
      ),
    ),
    PRS,
    "usePrList",
    "placeholderData",
  );
  assertFlags(
    mutate(realSources(), ISSUES, (t) =>
      t.replace("prevQuery?.queryKey[4]", "prevQuery?.queryKey[3]"),
    ),
    ISSUES,
    "useIssueList",
    "queryKey[4]",
  );
});

test("an axis inserted before state, or a longer key builder, fails", () => {
  assertFlags(
    mutate(realSources(), PRS, (t) =>
      t.replace(
        "...repoKeys.prList(repo),\n      lens,\n      state,",
        "...repoKeys.prList(repo),\n      lens,\n      kind,\n      state,",
      ),
    ),
    "usePrList",
    "index 4",
  );
  assertFlags(
    mutate(realSources(), CORE, (t) =>
      t.replace(
        '["repo", repo, "issue-list"]',
        '["repo", repo, "issues", "list"]',
      ),
    ),
    "repoKeys.issueList",
  );
});

test("a merge patch outside the queued gate, or ahead of the re-read, fails", () => {
  const outside = mutate(realSources(), PR_ACTIONS, (t) =>
    t.replace(
      '          patchPrListState(queryClient, repo, args.lens, args.number, "MERGED");\n        }',
      '        }\n        patchPrListState(queryClient, repo, args.lens, args.number, "MERGED");',
    ),
  );
  assertFlags(outside, "useMergePr", "not guarded");
  const ahead = mutate(realSources(), PR_ACTIONS, (t) =>
    t.replace(
      "if (!data.queued) {\n          recheckListsLater(",
      'if (!data.queued) {\n          patchPrListState(queryClient, repo, args.lens, args.number, "MERGED");\n          recheckListsLater(',
    ),
  );
  assertFlags(ahead, "useMergePr", "first statement is the list re-read");
  const dropped = mutate(realSources(), PR_ACTIONS, (t) =>
    t.replace(
      '          patchPrListState(queryClient, repo, args.lens, args.number, "MERGED");\n',
      "",
    ),
  );
  assertFlags(dropped, "useMergePr", "found 0");
});

test("a close or reopen that re-files under the wrong state, or not at all, fails", () => {
  assertFlags(
    mutate(realSources(), PR_ACTIONS, (t) =>
      t.replace('args.number, "CLOSED");', 'args.number, "MERGED");'),
    ),
    "useClosePr",
    '"CLOSED"',
  );
  assertFlags(
    mutate(realSources(), PR_ACTIONS, (t) =>
      t.replace(
        '        patchPrListState(queryClient, repo, args.lens, args.number, "OPEN");\n',
        "",
      ),
    ),
    "useReopenPr",
  );
});

test("a commented-out patch is no patch", () => {
  assertFlags(
    mutate(realSources(), PR_ACTIONS, (t) =>
      t.replace(
        'patchPrListState(queryClient, repo, args.lens, args.number, "CLOSED");',
        '// patchPrListState(queryClient, repo, args.lens, args.number, "CLOSED");',
      ),
    ),
    "useClosePr",
  );
});

test("an exported helper, or one without its bail, fails", () => {
  assertFlags(
    mutate(realSources(), PR_ACTIONS, (t) =>
      t.replace(
        "\nfunction patchPrListState(",
        "\nexport function patchPrListState(",
      ),
    ),
    "patchPrListState",
    "module-private",
  );
  assertFlags(
    mutate(realSources(), ISSUES, (t) =>
      t.replace("return next === page ? undefined : next;", "return next;"),
    ),
    "patchIssueListState",
    "bail",
  );
});

test("an auto-merge arm or another write that patches list pages fails", () => {
  assertFlags(
    mutate(realSources(), PR_ACTIONS, (t) =>
      t.replace(
        "onSuccess: () => recheckRunsAfterPush(queryClient, repo),",
        'onSuccess: (_d, args) => {\n        recheckRunsAfterPush(queryClient, repo);\n        patchPrListState(queryClient, repo, args.lens, args.number, "MERGED");\n      },',
      ),
    ),
    "useGlArmAutoMerge",
  );
});

test("a new hook writing a remote row's state must join the patched set", () => {
  assertFlags(
    mutate(
      realSources(),
      PR_ACTIONS,
      (t) =>
        `${t}\nexport function useSneakyClose(repo: string) {\n  return useRepoMutation(repo, (n: number) => api.forgePrClose(repo, n, "origin"));\n}\n`,
    ),
    "useSneakyClose",
    "forgePrClose",
  );
  assertFlags(
    mutate(realSources(), ISSUES, (t) =>
      t.replace(
        "export function useReopenIssue(",
        "export function useReopen(",
      ),
    ),
    "useReopenIssue",
  );
});

test("a state write called from anywhere else in src/ fails", () => {
  const file = "features/issues/SneakyCloseButton.tsx";
  const sources = realSources();
  assert.ok(!(file in sources), `${file} exists`);
  sources[file] =
    'import * as api from "@/lib/git/api";\n\nexport function useSneakyClose(repo: string) {\n  return (n: number) => api.forgeIssueClose(repo, n, "completed", "origin");\n}\n';
  assertFlags(
    sources,
    `${file} useSneakyClose: calls forgeIssueClose but is not the hook that re-files its row`,
  );
  // A named import is a mention outside any function or binding.
  assertFlags(
    {
      ...realSources(),
      [file]: 'export { forgePrReopen } from "@/lib/git/api";\n',
    },
    `${file} (outside any function or binding): calls forgePrReopen`,
  );
  // Naming one in a comment or a string is no call, and a command name inside a
  // longer string or a comment is no command literal.
  assert.deepEqual(
    checkRemoteListState({
      ...realSources(),
      [file]:
        '// api.forgeIssueClose is the close write; invoke("forge_pr_close") lives in lib/git/api.\nexport const LABEL = "forgePrMerge";\nexport const NOTE = "runs \'forge_issue_close\' on the backend";\n',
    }),
    [],
  );
});

test("a state write read through a string key fails", () => {
  const file = "features/issues/SneakyKeyedClose.tsx";
  const sources = realSources();
  assert.ok(!(file in sources), `${file} exists`);
  sources[file] =
    'import * as api from "@/lib/git/api";\n\nexport function useKeyedClose(repo: string) {\n  return (n: number) => api["forgePrClose"](repo, n, "origin");\n}\n';
  assertFlags(
    sources,
    `${file} useKeyedClose: calls forgePrClose through a string key but is not the hook that re-files its row`,
  );
});

test("a state write's command used outside lib/git/api/ fails", () => {
  const file = "features/pulls/SneakyInvoke.ts";
  const sources = realSources();
  assert.ok(!(file in sources), `${file} exists`);
  sources[file] =
    'import { invoke } from "@/lib/tauri/invoke";\n\nexport const closeDirect = (repoPath: string, number: number) =>\n  invoke<void>("forge_pr_close", { repoPath, number, lens: "origin" });\n';
  assertFlags(
    sources,
    `${file} closeDirect: invokes forge_pr_close (forgePrClose's command) outside lib/git/api/`,
  );
  assertFlags(
    {
      ...realSources(),
      [file]: "export const CLOSE_ISSUE = 'forge_issue_close';\n",
    },
    `${file} CLOSE_ISSUE: names forge_issue_close (forgeIssueClose's command) outside lib/git/api/`,
  );
});

test("a state write whose api definition hides its command fails closed", () => {
  const api = "lib/git/api/pr-actions.ts";
  assertFlags(
    mutate(realSources(), api, (t) =>
      t.replace(
        'invoke<void>("forge_pr_reopen",',
        "invoke<void>(REOPEN_COMMAND,",
      ),
    ),
    "forgePrReopen: its definition under lib/git/api/ invokes no literal command",
  );
  const { [api]: _api, ...noApi } = realSources();
  assertFlags(
    noApi,
    "forgePrClose: expected one definition under lib/git/api/, found 0",
  );
});

test("a tree read that walked almost nothing fails closed", () => {
  const sources = realSources();
  const kept = Object.fromEntries(
    Object.entries(sources).filter(
      ([file]) => file.startsWith(Q) || CORPUS_FILES.includes(file),
    ),
  );
  assertFlags(kept, "src/: read", `expected at least ${TREE_FLOOR}`);
  assertFlags(
    { ...sources, "features/Unreadable.tsx": null },
    "features/Unreadable.tsx: unreadable source",
  );
});

/** `sources` with the issue helper's own text passed through `edit`: its
 *  callback shapes repeat in other hooks of the file. */
function mutateIssueHelper(sources, edit) {
  return mutate(sources, ISSUES, (t) => {
    const start = t.indexOf(`function ${ISSUE_HELPER.name}<`);
    const end = t.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, `${ISSUE_HELPER.name} not found`);
    return t.slice(0, start) + edit(t.slice(start, end)) + t.slice(end);
  });
}

const ISSUE_PATCH_TEXT =
  "      if (patchStateTo)\n        patchIssueListState(\n          queryClient,\n          repo,\n          lens,\n          numberOf(args),\n          patchStateTo,\n        );\n";

test("the issue helper's patch must follow its gated re-read in onSuccess", () => {
  const ahead = mutateIssueHelper(realSources(), (body) => {
    assert.ok(body.includes(ISSUE_PATCH_TEXT), "the patch statement moved");
    return body
      .replace(ISSUE_PATCH_TEXT, "")
      .replace(
        "    onSuccess: (_d, args) => {\n",
        `    onSuccess: (_d, args) => {\n${ISSUE_PATCH_TEXT}`,
      );
  });
  assertFlags(ahead, ISSUE_HELPER.name, "after the list re-read");
  const settled = mutateIssueHelper(realSources(), (body) =>
    body
      .replace(ISSUE_PATCH_TEXT, "")
      .replace(
        "    onSettled: (_d, _e, args) => {\n",
        `    onSettled: (_d, _e, args) => {\n${ISSUE_PATCH_TEXT}`,
      ),
  );
  assertFlags(settled, ISSUE_HELPER.name, "expected one patch in onSuccess");
  const ungated = mutateIssueHelper(realSources(), (body) =>
    body.replace(
      "if (recheckListLater)",
      "if (recheckListLater) void 0;\n     ",
    ),
  );
  assertFlags(ungated, ISSUE_HELPER.name, "directly under its gate");
});

test("only close and reopen hand the issue helper a state", () => {
  assertFlags(
    mutate(realSources(), ISSUES, (t) =>
      t.replace(
        'issueWriteKey("lock", repo),\n  );',
        'issueWriteKey("lock", repo),\n    false,\n    "CLOSED",\n  );',
      ),
    ),
    "useLockIssue",
    "outside close and reopen",
  );
  assertFlags(
    mutate(realSources(), ISSUES, (t) =>
      t.replace('    true,\n    "CLOSED",\n  );', "    true,\n  );"),
    ),
    "useCloseIssue",
    '"CLOSED"',
  );
});

test("an issue picker that filters a read by state, or stops deduping, fails", () => {
  for (const tab of ["open", "closed"])
    assertFlags(
      mutate(realSources(), RELATIONS, (t) =>
        t.replace(
          `...(${tab}.data ?? [])`,
          `...(${tab}.data ?? []).filter((i) => remoteStateMatches(i.state, "${tab}"))`,
        ),
      ),
      "IssuePicker",
      "filtered by state",
    );
  assertFlags(
    mutate(realSources(), RELATIONS, (t) =>
      t.replace(
        "      if (seen.has(i.number)) return false;\n      seen.add(i.number);\n",
        "",
      ),
    ),
    "IssuePicker",
    "deduped",
  );
});

test("chips that rank off the raw page, or filter an enrichment lookup, fail", () => {
  assertFlags(
    mutate(realSources(), CHIPS, (t) =>
      t.replace(
        "const ranked = (openRows ?? [])",
        "const ranked = (issueList.data ?? [])",
      ),
    ),
    "useLinkedIssueChips",
    "ranking",
  );
  assertFlags(
    mutate(realSources(), CHIPS, (t) =>
      t.replace(
        "const found = (issueList.data ?? []).find(",
        "const found = (openRows ?? []).find(",
      ),
    ),
    "useLinkedIssueChips",
    "outside the ranking",
  );
});

test("a filtered stack-offer page, or an unfiled fork note, fails", () => {
  assertFlags(
    mutate(realSources(), VIEW, (t) =>
      t.replace(
        "const openPrs = offerEnabled ? (offerList.data ?? []) : [];",
        'const openPrs = offerEnabled\n    ? (offerList.data ?? []).filter((p) => remoteStateMatches(p.state, "open"))\n    : [];',
      ),
    ),
    "openPrs must stay the raw open page",
  );
  assertFlags(
    mutate(realSources(), VIEW, (t) =>
      t.replace('        remoteStateMatches(p.state, "open") &&\n', ""),
    ),
    "forkChild",
  );
});

test("an empty corpus, a missing file or an unreadable one fails closed", () => {
  assert.notDeepEqual(checkRemoteListState({}), []);
  const { [VIEW]: _view, ...noView } = realSources();
  assertFlags(noView, VIEW, "missing from the corpus");
  assertFlags({ ...realSources(), [CHIPS]: null }, CHIPS, "unreadable");
  assertFlags(
    { ...realSources(), [RELATIONS]: "export function IssuePicker() { /* " },
    RELATIONS,
  );
});
