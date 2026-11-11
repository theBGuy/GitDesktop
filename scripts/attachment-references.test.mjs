// Pins the text rules of staged image attachments (src/lib/attachments/
// references.ts): the name grammar (every fixture row, which Rust's
// `is_staged_name` pins too), the `](NAME)` reference rule,
// the insert whitespace, chip removal, the too-big `{size}` and the uploading
// copy. Stdlib only, importing the import-free module under Node's
// type stripping.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  appendReferenceText,
  failedAttachmentsOf,
  failedReferencesDraft,
  imageReference,
  insertionFor,
  isStagedName,
  MAX_IMAGE_BYTES,
  referencedNames,
  referencesName,
  refusalSize,
  removalSplice,
  removeReferences,
  tooBigRefusal,
  uploadingReason,
} from "../src/lib/attachments/references.ts";

const VALID_NAMES = [
  "image-1.png",
  "a.b-c_d.webp",
  "photo.png.png",
  "A.jpg",
  "0.gif",
  `${"a".repeat(76)}.png`,
];

const INVALID_NAMES = [
  "",
  ".png",
  "-a.png",
  "_a.png",
  "a.jpeg",
  "a.PNG",
  "a.svg",
  "a.png.",
  "a.png ",
  "a b.png",
  "a/b.png",
  "a\\b.png",
  "../a.png",
  "con.png",
  "NUL.gif",
  "Com1.webp",
  "lpt9.x.jpg",
  "image-1",
  "png",
  "é.png",
  `${"a".repeat(77)}.png`,
];

test("every valid name row passes the grammar", () => {
  for (const name of VALID_NAMES) assert.equal(isStagedName(name), true, name);
  assert.equal(VALID_NAMES[5].length, 80);
});

test("every invalid name row fails the grammar", () => {
  for (const name of INVALID_NAMES)
    assert.equal(isStagedName(name), false, JSON.stringify(name));
  assert.equal(INVALID_NAMES.at(-1).length, 81);
});

test("{size} rounds up to a tenth in integers at the fold-time values", () => {
  assert.equal(refusalSize(10_485_760), "10.0 MB");
  assert.equal(refusalSize(10_485_761), "10.1 MB");
  assert.equal(refusalSize(14_889_779), "14.2 MB");
  assert.equal(refusalSize(14_889_780), "14.3 MB");
  // Control: a toFixed formula disagrees at the first byte past the limit.
  assert.notEqual(`${(10_485_761 / 1_048_576).toFixed(1)} MB`, "10.1 MB");
  assert.equal(MAX_IMAGE_BYTES, 10_485_760);
  assert.equal(10_485_760 > MAX_IMAGE_BYTES, false);
  assert.equal(10_485_761 > MAX_IMAGE_BYTES, true);
  assert.equal(
    tooBigRefusal(null, 14_889_780),
    "The pasted file is 14.3 MB. Images can be at most 10 MB.",
  );
  assert.equal(
    tooBigRefusal("shot.png", 10_485_761),
    "shot.png is 10.1 MB. Images can be at most 10 MB.",
  );
});

test("the reference rule and first-occurrence order", () => {
  const text = "a ![x](image-10.png) b ![y](image-1.png) `![z](image-2.png)`";
  assert.equal(referencesName(text, "image-1.png"), true);
  assert.equal(referencesName("![x](image-10.png)", "image-1.png"), false);
  assert.deepEqual(
    referencedNames(text, [
      "image-1.png",
      "image-2.png",
      "image-10.png",
      "x.png",
    ]),
    ["image-10.png", "image-1.png", "image-2.png"],
  );
});

test("alts: a paste says image, a pick uses the escaped file stem", () => {
  assert.equal(
    imageReference("paste", null, "image-1.png"),
    "![image](image-1.png)",
  );
  assert.equal(
    imageReference("paste", "x.png", "image-1.png"),
    "![image](image-1.png)",
  );
  assert.equal(
    imageReference("picker", "photo.PNG", "photo.png"),
    "![photo](photo.png)",
  );
  assert.equal(
    imageReference("picker", "a[b]\\c\nd.png", "a-b-c-d.png"),
    "![a\\[b\\]\\\\c d](a-b-c-d.png)",
  );
  assert.equal(
    imageReference("picker", ".png", "image.png"),
    "![.png](image.png)",
  );
  assert.equal(
    imageReference("picker", null, "image.png"),
    "![image](image.png)",
  );
  assert.equal(
    imageReference("picker", "naïve.webp", "na-ve.webp"),
    "![naïve](na-ve.webp)",
  );
});

