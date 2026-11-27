#!/usr/bin/env node
// Runs `cargo test --manifest-path src-tauri/Cargo.toml` inside a warm Linux
// container: a prebuilt image, per-worktree named volumes for the source copy
// and the target dir, and a shared CARGO_HOME volume. The container must
// test EXACTLY the worktree's current files, so the source volume is filled by
// a host-side, content-addressed sync: only changed files travel (unchanged
// ones keep their mtime, so cargo rebuilds only what changed), every sync is
// identified by a random id the volume and the host cache both record, and the
// archive ends with a sentinel member the container checks before the tree or
// its sync id change.
//
// It holds its own port lock (27484, GD_RUST_CONTAINER_PORT), never the native
// full-suite lock (GD_FULL_SUITE_PORT, default 27483, which must differ), and
// logs whether that native lock was held during the run.
// The container cannot see cfg(windows) code, CRLF behaviour or Windows path
// rules, so it complements one native full run per batch; it never replaces it.
//
// Run: node scripts/rust-container.mjs test [cargo test args...] | clean [--worktree <path> | --stale | --all] | info
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireLock,
  isPidAlive,
  portFromEnv,
  readSidecar,
  sidecarPath,
} from "./full-suite.mjs";

export const DEFAULT_CONTAINER_PORT = 27484;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "rust-container: ";
const USAGE =
  "usage: node scripts/rust-container.mjs test [cargo test args...] | clean [--worktree <path> | --stale | --all] | info";
const RESERVED_DIR = ".gd-rust-container";

const defaultLog = (line) => process.stderr.write(`${line}\n`);

export function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** The port from GD_RUST_CONTAINER_PORT; unset or empty means the default. */
export function containerPortFromEnv(value) {
  if (value === undefined || value === "") return DEFAULT_CONTAINER_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 1024 && port <= 65535)) {
    throw new Error(
      `GD_RUST_CONTAINER_PORT must be an integer 1024..65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

// Mirrors the "Install Linux dependencies" step of rust-tests.yml (set and
// order are pinned by a test), so the container links what CI links.
export const APT_PACKAGES = [
  "libwebkit2gtk-4.1-dev",
  "libayatana-appindicator3-dev",
  "librsvg2-dev",
  "patchelf",
  "build-essential",
  "libssl-dev",
  "file",
];

// A string constant, not a file, so a CRLF checkout cannot change its hash.
// Every byte, comments included, is hashed into the image tag, so an edit
// rebuilds the image and clears each target volume once. The first line must
// stay the FROM line: buildDockerfile replaces it.
export const DOCKERFILE = `FROM rust:1
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")} \\
 && rm -rf /var/lib/apt/lists/*
# Non-root: several tests assert permission refusals that root would bypass.
RUN useradd -m -s /bin/bash builder
USER builder
# Created as builder so new named volumes mounted here inherit that owner.
RUN mkdir -p /home/builder/.cargo-home /home/builder/target /home/builder/src
ENV CARGO_HOME=/home/builder/.cargo-home CARGO_TARGET_DIR=/home/builder/target
WORKDIR /home/builder
`;

const RUST_DIGEST = /^rust@sha256:[0-9a-f]{64}$/;

/**
 * The text sent to `docker build`: FROM pinned to the local rust:1's digest,
 * so the image's rustc is the one its tag names. Unchanged without a digest.
 */
export function buildDockerfile(dockerfile, repoDigests) {
  const digest = Array.isArray(repoDigests)
    ? repoDigests.find(
        (entry) => typeof entry === "string" && RUST_DIGEST.test(entry),
      )
    : undefined;
  if (digest === undefined) return dockerfile;
  const newline = dockerfile.indexOf("\n");
  return `FROM ${digest}${newline === -1 ? "" : dockerfile.slice(newline)}`;
}

export function imageName(dockerfile, rustVersion) {
  return `gd-rust-container:${sha256hex(`${dockerfile}\nrustc ${rustVersion}`).slice(0, 12)}`;
}

const RUST_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The RUST_VERSION from an image's `.Config.Env`, or null. */
export function rustVersionFromEnv(envArray) {
  if (!Array.isArray(envArray)) return null;
  for (const entry of envArray) {
    if (typeof entry !== "string" || !entry.startsWith("RUST_VERSION="))
      continue;
    const version = entry.slice("RUST_VERSION=".length);
    return RUST_VERSION.test(version) ? version : null;
  }
  return null;
}

/** The version from `rustc --version` output, or null. */
export function rustVersionFromRustc(stdout) {
  if (typeof stdout !== "string") return null;
  const match = /^rustc (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\s|$)/m.exec(
    stdout,
  );
  return match ? match[1] : null;
}

/**
 * A worktree path's comparable form. Never realpath: a removed worktree must
 * still map to the key its volumes were created under.
 */
export function normalizeWorktreePath(path, platform = process.platform) {
  if (platform === "win32") {
    const normalized = win32.resolve(path).replaceAll("\\", "/").toLowerCase();
    if (/^[a-z]:\/$/.test(normalized)) return normalized;
    return normalized.replace(/\/+$/, "");
  }
  const normalized = posix.resolve(path);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function worktreeKey(path, platform = process.platform) {
  const normalized = normalizeWorktreePath(path, platform);
  const last = normalized.split("/").filter(Boolean).pop() ?? "";
  const slug =
    last
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/^-+|-+$/g, "") || "tree";
  return `${slug}-${sha256hex(normalized).slice(0, 8)}`;
}

export function volumeNames(key) {
  return {
    src: `gd-rust-container-${key}-src`,
    target: `gd-rust-container-${key}-target`,
    cargo: "gd-rust-container-cargo",
  };
}

const EOL_META = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*)$/;

/**
 * The non-empty records of a NUL-separated listing, each split on its FIRST
 * tab only, since a path may hold tabs; `head` is null without a tab.
 */
function nulRecords(stdoutBuffer) {
  const records = [];
  let start = 0;
  while (start < stdoutBuffer.length) {
    let end = stdoutBuffer.indexOf(0, start);
    if (end === -1) end = stdoutBuffer.length;
    const record = stdoutBuffer.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(9);
    records.push({
      text: record.toString("utf8"),
      head: tab === -1 ? null : record.subarray(0, tab).toString("utf8"),
      path: record.subarray(tab + 1).toString("utf8"),
    });
  }
  return records;
}

/**
 * Rows of `git ls-files -z -co --exclude-standard --eol`; duplicates keep the
 * first. A record that does not parse throws: an unread row would drop a file.
 */
export function parseEolListing(stdoutBuffer) {
  const rows = [];
  const seen = new Set();
  for (const { text, head, path } of nulRecords(stdoutBuffer)) {
    const meta = head === null ? null : EOL_META.exec(head);
    if (meta === null) {
      throw new Error(
        `unreadable ls-files --eol record: ${JSON.stringify(text)}`,
      );
    }
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push({
      path,
      index: meta[1],
      worktree: meta[2],
      attrs: meta[3].split(/\s+/).filter(Boolean),
    });
  }
  return rows;
}

const MODE_RECORD = /^([0-7]{6}) [0-9a-f]{40,64} ([0-3])$/;

/**
 * Index modes from `git ls-files -z -s` (`<mode> <sha> <stage>\t<path>`),
 * path -> mode. An unmerged path takes stage 0, else 2 (ours), else its first
 * stage listed. An unreadable record throws.
 */
export function parseModeListing(stdoutBuffer) {
  const modes = new Map();
  const stages = new Map();
  const rank = (stage) => (stage === "0" ? 0 : stage === "2" ? 1 : 2);
  for (const { text, head, path } of nulRecords(stdoutBuffer)) {
    const meta = head === null ? null : MODE_RECORD.exec(head);
    if (meta === null) {
      throw new Error(`unreadable ls-files -s record: ${JSON.stringify(text)}`);
    }
    if (!stages.has(path) || rank(meta[2]) < rank(stages.get(path))) {
      stages.set(path, meta[2]);
      modes.set(path, meta[1]);
    }
  }
  return modes;
}

const RAW_ATTRS = new Set(["-text", "binary", "-crlf"]);
const CRLF_INDEX = new Set(["crlf", "mixed"]);

/**
 * Whether a file reaches the container LF-converted. `autocrlf` is the
 * worktree's core.autocrlf, null when unset. An explicit `text` or `eol=lf`
 * attribute converts unless the index blob already holds CRLF, because CI
 * checks that blob out unchanged; binary detection and the untracked/autocrlf
 * rule belong to the auto modes.
 */
export function needsLf({ index, worktree, attrs }, autocrlf = null) {
  if (attrs.some((attr) => RAW_ATTRS.has(attr))) return false;
  if (attrs.includes("eol=crlf")) return false;
  const auto = attrs.includes("text=auto");
  // git prints `eol=lf` only beside `text` or `text=auto`; the latter is auto.
  if (attrs.includes("text") || (attrs.includes("eol=lf") && !auto)) {
    return !CRLF_INDEX.has(index);
  }
  if (auto || autocrlf === "true" || autocrlf === "input") {
    return !CRLF_INDEX.has(index) && worktree !== "-text";
  }
  return false;
}

/** Drops each CR that is immediately followed by LF; a lone CR stays. */
export function toLf(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  let length = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) continue;
    out[length++] = buffer[i];
  }
  return out.subarray(0, length);
}

