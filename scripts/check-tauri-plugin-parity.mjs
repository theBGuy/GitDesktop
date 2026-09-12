#!/usr/bin/env node
// `tauri build` refuses to bundle when a Tauri plugin's npm half and Rust crate
// half differ in major.minor, and nothing else in CI compares the two:
// appimage-check.yml is paths-filtered to package.json and the Linux bundling
// files, so a Cargo.lock-only bump never runs it, and release.yml fires on tag
// push alone. A split pair therefore reaches master with the bundler broken and
// zero signal — which is why this gate reads both lockfiles on every PR.
//
// Comparison is major.minor on the RESOLVED versions, mirroring tauri-cli's own
// InstalledPackages::mismatched(): patch drift between the halves is legal.
//
// Only pairs where BOTH halves exist are compared — crate-only plugins
// (tauri-plugin-fs, tauri-plugin-window-state, the tauri-* build crates) and
// npm-only packages (@tauri-apps/cli) have no counterpart to disagree with.
//
// Run: node scripts/check-tauri-plugin-parity.mjs
// GD_TAURI_PARITY_ROOT points the check at a copy of the tree, for an ad-hoc
// negative control by hand: copy the lockfiles, skew one version, watch it go
// red. The committed controls live in scripts/checks.test.mjs and drive the
// predicates below in memory, touching no disk.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CARGO_LOCK = "src-tauri/Cargo.lock";
export const PNPM_LOCK = "pnpm-lock.yaml";

// The `\r?` is required: a Windows checkout materializes Cargo.lock with
// CRLF under core.autocrlf, and an LF-only pattern would parse zero packages —
// a gate that passes having compared nothing.
const CRATE_BLOCK =
  /\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g;

/** Every crate in a Cargo.lock, name → locked version. */
export function parseCrateVersions(cargoLockText) {
  const versions = new Map();
  for (const [, name, version] of cargoLockText.matchAll(CRATE_BLOCK)) {
    versions.set(name, version);
  }
  return versions;
}

/**
 * The ROOT importer's direct dependencies in a pnpm lockfile, name → resolved
 * version. Scope is deliberate: `packages:`/`snapshots:` hold every transitive
 * copy of a name and a sibling importer (site/) resolves its own tree, while
 * what tauri-cli compares is what the app itself installs.
 */
export function parseNpmVersions(pnpmLockText) {
  const versions = new Map();
  const lines = pnpmLockText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}\.:\s*$/.test(line));
  if (start === -1) return versions;

  let name = null;
  for (const line of lines.slice(start + 1)) {
    // Any non-blank line indented at or above the importer key ends the block —
    // the next importer, or a top-level section.
    if (line.trim() && !line.startsWith("   ")) break;
    const entry = /^ {6}'?([^'\s:]+)'?:\s*$/.exec(line);
    if (entry) {
      name = entry[1];
      continue;
    }
    // The resolved version, never the specifier: a range says nothing about
    // what installed. Peer-resolution suffixes — `1.2.3(react@19.2.8)` — are
    // not part of the version.
    const resolved = /^ {8}version:\s*(\S+)/.exec(line);
    if (resolved && name) {
      versions.set(name, resolved[1].replace(/\(.*$/, ""));
      name = null;
    }
  }
  return versions;
}

/**
 * The pair tauri-cli itself puts first (its list is `iter::once("tauri")` plus
 * the plugin crates) and the one this repo can never legitimately be without,
 * so its absence means a parser stopped matching rather than a clean tree.
 */
export const CORE_CRATE = "tauri";

/** The npm half of a crate, or null when the crate has no npm counterpart. */
export function npmNameFor(crateName) {
  if (crateName === "tauri") return "@tauri-apps/api";
  const plugin = /^tauri-plugin-(.+)$/.exec(crateName);
  return plugin ? `@tauri-apps/plugin-${plugin[1]}` : null;
}

const majorMinor = (version) => version.split(".").slice(0, 2).join(".");

