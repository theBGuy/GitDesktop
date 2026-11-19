// The filter surface decides which filter text a file rail shares and which
// shortcut scope it joins, and CommitDetailView defaults it to "history", so a
// mount that drops or changes its attribute misroutes silently. Every
// production mount of CommitDetailView and BranchDiffView is pinned in HOSTS,
// and two closures over every .ts/.tsx under src/ (src/test/ excluded) keep a
// new host from hiding: one by JSX mount name (it sees a mount reached through
// a re-export), one by import specifier (it sees an aliased or lazy import).
// Scans run on `maskNonCode`'s output, so comments and string text never
// count; attribute values and specifiers are read from the raw text at the
// masked offsets.
// A surface written as a non-literal expression, and any mount whose opening
// tag holds a JSX spread wherever it sits, read as null: they fail the table,
// never pass it. Not covered: a mount through a re-export under another name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  hasSpread,
  loadCorpus,
  maskNonCode,
  ScanError,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIEWS = ["CommitDetailView", "BranchDiffView"];
const DEFINING = [
  "src/features/history/CommitDetailView.tsx",
  "src/features/compare/BranchDiffView.tsx",
];

const HOSTS = {
  "src/features/repository/RepositoryView.tsx": [
    ["CommitDetailView", "history"],
    ["CommitDetailView", "compare"],
    ["BranchDiffView", "compare"],
  ],
  "src/features/pulls/LocalPrView.tsx": [
    ["CommitDetailView", "local-pr-commits"],
    ["BranchDiffView", "local-pr-files"],
  ],
  "src/features/sessions/SessionView.tsx": [["BranchDiffView", "session"]],
};

const squash = (s) => s.replace(/\s+/g, "");
const mask = (rel, text) => maskNonCode(text, rel.endsWith(".tsx"));

/** Every mount of either view in source order, as [view, surface]: the
 *  surface is null unless the opening tag carries a double-quoted
 *  `filterSurface` literal. */
function filterSurfaceMounts(rel, text, masked = mask(rel, text)) {
  const mounts = VIEWS.flatMap((view) =>
    elementRanges(rel, text, masked, view).map(([from]) => {
      const end = tagEnd(masked, from);
      const attr = /\sfilterSurface="/.exec(masked.slice(from, end));
      if (!attr || hasSpread(masked, from, end)) return [from, view, null];
      const open = from + attr.index + attr[0].length;
      return [from, view, text.slice(open, masked.indexOf('"', open))];
    }),
  );
  return mounts.sort((a, b) => a[0] - b[0]).map(([, view, s]) => [view, s]);
}

// A static `from "…"`, a bare `import "…"` or a dynamic `import("…")`, quoted
// or in backticks; the mask keeps the delimiters and blanks what they hold.
const SPECIFIER = /(?<![\w$.])(?:from|import)\s*\(?\s*(["'`])/g;
// An interpolated template can't be resolved: it names a view when its raw
// text holds the view's name as a whole identifier, anywhere in it.
const VIEW_WORD = /(?<![\w$])(CommitDetailView|BranchDiffView)(?![\w$])/g;

/** The view a module specifier names by its last path segment, if any. */
function viewOf(specifier) {
  const last = (specifier.split("/").at(-1) ?? "").replace(
    /\.[cm]?[jt]sx?$/,
    "",
  );
  return VIEWS.includes(last) ? last : null;
}

/** Every import of a view in source order: the view's name when a static
 *  named import binds it as itself, else the view and the statement's head,
 *  so an alias, a default, a namespace or a dynamic import fails a host. */
function viewImports(rel, text, masked = mask(rel, text)) {
  return [...masked.matchAll(SPECIFIER)].flatMap((m) => {
    const open = m.index + m[0].length;
    const specifier = text.slice(open, masked.indexOf(m[1], open));
    const head = squash(
      masked.slice(masked.lastIndexOf(";", m.index) + 1, m.index),
    );
    if (m[1] === "`" && specifier.includes("${")) {
      const named = new Set(
        [...specifier.matchAll(VIEW_WORD)].map((w) => w[1]),
      );
      return [...named].map((view) => `${view} via ${head} (template)`);
    }
    const view = viewOf(specifier);
    if (view === null) return [];
    const clause = /^import(?:type)?\{([^}]*)\}$/.exec(head);
    const names = clause ? clause[1].split(",") : [];
    const canonical =
      names.includes(view) &&
      !names.some((n) => n.startsWith(view) && n !== view);
    return [canonical ? view : `${view} via ${head}`];
  });
}

const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => !rel.startsWith("src/test/")),
);
const MASKED = new Map(
  [...CORPUS].map(([rel, text]) => [rel, mask(rel, text)]),
);
const withHits = (read, extra = new Map()) =>
  [...CORPUS, ...extra]
    .filter(([rel, text]) => read(rel, text, MASKED.get(rel)).length > 0)
    .map(([rel]) => rel)
    .sort();
/** The import closure's importers: every file but the defining modules. */
const importers = (extra) =>
  withHits(viewImports, extra).filter((rel) => !DEFINING.includes(rel));

test("the walk reads every source file outside src/test", () => {
  assert.ok(CORPUS.size > 0, "the walk read zero files");
  for (const rel of [...DEFINING, ...Object.keys(HOSTS)])
    assert.ok(CORPUS.has(rel), `${rel} is not in the walk`);
  assert.ok(![...CORPUS.keys()].some((rel) => rel.startsWith("src/test/")));
});

