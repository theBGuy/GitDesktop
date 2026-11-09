// Pins the palette route to the Changes list's open: the registry declares
// `open-changed-file` once, palette-only, in the Changes category, and
// DiffViewer (the diff pane, mounted under <main> while the sidebar is
// collapsed, which hides ChangesPanel) is the one site that registers it,
// enabled exactly while the selected row resolves to a live entry on its side
// (`rowEntry`, hasSide's side test). Its `openRow` and the row double-click's
// in ChangesPanel both go through the shared decision.
//
// A source scan over MASKED code (comments and string text blanked), since the
// panel only runs inside a React render; string literals are read from the
// source at the masked quotes' offsets. Every lookup that finds nothing fails,
// and the pins carry in-memory mutation controls.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLOSE,
  maskNonCode,
  matchBrace,
  OPEN,
  sourceFiles,
  tagEnd,
} from "./lib/ts-mask.mjs";

/** The file's text, LF-normalized; an empty or missing file fails closed. */
function read(rel) {
  const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.ok(text.length > 0, `${rel} is empty`);
  return text.replace(/\r\n/g, "\n");
}

const REGISTRY = read("src/lib/hotkeys/registry.ts");
const PANEL = read("src/features/repository/ChangesPanel.tsx");
const ACTION = "open-changed-file";

/** The string literal whose opening quote sits at masked offset `at`. */
function literalAt(source, masked, at) {
  const end = masked.indexOf(masked[at], at + 1);
  if (end === -1) throw new Error(`unclosed literal at ${at}`);
  return source.slice(at + 1, end);
}

/** `[from, to)` ranges of the top-level arguments in the call whose `(` is at `open`. */
function argRanges(masked, open) {
  const close = matchBrace(masked, open);
  if (close === -1) throw new Error(`unclosed call at ${open}`);
  const ranges = [];
  let from = open + 1;
  for (let i = open + 1, depth = 0; i < close; i++) {
    if (OPEN.has(masked[i])) depth++;
    else if (CLOSE.has(masked[i])) depth--;
    else if (depth === 0 && masked[i] === ",") {
      ranges.push([from, i]);
      from = i + 1;
    }
  }
  if (masked.slice(from, close).trim() !== "") ranges.push([from, close]);
  return ranges;
}

/** `[open, close]` of the innermost `{…}` enclosing offset `at`, or null. */
function enclosingObject(masked, at) {
  for (let k = at; k >= 0; k--)
    if (masked[k] === "{" && matchBrace(masked, k) > at)
      return [k, matchBrace(masked, k) + 1];
  return null;
}

