// Pins the diff panes' library-view and line-anchor wiring, read from source
// (src/ outside src/test/ and src/components/ui/), comment- and string-masked:
//   T1 every `<DiffView` / `<DiffViewWithMultiSelect` open tag carries one of
//      `HOST_KEYS`, a key on the retained build every host names `diffFile`:
//      the library clears its on-screen clone during render when the source
//      changes, so a view React keeps across a discarded render repaints in
//      the light theme;
//   T2 every `useModeLineAnchor(` call binds the result's `mark` and renders
//      that binding as a JSX child before the next call in its file, so a
//      switch reads the line in its commit;
//   T3 every file that calls a keeper's `.restore()` renders a `<SnapshotMark`
//      whose `read` calls that keeper's `.read()`;
//   T4 an unreadable file, an open tag with no end, and an empty roster for any
//      of the three each FAIL.
// The grammar is deliberately narrow. Out of its sight: the library components
// imported under another name, a `key` arriving through a spread, a `diffFile`
// that names something other than the retained build, a mark rendered through
// another variable, passed down as a prop or rendered past the next call, a
// call whose result isn't destructured by the `const` right before it, and a
// destructure spread over several statements.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, maskNonCode } from "./lib/ts-mask.mjs";

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

/** The index just past an open tag's closing `>`, or -1: `<…>` type arguments
 *  after the name and `{…}` attribute values may hold a `>` of their own. */
function openTagEnd(masked, from) {
  let braces = 0;
  let angles = 0;
  for (let k = from; k < masked.length; k++) {
    const c = masked[k];
    if (c === "{" || c === "(") braces++;
    else if (c === "}" || c === ")") braces--;
    else if (braces === 0 && c === "<") angles++;
    else if (c === ">" && masked[k - 1] !== "=" && braces === 0) {
      if (angles > 0) angles--;
      else return k + 1;
    }
    if (braces < 0) return -1;
  }
  return -1;
}

const HOST_TAG = /<(DiffViewWithMultiSelect|DiffView)\b/g;
// The accepted host keys, exactly; a key that extends the build's id adds its
// own entry here, scoped to the file whose host draws it (`file` absent = any).
// RenderedDiff's two arms key on the build and the record its rows are for.
const HOST_KEYS = [
  { re: /\bkey=\{diffFile\.getId\(\)\}/ },
  {
    re: /\bkey=\{viewKey\(viewGen, diffFile\)\}/,
    file: "src/features/diff/DiffSurface.tsx",
  },
];
const ANCHOR_CALL = /\buseModeLineAnchor\(/g;
const ANCHOR_DEF = /\bfunction\s+$/;
const MARK_BIND = /\bconst\s*\{([^}]*)\}\s*=\s*$/;
const KEEPER_RESTORE = /\blineKeeper\??\.current\??\.restore\(/g;
const KEEPER_READ = /\bread=\{[^]*\blineKeeper\??\.current\??\.read\(\)/;

/** Violations over a corpus; also returns the roster counts T4 reads. */
export function scan(corpus) {
  const out = [];
  let tags = 0;
  let callers = 0;
  let restores = 0;
  if (corpus.size === 0) out.push("T4 no source files read");
  for (const [rel, text] of corpus) {
    if (typeof text !== "string" || text.includes("\0")) {
      out.push(`T4 ${rel}: unreadable`);
      continue;
    }
    let masked;
    try {
      masked = maskNonCode(text, rel.endsWith(".tsx"));
    } catch (e) {
      out.push(`T4 ${rel}: ${e.message}`);
      continue;
    }
    for (const m of masked.matchAll(HOST_TAG)) {
      tags++;
      const end = openTagEnd(masked, m.index + m[0].length);
      const at = `${rel}:${lineOf(text, m.index)} <${m[1]}>`;
      if (end === -1) out.push(`T4 ${at}: no end to the open tag`);
      else if (
        !HOST_KEYS.some(
          (k) =>
            (k.file === undefined || k.file === rel) &&
            k.re.test(masked.slice(m.index, end)),
        )
      )
        out.push(`T1 ${at}: no key on the retained build (HOST_KEYS)`);
    }
    const calls = [...masked.matchAll(ANCHOR_CALL)].map((m) => m.index);
    calls.forEach((at, i) => {
      const before = masked.slice(Math.max(0, at - 300), at);
      if (ANCHOR_DEF.test(before)) return;
      callers++;
      const bind = MARK_BIND.exec(before);
      const mark = bind && /\bmark\b(?:\s*:\s*([\w$]+))?/.exec(bind[1]);
      const name = mark && (mark[1] ?? "mark");
      const scope = masked.slice(at, calls[i + 1] ?? masked.length);
      const rendered =
        name !== null &&
        new RegExp(`\\{\\s*${name}\\s*\\}(?!\\s*=)`).test(scope);
      if (!rendered)
        out.push(
          `T2 ${rel}:${lineOf(text, at)}: useModeLineAnchor's mark is not rendered`,
        );
    });
    const restoreSites = [...masked.matchAll(KEEPER_RESTORE)].length;
    if (restoreSites > 0) {
      restores += restoreSites;
      const marks = [...masked.matchAll(/<SnapshotMark\b/g)].some((m) => {
        const end = openTagEnd(masked, m.index + m[0].length);
        return end !== -1 && KEEPER_READ.test(masked.slice(m.index, end));
      });
      if (!marks)
        out.push(`T3 ${rel}: no <SnapshotMark> reads the keeper it restores`);
    }
  }
  if (tags === 0) out.push("T4 no library view tags found");
  if (callers === 0) out.push("T4 no useModeLineAnchor callers found");
  if (restores === 0) out.push("T4 no keeper restore sites found");
  return out;
}

const REAL = loadCorpus();
const SURFACE = "src/features/diff/DiffSurface.tsx";
const VIEWER = "src/features/diff/DiffViewer.tsx";
const IMAGE = "src/features/diff/ImageDiff.tsx";
const KEY = "key={diffFile.getId()}";
const RECORD_KEY = "key={viewKey(viewGen, diffFile)}";

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
      /<DiffView<\{ render: \(\) => ReactNode \}>\r?\n/,
      (m) => `${m}          // ${RECORD_KEY}\n`,
    ),
  );
  assert.notEqual(comment.get(SURFACE), text);
  assert.equal(scan(comment).filter((v) => v.startsWith("T1")).length, 1);
});