function pathProblem(path, allowReserved) {
  if (typeof path !== "string" || path === "") return "empty";
  if (path.includes("\\") || path.includes("\0")) return "backslash or NUL";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "absolute, or an empty, . or .. segment";
  }
  if (!allowReserved && segments[0] === RESERVED_DIR) return "reserved";
  return null;
}

/** A relative /-separated path outside the archive's control directory. */
export function validTreePath(path) {
  return pathProblem(path, false) === null;
}

// tauri's generate_context! embeds ../dist at compile time; CI writes the same stub.
export const STUB_DIST = {
  path: "dist/index.html",
  data: Buffer.from("<!doctype html>\n"),
};

const EXECUTABLE = "100755";
const REGULAR = "100644";
const SYMLINK = "120000";

/** A file's cache hash: its mode and bytes, so a mode-only change syncs. */
export function fileHash(mode, data) {
  return createHash("sha256").update(`${mode}\0`).update(data).digest("hex");
}

// Git for Windows checks a link blob's `/` separators out as `\`.
function linkText(target, platform) {
  if (platform !== "win32") return target;
  const text = Buffer.from(target);
  for (let i = 0; i < text.length; i++) if (text[i] === 0x5c) text[i] = 0x2f;
  return text;
}

/**
 * Reads the listed files as the container gets them (LF per needsLf, 100755
 * index entries executable). A tracked symlink (index mode 120000) checked out
 * as a link arrives as its target text, what a core.symlinks=false checkout
 * holds. Any other link or junction, a nested repository or another
 * non-regular path is skipped, and a tracked path gone from disk is missing (so
 * a delta deletes it), both reported; an invalid path or any other read error
 * throws.
 */
export function readTree(
  root,
  rows,
  {
    lstat = lstatSync,
    readFile = readFileSync,
    readlink = (path) => readlinkSync(path, { encoding: "buffer" }),
  } = {},
  { autocrlf = null, modes = new Map(), platform = process.platform } = {},
) {
  const files = new Map();
  const skipped = [];
  const missing = [];
  const symlinks = [];
  const gone = (err) => err?.code === "ENOENT" || err?.code === "ENOTDIR";
  for (const row of rows) {
    if (row.path.endsWith("/")) {
      skipped.push(row.path);
      continue;
    }
    if (!validTreePath(row.path)) {
      throw new Error(
        `listed path is not a valid tree path: ${JSON.stringify(row.path)}`,
      );
    }
    const full = join(root, row.path);
    const indexMode = modes.get(row.path);
    let raw;
    try {
      const stat = lstat(full);
      if (stat.isSymbolicLink?.() && indexMode === SYMLINK) {
        symlinks.push(row.path);
        const target = linkText(readlink(full), platform);
        files.set(row.path, {
          data: target,
          mode: REGULAR,
          hash: fileHash(REGULAR, target),
        });
        continue;
      }
      if (!stat.isFile()) {
        skipped.push(row.path);
        continue;
      }
      raw = readFile(full);
    } catch (err) {
      if (gone(err)) {
        missing.push(row.path);
        continue;
      }
      throw new Error(
        `cannot read ${JSON.stringify(row.path)} (${err?.code ?? err})`,
      );
    }
    if (indexMode === SYMLINK) symlinks.push(row.path);
    const mode = indexMode === EXECUTABLE ? EXECUTABLE : REGULAR;
    const data = needsLf(row, autocrlf) ? toLf(raw) : raw;
    files.set(row.path, { data, mode, hash: fileHash(mode, data) });
  }
  // CI overwrites dist/index.html with this stub whatever the checkout holds.
  files.set(STUB_DIST.path, {
    data: STUB_DIST.data,
    mode: REGULAR,
    hash: fileHash(REGULAR, STUB_DIST.data),
  });
  return { files, skipped, missing, symlinks };
}

/** The tracked paths absent from disk, less CI's stub, which every sync writes. */
export function absentPaths(tree) {
  return tree.missing.filter((path) => !tree.files.has(path)).sort();
}

const SYNC_ID = /^[0-9a-f]{32}$/;
const CACHE_VERSION = 4;

function cacheFiles(cache) {
  const files = cache?.files;
  if (files === null || typeof files !== "object" || Array.isArray(files))
    return null;
  for (const [path, hash] of Object.entries(files)) {
    if (!validTreePath(path) || typeof hash !== "string") return null;
  }
  return files;
}

function cacheMissing(cache) {
  const missing = cache?.missing;
  return Array.isArray(missing) && missing.every(validTreePath)
    ? missing
    : null;
}

/**
 * What to send: everything when the cache cannot vouch for the volume, else
 * only new or changed paths plus the cached paths that are gone. A cache
 * holding an unusable path list also means full: its deletes would be unsafe.
 */
export function planSync({ files, cache }) {
  const paths = [...files.keys()].sort();
  const cached =
    cache !== null &&
    typeof cache === "object" &&
    cache.version === CACHE_VERSION &&
    typeof cache.syncId === "string" &&
    SYNC_ID.test(cache.syncId) &&
    cacheMissing(cache) !== null
      ? cacheFiles(cache)
      : null;
  if (cached === null)
    return { mode: "full", prev: null, send: paths, deletes: [] };
  const send = paths.filter(
    (path) => !Object.hasOwn(cached, path) || cached[path] !== files.get(path),
  );
  const deletes = Object.keys(cached)
    .filter((path) => !files.has(path))
    .sort();
  return { mode: "delta", prev: cache.syncId, send, deletes };
}

/**
 * Whether the tracked paths missing from disk differ from those of the sync a
 * usable cache records: a reason to sync even when no file changed.
 */
export function missingChanged(cache, missing) {
  const now = [...missing].sort();
  const was = cache.missing;
  return was.length !== now.length || was.some((path, i) => path !== now[i]);
}

const BLOCK = 512;
// The ustar name of a pax-named member. A tar that ignored pax would extract
// it into the control directory, which the sync script removes.
const PAX_FALLBACK_NAME = `${RESERVED_DIR}/long-name`;

function octal(value, digits) {
  return `${value.toString(8).padStart(digits, "0")}\0`;
}

