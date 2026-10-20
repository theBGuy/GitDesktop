// Pins the MCP secret staging contract: typed secret values wait in a Save
// buffer, a Save writes only pairs the committed registry references, deletes
// come from a baseline-intersected diff that can't destroy another window's or
// a corrupt registry's credentials, and the post-flush settle never resurrects
// an entry the user replaced, pruned or discarded mid-flight.
//
// Imported through the shared src hooks; `secret-ops.ts` is runtime-import-free,
// so this suite also runs in the no-install `guards` job.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const {
  createCallQueue,
  entryPlanFromRows,
  isSafeMcpSecretKey,
  MAX_WINDOWS_SECRET_UTF16,
  mcpSecretDeletes,
  mcpSetFailureHeadings,
  pruneStagedServer,
  secretValueFits,
  secretWriteProblem,
  settleStaged,
  stagedSetFlushPlan,
  stageMcpSecretSets,
} = await import("@/features/settings/mcp/secret-ops");

/** A registry row with only the fields the helpers read made distinctive. */
function server(id, secretKeys = [], extra = {}) {
  return {
    id,
    name: id,
    description: "",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: [],
    env: [],
    url: "",
    headers: [],
    secretKeys,
    ...extra,
  };
}

const staged = (serverId, key, value = "test-value-1") => ({
  serverId,
  key,
  value,
});

const sortPairs = (pairs) =>
  [...pairs].sort((a, b) =>
    `${a.serverId}/${a.key}`.localeCompare(`${b.serverId}/${b.key}`),
  );

// ------------------------------------------------------------ mcpSecretDeletes

// Three servers: one with two secret keys, one repo-scoped, one plain.
const A = server("srv-a", ["API_KEY", "TOKEN"]);
const B = server("srv-b", ["SECRET"], { scope: "C:/Repos/Thing/.git" });
const C = server("srv-c");
const REGISTRY = [A, B, C];

test("mcpSecretDeletes: a removed server emits every string key it had", () => {
  assert.deepEqual(
    sortPairs(
      mcpSecretDeletes({
        baseline: REGISTRY,
        saved: REGISTRY,
        committed: [B, C],
      }),
    ),
    [
      { serverId: "srv-a", key: "API_KEY" },
      { serverId: "srv-a", key: "TOKEN" },
    ],
  );
});

test("mcpSecretDeletes: shrunk secretKeys and renames emit only the dropped keys", () => {
  assert.deepEqual(
    mcpSecretDeletes({
      baseline: REGISTRY,
      saved: REGISTRY,
      committed: [server("srv-a", ["API_KEY"]), B, C],
    }),
    [{ serverId: "srv-a", key: "TOKEN" }],
  );
  // Rename TOKEN -> TOKEN2: only the old key goes.
  assert.deepEqual(
    mcpSecretDeletes({
      baseline: REGISTRY,
      saved: REGISTRY,
      committed: [server("srv-a", ["API_KEY", "TOKEN2"]), B, C],
    }),
    [{ serverId: "srv-a", key: "TOKEN" }],
  );
});

test("mcpSecretDeletes: unchanged and added-only registries emit nothing", () => {
  assert.deepEqual(
    mcpSecretDeletes({
      baseline: REGISTRY,
      saved: REGISTRY,
      committed: REGISTRY,
    }),
    [],
  );
  assert.deepEqual(
    mcpSecretDeletes({
      baseline: REGISTRY,
      saved: REGISTRY,
      committed: [...REGISTRY, server("srv-d", ["NEW_KEY"])],
    }),
    [],
  );
});

test("mcpSecretDeletes: the named fields can't be swapped silently", () => {
  // Documented shape {baseline, saved, committed}: a committed server with
  // secrets that baseline and saved never had is an ADD, never a delete.
  assert.deepEqual(
    mcpSecretDeletes({ baseline: [], saved: [], committed: [A] }),
    [],
  );
  // Its failing direction: the same server present before and gone after.
  assert.equal(
    mcpSecretDeletes({ baseline: [A], saved: [A], committed: [] }).length,
    2,
  );
});