test("a picked name holding `](NAME)` adds no second reference", () => {
  const ref = imageReference("picker", "x](image-1.png).png", "image-2.png");
  assert.equal(ref.split("](").length - 1, 1);
  assert.equal(referencesName(ref, "image-1.png"), false);
  // Parentheses that follow no `]` stay as typed.
  assert.equal(
    imageReference("picker", "Screenshot (12).png", "image-1.png"),
    "![Screenshot (12)](image-1.png)",
  );
  const text = `![a](image-1.png) ${ref}`;
  assert.deepEqual(referencedNames(text, ["image-1.png", "image-2.png"]), [
    "image-1.png",
    "image-2.png",
  ]);
  const splice = removalSplice(text, "image-2.png");
  assert.equal(
    text.slice(0, splice.start) + text.slice(splice.end),
    "![a](image-1.png) ",
  );
  assert.equal(removalSplice(text, "image-1.png").end, 17);
});

test("insert whitespace follows the narrow rule", () => {
  const ref = "![image](image-2.png)";
  assert.deepEqual(insertionFor("", 0, ref), {
    insert: ref,
    caret: ref.length,
  });
  assert.deepEqual(insertionFor("hi ", 3, ref), {
    insert: ref,
    caret: 3 + ref.length,
  });
  assert.deepEqual(insertionFor("hi", 2, ref), {
    insert: ` ${ref}`,
    caret: 3 + ref.length,
  });
  assert.deepEqual(insertionFor("![image](image-1.png)", 21, ref), {
    insert: `\n${ref}`,
    caret: 22 + ref.length,
  });
  assert.deepEqual(insertionFor("ab", 1, ref), {
    insert: ` ${ref} `,
    caret: 2 + ref.length,
  });
  assert.deepEqual(insertionFor("a b", 1, ref).insert, ` ${ref}`);
  assert.equal(appendReferenceText("x", ref), `x ${ref}`);
  assert.equal(appendReferenceText("", ref), ref);
});

test("removal deletes every reference to the name in one splice", () => {
  const text =
    "a ![one](image-1.png) b ![two \\] x](image-1.png) c ![k](image-10.png)";
  assert.equal(
    removeReferences(text, "image-1.png"),
    "a  b  c ![k](image-10.png)",
  );
  const splice = removalSplice(text, "image-1.png");
  assert.equal(splice.start, 2);
  assert.equal(text.slice(splice.end), " c ![k](image-10.png)");
  assert.equal(removalSplice("plain", "image-1.png"), null);
  // A name's dots are literal, never wildcards.
  assert.equal(
    removeReferences("![a](image-1xpng)", "image-1.png"),
    "![a](image-1xpng)",
  );
});

test("removal takes every `](NAME)` back to its opening bracket", () => {
  const rows = [
    // Nested brackets in the alt.
    ["a ![Before [v2]](image-1.png) b", "a  b"],
    // An escaped bracket doesn't open or close.
    ["![a \\[ b](image-1.png)", ""],
    ["![a \\] b](image-1.png)", ""],
    // A line break inside the alt.
    ["x ![two\nlines](image-1.png) y", "x  y"],
    // A plain link to the staged name goes the same way.
    ["see [link](image-1.png).", "see ."],
    // No opening bracket: just the `](NAME)` text.
    ["stray ](image-1.png) end", "stray  end"],
    // An escaped closing bracket closes nothing: the same arm, user text kept.
    [String.raw`see [notes \](image-1.png)`, "see [notes \\"],
    // Bracket text never spans a blank line.
    ["[para\n\nnext](image-1.png)", "[para\n\nnext"],
    // Two references, and an image inside a link to the same name.
    ["![a](image-1.png) mid ![b](image-1.png)", " mid "],
    ["[![in](image-1.png)](image-1.png) z", " z"],
    // An escaped `!` stays: only the link part was a reference.
    ["\\![esc](image-1.png)", "\\!"],
    // A name sharing a prefix stays.
    ["![a](image-1.png) ![k](image-10.png)", " ![k](image-10.png)"],
  ];
  for (const [text, out] of rows) {
    assert.equal(removeReferences(text, "image-1.png"), out, text);
    assert.equal(referencesName(out, "image-1.png"), false, text);
  }
  // One splice, from the first change to the last.
  const text = "keep ![a](image-1.png) mid [b](image-1.png) tail";
  const splice = removalSplice(text, "image-1.png");
  assert.equal(splice.start, 5);
  assert.equal(text.slice(splice.end), " tail");
  assert.equal(splice.replacement, " mid ");
});

