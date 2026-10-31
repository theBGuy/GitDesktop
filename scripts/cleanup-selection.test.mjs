// Pins the Clean up dialog's selection policy: the user's choices survive a
// close and reopen, an `<Activity>` re-show and a held-read flap; the selection
// re-seeds only when the repo or the pre-checked set changes. After a stopped
// or partly failed batch the selection is the pre-run one minus what the batch
// finished, and the refetch that follows only prunes names that stopped being
// candidates; the user's own controls (mode, window) still re-seed.
//
// The policy is a pure module loaded straight from `src/` under Node's type
// stripping, its truth table re-run over source mutants written to a temp dir;
// the dialog's wiring is pinned over its source text with in-memory mutants.
// Out of reach: a second selection writer added under another name (the pin
// counts the writers it knows), and the rendered checkbox state.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  keepCandidates,
  namesOfKey,
  selectionAfterBatch,
  selectionKey,
  selectionStep,
} from "../src/features/repository/cleanup-selection.ts";

const POLICY = "src/features/repository/cleanup-selection.ts";
const REPO = "C:/r";
const ARCHIVE_60 = "archive\n60";
const DELETE_60 = "delete\n60";
const ABC = selectionKey(["a", "b", "c"]);
const open = (over) => ({
  repo: REPO,
  open: true,
  running: false,
  holdingReads: false,
  context: ARCHIVE_60,
  autoKey: ABC,
  ...over,
});
const fresh = { repo: null, seededKey: null, afterBatch: null };
const seedOf = ({ repo, seededKey, afterBatch }) => ({
  repo,
  seededKey,
  afterBatch,
});

/** Each truth-table row the policy must answer, run over a given `step`:
 *  the failing rows' names. */
function tableProblems(step) {
  const problems = [];
  const expect = (row, got, action) => {
    if (got.action !== action) problems.push(`${row}: ${got.action}`);
  };
  const seeded = step(fresh, open({}));
  expect("first open", seeded, "reseed");
  // An `<Activity>` re-show re-runs the effect over the same inputs.
  expect("re-show", step(seedOf(seeded), open({})), "none");
  const closed = step(seedOf(seeded), open({ open: false }));
  expect("close", closed, "none");
  expect("reopen, same set", step(seedOf(closed), open({})), "none");
  const changed = selectionKey(["a"]);
  expect(
    "reopen, set changed",
    step(seedOf(closed), open({ autoKey: changed })),
    "reseed",
  );
  expect(
    "repo change while open",
    step(seedOf(seeded), open({ repo: "C:/other" })),
    "reseed",
  );
  expect(
    "reopen in another repo",
    step(seedOf(closed), open({ repo: "C:/other" })),
    "reseed",
  );
  // A held read stands in while open (the list may differ); it lands unchanged.
  for (const hold of [{ running: true }, { holdingReads: true }]) {
    const held = step(seedOf(seeded), open({ ...hold, autoKey: changed }));
    expect(`held ${Object.keys(hold)[0]}`, held, "none");
    expect(
      `after ${Object.keys(hold)[0]}`,
      step(seedOf(held), open({})),
      "none",
    );
  }
  const after = { ...seedOf(seeded), afterBatch: ARCHIVE_60 };
  for (const autoKey of [ABC, selectionKey(["c"])])
    expect(`post-batch ${autoKey}`, step(after, open({ autoKey })), "prune");
  expect(
    "post-batch mode switch",
    step(after, open({ context: DELETE_60, autoKey: changed })),
    "reseed",
  );
  // A close ends the post-batch window: the reopen re-seeds a changed set.
  const shut = step(after, open({ open: false }));
  expect(
    "post-batch reopen",
    step(seedOf(shut), open({ autoKey: changed })),
    "reseed",
  );
  return problems;
}

test("keys are order-free and round-trip", () => {
  assert.equal(selectionKey(["c", "a", "b"]), selectionKey(["a", "b", "c"]));
  assert.deepEqual(namesOfKey(selectionKey(["b", "a"])), ["a", "b"]);
  assert.deepEqual(namesOfKey(""), []);
});

test("the policy answers every truth-table row", () => {
  assert.deepEqual(tableProblems(selectionStep), []);
});