test("T2: dropping each caller's mark names it", () => {
  for (const file of [SURFACE, VIEWER]) {
    const { corpus } = mutate(file, "{mark}", "{null}");
    const out = scan(corpus).filter((v) => v.startsWith("T2"));
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(
      out[0],
      new RegExp(`^T2 ${file}:\\d+: useModeLineAnchor's mark is not rendered$`),
    );
  }
});

test("T2 decoy: a mark bound and never rendered fails", () => {
  const { corpus } = mutate(VIEWER, "{mark}", "");
  assert.equal(scan(corpus).filter((v) => v.startsWith("T2")).length, 1);
});

test("T2: a second caller is judged on its own mark", () => {
  const withCaller = (body) => {
    const corpus = new Map(REAL);
    const text = REAL.get(VIEWER);
    const next = `${text}\nexport function SecondCaller() {\n${body}\n}\n`;
    corpus.set(VIEWER, next);
    return { corpus, line: lineOf(next, next.indexOf(call, text.length)) };
  };
  const call = 'useModeLineAnchor(undefined, "split", "a.ts", null)';
  // The first caller's rendered mark sits before this one: it doesn't count.
  const unrendered = withCaller(
    `  const { mark } = ${call};\n  return <div />;`,
  );
  assert.deepEqual(
    scan(unrendered.corpus).filter((v) => v.startsWith("T2")),
    [
      `T2 ${VIEWER}:${unrendered.line}: useModeLineAnchor's mark is not rendered`,
    ],
  );
  const unbound = withCaller(`  const { keepLine } = ${call};\n  return null;`);
  assert.equal(
    scan(unbound.corpus).filter((v) => v.startsWith("T2")).length,
    1,
  );
  const rendered = withCaller(
    `  const { mark } = ${call};\n  return <div>{mark}</div>;`,
  );
  assert.deepEqual(scan(rendered.corpus), []);
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

test("T4: empty rosters, unreadable files and open tags fail closed", () => {
  assert.ok(scan(new Map()).includes("T4 no source files read"));
  const none = new Map([["src/a.ts", "export const a = 1;\n"]]);
  assert.deepEqual(scan(none), [
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
});
