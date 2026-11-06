// Pins the Clean up dialog's selection policy: the user's choices survive a
// close and reopen, an `<Activity>` re-show and a held-read flap; the selection
// re-seeds only when the repo or the pre-checked set changes. After a batch the
// selection is the pre-run one minus what the batch finished, and after a
// stopped or partly failed one the refetch that follows only prunes names no
// longer listed or held for good (a status read in flight holds a row only for
// now); the user's own controls (mode, window, criteria, worktree opt-in) still
// re-seed. Content verdicts never re-seed: once settled they only ADD rows the
// user hasn't touched, so a landing never unchecks a row or checks one the user
// unchecked, and worktree rows never pre-check. A reseed re-applies them, and a
// reopen drops the rows only they checked.
//
// The policy is a pure module loaded straight from `src/` under Node's type
// stripping, its truth tables re-run over source mutants written to a temp dir;
// the dialog's wiring is pinned over its source text with in-memory mutants.
// Out of reach: a second selection writer added under another name (the pin
// counts the writers it knows), the rendered checkbox state, and the order in
// which verdicts, the seed and user toggles land at runtime (the Vitest suite
// drives those).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  applySettledChecks,
  dropUntouched,
  keepCandidates,
  namesOfKey,
  selectionAfterBatch,
  selectionKey,
  selectionStep,
  settledPreCheck,
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

test("a reopen drops only the untouched rows a verdict checked", () => {
  const sel = new Set(["anc", "auto", "mine"]);
  const auto = new Set(["auto", "mine", "gone"]);
  assert.deepEqual(
    dropUntouched(sel, auto, new Set(["mine"])),
    new Set(["anc", "mine"]),
  );
  assert.equal(dropUntouched(sel, new Set(["gone"]), new Set()), sel);
  assert.equal(sel.size, 3);
});

/** The owner's pre-check table for a verdict-gated row: [verdict, fallback,
 *  pre-checked]. A clean row pre-checks in both modes, unique changes never do,
 *  and an unanswered check keeps the row's fallback. */
const PRE_CHECK_TABLE = [
  ["clean", true, true],
  ["changes", true, false],
  ["unknown", true, true],
  ["clean", false, true],
  ["changes", false, false],
  ["unknown", false, false],
];

function preCheckProblems(fn) {
  return PRE_CHECK_TABLE.filter(([v, fb, want]) => fn(v, fb) !== want).map(
    ([v, fb]) => `${v}/${fb}`,
  );
}

/** What applySettledChecks must answer: adds untouched names only, never
 *  removes, never mutates, and hands back the input when nothing is added. */
function settleProblems(apply) {
  const problems = [];
  const sel = new Set(["a"]);
  const grown = apply(sel, new Set(), ["a", "b"]);
  if (!(grown.has("a") && grown.has("b") && grown.size === 2))
    problems.push("adds untouched");
  if (apply(new Set(), new Set(["b"]), ["b"]).has("b"))
    problems.push("checks a touched row");
  const kept = apply(new Set(["x", "y"]), new Set(), ["b"]);
  if (!(kept.has("x") && kept.has("y"))) problems.push("removes a check");
  if (apply(sel, new Set(), ["a"]) !== sel)
    problems.push("same set, new instance");
  if (apply(sel, new Set(["b"]), ["b"]) !== sel)
    problems.push("touched only, new instance");
  if (apply(sel, new Set(), []) !== sel) problems.push("nothing, new instance");
  if (sel.size !== 1) problems.push("mutates its input");
  return problems;
}

test("a settled verdict pre-checks per the owner's table", () => {
  assert.deepEqual(preCheckProblems(settledPreCheck), []);
});

test("settled checks only add rows the user hasn't touched", () => {
  assert.deepEqual(settleProblems(applySettledChecks), []);
});

