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
// The two directions are NOT symmetric. A crate with no npm half is skipped
// and legitimately so: the build crates (tauri-build, tauri-codegen,
// tauri-utils) publish none, and plugins this app drives from Rust alone
// (tauri-plugin-fs, tauri-plugin-window-state) publish a JS API it simply does
// not install. But a package.json-declared `@tauri-apps/*` whose name maps to a
// crate owes a comparison and fails the gate when it produces none — a JS half
// calling a plugin the Rust side never registers. @tauri-apps/cli maps to no
// crate at all, so it stays out of the pairing entirely.
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
export const PACKAGE_JSON = "package.json";

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
 * Crate names carrying more than one block. A lockfile holding two versions of
 * a name is ordinary (58 names do here today), but for a PAIRED crate the map
 * above keeps whichever came last, so the comparison may describe a version the
 * app does not link — not comparable, rather than comparable-and-fine.
 */
export function duplicateCrateNames(cargoLockText) {
  const seen = new Set();
  const duplicated = new Set();
  for (const [, name] of cargoLockText.matchAll(CRATE_BLOCK)) {
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  return duplicated;
}

// pnpm installs all three of these; peerDependencies is deliberately absent,
// because an app does not install its peers by default and flagging one would
// redden a required check over a package that was never meant to be present.
const DECLARED_BLOCKS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

// An npm: alias carries the real package name in the VALUE, so the key alone
// cannot answer what is installed: `"x": "npm:@tauri-apps/plugin-store@^2.4"`.
const ALIASED_NAME = /^npm:(@tauri-apps\/[^@]+)/;

/**
 * What package.json declares, read from the key AND the value: the
 * `@tauri-apps/*` names, plus every alias that renames one. A declared package
 * that never reaches this result is a comparison the gate skips in silence,
 * and the two lists stay separate because one package can be declared both
 * directly and under an alias — collapsing them would let the pair the direct
 * declaration forms hide the alias.
 */
function tauriEntries(packageJsonText) {
  const pkg = JSON.parse(packageJsonText);
  const declared = new Set();
  const aliases = [];
  for (const block of DECLARED_BLOCKS) {
    for (const [key, value] of Object.entries(pkg[block] ?? {})) {
      if (key.startsWith("@tauri-apps/")) {
        declared.add(key);
        continue;
      }
      const aliased =
        typeof value === "string" ? ALIASED_NAME.exec(value) : null;
      if (!aliased) continue;
      declared.add(aliased[1]);
      aliases.push([aliased[1], key]);
    }
  }
  return { declared: [...declared], aliases };
}

/**
 * The `@tauri-apps/*` packages package.json declares. This is the robust half
 * of the expectation — real JSON, against a lockfile scan that depends on an
 * indentation-sensitive format — so it is what says how many comparisons the
 * gate owes.
 */
export function declaredNpmPackages(packageJsonText) {
  return tauriEntries(packageJsonText).declared;
}

/**
 * Declared packages an npm: alias renames, as [real name, alias key] pairs.
 * The lockfile's root importer keys an aliased install by its alias, so no
 * comparison can reach it — reported on its own, independent of the pairing,
 * because a second DIRECT declaration of the same package would otherwise pair
 * cleanly and leave the aliased copy unverified in silence.
 */
export function declaredNpmAliases(packageJsonText) {
  return tauriEntries(packageJsonText).aliases;
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
  if (crateName === CORE_CRATE) return "@tauri-apps/api";
  const plugin = /^tauri-plugin-(.+)$/.exec(crateName);
  return plugin ? `@tauri-apps/plugin-${plugin[1]}` : null;
}

/** The crate half of an npm package — the inverse of `npmNameFor`. */
export function crateNameFor(npmName) {
  if (npmName === "@tauri-apps/api") return CORE_CRATE;
  const plugin = /^@tauri-apps\/plugin-(.+)$/.exec(npmName);
  return plugin ? `tauri-plugin-${plugin[1]}` : null;
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
 * reachable from a fixture. Everything but `mismatched` is a fail-CLOSED arm
 * against a comparison that never happened: a parse that yields nothing, one
 * that loses the core pair, a duplicated crate whose kept version is arbitrary,
 * an aliased declaration no comparison can reach, and a package.json-declared
 * half that produced no comparison at all.
 */
export function verdict(
  crates,
  npm,
  { duplicates = new Set(), declared = [], aliases = [] } = {},
) {
  const pairs = pairedVersions(crates, npm);
  const paired = new Set(pairs.map((p) => p.crate));
  return {
    pairs,
    mismatched: mismatchedPairs(crates, npm),
    empty: pairs.length === 0,
    missingCore: !paired.has(CORE_CRATE),
    duplicated: [...duplicates].filter((name) => paired.has(name)).sort(),
    // Deliberately independent of `paired`: an alias is unverifiable whether or
    // not the same package is also declared directly, and the pair that direct
    // declaration forms is exactly what would otherwise mask it.
    aliased: [...aliases],
    // `paired` already requires both halves, so this covers a lost lockfile
    // entry and a crate that was never declared at all. `crate !== null` is the
    // only exemption: an npm package with no crate name owes no comparison.
    unpaired: declared.filter((name) => {
      const crate = crateNameFor(name);
      return crate !== null && !paired.has(crate);
    }),
  };
}

function main() {
  const root = process.env.GD_TAURI_PARITY_ROOT
    ? resolve(process.env.GD_TAURI_PARITY_ROOT)
    : REPO_ROOT;

  let crates;
  let npm;
  let duplicates;
  let declared;
  let aliases;
  try {
    const cargoLock = readFileSync(join(root, CARGO_LOCK), "utf8");
    crates = parseCrateVersions(cargoLock);
    duplicates = duplicateCrateNames(cargoLock);
    npm = parseNpmVersions(readFileSync(join(root, PNPM_LOCK), "utf8"));
    const packageJson = readFileSync(join(root, PACKAGE_JSON), "utf8");
    declared = declaredNpmPackages(packageJson);
    aliases = declaredNpmAliases(packageJson);
  } catch (err) {
    process.stderr.write("tauri-parity: FAIL — cannot read a manifest\n");
    process.stderr.write(`    ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const {
    pairs,
    mismatched,
    empty,
    missingCore,
    duplicated,
    aliased,
    unpaired,
  } = verdict(crates, npm, { duplicates, declared, aliases });
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
  if (duplicated.length > 0) {
    process.stderr.write(
      `tauri-parity: FAIL — ${duplicated.length} paired crate(s) carry more than one block in ${CARGO_LOCK}\n`,
    );
    for (const name of duplicated) {
      process.stderr.write(
        `  ${name} — which version the app links is ambiguous here, so the pair is not comparable\n`,
      );
    }
    process.stderr.write(
      "    unify the versions (a single block per paired crate) before this gate can speak to the pair\n",
    );
    process.exitCode = 1;
    return;
  }
  if (aliased.length > 0) {
    process.stderr.write(
      `tauri-parity: FAIL — ${aliased.length} Tauri package(s) declared under an npm: alias\n`,
    );
    for (const [name, key] of aliased) {
      process.stderr.write(
        `  ${name} is installed as \`${key}\`, the name ${PNPM_LOCK} keys it by, so no comparison can reach it\n`,
      );
    }
    process.stderr.write(
      `    declare an aliased Tauri package under its real name in ${PACKAGE_JSON}; a direct declaration alongside the alias does not cover it\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (unpaired.length > 0) {
    process.stderr.write(
      `tauri-parity: FAIL — ${unpaired.length} declared package(s) produced no comparison\n`,
    );
    for (const name of unpaired) {
      const crate = crateNameFor(name);
      const missing = crates.has(crate)
        ? `${PNPM_LOCK} carries no root-importer entry for it`
        : `${CARGO_LOCK} carries no \`${crate}\` block`;
      process.stderr.write(
        `  ${name} (${PACKAGE_JSON}) <-> ${crate} — ${missing}\n`,
      );
    }
    process.stderr.write(
      "    supply the missing half, or drop the declaration if the dependency is genuinely gone; a half that IS present means the block shape this gate reads has changed\n",
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
