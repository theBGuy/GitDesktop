// Pins the JSX-less typescript and TS/JS comment/regex transforms
// (src/features/diff/hljs-ts-no-jsx.ts) on both highlight.js engines: lowlight's
// singleton (@git-diff-view/core) and a `lib/core` instance standing in for
// the markdown singleton. Comment fixes have stock-collapse negative controls;
// regex and division controls pin closed spans. Mode counts make an hljs bump
// that moves a mode out from under its structural predicate fail loudly.
//
// The imports reach straight into `src/` under Node's type stripping, so the
// module must stay free of aliased and app imports. Static imports are stdlib
// plus the import-free diff-lang.ts, so the installless `guards` job can load
// this file: the highlight.js / @git-diff-view graph loads dynamically and
// skips only when one of those PACKAGES is unresolved; GD_EXPECT_DEPS turns
// that skip into a failure on frontend.yml's installed, enforced run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { diffLang } from "../src/features/diff/diff-lang.ts";

const DEP_PACKAGES =
  /Cannot find package '(@git-diff-view\/core|highlight\.js)'/;

let highlighter;
let hljsCore;
let stockTypescript;
let stockJavascript;
let xml;
let ensurePatchedJsGrammars;
let installPatchedJsGrammars;
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
      ensurePatchedJsGrammars,
      installPatchedJsGrammars,
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
const TEMPLATE_COMMENT = "const s = `${ /* it's */ a }`;\nconst x = 1;\n";
const TEMPLATE_COMMENT_CONTROL = TEMPLATE_COMMENT.replace("it's", "its");
const PARAMS_REGEX_CLASS =
  "function f(x = {pattern: /[/*]/}) {}\nconst y = 1;\n";
const PARAMS_REGEX_URL =
  String.raw`function f(x = {pattern: /https?:\/\//}) {}` + "\nconst y = 1;\n";
const PARAMS_REGEX_COMMA =
  String.raw`function f(x = {a: 1, b: /x\/y/}) {}` + "\nconst y = 1;\n";
const PARAMS_DIVISION = "function f(x = {value: a / b / c}) {}\nconst y = 1;\n";
const TEMPLATE_REGEX_CLASS = "const s = `${ /[/*]/ }`;\nconst y = 1;\n";
const TEMPLATE_REGEX_URL = "const s = `${ /https?:\\/\\// }`;\nconst y = 1;\n";
const TEMPLATE_DIVISION = "const s = `${ a / b / c }`;\nconst y = 1;\n";
const TEMPLATE_BRACE_DIVISION =
  "const s = `${ {value: a / b / c} }`;\nconst y = 1;\n";
const TEMPLATE_TAIL_DIVISION = "const s = `${ a / b } / more`;\nconst x = 1;\n";

