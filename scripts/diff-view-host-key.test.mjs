// Pins the diff panes' library-view and line-anchor wiring. It reads src/
// (outside src/test/ and src/components/ui/) line by line, comments and
// strings masked, in the form Biome writes it (CI runs `biome ci` over src/,
// which this suite relies on and does not check); a pinned shape spelled
// outside that form FAILS:
//   T1 every `<DiffView` / `<DiffViewWithMultiSelect` open tag starts its line,
//      and one of its own attributes is exactly one of `HOST_KEYS`, a key on
//      the retained build every host names `diffFile`: the library clears its
//      on-screen clone during render when the source changes, so a view React
//      keeps across a discarded render repaints in the light theme. A tag that
//      spans lines owns the attribute lines indented one step past it, up to
//      the `>` or `/>` line at its own indent; a one-line tag owns its
//      attributes only when every value is quoted or a brace group with no
//      brace inside, so no element nested in a value can lend it one;
//   T2 every `useModeLineAnchor(` call is the whole initializer of a `const`
//      whose pattern has an element written exactly `mark`: the text before it
//      ends `const { ... } = ` and its closing parenthesis is followed by `;`.
//      A line after that parenthesis's line, before the first line indented
//      less than that binding, is exactly `{mark}`, in a `.tsx` file, so a
//      switch reads the line in its commit (a `{mark}` inside the call's
//      arguments never counts). Biome writes no other statement, attribute
//      or type that way; a mark on a line with anything else or under
//      another name fails, and so does any `useModeLineAnchor` that is not
//      such a call, its `function` definition or a plain import specifier.
//      This is the fast tripwire; src/test/diff-white-flash.test.tsx proves
//      each caller's mark reads its scroller's line exactly once on a switch,
//      one case per caller in its describe `CALLER_CASES`, and the number of
//      callers T2 reads must equal that number of cases, each written
//      `it(title, fn)` or `test(title, fn)` inside a describe written
//      `describe(title, fn)` (a modifier, an options object or a timeout on a
//      case or on the describe, a nested describe, or the describe not found
//      exactly once FAILS);
//   T3 every file whose code names both `lineKeeper` and `restore` renders a
//      `<SnapshotMark` (read as T1 reads a host tag) with an own attribute
//      that is exactly a zero-argument arrow calling `lineKeeper`'s `.read()`
//      and nothing else; a file naming both for another reason FAILS;
//   T4 an unreadable file, a spanning tag with no end, and an empty roster for
//      any of the three each FAIL;
//   T5 DiffSurface.tsx imports `Assert` and `IsData` from ./held-data and
//      declares `Assert<IsData<DiffLineAnchor>>` and `Assert<IsData<ArmPaint>>`
//      on code lines, so `tsc -b` still proves the held types carry data only
//      (src/test/held-data.test.ts holds that proof's controls), and its raw
//      text names no `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` (in any
//      case, a string or comment included), which could silence those lines;
//      the file unread or unreadable FAILS.
// Out of its sight: the library components imported under another name, a
// `key` arriving through a spread, a `diffFile` that names something other
// than the retained build, a keeper restored in a file that never names
// `lineKeeper` or through a string key, and a `{mark}` line inside the
// caller's lines that renders zero or many times, outside the caller's commit
// or under another binding of the name: inside a multi-line JSX prop value, a
// nested component closure, a `.map(() => ...)` callback, a branch not taken,
// or a scope that declares its own `mark`; a per-caller case skipped from
// inside a callback or a hook in its describe (`ctx.skip()`); and a per-caller
// case registered under a condition (`if (...) it(...)`).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = ["src/test/", "src/components/ui/"];

