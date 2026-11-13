// Pins the GUI zoom's pure layer (src/lib/zoom/steps.ts), the settings heal's
// zoom field, and the source facts the controller rests on: native webview zoom
// stays off, the configured window minimum is the one the controller starts
// from, the window and webview permissions it calls are granted, and the three
// zoom actions (one row each) and the Ctrl/Cmd+scroll cheat-sheet row exist
// with their pinned shape. Runs in the no-install guards job, so every src
// import is dynamic and reaches only install-less modules (steps.ts imports
// nothing; heal.ts's chain stays inside @/lib/ai leaves).
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

/** The controller starts out believing the window holds the 100% minimum,
 *  minWindowSizeFor(ZOOM_DEFAULT), so tauri.conf.json's minimum must equal it. */
function windowMinFailures(text) {
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
  const want = minWindowSizeFor(ZOOM_DEFAULT);
  const failures = [];
  for (const [key, dim] of [
    ["minWidth", "width"],
    ["minHeight", "height"],
  ]) {
    if (windows[0][key] !== want[dim]) {
      failures.push(
        `app.windows[0].${key} is ${JSON.stringify(windows[0][key])}, not the zoom controller's starting ${want[dim]}`,
      );
    }
  }
  return failures;
}

const REQUIRED_PERMISSIONS = [
  "core:webview:allow-set-webview-zoom",
  "core:window:allow-set-min-size",
  "core:window:allow-set-size",
  "core:window:allow-set-position",
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

// The registry guards read registry.ts through one lexer pass over the whole
// file: comments are blanked, strings stay readable, and each declaration
// marker must occur exactly once in live code (outside comments and strings).
// The lexer refuses, as unreadable, any syntax it can't split without a parser:
// a `/` that starts no comment (a regex literal or division) and a template
// interpolation. A shape only a parser could split is refused, never guessed;
// there is no parser because this suite runs in the install-less guards job.
const REGISTRY_REMEDY =
  "keep regex literals, division and template interpolation out of registry.ts or extend scripts/zoom-steps.test.mjs";

/** registry.ts lexed: `masked` blanks comments, and `code` string contents
 *  too, both keeping every offset and newline; or the failure naming the
 *  first syntax the lexer can't read. */
function lexRegistry(text) {
  const masked = text.split("");
  const code = text.split("");
  const blank = (list, from, to) => {
    for (let k = from; k < to; k++) if (list[k] !== "\n") list[k] = " ";
  };
  const refuse = (what, at) => ({
    failure: `registry.ts holds syntax this guard can't read: ${what} at line ${text.slice(0, at).split("\n").length}; ${REGISTRY_REMEDY}`,
  });
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const eol = text.indexOf("\n", i);
      const to = eol < 0 ? text.length : eol;
      blank(masked, i, to);
      blank(code, i, to);
      i = to - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return refuse("an unclosed block comment", i);
      blank(masked, i, end + 2);
      blank(code, i, end + 2);
      i = end + 1;
    } else if (c === "/") {
      return refuse("a regex literal or division", i);
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (c === "`" && text[j] === "$" && text[j + 1] === "{") {
          return refuse("a template interpolation", j);
        }
        if (c !== "`" && text[j] === "\n") break;
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length || text[j] !== c) {
        return refuse("an unterminated string", i);
      }
      blank(code, i + 1, j);
      i = j;
    }
  }
  return { masked: masked.join(""), code: code.join("") };
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** The offsets of `marker`'s live occurrences in `code` at or after `from`. A
 *  marker ending in an identifier names its declaration only where that
 *  identifier ends, so `BUILT_IN_KEYS_EXTRA` is no `BUILT_IN_KEYS`. */
function liveOccurrences(code, marker, from) {
  const found = [];
  const bounded = IDENT_CHAR.test(marker.at(-1));
  for (let at = code.indexOf(marker, from); at >= 0; ) {
    if (!bounded || !IDENT_CHAR.test(code[at + marker.length] ?? "")) {
      found.push(at);
    }
    at = code.indexOf(marker, at + 1);
  }
  return found;
}