function ustarHeader(nameBytes, prefixBytes, size, typeflag, mode = 0o644) {
  const header = Buffer.alloc(BLOCK);
  nameBytes.copy(header, 0);
  header.write(octal(mode, 7), 100, "ascii");
  header.write(octal(0, 7), 108, "ascii");
  header.write(octal(0, 7), 116, "ascii");
  header.write(octal(size, 11), 124, "ascii");
  header.write(octal(0, 11), 136, "ascii");
  header.write(typeflag, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  prefixBytes.copy(header, 345);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function padded(data) {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

function splitName(nameBytes) {
  if (nameBytes.length <= 100)
    return { name: nameBytes, prefix: Buffer.alloc(0) };
  for (let i = 0; i < nameBytes.length; i++) {
    if (nameBytes[i] !== 0x2f) continue;
    const name = nameBytes.subarray(i + 1);
    if (name.length > 100) continue;
    if (i > 155) return null;
    return { name, prefix: nameBytes.subarray(0, i) };
  }
  return null;
}

function paxRecord(name) {
  const body = Buffer.byteLength(` path=${name}\n`);
  let length = body + 1;
  while (String(length).length + body !== length)
    length = String(length).length + body;
  return Buffer.from(`${length} path=${name}\n`);
}

/**
 * A POSIX ustar archive of `[{ name, data, mode? }]` in the given order (mode
 * defaults to 0644). Lengths are UTF-8 byte counts; a name no prefix/name
 * split fits rides a pax header.
 */
export function tarBuffer(entries) {
  const parts = [];
  for (const { name, data, mode = 0o644 } of entries) {
    const problem = pathProblem(name, true);
    if (problem !== null)
      throw new Error(
        `invalid archive member name ${JSON.stringify(name)}: ${problem}`,
      );
    if (data.length > 0o77777777777)
      throw new Error(`member too large: ${name}`);
    const nameBytes = Buffer.from(name);
    let split = splitName(nameBytes);
    if (split === null) {
      const record = paxRecord(name);
      parts.push(
        ustarHeader(
          Buffer.from(PAX_FALLBACK_NAME),
          Buffer.alloc(0),
          record.length,
          "x",
        ),
      );
      parts.push(...padded(record));
      split = { name: Buffer.from(PAX_FALLBACK_NAME), prefix: Buffer.alloc(0) };
    }
    parts.push(ustarHeader(split.name, split.prefix, data.length, "0", mode));
    parts.push(...padded(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

// Both scripts refuse (75) on any drift before they write, so a killed cargo's
// edits are never buried by a newer sync id.
const DRIFT_FN = `# Prints the synced paths that changed in the tree since the last completed sync, one per
# line: a synced file newer than .sync-id, a synced file gone, or a path that was absent on
# the host at that sync and exists now. Run in the tree; prints nothing for a volume without
# a manifest.
drift() {
  [ -f ../.sync-id ] && [ -f ../.sync-manifest ] || return 0
  local present
  present=$(mktemp)
  (
    export LC_ALL=C
    find . -type f -printf '%P\\0' | sort -z > "$present"
    find . -type f -newer ../.sync-id -printf '%P\\0' | sort -z | comm -z -12 - <(sort -z ../.sync-manifest)
    comm -z -13 "$present" <(sort -z ../.sync-manifest)
    if [ -f ../.sync-absent ]; then comm -z -12 "$present" <(sort -z ../.sync-absent); fi
  ) | tr '\\0' '\\n'
  rm -f "$present"
}
`;

// Run as `bash -c "$SYNC_SCRIPT" sync <full|delta> <volume root> <prev|-> <next>`
// with the archive on stdin; `.lock` (flock) keeps a second writer out (73).
// Nothing in the tree or .sync-id changes before the root guard, the end
// sentinel and the delta preconditions pass. Deletes run before extraction, so
// a file<->directory swap extracts cleanly; -m stamps the container's clock, so
// a changed file is newer than the last build whatever the host/VM clock skew.
export const SYNC_SCRIPT = `${DRIFT_FN}set -euo pipefail
mode=$1 vol=$2 prev=$3 next=$4
case $mode in full|delta) ;; *) echo "rust-container: sync: bad mode: $mode" >&2; exit 2 ;; esac
[[ $next =~ ^[0-9a-f]{32}$ ]] || { echo "rust-container: sync: bad sync id" >&2; exit 2; }
case $vol in /*) ;; *) echo "rust-container: sync: volume root must be absolute: $vol" >&2; exit 2 ;; esac
cd "$vol" || exit 2
if [ . -ef / ]; then echo "rust-container: sync: volume root resolves to /: $vol" >&2; exit 2; fi
exec 9> .lock
flock -n 9 || { echo "rust-container: sync: another run is using this source volume" >&2; exit 73; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/sync.tar"
[ "$(tar -x -O -f "$work/sync.tar" .gd-rust-container/end 2>/dev/null || true)" = "$next" ] \\
  || { echo "rust-container: sync: the archive is incomplete" >&2; exit 3; }
if [ "$mode" = delta ]; then
  if [ "$(cat .sync-id 2>/dev/null || true)" != "$prev" ] || [ ! -d tree ]; then
    echo "rust-container: sync: the volume does not match the host cache" >&2; exit 75
  fi
  if [ -n "$(cd tree && drift)" ]; then
    echo "rust-container: sync: the volume's tree changed since its last sync" >&2; exit 75
  fi
fi
rm -f .sync-id
if [ "$mode" = full ]; then rm -rf tree; mkdir tree; fi
cd tree
tar -x -O -f "$work/sync.tar" .gd-rust-container/deletes | xargs -0 -r rm -f --
find . -mindepth 1 -type d -empty -delete
tar -x -m -f "$work/sync.tar"
mv -f .gd-rust-container/manifest ../.sync-manifest
mv -f .gd-rust-container/absent ../.sync-absent
rm -rf .gd-rust-container
printf '%s\\n' "$next" > ../.sync-id
`;

// Run as `bash -c "$CARGO_SCRIPT" cargo-test <args...>` in the VOLUME ROOT (a
// missing -w dir would be created as root inside the volume), with a stdin the
// host keeps open: its EOF (the wrapper died) stops cargo. fd 3 keeps that stdin
// for the watcher; fd 9 holds the volume lock and is closed for both. A failure
// before cargo exits 74; drift before cargo exits 75, and drift cargo caused
// voids the sync id. Cargo's args stay positional.
export const CARGO_SCRIPT = `${DRIFT_FN}set -euo pipefail
exec 3<&0
trap 'exit 74' ERR
exec 9> .lock
flock -n 9 || { echo "rust-container: another run is using this source volume" >&2; exit 73; }
if [ "$(cat .sync-id 2>/dev/null || true)" != "\${GD_SYNC_ID:?}" ] || [ ! -d tree ]; then
  echo "rust-container: the source volume does not hold the expected sync" >&2; exit 75
fi
cd tree
if [ -n "$(drift)" ]; then
  echo "rust-container: the source volume's tree changed since its last sync" >&2; exit 75
fi
target=\${CARGO_TARGET_DIR:?}
marker="$target/.gd-rust-container-image"
if [ "$(cat "$marker" 2>/dev/null || true)" != "\${GD_IMAGE:?}" ]; then
  if [ -n "$(ls -A "$target")" ]; then
    echo "rust-container: the target volume holds another image's build; clearing it" >&2
    find "$target" -mindepth 1 -delete
  fi
  printf '%s\\n' "$GD_IMAGE" > "$marker"
fi
trap - ERR
cargo test --manifest-path src-tauri/Cargo.toml "$@" 9>&- &
cargo_pid=$!
trap 'kill -TERM "$cargo_pid" 2>/dev/null || true' INT TERM HUP
{ cat <&3; kill -TERM "$cargo_pid" || true; } > /dev/null 2>&1 9>&- &
set +e
wait "$cargo_pid"
code=$?
changed=$(drift)
set -e
if [ -n "$changed" ]; then
  rm -f ../.sync-id
  echo "rust-container: cargo changed $(printf '%s\\n' "$changed" | wc -l) synced path(s) in the source volume (first: \${changed%%$'\\n'*}); the next run does a full sync" >&2
fi
exit "$code"
`;

/** This package's duration format: seconds with one decimal. */
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Who holds the native lock, from its sidecar, named only while the recorded
 * wrapper is alive: a stale sidecar names a run that is over.
 */
export function nativeHolder(
  port,
  { sidecarDir = tmpdir(), isAlive = isPidAlive } = {},
) {
  const record = readSidecar(sidecarPath(port, sidecarDir));
  if (
    record !== null &&
    isAlive(record.wrapperPid) &&
    typeof record.suite === "string" &&
    typeof record.cwd === "string"
  ) {
    return `${record.suite} in ${record.cwd}`;
  }
  return "an unknown process";
}

/** The start-of-run line for one native sample (without the prefix). */
export function nativeStartLine(sample, port) {
  if (sample.state === "held") {
    return `native lock (port ${port}): HELD at start by ${sample.holder ?? "an unknown process"}`;
  }
  if (sample.state === "free")
    return `native lock (port ${port}): free at start`;
  return `native lock (port ${port}): unknown at start (${sample.reason ?? "unknown"})`;
}

/**
 * The run's summary line (without the prefix); any held sample wins. A free
 * verdict names the sampling, since a short native run can fall between two.
 */
export function nativeLockSummary(samples, port, intervalMs = 5000) {
  const n = samples.length;
  const held = samples.filter((sample) => sample.state === "held");
  if (held.length > 0) {
    const holders = [
      ...new Set(held.map((sample) => sample.holder ?? "an unknown process")),
    ];
    const first = `+${formatSeconds(held[0].atMs)}`;
    const last = `+${formatSeconds(held[held.length - 1].atMs)}`;
    return `native lock (port ${port}) was HELD during this run: ${held.length} of ${n} checks, first at ${first}, last at ${last} (${holders.join("; ")}); timings beside a native suite are not comparable to quiet ones`;
  }
  const unknown = samples.filter((sample) => sample.state === "unknown");
  if (unknown.length > 0) {
    return `native lock (port ${port}) was not seen held, but ${unknown.length} of ${n} checks could not tell (${unknown[0].reason ?? "unknown"})`;
  }
  return `native lock (port ${port}) was free at all ${n} checks during this run (sampled every ${intervalMs / 1000}s)`;
}

/**
 * Whether something listens on the port, by connecting: never binds it, so a
 * probe cannot block the lock's own holder.
 */
export function probePort(port, { host = "127.0.0.1", timeoutMs = 2000 } = {}) {
  return new Promise((done) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const timer = setTimeout(
      () => finish({ state: "unknown", reason: "timeout" }),
      timeoutMs,
    );
    socket.once("connect", () => finish({ state: "held" }));
    socket.once("error", (err) =>
      finish(
        err?.code === "ECONNREFUSED"
          ? { state: "free" }
          : { state: "unknown", reason: err?.code ?? String(err) },
      ),
    );
  });
}

const EMPTY = Buffer.alloc(0);
const CHUNK = 1 << 20;
const SRC_MOUNT = "/home/builder/src";
const LABEL = "gd.rust-container";
const WORKTREE_LABEL = `${LABEL}.worktree`;
const PLATFORM_LABEL = `${LABEL}.platform`;
const NS_LABEL = `${LABEL}.ns`;
const MISMATCH = 75;
const PRE_CARGO_FAILED = 74;
const SOURCE_LOCKED = 73;
const SOURCE_LOCKED_LINE =
  "another run is using this worktree's source volume (its lock is held inside the volume)";
const START_FAILURES = new Set([125, 126, 127]);
const SHORT_TIMEOUT_MS = 120_000;
// How long a bounded call that exited waits for its pipes to close.
const EXIT_GRACE_MS = 5000;
// Removals and the optional daily pull may run long but never hold the lock
// forever; the mandatory pull and the build stay unbounded.
const LONG_TIMEOUT_MS = 600_000;
// Docker's wording for an absent object; any other inspect failure is fatal.
const MISSING_OBJECT = /no such (image|volume|object)/i;
// A hook's env must not redirect the listing to another repository or index.
const STRIPPED_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
]);

class Failure extends Error {}
const STOPPED = Symbol("stopped");

function firstLine(output) {
  const text = String(output ?? "").trim();
  return text === "" ? "no output" : text.split(/\r?\n/)[0];
}

function exitText(result) {
  if (result.error) return result.error.code ?? String(result.error);
  return result.code ?? `signal ${result.signal}`;
}

/** Why a docker call failed: its timeout, its spawn error or its stderr. */
function failureReason(result, timeoutMs) {
  if (result.timedOut) return `timed out after ${formatSeconds(timeoutMs)}`;
  return result.error ? exitText(result) : firstLine(result.stderr);
}

/** Docker could not run, or could not start the role's container. */
function refuseStartFailure(result, role) {
  if (result.error) {
    throw new Failure(`could not run docker (${exitText(result)})`);
  }
  if (START_FAILURES.has(result.code)) {
    throw new Failure(
      `${role} container could not start (docker exit ${result.code})`,
    );
  }
}

function outputLines(buffer) {
  return String(buffer ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function waitWritable(stream) {
  return new Promise((done) => {
    const finish = () => {
      stream.off("drain", finish);
      stream.off("error", finish);
      stream.off("close", finish);
      done();
    };
    stream.on("drain", finish);
    stream.on("error", finish);
    stream.on("close", finish);
  });
}

/**
 * Runs `docker <args>` without a shell. `input` is written with backpressure
 * and `stdinError` reports a write that did not finish; `holdStdin` opens a
 * pipe that is never written and closes only once docker exits; `timeoutMs`
 * kills a call that runs longer and reports `timedOut`. A bounded call that
 * exits settles within `graceMs` even while a descendant holds its pipes.
 */
export function spawnDocker(
  args,
  {
    input,
    holdStdin = false,
    inherit = false,
    onStart,
    timeoutMs,
    graceMs = EXIT_GRACE_MS,
  } = {},
) {
  return new Promise((done) => {
    const piped = input !== undefined || holdStdin;
    const output = inherit ? "inherit" : "pipe";
    let child;
    try {
      child = spawn("docker", args, {
        stdio: [piped ? "pipe" : "ignore", output, output],
        windowsHide: true,
      });
    } catch (error) {
      done({ code: null, signal: null, error, stdout: EMPTY, stderr: EMPTY });
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    let stdinError = null;
    let written = false;
    if (piped) child.stdin.on("error", (err) => (stdinError ??= err));
    if (input !== undefined) {
      (async () => {
        for (let at = 0; at < input.length; at += CHUNK) {
          if (stdinError || child.stdin.destroyed) return;
          if (!child.stdin.write(input.subarray(at, at + CHUNK))) {
            await waitWritable(child.stdin);
          }
        }
        if (stdinError || child.stdin.destroyed) return;
        child.stdin.end((err) => {
          written = !err && stdinError === null;
        });
      })().catch((err) => (stdinError ??= err));
    }
    // A child that exits while the loop is blocked past the deadline can read
    // as timed out: the timer may run before the exit callback.
    let timedOut = false;
    let grace = null;
    const timer =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (piped) child.stdin.destroy();
      done({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdinError:
          input === undefined || written
            ? null
            : (stdinError ?? new Error("stdin was not fully written")),
        timedOut,
        ...result,
      });
    };
    child.once("error", (error) => settle({ code: null, signal: null, error }));
    // A descendant still holding the pipes would keep 'close' from ever
    // firing, so a bounded call settles on exit: at once when it timed out,
    // else after the grace.
    const settleOnExit = (code, signal) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ code, signal });
    };
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (holdStdin) child.stdin.destroy();
      if (timedOut) settleOnExit(code, signal);
      else if (timeoutMs !== undefined) {
        grace = setTimeout(() => settleOnExit(code, signal), graceMs);
      }
    });
    child.once("close", (code, signal) => settle({ code, signal }));
    onStart?.({ pid: child.pid, kill: () => child.kill() });
  });
}

function runGit(root, env, args) {
  return new Promise((done, fail) => {
    const child = spawn("git", args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (err) =>
      fail(new Error(`git could not run (${err?.code ?? err})`)),
    );
    child.once("close", (code, signal) =>
      done({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

// git's own bool-or-str parse: a valueless key reads true, an empty value
// false, any nonzero integer true; only true, false and input remain.
const AUTOCRLF_VALUES = new Set(["true", "false", "input"]);

/**
 * The worktree as git lists it: `--eol` rows, index modes and core.autocrlf
 * ("true" | "input" | "false" | null when unset). Async, so a Ctrl+C during a
 * listing reaches the stop handler first; a hook's GIT_* env must not
 * redirect it to another repository or index.
 */
export async function listWorktree(root, env = process.env) {
  const childEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!STRIPPED_GIT_ENV.has(name.toUpperCase())) childEnv[name] = value;
  }
  const listed = async (args) => {
    const result = await runGit(root, childEnv, args);
    if (result.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} exited ${result.code ?? result.signal} (${firstLine(result.stderr)})`,
      );
    }
    return result.stdout;
  };
  const eol = await listed([
    "ls-files",
    "-z",
    "-co",
    "--exclude-standard",
    "--eol",
  ]);
  const stage = await listed(["ls-files", "-z", "-s"]);
  const config = await runGit(root, childEnv, [
    "config",
    "--get",
    "--type=bool-or-str",
    "core.autocrlf",
  ]);
  const text = String(config.stdout);
  let autocrlf;
  if (config.code === 1 && text === "") {
    autocrlf = null;
  } else if (config.code === 0) {
    const value = text.trim().toLowerCase();
    if (!AUTOCRLF_VALUES.has(value)) {
      throw new Error(
        `unreadable core.autocrlf ${JSON.stringify(text.trim())}`,
      );
    }
    autocrlf = value;
  } else {
    throw new Error(
      `git config --get core.autocrlf exited ${config.code ?? config.signal} (${firstLine(config.stderr)})`,
    );
  }
  return { eol, stage, autocrlf };
}

function context(deps) {
  const platform = deps.platform ?? process.platform;
  const sidecarDir = deps.sidecarDir ?? tmpdir();
  const isAlive = deps.isAlive ?? isPidAlive;
  return {
    platform,
    sidecarDir,
    isAlive,
    env: deps.env ?? process.env,
    log: deps.log ?? defaultLog,
    repoRoot: resolve(deps.repoRoot ?? REPO_ROOT),
    cacheDir: deps.cacheDir ?? join(tmpdir(), "gitdesktop-rust-container"),
    docker: deps.docker ?? spawnDocker,
    listTree: deps.listTree ?? listWorktree,
    treeFs: deps.treeFs ?? { lstat: lstatSync, readFile: readFileSync },
    fs: {
      readFile: readFileSync,
      writeFile: writeFileSync,
      rename: renameSync,
      rm: rmSync,
      mkdir: mkdirSync,
      ...deps.fs,
    },
    acquire: deps.acquire ?? acquireLock,
    probe: deps.probe ?? probePort,
    holderOf:
      deps.holderOf ?? ((port) => nativeHolder(port, { sidecarDir, isAlive })),
    now: deps.now ?? Date.now,
    setTimer: deps.setTimer ?? setTimeout,
    clearTimer: deps.clearTimer ?? clearTimeout,
    monitorMs: deps.monitorMs ?? 5000,
    shortTimeoutMs: deps.shortTimeoutMs ?? SHORT_TIMEOUT_MS,
    longTimeoutMs: deps.longTimeoutMs ?? LONG_TIMEOUT_MS,
    randomHex:
      deps.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex")),
    exists: deps.exists ?? existsSync,
    signals: deps.signals ?? process,
    pid: deps.pid ?? process.pid,
  };
}

function say(ctx, line) {
  ctx.log(`${PREFIX}${line}`);
}

function reportFailure(ctx, err) {
  say(ctx, err instanceof Failure ? err.message : (err?.stack ?? err));
}

function lockLog(ctx) {
  return (line) =>
    ctx.log(
      line.startsWith("full-suite: ")
        ? `${PREFIX}${line.slice("full-suite: ".length)}`
        : line,
    );
}

function acquireFor(ctx, port, suite) {
  return ctx.acquire({
    port,
    sidecarFile: join(ctx.sidecarDir, `gitdesktop-rust-container-${port}.json`),
    record: { wrapperPid: ctx.pid, suite, cwd: ctx.repoRoot },
    isAlive: ctx.isAlive,
    platform: ctx.platform,
    log: lockLog(ctx),
  });
}

/** First sample at once, then one every monitorMs, never two at a time. */
function nativeMonitor(ctx, port, startMs) {
  const samples = [];
  let timer = null;
  let inFlight = null;
  let finished = false;
  const sample = async () => {
    const atMs = ctx.now() - startMs;
    let result;
    try {
      result = await ctx.probe(port);
    } catch (err) {
      result = { state: "unknown", reason: err?.code ?? String(err) };
    }
    const entry = { atMs, ...result };
    if (entry.state === "held") entry.holder = ctx.holderOf(port);
    samples.push(entry);
    return entry;
  };
  const schedule = () => {
    if (finished) return;
    timer = ctx.setTimer(() => {
      timer = null;
      inFlight = sample().then(() => {
        inFlight = null;
        schedule();
      });
    }, ctx.monitorMs);
    timer?.unref?.();
  };
  return {
    async begin() {
      say(ctx, nativeStartLine(await sample(), port));
      schedule();
    },
    async finish() {
      finished = true;
      if (timer !== null) ctx.clearTimer(timer);
      if (inFlight) await inFlight;
      await sample();
      say(ctx, nativeLockSummary(samples, port, ctx.monitorMs));
    },
  };
}

function stopSignals(platform) {
  return platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
}

function containerName(ctx, run, role) {
  return `gd-rust-container-${run.key}-${ctx.pid}-${role}-${ctx.randomHex(3)}`;
}

// A degraded run's containers carry no port label, so a later normal holder
// never reaps them as orphans while they still run. The ns label scopes the
// reaper to the lock's loopback: a WSL run binds its own copy of the port.
// ns is the platform, so two Linux loopbacks sharing one daemon are not told apart.
function labels(ctx, held, port) {
  return [
    "--label",
    `${LABEL}=1`,
    "--label",
    held.degraded ? `${LABEL}.degraded=1` : `${LABEL}.port=${port}`,
    "--label",
    `${NS_LABEL}=${ctx.platform}`,
  ];
}

// A hung daemon must not hold the lock forever: short calls are bounded, and
// one that runs out fails the run.
async function dockerShort(ctx, args) {
  const result = await ctx.docker(args, { timeoutMs: ctx.shortTimeoutMs });
  if (result.timedOut) {
    const verb = ["image", "volume"].includes(args[0])
      ? args.slice(0, 2)
      : args.slice(0, 1);
    throw new Failure(
      `\`docker ${verb.join(" ")}\` timed out after ${formatSeconds(ctx.shortTimeoutMs)}`,
    );
  }
  return result;
}

/** True when an inspect found nothing; any other failed inspect throws. */
function inspectMissing(result, what) {
  if (result.code === 0 && !result.error) return false;
  if (!result.error && MISSING_OBJECT.test(String(result.stderr))) return true;
  throw new Failure(`\`docker ${what}\` failed (${failureReason(result)})`);
}

// Long-lived children (pull, build, sync, cargo) are the ones a stop kills
// and the lock's sidecar names.
async function dockerLong(ctx, run, args, options = {}) {
  if (run.stopped) throw STOPPED;
  const result = await ctx.docker(args, {
    ...options,
    onStart: (child) => {
      run.current = { ...child, name: options.name };
      run.held.setChild(child.pid);
      if (run.stopped) stopCurrent(ctx, run);
    },
  });
  run.current = null;
  if (run.stopped) throw STOPPED;
  return result;
}

// Only this run's own container is removed: other runs' containers are reaped
// by the next non-degraded lock holder, never here.
function stopCurrent(ctx, run) {
  const current = run.current;
  if (current === null) return;
  try {
    current.kill();
  } catch {}
  if (current.name && !run.removing.has(current.name)) {
    run.removing.add(current.name);
    run.removals.push(
      Promise.resolve()
        .then(() => dockerShort(ctx, ["rm", "-f", current.name]))
        .catch(() => {}),
    );
  }
}

async function reapOrphans(ctx, held, port) {
  if (held.degraded) {
    say(
      ctx,
      `lock degraded (port ${port} could not be bound); not removing orphaned containers`,
    );
    return;
  }
  const listed = await dockerShort(ctx, [
    "ps",
    "-aq",
    "--filter",
    `label=${LABEL}.port=${port}`,
    "--filter",
    `label=${NS_LABEL}=${ctx.platform}`,
  ]);
  if (listed.code !== 0) {
    say(
      ctx,
      `could not list orphaned containers (${firstLine(listed.stderr)}); continuing`,
    );
    return;
  }
  const ids = outputLines(listed.stdout);
  if (ids.length === 0) return;
  const removed = await dockerShort(ctx, ["rm", "-f", ...ids]);
  if (removed.code === 0) {
    say(
      ctx,
      `removed ${ids.length} orphaned container(s) left by a killed run`,
    );
  } else {
    say(
      ctx,
      `could not remove orphaned containers (${firstLine(removed.stderr)}); continuing`,
    );
  }
}

async function inspectRust1(ctx) {
  const result = await dockerShort(ctx, ["image", "inspect", "rust:1"]);
  if (inspectMissing(result, "image inspect rust:1")) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout))[0];
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Failure("cannot read `docker image inspect rust:1` output");
  }
  return {
    id: parsed.Id ?? null,
    env: parsed.Config?.Env ?? null,
    repoDigests: parsed.RepoDigests ?? null,
  };
}

function dailyFile(ctx) {
  return join(ctx.cacheDir, "rust1-pull.json");
}

function readJson(ctx, file) {
  try {
    return JSON.parse(String(ctx.fs.readFile(file)));
  } catch {
    return null;
  }
}

function writeJsonAtomic(ctx, file, value) {
  ctx.fs.mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${ctx.pid}.tmp`;
  try {
    ctx.fs.writeFile(temp, JSON.stringify(value));
    ctx.fs.rename(temp, file);
  } catch (err) {
    try {
      ctx.fs.rm(temp, { force: true });
    } catch {}
    throw err;
  }
}

function lastDailyCheck(ctx) {
  const state = readJson(ctx, dailyFile(ctx));
  return typeof state?.utcDate === "string" ? state.utcDate : null;
}

function recordDailyCheck(ctx, today) {
  try {
    writeJsonAtomic(ctx, dailyFile(ctx), { utcDate: today });
  } catch (err) {
    say(ctx, `could not record the daily rust:1 check (${err?.code ?? err})`);
  }
}

async function ensureRust1(ctx, run) {
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  let rust = await inspectRust1(ctx);
  if (rust === null) {
    say(ctx, "rust:1 is not pulled; pulling it");
    const pulled = await dockerLong(ctx, run, ["pull", "rust:1"]);
    if (pulled.code !== 0) {
      throw new Failure(`could not pull rust:1 (${failureReason(pulled)})`);
    }
    recordDailyCheck(ctx, today);
    rust = await inspectRust1(ctx);
    if (rust === null)
      throw new Failure("rust:1 is still not pulled after a pull");
    return rust;
  }
  if (lastDailyCheck(ctx) === today) return rust;
  const pulled = await dockerLong(ctx, run, ["pull", "rust:1"], {
    timeoutMs: ctx.longTimeoutMs,
  });
  recordDailyCheck(ctx, today);
  if (pulled.timedOut || pulled.code !== 0) {
    say(
      ctx,
      `daily rust:1 check failed (${failureReason(pulled, ctx.longTimeoutMs)}); using the local rust:1`,
    );
    return rust;
  }
  const after = await inspectRust1(ctx);
  if (after === null)
    throw new Failure("rust:1 is still not pulled after a pull");
  if (after.id === rust.id) {
    say(ctx, "daily rust:1 check: up to date");
    return after;
  }
  // Docker Desktop's containerd store reports the index digest as .Id, which a
  // re-tag of identical content changes, so the line says what rustc did.
  const before = rustVersionFromEnv(rust.env) ?? "unknown";
  const newVersion = rustVersionFromEnv(after.env) ?? "unknown";
  say(
    ctx,
    `daily rust:1 check: pulled a newer rust:1 (${before === newVersion ? `rustc ${newVersion}, unchanged` : `rustc ${before} -> ${newVersion}`})`,
  );
  return after;
}

async function rustVersionOf(ctx, rust, labelArgs) {
  const fromEnv = rustVersionFromEnv(rust.env);
  if (fromEnv !== null) return fromEnv;
  const result = await dockerShort(ctx, [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--network",
    "none",
    ...labelArgs,
    "rust:1",
    "rustc",
    "--version",
  ]);
  const version =
    result.code === 0 ? rustVersionFromRustc(String(result.stdout)) : null;
  if (version === null) throw new Failure("cannot tell rust:1's rustc version");
  return version;
}

/** The image's `.Id`, or null when it is not built. */
async function imageId(ctx, image) {
  const result = await dockerShort(ctx, [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ]);
  if (inspectMissing(result, `image inspect ${image}`)) return null;
  const id = String(result.stdout).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new Failure(`cannot read the id of image ${image}`);
  }
  return id;
}

/**
 * Builds the image when it is missing; resolves its ID, which marks the
 * target volume (a rebuild under the same tag then clears it once).
 */
async function ensureImage(ctx, run, image, version, repoDigests) {
  const present = await imageId(ctx, image);
  if (present !== null) {
    say(ctx, `image ${image} (rustc ${version}) ready`);
    return present;
  }
  say(ctx, `building image ${image} (rustc ${version})`);
  const started = ctx.now();
  const built = await dockerLong(
    ctx,
    run,
    [
      "build",
      "--label",
      `${LABEL}=1`,
      "--label",
      `${LABEL}.rustc=${version}`,
      "-t",
      image,
      "-",
    ],
    {
      input: Buffer.from(buildDockerfile(DOCKERFILE, repoDigests)),
      inherit: true,
    },
  );
  if (built.error) {
    throw new Failure(`could not run docker (${exitText(built)})`);
  }
  if (built.code !== 0) {
    throw new Failure(`image build failed (exit ${exitText(built)})`);
  }
  say(ctx, `image built in ${formatSeconds(ctx.now() - started)}`);
  const id = await imageId(ctx, image);
  if (id === null)
    throw new Failure(`image ${image} is missing after its build`);
  return id;
}

function foreignVolume(name, role, found, root, platform) {
  if (role === "cargo") {
    return `the shared volume ${name} exists without this tool's label; remove it with docker volume rm ${name}`;
  }
  const worktree = found[WORKTREE_LABEL];
  if (typeof worktree !== "string") {
    return `volume ${name} exists but is not this worktree's (worktree label: none); remove it with docker volume rm ${name}`;
  }
  if (normalizeWorktreePath(worktree, platform) === root) {
    return `volume ${name} is not labeled ${LABEL}=1; remove it with docker volume rm ${name}`;
  }
  return `volume ${name} exists but is not this worktree's (worktree label: ${worktree}); remove it with docker volume rm ${name} or run node scripts/rust-container.mjs clean --worktree ${worktree}`;
}

