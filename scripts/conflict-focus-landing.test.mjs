// Pins how the conflict views hand keyboard focus back after a write settles
// (src/features/repository/ConflictFileView.tsx, ConflictResolveView.tsx): the
// region headers a landing finds by conflict ordinal, the landing helper's
// focus-then-scroll rule, the landing effect's hold gate and never-steal
// precondition, the handlers that arm it, and `landingOrdinal`'s table.
//
// Not testable here: whether focus actually lands where the pins say, mount
// order, and the browser's blur of a button disabled under focus. Those need
// the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so
// conflict-banner-state.ts must stay free of runtime imports. Every lookup
// that finds nothing fails, so a moved or unreadable source can't pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { landingOrdinal } from "../src/features/repository/conflict-banner-state.ts";
import { maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIEW = "src/features/repository/ConflictFileView.tsx";
const RESOLVE = "src/features/repository/ConflictResolveView.tsx";
const read = (file) => readFileSync(join(REPO_ROOT, file), "utf8");
const load = (source) => ({ source, masked: maskNonCode(source, true) });

/** The `{ … }` body offsets of the function declaration `name`. */
function functionBody(src, name) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src.masked);
  assert.ok(m, `no \`function ${name}(\` found`);
  const parenClose = matchBrace(src.masked, m.index + m[0].length - 1);
  assert.notEqual(parenClose, -1, `${name}: unbalanced parameter list`);
  const open = src.masked.indexOf("{", parenClose);
  const close = open === -1 ? -1 : matchBrace(src.masked, open);
  assert.ok(close > open, `${name}: no balanced body`);
  return { open, close };
}

/** The source text of the JSX opening tag around `index`, from the nearest
 *  preceding `<name` to its `>`. */
function enclosingTag(src, index, name) {
  const start = src.masked.lastIndexOf(`<${name}`, index);
  assert.notEqual(start, -1, `no <${name} before offset ${index}`);
  const end = tagEnd(src.masked, start);
  assert.ok(end > index, `offset ${index} is not inside a <${name}> tag`);
  return src.masked.slice(start, end + 1);
}

function pinHeader(viewSource, resolveSource) {
  const view = load(viewSource);
  const hits = [...view.masked.matchAll(/\bdata-conflict-ordinal\b/g)];
  assert.equal(
    hits.length,
    1,
    `exactly one element carries data-conflict-ordinal, found ${hits.length}`,
  );
  const tag = enclosingTag(view, hits[0].index, "div");
  assert.match(tag, /\sdata-conflict-ordinal=\{index\}/);
  assert.match(
    tag,
    /\stabIndex=\{-1\}/,
    "the region header must be focusable by script (tabIndex={-1})",
  );
  assert.doesNotMatch(
    load(resolveSource).masked,
    /\bdata-conflict-ordinal\b/,
    "only the conflict editor's region header carries the ordinal",
  );
}