const TS_COMMENT_CASES = [
  [TS_PARAMS_REPRO, "JSDoc"],
  [TS_PARAMS_LINE, "line comment"],
  [TS_FN_DECL, "function declaration"],
  [TS_BRACE_IN_COMMENT, "brace in comment"],
];
// Optional row fields list expected comments and whether stock collapses.
const REGEX_CASES = [
  [PARAMS_REGEX_CLASS, "params regex character class"],
  [PARAMS_REGEX_URL, "params URL regex"],
  [PARAMS_REGEX_COMMA, "params regex property after comma"],
  [TEMPLATE_REGEX_CLASS, "substitution regex character class"],
  [TEMPLATE_REGEX_URL, "substitution URL regex"],
  ...[
    "value = /re/",
    "(/re/)",
    "(value, /re/)",
    "[/re/]",
    "!/re/",
    "value & /re/",
    "value | /re/",
    "value ? /re/ : false",
  ].map((expression) => [
    `const s = \`\${ ${expression} }\`;\nconst x = 1;\n`,
    `substitution regex expression start: ${expression}`,
  ]),
  [
    "function f(x = {method() { a; /re/; }}) {}\nconst y = 1;\n",
    "params brace regex after semicolon",
  ],
  ...[
    "typeof /[/*]/",
    "void /[/*]/",
    "await /[/*]/",
    "a in /[/*]/",
    "a instanceof /[/*]/",
    "a + /[/*]/.source",
    "a - /[/*]/",
    "a * /[/*]/",
    "a < /[/*]/",
    "a > /[/*]/",
    "~/[/*]/",
    "(u) => /[/*]/.test(u)",
    "!!/[/*]/",
    "a && !/[/*]/.test(s)",
  ].flatMap((expression) => [
    [
      `const s = \`\${ ${expression} }\`;\nconst x = 1;\n`,
      `substitution regex extended start: ${expression}`,
    ],
    [
      `function f(x = {k: ${expression}}) {}\nconst y = 1;\n`,
      `params regex extended start: ${expression}`,
    ],
  ]),
  ...[
    "return /[/*]/;",
    "return !/[/*]/.test(s);",
    "throw /[/*]/;",
    "switch (v) { case /[/*]/: }",
  ].map((statement) => [
    `function f(x = { m() { ${statement} } }) {}\nconst y = 1;\n`,
    `params method regex: ${statement}`,
  ]),
  [
    "function f(x = { *m() { yield /[/*]/; } }) {}\nconst y = 1;\n",
    "params generator regex: yield",
  ],
  [
    "const s = `${ " +
      String.raw`list.map((u) => /^https?:\/\//.test(u))` +
      " }`;\nconst x = 1;\n",
    "substitution URL regex in arrow callback",
  ],
  [
    "function f(x = {pattern: /* note */ /[/*]/}) {}\nconst y = 1;\n",
    "params block comment before regex",
    ["/* note */"],
  ],
  [
    "function f(x = {pattern: // note\n  /[/*]/}) {}\nconst y = 1;\n",
    "params line comment before regex",
    ["// note"],
  ],
  [
    "function f(x = {pattern: /* a */ /* b */ /[/*]/}) {}\nconst y = 1;\n",
    "params consecutive block comments before regex",
    ["/* a */", "/* b */"],
  ],
  [
    "function f(x = {pattern: /* it's */ /[/*]/}) {}\nconst y = 1;\n",
    "params apostrophe comment before regex",
    ["/* it's */"],
    true,
  ],
  [
    "const s = `${ /* c */ /[/*]/ }`;\nconst x = 1;\n",
    "substitution block comment before regex",
    ["/* c */"],
  ],
  [
    "const s = `${ a ? /* c */ /[/*]/ : null }`;\nconst x = 1;\n",
    "substitution conditional comment before regex",
    ["/* c */"],
  ],
  [
    "const s = `${ list.map((u) => /* c */ /[/*]/.test(u)) }`;\nconst x = 1;\n",
    "substitution arrow comment before regex",
    ["/* c */"],
  ],
  [
    "const s = `${ !/* c */ /[/*]/.test(s) }`;\nconst x = 1;\n",
    "substitution prefix-not comment before regex",
    ["/* c */"],
  ],
  [
    "function f(x = { m() { return /* c */ /[/*]/; } }) {}\nconst y = 1;\n",
    "params return block comment before regex",
    ["/* c */"],
  ],
  [
    "function f(x = { m() { return // c\n /[/*]/; } }) {}\nconst y = 1;\n",
    "params return line comment before regex",
    ["// c"],
  ],
  [
    String.raw`function f(x = {pattern: /* note */ /^https?:\/\//}) {}` +
      "\nconst y = 1;\n",
    "params block comment before URL regex",
    ["/* note */"],
  ],
  [
    "function f(x = {pattern: // note\n  " +
      String.raw`/^https?:\/\//}) {}` +
      "\nconst y = 1;\n",
    "params line comment before URL regex",
    ["// note"],
  ],
  [
    "const s = `${ a < /[/*]/ }`;\nconst x = 1;\n",
    "substitution spaced less-than before regex",
  ],
  [
    "function f(x = {k: a < /[/*]/}) {}\nconst y = 1;\n",
    "params spaced less-than before regex",
  ],
  [
    "function f(x = {pattern: /** doc */ /[/*]/}) {}\nconst y = 1;\n",
    "params JSDoc comment before regex",
    ["/** doc */"],
  ],
  [
    "function f(x = {k: f(/* default: lib/* */ " +
      String.raw`/^https?:\/\//.test(u))}) {}` +
      "\nconst y = 1;\n",
    "params nested opener in block comment before URL regex",
    ["/* default: lib/* */"],
  ],
  [
    "function f(x = {k: /* http://x.com/*/ /[/*]/}) {}\nconst y = 1;\n",
    "params slash-ending block comment before regex",
    ["/* http://x.com/*/"],
  ],
  [
    "function f(x = {r: /* matches /* */ /[/*]/}) {}\nconst y = 1;\n",
    "params nested comment marker before regex",
    ["/* matches /* */"],
  ],
  [
    "function f(x = {k: f(// c\n " +
      String.raw`/^https?:\/\//.test(u))}) {}` +
      "\nconst y = 1;\n",
    "params paren-glued line comment before URL regex",
    ["// c"],
  ],
  [
    "function f(x = {k: [// c\n " +
      String.raw`/\/\//]}) {}` +
      "\nconst y = 1;\n",
    "params bracket-glued line comment before regex",
    ["// c"],
  ],
  [
    "function f(x = {k: x\u00a0in /[/*]/}) {}\nconst y = 1;\n",
    "params no-break space before expression keyword regex",
  ],
];
const DIVISION_CASES = [
  [PARAMS_DIVISION, "params double division"],
  [TEMPLATE_DIVISION, "substitution double division"],
  [TEMPLATE_BRACE_DIVISION, "substitution brace double division"],
  [
    TEMPLATE_TAIL_DIVISION,
    "division before substitution end and template slash",
  ],
  ...["a / b", "(a) / b / c", "1 / b / c", "values[0] / b / c"].flatMap(
    (expression) => [
      [
        `function f(x = {value: ${expression}}) {}\nconst y = 1;\n`,
        `params division: ${expression}`,
      ],
      [
        `const s = \`\${ ${expression} }\`;\nconst x = 1;\n`,
        `substitution division: ${expression}`,
      ],
    ],
  ),
  ...[
    "a! / b / c",
    "f(a)! / b / c",
    "a?.b! / c / d",
    "v[0]! / b / c",
    "i++ / n / 2",
    "i-- / n / 2",
    "obj.return / b / c",
    "item.in / b / c",
    "min / b / c",
    "avoid / b / c",
  ].flatMap((expression) => [
    [
      `const s = \`\${ ${expression} }\`;\nconst x = 1;\n`,
      `substitution division after operand: ${expression}`,
    ],
    [
      `function f(x = {k: ${expression}}) {}\nconst y = 1;\n`,
      `params division after operand: ${expression}`,
    ],
  ]),
  [
    "function f(x = {k: a! / b}) {} // see a/b\nconst y = 1;\n",
    "params non-null division before trailing comment slash",
  ],
  [
    "function f(x = { pct: done! / total, label: 'a/b' }) {}\nconst y = 1;\n",
    "params non-null division before string slash",
  ],
  [
    "const s = `${ n! / d }/${ m }`;\nconst x = 1;\n",
    "substitution non-null division before template separator",
  ],
  [
    "const s = `${ (n! / d).toFixed(1) } km/h`;\nconst x = 1;\n",
    "substitution non-null division before template unit slash",
  ],
  [
    "const s = `${ i++ / n }/${ m }`;\nconst x = 1;\n",
    "substitution postfix division before template separator",
  ],
  [
    "function f(x = {k: a! / b[c / 2]}) {}\nconst y = 1;\n",
    "params non-null division with indexed divisor",
  ],
  [
    "function f(x = {k: a /* c */ / b / c}) {}\nconst y = 1;\n",
    "params division after block comment",
  ],
  [
    "function f(x = {k: a /* note: */ / b / c}) {}\nconst y = 1;\n",
    "params division after a colon-ending block comment",
  ],
  [
    "const s = `${ a /* c, */ / b / c }`;\nconst x = 1;\n",
    "substitution division after a comma-ending block comment",
  ],
  [
    "const s = `${ i++ /* c */ / n / 2 }`;\nconst x = 1;\n",
    "substitution postfix division after block comment",
  ],
  [
    "function f(x = {k: a! /* c */ / b / c}) {}\nconst y = 1;\n",
    "params non-null division after block comment",
  ],
  [
    "const s = `${ a /* c */ / b }/${ m }`;\nconst x = 1;\n",
    "substitution division after comment before template separator",
  ],
  [
    "function f(x = {k: a // note\n / b}) {}\nconst y = 1;\n",
    "params division after line comment",
  ],
  [
    'const a = /* x */ 1;\nconst s = `${ c /* px */ / 2 + "a/b" }`;\n' +
      "const x = 1;\n",
    "substitution division after an earlier block comment",
  ],
  [
    "const g = '**/*.ts';\nconst s = `${ size /* bytes */ / 1024 }/s`;\n" +
      "const x = 1;\n",
    "substitution division after glob string and block comment",
  ],
  [
    'function f(x = { w: total /* bytes */ / 1024, u: "a/b" }) {}\n' +
      "const y = 1;\n",
    "params division after block comment before string slash",
  ],
  [
    'const s = `${ "a://b"\n / 2 + "a/b" }`;\nconst x = 1;\n',
    "substitution division after URL string on prior line",
  ],
  [
    "const s = `${ a // http://x\n / b }/`;\nconst x = 1;\n",
    "substitution division after URL in line comment",
  ],
  [
    "const s = `${ a // TODO: //\n / b }/`;\nconst x = 1;\n",
    "substitution division after inner line-comment opener",
  ],
  [
    'function Button({ icon = <span>Go</span>, href = "/home" }) {}\n' +
      "const y = 1;\n",
    "params JSX closing tag before path string",
  ],
  [
    "const s = `${ <b>x</b> }/path`;\nconst x = 1;\n",
    "substitution JSX closing tag before template path",
  ],
  [
    "function C({ title = <b>Hi</b> }) { // default title\n" +
      "  return title;\n}\nconst y = 1;\n",
    "params JSX closing tag before function-body comment",
  ],
  [
    'function f({ a = <Fade in />, to = "/x" }) {}\nconst y = 1;\n',
    "params JSX keyword attribute before self-closing slash",
  ],
  [
    'const s = `${ x!++ / 2 + "a/b" }`;\nconst x = 1;\n',
    "substitution non-null postfix division",
  ],
  [
    'const s = `${ a ++ / 2 + "a/b" }`;\nconst x = 1;\n',
    "substitution spaced postfix division",
  ],
  [
    'const s = `${ caf\u00e9++ / 2 + "a/b" }`;\nconst x = 1;\n',
    "substitution non-ASCII identifier postfix division",
  ],
  [
    'class C { #in = 1; m(x = { r: this.#in / 2, s: "/" }) {} }\n' +
      "const y = 1;\n",
    "params division after private keyword name",
  ],
  [
    'function Card({ el = <Foo<T> />, y = "/b" }) {}\nconst y = 1;\n',
    "params generic JSX self-closing slash",
  ],
  [
    'const s = `a${ <A in /> / 2 + "a/b" }b`;\nconst x = 1;\n',
    "substitution division after JSX self-closing tag",
  ],
  [
    'function f(x = {k: obj.\n  in / 2 + "a/b",\n  j: "p/q"}) {}\n' +
      "const y = 1;\n",
    "params division after property keyword on next line",
  ],
  [
    "const s = `${ '/* x' /* c */ / 2 }/`;\nconst x = 1;\n",
    "substitution division after comment-opener string and comment",
  ],
];
const DIVISION_COMMENT_CASES = [
  [
    "function f(x = {value: a / b /* it's fine */}) {}\nconst y = 1;\n",
    "params division before block comment",
    "/* it's fine */",
  ],
  [
    "const s = `${ a / b /* it's fine */ }`;\nconst x = 1;\n",
    "substitution division before block comment",
    "/* it's fine */",
  ],
  [
    "function f(x = {value: a / b // it's fine\n}) {}\nconst y = 1;\n",
    "params division before line comment",
    "// it's fine",
  ],
  [
    "const s = `${ a / b // it's fine\n }`;\nconst x = 1;\n",
    "substitution division before line comment",
    "// it's fine",
  ],
];

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