/**
 * Creates missing volumes; an existing one is used only when its labels say
 * it is ours, since the cargo script clears a target volume it does not know.
 */
async function ensureVolumes(ctx, names) {
  const root = normalizeWorktreePath(ctx.repoRoot, ctx.platform);
  for (const role of ["src", "target", "cargo"]) {
    const name = names[role];
    const found = await volumeLabels(ctx, name);
    if (found !== null) {
      const worktree = found[WORKTREE_LABEL];
      const owned =
        found[LABEL] === "1" &&
        (role === "cargo" ||
          (typeof worktree === "string" &&
            normalizeWorktreePath(worktree, ctx.platform) === root));
      if (!owned) {
        throw new Failure(foreignVolume(name, role, found, root, ctx.platform));
      }
      continue;
    }
    const created = await dockerShort(ctx, [
      "volume",
      "create",
      "--label",
      `${LABEL}=1`,
      "--label",
      `${LABEL}.role=${role}`,
      ...(role === "cargo"
        ? []
        : [
            "--label",
            `${WORKTREE_LABEL}=${ctx.repoRoot}`,
            "--label",
            `${PLATFORM_LABEL}=${ctx.platform}`,
          ]),
      name,
    ]);
    if (created.code !== 0) {
      throw new Failure(
        `could not create volume ${name} (${firstLine(created.stderr)})`,
      );
    }
  }
}