test("a reference alone on its line takes one line break with it", () => {
  const a = "![a](image-1.png)";
  const b = "![b](image-2.png)";
  const c = "![c](image-3.png)";
  const rows = [
    // The only reference, with the separator the insert left after it.
    [`${a}\n`, "image-1.png", ""],
    [a, "image-1.png", ""],
    // First, middle and last of three lines: the break after, else before.
    [`${a}\n${b}\n${c}`, "image-1.png", `${b}\n${c}`],
    [`${a}\n${b}\n${c}`, "image-2.png", `${a}\n${c}`],
    [`${a}\n${b}\n${c}`, "image-3.png", `${a}\n${b}`],
    [`${a}\n${b}\n${c}\n`, "image-3.png", `${a}\n${b}\n`],
    // Under typed text, a blank line between keeps only one break.
    [`text\n\n${a}`, "image-1.png", "text\n"],
    // Inline in a sentence: the spaces around it stay.
    [`see ${a} here\nnext`, "image-1.png", "see  here\nnext"],
    // Two references on one line: neither owns the line.
    [`${a} ${b}\nnext`, "image-1.png", ` ${b}\nnext`],
    [`${a} ${b}\nnext`, "image-2.png", `${a} \nnext`],
    // Both occurrences of one name alone on their lines.
    [`${a}\n${a}`, "image-1.png", ""],
  ];
  for (const [text, name, out] of rows) {
    assert.equal(removeReferences(text, name), out, `${name} in ${text}`);
  }
  // Still one splice, so one undo step.
  const text = `${a}\n${b}\n${c}`;
  const splice = removalSplice(text, "image-2.png");
  assert.equal(
    text.slice(0, splice.start) + splice.replacement + text.slice(splice.end),
    `${a}\n${c}`,
  );
});

test("a partial failure's draft keeps each failed reference's alt", () => {
  const body =
    "x ![first](image-1.png) ![bad alt](image-2.png) ![c](image-3.png)";
  assert.equal(
    failedReferencesDraft(body, ["image-2.png", "image-3.png"]),
    "![bad alt](image-2.png)\n![c](image-3.png)",
  );
  assert.equal(
    failedReferencesDraft("nothing", ["image-9.png"]),
    "![image](image-9.png)",
  );
});

test("an image reference's bracket text reads backslash pairs and line breaks", () => {
  const ref = "![image](image-2.png)";
  const leadAtEnd = (text) => insertionFor(text, text.length, ref).insert[0];
  const rows = [
    // An escaped `]` stays in the alt; the unescaped one closes it.
    [String.raw`![a \] b](x.png)`, "\n"],
    // A backslash run before `]`: odd escapes it, even leaves it closing.
    [String.raw`![a\](x.png)`, " "],
    [String.raw`![a\\](x.png)`, "\n"],
    [String.raw`![a\\\](x.png)`, " "],
    // Bracket text never spans a line break, escaped or not.
    ["![two\nlines](x.png)", " "],
    ["![a\\\nb](x.png)", " "],
    // A carriage return is alt text alone, but no backslash pairs with it.
    ["![a\r b](x.png)", "\n"],
    ["![a\\\r b](x.png)", " "],
    // `[` never nests: the first unescaped `]` closes.
    ["![a [b](x.png)", "\n"],
    ["![a [b] c](x.png)", " "],
    ["![[v2]](x.png)", " "],
    // The target holds no whitespace or parenthesis.
    ["![a](x y.png)", " "],
    ["![a](x(1).png)", " "],
    ["![a](x.png", " "],
    // Any `![` on the line may open it, an escaped `!` included.
    ["![a] ![b](x.png)", "\n"],
    [String.raw`\![esc](x.png)`, "\n"],
    ["![](x.png)", "\n"],
    ["![a]()", "\n"],
    ["[link](x.png)", " "],
  ];
  for (const [text, lead] of rows)
    assert.equal(leadAtEnd(text), lead, JSON.stringify(text));

  const draft = (body) => failedReferencesDraft(body, ["x.png"]);
  assert.equal(draft("see ![one](x.png) and ![two](x.png)"), "![one](x.png)");
  assert.equal(
    draft(String.raw`![a \] b](x.png)`),
    String.raw`![a \] b](x.png)`,
  );
  // The earliest `![` wins, even when its alt spans another reference.
  assert.equal(
    draft(String.raw`![a\](x.png) ![b](x.png)`),
    String.raw`![a\](x.png) ![b](x.png)`,
  );
  assert.equal(draft("![a [b](x.png)"), "![a [b](x.png)");
  assert.equal(draft("x ![a] ![b](x.png)"), "![b](x.png)");
  assert.equal(draft(String.raw`\![esc](x.png)`), "![esc](x.png)");
  assert.equal(draft("![two\nlines](x.png)"), "![image](x.png)");
  assert.equal(draft("[link](x.png)"), "![image](x.png)");
  assert.equal(draft("![a](x.png.png)"), "![image](x.png)");
});

