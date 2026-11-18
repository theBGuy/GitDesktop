// Pins how the Projects panel wires the card open (src/features/projects/use-card-open.ts):
// one hook call and none of the open helpers or navigators in the panel, the wait
// drawn as busy on all three surfaces, the opener recorded through the hook's
// `noteOpener`, a held Enter on a table or roadmap row opening once and a held key
// on a group header toggling once, every open route and the arrival announcer
// reaching the hook (App mounting the announcer once), the open context the hook
// reads, and the user's project and view picks (and the creates and the delete
// whose continuations pick), and the view delete, moving the epoch first, and the
// arguments the Projects anchor provider hands boardAnchorAnswer. The panel can't
// render under jsdom, so its wiring is read from source; the open hook's behaviour
// is pinned in src/test/board-card-open.test.tsx, the anchor answer's in
// src/test/board-return.test.tsx.
//
// Each check fails closed on a file it can't read or a shape it can't find, and each
// has an in-memory mutant that must turn it red. Files are read with CRLF folded to
// LF, so a Windows checkout and the CI's LF checkout give the same verdicts.
//
// CONTRACT. These are source-shape pins. Green means each pinned shape is present,
// the stated number of times, at the named site, in the stated textual order. P2's
// surface compares, P10, P11, P12 and P14 read code with comments stripped; the
// other reads are of raw text, where a shape left in a comment can count (P1 fails
// on a name in a comment by design). No panel code is run (P12 alone models the
// two outcomes of the lens ternary it matched), so they cannot see what a pinned
// expression computes once more is written around it (`=== openingItemId &&
// false`), which paths reach a pinned statement from outside its own block (a
// narrowed key test around onTableKeyDown's guarded toggle), what runs between a
// note and its call other than a `return` (a `throw`, or the call put under a
// condition), what a pinned name is read from (the slug read behind the memo's
// `repoSlug`), or a new site of another shape (a pick or a view write outside the
// listed handlers). The
// typecheck catches an unread `noteOpener` parameter and a narrowed chord's dead
// compare. An equivalent rewrite turns a pin red by design: re-point the pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stripComments } from "./check-banned-patterns.mjs";

const ROOT = new URL("../", import.meta.url);
const PANEL = "src/features/projects/ProjectsBoardPanel.tsx";
const SURFACES = {
  ProjectsTableView: "src/features/projects/ProjectsTableView.tsx",
  ProjectsRoadmapView: "src/features/projects/ProjectsRoadmapView.tsx",
  BoardColumn: "src/features/projects/BoardColumn.tsx",
};

function read(rel) {
  const text = readFileSync(new URL(rel, ROOT), "utf8").replace(/\r\n/g, "\n");
  if (text.trim() === "") throw new Error(`${rel} is empty`);
  return text;
}

const count = (text, needle) => text.split(needle).length - 1;

/** The text from `open` (an index of an opening bracket) to its matching close,
 *  or null when the brackets never balance. Strings are not special-cased: the
 *  scanned regions hold no unbalanced bracket inside a literal. */
function balanced(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[text[open]];
  if (close === undefined) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === close && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** Every JSX opening tag of `name`: from `<name` to the first `>` outside braces
 *  (an arrow's `=>` sits inside an attribute's braces). */
function openingTags(text, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b`, "g");
  for (const m of text.matchAll(re)) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    out.push(end === -1 ? null : text.slice(m.index, end + 1));
  }
  return out;
}

/** P1: one useCardOpen( call, and the panel names none of the open helpers or
 *  navigators the hook owns. */
function checkP1(panel) {
  const errors = [];
  const calls = count(panel, "useCardOpen(");
  if (calls !== 1) errors.push(`useCardOpen( called ${calls} times, want 1`);
  for (const name of [
    "claimRepoOpen",
    "resolveLocalLanding",
    "opensInApp",
    "openLabelFor",
    "openPr(",
    "openIssue(",
    "selectIssue(",
  ])
    if (panel.includes(name)) errors.push(`the panel names ${name}`);
  return errors;
}

const OPENING_PROP = "openingItemId={openingItemId}";

/** The element on each surface that draws a card or row. */
const BUSY_ELEMENT = {
  ProjectsTableView: "TableItemRow",
  ProjectsRoadmapView: "RoadmapItemRow",
  BoardColumn: "BoardCard",
};

/** Source with comments removed, so a pinned shape left only in a comment fails. */
const uncommented = (text) => stripComments(text.split("\n")).join("\n");

/** The expression an opening tag hands its `item={…}` prop, or null. */
function ownItem(tag) {
  const m = /(?<![\w$-])item=\{/.exec(tag);
  const value = m === null ? null : balanced(tag, m.index + m[0].length - 1);
  return value === null ? null : value.slice(1, -1).trim();
}

/** Whether `span` compares `<own>.itemId === openingItemId`: the element's own
 *  item on the left, not whatever identifier happens to sit there. */
function comparesOwn(span, own) {
  const lefts = span.matchAll(
    /(?<![\w$.[\]])([\w$.[\]]+)\s*===\s*openingItemId\b/g,
  );
  return [...lefts].some((m) => m[1] === `${own}.itemId`);
}

/** P2: the panel passes the wait to each surface once, and each surface compares
 *  its card's or row's own item id to it inside a `busy={…}` prop of that element. */
function checkP2(panel, surfaces) {
  const errors = [];
  const total = count(panel, OPENING_PROP);
  if (total !== 3) errors.push(`${OPENING_PROP} passed ${total} times, want 3`);
  for (const [tag, text] of Object.entries(surfaces)) {
    const tags = openingTags(panel, tag);
    if (tags.length !== 1 || tags[0] === null)
      errors.push(
        `want one readable <${tag} opening tag, found ${tags.length}`,
      );
    else if (count(tags[0], OPENING_PROP) !== 1)
      errors.push(`<${tag} does not pass ${OPENING_PROP} once`);
    const element = BUSY_ELEMENT[tag];
    const own = openingTags(uncommented(text), element).filter(
      (t) => t !== null && ownItem(t) !== null,
    );
    const busy = own.flatMap((t) =>
      [...t.matchAll(/\bbusy=\{/g)].map((m) => ({
        item: ownItem(t),
        span: balanced(t, m.index + "busy=".length),
      })),
    );
    if (
      !busy.some(({ item, span }) => span !== null && comparesOwn(span, item))
    )
      errors.push(
        `${tag}: no busy={…} on <${element} compares its own item's itemId === openingItemId`,
      );
  }
  return errors;
}