function cacheFile(ctx, srcVolume) {
  return join(ctx.cacheDir, `sync-${srcVolume}.json`);
}

function dropCache(ctx, run) {
  try {
    ctx.fs.rm(cacheFile(ctx, run.names.src), { force: true });
  } catch {}
}

async function readWorktree(ctx) {
  let listed;
  let rows;
  let modes;
  try {
    listed = await ctx.listTree(ctx.repoRoot, ctx.env);
    rows = parseEolListing(listed.eol);
    modes = parseModeListing(listed.stage);
  } catch (err) {
    throw new Failure(`cannot list the worktree: ${err?.message ?? err}`);
  }
  let tree;
  try {
    tree = readTree(ctx.repoRoot, rows, ctx.treeFs, {
      autocrlf: listed.autocrlf,
      modes,
      platform: ctx.platform,
    });
  } catch (err) {
    throw new Failure(`cannot read the worktree: ${err?.message ?? err}`);
  }
  if (tree.symlinks.length > 0) {
    say(
      ctx,
      `sync: ${tree.symlinks.length} tracked symlink(s) arrive as regular files (first: ${tree.symlinks[0]})`,
    );
  }
  if (tree.skipped.length > 0) {
    say(
      ctx,
      `sync: skipped ${tree.skipped.length} listed path(s) that are not regular files (first: ${tree.skipped[0]})`,
    );
  }
  if (tree.missing.length > 0) {
    say(
      ctx,
      `sync: ${tree.missing.length} tracked path(s) missing from disk are treated as deleted (first: ${tree.missing[0]})`,
    );
  }
  return tree;
}

