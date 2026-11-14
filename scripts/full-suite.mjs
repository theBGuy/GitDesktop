#!/usr/bin/env node
// Runs a FULL test suite (cargo test, Vitest, or both) while holding one
// machine-wide localhost port, so full suites started from different checkouts
// or agent sessions run one after another instead of overlapping: two
// overlapping suites time out git calls into reds that pass solo.
//
// Holding the port IS the serialization. Two binds of 127.0.0.1:<port> refuse
// each other (EADDRINUSE), and the OS frees the port when its holder exits,
// however it exits. A sidecar JSON file beside it, written only by the holder,
// names the run; a new holder waits while the previous run is still alive,
// for at most MAX_HOLD_MS after that run started. On POSIX the child runs in
// its own process group, "alive" means any process of that group, and the
// port is held until the group is gone, or at most about 10 s after its leader
// exits (SIGKILL after 5 s, then released anyway): cargo does not forward
// signals to its test binary, which a hard-killed wrapper also leaves running
// (and no child keeps the port). kill(-pgid, 0) counts unreaped zombies, so a
// container needs an init (`docker run --init`), or a killed run's group reads
// alive until the cap. On Windows the kill-on-close jobs of libuv and cargo
// end the tree with the wrapper, so "alive" means the child's pid.
//
// Run: node scripts/full-suite.mjs <rust|vitest|all> [extra args...]
// Port: 27483, or GD_FULL_SUITE_PORT (machine configuration: only sessions
// that all see the same value serialize against each other).
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_PORT = 27483;
export const MAX_HOLD_MS = 7_200_000;

const PREFIX = "full-suite: ";
const GROUP_GRACE_MS = 5000;
const GROUP_POLL_MS = 50;
const MAX_PID = 2 ** 31 - 1;
const USAGE =
  "usage: node scripts/full-suite.mjs <rust|vitest|all> [extra args...] (all takes no extra args)";

const defaultLog = (line) => process.stderr.write(`${line}\n`);
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

export function sidecarPath(port, dir = tmpdir()) {
  return join(dir, `gitdesktop-full-suite-${port}.json`);
}

function vitestEntry(repoRoot) {
  return join(repoRoot, "node_modules", "vitest", "vitest.mjs");
}

/**
 * The children a mode runs, in order. Vitest runs through node itself, never
 * the pnpm shim: on Windows the shim's pid would be the recorded child, and
 * the child check would watch the shim instead of the suite.
 */
export function commandsFor(mode, extraArgs = [], repoRoot = REPO_ROOT) {
  const rust = {
    suite: "rust",
    file: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml", ...extraArgs],
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

/** The sidecar's record, or null when it is missing or not a JSON object. */
export function readSidecar(file) {
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (record === null || typeof record !== "object") return null;
    return Array.isArray(record) ? null : record;
  } catch {
    return null;
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
// killed mid-write never leaves a truncated record. A write that fails costs
// the next run its child check, never this run its suite.
function writeSidecar(file, record, log) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    log(`${PREFIX}could not write sidecar ${file} (${err?.code ?? err})`);
  }
}

function removeSidecar(file) {
  try {
    unlinkSync(file);
  } catch {}
}

/**
 * Waits for the port, then for any previous run that is still alive (its
 * process group on POSIX, its child on win32), then writes this run's
 * record. Contention always waits; only a bind error other than EADDRINUSE
 * on every attempt for a whole announceMs runs unserialized.
 */
export async function acquireLock({
  port = DEFAULT_PORT,
  sidecarDir = tmpdir(),
  sidecarFile,
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
  log = defaultLog,
}) {
  const waitStart = now();
  const waitFile = sidecarFile ?? sidecarPath(port, sidecarDir);
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
          log(waitingLine(port, waitFile, isWrapperAlive, now));
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
  const file = sidecarFile ?? sidecarPath(heldPort, sidecarDir);
  // The child check reads the previous run's record and never writes it, so
  // a wrapper stopped here leaves that evidence for the next holder.
  let orphanAt = null;
  for (;;) {
    const previous = readSidecar(file);
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
  writeSidecar(file, own, log);
  const waited = Math.round((now() - waitStart) / 1000);
  log(
    `${PREFIX}lock acquired for ${own.suite} on port ${heldPort} after waiting ${waited}s`,
  );
  let released = null;
  return {
    port: heldPort,
    degraded: false,
    setChild(pid) {
      if (released || !validPid(pid)) return;
      writeSidecar(file, { ...own, childPid: pid }, log);
    },
    // Sidecar first, then the port: a waiter that wins the bind must never
    // find this run's record naming a child that has already exited.
    release() {
      released ??= new Promise((done) => {
        removeSidecar(file);
        server.close(() => done());
      });
      return released;
    },
  };
}

function waitingLine(port, file, isWrapperAlive, now) {
  const record = readSidecar(file);
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
    probeCargo,
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
  const problem = preflight(mode, { repoRoot, exists, probeCargo });
  if (problem) {
    log(`${PREFIX}${problem}`);
    return 2;
  }
  return runUnderLock({
    ...lockOptions,
    steps,
    suite: mode,
    cwd: repoRoot,
    port,
    log,
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
