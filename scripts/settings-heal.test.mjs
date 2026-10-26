// Pins src/lib/settings/heal.ts `healLoadedSettings`, the one transform both the
// settings load and the post-write cache seed run: a seed must be
// stableStringify-equal to what a re-read of the same committed object returns,
// the heal must be idempotent, and
// each heal branch must keep healing its input.
//
// heal.ts is runtime-import-free of ./api and @/lib/theme, so this suite needs no
// install and runs in the no-install guards job, which is what fails an import
// chain reaching node_modules or `window`. The src hooks resolve its `@/`
// imports, so every src import below is dynamic.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { DEFAULT_SETTINGS, healLoadedSettings } = await import(
  "@/lib/settings/heal"
);
const { stableStringify } = await import("@/features/settings/save-reset");

const HEAL_SOURCE = new URL("../src/lib/settings/heal.ts", import.meta.url);

/** What a re-read of `committed` returns: the store keeps JSON, then loads heal it
 *  (an absent key reads back as `undefined`). */
const reread = (heal, committed) =>
  heal(
    committed === undefined ? undefined : JSON.parse(JSON.stringify(committed)),
  );

function assertSeedEqualsReread(heal, committed) {
  assert.equal(
    stableStringify(heal(committed)),
    stableStringify(reread(heal, committed)),
  );
}

function assertIdempotent(heal, saved) {
  const once = heal(saved);
  assert.equal(stableStringify(heal(once)), stableStringify(once));
}

const full = healLoadedSettings(undefined);

// Committed objects as the writers build them: a form draft or a `trimmed ||
// undefined` alias leaves undefined-valued keys that JSON storage drops.
const UNDEFINED_TOP = {
  ...full,
  defaultBranch: undefined,
  defaultAgent: undefined,
  theme: undefined,
  globalInstructions: undefined,
  bitbucketTokenExpiresAt: undefined,
  securityReviewAi: undefined,
};
const UNDEFINED_IN_AI = {
  ...full,
  ai: { ...full.ai, model: undefined, ollamaBaseUrl: undefined },
  reviewAi: { ...full.reviewAi, openaiCompatibleBaseUrl: undefined },
  securityReviewAi: { provider: "openai", model: undefined },
};
const UNDEFINED_ALIAS = {
  ...full,
  recentRepos: [
    {
      path: "C:/repos/a",
      name: "a",
      lastOpenedAt: "2026-10-01T00:00:00.000Z",
      alias: undefined,
    },
  ],
};

const LEGACY_NOTIFICATIONS = {
  prChecks: "off",
  prActivity: false,
  prReviews: true,
  actionRuns: false,
  reviews: true,
  automations: false,
};
const NEW_NOTIFICATIONS = {
  sources: {
    prChecks: { inApp: "yes", os: false },
    reviews: { inApp: false },
  },
  prChecksScope: "mine",
  outcomes: { prChecks: "failures", actionRuns: "bogus" },
  automationKinds: "failures",
};
const MCP_ARRAY = [
  {
    id: "srv-a",
    name: "a",
    transport: "carrier-pigeon",
    repoOverrides: { r1: "on", r2: "sometimes", r3: "off" },
  },
  42,
  ["nested"],
];

const FIXTURES = {
  undefinedTop: UNDEFINED_TOP,
  undefinedInAi: UNDEFINED_IN_AI,
  undefinedAlias: UNDEFINED_ALIAS,
  absentFields: { theme: "dark" },
  legacyNotifications: { notifications: LEGACY_NOTIFICATIONS },
  newNotifications: { notifications: NEW_NOTIFICATIONS },
  offList: { theme: "neon", defaultAgent: "gemini", agentIsolation: "vm" },
  securityPresent: { securityReviewAi: { provider: "openai" } },
  mcpServers: { mcpServers: MCP_ARRAY },
  mcpJunkContainer: { mcpServers: { not: "an array" } },
  empty: undefined,
};

/** heal.ts with `replacements` applied, each needle hitting exactly once, loaded
 *  from a copy under a `/src/lib/settings/` path so the hooks treat it as src. */
const mutantDirs = [];
after(() => {
  for (const dir of mutantDirs) rmSync(dir, { recursive: true, force: true });
});
async function mutantHeal(replacements) {
  let text = readFileSync(HEAL_SOURCE, "utf8").replace(/\r\n/g, "\n");
  for (const [needle, replacement] of replacements) {
    const count = text.split(needle).length - 1;
    assert.equal(count, 1, `expected exactly one "${needle}", found ${count}`);
    text = text.split(needle).join(replacement);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "gd-settings-heal-mutant-"));
  mutantDirs.push(dir);
  // Pins the copy's module format whatever package.json sits above the temp dir.
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }');
  const settingsDir = path.join(dir, "src", "lib", "settings");
  mkdirSync(settingsDir, { recursive: true });
  const file = path.join(settingsDir, "heal.ts");
  writeFileSync(file, text);
  return (await import(pathToFileURL(file).href)).healLoadedSettings;
}