function hashes(tree) {
  return new Map([...tree.files].map(([path, file]) => [path, file.hash]));
}

const nulJoined = (paths) =>
  Buffer.from(
    [...paths]
      .sort()
      .map((path) => `${path}\0`)
      .join(""),
  );

/**
 * One sync container: "synced" on a verified sync, "mismatch" on exit 75,
 * and for a delta, "failed" on any other container exit but 73 (the caller
 * retries in full); every other failure throws.
 */
async function sendSync(ctx, run, tree, plan, ports) {
  const next = ctx.randomHex(16);
  const absent = absentPaths(tree);
  const archive = tarBuffer([
    // Absent paths too: `rm -f` clears a copy cargo generated since, and a
    // path the volume lacks is harmless.
    {
      name: `${RESERVED_DIR}/deletes`,
      data: nulJoined(new Set([...plan.deletes, ...absent])),
    },
    ...plan.send.map((path) => {
      const file = tree.files.get(path);
      return {
        name: path,
        data: file.data,
        mode: file.mode === EXECUTABLE ? 0o755 : 0o644,
      };
    }),
    // Every path of the file set, and the tracked paths absent from disk, so
    // the scripts can tell a synced file cargo changed, or a deleted one it
    // regenerated, from a file cargo generated.
    { name: `${RESERVED_DIR}/manifest`, data: nulJoined(tree.files.keys()) },
    { name: `${RESERVED_DIR}/absent`, data: nulJoined(absent) },
    { name: `${RESERVED_DIR}/end`, data: Buffer.from(next) },
  ]);
  const name = containerName(ctx, run, "sync");
  const result = await dockerLong(
    ctx,
    run,
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "-i",
      "--init",
      "--network",
      "none",
      "--name",
      name,
      ...labels(ctx, run.held, ports.container),
      "-v",
      `${run.names.src}:${SRC_MOUNT}`,
      run.imageId,
      "bash",
      "-c",
      SYNC_SCRIPT,
      "sync",
      plan.mode,
      SRC_MOUNT,
      plan.prev ?? "-",
      next,
    ],
    { input: archive, inherit: true, name },
  );
  refuseStartFailure(result, "sync");
  if (result.code === SOURCE_LOCKED) throw new Failure(SOURCE_LOCKED_LINE);
  if (result.code === MISMATCH) return "mismatch";
  if (result.code === 0 && result.stdinError) {
    throw new Failure(
      `sync failed: the archive was not fully written (${result.stdinError.code ?? result.stdinError.message})`,
    );
  }
  if (plan.mode === "delta" && result.code !== 0 && !result.stdinError) {
    say(
      ctx,
      `sync (delta) failed (exit ${exitText(result)}); retrying with a full sync`,
    );
    return "failed";
  }
  if (result.code !== 0 || result.stdinError) {
    throw new Failure(`sync failed (exit ${exitText(result)})`);
  }
  // Written only after a verified sync: the volume's id check turns a failed
  // write into a full sync next time.
  try {
    writeJsonAtomic(ctx, cacheFile(ctx, run.names.src), {
      version: CACHE_VERSION,
      syncId: next,
      files: Object.fromEntries(hashes(tree)),
      missing: [...tree.missing].sort(),
    });
  } catch (err) {
    say(
      ctx,
      `could not write the sync cache (${err?.code ?? err}); the next run does a full sync`,
    );
  }
  run.syncId = next;
  return "synced";
}

