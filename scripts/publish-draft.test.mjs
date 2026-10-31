// Pins the failed-publish draft store: the pure record transitions composed
// with `normPath` exactly as PublishDialog applies them, plus source pins on
// the store file and the dialog's call sites.
//
// Fully static on purpose: both imports are dependency-free `src/` modules
// loaded under Node's type stripping, so the no-install guards job runs every
// case. The zustand store file is never imported here; its shape is pinned by
// reading its source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  clearDraft,
  draftFor,
  stampDraft,
  updateDraftValues,
} from "../src/features/repository/publish-draft.ts";
import { normPath } from "../src/lib/git/path.ts";

const values = (over) => ({
  name: "harbor",
  description: "A harbor",
  homepage: "",
  topics: "boats",
  workspace: "",
  owner: "",
  isPrivate: true,
  ...over,
});

const deepFreeze = (byRepo) => {
  for (const entry of Object.values(byRepo)) {
    Object.freeze(entry.values);
    Object.freeze(entry);
  }
  return Object.freeze(byRepo);
};

// The dialog's composition: one normalized key per repo path.
const stamp = (byRepo, repoPath, provider, v) =>
  stampDraft(byRepo, normPath(repoPath), provider, v);
const read = (byRepo, repoPath) => draftFor(byRepo, normPath(repoPath));
const clear = (byRepo, repoPath) => clearDraft(byRepo, normPath(repoPath));

test("a stamped draft reads back under its repo", () => {
  const byRepo = stamp({}, "C:/work/harbor", "github", values());
  assert.deepEqual(read(byRepo, "C:/work/harbor"), {
    repo: "c:/work/harbor",
    provider: "github",
    values: values(),
  });
});

test("a backslash-spelled stamp reads back under slash and case variants", () => {
  const byRepo = stamp({}, "C:\\work\\harbor", "gitlab", values());
  assert.equal(read(byRepo, "C:/work/harbor")?.provider, "gitlab");
  assert.equal(read(byRepo, "C:/Work/Harbor")?.provider, "gitlab");
  assert.equal(Object.keys(byRepo).length, 1);
  // A clear under another spelling reaches the same entry.
  assert.equal(read(clear(byRepo, "c:/WORK/harbor"), "C:\\work\\harbor"), null);
});

test("two repos hold independent drafts, and clearing one keeps the other", () => {
  let byRepo = stamp({}, "C:/work/harbor", "github", values());
  byRepo = stamp(byRepo, "C:/work/anchor", "bitbucket", values({ name: "a" }));
  const cleared = clear(byRepo, "C:/work/harbor");
  assert.equal(read(cleared, "C:/work/harbor"), null);
  assert.deepEqual(
    read(cleared, "C:/work/anchor")?.values,
    values({ name: "a" }),
  );
});

test("an absent key hands back the record itself", () => {
  const byRepo = deepFreeze(stamp({}, "C:/work/harbor", "github", values()));
  assert.ok(Object.is(clearDraft(byRepo, "c:/work/anchor"), byRepo));
  assert.ok(
    Object.is(updateDraftValues(byRepo, "c:/work/anchor", values()), byRepo),
  );
  assert.equal(draftFor(byRepo, "c:/work/anchor"), null);
});

test("a present key yields a new record and leaves its input untouched", () => {
  const byRepo = deepFreeze(stamp({}, "C:/work/harbor", "github", values()));
  const snapshot = structuredClone(byRepo);
  const key = "c:/work/harbor";
  const results = [
    stampDraft(byRepo, key, "gitlab", values({ name: "b" })),
    clearDraft(byRepo, key),
    updateDraftValues(byRepo, key, values({ name: "c" })),
  ];
  for (const next of results) assert.ok(!Object.is(next, byRepo));
  assert.deepEqual(byRepo, snapshot);
  assert.equal(results[0][key].provider, "gitlab");
  assert.equal(results[1][key], undefined);
  assert.equal(results[2][key].values.name, "c");
  assert.equal(results[2][key].provider, "github");
});

test("a re-stamp overwrites the earlier draft", () => {
  let byRepo = stamp({}, "C:/work/harbor", "github", values());
  byRepo = stamp(
    byRepo,
    "C:\\work\\harbor",
    "bitbucket",
    values({ name: "x" }),
  );
  assert.deepEqual(read(byRepo, "C:/work/harbor"), {
    repo: "c:/work/harbor",
    provider: "bitbucket",
    values: values({ name: "x" }),
  });
});

test("updating values never mints an entry", () => {
  const byRepo = updateDraftValues({}, "c:/work/harbor", values());
  assert.deepEqual(byRepo, {});
});

test("a stamp landing after a clear survives a later absent-key clear", () => {
  // Reopen reseeds (retire on an empty store), the late failure stamps, then a
  // second retire of another key must leave it for the next open to restore.
  let byRepo = clear({}, "C:/work/harbor");
  byRepo = stamp(byRepo, "C:/work/harbor", "github", values());
  byRepo = clear(byRepo, "C:/work/anchor");
  assert.equal(read(byRepo, "C:/work/harbor")?.values.name, "harbor");
});

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const STORE = "src/lib/stores/publish-draft.ts";
const DIALOG = "src/features/repository/PublishDialog.tsx";