test("a seed equals the re-read of its committed object", () => {
  for (const [name, committed] of Object.entries(FIXTURES)) {
    assert.doesNotThrow(
      () => assertSeedEqualsReread(healLoadedSettings, committed),
      name,
    );
  }
});

test("seed-equals-re-read fails against a heal without the undefined strip", async () => {
  // NEGATIVE CONTROL: `defaultBranch: undefined` shadows the default a re-read
  // applies once nothing drops it, and so does `model: undefined` inside `ai`.
  const heal = await mutantHeal([
    [
      "  if (value === null || value === undefined) return value;\n",
      "  return value;\n",
    ],
  ]);
  assert.throws(
    () => assertSeedEqualsReread(heal, UNDEFINED_TOP),
    assert.AssertionError,
  );
  assert.throws(
    () => assertSeedEqualsReread(heal, UNDEFINED_IN_AI),
    assert.AssertionError,
  );
});

test("the heal is idempotent", () => {
  for (const [name, saved] of Object.entries(FIXTURES)) {
    assert.doesNotThrow(
      () => assertIdempotent(healLoadedSettings, saved),
      name,
    );
  }
  // NEGATIVE CONTROL: a heal that moves a field on every pass fails the check.
  const drifting = (saved) => {
    const healed = healLoadedSettings(saved);
    return { ...healed, lastSeenVersion: `${healed.lastSeenVersion}x` };
  };
  assert.throws(
    () => assertIdempotent(drifting, FIXTURES.absentFields),
    assert.AssertionError,
  );
});

// Each heal branch as a check over a heal function, so the same check runs against
// the real heal and, in the controls below, against heal.ts with that branch broken.
const BRANCH_CHECKS = {
  "absent fields read as their defaults": (heal) => {
    const healed = heal({ theme: "dark" });
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === "theme") continue;
      assert.deepEqual(healed[key], DEFAULT_SETTINGS[key], key);
    }
    assert.equal(healed.theme, "dark");
    assert.equal(
      stableStringify(heal(null)),
      stableStringify(DEFAULT_SETTINGS),
    );
  },
  "legacy notifications heal onto the channel shape": (heal) => {
    const { notifications } = heal({ notifications: LEGACY_NOTIFICATIONS });
    const off = { inApp: false, os: false };
    const on = { inApp: true, os: true };
    assert.deepEqual(notifications.sources, {
      prChecks: off,
      prActivity: off,
      prCreate: on,
      prReviews: on,
      actionRuns: off,
      reviews: on,
      automations: off,
      agents: on,
    });
    assert.equal(notifications.prChecksScope, "all");
    assert.equal("prActivity" in notifications, false);
  },
  "new-shape notifications heal per channel and per axis": (heal) => {
    const { notifications } = heal({ notifications: NEW_NOTIFICATIONS });
    assert.deepEqual(notifications.sources.prChecks, {
      inApp: true,
      os: false,
    });
    assert.deepEqual(notifications.sources.reviews, {
      inApp: false,
      os: true,
    });
    assert.deepEqual(notifications.sources.agents, { inApp: true, os: true });
    assert.equal(notifications.prChecksScope, "mine");
    assert.deepEqual(notifications.outcomes, {
      prChecks: "failures",
      actionRuns: "all",
    });
    assert.equal(notifications.automationKinds, "failures");
  },
  "off-list enums heal to their defaults, an off-list agent to absent": (
    heal,
  ) => {
    const healed = heal(FIXTURES.offList);
    assert.equal(healed.theme, "system");
    assert.equal(healed.agentIsolation, "worktree");
    assert.equal("defaultAgent" in healed, false);
    const valid = heal({ theme: "slate", defaultAgent: "codex" });
    assert.equal(valid.theme, "slate");
    assert.equal(valid.defaultAgent, "codex");
  },
  "an off-list AI provider re-pairs provider and model": (heal) => {
    const healed = heal({
      ai: { provider: "skynet", model: "t-800", ollamaBaseUrl: "http://lan:1" },
    });
    assert.equal(healed.ai.provider, DEFAULT_SETTINGS.ai.provider);
    assert.equal(healed.ai.model, DEFAULT_SETTINGS.ai.model);
    assert.equal(healed.ai.ollamaBaseUrl, "http://lan:1");
  },
  "securityReviewAi stays absent when absent and merges when present": (
    heal,
  ) => {
    assert.equal("securityReviewAi" in heal({}), false);
    const present = heal(FIXTURES.securityPresent);
    assert.deepEqual(present.securityReviewAi, {
      ...DEFAULT_SETTINGS.reviewAi,
      provider: "openai",
    });
    const offList = heal({
      securityReviewAi: { provider: "skynet", model: "t-800" },
    });
    assert.equal(offList.securityReviewAi.provider, "anthropic");
    assert.equal(
      offList.securityReviewAi.model,
      DEFAULT_SETTINGS.reviewAi.model,
    );
  },
  "MCP servers heal per field and junk passes through": (heal) => {
    const healed = heal(FIXTURES.mcpServers);
    assert.equal(healed.mcpServers[0].transport, "stdio");
    assert.deepEqual(healed.mcpServers[0].repoOverrides, {
      r1: "on",
      r3: "off",
    });
    assert.equal(healed.mcpServers[1], 42);
    assert.equal(healed.mcpServers[2], MCP_ARRAY[2]);
    // A corrupt container is passed through, never substituted with [].
    const container = { not: "an array" };
    assert.equal(heal({ mcpServers: container }).mcpServers, container);
    assert.equal(heal({ mcpServers: "junk" }).mcpServers, "junk");
    assert.deepEqual(heal({ mcpServers: null }).mcpServers, []);
  },
};

