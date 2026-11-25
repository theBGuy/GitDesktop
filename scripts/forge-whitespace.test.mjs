// Pins the forge-patch whitespace mode's pure half
// (src/features/diff/forge-whitespace.ts): the fallback copy, the proof that a
// pair of reads is the forge patch's own, and the reducer that picks what a
// slot draws. The import reaches straight into src/ under Node's type
// stripping (the module's runtime imports are relative .ts ones); no install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  proveForgeSides,
  reduceForgeWhitespace,
  sidesOverBudget,
  WHITESPACE_INITIAL,
  WHITESPACE_SHOWN_NOTE,
  WHITESPACE_SHOWN_REASON,
  wantsReads,
  whitespaceCommandWanted,
  whitespaceHunksRead,
  whitespaceReadsKey,
  whitespaceSide,
  whitespaceSides,
} from "../src/features/diff/forge-whitespace.ts";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

// A re-indent of one block plus a content edit; the plain hunk and the -w
// hunk are real `git diff --no-index` output (git 2.51.1, no config).
const OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line 11\n  line 12\n  line 13\n  line 14\n}\n";
const NEW =
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line ELEVEN\n  line 12\n  line 13\n  line 14\n}\n";
const PLAIN_HUNKS =
  "@@ -1,17 +1,17 @@\n function f() {\n-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n }\n function g() {\n   line 7\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const WS_HUNKS =
  "@@ -11,7 +11,7 @@ function g() {\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const HEADER =
  "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n";
const PLAIN = {
  filePath: "f.txt",
  text: HEADER + PLAIN_HUNKS,
  isBinary: false,
  isTruncated: false,
};
const b64 = (t) => Buffer.from(t).toString("base64");
/** The proof over two texts, encoded as UTF-8 the way a forge read returns
 *  them. */
const prove = (key, plain, oldText, newText) =>
  proveForgeSides(key, plain, b64(oldText), b64(newText));
const bytes = (t, over = {}) => ({
  base64: b64(t),
  mime: null,
  tooLarge: false,
  size: t.length,
  ...over,
});
const READS = {
  repo: "/repo",
  sourceKey: "forge:origin",
  oldRev: "a".repeat(40),
  oldPath: "f.txt",
  newRev: "b".repeat(40),
  path: "f.txt",
};
const KEY = whitespaceReadsKey(READS);
const OTHER_KEY = whitespaceReadsKey({ ...READS, newRev: "c".repeat(40) });
const ID = JSON.stringify(["/repo", "origin\u0000 7", "f.txt"]);
const READY = {
  state: "ready",
  oldRev: READS.oldRev,
  newRev: READS.newRev,
  sourceKey: READS.sourceKey,
};

/** Every input ready: sides read, proven, the -w answer landed. */
function inputs(over = {}) {
  return {
    identity: ID,
    hide: true,
    plain: PLAIN,
    placeholder: false,
    revs: READY,
    readsKey: KEY,
    oldSide: { kind: "ready", bytes: bytes(OLD) },
    newSide: { kind: "ready", bytes: bytes(NEW) },
    budget: 300_000,
    proof: prove(KEY, PLAIN.text, OLD, NEW),
    hunks: { kind: "ready", readsKey: KEY, hunks: WS_HUNKS, isBinary: false },
    editorOpen: false,
    ...over,
  };
}

/** Runs the reducer over a sequence of inputs, as one slot's renders. */
function run(...steps) {
  let state = WHITESPACE_INITIAL;
  const views = [];
  for (const step of steps) {
    // A render adjusts its state until it holds still, as the hook does.
    for (let i = 0; i < 3; i++) {
      const out = reduceForgeWhitespace(state, step);
      if (out.state === state) {
        views.push(out.view);
        break;
      }
      state = out.state;
    }
  }
  return views;
}
const last = (...steps) => run(...steps).at(-1);
const NOTE = (kind) =>
  `Whitespace changes are shown in this file: ${WHITESPACE_SHOWN_REASON[kind]}.`;
const isForge = (view, note = null) => {
  assert.equal(view.pending, false);
  assert.equal(view.data.text, PLAIN.text);
  assert.equal(view.data.whitespaceHidden, false);
  assert.equal(view.note, note);
};
const isWs = (view) => {
  assert.equal(view.pending, false);
  assert.equal(view.data.text, HEADER + WS_HUNKS);
  assert.equal(view.data.whitespaceHidden, true);
  assert.equal(view.data.whitespaceOnly, false);
  assert.equal(view.note, null);
};

