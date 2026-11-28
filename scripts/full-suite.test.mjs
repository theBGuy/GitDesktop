// Contract tests for scripts/full-suite.mjs, the full-suite port lock.
//
// Port discipline: every lock binds port 0 (an OS-assigned port) or the port of
// a listener this file still holds, always on host 127.0.0.1, so no test ever
// touches DEFAULT_PORT. A port this file let go is never bound again as if it
// were still its own: "free again" is proven by a contender that was already
// waiting acquiring it. Every sidecar lives under one mkdtemp dir.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireLock,
  bindPort,
  commandsFor,
  DEFAULT_PORT,
  defaultSidecarDir,
  ensurePrivateDir,
  errorText,
  exeSuffixes,
  firstGitOnPath,
  isFile,
  isGroupAlive,
  isPidAlive,
  isRootedWin32,
  keepPathFromEnv,
  killGroup,
  MAX_HOLD_MS,
  main,
  orphanBlocks,
  portFromEnv,
  preflight,
  probeGitExecPath,
  probeResult,
  readSidecar,
  realGitBinDir,
  runUnderLock,
  rustStepEnv,
  sidecarPath,
  withPathFirst,
} from "./full-suite.mjs";

const SCRIPT = fileURLToPath(new URL("./full-suite.mjs", import.meta.url));
const NODE = process.execPath;
const BOUND_MS = 30_000;
const FAKE_CHILD = 4242;
const noop = () => {};
const WIN32 = process.platform === "win32";
// The orphan line names a child on win32 and a process group on POSIX.
const STILL_ALIVE = WIN32
  ? "the previous run's child is still alive"
  : "the previous run's process group is still alive";
const RUN_ID = WIN32 ? "child pid" : "group";

let root;
let harness;
let sleeper;
let marker;
let fakeCargo;
let grandchild;
const processes = new Set();
// Pids that may still be live; each leaves the set once its death is seen or
// caused, because a reused pid would make cleanup kill an unrelated process.
const pids = new Set();

