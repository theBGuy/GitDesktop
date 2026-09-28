#!/usr/bin/env node
// Some npm packages break when two copies install side by side: CodeMirror
// checks extensions by `instanceof` against its own @codemirror/state, so a
// second copy throws "Unrecognized extension value" when an editor opens, and a
// second @lezer/highlight mints tag objects the theme never styles. A routine
// `pnpm update` can leave exactly that split in the lockfile while build and
// tests stay green, because nothing in them renders an editor. This gate
// requires a single resolved version for each name in SINGLETONS.
//
// Remedy on a hit: `pnpm dedupe`; a split that survives it gets a pnpm
// `overrides:` pin in pnpm-workspace.yaml.
//
// Run: node scripts/check-lockfile-dedupe.mjs [path/to/pnpm-lock.yaml]
// The optional path serves an ad-hoc negative control against a saved lock;
// the committed controls live in scripts/checks.test.mjs and run in memory.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PNPM_LOCK = "pnpm-lock.yaml";

/** Packages that must resolve to exactly one version across the whole lock. */
export const SINGLETONS = [
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "style-mod",
];

/**
 * Every `packages:` key in a pnpm lockfile, name → set of versions, plus the
 * keys that did not split into a name and a version. Lockfile v9's `packages:`
 * holds one key per resolved name@version across every importer, which is where
 * a version split shows up. Same-version copies split by peer context appear
 * only as `snapshots:` keys and are not counted; no SINGLETONS entry declares
 * peerDependencies today, so a peer-context split cannot occur for them.
 */
export function parsePackageVersions(pnpmLockText) {
  const versions = new Map();
  const malformed = [];
  const lines = pnpmLockText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) return { versions, malformed };

  for (const line of lines.slice(start + 1)) {
    // Any non-blank line at column 0 ends the section (`snapshots:` today).
    if (line.trim() && !line.startsWith(" ")) break;
    // Every line at this indent is a key, so one the pattern cannot read is
    // reported rather than skipped.
    if (!/^ {2}\S/.test(line)) continue;
    const entry = /^ {2}(?:'([^']+)'|([^'\s:]+)):/.exec(line);
    const key = entry ? (entry[1] ?? entry[2]) : line.trim();
    // Search from index 1 so a scope's leading `@` is never taken as the
    // name/version separator.
    const at = entry ? key.indexOf("@", 1) : -1;
    if (at === -1) {
      malformed.push(key);
      continue;
    }
    const name = key.slice(0, at);
    const version = key.slice(at + 1).replace(/\(.*$/, "");
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return { versions, malformed };
}

/**
 * The whole decision, so the CLI only renders it. Everything but `split` is a
 * fail-CLOSED arm: a section that parsed to nothing, a key the parser could not
 * read, and a singleton absent from the lock — a list entry that no longer
 * matches anything checks nothing while still printing OK.
 */
export function verdict({ versions, malformed }, singletons = SINGLETONS) {
  return {
    empty: versions.size === 0,
    malformed: [...malformed],
    missing: singletons.filter((name) => !versions.has(name)),
    split: singletons
      .filter((name) => (versions.get(name)?.size ?? 0) > 1)
      .map((name) => ({
        name,
        versions: [...versions.get(name)].sort((a, b) =>
          a.localeCompare(b, "en", { numeric: true }),
        ),
      })),
  };
}

function main() {
  const lockPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(REPO_ROOT, PNPM_LOCK);

  let parsed;
  try {
    parsed = parsePackageVersions(readFileSync(lockPath, "utf8"));
  } catch (err) {
    process.stderr.write("lockfile-dedupe: FAIL — cannot read the lockfile\n");
    process.stderr.write(`    ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { empty, malformed, missing, split } = verdict(parsed);
  if (empty) {
    process.stderr.write(
      `lockfile-dedupe: FAIL — no \`packages:\` entries parsed from ${lockPath}\n`,
    );
    process.stderr.write(
      "    the lockfile shape this gate reads may have changed\n",
    );
    process.exitCode = 1;
    return;
  }
  if (malformed.length > 0) {
    process.stderr.write(
      `lockfile-dedupe: FAIL — ${malformed.length} \`packages:\` key(s) carry no name@version split\n`,
    );
    for (const key of malformed) process.stderr.write(`  ${key}\n`);
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0) {
    process.stderr.write(
      `lockfile-dedupe: FAIL — ${missing.length} singleton(s) absent from ${lockPath}\n`,
    );
    for (const name of missing) process.stderr.write(`  ${name}\n`);
    process.stderr.write(
      "    drop a name from SINGLETONS only if the dependency is genuinely gone; otherwise the lockfile shape this gate reads has changed\n",
    );
    process.exitCode = 1;
    return;
  }
  if (split.length > 0) {
    process.stderr.write(
      `lockfile-dedupe: FAIL — ${split.length} singleton package(s) resolve to more than one version\n`,
    );
    for (const { name, versions } of split) {
      process.stderr.write(`  ${name}: ${versions.join(", ")}\n`);
    }
    process.stderr.write(
      "    run `pnpm dedupe`; pin any split that survives it under `overrides:` in pnpm-workspace.yaml\n",
    );
    process.exitCode = 1;
    return;
  }

  for (const name of SINGLETONS) {
    process.stdout.write(
      `lockfile-dedupe: OK ${name} ${[...parsed.versions.get(name)][0]}\n`,
    );
  }
  process.stdout.write(
    `lockfile-dedupe: OK ${SINGLETONS.length} singletons resolve to one version each\n`,
  );
}

// Main-module detection by PATH comparison, not `import.meta.main`: that form
// only exists from node 24.2 and fails SILENTLY on older runtimes.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
