// Pins the GUI zoom's pure layer (src/lib/zoom/steps.ts), the settings heal's
// zoom field, and the source facts the controller rests on: native webview zoom
// stays off, the window and webview permissions it calls are granted, and the
// three zoom actions and the Ctrl/Cmd+scroll cheat-sheet row exist with their
// pinned shape. Runs in the no-install guards job, so every src import is dynamic
// and reaches only install-less modules (steps.ts imports nothing; heal.ts's
// chain stays inside @/lib/ai leaves).
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

const {
  ZOOM_STEPS,
  ZOOM_DEFAULT,
  ZOOM_MIN,
  ZOOM_HARD_MAX,
  healZoom,
  nextZoomStep,
  maxZoomForArea,
  minWindowSizeFor,
  formatZoom,
} = await import("@/lib/zoom/steps");
const { healLoadedSettings } = await import("@/lib/settings/heal");

const HEAL_SOURCE = new URL("../src/lib/settings/heal.ts", import.meta.url);
const TAURI_CONF = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const CAPABILITIES = new URL(
  "../src-tauri/capabilities/default.json",
  import.meta.url,
);
const REGISTRY = new URL("../src/lib/hotkeys/registry.ts", import.meta.url);

const read = (url) => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

test("healZoom: junk heals to the default, values snap to the nearest step", () => {
  for (const junk of [
    "150%",
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    true,
    false,
    -1,
    0,
    {},
  ]) {
    assert.equal(healZoom(junk), ZOOM_DEFAULT, String(junk));
  }
  assert.equal(healZoom(1.3), 1.25);
  assert.equal(healZoom(0.5), 0.8);
  assert.equal(healZoom(5), 2);
  // Ties round down.
  assert.equal(healZoom(0.85), 0.8);
  assert.equal(healZoom(1.05), 1);
  for (const step of ZOOM_STEPS) assert.equal(healZoom(step), step);
  // NEGATIVE CONTROL: a non-positive number is junk, never the nearest step.
  assert.notEqual(healZoom(-1), ZOOM_MIN);
});

test("nextZoomStep moves one step within [ZOOM_MIN, max]", () => {
  assert.equal(nextZoomStep(1, 1, ZOOM_HARD_MAX), 1.1);
  assert.equal(nextZoomStep(1, -1, ZOOM_HARD_MAX), 0.9);
  assert.equal(nextZoomStep(1.75, 1, ZOOM_HARD_MAX), 2);
  // Both boundaries hold.
  assert.equal(nextZoomStep(2, 1, ZOOM_HARD_MAX), 2);
  assert.equal(nextZoomStep(0.8, -1, ZOOM_HARD_MAX), 0.8);
  // A monitor-bounded max limits the step and clamps a level above it.
  assert.equal(nextZoomStep(1.25, 1, 1.25), 1.25);
  assert.equal(nextZoomStep(1.5, 1, 1.25), 1.25);
  assert.equal(nextZoomStep(1.1, 1, 1.25), 1.25);
  // Off-step input snaps first.
  assert.equal(nextZoomStep(1.3, 1, ZOOM_HARD_MAX), 1.5);
  assert.equal(nextZoomStep(1.3, -1, ZOOM_HARD_MAX), 1.1);
  // NEGATIVE CONTROL: a step never skips a level.
  assert.notEqual(nextZoomStep(1, 1, ZOOM_HARD_MAX), 1.25);
});

test("maxZoomForArea: the largest step whose floor fits, never below 100%", () => {
  assert.equal(maxZoomForArea(5000, 5000), 2);
  assert.equal(maxZoomForArea(1136, 1000), 2);
  assert.equal(maxZoomForArea(640, 600), 1.1);
  assert.equal(maxZoomForArea(900, 700), 1.25);
  assert.equal(maxZoomForArea(100, 100), ZOOM_DEFAULT);
  // NEGATIVE CONTROL: one pixel short of the 200% floor drops a step.
  assert.notEqual(maxZoomForArea(1135, 1000), 2);
});

test("minWindowSizeFor scales the floor, never below the configured minimum", () => {
  assert.deepEqual(minWindowSizeFor(1), { width: 640, height: 600 });
  assert.deepEqual(minWindowSizeFor(0.8), { width: 640, height: 600 });
  assert.deepEqual(minWindowSizeFor(1.1), { width: 640, height: 600 });
  assert.deepEqual(minWindowSizeFor(1.25), { width: 710, height: 625 });
  assert.deepEqual(minWindowSizeFor(2), { width: 1136, height: 1000 });
  assert.notDeepEqual(minWindowSizeFor(1.25), minWindowSizeFor(1));
});

