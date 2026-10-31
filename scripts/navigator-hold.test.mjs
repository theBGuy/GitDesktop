// Pins the hold a cross-repo navigation takes on the new repo's shell warm-up
// (`holdNavigation` in src/lib/stores/navigator-hold.ts): it never lands before
// the warm-up settles, lands exactly once after it, within a microtask when the
// warm-up has already settled, and not at all once a newer open or navigation
// superseded it, read when the warm-up settles rather than at the request. Each
// check must also fail on the in-memory mutants at the bottom, so a check that
// can't tell the contract from its breakage fails here instead.
//
// The imports reach straight into `src/` under Node's type stripping, which
// resolves no bundler aliases, so both modules must stay import-free. Node's
// stdlib test runner only: the CI `guards` job runs
// `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOpenClaims } from "../src/features/repository/open-claims.ts";
import { holdNavigation } from "../src/lib/stores/navigator-hold.ts";

const MODULE = fileURLToPath(
  new URL("../src/lib/stores/navigator-hold.ts", import.meta.url),
);

/** Lets every pending microtask and the current macrotask turn run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A warm-up still running holds the landing; its settle lands it once. */
async function deferredSettleProblems(hold) {
  const settle = deferred();
  let lands = 0;
  hold({ settled: settle.promise, stillCurrent: () => true }, () => lands++);
  const problems = [];
  await flush();
  if (lands !== 0)
    problems.push(`landed ${lands} time(s) before the warm-up settled`);
  settle.resolve();
  await flush();
  await flush();
  if (lands !== 1)
    problems.push(`landed ${lands} time(s) once the warm-up settled`);
  return problems;
}

/** Superseded between the request and the settle: the landing never applies. */
async function supersededProblems(hold) {
  const settle = deferred();
  let current = true;
  let lands = 0;
  hold({ settled: settle.promise, stillCurrent: () => current }, () => lands++);
  current = false;
  settle.resolve();
  await flush();
  return lands === 0 ? [] : [`a superseded hold landed ${lands} time(s)`];
}

/** An already-warm target lands once, within a microtask of the request. */
async function alreadySettledProblems(hold) {
  let lands = 0;
  hold({ settled: Promise.resolve(), stillCurrent: () => true }, () => lands++);
  // The hold's reaction was queued before this await's, so it has run by now.
  await null;
  const problems = [];
  if (lands !== 1)
    problems.push(`landed ${lands} time(s) a microtask after the request`);
  await flush();
  await flush();
  if (lands !== 1) problems.push(`landed ${lands} time(s) in all`);
  return problems;
}

/** Two holds numbered by the open claims: only the newer request lands, even
 *  when the older warm-up settles last. */
async function newerWinsProblems(hold) {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const older = deferred();
  const newer = deferred();
  const landed = [];
  hold({ settled: older.promise, stillCurrent: claims.claim() }, () =>
    landed.push("older"),
  );
  hold({ settled: newer.promise, stillCurrent: claims.claim() }, () =>
    landed.push("newer"),
  );
  newer.resolve();
  await flush();
  older.resolve();
  await flush();
  return JSON.stringify(landed) === '["newer"]'
    ? []
    : [`landed ${JSON.stringify(landed)}, expected only the newer`];
}

const CHECKS = [
  deferredSettleProblems,
  supersededProblems,
  alreadySettledProblems,
  newerWinsProblems,
];

test("a held navigation never lands before its warm-up settles, then lands once", async () => {
  assert.deepEqual(await deferredSettleProblems(holdNavigation), []);
});

test("a navigation superseded during its warm-up never lands", async () => {
  assert.deepEqual(await supersededProblems(holdNavigation), []);
});

test("an already-settled warm-up lands once, a microtask later", async () => {
  assert.deepEqual(await alreadySettledProblems(holdNavigation), []);
});

test("of two held navigations, only the newer request lands", async () => {
  assert.deepEqual(await newerWinsProblems(holdNavigation), []);
});

const BODY =
  "  void warm.settled.then(() => {\n    if (warm.stillCurrent()) land();\n  });\n";

/** Each mutant breaks one clause of the contract the checks above pin. */
const MUTANTS = {
  "lands at the request, ahead of the warm-up": (s) =>
    s.replace(BODY, () => "  if (warm.stillCurrent()) land();\n"),
  "lands without the supersession check": (s) =>
    s.replace("if (warm.stillCurrent()) land();", () => "land();"),
  "checks supersession at the request, not the settle": (s) =>
    s.replace(
      BODY,
      () =>
        "  const current = warm.stillCurrent();\n  void warm.settled.then(() => {\n    if (current) land();\n  });\n",
    ),
  "lands twice": (s) => s.replace(BODY, () => BODY + BODY),
  "lands a macrotask late": (s) =>
    s.replace(
      BODY,
      () =>
        "  void warm.settled.then(() => {\n    setTimeout(() => {\n      if (warm.stillCurrent()) land();\n    }, 0);\n  });\n",
    ),
};

test("negative control: every mutant of the hold fails a check", async () => {
  const source = readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n");
  assert.equal(source.split(BODY).length, 2, "control premise: one hold body");
  const dir = mkdtempSync(join(tmpdir(), "gd-navigator-hold-mutant-"));
  try {
    // Pins the copies' module format; otherwise Node takes it from whatever
    // package.json happens to sit above the temp dir.
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    for (const [i, [name, mutate]] of Object.entries(MUTANTS).entries()) {
      const mutant = mutate(source);
      assert.notEqual(mutant, source, `mutant "${name}" didn't apply`);
      const copy = join(dir, `navigator-hold-${i}.ts`);
      writeFileSync(copy, mutant);
      const { holdNavigation: hold } = await import(pathToFileURL(copy).href);
      const problems = [];
      for (const check of CHECKS) problems.push(...(await check(hold)));
      assert.ok(problems.length > 0, `the checks passed mutant "${name}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
