// The rust-tests `gate` job's decision: whether the test matrix must run for
// this commit. Pass 1 skips when a recent green run built the identical
// `src-tauri` tree under the same workflow, gate-script and canonicalizer
// blobs; pass 2 (only when pass 1 finds nothing) skips when the delta vs a
// green with those same three blobs is comment/format-only in modified regular
// `.rs` files, as judged by `.github/scripts/canonicalize-rust.py`. The gate
// and canonicalizer blobs are part of the identity so a fix to either
// invalidates the greens the older version skipped, and the gate and workflow
// that run (HEAD) must be the head's own. The workflow header states pass 2's
// accepted risk.
// Threat model: the gate guards against ACCIDENTAL drift, not an adversarial
// PR. It executes the PR's own code, so a PR can change its decision by
// editing this script; it reads ordinary repository shapes only. Out of reach:
// symlinked or non-regular entries for the workflow, gate script or
// canonicalizer, and hand-crafted object or path shapes beyond what
// `diff-tree --raw` reports. Open: a pull_request green is listed by head SHA
// but ran the merge commit, so it can vouch for a workflow or base tree it
// never ran; the HEAD checks narrow this, and gh records nothing more.
// Fail-open: every unreadable or failed input ends in run=true or a rejected
// candidate, never a skip. `run=<bool>` is appended to GITHUB_OUTPUT once, as
// the CLI's last act after a decision; any thrown error writes nothing and
// exits 1, and the workflow runs the matrix whenever no `run=false` was written.
// Node stdlib only (no install step); every child gets an argv array, no shell,
// and git and Python (which runs PR-controlled code) get no forge token.
// Fixtures live in scripts/check-rust-gate.test.mjs.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TREE_PATH = "src-tauri";
export const WORKFLOW_PATH = ".github/workflows/rust-tests.yml";
export const CANONICALIZER_PATH = ".github/scripts/canonicalize-rust.py";
export const GATE_PATH = "scripts/check-rust-gate.mjs";
export const MAX_CHANGED = 60;
export const MAX_COMPARED = 15;
/** Rust code whose canonical form can never be empty. */
export const CANONICALIZER_PROBE = Buffer.from(
  "fn probe() -> u32 {\n    1 + 2\n}\n",
);

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MODE = /^[0-7]{6}$/;
const STATUS = /^[A-Z][0-9]*$/;
const REGULAR_MODES = new Set(["100644", "100755"]);
const EVENTS = new Set(["pull_request", "push"]);
const GIT_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 120_000;
const PYTHON_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const PREFIX = "rust-gate:";

const isOid = (value) => typeof value === "string" && OID.test(value);
const short = (oid) => oid.slice(0, 8);
const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);
// Log lines are parsed for workflow commands, so a control character from a
// path or a child's stderr must never start a line of its own.
const flat = (text) =>
  String(text)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();
const shown = (path) =>
  /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;

/** `env` without the forge tokens: GH_TOKEN, GITHUB_TOKEN and every GH_*
 *  name. Only `gh` needs them; the canonicalizer is PR-controlled code. */
export function withoutForgeTokens(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !/^GH_/i.test(name) && !/^GITHUB_TOKEN$/i.test(name),
    ),
  );
}

/** `(args) -> { ok, stdout: Buffer }` running git in `cwd`; a spawn error,
 *  timeout, signal or non-zero exit is `ok: false`. */
