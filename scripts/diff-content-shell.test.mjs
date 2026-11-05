// Pins the diff pane's one shell (src/features/diff/DiffSurface.tsx), read from
// source: every DiffContent arm, loading and stale-path included, renders the
// file's path row and its body, so the header holds still while the next diff
// loads, and every arm that draws retained data passes the shell its notice.
// ImageDiff (ImageDiff.tsx) draws no path row of its own, leaving the shell's
// row the only one over an image.
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
const PATH_ROW = "src/features/diff/DiffPathRow.tsx";
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

export function diffShellViolations(surfaceRaw, imageRaw, rowRaw) {
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

  // Every arm that draws retained data passes the notice as the shell's second
  // argument, so a failed refresh never shows that data without it; the blank
  // and failed arms (pending, stale path, no data) pass none.
  const shellArgs = (at) => {
    const open = masked.indexOf("(", at);
    const close = open < 0 ? -1 : matchBrace(masked, open);
    if (close < 0) return null;
    const args = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open + 1; i < close; i++) {
      const c = masked[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 0) {
        args.push(flat(masked.slice(from, i)));
        from = i + 1;
      }
    }
    args.push(flat(masked.slice(from, close)));
    return args.filter((a) => a !== "");
  };
  /** The first component-level return after `guard`'s first match, or -1. */
  const armReturn = (guard) => {
    const g = guard.exec(masked.slice(body.open, body.close));
    return g === null
      ? -1
      : (returns.find((r) => r > body.open + g.index) ?? -1);
  };
  const imageAt = armReturn(
    /\bif\s*\(\s*repoPath\s*&&\s*imageRevs\s*&&\s*imageMime\s*\(\s*filePath\s*\)\s*\)/,
  );
  const headerOnlyAt = armReturn(/\bif\s*\(\s*headerOnly\s*!==\s*null\s*\)/);
  const textAt = returns[returns.length - 1];
  const arms = [
    ["pending", armReturn(/\bif\s*\(\s*isPending\s*\)/), false],
    [
      "stale-path",
      armReturn(/\bif\s*\(\s*data\s*&&\s*data\.filePath\s*!==\s*filePath\s*\)/),
      false,
    ],
    ["no-data", armReturn(/\bif\s*\(\s*!\s*data\s*\)/), false],
    ["image", imageAt, true],
    // The binary placeholder is the image guard's else branch.
    [
      "binary placeholder",
      imageAt < 0 ? -1 : (returns.find((r) => r > imageAt) ?? -1),
      true,
    ],
    ["empty", armReturn(/\bif\s*\(\s*emptyDiff\s*\)/), true],
    ["header-only", headerOnlyAt, true],
    ["text", headerOnlyAt >= 0 && textAt > headerOnlyAt ? textAt : -1, true],
  ];
  need(
    arms.every(([, at]) => at >= 0) &&
      new Set(arms.map(([, at]) => at)).size === arms.length &&
      returns.length === arms.length,
    "every DiffContent return is one of the eight named arms",
  );
  for (const [name, at, data] of arms) {
    if (at < 0) continue;
    const args = shellArgs(at);
    if (data)
      need(
        args !== null && args.length === 2 && args[1] === "notice",
        `the ${name} arm passes the notice to the shell`,
      );
    else
      need(
        args !== null && args.length === 1,
        `the ${name} arm passes the shell no notice`,
      );
  }

  // (b) Regression-only (true pre-fix too). One path row in DiffContent, a
  // DiffPathRow naming the selected file: never a per-arm copy, and the row's
  // markup lives only in DiffPathRow, which the lazy fallback shares.
  const rows = codeOccurrences(surfaceRaw, masked, "<DiffPathRow", body);
  need(
    rows.length === 1 && occurrences(surfaceRaw, ROW, body).length === 0,
    "DiffContent renders one DiffPathRow",
  );
  if (rows.length === 1) {
    need(
      /^<DiffPathRow\s+filePath=\{filePath\}/.test(surfaceRaw.slice(rows[0])),
      "the path row renders with the selected file's path",
    );
    // Part of (a): the row sits inside the shell, outside every arm branch.
    need(
      shellClose > shellOpen && rows[0] > shellOpen && rows[0] < shellClose,
      "the shell holds the path row",
    );
  }
  const rowMasked = maskNonCode(rowRaw, true);
  const pathRow = componentBody(rowMasked, "DiffPathRow");
  const rowLiterals = pathRow === null ? [] : occurrences(rowRaw, ROW, pathRow);
  need(
    rowLiterals.length === 1 &&
      /^border-b px-3 py-1\.5">\s*<PathText\s+path=\{filePath\}/.test(
        rowRaw.slice(rowLiterals[0]),
      ),
    "DiffPathRow renders one path-row literal with PathText naming its file",
  );

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
  // The shell hands its row the controls landing, and the row puts it on the
  // cluster.
  const handed = codeOccurrences(
    surfaceRaw,
    masked,
    "controlsRef={controlsRef}",
    shell,
  );
  need(
    shellClose > shellOpen &&
      handed.length === 1 &&
      rows.length === 1 &&
      handed[0] > rows[0],
    "the controls cluster's focus landing renders in the shell",
  );
  need(
    pathRow !== null &&
      codeOccurrences(rowRaw, rowMasked, "ref={controlsRef}", pathRow)
        .length === 1 &&
      /<span\s+ref=\{controlsRef\}\s+tabIndex=\{-1\}/.test(
        rowMasked.slice(pathRow.open, pathRow.close),
      ),
    "DiffPathRow's controls cluster carries the focus landing ref",
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
  const swapAt = calls(masked, "useFocusOnControlsSwap", body);
  const swaps = swapAt.map((at) =>
    flat(masked.slice(at, masked.indexOf(")", at) + 1)),
  );
  need(
    swaps.length === 2 &&
      swaps[0] === "useFocusOnControlsSwap(showsToolbar,armRescueRef)" &&
      swaps[1] === "useFocusOnControlsSwap(previewOn,previewRescueRef)",
    "the toolbar's focus rescue runs before the Preview rescue",
  );

  // Both rescues move only focus the pane held as a subtree left: one depless
  // gate effect, declared ahead of both, derives their refs from the record
  // and consumes it every commit.
  const gates = calls(masked, "useLayoutEffect", body)
    .map((at) => {
      const close = matchBrace(masked, masked.indexOf("(", at));
      return {
        at,
        close,
        code: close < 0 ? "" : flat(masked.slice(at, close + 1)),
      };
    })
    .filter((g) => g.code.includes("constheld=paneHeldFocus.current;"));
  if (gates.length !== 1) {
    problems.push("the held-focus gate effect is found once in DiffContent");
  } else {
    const [gate] = gates;
    const g = gate.code;
    need(
      g.includes(
        "armRescueRef.current=held?(armLandingRef.current??controlsRef.current):null;",
      ),
      "the toolbar rescue derives from the held record",
    );
    need(
      /^useLayoutEffect\(\(\)=>\{.*\}\)$/.test(g),
      "the held-focus gate takes no dependency array",
    );
    need(
      swapAt.length === 2 && swapAt.every((at) => gate.at < at),
      "the held-focus gate is declared ahead of both swap rescues",
    );
    const sameAt = g.indexOf(
      "constsameToolbarFile=showsToolbar&&prevSwapRef.current.toolbar&&prevSwapRef.current.path===filePath;",
    );
    need(
      sameAt >= 0 &&
        g.includes(
          "previewRescueRef.current=held||sameToolbarFile?controlsRef.current:null;",
        ),
      "the Preview rescue derives from the held record or a same-file toggle",
    );
    const prevWrites = g.split(
      "prevSwapRef.current={path:filePath,toolbar:showsToolbar}",
    );
    need(
      sameAt >= 0 && prevWrites.length === 2 && prevWrites[0].length > sameAt,
      "the Preview rescue's previous-commit record is written once, after its read",
    );
    const heldAt = g.indexOf("constheld=paneHeldFocus.current;");
    const resetAt = g.indexOf("paneHeldFocus.current=false;");
    need(resetAt >= 0, "the held-focus gate consumes the record");
    need(
      resetAt > heldAt && g.split("paneHeldFocus.current").length === 3,
      "the held record is consumed after its one read",
    );
  }

  // The record is written only in a capture node's ref cleanup, and only when
  // that node held focus; every focus-containment read sits in a ref cleanup.
  const cleanupOf = (decl, arrow) => {
    const d = decl.exec(masked.slice(body.open, body.close));
    if (d === null) return null;
    const call = body.open + d.index + d[0].length - 1;
    const callClose = matchBrace(masked, call);
    const head = masked.indexOf(arrow, call);
    if (callClose < 0 || head < 0 || head > callClose) return null;
    const open = head + arrow.length - 1;
    const close = matchBrace(masked, open);
    return close < 0
      ? null
      : { open, close, decl: { open: call, close: callClose } };
  };
  const capture = cleanupOf(
    /\bconst\s+captureHeldRef\s*=\s*useCallback\(/,
    "=> () => {",
  );
  const armCleanup = cleanupOf(
    /\bconst\s+armRef\s*=\s*useCallback\(/,
    "return () => {",
  );
  need(
    capture !== null &&
      flat(masked.slice(capture.open, capture.close + 1)) ===
        "{if(node!==null&&node.contains(document.activeElement))paneHeldFocus.current=true;}" &&
      /,\[\],?\)$/.test(
        flat(masked.slice(capture.decl.open, capture.decl.close + 1)),
      ),
    "the held record is written in a guarded ref cleanup",
  );
  const inCleanup = (at) =>
    [capture, armCleanup].some(
      (c) => c !== null && at > c.open && at < c.close,
    );
  const writes = [
    ...masked
      .slice(body.open, body.close)
      .matchAll(/paneHeldFocus\.current\s*=\s*true\b/g),
  ].map((m) => body.open + m.index);
  const containment = [
    ...masked
      .slice(body.open, body.close)
      .matchAll(/\bcontains\(\s*document\.activeElement\s*\)/g),
  ].map((m) => body.open + m.index);
  need(
    armCleanup !== null &&
      writes.length === 1 &&
      [...writes, ...containment].every(inCleanup),
    "focus is read and recorded only in ref cleanups",
  );
  // Any assignment form, whatever its right-hand side: the record has exactly
  // two writers, the guarded cleanup's `true` and the gate's reset.
  const recordWrites = [
    ...masked
      .slice(body.open, body.close)
      .matchAll(
        /(?<![\w$.])paneHeldFocus\.current\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)/g,
      ),
  ].map((m) => body.open + m.index);
  const writeIs = (at, text) =>
    flat(masked.slice(at, masked.indexOf(";", at) + 1)) === text;
  const gateSpan = gates.length === 1 ? gates[0] : null;
  need(
    recordWrites.length === 2 &&
      capture !== null &&
      recordWrites.some(
        (at) =>
          at > capture.open &&
          at < capture.close &&
          writeIs(at, "paneHeldFocus.current=true;"),
      ) &&
      gateSpan !== null &&
      gateSpan.close > gateSpan.at &&
      recordWrites.some(
        (at) =>
          at > gateSpan.at &&
          at < gateSpan.close &&
          writeIs(at, "paneHeldFocus.current=false;"),
      ),
    "the held record has exactly two writes: the cleanup's true and the gate's reset",
  );

  // The five nodes that can hold focus and leave on a watched flip: the text
  // scroller, the Preview body, both toolbar clusters, and the notice. The
  // scroller's capture rides its merged ref, shared with the line anchor.
  need(
    codeOccurrences(surfaceRaw, masked, "ref={captureHeldRef}", body).length ===
      4 &&
      codeOccurrences(surfaceRaw, masked, "ref={scrollerCaptureRef}", body)
        .length === 1,
    "five capture nodes carry captureHeldRef, the scroller through its merged ref",
  );
  // Identity-stable, so a re-render never runs the capture's cleanup; its own
  // cleanup runs the capture's before the scroller stops being readable.
  const mergedDecl = "const scrollerCaptureRef = useCallback(";
  const mergedAt = masked.indexOf(mergedDecl, body.open);
  const mergedOpen = mergedAt + mergedDecl.length - 1;
  const mergedClose =
    mergedAt < 0 || mergedAt > body.close ? -1 : matchBrace(masked, mergedOpen);
  need(
    mergedClose > 0 &&
      flat(masked.slice(mergedOpen, mergedClose + 1)) ===
        "((node:HTMLDivElement|null)=>{scrollerRef.current=node;constcapture=captureHeldRef(node);return()=>{capture();scrollerRef.current=null;};},[captureHeldRef],)",
    "the scroller's merged ref runs the capture's cleanup, identity-stable",
  );
  // Each capture node at its own placement, so a ref moved to another node
  // keeps the count and still trips. The ref and the node it wraps must both
  // be code, never a comment quoting them.
  const captureAt = (source, child, ref = "ref={captureHeldRef}") => {
    const re = new RegExp(source, "dg");
    const hits = [...surfaceRaw.slice(body.open, body.close).matchAll(re)]
      .map((m) => ({
        ref: body.open + m.indices.groups.ref[0],
        child: body.open + m.indices.groups.child[0],
      }))
      .filter(
        (h) =>
          masked.startsWith(ref, h.ref) && masked.startsWith(child, h.child),
      );
    return hits.length === 1 ? hits[0].ref : -1;
  };
  const CONTENTS = String.raw`<span\s+className="contents"\s+(?<ref>ref=\{captureHeldRef\})>\s*`;
  const placements = [
    [
      captureAt(
        String.raw`<div\s+(?<ref>ref=\{scrollerCaptureRef\})\s+className="min-h-0 flex-1 overflow-auto">\s*(?<child>\{previewOn\b)`,
        "{previewOn",
        "ref={scrollerCaptureRef}",
      ),
      "the text scroller is a capture node",
    ],
    [
      captureAt(
        String.raw`${CONTENTS}(?<child><MarkdownDocPreview\b)`,
        "<MarkdownDocPreview",
      ),
      "the Preview body renders inside a capture node",
    ],
    [
      captureAt(
        String.raw`${CONTENTS}(?<child><MarkdownViewToggle\b)`,
        "<MarkdownViewToggle",
      ),
      "the view toggle renders inside a capture node",
    ],
    [
      // The lazy run stops at the picker wrapper's own close, so the capture
      // span wraps both the picker and Unified/Split.
      captureAt(
        String.raw`${CONTENTS}\{\/\*[\s\S]*?\*\/\}\s*(?<child><span\s+ref=\{langWrapRef\})[\s\S]*?<\/span>\s*<DiffModeToggle\b[^>]*\/>\s*<\/span>`,
        "<span",
      ),
      "the language picker and mode toggle render inside a capture node",
    ],
    [
      captureAt(
        String.raw`\{notice\s*!==\s*null\s*&&\s*\(\s*${CONTENTS}(?<child>\{notice\})`,
        "{notice}",
      ),
      "the notice's capture node is placed",
    ],
  ];
  for (const [at, what] of placements) need(at >= 0, what);
  need(
    shellClose > shellOpen &&
      flat(masked.slice(shellOpen, shellClose)).split("{notice}").length ===
        2 &&
      /\{notice!==null&&\(<spanclassName="contents"ref=\{captureHeldRef\}>\{notice\}<\/span>\)\}/.test(
        flat(surfaceRaw.slice(shellOpen, shellClose)),
      ) &&
      flat(masked.slice(shellOpen, shellClose)).includes(
        "ref={captureHeldRef}>{notice}</span>",
      ),
    "the shell's notice renders inside a capture node",
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

test("diff shell: every arm returns through the shell, each data arm with its notice", () => {
  assert.deepEqual(
    diffShellViolations(read(SURFACE), read(IMAGE), read(PATH_ROW)),
    [],
  );
});

test("diff shell: negative controls trip the pin named beside them", () => {
  const surface = read(SURFACE);
  const image = read(IMAGE);
  const row = read(PATH_ROW);
  const caught = (s, i, pin, r = row) => {
    const got = diffShellViolations(s, i, r);
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
    surface,
    image,
    "DiffPathRow renders one path-row literal",
    swap(row, 'gap-2 border-b px-3 py-1.5"', 'gap-2"'),
  );
  // The shell drawing its own row again instead of DiffPathRow.
  caught(
    swap(
      surface,
      "      <DiffPathRow\n        filePath={filePath}",
      '      <div className="border-b px-3 py-1.5" />\n      <DiffPathRow\n        filePath={filePath}',
    ),
    image,
    "DiffContent renders one DiffPathRow",
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
    "DiffContent renders one DiffPathRow",
  );
  caught(
    swap(
      surface,
      '<div key="arm-image" className="min-h-0 flex-1">',
      '<div key="arm-image" className="min-h-0 flex-1">\n<DiffPathRow filePath={filePath} />',
    ),
    image,
    "DiffContent renders one DiffPathRow",
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
    swap(
      surface,
      "controlsRef={controlsRef}",
      "data-x={0} /* controlsRef={controlsRef} */",
    ),
    image,
    "the controls cluster's focus landing renders in the shell",
  );
  caught(
    surface,
    image,
    "DiffPathRow's controls cluster carries the focus landing ref",
    swap(row, "ref={controlsRef}", "data-x={0} /* ref={controlsRef} */"),
  );
  // The Preview rescue running first again.
  caught(
    swap(
      surface,
      "  useFocusOnControlsSwap(showsToolbar, armRescueRef);\n  useFocusOnControlsSwap(previewOn, previewRescueRef);",
      "  useFocusOnControlsSwap(previewOn, previewRescueRef);\n  useFocusOnControlsSwap(showsToolbar, armRescueRef);",
    ),
    image,
    "the toolbar's focus rescue runs before the Preview rescue",
  );
  // The held-focus gate: either rescue ungated, displaced or re-depped.
  const GATE_WRITE =
    "    prevSwapRef.current = { path: filePath, toolbar: showsToolbar };\n";
  const HELD_READ = "    const held = paneHeldFocus.current;\n";
  const RESET = "    paneHeldFocus.current = false;\n";
  caught(
    swap(
      surface,
      "armRescueRef.current = held\n      ? (armLandingRef.current ?? controlsRef.current)\n      : null;",
      "armRescueRef.current = armLandingRef.current ?? controlsRef.current;",
    ),
    image,
    "the toolbar rescue derives from the held record",
  );
  // The image arm's held focus falling to <body> again.
  caught(
    swap(
      surface,
      "      ? (armLandingRef.current ?? controlsRef.current)\n",
      "      ? armLandingRef.current\n",
    ),
    image,
    "the toolbar rescue derives from the held record",
  );
  caught(
    swap(
      surface,
      "useFocusOnControlsSwap(showsToolbar, armRescueRef);",
      "useFocusOnControlsSwap(showsToolbar, armLandingRef);",
    ),
    image,
    "the toolbar's focus rescue runs before the Preview rescue",
  );
  caught(
    swap(surface, `${RESET}  });`, `${RESET}  }, []);`),
    image,
    "the held-focus gate takes no dependency array",
  );
  caught(
    swap(
      swap(
        surface,
        "  });\n  useFocusOnControlsSwap(showsToolbar, armRescueRef);\n",
        "  });\n",
      ),
      `  useLayoutEffect(() => {\n${HELD_READ}`,
      `  useFocusOnControlsSwap(showsToolbar, armRescueRef);\n  useLayoutEffect(() => {\n${HELD_READ}`,
    ),
    image,
    "the held-focus gate is declared ahead of both swap rescues",
  );
  caught(
    swap(
      surface,
      "previewRescueRef.current =\n      held || sameToolbarFile ? controlsRef.current : null;",
      "previewRescueRef.current = controlsRef.current;",
    ),
    image,
    "the Preview rescue derives from the held record or a same-file toggle",
  );
  caught(
    swap(
      surface,
      "prevSwapRef.current.toolbar &&\n      prevSwapRef.current.path === filePath;",
      "prevSwapRef.current.toolbar;",
    ),
    image,
    "the Preview rescue derives from the held record or a same-file toggle",
  );
  caught(
    swap(
      surface,
      "useFocusOnControlsSwap(previewOn, previewRescueRef);",
      "useFocusOnControlsSwap(previewOn, controlsRef);",
    ),
    image,
    "the toolbar's focus rescue runs before the Preview rescue",
  );
  caught(
    swap(swap(surface, GATE_WRITE, ""), HELD_READ, `${HELD_READ}${GATE_WRITE}`),
    image,
    "the Preview rescue's previous-commit record is written once, after its read",
  );
  caught(
    swap(surface, GATE_WRITE, ""),
    image,
    "the Preview rescue's previous-commit record is written once, after its read",
  );
  // The record taken outside a ref cleanup, or unguarded.
  caught(
    swap(
      surface,
      HELD_READ,
      `    paneHeldFocus.current =\n      armLandingRef.current?.contains(document.activeElement) === true;\n${HELD_READ}`,
    ),
    image,
    "focus is read and recorded only in ref cleanups",
  );
  caught(
    swap(
      surface,
      "      if (node !== null && node.contains(document.activeElement))\n        paneHeldFocus.current = true;",
      "      paneHeldFocus.current = true;",
    ),
    image,
    "the held record is written in a guarded ref cleanup",
  );
  // A lost capture node, or a record that is never or too early consumed.
  caught(
    swap(
      surface,
      '<div ref={scrollerCaptureRef} className="min-h-0 flex-1 overflow-auto">',
      '<div className="min-h-0 flex-1 overflow-auto">',
    ),
    image,
    "five capture nodes carry captureHeldRef",
  );
  // The merged ref dropping the capture's cleanup, or its stable identity.
  caught(
    swap(surface, "        capture();\n", ""),
    image,
    "the scroller's merged ref runs the capture's cleanup",
  );
  caught(
    swap(
      surface,
      "    [captureHeldRef],\n",
      "    [captureHeldRef, filePath],\n",
    ),
    image,
    "the scroller's merged ref runs the capture's cleanup",
  );
  caught(
    swap(
      surface,
      '<span className="contents" ref={captureHeldRef}>\n          {notice}',
      '<span className="contents">\n          {notice}',
    ),
    image,
    "the shell's notice renders inside a capture node",
  );
  caught(
    swap(surface, RESET, ""),
    image,
    "the held-focus gate consumes the record",
  );
  caught(
    swap(swap(surface, RESET, ""), HELD_READ, `${RESET}${HELD_READ}`),
    image,
    "the held record is consumed after its one read",
  );
  // A capture ref moved to another node: the count holds at five, the
  // placement trips.
  const unref = (raw, from) =>
    swap(raw, from, from.replace(" ref={captureHeldRef}", ""));
  caught(
    unref(
      surface,
      '<span className="contents" ref={captureHeldRef}>\n            <MarkdownDocPreview',
    ),
    image,
    "five capture nodes carry captureHeldRef",
  );
  caught(
    swap(
      swap(
        surface,
        '<div ref={scrollerCaptureRef} className="min-h-0 flex-1 overflow-auto">',
        '<div className="min-h-0 flex-1 overflow-auto">',
      ),
      '<InfoNote className="shrink-0">',
      '<InfoNote ref={scrollerCaptureRef} className="shrink-0">',
    ),
    image,
    "the text scroller is a capture node",
  );
  caught(
    swap(
      unref(
        surface,
        '<span className="contents" ref={captureHeldRef}>\n            <MarkdownDocPreview',
      ),
      '<div className="border-b">\n                <ImagePanes',
      '<div ref={captureHeldRef} className="border-b">\n                <ImagePanes',
    ),
    image,
    "the Preview body renders inside a capture node",
  );
  caught(
    swap(
      unref(
        surface,
        '<span className="contents" ref={captureHeldRef}>\n            <MarkdownViewToggle',
      ),
      '<span className="sr-only">(truncated',
      '<span className="sr-only" ref={captureHeldRef}>(truncated',
    ),
    image,
    "the view toggle renders inside a capture node",
  );
  caught(
    swap(
      unref(
        surface,
        '<span className="contents" ref={captureHeldRef}>\n            {/* The only variable-width',
      ),
      '<span aria-hidden className="hidden shrink-0 @2xl/diff-pane:inline">',
      '<span aria-hidden ref={captureHeldRef} className="hidden shrink-0 @2xl/diff-pane:inline">',
    ),
    image,
    "the language picker and mode toggle render inside a capture node",
  );
  // The record written from outside its two writers, by any right-hand side.
  caught(
    swap(
      surface,
      "  useFocusOnControlsSwap(showsToolbar, armRescueRef);\n",
      "  paneHeldFocus.current = Boolean(armLandingRef.current);\n  useFocusOnControlsSwap(showsToolbar, armRescueRef);\n",
    ),
    image,
    "the held record has exactly two writes",
  );
  caught(
    swap(
      surface,
      "    armLandingRef.current = node;\n",
      "    armLandingRef.current = node;\n    paneHeldFocus.current ||= node !== null;\n",
    ),
    image,
    "the held record has exactly two writes",
  );
  caught(
    swap(
      surface,
      "  const paneHeldFocus = useRef(false);\n",
      "  const paneHeldFocus = useRef(false);\n  paneHeldFocus.current = false;\n",
    ),
    image,
    "the held record has exactly two writes",
  );
  // A data arm dropping its notice, or a blank arm taking one: each names its
  // arm.
  const NOTICE_TAIL = ",\n      notice,\n    );\n  }\n";
  for (const [arm, from, to] of [
    ["image", "        </div>,\n        notice,\n", "        </div>,\n"],
    [
      "binary placeholder",
      `      )${NOTICE_TAIL}  if (emptyDiff)`,
      "      ),\n    );\n  }\n  if (emptyDiff)",
    ],
    [
      "empty",
      `      )${NOTICE_TAIL}  // Ahead of the preview arms`,
      "      ),\n    );\n  }\n  // Ahead of the preview arms",
    ],
    [
      "header-only",
      `      )${NOTICE_TAIL}\n  // SVGs are text`,
      "      ),\n    );\n  }\n\n  // SVGs are text",
    ],
    ["text", "    </Fragment>,\n    notice,\n", "    </Fragment>,\n"],
  ])
    caught(
      swap(surface, from, to),
      image,
      `the ${arm} arm passes the notice to the shell`,
    );
  caught(
    swap(
      surface,
      "    </Fragment>,\n    notice,\n",
      "    </Fragment>,\n    null,\n",
    ),
    image,
    "the text arm passes the notice to the shell",
  );
  for (const [arm, from, to] of [
    [
      "pending",
      "        : landing(null, true),\n    );",
      "        : landing(null, true),\n      notice,\n    );",
    ],
    [
      "stale-path",
      "return shell(landing(null, true));",
      "return shell(landing(null, true), notice);",
    ],
    [
      "no-data",
      'for this file" />),\n    );',
      'for this file" />),\n      notice,\n    );',
    ],
  ])
    caught(
      swap(surface, from, to),
      image,
      `the ${arm} arm passes the shell no notice`,
    );
  // A ninth arm the pins above don't name.
  caught(
    swap(
      surface,
      "  if (emptyDiff) {\n",
      "  if (narrowPane) return shell(null);\n  if (emptyDiff) {\n",
    ),
    image,
    "every DiffContent return is one of the eight named arms",
  );
  // Fail closed on a component the scan can't find.
  caught(
    swap(surface, "export function DiffContent(", "export function Other("),
    image,
    "DiffContent's body is not found",
  );
});

test("diff shell: the shell and the lazy fallback root on one shared class", () => {
  const USE = "className={DIFF_PANE_ROOT_CLASS}";
  const check = (surface, row) => {
    const problems = [];
    if (
      !/export const DIFF_PANE_ROOT_CLASS =\s*"[^"]*@container\/diff-pane\b[^"]*";/.test(
        row,
      )
    )
      problems.push("DiffPathRow exports the pane-root class");
    if (row.split(USE).length !== 2)
      problems.push("DiffPaneFallback roots on it");
    if (surface.split(USE).length !== 2) problems.push("the shell roots on it");
    if (/@container\/diff-pane flex/.test(surface))
      problems.push("DiffSurface spells no pane-root literal of its own");
    return problems;
  };
  const surface = read(SURFACE);
  const row = read(PATH_ROW);
  assert.deepEqual(check(surface, row), []);
  // Negative controls: either side drifting onto its own literal is caught.
  const literal =
    'className="ph-no-capture @container/diff-pane flex h-full flex-col"';
  assert.equal(surface.split(USE).length, 2);
  assert.notDeepEqual(
    check(
      surface.replace(USE, () => literal),
      row,
    ),
    [],
  );
  assert.equal(row.split(USE).length, 2);
  assert.notDeepEqual(
    check(
      surface,
      row.replace(USE, () => literal),
    ),
    [],
  );
});

/** What the binary arm's `<BinaryFileSummary>` must be handed: the placeholder
 *  flag as `held` (no lookup on another read's ids), the working-tree side
 *  from the image revs, the surface's anchor commit, and a mount only with a
 *  repo. */
function binaryArmViolations(surfaceRaw) {
  const masked = maskNonCode(surfaceRaw, true);
  const at = masked.indexOf("if (data.isBinary) {");
  if (at < 0) return ["the binary arm is not found"];
  const open = masked.indexOf("{", at);
  const close = matchBrace(masked, open);
  const tags = [...masked.slice(open, close).matchAll(/<BinaryFileSummary\b/g)];
  if (tags.length !== 1 || masked.split("<BinaryFileSummary").length !== 2)
    return ["the binary arm renders the file's one BinaryFileSummary"];
  const from = open + tags[0].index;
  const end = masked.indexOf("/>", from);
  const attrs = flat(surfaceRaw.slice(from, end));
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };
  need(
    attrs.includes("held={dataIsPlaceholder===true}"),
    "held is the placeholder flag",
  );
  need(
    attrs.includes("worktreeNewSide={imageRevs?.new===null}"),
    "worktreeNewSide reads the image revs' new side",
  );
  need(
    attrs.includes("anchorCommit={anchorCommit}"),
    "anchorCommit passes through",
  );
  need(
    flat(surfaceRaw.slice(open, from)).endsWith("repoPath!==undefined?(") &&
      attrs.includes("repoPath={repoPath}"),
    "the summary mounts only with a repo path",
  );
  return problems;
}

test("diff shell: the binary arm wires BinaryFileSummary's gates", () => {
  const surface = read(SURFACE);
  assert.deepEqual(binaryArmViolations(surface), []);
  const swap = (from, to) => {
    assert.ok(
      surface.includes(from),
      `negative-control anchor missing: ${from}`,
    );
    return surface.replace(from, () => to);
  };
  for (const [what, from, to] of [
    ["held is the placeholder flag", "held={dataIsPlaceholder === true}", ""],
    [
      "worktreeNewSide reads the image revs' new side",
      "worktreeNewSide={imageRevs?.new === null}",
      "worktreeNewSide={imageRevs?.new !== null}",
    ],
    ["anchorCommit passes through", "anchorCommit={anchorCommit}", ""],
    [
      "the summary mounts only with a repo path",
      "repoPath !== undefined ? (\n              <BinaryFileSummary",
      "(\n              <BinaryFileSummary",
    ],
  ]) {
    const got = binaryArmViolations(swap(from, to));
    assert.ok(
      got.includes(what),
      `expected "${what}", got ${JSON.stringify(got)}`,
    );
  }
});
