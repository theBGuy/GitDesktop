// Pins the attachment store's pure transitions (src/lib/attachments/
// draft-attachments.ts): a same-name stage replaces its record, an end mid-post
// defers to the settle, and each settle's discards, held copies and revokes.
// Stdlib only, under Node's type stripping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  beginTransition,
  endTransition,
  newEntry,
  postCandidates,
  reclaimable,
  settleTransition,
  startGesture,
  withoutRecords,
  withStaged,
} from "../src/lib/attachments/draft-attachments.ts";

const S = "0123456789abcdef0123456789abcdef";
const rec = (name) => ({
  name,
  mime: "image/png",
  size: 1,
  width: 1,
  height: 1,
  url: `blob:${name}`,
});

function entryWith(...names) {
  let entry = newEntry({});
  for (const name of names) entry = withStaged(entry, S, rec(name)).entry;
  return entry;
}

test("a stage returning a held name replaces that record and revokes its URL", () => {
  const entry = entryWith("image-1.png");
  const next = withStaged(entry, S, { ...rec("image-1.png"), url: "blob:new" });
  assert.deepEqual(next.revoke, ["blob:image-1.png"]);
  assert.deepEqual(
    next.entry.images.map((i) => i.url),
    ["blob:new"],
  );
  assert.equal(next.entry.session, S);
  assert.equal(next.entry.gen, entry.gen);
});

test("an end ends at once, or defers while a post is in flight", () => {
  const entry = entryWith("a.png", "b.png");
  assert.deepEqual(endTransition(entry), {
    deferred: false,
    session: S,
    revoke: ["blob:a.png", "blob:b.png"],
  });
  const posting = beginTransition(entry, ["a.png"]);
  const ended = endTransition(posting);
  assert.equal(ended.deferred, true);
  assert.equal(ended.entry.releaseDeferred, true);
});

test("a second begin on a posting entry is refused, as is an empty one", () => {
  const entry = entryWith("a.png");
  const posting = beginTransition(entry, ["a.png"]);
  assert.deepEqual(posting.posting, ["a.png"]);
  assert.equal(beginTransition(posting, ["a.png"]), null);
  assert.equal(beginTransition(entry, []), null);
  assert.equal(beginTransition(newEntry({}), ["a.png"]), null);
});

test("not posted: the draft and its images stay; a deferred end runs", () => {
  const posting = beginTransition(entryWith("a.png"), ["a.png"]);
  const kept = settleTransition(posting, ["a.png"], {
    posted: false,
    failed: [],
  });
  assert.deepEqual(kept.entry.posting, []);
  assert.equal(kept.entry.images.length, 1);
  assert.equal(kept.discard, null);
  assert.deepEqual(kept.revoke, []);
  const deferred = settleTransition(
    { ...posting, releaseDeferred: true },
    ["a.png"],
    {
      posted: false,
      failed: [],
    },
  );
  assert.equal(deferred.entry, null);
  assert.equal(deferred.discard, "session");
  assert.deepEqual(deferred.revoke, ["blob:a.png"]);
});

test("landed clean: the entry ends, posted images are held, the rest revoked", () => {
  const posting = beginTransition(entryWith("a.png", "b.png"), ["a.png"]);
  const r = settleTransition(posting, ["a.png"], { posted: true, failed: [] });
  assert.equal(r.entry, null);
  assert.equal(r.discard, "session");
  assert.deepEqual(
    r.hold.map((i) => i.name),
    ["a.png"],
  );
  assert.deepEqual(r.revoke, ["blob:b.png"]);
});

test("landed partial: only failed images stay; every other record is discarded", () => {
  // posted, failed, and one whose chip was removed (not in the ticket)
  const posting = beginTransition(entryWith("p.png", "f.png", "r.png"), [
    "p.png",
    "f.png",
  ]);
  const r = settleTransition(posting, ["p.png", "f.png"], {
    posted: true,
    failed: ["f.png"],
  });
  assert.deepEqual(
    r.entry.images.map((i) => i.name),
    ["f.png"],
  );
  assert.deepEqual(r.entry.notice, { failed: ["f.png"] });
  assert.deepEqual(r.entry.posting, []);
  assert.deepEqual(r.discard, ["p.png", "r.png"]);
  assert.deepEqual(
    r.hold.map((i) => i.name),
    ["p.png"],
  );
  assert.deepEqual(r.revoke, ["blob:r.png"]);
  assert.equal(r.entry.gen, posting.gen);
});