test("mcpSecretDeletes: a server another window added (saved, not baseline) is never deleted", () => {
  const other = server("srv-other", ["OTHER_KEY"]);
  assert.deepEqual(
    mcpSecretDeletes({
      baseline: REGISTRY,
      saved: [...REGISTRY, other],
      committed: REGISTRY,
    }),
    [],
  );
  // A press-time baseline without the server keeps it safe; a baseline
  // rewritten to include it (a mid-flight Discard's refetch) would delete it,
  // which is why the Save diffs the press-time capture.
  assert.deepEqual(
    mcpSecretDeletes({
      baseline: [...REGISTRY, other],
      saved: [...REGISTRY, other],
      committed: REGISTRY,
    }),
    [{ serverId: "srv-other", key: "OTHER_KEY" }],
  );
});

test("mcpSecretDeletes: any non-array container yields nothing (no mass delete)", () => {
  for (const junk of [null, undefined, {}, "servers", 7, { 0: A }]) {
    assert.deepEqual(
      mcpSecretDeletes({ baseline: junk, saved: REGISTRY, committed: [] }),
      [],
      `baseline ${JSON.stringify(junk)}`,
    );
    assert.deepEqual(
      mcpSecretDeletes({ baseline: REGISTRY, saved: junk, committed: [] }),
      [],
      `saved ${JSON.stringify(junk)}`,
    );
    assert.deepEqual(
      mcpSecretDeletes({
        baseline: REGISTRY,
        saved: REGISTRY,
        committed: junk,
      }),
      [],
      `committed ${JSON.stringify(junk)}`,
    );
  }
});

test("mcpSecretDeletes: junk rows and non-string keys are skipped, duplicates deduped", () => {
  const before = [
    "a string row",
    null,
    ["an", "array"],
    { id: 42, secretKeys: ["NUMERIC_ID_KEY"] },
    { id: "", secretKeys: ["EMPTY_ID_KEY"] },
    { id: "srv-x", secretKeys: ["GOOD", 5, null, { k: 1 }] },
    { id: "srv-x", secretKeys: ["GOOD"] },
    { id: "srv-y", secretKeys: "not-an-array" },
  ];
  assert.deepEqual(
    mcpSecretDeletes({ baseline: before, saved: before, committed: [] }),
    [{ serverId: "srv-x", key: "GOOD" }],
  );
});

test("mcpSecretDeletes: remove + re-add under a fresh id emits the old id's keys", () => {
  const readded = server("srv-a2", ["API_KEY", "TOKEN"], { name: "srv-a" });
  assert.deepEqual(
    sortPairs(
      mcpSecretDeletes({
        baseline: REGISTRY,
        saved: REGISTRY,
        committed: [readded, B, C],
      }),
    ),
    [
      { serverId: "srv-a", key: "API_KEY" },
      { serverId: "srv-a", key: "TOKEN" },
    ],
  );
});

// ---------------------------------------------------------- stageMcpSecretSets

test("stageMcpSecretSets: an upsert replaces every entry for its pair", () => {
  const old1 = staged("srv-a", "API_KEY", "test-value-1");
  const old2 = staged("srv-a", "API_KEY", "test-value-2");
  const other = staged("srv-b", "SECRET");
  const next = stageMcpSecretSets({
    staged: [old1, other, old2],
    serverId: "srv-a",
    writes: [{ key: "API_KEY", value: "test-value-3" }],
    liveSecretKeys: ["API_KEY", "TOKEN"],
  });
  assert.deepEqual(next, [other, staged("srv-a", "API_KEY", "test-value-3")]);
  assert.ok(!next.includes(old1) && !next.includes(old2));
});

test("stageMcpSecretSets: a key no longer live is pruned for that server only", () => {
  const renamedAway = staged("srv-a", "TOKEN");
  const otherServer = staged("srv-b", "TOKEN");
  const next = stageMcpSecretSets({
    staged: [renamedAway, otherServer],
    serverId: "srv-a",
    writes: [],
    liveSecretKeys: ["TOKEN2"],
  });
  assert.deepEqual(next, [otherServer]);
  // The failing direction: while the key is still live, it stays.
  assert.deepEqual(
    stageMcpSecretSets({
      staged: [renamedAway],
      serverId: "srv-a",
      writes: [],
      liveSecretKeys: ["TOKEN"],
    }),
    [renamedAway],
  );
});

test("stageMcpSecretSets: non-string liveSecretKeys elements are ignored", () => {
  const entry = staged("srv-a", "5");
  assert.deepEqual(
    stageMcpSecretSets({
      staged: [entry],
      serverId: "srv-a",
      writes: [],
      liveSecretKeys: [5, null, undefined, { key: "5" }],
    }),
    [],
  );
});