function assertDivision(html, label) {
  assertParamsClosed(html, label);
  assert.ok(!html.includes('class="hljs-regexp"'), `${label}: no regex span`);
}

function assertStockParams(run) {
  for (const [buffer, label] of TS_COMMENT_CASES) {
    assertParamsCollapsed(run("typescript"), buffer, `stock ${label}`);
  }
  assertParamsCollapsed(run("tsx"), TS_PARAMS_REPRO, "stock tsx params");
  assertParamsCollapsed(run("javascript"), JS_PARAMS_REPRO, "stock JS params");
  for (const language of ["typescript", "javascript", "tsx"]) {
    assertParamsCollapsed(
      run(language),
      TEMPLATE_COMMENT,
      `stock ${language} substitution comment`,
    );
    for (const [buffer, label, , stockCollapses] of [
      ...REGEX_CASES,
      ...DIVISION_CASES,
    ]) {
      if (stockCollapses) {
        assertParamsCollapsed(
          run(language),
          buffer,
          `stock ${language} ${label}`,
        );
      } else {
        assertParamsClosed(run(language)(buffer), `stock ${language} ${label}`);
      }
    }
  }
  for (const [language, buffer, label] of TRIGGER_CONTROLS) {
    assertParamsClosed(run(language)(buffer), `stock ${label}`);
  }
  return [run("typescript")(TS_PAREN_COMMENT), run("typescript")(CONTROL)];
}