/** The offset of `marker`'s live occurrence in `code` at or after `from`, or
 *  the failure when it has none, or several where `unique` asks for one. */
function liveMarker(code, marker, { from = 0, unique = true } = {}) {
  const [at, second] = liveOccurrences(code, marker, from);
  if (at === undefined) {
    return { failure: `registry.ts has no live \`${marker}\`` };
  }
  if (unique && second !== undefined) {
    return {
      failure: `registry.ts holds more than one live \`${marker}\`, so which one the app reads is ambiguous`,
    };
  }
  return { at };
}

const ACTIONS_OPEN = "export const ACTIONS = [";
const ACTIONS_CLOSE = "] as const satisfies readonly ActionDef[];";

/** An array literal's top-level elements as source text with the registry.ts
 *  line each starts on, or null when the body can't be scanned. `masked` is
 *  lexRegistry's, so no comment or bare `/` reaches the scan. The body starts
 *  at `offset` and stops at `end`, or at the literal's own `closer` (`]` for
 *  an array, `}` for an object) when `end` is omitted. */
function scanElements(masked, offset, end, closer = "]") {
  const body = masked.slice(offset, end);
  const elements = [];
  let depth = 0;
  let from = -1;
  const close = (at) => {
    if (from >= 0) {
      const line = masked.slice(0, offset + from).split("\n").length;
      elements.push({ text: body.slice(from, at).trim(), line });
    }
    from = -1;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (/\s/.test(c)) continue;
    if (depth === 0 && c === ",") {
      if (from < 0) return null;
      close(i);
      continue;
    }
    // The literal's own close ends the scan; after a trailing comma it opens
    // no element.
    if (depth === 0 && c === closer && end === undefined) {
      close(i);
      return elements;
    }
    if (from < 0) from = i;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < body.length && body[j] !== c) {
        // An interpolation could hold anything: refuse to read past it.
        if (c === "`" && body[j] === "$" && body[j + 1] === "{") return null;
        j += body[j] === "\\" ? 2 : 1;
      }
      if (j >= body.length) return null;
      i = j;
    } else if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) {
      depth--;
      if (depth < 0) {
        if (end !== undefined || c !== closer) return null;
        close(i);
        return elements;
      }
    }
  }
  if (end === undefined || depth !== 0) return null;
  close(body.length);
  return elements;
}

/** The ACTIONS array's elements, or the failure when the file or the array
 *  can't be read. */
function actionElements(text) {
  const lexed = lexRegistry(text);
  if (lexed.failure) return lexed;
  const start = liveMarker(lexed.code, ACTIONS_OPEN);
  if (start.failure) return start;
  // The array's own close is the first after its opener; another array may
  // end the same way.
  const end = liveMarker(lexed.code, ACTIONS_CLOSE, {
    from: start.at,
    unique: false,
  });
  if (end.failure) return end;
  const elements = scanElements(
    lexed.masked,
    start.at + ACTIONS_OPEN.length,
    end.at,
  );
  return elements === null || elements.length === 0
    ? { failure: "registry.ts ACTIONS array is unreadable" }
    : { elements };
}

/** One whole row: the element must be exactly this, so a spread, a computed or
 *  shorthand key, a non-literal value or leftover syntax fails the match. */
const ROW_RE =
  /^\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*defaultBinding:\s*(null|"[^"]*"),?\s*\}$/;

const ROW_SHAPE =
  'write each action inline as { id: "…", label: "…", category: "…", defaultBinding: null | "…" } so this guard can read it';

/** The ACTIONS rows, or the failures naming every element the guard can't
 *  parse whole: refused, never skipped, so the corpus can't shrink. */
