// Pins the front-matter markdown grammar (src/features/diff/hljs-ts-no-jsx.ts)
// on both highlight.js engines: lowlight's singleton (@git-diff-view/core, the
// diff) and a `lib/core` instance standing in for the markdown singleton.
// Front matter engages exactly where stripFrontmatter (markdown-preview.ts)
// strips it; its bails stay byte-identical to stock. The intraword `_` guard
// has stock negative controls, and the opener mode count makes an hljs bump
// that moves the `_`/`__` variants out from under the shape match fail loudly.
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
let stockMarkdown;
let yaml;
let ini;
let xml;
let ensurePatchedJsGrammars;
let installPatchedJsGrammars;
let markdownWithFrontmatter;
let isMdFrontmatter;
let guardIntrawordUnderscores;
let skip = false;
// Settled, not raced: EVERY failure must be a missing dep package, so a broken
// src module can't hide behind an absent package's earlier rejection.
const loads = await Promise.allSettled([
  import("@git-diff-view/core"),
  import("highlight.js/lib/core"),
  import("highlight.js/lib/languages/markdown"),
  import("highlight.js/lib/languages/yaml"),
  import("highlight.js/lib/languages/ini"),
  import("highlight.js/lib/languages/xml"),
  import("../src/features/diff/hljs-ts-no-jsx.ts"),
]);
const failures = loads.filter((l) => l.status === "rejected");
if (failures.length === 0) {
  [
    { highlighter },
    { default: hljsCore },
    { default: stockMarkdown },
    { default: yaml },
    { default: ini },
    { default: xml },
    {
      ensurePatchedJsGrammars,
      installPatchedJsGrammars,
      markdownWithFrontmatter,
      isMdFrontmatter,
      guardIntrawordUnderscores,
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

// 64 lines of YAML: snake_case keys, mid-word `_` in values, and 4-space
// indented children, all of which stock markdown paints as emphasis or code.
const YAML_BODY = Array.from({ length: 16 }, (_, i) => [
  `section_${i}_name: value_${i}_with_underscores`,
  `nested_${i}_block:`,
  `    child_${i}_key: deep_${i}_value`,
  `    other_${i}_key: [a_b, c_d]`,
]).flat();
const BODY = "\nSome _em_ and __bold__ beside snake_case_prose.\n";
const YAML_FM = ["---", ...YAML_BODY, "---"].join("\n");
const LF = `${YAML_FM}${BODY}`;
const CRLF = LF.replaceAll("\n", "\r\n");
const FM_ONLY = YAML_FM;
const TOML = '+++\ntitle = "Post"\nsnake_case_key = 1\n+++\nBody text.\n';

// Inputs stripFrontmatter keeps whole; none carries `_`, so the patched
// grammar's output must equal stock's byte for byte.
const BAILS = [
  ["---\n\ntitle: Post\n---\n", "hr then blank line"],
  ["---\ntitle: Post\nbody text\n", "no closer"],
  ["---\ntitle: Post\n\n---\n", "blank line before closer"],
  ["Intro prose.\n---\ntitle: Post\n---\n", "leading prose"],
  ["---\n", "lone fence line"],
  ["---\ntitle: Post\n+++\n", "mismatched closer"],
];

const INTRAWORD = ["snake_case_word", "a__b__c"];

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

function count(html, scope) {
  return (html.match(new RegExp(`class="${scope}"`, "g")) ?? []).length;
}

const INLINE = ["hljs-emphasis", "hljs-strong", "hljs-code"];

/** The fixture's inline scopes, so a stock run proves the bug it exercises. */
function inlineScopes(html) {
  return INLINE.reduce((n, scope) => n + count(html, scope), 0);
}

function assertYamlFrontmatter(html, label) {
  assert.equal(count(html, "language-yaml"), 1, `${label}: one yaml island`);
  assert.ok(count(html, "hljs-attr") >= 32, `${label}: yaml keys colored`);
}

/** Every grammar assertion over one engine; `stock` ran the same inputs
 *  through the engine's stock markdown first. */
function assertPatched(run, stock, label) {
  for (const [input, name] of [
    [LF, "LF"],
    [CRLF, "CRLF"],
  ]) {
    const html = run(input);
    assertYamlFrontmatter(html, `${label} ${name}`);
    const fmInput = name === "LF" ? FM_ONLY : FM_ONLY.replaceAll("\n", "\r\n");
    const fm = run(fmInput);
    assertYamlFrontmatter(fm, `${label} ${name} front matter only`);
    assert.equal(inlineScopes(fm), 0, `${label} ${name}: no inline scopes`);
    assert.ok(
      inlineScopes(stock(fmInput)) > 0,
      `${label} ${name}: stock control`,
    );
    // The body after the closer keeps markdown: one emphasis, one strong,
    // and snake_case_prose plain.
    assert.equal(count(html, "hljs-emphasis"), 1, `${label} ${name}: _em_`);
    assert.equal(count(html, "hljs-strong"), 1, `${label} ${name}: __bold__`);
    assert.equal(count(html, "hljs-code"), 0, `${label} ${name}: no code`);
  }

  const toml = run(TOML);
  assert.equal(count(toml, "language-ini"), 1, `${label}: +++ is ini`);
  assert.equal(count(toml, "language-yaml"), 0, `${label}: +++ is not yaml`);
  assert.equal(inlineScopes(toml), 0, `${label}: toml has no inline scopes`);

  for (const [input, name] of BAILS) {
    const html = run(input);
    assert.ok(!html.includes("language-"), `${label} ${name}: no island`);
    assert.equal(html, stock(input), `${label} ${name}: stock markdown`);
  }

  for (const input of INTRAWORD) {
    assert.equal(inlineScopes(run(input)), 0, `${label} ${input}: plain`);
    assert.ok(inlineScopes(stock(input)) > 0, `${label} ${input}: stock`);
  }
  assert.equal(count(run("an _em_ word"), "hljs-emphasis"), 1, label);
  assert.equal(count(run("a __bold__ word"), "hljs-strong"), 1, label);
}

test("opener shape: two `_` openers guarded per grammar, then idempotent", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  const lang = stockMarkdown(hljs);
  assert.equal(guardIntrawordUnderscores(lang), 2);
  assert.equal(guardIntrawordUnderscores(lang), 0);
  const patched = markdownWithFrontmatter(hljs);
  assert.ok(isMdFrontmatter(patched));
  assert.equal(guardIntrawordUnderscores(patched), 0);
  assert.deepEqual(patched.aliases, ["md", "mkdown", "mkd"]);
  assert.ok(!isMdFrontmatter(stockMarkdown(hljs)));
  assert.ok(!isMdFrontmatter(undefined));
});

test("markdown (lib/core): ensurePatchedJsGrammars patches and heals", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  for (const [id, lang] of [
    ["xml", xml],
    ["yaml", yaml],
    ["ini", ini],
    ["markdown", stockMarkdown],
  ]) {
    hljs.registerLanguage(id, lang);
  }
  const run = (code) => hljs.highlight(code, { language: "markdown" }).value;
  const stockRuns = new Map();
  const stock = (code) => {
    if (!stockRuns.has(code)) throw new Error(`no stock run for ${code}`);
    return stockRuns.get(code);
  };
  const inputs = [
    LF,
    CRLF,
    FM_ONLY,
    FM_ONLY.replaceAll("\n", "\r\n"),
    TOML,
    ...BAILS.map(([input]) => input),
    ...INTRAWORD,
  ];
  for (const input of inputs) stockRuns.set(input, run(input));

  ensurePatchedJsGrammars(hljs);
  assert.ok(isMdFrontmatter(hljs.getLanguage("markdown")));
  assert.ok(isMdFrontmatter(hljs.getLanguage("md")), "alias resolves");
  assertPatched(run, stock, "lib/core");

  // The full-build load re-registers stock markdown; ensure re-applies.
  hljs.registerLanguage("markdown", stockMarkdown);
  assert.ok(!isMdFrontmatter(hljs.getLanguage("markdown")));
  ensurePatchedJsGrammars(hljs);
  assert.ok(isMdFrontmatter(hljs.getLanguage("markdown")));
  assertYamlFrontmatter(run(LF), "healed");

  // An instance without markdown gains no markdown id.
  const bare = hljsCore.newInstance();
  ensurePatchedJsGrammars(bare);
  assert.equal(bare.getLanguage("markdown"), undefined);
});

test("install: a custom markdown registered afterwards wins its id", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  hljs.registerLanguage("markdown", stockMarkdown);
  const engine = { register: hljs.registerLanguage };
  installPatchedJsGrammars(engine);
  assert.ok(isMdFrontmatter(hljs.getLanguage("markdown")));
  const custom = () => ({ name: "custom-md", contains: [] });
  hljs.registerLanguage("markdown", custom);
  installPatchedJsGrammars(engine);
  assert.equal(hljs.getLanguage("markdown")?.name, "custom-md");
});