test("the fallback copy: four kinds, one sentence each, never 'couldn't be read'", () => {
  assert.deepEqual(Object.keys(WHITESPACE_SHOWN_REASON).sort(), [
    "incomparable",
    "mismatch",
    "offline",
    "tooLarge",
  ]);
  assert.equal(
    WHITESPACE_SHOWN_NOTE("incomparable"),
    "Whitespace changes are shown in this file: its two versions couldn't be compared.",
  );
  assert.equal(
    WHITESPACE_SHOWN_NOTE("offline"),
    "Whitespace changes are shown in this file: you're offline.",
  );
  assert.ok(
    !source("src/features/diff/forge-whitespace.ts").includes(
      "couldn't be read",
    ),
  );
});

test("proven, read and answered: the -w view with the forge header", () => {
  isWs(last(inputs()));
  // Whitespace-only: the header stops before its first --- line, so a
  // rename keeps its From / To in the whitespace-only arm.
  const rename =
    "diff --git a/a.txt b/f.txt\nsimilarity index 90%\nrename from a.txt\nrename to f.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/f.txt\n";
  const plain = { ...PLAIN, text: rename + PLAIN_HUNKS, oldPath: "a.txt" };
  const view = last(
    inputs({
      plain,
      proof: prove(KEY, plain.text, OLD, NEW),
      hunks: { kind: "ready", readsKey: KEY, hunks: "", isBinary: false },
    }),
  );
  assert.equal(view.data.text, rename.slice(0, rename.indexOf("--- ")));
  assert.equal(view.data.whitespaceHidden, true);
  assert.equal(view.data.whitespaceOnly, true);
  assert.equal(view.data.oldPath, "a.txt");
});

test("RV5: the -w view needs a proof this module minted for these reads", () => {
  const refused = [
    ["(a) no proof", { proof: null }],
    ["(b) a look-alike proof", { proof: Object.freeze({ readsKey: KEY }) }],
    [
      "(c) a proof minted for other reads",
      { proof: prove(OTHER_KEY, PLAIN.text, OLD, NEW) },
    ],
    [
      "(d) a -w answer read under other reads",
      {
        hunks: {
          kind: "ready",
          readsKey: OTHER_KEY,
          hunks: WS_HUNKS,
          isBinary: false,
        },
      },
    ],
  ];
  for (const [name, over] of refused) {
    const view = last(inputs(over));
    assert.equal(view.data.whitespaceHidden, false, name);
    assert.equal(view.note, NOTE("mismatch"), name);
  }
  assert.equal(whitespaceCommandWanted(inputs({ proof: null })), false);
  assert.equal(whitespaceCommandWanted(inputs()), true);
});

test("a byte-order mark is proven as the sides hold it, never read as absent", () => {
  const BOM = String.fromCharCode(0xfeff);
  // A forge patch that removes the mark from line 1, as git prints it.
  const removes = `${HEADER}@@ -1,2 +1,2 @@\n-${BOM}x\n+x\n y\n`;
  // Sides that agree on the mark aren't that patch's own: `-w` over them
  // would come back empty and call the change whitespace-only.
  assert.equal(prove(KEY, removes, "x\ny\n", "x\ny\n"), null);
  assert.equal(prove(KEY, removes, `${BOM}x\ny\n`, `${BOM}x\ny\n`), null);
  assert.notEqual(prove(KEY, removes, `${BOM}x\ny\n`, "x\ny\n"), null);
  // A mark both sides keep proves on line-1 context and in a gap alike.
  const ctx = `${HEADER}@@ -1,2 +1,2 @@\n ${BOM}x\n-y\n+Y\n`;
  assert.notEqual(prove(KEY, ctx, `${BOM}x\ny\n`, `${BOM}x\nY\n`), null);
  assert.equal(prove(KEY, ctx, "x\ny\n", "x\nY\n"), null);
  const gap = `${HEADER}@@ -5 +5 @@\n-e\n+E\n`;
  const body = "b\nc\nd\n";
  assert.notEqual(
    prove(KEY, gap, `${BOM}a\n${body}e\n`, `${BOM}a\n${body}E\n`),
    null,
  );
  assert.equal(prove(KEY, gap, `${BOM}a\n${body}e\n`, `a\n${body}E\n`), null);
  // The proof decodes the bytes itself and keeps every mark they open with.
  const twice = `${HEADER}@@ -1,2 +1,2 @@\n ${BOM}${BOM}x\n-y\n+Y\n`;
  assert.notEqual(
    prove(KEY, twice, `${BOM}${BOM}x\ny\n`, `${BOM}${BOM}x\nY\n`),
    null,
  );
  assert.equal(prove(KEY, twice, `${BOM}x\ny\n`, `${BOM}x\nY\n`), null);
});

