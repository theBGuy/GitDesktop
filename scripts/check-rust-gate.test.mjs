// Pins scripts/check-rust-gate.mjs, the rust-tests gate decision. Small shapes
// run on real git in throwaway repos built with one fast-import stream (names
// Windows cannot hold on disk never touch the filesystem); large shapes run on
// an in-process fake git and a stub canonicalizer, so the suite stays a few
// seconds. CLI cases spawn the script with an env built from scratch, since the
// guards step's own env carries GITHUB_OUTPUT. Every test asserts the reason or
// a log line beside `run`, never `run` alone. The P-pins at the end read
// rust-tests.yml itself and hold the fail-open wiring; each carries in-memory
// mutations that must turn it red.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICALIZER_PATH,
  CANONICALIZER_PROBE,
  decide,
  GATE_PATH,
  ghGreens,
  gitRunner,
  MAX_CHANGED,
  MAX_COMPARED,
  passTwo,
  pythonCanonicalizer,
  runCli,
  TREE_PATH,
  WORKFLOW_PATH,
  withoutForgeTokens,
} from "./check-rust-gate.mjs";

const SCRIPT = fileURLToPath(new URL("./check-rust-gate.mjs", import.meta.url));
const REAL_CANONICALIZER = readFileSync(
  fileURLToPath(new URL(`../${CANONICALIZER_PATH}`, import.meta.url)),
);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BACKSLASH = String.fromCharCode(92);

const root = mkdtempSync(join(tmpdir(), "gd-rust-gate-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const emptyConfig = join(root, "empty.gitconfig");
writeFileSync(emptyConfig, "");
/** An env holding only what node, git and Python need plus `vars`, so the
 *  guards step's own GITHUB_OUTPUT, RUNNER_TEMP, CI and tokens never reach a
 *  fixture or CLI child. */
function childEnv(vars) {
  const env = { PATH: process.env.PATH ?? "" };
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...vars };
}

// Machine-wide git config (hooks, signing, autocrlf) and any inherited GIT_*
// variable (a hook's GIT_INDEX_FILE) must not reach the fixtures.
const gitEnv = childEnv({
  GIT_CEILING_DIRECTORIES: root,
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
});

function git(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
    input,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A throwaway repo whose commits come from one fast-import stream; each
 *  commit `{ name, from?, files: { path: content | null } }` is on its own
 *  branch, null deletes, and `{ mode, data }` sets a mode other than 100644.
 *  Returns `{ dir, shas }`. */
function buildRepo(name, commits) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  // Git for Windows refuses `*`, `?` and `"` in an index or import path while
  // protectNTFS is on; these repos never check out, so the names stay legal.
  appendFileSync(
    join(dir, ".git", "config"),
    "[user]\n\tname = Gate Test\n\temail = gate-test@example.invalid\n[core]\n\tautocrlf = false\n\tprotectNTFS = false\n",
  );
  const marks = new Map(commits.map((commit, i) => [commit.name, i + 1]));
  const chunks = [];
  const add = (text) => chunks.push(Buffer.from(text, "utf8"));
  commits.forEach((commit, i) => {
    add(`commit refs/heads/${commit.name}\nmark :${i + 1}\n`);
    add(
      `committer Gate Test <gate-test@example.invalid> ${1_700_000_000 + i} +0000\n`,
    );
    add(`data ${Buffer.byteLength(commit.name)}\n${commit.name}\n`);
    if (commit.from) add(`from :${marks.get(commit.from)}\n`);
    for (const [path, content] of Object.entries(commit.files ?? {})) {
      if (content === null) {
        add(`D ${path}\n`);
        continue;
      }
      const { mode = "100644", data = content } =
        typeof content === "object" && !Buffer.isBuffer(content) ? content : {};
      const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      add(`M ${mode} inline ${path}\ndata ${body.length}\n`);
      chunks.push(body);
      add("\n");
    }
    add("\n");
  });
  const marksFile = join(root, `${name}.marks`);
  git(
    dir,
    ["fast-import", "--quiet", `--export-marks=${marksFile}`],
    Buffer.concat(chunks),
  );
  const shas = {};
  for (const line of readFileSync(marksFile, "utf8").split("\n")) {
    const [mark, sha] = line.trim().split(" ");
    if (sha) shas[commits[Number(mark.slice(1)) - 1].name] = sha;
  }
  // HEAD stands in for the checked-out commit whose gate script runs.
  git(dir, ["symbolic-ref", "HEAD", `refs/heads/${commits[0].name}`]);
  return { dir, shas };
}

function buildOrClean(build) {
  try {
    return build();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const LIB = "pub fn answer() -> u32 {\n    42\n}\n";
const LIB_COMMENTED =
  "// The answer.\npub fn answer() -> u32 {\n    42 // fixed\n}\n";
const LIB_CHANGED = "pub fn answer() -> u32 {\n    43\n}\n";
// The rows 19a/26 shapes: git C-quotes the non-ASCII, quote and backslash names
// without -z, and a shell word-splits or globs the rest.
const ODD_PATHS = [
  "src/a b.rs",
  "src/glob*?.rs",
  "src/[ab].rs",
  `src/caf${String.fromCodePoint(0xe9)}.rs`,
  'src/q"uote.rs',
  `src/back${BACKSLASH}slash.rs`,
  "src/-lead.rs",
];
const oddFiles = (commented) =>
  Object.fromEntries(
    ODD_PATHS.map((path, i) => [
      `${TREE_PATH}/${path}`,
      `${commented ? "// note\n" : ""}pub fn f${i}() {}\n`,
    ]),
  );

// A throw here ends the file before any `after` hook runs, so this build
// removes the temp root itself on failure.
const repo = buildOrClean(() =>
  buildRepo("main", [
    {
      name: "base",
      files: {
        [WORKFLOW_PATH]: "name: rust-tests\n",
        [CANONICALIZER_PATH]: REAL_CANONICALIZER,
        [GATE_PATH]: "// gate\n",
        [`${TREE_PATH}/Cargo.toml`]: '[package]\nname = "x"\n',
        [`${TREE_PATH}/src/lib.rs`]: LIB,
        [`${TREE_PATH}/src/del.rs`]: "pub fn gone() {}\n",
        [`${TREE_PATH}/src/old.rs`]: "pub fn old() {}\n",
        // A symlink target is its blob's text; `//` would canonicalize away.
        [`${TREE_PATH}/src/link.rs`]: { mode: "120000", data: "x//one" },
        ...oddFiles(false),
      },
    },
    {
      name: "symlink",
      from: "base",
      files: {
        [`${TREE_PATH}/src/link.rs`]: { mode: "120000", data: "x//two" },
      },
    },
    {
      name: "exec",
      from: "base",
      files: { [`${TREE_PATH}/src/lib.rs`]: { mode: "100755", data: LIB } },
    },
    {
      name: "comment",
      from: "base",
      files: { [`${TREE_PATH}/src/lib.rs`]: LIB_COMMENTED },
    },
    { name: "comment2", from: "comment", files: {} },
    {
      name: "code",
      from: "base",
      files: { [`${TREE_PATH}/src/lib.rs`]: LIB_CHANGED },
    },
    { name: "paths", from: "base", files: oddFiles(true) },
    {
      name: "cargo",
      from: "base",
      files: { [`${TREE_PATH}/Cargo.toml`]: '[package]\nname = "y"\n' },
    },
    {
      name: "added",
      from: "base",
      files: { [`${TREE_PATH}/src/new.rs`]: "pub fn new() {}\n" },
    },
    {
      name: "deleted",
      from: "base",
      files: { [`${TREE_PATH}/src/del.rs`]: null },
    },
    {
      name: "renamed",
      from: "base",
      files: {
        [`${TREE_PATH}/src/old.rs`]: null,
        [`${TREE_PATH}/src/renamed.rs`]: "pub fn old() {}\n",
      },
    },
    {
      name: "nocanon",
      from: "comment",
      files: { [CANONICALIZER_PATH]: null },
    },
    {
      name: "othercanon",
      from: "base",
      files: {
        [CANONICALIZER_PATH]: Buffer.concat([
          REAL_CANONICALIZER,
          Buffer.from("\n# changed\n"),
        ]),
      },
    },
  ]),
);
const sha = repo.shas;
const short = (oid) => oid.slice(0, 8);
const realGit = gitRunner(repo.dir, gitEnv);
const failing = { ok: false, stdout: Buffer.alloc(0) };

/** Drops `//` line comments and all whitespace; records each input, the
 *  known-input probe in `probes` so `inputs` holds only compared blobs. */
function stubCanonicalizer({ selfTest = true, nullWhen = () => false } = {}) {
  const inputs = [];
  const probes = [];
  return {
    inputs,
    probes,
    selfTest: () => selfTest,
    canonicalize(_scriptPath, input) {
      const text = input.toString("utf8");
      if (input.equals(CANONICALIZER_PROBE)) probes.push(text);
      else inputs.push(text);
      if (nullWhen(text)) return null;
      return Buffer.from(
        text.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, ""),
        "utf8",
      );
    },
  };
}

/** decide() on `env` with collected log lines and a counting green list. */
function run({
  env,
  git: gitFn,
  greens = [],
  listGreens,
  canonicalizer = stubCanonicalizer(),
}) {
  const lines = [];
  const gh = { calls: 0 };
  const result = decide({
    env,
    git: gitFn,
    listGreens:
      listGreens ??
      (() => {
        gh.calls++;
        return greens;
      }),
    canonicalizer,
    log: (line) => lines.push(line),
  });
  return { ...result, lines, text: lines.join("\n"), gh };
}

const pushEnv = (head) => ({ ATTEMPT: "1", EVENT: "push", PUSH_SHA: head });
const onRepo = (head, greens, extra = {}) =>
  run({ env: pushEnv(head), git: realGit, greens, ...extra });

// ---------------------------------------------------------------- fake git

let serial = 0;
const nextOid = () => (++serial).toString(16).padStart(40, "0");
const SAME = "fn a() {}\n";
const COMMENTED = "// note\nfn a() {}\n";
const CODE = "fn a() { b() }\n";
/** One `diff-tree --raw` record header, as git prints it before the path. */
const raw = (
  oldOid,
  newOid,
  { oldMode = "100644", newMode = oldMode, status = "M" } = {},
) => `:${oldMode} ${newMode} ${oldOid} ${newOid} ${status}`;

/** A test-side model answering rev-parse, cat-file and diff-tree from maps,
 *  recording every call. `green(files)` adds a commit whose tree differs from
 *  head's by raw M records, `files` = { path: [pastContent, currentContent] };
 *  a path's current blob is minted once and shared by every green. */
function fakeRepo() {
  const refs = new Map();
  const blobs = new Map();
  const trees = new Set();
  const diffs = new Map();
  const calls = [];
  const answer = (stdout) => ({ ok: true, stdout: Buffer.from(stdout) });
  const gitFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") {
      const oid = refs.get(args[1]);
      return oid ? answer(`${oid}\n`) : failing;
    }
    if (args[0] === "cat-file" && args[1] === "-t") {
      if (trees.has(args[2])) return answer("tree\n");
      return blobs.has(args[2]) ? answer("blob\n") : failing;
    }
    if (args[0] === "cat-file") {
      const blob = blobs.get(args[2]);
      return blob ? answer(blob) : failing;
    }
    if (args[0] === "diff-tree") {
      const stream = diffs.get(`${args.at(-2)} ${args.at(-1)}`);
      return stream ? answer(stream) : failing;
    }
    return failing;
  };
  const head = nextOid();
  const tree = nextOid();
  const wf = nextOid();
  const gate = nextOid();
  const canon = nextOid();
  trees.add(tree);
  /** `tree` names a tree unless `asBlob`, which files it as a blob. */
  const commit = ({
    tree: t = nextOid(),
    wf: w = wf,
    gate: g = gate,
    canon: c = canon,
    asBlob = false,
  } = {}) => {
    const id = nextOid();
    if (asBlob) blobs.set(t, Buffer.from("src-tauri-link"));
    else trees.add(t);
    refs.set(`${id}:${TREE_PATH}`, t);
    refs.set(`${id}:${WORKFLOW_PATH}`, w);
    refs.set(`${id}:${GATE_PATH}`, g);
    refs.set(`${id}:${CANONICALIZER_PATH}`, c);
    return { sha: id, tree: t };
  };
  refs.set(`${head}:${TREE_PATH}`, tree);
  refs.set(`${head}:${WORKFLOW_PATH}`, wf);
  refs.set(`${head}:${GATE_PATH}`, gate);
  refs.set(`${head}:${CANONICALIZER_PATH}`, canon);
  // The checked-out commit's gate and workflow: the head's, unless a test
  // moves them.
  refs.set(`HEAD:${GATE_PATH}`, gate);
  refs.set(`HEAD:${WORKFLOW_PATH}`, wf);
  blobs.set(canon, Buffer.from("# canonicalizer\n"));
  const blob = (content) => {
    const id = nextOid();
    blobs.set(id, Buffer.from(content));
    return id;
  };
  const currentBlobs = new Map();
  const green = (files, opts) => {
    const c = commit(opts);
    let stream = "";
    for (const [path, [past, current]] of Object.entries(files)) {
      if (!currentBlobs.has(path)) currentBlobs.set(path, blob(current));
      stream += `${raw(blob(past), currentBlobs.get(path))}\0${path}\0`;
    }
    diffs.set(`${c.tree} ${tree}`, Buffer.from(stream, "utf8"));
    return c.sha;
  };
  return {
    git: gitFn,
    refs,
    blobs,
    blob,
    trees,
    diffs,
    calls,
    head,
    tree,
    wf,
    gate,
    canon,
    commit,
    green,
    env: pushEnv(head),
  };
}

