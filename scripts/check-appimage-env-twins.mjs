#!/usr/bin/env node
// Bundle exports and child sanitization must cover the same variables. This
// gate needs only Node stdlib because CI runs it before installing dependencies.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Any future exception must name why the child may inherit that bundle export.
// An exemption is live only while the guard allows a variable the child keeps.
export const EXEMPT = new Map();

export function parseGuardAllowed(source) {
  const names = new Set();
  const lines = source
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:(?:declare|local|export)\s+(?:-\S+\s+)*)?allowed\s*\+?=/.test(
        line,
      ),
    );
  if (lines.length === 0) {
    throw new Error("Could not find 'allowed=' in appimage-guard.sh");
  }
  for (const [index, line] of lines.entries()) {
    const match = line.match(
      /^\s*allowed="(\$allowed(?=\s|"))?([^"$]*)"\s*(?:#.*)?$/,
    );
    if (!match) throw new Error(`Could not parse allowed assignment: ${line}`);
    if (index > 0 && !match[1]) {
      throw new Error(`Replacement allowed assignment: ${line}`);
    }
    for (const name of match[2].trim().split(/\s+/).filter(Boolean)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Could not parse allowed variable: ${name}`);
      }
      names.add(name);
    }
  }
  return names;
}

export function parseRustVars(source) {
  // Strip comments before locating declarations or extracting entries so a
  // commented-out table or variable cannot make a missing sanitizer look live.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const names = new Set();
  for (const marker of ["APPDIR_PATHLIST_VARS", "APPDIR_SCALAR_VARS"]) {
    const match = code.match(
      new RegExp(
        `\\bconst\\s+${marker}\\s*:\\s*&\\s*\\[\\s*&str\\s*\\]\\s*=\\s*&\\s*\\[([^\\]]*)\\]\\s*;`,
      ),
    );
    if (!match) throw new Error(`Could not find '${marker}' in agent.rs`);
    const body = match[1];
    if (body.replace(/"[A-Za-z_][A-Za-z0-9_]*"/g, "").replace(/[\s,]/g, "")) {
      throw new Error(`Could not parse '${marker}' entries in agent.rs`);
    }
    for (const [, name] of body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
      names.add(name);
    }
  }
  return names;
}

export function verdict(guard, stripped, exempt = EXEMPT) {
  const expected = new Set([...stripped, ...exempt.keys()]);
  return {
    empty: guard.size === 0 || stripped.size === 0,
    notStripped: [...guard].filter((name) => !expected.has(name)).sort(),
    notAllowed: [...stripped]
      .filter((name) => !guard.has(name) && !exempt.has(name))
      .sort(),
    stale: [...exempt.keys()]
      .filter((name) => !guard.has(name) || stripped.has(name))
      .sort(),
  };
}

function main() {
  const root =
    process.env.GD_APPIMAGE_TWINS_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const guard = parseGuardAllowed(
      readFileSync(join(root, ".github/scripts/appimage-guard.sh"), "utf8"),
    );
    const stripped = parseRustVars(
      readFileSync(join(root, "src-tauri/src/agent.rs"), "utf8"),
    );
    const { empty, notStripped, notAllowed, stale } = verdict(guard, stripped);
    const failures = [];
    if (empty) failures.push("empty parsed set; refusing to pass vacuously");
    if (notStripped.length) {
      failures.push(`in guard but not stripped: ${notStripped.join(", ")}`);
    }
    if (notAllowed.length) {
      failures.push(`stripped but not allowed: ${notAllowed.join(", ")}`);
    }
    if (stale.length) failures.push(`stale exemptions: ${stale.join(", ")}`);
    if (failures.length) {
      process.stderr.write(
        `appimage-env-twins: FAIL\n${failures.join("\n")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `appimage-env-twins: OK ${guard.size} variables in sync\n`,
    );
  } catch (err) {
    process.stderr.write(`appimage-env-twins: FAIL ${err.message}\n`);
    process.exitCode = 1;
  }
}

// Path comparison keeps this gate active without relying on import.meta.main.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
