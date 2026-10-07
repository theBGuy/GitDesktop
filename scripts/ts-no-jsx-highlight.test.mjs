// Pins the JSX-less `typescript` grammar (src/features/diff/hljs-ts-no-jsx.ts)
// on both highlight.js engines that render `.ts`: the diff's lowlight
// singleton (@git-diff-view/core) and a `lib/core` instance standing in for
// the markdown singleton. Each fix arm runs beside a negative control proving
// the STOCK grammar still collapses on the same buffer, so an hljs bump that
// moves the JSX mode out from under the structural predicate fails loudly.
//
// The imports reach straight into `src/` under Node's type stripping, so the
// module must stay free of aliased and app imports. Static imports are stdlib
// plus the import-free diff-lang.ts, so the installless `guards` job can load
// this file: the highlight.js / @git-diff-view graph loads dynamically and
// skips only when one of those PACKAGES is unresolved; GD_EXPECT_DEPS turns
// that skip into a failure on frontend.yml's installed, enforced run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { diffLang } from "../src/features/diff/diff-lang.ts";

const DEP_PACKAGES =
  /Cannot find package '(@git-diff-view\/core|highlight\.js)'/;

let highlighter;
let hljsCore;
let stockTypescript;
let xml;
let ensureTsNoJsx;
let installTsNoJsx;
let isTsNoJsx;
let stripJsxModes;
let typescriptNoJsx;
let skip = false;
// Settled, not raced: EVERY failure must be a missing dep package, so a broken
// src module can't hide behind an absent package's earlier rejection.
const loads = await Promise.allSettled([
  import("@git-diff-view/core"),
  import("highlight.js/lib/core"),
  import("highlight.js/lib/languages/typescript"),
  import("highlight.js/lib/languages/xml"),
  import("../src/features/diff/hljs-ts-no-jsx.ts"),
]);
const failures = loads.filter((l) => l.status === "rejected");
if (failures.length === 0) {
  [
    { highlighter },
    { default: hljsCore },
    { default: stockTypescript },
    { default: xml },
    {
      ensureTsNoJsx,
      installTsNoJsx,
      isTsNoJsx,
      stripJsxModes,
      typescriptNoJsx,
    },
  ] = loads.map((l) => l.value);
} else {
  for (const { reason } of failures) {
    if (
      process.env.GD_EXPECT_DEPS ||
      reason?.code !== "ERR_MODULE_NOT_FOUND" ||
      !DEP_PACKAGES.test(String(reason?.message))
    )
      throw reason;
  }
  skip =
    "highlight.js / @git-diff-view/core are not installed — the guards job " +
    "runs with no install step; frontend.yml's installed run enforces this";
}

const GENERIC = "const o = { f: <T>(x: T) => x };\n";
const REPRO = `${GENERIC}const s = "<Title>x</Title>";\n`;
const CONTROL = `${GENERIC}const s = "<Name>x</Name>";\n`;
const IN_TEMPLATE = `${GENERIC}const s = \`<Title>\${o}</Title>\`;\n`;
const TEMPLATE_CONTROL = `${GENERIC}const s = \`<Name>\${o}</Name>\`;\n`;
const TSX = 'const el = <div className="a">x</div>;\n';

/** A hast tree (lowlight) as hljs-style HTML, so both engines share asserts.
 *  lowlight names a sub-language island by its bare id; hljs prefixes it. */
function toHtml(node) {
  if (node.type === "text") return escape(node.value);
  const inner = (node.children ?? []).map(toHtml).join("");
  if (node.type !== "element") return inner;
  const cls = node.properties.className
    .map((c) => (c.startsWith("hljs-") ? c : `language-${c}`))
    .join(" ");
  return `<span class="${cls}">${inner}</span>`;
}

