// Pins "Resolve all with AI"'s prefilter (src/lib/git/conflict-prefilter.ts):
// the blocked gate's equivalence with ConflictResolveView's old inline check,
// the skip-reason priority, partition's order and fail-toward-inclusion arm,
// and every summary-toast string. Also pins the two wiring lines a refactor
// could drop: the view's gate swap and the store's stale re-checks.
//
// Not testable here: the store's async run against real IPC, the banner hold's
// focus behavior, and the walk landing. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BINARY_REFUSAL,
  conflictAiBlockReason,
  LINKED_ANCESTOR_TAIL,
  PREFILTER_READ_REASON,
  partition,
  prefilterToast,
  SIDES_READ_CHUNK,
  sidesRefusal,
  TOO_LARGE_REFUSAL,
} from "../src/lib/git/conflict-prefilter.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) =>
  readFileSync(join(REPO_ROOT, file), "utf8").replace(/\r\n/g, "\n");
const HELPER = "src/lib/git/conflict-prefilter.ts";

const verdict = ({
  undecodable = false,
  workingUndecodable = false,
  ignored = false,
  unreadable = false,
  resolved = false,
} = {}) => ({
  undecodable,
  workingUndecodable,
  aiIgnored: { ignored, unreadable },
  resolved,
});
const ok = (value) => ({ status: "fulfilled", value });
const failed = { status: "rejected", reason: new Error("read failed") };

test("the blocked gate matches the view's old inline check on every flag row", () => {
  for (const undecodable of [false, true])
    for (const workingUndecodable of [false, true])
      for (const ignored of [false, true])
        for (const unreadable of [false, true]) {
          const v = verdict({
            undecodable,
            workingUndecodable,
            ignored,
            unreadable,
          });
          assert.equal(
            conflictAiBlockReason(v) !== null,
            undecodable || ignored,
            JSON.stringify(v),
          );
        }
});

test("the blocked gate's reason priority", () => {
  const cases = [
    [
      {
        undecodable: true,
        workingUndecodable: true,
        ignored: true,
        unreadable: true,
      },
      "undecodable",
    ],
    [{ undecodable: true, ignored: true, unreadable: true }, "partUndecodable"],
    [{ ignored: true, unreadable: true }, "unreadableName"],
    [{ ignored: true }, "excluded"],
    // Impossible in real data (unreadable implies ignored): pinned to queue.
    [{ unreadable: true }, null],
    [{ workingUndecodable: true }, null],
    [{}, null],
  ];
  for (const [flags, want] of cases)
    assert.equal(
      conflictAiBlockReason(verdict(flags)),
      want,
      JSON.stringify(flags),
    );
  // The prefilter's own reason never reaches the view's gate.
  assert.equal(conflictAiBlockReason(verdict({ resolved: true })), null);
});

test("partition keeps click order across chunk boundaries and outranks with resolved", () => {
  assert.equal(SIDES_READ_CHUNK, 4);
  const paths = Array.from({ length: 9 }, (_, i) => `d/f${i}.txt`);
  const reads = [
    ok(verdict()),
    ok(verdict({ undecodable: true, workingUndecodable: true })),
    failed,
    ok(verdict()),
    ok(verdict({ ignored: true })),
    failed,
    ok(verdict({ resolved: true, undecodable: true, ignored: true })),
    ok(verdict({ undecodable: true })),
    ok(verdict({ ignored: true, unreadable: true })),
  ];
  assert.deepEqual(partition(paths, reads), {
    queued: ["d/f0.txt", "d/f2.txt", "d/f3.txt", "d/f5.txt"],
    skipped: [
      { path: "d/f1.txt", reason: "undecodable" },
      { path: "d/f4.txt", reason: "excluded" },
      { path: "d/f6.txt", reason: "resolved" },
      { path: "d/f7.txt", reason: "partUndecodable" },
      { path: "d/f8.txt", reason: "unreadableName" },
    ],
  });
});