/** Every in-scope source file under src/, as { rel: text }. */
function loadCorpus() {
  const corpus = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (SKIP.some((s) => `${rel}/`.startsWith(s))) continue;
      if (entry.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
        corpus.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(join(ROOT, "src"));
  return corpus;
}

const indentOf = (line) => /^ */.exec(line)[0].length;
const blank = (line) => line.trim() === "";

// A one-line open tag's attributes: each value quoted or a brace group with no
// brace inside. The type arguments carry no space or `=`.
const ONE_LINE_TAG =
  /^(?:<[^=\s]*>)?((?: [\w$-]+(?:="[^"]*"|=\{[^{}]*\})?)*) ?\/?>/;
const ONE_LINE_ATTR = / ([\w$-]+(?:="[^"]*"|=\{[^{}]*\})?)/g;

/** The own attributes of the open tag whose name ends at `col` of line `i`,
 *  each as its trimmed text, or a reason the tag isn't in Biome's form. */
function ownAttrs(lines, i, start, col) {
  if (!blank(lines[i].slice(0, start)))
    return { why: "doesn't start its line" };
  const rest = lines[i].slice(col).trimEnd();
  if (/^(?:<[^=]*>)?$/.test(rest)) {
    const attrs = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (blank(line)) continue;
      const indent = indentOf(line);
      if (indent === start && /^\/?>$/.test(line.trim())) return { attrs };
      if (indent === start + 2) attrs.push(line.trim());
      else if (indent < start + 2) return { why: "isn't in Biome's form" };
    }
    return { why: "has no end" };
  }
  const one = ONE_LINE_TAG.exec(rest);
  if (one === null) return { why: "isn't in Biome's form" };
  return { attrs: [...one[1].matchAll(ONE_LINE_ATTR)].map((m) => m[1]) };
}

const HOST_TAG = /<(DiffViewWithMultiSelect|DiffView)\b/g;
// The accepted host keys, exactly; a key that extends the build's id adds its
// own entry here, scoped to the file whose host draws it (`file` absent = any).
// RenderedDiff's two arms key on the build and the record its rows are for.
const HOST_KEYS = [
  { attr: "key={diffFile.getId()}" },
  {
    attr: "key={viewKey(viewGen, diffFile)}",
    file: "src/features/diff/DiffSurface.tsx",
  },
];
const ANCHOR_CALL = /\buseModeLineAnchor\(/g;
const ANCHOR_NAME = /\buseModeLineAnchor\b/g;
const IMPORT_LIST = /\bimport\s*\{([^}]*)\}\s*from\b/g;

/** Offsets of `useModeLineAnchor` written as a plain import specifier. */
function plainImports(masked) {
  const at = new Set();
  for (const m of masked.matchAll(IMPORT_LIST)) {
    let pos = m.index + m[0].indexOf("{") + 1;
    for (const spec of m[1].split(",")) {
      if (spec.trim() === "useModeLineAnchor")
        at.add(pos + spec.length - spec.trimStart().length);
      pos += spec.length + 1;
    }
  }
  return at;
}
const ANCHOR_DEF = /\bfunction\s+$/;
const MARK_BIND = /\bconst\s*\{([^}]*)\}\s*=\s*$/;
// Names, not a call's spelling: counting an extra site only asks it to render
// the snapshot read.
const KEEPER_NAME = /\blineKeeper\b/;
const RESTORE_NAME = /\brestore\b/;
const KEEPER_READ = /^read=\{\(\) => lineKeeper\??\.current\??\.read\(\)\}$/;
const SURFACE = "src/features/diff/DiffSurface.tsx";
const HELD_IMPORT = 'import type { Assert, IsData } from "./held-data";';
const HELD_TYPES = ["DiffLineAnchor", "ArmPaint"];
const SUPPRESS = /@ts-(?:ignore|expect-error|nocheck)/i;
const NOT_CALLED =
  "useModeLineAnchor is named other than by a call, its definition or a plain import";
const NOT_WHOLE = "useModeLineAnchor's call isn't the whole initializer";

/** T5 over DiffSurface.tsx's text: the import and both held-type asserts. */
function heldAsserts(text, masked) {
  const out = [];
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const code = masked.split("\n").map((l) => l.replace(/\r$/, "").trim());
  if (!lines.some((l, i) => l === HELD_IMPORT && code[i].startsWith("import")))
    out.push(`T5 ${SURFACE}: no \`${HELD_IMPORT}\``);
  for (const name of HELD_TYPES) {
    const line = new RegExp(`^export type [\\w$]+ = Assert<IsData<${name}>>;$`);
    if (!code.some((l) => line.test(l)))
      out.push(`T5 ${SURFACE}: no \`Assert<IsData<${name}>>\` line`);
  }
  // Read raw, so a string or a comment naming one fails too.
  lines.forEach((l, i) => {
    const directive = SUPPRESS.exec(l);
    if (directive !== null)
      out.push(`T5 ${SURFACE}:${i + 1}: \`${directive[0]}\` can silence tsc`);
  });
  return out;
}

// The mutation tests rescan the shipped corpus, whose texts repeat: each text
// is masked once (a throw is not cached, so it recurs on every scan).
const MASKED = [new Map(), new Map()];
function masks(text, jsx) {
  const cache = MASKED[jsx ? 1 : 0];
  if (!cache.has(text)) cache.set(text, maskNonCode(text, jsx));
  return cache.get(text);
}

/** Violations over a corpus. */
export function scan(corpus) {
  return scanCounts(corpus).out;
}

/** Violations over a corpus, and how many `useModeLineAnchor` callers T2 read. */
function scanCounts(corpus) {
  const out = [];
  let tags = 0;
  let callers = 0;
  let restores = 0;
  if (corpus.size === 0) out.push("T4 no source files read");
  if (!corpus.has(SURFACE)) out.push(`T5 ${SURFACE}: not read`);
  for (const [rel, text] of corpus) {
    if (typeof text !== "string" || text.includes("\0")) {
      out.push(`T4 ${rel}: unreadable`);
      if (rel === SURFACE) out.push(`T5 ${SURFACE}: unreadable`);
      continue;
    }
    let masked;
    try {
      masked = masks(text, rel.endsWith(".tsx"));
    } catch (e) {
      out.push(`T4 ${rel}: ${e.message}`);
      continue;
    }
    if (rel === SURFACE) out.push(...heldAsserts(text, masked));
    const lines = masked.split("\n").map((l) => l.replace(/\r$/, ""));
    let snapshotReads = false;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(HOST_TAG)) {
        tags++;
        const at = `${rel}:${i + 1} <${m[1]}>`;
        const own = ownAttrs(lines, i, m.index, m.index + m[0].length);
        if (own.why === "has no end")
          out.push(`T4 ${at}: the open tag has no end`);
        else if (own.why !== undefined)
          out.push(`T1 ${at}: the open tag ${own.why}`);
        else if (
          !own.attrs.some((a) =>
            HOST_KEYS.some(
              (k) => (k.file === undefined || k.file === rel) && k.attr === a,
            ),
          )
        )
          out.push(`T1 ${at}: no key on the retained build (HOST_KEYS)`);
      }
      for (const m of line.matchAll(/<SnapshotMark\b/g)) {
        const own = ownAttrs(lines, i, m.index, m.index + m[0].length);
        if (own.attrs?.some((a) => KEEPER_READ.test(a))) snapshotReads = true;
      }
    });
    for (const m of masked.matchAll(ANCHOR_CALL)) {
      const before = masked.slice(Math.max(0, m.index - 300), m.index);
      if (ANCHOR_DEF.test(before)) continue;
      callers++;
      const at = `T2 ${rel}:${lineOf(text, m.index)}`;
      const bind = MARK_BIND.exec(before);
      if (
        bind === null ||
        !bind[1].split(",").some((element) => element.trim() === "mark")
      ) {
        out.push(`${at}: useModeLineAnchor's result binds no \`mark\``);
        continue;
      }
      const close = matchBrace(masked, m.index + m[0].length - 1);
      if (close === -1 || masked[close + 1] !== ";") {
        out.push(`${at}: ${NOT_WHOLE}`);
        continue;
      }
      const bindLine = lineOf(masked, m.index - before.length + bind.index) - 1;
      const indent = indentOf(lines[bindLine]);
      let rendered = false;
      for (let j = lineOf(masked, close); j < lines.length; j++) {
        if (blank(lines[j])) continue;
        if (indentOf(lines[j]) < indent) break;
        if (lines[j].trim() === "{mark}") rendered = true;
      }
      if (!rendered || !rel.endsWith(".tsx"))
        out.push(`${at}: no line of the caller after the call is \`{mark}\``);
    }
    const imports = plainImports(masked);
    for (const m of masked.matchAll(ANCHOR_NAME)) {
      if (masked[m.index + m[0].length] === "(" || imports.has(m.index))
        continue;
      out.push(`T2 ${rel}:${lineOf(text, m.index)}: ${NOT_CALLED}`);
    }
    if (KEEPER_NAME.test(masked) && RESTORE_NAME.test(masked)) {
      restores++;
      if (!snapshotReads)
        out.push(`T3 ${rel}: no <SnapshotMark> reads the keeper it restores`);
    }
  }
  if (tags === 0) out.push("T4 no library view tags found");
  if (callers === 0) out.push("T4 no useModeLineAnchor callers found");
  if (restores === 0) out.push("T4 no keeper restore sites found");
  return { out, callers };
}

