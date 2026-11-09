// Pins the toast close button's hover and focus to app tokens
// (src/App.css). sonner 2.0.8 paints the hover with its own neutral grays in
// both themes, from the two selectors quoted below; the vendored wrapper
// (src/components/ui/sonner.tsx) only sets the normal-state variables. The app
// rule must outrank both by specificity, since sonner injects its stylesheet at
// runtime and load order is no guarantee. In-memory mutants of App.css must
// fail the same checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** sonner 2.0.8's close-button hover selectors (dist/styles.css). */
const SONNER_HOVER = [
  "[data-sonner-toast][data-styled='true']:hover [data-close-button]:hover",
  "[data-sonner-toaster][data-sonner-theme='dark'] [data-sonner-toast] [data-close-button]:hover",
];

/** Attribute, class and pseudo-class count: every selector here is
 *  id-free and type-free, so this is the whole specificity. */
function specificity(selector) {
  const unquoted = selector.replace(/(["'])[^"']*\1/g, "");
  const attrs = (unquoted.match(/\[/g) ?? []).length;
  const classes = (unquoted.match(/\.[\w-]/g) ?? []).length;
  const pseudo = (unquoted.match(/:(?!:)[\w-]+/g) ?? []).length;
  return attrs + classes + pseudo;
}

/** The rules of `css` as { selector, body }; comments stripped. */
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    out.push({ selector: m[1].replace(/\s+/g, " ").trim(), body: m[2] });
  return out;
}

function decl(body, prop) {
  const m = body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

const TOKEN = /^var\(--[\w-]+\)$/;

/** The names of the checks `css` fails. */
function problems(css) {
  const failed = [];
  const all = rules(css);
  const scoped = (suffix) =>
    all.filter(
      (r) =>
        r.selector.includes(".cn-toast") &&
        r.selector.endsWith(`[data-close-button]${suffix}`),
    );
  const hover = scoped(":hover");
  if (hover.length !== 1) failed.push("one scoped hover rule");
  const [rule] = hover;
  if (rule) {
    const top = Math.max(...SONNER_HOVER.map(specificity));
    if (specificity(rule.selector) <= top) failed.push("outranks sonner");
    if (!rule.selector.includes("[data-sonner-theme]"))
      failed.push("every theme");
    for (const prop of ["background", "border-color"])
      if (!TOKEN.test(decl(rule.body, prop) ?? ""))
        failed.push(`${prop} is a token`);
  }
  const focus = scoped(":focus-visible");
  const ring = focus[0] && decl(focus[0].body, "outline");
  if (!ring || !/var\(--ring\)/.test(ring) || /\bnone\b|\b0\b/.test(ring))
    failed.push("visible focus ring");
  // sonner's own focus shadow would draw a second, gray ring beside it.
  const shadow = focus[0] && decl(focus[0].body, "box-shadow");
  if (shadow !== "none" && !TOKEN.test(shadow ?? ""))
    failed.push("one focus ring");
  return failed;
}

const css = readFileSync(
  new URL("../src/App.css", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

test("sonner's selectors measure as quoted", () => {
  assert.deepEqual(SONNER_HOVER.map(specificity), [5, 5]);
});

test("the close button hovers and focuses in app tokens", () => {
  assert.deepEqual(problems(css), []);
});

test("a rule that loses a guard fails the checks", () => {
  const swap = (from, to) => {
    assert.ok(css.includes(from), `mutant anchor missing: ${from}`);
    return css.replace(from, to);
  };
  const mutants = {
    "sonner's own specificity": swap(
      '[data-sonner-toaster][data-sonner-theme]\n  .cn-toast[data-sonner-toast][data-styled="true"]\n  [data-close-button]:hover',
      '.cn-toast[data-sonner-toast][data-styled="true"] [data-close-button]:hover',
    ),
    "dark only": swap(
      '[data-sonner-toaster][data-sonner-theme]\n  .cn-toast[data-sonner-toast][data-styled="true"]\n  [data-close-button]:hover',
      '[data-sonner-toaster][data-sonner-theme="dark"]\n  .cn-toast[data-sonner-toast][data-styled="true"]\n  [data-close-button]:hover',
    ),
    "a literal background": swap(
      "background: var(--accent);",
      "background: hsl(0, 0%, 12%);",
    ),
    "a literal border": swap(
      "border-color: var(--border);",
      "border-color: hsl(0, 0%, 25%);",
    ),
    "no focus ring": swap("outline: 2px solid var(--ring);", "outline: none;"),
    "sonner's focus shadow kept": swap("  box-shadow: none;\n", ""),
  };
  for (const [name, text] of Object.entries(mutants)) {
    assert.notEqual(text, css, name);
    assert.notDeepEqual(problems(text), [], name);
  }
});