function actionRows(text) {
  const { elements, failure } = actionElements(text);
  if (failure) return { failures: [failure] };
  const rows = [];
  const failures = [];
  for (const { text: element, line } of elements) {
    const m = element.match(ROW_RE);
    // The line locates a multi-line row, whose first line is a bare `{`.
    const head = element.split("\n")[0];
    // An escape compares as its spelling here but as its value in the app, so
    // a row spelling one is refused rather than decoded.
    if (m?.slice(1, 5).some((s) => s.includes("\\"))) {
      failures.push(
        `registry.ts:${line} ACTIONS element \`${head}\` spells a string with a backslash escape: write the literal plainly so this guard compares what the app reads`,
      );
    } else if (m) {
      rows.push({
        id: m[1],
        label: m[2],
        category: m[3],
        defaultBinding: m[4] === "null" ? null : m[4].slice(1, -1),
      });
    } else {
      failures.push(
        `registry.ts:${line} ACTIONS element \`${head}\` doesn't parse as a row: ${ROW_SHAPE}`,
      );
    }
  }
  return { rows, failures };
}

const ZOOM_ROWS = [
  { id: "app-zoom-in", label: "Zoom in", defaultBinding: "mod+=" },
  { id: "app-zoom-out", label: "Zoom out", defaultBinding: "mod+-" },
  { id: "app-zoom-reset", label: "Reset zoom", defaultBinding: "mod+0" },
];
const RESERVED_BINDINGS = ["mod+=", "mod+-", "mod+0", "mod++", "mod+shift++"];

function registryFailures(text) {
  const { rows, failures: unread } = actionRows(text);
  if (unread.length > 0) return unread;
  const failures = [];
  // The checks below read an id's first row, so a second one would go unread:
  // every id appears once.
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) failures.push(`duplicate action ${row.id}`);
    seen.add(row.id);
  }
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
  failures.push(...macDefaultFailures(text, rows));
  return failures;
}

