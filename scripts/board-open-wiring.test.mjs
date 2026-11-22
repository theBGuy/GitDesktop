// Pins how the Projects panel wires the card open
// (src/features/projects/use-card-open.ts): one hook call and none of the open
// helpers or navigators in the panel; the wait drawn as busy on all three
// surfaces; the opener recorded through the hook's `noteOpener`; a held Enter
// on a table or roadmap row opening once and a held key on a group header
// toggling once; a double click on a roadmap title opening once; every open
// route and the arrival announcer reaching the hook (App mounting the
// announcer once); App mounting the open repository's lens
// keeper once outside every view condition, in the return that renders every
// view able to cover an open repository; the open context the hook reads; the
// user's project and view picks (and the creates and the delete whose
// continuations pick) and the view delete, each moving the epoch first; the
// Projects anchor provider registered once for the Projects tab; the
// arguments it hands boardAnchorAnswer; and the latest view-creating request
// owning the view pick. The panel can't render under jsdom, so
// its wiring is read from source; the open hook's behaviour is pinned in
// src/test/board-card-open.test.tsx, the anchor answer's in
// src/test/board-return.test.tsx.
//
// Each check fails closed on a file it can't read or a shape it can't find,
// and each has an in-memory mutant that must turn it red. Files are read with
// CRLF folded to LF, so a Windows checkout and the CI's LF checkout give the
// same verdicts.
//
// CONTRACT. These are source-shape pins. Green means each pinned shape is
// present, the stated number of times, at the named site, in the stated textual
// order. P2's surface compares, P4b, P4c, P10, P11, P12, P14, P14b, P15 and P16 read
// code with comments stripped; the other reads are of raw text, where a shape
// left in a comment can count (P1 fails on a name in a comment by design). No
// panel code is run (P12 alone models the two outcomes of the lens ternary it
// matched), so they cannot see what a pinned expression computes once more is
// written around it (`=== openingItemId && false`), which paths reach a pinned
// statement from outside its own block (a narrowed key test around
// onTableKeyDown's guarded toggle), what runs between a note and its call other
// than a `return` (a `throw`, or the call put under a condition), what a pinned
// name is read from (the slug read behind the memo's `repoSlug`), or a new site
// of another shape (a pick or a view write outside the listed handlers). The
// typecheck catches an unread `noteOpener` parameter and a narrowed chord's
// dead compare. A count of a literal attribute also counts a longer attribute
// that ends in the pinned text (`data-onOpen={openItem}`), the same accepted
// limit as a copy left in a comment: P2's panel side, P6, P8 and P13. P11's
// `onValueChange` handlers and its `onClear` count, and P2's surface `item=`
// and `busy=` reads, are matched at an attribute boundary and do not, though a
// namespaced attribute (`x:onValueChange={…}`) still passes it. Stripped code
// still holds string literals, so a copy of a pinned shape inside a string
// counts as the shape: P11's picks (`void "switchProject(created.id)"`), its
// hotkey line and its refusal token, and P10's and P15's tag and import counts
// (P15's view tags included). P15 reads the keeper's tag at brace depth zero of
// App's last `return (…)`, counting every brace (one inside a string counts);
// it cannot see a condition inside the keeper itself
// (src/test/open-repo-lens-keeper.test.tsx covers what the keeper holds) or a
// wrapper component that mounts it. It reads the covering views by their tags,
// so it cannot see an early return that renders none of them
// (`if (view === "help") return null;`) or one through a wrapper component.
// P14b reads the registration's text, not whether the effect around it runs
// (`if (!active || true) return;` ahead of it). Its `return` rule reads the
// call's own statement, so a helper that returns the call while the effect
// drops the helper's result (`registerBoard();`) reads as returned. P11 finds a
// handler by its `name(` text, so a real picker spelled
// `switchProject.call(undefined, v)` beside a noting decoy handler elsewhere
// reads as noted. P14 reads the opener as read, spent at once and handed on by
// name at any depth of the call's arguments; it cannot see who else writes or
// spends `openerRef` (a bracket-spelled spend included), a `return` between the
// spend and the call, or what `boardAnchorAnswer` does with it (the table in
// src/test/board-return.test.tsx does). P4b reads the roadmap's `e.detail <= 1`
// in the `if` beside its title test, not what `detail` a real click carries
// (the card's and the table's guards are exercised in
// src/test/board-card-chord-space.test.tsx and
// src/test/board-table-title-click.test.tsx). P4c reads the input-method
// stop-and-return's text order in each key handler, not its depth, so one
// nested in a block ahead of the chord read (inside an `if (x) { … }`) reads as
// guarding. P16 reads the counter by name and
// its bump and compare by their spelled text, and counts every use of that name
// in each view create (its bump and its compare, nothing else), and holds each
// create to one use of the name `setPendingViewPick`, so it cannot see a write
// to the ref or a pick through another name, a compare written around
// (`|| true`), or a `return` between the bump and the write. A pick whose
// name is spelled with a Unicode escape (`setPendingView\u0050ick`) is not
// seen. An equivalent rewrite turns a pin red by design: re-point the pin.
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
 *  its card's or row's own item id to it inside a `busy={…}` prop of that element
 *  (the prop itself, never `data-busy` or `aria-busy`). */
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
      [...t.matchAll(/(?<![\w$-])busy=\{/g)].map((m) => ({
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

const IME_RETURN =
  /if\s*\(\s*isImeKeydown\(\s*e\s*\)\s*\)\s*\{\s*e\.stopPropagation\(\)\s*;\s*return\s*;\s*\}/;
const KEY_HANDLERS = ["onTableKeyDown", "onBoardKeyDown"];
const P4C_ERROR = (name) =>
  `${name} doesn't stop and return on isImeKeydown(e) before eventToBinding(`;

/** P4c: each grid key handler stops and returns on an input-method key before
 *  its first `eventToBinding(` read, so none of its chords or swallows act on
 *  one and no ancestor (a dialog's Escape dismissal) hears it. */
function checkP4c(panel) {
  const code = uncommented(panel);
  const errors = [];
  for (const name of KEY_HANDLERS) {
    const body = functionBody(code, name);
    if (body === null) {
      errors.push(`no balanced function ${name}(`);
      continue;
    }
    const chord = body.indexOf("eventToBinding(");
    const ime = body.search(IME_RETURN);
    if (chord === -1) errors.push(`${name} reads no eventToBinding(`);
    else if (ime === -1 || ime > chord) errors.push(P4C_ERROR(name));
  }
  return errors;
}

/** The condition of the `if (…)` that directly guards the first `call` in
 *  `block` (the call comes AFTER the condition, with nothing but whitespace
 *  between them), or null. A call inside the condition is not guarded by it. */
function guardOf(block, call) {
  const at = block.search(call);
  if (at === -1) return null;
  const heads = [...block.slice(0, at).matchAll(/(?<![\w$])if\s*\(/g)];
  const head = heads[heads.length - 1];
  if (head === undefined) return null;
  const cond = balanced(block, head.index + head[0].length - 1);
  if (cond === null) return null;
  const end = head.index + head[0].length - 1 + cond.length;
  if (at < end) return null;
  return block.slice(end, at).trim() === "" ? cond : null;
}

const ROADMAP_DETAIL = /\be\.detail\s*<=\s*1\b/;

/** P4b: the roadmap grid's click opens a row's item only on the first click of a
 *  gesture, so a double click on a title opens it once. Its guard sits in the
 *  same `if` as the title test, ahead of the one `onActivate(` call. */
function checkP4b(roadmap) {
  const body = functionBody(uncommented(roadmap), "handleClick");
  if (body === null) return ["the roadmap has no function handleClick("];
  const calls = count(body, "onActivate(");
  if (calls !== 1)
    return [`the roadmap's handleClick calls onActivate( ${calls} times`];
  const cond = guardOf(body, /(?<![\w$.])onActivate\(/);
  if (cond === null || !cond.includes("[data-title-open]"))
    return ["the roadmap's onActivate( is not guarded by its title-open test"];
  if (!ROADMAP_DETAIL.test(cond))
    return [
      "the roadmap's title open is not skipped on a later click of one gesture (e.detail <= 1)",
    ];
  return [];
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

const KEEPER_TAG = "<OpenRepoLensKeeper />";
const KEEPER_IMPORT =
  'import { OpenRepoLensKeeper } from "@/features/repository/OpenRepoLensKeeper";';

/** The views that can cover an open repository: their navigators keep `repoPath`
 *  (src/lib/stores/ui.ts), so each must render where the keeper does. */
const REPO_COVERING_VIEWS = [
  "RepositoryView",
  "SettingsScreen",
  "HelpScreen",
  "ExploreScreen",
  "MyWorkScreen",
];

/** P15: App mounts the open repository's lens keeper once, in code, at brace depth
 *  zero of its last `return (…)`, so no `{…}` expression (a view condition) can
 *  gate it, and renders each of REPO_COVERING_VIEWS once, inside that same
 *  return, so no early return shows one without the keeper; the session lens and
 *  the selections minted under it then live as long as each other. */
function checkP15(app) {
  const errors = [];
  const code = stripComments(app.split("\n")).join("\n");
  const imports = count(code, KEEPER_IMPORT);
  if (imports !== 1)
    errors.push(
      `the OpenRepoLensKeeper import appears ${imports} times, want 1`,
    );
  const tags = count(code, KEEPER_TAG);
  if (tags !== 1)
    return [...errors, `${KEEPER_TAG} appears ${tags} times, want 1`];
  const body = functionBody(code, "App");
  if (body === null) return [...errors, "no function App( body"];
  const returns = [...body.matchAll(/\breturn\s*\(/g)];
  const last = returns.at(-1);
  const jsx =
    last === undefined ? null : balanced(body, last.index + last[0].length - 1);
  if (jsx === null) return [...errors, "App's last return ( doesn't balance"];
  for (const view of REPO_COVERING_VIEWS) {
    const tag = new RegExp(`<${view}(?![\\w$])`, "g");
    const inApp = body.match(tag)?.length ?? 0;
    const inReturn = jsx.match(tag)?.length ?? 0;
    if (inApp !== 1 || inReturn !== 1)
      errors.push(
        `<${view} appears ${inApp} times in App and ${inReturn} in its last return, want 1 in both`,
      );
  }
  const at = jsx.indexOf(KEEPER_TAG);
  if (at === -1)
    return [...errors, `${KEEPER_TAG} is not in App's last return`];
  let depth = 0;
  for (const c of jsx.slice(0, at))
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  if (depth !== 0)
    errors.push(`${KEEPER_TAG} sits inside a {…} expression (depth ${depth})`);
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

/** Every `onValueChange={…}` handler that calls `name(`, the attribute matched at
 *  its boundary, so a longer name ending in it (`data-onValueChange`) is not one. */
function handlersCalling(text, name) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w$-])onValueChange=\{/g)) {
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
    if (
      tag === null ||
      [...tag.matchAll(/(?<![\w$-])onClear=\{clearViewByUser\}/g)].length !== 1
    )
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
 *  read live at the read. The opener, read and spent at the read, is checked on
 *  its own (`checkP14`). */
const ANCHOR_ARGS = [
  ["armed", "store.boardReturn?.anchor ?? null"],
  ["held", "heldAnchor"],
  ["retired", "retiredAnchor"],
  ["epoch", "store.interactionEpoch"],
  ["pickGeneration", "pickGenerationRef.current"],
];

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** P14: `readBoardAnchor` calls `boardAnchorAnswer(` once; each of ANCHOR_ARGS
 *  appears in the call's argument text as a complete `key: value` entry (at any
 *  depth: the text is matched, not parsed), and that text holds no `...`. The
 *  opener is read and spent at once above the call
 *  (`const opener = openerRef.current; openerRef.current = null;`), with no other
 *  `openerRef.current` in the body, and handed on as the shorthand `opener`, the
 *  name appearing only at its read and its hand-off. */
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
  if (!/[{,] ?opener ?[,}]/.test(flat))
    errors.push("boardAnchorAnswer( is not handed the shorthand opener");
  const spend =
    /const\s+opener\s*=\s*openerRef\.current\s*;\s*openerRef\.current\s*=\s*null\s*;/.exec(
      body,
    );
  if (spend === null || spend.index > calls[0].index)
    errors.push(
      "readBoardAnchor does not read the opener and spend it at once above the call",
    );
  const touches = count(body, "openerRef.current");
  if (touches !== 2)
    errors.push(
      `readBoardAnchor touches openerRef.current ${touches} times, want 2 (the opener's read and spend)`,
    );
  const named = body.match(/(?<![\w$.])opener(?![\w$])/g)?.length ?? 0;
  if (named !== 2)
    errors.push(
      `readBoardAnchor names opener ${named} times, want 2 (its read and its hand-off)`,
    );
  return errors;
}

/** P14b: the panel calls `registerNavAnchorProvider(` once (a qualified call
 *  counts), and that call registers `readBoardAnchor` for the Projects tab, so
 *  the reader P14 pins is the one Go back asks for the board's place. The call
 *  is a `return` operand, so the layout effect hands React the unregister. */
function checkP14b(panel) {
  const src = uncommented(panel);
  const calls =
    src.match(/(?<![\w$])registerNavAnchorProvider\s*\(/g)?.length ?? 0;
  if (calls !== 1)
    return [
      `the panel calls registerNavAnchorProvider( ${calls} times, want 1`,
    ];
  if (
    !/(?<![\w$])registerNavAnchorProvider\(\s*"projects"\s*,\s*readBoardAnchor\s*\)/.test(
      src,
    )
  )
    return [
      'the panel\'s registerNavAnchorProvider( call is not ("projects", readBoardAnchor)',
    ];
  if (
    !/(?<![\w$])return[ \t]+(?:[\w$]+\s*\.\s*)*registerNavAnchorProvider\(\s*"projects"\s*,\s*readBoardAnchor\s*\)/.test(
      src,
    )
  )
    return [
      "the panel's registerNavAnchorProvider( call is not returned, so its unregister is dropped",
    ];
  return [];
}

const VIEW_REQUEST_DECL = "const viewCreateRequestRef = useRef(0);";
const VIEW_REQUEST_BUMP = /const request = \+\+viewCreateRequestRef\.current;/;
const VIEW_REQUEST_COMPARE = /\brequest === viewCreateRequestRef\.current\b/;

/** The two view-creating requests: where each one's block is, and its write. */
const VIEW_CREATES = [
  {
    what: "the new view's submit",
    block: newViewBranch,
    write: /\bcreateView\.mutateAsync\(/,
  },
  {
    what: "the view duplicate",
    block: (text) => verbBody(text, "duplicateCurrentView", "duplicate-view"),
    write: /\bduplicateView\.mutateAsync\(/,
  },
];

/** Why one view-creating `block` doesn't bump the request counter as a plain
 *  statement after its last offline refusal and ahead of its write, or doesn't
 *  hold its pick to that request, or null. */
function bumpsAndHolds(block, write) {
  const at = block.search(write);
  if (at === -1) return `has no ${write.source}`;
  const bumps = block.match(new RegExp(VIEW_REQUEST_BUMP.source, "g")) ?? [];
  if (bumps.length !== 1)
    return `bumps the view-create request ${bumps.length} times, want 1`;
  const bump = block.search(VIEW_REQUEST_BUMP);
  let depth = 0;
  for (let i = 0; i < bump; i++) {
    if ("{([".includes(block[i])) depth += 1;
    else if ("})]".includes(block[i])) depth -= 1;
  }
  if (depth !== 1 || !/[{;}]$/.test(block.slice(0, bump).trimEnd()))
    return "bumps the view-create request inside a nested block or expression";
  const refusals = [...block.matchAll(new RegExp(REFUSAL.source, "g"))];
  const last = refusals[refusals.length - 1];
  if (last === undefined) return `has no ${REFUSAL.source}`;
  if (bump < last.index + last[0].length)
    return `bumps the view-create request before the refusal ${REFUSAL.source}, which it must follow`;
  if (bump > at) return `bumps the view-create request after ${write.source}`;
  // Whole identifiers only: a `$` or word character on either side is another name.
  const picks =
    block.match(/(?<![\w$])setPendingViewPick(?![\w$])/g)?.length ?? 0;
  if (picks !== 1) return `names setPendingViewPick ${picks} times, want 1`;
  const cond = guardOf(block, /(?<![\w$])setPendingViewPick\(created\)/);
  if (cond === null) return "picks setPendingViewPick(created) under no if (…)";
  for (const need of [
    /\bstillShowing\(/,
    /\bgeneration === pickGenerationRef\.current\b/,
    VIEW_REQUEST_COMPARE,
  ])
    if (!need.test(cond)) return `picks without ${need.source}`;
  const named = block.match(/\bviewCreateRequestRef\b/g)?.length ?? 0;
  if (named !== 2)
    return `names viewCreateRequestRef ${named} times, want 2 (its bump and its compare)`;
  return null;
}

/** P16: the latest view-creating request owns the view pick, even when it fails:
 *  New view and Duplicate view each bump one counter after their offline refusal
 *  (a refused request writes nothing, so it retires nothing) and before their
 *  write, and each continuation picks only while its request is still the latest,
 *  beside its board and pick-generation checks. Inside each, the counter is named
 *  only by that bump and that compare; nothing else names it. */
function checkP16(panel) {
  const src = uncommented(panel);
  const errors = [];
  let rest = src;
  for (const { what, block, write } of VIEW_CREATES) {
    const text = block(src);
    const why = text === null ? "can't be found" : bumpsAndHolds(text, write);
    if (why !== null) errors.push(`${what} ${why}`);
    if (text !== null) rest = rest.replace(text, "");
  }
  const decls = count(rest, VIEW_REQUEST_DECL);
  const named = rest.match(/\bviewCreateRequestRef\b/g)?.length ?? 0;
  if (decls !== 1 || named !== 1)
    errors.push(
      `outside the two view creates, viewCreateRequestRef is named ${named} times and declared ${decls} times, want its one declaration`,
    );
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
    // The compare re-added inside the item's own tag under a name that only ends
    // in busy; the bare name at the same spot is the control that it would count.
    const element = BUSY_ELEMENT[tag];
    const itemTag = openingTags(unbusy, element).find(
      (t) => t !== null && ownItem(t) !== null,
    );
    assert.ok(itemTag, `${tag}: no <${element} with an item={…} to mutate`);
    for (const name of ["data-busy", "aria-busy", "busy"]) {
      const attr = `${name}={${compare[1]} === openingItemId}`;
      const renamed = {
        ...surfaces,
        [tag]: mutate(
          unbusy,
          itemTag,
          itemTag.replace(`<${element}`, () => `<${element} ${attr}`),
        ),
      };
      assert.ok(
        openingTags(renamed[tag], element).some(
          (t) => t !== null && ownItem(t) !== null && t.includes(attr),
        ),
        `${tag}: ${attr} landed outside the <${element} that takes the item`,
      );
      if (name === "busy")
        assert.deepEqual(checkP2(panel, renamed), [], `${tag}: ${attr}`);
      else
        assert.notDeepEqual(
          checkP2(panel, renamed),
          [],
          `${tag} compare under ${name}`,
        );
    }
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

test("P4c: the grid key handlers leave an input-method key alone", () => {
  assert.deepEqual(checkP4c(panel), []);
  for (const name of KEY_HANDLERS) {
    const body = functionBody(panel, name);
    assert.notEqual(body, null, name);
    const mutants = {
      "the return dropped": body.replace(IME_RETURN, ""),
      "the return moved after the chord read": body
        .replace(IME_RETURN, "")
        .replace(
          /const chord = eventToBinding\(e\);/,
          (m) =>
            `${m}\n    if (isImeKeydown(e)) {\n      e.stopPropagation();\n      return;\n    }`,
        ),
      "the return kept without the stop": body.replace(
        IME_RETURN,
        "if (isImeKeydown(e)) return;",
      ),
      "the return left only in a comment": body.replace(IME_RETURN, (m) =>
        m.replace(/^/gm, "// "),
      ),
    };
    for (const [label, b] of Object.entries(mutants)) {
      assert.notEqual(b, body, `${name}: ${label}: no change`);
      assert.deepEqual(
        checkP4c(panel.replace(body, () => b)),
        [P4C_ERROR(name)],
        `${name}: ${label}`,
      );
    }
  }
  assert.deepEqual(checkP4c(panel.replace(/\n/g, "\r\n")), []);
});

test("P4b: the roadmap's title click opens once per multi-click gesture", () => {
  const roadmap = surfaces.ProjectsRoadmapView;
  assert.deepEqual(checkP4b(roadmap), []);
  const guard = /\s*&&\s*e\.detail\s*<=\s*1\b/;
  const body = functionBody(roadmap, "handleClick");
  const why =
    "the roadmap's title open is not skipped on a later click of one gesture (e.detail <= 1)";
  const mutants = {
    "the guard dropped": within(roadmap, body, (b) => b.replace(guard, "")),
    "the guard widened to a double click": within(roadmap, body, (b) =>
      b.replace(/e\.detail\s*<=\s*1/, "e.detail <= 2"),
    ),
    "the guard left only in a comment": within(roadmap, body, (b) =>
      b.replace(guard, " // && e.detail <= 1\n"),
    ),
  };
  for (const [label, m] of Object.entries(mutants))
    assert.deepEqual(checkP4b(m), [why], label);
  assert.deepEqual(checkP4b(roadmap.replace(/\n/g, "\r\n")), []);
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

test("P15: App mounts one OpenRepoLensKeeper outside every view condition", () => {
  assert.deepEqual(checkP15(app), []);
  const mutants = {
    "tag removed": mutate(app, KEEPER_TAG, ""),
    "tag doubled": mutate(app, KEEPER_TAG, `${KEEPER_TAG}${KEEPER_TAG}`),
    "import removed": mutate(app, KEEPER_IMPORT, ""),
    "tag behind a view condition": mutate(
      app,
      KEEPER_TAG,
      `{view === "repo" && ${KEEPER_TAG}}`,
    ),
    "tag and import only in comments": mutate(
      mutate(app, KEEPER_TAG, `{/* ${KEEPER_TAG} */}`),
      KEEPER_IMPORT,
      `// ${KEEPER_IMPORT}`,
    ),
    "Settings in an early return": earlyReturn("settings", "SettingsScreen"),
    "Help in an early return": earlyReturn("help", "HelpScreen"),
    "a covering view doubled": mutate(
      app,
      "<ExploreScreen />",
      "<ExploreScreen /><ExploreScreen />",
    ),
  };
  for (const [label, m] of Object.entries(mutants)) {
    assert.notEqual(m, app, `${label}: no change`);
    assert.notDeepEqual(checkP15(m), [], label);
    // The rule folds no line ending of its own: a CRLF copy gets the same verdict.
    assert.deepEqual(checkP15(m.replace(/\n/g, "\r\n")), checkP15(m), label);
  }
  assert.deepEqual(checkP15(app.replace(/\n/g, "\r\n")), []);
  // Only the depth rule sees the condition: the counts still hold.
  assert.deepEqual(checkP15(mutants["tag behind a view condition"]), [
    `${KEEPER_TAG} sits inside a {…} expression (depth 1)`,
  ]);
  for (const [label, view] of [
    ["Settings in an early return", "SettingsScreen"],
    ["Help in an early return", "HelpScreen"],
  ])
    assert.deepEqual(
      checkP15(mutants[label]),
      [
        `<${view} appears 1 times in App and 0 in its last return, want 1 in both`,
      ],
      label,
    );
});

/** App with `view`'s screen moved out of the last return into an early return
 *  ahead of it. */
function earlyReturn(view, screen) {
  const branch = `        {view === "${view}" && <${screen} />}\n`;
  const last = "\n  return (\n    <>\n";
  const moved = mutate(
    mutate(app, branch, ""),
    last,
    `\n  if (view === "${view}") return <${screen} />;\n${last}`,
  );
  assert.ok(!moved.includes(branch) && moved.includes(`return <${screen} />;`));
  return moved;
}

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
    // The real handler picks without noting; the noting arrow lives on under a
    // longer attribute name that ends in the pinned one.
    "project picker's noting handler renamed": mutate(
      panel,
      'onValueChange={(v) => {\n              if (typeof v !== "string") return;\n',
      'onValueChange={(v) => {\n              if (typeof v !== "string") return;\n              switchProject.call(undefined, v);\n            }}\n            data-onValueChange={(v: unknown) => {\n              if (typeof v !== "string") return;\n',
    ),
    "view rows' noting handler renamed": mutate(
      panel,
      "value={view?.id ?? NO_VIEW_ROW_ID}\n                            onValueChange={(next) => {\n",
      'value={view?.id ?? NO_VIEW_ROW_ID}\n                            onValueChange={(next) => {\n                              if (typeof next !== "string") return;\n                              pickView.call(undefined, next === NO_VIEW_ROW_ID ? null : next);\n                            }}\n                            data-onValueChange={(next: unknown) => {\n',
    ),
    "first button passes clearViewByUser only under a longer name": mutate(
      panel,
      "onClear={clearViewByUser}",
      "onClear={clearView} data-onClear={clearViewByUser}",
    ),
    "second button passes clearViewByUser only under a longer name": (() => {
      const at = panel.lastIndexOf("onClear={clearViewByUser}");
      return `${panel.slice(0, at)}onClear={clearView} data-onClear={clearViewByUser}${panel.slice(at + "onClear={clearViewByUser}".length)}`;
    })(),
  };
  for (const [label, m] of Object.entries(mutants)) {
    assert.notEqual(m, panel, `${label}: no change`);
    assert.notDeepEqual(checkP11(m), [], label);
  }
  // Only the attribute boundary sees these.
  for (const [label, why] of [
    [
      "project picker's noting handler renamed",
      "the project picker can't be found",
    ],
    [
      "view rows' noting handler renamed",
      "the view rows' handler can't be found",
    ],
    [
      "first button passes clearViewByUser only under a longer name",
      "a <ClearViewButton does not pass onClear={clearViewByUser}",
    ],
    [
      "second button passes clearViewByUser only under a longer name",
      "a <ClearViewButton does not pass onClear={clearViewByUser}",
    ],
  ])
    assert.deepEqual(checkP11(mutants[label]), [why], label);
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
    "the opener read after its spend": swap(
      "const opener = openerRef.current;\n    openerRef.current = null;",
      "openerRef.current = null;\n    const opener = openerRef.current;",
    ),
    "the opener handed on as null": swap(
      "opener,\n      armed:",
      "opener: null,\n      armed:",
    ),
    "the opener's spend dropped": swap(
      "    openerRef.current = null;\n    const store",
      "    const store",
    ),
    "the opener's spend under a condition": swap(
      "    openerRef.current = null;\n    const store",
      "    if (active) openerRef.current = null;\n    const store",
    ),
    "a later opener: null key": swap(
      "showArchived,\n    });",
      "showArchived,\n      opener: null,\n    });",
    ),
    "the opener re-armed after its spend": swap(
      "    return boardAnchorAnswer({",
      "    openerRef.current = cursorItemId;\n    return boardAnchorAnswer({",
    ),
  };
  for (const [label, m] of Object.entries(mutants))
    assert.notDeepEqual(checkP14(m), [], label);
  for (const label of [
    "the opener read after its spend",
    "the opener handed on as null",
    "the opener's spend dropped",
    "the opener's spend under a condition",
    "a later opener: null key",
  ])
    assert.ok(
      checkP14(mutants[label]).some((e) => e.includes("opener")),
      `${label}: the failure doesn't name the opener`,
    );
  // A re-arm leaves the read, the spend and the hand-off in place: only the
  // count of openerRef.current sees it.
  assert.deepEqual(
    checkP14(mutants["the opener re-armed after its spend"]),
    [
      "readBoardAnchor touches openerRef.current 3 times, want 2 (the opener's read and spend)",
    ],
    "the opener re-armed after its spend",
  );
});

test("P14b: the panel registers readBoardAnchor once, for the Projects tab", () => {
  assert.deepEqual(checkP14b(panel), []);
  const REGISTRATION = 'registerNavAnchorProvider("projects", readBoardAnchor)';
  const line = `    return ${REGISTRATION};\n`;
  const mutants = {
    "another tab": mutate(
      panel,
      REGISTRATION,
      'registerNavAnchorProvider("issues", readBoardAnchor)',
    ),
    "the registration removed": mutate(panel, line, ""),
    "another reader": mutate(
      panel,
      REGISTRATION,
      'registerNavAnchorProvider("projects", readHeldAnchor)',
    ),
    "a second registration": mutate(
      panel,
      line,
      `    ${REGISTRATION};\n${line}`,
    ),
    "the return dropped": mutate(panel, line, `    ${REGISTRATION};\n`),
    "a line break after the return": mutate(
      panel,
      line,
      `    return\n      ${REGISTRATION};\n`,
    ),
  };
  for (const [label, m] of Object.entries(mutants)) {
    assert.notEqual(m, panel, `${label}: no change`);
    assert.notDeepEqual(checkP14b(m), [], label);
    assert.deepEqual(checkP14b(m.replace(/\n/g, "\r\n")), checkP14b(m), label);
  }
  for (const label of ["the return dropped", "a line break after the return"])
    assert.deepEqual(checkP14b(mutants[label]), [
      "the panel's registerNavAnchorProvider( call is not returned, so its unregister is dropped",
    ]);
  assert.deepEqual(checkP14b(panel.replace(/\n/g, "\r\n")), []);
});

test("P16: the latest view-creating request owns the view pick", () => {
  assert.deepEqual(checkP16(panel), []);
  const BUMP_LINE =
    /const request = \+\+viewCreateRequestRef\.current;[^\S\n]*\n[^\S\n]*/;
  const BUMP = "const request = ++viewCreateRequestRef.current;";
  const REFUSE = "if (refuseWhileOffline()) return;";
  const TRY_END = /\} catch \{\s*return;\s*\}/;
  const drop = (b) => b.replace(BUMP_LINE, "");
  const NAMED_THRICE =
    "names viewCreateRequestRef 3 times, want 2 (its bump and its compare)";
  const edits = {
    "bump removed": [drop, "bumps the view-create request 0 times, want 1"],
    "compare removed": [
      (b) => b.replace(/\s*&&\s*request === viewCreateRequestRef\.current/, ""),
      "picks without \\brequest === viewCreateRequestRef\\.current\\b",
    ],
    "bump above the offline refusal": [
      (b) => drop(b).replace(REFUSE, () => `${BUMP}\n${REFUSE}`),
      "bumps the view-create request before the refusal \\brefuseWhileOffline\\(\\), which it must follow",
    ],
    "bump below the write": [
      (b) => drop(b).replace(TRY_END, (end) => `${end}\n${BUMP}`),
      null,
    ],
    "the counter reset before the bump": [
      (b) =>
        b.replace(BUMP, () => `viewCreateRequestRef.current = 0;\n${BUMP}`),
      NAMED_THRICE,
    ],
    "the counter written after the await": [
      (b) =>
        b.replace(
          TRY_END,
          (end) => `${end}\nviewCreateRequestRef.current = request;`,
        ),
      NAMED_THRICE,
    ],
    "a second, unguarded pick": [
      (b) =>
        b.replace(
          "setPendingViewPick(created);",
          () => "setPendingViewPick(created);\nsetPendingViewPick(created);",
        ),
      "names setPendingViewPick 2 times, want 1",
    ],
    "a second pick through an optional call": [
      (b) =>
        b.replace(
          "setPendingViewPick(created);",
          () => "setPendingViewPick(created);\nsetPendingViewPick?.(created);",
        ),
      "names setPendingViewPick 2 times, want 1",
    ],
    "a second pick spaced from its parenthesis": [
      (b) =>
        b.replace(
          "setPendingViewPick(created);",
          () => "setPendingViewPick(created);\nsetPendingViewPick (created);",
        ),
      "names setPendingViewPick 2 times, want 1",
    ],
    "a guarded decoy name ahead of an unguarded pick": [
      (b) =>
        b.replace(
          "setPendingViewPick(created);",
          () => "$setPendingViewPick(created);\nsetPendingViewPick(created);",
        ),
      "picks setPendingViewPick(created) under no if (…)",
    ],
    "a decoy name inside the guard, ahead of an unguarded pick": [
      (b) =>
        b.replace(
          /\s*\)\s*setPendingViewPick\(created\);/,
          () =>
            " &&\n$setPendingViewPick(created)\n) {}\nsetPendingViewPick(created);",
        ),
      "picks setPendingViewPick(created) under no if (…)",
    ],
    "the pick moved into its own guard's condition": [
      (b) => {
        const pick = b.indexOf("setPendingViewPick(created);");
        const at = b.lastIndexOf("stillShowing(", pick);
        const moved = `${b.slice(0, at)}(setPendingViewPick(created), ${b.slice(at)}`;
        return moved.replace(
          /\)\s*setPendingViewPick\(created\);/,
          () => ")) {}",
        );
      },
      "picks setPendingViewPick(created) under no if (…)",
    ],
  };
  for (const { what, block, write } of VIEW_CREATES)
    for (const [label, [edit, message]] of Object.entries(edits)) {
      const m = within(panel, block(panel), edit);
      const why =
        message ?? `bumps the view-create request after ${write.source}`;
      assert.deepEqual(checkP16(m), [`${what} ${why}`], `${what}: ${label}`);
    }
  // A longer name that starts with the pick's is another identifier.
  for (const { what, block } of VIEW_CREATES) {
    const m = within(panel, block(panel), (b) =>
      b.replace(
        "setPendingViewPick(created);",
        () =>
          "setPendingViewPick(created);\nconst marks = { setPendingViewPick$done: true };",
      ),
    );
    assert.deepEqual(checkP16(m), [], what);
  }
  // A third handler naming the counter (a rename bumping it) is seen outside
  // the two view creates.
  const renamed = within(panel, functionBody(panel, "submitViewName"), (b) =>
    b.replace(
      'if (run?.kind !== "rename-view") return;',
      () => `if (run?.kind !== "rename-view") return;\n${BUMP}`,
    ),
  );
  assert.deepEqual(checkP16(renamed), [
    "outside the two view creates, viewCreateRequestRef is named 2 times and declared 1 times, want its one declaration",
  ]);
  assert.deepEqual(checkP16(panel.replace(/\n/g, "\r\n")), []);
});

test("the checks fail closed on a shape they can't find", () => {
  assert.notDeepEqual(checkP1(""), []);
  assert.notDeepEqual(checkP2("", surfaces), []);
  assert.notDeepEqual(checkP3(""), []);
  assert.notDeepEqual(checkP4(""), []);
  assert.notDeepEqual(checkP4b(""), []);
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
    checkP14b,
    checkP15,
    checkP16,
  ])
    assert.notDeepEqual(check(""), []);
  assert.throws(() => read("src/features/projects/__no_such_file__.tsx"));
});
