// Pins the local-PR reconcile decision: what a merge-states row does to the FRESH
// record the store re-reads under its lock. The read can predate a rename that
// migrated the PR's head, so the verdict must land only on the record it was made
// for; a miss closes a PR the rename just carried over, with no error anywhere.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `reconcile.ts` may
// import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyReconcileVerdict,
  reconcileKey,
  reconcileVerdict,
} from "../src/lib/pulls/reconcile.ts";

const NOW = "2026-10-15T12:00:00.000Z";

const pr = (over = {}) => ({
  id: "pr-1",
  title: "t",
  body: "",
  base: "main",
  head: "feat/a",
  status: "open",
  approved: false,
  labels: [],
  comments: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const read = { base: "main", head: "feat/a" };

test("a deleted head closes; a merged head merges; otherwise no verdict", () => {
  assert.equal(reconcileVerdict({ merged: false, headExists: false }), "closed");
  assert.equal(reconcileVerdict({ merged: true, headExists: true }), "merged");
  assert.equal(reconcileVerdict({ merged: true, headExists: false }), "merged");
  assert.equal(reconcileVerdict({ merged: false, headExists: true }), null);
});

test("(a) head gone on the record the read was made for: closed", () => {
  const next = applyReconcileVerdict(pr(), read, "closed", NOW);
  assert.equal(next.status, "closed");
  assert.equal(next.head, "feat/a");
});

test("(b) head gone but the record was migrated to a new head: unchanged", () => {
  const cur = pr({ head: "feat/b" });
  assert.equal(applyReconcileVerdict(cur, read, "closed", NOW), cur);
});

test("(c) merged on the record the read was made for: merged, mergedAt kept", () => {
  const fresh = applyReconcileVerdict(pr(), read, "merged", NOW);
  assert.equal(fresh.status, "merged");
  assert.equal(fresh.mergedAt, NOW);
  const stamped = pr({ mergedAt: "2026-10-02T00:00:00.000Z" });
  const kept = applyReconcileVerdict(stamped, read, "merged", NOW);
  assert.equal(kept.status, "merged");
  assert.equal(kept.mergedAt, "2026-10-02T00:00:00.000Z");
});

test("(d) merged but the record's base moved: unchanged", () => {
  const cur = pr({ base: "develop" });
  assert.equal(applyReconcileVerdict(cur, read, "merged", NOW), cur);
});

test("(e) a record already closed or merged is never rewritten", () => {
  for (const status of ["closed", "merged"]) {
    const cur = pr({ status });
    assert.equal(applyReconcileVerdict(cur, read, "closed", NOW), cur);
    assert.equal(applyReconcileVerdict(cur, read, "merged", NOW), cur);
  }
});

test("(f) the evaluation key changes when the head or base changes", () => {
  const base = reconcileKey(pr());
  assert.equal(reconcileKey(pr()), base);
  assert.notEqual(reconcileKey(pr({ head: "feat/b" })), base);
  assert.notEqual(reconcileKey(pr({ base: "develop" })), base);
  assert.notEqual(reconcileKey(pr({ id: "pr-2" })), base);
});