/** Ways the registry entry drifts from palette-only, in Changes, once. */
function registryFailures(source) {
  const masked = maskNonCode(source, false);
  const failures = [];
  const hits = [];
  for (const m of masked.matchAll(/\bid\s*:\s*(["'])/g)) {
    const quote = m.index + m[0].length - 1;
    if (literalAt(source, masked, quote) === ACTION) hits.push(m.index);
  }
  if (hits.length !== 1) return [`${hits.length} "${ACTION}" entries, want 1`];
  const span = enclosingObject(masked, hits[0]);
  if (span === null) return ["entry object not found"];
  const entryMasked = masked.slice(...span);
  const entrySource = source.slice(...span);
  if (!/\bdefaultBinding\s*:\s*null\s*[,}]/.test(entryMasked))
    failures.push("defaultBinding is not null");
  const cat = /\bcategory\s*:\s*(["'])/.exec(entryMasked);
  if (
    cat === null ||
    literalAt(entrySource, entryMasked, cat.index + cat[0].length - 1) !==
      "Changes"
  )
    failures.push('category is not "Changes"');
  return failures;
}

/** The argument ranges of each `useHotkeyAction("open-changed-file", …)` call. */
function registrations(source, masked) {
  const calls = [];
  for (const m of masked.matchAll(/\buseHotkeyAction\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = argRanges(masked, open);
    if (args.length === 0) continue;
    const first = masked.slice(...args[0]).trim();
    if (!/^["']/.test(first)) continue;
    const at = args[0][0] + masked.slice(...args[0]).indexOf(first[0]);
    if (literalAt(source, masked, at) === ACTION) calls.push(args);
  }
  return calls;
}

/** Ways a host's `openRow` drifts from the shared decision and executor. */
function openRowFailures(flatAll) {
  const failures = [];
  if (
    !/const openSubmodule = useOpenSubmoduleAsRepo\(repoPath\); function openRow\(entry: FileEntry\) \{ void runOpenChangedFile\( openChangedFileAction\(\{ entry, repoPath, editorPath, windows: isWindows,? \}\), repoPath, openSubmodule,? \); \}/.test(
      flatAll,
    )
  )
    failures.push("openRow: the shared decision and executor");
  if (
    !flatAll.includes(
      'const editorPath = (settings.data?.externalEditor ?? "").trim();',
    )
  )
    failures.push("editorPath: the menu's trimmed normalisation");
  return failures;
}

/** Ways ChangesPanel's double-click wiring drifts; it registers no palette
 *  open of its own (a collapsed sidebar hides its panel). */
function panelFailures(source) {
  const masked = maskNonCode(source, true);
  const flatAll = masked.replace(/\s+/g, " ").trim();
  const failures = openRowFailures(flatAll);
  const calls = registrations(source, masked);
  if (calls.length !== 0)
    failures.push(`${calls.length} useHotkeyAction("${ACTION}") calls, want 0`);
  const onOpen = [...masked.matchAll(/\bonOpen=\{([^}]*)\}/g)];
  if (onOpen.length !== 1 || onOpen[0][1] !== "openRow")
    failures.push("FileRow: onOpen={openRow}, once");
  return failures;
}

/** Ways DiffViewer's palette registration drifts: once, gated on the selected
 *  row's entry on its own side, running the shared openRow. */
function viewerFailures(source) {
  const masked = maskNonCode(source, true);
  const flat = (from, to) => masked.slice(from, to).replace(/\s+/g, " ").trim();
  const flatAll = flat(0, masked.length);
  const failures = openRowFailures(flatAll);
  const calls = registrations(source, masked);
  if (calls.length !== 1)
    return [
      ...failures,
      `${calls.length} useHotkeyAction("${ACTION}") calls, want 1`,
    ];
  const [args] = calls;
  if (args.length !== 3) failures.push(`${args.length} arguments, want 3`);
  else {
    if (!/\bopenRow\(selectedEntry\)/.test(flat(...args[1])))
      failures.push("the run does not call openRow(selectedEntry)");
    if (flat(...args[2]) !== "selectedEntry !== null")
      failures.push("the gate is not selectedEntry !== null");
  }
  if (
    !/const selectedEntry = selectedFile \? \(rowEntry\(entries, selectedFile\.path, selectedFile\.staged\) \?\? null\) : null;/.test(
      flatAll,
    )
  )
    failures.push("selectedEntry: the selected row's entry on its own side");
  if (
    !/\bconst selectedFile = useUiStore\(\(s\) => s\.selectedFile\);/.test(
      flatAll,
    )
  )
    failures.push("selectedFile: the live selection");
  return failures;
}

/** Files under src/ (by name) that register the action, with their counts. */
function registeringFiles(texts) {
  const hits = [];
  for (const [name, source] of texts) {
    if (!source.includes(ACTION)) continue;
    const n = registrations(
      source,
      maskNonCode(source, name.endsWith("x")),
    ).length;
    if (n > 0) hits.push(`${name}:${n}`);
  }
  return hits;
}

/** `[open, close)` of the first `<tag …>…</tag>` element in masked JSX. */
function elementSpan(masked, tag) {
  const open = masked.search(new RegExp(`<${tag}\\b`));
  if (open === -1) return null;
  const close = masked.indexOf(`</${tag}>`, open);
  return close === -1 ? null : [open, close];
}

/** Ways RepositoryView stops keeping DiffViewer outside the collapsible
 *  sidebar: it renders once, inside <main> and not <aside>, under a TabPanel
 *  whose activity reads the tab alone (a collapsed sidebar hides the aside's
 *  panels and turns their `active` off). */
function placementFailures(source) {
  const masked = maskNonCode(source, true);
  const uses = [...masked.matchAll(/<DiffViewer\b/g)].map((m) => m.index);
  if (uses.length !== 1)
    return [`${uses.length} <DiffViewer> elements, want 1`];
  const [at] = uses;
  const failures = [];
  const aside = elementSpan(masked, "aside");
  const main = elementSpan(masked, "main");
  if (aside === null || main === null) return ["<aside> or <main> not found"];
  if (at > aside[0] && at < aside[1])
    failures.push("DiffViewer is inside <aside>");
  if (!(at > main[0] && at < main[1]))
    failures.push("DiffViewer is outside <main>");
  const panel = masked.lastIndexOf("<TabPanel", at);
  if (panel === -1 || panel < main[0])
    return [...failures, "no TabPanel above it"];
  // String text is masked; the offsets are the source's.
  const head = source
    .slice(panel, tagEnd(masked, panel) + 1)
    .replace(/\s+/g, " ");
  if (head !== '<TabPanel active={repoTab === "changes"}>')
    failures.push(`its TabPanel reads ${head}`);
  return failures;
}

const VIEWER = read("src/features/diff/DiffViewer.tsx");
const VIEW = read("src/features/repository/RepositoryView.tsx");
const SRC = [];
for (const file of sourceFiles(
  fileURLToPath(new URL("../src", import.meta.url)),
))
  SRC.push([file, readFileSync(file, "utf8").replace(/\r\n/g, "\n")]);

test(`registry: "${ACTION}" is declared once, palette-only, under Changes`, () => {
  assert.deepEqual(registryFailures(REGISTRY), []);
});

test("ChangesPanel: double-click runs openRow, and the panel registers no palette open", () => {
  assert.deepEqual(panelFailures(PANEL), []);
});

test("DiffViewer: one registration, gated on the selected entry, running openRow", () => {
  assert.deepEqual(viewerFailures(VIEWER), []);
});

test("src/: DiffViewer is the one registration site", () => {
  assert.ok(SRC.length > 100, `only ${SRC.length} source files read`);
  const hits = registeringFiles(SRC);
  assert.equal(hits.length, 1, hits.join(", "));
  assert.match(hits[0], /DiffViewer\.tsx:1$/);
});

test("RepositoryView: DiffViewer stays mounted with the sidebar collapsed", () => {
  assert.deepEqual(placementFailures(VIEW), []);
});

/** `text` with `from` (which must appear once) replaced by `to`. */
function mutate(text, from, to) {
  assert.equal(text.split(from).length, 2, `anchor appears once: ${from}`);
  return text.replace(from, () => to);
}

test("negative controls: registry drift fails", () => {
  const entry = `  {
    id: "${ACTION}",
    label: "Open changed file",
    category: "Changes",`;
  assert.notDeepEqual(
    registryFailures(mutate(REGISTRY, entry, `${entry}\n  },\n${entry}`)),
    [],
  );
  const binding = `category: "Changes",
    // Palette-only: the pointer route is a double-click on the file's row.
    defaultBinding: null,`;
  assert.notDeepEqual(
    registryFailures(
      mutate(
        REGISTRY,
        binding,
        binding.replace("defaultBinding: null", 'defaultBinding: "mod+e"'),
      ),
    ),
    [],
  );
  assert.notDeepEqual(
    registryFailures(
      mutate(REGISTRY, entry, entry.replace('"Changes"', '"Navigation"')),
    ),
    [],
  );
  // A commented-out entry is no entry.
  assert.notDeepEqual(
    registryFailures(
      mutate(REGISTRY, `id: "${ACTION}",`, `// id: "${ACTION}",`),
    ),
    [],
  );
});

const REGISTRATION = `  useHotkeyAction(
    "${ACTION}",
    () => {
      if (selectedEntry) openRow(selectedEntry);
    },
    selectedEntry !== null,
  );
`;

test("negative controls: ChangesPanel drift fails", () => {
  assert.notDeepEqual(
    panelFailures(
      mutate(PANEL, "onOpen={openRow}", "onOpen={() => undefined}"),
    ),
    [],
  );
  // The double-click reaches the submodule opener only through openRow's
  // third argument, which no jsdom test renders.
  assert.notDeepEqual(
    panelFailures(
      mutate(
        PANEL,
        "      repoPath,\n      openSubmodule,\n    );",
        "      repoPath,\n      async () => false,\n    );",
      ),
    ),
    [],
  );
  // A registration back in the panel (unmounted while collapsed) fails.
  const panelBack = mutate(
    PANEL,
    "  // Resolve the selected conflicted file with AI",
    `${REGISTRATION}  // Resolve the selected conflicted file with AI`,
  );
  assert.notDeepEqual(panelFailures(panelBack), []);
  assert.equal(
    registeringFiles(
      SRC.map(([name, text]) => [
        name,
        name.endsWith("ChangesPanel.tsx") ? panelBack : text,
      ]),
    ).length,
    2,
  );
});

test("negative controls: DiffViewer drift fails", () => {
  const mutants = [
    ["    selectedEntry !== null,\n  );", "    true,\n  );"],
    [
      "if (selectedEntry) openRow(selectedEntry);",
      "if (selectedEntry) void selectedEntry;",
    ],
    [
      "rowEntry(entries, selectedFile.path, selectedFile.staged)",
      "rowEntry(entries, selectedFile.path, false)",
    ],
    [
      `  useHotkeyAction(\n    "${ACTION}",`,
      `  useHotkeyAction(\n    // "${ACTION}",\n    "open-changed-files",`,
    ],
    [
      "        windows: isWindows,\n      }),\n      repoPath,\n      openSubmodule,\n    );",
      "        windows: isWindows,\n      }),\n      repoPath,\n      async () => false,\n    );",
    ],
    [
      'const editorPath = (settings.data?.externalEditor ?? "").trim();',
      'const editorPath = settings.data?.externalEditor ?? "";',
    ],
  ];
  for (const [from, to] of mutants)
    assert.notDeepEqual(
      viewerFailures(mutate(VIEWER, from, to)),
      [],
      `viewer mutant survived: ${to}`,
    );
});

test("negative controls: a DiffViewer moved into the sidebar fails", () => {
  const host =
    "<Suspense fallback={<DiffRestingFallback repoPath={repoPath} />}>\n              <DiffViewer repoPath={repoPath} />\n            </Suspense>";
  const moved = mutate(
    mutate(VIEW, host, "null"),
    "<ChangesPanel repoPath={repoPath} active={changesActive} />",
    "<ChangesPanel repoPath={repoPath} active={changesActive} />\n              <DiffViewer repoPath={repoPath} />",
  );
  assert.notDeepEqual(placementFailures(moved), []);
  assert.notDeepEqual(
    placementFailures(
      mutate(
        VIEW,
        '<main className="min-w-0 flex-1">\n          <TabPanel active={repoTab === "changes"}>',
        '<main className="min-w-0 flex-1">\n          <TabPanel active={changesActive}>',
      ),
    ),
    [],
  );
});