test("partition: empty, all skipped, all failed", () => {
  assert.deepEqual(partition([], []), { queued: [], skipped: [] });
  assert.deepEqual(
    partition(
      ["a/logo.psd", "b/logo.psd"],
      [
        ok(verdict({ undecodable: true, workingUndecodable: true })),
        ok(verdict({ undecodable: true, workingUndecodable: true })),
      ],
    ).queued,
    [],
  );
  const all = partition(["x", "y", "z"], [failed, failed, failed]);
  assert.deepEqual(all, { queued: ["x", "y", "z"], skipped: [] });
  assert.equal(prefilterToast({ total: 3, ...all }), null);
});

const skip = (path, reason) => ({ path, reason });

test("toast copy", () => {
  const rows = [
    [{ total: 3, queued: ["a", "b", "c"], skipped: [] }, null],
    [
      {
        total: 3,
        queued: ["a", "b"],
        skipped: [skip("art/logo.psd", "undecodable")],
      },
      "Resolving 2 of 3 files with AI. Skipped logo.psd (it isn't UTF-8 text).",
    ],
    [
      {
        total: 3,
        queued: ["a", "b"],
        skipped: [skip("x/y.bin", "partUndecodable")],
      },
      "Resolving 2 of 3 files with AI. Skipped y.bin (part of it isn't UTF-8 text).",
    ],
    [
      { total: 2, queued: ["a"], skipped: [skip("secrets.env", "excluded")] },
      "Resolving 1 of 2 files with AI. Skipped secrets.env (it's excluded from AI).",
    ],
    [
      {
        total: 2,
        queued: ["a"],
        skipped: [skip("d/bad\uFFFDname", "unreadableName")],
      },
      "Resolving 1 of 2 files with AI. Skipped bad\uFFFDname (its name isn't readable text).",
    ],
    [
      { total: 2, queued: ["a"], skipped: [skip("done.ts", "resolved")] },
      "Resolving 1 of 2 files with AI. Skipped done.ts (it's already resolved).",
    ],
    [
      {
        total: 7,
        queued: ["a", "b", "c", "d"],
        skipped: [
          skip("1", "undecodable"),
          skip("2", "excluded"),
          skip("3", "undecodable"),
        ],
      },
      "Resolving 4 of 7 files with AI. Skipped 3 files: 2 aren't UTF-8 text, 1 is excluded from AI.",
    ],
    [
      {
        total: 9,
        queued: ["a", "b", "c", "d"],
        skipped: [
          skip("1", "excluded"),
          skip("2", "unreadableName"),
          skip("3", "partUndecodable"),
          skip("4", "resolved"),
          skip("5", "resolved"),
        ],
      },
      "Resolving 4 of 9 files with AI. Skipped 5 files: 2 are already resolved, 1 has a part that isn't UTF-8 text, 1 has a name that isn't readable text, 1 is excluded from AI.",
    ],
    [
      {
        total: 4,
        queued: [],
        skipped: [
          skip("a", "partUndecodable"),
          skip("b", "partUndecodable"),
          skip("c", "unreadableName"),
          skip("d", "unreadableName"),
        ],
      },
      "Nothing to resolve with AI: 2 files have parts that aren't UTF-8 text, 2 have names that aren't readable text.",
    ],
    [
      {
        total: 3,
        queued: [],
        skipped: [
          skip("a", "undecodable"),
          skip("b", "undecodable"),
          skip("c", "excluded"),
        ],
      },
      "Nothing to resolve with AI: 2 files aren't UTF-8 text, 1 is excluded from AI.",
    ],
    [
      {
        total: 2,
        queued: [],
        skipped: [
          skip("a/logo.psd", "excluded"),
          skip("b/logo.psd", "undecodable"),
        ],
      },
      "Nothing to resolve with AI: 1 file isn't UTF-8 text, 1 is excluded from AI.",
    ],
    // The single-file route's one skip: no "/" in a root path.
    [
      { total: 1, queued: [], skipped: [skip("README.md", "resolved")] },
      "Nothing to resolve with AI: README.md is already resolved.",
    ],
  ];
  for (const [input, want] of rows)
    assert.equal(prefilterToast(input), want, JSON.stringify(input));
  assert.equal(PREFILTER_READ_REASON, "Reading the conflicted files…");
});