const onFake = (fake, greens, extra = {}) =>
  run({ env: fake.env, git: fake.git, greens, ...extra });

// ------------------------------------------------------------ head and list

test("a re-run attempt runs the matrix with no git or gh call (fake git)", () => {
  for (const attempt of ["2", "", undefined]) {
    const fake = fakeRepo();
    const env = { ...fake.env, ATTEMPT: attempt };
    if (attempt === undefined) delete env.ATTEMPT;
    const out = run({ env, git: fake.git });
    assert.equal(out.run, true);
    assert.equal(out.reason, "explicit re-run");
    assert.equal(
      out.lines[0],
      `rust-gate: run_attempt=${attempt ?? ""} is a re-run; running the matrix.`,
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(out.gh.calls, 0);
  }
});

test("the event picks the head SHA it signs (fake git)", () => {
  const fake = fakeRepo();
  const signature = `rust-gate: signature ${short(fake.head)} tree=${fake.tree} wf=${fake.wf} gate=${fake.gate} canon=${fake.canon}`;
  for (const env of [
    {
      ATTEMPT: "1",
      EVENT: "pull_request",
      PR_HEAD: fake.head,
      PUSH_SHA: SHA_A,
    },
    { ATTEMPT: "1", EVENT: "push", PUSH_SHA: fake.head, PR_HEAD: SHA_A },
  ]) {
    fake.calls.length = 0;
    const out = run({ env, git: fake.git });
    assert.equal(out.lines[0], signature);
    assert.equal(out.reason, "no prior green run for this exact content");
    assert.ok(fake.calls.every((args) => !args.join(" ").includes(SHA_A)));
  }
});

test("an invalid head SHA runs the matrix before any git call (fake git)", () => {
  for (const head of ["", "not-hex", "-x", "a".repeat(39), "A".repeat(40)]) {
    const fake = fakeRepo();
    const env = { ATTEMPT: "1", EVENT: "pull_request", PR_HEAD: head };
    const out = run({ env, git: fake.git });
    assert.equal(out.run, true);
    assert.equal(out.reason, "invalid head SHA");
    assert.deepEqual(out.lines, [
      "rust-gate: decision run=true (invalid head SHA)",
    ]);
    assert.equal(fake.calls.length, 0);
  }
});

test("a head without a src-tauri tree runs before listing greens (fake git)", () => {
  const fake = fakeRepo();
  fake.refs.delete(`${fake.head}:${TREE_PATH}`);
  const out = onFake(fake, [SHA_A]);
  assert.equal(out.run, true);
  assert.equal(
    out.reason,
    "no src-tauri tree, workflow blob or gate script at this commit",
  );
  assert.match(out.lines[0], / tree=\? wf=/);
  assert.equal(out.gh.calls, 0);
});

test("an empty green list runs the matrix (fake git)", () => {
  const out = onFake(fakeRepo(), []);
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(
    out.lines.includes(
      "rust-gate: listed 0 green head SHAs (0 malformed dropped)",
    ),
  );
  assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
  assert.equal(
    out.lines.at(-1),
    "rust-gate: decision run=true (no prior green run for this exact content)",
  );
});

test("a green list that fails is treated as empty (fake git)", () => {
  const out = onFake(fakeRepo(), [], {
    listGreens: () => {
      throw new Error("HTTP 502\nbad gateway");
    },
  });
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(
    out.lines.includes(
      "rust-gate: could not list green runs (HTTP 502 bad gateway); treating the list as empty.",
    ),
  );
});

test("malformed green entries are dropped and counted (fake git)", () => {
  const fake = fakeRepo();
  const out = onFake(fake, ["", "-x", "A".repeat(40), "a".repeat(39), SHA_B]);
  assert.equal(out.run, true);
  assert.ok(
    out.lines.includes(
      "rust-gate: listed 1 green head SHAs (4 malformed dropped)",
    ),
  );
  const args = fake.calls.flat().join("\n");
  assert.ok(!args.includes("-x") && !args.includes("A".repeat(40)));
  assert.ok(!args.includes(`${"a".repeat(39)}:`));
});

test("an unknown or missing event runs the matrix before any lookup (fake git)", () => {
  for (const event of [
    undefined,
    "",
    "PUSH",
    "push ",
    "pull_request_target",
    "workflow_dispatch",
    "push\n::error::injected",
  ]) {
    const fake = fakeRepo();
    const env = { ...fake.env, EVENT: event, PR_HEAD: fake.head };
    if (event === undefined) delete env.EVENT;
    const out = run({ env, git: fake.git });
    const reason = `unknown event ${JSON.stringify(event ?? "")}`;
    assert.ok(!reason.includes("\n"));
    assert.equal(out.run, true, String(event));
    assert.equal(out.reason, reason);
    assert.deepEqual(out.lines, [`rust-gate: decision run=true (${reason})`]);
    assert.equal(fake.calls.length, 0);
    assert.equal(out.gh.calls, 0);
  }
});

test("a non-hex rev-parse answer never compares equal (fake git)", () => {
  for (const answer of ["not-an-oid\n", `${"A".repeat(40)}\n`, "\n"]) {
    const fake = fakeRepo();
    const exact = fake.commit({ tree: fake.tree }).sha;
    const gitFn = (args) =>
      args[0] === "rev-parse" && args[1].endsWith(`:${TREE_PATH}`)
        ? { ok: true, stdout: Buffer.from(answer) }
        : fake.git(args);
    const out = onFake(fake, [exact], { git: gitFn });
    assert.equal(out.run, true, JSON.stringify(answer));
    assert.equal(
      out.reason,
      "no src-tauri tree, workflow blob or gate script at this commit",
    );
    assert.match(out.lines[0], / tree=\? wf=/);
    assert.equal(out.gh.calls, 0);
  }
});

test("pass 1 needs the same workflow and gate blobs as well as the tree (fake git)", () => {
  for (const opts of [{ wf: nextOid() }, { gate: nextOid() }]) {
    const fake = fakeRepo();
    const sameTree = fake.commit({ tree: fake.tree, ...opts }).sha;
    const out = onFake(fake, [sameTree]);
    assert.equal(out.run, true, Object.keys(opts)[0]);
    assert.equal(out.reason, "no prior green run for this exact content");
    assert.ok(!out.text.includes("pass 1"), out.text);
    assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
  }
});

test("pass 1 needs the same canonicalizer blob too (fake git)", () => {
  const fake = fakeRepo();
  const otherCanon = fake.commit({ tree: fake.tree, canon: nextOid() }).sha;
  const out = onFake(fake, [otherCanon]);
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(!out.text.includes("pass 1"), out.text);
  assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
});

test("a head without the canonicalizer never skips, even vs a canonicalizer-less twin (fake git)", () => {
  const fake = fakeRepo();
  fake.refs.delete(`${fake.head}:${CANONICALIZER_PATH}`);
  const twin = fake.commit({ tree: fake.tree }).sha;
  fake.refs.delete(`${twin}:${CANONICALIZER_PATH}`);
  const out = onFake(fake, [twin]);
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.match(out.lines[0], / canon=\?$/);
  assert.ok(
    out.lines.includes("rust-gate: pass 1 skipped: no canonicalizer blob."),
  );
  assert.ok(
    out.lines.includes("rust-gate: pass 2 skipped: no canonicalizer blob."),
  );
  assert.ok(!out.text.includes("pass 1: identical"), out.text);
});

test("the running gate and workflow must be the head's, on both events (fake git)", () => {
  // On pull_request the checked-out HEAD is the merge commit, never PR_HEAD;
  // PUSH_SHA names that merge so no lookup can reach it by SHA.
  const envs = {
    push: (fake) => fake.env,
    pull_request: (fake) => ({
      ATTEMPT: "1",
      EVENT: "pull_request",
      PR_HEAD: fake.head,
      PUSH_SHA: nextOid(),
    }),
  };
  for (const [event, envOf] of Object.entries(envs)) {
    // A merge that left both alone: the twin green is skippable.
    const same = fakeRepo();
    const exact = same.commit({ tree: same.tree }).sha;
    const skip = run({ env: envOf(same), git: same.git, greens: [exact] });
    assert.equal(skip.run, false, `${event}: ${skip.text}`);

    for (const [path, running, reason] of [
      [GATE_PATH, nextOid(), "the gate that runs differs from the head's gate"],
      [GATE_PATH, null, "could not resolve the running gate at HEAD"],
      [
        WORKFLOW_PATH,
        nextOid(),
        "the workflow that runs differs from the head's workflow",
      ],
      [WORKFLOW_PATH, null, "could not resolve the running workflow at HEAD"],
    ]) {
      const fake = fakeRepo();
      const twin = fake.commit({ tree: fake.tree }).sha;
      if (running) fake.refs.set(`HEAD:${path}`, running);
      else fake.refs.delete(`HEAD:${path}`);
      const env = envOf(fake);
      const out = run({ env, git: fake.git, greens: [twin] });
      const where = `${event}: ${reason}`;
      assert.equal(out.run, true, where);
      assert.equal(out.reason, reason, where);
      assert.equal(out.gh.calls, 0, where);
      assert.equal(
        out.lines.at(-1),
        `rust-gate: decision run=true (${reason})`,
      );
      assert.ok(
        fake.calls.some(
          (args) => args[0] === "rev-parse" && args[1] === `HEAD:${path}`,
        ),
        where,
      );
      assert.ok(
        fake.calls.every((args) => !args.join(" ").includes(env.PUSH_SHA)) ||
          event === "push",
        where,
      );
    }
  }
});

test("diff-tree never lets submodule config hide a gitlink (fake git)", () => {
  const fake = fakeRepo();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  onFake(fake, [past]);
  const diffs = fake.calls.filter((args) => args[0] === "diff-tree");
  assert.equal(diffs.length, 1);
  assert.ok(diffs[0].includes("--ignore-submodules=none"), diffs[0].join(" "));
  assert.ok(diffs[0].indexOf("--ignore-submodules=none") < diffs[0].length - 2);
});

test("a head without the gate script runs before listing greens (fake git)", () => {
  const fake = fakeRepo();
  fake.refs.delete(`${fake.head}:${GATE_PATH}`);
  const exact = fake.commit({ tree: fake.tree }).sha;
  const out = onFake(fake, [exact]);
  assert.equal(out.run, true);
  assert.equal(
    out.reason,
    "no src-tauri tree, workflow blob or gate script at this commit",
  );
  assert.match(out.lines[0], / gate=\? canon=/);
  assert.equal(out.gh.calls, 0);
});

test("duplicate greens are compared once, first occurrence kept (fake git)", () => {
  const fake = fakeRepo();
  const code = fake.green({ "src/lib.rs": [CODE, COMMENTED] });
  const out = onFake(fake, [code, code, SHA_A, code]);
  assert.equal(out.run, true);
  assert.ok(
    out.lines.includes(
      "rust-gate: listed 2 green head SHAs (0 malformed dropped)",
    ),
  );
  assert.ok(
    out.lines.includes("rust-gate: dropped 2 duplicate green head SHAs."),
  );
  assert.ok(out.lines.includes("rust-gate: pass 2: 1 candidates compared."));
  const treeReads = fake.calls.filter(
    (args) => args[0] === "rev-parse" && args[1] === `${code}:${TREE_PATH}`,
  );
  // Once in pass 1, once in pass 2.
  assert.equal(treeReads.length, 2);
  assert.equal(fake.calls.filter((args) => args[0] === "diff-tree").length, 1);
  const order = fake.calls
    .filter((args) => args[0] === "rev-parse" && args[1].endsWith(TREE_PATH))
    .map((args) => args[1].slice(0, 40));
  assert.deepEqual(order.slice(1, 3), [code, SHA_A]);
});

test("pass 1 scans all 100 greens, the match last (fake git)", () => {
  const fake = fakeRepo();
  const greens = Array.from({ length: 99 }, () => nextOid());
  const exact = fake.commit({ tree: fake.tree }).sha;
  const out = onFake(fake, [...greens, exact]);
  assert.equal(out.run, false);
  assert.equal(
    out.reason,
    `pass 1: identical content passed in ${short(exact)}`,
  );
  assert.ok(
    out.lines.includes(
      "rust-gate: listed 100 green head SHAs (0 malformed dropped)",
    ),
  );
  assert.ok(
    out.lines.includes(
      `rust-gate: pass 1: identical content passed in ${short(exact)}.`,
    ),
  );
});

test("100 greens with no match run the matrix (fake git)", () => {
  const fake = fakeRepo();
  const out = onFake(
    fake,
    Array.from({ length: 100 }, () => fake.commit().sha),
  );
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
});

// ------------------------------------------------------------ pass 2 limits

test(`${MAX_CHANGED} comment-only .rs files skip, ${MAX_CHANGED + 1} reject (fake git)`, () => {
  const files = (n) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, k) => [`src/f${k}.rs`, [SAME, COMMENTED]]),
    );
  const fits = fakeRepo();
  const ok = onFake(fits, [fits.green(files(MAX_CHANGED))]);
  assert.equal(ok.run, false);
  assert.match(
    ok.reason,
    /^pass 2: comment\/format-only delta vs [0-9a-f]{8} \(60 \.rs files\)$/,
  );

  const over = fakeRepo();
  const past = over.green(files(MAX_CHANGED + 1));
  const out = onFake(over, [past]);
  assert.equal(out.run, true);
  assert.ok(
    out.lines.includes(
      `rust-gate: pass 2: ${short(past)} rejected - 61 changed files (> 60).`,
    ),
  );
});

