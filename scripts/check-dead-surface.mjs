#!/usr/bin/env node
// Pins the Tauri IPC surface at zero drift: every command registered in
// `generate_handler!` must be invoked from src/, and every `invoke("…")` must be
// registered. A 2026-08 audit deleted 61 commands that had accumulated with no
// caller; this check keeps that from recurring silently. Node stdlib only — CI
// runs it with bare `node`, before any install step.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./check-banned-patterns.mjs";

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
export function parseRegistered(source, label = "the handler list") {
  const marker = "tauri::generate_handler![";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find '${marker}' in ${label}`);
  }
  let depth = 0;
  let end = start + marker.length - 1; // the marker's own '['
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (depth !== 0) {
    throw new Error(`Unterminated generate_handler! list in ${label}`);
  }
  // Comments go BEFORE the comma split, and the dangerous direction is why:
  // a commented-out entry `// git::foo,` survives the split and still yields
  // `foo` from `split("::").pop()`, so a command that is registered nowhere but
  // still invoked reads as a FALSE CLEAN here and fails at runtime. (Stripping
  // can at worst mis-parse a nearby entry into noise — a loud, fixable wrong.)
  const body = source
    .slice(start + marker.length, end)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  return new Set(
    body
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((path) => path.split("::").pop()),
  );
}

function readRegistered() {
  return parseRegistered(readFileSync(LIB_RS, "utf8"), LIB_RS);
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

/** Every command name passed to `invoke` in one file's contents. Comments are
 *  stripped first, and for the same reason the handler list strips them: a
 *  commented-out `// invoke("git_retired_command")` otherwise still counts as a
 *  live call, so a command nothing invokes any more reads green forever. Lines
 *  are re-joined rather than trimmed, so a call split across lines still
 *  matches. */
export function parseInvoked(contents, into = new Set()) {
  const code = stripComments(contents.split(/\r?\n/)).join("\n");
  INVOKE_RE.lastIndex = 0;
  let match;
  while ((match = INVOKE_RE.exec(code)) !== null) {
    into.add(match[1]);
  }
  return into;
}

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
        parseInvoked(readFileSync(full, "utf8"), invoked);
      }
    }
  };
  walk(SRC);
  return invoked;
}

const difference = (a, b) => [...a].filter((name) => !b.has(name)).sort();
const list = (names) => names.map((name) => `  ${name}`).join("\n");

function main() {
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
    return;
  }

  // Both directions always report before the exit code is set: drift usually
  // arrives in pairs (a rename shows up as one dead + one missing), and half a
  // picture sends the reader chasing the wrong fix.
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

  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // drift lists the failure is about on a CI runner.
  process.exitCode = 1;
}

// Main-module detection by PATH comparison, not `import.meta.main`: that is
// node 24.2+ only, and this repo documents a node 20 floor (CONTRIBUTING.md,
// README) with no engines pin — on an older runtime the gate would read
// `if (undefined)` and the script would exit 0 having scanned nothing.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