export function gitRunner(cwd, env = process.env, spawn = spawnSync) {
  const childEnv = withoutForgeTokens(env);
  return (args) => {
    const result = spawn("git", args, {
      cwd,
      env: childEnv,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout ?? Buffer.alloc(0),
    };
  };
}

/** Green head SHAs of this workflow, newest first, as raw lines; throws on
 *  any failure (decide() logs it and treats the list as empty). */
export function ghGreens(env = process.env, spawn = spawnSync) {
  const result = spawn(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      basename(WORKFLOW_PATH),
      "--status",
      "success",
      "--limit",
      "100",
      "--json",
      "headSha",
      "--jq",
      ".[].headSha",
    ],
    {
      encoding: "utf8",
      env,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = flat(result.stderr ?? "").slice(0, 200);
    throw new Error(`gh exited ${result.status ?? result.signal}: ${detail}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The canonicalizer seam over a Python interpreter: the self-test passes on
 *  exit 0; canonicalize returns stdout on exit 0 and null on anything else. */
export function pythonCanonicalizer(
  cmd = "python3",
  log = console.log,
  env = process.env,
  spawn = spawnSync,
) {
  const childEnv = withoutForgeTokens(env);
  return {
    selfTest(scriptPath) {
      const result = spawn(cmd, [scriptPath, "--self-test"], {
        encoding: "utf8",
        env: childEnv,
        maxBuffer: MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PYTHON_TIMEOUT_MS,
      });
      const passed = !result.error && result.status === 0;
      if (!passed) {
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        const lines = output.split("\n").map(flat).filter(Boolean);
        for (const line of lines.slice(-20)) log(`${PREFIX}   ${line}`);
        if (result.error) log(`${PREFIX}   ${flat(messageOf(result.error))}`);
      }
      return passed;
    },
    canonicalize(scriptPath, input) {
      const result = spawn(cmd, [scriptPath], {
        env: childEnv,
        input,
        maxBuffer: MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: PYTHON_TIMEOUT_MS,
      });
      if (result.error || result.status !== 0) return null;
      return result.stdout;
    },
  };
}

/** The object id at `<rev>:<path>`, or "" when it does not resolve to one. */
function objectAt(git, rev, path) {
  const result = git(["rev-parse", `${rev}:${path}`]);
  if (!result.ok) return "";
  const oid = result.stdout.toString("utf8").trim();
  return OID.test(oid) ? oid : "";
}

/** The tree id at `<rev>:<path>`, or "" when it is absent or not a tree. */
function treeAt(git, rev, path) {
  const oid = objectAt(git, rev, path);
  if (!oid) return "";
  const type = git(["cat-file", "-t", oid]);
  return type.ok && type.stdout.toString("utf8").trim() === "tree" ? oid : "";
}

/** `{ records }` from `diff-tree -z --raw --no-renames` output, or `{ error }`
 *  when the stream is not whole `:<mode> <mode> <oid> <oid> <status>` NUL
 *  `<path>` NUL pairs. Paths are decoded for logs and the `.rs` test only;
 *  blobs are always read by the OIDs in the header. */
function rawRecords(stdout) {
  const unreadable = { error: "unreadable diff-tree output" };
  if (stdout.at(-1) !== 0) return unreadable;
  const tokens = [];
  for (let at = 0; at < stdout.length; ) {
    const end = stdout.indexOf(0, at);
    tokens.push(stdout.subarray(at, end));
    at = end + 1;
  }
  if (tokens.length % 2 !== 0 || tokens.some((token) => token.length === 0)) {
    return unreadable;
  }
  const records = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const header = tokens[i].toString("latin1");
    if (!header.startsWith(":")) return unreadable;
    const fields = header.slice(1).split(" ");
    if (fields.length !== 5) return unreadable;
    const [oldMode, newMode, oldOid, newOid, status] = fields;
    if (!MODE.test(oldMode) || !MODE.test(newMode)) return unreadable;
    if (!isOid(oldOid) || !isOid(newOid) || !STATUS.test(status)) {
      return unreadable;
    }
    const path = tokens[i + 1].toString("utf8");
    records.push({ oldMode, newMode, oldOid, newOid, status, path });
  }
  return { records };
}

/** Why a raw record can't be compared as one Rust source edit, or "". */
function unsupported({ oldMode, newMode, status, path }) {
  if (status !== "M" || !path.endsWith(".rs")) {
    return `non-.rs or non-modify change (${status} ${shown(path)})`;
  }
  if (oldMode !== newMode) {
    return `mode change (${oldMode} -> ${newMode} ${shown(path)})`;
  }
  if (!REGULAR_MODES.has(newMode)) {
    return `non-regular file (${newMode} ${shown(path)})`;
  }
  return "";
}

function conclude(log, run, reason) {
  log(`${PREFIX} decision run=${run} (${reason})`);
  return { run, reason };
}

/** Pass 2 alone: `{ skip, reason, aborted? }`, skip only for a green whose
 *  delta is comment/format-only under an identical workflow, gate script and
 *  canonicalizer; `aborted` when the current side itself could not be read. */
export function passTwo({
  curTree,
  curWf,
  curGate,
  curCanon,
  greens,
  git,
  canonicalizer,
  log = console.log,
  tempRoot = process.env.RUNNER_TEMP || tmpdir(),
}) {
  const skipped = (reason) => {
    log(`${PREFIX} pass 2 skipped: ${reason}.`);
    return { skip: false, reason };
  };
  if (!curTree) return skipped("no src-tauri tree");
  if (!curWf) return skipped("no workflow blob");
  if (!curGate) return skipped("no gate script blob");
  if (!curCanon) return skipped("no canonicalizer blob");
  const script = git(["cat-file", "blob", curCanon]);
  if (!script.ok || script.stdout.length === 0) {
    return skipped("could not extract canonicalizer");
  }
  const dir = mkdtempSync(join(tempRoot, "gd-rust-gate-"));
  try {
    const scriptPath = join(dir, basename(CANONICALIZER_PATH));
    writeFileSync(scriptPath, script.stdout);
    if (!canonicalizer.selfTest(scriptPath)) {
      return skipped("canonicalizer self-test failed");
    }
    // A canonicalizer that exits 0 printing nothing would make every pair of
    // files equal, so real code must come back non-empty before any compare.
    const probe = canonicalizer.canonicalize(scriptPath, CANONICALIZER_PROBE);
    if (!Buffer.isBuffer(probe) || probe.length === 0) {
      return skipped("canonicalizer anomaly on a known input");
    }
    log(`${PREFIX} pass 2: canonicalizer self-test passed.`);

    // Current-side canonical forms keyed by blob OID; only successes cached.
    const current = new Map();
    const canonical = (oid) => {
      const blob = git(["cat-file", "blob", oid]);
      if (!blob.ok) return null;
      const out = canonicalizer.canonicalize(scriptPath, blob.stdout);
      return Buffer.isBuffer(out) ? out : null;
    };
    // A current-side failure aborts the pass: a blob that failed once and
    // passes on a retry is no evidence of equivalence for any candidate.
    const CURRENT_FAILED = "canonicalizer anomaly on current side";
    /** Why a record's two blobs differ canonically, or "". */
    const difference = ({ oldOid, newOid }) => {
      if (!current.has(newOid)) {
        const out = canonical(newOid);
        if (!out) return CURRENT_FAILED;
        current.set(newOid, out);
      }
      const pastOut = canonical(oldOid);
      if (!pastOut) return "canonicalizer anomaly on past side";
      if (pastOut.equals(current.get(newOid))) return "";
      return "canonical mismatch (real code change)";
    };

    let compared = 0;
    let result = { skip: false, reason: "no equivalent green" };
    for (const past of greens) {
      const pt = treeAt(git, past, TREE_PATH);
      if (!pt) continue;
      if (objectAt(git, past, WORKFLOW_PATH) !== curWf) continue;
      if (objectAt(git, past, GATE_PATH) !== curGate) continue;
      if (objectAt(git, past, CANONICALIZER_PATH) !== curCanon) continue;

      const reject = (reason) =>
        log(`${PREFIX} pass 2: ${short(past)} rejected - ${reason}.`);
      const diff = git([
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--raw",
        // Submodule config must never hide a gitlink record from the rejects.
        "--ignore-submodules=none",
        pt,
        curTree,
      ]);
      if (!diff.ok) {
        reject("diff-tree failed");
        continue;
      }
      if (diff.stdout.length === 0) {
        reject("empty diff-tree output");
        continue;
      }
      const { records, error } = rawRecords(diff.stdout);
      if (error) {
        reject(error);
        continue;
      }
      const bad = records.map(unsupported).find(Boolean);
      if (bad) {
        reject(bad);
        continue;
      }
      if (records.length > MAX_CHANGED) {
        reject(`${records.length} changed files (> ${MAX_CHANGED})`);
        continue;
      }

      if (compared >= MAX_COMPARED) {
        log(
          `${PREFIX} pass 2: stopping after ${MAX_COMPARED} candidates reached per-file comparison.`,
        );
        break;
      }
      compared++;

      let why = "";
      let failed = "";
      for (const record of records) {
        why = difference(record);
        if (why) {
          failed = record.path;
          break;
        }
      }
      if (why === CURRENT_FAILED) {
        const reason = `${why} (${shown(failed)})`;
        log(`${PREFIX} pass 2 aborted: ${reason}.`);
        result = { skip: false, reason, aborted: true };
        break;
      }
      if (why) {
        reject("a changed .rs file is not equivalent");
        log(`${PREFIX}   ${shown(failed)}: ${why}`);
        continue;
      }
      for (const { path } of records) {
        log(`${PREFIX}   ${shown(path)}: equivalent`);
      }
      result = {
        skip: true,
        reason: `comment/format-only delta vs ${short(past)} (${records.length} .rs files)`,
      };
      break;
    }
    log(`${PREFIX} pass 2: ${compared} candidates compared.`);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The gate decision, `{ run, reason }`; logs ending in the decision line. */
export function decide({
  env = process.env,
  git = gitRunner(process.cwd(), env),
  listGreens = () => ghGreens(env),
  canonicalizer = pythonCanonicalizer("python3", console.log, env),
  log = console.log,
} = {}) {
  // An explicit re-run means "actually run it" (toolchain drift, a flake to
  // reconfirm), so it never short-circuits.
  if (env.ATTEMPT !== "1") {
    log(
      `${PREFIX} run_attempt=${flat(env.ATTEMPT ?? "")} is a re-run; running the matrix.`,
    );
    return conclude(log, true, "explicit re-run");
  }
  // JSON quoting escapes every line break, so the value stays on one line.
  if (!EVENTS.has(env.EVENT)) {
    return conclude(
      log,
      true,
      `unknown event ${JSON.stringify(String(env.EVENT ?? ""))}`,
    );
  }

  // HEAD SHAs on both events keep the frame consistent: a merged PR and its
  // squash commit share a src-tauri tree, so the post-merge run can skip.
  const sha = env.EVENT === "pull_request" ? env.PR_HEAD : env.PUSH_SHA;
  if (!isOid(sha)) return conclude(log, true, "invalid head SHA");
  const curTree = treeAt(git, sha, TREE_PATH);
  const curWf = objectAt(git, sha, WORKFLOW_PATH);
  const curGate = objectAt(git, sha, GATE_PATH);
  const curCanon = objectAt(git, sha, CANONICALIZER_PATH);
  log(
    `${PREFIX} signature ${short(sha)} tree=${curTree || "?"} wf=${curWf || "?"} gate=${curGate || "?"} canon=${curCanon || "?"}`,
  );
  if (!curTree || !curWf || !curGate) {
    return conclude(
      log,
      true,
      "no src-tauri tree, workflow blob or gate script at this commit",
    );
  }
  // A pull_request job checks out the merge commit, so the gate and workflow
  // running here can differ from the ones the head signs (base may have added
  // a matrix leg); push runs the same commit. The src-tauri tree stays the
  // head's by design: the merged tree would re-run every PR behind its base.
  for (const [path, name, signed] of [
    [GATE_PATH, "gate", curGate],
    [WORKFLOW_PATH, "workflow", curWf],
  ]) {
    const running = objectAt(git, "HEAD", path);
    if (!running) {
      return conclude(
        log,
        true,
        `could not resolve the running ${name} at HEAD`,
      );
    }
    if (running !== signed) {
      log(`${PREFIX} running ${name}=${running}`);
      return conclude(
        log,
        true,
        `the ${name} that runs differs from the head's ${name}`,
      );
    }
  }

  // A matrix-skipped run also concludes "success" and joins this list; sound,
  // because tree identity and (under one canonicalizer blob) canonical
  // equivalence are transitive.
  let listed;
  try {
    listed = listGreens();
    if (!Array.isArray(listed)) throw new Error("the list is not an array");
  } catch (error) {
    log(
      `${PREFIX} could not list green runs (${flat(messageOf(error))}); treating the list as empty.`,
    );
    listed = [];
  }
  const valid = listed.filter(isOid);
  // A SHA with several green runs is listed once per run; compare it once.
  const greens = [...new Set(valid)];
  log(
    `${PREFIX} listed ${greens.length} green head SHAs (${listed.length - valid.length} malformed dropped)`,
  );
  if (greens.length < valid.length) {
    log(
      `${PREFIX} dropped ${valid.length - greens.length} duplicate green head SHAs.`,
    );
  }

  // Pass 1 is strictly stronger evidence, so every green is tried before pass 2.
  // An OID equal to the verified current tree is that tree, so no type read.
  // Without a canonicalizer blob pass 1 is off: an absent file reads like a
  // failed lookup on the green's side, and "" must never match "".
  if (!curCanon) log(`${PREFIX} pass 1 skipped: no canonicalizer blob.`);
  for (const past of curCanon ? greens : []) {
    if (objectAt(git, past, TREE_PATH) !== curTree) continue;
    if (objectAt(git, past, WORKFLOW_PATH) !== curWf) continue;
    if (objectAt(git, past, GATE_PATH) !== curGate) continue;
    if (objectAt(git, past, CANONICALIZER_PATH) !== curCanon) continue;
    log(`${PREFIX} pass 1: identical content passed in ${short(past)}.`);
    return conclude(
      log,
      false,
      `pass 1: identical content passed in ${short(past)}`,
    );
  }

  const second = passTwo({
    curTree,
    curWf,
    curGate,
    curCanon,
    greens,
    git,
    canonicalizer,
    log,
    tempRoot: env.RUNNER_TEMP || tmpdir(),
  });
  if (second.skip) return conclude(log, false, `pass 2: ${second.reason}`);
  if (second.aborted) {
    return conclude(log, true, `pass 2 aborted: ${second.reason}`);
  }
  return conclude(log, true, "no prior green run for this exact content");
}