test(`at most ${MAX_COMPARED} candidates reach comparison (fake git)`, () => {
  const fake = fakeRepo();
  const canonicalizer = stubCanonicalizer();
  const greens = Array.from({ length: 16 }, () =>
    fake.green({ "src/lib.rs": [CODE, COMMENTED] }),
  );
  greens.push(fake.green({ "src/lib.rs": [SAME, COMMENTED] }));
  const out = onFake(fake, greens, { canonicalizer });
  assert.equal(out.run, true);
  assert.ok(
    out.lines.includes(
      "rust-gate: pass 2: stopping after 15 candidates reached per-file comparison.",
    ),
  );
  assert.ok(out.lines.includes("rust-gate: pass 2: 15 candidates compared."));
  // One current-side read (cached by blob OID) plus one past side per candidate.
  assert.equal(canonicalizer.inputs.length, 1 + MAX_COMPARED);
});

test("the current side is canonicalized once across candidates (fake git)", () => {
  const fake = fakeRepo();
  const canonicalizer = stubCanonicalizer();
  const greens = [
    fake.green({ "src/lib.rs": [CODE, COMMENTED] }),
    fake.green({ "src/lib.rs": [CODE, COMMENTED] }),
  ];
  const out = onFake(fake, greens, { canonicalizer });
  assert.equal(out.run, true);
  assert.ok(out.lines.includes("rust-gate: pass 2: 2 candidates compared."));
  assert.equal(
    canonicalizer.inputs.filter((text) => text === COMMENTED).length,
    1,
  );
  assert.equal(canonicalizer.inputs.filter((text) => text === CODE).length, 2);
});