test("stageMcpSecretSets: untouched entries pass through by reference, same server included", () => {
  const sameServer = staged("srv-a", "API_KEY");
  const otherServer = staged("srv-b", "SECRET");
  const next = stageMcpSecretSets({
    staged: [sameServer, otherServer],
    serverId: "srv-a",
    writes: [{ key: "TOKEN", value: "test-value-2" }],
    liveSecretKeys: ["API_KEY", "TOKEN"],
  });
  assert.equal(next[0], sameServer);
  assert.equal(next[1], otherServer);
  assert.equal(next.length, 3);
});

// ----------------------------------------------------------- pruneStagedServer

test("pruneStagedServer: drops that server's entries, keeps the rest by reference", () => {
  const a1 = staged("srv-a", "API_KEY");
  const a2 = staged("srv-a", "TOKEN");
  const b1 = staged("srv-b", "SECRET");
  const next = pruneStagedServer([a1, b1, a2], "srv-a");
  assert.equal(next.length, 1);
  assert.equal(next[0], b1);
});

// ---------------------------------------------------------- stagedSetFlushPlan

test("stagedSetFlushPlan: committed-referenced pairs flush, others drop", () => {
  const ref = staged("srv-a", "API_KEY");
  const removedServer = staged("srv-gone", "API_KEY");
  const renamedKey = staged("srv-a", "OLD_KEY");
  const plan = stagedSetFlushPlan({
    staged: [ref, removedServer, renamedKey],
    committed: REGISTRY,
  });
  assert.deepEqual(plan, { flush: [ref], retain: [] });
  assert.equal(plan.flush[0], ref);
});

test("stagedSetFlushPlan: a non-array committed registry flushes nothing and retains all", () => {
  const entries = [staged("srv-a", "API_KEY"), staged("srv-b", "SECRET")];
  for (const junk of [null, undefined, {}, "x", 3]) {
    const plan = stagedSetFlushPlan({ staged: entries, committed: junk });
    assert.deepEqual(plan.flush, [], `committed ${JSON.stringify(junk)}`);
    assert.equal(plan.retain.length, 2);
    assert.ok(plan.retain.every((e, i) => e === entries[i]));
  }
});

test("stagedSetFlushPlan: any duplicate-id row referencing the key counts; junk rows skipped", () => {
  const entry = staged("srv-a", "TOKEN");
  const committed = [
    null,
    "junk",
    ["srv-a"],
    { id: 42, secretKeys: ["TOKEN"] },
    server("srv-a", ["API_KEY"]),
    server("srv-a", ["TOKEN", 7]),
  ];
  assert.deepEqual(stagedSetFlushPlan({ staged: [entry], committed }).flush, [
    entry,
  ]);
  // A numeric id never matches its string twin.
  assert.deepEqual(
    stagedSetFlushPlan({
      staged: [staged("42", "TOKEN")],
      committed: [{ id: 42, secretKeys: ["TOKEN"] }],
    }).flush,
    [],
  );
});

test("stagedSetFlushPlan: the named fields can't be swapped silently", () => {
  // Transposed: the registry passed as `staged`, the buffer as `committed`.
  const plan = stagedSetFlushPlan({
    staged: REGISTRY,
    committed: [staged("srv-a", "API_KEY")],
  });
  assert.deepEqual(plan.flush, []);
});

test("stagedSetFlushPlan: dedupe is last-wins and returns the input objects", () => {
  const first = staged("srv-a", "API_KEY", "test-value-1");
  const later = staged("srv-a", "API_KEY", "test-value-2");
  const other = staged("srv-b", "SECRET");
  const input = [first, other, later];
  const plan = stagedSetFlushPlan({ staged: input, committed: REGISTRY });
  assert.equal(plan.flush.length, 2);
  assert.ok(plan.flush.every((e) => input.includes(e)));
  assert.ok(plan.retain.every((e) => input.includes(e)));
  assert.ok(plan.flush.includes(later), "the later entry wins");
  assert.ok(!plan.flush.includes(first), "the earlier twin is dropped");
});

// ---------------------------------------------------------------- settleStaged

test("settleStaged: a flushed entry leaves, a failed entry in keep stays", () => {
  const ok = staged("srv-a", "API_KEY");
  const bad = staged("srv-b", "SECRET");
  assert.deepEqual(
    settleStaged({ current: [ok, bad], pressed: [ok, bad], keep: [bad] }),
    [bad],
  );
});