const REAL = loadCorpus();
const VIEWER = "src/features/diff/DiffViewer.tsx";
const IMAGE = "src/features/diff/ImageDiff.tsx";
const KEY = "key={diffFile.getId()}";
const RECORD_KEY = "key={viewKey(viewGen, diffFile)}";
const NO_MARK = "no line of the caller after the call is `{mark}`";
const NO_BIND = "useModeLineAnchor's result binds no `mark`";

/** The corpus with the `nth` occurrence of `from` in `file` replaced. */
function mutate(file, from, to, nth = 0) {
  const text = REAL.get(file);
  assert.ok(text !== undefined, `${file} is in the corpus`);
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(from, at + 1);
    assert.notEqual(at, -1, `occurrence ${nth} of ${from} in ${file}`);
  }
  const next = new Map(REAL);
  next.set(file, text.slice(0, at) + to + text.slice(at + from.length));
  return { corpus: next, line: lineOf(text, at) };
}

/** The T2 violations of a corpus. */
const t2 = (corpus) => scan(corpus).filter((v) => v.startsWith("T2"));

test("diff view hosts: the shipped source passes", () => {
  assert.deepEqual(scan(REAL), []);
});

const HOSTS = [
  [VIEWER, 0, "DiffView", KEY],
  [SURFACE, 0, "DiffViewWithMultiSelect", RECORD_KEY],
  [SURFACE, 1, "DiffView", RECORD_KEY],
];

test("T1: unkeying each host names that host", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus, line } = mutate(file, key, "", nth);
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
    const at = Number(/:(\d+) /.exec(out[0])[1]);
    assert.ok(Math.abs(at - line) < 3, `${out[0]} names line ~${line}`);
  }
});

test("T1: a key on another build's id names that host", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus } = mutate(file, key, "key={builtDiffFile.getId()}", nth);
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
  }
  const { corpus } = mutate(
    SURFACE,
    RECORD_KEY,
    "key={viewKey(viewGen, builtDiffFile)}",
  );
  assert.equal(scan(corpus).filter((v) => v.startsWith("T1")).length, 1);
});

test("T1: the record key counts only on RenderedDiff's arms", () => {
  const { corpus } = mutate(VIEWER, KEY, RECORD_KEY);
  const out = scan(corpus);
  assert.equal(out.length, 1, out.join("\n"));
  assert.match(out[0], new RegExp(`^T1 ${VIEWER}:\\d+ <DiffView>`));
});

