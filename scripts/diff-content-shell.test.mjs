// Pins the diff pane's one shell (src/features/diff/DiffSurface.tsx), read from
// source: every DiffContent arm, loading and stale-path included, renders the
// notice slot, the file's path row and its body, so the header holds still
// while the next diff loads. ImageDiff (ImageDiff.tsx) draws no path row of its
// own, leaving the shell's row the only one over an image.
//
// Not testable here: rendered row height, where focus lands across an arm swap,
// and the hold's promotion timing. Those need the live app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SURFACE = "src/features/diff/DiffSurface.tsx";
const IMAGE = "src/features/diff/ImageDiff.tsx";
// LF-normalized, so offsets and anchors read the same on any checkout.
const read = (file) =>
  readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
// Whitespace removed: formatting never moves a pin.
const flat = (s) => s.replace(/\s+/g, "");

/** The path row's box classes, shared with DiffViewer's staging row. */
const ROW = "border-b px-3 py-1.5";

/** The `{…}` span of `function <name>(…)`, or null. */
function componentBody(masked, name) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(masked);
  if (m === null) return null;
  const paramsClose = matchBrace(masked, m.index + m[0].length - 1);
  if (paramsClose < 0) return null;
  const open = masked.indexOf("{", paramsClose);
  const close = open < 0 ? -1 : matchBrace(masked, open);
  return close > open ? { open, close } : null;
}

/** Every block-bodied function nested in `span`, so a cleanup's or handler's
 *  own `return` never counts as the component's. */
