// Pins the raster caps a post's seed is gated on (src/lib/attachments/store.ts)
// equal to the ones the hosted-image loader refuses past
// (MAX_IMAGE_DIMENSION and MAX_IMAGE_PIXELS in src-tauri/src/image_sniff.rs):
// a looser TS side shows a seed the loader would caption as too large once
// the entry leaves, a tighter one loads a seedable image the slow way.
//
// A source-shape pin, so the second case runs the check over in-memory
// mutants to prove it can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RUST = new URL("../src-tauri/src/image_sniff.rs", import.meta.url);
const TS = new URL("../src/lib/attachments/store.ts", import.meta.url);
const read = (url) => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

/** The integer literal (underscores dropped) of the source's ONE declaration
 *  matching `pattern`, or null when there isn't exactly one. */
function oneLiteral(src, pattern) {
  const hits = [...src.matchAll(pattern)];
  return hits.length === 1 ? hits[0][1].replaceAll("_", "") : null;
}

const CAPS = {
  MAX_IMAGE_DIMENSION: {
    rust: /^const MAX_IMAGE_DIMENSION: u32 = ([\d_]+);$/gm,
    ts: /^export const MAX_IMAGE_DIMENSION = ([\d_]+);$/gm,
  },
  MAX_IMAGE_PIXELS: {
    rust: /^const MAX_IMAGE_PIXELS: u64 = ([\d_]+);$/gm,
    ts: /^export const MAX_IMAGE_PIXELS = ([\d_]+);$/gm,
  },
};

/** The TS gate's comparisons, each against a named cap and in the loader's
 *  shape: both axes above zero, each axis and the area at most its cap. */
const TS_GATE = [
  "width > 0",
  "height > 0",
  "width <= MAX_IMAGE_DIMENSION",
  "height <= MAX_IMAGE_DIMENSION",
  "width * height <= MAX_IMAGE_PIXELS",
];

/** Null when both sides declare each cap once with the same value and the TS
 *  gate reads them by name; otherwise the reason the pin fails. */
function capsMismatch(rustSrc, tsSrc) {
  for (const [name, { rust, ts }] of Object.entries(CAPS)) {
    const r = oneLiteral(rustSrc, rust);
    const t = oneLiteral(tsSrc, ts);
    if (r === null) return `Rust ${name} not found exactly once`;
    if (t === null) return `TS ${name} not found exactly once`;
    if (r !== t) return `${name}: Rust ${r} vs TS ${t}`;
  }
  for (const clause of TS_GATE)
    if (!tsSrc.includes(clause)) return `the TS gate lacks \`${clause}\``;
  if (!tsSrc.includes("if (!withinLoaderCaps(record.width, record.height))"))
    return "the seed reader doesn't apply the gate";
  return null;
}

test("the seed's raster caps equal the loader's", () => {
  const rustSrc = read(RUST);
  const tsSrc = read(TS);
  assert.equal(capsMismatch(rustSrc, tsSrc), null);
  assert.equal(oneLiteral(rustSrc, CAPS.MAX_IMAGE_DIMENSION.rust), "8192");
  assert.equal(oneLiteral(rustSrc, CAPS.MAX_IMAGE_PIXELS.rust), "40000000");
});

test("the pin fails on a drifted, missing, duplicated or bypassed cap", () => {
  const rustSrc = read(RUST);
  const tsSrc = read(TS);
  const rustDim = "const MAX_IMAGE_DIMENSION: u32 = 8192;";
  const rustPx = "const MAX_IMAGE_PIXELS: u64 = 40_000_000;";
  const tsDim = "export const MAX_IMAGE_DIMENSION = 8192;";
  const tsPx = "export const MAX_IMAGE_PIXELS = 40_000_000;";
  const tsUse = "if (!withinLoaderCaps(record.width, record.height))";
  assert.ok(
    rustSrc.includes(rustDim) &&
      rustSrc.includes(rustPx) &&
      tsSrc.includes(tsDim) &&
      tsSrc.includes(tsPx) &&
      tsSrc.includes(tsUse),
  );

  const swap = (src, from, to) => src.replace(from, () => to);
  const mutants = [
    [
      "a raised Rust axis cap",
      swap(rustSrc, rustDim, rustDim.replace("8192", "16384")),
      tsSrc,
    ],
    [
      "a lowered TS area cap",
      rustSrc,
      swap(tsSrc, tsPx, tsPx.replace("40_000_000", "4_000_000")),
    ],
    ["a removed TS constant", rustSrc, swap(tsSrc, tsDim, "")],
    ["a second Rust declaration", `${rustSrc}\n${rustPx}\n`, tsSrc],
    [
      "a TS gate on an inline literal",
      rustSrc,
      swap(tsSrc, "width <= MAX_IMAGE_DIMENSION", "width <= 8192"),
    ],
    ["a dropped zero check", rustSrc, swap(tsSrc, "height > 0", "height >= 0")],
    ["an unapplied gate", rustSrc, swap(tsSrc, tsUse, "if (false)")],
  ];
  for (const [name, r, t] of mutants)
    assert.notEqual(capsMismatch(r, t), null, `mutant passed: ${name}`);
});