const MAC_OPEN = "export const MAC_DEFAULT_BINDINGS";
// The annotation, then the object literal's opening brace.
const MAC_BODY_RE = /^\s*(?::[^=;{}]*)?=\s*\{/;
const MAC_ENTRY_RE = /^"([^"]+)":\s*"([^"]+)"$/;
const MAC_SHAPE =
  'write each entry as "<action id>": "<binding>", both plain double-quoted strings';

/** The macOS defaults table read whole: each entry must name one current,
 *  non-zoom action once and default it to no zoom binding. Fails, never skips,
 *  on a table it can't find once or read entry by entry. */
function macDefaultFailures(text, rows) {
  const lexed = lexRegistry(text);
  if (lexed.failure) return [lexed.failure];
  const start = liveMarker(lexed.code, MAC_OPEN);
  if (start.failure) return [start.failure];
  const from = start.at + MAC_OPEN.length;
  const open = lexed.code.slice(from).match(MAC_BODY_RE);
  const elements =
    open === null
      ? null
      : scanElements(lexed.masked, from + open[0].length, undefined, "}");
  if (elements === null || elements.length === 0) {
    return ["registry.ts MAC_DEFAULT_BINDINGS is unreadable"];
  }
  const ids = new Set(rows.map((r) => r.id));
  const zoomIds = new Set(ZOOM_ROWS.map((r) => r.id));
  const seen = new Set();
  const failures = [];
  for (const { text: element, line } of elements) {
    const head = element.split("\n")[0];
    if (element.includes("\\")) {
      failures.push(
        `registry.ts:${line} MAC_DEFAULT_BINDINGS entry \`${head}\` spells a backslash escape: write the literal plainly so this guard compares what the app reads`,
      );
      continue;
    }
    const m = element.match(MAC_ENTRY_RE);
    if (!m) {
      failures.push(
        `registry.ts:${line} MAC_DEFAULT_BINDINGS entry \`${head}\` doesn't parse: ${MAC_SHAPE}`,
      );
      continue;
    }
    const [, id, binding] = m;
    if (!ids.has(id)) failures.push(`mac default for unknown action ${id}`);
    if (seen.has(id)) failures.push(`duplicate mac default ${id}`);
    seen.add(id);
    if (zoomIds.has(id)) failures.push(`mac default for zoom action ${id}`);
    if (RESERVED_BINDINGS.includes(binding)) {
      failures.push(`${id} defaults on macOS to the zoom binding ${binding}`);
    }
  }
  return failures;
}

const BUILT_IN_OPEN = "export const BUILT_IN_KEYS";
// Where the array literal starts, past the element type annotation.
const BUILT_IN_BODY = "}[] = [";
const SCROLL_ROW_RE =
  /^\{\s*keys:\s*"Ctrl\+scroll",\s*what:\s*"Zoom the app in or out",\s*binding:\s*"mod\+scroll",?\s*\}$/;

/** The scroll row must be a whole element of the BUILT_IN_KEYS literal: a
 *  commented-out row, or one outside the array, never reaches the cheat sheet. */
function builtInFailures(text) {
  const lexed = lexRegistry(text);
  if (lexed.failure) return [lexed.failure];
  const start = liveMarker(lexed.code, BUILT_IN_OPEN);
  if (start.failure) return [start.failure];
  const open = lexed.code.indexOf(BUILT_IN_BODY, start.at);
  const elements =
    open < 0 ? null : scanElements(lexed.masked, open + BUILT_IN_BODY.length);
  if (elements === null)
    return ["registry.ts BUILT_IN_KEYS array is unreadable"];
  return elements.some(({ text: element }) => SCROLL_ROW_RE.test(element))
    ? []
    : ["BUILT_IN_KEYS lacks the Ctrl/Cmd+scroll row"];
}

test("native webview zoom stays off", () => {
  assert.deepEqual(nativeZoomFailures(read(TAURI_CONF)), []);
  const conf = JSON.parse(read(TAURI_CONF));
  conf.app.windows[0].zoomHotkeysEnabled = true;
  assert.equal(nativeZoomFailures(JSON.stringify(conf)).length, 1);
  assert.equal(nativeZoomFailures("{ not json").length, 1);
  assert.equal(nativeZoomFailures("{}").length, 1);
});

test("tauri.conf.json's window minimum is the one the zoom controller starts from", () => {
  const text = read(TAURI_CONF);
  assert.deepEqual(windowMinFailures(text), []);
  // NEGATIVE CONTROLS: a mismatch in either dimension, a non-number, a gap.
  for (const [key, value] of [
    ["minWidth", 600],
    ["minHeight", 640],
    ["minWidth", "640"],
    ["minHeight", undefined],
  ]) {
    const conf = JSON.parse(text);
    conf.app.windows[0][key] = value;
    assert.equal(
      windowMinFailures(JSON.stringify(conf)).length,
      1,
      `${key}: ${value}`,
    );
  }
  assert.equal(windowMinFailures("{ not json").length, 1);
  assert.equal(windowMinFailures('{"app": {"windows": {}}}').length, 1);
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
  // A second zoom row appended after the first goes unread unless ids are unique.
  const appended = mutate(
    ACTIONS_CLOSE,
    `  { id: "app-zoom-in", label: "Zoom in", category: "Application", defaultBinding: "mod+0" },\n${ACTIONS_CLOSE}`,
  );
  assert.deepEqual(registryFailures(appended), [
    "duplicate action app-zoom-in",
  ]);
  const twin = mutate(
    ACTIONS_CLOSE,
    `  { id: "open-settings", label: "X", category: "Application", defaultBinding: null },\n${ACTIONS_CLOSE}`,
  );
  assert.deepEqual(registryFailures(twin), ["duplicate action open-settings"]);
});

test("the registry guard reads the macOS defaults table whole", () => {
  const text = read(REGISTRY);
  assert.deepEqual(registryFailures(text), []);
  const mutate = (from, to) => {
    assert.equal(text.split(from).length - 1, 1, from);
    return text.split(from).join(to);
  };
  const back = '"go-back": "mod+[",';
  const forward = '"go-forward": "mod+]",';
  // NEGATIVE CONTROLS, each on the real file's text.
  for (const [name, mutant, expected] of [
    [
      "a zoom binding",
      mutate(back, '"go-back": "mod++",'),
      ["go-back defaults on macOS to the zoom binding mod++"],
    ],
    [
      "the table renamed",
      mutate(`${MAC_OPEN}:`, "export const MAC_DEFAULTS:"),
      [`registry.ts has no live \`${MAC_OPEN}\``],
    ],
    [
      "an unknown id",
      mutate(forward, '"go-nowhere": "mod+]",'),
      ["mac default for unknown action go-nowhere"],
    ],
    [
      "a duplicate id",
      mutate(forward, `${forward}\n  ${back}`),
      ["duplicate mac default go-back"],
    ],
    [
      "a zoom action",
      mutate(forward, `${forward}\n  "app-zoom-in": "mod+i",`),
      ["mac default for zoom action app-zoom-in"],
    ],
  ]) {
    assert.deepEqual(registryFailures(mutant), expected, name);
  }
  // Unreadable entries fail closed, each with the shape to write.
  for (const entry of [
    'goBack: "mod+[",',
    '"go-back": MOD_BRACKET,',
    "'go-back': 'mod+[',",
    '["go-back"]: "mod+[",',
    "...EXTRA,",
  ]) {
    const failures = registryFailures(mutate(back, entry));
    assert.equal(failures.length, 1, entry);
    assert.match(failures[0], /MAC_DEFAULT_BINDINGS entry .* doesn't parse/);
  }
  const escape = `"go-back": "mod+${String.fromCharCode(92)}u005b",`;
  assert.match(
    registryFailures(mutate(back, escape))[0],
    /MAC_DEFAULT_BINDINGS entry .* spells a backslash escape/,
  );
  // Declared twice, or with nothing to read, the table fails too.
  const declaration = text.slice(
    text.indexOf(MAC_OPEN),
    text.indexOf("};", text.indexOf(MAC_OPEN)) + 2,
  );
  assert.deepEqual(registryFailures(`${text}\n${declaration}\n`), [
    `registry.ts holds more than one live \`${MAC_OPEN}\`, so which one the app reads is ambiguous`,
  ]);
  // A longer name starting with the table's is another constant, not a second
  // table.
  assert.deepEqual(
    registryFailures(
      `${text}\n${declaration.replace(MAC_OPEN, `${MAC_OPEN}_SOMETHING`)}\n`,
    ),
    [],
  );
  assert.deepEqual(
    registryFailures(
      text
        .split(declaration)
        .join(`${MAC_OPEN}: Partial<Record<ActionId, string>> = {};`),
    ),
    ["registry.ts MAC_DEFAULT_BINDINGS is unreadable"],
  );
});

test("the registry guard refuses ACTIONS elements it can't parse whole", () => {
  const text = read(REGISTRY);
  const open = `${ACTIONS_OPEN}\n`;
  assert.equal(text.split(open).length - 1, 1, "ACTIONS opener present once");
  const withElement = (element) => text.split(open).join(`${open}${element}\n`);
  const row = (fields) =>
    `  { ${fields}, label: "X", category: "Application", defaultBinding: null },`;
  for (const element of [
    "  ...EXTRA_ACTIONS,",
    '  ...[{ id: "x-act", label: "X", category: "Application", defaultBinding: null }],',
    "  SOME_ACTION,",
    '  makeAction("x-act"),',
    "  { ...EXTRA_ACTION },",
    row('...BASE, id: "x-act"'),
    row("id: X_ID"),
    row("id: `app-zoom-x`"),
    row("id: 'app-zoom-x'"),
    row('"id": "app-zoom-x"'),
    row("id"),
    `${row('id: "x-act"').slice(0, -1)} as never,`,
  ]) {
    const failures = registryFailures(withElement(element));
    assert.equal(failures.length, 1, element);
    assert.match(failures[0], /doesn't parse as a row: write each action/);
  }
  // The message names the line a multi-line row starts on.
  const line = text
    .slice(0, text.indexOf(open) + open.length)
    .split("\n").length;
  assert.match(
    registryFailures(
      withElement('  {\n    ...BASE,\n    id: "x-act",\n  },'),
    )[0],
    new RegExp(`^registry\\.ts:${line} ACTIONS element \`\\{\` `),
  );
  // Unscannable shapes fail closed too: an interpolation, a hole.
  assert.deepEqual(registryFailures(withElement(row("id: `x-${n}`"))), [
    `registry.ts holds syntax this guard can't read: a template interpolation at line ${text.slice(0, text.indexOf(open)).split("\n").length + 1}; ${REGISTRY_REMEDY}`,
  ]);
  assert.deepEqual(registryFailures(withElement("  ,")), [
    "registry.ts ACTIONS array is unreadable",
  ]);
  // An unclosed string re-pairs later quotes: whatever it breaks, it fails.
  assert.ok(
    registryFailures(withElement('  { id: "x-act, label: "X" },')).length,
  );
  // NEGATIVE CONTROL: punctuation in strings and comments is not an element.
  assert.deepEqual(
    registryFailures(
      withElement(
        '  // a, ...b\n  { id: "x-act", label: "Wait, ...{x}", category: "Application", defaultBinding: null },',
      ),
    ),
    [],
  );
});

test("the registry guard refuses a row spelling a backslash escape", () => {
  const text = read(REGISTRY);
  const mutate = (from, to) => {
    assert.equal(text.split(from).length - 1, 1, from);
    return text.split(from).join(to);
  };
  const lineOf = (needle) =>
    text.slice(0, text.indexOf(needle)).split("\n").length;
  // Unicode escapes spelling "=" and "a": at runtime the first collides with
  // zoom in's mod+=, and the second duplicates the app-zoom-in id.
  const escape = (hex) => `${String.fromCharCode(92)}u${hex}`;
  const roadmap = 'id: "roadmap-zoom-in",';
  for (const [mutant, line] of [
    [
      mutate(
        `${roadmap}\n    label: "Zoom roadmap in",\n    category: "Repository",\n    defaultBinding: null,`,
        `${roadmap}\n    label: "Zoom roadmap in",\n    category: "Repository",\n    defaultBinding: "mod+${escape("003d")}",`,
      ),
      lineOf(roadmap) - 1,
    ],
    [
      mutate(
        ACTIONS_CLOSE,
        `  { id: "${escape("0061")}pp-zoom-in", label: "X", category: "Application", defaultBinding: null },\n${ACTIONS_CLOSE}`,
      ),
      lineOf(ACTIONS_CLOSE),
    ],
  ]) {
    const failures = registryFailures(mutant);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(
      failures[0],
      new RegExp(
        `^registry\\.ts:${line} ACTIONS element .* spells a string with a backslash escape: write the literal plainly`,
      ),
    );
  }
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
  // NEGATIVE CONTROLS: the row commented out either way, or moved past the
  // array's closing bracket, never reaches the cheat sheet.
  const row =
    '  {\n    keys: "Ctrl+scroll",\n    what: "Zoom the app in or out",\n    binding: "mod+scroll",\n  },\n';
  assert.equal(text.split(row).length - 1, 1, "scroll row present once");
  const lineCommented = row.replace(/^/gm, "// ").slice(0, -3);
  const without = text.split(row).join("");
  const close =
    without.indexOf("\n];\n", without.indexOf(BUILT_IN_OPEN)) + "\n];\n".length;
  for (const [name, mutant] of [
    ["block comment", text.split(row).join(`  /*\n${row}  */\n`)],
    ["line comments", text.split(row).join(lineCommented)],
    [
      "after the array",
      `${without.slice(0, close)}export const MORE_KEYS = [\n${row}];\n${without.slice(close)}`,
    ],
  ]) {
    assert.deepEqual(
      builtInFailures(mutant),
      ["BUILT_IN_KEYS lacks the Ctrl/Cmd+scroll row"],
      name,
    );
  }
});

test("close-marker text in a comment, or a regex's quote, never cuts the read", () => {
  const text = read(REGISTRY);
  assert.equal(text.split(ACTIONS_CLOSE).length - 1, 1, "ACTIONS close once");
  // The commented close marker is not live, so the row after it is read.
  const cut = text
    .split(ACTIONS_CLOSE)
    .join(
      `  // ${ACTIONS_CLOSE}\n  { id: "app-zoom-in", label: "Zoom in", category: "Application", defaultBinding: "mod+0" },\n${ACTIONS_CLOSE}`,
    );
  assert.deepEqual(registryFailures(cut), ["duplicate action app-zoom-in"]);
  // A regex's lone quote would pair with one in the comment after it and read
  // the commented-out scroll row as live.
  const row =
    '  {\n    keys: "Ctrl+scroll",\n    what: "Zoom the app in or out",\n    binding: "mod+scroll",\n  },\n';
  assert.equal(text.split(row).length - 1, 1, "scroll row present once");
  const regex = text
    .split(row)
    .join(
      '  { keys: "a", what: String(/"/) },\n  // "/) }, { keys: "Ctrl+scroll", what: "Zoom the app in or out", binding: "mod+scroll" },\n',
    );
  const failures = builtInFailures(regex);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /: a regex literal or division at line \d+;/);
});

test("the registry guards read only live declarations, exactly one of each", () => {
  const text = read(REGISTRY);
  const block = (open, close) => {
    const at = text.indexOf(open);
    return text.slice(at, text.indexOf(close, at) + close.length);
  };
  const actions = block(ACTIONS_OPEN, ACTIONS_CLOSE);
  const builtIn = block(BUILT_IN_OPEN, "\n];");
  for (const declaration of [actions, builtIn]) {
    assert.equal(text.split(declaration).length - 1, 1, "declaration once");
  }
  const reset = 'defaultBinding: "mod+0"';
  assert.equal(text.split(reset).length - 1, 1, reset);
  for (const [style, comment] of [
    // An inner comment's close would end the outer comment early.
    ["block comment", (d) => `/*\n${d.split("*/").join("* /")}\n*/`],
    ["line comments", (d) => d.replace(/^/gm, "// ")],
  ]) {
    // A commented copy ahead of the live declaration is never what is read.
    const live = text.split(reset).join('defaultBinding: "mod+9"');
    const at = live.indexOf(ACTIONS_OPEN);
    const shadowed = `${live.slice(0, at)}${comment(actions)}\n${live.slice(at)}`;
    assert.deepEqual(
      registryFailures(shadowed),
      ["app-zoom-reset defaultBinding"],
      style,
    );
    // Commented out whole, neither declaration passes.
    assert.deepEqual(
      registryFailures(text.split(actions).join(comment(actions))),
      [`registry.ts has no live \`${ACTIONS_OPEN}\``],
      style,
    );
    assert.deepEqual(
      builtInFailures(text.split(builtIn).join(comment(builtIn))),
      [`registry.ts has no live \`${BUILT_IN_OPEN}\``],
      style,
    );
  }
  // A second live declaration is ambiguous, whichever comes first.
  for (const [guard, declaration] of [
    [registryFailures, actions],
    [builtInFailures, builtIn],
  ]) {
    const failures = guard(`${text}\n${declaration}\n`);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /more than one live .* is ambiguous$/);
  }
  // NEGATIVE CONTROL: a marker inside a string is not a declaration.
  const quoted = `${text}\nconst MARKERS = ["${ACTIONS_OPEN}", "${BUILT_IN_OPEN}"];\n`;
  assert.deepEqual(registryFailures(quoted), []);
  assert.deepEqual(builtInFailures(quoted), []);
  // NEGATIVE CONTROLS: a sibling export sharing the marker's prefix, and
  // another array closing like ACTIONS, are not its declaration.
  const siblings = `${text}\nexport const BUILT_IN_KEYS_EXTRA = [\n  { keys: "a", what: "b", binding: "c" },\n];\nexport const MORE_ACTIONS = [\n] as const satisfies readonly ActionDef[];\n`;
  assert.deepEqual(registryFailures(siblings), []);
  assert.deepEqual(builtInFailures(siblings), []);
});

test("the registry guards refuse a file they can't lex, naming the line", () => {
  const text = read(REGISTRY);
  const line = text.split("\n").length + 1;
  for (const [what, tail] of [
    ["a regex literal or division", "const RE = /x/;"],
    ["a regex literal or division", "const HALF = 1 / 2;"],
    ["a template interpolation", "const T = `${RE}`;"],
    ["an unterminated string", 'const S = "x;'],
    ["an unclosed block comment", "/* x"],
  ]) {
    const mutant = `${text}\n${tail}\n`;
    const want = [
      `registry.ts holds syntax this guard can't read: ${what} at line ${line}; ${REGISTRY_REMEDY}`,
    ];
    assert.deepEqual(registryFailures(mutant), want, tail);
    assert.deepEqual(builtInFailures(mutant), want, tail);
  }
  // NEGATIVE CONTROL: a template literal without interpolation reads as a
  // string, slashes and all.
  const plain = `${text}\nconst T = \`a / b // c\`;\n`;
  assert.deepEqual(registryFailures(plain), []);
  assert.deepEqual(builtInFailures(plain), []);
});

test("a block-commented zoom row fails the registry guard", () => {
  const text = read(REGISTRY);
  const row =
    '  {\n    id: "app-zoom-in",\n    label: "Zoom in",\n    category: "Application",\n    defaultBinding: "mod+=",\n  },\n';
  assert.equal(text.split(row).length - 1, 1, "zoom-in row present once");
  assert.deepEqual(
    registryFailures(text.split(row).join(`  /*\n${row}  */\n`)),
    ["missing action app-zoom-in"],
  );
});

// zoom.ts scrolls, never zooms, on Ctrl/Cmd+wheel over a list marked
// multi-select, so each list that picks rows with Ctrl/Cmd+click keeps its
// marker. A bare JSX attribute ends its line (CRLF read as LF).
const MARKER_SITES = [
  [
    "src/features/history/HistoryPanel.tsx",
    'data-multiselect={searchActive ? undefined : ""}',
  ],
  ["src/features/repository/ChangesPanel.tsx", 'aria-multiselectable="true"'],
  ["src/features/projects/ProjectsRoadmapView.tsx", "aria-multiselectable\n"],
  ["src/features/projects/ProjectsTableView.tsx", "aria-multiselectable\n"],
  [
    "src/features/projects/BoardColumn.tsx",
    "aria-multiselectable={items.length === 0 ? undefined : true}",
  ],
  ["src/features/history/EditHistoryDialog.tsx", 'data-multiselect=""'],
];

/** Each marker site whose file can't be read or lacks its marker; `readSite`
 *  takes a repo-relative path. A marker counts only where it starts a line,
 *  as the attribute-per-line JSX writes it, so a commented-out one fails. */
function markerFailures(readSite) {
  return MARKER_SITES.flatMap(([file, marker]) => {
    let text;
    try {
      text = readSite(file);
    } catch (e) {
      return [`${file} can't be read: ${e.message}`];
    }
    const live =
      typeof text === "string" &&
      text
        .split("\n")
        .some((line) => `${line.trimStart()}\n`.startsWith(marker));
    if (live) return [];
    return [
      `${file} lacks \`${marker.trim()}\`: Ctrl/Cmd+scroll over its list would zoom instead of scroll`,
    ];
  });
}

test("the Ctrl/Cmd+click lists keep the marker Ctrl/Cmd+scroll scrolls over", () => {
  const readSite = (file) => read(new URL(`../${file}`, import.meta.url));
  assert.deepEqual(markerFailures(readSite), []);
  // NEGATIVE CONTROLS: each marker removed or commented out, an unreadable file.
  for (const [file, marker] of MARKER_SITES) {
    const lacks = [
      `${file} lacks \`${marker.trim()}\`: Ctrl/Cmd+scroll over its list would zoom instead of scroll`,
    ];
    const without = (f) =>
      f === file ? readSite(f).split(marker).join("") : readSite(f);
    assert.deepEqual(markerFailures(without), lacks);
    const commented = (f) =>
      f === file ? readSite(f).split(marker).join(`// ${marker}`) : readSite(f);
    assert.deepEqual(markerFailures(commented), lacks);
  }
  const unreadable = markerFailures(() => {
    throw new Error("gone");
  });
  assert.equal(unreadable.length, MARKER_SITES.length);
  assert.match(unreadable[0], /can't be read: gone$/);
});