// --------------------------------------------- pass 2 unreadable inputs (fake)

test("a failed diff-tree rejects the candidate (fake git)", () => {
  const fake = fakeRepo();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const out = onFake(fake, [past], {
    git: (args) => (args[0] === "diff-tree" ? failing : fake.git(args)),
  });
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(
    out.lines.includes(
      `rust-gate: pass 2: ${short(past)} rejected - diff-tree failed.`,
    ),
  );
});

test("an empty diff-tree output rejects the candidate (fake git)", () => {
  const fake = fakeRepo();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const out = onFake(fake, [past], {
    git: (args) =>
      args[0] === "diff-tree"
        ? { ok: true, stdout: Buffer.alloc(0) }
        : fake.git(args),
  });
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(
    out.lines.includes(
      `rust-gate: pass 2: ${short(past)} rejected - empty diff-tree output.`,
    ),
  );
});

test("an unreadable diff-tree record rejects the candidate (fake git)", () => {
  const [o1, o2] = [nextOid(), nextOid()];
  const head = raw(o1, o2);
  for (const stream of [
    `${head}\0src/lib.rs\0${head}\0`,
    `${head}\0src/lib.rs`,
    `${head}\0\0`,
    // Malformed headers: the --name-status form, a missing colon, a short or
    // long field list, a non-hex or short OID, a bad mode, a bad status.
    "M\0src/lib.rs\0",
    `${head.slice(1)}\0src/lib.rs\0`,
    `:100644 100644 ${o1} ${o2}\0src/lib.rs\0`,
    `${head} X\0src/lib.rs\0`,
    `${head.replace(o1, "g".repeat(40))}\0src/lib.rs\0`,
    `${head.replace(o1, o1.toUpperCase().replace(/0/g, "A"))}\0src/lib.rs\0`,
    `${head.replace(o1, o1.slice(1))}\0src/lib.rs\0`,
    `${raw(o1, o2, { oldMode: "10064" })}\0src/lib.rs\0`,
    `${raw(o1, o2, { status: "m" })}\0src/lib.rs\0`,
    `${head.replace(" M", "  M")}\0src/lib.rs\0`,
  ]) {
    const fake = fakeRepo();
    const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
    const out = onFake(fake, [past], {
      git: (args) =>
        args[0] === "diff-tree"
          ? { ok: true, stdout: Buffer.from(stream) }
          : fake.git(args),
    });
    assert.equal(out.run, true, JSON.stringify(stream));
    assert.ok(
      out.lines.includes(
        `rust-gate: pass 2: ${short(past)} rejected - unreadable diff-tree output.`,
      ),
    );
  }
});

test("symlink, mode-change and typechange .rs records reject (fake git)", () => {
  for (const [opts, why] of [
    [{ oldMode: "120000" }, "non-regular file (120000 src/lib.rs)"],
    [{ oldMode: "160000" }, "non-regular file (160000 src/lib.rs)"],
    [
      { oldMode: "100644", newMode: "100755" },
      "mode change (100644 -> 100755 src/lib.rs)",
    ],
    [
      { oldMode: "120000", newMode: "100644", status: "T" },
      "non-.rs or non-modify change (T src/lib.rs)",
    ],
  ]) {
    const fake = fakeRepo();
    const canonicalizer = stubCanonicalizer();
    const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
    const stream = `${raw(fake.blob(SAME), fake.blob(COMMENTED), opts)}\0src/lib.rs\0`;
    const out = onFake(fake, [past], {
      canonicalizer,
      git: (args) =>
        args[0] === "diff-tree"
          ? { ok: true, stdout: Buffer.from(stream) }
          : fake.git(args),
    });
    assert.equal(out.run, true, why);
    assert.ok(
      out.lines.includes(
        `rust-gate: pass 2: ${short(past)} rejected - ${why}.`,
      ),
      why,
    );
    assert.deepEqual(canonicalizer.inputs, [], why);
  }
});

test("blobs are read by the diff's OIDs, never by path (fake git)", () => {
  const fake = fakeRepo();
  const canonicalizer = stubCanonicalizer();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const out = onFake(fake, [past], { canonicalizer });
  assert.equal(out.run, false);
  const lookups = fake.calls
    .filter((args) => args[0] === "rev-parse")
    .map((args) => args[1].slice(args[1].indexOf(":") + 1));
  assert.ok(
    lookups.every((path) =>
      [TREE_PATH, WORKFLOW_PATH, GATE_PATH, CANONICALIZER_PATH].includes(path),
    ),
    lookups.join(" "),
  );
  assert.deepEqual(canonicalizer.inputs.sort(), [COMMENTED, SAME].sort());
});

test("a current-side canonicalizer failure aborts pass 2 (fake git)", () => {
  const fake = fakeRepo();
  // Fails once, then would succeed: a retry must not be taken as evidence.
  let failures = 1;
  const canonicalizer = stubCanonicalizer({
    nullWhen: (text) => text === COMMENTED && failures-- > 0,
  });
  const first = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const second = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const out = onFake(fake, [first, second], { canonicalizer });
  const reason = "canonicalizer anomaly on current side (src/lib.rs)";
  assert.equal(out.run, true, out.text);
  assert.equal(out.reason, `pass 2 aborted: ${reason}`);
  assert.ok(out.lines.includes(`rust-gate: pass 2 aborted: ${reason}.`));
  // The second candidate is never reached.
  assert.ok(out.lines.includes("rust-gate: pass 2: 1 candidates compared."));
  assert.equal(
    canonicalizer.inputs.filter((text) => text === COMMENTED).length,
    1,
  );
});

test("a past-side canonicalizer failure rejects only its candidate (fake git)", () => {
  const fake = fakeRepo();
  const BROKEN = "// broken\nfn a() {}\n";
  const canonicalizer = stubCanonicalizer({
    nullWhen: (text) => text === BROKEN,
  });
  const first = fake.green({ "src/lib.rs": [BROKEN, COMMENTED] });
  const second = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const out = onFake(fake, [first, second], { canonicalizer });
  assert.equal(out.run, false, out.text);
  assert.equal(
    out.reason,
    `pass 2: comment/format-only delta vs ${short(second)} (1 .rs files)`,
  );
  assert.ok(
    out.lines.includes(
      `rust-gate: pass 2: ${short(first)} rejected - a changed .rs file is not equivalent.`,
    ),
  );
  assert.ok(
    out.lines.includes(
      "rust-gate:   src/lib.rs: canonicalizer anomaly on past side",
    ),
  );
});

test("a pass-2 candidate needs the same workflow and gate blobs (fake git)", () => {
  for (const opts of [{ wf: nextOid() }, { gate: nextOid() }]) {
    const fake = fakeRepo();
    const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] }, opts);
    const out = onFake(fake, [past]);
    assert.equal(out.run, true, Object.keys(opts)[0]);
    assert.equal(out.reason, "no prior green run for this exact content");
    assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
    assert.ok(fake.calls.every((args) => args[0] !== "diff-tree"));
  }
});