// The patch is decoded lossily (invalid bytes as U+FFFD) and hunk-match
// compares lines without their CR, so the raw bytes settle what the texts
// can't: unchanged lines are byte-identical, change blocks differ.
test("raw bytes settle what a lossy decode can't; a visible change still proves", () => {
  const R = String.fromCharCode(0xfffd);
  const raw = (bytes) => Buffer.from(bytes).toString("base64");
  const at = (hunk) => `${HEADER}${hunk}`;
  const [x, y, c, C, sp, cr, nl] = [0x78, 0x79, 0x63, 0x43, 0x20, 0x0d, 0x0a];
  const caf = [c, 0x61, 0x66, 0xe9];
  const refused = [
    // A raced pair: the patch changes FF to FE, both sides hold the FF version.
    [
      "an invisible change (change block)",
      at(`@@ -1,2 +1,2 @@\n-x${R}\n+x${R}\n y\n`),
      [x, 0xff, nl, y, nl],
      [x, 0xff, nl, y, nl],
    ],
    [
      "an invisible change on a gap line",
      at("@@ -1 +1 @@\n-c\n+C\n"),
      [c, nl, y, nl, x, 0xff, nl],
      [C, nl, y, nl, x, 0xfe, nl],
    ],
    [
      "an invisible change on a context line",
      at(`@@ -1,2 +1,2 @@\n-c\n+C\n x${R}\n`),
      [c, nl, x, 0xff, nl],
      [C, nl, x, 0xfe, nl],
    ],
    [
      "a CR on an unchanged line of valid sides",
      at("@@ -1 +1 @@\n-c\n+C\n"),
      [c, nl, y, cr, nl],
      [C, nl, y, nl],
    ],
    [
      "valid sides holding a replacement character",
      at(`@@ -1,2 +1,2 @@\n-x${R}\n+x${R}\n y\n`),
      [...Buffer.from(`x${R}\ny\n`)],
      [...Buffer.from(`x${R}\ny\n`)],
    ],
    // A hidden change that also differs in ASCII: the exact match refuses.
    [
      "a visible change over raced sides",
      at(`@@ -1,2 +1,2 @@\n-xa${R}\n+xb${R}\n y\n`),
      [x, 0x61, 0xff, nl, y, nl],
      [x, 0x61, 0xff, nl, y, nl],
    ],
    [
      "old side's hunk line only",
      at("@@ -1,2 +1,2 @@\n-xa\n+xb\n y\n"),
      [x, 0xff, nl, y, nl],
      [x, 0x62, nl, y, nl],
    ],
    [
      "new side's hunk line only",
      at("@@ -1,2 +1,2 @@\n-xa\n+xb\n y\n"),
      [x, 0x61, nl, y, nl],
      [x, 0xff, nl, y, nl],
    ],
  ];
  for (const [name, plain, oldBytes, newBytes] of refused)
    assert.equal(
      proveForgeSides(KEY, plain, raw(oldBytes), raw(newBytes)),
      null,
      name,
    );
  const proves = [
    [
      "a Latin-1 accented line whose change is visible",
      at(`@@ -1 +1 @@\n-caf${R}\n+Caf${R}\n`),
      [...caf, nl],
      [C, ...caf.slice(1), nl],
    ],
    [
      "a Latin-1 re-indent",
      at(`@@ -1 +1 @@\n-caf${R}\n+  caf${R}\n`),
      [...caf, nl],
      [sp, sp, ...caf, nl],
    ],
    [
      "U+FFFD on a context line",
      at(`@@ -1,2 +1,2 @@\n caf${R}\n-c\n+C\n`),
      [...caf, nl, c, nl],
      [...caf, nl, C, nl],
    ],
    [
      "U+FFFD outside the hunks",
      at("@@ -3 +3 @@\n-c\n+C\n"),
      [...caf, nl, y, nl, c, nl],
      [...caf, nl, y, nl, C, nl],
    ],
    [
      "a final newline added",
      at("@@ -1 +1 @@\n-c\n\\ No newline at end of file\n+c\n"),
      [c],
      [c, nl],
    ],
    [
      "CRLF lines",
      at("@@ -1,2 +1,2 @@\n-c\r\n+C\r\n y\r\n"),
      [c, cr, nl, y, cr, nl],
      [C, cr, nl, y, cr, nl],
    ],
    // `-w` pairs these lines as the patch does; the sides hide nothing.
    [
      "U+FFFD moved across hunks",
      at(`@@ -1 +1 @@\n-x${R}\n+a\n@@ -5 +5 @@\n-b\n+x${R}\n`),
      [x, 0xff, nl, 0x32, nl, 0x33, nl, 0x34, nl, 0x62, nl],
      [0x61, nl, 0x32, nl, 0x33, nl, 0x34, nl, x, 0xff, nl],
    ],
  ];
  for (const [name, plain, oldBytes, newBytes] of proves)
    assert.notEqual(
      proveForgeSides(KEY, plain, raw(oldBytes), raw(newBytes)),
      null,
      name,
    );
  // Accepted residual (no re-read of the head after the diff): raced sides
  // whose line differs from the patch's in whitespace plus an invalid byte
  // still prove, and `-w` over them calls the line whitespace-only.
  assert.notEqual(
    proveForgeSides(
      KEY,
      at(`@@ -1,2 +1,2 @@\n-x${R} \n+x${R}\n y\n`),
      raw([x, 0xff, sp, nl, y, nl]),
      raw([x, 0xff, nl, y, nl]),
    ),
    null,
    "accepted residual: an invisible change beside a whitespace one",
  );
  // A payload that isn't base64 proves nothing.
  assert.equal(
    proveForgeSides(KEY, at("@@ -1 +1 @@\n-c\n+C\n"), "!", raw([C, nl])),
    null,
  );
});