function syncLine(ctx, plan, tree, startedMs) {
  const took = formatSeconds(ctx.now() - startedMs);
  if (plan.mode === "full") {
    return `sync (full): ${plan.send.length} files sent in ${took}`;
  }
  const unchanged = tree.files.size - plan.send.length;
  return `sync (delta): ${plan.send.length} changed, ${plan.deletes.length} deleted, ${unchanged} unchanged in ${took}`;
}

async function fullSync(ctx, run, ports, startedMs) {
  const plan = planSync({ files: hashes(run.tree), cache: null });
  if ((await sendSync(ctx, run, run.tree, plan, ports)) !== "synced") {
    throw new Failure(
      "the source volume still does not match after a full sync",
    );
  }
  say(ctx, syncLine(ctx, plan, run.tree, startedMs));
}

function resyncAfterMismatch(ctx, run) {
  say(
    ctx,
    "source volume does not match this worktree's sync cache; doing a full sync",
  );
  dropCache(ctx, run);
}

/** Brings the source volume to the worktree; returns whether it synced. */
async function syncTree(ctx, run, ports) {
  const started = ctx.now();
  run.tree = await readWorktree(ctx);
  if (run.stopped) throw STOPPED;
  const cached = readJson(ctx, cacheFile(ctx, run.names.src));
  const plan = planSync({ files: hashes(run.tree), cache: cached });
  if (
    plan.mode === "delta" &&
    plan.send.length === 0 &&
    plan.deletes.length === 0 &&
    !missingChanged(cached, run.tree.missing)
  ) {
    run.syncId = plan.prev;
    say(
      ctx,
      `sync (delta): nothing changed (${run.tree.files.size} files) in ${formatSeconds(ctx.now() - started)}`,
    );
    return false;
  }
  const outcome = await sendSync(ctx, run, run.tree, plan, ports);
  if (outcome === "synced") {
    say(ctx, syncLine(ctx, plan, run.tree, started));
    return true;
  }
  if (outcome === "mismatch") resyncAfterMismatch(ctx, run);
  else dropCache(ctx, run);
  await fullSync(ctx, run, ports, started);
  return true;
}

/** One cargo container; resolves its exit code, or MISMATCH on exit 75. */
async function runCargo(ctx, run, args, ports) {
  const name = containerName(ctx, run, "test");
  const started = ctx.now();
  const result = await dockerLong(
    ctx,
    run,
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "-i",
      "--init",
      "--name",
      name,
      ...labels(ctx, run.held, ports.container),
      "-v",
      `${run.names.cargo}:/home/builder/.cargo-home`,
      "-v",
      `${run.names.target}:/home/builder/target`,
      "-v",
      `${run.names.src}:${SRC_MOUNT}`,
      "-w",
      SRC_MOUNT,
      "-e",
      `GD_IMAGE=${run.imageId}`,
      "-e",
      `GD_SYNC_ID=${run.syncId}`,
      run.imageId,
      "bash",
      "-c",
      CARGO_SCRIPT,
      "cargo-test",
      ...args,
    ],
    { holdStdin: true, inherit: true, name },
  );
  refuseStartFailure(result, "cargo");
  if (result.code === SOURCE_LOCKED) throw new Failure(SOURCE_LOCKED_LINE);
  if (result.code === PRE_CARGO_FAILED) {
    throw new Failure(
      `the cargo container failed before cargo started (exit ${PRE_CARGO_FAILED})`,
    );
  }
  if (result.code === MISMATCH) return MISMATCH;
  say(
    ctx,
    `cargo test exited ${exitText(result)} after ${formatSeconds(ctx.now() - started)}`,
  );
  return result.code ?? 1;
}

async function testSteps(ctx, run, args, ports) {
  await reapOrphans(ctx, run.held, ports.container);
  if (run.stopped) throw STOPPED;
  const rust = await ensureRust1(ctx, run);
  const version = await rustVersionOf(
    ctx,
    rust,
    labels(ctx, run.held, ports.container),
  );
  const image = imageName(DOCKERFILE, version);
  run.imageId = await ensureImage(ctx, run, image, version, rust.repoDigests);
  if (run.stopped) throw STOPPED;
  await ensureVolumes(ctx, run.names);
  if (run.stopped) throw STOPPED;
  const synced = await syncTree(ctx, run, ports);
  const code = await runCargo(ctx, run, args, ports);
  if (code !== MISMATCH) return code;
  if (synced) {
    throw new Failure(
      "the source volume does not hold this run's sync; is another run using it?",
    );
  }
  resyncAfterMismatch(ctx, run);
  await fullSync(ctx, run, ports, ctx.now());
  const retried = await runCargo(ctx, run, args, ports);
  if (retried === MISMATCH) {
    throw new Failure("the source volume does not hold this run's sync");
  }
  return retried;
}

async function runTest(ctx, args, ports, startMs) {
  const held = await acquireFor(ctx, ports.container, "test");
  const key = worktreeKey(ctx.repoRoot, ctx.platform);
  const run = {
    held,
    key,
    names: volumeNames(key),
    stopped: false,
    current: null,
    removing: new Set(),
    removals: [],
  };
  const onStop = () => {
    run.stopped = true;
    stopCurrent(ctx, run);
  };
  const signals = stopSignals(ctx.platform);
  for (const signal of signals) ctx.signals.on(signal, onStop);
  const monitor = nativeMonitor(ctx, ports.native, startMs);
  let code = null;
  try {
    await monitor.begin();
    code = await testSteps(ctx, run, args, ports);
  } catch (err) {
    if (err !== STOPPED && !run.stopped) {
      reportFailure(ctx, err);
      code = 2;
    }
  } finally {
    await Promise.all(run.removals);
    await monitor.finish();
    await held.release();
    for (const signal of signals) ctx.signals.removeListener(signal, onStop);
  }
  // A stop never reads as a pass, nor as a setup failure it caused.
  if (run.stopped && !(code !== null && code !== 0)) code = 1;
  say(ctx, `done in ${formatSeconds(ctx.now() - startMs)} (exit ${code})`);
  return code;
}

async function labeledVolumes(ctx) {
  const listed = await dockerShort(ctx, [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=${LABEL}=1`,
  ]);
  if (listed.code !== 0) {
    throw new Failure(`cannot list volumes (${firstLine(listed.stderr)})`);
  }
  const volumes = [];
  for (const name of outputLines(listed.stdout)) {
    const labelsOf = await volumeLabels(ctx, name);
    if (labelsOf !== null) volumes.push({ name, labels: labelsOf });
  }
  return volumes;
}

/** A volume's labels ({} for `Labels: null`), or null when it is missing. */
async function volumeLabels(ctx, name) {
  const inspected = await dockerShort(ctx, ["volume", "inspect", name]);
  if (inspectMissing(inspected, `volume inspect ${name}`)) return null;
  let entry;
  try {
    entry = JSON.parse(String(inspected.stdout))[0];
  } catch {
    throw new Failure(`cannot read \`docker volume inspect ${name}\` output`);
  }
  if (entry === undefined) return null;
  const found = entry?.Labels;
  return found !== null && typeof found === "object" ? found : {};
}

/** Labeled images as `{ id, ref }`; `ref` is the ID for an untagged one. */
async function labeledImages(ctx) {
  const listed = await dockerShort(ctx, [
    "image",
    "ls",
    "--no-trunc",
    "--filter",
    `label=${LABEL}=1`,
    "--format",
    "{{.ID}} {{.Repository}}:{{.Tag}}",
  ]);
  if (listed.code !== 0) {
    throw new Failure(`cannot list images (${firstLine(listed.stderr)})`);
  }
  return outputLines(listed.stdout).map((line) => {
    const [id, ref = ""] = line.split(" ");
    return { id, ref: ref.includes("<none>") ? id : ref };
  });
}