test("no copy blames the user's rules for an unreadable name", () => {
  const lines = [
    prefilterToast({
      total: 2,
      queued: ["a"],
      skipped: [skip("n", "unreadableName")],
    }),
    prefilterToast({
      total: 3,
      queued: [],
      skipped: [
        skip("n", "unreadableName"),
        skip("m", "unreadableName"),
        skip("o", "unreadableName"),
      ],
    }),
  ];
  for (const line of lines)
    assert.doesNotMatch(line, /pattern|ignore|exclude|rule/i);
});

// Mutants load from memory: a load hook serves each mutated source under the
// helper's own URL plus a query, so nothing is written to disk and its one
// type import still resolves beside the real file.
const HELPER_URL = pathToFileURL(join(REPO_ROOT, HELPER)).href;
const mutants = new Map();
registerHooks({
  load(url, context, next) {
    const source = mutants.get(url);
    if (source === undefined) return next(url, context);
    return { format: "module-typescript", source, shortCircuit: true };
  },
});

/** Imports the helper with `from` replaced by `to`, from memory. */
async function importMutated(from, to) {
  const source = read(HELPER);
  const out = source.replace(from, to);
  assert.notEqual(out, source, `mutation did not apply: ${from}`);
  const url = `${HELPER_URL}?mutant=${mutants.size}`;
  mutants.set(url, out);
  return import(url);
}

test("a failed read queues: a fail-closed partition goes red", async () => {
  const mutated = await importMutated(
    'if (read?.status !== "fulfilled") {\n      queued.push(path);',
    'if (read?.status !== "fulfilled") {\n      skipped.push({ path, reason: "excluded" });',
  );
  const run = (mod) => mod.partition(["x"], [failed]).queued;
  assert.deepEqual(run({ partition }), ["x"]);
  assert.notDeepEqual(run(mutated), ["x"]);
});

test("the gate keeps the view's population: a resolved-aware gate goes red", async () => {
  const mutated = await importMutated(
    "if (sides.undecodable) {",
    'if ("resolved" in sides && sides.resolved) return "excluded";\n  if (sides.undecodable) {',
  );
  const v = verdict({ resolved: true });
  assert.equal(conflictAiBlockReason(v), null);
  assert.notEqual(mutated.conflictAiBlockReason(v), null);
});

/** The wiring a refactor could silently drop. */
function pinWiring(view, store) {
  assert.match(view, /if \(conflictAiBlockReason\(resolved\) !== null\) \{/);
  assert.doesNotMatch(
    view,
    /resolved\.undecodable \|\| resolved\.aiIgnored\.ignored/,
  );
  // One re-check after the exclude read, one after each chunk, one at settle.
  assert.equal(store.match(/if \(stale\(\)\) return null;/g)?.length, 2);
  assert.match(store, /if \(split === null \|\| stale\(\)\) return;/);
  assert.match(store, /tolerateRepoReadError: true/);
  assert.match(store, /\.catch\(\(\): string\[\] => \[\]\)/);
}

test("the view swap and the store's stale re-checks are wired", () => {
  const view = read("src/features/repository/ConflictResolveView.tsx");
  const store = read("src/lib/stores/conflict-resolve.ts");
  pinWiring(view, store);
  const mutate = (s, from, to) => {
    const out = s.replace(from, to);
    assert.notEqual(out, s, `mutation did not apply: ${from}`);
    return out;
  };
  assert.throws(() =>
    pinWiring(
      mutate(
        view,
        "conflictAiBlockReason(resolved) !== null",
        "resolved.undecodable || resolved.aiIgnored.ignored",
      ),
      store,
    ),
  );
  assert.throws(() =>
    pinWiring(view, mutate(store, "if (stale()) return null;", "")),
  );
  assert.throws(() =>
    pinWiring(
      view,
      mutate(store, "split === null || stale()", "split === null"),
    ),
  );
  assert.throws(() =>
    pinWiring(view, mutate(store, "tolerateRepoReadError: true", "")),
  );
});

const RUST = "src-tauri/src/git/conflict.rs";
const OPS = "src-tauri/src/git/ops.rs";
const RUST_TOO_LARGE =
  /^pub\(crate\) const RESOLVE_TOO_LARGE_REFUSAL: &str = "([^"\\]*)";$/m;
const RUST_BINARY =
  /^pub\(crate\) const RESOLVE_BINARY_REFUSAL: &str = "([^"\\]*)";$/m;
