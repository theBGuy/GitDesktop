// Pins the Changes diff keeping the user's place through a hunk write
// (src/features/diff/DiffViewer.tsx), read from source. The staging build
// prebuilds its rows for both layouts, so the library's remount on every
// rebuild never commits rowless (which would clamp the pane's scroll to the
// top); a min-height hold over any rowless commit left mirrors the settle
// report's rows term; the post-write landing scrolls its focus target into
// view, nearest, unless the user took the pane over mid-write, which in-pane
// wheel, touch, scroll-key and focus input latch in the same effect as the
// pointer drop; and only the hunk landing arms a scrolling re-land.
//
// Not testable here: the remount's first commit carrying rows, the browser's
// scroll clamp, and where focus and scroll end up. Those need the live app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeRe, maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIEWER = "src/features/diff/DiffViewer.tsx";
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const squash = (s) => s.replace(/\s+/g, " ").trim();

const TOP_LEVEL = /\n(?:export )?(?:async )?(?:function|const|type|interface) /;

/** The top-level function `name` as a span of the masked text, or null. */
function functionSpan(masked, name) {
  const start = masked.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const next = masked.slice(start + 1).search(TOP_LEVEL);
  return { start, end: next < 0 ? masked.length : start + 1 + next };
}

/** Every call of `callee` starting in [from, to): its span, its code (text
 *  masked) and its raw text, both whitespace-squashed. */
function calls(src, callee, from, to) {
  const re = new RegExp(`(?<![\\w$])${escapeRe(callee)}\\(`, "g");
  re.lastIndex = from;
  const out = [];
  for (let m = re.exec(src.masked); m !== null && m.index < to; ) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src.masked, open);
    if (close < 0) throw new Error(`unclosed ${callee}( at ${m.index}`);
    out.push({
      start: m.index,
      end: close + 1,
      code: squash(src.masked.slice(m.index, close + 1)),
      text: squash(src.raw.slice(m.index, close + 1)),
    });
    m = re.exec(src.masked);
  }
  return out;
}

/** The `hook(` call in `span` whose code contains `marker`, or null. */
function hookWith(src, hook, span, marker) {
  return (
    calls(src, hook, span.start, span.end).find((c) =>
      c.code.includes(marker),
    ) ?? null
  );
}

/** The body of the arrow function `const name = (…) => {…}` in `span`. */
function arrowBody(src, name, span) {
  const at = src.masked.indexOf(`const ${name} = (`, span.start);
  if (at < 0 || at >= span.end) return null;
  const open = src.masked.indexOf("=> {", at) + 3;
  const close = matchBrace(src.masked, open);
  return close < 0 ? null : squash(src.masked.slice(open, close + 1));
}