test("T1 decoys: a key on a neighbour or in a comment doesn't count", () => {
  const unkeyed = mutate(SURFACE, RECORD_KEY, "", 1).corpus;
  const text = unkeyed.get(SURFACE);
  const neighbour = new Map(unkeyed);
  neighbour.set(
    SURFACE,
    text.replace("<DiffCapFooter", () => `<DiffCapFooter ${RECORD_KEY}`),
  );
  assert.equal(scan(neighbour).filter((v) => v.startsWith("T1")).length, 1);
  const comment = new Map(unkeyed);
  comment.set(
    SURFACE,
    text.replace(
      /<DiffView<AnchorRowData>\r?\n/,
      (m) => `${m}              // ${RECORD_KEY}\n`,
    ),
  );
  assert.notEqual(comment.get(SURFACE), text);
  assert.equal(scan(comment).filter((v) => v.startsWith("T1")).length, 1);
});

test("T1/T3 decoys: a data- attribute spelled like the key or read fails", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus } = mutate(file, key, `data-${key}`, nth);
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
  }
  const from = "read={() => lineKeeper.current?.read()}";
  const { corpus } = mutate(SURFACE, from, `data-${from}`);
  assert.deepEqual(
    scan(corpus).filter((v) => v.startsWith("T3")),
    [`T3 ${SURFACE}: no <SnapshotMark> reads the keeper it restores`],
  );
});

test("T1/T3 decoys: a nested element's key or a later prop's read fails", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const text = REAL.get(file);
    let at = -1;
    for (let i = 0; i <= nth; i++) at = text.indexOf(key, at + 1);
    const pad = /( *)$/.exec(text.slice(0, at))[1];
    for (const value of [
      `renderWidgetLine={() => <div ${key} />}`,
      // An element value, and one spanning lines whose key sits deeper.
      `renderer=<Other ${key} />`,
      `renderer=<Other ${key}>text</Other>`,
      `renderer={\n${pad}  <Other\n${pad}    ${key}\n${pad}  />\n${pad}}`,
    ]) {
      const { corpus } = mutate(file, key, value, nth);
      const out = scan(corpus);
      assert.equal(out.length, 1, `${value}\n${out.join("\n")}`);
      assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
    }
  }
  const from = "read={() => lineKeeper.current?.read()}";
  const { corpus } = mutate(
    SURFACE,
    from,
    "read={() => undefined} onSnap={() => lineKeeper.current?.read()}",
  );
  assert.deepEqual(
    scan(corpus).filter((v) => v.startsWith("T3")),
    [`T3 ${SURFACE}: no <SnapshotMark> reads the keeper it restores`],
  );
});

/** The corpus with one more file, `src/extra.tsx`, holding `body`. */
function withFile(body, rel = "src/extra.tsx") {
  const corpus = new Map(REAL);
  corpus.set(rel, body);
  return corpus;
}

test("T1: a host outside Biome's line form fails closed", () => {
  const at = "T1 src/extra.tsx:2 <DiffView>";
  for (const [body, verdict] of [
    // Mid-line, a key on the same line as another attribute, a one-line tag
    // whose value holds a brace, an attribute line dedented past the tag's.
    [
      `export const v = (\n  ok && <DiffView ${KEY} />\n);\n`,
      `${at}: the open tag doesn't start its line`,
    ],
    [
      `export const v = (\n  <DiffView\n    a={1} ${KEY}\n  />\n);\n`,
      `${at}: no key on the retained build (HOST_KEYS)`,
    ],
    [
      `export const v = (\n  <DiffView a={{ b: 1 }} ${KEY} />\n);\n`,
      `${at}: the open tag isn't in Biome's form`,
    ],
    [
      `export const v = (\n  <DiffView\n    a={1}\n  ${KEY}\n  />\n);\n`,
      `${at}: the open tag isn't in Biome's form`,
    ],
  ])
    assert.deepEqual(
      scan(withFile(body)).filter((v) => v.startsWith("T1")),
      [verdict],
      body,
    );
  // A one-line tag in Biome's form passes, its own key read.
  assert.deepEqual(
    scan(
      withFile(
        `export const v = (\n  <DiffView a="x" ${KEY} b={c(d)} />\n);\n`,
      ),
    ),
    [],
  );
});