/** Crates whose npm half is present in the lockfile, both versions carried. */
export function pairedVersions(crates, npm) {
  const pairs = [];
  for (const [crate, crateVersion] of crates) {
    const npmName = npmNameFor(crate);
    if (!npmName) continue;
    const npmVersion = npm.get(npmName);
    if (!npmVersion) continue;
    pairs.push({ crate, npm: npmName, crateVersion, npmVersion });
  }
  return pairs;
}

/** Paired halves whose major.minor disagree — what breaks `tauri build`. */
export function mismatchedPairs(crates, npm) {
  return pairedVersions(crates, npm).filter(
    (p) => majorMinor(p.crateVersion) !== majorMinor(p.npmVersion),
  );
}

/**
 * The whole decision, so the CLI only renders it and every branch stays
 * reachable from a fixture. `empty` and `missingCore` are the fail-CLOSED arms:
 * a parser that stops matching — wholly, or far enough to lose the core pair —
 * would otherwise print OK over comparisons it never made.
 */
export function verdict(crates, npm) {
  const pairs = pairedVersions(crates, npm);
  return {
    pairs,
    mismatched: mismatchedPairs(crates, npm),
    empty: pairs.length === 0,
    missingCore: !pairs.some((p) => p.crate === CORE_CRATE),
  };
}

function main() {
  const root = process.env.GD_TAURI_PARITY_ROOT
    ? resolve(process.env.GD_TAURI_PARITY_ROOT)
    : REPO_ROOT;

  let crates;
  let npm;
  try {
    crates = parseCrateVersions(readFileSync(join(root, CARGO_LOCK), "utf8"));
    npm = parseNpmVersions(readFileSync(join(root, PNPM_LOCK), "utf8"));
  } catch (err) {
    process.stderr.write("tauri-parity: FAIL — cannot read a lockfile\n");
    process.stderr.write(`    ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { pairs, mismatched, empty, missingCore } = verdict(crates, npm);
  if (empty) {
    process.stderr.write(
      "tauri-parity: FAIL — no tauri npm/crate pairs found in the lockfiles\n",
    );
    process.stderr.write(
      `    check that ${CARGO_LOCK} and ${PNPM_LOCK} still parse: the block shapes this gate reads may have changed\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (missingCore) {
    process.stderr.write(
      `tauri-parity: FAIL — ${pairs.length} pairs found but \`${CORE_CRATE}\` <-> \`${npmNameFor(CORE_CRATE)}\` is not among them\n`,
    );
    process.stderr.write(
      "    a partial parse skips real comparisons silently; confirm both halves are still declared, then check the block shapes this gate reads\n",
    );
    process.exitCode = 1;
    return;
  }

  if (mismatched.length === 0) {
    for (const p of pairs) {
      process.stdout.write(
        `tauri-parity: OK ${p.crate} ${p.crateVersion} <-> ${p.npm} ${p.npmVersion}\n`,
      );
    }
    process.stdout.write(
      `tauri-parity: OK ${pairs.length} pairs aligned on major.minor\n`,
    );
    return;
  }

  process.stderr.write(
    `tauri-parity: FAIL ${mismatched.length} of ${pairs.length} pairs differ in major.minor\n`,
  );
  for (const p of mismatched) {
    process.stderr.write(
      `  ${p.crate} ${p.crateVersion} (crate) vs ${p.npm} ${p.npmVersion} (npm)\n`,
    );
    // Both remedies name the OTHER half's minor: a caret range would resolve to
    // whatever newer minor is published and land right back here.
    process.stderr.write(
      `    align both halves on one major.minor: \`pnpm add ${p.npm}@~${majorMinor(p.crateVersion)}.0\` pins npm to the crate's minor, or bring ${p.crate} to ${majorMinor(p.npmVersion)}.x in src-tauri/Cargo.toml and re-lock\n`,
    );
  }
  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // finding the failure is about on a CI runner.
  process.exitCode = 1;
}

// Main-module detection by PATH comparison, not `import.meta.main`: that form
// only exists from node 24.2 and fails SILENTLY on older runtimes (the gate
// reads `if (undefined)` and exits 0 having checked nothing).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