test("settleStaged: a mid-flight upsert keeps only the new entry", () => {
  const oldFailed = staged("srv-a", "API_KEY", "test-value-1");
  const fresh = staged("srv-a", "API_KEY", "test-value-2");
  const result = settleStaged({
    current: [fresh],
    pressed: [oldFailed],
    keep: [oldFailed],
  });
  assert.deepEqual(result, [fresh]);
  assert.equal(result[0], fresh);
});

test("settleStaged: a mid-flight prune or discard is never undone", () => {
  const failedA = staged("srv-a", "API_KEY");
  const b = staged("srv-b", "SECRET");
  // The server was removed during the flush: its failed entries stay gone.
  assert.deepEqual(
    settleStaged({ current: [b], pressed: [failedA, b], keep: [failedA, b] }),
    [b],
  );
  // The buffer was discarded during the flush.
  assert.deepEqual(
    settleStaged({ current: [], pressed: [failedA, b], keep: [failedA, b] }),
    [],
  );
});

test("settleStaged: entries staged mid-flight survive; nothing absent from current is added", () => {
  const pressed = staged("srv-a", "API_KEY");
  const newcomer = staged("srv-c", "NEW_KEY");
  const result = settleStaged({
    current: [pressed, newcomer],
    pressed: [pressed],
    keep: [],
  });
  assert.deepEqual(result, [newcomer]);
  assert.equal(result[0], newcomer);
  // The failing direction: a kept entry missing from current is NOT re-added.
  const ghost = staged("srv-z", "GHOST");
  assert.ok(
    !settleStaged({ current: [], pressed: [ghost], keep: [ghost] }).includes(
      ghost,
    ),
  );
});

test("settleStaged: plan -> failed subset -> settle keeps exactly the failed entries", () => {
  const buffer = [
    staged("srv-a", "API_KEY", "test-value-1"),
    staged("srv-a", "TOKEN", "test-value-2"),
    staged("srv-b", "SECRET", "test-value-3"),
    staged("srv-gone", "KEY", "test-value-4"),
  ];
  const plan = stagedSetFlushPlan({ staged: buffer, committed: REGISTRY });
  assert.equal(plan.flush.length, 3);
  // flushMcpSecretSets returns each failure's `entry` as the INPUT object
  // itself, beside the error the keychain raised; the Save keeps those entries.
  const failures = [{ entry: plan.flush[1], error: new Error("test failure") }];
  const failed = failures.map((f) => f.entry);
  const result = settleStaged({
    current: buffer,
    pressed: buffer,
    keep: [...failed, ...plan.retain],
  });
  assert.deepEqual(result, failed);
  assert.equal(result[0], plan.flush[1]);
  // A copy anywhere in the chain loses the failed entry.
  const copied = failed.map((e) => ({ ...e }));
  assert.deepEqual(
    settleStaged({ current: buffer, pressed: buffer, keep: copied }),
    [],
  );
});

// ----------------------------------------------------------- entryPlanFromRows

test("entryPlanFromRows: a typed secret value never reaches entries or secretKeys", () => {
  const sentinel = "test-value-sentinel";
  const plan = entryPlanFromRows([
    {
      key: " API_KEY ",
      value: "",
      secret: true,
      secretInput: `  ${sentinel} `,
    },
    { key: "PLAIN", value: "plain-value", secret: false, secretInput: "" },
    { key: "KEEP_SAVED", value: "", secret: true, secretInput: "   " },
  ]);
  assert.ok(!JSON.stringify(plan.entries).includes(sentinel));
  assert.ok(!JSON.stringify(plan.secretKeys).includes(sentinel));
  assert.deepEqual(plan.entries, [
    { key: "API_KEY", value: "" },
    { key: "PLAIN", value: "plain-value" },
    { key: "KEEP_SAVED", value: "" },
  ]);
  assert.deepEqual(plan.secretKeys, ["API_KEY", "KEEP_SAVED"]);
  // Trimmed key, untrimmed value; a blank input writes nothing.
  assert.deepEqual(plan.secretWrites, [
    { key: "API_KEY", value: `  ${sentinel} ` },
  ]);
});

test("entryPlanFromRows: a non-secret row with a stray secretInput writes nothing", () => {
  const plan = entryPlanFromRows([
    { key: "K", value: "v", secret: false, secretInput: "test-value-1" },
  ]);
  assert.deepEqual(plan.secretWrites, []);
  assert.deepEqual(plan.entries, [{ key: "K", value: "v" }]);
});