for (const [rel, mounts] of Object.entries(HOSTS)) {
  test(`${rel} mounts its rails on these surfaces`, () => {
    assert.deepEqual(
      filterSurfaceMounts(rel, CORPUS.get(rel), MASKED.get(rel)),
      mounts,
    );
  });

  test(`${rel} imports the views it mounts under their own names`, () => {
    const views = [...new Set(mounts.map(([view]) => view))].sort();
    assert.deepEqual(
      viewImports(rel, CORPUS.get(rel), MASKED.get(rel)).sort(),
      views,
    );
  });
}

test("no other source file mounts either view", () => {
  assert.deepEqual(withHits(filterSurfaceMounts), Object.keys(HOSTS).sort());
});

test("no other source file imports either view", () => {
  assert.deepEqual(importers(), Object.keys(HOSTS).sort());
});

// In-memory controls: each mutation of a host's source fails the check that
// pins it.
const HOST = "src/features/repository/RepositoryView.tsx";
const hostText = () => CORPUS.get(HOST);
const once = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `expected one ${from}`);
  return text.replace(from, () => to);
};

test("control: a mount with its attribute removed fails its table", () => {
  const text = once(hostText(), ' filterSurface="history"', "");
  assert.notDeepEqual(filterSurfaceMounts(HOST, text), HOSTS[HOST]);
  assert.deepEqual(filterSurfaceMounts(HOST, text)[0], [
    "CommitDetailView",
    null,
  ]);
});

test("control: a changed surface fails its table", () => {
  const text = once(
    hostText(),
    'filterSurface="history"',
    'filterSurface="compare"',
  );
  assert.notDeepEqual(filterSurfaceMounts(HOST, text), HOSTS[HOST]);
});

test("control: a non-literal surface reads as null", () => {
  const rel = "x.tsx";
  assert.deepEqual(
    filterSurfaceMounts(rel, "<BranchDiffView filterSurface={s} />;"),
    [["BranchDiffView", null]],
  );
});

test("control: an aliased import is counted, and fails the host check", () => {
  const rel = "src/x/Other.tsx";
  const imports = viewImports(
    rel,
    'import { CommitDetailView as Detail } from "@/features/history/CommitDetailView";\n',
  );
  assert.equal(imports.length, 1);
  assert.notDeepEqual(imports, ["CommitDetailView"]);
  const text = once(
    hostText(),
    "import { CommitDetailView }",
    "import { CommitDetailView as Detail }",
  );
  assert.notDeepEqual(viewImports(HOST, text).sort(), [
    "BranchDiffView",
    "CommitDetailView",
  ]);
});

test("control: a lazy import is counted in either quote style", () => {
  for (const q of ['"', "'"]) {
    const imports = viewImports(
      "src/x/Other.tsx",
      `const Lazy = lazy(() => import(${q}@/features/compare/BranchDiffView${q}));\n`,
    );
    assert.equal(imports.length, 1);
    assert.notDeepEqual(imports, ["BranchDiffView"]);
  }
});

test("control: a commented-out mount or import is not counted", () => {
  const rel = "src/x/Other.tsx";
  const text = [
    '// import { CommitDetailView } from "@/features/history/CommitDetailView";',
    "/* import { BranchDiffView }",
    '  from "@/features/compare/BranchDiffView"; */',
    'const a = <div>{/* <BranchDiffView filterSurface="compare" /> */}</div>;',
    '// <CommitDetailView filterSurface="history" />',
  ].join("\n");
  assert.deepEqual(viewImports(rel, text), []);
  assert.deepEqual(filterSurfaceMounts(rel, text), []);
});

test("control: a view named only in a comment, a string or a longer name is not counted", () => {
  const rel = "src/x/Other.tsx";
  const text = [
    "// Mirrors BranchDiffView's layout.",
    'const label = "CommitDetailView";',
    'import { X } from "@/features/history/CommitDetailViewLazy";',
    'const b = <BranchDiffViewLazy filterSurface="compare" />;',
  ].join("\n");
  assert.deepEqual(viewImports(rel, text), []);
  assert.deepEqual(filterSurfaceMounts(rel, text), []);
});

test("control: a mount whose tag never ends fails closed", () => {
  assert.throws(
    () => filterSurfaceMounts("src/x/Other.tsx", "const a = <BranchDiffView"),
    ScanError,
  );
});

test("control: a JSX spread anywhere in the tag reads as unpinned", () => {
  const rel = "src/x/Other.tsx";
  for (const tag of [
    '<BranchDiffView filterSurface="compare" {...p} />;',
    '<BranchDiffView {...p} filterSurface="compare" />;',
    '<BranchDiffView filterSurface="compare" { ...p } />;',
  ])
    assert.deepEqual(filterSurfaceMounts(rel, tag), [["BranchDiffView", null]]);
  assert.deepEqual(
    filterSurfaceMounts(
      rel,
      '<BranchDiffView style={{ ...s }} filterSurface="compare" />;',
    ),
    [["BranchDiffView", "compare"]],
  );
  const text = once(
    hostText(),
    'filterSurface="history"',
    'filterSurface="history" {...rest}',
  );
  assert.notDeepEqual(filterSurfaceMounts(HOST, text), HOSTS[HOST]);
});

test("control: a backtick import is counted, and fails the closure", () => {
  const rel = "src/x/Other.tsx";
  for (const spec of [
    "@/features/compare/BranchDiffView",
    "@/features/${area}/BranchDiffView",
  ]) {
    const text = `const L = lazy(() => import(\`${spec}\`));\n`;
    const imports = viewImports(rel, text);
    assert.equal(imports.length, 1, spec);
    assert.notDeepEqual(imports, ["BranchDiffView"]);
    assert.notDeepEqual(
      importers(new Map([[rel, text]])),
      Object.keys(HOSTS).sort(),
    );
  }
  assert.deepEqual(
    viewImports(rel, "const m = import(`@/features/${area}/DiffView`);\n"),
    [],
  );
});