function nestedFunctions(masked, span) {
  const out = [];
  const inner = masked.slice(span.open + 1, span.close);
  for (const m of inner.matchAll(/=>\s*\{/g)) {
    const open = span.open + 1 + m.index + m[0].length - 1;
    out.push({ from: open, to: matchBrace(masked, open) });
  }
  for (const m of inner.matchAll(/(?<![\w$.])function\b[^(]*\(/g)) {
    const paren = span.open + 1 + m.index + m[0].length - 1;
    const open = masked.indexOf("{", matchBrace(masked, paren));
    out.push({ from: open, to: matchBrace(masked, open) });
  }
  return out;
}

/** The component-level `return`s in `span`, as offsets. */
function componentReturns(masked, span, nested) {
  return [
    ...masked.slice(span.open + 1, span.close).matchAll(/(?<![\w$.])return\b/g),
  ]
    .map((m) => span.open + 1 + m.index)
    .filter((at) => !nested.some((n) => at > n.from && at < n.to));
}

/** Every `name(` call in `span`, as its start offset. */
function calls(masked, name, span) {
  return [
    ...masked
      .slice(span.open + 1, span.close)
      .matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g")),
  ].map((m) => span.open + 1 + m.index);
}

/** Offsets of every `needle` in `raw` within `span`. */
function occurrences(raw, needle, span) {
  const out = [];
  for (
    let at = raw.indexOf(needle, span.open);
    at >= 0 && at < span.close;
    at = raw.indexOf(needle, at + 1)
  )
    out.push(at);
  return out;
}

/** `occurrences` whose code part (the needle up to any string quote) survives
 *  masking, so a comment or JSX text quoting the literal never counts. */
function codeOccurrences(raw, masked, needle, span) {
  const code = needle.split('"')[0];
  return occurrences(raw, needle, span).filter((at) =>
    masked.startsWith(code, at),
  );
}

export function diffShellViolations(surfaceRaw, imageRaw) {
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };

  const masked = maskNonCode(surfaceRaw, true);
  const body = componentBody(masked, "DiffContent");
  // Fail closed: a component this scan can't find pins nothing.
  if (body === null) return ["DiffContent's body is not found"];
  const nested = nestedFunctions(masked, body);
  if (nested.some((n) => n.from < 0 || n.to < 0))
    return ["a nested function in DiffContent never closes"];
  const returns = componentReturns(masked, body, nested);
  if (returns.length === 0) return ["DiffContent has no return"];

  // (a) Fails pre-fix. Every arm returns through the shell, and the shell
  // holds the path row, so no arm (loading and stale-path included) renders
  // without it.
  const unshelled = returns.filter(
    (at) => !flat(masked.slice(at, at + 40)).startsWith("returnshell("),
  );
  need(
    unshelled.length === 0,
    `every DiffContent arm returns through the shell (not at line ${unshelled
      .map((at) => lineOf(surfaceRaw, at))
      .join(", ")})`,
  );
  const shellDecl =
    /\bconst\s+shell\s*=\s*\(\s*body\s*:\s*ReactNode\s*,\s*notice\s*:\s*ReactNode\s*=\s*null\s*\)\s*=>\s*\(/g;
  shellDecl.lastIndex = body.open;
  const decl = shellDecl.exec(masked);
  const shellOpen =
    decl !== null && decl.index < body.close
      ? decl.index + decl[0].length - 1
      : -1;
  const shellClose = shellOpen < 0 ? -1 : matchBrace(masked, shellOpen);
  const shell = { open: shellOpen, close: shellClose };
  need(
    shellClose > shellOpen &&
      !nested.some((n) => shellOpen > n.from && shellOpen < n.to) &&
      returns.every((at) => at > shellClose),
    "the shell is declared once at component level, ahead of every arm",
  );

  // (b) Regression-only (true pre-fix too). One path-row literal in
  // DiffContent, naming the selected file: never a per-arm copy.
  const rows = occurrences(surfaceRaw, ROW, body);
  need(rows.length === 1, "DiffContent renders one path-row literal");
  if (rows.length === 1) {
    need(
      /^border-b px-3 py-1\.5">\s*<PathText\s+path=\{filePath\}/.test(
        surfaceRaw.slice(rows[0]),
      ),
      "the path row renders PathText with the selected file's path",
    );
    // Part of (a): the row sits inside the shell, outside every arm branch.
    need(
      shellClose > shellOpen && rows[0] > shellOpen && rows[0] < shellClose,
      "the shell holds the path row",
    );
  }

  // Part of (a), so it fails pre-fix too. The landing body (pending,
  // stale-path, error, binary, empty, header-only) carries the swap ref, the
  // three bodies are keyed apart, and the controls' landing renders in every
  // arm.
  for (const key of ["arm-landing", "arm-image", "arm-text"])
    need(
      codeOccurrences(surfaceRaw, masked, `key="${key}"`, body).length === 1,
      `one body keyed "${key}"`,
    );
  need(
    codeOccurrences(surfaceRaw, masked, "ref={armRef}", body).length === 1,
    "one body carries the arm landing's ref",
  );
  need(
    shellClose > shellOpen &&
      codeOccurrences(surfaceRaw, masked, "ref={controlsRef}", shell).length ===
        1,
    "the controls cluster's focus landing renders in the shell",
  );

  // The blank bodies (pending, stale path) are busy, so AT hears a load rather
  // than an empty pane: the landing body maps `busy` onto aria-busy, and both
  // arms pass it.
  const landingDecl =
    /\bconst\s+landing\s*=\s*\(\s*content\s*:\s*ReactNode\s*,\s*busy\s*=\s*false\s*\)\s*=>\s*\(/g;
  landingDecl.lastIndex = body.open;
  const ld = landingDecl.exec(masked);
  const landingOpen =
    ld !== null && ld.index < body.close ? ld.index + ld[0].length - 1 : -1;
  const landingClose = landingOpen < 0 ? -1 : matchBrace(masked, landingOpen);
  need(
    landingClose > landingOpen &&
      flat(masked.slice(landingOpen, landingClose)).includes(
        "aria-busy={busy||undefined}",
      ),
    "the landing body maps busy onto aria-busy",
  );
  const pendingArm = /\bif\s*\(\s*isPending\s*\)\s*\{/g;
  pendingArm.lastIndex = body.open;
  const pa = pendingArm.exec(masked);
  const paOpen =
    pa !== null && pa.index < body.close ? pa.index + pa[0].length - 1 : -1;
  const paClose = paOpen < 0 ? -1 : matchBrace(masked, paOpen);
  need(
    paClose > paOpen &&
      flat(masked.slice(paOpen, paClose)).includes(":landing(null,true)"),
    "the blank pending body is busy",
  );
  const staleArm =
    /\bif\s*\(\s*data\s*&&\s*data\.filePath\s*!==\s*filePath\s*\)/g;
  staleArm.lastIndex = body.open;
  const sa = staleArm.exec(masked);
  need(
    sa !== null &&
      sa.index < body.close &&
      flat(masked.slice(sa.index, sa.index + 120)).startsWith(
        "if(data&&data.filePath!==filePath)returnshell(landing(null,true));",
      ),
    "the stale-path body is busy",
  );

  // A swap that drops both the toolbar and Preview lands on the new body: the
  // toolbar's rescue is declared, so its layout effect runs, ahead of the
  // Preview rescue, whose controls landing persists across arms.
  const swaps = calls(masked, "useFocusOnControlsSwap", body).map((at) =>
    flat(masked.slice(at, masked.indexOf(")", at) + 1)),
  );
  need(
    swaps.length === 2 &&
      swaps[0] === "useFocusOnControlsSwap(showsToolbar,armLandingRef)" &&
      swaps[1] === "useFocusOnControlsSwap(previewOn,controlsRef)",
    "the toolbar's focus rescue runs before the Preview rescue",
  );

  // (c) Regression-only (true pre-fix too). One settle report, ahead of the
  // first component-level return: a render-blank arm under a slot still
  // reports.
  const reports = calls(masked, "useReportPaneSettled", body);
  need(reports.length === 1, "DiffContent calls useReportPaneSettled once");
  if (reports.length === 1)
    need(
      reports[0] < returns[0],
      `DiffContent returns at line ${lineOf(surfaceRaw, returns[0])} before its settle report`,
    );

  // (d) Fails pre-fix. ImageDiff draws no path row of its own; its panes
  // still render inside it.
  const imageMasked = maskNonCode(imageRaw, true);
  const image = componentBody(imageMasked, "ImageDiff");
  if (image === null) {
    problems.push("ImageDiff's body is not found");
    return problems;
  }
  need(
    /<ImagePanes\b/.test(imageMasked.slice(image.open, image.close)),
    "ImageDiff renders ImagePanes",
  );
  need(
    !/(?<![\w$])PathText\b/.test(imageMasked),
    "ImageDiff neither imports nor renders PathText",
  );
  need(!imageRaw.includes(ROW), "ImageDiff renders no path row");
  return problems;
}

test("diff shell: every arm renders the notice slot, path row and body", () => {
  assert.deepEqual(diffShellViolations(read(SURFACE), read(IMAGE)), []);
});

test("diff shell: negative controls trip the pin named beside them", () => {
  const surface = read(SURFACE);
  const image = read(IMAGE);
  const caught = (s, i, pin) => {
    const got = diffShellViolations(s, i);
    assert.ok(
      got.some((p) => p.startsWith(pin)),
      `expected "${pin}", got ${JSON.stringify(got)}`,
    );
  };
  const swap = (raw, from, to) => {
    assert.ok(raw.includes(from), `negative-control anchor missing: ${from}`);
    return raw.replace(from, () => to);
  };
  const UNSHELLED = "every DiffContent arm returns through the shell";

  // The pending arm rendering nothing again.
  caught(
    swap(
      surface,
      "if (isPending) {\n    return shell(",
      "if (isPending) {\n    return null;\n    return shell(",
    ),
    image,
    UNSHELLED,
  );
  // The stale-path arm rendering nothing again.
  caught(
    swap(
      surface,
      "if (data && data.filePath !== filePath) return shell(landing(null, true));",
      "if (data && data.filePath !== filePath) return null;",
    ),
    image,
    UNSHELLED,
  );
  // The row losing its box.
  caught(
    swap(surface, 'gap-2 border-b px-3 py-1.5"', 'gap-2"'),
    image,
    "DiffContent renders one path-row literal",
  );
  // No shell for the arms to share.
  caught(
    swap(surface, "const shell = (body", "const frame = (body"),
    image,
    "the shell is declared once at component level",
  );
  // A second, per-arm row.
  caught(
    swap(
      surface,
      '<div key="arm-image" className="min-h-0 flex-1">',
      '<div key="arm-image" className="min-h-0 flex-1">\n<div className="border-b px-3 py-1.5"><PathText path={filePath} /></div>',
    ),
    image,
    "DiffContent renders one path-row literal",
  );
  // An arm returning ahead of the settle report.
  caught(
    swap(
      surface,
      "  useReportPaneSettled(\n    !(isPending && !isPaused) &&",
      "  if (isPaused) return shell(null);\n  useReportPaneSettled(\n    !(isPending && !isPaused) &&",
    ),
    image,
    "DiffContent returns at line",
  );
  // ImageDiff's own row coming back.
  caught(
    surface,
    swap(
      image,
      '<div className="min-h-0 flex-1 overflow-auto">',
      '<div className="border-b px-3 py-1.5"><PathText path={filePath} /></div>\n<div className="min-h-0 flex-1 overflow-auto">',
    ),
    "ImageDiff neither imports nor renders PathText",
  );
  // The blank bodies losing their busy state.
  caught(
    swap(
      surface,
      "if (data && data.filePath !== filePath) return shell(landing(null, true));",
      "if (data && data.filePath !== filePath) return shell(landing(null));",
    ),
    image,
    "the stale-path body is busy",
  );
  caught(
    swap(surface, ": landing(null, true),", ": landing(null),"),
    image,
    "the blank pending body is busy",
  );
  caught(
    swap(surface, "aria-busy={busy || undefined}", ""),
    image,
    "the landing body maps busy onto aria-busy",
  );
  // A comment quoting a literal never stands in for the real one.
  caught(
    swap(
      surface,
      '<div key="arm-image" className="min-h-0 flex-1">',
      '<div className="min-h-0 flex-1">{/* key="arm-image" */}',
    ),
    image,
    'one body keyed "arm-image"',
  );
  caught(
    swap(
      surface,
      'key="arm-landing"\n      ref={armRef}',
      'key="arm-landing"\n      // ref={armRef}',
    ),
    image,
    "one body carries the arm landing's ref",
  );
  caught(
    swap(surface, "ref={controlsRef}", "data-x={0} /* ref={controlsRef} */"),
    image,
    "the controls cluster's focus landing renders in the shell",
  );
  // The Preview rescue running first again.
  caught(
    swap(
      surface,
      "  useFocusOnControlsSwap(showsToolbar, armLandingRef);\n  useFocusOnControlsSwap(previewOn, controlsRef);",
      "  useFocusOnControlsSwap(previewOn, controlsRef);\n  useFocusOnControlsSwap(showsToolbar, armLandingRef);",
    ),
    image,
    "the toolbar's focus rescue runs before the Preview rescue",
  );
  // Fail closed on a component the scan can't find.
  caught(
    swap(surface, "export function DiffContent(", "export function Other("),
    image,
    "DiffContent's body is not found",
  );
});
