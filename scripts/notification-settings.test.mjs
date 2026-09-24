// Pins how stored notification settings heal onto the `prCreate` source and how
// a repo override delivers it. Settings written by a build that predates a
// source have no key for it, so the heal must fill that key (and each missing
// channel of a half-stored cell) from the defaults while leaving every stored
// sibling alone; an override inherits whatever it does not name, and a mute
// wins over all of it.
//
// `settings/api.ts` value-imports through the `@/` alias and its graph reads
// `import.meta.env` at load, neither of which plain type stripping provides, so
// the src-import hooks go in first and every src import below is DYNAMIC (a
// static one would link before the hooks exist). The graph also pulls react
// and @tauri-apps/plugin-store: the CI `guards` job runs `node --test` with no
// install step, where both are unresolvable. Unresolved deps skip every test
// here, and frontend.yml's installed step is the enforced run.
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

// The api graph touches these at load; nothing here renders.
globalThis.window ??= globalThis;
globalThis.localStorage ??= {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.matchMedia ??= () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});

let deps = null;
try {
  deps = {
    ...(await import("@/lib/settings/api")),
    ...(await import("@/lib/notifications/overrides.ts")),
  };
} catch (e) {
  // The rethrow is what keeps the skip honest: without it, a real import
  // breakage in the INSTALLED run would silently skip every test here instead of
  // failing. That run sets GD_EXPECT_DEPS; the no-install job does not.
  if (process.env.GD_EXPECT_DEPS) throw e;
}
const {
  DEFAULT_SETTINGS,
  NOTIFICATION_SOURCES,
  deliveredChannels,
  healNotifications,
  isOutcomeSource,
} = deps ?? {};

const NEEDS_DEPS =
  "needs node_modules — frontend.yml's installed step is the enforced run";

const API_SOURCE = new URL("../src/lib/settings/api.ts", import.meta.url);
const KIND = "pr-create-failed";
const BOTH_ON = { inApp: true, os: true };
const BOTH_OFF = { inApp: false, os: false };

// Settings persisted by a build that predates the source: new shape, no
// prCreate key, and non-default values on other sources so a whole-default
// fallback can't pass.
const old = {
  sources: {
    prChecks: { inApp: false, os: false },
    prActivity: { inApp: true, os: false },
    prReviews: { inApp: true, os: true },
    actionRuns: { inApp: true, os: true },
    reviews: { inApp: false, os: true },
    automations: { inApp: true, os: true },
    agents: { inApp: true, os: true },
  },
  prChecksScope: "mine",
  outcomes: { prChecks: "failures", actionRuns: "all" },
  automationKinds: "all",
};

const withPrCreate = (cell) => ({
  ...old,
  sources: { ...old.sources, prCreate: cell },
});

/** The missing-key heal, shared by the real module and the mutant control. */
function assertFillsMissingPrCreate(heal) {
  const healed = heal(old);
  assert.deepEqual(healed.sources.prCreate, BOTH_ON);
  // Stored siblings survive untouched.
  assert.deepEqual(healed.sources.prChecks, { inApp: false, os: false });
  assert.deepEqual(healed.sources.reviews, { inApp: false, os: true });
  assert.equal(healed.prChecksScope, "mine");
}

test("manifest order places prCreate after prActivity", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const i = NOTIFICATION_SOURCES.indexOf("prCreate");
  assert.ok(i > 0, "prCreate is in the manifest");
  assert.equal(NOTIFICATION_SOURCES[i - 1], "prActivity");
});

test("prCreate carries no outcome axis", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  assert.equal(isOutcomeSource("prCreate"), false);
});

test("defaults: both channels on", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  assert.deepEqual(DEFAULT_SETTINGS.notifications.sources.prCreate, BOTH_ON);
});

test("heal fills missing prCreate from defaults", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  assertFillsMissingPrCreate(healNotifications);
});

test("heal keeps a stored prCreate", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const healed = healNotifications(withPrCreate({ inApp: false, os: false }));
  assert.deepEqual(healed.sources.prCreate, BOTH_OFF);
});

test("heal fills a half-stored prCreate cell per channel", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const healed = healNotifications(withPrCreate({ os: false }));
  assert.deepEqual(healed.sources.prCreate, { inApp: true, os: false });
});

test("legacy-shape settings default prCreate on", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const healed = healNotifications({
    prChecks: "off",
    prActivity: false,
    reviews: true,
  });
  assert.deepEqual(healed.sources.prCreate, BOTH_ON);
});

test("junk settings default prCreate on", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  assert.deepEqual(healNotifications(null).sources.prCreate, BOTH_ON);
});

test("override without the key inherits the global", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const global = healNotifications(old);
  const override = { sources: { prChecks: { os: false } } };
  assert.deepEqual(
    deliveredChannels(global, override, "prCreate", undefined, KIND),
    BOTH_ON,
  );
});

test("override with only os off", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const global = healNotifications(old);
  const override = { sources: { prCreate: { os: false } } };
  assert.deepEqual(
    deliveredChannels(global, override, "prCreate", undefined, KIND),
    { inApp: true, os: false },
  );
});

test("muted repo delivers nothing", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const global = healNotifications(old);
  assert.deepEqual(
    deliveredChannels(global, { muted: true }, "prCreate", undefined, KIND),
    BOTH_OFF,
  );
});

test("global both-off delivers nothing", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const off = healNotifications(withPrCreate({ inApp: false, os: false }));
  assert.deepEqual(
    deliveredChannels(off, undefined, "prCreate", undefined, KIND),
    BOTH_OFF,
  );
});

// NEGATIVE CONTROL for "heal fills missing prCreate from defaults": the real
// api.ts with the heal's two default-fill arms removed must fail that check.
// The copy sits under a `/src/lib/settings/` path so the hooks treat it as a
// src module (env shim, `@/` imports onto the real tree).
let mutantDir = null;
after(() => {
  if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
});

test("the missing-key heal check fails against a heal without default fill", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  let text = readFileSync(API_SOURCE, "utf8");
  for (const needle of [
    ": defaults.sources[source].inApp,",
    ": defaults.sources[source].os,",
  ]) {
    // Exactly one hit, or the mutation no longer targets the heal and the
    // control would pass for the wrong reason.
    const count = text.split(needle).length - 1;
    assert.equal(count, 1, `expected exactly one "${needle}", found ${count}`);
    text = text.split(needle).join(": (undefined as unknown as boolean),");
  }
  mutantDir = mkdtempSync(path.join(tmpdir(), "gd-heal-mutant-"));
  // Pins the copy's module format; otherwise Node takes it from whatever
  // package.json happens to sit above the temp dir.
  writeFileSync(path.join(mutantDir, "package.json"), '{ "type": "module" }');
  const settingsDir = path.join(mutantDir, "src", "lib", "settings");
  mkdirSync(settingsDir, { recursive: true });
  const mutantFile = path.join(settingsDir, "api.ts");
  writeFileSync(mutantFile, text);

  const mutant = await import(pathToFileURL(mutantFile).href);
  assert.throws(
    () => assertFillsMissingPrCreate(mutant.healNotifications),
    assert.AssertionError,
  );
});