test("src-tauri must be a tree on the head and on each candidate (fake git)", () => {
  // Head: a src-tauri blob that a green shares byte for byte.
  const head = fakeRepo();
  head.trees.delete(head.tree);
  head.blobs.set(head.tree, Buffer.from("src-tauri-link"));
  const twin = head.commit({ tree: head.tree, asBlob: true }).sha;
  const out = onFake(head, [twin]);
  assert.equal(out.run, true);
  assert.equal(
    out.reason,
    "no src-tauri tree, workflow blob or gate script at this commit",
  );
  assert.match(out.lines[0], / tree=\? wf=/);
  assert.equal(out.gh.calls, 0);

  // Candidate: a src-tauri blob whose diff would read as comment-only.
  const fake = fakeRepo();
  const { sha: past, tree: pastTree } = fake.commit({ asBlob: true });
  const stream = `${raw(fake.blob(SAME), fake.blob(COMMENTED))}\0src/lib.rs\0`;
  fake.diffs.set(`${pastTree} ${fake.tree}`, Buffer.from(stream));
  const cand = onFake(fake, [past]);
  assert.equal(cand.run, true);
  assert.equal(cand.reason, "no prior green run for this exact content");
  assert.ok(cand.lines.includes("rust-gate: pass 2: 0 candidates compared."));
});

test("a canonicalizer that cannot be extracted skips pass 2 (fake git)", () => {
  const fake = fakeRepo();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  for (const gitFn of [
    (args) =>
      args[0] === "cat-file" && args[1] === "blob" ? failing : fake.git(args),
    (args) =>
      args[0] === "cat-file" && args[2] === fake.canon
        ? { ok: true, stdout: Buffer.alloc(0) }
        : fake.git(args),
  ]) {
    const out = onFake(fake, [past], { git: gitFn });
    assert.equal(out.run, true);
    assert.ok(
      out.lines.includes(
        "rust-gate: pass 2 skipped: could not extract canonicalizer.",
      ),
    );
  }
});

test("a canonicalizer that fails the known-input probe skips pass 2 (fake git)", () => {
  // Exit 0 with empty output for everything would equate a real code change.
  const silent = { selfTest: () => true, canonicalize: () => Buffer.alloc(0) };
  const refusing = { selfTest: () => true, canonicalize: () => null };
  for (const canonicalizer of [silent, refusing]) {
    const fake = fakeRepo();
    const past = fake.green({ "src/lib.rs": [CODE, COMMENTED] });
    const out = onFake(fake, [past], { canonicalizer });
    assert.equal(out.run, true, out.text);
    assert.equal(out.reason, "no prior green run for this exact content");
    assert.ok(
      out.lines.includes(
        "rust-gate: pass 2 skipped: canonicalizer anomaly on a known input.",
      ),
      out.text,
    );
    assert.ok(fake.calls.every((args) => args[0] !== "diff-tree"));
  }
  // A working canonicalizer is probed once per pass.
  const fake = fakeRepo();
  const stub = stubCanonicalizer();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  assert.equal(onFake(fake, [past], { canonicalizer: stub }).run, false);
  assert.equal(stub.probes.length, 1);
});

test("a failed canonicalizer self-test skips pass 2 (fake git)", () => {
  const fake = fakeRepo();
  const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
  const out = onFake(fake, [past], {
    canonicalizer: stubCanonicalizer({ selfTest: false }),
  });
  assert.equal(out.run, true);
  assert.ok(
    out.lines.includes(
      "rust-gate: pass 2 skipped: canonicalizer self-test failed.",
    ),
  );
});

test("a canonicalizer anomaly on either side is not equivalent (fake git)", () => {
  for (const [content, side, line] of [
    [
      COMMENTED,
      "current",
      "rust-gate: pass 2 aborted: canonicalizer anomaly on current side (src/lib.rs).",
    ],
    [
      SAME,
      "past",
      "rust-gate:   src/lib.rs: canonicalizer anomaly on past side",
    ],
  ]) {
    const fake = fakeRepo();
    const past = fake.green({ "src/lib.rs": [SAME, COMMENTED] });
    const out = onFake(fake, [past], {
      canonicalizer: stubCanonicalizer({
        nullWhen: (text) => text === content,
      }),
    });
    assert.equal(out.run, true, side);
    assert.ok(out.lines.includes(line), out.text);
  }
});

test("a spawn error fails the Python canonicalizer seam", () => {
  const lines = [];
  const python = pythonCanonicalizer("gd-rust-gate-no-such-python", (line) =>
    lines.push(line),
  );
  assert.equal(python.selfTest(join(root, "missing.py")), false);
  assert.ok(lines.length > 0);
  assert.equal(
    python.canonicalize(join(root, "missing.py"), Buffer.from("x")),
    null,
  );
});

// ---------------------------------------------------------------- real git

test("pass 1 matches identical content on real git", () => {
  const out = onRepo(sha.base, [SHA_A, sha.base]);
  assert.equal(out.run, false);
  assert.equal(
    out.reason,
    `pass 1: identical content passed in ${short(sha.base)}`,
  );
  assert.ok(
    out.lines.includes(
      "rust-gate: listed 2 green head SHAs (0 malformed dropped)",
    ),
  );
});

test("pass 1 outranks an earlier pass-2-equivalent green (real git)", () => {
  const out = onRepo(sha.comment, [sha.base, sha.comment2]);
  assert.equal(out.run, false);
  assert.equal(
    out.reason,
    `pass 1: identical content passed in ${short(sha.comment2)}`,
  );
  assert.ok(!out.text.includes("pass 2"));
});

test("a comment-only .rs change skips by pass 2 (real git)", () => {
  const out = onRepo(sha.comment, [sha.base]);
  assert.equal(out.run, false);
  assert.equal(
    out.reason,
    `pass 2: comment/format-only delta vs ${short(sha.base)} (1 .rs files)`,
  );
  assert.ok(
    out.lines.includes("rust-gate: pass 2: canonicalizer self-test passed."),
  );
  assert.ok(out.lines.includes("rust-gate:   src/lib.rs: equivalent"));
  assert.ok(out.lines.includes("rust-gate: pass 2: 1 candidates compared."));
});

test("a real code change runs the matrix (real git)", () => {
  const out = onRepo(sha.code, [sha.base]);
  assert.equal(out.run, true);
  assert.equal(out.reason, "no prior green run for this exact content");
  assert.ok(
    out.lines.includes(
      "rust-gate:   src/lib.rs: canonical mismatch (real code change)",
    ),
  );
});

test("quoted, spaced and glob .rs paths reach git intact (real git)", () => {
  const out = onRepo(sha.paths, [sha.base]);
  assert.equal(out.run, false);
  assert.equal(
    out.reason,
    `pass 2: comment/format-only delta vs ${short(sha.base)} (${ODD_PATHS.length} .rs files)`,
  );
  for (const path of ODD_PATHS) {
    assert.ok(out.lines.includes(`rust-gate:   ${path}: equivalent`), path);
  }
});

test("non-.rs, added, deleted and renamed changes reject (real git)", () => {
  const out = onRepo(sha.base, [
    sha.cargo,
    sha.added,
    sha.deleted,
    sha.renamed,
  ]);
  assert.equal(out.run, true);
  for (const [past, change] of [
    [sha.cargo, "M Cargo.toml"],
    [sha.added, "D src/new.rs"],
    [sha.deleted, "A src/del.rs"],
    [sha.renamed, "A src/old.rs"],
  ]) {
    assert.ok(
      out.lines.includes(
        `rust-gate: pass 2: ${short(past)} rejected - non-.rs or non-modify change (${change}).`,
      ),
      change,
    );
  }
  assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
});

test("a symlinked .rs and a mode-only change reject (real git)", () => {
  for (const [head, why] of [
    [sha.symlink, "non-regular file (120000 src/link.rs)"],
    [sha.exec, "mode change (100644 -> 100755 src/lib.rs)"],
  ]) {
    const canonicalizer = stubCanonicalizer();
    const out = onRepo(head, [sha.base], { canonicalizer });
    assert.equal(out.run, true, why);
    assert.equal(out.reason, "no prior green run for this exact content");
    assert.ok(
      out.lines.includes(
        `rust-gate: pass 2: ${short(sha.base)} rejected - ${why}.`,
      ),
      out.text,
    );
    assert.deepEqual(canonicalizer.inputs, [], why);
  }
});

test("a head without the canonicalizer skips pass 2 (real git)", () => {
  const out = onRepo(sha.nocanon, [sha.base]);
  assert.equal(out.run, true);
  assert.match(out.lines[0], / canon=\?$/);
  assert.ok(
    out.lines.includes("rust-gate: pass 2 skipped: no canonicalizer blob."),
  );
});

test("a green with another canonicalizer blob is no candidate (real git)", () => {
  const out = onRepo(sha.comment, [sha.othercanon]);
  assert.equal(out.run, true);
  assert.ok(out.lines.includes("rust-gate: pass 2: 0 candidates compared."));
});