/** P3: the `noteOpener` the panel hands the hook writes the opener ref. */
function checkP3(panel) {
  const call = panel.indexOf("useCardOpen(");
  if (call === -1) return ["no useCardOpen( call"];
  const args = balanced(panel, call + "useCardOpen".length);
  if (args === null) return ["useCardOpen('s arguments don't balance"];
  const prop = /\bnoteOpener\b(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*[,}]/.exec(args);
  if (prop === null) return ["useCardOpen( is handed no noteOpener"];
  const name = prop[1] ?? "noteOpener";
  const def = new RegExp(`const ${name}\\s*=\\s*useCallback\\(`).exec(panel);
  if (def === null) return [`no \`const ${name} = useCallback(\` in the panel`];
  const body = balanced(panel, def.index + def[0].length - 1);
  if (body === null) return [`${name}'s useCallback doesn't balance`];
  if (!/openerRef\.current\s*=\s*[A-Za-z_$]/.test(body))
    return [`${name} never assigns openerRef.current`];
  return [];
}

/** P4: a held Enter on a table or roadmap row opens once, and a held Enter or
 *  Space on a group header toggles it once. */
function checkP4(panel) {
  const head = /function onTableKeyDown\s*\(/.exec(panel);
  if (head === null) return ["no function onTableKeyDown("];
  const brace = panel.indexOf("{", panel.indexOf(")", head.index));
  const body = brace === -1 ? null : balanced(panel, brace);
  if (body === null) return ["onTableKeyDown's body doesn't balance"];
  const errors = [];
  for (const name of ["activateRow", "toggleGroup"]) {
    const calls = count(body, `${name}(`);
    if (calls !== 1)
      errors.push(`onTableKeyDown calls ${name}( ${calls} times`);
    else if (
      !new RegExp(`if\\s*\\(\\s*!e\\.repeat\\s*\\)\\s*${name}\\(`).test(body)
    )
      errors.push(`onTableKeyDown's ${name}( is not skipped on e.repeat`);
  }
  return errors;
}

/** useCardOpen('s argument text, or null. */
function cardOpenArgs(panel) {
  const call = panel.indexOf("useCardOpen(");
  return call === -1 ? null : balanced(panel, call + "useCardOpen".length);
}

/** P5: the arrival announcer that outlives the repository switch reaches the hook.
 *  Optional in the hook's input, so the typechecker can't see it missing. */
function checkP5(panel) {
  const args = cardOpenArgs(panel);
  if (args === null) return ["no balanced useCardOpen( call"];
  if (!/\bannounceArrival\s*:\s*announceApp\s*[,}]/.test(args))
    return ["useCardOpen( is not handed announceArrival: announceApp"];
  return [];
}

/** P6: a board column's card click opens through the hook. */
function checkP6(panel) {
  const tags = openingTags(panel, "BoardColumn");
  if (tags.length !== 1 || tags[0] === null)
    return [`want one readable <BoardColumn opening tag, found ${tags.length}`];
  if (count(tags[0], "onOpen={openItem}") !== 1)
    return ["<BoardColumn does not pass onOpen={openItem} once"];
  return [];
}

const MENU_OPEN =
  /\bopen:\s*\(\)\s*=>\s*\{\s*if\s*\(menuTarget !== null\)\s*openItem\(menuTarget\.item\);\s*\}/;
const MENU_WEB =
  /\bopenOnWeb:\s*\(\)\s*=>\s*\{\s*if\s*\(menuTarget !== null\)\s*openOnWeb\(menuTarget\.item\);\s*\}/;

/** P7: the card menu's two open rows call the hook's two opens, each its own. */
function checkP7(panel) {
  const at = panel.indexOf("actions={{");
  if (at === -1) return ["no actions={{ in the panel"];
  const actions = balanced(panel, at + "actions=".length);
  if (actions === null) return ["the menu's actions don't balance"];
  const errors = [];
  if (!MENU_OPEN.test(actions))
    errors.push("the menu's open: does not call openItem(menuTarget.item)");
  if (!MENU_WEB.test(actions))
    errors.push(
      "the menu's openOnWeb: does not call openOnWeb(menuTarget.item)",
    );
  return errors;
}

/** P8: the menu's row labels read the same open context the hook opens with. */
function checkP8(panel) {
  const args = cardOpenArgs(panel);
  if (args === null) return ["no balanced useCardOpen( call"];
  const ctx = /\bctx\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(args);
  if (ctx === null) return ["useCardOpen( is handed no ctx: <identifier>"];
  const rows = [
    ...panel.matchAll(
      /openRows=\{openRowLabels\([^,()]*,\s*([A-Za-z_$][\w$]*)\s*\)\}/g,
    ),
  ];
  if (rows.length !== 1)
    return [`want one openRows={openRowLabels(…, ctx)}, found ${rows.length}`];
  if (rows[0][1] !== ctx[1])
    return [`openRows= reads ${rows[0][1]}, the hook's ctx: is ${ctx[1]}`];
  return [];
}