function pinHelper(viewSource, resolveSource) {
  for (const [file, source] of [
    [VIEW, viewSource],
    [RESOLVE, resolveSource],
  ]) {
    assert.doesNotMatch(
      load(source).masked,
      /\bscrollIntoView\b/,
      `${file}: the app root clips overflow, so landings scroll the body via scrollBy`,
    );
  }
  const view = load(viewSource);
  const { open, close } = functionBody(view, "landConflictRegion");
  const body = view.source.slice(open, close);
  assert.match(
    body,
    /\bheader\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    "landConflictRegion must focus the header with preventScroll",
  );
  assert.match(body, /\bscroller\.scrollBy\(/, "the scroller must move itself");
  assert.match(body, /behavior:\s*"instant"/, "the reveal must be instant");
  assert.doesNotMatch(body, /"smooth"/, "the reveal must never animate");
}

/** The landing effect: one `useLayoutEffect` gated on `landRequest` and the
 *  view's hold, consuming the request before any move, and never moving focus
 *  the user put somewhere else. */
function pinEffect(source, busy) {
  const src = load(source);
  const bodies = [
    ...src.masked.matchAll(/\buseLayoutEffect\s*\(\s*\(\)\s*=>\s*\{/g),
  ]
    .map((m) => {
      const open = m.index + m[0].length - 1;
      const close = matchBrace(src.masked, open);
      return { open, close, body: src.masked.slice(open + 1, close) };
    })
    .filter(({ body }) => /\blandRequest\s*===\s*null\b/.test(body));
  assert.equal(
    bodies.length,
    1,
    `expected one landing effect gated on landRequest, found ${bodies.length}`,
  );
  const [{ close, body }] = bodies;
  assert.match(
    body,
    new RegExp(
      `^\\s*if\\s*\\(\\s*landRequest\\s*===\\s*null\\s*\\|\\|\\s*${busy}\\s*\\)\\s*return\\s*;\\s*setLandRequest\\(\\s*null\\s*\\)\\s*;`,
    ),
    `the landing must wait out \`${busy}\` and consume the request first`,
  );
  assert.match(
    body,
    /setLandRequest\(\s*null\s*\)\s*;\s*const\s+pending\s*=\s*landPendingRef\.current\s*;\s*landPendingRef\.current\s*=\s*false\s*;\s*if\s*\(\s*!pending\s*\)\s*return\s*;/,
    "a landing the user took over (press marker cleared) must yield",
  );
  assert.match(
    body,
    /landRequest\.repoPath\s*!==\s*repoPath\s*\|\|\s*landRequest\.path\s*!==\s*path\s*\)\s*return\s*;/,
    "the landing must skip a request armed for another repo or file",
  );
  const guard =
    /\bconst\s+active\s*=\s*document\.activeElement\s*;\s*if\s*\(\s*active\s*!==\s*null\s*&&\s*active\s*!==\s*document\.body\s*&&\s*active\s*!==\s*landRequest\.pressed\s*\)\s*return\s*;/.exec(
      body,
    );
  assert.ok(
    guard,
    "the landing must return unless focus sits on null, <body> or the pressed control",
  );
  assert.ok(
    body.indexOf(".focus(") > guard.index,
    "no focus move may run before the never-steal guard",
  );
  const deps = /^\s*,\s*\[([^\]]*)\]/.exec(src.masked.slice(close + 1));
  assert.ok(deps, "the landing effect needs a deps array");
  for (const dep of ["landRequest", busy]) {
    assert.ok(
      deps[1].split(",").some((d) => d.trim() === dep),
      `the landing effect must re-run on \`${dep}\``,
    );
  }
  return body;
}

const VIEW_ARMS = { acceptRegion: 2, acceptAll: 3, markResolved: 3 };

/** The root's input-takeover latch: a click, wheel, touch or pane scroll key
 *  inside the view clears the press marker, and the press sets it. */
function pinTakeover(source, setSite) {
  const src = load(source);
  const root = src.masked.search(/<div\s+ref=\{rootRef\}/);
  assert.notEqual(root, -1, "the view's root must carry ref={rootRef}");
  const tag = enclosingTag(src, root + 1, "div");
  for (const prop of [
    "onPointerDownCapture",
    "onWheelCapture",
    "onTouchMoveCapture",
  ]) {
    assert.match(
      tag,
      new RegExp(`\\s${prop}=\\{takeOverLanding\\}`),
      `the root's ${prop} must cancel a pending landing`,
    );
  }
  assert.match(
    tag,
    /\sonKeyDownCapture=\{\(e\)\s*=>\s*\{\s*if\s*\(\s*PANE_SCROLL_KEYS\.has\(e\.key\)\s*\)\s*takeOverLanding\(\)\s*;\s*\}\}/,
    "a pane scroll key must cancel a pending landing",
  );
  assert.match(
    src.masked,
    /\bconst\s+takeOverLanding\s*=\s*\(\)\s*=>\s*\{\s*landPendingRef\.current\s*=\s*false\s*;\s*\}\s*;/,
    "takeOverLanding must clear the press marker",
  );
  const { open, close } = functionBody(src, setSite);
  assert.match(
    src.masked.slice(open, close),
    /\blandPendingRef\.current\s*=\s*true\s*;/,
    `${setSite} must set the press marker`,
  );
}

/** The unmount hand-off: a layout effect whose cleanup moves focus left inside
 *  the view (and, with `stranded`, focus a pending write left on <body>) to
 *  the host's sink. */
function pinUnmountHandOff(source, stranded) {
  const src = load(source);
  const cleanups = [
    ...src.masked.matchAll(
      /\buseLayoutEffect\s*\(\s*\(\)\s*=>\s*\{\s*const\s+root\s*=\s*rootRef\.current\s*;\s*return\s*\(\)\s*=>\s*\{/g,
    ),
  ];
  assert.equal(
    cleanups.length,
    1,
    `expected one unmount hand-off effect, found ${cleanups.length}`,
  );
  const open = cleanups[0].index + cleanups[0][0].length - 1;
  const body = src.masked.slice(open, matchBrace(src.masked, open));
  assert.match(
    body,
    /\broot\?\.contains\(/,
    "the hand-off must catch focus left inside the view",
  );
  assert.match(
    body,
    /\bfocusSink\?\.current\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    "the hand-off must land on the host's sink",
  );
  if (stranded) {
    assert.match(
      body,
      /\blandPendingRef\.current\s*&&\s*\(\s*active\s*===\s*null\s*\|\|\s*active\s*===\s*document\.body\s*\)/,
      "a write still pending when the pane drops must hand off focus its hold left on <body>",
    );
  }
}

/** The host wiring: every conflict view a host renders takes its sink. */
function pinHost(source, sink, file) {
  const src = load(source);
  for (const view of ["ConflictFileView", "ConflictResolveView"]) {
    const tags = [...src.masked.matchAll(new RegExp(`<${view}\\b`, "g"))];
    assert.ok(tags.length > 0, `${file}: no <${view}> found`);
    for (const m of tags) {
      assert.match(
        src.masked.slice(m.index, tagEnd(src.masked, m.index) + 1),
        new RegExp(`\\sfocusSink=\\{${sink.replace(".", "\\.")}\\}`),
        `${file}: <${view}> must take focusSink={${sink}}`,
      );
    }
  }
}

function pinPrHost(source, file) {
  pinHost(source, "paneSinkRef", file);
  const masked = load(source).masked;
  assert.match(
    masked,
    /<span\s+ref=\{paneSinkRef\}\s+tabIndex=\{-1\}\s+className=/,
    `${file}: the pane sink must be a tabIndex={-1} span outside the pane`,
  );
  assert.match(
    masked,
    /\buseFocusOnControlsSwap\(\s*done\s*,\s*paneSinkRef\s*\)/,
    `${file}: the all-resolved swap must rescue <body> focus to the pane sink`,
  );
}

function pinViewArms(viewSource) {
  const view = load(viewSource);
  for (const [name, expected] of Object.entries(VIEW_ARMS)) {
    const { open, close } = functionBody(view, name);
    const body = view.masked.slice(open, close);
    const arms = [...body.matchAll(/(?<![\w$.])armLanding\s*\(/g)].length;
    assert.equal(
      arms,
      expected,
      `${name}: expected ${expected} armLanding(…) settle arms, found ${arms}`,
    );
    assert.match(
      body,
      /^\{[\s\S]*?\bconst\s+pressed\s*=\s*capturePress\s*\(\s*\)\s*;/,
      `${name}: the pressed control must be captured in the handler`,
    );
    const capture = body.search(/\bcapturePress\s*\(/);
    const firstAwait = body.search(/(?<![\w$])await(?![\w$])/);
    assert.ok(
      firstAwait === -1 || capture < firstAwait,
      `${name}: the pressed control must be captured before any await`,
    );
    assert.doesNotMatch(
      body,
      /\blandingOrdinal\s*\(/,
      `${name}: the landing ordinal reads the post-write count, inside the effect`,
    );
  }
  const effect = pinEffect(viewSource, "busy");
  assert.match(
    effect,
    /\blandingOrdinal\s*\(\s*landRequest\.ordinal\b[^,]*,\s*regionCount\s*\)/,
    "the region landing takes landingOrdinal over the rendered region count",
  );
  assert.match(effect, /\blandConflictRegion\s*\(/);
  assert.doesNotMatch(
    effect,
    /\bfocusSink\b/,
    "a landing while the pane stays mounted uses the view's own sink",
  );
  pinTakeover(viewSource, "capturePress");
  pinUnmountHandOff(viewSource, true);
}

/** accept()'s exits that owe a focus request, each with the one it owes. A
 *  refused accept keeps the view up and lands on the pressed control; the
 *  not-conflicted refusal leaves, so it hands off before its await. */
const ACCEPT_FOCUS_ARMS = [
  ["the re-read failure", /\bcatch\s*\{/, "land"],
  [
    "the not-conflicted arm",
    /\bif\s*\(\s*noLongerConflicted\(\s*fresh\s*\)\s*\)\s*\{/,
    "handOff",
  ],
  ["the undecodable arm", /\bif\s*\(\s*fresh\.undecodable\s*\)\s*\{/, "land"],
  [
    "the changed-on-disk arm",
    /\bif\s*\(\s*outcome\.kind\s*===[^)]*\)\s*\{/,
    "land",
  ],
  ["the write failure", /\bcatch\s*\(\s*e\s*\)\s*\{/, "land"],
];
/** Returns that owe none: the re-entry guard runs before anything is captured,
 *  `!sides` can't happen in phase "ready", a moved generation belongs to the
 *  restart that moved it, and refuseIfMoved's arms are unmounts and hides. */
const ACCEPT_SILENT_RETURNS = [
  /\bif\s*\(\s*acceptingRef\.current\s*\)\s*return\s*;/,
  /\bif\s*\(\s*!sides\s*\)\s*return\s*;/,
  /\bif\s*\(\s*gen\s*!==\s*genRef\.current\s*\)\s*return\s*;/,
  /\bif\s*\(\s*refuseIfMoved\([^;]*\)\s*\)\s*return\s*;/,
];
const focusCall = (name) =>
  new RegExp(String.raw`(?<![\w$.])${name}\s*\(\s*\)\s*;`, "g");

/** Ties each of accept()'s focus requests to its arm. The set is bounded by
 *  the returns: every `return` in accept() sits in a focus arm or is a
 *  listed silent one, so a new exit fails until it is classified here. The
 *  settle's leaves/land split is pinned beside this. */
function pinAcceptArmFocus(body) {
  const spans = [];
  for (const [name, opener, call] of ACCEPT_FOCUS_ARMS) {
    const hits = [...body.matchAll(new RegExp(opener.source, "g"))];
    assert.equal(
      hits.length,
      1,
      `accept: ${name} must appear once, found ${hits.length}`,
    );
    const open = hits[0].index + hits[0][0].length - 1;
    const close = matchBrace(body, open);
    const block = body.slice(open, close);
    spans.push([open, close]);
    const other = call === "land" ? "handOff" : "land";
    const calls = [...block.matchAll(focusCall(call))];
    assert.ok(
      calls.length === 1 && block.search(focusCall(other)) === -1,
      `accept: ${name} must call ${call}() and only that`,
    );
    const ret = block.search(/\breturn\s*;/);
    assert.ok(
      ret === -1 || calls[0].index < ret,
      `accept: ${name} must call ${call}() before its return`,
    );
    const wait = block.search(/(?<![\w$])await(?![\w$])/);
    assert.ok(
      call !== "handOff" || wait === -1 || calls[0].index < wait,
      `accept: ${name} must call handOff() before its await`,
    );
  }
  for (const re of ACCEPT_SILENT_RETURNS) {
    const m = re.exec(body);
    assert.ok(m, `accept: the silent return ${re} moved`);
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of body.matchAll(/\breturn\b/g)) {
    assert.ok(
      spans.some(([a, b]) => m.index > a && m.index < b),
      `accept: a return outside every classified arm, at offset ${m.index}`,
    );
  }
}

function pinResolveArms(resolveSource) {
  const src = load(resolveSource);
  const { open, close } = functionBody(src, "accept");
  const body = src.masked.slice(open, close);
  pinAcceptArmFocus(body);
  // A settled accept hands focus off only when the view leaves; an unclean
  // accept the walk keeps on screen lands back on the pressed control.
  assert.match(
    body,
    /\bconst\s+leaves\s*=\s*advances\s*\|\|\s*clean\s*\|\|\s*walk\.scopePath\s*!==\s*repoPath\s*\|\|\s*walk\.activePath\s*!==\s*path\s*;\s*if\s*\(\s*leaves\s*\)\s*handOff\(\);\s*else\s+land\(\);/,
    "accept must hand off only when the view leaves, else land on the pressed control",
  );
  const effect = pinEffect(resolveSource, "acceptBusy");
  assert.doesNotMatch(
    effect,
    /\bfocusSink\b/,
    "a landing while the view stays mounted uses the view's own sink",
  );
  // A settled accept unmounts the view: hand focus to the host's sink first.
  // Bound to the settle's own split, since the not-conflicted refusal arm
  // hands off earlier in the body.
  const handOff = body.search(
    /\bif\s*\(\s*leaves\s*\)\s*handOff\s*\(\s*\)\s*;\s*else\s+land\s*\(\s*\)\s*;/,
  );
  const advance = body.search(
    /\bif\s*\(\s*advances\s*\)\s*walk\.advance\s*\(\s*\)\s*;/,
  );
  assert.ok(
    handOff !== -1 && advance !== -1 && handOff < advance,
    "accept must hand focus off before walk.advance() unmounts the view",
  );
  assert.match(
    body,
    /\bconst\s+handOff\s*=\s*\(\)\s*=>\s*\{[\s\S]*?now\s*===\s*null\s*\|\|\s*now\s*===\s*document\.body\s*\|\|\s*now\s*===\s*pressed\s*\)[\s\S]*?\(\s*focusSink\?\.current\s*\?\?\s*resolveSinkRef\.current\s*\)\?\.focus\(/,
    "handOff must move only body/null/pressed focus, to the host's sink first",
  );
  pinTakeover(resolveSource, "accept");
  pinUnmountHandOff(resolveSource, false);
  assert.match(
    src.masked,
    /\bconst\s+acceptBusy\s*=\s*resolve\.isPending\s*\|\|\s*accepting\s*;/,
    "the Resolve view's hold is resolve.isPending || accepting",
  );
  const click = src.masked.search(/onClick=\{\(\)\s*=>\s*void\s+accept\(\)\}/);
  assert.notEqual(click, -1, "no Accept button found");
  assert.match(
    enclosingTag(src, click, "Button"),
    /\sonKeyDown=\{ignoreHeldEnter\}/,
    "the Accept button regains focus after a refusal, so a held Enter must not re-fire it",
  );
}

test("the region header is focusable and carries its conflict ordinal", () => {
  pinHeader(read(VIEW), read(RESOLVE));
});

test("the landing helper focuses without scrolling and moves the body itself", () => {
  pinHelper(read(VIEW), read(RESOLVE));
});

test("every conflict editor write handler arms a landing the effect gates", () => {
  pinViewArms(read(VIEW));
});

test("the Resolve view's refused Accept lands back on the button", () => {
  pinResolveArms(read(RESOLVE));
});

const DIFF_VIEWER = "src/features/diff/DiffViewer.tsx";
const PR_HOSTS = [
  "src/features/pulls/ResolveConflictsView.tsx",
  "src/features/pulls/ResolveRemotePrView.tsx",
];

test("every conflict pane host hands its views a sink that outlives them", () => {
  pinHost(read(DIFF_VIEWER), "slots.sinkRef", DIFF_VIEWER);
  for (const file of PR_HOSTS) pinPrHost(read(file), file);
});

test("landingOrdinal lands on the region that took the place, or the last", () => {
  assert.equal(landingOrdinal(1, 3), 1);
  assert.equal(landingOrdinal(2, 2), 1);
  assert.equal(landingOrdinal(5, 1), 0);
  assert.equal(landingOrdinal(0, 0), null);
  assert.equal(landingOrdinal(0, 1), 0);
});

/** Returns `source` with `from` (a string or RegExp) replaced, asserting the
 *  fixture still exists. */
function mutate(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `the fixture \`${from}\` moved`);
  return out;
}

test("the pins fail on a mutated view", () => {
  const view = read(VIEW);
  const res = read(RESOLVE);
  // Each mutation is built outside assert.throws, so a moved fixture fails
  // here instead of passing as an expected throw.
  const cases = [
    [
      pinHeader.bind(
        null,
        mutate(view, "data-conflict-ordinal={index}", ""),
        res,
      ),
      /exactly one element carries data-conflict-ordinal/,
    ],
    [
      pinHeader.bind(
        null,
        mutate(view, /tabIndex=\{-1\}(\s*data-conflict-ordinal)/, "$1"),
        res,
      ),
      /tabIndex=\{-1\}/,
    ],
    [
      pinHelper.bind(
        null,
        mutate(view, "scroller.scrollBy(", "header.scrollIntoView("),
        res,
      ),
      /scroll the body via scrollBy/,
    ],
    [
      pinHelper.bind(
        null,
        view,
        mutate(res, "useLayoutEffect(", "x.scrollIntoView(); useLayoutEffect("),
      ),
      /scroll the body via scrollBy/,
    ],
    [
      pinViewArms.bind(null, mutate(view, "active !== document.body &&", "")),
      /null, <body> or the pressed control/,
    ],
    [
      pinViewArms.bind(
        null,
        mutate(
          view,
          "if (landRequest === null || busy) return;",
          "if (landRequest === null) return;",
        ),
      ),
      /wait out `busy`/,
    ],
    [
      pinViewArms.bind(
        null,
        mutate(
          view,
          /armLanding\("header", pressed\);(\s*\} catch \(e\) \{)/,
          "$1",
        ),
      ),
      /acceptAll: expected 3 armLanding/,
    ],
    [
      pinResolveArms.bind(null, mutate(res, "onKeyDown={ignoreHeldEnter}", "")),
      /held Enter must not re-fire/,
    ],
    [
      pinViewArms.bind(null, mutate(view, /if \(!pending\) return;/, "")),
      /took over \(press marker cleared\)/,
    ],
    [
      pinViewArms.bind(
        null,
        mutate(
          view,
          "const sink = focusSinkRef.current;",
          "const sink = focusSink?.current ?? focusSinkRef.current;",
        ),
      ),
      /the view's own sink/,
    ],
    [
      pinViewArms.bind(
        null,
        mutate(view, "onWheelCapture={takeOverLanding}", ""),
      ),
      /onWheelCapture must cancel/,
    ],
    [
      pinViewArms.bind(
        null,
        mutate(view, /landPendingRef\.current = true;/, ""),
      ),
      /capturePress must set the press marker/,
    ],
    [
      pinViewArms.bind(
        null,
        mutate(
          view,
          /landPendingRef\.current &&\s*\(active === null \|\| active === document\.body\)/,
          "false",
        ),
      ),
      /hand off focus its hold left on <body>/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(res, /if \(leaves\) handOff\(\);\s*else land\(\);/, "land();"),
      ),
      /hand off only when the view leaves/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(
          res,
          /if \(leaves\) handOff\(\);\s*else land\(\);/,
          "handOff();",
        ),
      ),
      /hand off only when the view leaves/,
    ],
    // The settle's split moved after the advance that unmounts the view.
    [
      pinResolveArms.bind(
        null,
        mutate(
          res,
          /(\s*\/\/ Up only when[^\n]*\n\s*const leaves =[\s\S]*?else land\(\);)([\s\S]*?\n\s*if \(advances\) walk\.advance\(\);)/,
          "$2$1",
        ),
      ),
      /hand focus off before walk\.advance\(\) unmounts/,
    ],
    // The land() count stays the same, so only the per-arm pin sees the move.
    [
      pinResolveArms.bind(
        null,
        mutate(
          mutate(
            res,
            /(keep the file's bytes exact\.`,\s*\);\s*)land\(\);/,
            "$1",
          ),
          /(if \(outcome\.kind === "changedOnDisk"\) \{\s*toast\.info\(changedOnDiskCopy\(baseName\(path\)\)\);\s*)land\(\);/,
          "$1land();\n        land();",
        ),
      ),
      /the undecodable arm must call land\(\) and only that/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(
          res,
          /handOff\(\);(\s*await refreshConflictFile\(queryClient, acceptIn\);)/,
          "$1\n        land();",
        ),
      ),
      /the not-conflicted arm must call handOff\(\) and only that/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(
          res,
          /handOff\(\);(\s*await refreshConflictFile\(queryClient, acceptIn\);)/,
          "$1\n        handOff();",
        ),
      ),
      /the not-conflicted arm must call handOff\(\) before its await/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(res, /(toastError\(e\);)\s*land\(\);/, "$1"),
      ),
      /the write failure must call land\(\) and only that/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(
          res,
          /(const outcome = await resolve\.mutateAsync\()/,
          'if (proposed === "") return;\n      $1',
        ),
      ),
      /a return outside every classified arm/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(res, /(advances \|\|)\s*clean \|\|/, "$1"),
      ),
      /hand off only when the view leaves/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(res, /\|\|\s*walk\.activePath !== path;/, ";"),
      ),
      /hand off only when the view leaves/,
    ],
    [
      pinResolveArms.bind(
        null,
        mutate(
          res,
          /if \(root\?\.contains\(document\.activeElement\)\)/,
          "if (false)",
        ),
      ),
      /catch focus left inside the view/,
    ],
    [
      pinHost.bind(
        null,
        // WorkingTreeDiff takes the same prop, so the mutation targets the
        // conflict editor's tag.
        mutate(
          read(DIFF_VIEWER),
          /(<ConflictFileView[^>]*?)\s*focusSink=\{slots\.sinkRef\}/,
          "$1",
        ),
        "slots.sinkRef",
        DIFF_VIEWER,
      ),
      /must take focusSink=\{slots\.sinkRef\}/,
    ],
    ...PR_HOSTS.flatMap((file) => [
      [
        pinPrHost.bind(
          null,
          mutate(read(file), /focusSink=\{paneSinkRef\}/, ""),
          file,
        ),
        /must take focusSink=\{paneSinkRef\}/,
      ],
      [
        pinPrHost.bind(
          null,
          mutate(
            read(file),
            /useFocusOnControlsSwap\(done, paneSinkRef\);/,
            "",
          ),
          file,
        ),
        /rescue <body> focus to the pane sink/,
      ],
      [
        pinPrHost.bind(
          null,
          mutate(read(file), /<span ref=\{paneSinkRef\}[^>]*\/>/, ""),
          file,
        ),
        /pane sink must be a tabIndex/,
      ],
    ]),
  ];
  for (const [i, [run, message]] of cases.entries()) {
    assert.throws(run, message, `negative control #${i} did not fail`);
  }
});
