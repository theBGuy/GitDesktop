#!/usr/bin/env node
// Runs a FULL test suite (cargo test, Vitest, or both) while holding one
// machine-wide localhost port, so full suites started from different checkouts
// or agent sessions run one after another instead of overlapping: two
// overlapping suites time out git calls into reds that pass solo.
//
// Holding the port IS the serialization. Two binds of 127.0.0.1:<port> refuse
// each other (EADDRINUSE), and the OS frees the port when its holder exits,
// however it exits. A sidecar JSON file, written only by the holder, names the
// run. On POSIX it lives in a private dir under the passwd home (see
// defaultSidecarDir), so every session of one user meets at one path, and a
// record another user wrote is ignored; on win32 it lives in the per-user temp
// dir. A new holder waits while the previous run is still alive, for at most
// MAX_HOLD_MS after that run started. On POSIX the child runs in its own
// process group, "alive" means any process of that group, and the port is held
// until the group is gone, or at most about 10 s after its leader exits
// (SIGKILL after 5 s, then released anyway): cargo does not forward signals to
// its test binary, which a hard-killed wrapper also leaves running (and no
// child keeps the port). kill(-pgid, 0) counts unreaped zombies, so a
// container needs an init (`docker run --init`), or a killed run's group reads
// alive until the cap. On Windows the kill-on-close jobs of libuv and cargo
// end the tree with the wrapper, so "alive" means the child's pid.
//
// Run: node scripts/full-suite.mjs <rust|vitest|all> [extra args...]
// Port: 27483, or GD_FULL_SUITE_PORT (machine configuration: only sessions
// that all see the same value serialize against each other).
// On Windows, when the PATH git's `--exec-path` is <prefix>\libexec\git-core
// and <prefix>\bin holds git.exe, the rust step's PATH starts with that folder,
// so tests spawn git.exe directly: the Git\cmd shim costs a second process per
// git call (PR #746, a quiet full --lib suite: 380 s via the shim, 335 s
// direct). Local default runs therefore use the direct-git topology;
// GD_FULL_SUITE_KEEP_PATH=1 keeps PATH, e.g. to run the cmd\git.exe shim
// topology proc_tree's guards exist for.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_PORT = 27483;
export const MAX_HOLD_MS = 7_200_000;

const PREFIX = "full-suite: ";
const RUST_MANIFEST = "src-tauri/Cargo.toml";
const GROUP_GRACE_MS = 5000;
const GROUP_POLL_MS = 50;
const MAX_PID = 2 ** 31 - 1;
const USAGE =
  "usage: node scripts/full-suite.mjs <rust|vitest|all> [extra args...] (all takes no extra args)";