test("a close keeps the seed and the repo; a step adopts the live set", () => {
  const seeded = selectionStep(fresh, open({}));
  assert.deepEqual(seedOf(seeded), {
    repo: REPO,
    seededKey: ABC,
    afterBatch: null,
  });
  const closed = selectionStep(
    { ...seedOf(seeded), afterBatch: ARCHIVE_60 },
    open({ open: false }),
  );
  assert.deepEqual(seedOf(closed), {
    repo: REPO,
    seededKey: ABC,
    afterBatch: null,
  });
  const pruned = selectionStep(
    { ...seedOf(seeded), afterBatch: ARCHIVE_60 },
    open({ autoKey: selectionKey(["c"]) }),
  );
  assert.equal(pruned.seededKey, selectionKey(["c"]));
  assert.equal(pruned.afterBatch, ARCHIVE_60);
});

test("after a batch, a window change that keeps the set re-seeds nothing", () => {
  const seeded = selectionStep(fresh, open({}));
  const pruned = selectionStep(
    { ...seedOf(seeded), afterBatch: ARCHIVE_60 },
    open({ autoKey: selectionKey(["c"]) }),
  );
  const step = selectionStep(
    seedOf(pruned),
    open({ context: "archive\n90", autoKey: selectionKey(["c"]) }),
  );
  assert.equal(step.action, "none");
  assert.equal(step.afterBatch, null);
  const moved = selectionStep(
    seedOf(pruned),
    open({ context: "archive\n90", autoKey: selectionKey(["c", "d"]) }),
  );
  assert.equal(moved.action, "reseed");
});