test("formatZoom renders a whole percentage", () => {
  assert.equal(formatZoom(1.25), "125%");
  assert.equal(formatZoom(0.8), "80%");
  assert.equal(formatZoom(1.1), "110%");
});

/** Seed == re-read and idempotency, as scripts/settings-heal.test.mjs pins them. */
function assertHealStable(heal, committed) {
  const seed = heal(committed);
  const reread = heal(JSON.parse(JSON.stringify(committed)));
  assert.equal(JSON.stringify(seed), JSON.stringify(reread));
  assert.equal(JSON.stringify(heal(seed)), JSON.stringify(seed));
}

test("the settings heal heals the zoom field", () => {
  assert.equal(healLoadedSettings({ zoom: "150%" }).zoom, 1);
  assert.equal(healLoadedSettings({ zoom: Number.NaN }).zoom, 1);
  assert.equal(healLoadedSettings({ zoom: 1.5 }).zoom, 1.5);
  assert.equal(healLoadedSettings({ zoom: 1.3 }).zoom, 1.25);
  assert.equal(healLoadedSettings({}).zoom, 1);
  assert.equal(healLoadedSettings(undefined).zoom, 1);
  assertHealStable(healLoadedSettings, { zoom: 1.75 });
  assertHealStable(healLoadedSettings, { zoom: "junk" });
});

const mutantDirs = [];
after(() => {
  for (const dir of mutantDirs) rmSync(dir, { recursive: true, force: true });
});

test("a heal without the zoom healer fails the junk-zoom check", async () => {
  const needle = "    zoom: healZoom(settings.zoom),\n";
  const text = read(HEAL_SOURCE);
  assert.equal(text.split(needle).length - 1, 1, "healer line present once");
  const dir = mkdtempSync(path.join(tmpdir(), "gd-zoom-heal-mutant-"));
  mutantDirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }');
  const settingsDir = path.join(dir, "src", "lib", "settings");
  mkdirSync(settingsDir, { recursive: true });
  const file = path.join(settingsDir, "heal.ts");
  writeFileSync(file, text.split(needle).join(""));
  const mutant = (await import(pathToFileURL(file).href)).healLoadedSettings;
  assert.notEqual(mutant({ zoom: "150%" }).zoom, 1);
});

// --- Source guards. Each returns its failures and FAILS on input it cannot read.

function nativeZoomFailures(text) {
  let conf;
  try {
    conf = JSON.parse(text);
  } catch (e) {
    return [`tauri.conf.json does not parse: ${e.message}`];
  }
  const windows = conf?.app?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    return ["tauri.conf.json has no app.windows[0]"];
  }
  return windows[0].zoomHotkeysEnabled === true
    ? [
        "app.windows[0].zoomHotkeysEnabled is true: native zoom would double-zoom",
      ]
    : [];
}

const REQUIRED_PERMISSIONS = [
  "core:webview:allow-set-webview-zoom",
  "core:window:allow-set-min-size",
  "core:window:allow-set-size",
];

function permissionFailures(text) {
  let caps;
  try {
    caps = JSON.parse(text);
  } catch (e) {
    return [`capabilities/default.json does not parse: ${e.message}`];
  }
  if (!Array.isArray(caps?.permissions)) {
    return ["capabilities/default.json has no permissions array"];
  }
  return REQUIRED_PERMISSIONS.filter((p) => !caps.permissions.includes(p)).map(
    (p) => `missing permission ${p}`,
  );
}

const ENTRY_RE =
  /\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*defaultBinding:\s*(null|"[^"]*"),?\s*\}/g;