const RUST_SENTENCE =
  /AppError::InvalidArgument\(format!\(\s*"[^"{]* \{shown\}([^"{]*)\{why\}([^"{]*)"/;
const OPS_LINKED = /^pub\(crate\) const DISCARD_LINKED: &str = "([^"\\]*)";$/m;

/** Throws unless each refusal twin matches the backend's spelling. */
function pinRefusalStrings(rust, ops) {
  const tooLarge = RUST_TOO_LARGE.exec(rust);
  assert.ok(tooLarge, "conflict.rs must declare RESOLVE_TOO_LARGE_REFUSAL");
  const binary = RUST_BINARY.exec(rust);
  assert.ok(binary, "conflict.rs must declare RESOLVE_BINARY_REFUSAL");
  const sentence = RUST_SENTENCE.exec(rust);
  assert.ok(sentence, "conflict.rs must keep conflict_path_refusal's sentence");
  const linked = OPS_LINKED.exec(ops);
  assert.ok(linked, "ops.rs must declare DISCARD_LINKED");
  assert.equal(TOO_LARGE_REFUSAL, tooLarge[1]);
  assert.equal(BINARY_REFUSAL, binary[1]);
  assert.equal(
    LINKED_ANCESTOR_TAIL,
    `${sentence[1]}${linked[1]}${sentence[2]}`,
  );
  // Both refusals are raised through the constants, never a re-spelled literal.
  assert.match(rust, /InvalidArgument\(RESOLVE_TOO_LARGE_REFUSAL\.into\(\)\)/);
  assert.match(rust, /InvalidArgument\(RESOLVE_BINARY_REFUSAL\.into\(\)\)/);
}

const mutate = (s, from, to) => {
  const out = s.replace(from, to);
  assert.notEqual(out, s, `mutation did not apply: ${from}`);
  return out;
};

test("the refusal twins match the backend's strings", () => {
  const rust = read(RUST);
  const ops = read(OPS);
  pinRefusalStrings(rust, ops);
  assert.throws(() =>
    pinRefusalStrings(
      mutate(rust, "file is too large for AI", "file is too big for AI"),
      ops,
    ),
  );
  assert.throws(() =>
    pinRefusalStrings(
      mutate(rust, "binary file — resolve", "binary file - resolve"),
      ops,
    ),
  );
  assert.throws(() =>
    pinRefusalStrings(rust, mutate(ops, "symbolic link or junction", "link")),
  );
  assert.throws(() =>
    pinRefusalStrings(
      mutate(
        rust,
        "InvalidArgument(RESOLVE_BINARY_REFUSAL.into())",
        'InvalidArgument("binary file — resolve this conflict by hand".into())',
      ),
      ops,
    ),
  );
});

const pathRefusal = (why, linkedLeaf = false) => ({
  summary: `Can't resolve the conflict in a/b — ${why}. Nothing was changed.`,
  linkedLeaf,
});

test("only refusals no retry can heal classify", () => {
  const rows = [
    [TOO_LARGE_REFUSAL, null, "tooLarge"],
    [BINARY_REFUSAL, null, "binary"],
    ["x", pathRefusal("it's a symbolic link", true), "linkedLeaf"],
    [
      "x",
      pathRefusal("it's reached through a symbolic link or junction"),
      "linkedPath",
    ],
    // Other path-gate refusals keep the walk's blocked screen, which names them.
    ["x", pathRefusal('its path starts with "-"'), null],
    // presentError's summary capitalizes; only the lead-stripped message matches.
    ["Binary file — resolve this conflict by hand", null, null],
    ["file is too large", null, null],
    ["", null, null],
  ];
  for (const [detail, refusal, want] of rows)
    assert.equal(sidesRefusal(detail, refusal), want, JSON.stringify(detail));
});

test("partition skips a classified refusal and queues the rest in order", () => {
  const paths = ["big.log", "a.png", "link/x", "bin/tool", "ok.ts", "flaky.ts"];
  const reads = [
    ok({ refused: "tooLarge" }),
    ok({ refused: "binary" }),
    ok({ refused: "linkedPath" }),
    ok({ refused: "linkedLeaf" }),
    ok(verdict()),
    failed,
  ];
  const split = partition(paths, reads);
  assert.deepEqual(split, {
    queued: ["ok.ts", "flaky.ts"],
    skipped: [
      { path: "big.log", reason: "tooLarge" },
      { path: "a.png", reason: "binary" },
      { path: "link/x", reason: "linkedPath" },
      { path: "bin/tool", reason: "linkedLeaf" },
    ],
  });
  assert.equal(
    prefilterToast({ total: 6, ...split }),
    "Resolving 2 of 6 files with AI. Skipped 4 files: 1 is binary, 1 is too large for AI, 1 is a symbolic link, 1 has a path through a link.",
  );
  const rows = [
    [
      { total: 2, queued: ["a"], skipped: [skip("art/logo.psd", "binary")] },
      "Resolving 1 of 2 files with AI. Skipped logo.psd (it's a binary file).",
    ],
    [
      { total: 2, queued: ["a"], skipped: [skip("big.log", "tooLarge")] },
      "Resolving 1 of 2 files with AI. Skipped big.log (it's too large for AI).",
    ],
    [
      { total: 2, queued: ["a"], skipped: [skip("bin/tool", "linkedLeaf")] },
      "Resolving 1 of 2 files with AI. Skipped tool (it's a symbolic link).",
    ],
    [
      {
        total: 3,
        queued: [],
        skipped: [
          skip("a", "linkedLeaf"),
          skip("b", "linkedLeaf"),
          skip("c", "linkedPath"),
        ],
      },
      "Nothing to resolve with AI: 2 files are symbolic links, 1 has a path through a link.",
    ],
    [
      { total: 2, queued: ["a"], skipped: [skip("l/x.ts", "linkedPath")] },
      "Resolving 1 of 2 files with AI. Skipped x.ts (its path goes through a link).",
    ],
    [
      {
        total: 7,
        queued: [],
        skipped: [
          skip("a", "binary"),
          skip("b", "binary"),
          skip("c", "tooLarge"),
          skip("d", "tooLarge"),
          skip("e", "linkedPath"),
          skip("f", "linkedPath"),
          skip("g", "partUndecodable"),
        ],
      },
      "Nothing to resolve with AI: 1 file has a part that isn't UTF-8 text, 2 are binary, 2 are too large for AI, 2 have paths through a link.",
    ],
  ];
  for (const [input, want] of rows)
    assert.equal(prefilterToast(input), want, JSON.stringify(input));
});

test("classification stays narrow: a mutant skipping every path refusal goes red", async () => {
  const narrow = await importMutated(
    ".endsWith(LINKED_ANCESTOR_TAIL)",
    ".length > 0",
  );
  const other = pathRefusal('its path starts with "-"');
  assert.equal(sidesRefusal("x", other), null);
  assert.equal(narrow.sidesRefusal("x", other), "linkedPath");
  // The leaf keeps its own reason, never the ancestor's copy.
  const folded = await importMutated(
    'if (pathRefusal.linkedLeaf) return "linkedLeaf";',
    'if (pathRefusal.linkedLeaf) return "linkedPath";',
  );
  const leaf = pathRefusal("it's a symbolic link", true);
  assert.equal(sidesRefusal("x", leaf), "linkedLeaf");
  assert.equal(folded.sidesRefusal("x", leaf), "linkedPath");
});

test("partition reads a refusal: a mutant ignoring it goes red", async () => {
  const mutated = await importMutated('"refused" in value', "false");
  const reads = [ok({ refused: "binary" })];
  const want = [{ path: "a.png", reason: "binary" }];
  assert.deepEqual(partition(["a.png"], reads).skipped, want);
  // The mutant reads the refusal as a verdict, which has no flags to read.
  assert.throws(() => mutated.partition(["a.png"], reads), TypeError);
});

/** The store's refusal routing, press arms, liveness, hold release, quiet
 *  landing and scoped retire: a refactor could drop any without a type error. */
function pinStore(store) {
  // A rejected read is classified; anything unclassified rethrows and queues.
  assert.match(
    store,
    /conflictSides\(scope, p, exclude\)\.then\([\s\S]{0,400}?\n\s*refusalRead,\n/,
  );
  assert.match(store, /appErrorDetail\(e\.kind, e\.message\)/);
  assert.match(store, /if \(refused === null\) throw e;/);
  // A press keeps an on-screen file of its set and clears anything else.
  assert.match(
    store,
    /const keep =\s*scopePath === scope &&\s*activePath !== null &&\s*paths\.includes\(activePath\);/,
  );
  assert.match(
    store,
    /keep\s*\?\s*\{ prefiltering: scope, queue: \[\] \}\s*:\s*\{\s*prefiltering: scope,\s*activePath: null,\s*queue: \[\],\s*scopePath: null,\s*\}/,
  );
  // A repeat is a no-op only while the run it repeats is live.
  assert.match(store, /prefilterRun\.key === key &&\s*isLive\(prefilterRun\)/);
  assert.match(
    store,
    /const stale = \(\) => prefilterRun !== run \|\| !isLive\(run\);/,
  );
  // A press bumps the ui epoch and claims it; a seeded start does neither (the
  // bump's own pin sits with the claimed-start pins below).
  assert.match(
    store,
    /run\.epoch === walkEpoch &&\s*\(run\.uiEpoch === null \|\|\s*run\.uiEpoch === useUiStore\.getState\(\)\.interactionEpoch\)/,
  );
  // A run that stops being live gives up its hold at once.
  assert.match(
    store,
    /if \(prefilterRun === null \|\| isLive\(prefilterRun\)\) return;\s*prefilterRun = null;\s*useConflictResolve\.setState\(\{ prefiltering: null \}\);/,
  );
  for (const action of ["startOne", "advance", "stop", "retire"]) {
    const body = new RegExp(
      `\\n    ${action}: \\([^)]*\\) => \\{([\\s\\S]*?)\\n    \\},`,
    ).exec(store);
    assert.ok(body, `the store must define ${action}`);
    assert.match(
      body[1],
      /walkEpoch\+\+;\s*releaseDeadRun\(\);/,
      `${action} must release a dead run's hold`,
    );
  }
  assert.match(
    store,
    /if \(s\.interactionEpoch !== prev\.interactionEpoch\) releaseDeadRun\(\);/,
  );
  // The landings (the arm, a self-heal advance) select without bumping; user
  // moves still bump.
  assert.match(store, /selectConflicted\(first, scope, true\);/);
  assert.match(
    store,
    /advance: \(opts\) => \{[\s\S]*?selectConflicted\(next, scopePath, opts\?\.landing === true\);/,
  );
  assert.match(store, /if \(landing\) ui\.advanceSelectedFile\(file\);/);
  // A start claimed at an earlier press drops once a newer interaction moved
  // the epoch, and otherwise lands without a second bump.
  assert.match(
    store,
    /claimed !== undefined &&\s*claimed !== useUiStore\.getState\(\)\.interactionEpoch/,
  );
  assert.match(
    store,
    /startOne: \(path, scope, opts\) => \{\s*const claimed = opts\?\.claimedEpoch;\s*if \(claimMoved\(claimed\)\) return;/,
  );
  assert.match(
    store,
    /selectConflicted\(path, scope, claimed !== undefined\);/,
  );
  assert.match(
    store,
    /const claimed = opts\?\.claimedEpoch;\s*if \(claimMoved\(claimed\)\) return;\s*\/\/ Ahead of the single-file arm/,
  );
  assert.match(
    store,
    /if \(!seeded && claimed === undefined\)\s*useUiStore\.getState\(\)\.noteUserInteraction\(\);\s*const run: PrefilterRun = \{[^}]*uiEpoch: seeded \? null : useUiStore\.getState\(\)\.interactionEpoch,/,
  );
  // Retire acts only for its own tree.
  assert.match(
    store,
    /if \(get\(\)\.scopePath !== scope && prefilterRun\?\.scope !== scope\) return;/,
  );
}

test("the store routes refusals, keeps or clears at the press, releases and retires", () => {
  const store = read("src/lib/stores/conflict-resolve.ts");
  pinStore(store);
  const mutations = [
    [/\n\s*refusalRead,\n/, "\n"],
    ["if (refused === null) throw e;", ""],
    ["appErrorDetail(e.kind, e.message)", "presentError(e).summary"],
    ["paths.includes(activePath)", "true"],
    ["? { prefiltering: scope, queue: [] }", "? { prefiltering: scope }"],
    [/(:\s*\{\s*prefiltering: scope,)\s*activePath: null,/, "$1"],
    [/ &&\s*isLive\(prefilterRun\)/, ""],
    ["prefilterRun !== run || !isLive(run)", "prefilterRun !== run"],
    ["if (!seeded && claimed === undefined)", "if (!seeded)"],
    ["if (!seeded && claimed === undefined)", "if (claimed === undefined)"],
    [
      /(startOne: \(path, scope, opts\) => \{\s*const claimed = opts\?\.claimedEpoch;)\s*if \(claimMoved\(claimed\)\) return;/,
      "$1",
    ],
    [
      /(const seeded = opts\?\.seeded === true;\s*const claimed = opts\?\.claimedEpoch;)\s*if \(claimMoved\(claimed\)\) return;/,
      "$1",
    ],
    [
      "selectConflicted(path, scope, claimed !== undefined);",
      "selectConflicted(path, scope);",
    ],
    [
      /claimed !== undefined &&\s*claimed !== useUiStore/,
      "claimed !== useUiStore",
    ],
    ["uiEpoch: seeded ? null : ", "uiEpoch: "],
    ["run.uiEpoch === null ||", "false ||"],
    [/(stop: \(\) => \{\s*walkEpoch\+\+;)\s*releaseDeadRun\(\);/, "$1"],
    [
      /(retire: \(scope\) => \{[\s\S]*?walkEpoch\+\+;)\s*releaseDeadRun\(\);/,
      "$1",
    ],
    ["if (s.interactionEpoch !== prev.interactionEpoch) releaseDeadRun();", ""],
    [
      "selectConflicted(first, scope, true);",
      "selectConflicted(first, scope);",
    ],
    ["if (landing) ui.advanceSelectedFile(file);", ""],
    [
      "selectConflicted(next, scopePath, opts?.landing === true);",
      "selectConflicted(next, scopePath);",
    ],
    ["&& prefilterRun?.scope !== scope) return;", ") return;"],
  ];
  for (const [from, to] of mutations) {
    const out = mutate(store, from, to);
    assert.throws(() => pinStore(out), undefined, `survived: ${from}`);
  }
});

const HOSTS = {
  view: "src/features/repository/ConflictResolveView.tsx",
  heal: "src/features/repository/use-walk-self-heal.ts",
  diff: "src/features/diff/DiffViewer.tsx",
  local: "src/features/pulls/ResolveConflictsView.tsx",
  remote: "src/features/pulls/ResolveRemotePrView.tsx",
  banner: "src/features/repository/ConflictBanner.tsx",
  pr: "src/features/pulls/RemotePrView.tsx",
};

/** The accept's generation check and read-time hold, the self-heal in every
 *  walk host (held while its tree reads, landing quietly), the takeovers' hold
 *  and retires, the banner's and the PR view's retires, and the seeded start. */
function pinHosts(src) {
  assert.match(src.view, /const walkGen = walkGeneration\(\);/);
  assert.match(
    src.view,
    /const owns =\s*walk\.scopePath === repoPath &&\s*walk\.activePath === path &&\s*walkGeneration\(\) === walkGen;/,
  );
  // An accept on a file a Resolve all kept on screen leaves the walk to the arm.
  assert.match(
    src.view,
    /const advances = owns && walk\.prefiltering !== repoPath;/,
  );
  assert.match(src.view, /advances && walk\.queue\.length > 0/);
  assert.match(src.view, /if \(advances\) walk\.advance\(\);/);
  assert.match(
    src.heal,
    /conflicted !== null &&\s*!conflicted\.includes\(activePath\)/,
  );
  assert.match(
    src.heal,
    /const reading = useConflictResolve\(\(s\) => s\.prefiltering === scope\);/,
  );
  assert.match(src.heal, /if \(!gone \|\| reading\) return;/);
  assert.match(src.heal, /\}, \[gone, reading, scope, activePath\]\);/);
  assert.match(
    src.heal,
    /if \(\s*walk\.scopePath === scope &&\s*walk\.activePath === activePath &&\s*walk\.prefiltering !== scope\s*\) \{\s*walk\.advance\(\{ landing: true \}\);/,
  );
  assert.match(
    src.diff,
    /useWalkSelfHeal\(\s*repoPath,\s*status\.data && !status\.isPlaceholderData/,
  );
  for (const host of ["local", "remote"]) {
    const s = src[host];
    assert.match(
      s,
      /useWalkSelfHeal\(\s*worktreePath,\s*status\.data && !status\.isPlaceholderData \? conflictedPaths : null,/,
      `${host} must self-heal its walk`,
    );
    assert.match(s, /\(s\) => s\.prefiltering === worktreePath/);
    assert.match(
      s,
      /reason=\{prefilterHold \? PREFILTER_READ_REASON : undefined\}/,
    );
    // Hidden, so the button keeps its name and nests no live region.
    assert.match(
      s,
      /\{prefilterHold \? \(\s*<Spinner aria-hidden data-icon="inline-start" \/>/,
    );
    assert.equal(
      s.match(/retireWalk\(/g)?.length,
      2,
      `${host} must retire its walk on abort and on finish`,
    );
  }
  assert.match(
    src.banner,
    /async function doAbort\(target: RepoOp\) \{[^}]*retireWalk\(repoPath\);/,
  );
  assert.match(
    src.remote,
    /startAll\(aiPaths, worktreePath, \{ seeded: true \}\);/,
  );
  // A seeded run ends with its takeover: a confirmed discard retires it before
  // the abort's await, and a PR switch retires the tree it left.
  assert.match(
    src.pr,
    /ask\(DISCARD_RESOLVE_CONFIRM\)\)\) return;\s*(?:\/\/[^\n]*\n\s*)*useConflictResolve\.getState\(\)\.retire\(target\.worktreePath\);\s*try \{/,
  );
  assert.match(
    src.pr,
    /if \(resolve\) setLeftResolve\(resolve\.worktreePath\);\s*setResolve\(null\);/,
  );
  assert.match(
    src.pr,
    /if \(leftResolve === null\) return;\s*useConflictResolve\.getState\(\)\.retire\(leftResolve\);\s*setLeftResolve\(null\);\s*\}, \[leftResolve\]\);/,
  );
}

test("the walk hosts check the generation, self-heal, hold and retire", () => {
  const src = Object.fromEntries(
    Object.entries(HOSTS).map(([k, file]) => [k, read(file)]),
  );
  pinHosts(src);
  const mutations = [
    ["view", " &&\n        walkGeneration() === walkGen;", ";"],
    ["heal", "conflicted !== null &&", ""],
    ["heal", "walk.activePath === activePath &&", "true &&"],
    ["diff", "status.data && !status.isPlaceholderData", "status.data"],
    ["local", "status.data && !status.isPlaceholderData ? ", "true ? "],
    [
      "remote",
      "s.prefiltering === worktreePath",
      "s.prefiltering === repoPath",
    ],
    ["local", "reason={prefilterHold ? PREFILTER_READ_REASON : undefined}", ""],
    ["remote", /\n\s*retireWalk\(worktreePath\);\n/, "\n"],
    ["banner", "    retireWalk(repoPath);\n", ""],
    ["remote", ", { seeded: true }", ""],
    ["view", "owns && walk.prefiltering !== repoPath", "owns"],
    ["view", "if (advances) walk.advance();", "if (owns) walk.advance();"],
    ["heal", "if (!gone || reading) return;", "if (!gone) return;"],
    ["heal", "[gone, reading, scope, activePath]", "[gone, scope, activePath]"],
    ["heal", "walk.advance({ landing: true });", "walk.advance();"],
    ["local", "<Spinner aria-hidden ", "<Spinner "],
    ["remote", "<Spinner aria-hidden ", "<Spinner "],
    [
      "pr",
      /\n\s*useConflictResolve\.getState\(\)\.retire\(target\.worktreePath\);\n/,
      "\n",
    ],
    ["pr", "if (resolve) setLeftResolve(resolve.worktreePath);", ""],
    ["pr", ".retire(leftResolve);", ".stop();"],
  ];
  for (const [key, from, to] of mutations) {
    const out = { ...src, [key]: mutate(src[key], from, to) };
    assert.throws(() => pinHosts(out), undefined, `survived: ${key} ${from}`);
  }
});