test("D2: sides that are not the forge patch's own mint no proof (mismatch)", () => {
  // The same hunks over a gap line the forge patch never had.
  const stale = OLD.replace("  line 9\n", "  line nine\n");
  assert.equal(
    prove(KEY, PLAIN.text, stale, NEW.replace("  line 9\n", "  line nine\n")),
    null,
  );
  const view = last(
    inputs({
      oldSide: { kind: "ready", bytes: bytes(stale) },
      proof: prove(KEY, PLAIN.text, stale, NEW),
    }),
  );
  isForge(view, NOTE("mismatch"));
});

test("each fallback kind draws the forge diff under its one note", () => {
  const rows = [
    ["revs paused", { revs: { state: "paused" }, readsKey: null }, "offline"],
    ["revs none", { revs: { state: "none" }, readsKey: null }, "incomparable"],
    ["a side read failed", { newSide: { kind: "failed" } }, "incomparable"],
    ["a side read parked", { oldSide: { kind: "paused" } }, "offline"],
    [
      "a refused side (no base64)",
      { newSide: { kind: "ready", bytes: bytes(NEW, { base64: null }) } },
      "incomparable",
    ],
    [
      "a side over the cap",
      {
        newSide: {
          kind: "ready",
          bytes: bytes(NEW, { base64: null, tooLarge: true }),
        },
      },
      "tooLarge",
    ],
    [
      "a local side over the budget",
      { oldSide: { kind: "ready", bytes: bytes(OLD, { size: 300_001 }) } },
      "tooLarge",
    ],
    [
      "both sides absent",
      { oldSide: { kind: "absent" }, newSide: { kind: "ready", bytes: null } },
      "incomparable",
    ],
    ["the -w command failed", { hunks: { kind: "failed" } }, "incomparable"],
    [
      "git's binary verdict",
      { hunks: { kind: "ready", readsKey: KEY, hunks: "", isBinary: true } },
      "incomparable",
    ],
  ];
  for (const [name, over, kind] of rows) {
    const view = last(inputs(over));
    assert.equal(view.pending, false, name);
    assert.equal(view.data.text, PLAIN.text, name);
    assert.equal(view.data.whitespaceHidden, false, name);
    assert.equal(view.note, NOTE(kind), name);
  }
  // A side absent with a defined rev is an empty side, not a failure.
  const added = last(
    inputs({ oldSide: { kind: "ready", bytes: null }, proof: null }),
  );
  assert.equal(added.note, NOTE("mismatch"));
});