function escape(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Token spans after the generic's line — the region the collapse kills. */
function spansAfterGeneric(html) {
  const tail = html.slice(html.indexOf("\n") + 1);
  return (tail.match(/<span class="hljs-/g) ?? []).length;
}

/** The fixed tokenization: no xml island, and the tail tokenized exactly as
 *  the no-`</T` control's tail is. */
function assertFixed(highlight, buffer, control, label) {
  const html = highlight(buffer);
  assert.ok(!html.includes("language-xml"), `${label}: no JSX island`);
  assert.equal(
    spansAfterGeneric(html),
    spansAfterGeneric(highlight(control)),
    `${label}: tail tokenizes like the control`,
  );
  assert.ok(spansAfterGeneric(html) >= 2, `${label}: tail has spans`);
}

/** The stock collapse: an xml island opened at `<T>`, no tokens in the tail. */
function assertCollapsed(highlight, buffer, label) {
  const html = highlight(buffer);
  assert.ok(html.includes("language-xml"), `${label}: JSX island opened`);
  assert.equal(
    (html.slice(html.indexOf("\n") + 1).match(/hljs-(keyword|string)/g) ?? [])
      .length,
    0,
    `${label}: tail lost its keyword/string spans`,
  );
}

test("the structural predicate removes exactly javascript's JSX mode", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  assert.equal(stripJsxModes(stockTypescript(hljs)), 1);
  assert.equal(stripJsxModes(typescriptNoJsx(hljs)), 0);
});

test("markdown engine (lib/core): stock collapses, ensureTsNoJsx fixes", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("typescript", stockTypescript);
  const run = (lang) => (code) =>
    hljs.highlight(code, { language: lang }).value;
  const before = hljs.listLanguages();

  assertCollapsed(run("typescript"), REPRO, "stock");
  assertCollapsed(run("typescript"), IN_TEMPLATE, "stock template");

  ensureTsNoJsx(hljs);
  assert.ok(isTsNoJsx(hljs.getLanguage("typescript")));
  for (const id of ["typescript", "ts", "mts", "cts"]) {
    assertFixed(run(id), REPRO, CONTROL, id);
  }
  assertFixed(run("typescript"), IN_TEMPLATE, TEMPLATE_CONTROL, "template");
  // html`` templates embed xml legitimately and keep doing so.
  assert.ok(
    run("typescript")("const t = html`<b>x</b>`;").includes("language-xml"),
  );
  // ```tsx keeps JSX through its own stock-grammar id.
  assert.ok(run("tsx")(TSX).includes("language-xml"));
  assert.ok(!isTsNoJsx(hljs.getLanguage("tsx")));
  // The only new id is `tsx`, already a picker entry via the Shiki list.
  assert.deepEqual(
    hljs.listLanguages().filter((l) => !before.includes(l)),
    ["tsx"],
  );

  // The full-build upgrade re-registers stock; ensureTsNoJsx re-applies.
  hljs.registerLanguage("typescript", stockTypescript);
  assertCollapsed(run("typescript"), REPRO, "re-registered stock");
  ensureTsNoJsx(hljs);
  assertFixed(run("typescript"), REPRO, CONTROL, "re-applied");
});

test("diff engine (lowlight): stock collapses, installTsNoJsx fixes", {
  skip,
}, () => {
  const engine = highlighter.getHighlighterEngine();
  const run = (lang) => (code) => toHtml(engine.highlight(lang, code));
  const lang = diffLang("src/retry.mts");
  assert.equal(lang, "typescript");
  const before = engine.listLanguages();

  assertCollapsed(run(lang), REPRO, "stock");

  installTsNoJsx(engine);
  assertFixed(run(lang), REPRO, CONTROL, ".mts");
  assertFixed(
    run(diffLang("a.ts")),
    IN_TEMPLATE,
    TEMPLATE_CONTROL,
    ".ts template",
  );
  assert.ok(run("tsx")(TSX).includes("language-xml"), "tsx keeps JSX");
  assert.deepEqual(
    engine.listLanguages().filter((l) => !before.includes(l)),
    ["tsx"],
  );

  // A custom grammar registered afterwards wins its id, and a second install
  // (HMR re-evaluation) never re-registers over it.
  const custom = () => ({ contains: [{ scope: "keyword", begin: "const" }] });
  engine.register("typescript", custom);
  engine.register("gd-custom", custom);
  installTsNoJsx(engine);
  const html = run("typescript")(REPRO);
  assert.ok(!html.includes("hljs-attr"), "custom typescript grammar in use");
  assert.ok(run("gd-custom")("const").includes("hljs-keyword"));
});