for (const [name, check] of Object.entries(BRANCH_CHECKS)) {
  test(name, () => check(healLoadedSettings));
}

// NEGATIVE CONTROLS: each branch check against heal.ts with that branch broken.
const BRANCH_MUTANTS = {
  // The stored object as-is: every default but theme stays absent.
  "absent fields read as their defaults": [
    ["    ...DEFAULT_SETTINGS,\n    ...stored,\n", "    ...stored,\n"],
  ],
  // A nested spread keeps the legacy primitives and no `sources` map.
  "legacy notifications heal onto the channel shape": [
    [
      "    notifications: healNotifications(stored?.notifications),",
      "    notifications: { ...DEFAULT_SETTINGS.notifications, ...stored?.notifications },",
    ],
  ],
  // Copying a stored channel value keeps `inApp: "yes"`.
  "new-shape notifications heal per channel and per axis": [
    ['typeof pair.inApp === "boolean"', "pair.inApp !== undefined"],
  ],
  // Without healEnumerated every junk string survives.
  "off-list enums heal to their defaults, an off-list agent to absent": [
    ["  return healEnumerated({", "  return ({"],
  ],
  // Healing the provider alone keeps the foreign model.
  "an off-list AI provider re-pairs provider and model": [
    [
      ": { ...stored, provider: fallback.provider, model: fallback.model };",
      ": { ...stored, provider: fallback.provider };",
    ],
  ],
  // An unconditional merge mints securityReviewAi for every install.
  "securityReviewAi stays absent when absent and merges when present": [
    ["    ...(stored?.securityReviewAi\n", "    ...(true\n"],
  ],
  // An unhealed registry keeps the off-list transport and the junk override.
  "MCP servers heal per field and junk passes through": [
    [
      "      ? settings.mcpServers.map(healMcpServer)",
      "      ? settings.mcpServers",
    ],
  ],
};

test("each heal branch check fails against heal.ts with that branch broken", async () => {
  assert.deepEqual(
    Object.keys(BRANCH_MUTANTS).sort(),
    Object.keys(BRANCH_CHECKS).sort(),
  );
  for (const [name, replacements] of Object.entries(BRANCH_MUTANTS)) {
    const heal = await mutantHeal(replacements);
    assert.throws(() => BRANCH_CHECKS[name](heal), assert.AssertionError, name);
  }
});

/** Each import/export statement in `src` naming ./api or @/lib/theme, with the
 *  ones that are not an `import type { … }` declaration. Statements start at a
 *  line start, so comment lines never count. */
function themeAndApiImports(src) {
  const named = [];
  const runtime = [];
  for (const m of src.matchAll(/^(?:import|export)\b[^;]*;/gm)) {
    const spec = m[0].match(/["'](\.\/api|@\/lib\/theme)["']/);
    if (!spec) continue;
    named.push(spec[1]);
    if (!/^import\s+type\s*\{/.test(m[0])) runtime.push(m[0]);
  }
  for (const m of src.matchAll(
    /\bimport\s*\(\s*["'](\.\/api|@\/lib\/theme)["']/g,
  )) {
    runtime.push(m[0]);
  }
  return { named, runtime };
}

test("heal.ts names ./api and @/lib/theme only through import type declarations", () => {
  const src = readFileSync(HEAL_SOURCE, "utf8");
  const { named, runtime } = themeAndApiImports(src);
  assert.deepEqual(named.sort(), ["./api", "@/lib/theme"]);
  assert.deepEqual(runtime, []);

  // NEGATIVE CONTROLS: an inline `type` specifier keeps a real import under
  // Node's type stripping, and so does a plain one.
  for (const [from, to] of [
    ["import type {\n  AppSettings,", "import {\n  type AppSettings,"],
    [
      'import type { ThemeSetting } from "@/lib/theme";',
      'import { type ThemeSetting } from "@/lib/theme";',
    ],
    [
      'import type { ThemeSetting } from "@/lib/theme";',
      'import { THEME_ORDER } from "@/lib/theme";',
    ],
  ]) {
    const normalized = src.replace(/\r\n/g, "\n");
    assert.equal(normalized.split(from).length - 1, 1, `needle ${from}`);
    const mutated = normalized.split(from).join(to);
    assert.equal(themeAndApiImports(mutated).runtime.length, 1, to);
  }
});
