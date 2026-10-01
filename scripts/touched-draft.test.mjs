// Pins the repo-settings draft reconcile (src/features/repo-settings/
// touched-draft.ts) that Security, Pages and Funding run on every render. The
// contract: a touched field retires once the server reads back equal; a saved
// field retires on the first healthy read newer than the save even when the
// server stored something else; a failed post-save refetch holds the saved
// values; a field edited again during the save survives; nothing returns new
// objects when nothing changed, so a render-time caller can't loop.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module
// must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reconcileTouched,
  stampSent,
} from "../src/features/repo-settings/touched-draft.ts";

const SERVER = { cname: "old.example.com", branch: "main" };

function reconcile(over) {
  return reconcileTouched({
    edit: null,
    server: SERVER,
    pending: null,
    dataUpdatedAt: 100,
    isError: false,
    ...over,
  });
}

test("a touched field retires once the server reads back equal", () => {
  const out = reconcile({ edit: { cname: "old.example.com", branch: "dev" } });
  assert.deepEqual(out.edit, { branch: "dev" });
  assert.equal(out.pending, null);
});

test("an edit matching nothing comes back as the same object", () => {
  const edit = { cname: "new.example.com" };
  const pending = { at: 100, sent: { cname: "new.example.com" } };
  const out = reconcile({ edit, pending });
  assert.equal(out.edit, edit);
  assert.equal(out.pending, pending);
});

test("the last touched field retiring clears the edit to null", () => {
  assert.equal(reconcile({ edit: { branch: "main" } }).edit, null);
});

test("a sent field retires after a healthy newer read even when it differs", () => {
  const out = reconcile({
    edit: { cname: "WWW.Example.com " },
    server: { ...SERVER, cname: "www.example.com" },
    pending: { at: 100, sent: { cname: "WWW.Example.com " } },
    dataUpdatedAt: 200,
  });
  assert.equal(out.edit, null);
  assert.equal(out.pending, null);
});

test("a failed post-save refetch holds the saved values", () => {
  const edit = { cname: "new.example.com" };
  const pending = { at: 100, sent: { cname: "new.example.com" } };
  // Not advanced: the post-save refetch failed outright.
  const held = reconcile({ edit, pending, dataUpdatedAt: 100, isError: true });
  assert.equal(held.edit, edit);
  assert.equal(held.pending, pending);
  // Advanced by an unrelated read mid-save, then the post-save refetch failed:
  // the error outlives that read, so the old values must not come back.
  const raced = reconcile({ edit, pending, dataUpdatedAt: 150, isError: true });
  assert.equal(raced.edit, edit);
  assert.equal(raced.pending, pending);
});

test("a field edited again during the save survives the drop", () => {
  const out = reconcile({
    edit: { cname: "newer.example.com", branch: "dev" },
    pending: { at: 100, sent: { cname: "new.example.com", branch: "dev" } },
    dataUpdatedAt: 200,
  });
  assert.deepEqual(out.edit, { cname: "newer.example.com" });
  assert.equal(out.pending, null);
});

test("Discard while a save is pending leaves nothing to resurrect", () => {
  const pending = { at: 100, sent: { cname: "new.example.com" } };
  const before = reconcile({ edit: null, pending, dataUpdatedAt: 100 });
  assert.equal(before.edit, null);
  assert.equal(before.pending, pending);
  const after = reconcile({ edit: null, pending, dataUpdatedAt: 200 });
  assert.equal(after.edit, null);
  assert.equal(after.pending, null);
});

test("stampSent merges overlapping saves under the earliest stamp", () => {
  const first = stampSent(null, 100, { cname: "a.example.com" });
  assert.deepEqual(first, { at: 100, sent: { cname: "a.example.com" } });
  const second = stampSent(first, 150, { branch: "dev" });
  assert.deepEqual(second, {
    at: 100,
    sent: { cname: "a.example.com", branch: "dev" },
  });
  const resent = stampSent(second, 90, { cname: "b.example.com" });
  assert.deepEqual(resent, {
    at: 90,
    sent: { cname: "b.example.com", branch: "dev" },
  });
});

test("boolean toggles reconcile the same way", () => {
  const out = reconcileTouched({
    edit: { secret_scanning: true, code_scanning: true },
    server: { secret_scanning: false, code_scanning: false },
    pending: { at: 100, sent: { secret_scanning: true } },
    dataUpdatedAt: 200,
    isError: false,
  });
  // GitHub refused secret scanning: the healthy read wins; the unsent toggle stays.
  assert.deepEqual(out.edit, { code_scanning: true });
});