function assertFixedParams(run, unchanged) {
  for (const [buffer, label] of TS_COMMENT_CASES) {
    assertParamsFixed(run("typescript"), buffer, TS_PARAMS_CONTROL, label);
  }
  assertParamsFixed(run("tsx"), TS_PARAMS_REPRO, TS_PARAMS_CONTROL, "tsx");
  assertParamsFixed(
    run("javascript"),
    JS_PARAMS_REPRO,
    JS_PARAMS_CONTROL,
    "JS destructuring",
  );
  for (const language of ["typescript", "javascript", "tsx"]) {
    assertParamsFixed(
      run(language),
      TEMPLATE_COMMENT,
      TEMPLATE_COMMENT_CONTROL,
      `${language} substitution comment`,
    );
    for (const [buffer, label, comments = []] of REGEX_CASES) {
      const html = run(language)(buffer);
      assertParamsClosed(html, `${language} ${label}`);
      assert.ok(
        html.includes('class="hljs-regexp"'),
        `${language} ${label}: regex colored`,
      );
      assert.equal(
        (html.match(/<span class="hljs-comment">/g) ?? []).length,
        comments.length,
        `${language} ${label}: only expected comments`,
      );
      for (const comment of comments) {
        assert.ok(
          html
            .replaceAll("&#x27;", "'")
            .includes(`<span class="hljs-comment">${comment}</span>`),
          `${language} ${label}: comment colored`,
        );
      }
    }
    for (const [buffer, label] of DIVISION_CASES) {
      assertDivision(run(language)(buffer), `${language} ${label}`);
    }
    for (const [buffer, label, comment] of DIVISION_COMMENT_CASES) {
      const html = run(language)(buffer);
      assertDivision(html, `${language} ${label}`);
      assert.ok(
        html
          .replaceAll("&#x27;", "'")
          .includes(`<span class="hljs-comment">${comment}</span>`),
        `${language} ${label}: comment colored`,
      );
    }
  }
  for (const [language, buffer, label] of TRIGGER_CONTROLS) {
    const html = run(language)(buffer);
    assertParamsClosed(html, `spliced ${label}`);
    assert.ok(
      html.includes('class="hljs-comment"'),
      `${language} ${label}: comment colored`,
    );
  }
  assert.equal(run("typescript")(TS_PAREN_COMMENT), unchanged[0]);
  assert.equal(run("typescript")(CONTROL), unchanged[1]);
}