const defaultLog = (line) => process.stderr.write(`${line}\n`);
const randomSuffix = () => randomBytes(8).toString("hex");
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The port from GD_FULL_SUITE_PORT; unset or empty means DEFAULT_PORT. */
export function portFromEnv(value) {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 1024 && port <= 65535)) {
    throw new Error(
      `GD_FULL_SUITE_PORT must be an integer 1024..65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

/** GD_FULL_SUITE_KEEP_PATH: "1" keeps PATH; unset, empty or "0" does not. */
export function keepPathFromEnv(value) {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(
    `GD_FULL_SUITE_KEEP_PATH must be 0 or 1, got ${JSON.stringify(value)}`,
  );
}

/** True only for an existing regular file; any stat error reads as false. */
export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// A drive root (`C:\`) or a UNC share root (`\\server\share\`); device
// namespaces (`\\?\`, `\\.\`) and rooted paths without a drive are refused.
const GIT_PREFIX_ROOT = /^(?:[A-Za-z]:\\|\\\\(?![?.]\\)[^\\]+\\[^\\]+\\)$/;

/** `<prefix>\bin` from git's `<prefix>/libexec/git-core`, or why there is none. */
export function realGitBinDir(execPathOutput, exists = isFile) {
  const trimmed = String(execPathOutput ?? "").trim();
  const notExecPath = {
    reason: `git --exec-path printed ${JSON.stringify(trimmed)}, not a <prefix>/libexec/git-core path`,
  };
  // Code points 0-31 (newlines included) never belong in a folder name.
  const hasControl = [...trimmed].some((c) => c.charCodeAt(0) < 0x20);
  if (trimmed === "" || hasControl) return notExecPath;
  const path = win32.normalize(trimmed).replace(/[\\/]+$/, "");
  const { root } = win32.parse(path);
  if (!GIT_PREFIX_ROOT.test(root)) return notExecPath;
  const segments = path.slice(root.length).split("\\");
  const [libexec, core] = segments.slice(-2);
  if (
    segments.length < 2 ||
    libexec.toLowerCase() !== "libexec" ||
    core.toLowerCase() !== "git-core"
  ) {
    return notExecPath;
  }
  const dir = win32.join(root, ...segments.slice(0, -2), "bin");
  // Rust's split_paths would read a `;` inside the entry as two entries.
  if (dir.includes(";")) {
    return { reason: `${JSON.stringify(dir)} contains ';'` };
  }
  if (!exists(win32.join(dir, "git.exe"))) {
    return { reason: `no git.exe in ${dir}` };
  }
  return { dir };
}

/**
 * The key a win32 child reads for `name`: of the case-variant keys present,
 * only the lexicographically first reaches it (undefined when none does).
 */
function envKey(env, name) {
  const upper = name.toUpperCase();
  return Object.keys(env)
    .filter((key) => key.toUpperCase() === upper)
    .sort()[0];
}

/**
 * A copy of `env` whose one PATH key puts `dir` first: the name a win32 child
 * reads is kept and every other case variant dropped. An empty value keeps
 * the one empty entry Rust's split_paths reads in it.
 */
export function withPathFirst(env, dir) {
  const key = envKey(env, "PATH") ?? "Path";
  const old = env[key];
  const next = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() !== "PATH") next[name] = value;
  }
  next[key] = old === undefined ? dir : `${dir};${old}`;
  return next;
}

/**
 * The `.com`/`.exe` suffixes Rust's exe pass tries, lowercased in PATHEXT
 * order; undefined (unset) means Rust's fallback list, while an empty value
 * lists none.
 */
export function exeSuffixes(pathext) {
  return (pathext === undefined ? ".EXE;.CMD;.BAT" : String(pathext))
    .split(";")
    .filter((ext) => ext !== "")
    .map((ext) => ext.toLowerCase())
    .filter((ext) => ext === ".exe" || ext === ".com");
}

/**
 * The git Rust's `agent::find_executable` exe pass picks from a PATH value,
 * as an absolute path, or null: entries in order, split on `;` outside double
 * quotes with the quotes dropped, and in each entry `git<suffix>` for each
 * suffix in the given order. Every entry, empty or relative included,
 * resolves against `cwd`, the test binary's working directory (cargo's
 * package root), the way Rust's `is_file` resolves a relative entry. An
 * undefined value (no PATH variable) has no entries, while "" is one empty
 * entry, as in Rust's `var_os` and `split_paths`. Outside win32.resolve's
 * model, and so possibly not Rust's pick: another drive's `D:x`, and `\\?\`.
 */
export function firstGitOnPath(pathValue, suffixes, cwd, isFileFn = isFile) {
  if (pathValue === undefined) return null;
  const entries = [];
  let entry = "";
  let quoted = false;
  for (const c of String(pathValue ?? "")) {
    if (c === '"') quoted = !quoted;
    else if (c === ";" && !quoted) {
      entries.push(entry);
      entry = "";
    } else entry += c;
  }
  entries.push(entry);
  for (const raw of entries) {
    const dir = win32.resolve(cwd, raw);
    for (const suffix of suffixes) {
      const candidate = win32.join(dir, `git${suffix}`);
      if (isFileFn(candidate)) return candidate;
    }
  }
  return null;
}

/** Maps `git --exec-path`'s spawnSync result to the probe's answer. */
export function probeResult(result, git) {
  if (result.error) {
    return { ok: false, detail: result.error.code ?? String(result.error) };
  }
  if (result.status === null) {
    return { ok: false, detail: `signal ${result.signal}` };
  }
  if (result.status !== 0) {
    return { ok: false, detail: `exit ${result.status}` };
  }
  return { ok: true, stdout: result.stdout, git };
}

/**
 * `git --exec-path` of the git the Rust tests would pick from `env`'s PATH and
 * PATHEXT, an empty or relative PATH entry resolving against the required
 * `rustCwd` (the test binary's working directory), spawned by its absolute
 * path, so neither the cwd nor libuv's own search can substitute another git.
 * A PATHEXT listing neither `.com` nor `.exe`, or no such git on PATH,
 * answers with a `reason` and spawns nothing.
 */
export function probeGitExecPath({
  env,
  cwd,
  rustCwd,
  isFileFn = isFile,
  spawnFn = spawnSync,
}) {
  const extKey = envKey(env, "PATHEXT");
  const suffixes = exeSuffixes(extKey === undefined ? undefined : env[extKey]);
  if (suffixes.length === 0) {
    return { ok: false, reason: "PATHEXT lists neither .com nor .exe" };
  }
  const key = envKey(env, "PATH");
  const git = firstGitOnPath(
    key === undefined ? undefined : env[key],
    suffixes,
    rustCwd,
    isFileFn,
  );
  if (git === null) {
    const tried = suffixes.map((suffix) => `git${suffix}`).join(" or ");
    return { ok: false, reason: `no ${tried} on PATH` };
  }
  const result = spawnFn(git, ["--exec-path"], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return probeResult(result, git);
}

/**
 * The rust step's env and its log line. Win32 only, and it never throws or
 * fails a run: any problem keeps PATH (env null) and says why.
 */
export function rustStepEnv({ env, platform, keepPath, probe, exists }) {
  if (platform !== "win32") return { env: null, line: null };
  const keep = (why) => ({
    env: null,
    line: `${PREFIX}rust step keeps PATH (${why})`,
  });
  if (keepPath) return keep("GD_FULL_SUITE_KEEP_PATH=1");
  // A set GIT_EXEC_PATH is what `git --exec-path` prints, not the running git.
  const execKey = envKey(env, "GIT_EXEC_PATH");
  if (execKey !== undefined && env[execKey]) {
    return keep("GIT_EXEC_PATH is set");
  }
  try {
    const result = probe();
    if (!result?.ok) {
      return keep(
        result?.reason ?? `git --exec-path failed: ${result?.detail}`,
      );
    }
    const found = realGitBinDir(result.stdout, exists);
    if (found.reason) return keep(found.reason);
    return {
      env: withPathFirst(env, found.dir),
      line: `${PREFIX}rust step puts ${found.dir} first on PATH (from ${result.git} --exec-path)`,
    };
  } catch (err) {
    return keep(
      `could not resolve the real git: ${err?.code ?? err?.message ?? err}`,
    );
  }
}

export function sidecarPath(port, dir) {
  return join(dir, `gitdesktop-full-suite-${port}.json`);
}

/**
 * A win32 path rooted at a drive (`C:\`) or a UNC share (`\\server\share`).
 * win32.isAbsolute also accepts `\x` and `/x`, which resolve on the cwd's
 * drive root, where other users may create folders.
 */
export function isRootedWin32(path) {
  return (
    typeof path === "string" &&
    (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path))
  );
}

/**
 * The cause of a failure, for a log line. os.userInfo and os.homedir throw a
 * SystemError whose code is ERR_SYSTEM_ERROR, with the errno in info.code; a
 * plain Error carries only its message.
 */
export function errorText(err) {
  return err?.info?.code ?? err?.code ?? err?.message ?? String(err);
}

/**
 * The per-user sidecar dir as `{ dir, problem }`, dir null when there is none
 * (never a shared-temp fallback). The sidecar is a rendezvous, so on POSIX the
 * dir comes from the passwd home and the uid, never HOME or XDG_CACHE_HOME:
 * every session of one uid computes the same path whatever its environment,
 * and a sudo run that keeps HOME resolves root's own home. win32 keeps its
 * per-user temp dir.
 */
export function defaultSidecarDir({
  platform = process.platform,
  uid = process.getuid?.(),
  userHome = () => userInfo().homedir,
  tmp = tmpdir,
} = {}) {
  if (platform === "win32") {
    const dir = tmp();
    return isRootedWin32(dir)
      ? { dir, problem: null }
      : {
          dir: null,
          problem: `temp dir not rooted at a drive or share: ${dir}`,
        };
  }
  if (!Number.isInteger(uid)) return { dir: null, problem: "no user id" };
  let home;
  try {
    home = userHome();
  } catch (err) {
    return { dir: null, problem: errorText(err) };
  }
  if (typeof home !== "string" || !posix.isAbsolute(home)) {
    return { dir: null, problem: `home is not an absolute path: ${home}` };
  }
  const leaf = `gitdesktop-full-suite-${uid}`;
  return {
    dir:
      platform === "darwin"
        ? posix.join(home, "Library", "Caches", leaf)
        : posix.join(home, ".cache", leaf),
    problem: null,
  };
}

/**
 * Makes `dir` and, on POSIX, checks it is private, answering null or why not;
 * it never throws. The dir must be a directory, not a link, that `uid` owns,
 * with no group or other write bit (mode bits; ACLs are not read); a link at
 * the dir, dangling or not, is refused first. Only when the dir has to be
 * created is the nearest existing ancestor (links followed, so a dangling one
 * reads as absent) checked first, as a directory `uid` owns, so a root run
 * never creates a dir in a home whose nearest existing folder is the user's.
 * With `create` false an absent dir is answered null after that ancestor check
 * and nothing is made.
 */
export function ensurePrivateDir(
  dir,
  {
    platform = process.platform,
    uid = process.getuid?.(),
    fs = { stat: statSync, lstat: lstatSync, mkdir: mkdirSync },
    create = true,
  } = {},
) {
  try {
    if (platform === "win32") {
      if (create) fs.mkdir(dir, { recursive: true });
      return null;
    }
    if (!Number.isInteger(uid)) return "no user id";
    try {
      if (fs.lstat(dir).isSymbolicLink()) return `${dir} is a symlink`;
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    let existing = dir;
    let info;
    for (;;) {
      try {
        info = fs.stat(existing);
        break;
      } catch (err) {
        const parent = dirname(existing);
        const absent = err?.code === "ENOENT" || err?.code === "ENOTDIR";
        if (!absent || parent === existing) throw err;
        existing = parent;
      }
    }
    if (!info.isDirectory()) return `${existing} is not a directory`;
    if (info.uid !== uid) return `${existing} belongs to uid ${info.uid}`;
    if (create) fs.mkdir(dir, { recursive: true, mode: 0o700 });
    else if (existing !== dir) return null;
    const leaf = fs.lstat(dir);
    if (leaf.isSymbolicLink()) return `${dir} is a symlink`;
    if (!leaf.isDirectory()) return `${dir} is not a directory`;
    if (leaf.uid !== uid) return `${dir} belongs to uid ${leaf.uid}`;
    if ((leaf.mode & 0o022) !== 0) {
      return `${dir} is writable by other users`;
    }
    return null;
  } catch (err) {
    return errorText(err);
  }
}

function vitestEntry(repoRoot) {
  return join(repoRoot, "node_modules", "vitest", "vitest.mjs");
}

/**
 * The children a mode runs, in order. Vitest runs through node itself, never
 * the pnpm shim: on Windows the shim's pid would be the recorded child, and
 * the child check would watch the shim instead of the suite. A non-null
 * rustEnv becomes the rust step's env; no other step ever carries one.
 */
export function commandsFor(
  mode,
  extraArgs = [],
  repoRoot = REPO_ROOT,
  rustEnv = null,
) {
  const rust = {
    suite: "rust",
    file: "cargo",
    args: ["test", "--manifest-path", RUST_MANIFEST, ...extraArgs],
    ...(rustEnv ? { env: rustEnv } : {}),
  };
  const vitest = {
    suite: "vitest",
    file: process.execPath,
    args: [vitestEntry(repoRoot), "run", ...extraArgs],
  };
  if (mode === "rust") return [rust];
  if (mode === "vitest") return [vitest];
  if (mode === "all") {
    if (extraArgs.length > 0) throw new Error("all takes no extra args");
    return [rust, vitest];
  }
  throw new Error(`unknown mode ${JSON.stringify(mode)}`);
}

function cargoRuns(repoRoot) {
  const probe = spawnSync("cargo", ["--version"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return probe.status === 0;
}

/** Checked before the first bind, so a run that cannot start never waits. */
export function preflight(
  mode,
  { repoRoot = REPO_ROOT, exists = existsSync, probeCargo } = {},
) {
  const missing = [];
  if (mode === "rust" || mode === "all") {
    const ok = probeCargo ? probeCargo() : cargoRuns(repoRoot);
    if (!ok) missing.push("`cargo --version` failed (is cargo on PATH?)");
  }
  if (mode === "vitest" || mode === "all") {
    const entry = vitestEntry(repoRoot);
    if (!exists(entry)) missing.push(`${entry} is missing (run pnpm install)`);
  }
  return missing.length > 0 ? `cannot start: ${missing.join("; ")}` : null;
}

// Only a pid in the OS range is ever handed to process.kill: 0 and negative
// values address process groups, and anything else is not a pid at all.
function validPid(pid) {
  return Number.isInteger(pid) && pid >= 1 && pid <= MAX_PID;
}

/** Signal 0 probe: only ESRCH proves the pid is gone; EPERM means it exists. */
export function isPidAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/**
 * The only place a negative pid reaches process.kill. Group ids 0 and 1 are
 * refused: kill(0) signals the wrapper's own group, kill(-1) every process
 * the user owns.
 */
export function killGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid > MAX_PID) {
    throw new RangeError(`refusing to signal process group ${pgid}`);
  }
  process.kill(-pgid, signal);
}

/** Any process of the group is alive; only ESRCH proves it empty. */
export function isGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid > MAX_PID) return false;
  try {
    killGroup(pgid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/** A run's liveness: its whole process group on POSIX, its pid on win32. */
export function isRunAlive(pid, platform = process.platform) {
  return platform === "win32" ? isPidAlive(pid) : isGroupAlive(pid);
}

/**
 * The sidecar's record, or null when it is missing or not a JSON object. When
 * the uid is known (POSIX; tests seam it with `fstat`), a sidecar that is not
 * a regular file this uid owns is null too: a record another user planted in
 * the sidecar dir never blocks or names this run's wait. That also keeps root
 * and the user apart (a sudo run ignores the user's orphan records and back);
 * the port still serializes live holders. The dir is per user as well: a
 * private dir under the passwd home on POSIX, the user's temp dir on win32.
 */
export function readSidecar(
  file,
  { fstat = fstatSync, uid = process.getuid?.() } = {},
) {
  let fd;
  try {
    // A symlink at the sidecar path is not followed, and a FIFO opens at once
    // instead of blocking the reader; both flags are undefined on win32.
    fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    if (uid !== undefined) {
      const info = fstat(fd);
      if (!info.isFile() || info.uid !== uid) return null;
    }
    const record = JSON.parse(readFileSync(fd, "utf8"));
    if (record === null || typeof record !== "object") return null;
    return Array.isArray(record) ? null : record;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function startedMs(record) {
  return typeof record.startedAt === "string"
    ? Date.parse(record.startedAt)
    : Number.NaN;
}

/**
 * True while a previous run may still be running its suite: the record names
 * a live run (its child's process group on POSIX) and started less than
 * maxHoldMs ago. A missing, unparseable or future start never blocks, so no
 * record can hold a run past the cap.
 */
export function orphanBlocks(
  record,
  { isAlive = isRunAlive, now = Date.now, maxHoldMs = MAX_HOLD_MS } = {},
) {
  if (record === null || typeof record !== "object") return false;
  if (!validPid(record.childPid)) return false;
  const age = now() - startedMs(record);
  if (!(age >= 0 && age < maxHoldMs)) return false;
  return Boolean(isAlive(record.childPid));
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const pad = (n) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

function describeRun(record, now) {
  const child = validPid(record.childPid) ? record.childPid : "none";
  const age = formatAge(now() - startedMs(record));
  return { child, age };
}

/** Binds 127.0.0.1:<port>; every connection made to it is dropped at once. */
export function bindPort(port) {
  return new Promise((done, fail) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", fail);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.removeListener("error", fail);
      // A listening server has nothing left to report; an unhandled 'error'
      // would crash the wrapper in the middle of its child's run.
      server.on("error", () => {});
      // The port never keeps the wrapper alive: the child or a wait does.
      server.unref();
      done(server);
    });
  });
}

// Whole record to a temp file, then a rename over the sidecar, so a holder
// killed mid-write never leaves a truncated record. Called only for a dir
// acquireLock accepted (ensurePrivateDir: on POSIX a private dir this uid
// owns). The temp's name is random, it is created exclusively and only a temp
// this call created is removed, so on POSIX an entry another user planted
// there is refused, never written through or removed; win32, whose exclusive
// create follows a dangling link, relies on its per-user temp dir. A failed
// write costs the next run its child check, never this run its suite.
function writeSidecar(file, record, log, suffix) {
  const tmp = `${file}.${suffix}.tmp`;
  let created = false;
  try {
    const fd = openSync(tmp, "wx");
    created = true;
    try {
      writeFileSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {}
    }
    log(`${PREFIX}could not write sidecar ${file} (${errorText(err)})`);
  }
}

function removeSidecar(file) {
  try {
    unlinkSync(file);
  } catch {}
}

/**
 * Waits for the port, then for any previous run that is still alive (its
 * process group on POSIX, its child on win32), then writes this run's record.
 * Contention always waits; only a bind error other than EADDRINUSE on every
 * attempt for a whole announceMs runs unserialized. With neither sidecarDir
 * nor sidecarFile the dir comes from resolveSidecarDir; a null dir with no
 * sidecarFile (resolved, or passed by a caller that reported it) holds the
 * port with no sidecar: nothing is read, written or removed. The sidecar's dir
 * is decided once, after the bind (ensureDir): a refused dir is logged once
 * and never written or removed, though the previous run's record is still
 * read there (on POSIX readSidecar refuses a link at the file's path and a
 * file another user owns).
 */
export async function acquireLock({
  port = DEFAULT_PORT,
  sidecarDir,
  sidecarFile,
  resolveSidecarDir = defaultSidecarDir,
  ensureDir = ensurePrivateDir,
  record,
  bind = bindPort,
  platform = process.platform,
  isAlive = (pid) => isRunAlive(pid, platform),
  isWrapperAlive = isPidAlive,
  now = Date.now,
  sleep = defaultSleep,
  pollMs = 2000,
  announceMs = 30000,
  maxHoldMs = MAX_HOLD_MS,
  tempSuffix = randomSuffix,
  sidecarOwner,
  log = defaultLog,
}) {
  const waitStart = now();
  let dir = sidecarDir;
  if (dir === undefined && sidecarFile === undefined) {
    let problem;
    try {
      ({ dir, problem } = resolveSidecarDir());
    } catch (err) {
      problem = errorText(err);
    }
    dir ??= null;
    if (dir === null) {
      log(
        `${PREFIX}no per-user dir for the sidecar (${problem}); this run is not named, and a killed run's children are not waited for`,
      );
    }
  }
  const fileFor = (p) =>
    sidecarFile ??
    (dir === null || dir === undefined ? null : sidecarPath(p, dir));
  const waitFile = fileFor(port);
  let announcedAt = null;
  let failingSince = null;
  let server;
  for (;;) {
    try {
      server = await bind(port);
      break;
    } catch (err) {
      if (err?.code === "EADDRINUSE") {
        failingSince = null;
        if (announcedAt === null || now() - announcedAt >= announceMs) {
          announcedAt = now();
          log(waitingLine(port, waitFile, isWrapperAlive, now, sidecarOwner));
        }
      } else if (failingSince === null) {
        failingSince = now();
      } else if (now() - failingSince >= announceMs) {
        log(
          `${PREFIX}could not bind port ${port} (${err?.code ?? err}) - running unserialized`,
        );
        return {
          port,
          degraded: true,
          setChild() {},
          release: async () => {},
        };
      }
      await sleep(pollMs);
    }
  }

  const heldPort = server.address().port;
  const file = fileFor(heldPort);
  let writable = false;
  if (file !== null) {
    let problem;
    try {
      problem = ensureDir(dirname(file));
    } catch (err) {
      problem = errorText(err);
    }
    writable = problem === null;
    if (!writable) {
      log(
        `${PREFIX}could not use the sidecar dir ${dirname(file)} (${problem}); this run is not named, and if it is killed the next run does not wait for its children`,
      );
    }
  }
  // The child check reads the previous run's record and never writes it, so
  // a wrapper stopped here leaves that evidence for the next holder.
  let orphanAt = null;
  for (;;) {
    const previous = file === null ? null : readSidecar(file, sidecarOwner);
    if (!orphanBlocks(previous, { isAlive, now, maxHoldMs })) break;
    if (orphanAt === null || now() - orphanAt >= announceMs) {
      orphanAt = now();
      const { child, age } = describeRun(previous, now);
      // On POSIX the recorded pid is a process group whose leader may be gone.
      const what =
        platform === "win32"
          ? `child is still alive (${previous.suite}, child pid ${child}`
          : `process group is still alive (${previous.suite}, group ${child}`;
      log(
        `${PREFIX}waiting - holding port ${heldPort}; the previous run's ${what}, cwd ${previous.cwd}, started ${age} ago) [sidecar ${file}]`,
      );
    }
    await sleep(pollMs);
  }

  const own = {
    wrapperPid: record.wrapperPid,
    childPid: null,
    suite: record.suite,
    cwd: record.cwd,
    startedAt: new Date(now()).toISOString(),
  };
  if (writable) writeSidecar(file, own, log, tempSuffix());
  const waited = Math.round((now() - waitStart) / 1000);
  log(
    `${PREFIX}lock acquired for ${own.suite} on port ${heldPort} after waiting ${waited}s`,
  );
  let released = null;
  return {
    port: heldPort,
    degraded: false,
    setChild(pid) {
      if (released || !validPid(pid) || !writable) return;
      writeSidecar(file, { ...own, childPid: pid }, log, tempSuffix());
    },
    // Sidecar first, then the port: a waiter that wins the bind must never
    // find this run's record naming a child that has already exited.
    release() {
      released ??= new Promise((done) => {
        if (writable) removeSidecar(file);
        server.close(() => done());
      });
      return released;
    },
  };
}