test("the budget is read from sizes alone: the size field, else the base64 length", () => {
  const side = (t, over) => ({ kind: "ready", bytes: bytes(t, over) });
  const ok = side("x");
  // Each padding shape decodes to its exact byte count.
  for (const n of [9, 10, 11]) {
    const t = "y".repeat(n);
    assert.equal(sidesOverBudget(ok, side(t, { size: null }), n), false, `${n} at ${n}`);
    assert.equal(sidesOverBudget(ok, side(t, { size: null }), n - 1), true, `${n} at ${n - 1}`);
  }
  // Either reading over the budget refuses, on either side.
  assert.equal(sidesOverBudget(side("y".repeat(4), { size: 99 }), ok, 10), true);
  assert.equal(sidesOverBudget(ok, side("y".repeat(99), { size: 4 }), 10), true);
  assert.equal(sidesOverBudget(ok, side("y", { tooLarge: true }), 10), true);
  // Sides with no bytes to judge are never over it.
  for (const s of [
    { kind: "absent" },
    { kind: "pending" },
    { kind: "failed" },
    { kind: "ready", bytes: null },
    side("y".repeat(99), { base64: null, size: null }),
  ])
    assert.equal(sidesOverBudget(s, ok, 10), false, JSON.stringify(s));
  // The reducer lands on the size note for a size-less side over the budget.
  const view = last(
    inputs({ newSide: side(NEW, { size: null }), budget: NEW.length - 1 }),
  );
  isForge(view, NOTE("tooLarge"));
});

test("SR5: revs parked on a first open paint the forge diff at once, then the -w view with no blank", () => {
  const views = run(
    inputs({ revs: { state: "paused" }, readsKey: null }),
    inputs({ revs: { state: "pending" }, readsKey: null }),
    inputs(),
  );
  isForge(views[0], NOTE("offline"));
  isForge(views[1], NOTE("offline"));
  isWs(views[2]);
  // Over an identity already showing its -w view, parked revs fall back.
  const back = run(
    inputs(),
    inputs({ revs: { state: "paused" }, readsKey: null }),
  );
  isForge(back[1], NOTE("offline"));
});

test("rule 6: a first open waits; a flip on an open file paints the forge text meanwhile", () => {
  const first = last(inputs({ hunks: { kind: "pending" } }));
  assert.equal(first.pending, true);
  assert.equal(first.data, undefined);
  const flip = run(
    inputs({ hide: false }),
    inputs({ revs: { state: "pending" }, readsKey: null }),
    inputs(),
  );
  isForge(flip[0]);
  isForge(flip[1]);
  isWs(flip[2]);
  // A side parked, then resuming.
  const parked = run(
    inputs({ oldSide: { kind: "paused" } }),
    inputs({ oldSide: { kind: "pending" } }),
    inputs(),
  );
  isForge(parked[0], NOTE("offline"));
  isForge(parked[1], NOTE("offline"));
  isWs(parked[2]);
});

test("rules 1 and 2: off, binary, hunkless and placeholder paints never read", () => {
  isForge(last(inputs({ hide: false })));
  const bin = last(
    inputs({
      plain: { ...PLAIN, isBinary: true, text: "Binary files differ\n" },
    }),
  );
  assert.equal(bin.data.whitespaceHidden, false);
  const header = last(
    inputs({
      plain: {
        ...PLAIN,
        text: "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n",
      },
    }),
  );
  assert.equal(header.data.whitespaceHidden, false);
  assert.deepEqual(last(inputs({ plain: undefined })), {
    data: undefined,
    pending: false,
    note: null,
  });
  assert.equal(wantsReads(true, PLAIN, true), false);
  assert.equal(wantsReads(false, PLAIN, false), false);
  assert.equal(wantsReads(true, PLAIN, false), true);
  // A placeholder of the same text keeps the -w view; of other text, the forge text.
  const same = run(
    inputs(),
    inputs({ placeholder: true, hunks: { kind: "idle" } }),
  );
  isWs(same[1]);
  const otherText = `${PLAIN.text}`.replace("line ELEVEN", "line 11b");
  const other = run(
    inputs(),
    inputs({ placeholder: true, plain: { ...PLAIN, text: otherText } }),
  );
  assert.equal(other[1].data.text, otherText);
  assert.equal(other[1].data.whitespaceHidden, false);
  assert.equal(other[1].pending, false);
});

test("rule 7: a replacement for the same forge text waits for an open editor, both ways", () => {
  // -w view on screen, the setting turned off with an editor open.
  const off = run(
    inputs(),
    inputs({ hide: false, editorOpen: true }),
    inputs({ hide: false }),
  );
  isWs(off[1]);
  isForge(off[2]);
  // Forge text on screen, the -w answer lands with an editor open.
  const on = run(
    inputs({ hide: false }),
    inputs({ editorOpen: true }),
    inputs(),
  );
  isForge(on[1]);
  isWs(on[2]);
  // D33: new revs under an unchanged forge text that settle to a fallback.
  const NEW_KEY = OTHER_KEY;
  const moved = {
    revs: { ...READY, newRev: "c".repeat(40) },
    readsKey: NEW_KEY,
    newSide: { kind: "failed" },
    proof: null,
    hunks: { kind: "idle" },
  };
  const held = run(
    inputs(),
    inputs({ ...moved, editorOpen: true }),
    inputs(moved),
  );
  isWs(held[1]);
  isForge(held[2], NOTE("incomparable"));
  // A changed forge text is never held.
  const changed = {
    ...PLAIN,
    text: PLAIN.text.replace("line ELEVEN", "line 11b"),
  };
  const notHeld = run(
    inputs(),
    inputs({
      plain: changed,
      editorOpen: true,
      revs: { state: "pending" },
      readsKey: null,
    }),
  );
  assert.equal(notHeld[1].data.text, changed.text);
  assert.equal(notHeld[1].data.whitespaceHidden, false);
});