test("an unresolved workflow blob runs the matrix, pass 2 refuses it (real git)", () => {
  const noWorkflow = (args) =>
    args[0] === "rev-parse" && args[1].endsWith(`:${WORKFLOW_PATH}`)
      ? failing
      : realGit(args);
  const out = onRepo(sha.comment, [sha.base], { git: noWorkflow });
  assert.equal(out.run, true);
  assert.equal(
    out.reason,
    "no src-tauri tree, workflow blob or gate script at this commit",
  );
  assert.match(out.lines[0], / wf=\? /);
  assert.equal(out.gh.calls, 0);

  // Row 10: the same shape fed straight to pass 2, where the candidate's
  // workflow blob is absent too and would otherwise compare equal.
  const lines = [];
  const second = passTwo({
    curTree: git(repo.dir, ["rev-parse", `${sha.comment}:${TREE_PATH}`]).trim(),
    curWf: "",
    curCanon: git(repo.dir, [
      "rev-parse",
      `${sha.comment}:${CANONICALIZER_PATH}`,
    ]).trim(),
    greens: [sha.base],
    git: noWorkflow,
    canonicalizer: stubCanonicalizer(),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(second, { skip: false, reason: "no workflow blob" });
  assert.deepEqual(lines, ["rust-gate: pass 2 skipped: no workflow blob."]);
});

/** Interpreters the real-Python test may use: CI runs the production command
 *  `python3` alone, so a missing python3 there fails instead of falling back. */
const pythonCandidates = (env) =>
  env.CI === "true" ? ["python3"] : ["python3", "python"];

test("CI discovers only python3; local runs may fall back to python", () => {
  assert.deepEqual(pythonCandidates({ CI: "true" }), ["python3"]);
  assert.deepEqual(pythonCandidates({}), ["python3", "python"]);
  assert.deepEqual(pythonCandidates({ CI: "1" }), ["python3", "python"]);
});

test("the real canonicalizer decides both directions (real git, real Python)", (t) => {
  const pythonEnv = childEnv({});
  for (const env of [pythonEnv, gitEnv]) {
    assert.equal(env.GITHUB_OUTPUT, undefined);
    assert.equal(env.GH_TOKEN, undefined);
  }
  const python = pythonCandidates(process.env).find((cmd) => {
    const result = spawnSync(cmd, ["--version"], {
      encoding: "utf8",
      env: pythonEnv,
      timeout: 10_000,
    });
    return (
      !result.error && /^Python 3\./.test(`${result.stdout}${result.stderr}`)
    );
  });
  if (!python) {
    // An absent interpreter in CI must not read as a pass.
    assert.notEqual(process.env.CI, "true", "no python3 on PATH in CI");
    t.skip("no Python 3 on PATH; CI's guards job runs this");
    return;
  }
  const canonicalizer = pythonCanonicalizer(python, () => {}, pythonEnv);
  const scriptCopy = join(mkdtempSync(join(root, "canon-")), "canon.py");
  writeFileSync(scriptCopy, REAL_CANONICALIZER);
  const probed = canonicalizer.canonicalize(scriptCopy, CANONICALIZER_PROBE);
  assert.ok(Buffer.isBuffer(probed) && probed.length > 0, "probe output");
  const same = onRepo(sha.comment, [sha.base], { canonicalizer });
  assert.equal(same.run, false, same.text);
  assert.equal(
    same.reason,
    `pass 2: comment/format-only delta vs ${short(sha.base)} (1 .rs files)`,
  );
  const changed = onRepo(sha.code, [sha.base], { canonicalizer });
  assert.equal(changed.run, true, changed.text);
  assert.ok(
    changed.lines.includes(
      "rust-gate:   src/lib.rs: canonical mismatch (real code change)",
    ),
  );
});

// ---------------------------------------------------------------- the CLI

function cli(cwd, vars, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv(vars),
    timeout: 30_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the CLI appends a re-run decision to GITHUB_OUTPUT", () => {
  const dir = mkdtempSync(join(root, "cli-a-"));
  const output = join(dir, "output");
  writeFileSync(output, "x=1\n");
  const out = cli(dir, { ATTEMPT: "2", GITHUB_OUTPUT: output });
  assert.equal(out.code, 0, out.output);
  assert.equal(readFileSync(output, "utf8"), "x=1\nrun=true\n");
  assert.match(out.output, /rust-gate: decision run=true \(explicit re-run\)/);
});

test("the CLI outside a repository decides run=true", () => {
  const dir = mkdtempSync(join(root, "cli-b-"));
  const output = join(root, "cli-b.output");
  writeFileSync(output, "");
  const out = cli(dir, {
    ATTEMPT: "1",
    EVENT: "push",
    PUSH_SHA: SHA_A,
    GITHUB_OUTPUT: output,
    GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  assert.equal(out.code, 0, out.output);
  assert.equal(readFileSync(output, "utf8"), "run=true\n");
  assert.ok(
    out.output.includes(
      "decision run=true (no src-tauri tree, workflow blob or gate script at this commit)",
    ),
  );
});

test("the CLI without GITHUB_OUTPUT writes nothing and exits 1", () => {
  const dir = mkdtempSync(join(root, "cli-c-"));
  const out = cli(dir, {
    ATTEMPT: "1",
    EVENT: "push",
    PUSH_SHA: SHA_A,
    RUNNER_TEMP: dir,
    GIT_CEILING_DIRECTORIES: root,
  });
  assert.equal(out.code, 1);
  assert.match(out.output, /::error::rust-gate: GITHUB_OUTPUT is not set/);
  assert.deepEqual(readdirSync(dir), []);
});

test("the CLI refuses an argument without writing a decision", () => {
  const dir = mkdtempSync(join(root, "cli-d-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const out = cli(dir, { ATTEMPT: "2", GITHUB_OUTPUT: output }, ["--run"]);
  assert.equal(out.code, 1);
  assert.match(out.output, /::error::rust-gate: unexpected argument/);
  assert.equal(readFileSync(output, "utf8"), "");
});

test("runCli writes nothing when decide throws, Error or not", () => {
  for (const thrown of [new Error("git exploded"), "git exploded"]) {
    const output = join(mkdtempSync(join(root, "crash-")), "output");
    writeFileSync(output, "");
    const lines = [];
    const code = runCli({
      env: { ...pushEnv(SHA_A), GITHUB_OUTPUT: output },
      argv: [],
      deps: {
        git: () => {
          throw thrown;
        },
        listGreens: () => [],
        canonicalizer: stubCanonicalizer(),
        log: (line) => lines.push(line),
      },
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.deepEqual(
      lines.filter((line) => line.startsWith("::error::")),
      [
        "::error::rust-gate: git exploded - no decision written; the matrix runs (fail-open)",
      ],
    );
  }
});

test("the green list asks gh for this workflow's successful runs", () => {
  const env = { GH_TOKEN: "t", GH_REPO: "o/r" };
  const seen = [];
  const spawn = (cmd, args, options) => {
    seen.push({ cmd, args, options });
    return { status: 0, stdout: `${SHA_A}\n\n  ${SHA_B}  \n`, stderr: "" };
  };
  assert.deepEqual(ghGreens(env, spawn), [SHA_A, SHA_B]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, "gh");
  assert.deepEqual(seen[0].args, [
    "run",
    "list",
    "--workflow",
    "rust-tests.yml",
    "--status",
    "success",
    "--limit",
    "100",
    "--json",
    "headSha",
    "--jq",
    ".[].headSha",
  ]);
  // gh alone keeps the token, untouched.
  assert.equal(seen[0].options.env, env);

  const failed = () => ({ status: 1, stdout: "", stderr: "HTTP 502\nbad" });
  assert.throws(
    () => ghGreens(env, failed),
    /^Error: gh exited 1: HTTP 502 bad$/,
  );
});

test("git and Python children get no forge token; the token list is exact", () => {
  const env = {
    PATH: "/bin",
    GH_TOKEN: "t1",
    GITHUB_TOKEN: "t2",
    GH_REPO: "o/r",
    gh_host: "h",
    github_token: "t3",
    GITHUB_REPOSITORY: "o/r",
    GHOST: "kept",
  };
  const kept = { PATH: "/bin", GITHUB_REPOSITORY: "o/r", GHOST: "kept" };
  assert.deepEqual(withoutForgeTokens(env), kept);
  const seen = [];
  const spawn = (cmd, args, options) => {
    seen.push([cmd, options.env]);
    return { status: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  gitRunner(root, env, spawn)(["rev-parse", "HEAD"]);
  const python = pythonCanonicalizer("py", () => {}, env, spawn);
  python.selfTest("s.py");
  python.canonicalize("s.py", Buffer.from("x"));
  assert.deepEqual(
    seen.map(([cmd]) => cmd),
    ["git", "py", "py"],
  );
  for (const [cmd, childEnv] of seen) assert.deepEqual(childEnv, kept, cmd);
});

test("a real Python-seam child sees no GH_TOKEN", () => {
  const dir = mkdtempSync(join(root, "env-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    "process.stdout.write(JSON.stringify(Object.keys(process.env)));\n",
  );
  const python = pythonCanonicalizer(
    process.execPath,
    () => {},
    childEnv({ GH_TOKEN: "secret", GITHUB_TOKEN: "secret", GH_REPO: "o/r" }),
  );
  const names = JSON.parse(python.canonicalize(probe, Buffer.alloc(0)));
  assert.ok(names.includes("PATH") || names.includes("Path"), names.join());
  assert.deepEqual(
    names.filter((name) => /^(GH_|GITHUB_TOKEN$|GITHUB_OUTPUT$)/i.test(name)),
    [],
  );
});

test("the CLI runs from a symlinked or junctioned entry", (t) => {
  // A copy, so removing the temp root can never reach scripts/.
  const real = mkdtempSync(join(root, "entry-real-"));
  copyFileSync(SCRIPT, join(real, "check-rust-gate.mjs"));
  const link = join(root, `entry-link-${process.pid}`);
  try {
    symlinkSync(real, link, "junction");
  } catch (error) {
    assert.notEqual(process.env.CI, "true", String(error));
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  const output = join(real, "output");
  writeFileSync(output, "");
  const result = spawnSync(
    process.execPath,
    [join(link, "check-rust-gate.mjs")],
    {
      cwd: real,
      encoding: "utf8",
      env: childEnv({ ATTEMPT: "2", GITHUB_OUTPUT: output }),
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(readFileSync(output, "utf8"), "run=true\n");
});

test("runCli appends one skip decision after a pass-1 match", () => {
  const fake = fakeRepo();
  const exact = fake.commit({ tree: fake.tree }).sha;
  const output = join(mkdtempSync(join(root, "skip-")), "output");
  writeFileSync(output, "");
  const lines = [];
  const code = runCli({
    env: { ...fake.env, GITHUB_OUTPUT: output },
    argv: [],
    deps: {
      git: fake.git,
      listGreens: () => [exact],
      canonicalizer: stubCanonicalizer(),
      log: (line) => lines.push(line),
    },
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(output, "utf8"), "run=false\n");
  assert.equal(
    lines.at(-1),
    `rust-gate: decision run=false (pass 1: identical content passed in ${short(exact)})`,
  );
});

// --- P-pins: the workflow's fail-open wiring. A reader by indentation over
// the block subset rust-tests.yml uses; a missing or duplicated job, step id
// or key throws, so a reshaped file reds the pins instead of skipping them.

const WORKFLOW = readFileSync(
  fileURLToPath(new URL(`../${WORKFLOW_PATH}`, import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const TEST_IF =
  "${{ !cancelled() && (needs.gate.result != 'success' || needs.gate.outputs.decided != 'success' || needs.gate.outputs.run != 'false') }}";
const OLD_TEST_IF = "${{ !cancelled() && needs.gate.outputs.run != 'false' }}";
const GATE_OUTPUTS = [
  ["run", "${{ steps.decide.outputs.run }}"],
  ["decided", "${{ steps.decide.outcome }}"],
];
const DECIDE_RUN = "node scripts/check-rust-gate.mjs";
const DECIDE_IF = "steps.node.outcome == 'success'";
const DECIDE_TIMEOUT = "8";
const REPORT_NAME = "Report a gate that made no decision";
const REPORT_IF =
  "${{ !cancelled() && (steps.decide.outcome != 'success' || steps.decide.outputs.run == '') }}";
const OLD_REPORT_IF =
  "steps.node.outcome != 'success' || steps.decide.outcome != 'success'";
// The env scripts/check-rust-gate.mjs reads (gh reads the GH_ pair), by value:
// a head SHA from the wrong context would sign another commit.
const DECIDE_ENV = [
  ["ATTEMPT", "${{ github.run_attempt }}"],
  ["EVENT", "${{ github.event_name }}"],
  ["GH_REPO", "${{ github.repository }}"],
  ["GH_TOKEN", "${{ github.token }}"],
  ["PR_HEAD", "${{ github.event.pull_request.head.sha }}"],
  ["PUSH_SHA", "${{ github.sha }}"],
];

const indentOf = (line) => line.length - line.trimStart().length;
const isNoise = (line) =>
  line.trim() === "" || line.trimStart().startsWith("#");

function blockAfter(lines, start) {
  const base = indentOf(lines[start]);
  let end = start + 1;
  while (
    end < lines.length &&
    (isNoise(lines[end]) || indentOf(lines[end]) > base)
  ) {
    end++;
  }
  return lines.slice(start + 1, end);
}

function entries(lines, where) {
  const body = lines.filter((line) => !isNoise(line));
  if (body.length === 0) throw new Error(`${where}: empty block`);
  const indent = Math.min(...body.map(indentOf));
  const map = new Map();
  lines.forEach((line, i) => {
    if (isNoise(line) || indentOf(line) !== indent) return;
    const match = /^\s*([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!match)
      throw new Error(`${where}: unreadable line ${JSON.stringify(line)}`);
    if (map.has(match[1]))
      throw new Error(`${where}: duplicate key ${match[1]}`);
    map.set(match[1], {
      value: (match[2] ?? "").trim(),
      children: blockAfter(lines, i),
    });
  });
  return map;
}

function get(map, key, where) {
  const entry = map.get(key);
  if (!entry) throw new Error(`${where}: missing key ${key}`);
  return entry;
}

const topOf = (text) => entries(text.split("\n"), "workflow");

function jobOf(text, name) {
  const jobs = entries(get(topOf(text), "jobs", "workflow").children, "jobs");
  return entries(get(jobs, name, "jobs").children, `job ${name}`);
}

function stepsOf(job, where) {
  const lines = get(job, "steps", where).children;
  const indent = Math.min(...lines.filter((l) => !isNoise(l)).map(indentOf));
  const steps = [];
  for (const line of lines) {
    if (!isNoise(line) && indentOf(line) === indent) {
      if (!line.trimStart().startsWith("- ")) {
        throw new Error(
          `${where}: unreadable step line ${JSON.stringify(line)}`,
        );
      }
      steps.push([line.replace("- ", "  ")]);
    } else if (steps.length > 0) {
      steps.at(-1).push(line);
    }
  }
  return steps.map((step, i) => entries(step, `${where} step ${i + 1}`));
}

function stepWith(steps, key, value, where) {
  const found = steps.flatMap((step, index) =>
    step.get(key)?.value === value ? [{ step, index }] : [],
  );
  if (found.length !== 1) {
    throw new Error(`${where}: ${found.length} steps with ${key}: ${value}`);
  }
  return found[0];
}

const runLines = (entry) =>
  entry.value === "|"
    ? entry.children.map((line) => line.trim()).filter((line) => line !== "")
    : [entry.value];

function pathsOf(text, event) {
  const on = entries(get(topOf(text), "on", "workflow").children, "on");
  const trigger = entries(get(on, event, "on").children, `on.${event}`);
  return get(trigger, "paths", `on.${event}`)
    .children.filter((line) => !isNoise(line))
    .map((line) => {
      const match = /^\s*- (?:"([^"]*)"|'([^']*)'|(\S.*))$/.exec(line);
      if (!match) throw new Error(`on.${event}.paths: unreadable ${line}`);
      return match[1] ?? match[2] ?? match[3];
    });
}

const gateSteps = (text) => stepsOf(jobOf(text, "gate"), "job gate");

function pinTestIf(text) {
  assert.equal(get(jobOf(text, "test"), "if", "job test").value, TEST_IF);
}

function pinGateOutput(text) {
  const outputs = get(jobOf(text, "gate"), "outputs", "job gate");
  assert.deepEqual(
    [...entries(outputs.children, "outputs")]
      .map(([key, entry]) => [key, entry.value])
      .sort(),
    [...GATE_OUTPUTS].sort(),
  );
}

function pinSetupNode(text) {
  const steps = gateSteps(text);
  const node = stepWith(steps, "id", "node", "job gate");
  const decideStep = stepWith(steps, "id", "decide", "job gate");
  // Only what the fail-open wiring needs; other keys (a timeout) are allowed,
  // since this suite runs in the required guards job.
  assert.equal(get(node.step, "continue-on-error", "setup-node").value, "true");
  // Any non-empty ref: Dependabot bumps the action.
  assert.match(
    get(node.step, "uses", "setup-node").value,
    /^actions\/setup-node@\S+$/,
  );
  const inputs = entries(
    get(node.step, "with", "setup-node").children,
    "setup-node with",
  );
  assert.equal(
    get(inputs, "node-version-file", "setup-node with").value,
    ".node-version",
  );
  // `node-version` would outrank the file as the version source.
  assert.ok(!inputs.has("node-version"), "setup-node node-version");
  assert.ok(node.index < decideStep.index, "setup-node must precede decide");
}

function pinDecide(text) {
  const { step } = stepWith(gateSteps(text), "id", "decide", "job gate");
  assert.equal(get(step, "if", "decide").value, DECIDE_IF);
  assert.equal(get(step, "continue-on-error", "decide").value, "true");
  assert.equal(get(step, "timeout-minutes", "decide").value, DECIDE_TIMEOUT);
  assert.deepEqual(runLines(get(step, "run", "decide")), [DECIDE_RUN]);
  const env = entries(get(step, "env", "decide").children, "decide env");
  assert.deepEqual(
    [...env].map(([key, entry]) => [key, entry.value]).sort(),
    DECIDE_ENV,
  );
}

function pinReport(text) {
  const steps = gateSteps(text);
  const report = stepWith(steps, "name", REPORT_NAME, "job gate");
  const decideStep = stepWith(steps, "id", "decide", "job gate");
  assert.equal(get(report.step, "if", "report").value, REPORT_IF);
  // The annotation must sit in a live line, never a shell comment.
  assert.ok(
    runLines(get(report.step, "run", "report")).some(
      (line) => !line.startsWith("#") && line.includes("::error::"),
    ),
  );
  assert.ok(report.index > decideStep.index, "report must follow decide");
}

function pinPaths(text) {
  for (const event of ["pull_request", "push"]) {
    assert.ok(
      pathsOf(text, event).includes("scripts/check-rust-gate.mjs"),
      `on.${event}.paths lacks the gate script`,
    );
  }
}

function pinTimeouts(text) {
  assert.equal(
    get(jobOf(text, "gate"), "timeout-minutes", "job gate").value,
    "10",
  );
  assert.equal(
    get(jobOf(text, "test"), "timeout-minutes", "job test").value,
    "45",
  );
}

// Controls edit an in-memory copy; the edited text must occur exactly once so
// a control can never pass by matching nothing.
function swap(text, from, to) {
  const at = text.indexOf(from);
  assert.ok(at >= 0 && text.indexOf(from, at + 1) < 0, `once: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}
function swapRe(text, pattern, to) {
  const hits = text.match(new RegExp(pattern.source, "g")) ?? [];
  assert.equal(hits.length, 1, `once: ${pattern}`);
  return text.replace(pattern, () => to);
}
const SETUP_NODE_USES = /uses: actions\/setup-node@\S*/;
const stepText = (text, name) => {
  const start = text.indexOf(`      - name: ${name}\n`);
  const end = text.indexOf("\n\n", start);
  assert.ok(start >= 0 && end > start, `step ${name}`);
  return text.slice(start, end + 2);
};

test("P1 the test job skips only on run=false from a decide that succeeded", () => {
  pinTestIf(WORKFLOW);
  for (const broken of [
    swap(WORKFLOW, TEST_IF, "${{ needs.gate.outputs.run == 'true' }}"),
    swap(WORKFLOW, "!cancelled() && (needs.gate", "(needs.gate"),
    swap(WORKFLOW, TEST_IF, OLD_TEST_IF),
    swap(WORKFLOW, "needs.gate.result != 'success' || ", ""),
    swap(WORKFLOW, "needs.gate.outputs.decided != 'success' || ", ""),
    swap(WORKFLOW, " || needs.gate.outputs.run != 'false'", ""),
    swap(
      WORKFLOW,
      "needs.gate.outputs.decided != 'success' || ",
      "needs.gate.outputs.decided == 'success' && ",
    ),
  ]) {
    assert.throws(() => pinTestIf(broken));
  }
});

test("P2 the gate outputs read the decide step's value and outcome", () => {
  pinGateOutput(WORKFLOW);
  for (const broken of [
    swap(
      WORKFLOW,
      "${{ steps.decide.outputs.run }}",
      "${{ steps.node.outputs.run }}",
    ),
    swap(
      WORKFLOW,
      "      decided: ${{ steps.decide.outcome }}\n",
      "      decided: ${{ steps.decide.conclusion }}\n",
    ),
    swap(WORKFLOW, "      decided: ${{ steps.decide.outcome }}\n", ""),
  ]) {
    assert.throws(() => pinGateOutput(broken));
  }
});

test("P3 setup-node continues on error, ahead of decide, at any ref", () => {
  pinSetupNode(WORKFLOW);
  const node = stepText(WORKFLOW, "Install Node");
  const moved = swap(
    swap(WORKFLOW, node, ""),
    `      - name: ${REPORT_NAME}\n`,
    `${node}      - name: ${REPORT_NAME}\n`,
  );
  for (const broken of [
    swap(
      WORKFLOW,
      "        id: node\n        continue-on-error: true\n",
      "        id: node\n",
    ),
    moved,
    swapRe(WORKFLOW, SETUP_NODE_USES, "uses: actions/setup-node@"),
    swap(
      WORKFLOW,
      "          node-version-file: .node-version\n",
      "          node-version-file: package.json\n",
    ),
    swap(
      WORKFLOW,
      "          node-version-file: .node-version\n",
      "          node-version-file: .node-version\n          node-version: 20\n",
    ),
  ]) {
    assert.throws(() => pinSetupNode(broken));
  }
  pinSetupNode(
    swapRe(WORKFLOW, SETUP_NODE_USES, "uses: actions/setup-node@v8.0.0"),
  );
  // An extra key such as a step timeout keeps the wiring and stays green.
  pinSetupNode(
    swap(
      WORKFLOW,
      "        id: node\n",
      "        id: node\n        timeout-minutes: 1\n",
    ),
  );
});

test("P4 decide runs only the script, after setup-node, continuing on error", () => {
  pinDecide(WORKFLOW);
  const ifLine = `        if: ${DECIDE_IF}\n`;
  for (const broken of [
    swap(WORKFLOW, `${ifLine}        continue-on-error: true\n`, ifLine),
    swap(WORKFLOW, ifLine, ""),
    swap(
      WORKFLOW,
      `        run: ${DECIDE_RUN}\n`,
      `        run: |\n          ${DECIDE_RUN}\n          echo "run=false" >> "$GITHUB_OUTPUT"\n`,
    ),
    swap(WORKFLOW, "          ATTEMPT: ${{ github.run_attempt }}\n", ""),
    swap(
      WORKFLOW,
      "${{ github.event.pull_request.head.sha }}",
      "${{ github.event.pull_request.base.sha }}",
    ),
    swap(
      WORKFLOW,
      "PUSH_SHA: ${{ github.sha }}",
      "PUSH_SHA: ${{ github.ref }}",
    ),
    swap(
      WORKFLOW,
      "EVENT: ${{ github.event_name }}",
      "EVENT: ${{ github.event.action }}",
    ),
    swap(WORKFLOW, "GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ''"),
    swap(WORKFLOW, `        timeout-minutes: ${DECIDE_TIMEOUT}\n`, ""),
    swap(
      WORKFLOW,
      `        timeout-minutes: ${DECIDE_TIMEOUT}\n`,
      "        timeout-minutes: 30\n",
    ),
  ]) {
    assert.throws(() => pinDecide(broken));
  }
});

test("P5 a gate that made no decision reports it", () => {
  pinReport(WORKFLOW);
  for (const broken of [
    swap(WORKFLOW, stepText(WORKFLOW, REPORT_NAME), ""),
    swap(WORKFLOW, REPORT_IF, OLD_REPORT_IF),
    swap(WORKFLOW, " || steps.decide.outputs.run == ''", ""),
    swap(WORKFLOW, "${{ !cancelled() && (steps.decide", "${{ (steps.decide"),
    swap(WORKFLOW, '          echo "::error::', '          # echo "::error::'),
  ]) {
    assert.throws(() => pinReport(broken));
  }
});

test("P6 both path filters trigger on the gate script", () => {
  pinPaths(WORKFLOW);
  const push = WORKFLOW.indexOf("\n  push:\n");
  const broken =
    WORKFLOW.slice(0, push) +
    swap(WORKFLOW.slice(push), '      - "scripts/check-rust-gate.mjs"\n', "");
  assert.throws(() => pinPaths(broken));
});

test("P7 job timeouts: gate 10, test 45", () => {
  pinTimeouts(WORKFLOW);
  const broken = swap(WORKFLOW, "\n    timeout-minutes: 45\n", "\n");
  assert.throws(() => pinTimeouts(broken));
});

test("the P-pin reader throws on a missing or duplicated job, step id or key", () => {
  for (const broken of [
    swap(WORKFLOW, "\n  gate:\n", "\n  gatekeeper:\n"),
    swap(WORKFLOW, "        id: node\n", "        id: decide\n"),
    swap(WORKFLOW, "        id: decide\n", ""),
    swap(
      WORKFLOW,
      "\n    timeout-minutes: 10\n",
      "\n    timeout-minutes: 10\n    timeout-minutes: 10\n",
    ),
  ]) {
    assert.throws(
      () =>
        [
          pinGateOutput,
          pinSetupNode,
          pinDecide,
          pinReport,
          pinTimeouts,
        ].forEach((pin) => pin(broken)),
      /missing key|duplicate key|steps with id/,
    );
  }
});