function waitingLine(port, file, isWrapperAlive, now, sidecarOwner) {
  if (file === null) {
    return `${PREFIX}waiting - held by an unknown process on port ${port} (or by a wrapper still checking a previous run's child)`;
  }
  const record = readSidecar(file, sidecarOwner);
  if (
    record &&
    validPid(record.wrapperPid) &&
    isWrapperAlive(record.wrapperPid)
  ) {
    const { child, age } = describeRun(record, now);
    return `${PREFIX}waiting - ${record.suite} holds port ${port} (wrapper pid ${record.wrapperPid}, child pid ${child}, cwd ${record.cwd}, started ${age} ago) [sidecar ${file}]`;
  }
  // A record whose wrapper is dead describes an earlier run, not the holder.
  return `${PREFIX}waiting - held by an unknown process on port ${port} (or by a wrapper still checking a previous run's child) [sidecar ${file}]`;
}

/**
 * Runs `steps` in order under one hold and resolves the first non-zero exit
 * code (0 when every step passed). Every step runs even after a failure; a
 * signal stops before the next step. On POSIX each child leads its own
 * session and process group (its pid is the group id the sidecar's childPid
 * names), a signal is forwarded to the whole group, and a step ends once the
 * group is gone: a group still alive GROUP_GRACE_MS after its leader exits is
 * SIGKILLed, and released after another GROUP_GRACE_MS whatever remains.
 * Win32 only waits: the console already delivered Ctrl+C to the child.
 */