export function scrollKeepViolations(raw) {
  const src = { raw, masked: maskNonCode(raw, true) };
  const { masked } = src;
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };
  const view = functionSpan(masked, "StagingDiffView");
  const pane = functionSpan(masked, "WorkingTreeDiff");
  const landFocus = functionSpan(masked, "landHunkFocus");
  if (view === null || pane === null || landFocus === null)
    return ["StagingDiffView, WorkingTreeDiff or landHunkFocus not found"];
  const viewCode = squash(masked.slice(view.start, view.end));
  const paneCode = squash(masked.slice(pane.start, pane.end));

  // The pending record and the press-shaped HunkFocus.
  need(
    /type PendingHunkFocus = HunkFocus & \{ tookOver: boolean \};/.test(
      squash(masked),
    ),
    "PendingHunkFocus is HunkFocus plus the tookOver latch",
  );
  need(
    paneCode.includes("useRef<PendingHunkFocus | null>(null)") &&
      viewCode.includes("hunkFocusRef: RefObject<PendingHunkFocus | null>;"),
    "both ends of hunkFocusRef carry the pending record",
  );
  need(
    paneCode.includes(
      "const pending = focus === null ? null : { ...focus, tookOver: false }; hunkFocusRef.current = pending; scrollCycleRef.current = pending;",
    ),
    "runWrite builds the pending-only record into both refs",
  );
  // The write's record outlives its landing, so input in the landing's frame
  // and its re-land window still latches: only runWrite ever writes it.
  need(
    paneCode.includes(
      "const scrollCycleRef = useRef<PendingHunkFocus | null>(null);",
    ) && (masked.match(/\bscrollCycleRef\.current =/g) ?? []).length === 1,
    "only runWrite writes the write's record",
  );
  let pressShapes = 0;
  for (let at = masked.indexOf("hadFocus:"); at >= 0; ) {
    const open = masked.lastIndexOf("{", at);
    const block = masked.slice(open, matchBrace(masked, open) + 1);
    pressShapes++;
    if (/\btookOver\b/.test(block))
      problems.push("a press-shaped HunkFocus carries tookOver");
    at = masked.indexOf("hadFocus:", at + 1);
  }
  need(pressShapes >= 3, "HunkFocus and its two press literals not found");

  // The landing's own focus never scrolls.
  const focusCalls = calls(src, "target.focus", landFocus.start, landFocus.end);
  need(
    focusCalls.length === 1 &&
      focusCalls[0].text === "target.focus({ preventScroll: true })",
    "landHunkFocus focuses with preventScroll",
  );
  need(
    !masked.slice(landFocus.start, landFocus.end).includes("scrollIntoView"),
    "landHunkFocus never scrolls",
  );

  // The prebuild, in the staging memo only, off the layout.
  const memo = hookWith(src, "useMemo", view, "createDiffFile(");
  const built = memo && /const (\w+) = createDiffFile\(/.exec(memo.code);
  if (built === null) problems.push("the builtDiffFile memo is not found");
  else {
    const file = escapeRe(built[1]);
    for (const method of ["buildSplitDiffLines", "buildUnifiedDiffLines"])
      need(
        new RegExp(`\\b${file}\\??\\.${method}\\(\\);`).test(memo.code),
        `the memo prebuilds with ${method}`,
      );
    need(
      new RegExp(`return ${file};`).test(memo.code),
      "the memo returns the prebuilt file",
    );
    const deps = memo.code.slice(memo.code.lastIndexOf("["));
    need(
      !/\b(viewMode|split)\b/.test(deps),
      "the layout stays out of the memo's deps",
    );
  }
  need(
    viewCode.includes("const builtDiffFile = useMemo("),
    "the prebuilding memo is builtDiffFile",
  );

  // The rowless hold mirrors the settle report's rows term.
  const ROWS = "anchors.some((a) => a.top >= 0)";
  need(
    viewCode.includes(
      `const rowsPending = diffFile !== null && diffRendersRows(diffFile) && !${ROWS};`,
    ),
    "rowsPending is the settle report's rows term, negated",
  );
  const settle = calls(src, "useReportPaneSettled", view.start, view.end);
  need(
    settle.length === 1 &&
      settle[0].code.includes(`!diffRendersRows(diffFile) || ${ROWS}`),
    "the settle report keeps the rows term",
  );
  need(
    viewCode.includes(
      `if (list.some((a) => a.top >= 0)) heightRef.current = container.offsetHeight;`,
    ),
    "measure records the height only with rows found",
  );
  const hold = hookWith(src, "useLayoutEffect", view, ".style.minHeight =");
  const landing = hookWith(
    src,
    "useLayoutEffect",
    view,
    "const pending = hunkFocusRef.current;",
  );
  // The hold engages only with rows pending, a height recorded and no row in
  // the DOM, found the way measure finds them.
  need(
    hold !== null &&
      hold.code.includes(
        "const hold = rowsPending && heightRef.current > 0 && !displayHunks.some((h) => hunkFirstRow(container, h) !== null); container.style.minHeight = hold ?",
      ),
    "the min-height hold gates on pending, unrendered rows and a height",
  );
  need(
    /\bfunction hunkFirstRow\(/.test(masked) &&
      viewCode.includes("const row = hunkFirstRow(container, h);"),
    "measure finds rows through the hold's own lookup",
  );
  need(
    hold !== null && landing !== null && hold.start < landing.start,
    "the min-height hold is declared before the post-write landing",
  );
  const ref = masked.indexOf("ref={containerRef}", view.start);
  const div = masked.lastIndexOf("<div", ref);
  need(
    ref >= 0 && !/\bstyle=/.test(masked.slice(div, tagEnd(masked, div))),
    "the held container takes no style prop",
  );

  // The post-write landing scrolls, and arms a scrolling re-land, unless the
  // user took over.
  const land = landing && arrowBody(src, "land", landing);
  need(
    land !== null &&
      /if \(!landHunkFocus\(pending, target\)\) return; .*if \(!pending\.tookOver\) target\.scrollIntoView\(/.test(
        land,
      ),
    "a kept landing scrolls only while tookOver is unset",
  );
  const landFooter = landing && arrowBody(src, "landFooter", landing);
  need(
    landFooter !== null &&
      /^\{ if \(footer === null \|\| !landHunkFocus\(pending, footer\)\) return; if \(!pending\.tookOver\) footer\.scrollIntoView\(\{ block: " ?" \}\); \}$/.test(
        landFooter,
      ),
    "the footer landing scrolls only while tookOver is unset",
  );
  const nearest = 'target.scrollIntoView({ block: "nearest" })';
  const landScrolls =
    landing === null
      ? []
      : calls(src, "target.scrollIntoView", landing.start, landing.end);
  need(
    landScrolls.length === 1 && landScrolls[0].text === nearest,
    "the landing's scroll is nearest",
  );

  // Re-lands scroll only for a write's record not taken over, read at the
  // scroll, so a latch that lands after the landing still stops them.
  const arm = hookWith(src, "useCallback", view, "relandRef.current =");
  need(
    arm !== null &&
      arm.code.includes("cycle?: { readonly tookOver: boolean }") &&
      arm.code.includes(
        "relandRef.current = { index, button, control, cycle };",
      ),
    "armReland's record defaults to none (never scroll)",
  );
  const reland = hookWith(
    src,
    "useLayoutEffect",
    view,
    "const landed = relandRef.current;",
  );
  const relandScrolls =
    reland === null
      ? []
      : calls(src, "target.scrollIntoView", reland.start, reland.end);
  need(
    reland !== null &&
      relandScrolls.length === 1 &&
      relandScrolls[0].text === nearest &&
      reland.code.includes(
        "if (landed.cycle !== undefined && !landed.cycle.tookOver) target.scrollIntoView(",
      ),
    "a re-land scrolls only for its write's record, not taken over",
  );
  const reveal = hookWith(
    src,
    "useLayoutEffect",
    view,
    "const reveal = revealRef.current;",
  );
  const arms = calls(src, "armReland", view.start, view.end);
  const armIn = (hook) =>
    hook === null
      ? []
      : arms.filter((c) => c.start > hook.start && c.end <= hook.end);
  need(
    arms.length === 2 &&
      armIn(landing).length === 1 &&
      armIn(landing)[0].text === 'armReland(index, target, "primary", pending)',
    "the hunk landing arms its re-land with the write's record",
  );
  need(
    armIn(reveal).length === 1 &&
      raw.slice(armIn(reveal)[0].start, armIn(reveal)[0].end + 1) ===
        "armReland(index, target, control);",
    "the reveal arm's call is unchanged (never scrolls)",
  );

  // The reveal's scroll reads its own record's latch, which in-pane wheel,
  // touch and scroll keys set while armReveal's listeners are on.
  const revealScrolls =
    reveal === null
      ? []
      : calls(src, "target.scrollIntoView", reveal.start, reveal.end);
  need(
    reveal !== null &&
      revealScrolls.length === 1 &&
      revealScrolls[0].text === nearest &&
      reveal.code.includes("if (!reveal.tookOver) target.scrollIntoView("),
    "the reveal scrolls only while its record's tookOver is unset",
  );
  const armRev = hookWith(src, "useCallback", view, "revealRef.current = {");
  if (armRev === null) problems.push("armReveal is not found");
  else {
    need(
      armRev.code.includes("landed: false, tookOver: false, };"),
      "armReveal's record starts with tookOver unset",
    );
    const armText = squash(raw.slice(armRev.start, armRev.end));
    const passiveOpts =
      /const (\w+) = \{ capture: true, passive: true \};/.exec(armText);
    const added = new Map();
    for (const c of calls(
      src,
      "document.addEventListener",
      armRev.start,
      armRev.end,
    )) {
      const m = /^document\.addEventListener\("(\w+)", (\w+), (.+)\)$/.exec(
        c.text,
      );
      if (m === null) problems.push(`unreadable reveal listener: ${c.text}`);
      else added.set(m[1], { handler: m[2], opts: m[3] });
    }
    need(
      [...added.keys()].sort().join() ===
        "focusin,keydown,pointerdown,touchmove,wheel",
      "armReveal registers the disarm, focusin and the three input latches",
    );
    // Raw text: the event names are strings, which the masked body blanks.
    const disarmAt = masked.indexOf("const disarm = (", armRev.start);
    const disarmOpen = masked.indexOf("=> {", disarmAt) + 3;
    const disarmBody =
      disarmAt < 0 || disarmAt >= armRev.end
        ? ""
        : squash(raw.slice(disarmOpen, matchBrace(masked, disarmOpen) + 1));
    for (const [event, { handler }] of added)
      need(
        disarmBody.includes(
          `document.removeEventListener("${event}", ${handler}, true);`,
        ),
        `the reveal's ${event} listener is removed in disarm with capture`,
      );
    const isRevealLatch = (name) =>
      /^\{ const reveal = revealRef\.current; if \(reveal !== null && inScrollPane\(e\.target\)\) reveal\.tookOver = true; \}$/.test(
        arrowBody(src, name, armRev) ?? "",
      );
    for (const event of ["wheel", "touchmove", "keydown"]) {
      const l = added.get(event);
      need(
        l !== undefined && passiveOpts !== null && l.opts === passiveOpts[1],
        `the reveal's ${event} latch is passive capture`,
      );
    }
    for (const event of ["wheel", "touchmove"]) {
      const l = added.get(event);
      need(
        l !== undefined && isRevealLatch(l.handler),
        `the reveal's ${event} latches its record for in-pane targets only`,
      );
    }
    const revKey = added.get("keydown");
    const keyBody =
      revKey === undefined
        ? ""
        : (arrowBody(src, revKey.handler, armRev) ?? "");
    const keyLatch =
      /^\{ if \(PANE_SCROLL_KEYS\.has\(e\.key\)\) (\w+)\(e\); \}$/.exec(
        keyBody,
      );
    need(
      keyLatch !== null && isRevealLatch(keyLatch[1]),
      "the reveal's keydown latches only PANE_SCROLL_KEYS",
    );
    need(
      armRev.code.includes(
        "const inScrollPane = (target: EventTarget | null) => target instanceof Node && (scrollPaneRef.current?.contains(target) ?? false);",
      ) &&
        viewCode.includes("scrollPaneRef: RefObject<HTMLDivElement | null>;") &&
        squash(raw).includes("scrollPaneRef={scrollPaneRef}"),
      "the reveal judges containment against the scrolling pane",
    );
  }

  // The takeover latches share the pointer drop's effect.
  const drop = calls(
    src,
    "document.addEventListener",
    pane.start,
    pane.end,
  ).find(
    (c) => c.text === 'document.addEventListener("pointerdown", drop, true)',
  );
  const effect =
    drop === undefined
      ? null
      : calls(src, "useEffect", pane.start, pane.end).find(
          (c) => c.start < drop.start && c.end > drop.end,
        );
  if (effect === undefined || effect === null) {
    problems.push("the pointerdown drop's effect is not found");
    return problems;
  }
  const options = (opts) => {
    if (opts === "true") return { capture: true, passive: false };
    const literal = new RegExp(`const ${escapeRe(opts)} = (\\{[^}]*\\});`).exec(
      squash(raw.slice(effect.start, effect.end)),
    );
    const text = literal === null ? opts : literal[1];
    return {
      capture: /\bcapture: true\b/.test(text),
      passive: /\bpassive: true\b/.test(text),
    };
  };
  const listeners = new Map();
  for (const c of calls(
    src,
    "document.addEventListener",
    effect.start,
    effect.end,
  )) {
    const m = /^document\.addEventListener\("(\w+)", (\w+), (.+)\)$/.exec(
      c.text,
    );
    if (m === null) problems.push(`unreadable listener: ${c.text}`);
    else listeners.set(m[1], { handler: m[2], ...options(m[3]) });
  }
  need(
    [...listeners.keys()].sort().join() ===
      "focusin,keydown,pointerdown,touchmove,wheel",
    "the effect registers exactly the drop, the three input latches and focusin",
  );
  const effectText = squash(raw.slice(effect.start, effect.end));
  for (const [event, { handler, capture }] of listeners) {
    const flag = capture ? ", true" : "";
    need(
      effectText.includes(
        `document.removeEventListener("${event}", ${handler}${flag});`,
      ),
      `the ${event} listener is removed with its capture flag`,
    );
  }
  const effectCode = squash(masked.slice(effect.start, effect.end));
  need(
    effectCode.includes(
      "const inPane = (target: EventTarget | null) => target instanceof Node && scrollPaneRef.current?.contains(target) === true;",
    ),
    "inPane checks the target against the scrolling pane",
  );
  // View input latches the write's record, which outlives the landing.
  const isLatch = (name) =>
    /^\{ const (\w+) = scrollCycleRef\.current; if \(\1 !== null && inPane\(e\.target\)\) \1\.tookOver = true; \}$/.test(
      arrowBody(src, name, effect) ?? "",
    );
  const callsLatch = (name) => {
    const body = arrowBody(src, name, effect) ?? "";
    return [...body.matchAll(/\b(\w+)\(e\)/g)].some((m) => isLatch(m[1]));
  };
  for (const event of ["wheel", "touchmove"]) {
    const l = listeners.get(event);
    need(
      l !== undefined && l.passive && isLatch(l.handler),
      `${event} latches tookOver, passively, for in-pane targets only`,
    );
  }
  const key = listeners.get("keydown");
  need(
    key !== undefined &&
      key.passive &&
      callsLatch(key.handler) &&
      /if \(PANE_SCROLL_KEYS\.has\(e\.key\)\)/.test(
        arrowBody(src, key.handler, effect) ?? "",
      ),
    "keydown latches only the scroll keys, passively, in-pane",
  );
  // Focus latches only while pending: the landing clears the ref before its
  // own focus move, which must never latch.
  const focus = listeners.get("focusin");
  need(
    focus !== undefined &&
      /^\{ const pending = hunkFocusRef\.current; if \(pending !== null && e\.target !== pending\.button && inPane\(e\.target\)\) pending\.tookOver = true; \}$/.test(
        arrowBody(src, focus.handler, effect) ?? "",
      ),
    "focusin latches pending, in-pane moves other than to the pressed button",
  );
  const keys = /const PANE_SCROLL_KEYS = new Set\(\[/.exec(masked);
  if (keys === null) problems.push("PANE_SCROLL_KEYS not found");
  else {
    const open = keys.index + keys[0].length - 1;
    const list = raw.slice(open, matchBrace(masked, open) + 1);
    need(
      [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join() ===
        "PageUp,PageDown,Home,End,ArrowUp,ArrowDown",
      "the scroll keys are exactly Page/Home/End/arrows, never Space",
    );
  }
  need(
    /<div ref=\{scrollPaneRef\} className="[^"]*\boverflow-auto\b/.test(
      squash(raw),
    ),
    "scrollPaneRef is the scrolling pane",
  );
  return problems;
}

test("staging scroll keep: prebuilt rows, a rowless hold, and a latched landing scroll", () => {
  const raw = read(VIEWER);
  assert.deepEqual(scrollKeepViolations(raw), []);
  // Negative controls: each regression the pin exists for is caught.
  const mutate = (from, to) => {
    assert.equal(raw.split(from).length, 2, `one control anchor: ${from}`);
    return scrollKeepViolations(raw.replace(from, () => to));
  };
  const controls = [
    ["file?.buildUnifiedDiffLines();", ""],
    ["file?.buildSplitDiffLines();", ""],
    // The re-land scrolls unconditionally, or ignores its record's latch.
    ["if (landed.cycle !== undefined && !landed.cycle.tookOver)", "if (true)"],
    [
      "if (landed.cycle !== undefined && !landed.cycle.tookOver)",
      "if (landed.cycle !== undefined)",
    ],
    ["scrollPaneRef.current?.contains(target) === true", "true"],
    ['"ArrowDown",', ""],
    [
      'armReland(index, target, "primary", pending)',
      'armReland(index, target, "primary")',
    ],
    // A snapshot of the latch can't see a takeover after the landing.
    [
      'armReland(index, target, "primary", pending)',
      'armReland(index, target, "primary", { tookOver: pending.tookOver })',
    ],
    // Wheel latches that can't reach an armed re-land: through the pending ref
    // (cleared at the landing), or a record runWrite never shares.
    [
      "const cycle = scrollCycleRef.current;",
      "const cycle = hunkFocusRef.current;",
    ],
    ["scrollCycleRef.current = pending;", "scrollCycleRef.current = null;"],
    [
      "const inPane = (target",
      "scrollCycleRef.current = null; const inPane = (target",
    ],
    ["if (!pending.tookOver) target.scrollIntoView", "target.scrollIntoView"],
    ["if (!pending.tookOver) footer.scrollIntoView", "footer.scrollIntoView"],
    // The reveal scrolls ungated, loses a latch or its removal, or judges
    // containment by the rows container. Indentation keeps each anchor unique.
    ["if (!reveal.tookOver) target.scrollIntoView", "target.scrollIntoView"],
    ['      document.addEventListener("wheel", latch, latchOptions);', ""],
    ['        document.removeEventListener("keydown", latchKey, true);', ""],
    ["        if (PANE_SCROLL_KEYS.has(e.key)) latch(e);", "        latch(e);"],
    [
      "        (scrollPaneRef.current?.contains(target) ?? false);",
      "        (containerRef.current?.contains(target) ?? false);",
    ],
    ["        tookOver: false,", ""],
    // The reveal arms a re-land with no record: its relands never scroll.
    [
      "armReland(index, target, control);",
      "armReland(index, target, control, { tookOver: false });",
    ],
    // The hold engages without rows pending, or with rows in the DOM.
    ["rowsPending &&", "false &&"],
    ["!displayHunks.some((h) => hunkFirstRow(container, h) !== null)", "true"],
    ["const row = hunkFirstRow(container, h);", "const row = container;"],
    [
      "const passive = { capture: true, passive: true };",
      "const passive = { capture: true, passive: false };",
    ],
    [
      "if (kept) target.focus({ preventScroll: true });",
      "if (kept) target.focus();",
    ],
    ["!anchors.some((a) => a.top >= 0);", "!anchors.some((a) => a.top > 0);"],
    [
      'viaConfirm: kind === "discard",',
      'viaConfirm: kind === "discard", tookOver: false,',
    ],
    ["e.target !== pending.button && ", ""],
    ["{ ...focus, tookOver: false }", "focus"],
  ];
  for (const [from, to] of controls)
    assert.notDeepEqual(mutate(from, to), [], `control not caught: ${from}`);
});

test("staging scroll keep: the prebuild stays out of the shared createDiffFile", () => {
  const masked = maskNonCode(read("src/features/diff/DiffSurface.tsx"), true);
  assert.ok(
    masked.includes("function createDiffFile("),
    "createDiffFile found",
  );
  assert.doesNotMatch(masked, /\bbuild(Split|Unified)DiffLines\(/);
});