// The store is a dumb holder: types, the record, and ONE setter whose
// same-reference arm returns the state object itself (zustand skips notify).
function storeProblems(text) {
  const problems = [];
  const need = {
    "byRepo record": /byRepo: \{\},/,
    "store hook": /export const usePublishDraftStore = create</,
    "same-reference arm":
      /return next === s\.byRepo \? s : \{ byRepo: next \};/,
  };
  for (const [what, re] of Object.entries(need)) {
    if (!re.test(text)) problems.push(`missing: ${what}`);
  }
  const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map(
    (m) => m[1],
  );
  if (imports.join() !== "zustand") problems.push(`imports: ${imports}`);
  if (/@\/features|\.\.\/features/.test(text)) problems.push("features import");
  if ((text.match(/^export function /gm) ?? []).length !== 1) {
    problems.push("exported functions");
  }
  if ((text.match(/setState\(/g) ?? []).length !== 1) {
    problems.push("setState calls");
  }
  // Record logic (spreads, deletes, key writes) belongs to publish-draft.ts.
  if (/\.\.\.(?:s\.)?byRepo|delete |byRepo\[/.test(text)) {
    problems.push("record logic in the store");
  }
  return problems;
}

test("the store is a dumb holder with one setter", () => {
  assert.deepEqual(storeProblems(source(STORE)), []);
});

test("a store that grows record logic or loses its same-reference arm is caught", () => {
  const live = source(STORE);
  const mutants = [
    live.replace(
      "return next === s.byRepo ? s : { byRepo: next };",
      "return { byRepo: next };",
    ),
    `${live}\nexport function dropDraft(key: string): void {\n  usePublishDraftStore.setState((s) => {\n    delete s.byRepo[key];\n    return s;\n  });\n}\n`,
    `${live}\nexport function putDraft(key: string, d: FailedPublishDraft): void {\n  setPublishDrafts((b) => ({ ...b, [key]: d }));\n}\n`,
    live.replace(
      'import { create } from "zustand";',
      'import { create } from "zustand";\nimport { clearDraft } from "@/features/repository/publish-draft";',
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(storeProblems(mutant), []);
  }
});

// The dialog normalizes once, into `repoKey`, and every draft write goes
// through the setter with a pure transition keyed on it.
const TRANSITIONS = ["clearDraft", "stampDraft", "updateDraftValues"];

function dialogProblems(text) {
  const problems = [];
  const norms = text.split("normPath(").length - 1;
  if (norms !== 1 || !text.includes("const repoKey = normPath(repoPath);")) {
    problems.push(`normPath spellings: ${norms}`);
  }
  const setters = [
    ...text.matchAll(
      /setPublishDrafts\(\(drafts\) =>\s*(\w+)\(\s*drafts,\s*(\w+)/g,
    ),
  ];
  const calls = text.split("setPublishDrafts(").length - 1;
  if (setters.length !== calls) problems.push("setter without a transition");
  for (const [, fn, key] of setters) {
    if (!TRANSITIONS.includes(fn)) problems.push(`unknown transition: ${fn}`);
    if (key !== "repoKey") problems.push(`${fn} keyed on ${key}`);
  }
  for (const fn of TRANSITIONS) {
    const uses = text.split(`${fn}(`).length - 1;
    const routed = setters.filter(([, f]) => f === fn).length;
    if (uses !== routed) problems.push(`${fn} outside the setter`);
  }
  if (
    !text.includes("draftFor(usePublishDraftStore.getState().byRepo, repoKey)")
  ) {
    problems.push("draft read not keyed on repoKey");
  }
  if (/\.byRepo\[(?!repoKey\])/.test(text) || /setState\(/.test(text)) {
    problems.push("inline byRepo access");
  }
  return problems;
}

test("the dialog keys every draft write on repoKey through the setter", () => {
  assert.deepEqual(dialogProblems(source(DIALOG)), []);
});

test("a call site keyed on the raw path or editing the record inline is caught", () => {
  const live = source(DIALOG);
  const mutants = [
    live.replace(
      "stampDraft(\n            drafts,\n            repoKey,",
      "stampDraft(\n            drafts,\n            repoPath,",
    ),
    live.replace(
      "updateDraftValues(drafts, repoKey,",
      "updateDraftValues(drafts, repoPath,",
    ),
    live.replace(
      "draftFor(usePublishDraftStore.getState().byRepo, repoKey)",
      "draftFor(usePublishDraftStore.getState().byRepo, repoPath)",
    ),
    live.replace(
      "const repoKey = normPath(repoPath);",
      "const repoKey = normPath(repoPath);\n  const rawKey = normPath(repoPath);",
    ),
    `${live}\nusePublishDraftStore.setState((s) => ({ byRepo: { ...s.byRepo } }));\n`,
    `${live}\nconst x = clearDraft(usePublishDraftStore.getState().byRepo, repoKey);\n`,
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(dialogProblems(mutant), []);
  }
});