export async function runUnderLock({
  steps,
  suite,
  cwd = REPO_ROOT,
  log = defaultLog,
  now = Date.now,
  platform = process.platform,
  ...lockOptions
}) {
  const held = await acquireLock({
    ...lockOptions,
    platform,
    now,
    log,
    record: { wrapperPid: process.pid, suite, cwd },
  });
  const posix = platform !== "win32";
  // The group to forward signals to, set from spawn until the group is gone.
  let group = null;
  let stopped = false;
  const forward = (signal) => {
    if (group === null) return;
    try {
      killGroup(group, signal);
    } catch {}
  };
  const onStop = (signal) => {
    stopped = true;
    if (posix) forward(signal);
  };
  // The suite's session has no controlling terminal, so job control reaches
  // it only through the wrapper: a terminal stop pauses the group and then the
  // wrapper itself, and a continue resumes the group.
  const onSuspend = () => {
    forward("SIGSTOP");
    process.kill(process.pid, "SIGSTOP");
  };
  const onResume = () => forward("SIGCONT");
  // Win32 listens for exactly SIGINT, SIGTERM and SIGBREAK; the POSIX-only
  // signals are never listened for there.
  const handlers = posix
    ? [
        ["SIGINT", onStop],
        ["SIGTERM", onStop],
        ["SIGHUP", onStop],
        ["SIGQUIT", onStop],
        ["SIGTSTP", onSuspend],
        ["SIGCONT", onResume],
      ]
    : [
        ["SIGINT", onStop],
        ["SIGTERM", onStop],
        ["SIGBREAK", onStop],
      ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let code = 0;
  let ran = 0;
  try {
    for (const step of steps) {
      if (stopped) break;
      const started = now();
      const result = await new Promise((done) => {
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        let child;
        try {
          // detached on POSIX is setsid(): a new session with no controlling
          // terminal, so the suite can never stop on SIGTTIN or SIGTTOU.
          child = spawn(step.file, step.args, {
            cwd,
            stdio: posix ? ["ignore", "inherit", "inherit"] : "inherit",
            detached: posix,
            ...(step.env ? { env: step.env } : {}),
          });
        } catch (err) {
          settle({ spawnError: err });
          return;
        }
        if (posix && validPid(child.pid)) group = child.pid;
        held.setChild(child.pid);
        child.once("error", (err) => settle({ spawnError: err }));
        child.once("exit", (exitCode) => settle({ exitCode: exitCode ?? 1 }));
      });
      if (group !== null) {
        await waitGroupGone(group, step.suite, log);
        group = null;
      }
      ran += 1;
      let stepCode;
      if (result.spawnError) {
        stepCode = 2;
        log(
          `${PREFIX}could not start ${step.suite} (${result.spawnError.code ?? result.spawnError}: ${step.file})`,
        );
      } else {
        stepCode = result.exitCode;
        const secs = Math.round((now() - started) / 1000);
        log(`${PREFIX}${step.suite} exited ${stepCode} after ${secs}s`);
      }
      if (code === 0) code = stepCode;
    }
  } finally {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
    await held.release();
  }
  // A signal that stopped the run before every step ran never reads as a pass.
  return code === 0 && ran < steps.length ? 1 : code;
}

async function waitGroupGone(pgid, suite, log) {
  const gone = async () => {
    const deadline = Date.now() + GROUP_GRACE_MS;
    while (isGroupAlive(pgid)) {
      if (Date.now() >= deadline) return false;
      await defaultSleep(GROUP_POLL_MS);
    }
    return true;
  };
  if (await gone()) return;
  log(`${PREFIX}${suite} left processes in group ${pgid}; sending SIGKILL`);
  try {
    killGroup(pgid, "SIGKILL");
  } catch {}
  if (!(await gone())) {
    log(`${PREFIX}group ${pgid} still has processes; releasing anyway`);
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    log = defaultLog,
    repoRoot = REPO_ROOT,
    exists,
    isGitFile = isFile,
    probeCargo,
    platform = process.platform,
    probeGitExecPath: probeGit = probeGitExecPath,
    run = runUnderLock,
    ...lockOptions
  } = deps;
  const [mode, ...extra] = argv;
  let steps;
  try {
    steps = commandsFor(mode, extra, repoRoot);
  } catch {
    log(`${PREFIX}${USAGE}`);
    return 2;
  }
  let port;
  try {
    port = portFromEnv(env.GD_FULL_SUITE_PORT);
  } catch (err) {
    log(`${PREFIX}${err.message}`);
    return 2;
  }
  if (env.GD_FULL_SUITE_PORT) {
    log(`${PREFIX}using port ${port} from GD_FULL_SUITE_PORT`);
  }
  let keepPath;
  try {
    keepPath = keepPathFromEnv(env.GD_FULL_SUITE_KEEP_PATH);
  } catch (err) {
    log(`${PREFIX}${err.message}`);
    return 2;
  }
  const problem = preflight(mode, { repoRoot, exists, probeCargo });
  if (problem) {
    log(`${PREFIX}${problem}`);
    return 2;
  }
  if (steps.some((step) => step.suite === "rust")) {
    // cargo runs the test binary in the package root, where Rust resolves a
    // relative PATH entry.
    const rustCwd = win32.resolve(repoRoot, win32.dirname(RUST_MANIFEST));
    const rust = rustStepEnv({
      env,
      platform,
      keepPath,
      probe: () =>
        probeGit({ env, cwd: repoRoot, rustCwd, isFileFn: isGitFile }),
      exists: isGitFile,
    });
    if (rust.line) log(rust.line);
    if (rust.env) steps = commandsFor(mode, extra, repoRoot, rust.env);
  }
  return run({
    ...lockOptions,
    steps,
    suite: mode,
    cwd: repoRoot,
    port,
    log,
    platform,
  });
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
