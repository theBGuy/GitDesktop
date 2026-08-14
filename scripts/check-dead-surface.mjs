#!/usr/bin/env node
// Pins the Tauri IPC surface at zero drift: every command registered in
// `generate_handler!` must be invoked from src/, and every `invoke("…")` must be
// registered. A 2026-08 audit deleted 61 commands that had accumulated with no
// caller; this check keeps that from recurring silently. Node stdlib only — CI
// runs it with bare `node`, before any install step.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB_RS = join(root, "src-tauri", "src", "lib.rs");
const SRC = join(root, "src");

// Commands that are legitimately registered without a src/ caller. Empty today,
// and the two classes that could ever populate it: (1) a command served to a
// second window or binary target whose frontend doesn't live under src/;
// (2) a call site that builds the command name as a computed string, which the
// literal-only scan below cannot see. Neither exists now — every call site in
// the tree passes a bare string literal.
const ALLOWLIST = [];

/** Registered set: the final `::` segment of every entry in the
 *  `generate_handler!` list. Located by MARKER + bracket scan, never by line
 *  numbers — the list grows every release. */
function readRegistered() {
  const source = readFileSync(LIB_RS, "utf8");
  const marker = "tauri::generate_handler![";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find '${marker}' in ${LIB_RS}`);
  }
  let depth = 0;
  let end = start + marker.length - 1; // the marker's own '['
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (depth !== 0) {
    throw new Error(`Unterminated generate_handler! list in ${LIB_RS}`);
  }
  return new Set(
    source
      .slice(start + marker.length, end)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((path) => path.split("::").pop()),
  );
}

// Two traps this pattern exists to survive, both live in src/lib/git/api.ts:
//   1. The call can be split across lines — `invoke<T>(\n  "forge_publish_targets"`
//      — so the gap before the literal must match newlines (`\s*`, not ` *`).
//   2. Type arguments nest: `invoke<Record<string, string>>("git_branch_tips")`.
//      A `<[^>]*>` generic group stops at the INNER `>` and then fails on the
//      leftover `>`; `<[^(]*?>` is lazy and bounded by the call's own paren.
// A pattern that gets either wrong reports exactly three live commands as dead:
// forge_pr_list_mergeability, forge_publish_targets, git_branch_tips.
const INVOKE_RE = /invoke(?:<[^(]*?>)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;

/** Invoked set: every command name passed to `invoke` anywhere under src/.
 *  The walk covers ALL of src/, not just src/lib — 13 call sites live outside it
 *  (App.tsx, features/app-menu/useMacAppMenu.ts, features/research/store.ts,
 *  features/sessions/persistence.ts), reaching 10 commands nothing in src/lib
 *  calls. Matching is done on whole file contents so trap 1 above can't bite. */
function readInvoked() {
  const invoked = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const contents = readFileSync(full, "utf8");
        INVOKE_RE.lastIndex = 0;
        let match;
        while ((match = INVOKE_RE.exec(contents)) !== null) {
          invoked.add(match[1]);
        }
      }
    }
  };
  walk(SRC);
  return invoked;
}

const difference = (a, b) => [...a].filter((name) => !b.has(name)).sort();
const list = (names) => names.map((name) => `  ${name}`).join("\n");

const registered = readRegistered();
const invoked = readInvoked();
const allowed = new Set(ALLOWLIST);

const dead = difference(registered, invoked).filter(
  (name) => !allowed.has(name),
);
const missing = difference(invoked, registered);

const handlerPath = relative(root, LIB_RS).split(sep).join("/");
process.stdout.write(
  `${registered.size} command(s) registered in ${handlerPath}\n` +
    `${invoked.size} command(s) invoked from src/\n`,
);

if (dead.length === 0 && missing.length === 0) {
  process.stdout.write("IPC surface is in sync — no drift.\n");
  process.exit(0);
}

if (dead.length > 0) {
  process.stderr.write(
    `\n${dead.length} command(s) registered but never invoked from src/ — dead IPC surface (or add an allowlist entry):\n${list(dead)}\n` +
      `\nRemove them from the tauri::generate_handler! list in ${handlerPath} (and delete the command itself if nothing else uses it).\n`,
  );
}

if (missing.length > 0) {
  process.stderr.write(
    `\n${missing.length} command(s) invoked but not registered — this call fails at runtime:\n${list(missing)}\n` +
      `\nAdd them to the tauri::generate_handler! list in ${handlerPath}.\n`,
  );
}

process.exit(1);
