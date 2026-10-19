// Pins the JSX-less typescript and TS/JS params-comment transforms
// (src/features/diff/hljs-ts-no-jsx.ts) on both highlight.js engines: lowlight's
// singleton (@git-diff-view/core) and a `lib/core` instance standing in for
// the markdown singleton. Each fix arm runs beside a negative control proving
// the STOCK grammar still collapses on the same buffer, so an hljs bump that
// moves either mode out from under its structural predicate fails loudly.
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
let stockJavascript;
let xml;
let ensureTsNoJsx;
let installTsNoJsx;
let isTsNoJsx;
let stripJsxModes;
let typescriptNoJsx;
let spliceParamsComment;
let javascriptWithParamsComment;
let isJsParamsComment;
let skip = false;
// Settled, not raced: EVERY failure must be a missing dep package, so a broken
// src module can't hide behind an absent package's earlier rejection.
const loads = await Promise.allSettled([
  import("@git-diff-view/core"),
  import("highlight.js/lib/core"),
  import("highlight.js/lib/languages/typescript"),
  import("highlight.js/lib/languages/javascript"),
  import("highlight.js/lib/languages/xml"),
  import("../src/features/diff/hljs-ts-no-jsx.ts"),
]);
const failures = loads.filter((l) => l.status === "rejected");
if (failures.length === 0) {
  [
    { highlighter },
    { default: hljsCore },
    { default: stockTypescript },
    { default: stockJavascript },
    { default: xml },
    {
      ensureTsNoJsx,
      installTsNoJsx,
      isTsNoJsx,
      stripJsxModes,
      typescriptNoJsx,
      spliceParamsComment,
      javascriptWithParamsComment,
      isJsParamsComment,
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

// Line 7 is the probe line: stock leaves it inside params>string.
const TS_PARAMS_REPRO = `type S = {
  f: (t: {
    /** b's */
    a: number;
  }) => void;
};
const x = 1;
`;
const TS_PARAMS_CONTROL = TS_PARAMS_REPRO.replace("b's", "bs");
const TS_PARAMS_TWO_APOS = TS_PARAMS_REPRO.replace("b's", "b's c's");
const TS_PARAMS_LINE = TS_PARAMS_REPRO.replace("/** b's */", "// b's");
const TS_PAREN_COMMENT = `const f = (/* b's */ t: number) => t;\nconst x = 1;\n`;
const TS_FN_DECL = `function f(t: { /** b's */ a: number }) {}\nconst x = 1;\n`;
const TS_BRACE_IN_COMMENT = `type S = {\n  f: (t: {\n    /* } b's */\n    a: number;\n  }) => void;\n};\nconst x = 1;\n`;
const JS_PARAMS_REPRO = `function f({ // a's
  x,
}) {}
const y = 1;
`;
const JS_PARAMS_CONTROL = JS_PARAMS_REPRO.replace("a's", "as");

const TRIGGER_CONTROLS = [
  ["typescript", TS_PARAMS_CONTROL, "no apostrophe"],
  ["typescript", TS_PARAMS_TWO_APOS, "even apostrophes"],
  ["javascript", JS_PARAMS_CONTROL, "JS no apostrophe"],
];

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

/** Every params fixture ends in a newline; the last entry holds EOF closers. */
function probeLine(html) {
  return html.split("\n").at(-2);
}

function assertParamsClosed(html, label) {
  assert.match(
    probeLine(html),
    /<span class="hljs-keyword">const<\/span>/,
    label,
  );
  assert.equal(html.split("\n").at(-1), "", `${label}: all spans closed`);
}

function assertParamsCollapsed(highlight, buffer, label) {
  const html = highlight(buffer);
  assert.equal(
    (probeLine(html).match(/<span class="hljs-keyword">/g) ?? []).length,
    0,
    `${label}: probe lost its keyword`,
  );
  assert.notEqual(html.split("\n").at(-1), "", `${label}: spans reach EOF`);
}

function assertParamsFixed(highlight, buffer, control, label) {
  const html = highlight(buffer);
  assertParamsClosed(html, label);
  assert.ok(html.includes('class="hljs-comment"'), `${label}: comment colored`);
  assert.equal(probeLine(html), probeLine(highlight(control)), label);
}

function assertStockParams(run) {
  assertParamsCollapsed(run("typescript"), TS_PARAMS_REPRO, "stock TS params");
  assertParamsCollapsed(run("javascript"), JS_PARAMS_REPRO, "stock JS params");
  for (const [language, buffer, label] of TRIGGER_CONTROLS) {
    assertParamsClosed(run(language)(buffer), `stock ${label}`);
  }
  return [run("typescript")(TS_PAREN_COMMENT), run("typescript")(CONTROL)];
}

function assertFixedParams(run, unchanged) {
  for (const [buffer, label] of [
    [TS_PARAMS_REPRO, "JSDoc"],
    [TS_PARAMS_LINE, "line comment"],
    [TS_FN_DECL, "function declaration"],
    [TS_BRACE_IN_COMMENT, "brace in comment"],
  ]) {
    assertParamsFixed(run("typescript"), buffer, TS_PARAMS_CONTROL, label);
  }
  assertParamsFixed(
    run("javascript"),
    JS_PARAMS_REPRO,
    JS_PARAMS_CONTROL,
    "JS destructuring",
  );
  for (const [language, buffer, label] of TRIGGER_CONTROLS) {
    const html = run(language)(buffer);
    assertParamsClosed(html, `spliced ${label}`);
    assert.ok(
      html.includes('class="hljs-comment"'),
      `${label}: comment colored`,
    );
  }
  assert.equal(run("typescript")(TS_PAREN_COMMENT), unchanged[0]);
  assert.equal(run("typescript")(CONTROL), unchanged[1]);
}

test("params brace shape: one splice per stock grammar, then idempotent", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  for (const stock of [stockTypescript, stockJavascript]) {
    const lang = stock(hljs);
    assert.equal(spliceParamsComment(lang), 1);
    assert.equal(spliceParamsComment(lang), 0);
    assert.ok(!isJsParamsComment(lang));
  }
  const ts = typescriptNoJsx(hljs);
  const js = javascriptWithParamsComment(hljs);
  assert.equal(spliceParamsComment(ts), 0);
  assert.equal(spliceParamsComment(js), 0);
  assert.ok(isJsParamsComment(js));
  assert.ok(!isJsParamsComment(ts));
  assert.ok(!isJsParamsComment(undefined));
});

test("markdown params: stock collapses, patched ids and aliases close spans", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("typescript", stockTypescript);
  hljs.registerLanguage("javascript", stockJavascript);
  const run = (language) => (code) =>
    hljs.highlight(code, { language, ignoreIllegals: true }).value;
  const unchanged = assertStockParams(run);

  ensureTsNoJsx(hljs);
  assertFixedParams(run, unchanged);
  for (const id of ["javascript", "js", "mjs", "cjs", "jsx"]) {
    assertParamsFixed(run(id), JS_PARAMS_REPRO, JS_PARAMS_CONTROL, id);
  }
  assertParamsFixed(run("tsx"), TS_PARAMS_REPRO, TS_PARAMS_CONTROL, "tsx");
});

test("markdown params: late full-build and half-ours states re-apply", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  const run = (code) =>
    hljs.highlight(code, {
      language: "javascript",
      ignoreIllegals: true,
    }).value;
  ensureTsNoJsx(hljs);
  for (const replaceTypescript of [true, false]) {
    if (replaceTypescript) hljs.registerLanguage("typescript", stockTypescript);
    hljs.registerLanguage("javascript", stockJavascript);
    assert.equal(isTsNoJsx(hljs.getLanguage("typescript")), !replaceTypescript);
    assert.ok(!isJsParamsComment(hljs.getLanguage("javascript")));
    assertParamsCollapsed(run, JS_PARAMS_REPRO, "late stock javascript");
    ensureTsNoJsx(hljs);
    assert.ok(isTsNoJsx(hljs.getLanguage("typescript")));
    assert.ok(isJsParamsComment(hljs.getLanguage("javascript")));
    assertParamsFixed(run, JS_PARAMS_REPRO, JS_PARAMS_CONTROL, "re-applied JS");
  }
});

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
  hljs.registerLanguage("javascript", stockJavascript);
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
  const unchanged = assertStockParams(run);

  installTsNoJsx(engine);
  assertFixedParams(run, unchanged);
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
