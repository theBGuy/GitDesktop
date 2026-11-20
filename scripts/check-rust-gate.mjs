// The rust-tests `gate` job's decision: whether the test matrix must run for
// this checkout. The identity is the checked-out commit (HEAD, asserted equal
// to GITHUB_SHA, the commit the matrix tests: the merge commit on
// pull_request): its `src-tauri` tree plus the workflow, gate-script and
// apt-script blobs, as `rust-gate-v1-<digest>-<tree>` with the digest over the
// three blobs. Inputs outside those (`../package.json`, the stubbed `../dist`,
// the root `.gitattributes`, a root `.cargo/config.toml`) can change what the
// matrix runs without changing the identity or tripping the paths filter.
// The gate job uploads that name as an artifact; a green run of this workflow
// holding it is the evidence. One lookup by that exact name
// (one page of up to 100 artifacts) decides: only an exact identity may skip,
// since source-reading `include_str!` tests see comments and whitespace.
// Evidence age: only the newest 100 green runs count (about ten days at the
// measured cadence), with the 14-day artifact retention behind that window. A
// checkout with no recorded green identity runs the matrix.
// Trust: evidence is a past run's self-reported artifact name, never
// re-derived from git; the gate blob in the digest confines it to
// byte-identical gates. A matrix-skipped run also concludes green and records
// its identity, which is sound: it skipped on that same identity.
// Threat model: the gate guards against ACCIDENTAL drift, not an adversarial
// PR. It executes the PR's own code, so a PR can change its decision by
// editing this script; it reads ordinary repository shapes only. Out of reach:
// symlinked or non-regular entries for the three blobs.
// Fail-open: every failed input runs the matrix and an unreadable artifact
// entry is ignored; only a valid exact green match skips. After a decision
// the CLI appends `identity=<name>` (once the evidence file is written), then
// `run=<bool>` as its last act; a thrown error writes no
// `run=` and exits 1, and the workflow runs the matrix whenever no `run=false`
// was written. Node stdlib only; children get argv arrays, no shell, and only
// gh gets the forge token.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TREE_PATH = "src-tauri";
export const WORKFLOW_PATH = ".github/workflows/rust-tests.yml";
export const GATE_PATH = "scripts/check-rust-gate.mjs";
export const APT_PATH = ".github/scripts/apt-prefer-canonical-mirror.sh";
/** The blobs the identity digest covers, in digest order. */
export const IDENTITY_MEMBERS = [WORKFLOW_PATH, GATE_PATH, APT_PATH];
/** A new version re-keys every recorded identity. */
export const NAME_PREFIX = "rust-gate-v1-";
export const DIGEST_LENGTH = 16;
/** Relative to RUNNER_TEMP; the record step uploads it under the identity. */
export const EVIDENCE_FILE = "rust-gate-evidence/identity.txt";

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EVENTS = new Set(["pull_request", "push"]);
const GIT_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 120_000;
const GH_ARTIFACTS_TIMEOUT_MS = 30_000;
const ARTIFACT_PAGE_SIZE = 100;
const RUN_ID = /^[1-9][0-9]*$/;
const NO_EVIDENCE = "no prior green run for this exact content";
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

/** `env` without the forge tokens: every GH_* name, GITHUB_TOKEN and
 *  GITHUB_ENTERPRISE_TOKEN; only `gh` needs them. */
