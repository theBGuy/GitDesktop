// Pins the diff panes' whole-file reader (src/features/diff/content-source.ts)
// by its source text: it imports react-query, which this installless suite
// can't load. Each pin has an in-memory mutation control.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const READER = "src/features/diff/content-source.ts";
const SURFACE = "src/features/diff/DiffSurface.tsx";
const red = (pin, ...texts) =>
  assert.throws(() => pin(...texts), undefined, "mutation control");
const swap = (text, from, to) => {
  assert.equal(text.split(from).length - 1, 1, `control anchor: ${from}`);
  return text.replace(from, () => to);
};

const CAP_DECL = /^const CONTENT_HIGHLIGHT_MAX_CHARS = ([\d_]+);$/m;
const BUDGET_DECL = /^export const FORGE_CONTENT_BUDGET_BYTES = ([\d_]+);$/m;

/** Content mode's forge budget is 3 bytes per char of DiffSurface's cap. */
function pinBudget(reader, surface) {
  const cap = surface.match(CAP_DECL);
  const budget = reader.match(BUDGET_DECL);
  if (!cap || !budget) throw new Error("budget constants not found");
  const n = (s) => Number(s.replaceAll("_", ""));
  if (3 * n(cap[1]) !== n(budget[1]))
    throw new Error(
      `FORGE_CONTENT_BUDGET_BYTES (${budget[1]}) must be 3 × CONTENT_HIGHLIGHT_MAX_CHARS (${cap[1]})`,
    );
}

test("the forge content budget follows DiffSurface's content-mode cap", () => {
  const reader = source(READER);
  const surface = source(SURFACE);
  pinBudget(reader, surface);
  // Each control moves one side's value as its declaration reads, so a
  // retuned pair keeps its controls.
  const moved = (text, decl) => {
    const [line, value] = text.match(decl);
    return swap(
      text,
      line,
      line.replace(value, () => `${value}1`),
    );
  };
  red(pinBudget, reader, moved(surface, CAP_DECL));
  red(pinBudget, moved(reader, BUDGET_DECL), surface);
});

/** A module specifier at a line's start: a side-effect import, or an import
 *  or re-export that names one with `from`. */
const SPECIFIER =
  /^(?:import\s+"([^"]+)"|(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)");$/gms;

/** No relative or feature import: nothing that reaches ./DiffSurface. */
function pinImports(reader) {
  const specs = [...reader.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2]);
  if (specs.length === 0) throw new Error("no imports read");
  for (const spec of specs)
    if (spec.startsWith(".") || spec.startsWith("@/features/"))
      throw new Error(`content-source.ts imports ${spec}`);
}

test("the reader imports nothing that reaches the diff chunk", () => {
  const reader = source(READER);
  pinImports(reader);
  for (const line of [
    `import { DiffContent } from "./DiffSurface";`,
    `import "./DiffSurface";`,
    `export { DiffContent } from "./DiffSurface";`,
    `export * from "@/features/diff/DiffSurface";`,
  ])
    red(pinImports, `${line}\n${reader}`);
});

/** In the diff feature only Markdown preview reads `useFileAtRev` directly:
 *  every other whole-file read goes through the source-aware reader. */
function pinReaders(files) {
  const direct = files
    .filter(([, text]) => text.includes("useFileAtRev("))
    .map(([name]) => name);
  if (direct.join() !== "MarkdownPreview.tsx")
    throw new Error(`direct useFileAtRev readers: ${direct.join(", ")}`);
}

test("whole-file reads in the diff feature go through content-source.ts", () => {
  const dir = new URL("../src/features/diff/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => [name, source(`src/features/diff/${name}`)]);
  assert.ok(files.length > 10, "the diff feature's files were read");
  pinReaders(files);
  red(pinReaders, [
    ...files,
    ["ImageDiff.tsx", "useFileAtRev(repo, rev, path, true)"],
  ]);
});