test("a policy that forgets on close, ignores the repo or holds badly fails", async () => {
  const live = readFileSync(
    new URL(`../${POLICY}`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const close =
    'if (!input.open) return { ...seed, afterBatch: null, action: "none" };';
  const mutants = {
    "close forgets the seed": live.replace(
      close,
      'if (!input.open)\n    return { repo: null, seededKey: null, afterBatch: null, action: "none" };',
    ),
    "close keeps the post-batch window": live.replace(
      close,
      'if (!input.open) return { ...seed, action: "none" };',
    ),
    "repo ignored": live.replace("if (seed.repo !== repo)", "if (false)"),
    "held read not held": live.replace(
      "if (input.running || input.holdingReads)",
      "if (input.running)",
    ),
  };
  const dir = mkdtempSync(join(tmpdir(), "cleanup-selection-"));
  try {
    for (const [name, text] of Object.entries(mutants)) {
      assert.notEqual(text, live, name);
      const file = join(dir, `${name.replace(/\W+/g, "-")}.ts`);
      writeFileSync(file, text);
      const mod = await import(pathToFileURL(file).href);
      assert.notDeepEqual(tableProblems(mod.selectionStep), [], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the post-batch selection keeps choices, failures and the unprocessed", () => {
  // `c` was pre-checked but the user unchecked it before the run.
  const pre = new Set(["a", "b", "d"]);
  const names = ["a", "b", "d"];
  const none = new Set();
  // Stopped before the first branch: nothing finished.
  assert.deepEqual(selectionAfterBatch(pre, names, 0, none), pre);
  // Stopped at i = 1: `a` finished, the rest stay selected.
  assert.deepEqual(
    selectionAfterBatch(pre, names, 1, none),
    new Set(["b", "d"]),
  );
  // Ran through with `b` failing: only the failure stays.
  assert.deepEqual(
    selectionAfterBatch(pre, names, 3, new Map([["b", "why"]])),
    new Set(["b"]),
  );
  for (const out of [
    selectionAfterBatch(pre, names, 0, none),
    selectionAfterBatch(pre, names, 3, none),
  ])
    assert.equal(out.has("c"), false);
});

test("pruning drops only names that left the candidates", () => {
  const sel = new Set(["b", "x"]);
  assert.deepEqual(
    keepCandidates(sel, selectionKey(["b", "c"])),
    new Set(["b"]),
  );
  const kept = new Set(["b"]);
  assert.equal(keepCandidates(kept, selectionKey(["b", "c"])), kept);
  assert.equal(keepCandidates(kept, selectionKey(["b"])).has("c"), false);
});

const DIALOG = "src/features/repository/CleanupBranchesDialog.tsx";
const source = () =>
  readFileSync(new URL(`../${DIALOG}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** The dialog's wiring of the policy: one seed effect stepping it with the
 *  live inputs, the post-batch arm marking the batch and pruning through the
 *  helper, and no other selection writer than the user's toggles. */
function wiringProblems(text) {
  const problems = [];
  const need = {
    "context from the user's controls":
      "const selectionContext = `${mode}\\n${windowDays}`;",
    "keys through selectionKey":
      "const autoSelectKey = selectionKey(autoSelectNames);",
    "candidate key": "const candidateKey = selectionKey(candidateNames);",
    "step with live inputs":
      "const step = selectionStep(selectionSeed.current, {\n      repo: repoPath,\n      open,\n      running,\n      holdingReads,\n      context: selectionContext,\n      autoKey: autoSelectKey,\n    });",
    "seed write keeps every field":
      "selectionSeed.current = {\n      repo: step.repo,\n      seededKey: step.seededKey,\n      afterBatch: step.afterBatch,\n    };",
    "reseed arm":
      'if (step.action === "reseed")\n      setSelected(new Set(namesOfKey(autoSelectKey)));',
    "prune arm":
      'else if (step.action === "prune")\n      setSelected((prev) => keepCandidates(prev, candidateKey));',
    deps: "}, [\n    repoPath,\n    open,\n    autoSelectKey,\n    candidateKey,\n    selectionContext,\n    running,\n    holdingReads,\n  ]);",
  };
  for (const [what, spelling] of Object.entries(need))
    if (!text.includes(spelling)) problems.push(`missing: ${what}`);
  const batch = text.indexOf("async function runBatch()");
  const settle = text.indexOf("setProgress(null);", batch);
  const arm = text.indexOf(
    "if (processed < names.length || fails.size > 0) {",
    batch,
  );
  const mark = text.indexOf("afterBatch: selectionContext,", arm);
  const prune = text.indexOf(
    "setSelected((prev) => selectionAfterBatch(prev, names, processed, fails));",
    arm,
  );
  if (batch < 0 || arm < 0 || mark < 0 || prune < 0 || !(prune < settle))
    problems.push(
      "post-batch arm doesn't mark the batch and prune before settling",
    );
  // The writers: the two seed arms, the post-batch arm, toggle and toggleAll.
  const writers = text.split("setSelected(").length - 1;
  if (writers !== 5) problems.push(`selection writers: ${writers}`);
  return problems;
}

test("the dialog steps the policy and prunes after a batch", () => {
  assert.deepEqual(wiringProblems(source()), []);
});

test("a dialog that re-seeds after a batch, skips the prune or drops the repo is caught", () => {
  const live = source();
  const mutants = [
    // The old shape: re-seed whenever the effect runs off a batch.
    live.replace(
      'else if (step.action === "prune")\n      setSelected((prev) => keepCandidates(prev, candidateKey));',
      'else if (step.action === "prune")\n      setSelected(new Set(namesOfKey(autoSelectKey)));',
    ),
    live.replace(
      "      setSelected((prev) => selectionAfterBatch(prev, names, processed, fails));\n",
      "",
    ),
    live.replace("        afterBatch: selectionContext,\n", ""),
    live.replace(
      "if (processed < names.length || fails.size > 0) {",
      "if (processed < names.length) {",
    ),
    live.replace(
      "const selectionContext = `${mode}\\n${windowDays}`;",
      "const selectionContext = `${mode}\\n${windowDays}\\n${autoSelectKey}`;",
    ),
    live.replace(
      "      running,\n      holdingReads,\n      context:",
      "      running: false,\n      holdingReads,\n      context:",
    ),
    live.replace(
      "  const allChecked =",
      "  useEffect(() => setSelected(new Set(candidateNames)), [running]);\n  const allChecked =",
    ),
    live.replace("      repo: repoPath,\n      open,", "      open,"),
    live.replace("      repo: step.repo,\n", ""),
    live.replace("  }, [\n    repoPath,\n    open,", "  }, [\n    open,"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(wiringProblems(mutant), []);
  }
});