// A removal can outlast the short bound (a large target volume); one that
// runs out is that item's failure, and the rest of the clean goes on.
async function remove(ctx, kind, name) {
  const removed = await ctx.docker([kind, "rm", name], {
    timeoutMs: ctx.longTimeoutMs,
  });
  if (removed.code === 0 && !removed.timedOut && !removed.error) {
    say(ctx, `removed ${kind} ${name}`);
    return true;
  }
  say(
    ctx,
    `could not remove ${kind} ${name} (${failureReason(removed, ctx.longTimeoutMs)})`,
  );
  return false;
}

function absoluteFor(path, platform) {
  return platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    : path.startsWith("/");
}

async function cleanVolumes(ctx, target) {
  const volumes = await labeledVolumes(ctx);
  if (target.mode === "all") {
    const names = volumes.map((volume) => volume.name);
    // `docker run -v` recreates a volume removed mid-run without labels; no
    // label filter lists those, so this worktree's names are checked by name.
    const own = volumeNames(worktreeKey(ctx.repoRoot, ctx.platform));
    for (const name of [own.src, own.target, own.cargo]) {
      if (names.includes(name)) continue;
      const found = await volumeLabels(ctx, name);
      if (found !== null && Object.keys(found).length === 0) names.push(name);
    }
    return names;
  }
  if (target.mode === "stale") {
    // Another platform's path (a WSL run's, say) reads as gone from here.
    const stale = [];
    for (const volume of volumes) {
      const path = volume.labels[WORKTREE_LABEL];
      if (typeof path !== "string") continue;
      const platform = volume.labels[PLATFORM_LABEL];
      if (
        platform === undefined
          ? !absoluteFor(path, ctx.platform)
          : platform !== ctx.platform
      ) {
        say(
          ctx,
          `skipped volume ${volume.name}: labeled by another platform or a path this platform cannot check (${path})`,
        );
        continue;
      }
      if (!ctx.exists(path)) stale.push(volume.name);
    }
    return stale;
  }
  const wanted = normalizeWorktreePath(target.path, ctx.platform);
  const names = new Set(
    volumes
      .filter((volume) => {
        const path = volume.labels[WORKTREE_LABEL];
        return (
          typeof path === "string" &&
          normalizeWorktreePath(path, ctx.platform) === wanted
        );
      })
      .map((volume) => volume.name),
  );
  // A computed name another worktree's label claims is that worktree's.
  for (const name of computedNames(ctx, target)) {
    if (names.has(name)) continue;
    const found = await volumeLabels(ctx, name);
    const path = found?.[WORKTREE_LABEL];
    if (
      found !== null &&
      (typeof path !== "string" ||
        normalizeWorktreePath(path, ctx.platform) === wanted)
    ) {
      names.add(name);
    }
  }
  return [...names];
}

function computedNames(ctx, target) {
  const computed = volumeNames(worktreeKey(target.path, ctx.platform));
  return [computed.src, computed.target];
}

/** Labeled image refs other than the current image, compared by image ID. */
async function staleImages(ctx, labelArgs) {
  const rust = await inspectRust1(ctx);
  if (rust === null) {
    say(ctx, "rust:1 is not pulled; not removing images");
    return [];
  }
  const current = imageName(
    DOCKERFILE,
    await rustVersionOf(ctx, rust, labelArgs),
  );
  const currentId = await imageId(ctx, current);
  return (await labeledImages(ctx))
    .filter(({ id, ref }) => ref !== current && id !== currentId)
    .map(({ ref }) => ref);
}

/** Removes a cache file or dir; a failure is logged and fails the clean. */
function removeCache(ctx, path, options = { force: true }) {
  try {
    ctx.fs.rm(path, options);
    return true;
  } catch (err) {
    say(ctx, `could not remove ${path} (${err?.code ?? err})`);
    return false;
  }
}

async function cleanSteps(ctx, held, target, port) {
  await reapOrphans(ctx, held, port);
  let failed = false;
  const kept = new Set();
  for (const name of await cleanVolumes(ctx, target)) {
    if (!(await remove(ctx, "volume", name))) {
      failed = true;
      kept.add(name);
    } else if (
      name.endsWith("-src") &&
      !removeCache(ctx, cacheFile(ctx, name))
    ) {
      failed = true;
    }
  }
  if (target.mode === "worktree") {
    // The cache goes even when its volume is already gone, unless it survived.
    const [src] = computedNames(ctx, target);
    if (!kept.has(src) && !removeCache(ctx, cacheFile(ctx, src))) failed = true;
  } else {
    const images =
      target.mode === "all"
        ? (await labeledImages(ctx)).map(({ ref }) => ref)
        : await staleImages(ctx, labels(ctx, held, port));
    for (const ref of images) {
      if (!(await remove(ctx, "image", ref))) failed = true;
    }
  }
  if (target.mode === "all") {
    if (removeCache(ctx, ctx.cacheDir, { recursive: true, force: true })) {
      say(ctx, `removed ${ctx.cacheDir}`);
    } else {
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

async function runClean(ctx, target, ports, startMs) {
  const held = await acquireFor(ctx, ports.container, "clean");
  let code;
  try {
    code = await cleanSteps(ctx, held, target, ports.container);
  } catch (err) {
    reportFailure(ctx, err);
    code = 2;
  } finally {
    await held.release();
  }
  say(ctx, `done in ${formatSeconds(ctx.now() - startMs)} (exit ${code})`);
  return code;
}

async function runInfo(ctx, ports) {
  const key = worktreeKey(ctx.repoRoot, ctx.platform);
  say(ctx, `worktree ${ctx.repoRoot} (key ${key})`);
  say(
    ctx,
    `container lock port ${ports.container}; native lock port ${ports.native}`,
  );
  for (const name of Object.values(volumeNames(key))) {
    const present = (await volumeLabels(ctx, name)) !== null;
    say(ctx, `volume ${name}: ${present ? "present" : "missing"}`);
  }
  const rust = await inspectRust1(ctx);
  if (rust === null) {
    say(ctx, "rust:1: not pulled");
  } else {
    const version = await rustVersionOf(ctx, rust, ["--label", `${LABEL}=1`]);
    const image = imageName(DOCKERFILE, version);
    const built = (await imageId(ctx, image)) !== null;
    say(ctx, `rust:1: rustc ${version}`);
    say(ctx, `image ${image}: ${built ? "built" : "not built"}`);
  }
  say(ctx, `last daily rust:1 check: ${lastDailyCheck(ctx) ?? "never"}`);
  return 0;
}

function cleanTarget(args, repoRoot) {
  if (args.length === 0) return { mode: "worktree", path: repoRoot };
  if (args.length === 2 && args[0] === "--worktree" && args[1] !== "") {
    return { mode: "worktree", path: resolve(args[1]) };
  }
  if (args.length === 1 && args[0] === "--stale") return { mode: "stale" };
  if (args.length === 1 && args[0] === "--all") return { mode: "all" };
  return null;
}

/**
 * `test` runs cargo in the container under the container lock; `clean`
 * removes volumes, images and caches; `info` reports state without the lock.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const ctx = context(deps);
  const startMs = ctx.now();
  const [command, ...rest] = argv;
  const target =
    command === "clean" ? cleanTarget(rest, ctx.repoRoot) : undefined;
  if (
    !(
      command === "test" ||
      (command === "info" && rest.length === 0) ||
      (command === "clean" && target !== null)
    )
  ) {
    say(ctx, USAGE);
    return 2;
  }
  const ports = {};
  try {
    ports.container = containerPortFromEnv(ctx.env.GD_RUST_CONTAINER_PORT);
    ports.native = portFromEnv(ctx.env.GD_FULL_SUITE_PORT);
  } catch (err) {
    say(ctx, err.message);
    return 2;
  }
  if (ports.container === ports.native) {
    say(
      ctx,
      `GD_RUST_CONTAINER_PORT and GD_FULL_SUITE_PORT both name port ${ports.container}; the container lock must not be the native suite's lock`,
    );
    return 2;
  }
  let version;
  try {
    version = await dockerShort(ctx, [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
  } catch (err) {
    say(ctx, `cannot start: ${err.message}`);
    return 2;
  }
  if (version.code !== 0 || version.error) {
    say(
      ctx,
      "cannot start: docker is not reachable (is Docker Desktop running?)",
    );
    return 2;
  }
  if (command === "test") return runTest(ctx, rest, ports, startMs);
  if (command === "clean") return runClean(ctx, target, ports, startMs);
  try {
    return await runInfo(ctx, ports);
  } catch (err) {
    reportFailure(ctx, err);
    return 2;
  }
}

// Main-module detection by PATH comparison, not `import.meta.main`: that form
// only exists from node 24.2 and fails SILENTLY on older runtimes.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      defaultLog(`${PREFIX}${err?.stack ?? err}`);
      process.exitCode = 2;
    },
  );
}