test("diff (lowlight): installPatchedJsGrammars patches markdown", {
  skip,
}, () => {
  const engine = highlighter.getHighlighterEngine();
  const lang = diffLang("docs/post.md");
  assert.equal(lang, "markdown");
  const run = (code) => toHtml(engine.highlight(lang, code));
  const before = engine.listLanguages();
  assert.ok(before.includes("markdown") && before.includes("yaml"));
  assert.ok(before.includes("ini"));
  const stockRuns = new Map();
  for (const input of [
    LF,
    CRLF,
    FM_ONLY,
    FM_ONLY.replaceAll("\n", "\r\n"),
    TOML,
    ...BAILS.map(([input]) => input),
    ...INTRAWORD,
  ]) {
    stockRuns.set(input, run(input));
  }
  const stock = (code) => {
    if (!stockRuns.has(code)) throw new Error(`no stock run for ${code}`);
    return stockRuns.get(code);
  };

  installPatchedJsGrammars(engine);
  assertPatched(run, stock, "lowlight");
  assert.deepEqual(
    engine.listLanguages().filter((l) => !before.includes(l)),
    ["tsx"],
  );

  // A custom grammar registered afterwards wins, and a second install (HMR
  // re-evaluation) never re-registers over it.
  engine.register("markdown", () => ({
    contains: [{ scope: "keyword", begin: "---" }],
  }));
  installPatchedJsGrammars(engine);
  const html = run(LF);
  assert.ok(!html.includes("language-yaml"), "custom markdown in use");
  assert.ok(html.includes("hljs-keyword"));
});