test("a verdict policy that checks touched rows, unchecks or flips a verdict fails", async () => {
  const live = readFileSync(
    new URL(`../${POLICY}`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const mutants = {
    "touched ignored": [
      live.replace("!touched.has(n) && ", ""),
      (m) => settleProblems(m.applySettledChecks),
    ],
    "replaces the selection": [
      live.replace("new Set([...selected, ...add])", "new Set(add)"),
      (m) => settleProblems(m.applySettledChecks),
    ],
    "always a new instance": [
      live.replace("add.length === 0 ? selected : ", ""),
      (m) => settleProblems(m.applySettledChecks),
    ],
    "changes falls back": [
      live.replace("changes: false,", "changes: fallbackCheck,"),
      (m) => preCheckProblems(m.settledPreCheck),
    ],
    "unknown always checks": [
      live.replace("unknown: fallbackCheck,", "unknown: true,"),
      (m) => preCheckProblems(m.settledPreCheck),
    ],
    "clean only on fallback": [
      live.replace("clean: true,", "clean: fallbackCheck,"),
      (m) => preCheckProblems(m.settledPreCheck),
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "cleanup-verdicts-"));
  try {
    for (const [name, [text, problems]] of Object.entries(mutants)) {
      assert.notEqual(text, live, name);
      const file = join(dir, `${name.replace(/\W+/g, "-")}.ts`);
      writeFileSync(file, text);
      const mod = await import(pathToFileURL(file).href);
      assert.notDeepEqual(problems(mod), [], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DIALOG = "src/features/repository/CleanupBranchesDialog.tsx";
const source = () =>
  readFileSync(new URL(`../${DIALOG}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const CONTEXT =
  "const selectionContext = `${mode}\\n${windowDays}\\n${criteria.merged ? 1 : 0}${criteria.closed ? 1 : 0}${criteria.idle ? 1 : 0}\\n${includeWorktrees ? 1 : 0}`;";
const CRITERIA_TOKEN =
  "\\n${criteria.merged ? 1 : 0}${criteria.closed ? 1 : 0}${criteria.idle ? 1 : 0}";
const AUTO_FILTER = ".filter((c) => c.merged && !c.worktree)";
const KEEPABLE = 'return hold === null || hold === "pending";';
const SETTLE_CALL = "applySettledChecks(prev, touchedRef.current, want)";
const RESEED_TOUCH = "touchedRef.current = new Set(keptRef.current);";
const BATCH_PRUNE =
  "setSelected((prev) =>\n      selectionAfterBatch(prev, names, processed, retryable),\n    );";
const SETTLE_GUARD =
  'if (running || holdingReads || shouldCheckKey === "") return;';
const TOGGLE_TOUCH =
  "touchedRef.current.add(name);\n    setSelected((prev) => {";
const TOGGLE_ALL_TOUCH =
  "for (const name of candidateNames) touchedRef.current.add(name);";
const SETTLED_ONLY = "return v !== undefined && settledPreCheck(v, fallback);";
const NO_WORKTREE_DESIRE = "if (c.worktree || c.merged) return false;";
const UNSUPPORTED_FALLBACK =
  'if (check.status === "unsupported") return fallback;';

/** The dialog's wiring of the policy: one seed effect stepping it with the
 *  live inputs, every batch pruning through the helper and the post-batch arm
 *  marking a stopped or partly failed one, the settled-verdict effect adding
 *  through its helper, and no other selection writer than the user's toggles
 *  and the reopen's drop. */
function wiringProblems(text) {
  const problems = [];
  const need = {
    "context from the user's controls": CONTEXT,
    "keys through selectionKey":
      "const autoSelectKey = selectionKey(autoSelectNames);",
    "pre-checks ancestry rows outside worktrees only": `const autoSelectNames = useMemo(\n    () =>\n      candidates\n        ${AUTO_FILTER}\n        .map((c) => c.branch.name),\n    [candidates],\n  );`,
    "keepable key": "const keepableKey = selectionKey(",
    "a pending hold stays keepable": KEEPABLE,
    "step with live inputs":
      "const step = selectionStep(selectionSeed.current, {\n      repo: repoPath,\n      open,\n      running,\n      holdingReads,\n      context: selectionContext,\n      autoKey: autoSelectKey,\n    });",
    "seed write keeps every field":
      "selectionSeed.current = {\n      repo: step.repo,\n      seededKey: step.seededKey,\n      afterBatch: step.afterBatch,\n    };",
    "reseed arm resets touched to the kept rows": RESEED_TOUCH,
    "prune arm":
      '} else if (step.action === "prune")\n      setSelected((prev) => keepCandidates(prev, keepableKey));',
    deps: "}, [\n    repoPath,\n    open,\n    autoSelectKey,\n    keepableKey,\n    selectionContext,\n    running,\n    holdingReads,\n  ]);",
    "settled verdicts add through the helper": `useEffect(() => {\n    ${SETTLE_GUARD}\n    const want = namesOfKey(shouldCheckKey).filter(\n      (n) => !touchedRef.current.has(n),\n    );\n    for (const n of want) autoCheckedRef.current.add(n);\n    setSelected((prev) => ${SETTLE_CALL});\n  }, [shouldCheckKey, running, holdingReads]);`,
    "toggle marks touched": TOGGLE_TOUCH,
    "select all marks touched": TOGGLE_ALL_TOUCH,
    "worktree and ancestry rows want no verdict check": NO_WORKTREE_DESIRE,
    "fallback only once unsupported": UNSUPPORTED_FALLBACK,
    "only a landed verdict checks": SETTLED_ONLY,
  };
  for (const [what, spelling] of Object.entries(need))
    if (!text.includes(spelling)) problems.push(`missing: ${what}`);
  const batch = text.indexOf("async function runBatch()");
  const prune = text.indexOf(BATCH_PRUNE, batch);
  const arm = text.indexOf(
    "if (processed < names.length || fails.size > 0) {",
    prune,
  );
  const mark = text.indexOf("afterBatch: selectionContext,", arm);
  const settle = text.indexOf("setProgress(null);", mark);
  if (batch < 0 || prune < 0 || arm < 0 || mark < 0 || settle < 0)
    problems.push(
      "the batch doesn't prune, then mark a stopped or failed batch, before settling",
    );
  // The writers: the two seed arms, the settled-verdict effect, the batch's
  // prune, toggle, toggleAll and the reopen's drop of verdict-only checks.
  const writers = text.split("setSelected(").length - 1;
  if (writers !== 7) problems.push(`selection writers: ${writers}`);
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
      '} else if (step.action === "prune")\n      setSelected((prev) => keepCandidates(prev, keepableKey));',
      '} else if (step.action === "prune")\n      setSelected(new Set(namesOfKey(autoSelectKey)));',
    ),
    live.replace(`    ${BATCH_PRUNE}\n`, ""),
    live.replace("        afterBatch: selectionContext,\n", ""),
    live.replace(
      "if (processed < names.length || fails.size > 0) {",
      "if (processed < names.length) {",
    ),
    live.replace(CONTEXT, CONTEXT.replace("}`;", "}\\n${autoSelectKey}`;")),
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
    // The criteria toggles stop counting as the user's own controls.
    live.replace(CRITERIA_TOKEN, ""),
    // Idle rows seed before their verdict lands (I2).
    live.replace(AUTO_FILTER, ".filter((c) => c.merged || c.old)"),
    // Worktree rows seed, and the opt-in moves the seed key (F1).
    live.replace(AUTO_FILTER, ".filter((c) => c.merged)"),
    // A reseed keeps the previous context's touched rows.
    live.replace(`      ${RESEED_TOUCH}\n`, ""),
    // A landing writes past the touched guard, or replaces the selection.
    live.replace(SETTLE_CALL, "new Set([...prev, ...want])"),
    live.replace(SETTLE_CALL, "new Set(want)"),
    live.replace(SETTLE_GUARD, 'if (running || shouldCheckKey === "") return;'),
    live.replace(TOGGLE_TOUCH, "setSelected((prev) => {"),
    live.replace(`${TOGGLE_ALL_TOUCH}\n`, ""),
    // A pending row takes its fallback provisionally.
    live.replace(
      SETTLED_ONLY,
      'return settledPreCheck(v ?? "unknown", fallback);',
    ),
    live.replace(NO_WORKTREE_DESIRE, "if (c.merged) return false;"),
    live.replace(UNSUPPORTED_FALLBACK, ""),
    // A status read in flight prunes a failed worktree row after a batch.
    live.replace(KEEPABLE, "return hold === null;"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(wiringProblems(mutant), []);
  }
});
