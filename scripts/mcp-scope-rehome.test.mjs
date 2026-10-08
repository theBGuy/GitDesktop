// Pins how a relocated repo's MCP per-repo keys re-home: every stored form of
// the old location (`<oldPath>` and `<oldPath>/.git`, any case or slash style)
// moves to exactly the new identity key on every server, a value already under
// the new key wins, and anything merely sharing a prefix with the old path is
// left alone. Losing one of these resets a repo's per-repo MCP states to inherit
// with nothing on screen.
//
// Imported through the shared src hooks (dynamic, so they are registered before
// the module links) to resolve its `@/` imports. `settings/mcp.ts`'s runtime
// graph imports no package (plugin-store is type-only, and `invoke` goes
// through the import-free transport registry), so this suite also runs in the
// no-install `guards` job and any import failure there is a real breakage.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { rehomeServerRepoKeys } = await import("@/lib/settings/mcp");

const OLD_PATH = "C:/Repos/Old";
const NEW_KEY = "C:/Repos/New/.git";

/** A stdio server with only the fields the re-home reads made distinctive. */
function server(id, extra = {}) {
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
    secretKeys: [],
    ...extra,
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Runs the re-home over a frozen input and asserts the input is unchanged. */
function rehome(servers, oldPath = OLD_PATH, newKey = NEW_KEY) {
  const before = structuredClone(servers);
  deepFreeze(servers);
  const result = rehomeServerRepoKeys(servers, oldPath, newKey);
  assert.deepEqual(servers, before, "input must not be mutated");
  return result;
}

const byId = (servers, id) => servers.find((s) => s.id === id);

test("re-homes every old-form scope and override key across servers", () => {
  const untouched = server("plain", { scope: "global" });
  const input = [
    server("raw-override", {
      scope: "global",
      repoOverrides: { "C:/Repos/Old": "off", "C:/Other/.git": "on" },
    }),
    server("mixed-case-git-override", {
      repoOverrides: { "c:/REPOS/old/.GIT": "optional" },
    }),
    server("raw-scope", { scope: "C:\\Repos\\Old\\" }),
    server("git-scope", { scope: "C:/Repos/Old/.git" }),
    server("keep-new", {
      scope: "global",
      repoOverrides: {
        [NEW_KEY]: "on",
        "C:/Repos/Old/.git": "off",
        "c:/repos/old": "optional",
      },
    }),
    untouched,
  ];
  const { servers, changed } = rehome(input);
  assert.equal(changed, true);
  assert.notEqual(servers, input);

  assert.deepEqual(byId(servers, "raw-override").repoOverrides, {
    "C:/Other/.git": "on",
    [NEW_KEY]: "off",
  });
  assert.deepEqual(byId(servers, "mixed-case-git-override").repoOverrides, {
    [NEW_KEY]: "optional",
  });
  assert.equal(byId(servers, "raw-scope").scope, NEW_KEY);
  assert.equal(byId(servers, "git-scope").scope, NEW_KEY);
  // Keep-new: the existing new-key value wins and every old variant goes.
  assert.deepEqual(byId(servers, "keep-new").repoOverrides, {
    [NEW_KEY]: "on",
  });
  // A server with no per-repo data comes through as the same object.
  assert.equal(byId(servers, "plain"), untouched);

  // No old-form key survives anywhere.
  const oldForms = new Set(["c:/repos/old", "c:/repos/old/.git"]);
  const fold = (k) => k.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const s of servers) {
    if (s.scope) assert.ok(!oldForms.has(fold(s.scope)), `${s.id} scope`);
    for (const k of Object.keys(s.repoOverrides ?? {}))
      assert.ok(!oldForms.has(fold(k)), `${s.id} override ${k}`);
  }
});

test("both old forms, no new key: one entry, identity form's value wins", () => {
  const { servers } = rehome([
    server("both", {
      repoOverrides: { "C:/Repos/Old": "on", "C:/REPOS/OLD/.git": "off" },
    }),
  ]);
  assert.deepEqual(servers[0].repoOverrides, { [NEW_KEY]: "off" });
});

test("a case variant of the new key is left alone, not taken as present", () => {
  // pickForRepo reads the exact key, so the variant can't stand in for NEW_KEY:
  // keep-new on it would drop the user's "off" and the server would come back on.
  const { servers } = rehome([
    server("variant", {
      repoOverrides: { "c:/repos/new/.git": "optional", "C:/Repos/Old": "off" },
    }),
  ]);
  assert.deepEqual(servers[0].repoOverrides, {
    "c:/repos/new/.git": "optional",
    [NEW_KEY]: "off",
  });
});

test("an own __proto__ key survives the rebuild", () => {
  const overrides = JSON.parse('{"__proto__": "on", "C:/Repos/Old": "off"}');
  const { servers } = rehome([server("proto", { repoOverrides: overrides })]);
  const rebuilt = servers[0].repoOverrides;
  assert.equal(
    Object.getOwnPropertyDescriptor(rebuilt, "__proto__")?.value,
    "on",
  );
  assert.equal(rebuilt[NEW_KEY], "off");
});

test("a key that only prefixes the old path never matches", () => {
  const input = [
    server("prefix", {
      scope: `${OLD_PATH}2/.git`,
      repoOverrides: {
        [`${OLD_PATH}2/.git`]: "off",
        [`${OLD_PATH}2`]: "on",
        [`${OLD_PATH}/sub`]: "optional",
      },
    }),
  ];
  const result = rehome(input);
  assert.equal(result.changed, false);
  assert.equal(result.servers, input);
});

test("an all-unchanged input returns changed:false and the original array", () => {
  const input = [
    server("global-plain", { scope: "global" }),
    server("unset-scope"),
    server("elsewhere", {
      scope: "D:/Elsewhere/.git",
      repoOverrides: { "D:/Elsewhere/.git": "off" },
    }),
  ];
  const result = rehome(input);
  assert.equal(result.changed, false);
  assert.equal(result.servers, input);
});

test("an empty servers array is a no-op", () => {
  const input = [];
  const result = rehome(input);
  assert.equal(result.changed, false);
  assert.equal(result.servers, input);
});

test("junk shapes pass through untouched instead of throwing", () => {
  const corrupt = { not: "an array" };
  const container = rehomeServerRepoKeys(corrupt, OLD_PATH, NEW_KEY);
  assert.equal(container.changed, false);
  assert.equal(container.servers, corrupt);

  const junkScope = server("junk-scope", { scope: 42 });
  const junkOverrides = server("junk-overrides", {
    repoOverrides: ["C:/Repos/Old"],
  });
  const real = server("real", { scope: "C:/Repos/Old/.git" });
  const input = [null, "x", ["C:/Repos/Old"], junkScope, junkOverrides, real];
  const { servers, changed } = rehome(input);
  assert.equal(changed, true);
  assert.deepEqual(servers.slice(0, 3), [null, "x", ["C:/Repos/Old"]]);
  assert.equal(servers[3], junkScope);
  assert.equal(servers[4], junkOverrides);
  assert.equal(servers[5].scope, NEW_KEY);
});

test("a global scope is never rewritten, even when the old path is 'global'", () => {
  const input = [server("g", { scope: "global" })];
  const result = rehome(input, "global");
  assert.equal(result.changed, false);
  assert.equal(result.servers[0].scope, "global");
});
