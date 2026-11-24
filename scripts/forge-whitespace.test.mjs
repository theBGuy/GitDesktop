// Pins the forge-patch whitespace mode's pure half
// (src/features/diff/forge-whitespace.ts): the fallback copy, the proof that a
// pair of reads is the forge patch's own, and the reducer that picks what a
// slot draws. The import reaches straight into src/ under Node's type
// stripping (the module's runtime imports are relative .ts ones); no install.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  proveForgeSides,
  reduceForgeWhitespace,
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
    proof: proveForgeSides(KEY, PLAIN.text, OLD, NEW),
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
      proof: proveForgeSides(KEY, plain.text, OLD, NEW),
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
      { proof: proveForgeSides(OTHER_KEY, PLAIN.text, OLD, NEW) },
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

test("D2: sides that are not the forge patch's own mint no proof (mismatch)", () => {
  // The same hunks over a gap line the forge patch never had.
  const stale = OLD.replace("  line 9\n", "  line nine\n");
  assert.equal(
    proveForgeSides(
      KEY,
      PLAIN.text,
      stale,
      NEW.replace("  line 9\n", "  line nine\n"),
    ),
    null,
  );
  const view = last(
    inputs({
      oldSide: { kind: "ready", bytes: bytes(stale) },
      proof: proveForgeSides(KEY, PLAIN.text, stale, NEW),
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
    inputs({ plain: bare, proof: proveForgeSides(KEY, bare.text, OLD, NEW) }),
  );
  assert.equal(view.data.text, WS_HUNKS);
  assert.equal(view.data.whitespaceHidden, true);
  const wsOnly = last(
    inputs({
      plain: bare,
      proof: proveForgeSides(KEY, bare.text, OLD, NEW),
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