/** P9: a table or roadmap row's activation opens through the hook. */
function checkP9(panel) {
  const def = /const activateRow\s*=\s*useCallback\(/.exec(panel);
  if (def === null) return ["no `const activateRow = useCallback(`"];
  const body = balanced(panel, def.index + def[0].length - 1);
  if (body === null) return ["activateRow's useCallback doesn't balance"];
  if (!/(?<![\w$.])openItem\(item\)/.test(body))
    return ["activateRow never calls openItem(item)"];
  return [];
}

const ANNOUNCER_TAG = "<AppAnnouncer />";
const ANNOUNCER_IMPORT =
  'import { AppAnnouncer } from "@/components/app-announcer";';

/** P10: the app-level announcer the arrival lines speak through is mounted once.
 *  Counted in code only, so a copy inside a comment never satisfies it. */
function checkP10(app) {
  const errors = [];
  const code = stripComments(app.split("\n")).join("\n");
  const tags = count(code, ANNOUNCER_TAG);
  if (tags !== 1) errors.push(`${ANNOUNCER_TAG} appears ${tags} times, want 1`);
  const imports = count(code, ANNOUNCER_IMPORT);
  if (imports !== 1)
    errors.push(`the AppAnnouncer import appears ${imports} times, want 1`);
  return errors;
}

/** The body of `function <name>(…) {…}`, or null. */
function functionBody(text, name) {
  const head = new RegExp(`function ${name}\\s*\\(`).exec(text);
  if (head === null) return null;
  const params = balanced(text, head.index + head[0].length - 1);
  if (params === null) return null;
  const brace = text.indexOf(
    "{",
    head.index + head[0].length - 1 + params.length,
  );
  return brace === -1 ? null : balanced(text, brace);
}

const callOf = (name) => new RegExp(`(?<![\\w$.])${name}\\(`);
const NOTE = /\bnoteUserInteraction\(\)/;

/** Every `onValueChange={…}` handler that calls `name(`. */
function handlersCalling(text, name) {
  const out = [];
  for (const m of text.matchAll(/\bonValueChange=\{/g)) {
    const body = balanced(text, m.index + "onValueChange=".length);
    if (body !== null && callOf(name).test(body)) out.push(body);
  }
  return out;
}

/** The block of the arrow function in `expr`, or null. */
function arrowBody(expr) {
  const m = /=>\s*\{/.exec(expr ?? "");
  return m === null ? null : balanced(expr, m.index + m[0].length - 1);
}

/** The body of the `onValueChange` arrow that calls `name(`, or null unless
 *  exactly one does. */
function pickHandler(text, name) {
  const handlers = handlersCalling(text, name);
  return handlers.length === 1 ? arrowBody(handlers[0]) : null;
}

/** The `async () => {…}` block `fn` hands `runVerbOnce("<verb>", …)`, or null. */
function verbBody(text, fn, verb) {
  const body = functionBody(text, fn) ?? "";
  const m = new RegExp(
    `runVerbOnce\\(\\s*"${verb}",\\s*async\\s*\\(\\)\\s*=>\\s*\\{`,
  ).exec(body);
  return m === null ? null : balanced(body, m.index + m[0].length - 1);
}

/** `submitViewName`'s create branch, or null. */
function newViewBranch(text) {
  const body = functionBody(text, "submitViewName") ?? "";
  const m = /if\s*\(\s*run\?\.kind\s*===\s*"new-view"\s*\)\s*\{/.exec(body);
  return m === null ? null : balanced(body, m.index + m[0].length - 1);
}

const REFUSAL = /\brefuseWhileOffline\(\)/;

/** The user requests that move the epoch: where each one's block is, the call its
 *  note must precede (the pick, or the write), the pick that block goes on to
 *  reach (absent for the view delete, whose write changes the shown view and
 *  reaches no pick), and the refusal the note must follow, where one stands above
 *  it. */
const USER_PICKS = [
  {
    what: "the project picker",
    block: (text) => pickHandler(text, "switchProject"),
    before: callOf("switchProject"),
    picks: callOf("switchProject"),
  },
  {
    what: "the view rows' handler",
    block: (text) => pickHandler(text, "pickView"),
    before: callOf("pickView"),
    picks: callOf("pickView"),
  },
  {
    what: "clearViewByUser",
    block: (text) => functionBody(text, "clearViewByUser"),
    before: callOf("clearView"),
    picks: callOf("clearView"),
  },
  {
    what: "the new project's submit",
    block: (text) => functionBody(text, "submitNewProject"),
    before: /\bcreateProject\.mutateAsync\(/,
    picks: /\bswitchProject\(created\.id\)/,
    after: REFUSAL,
  },
  {
    what: "the project delete",
    block: (text) => verbBody(text, "removeProject", "delete-project"),
    before: /\bdeleteProject\.mutateAsync\(/,
    picks: /\bswitchProject\(null\)/,
    after: REFUSAL,
  },
  {
    what: "the new view's submit",
    block: newViewBranch,
    before: /\bcreateView\.mutateAsync\(/,
    picks: /\bsetPendingViewPick\(created\)/,
    after: REFUSAL,
  },
  {
    what: "the view duplicate",
    block: (text) => verbBody(text, "duplicateCurrentView", "duplicate-view"),
    before: /\bduplicateView\.mutateAsync\(/,
    picks: /\bsetPendingViewPick\(created\)/,
    after: REFUSAL,
  },
  {
    what: "the view delete",
    block: (text) => verbBody(text, "removeCurrentView", "delete-view"),
    before: /\bdeleteView\.mutateAsync\(/,
    after: REFUSAL,
  },
];

const NOTE_STATEMENT = /(?:useUiStore\.getState\(\)\.)?noteUserInteraction\(\)/;

/** Why `block` (a balanced `{…}`) doesn't note the interaction as a plain
 *  statement after the last `after` (when given) and ahead of `before`, with no
 *  `return` between the two, then reach `picks` (when given), or null. Plain: a
 *  statement of its own directly in `block`, never inside a nested block, an `if`,
 *  `else`, loop, `&&` or ternary, so every path that reaches the call notes first.
 *  Nesting and the `return` token are read over raw text, so a bracket ahead of
 *  the note, or the word `return` after it, inside a string or template literal
 *  counts. */
function plainNoteBefore(block, { before, picks, after }) {
  const at = block.search(before);
  if (at === -1) return `has no ${before.source}`;
  if (picks !== undefined && block.slice(at).search(picks) === -1)
    return `never reaches ${picks.source}`;
  const notes = block.match(new RegExp(NOTE.source, "g"))?.length ?? 0;
  if (notes !== 1) return `calls noteUserInteraction() ${notes} times, want 1`;
  const note = NOTE_STATEMENT.exec(block);
  if (note.index > at)
    return `calls noteUserInteraction() after ${before.source}`;
  let depth = 0;
  for (let i = 0; i < note.index; i++) {
    if ("{([".includes(block[i])) depth += 1;
    else if ("})]".includes(block[i])) depth -= 1;
  }
  if (depth !== 1) return "calls noteUserInteraction() inside a nested block";
  if (!/[{;}]$/.test(block.slice(0, note.index).trimEnd()))
    return "calls noteUserInteraction() behind something else in its statement (a condition, a prefix such as void, or a receiver other than useUiStore.getState())";
  if (!/^\s*;/.test(block.slice(note.index + note[0].length)))
    return "calls noteUserInteraction() inside an expression";
  if (after !== undefined) {
    const refusals = [...block.matchAll(new RegExp(after.source, "g"))];
    if (refusals.length === 0) return `has no ${after.source}`;
    const last = refusals[refusals.length - 1];
    if (note.index < last.index + last[0].length)
      return `calls noteUserInteraction() before the refusal ${after.source}, which it must follow`;
  }
  if (/\breturn\b/.test(block.slice(note.index, at)))
    return `has a return between noteUserInteraction() and ${before.source}`;
  return null;
}

/** P11: every user-facing start of a project or view pick (the project picker, the
 *  view rows, clear-view's hotkey and both buttons, and the create, delete and
 *  duplicate whose continuations pick), and the view delete, whose write changes
 *  the view on screen without a pick, moves the epoch first, as a plain statement,
 *  so a pending card open or held Back retires; the pick functions the board return
 *  and the write continuations call never do, so those keep a pending open alive. */
function checkP11(panel) {
  const src = uncommented(panel);
  const errors = [];
  for (const row of USER_PICKS) {
    const text = row.block(src);
    const why = text === null ? "can't be found" : plainNoteBefore(text, row);
    if (why !== null) errors.push(`${row.what} ${why}`);
  }
  if (
    !/useHotkeyAction\(\s*"clear-project-view",\s*clearViewByUser\s*,/.test(src)
  )
    errors.push("the clear-project-view hotkey does not run clearViewByUser");
  const buttons = openingTags(src, "ClearViewButton");
  if (buttons.length !== 2)
    errors.push(`want two <ClearViewButton tags, found ${buttons.length}`);
  for (const tag of buttons)
    if (tag === null || count(tag, "onClear={clearViewByUser}") !== 1)
      errors.push("a <ClearViewButton does not pass onClear={clearViewByUser}");
  for (const name of ["switchProject", "pickView", "clearView"]) {
    const body = functionBody(src, name);
    if (body === null) errors.push(`no function ${name}(`);
    else if (NOTE.test(body) || body.includes("clearViewByUser"))
      errors.push(`${name} moves the epoch, which its system callers must not`);
  }
  const notes = src.match(new RegExp(NOTE.source, "g"))?.length ?? 0;
  if (notes !== USER_PICKS.length)
    errors.push(
      `noteUserInteraction() called ${notes} times, want ${USER_PICKS.length}`,
    );
  // Its definition, the hotkey and the two buttons: never the board return.
  const uses = src.match(/\bclearViewByUser\b/g)?.length ?? 0;
  if (uses !== 4) errors.push(`clearViewByUser named ${uses} times, want 4`);
  return errors;
}

const OTHER_SLUG_ENABLED = "canRead && lensGate";

/** P12: the open context the panel hands the hook. The other side is the lens the
 *  active one is not, its slug is read for that same lens while the board can read
 *  and the lens gate is open, the side is null while the gate is shut, and the
 *  recents ride in the memo. */
function checkP12(panel) {
  const src = uncommented(panel);
  const errors = [];
  const ternary =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*lens\s*===\s*"(origin|upstream)"\s*\?\s*"(origin|upstream)"\s*:\s*"(origin|upstream)"\s*;/.exec(
      src,
    );
  if (ternary === null) return ['no `const <x> = lens === "…" ? "…" : "…";`'];
  const [, other, test, yes, no] = ternary;
  const flip = (lens) => (lens === test ? yes : no);
  if (flip("origin") !== "upstream" || flip("upstream") !== "origin")
    errors.push(`${other} is not the lens the active one is not`);
  const call = /const\s+otherSlug\s*=\s*useRemoteSlug\(/.exec(src);
  const args =
    call === null ? null : balanced(src, call.index + call[0].length - 1);
  const [repo, slugLens, enabled, ...rest] = (args ?? "()")
    .slice(1, -1)
    .split(",")
    .map((a) => a.trim().replace(/\s+/g, " "))
    .filter((a) => a !== "");
  if (args === null || repo !== "repoPath" || rest.length > 0)
    errors.push("no `const otherSlug = useRemoteSlug(repoPath, <x>, <y>)`");
  else {
    if (slugLens !== other)
      errors.push(
        `otherSlug reads the lens ${slugLens}, the other side is ${other}`,
      );
    // Its enabled argument as written: the read runs while the board can read
    // at all and the lens gate is open, never off.
    if (enabled !== OTHER_SLUG_ENABLED)
      errors.push(
        `otherSlug's read is enabled by ${enabled}, want ${OTHER_SLUG_ENABLED}`,
      );
  }
  const ctx = /\bctx\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(
    cardOpenArgs(src) ?? "",
  );
  if (ctx === null)
    return [...errors, "useCardOpen( is handed no ctx: <identifier>"];
  const memo = new RegExp(
    `const ${ctx[1]}\\s*=\\s*useMemo(?:<[^>]*>)?\\(`,
  ).exec(src);
  const body =
    memo === null ? null : balanced(src, memo.index + memo[0].length - 1);
  if (body === null)
    return [...errors, `no balanced \`const ${ctx[1]} = useMemo(\``];
  const spans = memoSpans(body);
  if (spans === null)
    return [
      ...errors,
      "the memo's `() => ({…})` and its trailing `[…]` don't read as two spans",
    ];
  const { value, deps } = spans;
  if (!/[{,]\s*repoSlug\s*(?::\s*repoSlug\s*)?[,}]/.test(value))
    errors.push("the memo does not carry repoSlug");
  if (!/[{,]\s*forgeHost\s*:\s*host\s*[,}]/.test(value))
    errors.push("the memo does not carry forgeHost: host");
  const side =
    /\botherSide\s*:\s*lensGate\s*\?\s*\{\s*lens\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*slug\s*:\s*otherSlug\s*\}\s*:\s*null\b/.exec(
      value,
    );
  if (side === null)
    errors.push(
      "the memo has no otherSide: lensGate ? { lens: …, slug: otherSlug } : null",
    );
  else if (side[1] !== other)
    errors.push(`otherSide.lens is ${side[1]}, the other side is ${other}`);
  if (!/\brecents\s*(?::\s*recents\s*)?[,}]/.test(value))
    errors.push("the memo does not carry recents");
  const named = new Set(
    deps
      .slice(1, -1)
      .split(",")
      .map((d) => d.trim()),
  );
  for (const dep of [
    "repoSlug",
    "lensGate",
    other,
    "otherSlug",
    "host",
    "recents",
  ])
    if (!named.has(dep))
      errors.push(`the memo's dependency array does not name ${dep}`);
  return errors;
}

/** A `useMemo(…)` call's text split into the object literal its arrow returns and
 *  its trailing dependency array, or null when either doesn't read. */
function memoSpans(call) {
  const arrow = /^\(\s*\(\s*\)\s*=>\s*\(/.exec(call);
  if (arrow === null) return null;
  const group = balanced(call, arrow[0].length - 1);
  const open = group === null ? null : /^\(\s*\{/.exec(group);
  const value = open === null ? null : balanced(group, open[0].length - 1);
  if (
    value === null ||
    !/^\s*\)$/.test(group.slice(open[0].length - 1 + value.length))
  )
    return null;
  const rest = call.slice(arrow[0].length - 1 + group.length);
  const tail = /^\s*,\s*\[/.exec(rest);
  const deps = tail === null ? null : balanced(rest, tail[0].length - 1);
  if (
    deps === null ||
    !/^\s*,?\s*\)$/.test(rest.slice(tail[0].length - 1 + deps.length))
  )
    return null;
  return { value, deps };
}

/** P13: the table and the roadmap hand their row activation and keys to the panel's
 *  own handlers, which P9 and P4 pin. */
function checkP13(panel) {
  const errors = [];
  for (const tag of ["ProjectsTableView", "ProjectsRoadmapView"]) {
    const tags = openingTags(panel, tag);
    if (tags.length !== 1 || tags[0] === null) {
      errors.push(
        `want one readable <${tag} opening tag, found ${tags.length}`,
      );
      continue;
    }
    for (const prop of [
      "onActivate={activateRow}",
      "onKeyDown={onTableKeyDown}",
    ])
      if (count(tags[0], prop) !== 1)
        errors.push(`<${tag} does not pass ${prop} once`);
  }
  return errors;
}

/** What the Projects anchor provider hands `boardAnchorAnswer`, as written: the
 *  hook's two anchors, and the armed request, the epoch and the pick generation
 *  read live at the read. */
const ANCHOR_ARGS = [
  ["armed", "store.boardReturn?.anchor ?? null"],
  ["held", "heldAnchor"],
  ["retired", "retiredAnchor"],
  ["epoch", "store.interactionEpoch"],
  ["pickGeneration", "pickGenerationRef.current"],
];

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** P14: `readBoardAnchor` calls `boardAnchorAnswer(` once, with each of
 *  ANCHOR_ARGS as a whole property and no spread that could override one. */
function checkP14(panel) {
  const src = uncommented(panel);
  const head = /const\s+readBoardAnchor\s*=\s*useEffectEvent\(/.exec(src);
  const body =
    head === null ? null : balanced(src, head.index + head[0].length - 1);
  if (body === null)
    return ["no balanced `const readBoardAnchor = useEffectEvent(`"];
  const calls = [...body.matchAll(/(?<![\w$.])boardAnchorAnswer\(/g)];
  if (calls.length !== 1)
    return [
      `readBoardAnchor calls boardAnchorAnswer( ${calls.length} times, want 1`,
    ];
  const args = balanced(body, calls[0].index + calls[0][0].length - 1);
  if (args === null) return ["boardAnchorAnswer('s arguments don't balance"];
  const flat = args.replace(/\s+/g, " ");
  const errors = [];
  if (flat.includes("..."))
    errors.push("boardAnchorAnswer( is handed a spread");
  for (const [prop, value] of ANCHOR_ARGS)
    if (!new RegExp(`[{,] ?${prop}: ?${literal(value)} ?[,}]`).test(flat))
      errors.push(`boardAnchorAnswer( is not handed ${prop}: ${value}`);
  return errors;
}

const panel = read(PANEL);
const app = read("src/App.tsx");
const surfaces = Object.fromEntries(
  Object.entries(SURFACES).map(([tag, rel]) => [tag, read(rel)]),
);

/** Applies one literal replacement, asserting the literal is present. */
function mutate(text, from, to) {
  assert.ok(text.includes(from), `mutant literal not found: ${from}`);
  return text.replace(from, () => to);
}

test("P1: one useCardOpen( call, and no open helper or navigator in the panel", () => {
  assert.deepEqual(checkP1(panel), []);
  const mutants = [
    mutate(panel, "useCardOpen({", "useCardOpenX({"),
    `${panel}\nuseCardOpen({});`,
    `${panel}\n// claimRepoOpen`,
    `${panel}\n// resolveLocalLanding`,
    `${panel}\nfunction opensInApp() {}`,
    `${panel}\nfunction openLabelFor() {}`,
    `${panel}\nopenPr({});`,
    `${panel}\nopenIssue({});`,
    `${panel}\nselectIssue({});`,
  ];
  for (const m of mutants) assert.notDeepEqual(checkP1(m), []);
});

test("P2: the wait reaches each surface once and is compared inside its busy={…}", () => {
  assert.deepEqual(checkP2(panel, surfaces), []);
  for (const tag of Object.keys(SURFACES)) {
    const start = panel.indexOf(`<${tag}`);
    const tagText = openingTags(panel, tag)[0];
    const without = mutate(tagText, `${OPENING_PROP}`, "");
    const dropped =
      panel.slice(0, start) + without + panel.slice(start + tagText.length);
    assert.notDeepEqual(checkP2(dropped, surfaces), [], `${tag} pass dropped`);
    const surface = surfaces[tag];
    const compare = /\|\|\s*([\w.[\]]+)\s*===\s*openingItemId/.exec(surface);
    assert.ok(compare, `${tag}: no "|| x === openingItemId" to mutate`);
    const unbusy = surface.replace(compare[0], "");
    const blind = { ...surfaces, [tag]: unbusy };
    assert.notDeepEqual(checkP2(panel, blind), [], `${tag} compare dropped`);
    // Another identifier on the left: the compare stays, the row's own id goes.
    for (const left of ["peekItemId", "busyItemId", `${compare[1]}X`]) {
      const other = {
        ...surfaces,
        [tag]: surface.replace(
          compare[0],
          () => `|| ${left} === openingItemId`,
        ),
      };
      assert.notDeepEqual(checkP2(panel, other), [], `${tag} compares ${left}`);
    }
    // The compare moved to another prop of the same element.
    const peek = {
      ...surfaces,
      [tag]: mutate(
        unbusy,
        "peek={",
        `peek={${compare[1]} === openingItemId || `,
      ),
    };
    assert.notDeepEqual(
      checkP2(panel, peek),
      [],
      `${tag} compare moved to peek`,
    );
    // The compare left only in a comment.
    const remark = {
      ...surfaces,
      [tag]: `${unbusy}\n// busy={${compare[1]} === openingItemId}`,
    };
    assert.notDeepEqual(
      checkP2(panel, remark),
      [],
      `${tag} compare in a comment`,
    );
  }
});

test("P3: the panel's noteOpener writes the opener ref", () => {
  assert.deepEqual(checkP3(panel), []);
  const def = /const noteOpener\s*=\s*useCallback\(/.exec(panel);
  assert.ok(def);
  const body = balanced(panel, def.index + def[0].length - 1);
  const silent = panel.replace(body, () =>
    body.replace(/openerRef\.current\s*=/, "void"),
  );
  assert.notDeepEqual(checkP3(silent), []);
  const handedOff = panel.replace(
    /(useCardOpen\(\{[^}]*?)\bnoteOpener,/,
    (_m, lead) => `${lead}noteOpener: () => {},`,
  );
  assert.notEqual(handedOff, panel);
  assert.notDeepEqual(checkP3(handedOff), []);
});

test("P4: onTableKeyDown skips the open and the header toggle on a repeated key", () => {
  assert.deepEqual(checkP4(panel), []);
  for (const name of ["activateRow", "toggleGroup"]) {
    const bare = panel.replace(
      new RegExp(`if\\s*\\(\\s*!e\\.repeat\\s*\\)\\s*${name}\\(`),
      `${name}(`,
    );
    assert.notEqual(bare, panel, `${name}: no change`);
    assert.notDeepEqual(checkP4(bare), [], `${name} unguarded`);
  }
});

test("P5: the panel hands the hook its arrival announcer", () => {
  assert.deepEqual(checkP5(panel), []);
  assert.notDeepEqual(
    checkP5(mutate(panel, "announceArrival: announceApp,", "")),
    [],
  );
});

test("P6: a board column's card opens through openItem", () => {
  assert.deepEqual(checkP6(panel), []);
  const tag = openingTags(panel, "BoardColumn")[0];
  const start = panel.indexOf(tag);
  const swapped = mutate(tag, "onOpen={openItem}", "onOpen={openOnWeb}");
  assert.notDeepEqual(
    checkP6(panel.slice(0, start) + swapped + panel.slice(start + tag.length)),
    [],
  );
});

test("P7: the menu's open rows call openItem and openOnWeb, not swapped", () => {
  assert.deepEqual(checkP7(panel), []);
  const swapped = panel
    .replace(MENU_OPEN, (m) =>
      m.replace("openItem(menuTarget.item)", "openOnWeb(menuTarget.item)"),
    )
    .replace(MENU_WEB, (m) =>
      m.replace("openOnWeb(menuTarget.item)", "openItem(menuTarget.item)"),
    );
  assert.notEqual(swapped, panel);
  assert.notDeepEqual(checkP7(swapped), []);
  const openOnly = panel.replace(MENU_OPEN, (m) =>
    m.replace("openItem(menuTarget.item)", "openOnWeb(menuTarget.item)"),
  );
  assert.notEqual(openOnly, panel);
  assert.notDeepEqual(checkP7(openOnly), []);
});

test("P8: the menu's row labels and the hook read one open context", () => {
  assert.deepEqual(checkP8(panel), []);
  const ctx = /\bctx\s*:\s*([A-Za-z_$][\w$]*)/.exec(cardOpenArgs(panel));
  assert.ok(ctx);
  assert.notDeepEqual(
    checkP8(
      mutate(
        panel,
        `openRowLabels(menuTarget?.item, ${ctx[1]})`,
        "openRowLabels(menuTarget?.item, otherCtx)",
      ),
    ),
    [],
  );
});

test("P9: activateRow opens an issue or pull request through openItem", () => {
  assert.deepEqual(checkP9(panel), []);
  assert.notDeepEqual(
    checkP9(mutate(panel, "else openItem(item);", "else openOnWeb(item);")),
    [],
  );
});

test("P10: App mounts one AppAnnouncer", () => {
  assert.deepEqual(checkP10(app), []);
  const mutants = [
    mutate(app, ANNOUNCER_TAG, ""),
    mutate(app, ANNOUNCER_TAG, `${ANNOUNCER_TAG}${ANNOUNCER_TAG}`),
    mutate(app, ANNOUNCER_IMPORT, ""),
    // The element and its import only inside comments: a JSX one and a line one.
    mutate(
      mutate(app, ANNOUNCER_TAG, `{/* ${ANNOUNCER_TAG} */}`),
      ANNOUNCER_IMPORT,
      `// ${ANNOUNCER_IMPORT}`,
    ),
    mutate(app, ANNOUNCER_TAG, `{/* ${ANNOUNCER_TAG} */}`),
  ];
  for (const m of mutants) assert.notDeepEqual(checkP10(m), []);
});

/** The panel with `body` (a slice of it) rewritten by `edit`, asserting a change. */
function within(text, body, edit) {
  assert.ok(body !== null && text.includes(body), "mutant region not found");
  const next = edit(body);
  assert.notEqual(next, body, "mutant changed nothing");
  return text.replace(body, () => next);
}

const NOTE_LINE =
  /useUiStore\.getState\(\)\.noteUserInteraction\(\);[^\S\n]*\n[^\S\n]*/;
const NOTE_CALL = "useUiStore.getState().noteUserInteraction();";

test("P11: every user start of a pick moves the epoch first; the shared pick functions never do", () => {
  assert.deepEqual(checkP11(panel), []);
  const [project, views, byUser, create, remove, newView, duplicate, unview] =
    USER_PICKS.map(({ block }) => block(panel));
  const drop = (body) => body.replace(NOTE_LINE, "");
  const guarded = (cond) => (body) =>
    body.replace(NOTE_CALL, () => `if (${cond}) ${NOTE_CALL}`);
  // The note moved to the block's first statement, above every refusal: plain,
  // and ahead of the write, so only the `after` rule can see it.
  const hoist = (body) => drop(body).replace("{", () => `{\n${NOTE_CALL}`);
  const cancelBelow = (body) =>
    body
      .replace(
        "if (!ok || refuseWhileOffline()) return;",
        () => "if (refuseWhileOffline()) return;",
      )
      .replace(NOTE_CALL, () => `${NOTE_CALL}\nif (!ok) return;`);
  const moveInto = (text, name) =>
    within(text, functionBody(text, name), (b) =>
      b.replace("{", () => `{\n    ${NOTE_CALL}`),
    );
  const mutants = {
    "project pick unnoted": within(panel, project, drop),
    "view pick unnoted": within(panel, views, drop),
    "clear view unnoted": within(panel, byUser, drop),
    "project create unnoted": within(panel, create, drop),
    "project delete unnoted": within(panel, remove, drop),
    "view create unnoted": within(panel, newView, drop),
    "view duplicate unnoted": within(panel, duplicate, drop),
    "view delete unnoted": within(panel, unview, drop),
    "view delete noted under a condition": within(
      panel,
      unview,
      guarded("target.name === ''"),
    ),
    "project create noted before its refusal": within(panel, create, hoist),
    "project delete noted before its refusal": within(panel, remove, hoist),
    "view create noted before its refusal": within(panel, newView, hoist),
    "view duplicate noted before its refusal": within(panel, duplicate, hoist),
    "view delete noted before its refusal": within(panel, unview, hoist),
    // The cancel half of the guard moved below the note: the offline refusal
    // still stands above it, so only the return rule sees the move.
    "view delete cancels below the note": within(panel, unview, cancelBelow),
    "project delete cancels below the note": within(panel, remove, cancelBelow),
    "view duplicate returns below the note": within(panel, duplicate, (b) =>
      b.replace(
        NOTE_CALL,
        () => `${NOTE_CALL}\nif (source.name === "") return;`,
      ),
    ),
    "project pick noted only in a comment": within(panel, project, (b) =>
      b.replace(NOTE_CALL, () => `// ${NOTE_CALL}`),
    ),
    "project pick noted after the pick": within(panel, project, (b) =>
      drop(b).replace(
        "switchProject(v);",
        () => `switchProject(v);\n${NOTE_CALL}`,
      ),
    ),
    "project pick noted only on a re-pick": within(
      panel,
      project,
      guarded("v === projectId"),
    ),
    "project pick noted in a braced branch": within(panel, project, (b) =>
      b.replace(NOTE_CALL, () => `if (v === projectId) { ${NOTE_CALL} }`),
    ),
    "project pick noted behind &&": within(panel, project, (b) =>
      b.replace(NOTE_CALL, () => `v === projectId && ${NOTE_CALL}`),
    ),
    "view pick noted under a condition": within(
      panel,
      views,
      guarded("next === NO_VIEW_ROW_ID"),
    ),
    "clear view noted under a condition": within(
      panel,
      byUser,
      guarded("view === null"),
    ),
    "project create noted under a condition": within(
      panel,
      create,
      guarded("pickedProjectId === null"),
    ),
    "project delete noted under a condition": within(
      panel,
      remove,
      guarded("target.closed"),
    ),
    "view create noted under a condition": within(
      panel,
      newView,
      guarded("session === 0"),
    ),
    "view duplicate noted under a condition": within(
      panel,
      duplicate,
      guarded("source.name === ''"),
    ),
    "project create noted in its continuation": within(panel, create, (b) =>
      drop(b).replace(
        "switchProject(created.id);",
        () => `{\n${NOTE_CALL}\nswitchProject(created.id);\n}`,
      ),
    ),
    "view duplicate noted after the write": within(panel, duplicate, (b) =>
      drop(b).replace(
        "setPendingViewPick(created);",
        () => `{\n${NOTE_CALL}\nsetPendingViewPick(created);\n}`,
      ),
    ),
    "view rename noted as well": within(
      panel,
      functionBody(panel, "submitViewName"),
      (b) =>
        b.replace(
          'if (run?.kind !== "rename-view") return;',
          () => `if (run?.kind !== "rename-view") return;\n${NOTE_CALL}`,
        ),
    ),
    "hotkey clears without noting": panel.replace(
      /("clear-project-view",\s*)clearViewByUser/,
      "$1clearView",
    ),
    "first button clears without noting": mutate(
      panel,
      "onClear={clearViewByUser}",
      "onClear={clearView}",
    ),
    "second button clears without noting": (() => {
      const at = panel.lastIndexOf("onClear={clearViewByUser}");
      return `${panel.slice(0, at)}onClear={clearView}${panel.slice(at + "onClear={clearViewByUser}".length)}`;
    })(),
    "noted inside switchProject": moveInto(
      within(panel, project, drop),
      "switchProject",
    ),
    "noted inside pickView": moveInto(within(panel, views, drop), "pickView"),
    "noted inside clearView": moveInto(
      within(panel, byUser, drop),
      "clearView",
    ),
    "board return clears through clearViewByUser": mutate(
      panel,
      "viewId === null ? clearView() :",
      "viewId === null ? clearViewByUser() :",
    ),
  };
  for (const [label, m] of Object.entries(mutants)) {
    assert.notEqual(m, panel, `${label}: no change`);
    assert.notDeepEqual(checkP11(m), [], label);
  }
});

test("P12: the open context's other side, its slug, its gate, its fields and its dependencies", () => {
  assert.deepEqual(checkP12(panel), []);
  const memoHead = /const cardOpenCtx\s*=\s*useMemo(?:<[^>]*>)?\(/.exec(panel);
  assert.ok(memoHead, "no `const cardOpenCtx = useMemo(` to mutate");
  const memo = balanced(panel, memoHead.index + memoHead[0].length - 1);
  const mutants = {
    "ternary yields the active lens": mutate(
      panel,
      'lens === "origin" ? "upstream" : "origin"',
      'lens === "origin" ? "origin" : "upstream"',
    ),
    "ternary yields upstream both ways": mutate(
      panel,
      'lens === "origin" ? "upstream" : "origin"',
      'lens === "origin" ? "upstream" : "upstream"',
    ),
    "other slug read for the active lens": mutate(
      panel,
      "useRemoteSlug(repoPath, otherLens,",
      "useRemoteSlug(repoPath, lens,",
    ),
    "other slug never read": mutate(
      panel,
      `useRemoteSlug(repoPath, otherLens, ${OTHER_SLUG_ENABLED})`,
      "useRemoteSlug(repoPath, otherLens, false)",
    ),
    "other slug read off": mutate(
      panel,
      `useRemoteSlug(repoPath, otherLens, ${OTHER_SLUG_ENABLED})`,
      `useRemoteSlug(repoPath, otherLens, ${OTHER_SLUG_ENABLED} && false)`,
    ),
    "other slug read with the gate shut": mutate(
      panel,
      `useRemoteSlug(repoPath, otherLens, ${OTHER_SLUG_ENABLED})`,
      "useRemoteSlug(repoPath, otherLens, canRead)",
    ),
    "other side carries the active lens": mutate(
      panel,
      "{ lens: otherLens, slug: otherSlug }",
      "{ lens: lens, slug: otherSlug }",
    ),
    "other side ungated": mutate(
      panel,
      "otherSide: lensGate ? { lens: otherLens, slug: otherSlug } : null,",
      "otherSide: { lens: otherLens, slug: otherSlug },",
    ),
    "recents left out": mutate(panel, "      recents,\n    }),", "    }),"),
    "recents emptied": mutate(
      panel,
      "      recents,\n    }),",
      "      recents: [],\n    }),",
    ),
    // Built inside the memo: `repoSlug,` also stands outside it.
    "dependency otherSlug dropped": within(panel, memo, (b) =>
      b.replace(", otherSlug,", () => ","),
    ),
    "dependency array emptied": within(
      panel,
      memo,
      (b) =>
        `${b.slice(0, b.lastIndexOf("["))}[]${b.slice(b.lastIndexOf("]") + 1)}`,
    ),
    "repoSlug: null": within(panel, memo, (b) =>
      b.replace("repoSlug,", () => "repoSlug: null,"),
    ),
    "forgeHost: null": within(panel, memo, (b) =>
      b.replace("forgeHost: host", () => "forgeHost: null"),
    ),
    // Fail closed: a value or a dependency array the check can't read.
    "memo returns no object literal": within(panel, memo, (b) =>
      b.replace("() => ({", () => "() => makeCtx({"),
    ),
    "memo without a dependency array": within(panel, memo, (b) =>
      b.replace(/,\s*\[[^\]]*\],?(?=\s*\)$)/, () => ""),
    ),
  };
  for (const [label, m] of Object.entries(mutants))
    assert.notDeepEqual(checkP12(m), [], label);
});

test("P13: the table and the roadmap activate and key through the panel's handlers", () => {
  assert.deepEqual(checkP13(panel), []);
  for (const tag of ["ProjectsTableView", "ProjectsRoadmapView"]) {
    const tagText = openingTags(panel, tag)[0];
    const start = panel.indexOf(tagText);
    for (const [from, to] of [
      ["onActivate={activateRow}", "onActivate={openOnWeb}"],
      ["onKeyDown={onTableKeyDown}", "onKeyDown={onCellCancel}"],
    ]) {
      const swapped = mutate(tagText, from, to);
      const m =
        panel.slice(0, start) + swapped + panel.slice(start + tagText.length);
      assert.notDeepEqual(checkP13(m), [], `${tag}: ${to}`);
    }
  }
});

test("P14: the Projects anchor provider hands boardAnchorAnswer its live arguments", () => {
  assert.deepEqual(checkP14(panel), []);
  const head = /const readBoardAnchor\s*=\s*useEffectEvent\(/.exec(panel);
  assert.ok(head, "no `const readBoardAnchor = useEffectEvent(` to mutate");
  const provider = balanced(panel, head.index + head[0].length - 1);
  const swap = (from, to) =>
    within(panel, provider, (b) => b.replace(from, () => to));
  const mutants = {
    "armed null": swap(
      "armed: store.boardReturn?.anchor ?? null",
      "armed: null",
    ),
    "held null": swap("held: heldAnchor", "held: null"),
    "retired null": swap("retired: retiredAnchor", "retired: null"),
    "epoch constant": swap("epoch: store.interactionEpoch", "epoch: 0"),
    "pick generation constant": swap(
      "pickGeneration: pickGenerationRef.current",
      "pickGeneration: 0",
    ),
    "retired written around": swap(
      "retired: retiredAnchor,",
      "retired: retiredAnchor && null,",
    ),
    "a trailing spread": swap(
      "showArchived,\n    });",
      "showArchived,\n      ...{ retired: null },\n    });",
    ),
    "the call only in a comment": swap(
      "return boardAnchorAnswer(",
      "return null; // boardAnchorAnswer(",
    ),
  };
  for (const [label, m] of Object.entries(mutants))
    assert.notDeepEqual(checkP14(m), [], label);
});

test("the checks fail closed on a shape they can't find", () => {
  assert.notDeepEqual(checkP1(""), []);
  assert.notDeepEqual(checkP2("", surfaces), []);
  assert.notDeepEqual(checkP3(""), []);
  assert.notDeepEqual(checkP4(""), []);
  for (const check of [
    checkP5,
    checkP6,
    checkP7,
    checkP8,
    checkP9,
    checkP10,
    checkP11,
    checkP12,
    checkP13,
    checkP14,
  ])
    assert.notDeepEqual(check(""), []);
  assert.throws(() => read("src/features/projects/__no_such_file__.tsx"));
});