/** The CLI body; returns the exit code. Appending the decision is its last
 *  act, so a run that throws never publishes a `run=false`. */
export function runCli({
  env = process.env,
  argv = process.argv.slice(2),
  deps = {},
} = {}) {
  const log = deps.log ?? console.log;
  try {
    if (argv.length > 0) {
      throw new Error(`unexpected argument(s): ${argv.join(" ")}`);
    }
    const output = env.GITHUB_OUTPUT;
    if (typeof output !== "string" || output === "") {
      throw new Error("GITHUB_OUTPUT is not set");
    }
    const { run } = decide({
      env,
      git: deps.git ?? gitRunner(deps.cwd ?? process.cwd(), env),
      listGreens: deps.listGreens ?? (() => ghGreens(env)),
      canonicalizer:
        deps.canonicalizer ?? pythonCanonicalizer("python3", log, env),
      log,
    });
    appendFileSync(output, `run=${run}\n`);
    return 0;
  } catch (error) {
    // Workflow-command data escaping, so a multi-line message stays one line.
    const text = messageOf(error)
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    log(
      `::error::rust-gate: ${text} - no decision written; the matrix runs (fail-open)`,
    );
    return 1;
  }
}

// Node runs a symlinked entry from its real path, so both sides compare as
// realpaths; an unresolvable argv path is not this module.
function isEntry(argvPath) {
  try {
    return (
      realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry(process.argv[1])) {
  process.exitCode = runCli();
}
