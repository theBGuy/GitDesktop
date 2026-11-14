// Contract tests for scripts/full-suite.mjs, the full-suite port lock.
//
// Port discipline: every lock binds port 0 (an OS-assigned port) or the port of
// a listener this file still holds, always on host 127.0.0.1, so no test ever
// touches DEFAULT_PORT. A port this file let go is never bound again as if it
// were still its own: "free again" is proven by a contender that was already
// waiting acquiring it. Every sidecar lives under one mkdtemp dir.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireLock,
  bindPort,
  commandsFor,
  DEFAULT_PORT,
  isGroupAlive,
  isPidAlive,
  killGroup,
  MAX_HOLD_MS,
  main,
  orphanBlocks,
  portFromEnv,
  preflight,
  readSidecar,
  runUnderLock,
  sidecarPath,
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

test("B18 no test here names DEFAULT_PORT as a port to bind", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(source.includes(["port", "DEFAULT_PORT"].join(": ")), false);
  assert.equal(source.includes(String(DEFAULT_PORT)), false);
});