test("T2: dropping each caller's mark names it", () => {
  for (const file of [SURFACE, VIEWER]) {
    const { corpus } = mutate(file, "{mark}", "{null}");
    const out = t2(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.ok(
      out[0].startsWith(`T2 ${file}:`) && out[0].endsWith(`: ${NO_MARK}`),
      out[0],
    );
  }
});

test("T2 decoy: a mark bound and never rendered fails", () => {
  const { corpus } = mutate(VIEWER, "{mark}", "");
  assert.equal(t2(corpus).length, 1);
});

test("T2 decoy: a `{mark}` line inside the call's arguments never counts", () => {
  // The shipped viewer's last argument turned into a closure returning JSX
  // with a `{mark}` child, its rendered mark dropped.
  const viewer = REAL.get(VIEWER);
  const eol = viewer.includes("\r\n") ? "\r\n" : "\n";
  const lines = (...l) => l.join(eol);
  const arg = lines("    deferredPath,", "    diffFile,", "  );");
  assert.equal(viewer.split(arg).length, 2, "the viewer's call arguments");
  assert.equal(viewer.split("{mark}").length, 2, "the viewer's mark");
  const closure = lines(
    "    deferredPath,",
    "    () => (",
    "      <div>",
    "        {mark}",
    "      </div>",
    "    ),",
    "  );",
  );
  const decoyed = viewer
    .replace("{mark}", () => "{null}")
    .replace(arg, () => closure);
  const call = viewer.indexOf("const { mark } = useModeLineAnchor(");
  assert.deepEqual(t2(withFile(decoyed, VIEWER)), [
    `T2 ${VIEWER}:${lineOf(viewer, call)}: ${NO_MARK}`,
  ]);
  // The same closure with the mark still rendered after the call passes.
  assert.deepEqual(
    scan(
      withFile(
        viewer.replace(arg, () => closure),
        VIEWER,
      ),
    ),
    [],
  );
});

const CALL = 'useModeLineAnchor(undefined, "split", "a.ts", null)';
/** A file with one caller whose body is `body` (`mark` bound before it),
 *  and the line of its call. */
function caller(body, bind = "{ mark }") {
  const text = `export function Caller() {\n  const ${bind} = ${CALL};\n${body}\n}\n`;
  return { corpus: withFile(text), at: "T2 src/extra.tsx:2" };
}

test("T2: a mark on its own child line counts under any parent", () => {
  for (const open of [
    "<Wrapper<Row>>",
    "<Wrapper<{ id: string }>>",
    "<Wrapper<Map<string, Row>>>",
    "<Ns.Wrapper<Row> a={1}>",
    "<>",
  ]) {
    const close = `</${/^<([\w.]*)/.exec(open)[1]}>`;
    const { corpus } = caller(
      `  return (\n    ${open}\n      {mark}\n    ${close}\n  );`,
    );
    assert.deepEqual(scan(corpus), [], open);
  }
});

test("T2: every other spelling fails closed, by meaning", () => {
  for (const use of [
    // Rendered, but not on a line of its own: Biome's one-line JSX.
    "  return <div>{mark}</div>;",
    "  return <Wrapper<Row>>{mark}</Wrapper>;",
    // A contextual `of` before a type argument list, then a block.
    "  function finish(): of<Wrapper<Row>> {mark} {paint()}\n  return null;",
    // An attribute value, on the tag's line or on a line of its own.
    "  return <div a={mark} />;",
    "  return (\n    <div\n      a={mark}\n    />\n  );",
    // A block statement, on one line or as Biome writes it.
    "  if (flag) {} {mark} {paint()}\n  return null;",
    "  if (flag) {\n    mark;\n  }\n  return null;",
    // Named in a comment, a string, an object or an effect.
    "  // {mark}\n  return null;",
    '  return "{mark}";',
    "  const kept = { mark };\n  return kept;",
    "  useEffect(() => {\n    mark;\n  });\n  return null;",
    // Spaced inside the braces, which Biome would never leave.
    "  return (\n    <div>\n      { mark }\n    </div>\n  );",
  ]) {
    const { corpus, at } = caller(use);
    assert.deepEqual(t2(corpus), [`${at}: ${NO_MARK}`], use);
  }
});

test("T2: a binding other than a literal `mark` fails closed", () => {
  const body = "  return (\n    <div>\n      {mark}\n    </div>\n  );";
  for (const bind of [
    "{ mark: m }",
    "{ mark: $m }",
    "{ keepLine }",
    "anchor",
  ]) {
    const { corpus, at } = caller(body, bind);
    assert.deepEqual(t2(corpus), [`${at}: ${NO_BIND}`], bind);
  }
  // Several elements, one per line as Biome wraps them, still bind it.
  const { corpus } = caller(body, "{\n    keepLine,\n    mark,\n  }");
  assert.deepEqual(scan(corpus), []);
});

test("T2: only the caller's own function counts", () => {
  // The mark line sits in the next function, after the caller's closing brace.
  const text = `export function Caller() {\n  const { mark } = ${CALL};\n  return null;\n}\nexport function Other() {\n  return (\n    <div>\n      {mark}\n    </div>\n  );\n}\n`;
  assert.deepEqual(t2(withFile(text)), [`T2 src/extra.tsx:2: ${NO_MARK}`]);
  // A second caller in the shipped corpus is judged on its own lines.
  const second = new Map(REAL);
  const viewer = REAL.get(VIEWER);
  second.set(
    VIEWER,
    `${viewer}\nexport function SecondCaller() {\n  const { mark } = ${CALL};\n  return <div />;\n}\n`,
  );
  assert.deepEqual(t2(second), [
    `T2 ${VIEWER}:${lineOf(viewer, viewer.length) + 2}: ${NO_MARK}`,
  ]);
});

test("T2: a `.ts` file renders no JSX", () => {
  const text = `export function f() {\n  const { mark } = ${CALL};\n  return (\n    <Row>\n      {mark}\n  );\n}\n`;
  assert.deepEqual(t2(withFile(text, "src/lib/asserted-mark.ts")), [
    `T2 src/lib/asserted-mark.ts:2: ${NO_MARK}`,
  ]);
});

test("T2: the hook named other than by a call, its definition or a plain import fails closed", () => {
  const good = `  const { mark } = ${CALL};\n  return (\n    <div>\n      {mark}\n    </div>\n  );`;
  for (const [text, line] of [
    // An aliased import, whose calls T2 would never see.
    [
      `import { useModeLineAnchor as useAnchor } from "./x";\nexport function C() {\n  const { mark } = useAnchor(undefined, "split", "a.ts", null);\n  return null;\n}\n`,
      1,
    ],
    // A reference stored, passed on or re-exported.
    [
      `export function C() {\n  const hook = useModeLineAnchor;\n${good}\n}\n`,
      2,
    ],
    [`export function C() {\n  register(useModeLineAnchor);\n${good}\n}\n`, 2],
    [`export { useModeLineAnchor } from "./x";\n`, 1],
    [`import type { useModeLineAnchor } from "./x";\n`, 1],
  ])
    assert.deepEqual(
      t2(withFile(text)),
      [`T2 src/extra.tsx:${line}: ${NOT_CALLED}`],
      text,
    );
  // A plain specifier, on one line or as Biome wraps a list, passes.
  for (const imports of [
    'import { a, useModeLineAnchor } from "./x";',
    'import {\n  a,\n  useModeLineAnchor,\n} from "./x";',
  ])
    assert.deepEqual(
      scan(withFile(`${imports}\nexport function C() {\n${good}\n}\n`)),
      [],
      imports,
    );
});

test("T2: a call that isn't the whole initializer fails closed", () => {
  const mark = "  return (\n    <div>\n      {mark}\n    </div>\n  );";
  /** A caller whose call to the hook ends with `tail` instead of `;`. */
  const ending = (call, tail) =>
    withFile(
      `export function Caller() {\n  const { mark } = ${call}${tail}\n${mark}\n}\n`,
    );
  for (const tail of [
    " && { mark: null };",
    " ?? { mark: null };",
    " || fallback;",
    " as Anchor;",
    "!;",
    ".other;",
    ",\n    other = 1;",
    " && {\n    mark: null,\n  };",
    "",
  ])
    assert.deepEqual(
      t2(ending(CALL, tail)),
      [`T2 src/extra.tsx:2: ${NOT_WHOLE}`],
      JSON.stringify(tail),
    );
  // The shipped viewer's call with its result discarded.
  const viewer = REAL.get(VIEWER);
  const start = viewer.indexOf("const { mark } = useModeLineAnchor(");
  const call = viewer.slice(start, viewer.indexOf(");", start) + 2);
  const { corpus, line } = mutate(
    VIEWER,
    call,
    call.replace(/\);$/, () => ") && { mark: null };"),
  );
  assert.deepEqual(t2(corpus), [`T2 ${VIEWER}:${line}: ${NOT_WHOLE}`]);
  // Arguments holding parentheses, strings and regexes keep the call whole.
  for (const whole of [
    "useModeLineAnchor(ref, mode)",
    "useModeLineAnchor(\n    ref,\n    mode,\n    path,\n    build,\n  )",
    'useModeLineAnchor(ref, pick(mode), "a)b", { k: [1] }, () => fn())',
    "useModeLineAnchor(ref, /\\)/.test(x), `${a})`)",
    "useModeLineAnchor(ref, a ? (b) : (c), [d(e)])",
  ])
    assert.deepEqual(scan(ending(whole, ";")), [], whole);
});