test("comment chain highlighting finishes in a bounded child process", {
  skip,
}, () => {
  const transformUrl = new URL(
    "../src/features/diff/hljs-ts-no-jsx.ts",
    import.meta.url,
  ).href;
  const coreUrl = import.meta.resolve("highlight.js/lib/core");
  const script = [
    `import hljsCore from ${JSON.stringify(coreUrl)};`,
    `import { ensurePatchedJsGrammars } from ${JSON.stringify(transformUrl)};`,
    "const hljs = hljsCore.newInstance();",
    "ensurePatchedJsGrammars(hljs);",
    'const code = "const s = `${ c " + "/* n */ ".repeat(40) + "/ 2 }`;";',
    'hljs.highlight(code, { language: "typescript", ignoreIllegals: true });',
    'const spaces = "const s = `${ a" + " ".repeat(160000) + "/ b }`;";',
    'hljs.highlight(spaces, { language: "typescript", ignoreIllegals: true });',
    'const slashes = "const s = `${ a\\n// " + "// ".repeat(160000) +',
    '  "\\n/ b }`;";',
    'hljs.highlight(slashes, { language: "typescript", ignoreIllegals: true });',
    'console.log("params-comment-chain-ok");',
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10000, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.equal(child.stdout.trim(), "params-comment-chain-ok");
});

test("brace/subst shape: four inserted modes per grammar, then idempotent", {
  skip,
}, () => {
  const hljs = hljsCore.newInstance();
  for (const stock of [stockTypescript, stockJavascript]) {
    const lang = stock(hljs);
    assert.equal(spliceParamsComment(lang), 4);
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

  ensurePatchedJsGrammars(hljs);
  assertFixedParams(run, unchanged);
  for (const id of ["javascript", "js", "mjs", "cjs", "jsx"]) {
    assertParamsFixed(run(id), JS_PARAMS_REPRO, JS_PARAMS_CONTROL, id);
  }
  for (const id of ["ts", "mts", "cts"]) {
    assertParamsFixed(run(id), TS_PARAMS_REPRO, TS_PARAMS_CONTROL, id);
  }
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
  ensurePatchedJsGrammars(hljs);
  for (const replaceTypescript of [true, false]) {
    if (replaceTypescript) hljs.registerLanguage("typescript", stockTypescript);
    hljs.registerLanguage("javascript", stockJavascript);
    assert.equal(isTsNoJsx(hljs.getLanguage("typescript")), !replaceTypescript);
    assert.ok(!isJsParamsComment(hljs.getLanguage("javascript")));
    assertParamsCollapsed(run, JS_PARAMS_REPRO, "late stock javascript");
    ensurePatchedJsGrammars(hljs);
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

test("markdown (lib/core): stock collapses, ensurePatchedJsGrammars fixes", {
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

  ensurePatchedJsGrammars(hljs);
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

  // Full-build registration restores stock; ensurePatchedJsGrammars re-applies.
  hljs.registerLanguage("typescript", stockTypescript);
  assertCollapsed(run("typescript"), REPRO, "re-registered stock");
  ensurePatchedJsGrammars(hljs);
  assertFixed(run("typescript"), REPRO, CONTROL, "re-applied");
});

test("diff (lowlight): stock collapses, installPatchedJsGrammars fixes", {
  skip,
}, () => {
  const engine = highlighter.getHighlighterEngine();
  const run = (lang) => (code) => toHtml(engine.highlight(lang, code));
  const lang = diffLang("src/retry.mts");
  assert.equal(lang, "typescript");
  const before = engine.listLanguages();

  assertCollapsed(run(lang), REPRO, "stock");
  const unchanged = assertStockParams(run);

  installPatchedJsGrammars(engine);
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
  installPatchedJsGrammars(engine);
  const html = run("typescript")(REPRO);
  assert.ok(!html.includes("hljs-attr"), "custom typescript grammar in use");
  assert.ok(run("gd-custom")("const").includes("hljs-keyword"));
});
