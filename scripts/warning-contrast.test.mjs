// Pins the light theme's `--warning` token to WCAG 2.x AA on every surface it
// paints: text on white, the /5 and /10 warning tints, muted chips and the
// accent-selected file row (>= 4.5), plus fills on white and muted (>= 3.0).
// Tokens come from the FIRST `:root` block of the real src/App.css (the light
// theme; later `:root` blocks hold syntax colors and easing curves), so a
// token drift fails here. Stdlib only: the installless guards job runs it too.
// Any token this can't read FAILS the suite rather than skipping it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CSS_PATH = new URL("../src/App.css", import.meta.url);
const BLOCK = "the first :root block of src/App.css (the light theme)";

/** The first `:root { … }` body; throws when it is missing or unterminated. */
function firstRootBlock(css) {
  const open = /^:root\s*\{/m.exec(css);
  if (!open) throw new Error(`no :root block found in src/App.css`);
  const start = open.index + open[0].length;
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`${BLOCK} is unterminated`);
  return css.slice(start, end);
}

/** `--name: oklch(L C H);` out of `block` as [L, C, H]; exactly one decl. */
function oklchToken(block, name) {
  const decl = new RegExp(
    `^\\s*--${name}\\s*:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)\\s*;`,
    "gm",
  );
  const hits = [...block.matchAll(decl)];
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one plain oklch(L C H) --${name} in ${BLOCK}, found ${hits.length}`,
    );
  }
  const values = hits[0].slice(1, 4).map(Number);
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error(`--${name} in ${BLOCK} has an unreadable value`);
  }
  return values;
}

/** OKLCH → gamma-encoded sRGB in [0, 1] (Ottosson's matrices, clipped). */
function oklchToSrgb([l, c, h]) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  });
}

/** `fg` at `alpha` over opaque `bg`, composited in gamma-encoded sRGB. */
function over(fg, alpha, bg) {
  return fg.map((v, i) => alpha * v + (1 - alpha) * bg[i]);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(x, y) {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

const block = firstRootBlock(readFileSync(CSS_PATH, "utf8"));

test("the first :root block is the light theme", () => {
  assert.match(block, /color-scheme:\s*light\s*;/, `${BLOCK}: not light`);
});

test("light --warning clears WCAG AA on every surface it paints", () => {
  const warning = oklchToSrgb(oklchToken(block, "warning"));
  const white = oklchToSrgb(oklchToken(block, "background"));
  const muted = oklchToSrgb(oklchToken(block, "muted"));
  const accent = oklchToSrgb(oklchToken(block, "accent"));
  const pairs = [
    ["text on white (background/card/popover)", white, 4.5],
    ["text on bg-warning/5 over white", over(warning, 0.05, white), 4.5],
    ["text on bg-warning/10 over white", over(warning, 0.1, white), 4.5],
    ["text on muted chips", muted, 4.5],
    ["text on an accent-selected row", accent, 4.5],
    ["fill against white", white, 3.0],
    ["fill against muted", muted, 3.0],
  ];
  for (const [label, surface, floor] of pairs) {
    const ratio = contrast(warning, surface);
    assert.ok(
      ratio >= floor,
      `--warning ${label}: ${ratio.toFixed(2)}:1 is below ${floor}:1 (${BLOCK})`,
    );
  }
});

test("the contrast math reproduces the old token's measured 3.76:1", () => {
  const old = oklchToSrgb([0.62, 0.13, 65]);
  const white = oklchToSrgb([1, 0, 0]);
  assert.equal(contrast(old, white).toFixed(2), "3.76");
});