export function withoutForgeTokens(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/^GH_/i.test(name) && !/^GITHUB_(?:ENTERPRISE_)?TOKEN$/i.test(name),
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

/** stdout of `gh <args>`, which alone keeps the forge token; throws on a
 *  spawn error, timeout, signal or non-zero exit. */
function runGh(args, env, spawn, timeout) {
  const result = spawn("gh", args, {
    encoding: "utf8",
    env,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = flat(result.stderr ?? "").slice(0, 200);
    throw new Error(`gh exited ${result.status ?? result.signal}: ${detail}`);
  }
  return result.stdout;
}

/** Run ids of this workflow's green runs, newest first, as raw lines; throws
 *  on any failure (decide() logs it and treats the list as empty). */
export function ghGreenRunIds(env = process.env, spawn = spawnSync) {
  return runGh(
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
      "databaseId",
      "--jq",
      ".[].databaseId",
    ],
    env,
    spawn,
    GH_TIMEOUT_MS,
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** One page of the repository's artifacts for `query` as `{ items }`, the
 *  well-formed entries as `{ name, expired, runId }`. Throws on any failure
 *  or an answer without an artifact list. */
export function ghArtifacts(query, env = process.env, spawn = spawnSync) {
  const stdout = runGh(
    ["api", `repos/{owner}/{repo}/actions/artifacts?${query}`],
    env,
    spawn,
    GH_ARTIFACTS_TIMEOUT_MS,
  );
  let artifacts;
  try {
    artifacts = JSON.parse(stdout)?.artifacts;
  } catch {
    throw new Error("unparseable artifacts answer");
  }
  if (!Array.isArray(artifacts)) {
    throw new Error("the artifacts answer holds no list");
  }
  const items = [];
  for (const item of artifacts) {
    const id = item?.workflow_run?.id;
    if (
      typeof item?.name === "string" &&
      typeof item.expired === "boolean" &&
      Number.isSafeInteger(id) &&
      id > 0
    ) {
      items.push({ name: item.name, expired: item.expired, runId: String(id) });
    }
  }
  return { items };
}

/** The artifact name recording `tree` under the member `blobs` (path -> oid):
 *  NAME_PREFIX, the first DIGEST_LENGTH hex of a sha256 over one
 *  `<path> <oid>` line per IDENTITY_MEMBERS entry in order, then the tree. */
export function identityName({ tree, blobs }) {
  const lines = IDENTITY_MEMBERS.map((path) => `${path} ${blobs[path]}\n`);
  const digest = createHash("sha256")
    .update(lines.join(""), "utf8")
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
  return `${NAME_PREFIX}${digest}-${tree}`;
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

/** The identity of `sha`, which must be the checked-out HEAD, as
 *  `{ name, tree, blobs, sha }`; else `{ missing }` naming why there is none,
 *  plus `tree` and `blobs` once they were read. */
export function readIdentity(git, sha) {
  if (!isOid(sha)) return { missing: "invalid checkout SHA" };
  const head = git(["rev-parse", "HEAD"]);
  const headOid = head.ok ? head.stdout.toString("utf8").trim() : "";
  if (!isOid(headOid)) return { missing: "could not resolve HEAD" };
  if (headOid !== sha) {
    return {
      missing: `HEAD ${short(headOid)} is not GITHUB_SHA ${short(sha)}`,
    };
  }
  const tree = treeAt(git, sha, TREE_PATH);
  const blobs = Object.fromEntries(
    IDENTITY_MEMBERS.map((path) => [path, objectAt(git, sha, path)]),
  );
  // A name with a hole could match another commit's hole.
  if (!tree || IDENTITY_MEMBERS.some((path) => !blobs[path])) {
    return {
      missing: "no src-tauri tree or identity blob at this commit",
      tree,
      blobs,
    };
  }
  return { name: identityName({ tree, blobs }), tree, blobs, sha };
}

function conclude(log, run, reason) {
  log(`${PREFIX} decision run=${run} (${reason})`);
  return { run, reason };
}

/** Valid green run ids from `listGreens`, as a Set; a failed or non-array
 *  list is empty. */
function greenRunIds(listGreens, log) {
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
  const valid = listed.filter(
    (id) =>
      typeof id === "string" &&
      RUN_ID.test(id) &&
      Number.isSafeInteger(Number(id)),
  );
  const ids = new Set(valid);
  log(
    `${PREFIX} listed ${ids.size} green runs (${listed.length - valid.length} malformed dropped)`,
  );
  if (ids.size < valid.length) {
    log(
      `${PREFIX} dropped ${valid.length - ids.size} duplicate green run ids.`,
    );
  }
  return ids;
}

/** The gate decision, `{ run, reason, identity }` with `identity` the name to
 *  record (or ""); logs ending in the decision line. */
export function decide({
  env = process.env,
  git = gitRunner(process.cwd(), env),
  listGreens = () => ghGreenRunIds(env),
  findArtifacts = (name) =>
    ghArtifacts(`name=${name}&per_page=${ARTIFACT_PAGE_SIZE}`, env),
  log = console.log,
} = {}) {
  // Read first, so every attempt records what it tested: a green re-run is
  // the strongest evidence there is.
  const identity = readIdentity(git, env.GITHUB_SHA);
  if (identity.blobs) {
    const [wf, gate, apt] = IDENTITY_MEMBERS.map(
      (path) => identity.blobs[path] || "?",
    );
    log(
      `${PREFIX} signature ${short(env.GITHUB_SHA)} tree=${identity.tree || "?"} wf=${wf} gate=${gate} apt=${apt}`,
    );
  }
  if (identity.missing) log(`${PREFIX} no identity (${identity.missing})`);
  else {
    log(
      `${PREFIX} identity ${identity.name} (checkout ${short(identity.sha)})`,
    );
  }
  const name = identity.name ?? "";
  const finish = (run, reason) => ({
    ...conclude(log, run, reason),
    identity: name,
  });

  // An explicit re-run means "actually run it" (toolchain drift, a flake to
  // reconfirm), so it never short-circuits.
  if (env.ATTEMPT !== "1") {
    log(
      `${PREFIX} run_attempt=${flat(env.ATTEMPT ?? "")} is a re-run; running the matrix.`,
    );
    return finish(true, "explicit re-run");
  }
  // JSON quoting escapes every line break, so the value stays on one line.
  if (!EVENTS.has(env.EVENT)) {
    return finish(
      true,
      `unknown event ${JSON.stringify(String(env.EVENT ?? ""))}`,
    );
  }
  if (identity.missing) return finish(true, identity.missing);

  const greenIds = greenRunIds(listGreens, log);
  if (greenIds.size === 0) {
    log(`${PREFIX} no green runs; no evidence to read.`);
    return finish(true, NO_EVIDENCE);
  }

  // One page: the first ARTIFACT_PAGE_SIZE artifacts the API lists by this
  // name. A lookup that fails or answers in another shape is no evidence.
  let green;
  try {
    const answer = findArtifacts(name);
    if (!Array.isArray(answer?.items)) throw new Error("no artifact list");
    const named = answer.items.filter((item) => item?.name === name);
    green = named.filter(
      (item) => item.expired === false && greenIds.has(item.runId),
    );
    log(
      `${PREFIX} ${named.length} artifacts named ${name}, ${green.length} from green runs.`,
    );
  } catch (error) {
    log(
      `${PREFIX} could not look up the artifact (${flat(messageOf(error))}); running the matrix.`,
    );
    return finish(true, "artifact lookup failed");
  }
  if (green.length === 0) return finish(true, NO_EVIDENCE);
  return finish(false, `identical content passed in run ${green[0].runId}`);
}

/** Writes the evidence file the record step uploads, then the `identity`
 *  output naming it; a failure is logged and loses only a future skip. */
function recordIdentity({ env, name, output, log }) {
  const temp = env.RUNNER_TEMP;
  if (typeof temp !== "string" || temp === "") {
    log(`${PREFIX} RUNNER_TEMP is not set; identity not recorded.`);
    return;
  }
  try {
    const file = join(temp, EVIDENCE_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${name}\n${env.GITHUB_SHA}\n`);
  } catch (error) {
    log(
      `${PREFIX} could not write the identity file (${flat(messageOf(error))}); identity not recorded.`,
    );
    return;
  }
  appendFileSync(output, `identity=${name}\n`);
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
    // An absent artifact seam takes decide()'s gh default.
    const { run, identity } = decide({
      env,
      git: deps.git ?? gitRunner(deps.cwd ?? process.cwd(), env),
      listGreens: deps.listGreens ?? (() => ghGreenRunIds(env)),
      findArtifacts: deps.findArtifacts,
      log,
    });
    if (identity) recordIdentity({ env, name: identity, output, log });
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