// ------------------------------------------------------------- no-mutation pin

test("stagedSetFlushPlan and stageMcpSecretSets never mutate their inputs", () => {
  const committed = [
    server("srv-a", ["API_KEY", "TOKEN"]),
    { id: "srv-b", secretKeys: ["SECRET", 3] },
    null,
  ];
  const buffer = [staged("srv-a", "API_KEY"), staged("srv-a", "API_KEY")];
  const live = ["API_KEY", 9];
  const writes = [{ key: "TOKEN", value: "test-value-2" }];
  const before = JSON.stringify({ committed, buffer, live, writes });
  stagedSetFlushPlan({ staged: buffer, committed });
  stageMcpSecretSets({
    staged: buffer,
    serverId: "srv-a",
    writes,
    liveSecretKeys: live,
  });
  assert.equal(JSON.stringify({ committed, buffer, live, writes }), before);
});

// ---------------------------------------------------------- isSafeMcpSecretKey

test("isSafeMcpSecretKey mirrors secrets.rs safe_token and is total", () => {
  for (const ok of ["API_KEY", "a.b-c_d", "0"])
    assert.equal(isSafeMcpSecretKey(ok), true, `should accept ${ok}`);
  for (const bad of [
    "",
    "my key",
    "k$",
    "k/x",
    "café",
    "tab\tkey",
    "line\nkey",
    123,
    null,
    undefined,
  ])
    assert.equal(
      isSafeMcpSecretKey(bad),
      false,
      `should refuse ${JSON.stringify(bad)}`,
    );
});

// ------------------------------------------------------------- secretValueFits

test("secretValueFits caps values at 1280 UTF-16 units on Windows only", () => {
  assert.equal(MAX_WINDOWS_SECRET_UTF16, 1280);
  const atCap = "a".repeat(1280);
  const overCap = "a".repeat(1281);
  assert.equal(secretValueFits(atCap, true), true);
  assert.equal(secretValueFits(overCap, true), false);
  // macOS and Linux keychains store long values.
  assert.equal(secretValueFits(overCap, false), true);
  assert.equal(secretValueFits("a".repeat(100000), false), true);
});

test("secretValueFits counts an astral character as two UTF-16 units", () => {
  const astral = String.fromCodePoint(0x1f600);
  assert.equal(astral.length, 2);
  assert.equal(secretValueFits(astral.repeat(640), true), true);
  assert.equal(secretValueFits(astral.repeat(641), true), false);
  assert.equal(secretValueFits(astral.repeat(641), false), true);
});

// ------------------------------------------------------------- createCallQueue