// The cost is linear in the text. A child process, so a regression is killed at
// the timeout instead of hanging the suite.
test("a long line of `![` costs linear time", { timeout: 30_000 }, () => {
  const moduleUrl = new URL(
    "../src/lib/attachments/references.ts",
    import.meta.url,
  ).href;
  const script = [
    `import { failedReferencesDraft, insertionFor } from ${JSON.stringify(moduleUrl)};`,
    "const bs = String.fromCharCode(92);",
    'const lines = ["![".repeat(500_000), `![${bs}`.repeat(333_334)];',
    "const out = [];",
    "const t0 = performance.now();",
    "for (const line of lines) {",
    '  out.push(insertionFor(line, line.length, "![i](i.png)").insert);',
    '  for (const tail of ["", `${bs}](x.png)`, "](x.png)"])',
    '    out.push(failedReferencesDraft(line + tail, ["x.png"]).length);',
    "}",
    "console.log(JSON.stringify({ ms: performance.now() - t0, out }));",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 20_000, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const { ms, out } = JSON.parse(child.stdout);
  // Lengths: 15 is the `![image](x.png)` fallback, the rest a whole line's
  // match from its first `![` (a doubled backslash leaves the `]` closing).
  assert.deepEqual(out, [
    " ![i](i.png)",
    15,
    15,
    1_000_008,
    " ![i](i.png)",
    15,
    1_000_011,
    15,
  ]);
  assert.ok(ms < 8_000, `${ms} ms`);
});

// The cost is linear in the text. A child process, so a regression is killed at
// the timeout instead of hanging the suite.
test("removal over long texts costs linear time", { timeout: 30_000 }, () => {
  const moduleUrl = new URL(
    "../src/lib/attachments/references.ts",
    import.meta.url,
  ).href;
  const script = [
    `import { removeReferences } from ${JSON.stringify(moduleUrl)};`,
    "const texts = [",
    '  "](x.png)".repeat(125_000),',
    '  `${"a\\n".repeat(500_000)}](x.png)`,',
    '  "a](x.png)\\n".repeat(100_000),',
    "];",
    "const t0 = performance.now();",
    'const out = texts.map((t) => removeReferences(t, "x.png").length);',
    "console.log(JSON.stringify({ ms: performance.now() - t0, out }));",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 20_000, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const { ms, out } = JSON.parse(child.stdout);
  // A reference alone on the last line takes the line break before it.
  assert.deepEqual(out, [0, 999_999, 200_000]);
  assert.ok(ms < 8_000, `${ms} ms`);
});

// Each deletion here joins a new occurrence, so removal runs one pass per join;
// a pass whose `[` sits right before its `]` finds it without reading the text
// ahead of it. A child process, so a regression is killed at the timeout
// instead of hanging the suite.
test("removal passes find an adjacent `[` cheaply", { timeout: 30_000 }, () => {
  const moduleUrl = new URL(
    "../src/lib/attachments/references.ts",
    import.meta.url,
  ).href;
  const script = [
    `import { removeReferences } from ${JSON.stringify(moduleUrl)};`,
    'const text = `${"[]".repeat(496_500)}${"[](x".repeat(700)}[](x.png)${".png)".repeat(700)}`;',
    "const t0 = performance.now();",
    'const out = removeReferences(text, "x.png").length;',
    "console.log(JSON.stringify({ ms: performance.now() - t0, out }));",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 20_000, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const { ms, out } = JSON.parse(child.stdout);
  // Every joined reference goes; the `[]` pairs close no reference and stay.
  assert.equal(out, 993_000);
  assert.ok(ms < 8_000, `${ms} ms`);
});

test("failedAttachmentsOf tolerates every outcome shape", () => {
  assert.deepEqual(failedAttachmentsOf(undefined), []);
  assert.deepEqual(failedAttachmentsOf(null), []);
  assert.deepEqual(failedAttachmentsOf({ failedAttachments: [] }), []);
  assert.deepEqual(failedAttachmentsOf({ failedAttachments: ["a.png"] }), [
    "a.png",
  ]);
  assert.deepEqual(
    failedAttachmentsOf({ failedAttachments: ["a.png", 3, "b.png", "c.png"] }),
    ["a.png", "b.png", "c.png"],
  );
  assert.deepEqual(failedAttachmentsOf({ failedAttachments: "a.png" }), []);
});

test("uploading copy per act", () => {
  assert.equal(uploadingReason(1, "posting"), "Uploading 1 image and posting…");
  assert.equal(
    uploadingReason(3, "posting"),
    "Uploading 3 images and posting…",
  );
  assert.equal(
    uploadingReason(1, "creating"),
    "Uploading 1 image and creating…",
  );
  assert.equal(
    uploadingReason(2, "creating"),
    "Uploading 2 images and creating…",
  );
});