test("landed partial with discardFailed ends everything", () => {
  const posting = beginTransition(entryWith("p.png", "f.png"), [
    "p.png",
    "f.png",
  ]);
  const r = settleTransition(posting, ["p.png", "f.png"], {
    posted: true,
    failed: ["f.png"],
    discardFailed: true,
  });
  assert.equal(r.entry, null);
  assert.equal(r.discard, "session");
  assert.deepEqual(r.revoke, ["blob:f.png"]);
  assert.deepEqual(
    r.hold.map((i) => i.name),
    ["p.png"],
  );
});

test("the frontend cap is Rust's MAX_IMAGES", () => {
  const read = (rel) =>
    readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const one = (src, re) => {
    const hits = [...src.matchAll(re)];
    return hits.length === 1 ? Number(hits[0][1]) : null;
  };
  const rust = /^pub\(crate\) const MAX_IMAGES: usize = (\d+);$/gm;
  const ts = /^export const MAX_STAGED_IMAGES = (\d+);$/gm;
  const r = one(read("../src-tauri/src/attachments.rs"), rust);
  assert.notEqual(r, null, "MAX_IMAGES line not found in attachments.rs");
  assert.equal(one(read("../src/lib/attachments/references.ts"), ts), r);
  // The check can fail: a drifted twin and a missing line both read unequal.
  assert.notEqual(one("export const MAX_STAGED_IMAGES = 11;\n", ts), r);
  assert.equal(one("const MAX_IMAGES: usize = 10;\n", rust), null);
});

test("a gesture clears the fresh names only when no stage is in flight", () => {
  const entry = entryWith("a.png", "b.png");
  assert.deepEqual(entry.fresh, ["a.png", "b.png"]);
  assert.deepEqual(startGesture(entry, 0).fresh, []);
  assert.deepEqual(startGesture(entry, 1).fresh, ["a.png", "b.png"]);
  assert.equal(
    startGesture({ ...entry, status: { tone: "info", text: "x" } }, 1).status,
    null,
  );
});

test("only unreferenced, non-fresh names are reclaimable, and none mid-post", () => {
  const entry = startGesture(entryWith("a.png", "b.png", "c.png"), 0);
  assert.deepEqual(reclaimable(entry, ["b.png"]), ["a.png", "c.png"]);
  const fresh = withStaged(entry, S, rec("d.png")).entry;
  assert.deepEqual(reclaimable(fresh, ["b.png"]), ["a.png", "c.png"]);
  assert.deepEqual(reclaimable(beginTransition(entry, ["b.png"]), []), []);
});

test("reclaimed records leave, and only an exact live name retires a reclaimed one", () => {
  const entry = entryWith("a.png", "b.png", "c.png");
  const next = withoutRecords(entry, ["a.png", "c.png"]);
  assert.deepEqual(next.revoke, ["blob:a.png", "blob:c.png"]);
  assert.deepEqual(
    next.entry.images.map((i) => i.name),
    ["b.png"],
  );
  assert.deepEqual(next.entry.reclaimed, ["a.png", "c.png"]);
  assert.deepEqual(postCandidates(next.entry), ["b.png", "a.png", "c.png"]);
  // A live record of exactly that name is no longer a reclaimed one.
  assert.deepEqual(withStaged(next.entry, S, rec("a.png")).entry.reclaimed, [
    "c.png",
  ]);
  // A case variant is a different file: the old reference still reaches Rust,
  // which refuses it, so it is never dropped silently.
  const back = withStaged(next.entry, S, rec("A.png")).entry;
  assert.deepEqual(back.reclaimed, ["a.png", "c.png"]);
  assert.deepEqual(postCandidates(back), ["b.png", "A.png", "a.png", "c.png"]);
  // Reclaiming the variant remembers it beside the other case: either
  // reference must still reach Rust.
  const again = withoutRecords(back, ["A.png"]).entry;
  assert.deepEqual(again.reclaimed, ["a.png", "c.png", "A.png"]);
  assert.deepEqual(postCandidates(again), ["b.png", "a.png", "c.png", "A.png"]);
  assert.deepEqual(postCandidates({ ...next.entry, images: [rec("C.PNG")] }), [
    "C.PNG",
    "a.png",
    "c.png",
  ]);
});