/** The ACTIONS rows, or null when the block can't be read whole. */
function actionRows(text) {
  const start = text.indexOf("export const ACTIONS = [");
  const end = text.indexOf("] as const satisfies readonly ActionDef[];");
  if (start < 0 || end < start) return null;
  // Whole-line comments sit between some rows' fields; drop them before parsing.
  const block = text.slice(start, end).replace(/^[ \t]*\/\/.*\n/gm, "");
  const rows = [...block.matchAll(ENTRY_RE)].map((m) => ({
    id: m[1],
    label: m[2],
    category: m[3],
    defaultBinding: m[4] === "null" ? null : m[4].slice(1, -1),
  }));
  const ids = block.match(/\bid:\s*"/g)?.length ?? 0;
  // A row this regex can't read must fail the guard, never shrink the corpus.
  return rows.length === 0 || rows.length !== ids ? null : rows;
}

const ZOOM_ROWS = [
  { id: "app-zoom-in", label: "Zoom in", defaultBinding: "mod+=" },
  { id: "app-zoom-out", label: "Zoom out", defaultBinding: "mod+-" },
  { id: "app-zoom-reset", label: "Reset zoom", defaultBinding: "mod+0" },
];
const RESERVED_BINDINGS = ["mod+=", "mod+-", "mod+0", "mod++", "mod+shift++"];

function registryFailures(text) {
  const rows = actionRows(text);
  if (rows === null) return ["registry.ts ACTIONS block is unreadable"];
  const failures = [];
  for (const want of ZOOM_ROWS) {
    const row = rows.find((r) => r.id === want.id);
    if (!row) {
      failures.push(`missing action ${want.id}`);
      continue;
    }
    if (row.label !== want.label) failures.push(`${want.id} label`);
    if (row.category !== "Application") failures.push(`${want.id} category`);
    if (row.defaultBinding !== want.defaultBinding) {
      failures.push(`${want.id} defaultBinding`);
    }
  }
  const zoomIds = new Set(ZOOM_ROWS.map((r) => r.id));
  for (const row of rows) {
    if (zoomIds.has(row.id)) continue;
    if (row.id.startsWith("app-zoom")) failures.push(`stray ${row.id}`);
    if (RESERVED_BINDINGS.includes(row.defaultBinding)) {
      failures.push(
        `${row.id} defaults to the zoom binding ${row.defaultBinding}`,
      );
    }
    if (ZOOM_ROWS.some((z) => z.label === row.label)) {
      failures.push(`${row.id} reuses a zoom label`);
    }
  }
  return failures;
}

function builtInFailures(text) {
  const start = text.indexOf("export const BUILT_IN_KEYS");
  if (start < 0) return ["registry.ts has no BUILT_IN_KEYS"];
  const block = text.slice(start);
  const row =
    /\{\s*keys:\s*"Ctrl\+scroll",\s*what:\s*"Zoom the app in or out",\s*binding:\s*"mod\+scroll",?\s*\}/;
  return row.test(block) ? [] : ["BUILT_IN_KEYS lacks the Ctrl/Cmd+scroll row"];
}

test("native webview zoom stays off", () => {
  assert.deepEqual(nativeZoomFailures(read(TAURI_CONF)), []);
  const conf = JSON.parse(read(TAURI_CONF));
  conf.app.windows[0].zoomHotkeysEnabled = true;
  assert.equal(nativeZoomFailures(JSON.stringify(conf)).length, 1);
  assert.equal(nativeZoomFailures("{ not json").length, 1);
  assert.equal(nativeZoomFailures("{}").length, 1);
});

test("the capability grants the zoom and window-size permissions", () => {
  const text = read(CAPABILITIES);
  assert.deepEqual(permissionFailures(text), []);
  for (const p of REQUIRED_PERMISSIONS) {
    const caps = JSON.parse(text);
    caps.permissions = caps.permissions.filter((x) => x !== p);
    assert.equal(permissionFailures(JSON.stringify(caps)).length, 1, p);
  }
  assert.equal(permissionFailures("[").length, 1);
  assert.equal(permissionFailures('{"permissions": "x"}').length, 1);
});

test("the registry carries the three zoom actions and no colliding default", () => {
  const text = read(REGISTRY);
  assert.deepEqual(registryFailures(text), []);
  // NEGATIVE CONTROLS: a renamed binding, a colliding default, an unreadable row.
  const mutate = (from, to) => {
    assert.equal(text.split(from).length - 1, 1, from);
    return text.split(from).join(to);
  };
  assert.ok(
    registryFailures(
      mutate('defaultBinding: "mod+0"', 'defaultBinding: "mod+9"'),
    ).length > 0,
  );
  assert.ok(
    registryFailures(
      mutate(
        'id: "roadmap-zoom-in",\n    label: "Zoom roadmap in",\n    category: "Repository",\n    defaultBinding: null,',
        'id: "roadmap-zoom-in",\n    label: "Zoom roadmap in",\n    category: "Repository",\n    defaultBinding: "mod++",',
      ),
    ).length > 0,
  );
  assert.ok(
    registryFailures(
      mutate('id: "app-zoom-in",', 'id: "app-zoom-in", extra: 1,'),
    ).length > 0,
  );
  assert.equal(registryFailures("").length, 1);
});

test("the cheat sheet lists the Ctrl/Cmd+scroll zoom gesture", () => {
  const text = read(REGISTRY);
  assert.deepEqual(builtInFailures(text), []);
  assert.equal(
    builtInFailures(text.replace('binding: "mod+scroll"', 'binding: "mod+x"'))
      .length,
    1,
  );
  assert.equal(builtInFailures("").length, 1);
});