test("rule 8 and D20: another record starts unpainted; a new forge text never wears an old -w view", () => {
  const other = JSON.stringify(["/repo", "origin\u0000 8", "f.txt"]);
  const retarget = run(
    inputs(),
    inputs({ identity: other, hunks: { kind: "pending" } }),
  );
  assert.equal(retarget[1].pending, true);
  // A head move that changed the section: forge text first, never the old -w view.
  const changed = {
    ...PLAIN,
    text: PLAIN.text.replace("line ELEVEN", "line 11b"),
  };
  const move = run(
    inputs(),
    inputs({ plain: changed, revs: { state: "pending" }, readsKey: null }),
  );
  assert.equal(move[1].pending, false);
  assert.equal(move[1].data.text, changed.text);
  // A head move that left the section alone: equal by value, a new string.
  const copy = { ...PLAIN, text: [HEADER, PLAIN_HUNKS].join("") };
  const kept = run(
    inputs(),
    inputs({ plain: copy, revs: { state: "pending" }, readsKey: null }),
  );
  isWs(kept[1]);
});

test("rule 8: a placeholder under another record never marks it painted", () => {
  const other = JSON.stringify(["/repo", "origin\u0000 8", "f.txt"]);
  const changed = {
    ...PLAIN,
    text: PLAIN.text.replace("line ELEVEN", "line 11b"),
  };
  const inFlight = (plain) =>
    inputs({
      identity: other,
      plain,
      revs: { state: "pending" },
      readsKey: null,
    });
  // The previous record's text paints as the placeholder; the new record's
  // own text then waits for its -w view, whether or not it reads the same.
  for (const own of [PLAIN, changed]) {
    const views = run(
      inputs(),
      inputs({ identity: other, placeholder: true, hunks: { kind: "idle" } }),
      inFlight(own),
    );
    isForge(views[1]);
    assert.deepEqual(views[2], { data: undefined, pending: true, note: null });
  }
  const landed = run(
    inputs(),
    inputs({ identity: other, placeholder: true, hunks: { kind: "idle" } }),
    inFlight(PLAIN),
    inputs({ identity: other }),
  );
  isWs(landed[3]);
});

test("the -w view's header: up to the first hunk, none when the section opens on one", () => {
  isWs(last(inputs()));
  const bare = { ...PLAIN, text: PLAIN_HUNKS };
  const view = last(
    inputs({ plain: bare, proof: prove(KEY, bare.text, OLD, NEW) }),
  );
  assert.equal(view.data.text, WS_HUNKS);
  assert.equal(view.data.whitespaceHidden, true);
  const wsOnly = last(
    inputs({
      plain: bare,
      proof: prove(KEY, bare.text, OLD, NEW),
      hunks: { kind: "ready", readsKey: KEY, hunks: "", isBinary: false },
    }),
  );
  assert.equal(wsOnly.data.text, "");
  assert.equal(wsOnly.data.whitespaceOnly, true);
});

test("read helpers: sides, the -w read and the command's payloads", () => {
  const q = (o) => ({ data: undefined, firstRead: false, paused: false, ...o });
  assert.deepEqual(whitespaceSide(undefined, q({ data: bytes("x") })), {
    kind: "absent",
  });
  assert.deepEqual(whitespaceSide("r", q({ data: null })), {
    kind: "ready",
    bytes: null,
  });
  assert.deepEqual(whitespaceSide("r", q({ paused: true })), {
    kind: "paused",
  });
  assert.deepEqual(whitespaceSide("r", q({ firstRead: true })), {
    kind: "pending",
  });
  assert.deepEqual(whitespaceSide("r", q({})), { kind: "failed" });
  const hq = (o) => ({
    data: undefined,
    isError: false,
    errorUpdateCount: 0,
    ...o,
  });
  assert.deepEqual(whitespaceHunksRead(false, KEY, hq({})), { kind: "idle" });
  assert.deepEqual(whitespaceHunksRead(true, KEY, hq({})), { kind: "pending" });
  assert.deepEqual(
    whitespaceHunksRead(true, KEY, hq({ errorUpdateCount: 1 })),
    { kind: "failed" },
  );
  assert.deepEqual(
    whitespaceHunksRead(
      true,
      KEY,
      hq({ data: { hunks: "h", isBinary: false } }),
    ),
    { kind: "ready", readsKey: KEY, hunks: "h", isBinary: false },
  );
  assert.deepEqual(
    whitespaceSides({ kind: "absent" }, { kind: "ready", bytes: bytes("n") }),
    { old: null, new: b64("n") },
  );
  assert.equal(whitespaceSides({ kind: "pending" }, { kind: "absent" }), null);
});