before(() => {
  root = mkdtempSync(join(tmpdir(), "gd-full-suite-"));
  harness = join(root, "harness.mjs");
  writeFileSync(
    harness,
    [
      `import { runUnderLock } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
      "process.exitCode = await runUnderLock(JSON.parse(process.argv[2]));",
      "",
    ].join("\n"),
  );
  // Self-exits after 60 s, so a test that dies early strands nothing for long.
  sleeper = join(root, "sleeper.mjs");
  writeFileSync(sleeper, "setTimeout(() => {}, 60_000);\n");
  // `short` ends soon after it starts; `overlap` ends only once four starts
  // are in the log (or after 20 s), which only unserialized children reach.
  marker = join(root, "marker.mjs");
  writeFileSync(
    marker,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const [log, id, mode] = process.argv.slice(2);",
      "appendFileSync(log, `start ${id}\\n`);",
      "const starts = () => readFileSync(log, 'utf8').split('start ').length - 1;",
      "const deadline = Date.now() + 20_000;",
      "const finish = () => appendFileSync(log, `end ${id}\\n`);",
      "const poll = () => {",
      "  if (mode !== 'overlap' || starts() >= 4 || Date.now() > deadline) finish();",
      "  else setTimeout(poll, 20);",
      "};",
      "setTimeout(poll, 50);",
      "",
    ].join("\n"),
  );
  // Like cargo: starts a process that stays in its group (which writes the
  // pid file itself), exits on SIGTERM without forwarding it, and otherwise
  // exits once its trigger file appears.
  fakeCargo = join(root, "fake-cargo.mjs");
  writeFileSync(
    fakeCargo,
    [
      'import { spawn } from "node:child_process";',
      'import { existsSync } from "node:fs";',
      "const [grandchild, gone, pidFile, trigger, mode] = process.argv.slice(2);",
      "const child = spawn(process.execPath, [grandchild, gone, pidFile, mode ?? ''], { stdio: 'ignore' });",
      "child.unref();",
      "process.on('SIGTERM', () => process.exit(143));",
      "const deadline = Date.now() + 60_000;",
      "const poll = () => {",
      "  if ((trigger && existsSync(trigger)) || Date.now() > deadline) process.exit(0);",
      "  setTimeout(poll, 20);",
      "};",
      "poll();",
      "",
    ].join("\n"),
  );
  // Takes a second to shut down on SIGTERM and marks that it did, or, when
  // stubborn, ignores SIGTERM so only a SIGKILL ends it. Its pid file lands
  // (temp + rename) only once the handler is installed, so a test that read
  // the pid can signal it without racing the handler.
  grandchild = join(root, "grandchild.mjs");
  writeFileSync(
    grandchild,
    [
      'import { renameSync, writeFileSync } from "node:fs";',
      "const [gone, pidFile, mode] = process.argv.slice(2);",
      "if (mode === 'stubborn') process.on('SIGTERM', () => {});",
      "else process.on('SIGTERM', () => setTimeout(() => {",
      "  writeFileSync(gone, 'gone');",
      "  process.exit(0);",
      "}, 1000));",
      "writeFileSync(`${pidFile}.tmp`, String(process.pid));",
      "renameSync(`${pidFile}.tmp`, pidFile);",
      "setTimeout(() => {}, 60_000);",
      "",
    ].join("\n"),
  );
});

after(() => {
  for (const child of processes) {
    try {
      child.kill(WIN32 ? undefined : "SIGKILL");
    } catch {}
  }
  for (const pid of pids) {
    try {
      killPid(pid, WIN32 ? undefined : "SIGKILL");
    } catch {}
  }
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

/**
 * A pid this file may signal or track: an integer 2..2**31-1, else null.
 * kill(0) would signal this test runner's own process group, and a pid file
 * read mid-write parses as 0.
 */
function parsePid(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim())) return null;
  const pid = Number(text.trim());
  return pid >= 2 && pid <= 2 ** 31 - 1 ? pid : null;
}

/** Waits until `read()` yields a valid pid; `what` names its source. */
async function waitForPid(read, what) {
  let pid = null;
  await waitFor(() => {
    try {
      pid = parsePid(read());
    } catch {
      pid = null;
    }
    return pid !== null;
  }, `a valid pid in ${what}`);
  return pid;
}

const pidFromFile = (file) =>
  waitForPid(() => readFileSync(file, "utf8"), file);
const childPidFrom = (sidecar) =>
  waitForPid(() => readSidecar(sidecar)?.childPid, sidecar);

/** Adds a validated pid to the cleanup set. */
function watchPid(pid) {
  assert.notEqual(parsePid(pid), null, `refusing to track pid ${pid}`);
  pids.add(pid);
  return pid;
}

/** The only process.kill this file makes on a pid it did not spawn itself. */
function killPid(pid, signal) {
  if (parsePid(pid) === null) throw new RangeError(`refusing to signal ${pid}`);
  process.kill(pid, signal);
}

function caseDir(name) {
  return mkdtempSync(join(root, `${name}-`));
}

async function waitFor(predicate, what, timeoutMs = BOUND_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}

function bounded(promise, what, timeoutMs = BOUND_MS) {
  let timer;
  const timeout = new Promise((_, fail) => {
    timer = setTimeout(
      () => fail(new Error(`timed out after ${timeoutMs} ms: ${what}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function track(promise) {
  const state = { done: false, value: undefined };
  state.promise = promise.then((value) => {
    state.done = true;
    state.value = value;
    return value;
  });
  return state;
}

/** An injected clock whose sleeps resolve only when the test ticks them. */
function manualClock(start = Date.now()) {
  let t = start;
  const pending = [];
  const clock = {
    sleeps: 0,
    now: () => t,
    sleep: (ms) => {
      clock.sleeps += 1;
      return new Promise((done) => pending.push({ ms, done }));
    },
    pending: () => pending.length,
    idle: () => waitFor(() => pending.length > 0, "the next poll"),
    async tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        await clock.idle();
        const next = pending.shift();
        t += next.ms;
        next.done();
      }
    },
    /** Ticks until `state` settles. */
    async drive(state) {
      await waitFor(
        () => state.done || pending.length > 0,
        "the lock to settle or poll",
      );
      while (!state.done) {
        if (pending.length > 0) {
          const next = pending.shift();
          t += next.ms;
          next.done();
        }
        await waitFor(
          () => state.done || pending.length > 0,
          "the lock to settle or poll",
        );
      }
      return state.value;
    },
  };
  return clock;
}

/** Resolves true when the lock settled without polling even once. */
async function settledAtOnce(state, clock) {
  await waitFor(
    () => state.done || clock.pending() > 0,
    "the lock to settle or poll",
  );
  return state.done && clock.sleeps === 0;
}

function listenLoopback() {
  return new Promise((done, fail) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", fail);
    server.listen({ port: 0, host: "127.0.0.1" }, () => done(server));
  });
}

const closeServer = (server) =>
  new Promise((done) => server.close(() => done()));

const holderRecord = (suite = "rust") => ({
  wrapperPid: process.pid,
  suite,
  cwd: "C:/holder",
});

function writeRecord(file, fields) {
  const body = JSON.stringify({
    wrapperPid: 1,
    childPid: FAKE_CHILD,
    suite: "rust",
    cwd: "C:/previous",
    ...fields,
  });
  writeFileSync(file, body);
  return body;
}

function startHarness(config) {
  const child = spawn(NODE, [harness, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  const run = { child, err: "", exited: null };
  child.stdout.on("data", noop);
  child.stderr.on("data", (chunk) => {
    run.err += chunk;
  });
  run.exit = new Promise((done) => {
    child.once("exit", (code, signal) => {
      run.exited = { code, signal };
      done(run.exited);
    });
  });
  return run;
}

const markerStep = (file) => ({
  suite: "vitest",
  file: NODE,
  args: ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "ran")`],
});

function acquiredPort(text) {
  const match = /(?:lock acquired for \w+ on|holding) port (\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

test("B1 acquire writes the full record and rewrites it on setChild", async () => {
  const dir = caseDir("b1");
  const held = await acquireLock({
    port: 0,
    sidecarDir: dir,
    record: { wrapperPid: 12345, suite: "vitest", cwd: "C:/repo" },
    log: noop,
  });
  assert.ok(held.port > 0 && held.port !== DEFAULT_PORT);
  assert.equal(held.degraded, false);
  const file = sidecarPath(held.port, dir);
  const first = readSidecar(file);
  assert.deepEqual(Object.keys(first).sort(), [
    "childPid",
    "cwd",
    "startedAt",
    "suite",
    "wrapperPid",
  ]);
  assert.equal(first.wrapperPid, 12345);
  assert.equal(first.childPid, null);
  assert.equal(first.suite, "vitest");
  assert.equal(first.cwd, "C:/repo");
  assert.ok(Number.isFinite(Date.parse(first.startedAt)));
  assert.deepEqual(readdirSync(dir), [basename(file)]);
  held.setChild(777);
  const second = readSidecar(file);
  assert.equal(second.childPid, 777);
  assert.equal(second.startedAt, first.startedAt);
  assert.deepEqual(readdirSync(dir), [basename(file)]);
  await held.release();
  assert.equal(existsSync(file), false);
});

test("B2 a second bind waits, announcing the holder every announceMs", async () => {
  const dir = caseDir("b2");
  const holder = await acquireLock({
    port: 0,
    sidecarDir: dir,
    record: holderRecord("rust"),
    log: noop,
  });
  holder.setChild(4321);
  const port = holder.port;
  const clock = manualClock();
  const lines = [];
  const contender = track(
    acquireLock({
      port,
      sidecarDir: dir,
      record: holderRecord("vitest"),
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => lines.push(line),
    }),
  );
  await clock.tick(5);
  await clock.idle();
  assert.equal(contender.done, false);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.match(
    line,
    new RegExp(`^full-suite: waiting - rust holds port ${port} `),
  );
  assert.ok(line.includes(`wrapper pid ${process.pid}`), line);
  assert.ok(line.includes("child pid 4321"), line);
  assert.ok(line.includes("cwd C:/holder"), line);
  assert.ok(line.includes(`[sidecar ${sidecarPath(port, dir)}]`), line);
  await clock.tick(26);
  await clock.idle();
  assert.equal(contender.done, false);
  assert.equal(lines.length, 3);
  assert.ok(
    lines.every((l) => l.startsWith("full-suite: waiting - rust holds")),
  );
  await holder.release();
  const held = await bounded(
    clock.drive(contender),
    `contender on port ${port}`,
  );
  assert.equal(held.port, port);
  await held.release();
});

test("B3 an unknown holder is named as unknown, sidecar or not", async () => {
  const dir = caseDir("b3");
  const server = await listenLoopback();
  const port = server.address().port;
  const clock = manualClock();
  const lines = [];
  const unknown = `full-suite: waiting - held by an unknown process on port ${port} (or by a wrapper still checking a previous run's child) [sidecar ${sidecarPath(port, dir)}]`;
  try {
    const contender = track(
      acquireLock({
        port,
        sidecarDir: dir,
        record: holderRecord(),
        isAlive: () => false,
        isWrapperAlive: () => false,
        now: clock.now,
        sleep: clock.sleep,
        log: (line) => lines.push(line),
      }),
    );
    await clock.idle();
    assert.deepEqual(lines, [unknown]);
    // A readable record whose wrapper is dead describes an earlier run.
    writeRecord(sidecarPath(port, dir), {
      wrapperPid: 31337,
      startedAt: new Date(clock.now()).toISOString(),
    });
    await clock.tick(15);
    await clock.idle();
    assert.equal(contender.done, false);
    assert.deepEqual(lines, [unknown, unknown]);
    await closeServer(server);
    const held = await bounded(
      clock.drive(contender),
      `contender on port ${port}`,
    );
    await held.release();
  } finally {
    if (server.listening) await closeServer(server);
  }
});

test("B4 a live child of the previous run keeps the new holder waiting", async () => {
  const dir = caseDir("b4");
  const sidecarFile = join(dir, "previous.json");
  const clock = manualClock();
  const before = writeRecord(sidecarFile, {
    startedAt: new Date(clock.now() - 60_000).toISOString(),
  });
  let alive = true;
  const lines = [];
  const holder = track(
    acquireLock({
      port: 0,
      sidecarFile,
      record: { wrapperPid: 999, suite: "vitest", cwd: "C:/next" },
      isAlive: (pid) => pid === FAKE_CHILD && alive,
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => lines.push(line),
    }),
  );
  await clock.idle();
  const port = acquiredPort(lines[0] ?? "");
  assert.ok(port > 0, lines[0]);
  await assert.rejects(bindPort(port), { code: "EADDRINUSE" });
  await clock.tick(3);
  await clock.idle();
  assert.equal(holder.done, false);
  assert.equal(lines.length, 1);
  assert.ok(
    lines[0].includes(
      `holding port ${port}; ${STILL_ALIVE} (rust, ${RUN_ID} ${FAKE_CHILD}, cwd C:/previous, started 1m 0`,
    ),
    lines[0],
  );
  assert.equal(readFileSync(sidecarFile, "utf8"), before);
  alive = false;
  const held = await bounded(clock.drive(holder), "the child check to end");
  const own = readSidecar(sidecarFile);
  assert.equal(own.wrapperPid, 999);
  assert.equal(own.childPid, null);
  await held.release();
});

test("B4 real processes: a killed holder's child blocks the next run on POSIX and dies with it on win32", async () => {
  const dir = caseDir("b4real");
  const ran = join(dir, "contender-ran");
  const holder = startHarness({
    steps: [{ suite: "vitest", file: NODE, args: [sleeper] }],
    suite: "vitest",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(() => acquiredPort(holder.err) !== null, "the holder's port");
  const port = acquiredPort(holder.err);
  const file = sidecarPath(port, dir);
  await waitFor(
    () => Number.isInteger(readSidecar(file)?.childPid),
    `the sleeper pid in ${file}`,
  );
  const sleeperPid = watchPid(await childPidFrom(file));
  const contender = startHarness({
    steps: [markerStep(ran)],
    suite: "rust",
    cwd: tmpdir(),
    port,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(
    () => contender.err.includes(`waiting - vitest holds port ${port}`),
    `the contender to wait on port ${port}`,
  );
  // SIGKILL on POSIX: a default SIGTERM would be forwarded to the sleeper.
  holder.child.kill(WIN32 ? undefined : "SIGKILL");
  await holder.exit;
  if (WIN32) {
    // libuv puts every child in a kill-on-close job object, so a hard-killed
    // wrapper takes its direct child with it and the next run proceeds.
    await waitFor(() => !isPidAlive(sleeperPid), "the job object to end it");
    pids.delete(sleeperPid);
  } else {
    await waitFor(
      () => contender.err.includes(`holding port ${port}; ${STILL_ALIVE}`),
      `the contender to rebind port ${port} and find the orphan`,
    );
    assert.equal(existsSync(ran), false);
    assert.equal(isPidAlive(sleeperPid), true);
    pids.delete(sleeperPid);
    killPid(sleeperPid);
  }
  const exited = await bounded(contender.exit, `contender on port ${port}`);
  assert.equal(exited.code, 0, contender.err);
  assert.equal(existsSync(ran), true);
});

test("B4 real processes: a wrapper killed in its child check keeps the orphan's hold", async () => {
  const dir = caseDir("b4orphan");
  const sidecarFile = join(dir, "previous.json");
  const ran = join(dir, "contender-ran");
  const never = join(dir, "never");
  // POSIX checks a run by its process group, so the orphan leads one.
  const orphan = spawn(NODE, [sleeper], { stdio: "ignore", detached: !WIN32 });
  processes.add(orphan);
  const body = writeRecord(sidecarFile, {
    childPid: orphan.pid,
    startedAt: new Date().toISOString(),
  });
  const checking = startHarness({
    steps: [markerStep(never)],
    suite: "vitest",
    cwd: tmpdir(),
    port: 0,
    sidecarFile,
    pollMs: 20,
  });
  await waitFor(
    () => acquiredPort(checking.err) !== null,
    "the checker's port",
  );
  const port = acquiredPort(checking.err);
  const next = startHarness({
    steps: [markerStep(ran)],
    suite: "rust",
    cwd: tmpdir(),
    port,
    sidecarFile,
    pollMs: 20,
  });
  await waitFor(
    () => next.err.includes("full-suite: waiting - "),
    `the next run to wait on port ${port}`,
  );
  checking.child.kill(WIN32 ? undefined : "SIGKILL");
  await checking.exit;
  await waitFor(
    () => next.err.includes(`holding port ${port}; ${STILL_ALIVE}`),
    `the next run to rebind port ${port} and find the orphan`,
  );
  assert.equal(readFileSync(sidecarFile, "utf8"), body);
  assert.equal(existsSync(ran), false);
  orphan.kill();
  const exited = await bounded(next.exit, `next run on port ${port}`);
  assert.equal(exited.code, 0, next.err);
  assert.equal(existsSync(ran), true);
  assert.equal(existsSync(never), false);
});

test("B5 a dead or absent previous child proceeds at once", async () => {
  for (const childPid of [FAKE_CHILD, null]) {
    const dir = caseDir("b5");
    const sidecarFile = join(dir, "previous.json");
    const clock = manualClock();
    writeRecord(sidecarFile, {
      childPid,
      startedAt: new Date(clock.now() - 60_000).toISOString(),
    });
    const state = track(
      acquireLock({
        port: 0,
        sidecarFile,
        record: holderRecord(),
        isAlive: () => false,
        now: clock.now,
        sleep: clock.sleep,
        log: noop,
      }),
    );
    assert.equal(
      await settledAtOnce(state, clock),
      true,
      `childPid ${childPid}`,
    );
    await state.value.release();
  }
});

test("B6 the default cap releases an orphan at exactly MAX_HOLD_MS", async () => {
  assert.equal(MAX_HOLD_MS, 7_200_000);
  const atCapDir = caseDir("b6");
  const atCap = join(atCapDir, "previous.json");
  const clock = manualClock();
  writeRecord(atCap, {
    startedAt: new Date(clock.now() - MAX_HOLD_MS).toISOString(),
  });
  const state = track(
    acquireLock({
      port: 0,
      sidecarFile: atCap,
      record: holderRecord(),
      isAlive: (pid) => pid === FAKE_CHILD,
      now: clock.now,
      sleep: clock.sleep,
      log: noop,
    }),
  );
  assert.equal(await settledAtOnce(state, clock), true, "age exactly the cap");
  await state.value.release();

  const underDir = caseDir("b6");
  const under = join(underDir, "previous.json");
  const clock2 = manualClock();
  writeRecord(under, {
    startedAt: new Date(clock2.now() - (MAX_HOLD_MS - 1000)).toISOString(),
  });
  const lines = [];
  const waiting = track(
    acquireLock({
      port: 0,
      sidecarFile: under,
      record: holderRecord(),
      isAlive: (pid) => pid === FAKE_CHILD,
      now: clock2.now,
      sleep: clock2.sleep,
      log: (line) => lines.push(line),
    }),
  );
  await clock2.idle();
  assert.equal(waiting.done, false);
  assert.ok(lines[0].includes(STILL_ALIVE), lines[0]);
  const held = await bounded(clock2.drive(waiting), "the cap to pass");
  assert.equal(clock2.sleeps, 1);
  await held.release();
});

test("B7 a pid outside 1..2**31-1 is never probed", async () => {
  const garbage = [0, -1, 1.5, "12", 2 ** 31, 2 ** 53];
  const probed = [];
  const spy = (pid) => {
    probed.push(pid);
    return true;
  };
  for (const childPid of garbage) {
    const dir = caseDir("b7");
    const sidecarFile = join(dir, "previous.json");
    const clock = manualClock();
    writeRecord(sidecarFile, {
      childPid,
      startedAt: new Date(clock.now()).toISOString(),
    });
    const state = track(
      acquireLock({
        port: 0,
        sidecarFile,
        record: holderRecord(),
        isAlive: spy,
        now: clock.now,
        sleep: clock.sleep,
        log: noop,
      }),
    );
    assert.equal(
      await settledAtOnce(state, clock),
      true,
      `childPid ${childPid}`,
    );
    await state.value.release();
  }
  assert.deepEqual(probed, []);
  const now = () => Date.parse("2026-01-01T00:01:00Z");
  const top = {
    childPid: 2 ** 31 - 1,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(orphanBlocks(top, { isAlive: spy, now }), true);
  assert.deepEqual(probed, [2 ** 31 - 1]);

  const kill = process.kill;
  const killed = [];
  process.kill = (pid, signal) => {
    killed.push(pid);
    return kill.call(process, pid, signal);
  };
  try {
    for (const pid of [...garbage, null, undefined]) {
      assert.equal(isPidAlive(pid), false, `pid ${pid}`);
    }
  } finally {
    process.kill = kill;
  }
  assert.deepEqual(killed, []);
});

test("B8 a missing, unreadable or malformed sidecar proceeds", async () => {
  const now = Date.now();
  const bodies = {
    missing: null,
    empty: "",
    truncated: `{"wrapperPid":1,"childPid":${FAKE_CHILD},"suite":"rust"`,
    array: `[${FAKE_CHILD}]`,
    "no startedAt": JSON.stringify({ wrapperPid: 1, childPid: FAKE_CHILD }),
    "unparseable startedAt": JSON.stringify({
      childPid: FAKE_CHILD,
      startedAt: "yesterday-ish",
    }),
    "future startedAt": JSON.stringify({
      childPid: FAKE_CHILD,
      startedAt: new Date(now + 60_000).toISOString(),
    }),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const dir = caseDir("b8");
    const sidecarFile = join(dir, "previous.json");
    if (body !== null) writeFileSync(sidecarFile, body);
    const clock = manualClock(now);
    const state = track(
      acquireLock({
        port: 0,
        sidecarFile,
        record: holderRecord(),
        isAlive: () => true,
        now: clock.now,
        sleep: clock.sleep,
        log: noop,
      }),
    );
    assert.equal(await settledAtOnce(state, clock), true, name);
    await state.value.release();
  }
});

function assertSerial(entries) {
  let open = null;
  for (const entry of entries) {
    const [kind, id] = entry.split(" ");
    if (kind === "start") {
      assert.equal(open, null, `start ${id} while ${open} ran: ${entries}`);
      open = id;
    } else {
      assert.equal(open, id, `end ${id} while ${open} ran: ${entries}`);
      open = null;
    }
  }
}

function readEntries(log) {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

test("B9 four real contenders never overlap; unserialized ones do", async () => {
  const dir = caseDir("b9");
  const log = join(dir, "runs.log");
  writeFileSync(log, "");
  const gate = await listenLoopback();
  const port = gate.address().port;
  const runs = [];
  try {
    for (const id of ["a", "b", "c", "d"]) {
      runs.push(
        startHarness({
          steps: [
            { suite: "vitest", file: NODE, args: [marker, log, id, "short"] },
          ],
          suite: "vitest",
          cwd: tmpdir(),
          port,
          sidecarDir: dir,
          pollMs: 20,
        }),
      );
    }
    await waitFor(
      () =>
        runs.every((run) =>
          run.err.includes(
            `waiting - held by an unknown process on port ${port}`,
          ),
        ),
      `four contenders waiting on port ${port}`,
    );
  } finally {
    await closeServer(gate);
  }
  const codes = await bounded(
    Promise.all(runs.map((run) => run.exit)),
    `four contenders to take port ${port} in turn`,
  );
  assert.deepEqual(
    codes.map((c) => c.code),
    [0, 0, 0, 0],
  );
  const entries = readEntries(log);
  assert.equal(entries.length, 8, `${entries}`);
  assertSerial(entries);

  // Negative control: own ports, so nothing serializes them.
  const freeDir = caseDir("b9free");
  const freeLog = join(freeDir, "runs.log");
  writeFileSync(freeLog, "");
  const free = ["a", "b", "c", "d"].map((id) =>
    startHarness({
      steps: [
        { suite: "vitest", file: NODE, args: [marker, freeLog, id, "overlap"] },
      ],
      suite: "vitest",
      cwd: tmpdir(),
      port: 0,
      sidecarDir: freeDir,
      pollMs: 20,
    }),
  );
  await bounded(Promise.all(free.map((run) => run.exit)), "unserialized runs");
  const freeEntries = readEntries(freeLog);
  assert.ok(
    freeEntries.slice(0, 4).every((entry) => entry.startsWith("start ")),
    `${freeEntries}`,
  );
  assert.throws(() => assertSerial(freeEntries));
});

test("B10 a failed run still releases before a waiting contender writes", async () => {
  const cases = [
    [
      "exit 3",
      { suite: "vitest", file: NODE, args: ["-e", "process.exit(3)"] },
      3,
    ],
    [
      "missing binary",
      { suite: "vitest", file: join(root, "no-such-binary"), args: [] },
      2,
    ],
  ];
  for (const [name, step, expected] of cases) {
    const dir = caseDir("b10");
    const sidecarFile = join(dir, "run.json");
    writeRecord(sidecarFile, { startedAt: new Date().toISOString() });
    let orphanAlive = true;
    const lines = [];
    const run = track(
      runUnderLock({
        steps: [step],
        suite: "vitest",
        cwd: tmpdir(),
        port: 0,
        sidecarFile,
        pollMs: 10,
        isAlive: (pid) => (pid === FAKE_CHILD ? orphanAlive : isPidAlive(pid)),
        log: (line) => lines.push(line),
      }),
    );
    await waitFor(
      () => acquiredPort(lines.join("\n")) !== null,
      `${name}: port`,
    );
    const port = acquiredPort(lines.join("\n"));
    const contenderLines = [];
    let sidecarAtBind;
    // Real-time polls: a red case must not leave this contender polling on.
    let over = false;
    const contender = track(
      acquireLock({
        port,
        sidecarFile,
        record: { wrapperPid: 7777, suite: "rust", cwd: "C:/next" },
        pollMs: 10,
        sleep: (ms) =>
          over
            ? Promise.reject(new Error("case over"))
            : new Promise((done) => setTimeout(done, ms)),
        bind: async (p) => {
          const server = await bindPort(p);
          sidecarAtBind = existsSync(sidecarFile);
          return server;
        },
        log: (line) => contenderLines.push(line),
      }),
    );
    contender.promise.catch(noop);
    try {
      await waitFor(
        () =>
          contenderLines.some((l) => l.startsWith("full-suite: waiting - ")),
        `${name}: contender waiting on port ${port}`,
      );
      orphanAlive = false;
      assert.equal(await bounded(run.promise, `${name}: run`), expected, name);
      const held = await bounded(
        contender.promise,
        `${name}: contender on port ${port}`,
      );
      assert.equal(sidecarAtBind, false, name);
      assert.equal(readSidecar(sidecarFile).wrapperPid, 7777, name);
      await held.release();
    } finally {
      over = true;
    }
  }
});

test("B11 contention never degrades; a persistent bind error does", async () => {
  const dir = caseDir("b11");
  const holder = await acquireLock({
    port: 0,
    sidecarDir: dir,
    record: holderRecord(),
    log: noop,
  });
  const port = holder.port;
  const ran = join(caseDir("b11ran"), "ran");
  const clock = manualClock();
  const lines = [];
  const run = track(
    runUnderLock({
      steps: [markerStep(ran)],
      suite: "vitest",
      cwd: tmpdir(),
      port,
      sidecarDir: dir,
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => lines.push(line),
    }),
  );
  await clock.tick(150);
  await clock.idle();
  assert.equal(run.done, false);
  assert.equal(existsSync(ran), false);
  assert.ok(lines.length >= 10, `${lines.length} lines`);
  assert.ok(
    lines.every((l) => l.startsWith("full-suite: waiting - ")),
    `${lines}`,
  );
  await holder.release();
  assert.equal(await bounded(clock.drive(run), `run on port ${port}`), 0);
  assert.equal(existsSync(ran), true);

  // EACCES on every attempt: degraded once, after a whole announceMs.
  const eaccesDir = caseDir("b11eacces");
  const ran2 = join(caseDir("b11ran"), "ran");
  const clock2 = manualClock();
  const start = clock2.now();
  const lines2 = [];
  let degradedAt = null;
  const denied = track(
    runUnderLock({
      steps: [markerStep(ran2)],
      suite: "vitest",
      cwd: tmpdir(),
      port: 0,
      sidecarDir: eaccesDir,
      bind: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      now: clock2.now,
      sleep: clock2.sleep,
      log: (line) => {
        lines2.push(line);
        if (line.includes("running unserialized")) degradedAt = clock2.now();
      },
    }),
  );
  await clock2.tick(14);
  await clock2.idle();
  assert.equal(degradedAt, null);
  assert.equal(await bounded(clock2.drive(denied), "degraded run"), 0);
  assert.equal(degradedAt - start, 30_000);
  assert.deepEqual(
    lines2.filter((l) => l.includes("running unserialized")),
    ["full-suite: could not bind port 0 (EACCES) - running unserialized"],
  );
  assert.equal(existsSync(ran2), true);
  assert.deepEqual(readdirSync(eaccesDir), []);

  // One EADDRINUSE inside the window restarts it.
  const clock3 = manualClock();
  const start3 = clock3.now();
  let attempts = 0;
  let degradedAt3 = null;
  const mixed = track(
    acquireLock({
      port: 0,
      sidecarDir: caseDir("b11mixed"),
      record: holderRecord(),
      bind: async () => {
        attempts += 1;
        const code = attempts === 11 ? "EADDRINUSE" : "EACCES";
        throw Object.assign(new Error(code), { code });
      },
      now: clock3.now,
      sleep: clock3.sleep,
      log: (line) => {
        if (line.includes("running unserialized")) degradedAt3 = clock3.now();
      },
    }),
  );
  await clock3.tick(25);
  await clock3.idle();
  assert.equal(degradedAt3, null);
  const result = await bounded(clock3.drive(mixed), "mixed bind errors");
  assert.equal(result.degraded, true);
  assert.equal(degradedAt3 - start3, 52_000);
});

test("B12 isPidAlive tells a live pid from an exited one", async () => {
  assert.equal(isPidAlive(process.pid), true);
  const child = spawn(NODE, ["-e", ""], { stdio: "ignore" });
  await bounded(
    new Promise((done) => child.once("exit", done)),
    "a short child to exit",
  );
  assert.equal(isPidAlive(child.pid), false);
});

test("B13 commandsFor maps each mode to its argv", () => {
  const rootDir = join("C:", "repo");
  const vitest = join(rootDir, "node_modules", "vitest", "vitest.mjs");
  const extra = ["--", "git::branches::"];
  assert.deepEqual(commandsFor("rust", [], rootDir), [
    {
      suite: "rust",
      file: "cargo",
      args: ["test", "--manifest-path", "src-tauri/Cargo.toml"],
    },
  ]);
  assert.deepEqual(commandsFor("rust", extra, rootDir)[0].args, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--",
    "git::branches::",
  ]);
  assert.deepEqual(commandsFor("vitest", extra, rootDir), [
    { suite: "vitest", file: NODE, args: [vitest, "run", ...extra] },
  ]);
  assert.deepEqual(commandsFor("all", [], rootDir), [
    ...commandsFor("rust", [], rootDir),
    ...commandsFor("vitest", [], rootDir),
  ]);
  assert.throws(() => commandsFor("all", extra, rootDir));
  assert.throws(() => commandsFor("bogus", [], rootDir));
  assert.throws(() => commandsFor(undefined, [], rootDir));
  // A rustEnv rides the rust step only.
  const rustEnv = { Path: "C:\\git\\bin" };
  const [rustStep] = commandsFor("rust", [], rootDir, rustEnv);
  assert.equal(rustStep.env, rustEnv);
  const [allRust, allVitest] = commandsFor("all", [], rootDir, rustEnv);
  assert.equal(allRust.env, rustEnv);
  assert.equal("env" in allVitest, false);
  assert.equal("env" in commandsFor("vitest", [], rootDir, rustEnv)[0], false);
});

test("B14 all runs every step and resolves the first failure", async () => {
  const fail = (code) => ({
    suite: "rust",
    file: NODE,
    args: ["-e", `process.exit(${code})`],
  });
  const dir = caseDir("b14");
  const ran = join(dir, "second-ran");
  const lines = [];
  const code = await runUnderLock({
    steps: [fail(4), markerStep(ran)],
    suite: "all",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    log: (line) => lines.push(line),
  });
  assert.equal(code, 4);
  assert.equal(existsSync(ran), true);
  const verdicts = lines.filter((l) => / exited \d+ after \d+s$/.test(l));
  assert.equal(verdicts.length, 2, `${lines}`);
  assert.match(verdicts[0], /^full-suite: rust exited 4 after/);
  assert.match(verdicts[1], /^full-suite: vitest exited 0 after/);
  const passing = { ...fail(0) };
  const second = { ...fail(5), suite: "vitest" };
  assert.equal(
    await runUnderLock({
      steps: [passing, second],
      suite: "all",
      cwd: tmpdir(),
      port: 0,
      sidecarDir: dir,
      log: noop,
    }),
    5,
  );
  assert.equal(
    await runUnderLock({
      steps: [passing, { ...passing, suite: "vitest" }],
      suite: "all",
      cwd: tmpdir(),
      port: 0,
      sidecarDir: dir,
      log: noop,
    }),
    0,
  );
});

test("B15 preflight refuses before any bind", async () => {
  const empty = caseDir("b15");
  const cargoOk = () => true;
  const cargoMissing = () => false;
  assert.match(
    preflight("vitest", { repoRoot: empty, probeCargo: cargoOk }),
    /vitest\.mjs is missing/,
  );
  assert.match(
    preflight("rust", { repoRoot: empty, probeCargo: cargoMissing }),
    /cargo --version/,
  );
  assert.equal(
    preflight("rust", { repoRoot: empty, probeCargo: cargoOk }),
    null,
  );
  assert.match(
    preflight("all", { repoRoot: empty, probeCargo: cargoOk }),
    /vitest\.mjs is missing/,
  );
  assert.match(
    preflight("all", {
      repoRoot: empty,
      probeCargo: cargoMissing,
      exists: () => true,
    }),
    /cargo --version/,
  );
  assert.equal(
    preflight("all", {
      repoRoot: empty,
      probeCargo: cargoOk,
      exists: () => true,
    }),
    null,
  );

  const binds = [];
  const lines = [];
  const deps = (extra) => ({
    env: {},
    repoRoot: empty,
    sidecarDir: empty,
    bind: async (port) => {
      binds.push(port);
      throw new Error("bind must not be reached");
    },
    log: (line) => lines.push(line),
    ...extra,
  });
  assert.equal(await main(["vitest"], deps({ probeCargo: cargoOk })), 2);
  assert.equal(await main(["rust"], deps({ probeCargo: cargoMissing })), 2);
  assert.equal(await main(["all"], deps({ probeCargo: cargoMissing })), 2);
  // Usage errors and a bad port refuse before preflight, let alone a bind.
  assert.equal(await main([], deps({})), 2);
  assert.equal(await main(["bogus"], deps({})), 2);
  assert.equal(await main(["all", "--"], deps({})), 2);
  assert.equal(
    await main(["vitest"], deps({ env: { GD_FULL_SUITE_PORT: "abc" } })),
    2,
  );
  assert.deepEqual(binds, []);
  assert.equal(lines.length, 7);
  assert.ok(
    lines.every((l) => l.startsWith("full-suite: ")),
    `${lines}`,
  );
});

test("B16 portFromEnv accepts only an integer 1024..65535", () => {
  assert.equal(portFromEnv(undefined), DEFAULT_PORT);
  assert.equal(portFromEnv(""), DEFAULT_PORT);
  assert.equal(portFromEnv("30123"), 30123);
  for (const bad of ["abc", "0", "80", "70000", "1.5", " 30123x"]) {
    assert.throws(() => portFromEnv(bad), /GD_FULL_SUITE_PORT/, bad);
  }
});

test("B16 main binds the port GD_FULL_SUITE_PORT names", async () => {
  const bound = [];
  const lines = [];
  await assert.rejects(
    main(["vitest"], {
      env: { GD_FULL_SUITE_PORT: "30123" },
      sidecarDir: caseDir("b16"),
      exists: () => true,
      bind: async (port) => {
        bound.push(port);
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      sleep: () => Promise.reject(new Error("stop polling")),
      log: (line) => lines.push(line),
    }),
    /stop polling/,
  );
  assert.deepEqual(bound, [30123]);
  assert.deepEqual(lines, [
    "full-suite: using port 30123 from GD_FULL_SUITE_PORT",
  ]);
});

test("B17 SIGTERM releases a running wrapper and spares a checking one's evidence", {
  skip:
    process.platform === "win32"
      ? "POSIX signal paths: node on win32 receives no SIGTERM, and the wrapper never kills its child there"
      : false,
}, async () => {
  const dir = caseDir("b17");
  const ran = join(dir, "contender-ran");
  const holder = startHarness({
    steps: [{ suite: "vitest", file: NODE, args: [sleeper] }],
    suite: "vitest",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(() => acquiredPort(holder.err) !== null, "the holder's port");
  const port = acquiredPort(holder.err);
  const file = sidecarPath(port, dir);
  await waitFor(
    () => Number.isInteger(readSidecar(file)?.childPid),
    `the sleeper pid in ${file}`,
  );
  const sleeperPid = watchPid(await childPidFrom(file));
  const contender = startHarness({
    steps: [markerStep(ran)],
    suite: "rust",
    cwd: tmpdir(),
    port,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(
    () => contender.err.includes(`waiting - vitest holds port ${port}`),
    `the contender to wait on port ${port}`,
  );
  holder.child.kill("SIGTERM");
  const holderExit = await bounded(holder.exit, "the holder to exit");
  assert.equal(holderExit.code, 1, holder.err);
  assert.equal(isPidAlive(sleeperPid), false);
  pids.delete(sleeperPid);
  const after = readSidecar(file);
  assert.ok(after === null || after.wrapperPid === contender.child.pid);
  const exited = await bounded(contender.exit, `contender on port ${port}`);
  assert.equal(exited.code, 0, contender.err);
  assert.equal(existsSync(ran), true);

  // A wrapper stopped in its child check leaves the previous record intact.
  const checkDir = caseDir("b17check");
  const sidecarFile = join(checkDir, "previous.json");
  const ran2 = join(checkDir, "contender-ran");
  // POSIX checks a run by its process group, so the orphan leads one.
  const orphan = spawn(NODE, [sleeper], { stdio: "ignore", detached: !WIN32 });
  processes.add(orphan);
  const body = writeRecord(sidecarFile, {
    childPid: orphan.pid,
    startedAt: new Date().toISOString(),
  });
  const checking = startHarness({
    steps: [markerStep(join(checkDir, "never"))],
    suite: "vitest",
    cwd: tmpdir(),
    port: 0,
    sidecarFile,
    pollMs: 20,
  });
  await waitFor(
    () => acquiredPort(checking.err) !== null,
    "the checker's port",
  );
  const port2 = acquiredPort(checking.err);
  const next = startHarness({
    steps: [markerStep(ran2)],
    suite: "rust",
    cwd: tmpdir(),
    port: port2,
    sidecarFile,
    pollMs: 20,
  });
  await waitFor(
    () => next.err.includes("full-suite: waiting - "),
    `the next run to wait on port ${port2}`,
  );
  checking.child.kill("SIGTERM");
  await bounded(checking.exit, "the checker to exit");
  await waitFor(
    () => next.err.includes(`holding port ${port2}; ${STILL_ALIVE}`),
    `the next run to rebind port ${port2}`,
  );
  assert.equal(readFileSync(sidecarFile, "utf8"), body);
  assert.equal(existsSync(join(checkDir, "never")), false);
  orphan.kill();
  const nextExit = await bounded(next.exit, `next run on port ${port2}`);
  assert.equal(nextExit.code, 0, next.err);
  assert.equal(existsSync(ran2), true);
});

test("B19 killGroup refuses every group id that is not a real pgid above 1", () => {
  const kill = process.kill;
  const calls = [];
  // Records only: a real kill(0) or kill(-1) would signal this test's own
  // group or every process the user owns.
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    for (const pgid of [0, 1, -1, -5, 1.5, "7", null, 2 ** 31]) {
      assert.throws(() => killGroup(pgid, "SIGTERM"), RangeError, `${pgid}`);
      assert.equal(isGroupAlive(pgid), false, `${pgid}`);
    }
  } finally {
    process.kill = kill;
  }
  assert.deepEqual(calls, []);
});

const LINUX_ONLY =
  process.platform === "linux" ? false : "reads process state from /proc";

const POSIX_ONLY = WIN32
  ? "POSIX process groups: on win32 the kill-on-close jobs end the tree"
  : false;

function fakeCargoStep(dir, trigger = "", mode = "") {
  return {
    suite: "rust",
    file: NODE,
    args: [
      fakeCargo,
      grandchild,
      join(dir, "gone"),
      join(dir, "gc.pid"),
      trigger,
      mode,
    ],
  };
}

test("B20 SIGTERM reaches the whole group and the port waits for it", {
  skip: POSIX_ONLY,
}, async () => {
  const dir = caseDir("b20");
  const gone = join(dir, "gone");
  const seen = join(dir, "seen");
  const holder = startHarness({
    steps: [fakeCargoStep(dir)],
    suite: "rust",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(() => acquiredPort(holder.err) !== null, "the holder's port");
  const port = acquiredPort(holder.err);
  const gcPid = watchPid(await pidFromFile(join(dir, "gc.pid")));
  const contender = startHarness({
    steps: [
      {
        suite: "vitest",
        file: NODE,
        args: [
          "-e",
          `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(seen)}, String(fs.existsSync(${JSON.stringify(gone)})))`,
        ],
      },
    ],
    suite: "vitest",
    cwd: tmpdir(),
    port,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(
    () => contender.err.includes(`waiting - rust holds port ${port}`),
    `the contender to wait on port ${port}`,
  );
  holder.child.kill("SIGTERM");
  await bounded(holder.exit, "the holder to exit");
  // The grandchild got the SIGTERM itself and wrote its marker on the way
  // out, before the holder let go of the port.
  assert.equal(existsSync(gone), true, holder.err);
  await waitFor(() => !isPidAlive(gcPid), "the grandchild to be reaped");
  pids.delete(gcPid);
  const exited = await bounded(contender.exit, `contender on port ${port}`);
  assert.equal(exited.code, 0, contender.err);
  assert.equal(readFileSync(seen, "utf8"), "true");
});

test("B21 a killed wrapper's group keeps blocking after its leader exits", {
  skip: POSIX_ONLY,
}, async () => {
  const dir = caseDir("b21");
  const trigger = join(dir, "exit-now");
  const ran = join(dir, "contender-ran");
  const holder = startHarness({
    steps: [fakeCargoStep(dir, trigger)],
    suite: "rust",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(() => acquiredPort(holder.err) !== null, "the holder's port");
  const port = acquiredPort(holder.err);
  const file = sidecarPath(port, dir);
  await waitFor(
    () => Number.isInteger(readSidecar(file)?.childPid),
    `the fake cargo pid in ${file}`,
  );
  const cargoPid = watchPid(await childPidFrom(file));
  const gcPid = watchPid(await pidFromFile(join(dir, "gc.pid")));
  const contender = startHarness({
    steps: [markerStep(ran)],
    suite: "vitest",
    cwd: tmpdir(),
    port,
    sidecarDir: dir,
    pollMs: 20,
    announceMs: 200,
  });
  await waitFor(
    () => contender.err.includes(`waiting - rust holds port ${port}`),
    `the contender to wait on port ${port}`,
  );
  holder.child.kill("SIGKILL");
  await holder.exit;
  const orphanLines = () =>
    contender.err.split(`holding port ${port}; ${STILL_ALIVE}`).length - 1;
  await waitFor(
    () => orphanLines() > 0,
    `the contender to rebind port ${port} and find the group`,
  );
  writeFileSync(trigger, "");
  await waitFor(() => !isPidAlive(cargoPid), "the fake cargo to exit");
  pids.delete(cargoPid);
  const before = orphanLines();
  await waitFor(
    () => orphanLines() > before,
    "an orphan line after the group leader exited",
  );
  assert.equal(existsSync(ran), false);
  pids.delete(gcPid);
  killPid(gcPid, "SIGKILL");
  const exited = await bounded(contender.exit, `contender on port ${port}`);
  assert.equal(exited.code, 0, contender.err);
  assert.equal(existsSync(ran), true);
});

test("B22 test-side pids accept only 2..2**31-1", async () => {
  for (const bad of [
    "",
    "0",
    "1",
    "abc",
    " ",
    "-5",
    "1.5",
    "12x",
    0,
    1,
    -1,
    1.5,
    2 ** 31,
    null,
    undefined,
    Number.NaN,
  ]) {
    assert.equal(parsePid(bad), null, JSON.stringify(bad));
    assert.throws(() => watchPid(bad), assert.AssertionError);
    assert.throws(() => killPid(bad, 0), RangeError, JSON.stringify(bad));
  }
  assert.equal(parsePid("1234"), 1234);
  assert.equal(parsePid("42\n"), 42);
  assert.equal(parsePid(2 ** 31 - 1), 2 ** 31 - 1);
  // A pid file caught between truncate and write reads "", which never passes.
  const file = join(caseDir("b22"), "pid");
  writeFileSync(file, "");
  let reads = 0;
  const pending = waitForPid(() => {
    reads += 1;
    if (reads === 3) writeFileSync(file, "4321");
    return readFileSync(file, "utf8");
  }, file);
  assert.equal(await pending, 4321);
  assert.ok(reads >= 3);
});

test("B23 job control and SIGQUIT reach the suite's group", {
  skip: LINUX_ONLY,
}, async () => {
  const dir = caseDir("b23");
  const holder = startHarness({
    steps: [fakeCargoStep(dir)],
    suite: "rust",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(() => acquiredPort(holder.err) !== null, "the holder's port");
  const gcPid = watchPid(await pidFromFile(join(dir, "gc.pid")));
  const state = (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat[stat.lastIndexOf(") ") + 2];
    } catch {
      return null;
    }
  };
  holder.child.kill("SIGTSTP");
  await waitFor(() => state(gcPid) === "T", "the grandchild to stop");
  await waitFor(() => state(holder.child.pid) === "T", "the wrapper to stop");
  holder.child.kill("SIGCONT");
  await waitFor(() => state(gcPid) !== "T", "the grandchild to resume");
  holder.child.kill("SIGQUIT");
  // Forwarded: the wrapper outlives the group and exits on its own.
  const exited = await bounded(holder.exit, "the wrapper to exit");
  assert.deepEqual(exited, { code: 1, signal: null }, holder.err);
  assert.equal(isPidAlive(gcPid), false);
  pids.delete(gcPid);
});

test("B24 a group that ignores SIGTERM is SIGKILLed before the port is released", {
  skip: POSIX_ONLY,
}, async () => {
  const dir = caseDir("b24");
  const ran = join(dir, "contender-ran");
  const holder = startHarness({
    steps: [fakeCargoStep(dir, "", "stubborn")],
    suite: "rust",
    cwd: tmpdir(),
    port: 0,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(() => acquiredPort(holder.err) !== null, "the holder's port");
  const port = acquiredPort(holder.err);
  const gcPid = watchPid(await pidFromFile(join(dir, "gc.pid")));
  const contender = startHarness({
    steps: [markerStep(ran)],
    suite: "vitest",
    cwd: tmpdir(),
    port,
    sidecarDir: dir,
    pollMs: 20,
  });
  await waitFor(
    () => contender.err.includes(`waiting - rust holds port ${port}`),
    `the contender to wait on port ${port}`,
  );
  holder.child.kill("SIGTERM");
  await bounded(holder.exit, "the holder to exit");
  assert.ok(holder.err.includes("sending SIGKILL"), holder.err);
  assert.equal(holder.err.includes("releasing anyway"), false, holder.err);
  assert.equal(isPidAlive(gcPid), false);
  pids.delete(gcPid);
  const exited = await bounded(contender.exit, `contender on port ${port}`);
  assert.equal(exited.code, 0, contender.err);
  assert.equal(existsSync(ran), true);
});

const GIT_BIN = "C:\\Program Files\\Git\\mingw64\\bin";
const EXEC_PATH = "C:/Program Files/Git/mingw64/libexec/git-core\n";
const KEEP_LINE =
  "full-suite: rust step keeps PATH (GD_FULL_SUITE_KEEP_PATH=1)";
const GIT_SHIM = "C:\\Program Files\\Git\\cmd\\git.exe";
const PUT_LINE = `full-suite: rust step puts ${GIT_BIN} first on PATH (from ${GIT_SHIM} --exec-path)`;
const notExecPath = (trimmed) =>
  `git --exec-path printed ${JSON.stringify(trimmed)}, not a <prefix>/libexec/git-core path`;
const pathKeys = (env) => Object.keys(env).filter((k) => /^path$/i.test(k));

/**
 * main's deps: probeCargo, probeGitExecPath and run are recording spies, bind
 * throws if reached, and exists, isGitFile, platform and env are fixed stubs.
 */
function mainSeams(extra = {}) {
  const calls = { cargo: 0, probe: [], runs: [] };
  const lines = [];
  const deps = {
    env: { Path: "C:\\a" },
    repoRoot: join("C:", "repo"),
    platform: "win32",
    exists: () => true,
    isGitFile: () => true,
    probeCargo: () => {
      calls.cargo += 1;
      return true;
    },
    probeGitExecPath: (args) => {
      calls.probe.push(args);
      return { ok: true, stdout: EXEC_PATH, git: GIT_SHIM };
    },
    run: async (options) => {
      calls.runs.push(options);
      return 0;
    },
    bind: async () => {
      throw new Error("bind must not be reached");
    },
    log: (line) => lines.push(line),
    ...extra,
  };
  return { deps, calls, lines };
}

const pathLines = (lines) => lines.filter((l) => l.includes("PATH ("));

test("B25 keepPathFromEnv accepts only unset, empty, 0 and 1", async () => {
  assert.equal(keepPathFromEnv(undefined), false);
  assert.equal(keepPathFromEnv(""), false);
  assert.equal(keepPathFromEnv("0"), false);
  assert.equal(keepPathFromEnv("1"), true);
  for (const bad of ["true", "yes", " 1", "2", "01"]) {
    assert.throws(() => keepPathFromEnv(bad), /GD_FULL_SUITE_KEEP_PATH/, bad);
  }
  for (const platform of ["win32", "linux"]) {
    const { deps, calls, lines } = mainSeams({
      env: { GD_FULL_SUITE_KEEP_PATH: "yes" },
      platform,
    });
    assert.equal(await main(["all"], deps), 2, platform);
    assert.equal(calls.cargo, 0, platform);
    assert.equal(calls.probe.length, 0, platform);
    assert.equal(calls.runs.length, 0, platform);
    assert.equal(lines.length, 1, `${platform}: ${lines}`);
    assert.match(lines[0], /^full-suite: GD_FULL_SUITE_KEEP_PATH/);
  }
});

test("B26 realGitBinDir takes <prefix>\\bin from a libexec/git-core path", () => {
  const yes = () => true;
  for (const out of [
    EXEC_PATH,
    "C:\\Program Files\\Git\\mingw64\\libexec\\git-core",
    "C:/Program Files/Git/mingw64/libexec/git-core/",
    "C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\\r\n",
    "C:\\Program Files\\Git\\mingw64\\LIBEXEC\\Git-Core",
  ]) {
    assert.deepEqual(realGitBinDir(out, yes), { dir: GIT_BIN }, out);
  }
  assert.deepEqual(
    realGitBinDir("C:/Program Files/Git/clangarm64/libexec/git-core", yes),
    { dir: "C:\\Program Files\\Git\\clangarm64\\bin" },
  );
  assert.deepEqual(realGitBinDir("C:\\libexec\\git-core", yes), {
    dir: "C:\\bin",
  });
  assert.deepEqual(
    realGitBinDir("\\\\server\\share\\Git\\mingw64\\libexec\\git-core", yes),
    { dir: "\\\\server\\share\\Git\\mingw64\\bin" },
  );
  for (const out of [
    "/usr/lib/git-core\n",
    "libexec/git-core",
    "",
    "C:/",
    "C:/libexec",
    "/portable/libexec/git-core",
    "/usr/libexec/git-core",
    "\\\\server\\libexec\\git-core",
    "\\\\?\\C:\\Git\\libexec\\git-core",
    "\\\\.\\share\\Git\\libexec\\git-core",
    "C:/Git/libexec/other",
    "C:/Git\n/libexec/git-core",
    "C:/Gi\tt/libexec/git-core",
  ]) {
    let probed = 0;
    const result = realGitBinDir(out, () => {
      probed += 1;
      return true;
    });
    assert.deepEqual(result, { reason: notExecPath(out.trim()) }, out);
    assert.equal(probed, 0, out);
  }
  let semicolonProbed = 0;
  assert.deepEqual(
    realGitBinDir("C:/a;b/libexec/git-core", () => {
      semicolonProbed += 1;
      return true;
    }),
    { reason: `${JSON.stringify("C:\\a;b\\bin")} contains ';'` },
  );
  assert.equal(semicolonProbed, 0);
  const asked = [];
  assert.deepEqual(
    realGitBinDir(EXEC_PATH, (file) => {
      asked.push(file);
      return false;
    }),
    { reason: `no git.exe in ${GIT_BIN}` },
  );
  assert.deepEqual(asked, [`${GIT_BIN}\\git.exe`]);
});

test("B27 withPathFirst leaves one PATH key, the name a win32 child reads", () => {
  const dir = "C:\\git\\bin";
  const input = { Path: "C:\\a", X: "1" };
  const before = structuredClone(input);
  const result = withPathFirst(input, dir);
  assert.deepEqual(result, { Path: `${dir};C:\\a`, X: "1" });
  assert.deepEqual(pathKeys(result), ["Path"]);
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
  assert.deepEqual(withPathFirst({ PATH: "C:\\b" }, dir), {
    PATH: `${dir};C:\\b`,
  });
  const both = { Path: "C:\\a", PATH: "C:\\b" };
  const bothBefore = structuredClone(both);
  const merged = withPathFirst(both, dir);
  assert.deepEqual(pathKeys(merged), ["PATH"]);
  assert.equal(merged.PATH, `${dir};C:\\b`);
  assert.deepEqual(both, bothBefore);
  // An empty PATH is one empty entry to Rust, so it stays after dir.
  assert.deepEqual(withPathFirst({ Path: "" }, dir), { Path: `${dir};` });
  assert.deepEqual(withPathFirst({ X: "1" }, dir), { X: "1", Path: dir });
});

test("B28 rustStepEnv probes only on win32 without the opt-out", () => {
  let probes = 0;
  const probe = (answer) => () => {
    probes += 1;
    return answer;
  };
  const good = probe({ ok: true, stdout: EXEC_PATH, git: GIT_SHIM });
  const base = { env: { Path: "C:\\a" }, keepPath: false, exists: () => true };
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(rustStepEnv({ ...base, platform, probe: good }), {
      env: null,
      line: null,
    });
  }
  assert.equal(probes, 0);
  assert.deepEqual(
    rustStepEnv({ ...base, platform: "win32", keepPath: true, probe: good }),
    { env: null, line: KEEP_LINE },
  );
  assert.equal(probes, 0);
  assert.deepEqual(
    rustStepEnv({
      ...base,
      platform: "win32",
      probe: probe({ ok: false, detail: "ENOENT" }),
    }),
    {
      env: null,
      line: "full-suite: rust step keeps PATH (git --exec-path failed: ENOENT)",
    },
  );
  // A probe that never spawned says why, without the spawn-failure lead.
  assert.deepEqual(
    rustStepEnv({
      ...base,
      platform: "win32",
      probe: probe({ ok: false, reason: "no git.com or git.exe on PATH" }),
    }),
    {
      env: null,
      line: "full-suite: rust step keeps PATH (no git.com or git.exe on PATH)",
    },
  );
  assert.deepEqual(
    rustStepEnv({
      ...base,
      platform: "win32",
      probe: probe({ ok: true, stdout: "/usr/lib/git-core\n" }),
    }),
    {
      env: null,
      line: `full-suite: rust step keeps PATH (${notExecPath("/usr/lib/git-core")})`,
    },
  );
  assert.deepEqual(rustStepEnv({ ...base, platform: "win32", probe: good }), {
    env: { Path: `${GIT_BIN};C:\\a` },
    line: PUT_LINE,
  });
  const probed = probes;
  // A set GIT_EXEC_PATH is what git would print, so it is never probed.
  for (const key of ["GIT_EXEC_PATH", "git_exec_path"]) {
    const env = {
      Path: "C:\\a",
      [key]: "D:/OtherGit/mingw64/libexec/git-core",
    };
    assert.deepEqual(
      rustStepEnv({ ...base, env, platform: "win32", probe: good }),
      {
        env: null,
        line: "full-suite: rust step keeps PATH (GIT_EXEC_PATH is set)",
      },
      key,
    );
  }
  assert.equal(probes, probed);
  const emptyExecPath = { Path: "C:\\a", GIT_EXEC_PATH: "" };
  assert.deepEqual(
    rustStepEnv({
      ...base,
      env: emptyExecPath,
      platform: "win32",
      probe: good,
    }),
    { env: { ...emptyExecPath, Path: `${GIT_BIN};C:\\a` }, line: PUT_LINE },
  );
  assert.equal(probes, probed + 1);
  // Neither a throwing probe nor a throwing file check escapes.
  const boom = Object.assign(new Error("denied"), { code: "EACCES" });
  const resolveFailed =
    "full-suite: rust step keeps PATH (could not resolve the real git: EACCES)";
  assert.deepEqual(
    rustStepEnv({
      ...base,
      platform: "win32",
      probe: () => {
        throw boom;
      },
    }),
    { env: null, line: resolveFailed },
  );
  assert.deepEqual(
    rustStepEnv({
      ...base,
      platform: "win32",
      probe: good,
      exists: () => {
        throw boom;
      },
    }),
    { env: null, line: resolveFailed },
  );
});

test("B31 isFile is true only for a regular file", () => {
  const dir = caseDir("b31");
  const fakeExe = join(dir, "Git", "bin", "git.exe");
  mkdirSync(fakeExe, { recursive: true });
  const real = join(dir, "real.exe");
  writeFileSync(real, "");
  assert.equal(isFile(fakeExe), false);
  assert.equal(isFile(real), true);
  assert.equal(isFile(join(dir, "missing.exe")), false);
  // A directory named git.exe is no git: map the win32 candidate into dir.
  const underDir = (file) => isFile(join(dir, ...file.slice(3).split("\\")));
  assert.deepEqual(realGitBinDir("C:/Git/libexec/git-core", underDir), {
    reason: "no git.exe in C:\\Git\\bin",
  });
});

test("B36 exeSuffixes keeps PATHEXT's .com and .exe in order", () => {
  assert.deepEqual(exeSuffixes(undefined), [".exe"]);
  assert.deepEqual(exeSuffixes(".COM;.EXE;.BAT;.CMD"), [".com", ".exe"]);
  assert.deepEqual(exeSuffixes(".EXE;.COM"), [".exe", ".com"]);
  // Set but empty is not unset: Rust's fallback applies only to unset.
  assert.deepEqual(exeSuffixes(""), []);
  assert.deepEqual(exeSuffixes(".exe;;.Com"), [".exe", ".com"]);
  assert.deepEqual(exeSuffixes(".BAT;.CMD"), []);
});

test("B32 firstGitOnPath walks PATH in order, each suffix in order", () => {
  const cwd = "C:\\repo\\src-tauri";
  const comExe = [".com", ".exe"];
  const files = new Set([
    "C:\\one\\git.exe",
    "C:\\two\\git.com",
    "C:\\two\\git.exe",
    "C:\\a;b\\git.exe",
  ]);
  const asked = [];
  const has = (file) => {
    asked.push(file);
    return files.has(file);
  };
  const first = (path, suffixes = comExe, isFileFn = has) =>
    firstGitOnPath(path, suffixes, cwd, isFileFn);
  assert.equal(first("C:\\one;C:\\two"), "C:\\one\\git.exe");
  assert.deepEqual(asked, ["C:\\one\\git.com", "C:\\one\\git.exe"]);
  assert.equal(first("C:\\two;C:\\one"), "C:\\two\\git.com");
  asked.length = 0;
  assert.equal(first("C:\\two", [".exe", ".com"]), "C:\\two\\git.exe");
  assert.deepEqual(asked, ["C:\\two\\git.exe"]);
  assert.equal(first('"C:\\a;b";C:\\two'), "C:\\a;b\\git.exe");
  // Empty and relative entries resolve against cwd, as Rust's is_file does.
  asked.length = 0;
  assert.equal(first(";C:\\none;C:\\two", [".exe"]), "C:\\two\\git.exe");
  assert.deepEqual(asked, [
    `${cwd}\\git.exe`,
    "C:\\none\\git.exe",
    "C:\\two\\git.exe",
  ]);
  asked.length = 0;
  assert.equal(first("rel\\dir;.;C:\\one", [".exe"]), "C:\\one\\git.exe");
  assert.deepEqual(asked, [
    `${cwd}\\rel\\dir\\git.exe`,
    `${cwd}\\git.exe`,
    "C:\\one\\git.exe",
  ]);
  const only = (target) => (file) => file === target;
  assert.equal(
    first("tools;C:\\one", [".exe"], only(`${cwd}\\tools\\git.exe`)),
    `${cwd}\\tools\\git.exe`,
  );
  for (const entry of ["", "."]) {
    assert.equal(
      first(entry, [".exe"], only(`${cwd}\\git.exe`)),
      `${cwd}\\git.exe`,
      JSON.stringify(entry),
    );
  }
  asked.length = 0;
  assert.equal(first("C:\\one", []), null);
  assert.deepEqual(asked, []);
  assert.equal(first("C:\\none;C:\\other"), null);
  // A driveless rooted entry takes cwd's drive; a same-drive `C:x` is
  // relative to cwd.
  asked.length = 0;
  assert.equal(first("\\Git\\cmd;C:x", [".exe"]), null);
  assert.deepEqual(asked, ["C:\\Git\\cmd\\git.exe", `${cwd}\\x\\git.exe`]);
  // No PATH variable has no entries; an empty one is one entry, the cwd.
  asked.length = 0;
  assert.equal(first(undefined), null);
  assert.deepEqual(asked, []);
  assert.equal(first("", [".exe"]), null);
  assert.deepEqual(asked, [`${cwd}\\git.exe`]);
});

test("B33 probeResult maps every spawnSync outcome", () => {
  const git = "C:\\g\\git.exe";
  assert.deepEqual(probeResult({ error: { code: "ETIMEDOUT" } }, git), {
    ok: false,
    detail: "ETIMEDOUT",
  });
  assert.deepEqual(probeResult({ status: null, signal: "SIGTERM" }, git), {
    ok: false,
    detail: "signal SIGTERM",
  });
  assert.deepEqual(probeResult({ status: 3 }, git), {
    ok: false,
    detail: "exit 3",
  });
  assert.deepEqual(probeResult({ status: 0, stdout: "x" }, git), {
    ok: true,
    stdout: "x",
    git,
  });
});

test("B34 probeGitExecPath spawns the PATH git by its absolute path", () => {
  const spawned = [];
  const spawnFn = (file, args, options) => {
    spawned.push({ file, args, options });
    return { status: 0, stdout: "out" };
  };
  const env = { PATH: "C:\\none;C:\\g", X: "1" };
  const rustCwd = "C:\\repo\\src-tauri";
  const result = probeGitExecPath({
    env,
    cwd: "C:\\repo",
    rustCwd,
    isFileFn: (file) => file === "C:\\g\\git.exe",
    spawnFn,
  });
  assert.deepEqual(result, { ok: true, stdout: "out", git: "C:\\g\\git.exe" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, "C:\\g\\git.exe");
  assert.deepEqual(spawned[0].args, ["--exec-path"]);
  assert.equal(spawned[0].options.env, env);
  assert.equal(spawned[0].options.cwd, "C:\\repo");
  // The PATH key is read case-insensitively, as a win32 child reads it.
  const mixedCase = probeGitExecPath({
    env: { Path: "C:\\g" },
    cwd: "C:\\repo",
    rustCwd,
    isFileFn: (file) => file === "C:\\g\\git.exe",
    spawnFn,
  });
  assert.deepEqual(mixedCase, {
    ok: true,
    stdout: "out",
    git: "C:\\g\\git.exe",
  });
  assert.equal(spawned.length, 2);
  spawned.length = 1;
  // No git on PATH: answered without a spawn, through the real isFile.
  assert.deepEqual(
    probeGitExecPath({
      env: { PATH: caseDir("b34") },
      cwd: tmpdir(),
      rustCwd: caseDir("b34cwd"),
      spawnFn,
    }),
    { ok: false, reason: "no git.exe on PATH" },
  );
  assert.equal(spawned.length, 1);
});

test("B37 probeGitExecPath follows PATHEXT and resolves PATH like Rust", () => {
  const rustCwd = "C:\\repo\\src-tauri";
  const noGit = (tried) => ({ ok: false, reason: `no ${tried} on PATH` });
  const spawned = [];
  const spawnFn = (file, args, options) => {
    spawned.push({ file, options });
    return { status: 0, stdout: "out" };
  };
  const probeAsking = (env, isFileFn = () => false) => {
    const asked = [];
    const result = probeGitExecPath({
      env,
      cwd: "C:\\elsewhere",
      rustCwd,
      isFileFn: (file) => {
        asked.push(file);
        return isFileFn(file);
      },
      spawnFn,
    });
    return { result, asked };
  };
  // The PATHEXT key is read case-insensitively, as a win32 child reads it.
  const mixed = probeAsking({ Path: "C:\\g", PathExt: ".COM" });
  assert.deepEqual(mixed.result, noGit("git.com"));
  assert.deepEqual(mixed.asked, ["C:\\g\\git.com"]);
  const ordered = probeAsking({ PATH: "C:\\g", PATHEXT: ".EXE;.COM" });
  assert.deepEqual(ordered.result, noGit("git.exe or git.com"));
  assert.deepEqual(ordered.asked, ["C:\\g\\git.exe", "C:\\g\\git.com"]);
  const comExe = probeAsking({ PATH: "C:\\g", PATHEXT: ".COM;.EXE" });
  assert.deepEqual(comExe.result, noGit("git.com or git.exe"));
  // The reason names only the suffixes tried: unset PATHEXT means .exe.
  const unsetExt = probeAsking({ PATH: "C:\\g" });
  assert.deepEqual(unsetExt.result, noGit("git.exe"));
  assert.deepEqual(unsetExt.asked, ["C:\\g\\git.exe"]);
  const batOnly = probeAsking({ PATH: "C:\\g", PATHEXT: ".BAT" });
  assert.deepEqual(batOnly.result, {
    ok: false,
    reason: "PATHEXT lists neither .com nor .exe",
  });
  assert.deepEqual(batOnly.asked, []);
  // No PATH key means no PATH dirs, not one empty entry in rustCwd.
  const noPath = probeAsking({ X: "1" }, () => true);
  assert.deepEqual(noPath.result, noGit("git.exe"));
  assert.deepEqual(noPath.asked, []);
  assert.equal(spawned.length, 0);
  // A relative entry is the test binary's, resolved against rustCwd.
  const tools = `${rustCwd}\\tools\\git.exe`;
  const relative = probeAsking({ PATH: "tools" }, (file) => file === tools);
  assert.deepEqual(relative.result, { ok: true, stdout: "out", git: tools });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, tools);
  assert.equal(spawned[0].options.cwd, "C:\\elsewhere");
});

test("B29 main gives the rust step alone its PATH, logged once", async () => {
  const rust = mainSeams();
  assert.equal(await main(["rust", "--lib", "x"], rust.deps), 0);
  assert.equal(rust.calls.runs.length, 1);
  const [rustRun] = rust.calls.runs;
  assert.equal(rustRun.steps[0].env.Path, `${GIT_BIN};C:\\a`);
  // The rebuilt step keeps the caller's extra args.
  assert.deepEqual(rustRun.steps[0].args, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "x",
  ]);
  assert.equal(rustRun.platform, "win32");
  assert.deepEqual(pathLines(rust.lines), [PUT_LINE]);
  assert.deepEqual(rust.calls.probe, [
    {
      env: rust.deps.env,
      cwd: rust.deps.repoRoot,
      rustCwd: win32.resolve(rust.deps.repoRoot, "src-tauri"),
      isFileFn: rust.deps.isGitFile,
    },
  ]);

  // The git checks read isGitFile; exists belongs to preflight alone.
  const noExists = mainSeams({
    exists: () => {
      throw new Error("exists must not check git");
    },
  });
  assert.equal(await main(["rust"], noExists.deps), 0);
  assert.deepEqual(pathLines(noExists.lines), [PUT_LINE]);
  const noGitFile = mainSeams({ isGitFile: () => false });
  assert.equal(await main(["rust"], noGitFile.deps), 0);
  assert.deepEqual(pathLines(noGitFile.lines), [
    `full-suite: rust step keeps PATH (no git.exe in ${GIT_BIN})`,
  ]);

  const all = mainSeams();
  assert.equal(await main(["all"], all.deps), 0);
  const [allRun] = all.calls.runs;
  assert.equal(allRun.steps[0].env.Path, `${GIT_BIN};C:\\a`);
  assert.equal("env" in allRun.steps[1], false);
  assert.deepEqual(pathLines(all.lines), [PUT_LINE]);

  const vitest = mainSeams();
  assert.equal(await main(["vitest"], vitest.deps), 0);
  assert.equal(vitest.calls.probe.length, 0);
  assert.deepEqual(pathLines(vitest.lines), []);
  assert.equal(vitest.calls.runs[0].platform, "win32");

  const kept = mainSeams({
    env: { Path: "C:\\a", GD_FULL_SUITE_KEEP_PATH: "1" },
  });
  assert.equal(await main(["all"], kept.deps), 0);
  assert.equal(kept.calls.probe.length, 0);
  assert.ok(kept.calls.runs[0].steps.every((step) => !("env" in step)));
  assert.deepEqual(pathLines(kept.lines), [KEEP_LINE]);

  const failing = mainSeams({
    probeGitExecPath: () => ({ ok: false, detail: "ETIMEDOUT" }),
    run: async (options) => {
      failing.calls.runs.push(options);
      return 9;
    },
  });
  assert.equal(await main(["rust"], failing.deps), 9);
  assert.equal(failing.calls.runs.length, 1);
  assert.equal("env" in failing.calls.runs[0].steps[0], false);
  assert.deepEqual(pathLines(failing.lines), [
    "full-suite: rust step keeps PATH (git --exec-path failed: ETIMEDOUT)",
  ]);

  const linux = mainSeams({ platform: "linux" });
  assert.equal(await main(["all"], linux.deps), 0);
  assert.equal(linux.calls.probe.length, 0);
  assert.ok(linux.calls.runs[0].steps.every((step) => !("env" in step)));
  assert.deepEqual(pathLines(linux.lines), []);
  assert.equal(linux.calls.runs[0].platform, "linux");
});

test("B30 runUnderLock hands a step its env; a step without one inherits", async () => {
  assert.equal("GD_FULL_SUITE_ENV_PROBE" in process.env, false);
  const dir = caseDir("b30");
  // Exits 0 only when the variable holds the value named in its argv.
  const step = (expected) => ({
    suite: "rust",
    file: NODE,
    args: [
      "-e",
      "process.exit(process.env.GD_FULL_SUITE_ENV_PROBE === process.argv[1] ? 0 : 7)",
      expected,
    ],
  });
  const run = (one) =>
    runUnderLock({
      steps: [one],
      suite: "rust",
      cwd: tmpdir(),
      port: 0,
      sidecarDir: dir,
      log: noop,
    });
  process.env.GD_FULL_SUITE_ENV_PROBE = "parent";
  try {
    const env = { ...process.env, GD_FULL_SUITE_ENV_PROBE: "on" };
    assert.equal(await run({ ...step("on"), env }), 0);
    assert.equal(await run(step("parent")), 0);
  } finally {
    delete process.env.GD_FULL_SUITE_ENV_PROBE;
  }
});

test("B35 the default file checks refuse a directory named git.exe", {
  skip: WIN32 ? false : "real win32 paths: realGitBinDir derives a win32 dir",
}, async () => {
  const dir = caseDir("b35");
  mkdirSync(join(dir, "Git", "libexec", "git-core"), { recursive: true });
  mkdirSync(join(dir, "Git", "bin", "git.exe"), { recursive: true });
  const execPath = join(dir, "Git", "libexec", "git-core");
  const bin = join(dir, "Git", "bin");
  const reason = `no git.exe in ${bin}`;
  assert.deepEqual(realGitBinDir(execPath), { reason });
  // main's own fallback, with no isGitFile dep given.
  const seams = mainSeams({
    probeGitExecPath: () => ({ ok: true, stdout: `${execPath}\n`, git: "g" }),
  });
  delete seams.deps.isGitFile;
  assert.equal(await main(["rust"], seams.deps), 0);
  assert.deepEqual(pathLines(seams.lines), [
    `full-suite: rust step keeps PATH (${reason})`,
  ]);
  assert.equal(seams.calls.runs.length, 1);
  assert.equal("env" in seams.calls.runs[0].steps[0], false);
});

const refusalOf = (sidecarFile) =>
  `full-suite: could not write sidecar ${sidecarFile} (EEXIST)`;

test("B38 an entry planted at the sidecar's temp path is neither written through nor removed", async () => {
  const dir = caseDir("b38");
  const sidecarFile = join(dir, "run.json");
  const planted = `${sidecarFile}.planted.tmp`;
  writeFileSync(planted, "PLANTED");
  const refused = refusalOf(sidecarFile);
  const lines = [];
  const held = await acquireLock({
    port: 0,
    sidecarFile,
    record: holderRecord(),
    tempSuffix: () => "planted",
    log: (line) => lines.push(line),
  });
  assert.equal(held.degraded, false);
  assert.equal(readFileSync(planted, "utf8"), "PLANTED");
  assert.equal(existsSync(sidecarFile), false);
  assert.equal(lines.filter((line) => line === refused).length, 1);
  held.setChild(777);
  assert.equal(readFileSync(planted, "utf8"), "PLANTED");
  assert.equal(existsSync(sidecarFile), false);
  assert.equal(lines.filter((line) => line === refused).length, 2);
  await held.release();
  assert.deepEqual(readdirSync(dir), [basename(planted)]);
});

test("B39 the default temp name is never the wrapper's pid", async () => {
  const dir = caseDir("b39");
  const sidecarFile = join(dir, "run.json");
  const planted = `${sidecarFile}.${process.pid}.tmp`;
  writeFileSync(planted, "PLANTED");
  const lines = [];
  const held = await acquireLock({
    port: 0,
    sidecarFile,
    record: holderRecord(),
    log: (line) => lines.push(line),
  });
  assert.equal(readSidecar(sidecarFile)?.wrapperPid, process.pid);
  held.setChild(777);
  assert.equal(readSidecar(sidecarFile)?.childPid, 777);
  assert.equal(readFileSync(planted, "utf8"), "PLANTED");
  assert.equal(
    lines.some((line) => line.includes("could not write sidecar")),
    false,
  );
  await held.release();
  assert.deepEqual(readdirSync(dir), [basename(planted)]);
});

test("B40 every sidecar write draws its own temp name", async () => {
  const dir = caseDir("b40");
  const sidecarFile = join(dir, "run.json");
  const names = [];
  const held = await acquireLock({
    port: 0,
    sidecarFile,
    record: holderRecord(),
    tempSuffix: () => {
      const suffix = `w${names.length}`;
      names.push(suffix);
      return suffix;
    },
    log: noop,
  });
  held.setChild(777);
  assert.deepEqual(names, ["w0", "w1"]);
  assert.equal(readSidecar(sidecarFile)?.childPid, 777);
  assert.deepEqual(readdirSync(dir), ["run.json"]);
  await held.release();
});

const POSIX_LINK_CONTRACT = WIN32
  ? "an exclusive create follows a dangling link on win32; this test pins the POSIX contract"
  : false;

test("B41 a symlink planted at the temp path is not followed", {
  skip: POSIX_LINK_CONTRACT,
}, async () => {
  const dir = caseDir("b41");
  const sidecarFile = join(dir, "run.json");
  const victim = join(dir, "victim");
  const absent = join(dir, "absent");
  writeFileSync(victim, "ORIGINAL");
  const live = `${sidecarFile}.planted.tmp`;
  const dangling = `${sidecarFile}.dangling.tmp`;
  symlinkSync(victim, live);
  symlinkSync(absent, dangling);
  const suffixes = ["planted", "dangling"];
  const refused = refusalOf(sidecarFile);
  const lines = [];
  const held = await acquireLock({
    port: 0,
    sidecarFile,
    record: holderRecord(),
    tempSuffix: () => suffixes.shift(),
    log: (line) => lines.push(line),
  });
  held.setChild(777);
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL");
  assert.equal(existsSync(absent), false);
  assert.equal(lstatSync(live).isSymbolicLink(), true);
  assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(existsSync(sidecarFile), false);
  assert.equal(lines.filter((line) => line === refused).length, 2);
  await held.release();
});

test("B42 a temp the write created is removed when its rename fails", async () => {
  const dir = caseDir("b42");
  const sidecarFile = join(dir, "run.json");
  // A non-empty directory at the sidecar path fails the rename on every
  // platform (EPERM on win32, EISDIR on Linux).
  mkdirSync(sidecarFile);
  writeFileSync(join(sidecarFile, "child"), "x");
  const lines = [];
  const held = await acquireLock({
    port: 0,
    sidecarFile,
    record: holderRecord(),
    tempSuffix: () => "t",
    log: (line) => lines.push(line),
  });
  assert.equal(held.degraded, false);
  const failed = lines.filter((line) =>
    line.includes("could not write sidecar"),
  );
  assert.equal(failed.length, 1);
  assert.match(failed[0], /\((EPERM|EISDIR)\)$/);
  assert.deepEqual(readdirSync(dir), [basename(sidecarFile)]);
  await held.release();
});

test("B43 each default temp name is a fresh 16-hex suffix", async () => {
  const dir = caseDir("b43");
  const sidecarFile = join(dir, "run.json");
  const names = [];
  // syncBuiltinESMExports carries the wrapper into full-suite.mjs's named
  // openSync binding, so the default names are read, never guessed.
  const realOpen = fs.openSync;
  fs.openSync = (path, ...rest) => {
    if (String(path).startsWith(`${sidecarFile}.`)) {
      names.push(String(path).slice(sidecarFile.length));
    }
    return realOpen(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const held = await acquireLock({
      port: 0,
      sidecarFile,
      record: holderRecord(),
      log: noop,
    });
    held.setChild(777);
    await held.release();
  } finally {
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  }
  assert.equal(names.length, 2);
  for (const name of names) assert.match(name, /^\.[0-9a-f]{16}\.tmp$/);
  assert.notEqual(names[0], names[1]);
});

const OWN_UID = 4100;
const OTHER_UID = 4101;
// readSidecar's owner seam: a sidecar of this type, owned by `owner`, read as
// OWN_UID. It runs on every platform, win32 included.
const ownedBy = (owner, regular = true) => ({
  fstat: () => ({ isFile: () => regular, uid: owner }),
  uid: OWN_UID,
});

test("B44 readSidecar reads only a regular file the current uid owns", () => {
  const dir = caseDir("b44");
  const file = join(dir, "run.json");
  const body = writeRecord(file, { startedAt: new Date().toISOString() });
  assert.deepEqual(readSidecar(file, ownedBy(OWN_UID)), JSON.parse(body));
  assert.equal(readSidecar(file, ownedBy(OTHER_UID)), null);
  assert.equal(readSidecar(file, ownedBy(OWN_UID, false)), null);
});

test("B45 a live record another uid owns never blocks the child check", async () => {
  const now = Date.now();
  // The same fake shape both ways: the own row proves the record would block.
  for (const [name, owner] of [
    ["foreign", OTHER_UID],
    ["own", OWN_UID],
  ]) {
    const dir = caseDir("b45");
    const sidecarFile = join(dir, "previous.json");
    writeRecord(sidecarFile, { startedAt: new Date(now).toISOString() });
    const clock = manualClock(now);
    let alive = true;
    const state = track(
      acquireLock({
        port: 0,
        sidecarFile,
        record: holderRecord(),
        isAlive: () => alive,
        sidecarOwner: ownedBy(owner),
        now: clock.now,
        sleep: clock.sleep,
        log: noop,
      }),
    );
    assert.equal(await settledAtOnce(state, clock), owner === OTHER_UID, name);
    alive = false;
    const held = await bounded(clock.drive(state), name);
    await held.release();
  }
});

test("B46 a record another uid owns never names the port's holder", async () => {
  for (const [name, owner] of [
    ["foreign", OTHER_UID],
    ["own", OWN_UID],
  ]) {
    const dir = caseDir("b46");
    const server = await listenLoopback();
    const port = server.address().port;
    const file = sidecarPath(port, dir);
    const clock = manualClock();
    const lines = [];
    writeRecord(file, {
      wrapperPid: 31337,
      startedAt: new Date(clock.now()).toISOString(),
    });
    try {
      const contender = track(
        acquireLock({
          port,
          sidecarDir: dir,
          record: holderRecord(),
          isAlive: () => false,
          isWrapperAlive: () => true,
          sidecarOwner: ownedBy(owner),
          now: clock.now,
          sleep: clock.sleep,
          log: (line) => lines.push(line),
        }),
      );
      await clock.idle();
      const expected =
        owner === OTHER_UID
          ? `full-suite: waiting - held by an unknown process on port ${port} (or by a wrapper still checking a previous run's child) [sidecar ${file}]`
          : `full-suite: waiting - rust holds port ${port} (wrapper pid 31337, child pid ${FAKE_CHILD}, cwd C:/previous, started 0s ago) [sidecar ${file}]`;
      assert.deepEqual(lines, [expected], name);
      await closeServer(server);
      const held = await bounded(clock.drive(contender), name);
      await held.release();
    } finally {
      if (server.listening) await closeServer(server);
    }
  }
});

const POSIX_FILE_TYPES = WIN32
  ? "symlinks and FIFOs at the sidecar path are a POSIX concern; win32's temp dir is per user"
  : false;

test("B47 a symlink at the sidecar path is not followed", {
  skip: POSIX_FILE_TYPES,
}, () => {
  const dir = caseDir("b47");
  const target = join(dir, "target.json");
  const link = join(dir, "link.json");
  const body = writeRecord(target, { startedAt: new Date().toISOString() });
  symlinkSync(target, link);
  assert.deepEqual(readSidecar(target), JSON.parse(body));
  assert.equal(readSidecar(link), null);
});

test("B48 a FIFO at the sidecar path reads as no record without blocking", {
  skip: POSIX_FILE_TYPES,
}, () => {
  const dir = caseDir("b48");
  const fifo = join(dir, "run.json");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  // A child process, so a read that blocks fails on the timeout instead of
  // hanging this file.
  const read = spawnSync(
    NODE,
    [
      "--input-type=module",
      "-e",
      [
        `import { readSidecar } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
        `console.log(JSON.stringify(readSidecar(${JSON.stringify(fifo)})));`,
      ].join("\n"),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(read.signal, null, "the read blocked on the FIFO");
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout.trim(), "null");
});

test("B18 no test here names DEFAULT_PORT as a port to bind", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(source.includes(["port", "DEFAULT_PORT"].join(": ")), false);
  assert.equal(source.includes(String(DEFAULT_PORT)), false);
});

test("B49 isRootedWin32 accepts only drive and UNC share roots", () => {
  for (const path of ["C:\\x", "C:/x", "\\\\srv\\share\\x", "//srv/share"]) {
    assert.equal(isRootedWin32(path), true, path);
  }
  for (const path of [
    "\\x",
    "/x",
    "C:x",
    "x\\y",
    "\\\\srv",
    "\\\\srv\\",
    "\\\\",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isRootedWin32(path), false, String(path));
  }
});

/**
 * Counting seams for defaultSidecarDir; tmp and userHome return the given
 * values, and userHome throws one that is an Error.
 */
function dirSeams({ tmp = "C:\\Users\\u\\Temp", home = "/home/u" } = {}) {
  const calls = { tmp: 0, home: 0 };
  return {
    calls,
    tmp: () => {
      calls.tmp += 1;
      return tmp;
    },
    userHome: () => {
      calls.home += 1;
      if (home instanceof Error) throw home;
      return home;
    },
  };
}

test("B50 defaultSidecarDir on win32 is the per-user temp dir, never the home", () => {
  const seams = dirSeams();
  const { tmp, userHome } = seams;
  assert.deepEqual(
    defaultSidecarDir({ platform: "win32", uid: 4242, tmp, userHome }),
    { dir: "C:\\Users\\u\\Temp", problem: null },
  );
  assert.deepEqual(seams.calls, { tmp: 1, home: 0 });
  const unrooted = dirSeams({ tmp: "\\temp" });
  assert.deepEqual(
    defaultSidecarDir({
      platform: "win32",
      tmp: unrooted.tmp,
      userHome: unrooted.userHome,
    }),
    { dir: null, problem: "temp dir not rooted at a drive or share: \\temp" },
  );
  assert.deepEqual(unrooted.calls, { tmp: 1, home: 0 });
});

/** The SystemError os.userInfo throws for a uid with no passwd entry. */
function noPasswdEntry(syscall = "uv_os_get_passwd") {
  return Object.assign(
    new Error(
      `A system error occurred: ${syscall} returned ENOENT (no such file or directory)`,
    ),
    { code: "ERR_SYSTEM_ERROR", info: { errno: -2, code: "ENOENT", syscall } },
  );
}

test("B51 defaultSidecarDir on POSIX is the passwd home's cache and the uid", () => {
  const rows = [
    ["linux", 4242, "/home/u", "/home/u/.cache/gitdesktop-full-suite-4242"],
    [
      "darwin",
      501,
      "/Users/u",
      "/Users/u/Library/Caches/gitdesktop-full-suite-501",
    ],
    ["linux", 0, "/root", "/root/.cache/gitdesktop-full-suite-0"],
  ];
  const saved = process.env.XDG_CACHE_HOME;
  // The env is no input: a session with XDG set meets one without it.
  process.env.XDG_CACHE_HOME = "/elsewhere";
  try {
    for (const [platform, uid, home, dir] of rows) {
      const seams = dirSeams({ home });
      const { tmp, userHome } = seams;
      assert.deepEqual(
        defaultSidecarDir({ platform, uid, tmp, userHome }),
        { dir, problem: null },
        dir,
      );
      assert.deepEqual(seams.calls, { tmp: 0, home: 1 }, dir);
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
  }
});

test("B52 defaultSidecarDir has no POSIX dir without a uid or an absolute home", () => {
  for (const uid of [null, "4242", 1.5]) {
    const { tmp, userHome } = dirSeams();
    assert.equal(
      defaultSidecarDir({ platform: "linux", uid, tmp, userHome }).dir,
      null,
      String(uid),
    );
  }
  const gone = dirSeams({ home: noPasswdEntry() });
  assert.deepEqual(
    defaultSidecarDir({
      platform: "linux",
      uid: 4242,
      tmp: gone.tmp,
      userHome: gone.userHome,
    }),
    { dir: null, problem: "ENOENT" },
  );
  for (const home of ["rel", "", undefined]) {
    const { tmp } = dirSeams();
    const userHome = () => home;
    assert.deepEqual(
      defaultSidecarDir({ platform: "linux", uid: 4242, tmp, userHome }),
      { dir: null, problem: `home is not an absolute path: ${home}` },
      String(home),
    );
  }
});

test("B60 errorText names a SystemError's errno, else the code or message", () => {
  const rows = [
    [noPasswdEntry(), "ENOENT"],
    [Object.assign(new Error("busy"), { code: "EBUSY" }), "EBUSY"],
    [
      new Error("/c is writable by other users"),
      "/c is writable by other users",
    ],
    ["plain text", "plain text"],
    [undefined, "undefined"],
  ];
  for (const [err, want] of rows) assert.equal(errorText(err), want, want);
});

const POSIX_MODES = WIN32 ? "POSIX owners and modes" : false;
const ENOENT = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const ENOTDIR = () =>
  Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
const dirInfo = (fields) => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  mode: 0o40700,
  uid: 4242,
  ...fields,
});

test("B53 ensurePrivateDir refuses an ancestor another uid owns and creates nothing", () => {
  const made = [];
  const lstats = [];
  const problem = ensurePrivateDir("/home/u/.cache/leaf", {
    platform: "linux",
    uid: 4242,
    fs: {
      stat: (path) => {
        if (path === "/home/u") return dirInfo({ uid: 1001 });
        throw ENOENT();
      },
      lstat: (path) => {
        lstats.push(path);
        throw ENOENT();
      },
      mkdir: (path) => made.push(path),
    },
  });
  assert.equal(problem, "/home/u belongs to uid 1001");
  assert.deepEqual(made, []);
  assert.deepEqual(lstats, ["/home/u/.cache/leaf"]);
  // A POSIX fs answers ENOTDIR for any path under a file.
  const filed = ensurePrivateDir("/home/u/.cache/leaf", {
    platform: "linux",
    uid: 4242,
    fs: {
      stat: (path) => {
        if (path === "/home/u") return dirInfo({ isDirectory: () => false });
        throw path.startsWith("/home/u/") ? ENOTDIR() : ENOENT();
      },
      lstat: (path) => {
        lstats.push(path);
        throw ENOTDIR();
      },
      mkdir: (path) => made.push(path),
    },
  });
  assert.equal(filed, "/home/u is not a directory");
  assert.deepEqual(made, []);
  assert.deepEqual(lstats, ["/home/u/.cache/leaf", "/home/u/.cache/leaf"]);
});

test("B61 ensurePrivateDir with create false makes nothing", () => {
  const rows = [
    ["/home/u", 4242, null],
    ["/home/u", 1001, "/home/u belongs to uid 1001"],
    [
      "/home/u/.cache/leaf",
      4242,
      "/home/u/.cache/leaf is writable by other users",
    ],
  ];
  for (const [present, owner, want] of rows) {
    const made = [];
    const problem = ensurePrivateDir("/home/u/.cache/leaf", {
      platform: "linux",
      uid: 4242,
      create: false,
      fs: {
        stat: (path) => {
          if (path === present) return dirInfo({ uid: owner });
          throw ENOENT();
        },
        lstat: () => dirInfo({ mode: 0o40777 }),
        mkdir: (path) => made.push(path),
      },
    });
    assert.equal(problem, want, present);
    assert.deepEqual(made, [], present);
  }
  const made = [];
  assert.equal(
    ensurePrivateDir("C:\\x", {
      platform: "win32",
      create: false,
      fs: { mkdir: (...args) => made.push(args) },
    }),
    null,
  );
  assert.deepEqual(made, []);
});

test("B54 ensurePrivateDir refuses a linked or shared leaf (seamed)", () => {
  const rows = [
    [dirInfo({ isSymbolicLink: () => true }), "/c/leaf is a symlink"],
    [dirInfo({ mode: 0o40777 }), "/c/leaf is writable by other users"],
    [dirInfo({ uid: 1001 }), "/c/leaf belongs to uid 1001"],
    [dirInfo({ isDirectory: () => false }), "/c/leaf is not a directory"],
    [dirInfo(), null],
  ];
  for (const [leaf, want] of rows) {
    const problem = ensurePrivateDir("/c/leaf", {
      platform: "linux",
      uid: 4242,
      fs: { stat: () => dirInfo(), lstat: () => leaf, mkdir: () => {} },
    });
    assert.equal(problem, want);
  }
  const made = [];
  assert.equal(
    ensurePrivateDir("C:\\x", {
      platform: "win32",
      fs: {
        stat: () => {
          throw new Error("stat reached");
        },
        lstat: () => {
          throw new Error("lstat reached");
        },
        mkdir: (...args) => made.push(args),
      },
    }),
    null,
  );
  assert.deepEqual(made, [["C:\\x", { recursive: true }]]);
});

test("B63 ensurePrivateDir refuses a dangling link at the dir in both modes (seamed)", () => {
  for (const create of [false, true]) {
    const made = [];
    const problem = ensurePrivateDir("/c/leaf", {
      platform: "linux",
      uid: 4242,
      create,
      fs: {
        stat: (path) => {
          if (path === "/c") return dirInfo();
          throw ENOENT();
        },
        lstat: (path) => {
          if (path === "/c/leaf") {
            return dirInfo({
              isSymbolicLink: () => true,
              isDirectory: () => false,
            });
          }
          throw ENOENT();
        },
        mkdir: (path) => made.push(path),
      },
    });
    assert.equal(problem, "/c/leaf is a symlink", `create ${create}`);
    assert.deepEqual(made, [], `create ${create}`);
  }
});

test("B64 ensurePrivateDir on a real POSIX tree names a dangling leaf link and a file above the dir", {
  skip: POSIX_MODES,
}, () => {
  const base = caseDir("b64");
  const dangling = join(base, "dangling");
  symlinkSync(join(base, "nowhere"), dangling);
  const file = join(base, "file");
  writeFileSync(file, "file bytes");
  const rows = [
    [dangling, `${dangling} is a symlink`],
    [join(file, "a", "leaf"), `${file} is not a directory`],
  ];
  for (const [dir, want] of rows) {
    for (const create of [false, true]) {
      const label = `${dir} create ${create}`;
      assert.equal(ensurePrivateDir(dir, { create }), want, label);
      assert.deepEqual(readdirSync(base).sort(), ["dangling", "file"], label);
    }
  }
  assert.equal(readFileSync(file, "utf8"), "file bytes");
});

test("B55 ensurePrivateDir on a real POSIX tree", { skip: POSIX_MODES }, () => {
  const base = caseDir("b55");
  const nested = join(base, "a", "b");
  assert.equal(ensurePrivateDir(nested), null);
  assert.equal(statSync(nested).mode & 0o777, 0o700);
  assert.equal(ensurePrivateDir(nested), null);
  const link = join(base, "link");
  symlinkSync(nested, link);
  assert.equal(ensurePrivateDir(link), `${link} is a symlink`);
  const shared = join(base, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  assert.equal(
    ensurePrivateDir(shared),
    `${shared} is writable by other users`,
  );
});

test("B56 a refused sidecar dir is logged once and never written or removed", async () => {
  const dir = caseDir("b56");
  const sidecarFile = join(dir, "planted.json");
  writeFileSync(sidecarFile, "planted bytes");
  const lines = [];
  let checks = 0;
  const held = await acquireLock({
    port: 0,
    sidecarFile,
    ensureDir: () => {
      checks += 1;
      return "planted refusal";
    },
    record: holderRecord(),
    log: (line) => lines.push(line),
  });
  held.setChild(777);
  held.setChild(778);
  await held.release();
  assert.equal(checks, 1);
  assert.deepEqual(
    lines.filter((line) => line.includes("sidecar")),
    [
      `full-suite: could not use the sidecar dir ${dir} (planted refusal); this run is not named, and if it is killed the next run does not wait for its children`,
    ],
  );
  assert.ok(
    lines.some((line) =>
      line.startsWith("full-suite: lock acquired for rust "),
    ),
    lines.join("\n"),
  );
  assert.equal(readFileSync(sidecarFile, "utf8"), "planted bytes");
  assert.deepEqual(readdirSync(dir), ["planted.json"]);
});

test("B62 a sidecar dir that is a symlink is refused and its file kept", {
  skip: POSIX_MODES,
}, async () => {
  const base = caseDir("b62");
  const target = join(base, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = join(base, "link");
  symlinkSync(target, link);
  writeFileSync(join(target, "run.json"), "planted bytes");
  const lines = [];
  const held = await acquireLock({
    port: 0,
    sidecarFile: join(link, "run.json"),
    record: holderRecord(),
    log: (line) => lines.push(line),
  });
  held.setChild(777);
  await held.release();
  assert.equal(
    lines.filter((line) => line.includes(`${link} is a symlink`)).length,
    1,
    lines.join("\n"),
  );
  assert.equal(readFileSync(join(target, "run.json"), "utf8"), "planted bytes");
});

test("B57 with no dir given the lock resolves one and writes there", async () => {
  const dir = caseDir("b57");
  let calls = 0;
  const held = await acquireLock({
    port: 0,
    resolveSidecarDir: () => {
      calls += 1;
      return { dir, problem: null };
    },
    record: holderRecord(),
    log: noop,
  });
  assert.equal(calls, 1);
  assert.equal(readSidecar(sidecarPath(held.port, dir))?.suite, "rust");
  await held.release();
  assert.deepEqual(readdirSync(dir), []);
});

test("B58 with no per-user dir the lock holds the port and names nobody", async () => {
  const server = await listenLoopback();
  const port = server.address().port;
  const clock = manualClock();
  const lines = [];
  const cwdBefore = readdirSync(process.cwd()).sort();
  const noDir =
    "full-suite: no per-user dir for the sidecar (no user id); this run is not named, and a killed run's children are not waited for";
  const unknown = `full-suite: waiting - held by an unknown process on port ${port} (or by a wrapper still checking a previous run's child)`;
  try {
    const contender = track(
      acquireLock({
        port,
        resolveSidecarDir: () => ({ dir: null, problem: "no user id" }),
        ensureDir: () => {
          throw new Error("no dir may be made");
        },
        record: holderRecord(),
        now: clock.now,
        sleep: clock.sleep,
        log: (line) => lines.push(line),
      }),
    );
    await clock.idle();
    await clock.tick(15);
    await clock.idle();
    assert.equal(contender.done, false);
    assert.deepEqual(lines, [noDir, unknown, unknown]);
    await closeServer(server);
    const held = await bounded(
      clock.drive(contender),
      `contender on port ${port}`,
    );
    held.setChild(777);
    await held.release();
    assert.equal(lines.length, 4);
    assert.match(
      lines[3],
      /^full-suite: lock acquired for rust on port \d+ after waiting \d+s$/,
    );
    assert.deepEqual(readdirSync(process.cwd()).sort(), cwdBefore);
  } finally {
    if (server.listening) await closeServer(server);
  }
});

test("B59 an explicit null dir has no sidecar and no line; a sidecarFile still counts", async () => {
  const lines = [];
  const resolveSidecarDir = () => {
    throw new Error("an explicit dir is never resolved");
  };
  const bare = await acquireLock({
    port: 0,
    sidecarDir: null,
    resolveSidecarDir,
    record: holderRecord(),
    log: (line) => lines.push(line),
  });
  bare.setChild(777);
  await bare.release();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^full-suite: lock acquired for rust /);
  const dir = caseDir("b59");
  const sidecarFile = join(dir, "missing", "nested", "run.json");
  const filed = await acquireLock({
    port: 0,
    sidecarDir: null,
    sidecarFile,
    resolveSidecarDir,
    record: holderRecord(),
    log: (line) => lines.push(line),
  });
  assert.equal(readSidecar(sidecarFile)?.suite, "rust");
  if (!WIN32) {
    assert.equal(statSync(join(dir, "missing")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "missing", "nested")).mode & 0o777, 0o700);
  }
  await filed.release();
  assert.equal(lines.length, 2);
  assert.equal(existsSync(sidecarFile), false);
});