const FLASH = "src/test/diff-white-flash.test.tsx";
const CALLER_CASES =
  'describe("each useModeLineAnchor caller reads its line once on a switch"';

/** The plain `it(` / `test(` cases in the white-flash test's per-caller
 *  describe, or why that block can't be counted. */
export function callerCases(text) {
  const at = text.indexOf(CALLER_CASES);
  if (at === -1 || text.indexOf(CALLER_CASES, at + 1) !== -1)
    return "the per-caller describe isn't written exactly once";
  let masked;
  try {
    masked = maskNonCode(text, true);
  } catch (e) {
    return e.message;
  }
  const close = matchBrace(masked, at + "describe".length);
  if (close === -1) return "the per-caller describe has no end";
  if (!plainCase(masked.slice(at + "describe(".length, close)))
    return DESCRIBE_FORM;
  const body = masked.slice(at + CALLER_CASES.length, close);
  if (/(?<![\w.$])(?:it|test|describe)\s*\./.test(body))
    return "a case is written with a modifier";
  if (/(?<![\w.$])describe\s*\(/.test(body))
    return "the per-caller describe nests another";
  const cases = [...body.matchAll(/(?<![\w.$])(?:it|test)\s*\(/g)];
  for (const c of cases) {
    const open = c.index + c[0].length - 1;
    const end = matchBrace(body, open);
    if (end === -1 || !plainCase(body.slice(open + 1, end))) return CASE_FORM;
  }
  return cases.length;
}

const DESCRIBE_FORM =
  "the per-caller describe isn't written `describe(title, fn)` (an options object or a timeout rides it): write it in that form, never skip it";

const CASE_FORM =
  "a case isn't written `it(title, fn)` or `test(title, fn)` (an options object or a timeout rides it): write it in that form, or delete it rather than skip it";

/** Whether a case's masked argument text is exactly a string title and a
 *  function, so no options object (`{ skip: true }`) or timeout rides it. */
function plainCase(args) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    if ("([{".includes(args[i])) depth++;
    else if (")]}".includes(args[i])) depth--;
    else if (args[i] === "," && depth === 0) {
      parts.push(args.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = args.slice(from).trim();
  if (last !== "") parts.push(last);
  return (
    parts.length === 2 &&
    /^(["'`])[^"'`]*\1$/.test(parts[0]) &&
    /^(?:async\s+)?(?:\([^()]*\)\s*=>|function\b)/.test(parts[1])
  );
}

test("T2: the callers T2 reads match the white-flash test's per-caller cases", () => {
  const text = readFileSync(join(ROOT, FLASH), "utf8").replace(/\r\n/g, "\n");
  const cases = callerCases(text);
  assert.equal(typeof cases, "number", String(cases));
  assert.equal(scanCounts(REAL).callers, cases);
  // A third caller with no case of its own.
  const { corpus } = caller("  return <>\n    {mark}\n  </>;");
  assert.deepEqual(scan(corpus), []);
  assert.equal(scanCounts(corpus).callers, cases + 1);
  // A case dropped, renamed with a modifier, or the describe retitled.
  const first = text.indexOf('  it("RenderedDiff"');
  assert.notEqual(first, -1);
  const end = text.indexOf("\n  });\n", first) + "\n  });\n".length;
  assert.equal(callerCases(text.slice(0, first) + text.slice(end)), cases - 1);
  assert.equal(
    callerCases(
      text.replace('  it("RenderedDiff"', () => '  it.skip("RenderedDiff"'),
    ),
    "a case is written with a modifier",
  );
  assert.equal(
    callerCases(
      text.replace("caller reads its line once", () => "caller reads"),
    ),
    "the per-caller describe isn't written exactly once",
  );
  // A case carrying an options object or a timeout, which can skip it.
  const staging = '  it("the staging viewer", async';
  assert.equal(text.split(staging).length, 2, staging);
  for (const options of ["{ skip: true }", "{ todo: true }", "{ only: true }"])
    assert.equal(
      callerCases(
        text.replace(
          staging,
          () => `  it("the staging viewer", ${options}, async`,
        ),
      ),
      CASE_FORM,
      options,
    );
  const caseEnd = text.slice(0, end).lastIndexOf("  });\n");
  assert.equal(
    callerCases(
      `${text.slice(0, caseEnd)}  }, 10_000);\n${text.slice(caseEnd + "  });\n".length)}`,
    ),
    CASE_FORM,
  );
  // The describe itself carrying an options object or a timeout, which skips
  // every case in it.
  const head = `${CALLER_CASES}, () => {`;
  assert.equal(text.split(head).length, 2, head);
  for (const options of ["{ skip: true }", "{ todo: true }"])
    assert.equal(
      callerCases(
        text.replace(head, () => `${CALLER_CASES}, ${options}, () => {`),
      ),
      DESCRIBE_FORM,
      options,
    );
  const describeEnd = text.indexOf("\n});\n", text.indexOf(head));
  assert.notEqual(describeEnd, -1);
  assert.equal(
    callerCases(
      `${text.slice(0, describeEnd)}\n}, 10_000);\n${text.slice(describeEnd + "\n});\n".length)}`,
    ),
    DESCRIBE_FORM,
  );
});

test("T3: dropping each keeper site's SnapshotMark fails", () => {
  for (const [file, from] of [
    [SURFACE, "read={() => lineKeeper.current?.read()}"],
    [IMAGE, "read={() => lineKeeper?.current?.read()}"],
  ]) {
    const { corpus } = mutate(file, from, "read={() => undefined}");
    assert.deepEqual(
      scan(corpus).filter((v) => v.startsWith("T3")),
      [`T3 ${file}: no <SnapshotMark> reads the keeper it restores`],
    );
  }
});

test("T3 decoys: a read that isn't the snapshot's own call fails", () => {
  for (const [file, from, call] of [
    [SURFACE, "read={() => lineKeeper.current?.read()}", "lineKeeper.current"],
    [IMAGE, "read={() => lineKeeper?.current?.read()}", "lineKeeper?.current"],
  ])
    for (const value of [
      // A snapshot calls the outer function only.
      `{() => () => ${call}?.read()}`,
      // The call runs at render, not at the snapshot.
      `{${call}?.read()}`,
      `{() => undefined && ${call}?.read()}`,
      `{() => { void ${call}?.read(); }}`,
    ]) {
      const { corpus } = mutate(file, from, `read=${value}`);
      assert.deepEqual(
        scan(corpus).filter((v) => v.startsWith("T3")),
        [`T3 ${file}: no <SnapshotMark> reads the keeper it restores`],
        value,
      );
    }
});

test("T3: a restore spelled any way is a site, by the names alone", () => {
  const text = REAL.get(IMAGE);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const restore = "lineKeeper?.current?.restore();";
  const read = "read={() => lineKeeper?.current?.read()}";
  const drop = [`T3 ${IMAGE}: no <SnapshotMark> reads the keeper it restores`];
  for (const spelling of [
    "lineKeeper?.current?.restore?.();",
    "lineKeeper!.current!.restore();",
    `lineKeeper?.current${eol}      ?.restore();`,
    `const { restore } = lineKeeper?.current ?? {};${eol}    restore?.();`,
    `const keeper = lineKeeper?.current;${eol}    keeper?.restore();`,
    "lineKeeper?.current?.restore.call(null);",
  ]) {
    assert.equal(text.split(restore).length, 2, restore);
    const respelled = text.replace(restore, () => spelling);
    const kept = withFile(respelled, IMAGE);
    assert.deepEqual(scan(kept), [], `${spelling} with the read`);
    const unread = withFile(
      respelled.replace(read, () => "read={() => undefined}"),
      IMAGE,
    );
    assert.deepEqual(
      scan(unread).filter((v) => v.startsWith("T3")),
      drop,
      spelling,
    );
  }
  // A file that only hands the keeper on is no site.
  const handsOn =
    "export const v = (\n  <Child lineKeeper={lineKeeper} />\n);\n";
  assert.deepEqual(scan(withFile(handsOn)), []);
  // Fails closed: the keeper named beside an unrelated `restore`.
  const unrelated =
    "export function C({ lineKeeper, restore }) {\n  return null;\n}\n";
  assert.deepEqual(
    scan(withFile(unrelated)).filter((v) => v.startsWith("T3")),
    ["T3 src/extra.tsx: no <SnapshotMark> reads the keeper it restores"],
  );
});

test("T4: empty rosters, unreadable files and open tags fail closed", () => {
  assert.ok(scan(new Map()).includes("T4 no source files read"));
  const none = new Map([["src/a.ts", "export const a = 1;\n"]]);
  assert.deepEqual(scan(none), [
    `T5 ${SURFACE}: not read`,
    "T4 no library view tags found",
    "T4 no useModeLineAnchor callers found",
    "T4 no keeper restore sites found",
  ]);
  const binary = new Map(REAL);
  binary.set("src/b.ts", "a\0b");
  assert.ok(scan(binary).includes("T4 src/b.ts: unreadable"));
  const open = new Map(REAL);
  open.set("src/c.tsx", "export const c = <DiffView diffFile={x}");
  // The masker refuses the unterminated tag before the tag scan reads it.
  assert.ok(scan(open).some((v) => v.startsWith("T4 src/c.tsx")));
  // A spanning tag that reaches the end of its file.
  const endless = withFile(`export const v = (\n  <DiffView\n    ${KEY}\n`);
  assert.ok(scan(endless).some((v) => v.startsWith("T4 src/extra.tsx")));
});

test("T5: each held-type assert and the import are pinned", () => {
  const text = REAL.get(SURFACE);
  for (const name of HELD_TYPES) {
    const line = new RegExp(
      `^export type [\\w$]+ = Assert<IsData<${name}>>;\\r?$`,
      "m",
    );
    const found = line.exec(text);
    assert.ok(found, name);
    for (const to of ["", `// ${found[0]}`, `/*\n${found[0]}\n*/`]) {
      const { corpus } = mutate(SURFACE, found[0], to);
      assert.deepEqual(
        scan(corpus),
        [`T5 ${SURFACE}: no \`Assert<IsData<${name}>>\` line`],
        `${name} -> ${JSON.stringify(to)}`,
      );
    }
  }
  const { corpus } = mutate(SURFACE, HELD_IMPORT, `// ${HELD_IMPORT}`);
  assert.deepEqual(scan(corpus), [`T5 ${SURFACE}: no \`${HELD_IMPORT}\``]);
  const missing = new Map(REAL);
  missing.delete(SURFACE);
  assert.ok(scan(missing).includes(`T5 ${SURFACE}: not read`));
  const binary = new Map(REAL);
  binary.set(SURFACE, `${REAL.get(SURFACE)}\0`);
  assert.ok(scan(binary).includes(`T5 ${SURFACE}: unreadable`));
});

// TypeScript reads a directive through intervening comments and blank lines.
function commentBlockStart(text, block) {
  for (;;) {
    const prev = text.lastIndexOf("\n", block - 2) + 1;
    if (prev >= block) break;
    if (!/^\s*(?:\/\/.*)?\r?$/.test(text.slice(prev, block - 1))) break;
    block = prev;
  }
  return block;
}

test("T5: the comment walk ends at the top of a file that opens with a blank line", () => {
  const text = "\n// note\nexport type X = Assert<IsData<DiffLineAnchor>>;";
  assert.equal(commentBlockStart(text, text.indexOf("export type")), 1);
});

test("T5: a directive that can silence the asserts fails, naming its line", () => {
  const text = REAL.get(SURFACE);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  /** `insert` as a line of its own at offset `at`, and the verdict naming it. */
  const added = (at, insert, word) => {
    const corpus = new Map(REAL);
    corpus.set(SURFACE, text.slice(0, at) + insert + eol + text.slice(at));
    return [
      corpus,
      `T5 ${SURFACE}:${lineOf(text, at)}: \`${word}\` can silence tsc`,
    ];
  };
  for (const name of HELD_TYPES) {
    const found = new RegExp(
      `^export type [\\w$]+ = Assert<IsData<${name}>>;\\r?$`,
      "m",
    ).exec(text);
    assert.ok(found, name);
    const block = commentBlockStart(text, found.index);
    const sites = block < found.index ? [found.index, block] : [found.index];
    for (const at of sites)
      for (const word of ["@ts-expect-error", "@ts-ignore"]) {
        const [corpus, verdict] = added(at, `// ${word}`, word);
        assert.deepEqual(scan(corpus), [verdict], `${name} ${word} at ${at}`);
      }
  }
  for (const [insert, word] of [
    ["// @ts-nocheck", "@ts-nocheck"],
    ["/* @ts-nocheck */", "@ts-nocheck"],
    ["// @TS-IGNORE", "@TS-IGNORE"],
    // Fails closed: a string literal naming one is no directive, but the raw
    // read can't tell, and the file has no reason to spell one.
    ['export const NOTE = "@ts-ignore";', "@ts-ignore"],
  ]) {
    const [corpus, verdict] = added(0, insert, word);
    assert.deepEqual(scan(corpus), [verdict], insert);
  }
});