test("source pins: the guard's relaxation is reached from the diff's own mark only", () => {
  const surface = source("src/features/diff/DiffSurface.tsx");
  const guards = [...surface.matchAll(/hunksMatchContent\(/g)];
  assert.equal(guards.length, 1, "one hunksMatchContent( call in DiffSurface");
  assert.match(
    surface,
    /hunksMatchContent\(diffText, oldText, newText, \{\s*ignoreWhitespace: whitespaceHidden,\s*\}\)/,
  );
  assert.equal(
    surface.split("whitespaceHidden={data.whitespaceHidden === true}").length -
      1,
    1,
    "the text arm hands its diff's own mark down",
  );
  const forge = source("src/features/diff/forge-whitespace.ts");
  assert.equal(forge.split("whitespaceHidden: true").length - 1, 1);
});

// Matrix B over real git: raw byte triples (base, stale head, head) across
// encodings, change kinds and where the stale head differs (a line the patch
// changes, a context line, a gap line). The patch of (base, head) must prove
// against its own sides; against the stale sides, a proof is sound only when
// `-w` over them reads as `-w` over the true pair.
test("matrix B: true sides always prove; stale sides prove only when -w reads alike", () => {
  const root = mkdtempSync(join(tmpdir(), "gd-forge-ws-"));
  try {
    const emptyConfig = join(root, "empty.gitconfig");
    writeFileSync(emptyConfig, "");
    const env = {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "HOME"])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    const B = (...parts) =>
      Buffer.concat(
        parts.map((p) =>
          Buffer.from(p, typeof p === "string" ? "latin1" : undefined),
        ),
      );
    const NL = "\n";
    const ENC = {
      utf8: {
        e: B("caf", [0xc3, 0xa9]),
        body: (k) => B(`l${k}`, [0xc3, 0xad], "ne"),
      },
      latin1: { e: B("caf", [0xe9]), body: (k) => B(`l${k}`, [0xed], "ne") },
      invalid: { e: B("x", [0xff]), body: (k) => B(`line ${k}`, [0xfe]) },
    };
    // Each kind: the line's two variants, terminator included.
    const KINDS = {
      reindent: (e) => [B(e, NL), B("  ", e, NL)],
      "FF->FE": (e) => [B(e, [0xff], NL), B(e, [0xfe], NL)],
      "E9->E8": (e) => [B(e, [0xe9], NL), B(e, [0xe8], NL)],
      both: (e) => [B(e, [0xff], NL), B("  ", e, [0xfe], NL)],
      "EOL-only": (e) => [B(e, NL), B(e)],
      BOM: (e) => [B([0xef, 0xbb, 0xbf], e, NL), B(e, NL)],
      CRLF: (e) => [B(e, "\r\n"), B(e, NL)],
    };
    const LINES = 12;
    const file = (enc, at, special, anchorAt, anchor) =>
      Buffer.concat(
        Array.from({ length: LINES }, (_, k) =>
          k === at
            ? special
            : k === anchorAt
              ? B(anchor, NL)
              : B(ENC[enc].body(k), NL),
        ),
      );
    const cases = [];
    for (const enc of Object.keys(ENC))
      for (const [kind, make] of Object.entries(KINDS)) {
        const [P, Q] = make(ENC[enc].e);
        const Z = B("zz", NL);
        // The special line is the last (a BOM's is the first); the anchor
        // line every head changes sits near it or far from it.
        const at = kind === "BOM" ? 0 : LINES - 1;
        const near = at === 0 ? 2 : LINES - 3;
        const far = at === 0 ? LINES - 3 : 2;
        // Each triple spells (base, stale head, head) by variant letter.
        const triples = [
          ["change, stale differs", far, "ZPQ ZQP"],
          ["change, stale unchanged", far, "PPQ QQP"],
          ["change, stale current", far, "PQQ QPP"],
          ["context line", near, "PQP QPQ"],
          ["gap line", far, "PQP QPQ"],
        ];
        const variant = { Z, P, Q };
        for (const [where, anchorAt, spelled] of triples)
          spelled.split(" ").forEach((letters, i) => {
            const [base, stale, head] = [...letters].map((ch) => variant[ch]);
            cases.push({
              name: `${enc} / ${kind} / ${where} #${i}`,
              // hunk-match compares a line without its CR, so a stale head
              // whose changed line differs only there still proves; `-w`
              // ignores the CR, so its view differs only in that byte.
              crResidual: kind === "CRLF" && where === "change, stale differs",
              base: file(enc, at, base, anchorAt, "anchor"),
              stale: file(enc, at, stale, anchorAt, "ANCHOR"),
              head: file(enc, at, head, anchorAt, "ANCHOR"),
            });
          });
      }
    // Accepted residual: no re-read of the head after the diff, so a stale
    // head that re-indented the line the head then changed in an invalid
    // byte only proves, and `-w` over it hides that change.
    cases.push({
      name: "accepted residual: caf\\xE9 -> '  caf\\xE9' -> '  caf\\xE8'",
      residual: true,
      base: B("caf", [0xe9], NL, "y\n"),
      stale: B("  caf", [0xe9], NL, "y\n"),
      head: B("  caf", [0xe8], NL, "y\n"),
    });
    // One `git diff --no-index` over every pair, split per file.
    const diffAll = (pairs, ws) => {
      const dir = mkdtempSync(join(root, "run-"));
      mkdirSync(join(dir, "a"));
      mkdirSync(join(dir, "b"));
      pairs.forEach(([o, n], i) => {
        writeFileSync(join(dir, "a", `f${i}`), o);
        writeFileSync(join(dir, "b", `f${i}`), n);
      });
      const args = ["diff", "--no-index", "--no-color", "--no-ext-diff"];
      const r = spawnSync("git", [...args, ...(ws ? ["-w"] : []), "a", "b"], {
        cwd: dir,
        env,
        timeout: 60_000,
      });
      assert.ok(r.status === 0 || r.status === 1, `git: ${r.stderr}`);
      const text = r.stdout.toString("latin1");
      const starts = [...text.matchAll(/^diff --git a\/a\/f(\d+) /gm)];
      const out = pairs.map(() => Buffer.alloc(0));
      starts.forEach((m, j) => {
        const end = j + 1 < starts.length ? starts[j + 1].index : text.length;
        out[Number(m[1])] = r.stdout.subarray(m.index, end);
      });
      return out;
    };
    const lossy = (buf) => new TextDecoder().decode(buf);
    // The `-w` command's answer: from the first hunk on.
    const hunksOf = (buf) => {
      const t = lossy(buf);
      if (t.startsWith("@@")) return t;
      const at = t.indexOf("\n@@");
      return at < 0 ? "" : t.slice(at + 1);
    };
    const noCr = (t) => t.replace(/\r(?=\n|$)/g, "");
    const truePairs = cases.map((c) => [c.base, c.head]);
    const stalePairs = cases.map((c) => [c.base, c.stale]);
    const patches = diffAll(truePairs, false);
    const wsTrue = diffAll(truePairs, true);
    const wsStale = diffAll(stalePairs, true);
    let staleProofs = 0;
    cases.forEach((c, i) => {
      const plain = lossy(patches[i]);
      assert.ok(plain.includes("\n@@ "), `${c.name}: a patch`);
      const b = (buf) => buf.toString("base64");
      assert.notEqual(
        proveForgeSides(KEY, plain, b(c.base), b(c.head)),
        null,
        `${c.name}: the true sides prove`,
      );
      if (proveForgeSides(KEY, plain, b(c.base), b(c.stale)) === null) {
        assert.ok(!c.residual, `${c.name}: the residual's outcome moved`);
        return;
      }
      staleProofs++;
      const [stale, real] = [hunksOf(wsStale[i]), hunksOf(wsTrue[i])];
      if (c.residual) assert.notEqual(stale, real, c.name);
      else if (c.crResidual) assert.equal(noCr(stale), noCr(real), c.name);
      else assert.equal(stale, real, `${c.name}: stale sides proved`);
    });
    // The "stale current" cells (a stale head equal to the head) prove in
    // every encoding and kind, so the oracle ran on proofs, not only refusals.
    assert.ok(staleProofs >= 42, `stale proofs: ${staleProofs}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