/** A promise with its settle functions exposed. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("createCallQueue holds a call until the one before it settles", async () => {
  const inOrder = createCallQueue();
  const log = [];
  const slow = deferred();
  const first = inOrder(() => {
    log.push("first start");
    return slow.promise.then(() => log.push("first done"));
  });
  const second = inOrder(async () => {
    log.push("second start");
  });
  // Let every pending microtask run: the second call must still be waiting.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ["first start"]);
  slow.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(log, ["first start", "first done", "second start"]);
});

test("createCallQueue continues the chain past a rejection", async () => {
  const inOrder = createCallQueue();
  const failing = inOrder(() => Promise.reject(new Error("test failure")));
  const next = inOrder(async () => "test-value-1");
  await assert.rejects(failing, /test failure/);
  assert.equal(await next, "test-value-1");
});

test("createCallQueue turns a sync throw into that call's rejection", async () => {
  const inOrder = createCallQueue();
  const throwing = inOrder(() => {
    throw new Error("thrown synchronously");
  });
  assert.ok(throwing instanceof Promise);
  const next = inOrder(async () => "test-value-2");
  await assert.rejects(throwing, /thrown synchronously/);
  assert.equal(await next, "test-value-2");
});

test("createCallQueue passes each call's value through", async () => {
  const inOrder = createCallQueue();
  const values = await Promise.all([
    inOrder(async () => 1),
    inOrder(async () => "two"),
    inOrder(async () => ({ three: 3 })),
  ]);
  assert.deepEqual(values, [1, "two", { three: 3 }]);
});

test("createCallQueue queues are independent of each other", async () => {
  const a = createCallQueue();
  const b = createCallQueue();
  const held = deferred();
  void a(() => held.promise);
  // b's call runs at once, though a's first call never settles.
  assert.equal(await b(async () => "test-value-3"), "test-value-3");
  held.resolve();
});

// ---------------------------------------------------------- secretWriteProblem

test("secretWriteProblem returns null for storable writes", () => {
  assert.equal(
    secretWriteProblem([{ key: "API_KEY", value: "test-value-1" }], true),
    null,
  );
  assert.equal(secretWriteProblem([], true), null);
});

test("secretWriteProblem flags an unsafe name first", () => {
  assert.deepEqual(
    secretWriteProblem(
      [
        { key: "OK_KEY", value: "a".repeat(2000) },
        { key: "MY KEY", value: 5 },
      ],
      true,
    ),
    { key: "MY KEY", kind: "name" },
  );
});

test("secretWriteProblem flags a non-string value before an over-long one", () => {
  assert.deepEqual(
    secretWriteProblem(
      [
        { key: "LONG_SECRET", value: "a".repeat(1281) },
        { key: "API_TOKEN", value: 12345 },
      ],
      true,
    ),
    { key: "API_TOKEN", kind: "value" },
  );
  for (const value of [null, undefined, true, {}, ["x"]])
    assert.equal(
      secretWriteProblem([{ key: "K", value }], false)?.kind,
      "value",
      JSON.stringify(value),
    );
});

test("secretWriteProblem flags an over-long value on Windows only", () => {
  const writes = [
    { key: "SHORT", value: "a".repeat(MAX_WINDOWS_SECRET_UTF16) },
    { key: "LONG_SECRET", value: "a".repeat(MAX_WINDOWS_SECRET_UTF16 + 1) },
  ];
  assert.deepEqual(secretWriteProblem(writes, true), {
    key: "LONG_SECRET",
    kind: "length",
  });
  assert.equal(secretWriteProblem(writes, false), null);
});

test("secretWriteProblem names the FIRST failing write of a kind", () => {
  assert.deepEqual(
    secretWriteProblem(
      [
        { key: "A B", value: "x" },
        { key: "C D", value: "y" },
      ],
      false,
    ),
    { key: "A B", kind: "name" },
  );
});

// ------------------------------------------------------- mcpSetFailureHeadings

const failure = (serverId, key) => ({
  entry: staged(serverId, key),
  error: new Error("test failure"),
});

test("mcpSetFailureHeadings names the server, so a shared key reads apart", () => {
  const committed = [
    server("srv-a", ["API_KEY"], { name: "github" }),
    server("srv-b", ["API_KEY"], { name: "linear" }),
  ];
  const headings = mcpSetFailureHeadings({
    failures: [failure("srv-a", "API_KEY"), failure("srv-b", "API_KEY")],
    committed,
  });
  assert.deepEqual(headings, [
    'Secret "API_KEY" on "github"',
    'Secret "API_KEY" on "linear"',
  ]);
  assert.notEqual(headings[0], headings[1]);
});

test("mcpSetFailureHeadings falls back to the server id without a usable name", () => {
  const committed = [
    server("srv-a", ["K"], { name: "" }),
    server("srv-b", ["K"], { name: "   " }),
    { id: "srv-c", secretKeys: ["K"], name: 42 },
    { id: "srv-d", secretKeys: ["K"] },
    null,
    "junk",
  ];
  assert.deepEqual(
    mcpSetFailureHeadings({
      failures: ["srv-a", "srv-b", "srv-c", "srv-d", "srv-gone"].map((id) =>
        failure(id, "K"),
      ),
      committed,
    }),
    [
      'Secret "K" on "srv-a"',
      'Secret "K" on "srv-b"',
      'Secret "K" on "srv-c"',
      'Secret "K" on "srv-d"',
      'Secret "K" on "srv-gone"',
    ],
  );
  for (const junk of [null, undefined, {}, "servers"])
    assert.deepEqual(
      mcpSetFailureHeadings({
        failures: [failure("srv-a", "K")],
        committed: junk,
      }),
      ['Secret "K" on "srv-a"'],
    );
});

test("mcpSetFailureHeadings keeps the failures' order, one heading each", () => {
  const committed = [server("srv-a", ["A", "B"], { name: "one" })];
  assert.deepEqual(
    mcpSetFailureHeadings({
      failures: [failure("srv-a", "B"), failure("srv-a", "A")],
      committed,
    }),
    ['Secret "B" on "one"', 'Secret "A" on "one"'],
  );
  assert.deepEqual(mcpSetFailureHeadings({ failures: [], committed }), []);
});
