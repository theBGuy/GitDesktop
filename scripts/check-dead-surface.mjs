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
//
// RATCHET RULE: the list only shrinks by default. Adding an entry is a reviewed
// change needing a rationale for which of those two classes it falls in, and an
// entry that suppresses nothing fails as stale (`staleAllowlistEntries`
// below) — so a leftover can never pre-authorize whatever takes that name
// next.
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

const STALE_FIX =
  "stale allowlist entry — it suppresses nothing: the command is no longer " +
  "registered, or it has a live caller in src/ and so never reaches the " +
  "dead-surface list; remove the entry (an exception left behind " +
  "pre-authorizes whatever takes that name next)";

/** Allowlist entries that suppress nothing, in either of its two shapes: the
 *  command is no longer registered, or it IS invoked from src/ and so never
 *  reaches the `dead` filter the entry exists to quiet. Both leave a standing
 *  exception with nothing behind it — and a ratchet that can only loosen is not
 *  a ratchet. Registered-but-uninvoked is the one live shape: that entry is
 *  doing exactly its job and stays. */
export function staleAllowlistEntries(allowlist, registered, invoked) {
  return allowlist
    .filter((name) => !registered.has(name) || invoked.has(name))
    .sort();
}

function main() {
  const registered = readRegistered();
  const invoked = readInvoked();
  const allowed = new Set(ALLOWLIST);

  const dead = difference(registered, invoked).filter(
    (name) => !allowed.has(name),
  );
  const missing = difference(invoked, registered);
  const stale = staleAllowlistEntries(ALLOWLIST, registered, invoked);

  const handlerPath = relative(root, LIB_RS).split(sep).join("/");
  process.stdout.write(
    `${registered.size} command(s) registered in ${handlerPath}\n` +
      `${invoked.size} command(s) invoked from src/\n`,
  );

  if (dead.length === 0 && missing.length === 0 && stale.length === 0) {
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

  if (stale.length > 0) {
    process.stderr.write(
      `\n${stale.length} stale allowlist entry(s):\n${list(stale)}\n` +
        `\n${STALE_FIX}\n`,
    );
  }

  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // drift lists the failure is about on a CI runner.
  process.exitCode = 1;
}

// Main-module detection by PATH comparison, not `import.meta.main`: this form
// works on any node, while `import.meta.main` only exists from 24.2 — a cliff
// the documented floor should not have to track, and one that fails SILENTLY
// (the gate reads `if (undefined)` and the script exits 0 having scanned
// nothing — the fail-open this whole file exists to prevent).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
