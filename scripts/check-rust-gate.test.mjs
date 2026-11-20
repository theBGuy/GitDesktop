// Pins scripts/check-rust-gate.mjs, the rust-tests gate decision. Small shapes
// run on real git in throwaway repos built with one fast-import stream; large
// shapes run on an in-process fake git, so the suite stays a few seconds. CLI
// cases spawn the script with an env built from scratch, since the guards
// step's own env carries GITHUB_OUTPUT. Every test asserts the reason or a log
// line beside `run`, never `run` alone. The P-pins at the end read
// rust-tests.yml itself (and the other apt-script callers) and hold the
// fail-open wiring; each carries in-memory mutations that must turn it red,
// all built before any `assert.throws`, so a mutation whose anchor is gone
// fails the test instead of satisfying the throw.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  APT_PATH,
  DIGEST_LENGTH,
  decide,
  EVIDENCE_FILE,
  GATE_PATH,
  ghArtifacts,
  ghGreenRunIds,
  gitRunner,
  IDENTITY_MEMBERS,
  identityName,
  NAME_PREFIX,
  readIdentity,
  runCli,
  TREE_PATH,
  WORKFLOW_PATH,
  withoutForgeTokens,
} from "./check-rust-gate.mjs";

const SCRIPT = fileURLToPath(new URL("./check-rust-gate.mjs", import.meta.url));
const SHA_A = "a".repeat(40);
const BACKSLASH = String.fromCharCode(92);

const root = mkdtempSync(join(tmpdir(), "gd-rust-gate-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const emptyConfig = join(root, "empty.gitconfig");
writeFileSync(emptyConfig, "");
/** An env holding only what node and git need plus `vars`, so the
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

// A throw here ends the file before any `after` hook runs, so this build
// removes the temp root itself on failure.
const repo = buildOrClean(() =>
  buildRepo("main", [
    {
      name: "base",
      files: {
        [WORKFLOW_PATH]: "name: rust-tests\n",
        [GATE_PATH]: "// gate\n",
        [APT_PATH]: "#!/usr/bin/env bash\n",
        [`${TREE_PATH}/Cargo.toml`]: '[package]\nname = "x"\n',
        [`${TREE_PATH}/src/lib.rs`]: LIB,
      },
    },
    {
      name: "comment",
      from: "base",
      files: { [`${TREE_PATH}/src/lib.rs`]: LIB_COMMENTED },
    },
    {
      name: "code",
      from: "base",
      files: { [`${TREE_PATH}/src/lib.rs`]: LIB_CHANGED },
    },
    { name: "noapt", from: "comment", files: { [APT_PATH]: null } },
  ]),
);
const sha = repo.shas;
const short = (oid) => oid.slice(0, 8);
const realGit = gitRunner(repo.dir, gitEnv);
const failing = { ok: false, stdout: Buffer.alloc(0) };

/** One lookup answer as ghArtifacts returns it. */
const artifactPage = (items) => ({ items });

/** decide() with collected log lines. `greens` (run ids) and `artifacts`
 *  (`{ name, expired, runId }`) back the two gh seams, each call counted in
 *  `gh`, unless a test passes its own seam. */
function run({
  env,
  git: gitFn,
  greens = [],
  artifacts = [],
  listGreens,
  findArtifacts,
}) {
  const lines = [];
  const gh = { calls: 0, names: [] };
  const result = decide({
    env,
    git: gitFn,
    listGreens:
      listGreens ??
      (() => {
        gh.calls++;
        return greens;
      }),
    findArtifacts:
      findArtifacts ??
      ((name) => {
        gh.calls++;
        gh.names.push(name);
        return artifactPage(
          artifacts.filter((item) => item.name === name).slice(0, 100),
        );
      }),
    log: (line) => lines.push(line),
  });
  return { ...result, lines, text: lines.join("\n"), gh };
}

const pushEnv = (head) => ({ ATTEMPT: "1", EVENT: "push", GITHUB_SHA: head });
/** `gitFn` with `rev-parse HEAD` answering `head`, as a checkout of it would. */
const atHead = (gitFn, head) => (args) =>
  args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD"
    ? { ok: true, stdout: Buffer.from(`${head}\n`) }
    : gitFn(args);
const treeOf = (commit) =>
  git(repo.dir, ["rev-parse", `${commit}:${TREE_PATH}`]).trim();
const runIdOf = (i) => String(9000 + i);
/** Evidence that each of `commits` passed: its identity, read on real git, as
 *  the artifact of green run `runIdOf(i)`. */
function evidenceOf(commits) {
  const artifacts = commits.map((commit, i) => {
    const { name } = readIdentity(atHead(realGit, commit), commit);
    assert.ok(name, commit);
    return { name, expired: false, runId: runIdOf(i) };
  });
  return { artifacts, greens: artifacts.map((item) => item.runId) };
}
const onRepo = (head, passed, extra = {}) =>
  run({
    env: pushEnv(head),
    git: atHead(realGit, head),
    ...evidenceOf(passed),
    ...extra,
  });

// ---------------------------------------------------------------- fake git

let serial = 0;
const nextOid = () => (++serial).toString(16).padStart(40, "0");

/** A test-side model answering rev-parse and `cat-file -t` from maps,
 *  recording every call, beside an evidence store. `evidence(tree, opts)`
 *  records an artifact naming `tree` under the head's blobs (or `opts`
 *  overrides) from a new run, green unless `green: false`, and returns its
 *  run id. */
function fakeRepo() {
  const refs = new Map();
  const blobs = new Map();
  const trees = new Set();
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
    return failing;
  };
  const head = nextOid();
  const tree = nextOid();
  const wf = nextOid();
  const gate = nextOid();
  const apt = nextOid();
  trees.add(tree);
  refs.set("HEAD", head);
  refs.set(`${head}:${TREE_PATH}`, tree);
  refs.set(`${head}:${WORKFLOW_PATH}`, wf);
  refs.set(`${head}:${GATE_PATH}`, gate);
  refs.set(`${head}:${APT_PATH}`, apt);
  const blobsOf = ({ wf: w = wf, gate: g = gate, apt: a = apt } = {}) => ({
    [WORKFLOW_PATH]: w,
    [GATE_PATH]: g,
    [APT_PATH]: a,
  });
  const greens = [];
  const artifacts = [];
  let runs = 0;
  const evidence = (t, { green = true, expired = false, ...over } = {}) => {
    const runId = String(++runs);
    if (green) greens.push(runId);
    const name = identityName({ tree: t, blobs: blobsOf(over) });
    artifacts.push({ name, expired, runId });
    return runId;
  };
  return {
    git: gitFn,
    refs,
    blobs,
    trees,
    calls,
    head,
    tree,
    wf,
    gate,
    apt,
    blobsOf,
    name: identityName({ tree, blobs: blobsOf() }),
    greens,
    artifacts,
    evidence,
    env: pushEnv(head),
  };
}

const onFake = (fake, extra = {}) =>
  run({
    env: fake.env,
    git: fake.git,
    greens: fake.greens,
    artifacts: fake.artifacts,
    ...extra,
  });
const NO_IDENTITY = "no src-tauri tree or identity blob at this commit";
const NO_EVIDENCE = "no prior green run for this exact content";

// ---------------------------------------------------------------- identity

const SIGNATURE_KEYS = [
  [TREE_PATH, "tree"],
  [WORKFLOW_PATH, "wf"],
  [GATE_PATH, "gate"],
  [APT_PATH, "apt"],
];

test("identityName: every member and the tree move the name; the order is fixed", () => {
  const blobs = Object.fromEntries(
    IDENTITY_MEMBERS.map((path, i) => [path, String(i + 1).repeat(40)]),
  );
  const tree = "c".repeat(40);
  const base = identityName({ tree, blobs });
  const lines = IDENTITY_MEMBERS.map((path) => `${path} ${blobs[path]}\n`);
  const digest = createHash("sha256")
    .update(lines.join(""))
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
  assert.equal(base, `${NAME_PREFIX}${digest}-${tree}`);
  assert.deepEqual(IDENTITY_MEMBERS, [WORKFLOW_PATH, GATE_PATH, APT_PATH]);
  const names = new Set([base, identityName({ tree: "d".repeat(40), blobs })]);
  for (const path of IDENTITY_MEMBERS) {
    names.add(
      identityName({ tree, blobs: { ...blobs, [path]: "f".repeat(40) } }),
    );
  }
  assert.equal(names.size, IDENTITY_MEMBERS.length + 2);
  // Two members trading oids is another identity: position is in the digest.
  const traded = {
    ...blobs,
    [WORKFLOW_PATH]: blobs[GATE_PATH],
    [GATE_PATH]: blobs[WORKFLOW_PATH],
  };
  assert.notEqual(identityName({ tree, blobs: traded }), base);
  const sha256 = identityName({ tree: "e".repeat(64), blobs });
  assert.equal(base.length, 70);
  assert.equal(sha256.length, 94);
  // The characters upload-artifact refuses in a name.
  const refused = ['"', ":", "<", ">", "|", "*", "?", "\r", "\n", BACKSLASH];
  refused.push("/");
  for (const name of [base, sha256]) {
    assert.match(name, /^[a-z0-9-]+$/);
    assert.ok(
      refused.every((c) => !name.includes(c)),
      name,
    );
  }
});

test("an invalid GITHUB_SHA is no identity and reads nothing, on both events (fake git)", () => {
  for (const event of ["push", "pull_request"]) {
    for (const sha of [
      undefined,
      "",
      "not-hex",
      "-x",
      "a".repeat(39),
      "A".repeat(40),
    ]) {
      const fake = fakeRepo();
      fake.evidence(fake.tree);
      const env = { ...fake.env, EVENT: event, GITHUB_SHA: sha };
      if (sha === undefined) delete env.GITHUB_SHA;
      const out = onFake(fake, { env });
      const where = `${event} ${JSON.stringify(sha)}`;
      assert.equal(out.run, true, where);
      assert.equal(out.reason, "invalid checkout SHA", where);
      assert.equal(out.identity, "", where);
      assert.deepEqual(out.lines, [
        "rust-gate: no identity (invalid checkout SHA)",
        "rust-gate: decision run=true (invalid checkout SHA)",
      ]);
      assert.equal(fake.calls.length, 0, where);
      assert.equal(out.gh.calls, 0, where);
    }
  }
});

test("an unresolvable HEAD or one other than GITHUB_SHA is no identity, on both events (fake git)", () => {
  for (const event of ["push", "pull_request"]) {
    const other = nextOid();
    for (const [head, reasonOf] of [
      [null, () => "could not resolve HEAD"],
      ["not-an-oid", () => "could not resolve HEAD"],
      ["A".repeat(40), () => "could not resolve HEAD"],
      [
        other,
        (fake) => `HEAD ${short(other)} is not GITHUB_SHA ${short(fake.head)}`,
      ],
    ]) {
      const fake = fakeRepo();
      fake.evidence(fake.tree);
      if (head === null) fake.refs.delete("HEAD");
      else fake.refs.set("HEAD", head);
      const reason = reasonOf(fake);
      const out = onFake(fake, { env: { ...fake.env, EVENT: event } });
      assert.equal(out.run, true, reason);
      assert.equal(out.reason, reason);
      assert.equal(out.identity, "");
      assert.deepEqual(out.lines, [
        `rust-gate: no identity (${reason})`,
        `rust-gate: decision run=true (${reason})`,
      ]);
      assert.deepEqual(fake.calls, [["rev-parse", "HEAD"]]);
      assert.equal(out.gh.calls, 0);
    }
  }
});

test("an identity needs the src-tauri tree and all three blobs (fake git)", () => {
  for (const [path, key] of SIGNATURE_KEYS) {
    const fake = fakeRepo();
    fake.refs.delete(`${fake.head}:${path}`);
    fake.evidence(fake.tree);
    const out = onFake(fake);
    assert.equal(out.run, true, path);
    assert.equal(out.reason, NO_IDENTITY, path);
    assert.equal(out.identity, "", path);
    assert.deepEqual(
      out.lines[0].split(" ").filter((word) => word.endsWith("=?")),
      [`${key}=?`],
    );
    assert.equal(out.lines[1], `rust-gate: no identity (${NO_IDENTITY})`);
    assert.equal(out.gh.calls, 0, path);
  }
  // A src-tauri blob, even one a recorded twin shares byte for byte.
  const fake = fakeRepo();
  fake.trees.delete(fake.tree);
  fake.blobs.set(fake.tree, Buffer.from("src-tauri-link"));
  fake.evidence(fake.tree);
  const out = onFake(fake);
  assert.equal(out.run, true);
  assert.equal(out.reason, NO_IDENTITY);
  assert.match(out.lines[0], / tree=\? wf=/);
  assert.equal(out.gh.calls, 0);
});

test("a non-hex rev-parse answer is no identity (fake git)", () => {
  for (const answer of ["not-an-oid\n", `${"A".repeat(40)}\n`, "\n"]) {
    const fake = fakeRepo();
    fake.evidence(fake.tree);
    const gitFn = (args) =>
      args[0] === "rev-parse" && args[1].endsWith(`:${TREE_PATH}`)
        ? { ok: true, stdout: Buffer.from(answer) }
        : fake.git(args);
    const out = onFake(fake, { git: gitFn });
    assert.equal(out.run, true, JSON.stringify(answer));
    assert.equal(out.reason, NO_IDENTITY);
    assert.match(out.lines[0], / tree=\? wf=/);
    assert.equal(out.gh.calls, 0);
  }
});

test("the signature and identity lines name the checkout, on both events (fake git)", () => {
  for (const event of ["push", "pull_request"]) {
    const fake = fakeRepo();
    const out = onFake(fake, { env: { ...fake.env, EVENT: event } });
    assert.deepEqual(out.lines.slice(0, 2), [
      `rust-gate: signature ${short(fake.head)} tree=${fake.tree} wf=${fake.wf} gate=${fake.gate} apt=${fake.apt}`,
      `rust-gate: identity ${fake.name} (checkout ${short(fake.head)})`,
    ]);
    assert.equal(out.identity, fake.name);
    assert.equal(out.reason, NO_EVIDENCE);
  }
});

test("a re-run reads and returns the identity, then runs with no gh call (fake git)", () => {
  for (const attempt of ["2", "", undefined]) {
    const fake = fakeRepo();
    fake.evidence(fake.tree);
    const env = { ...fake.env, ATTEMPT: attempt };
    if (attempt === undefined) delete env.ATTEMPT;
    const out = onFake(fake, { env });
    assert.equal(out.run, true);
    assert.equal(out.reason, "explicit re-run");
    assert.equal(out.identity, fake.name);
    assert.deepEqual(out.lines.slice(1), [
      `rust-gate: identity ${fake.name} (checkout ${short(fake.head)})`,
      `rust-gate: run_attempt=${attempt ?? ""} is a re-run; running the matrix.`,
      "rust-gate: decision run=true (explicit re-run)",
    ]);
    assert.equal(out.gh.calls, 0);
  }
});

test("an unknown or missing event runs the matrix with no gh call (fake git)", () => {
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
    fake.evidence(fake.tree);
    const env = { ...fake.env, EVENT: event };
    if (event === undefined) delete env.EVENT;
    const out = onFake(fake, { env });
    const reason = `unknown event ${JSON.stringify(event ?? "")}`;
    assert.ok(!reason.includes("\n"));
    assert.equal(out.run, true, String(event));
    assert.equal(out.reason, reason);
    assert.equal(out.identity, fake.name);
    assert.deepEqual(out.lines.slice(2), [
      `rust-gate: decision run=true (${reason})`,
    ]);
    assert.equal(out.gh.calls, 0);
  }
});

// ------------------------------------------------------------ green run ids

test("no green run reads no artifact and runs the matrix (fake git)", () => {
  const fake = fakeRepo();
  fake.evidence(fake.tree, { green: false });
  const out = onFake(fake);
  assert.equal(out.run, true);
  assert.equal(out.reason, NO_EVIDENCE);
  assert.deepEqual(out.lines.slice(2), [
    "rust-gate: listed 0 green runs (0 malformed dropped)",
    "rust-gate: no green runs; no evidence to read.",
    `rust-gate: decision run=true (${NO_EVIDENCE})`,
  ]);
  assert.equal(out.gh.calls, 1);
  assert.deepEqual(out.gh.names, []);
});

test("a green list that fails or is no array is treated as empty (fake git)", () => {
  for (const [listGreens, why] of [
    [
      () => {
        throw new Error("HTTP 502\nbad gateway");
      },
      "HTTP 502 bad gateway",
    ],
    [() => "1\n2", "the list is not an array"],
  ]) {
    const fake = fakeRepo();
    fake.evidence(fake.tree);
    const out = onFake(fake, { listGreens });
    assert.equal(out.run, true, why);
    assert.equal(out.reason, NO_EVIDENCE);
    assert.ok(
      out.lines.includes(
        `rust-gate: could not list green runs (${why}); treating the list as empty.`,
      ),
      out.text,
    );
    assert.ok(
      out.lines.includes("rust-gate: no green runs; no evidence to read."),
    );
    assert.equal(out.gh.calls, 0);
  }
});

test("malformed and duplicate green run ids are dropped and counted (fake git)", () => {
  const fake = fakeRepo();
  const runId = fake.evidence(fake.tree);
  const malformed = ["0", "-1", "1e3", "abc", "9007199254740993", "", "01", 7];
  const out = onFake(fake, { greens: [...malformed, runId, runId] });
  assert.equal(out.run, false, out.text);
  assert.equal(out.reason, `identical content passed in run ${runId}`);
  assert.ok(
    out.lines.includes(
      `rust-gate: listed 1 green runs (${malformed.length} malformed dropped)`,
    ),
    out.text,
  );
  assert.ok(
    out.lines.includes("rust-gate: dropped 1 duplicate green run ids."),
  );
  // Only malformed ids: nothing listed, so no artifact is read.
  const none = fakeRepo();
  none.evidence(none.tree);
  const empty = onFake(none, { greens: malformed });
  assert.equal(empty.run, true);
  assert.ok(
    empty.lines.includes("rust-gate: no green runs; no evidence to read."),
  );
  assert.deepEqual(empty.gh.names, []);
});

// ------------------------------------------------------- the exact lookup

test("an exact green unexpired match skips (fake git)", () => {
  const fake = fakeRepo();
  const runId = fake.evidence(fake.tree);
  const out = onFake(fake);
  assert.equal(out.run, false);
  assert.equal(out.reason, `identical content passed in run ${runId}`);
  assert.equal(out.identity, fake.name);
  assert.deepEqual(out.lines.slice(2), [
    "rust-gate: listed 1 green runs (0 malformed dropped)",
    `rust-gate: 1 artifacts named ${fake.name}, 1 from green runs.`,
    `rust-gate: decision run=false (identical content passed in run ${runId})`,
  ]);
  assert.deepEqual(out.gh.names, [fake.name]);
  assert.equal(out.gh.calls, 2);
});

test("a match from a green run listed 100th skips (fake git)", () => {
  const fake = fakeRepo();
  const runId = fake.evidence(fake.tree);
  const greens = Array.from({ length: 99 }, (_, i) => String(5000 + i));
  const out = onFake(fake, { greens: [...greens, runId] });
  assert.equal(out.run, false);
  assert.equal(out.reason, `identical content passed in run ${runId}`);
  assert.ok(
    out.lines.includes(
      "rust-gate: listed 100 green runs (0 malformed dropped)",
    ),
  );
});

test("a non-green run or an expired artifact does not skip (fake git)", () => {
  const fake = fakeRepo();
  fake.evidence(fake.tree, { green: false });
  fake.evidence(fake.tree, { expired: true });
  const out = onFake(fake);
  assert.equal(out.run, true);
  assert.equal(out.reason, NO_EVIDENCE);
  assert.deepEqual(out.lines.slice(-2), [
    `rust-gate: 2 artifacts named ${fake.name}, 0 from green runs.`,
    `rust-gate: decision run=true (${NO_EVIDENCE})`,
  ]);
});

test("the lookup's answer is re-checked: only the exact name counts (fake git)", () => {
  const fake = fakeRepo();
  const runId = fake.evidence(fake.tree);
  const otherTree = identityName({ tree: nextOid(), blobs: fake.blobsOf() });
  const otherDigest = identityName({
    tree: fake.tree,
    blobs: fake.blobsOf({ gate: nextOid() }),
  });
  const names = [
    fake.name.toUpperCase(),
    `${fake.name}x`,
    ` ${fake.name}`,
    otherTree,
    otherDigest,
  ];
  const out = onFake(fake, {
    findArtifacts: () =>
      artifactPage(names.map((name) => ({ name, expired: false, runId }))),
  });
  assert.equal(out.run, true, out.text);
  assert.equal(out.reason, NO_EVIDENCE);
  assert.ok(
    out.lines.includes(
      `rust-gate: 0 artifacts named ${fake.name}, 0 from green runs.`,
    ),
    out.text,
  );
});

test("another member blob or another tree is another identity (fake git)", () => {
  for (const over of [
    { wf: nextOid() },
    { gate: nextOid() },
    { apt: nextOid() },
    { tree: nextOid() },
  ]) {
    const fake = fakeRepo();
    const { tree = fake.tree, ...blobs } = over;
    fake.evidence(tree, blobs);
    const out = onFake(fake);
    const where = Object.keys(over)[0];
    assert.equal(out.run, true, where);
    assert.equal(out.reason, NO_EVIDENCE, where);
    assert.ok(
      out.lines.includes(
        `rust-gate: 0 artifacts named ${fake.name}, 0 from green runs.`,
      ),
      where,
    );
  }
});

test("a failed or malformed lookup runs the matrix (fake git)", () => {
  for (const [findArtifacts, why] of [
    [
      () => {
        throw new Error("HTTP 500\noops");
      },
      "HTTP 500 oops",
    ],
    [() => ({ items: "x" }), "no artifact list"],
    [() => ({ items: null }), "no artifact list"],
    [() => ({}), "no artifact list"],
    [() => [], "no artifact list"],
    [() => null, "no artifact list"],
    [() => "x", "no artifact list"],
  ]) {
    const fake = fakeRepo();
    fake.evidence(fake.tree);
    const out = onFake(fake, { findArtifacts });
    assert.equal(out.run, true, why);
    assert.equal(out.reason, "artifact lookup failed", why);
    assert.equal(out.identity, fake.name, why);
    assert.deepEqual(out.lines.slice(-2), [
      `rust-gate: could not look up the artifact (${why}); running the matrix.`,
      "rust-gate: decision run=true (artifact lookup failed)",
    ]);
  }
});

// ------------------------------------------------------------------ gh seams

test("ghGreenRunIds asks gh for this workflow's successful run ids", () => {
  const env = { GH_TOKEN: "t", GH_REPO: "o/r" };
  const seen = [];
  const spawn = (cmd, args, options) => {
    seen.push({ cmd, args, options });
    return { status: 0, stdout: "123\n\n  456  \n", stderr: "" };
  };
  assert.deepEqual(ghGreenRunIds(env, spawn), ["123", "456"]);
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
    "databaseId",
    "--jq",
    ".[].databaseId",
  ]);
  // gh alone keeps the token, untouched.
  assert.equal(seen[0].options.env, env);
  assert.equal(seen[0].options.timeout, 120_000);

  const failed = () => ({ status: 1, stdout: "", stderr: "HTTP 502\nbad" });
  assert.throws(
    () => ghGreenRunIds(env, failed),
    /^Error: gh exited 1: HTTP 502 bad$/,
  );
});

test("ghArtifacts asks gh api for one page and keeps only well-formed items", () => {
  const env = { GH_TOKEN: "t", GH_REPO: "o/r" };
  const good = { name: "n", expired: false, workflow_run: { id: 42 } };
  const malformed = [
    { expired: false, workflow_run: { id: 1 } },
    { name: 5, expired: false, workflow_run: { id: 1 } },
    { name: "n", expired: "false", workflow_run: { id: 1 } },
    { name: "n", workflow_run: { id: 1 } },
    { name: "n", expired: false, workflow_run: null },
    { name: "n", expired: false },
    { name: "n", expired: false, workflow_run: { id: 0 } },
    { name: "n", expired: false, workflow_run: { id: -3 } },
    { name: "n", expired: false, workflow_run: { id: 1.5 } },
    { name: "n", expired: false, workflow_run: { id: 2 ** 53 } },
    { name: "n", expired: false, workflow_run: { id: "7" } },
    null,
  ];
  const seen = [];
  const answering = (body) => (cmd, args, options) => {
    seen.push({ cmd, args, options });
    return { status: 0, stdout: body, stderr: "" };
  };
  const body = JSON.stringify({
    total_count: 13,
    artifacts: [good, ...malformed],
  });
  assert.deepEqual(ghArtifacts("name=n&per_page=100", env, answering(body)), {
    items: [{ name: "n", expired: false, runId: "42" }],
  });
  assert.equal(seen[0].cmd, "gh");
  assert.deepEqual(seen[0].args, [
    "api",
    "repos/{owner}/{repo}/actions/artifacts?name=n&per_page=100",
  ]);
  assert.equal(seen[0].options.env, env);
  assert.equal(seen[0].options.timeout, 30_000);

  for (const [stdout, message] of [
    ["not json", /^Error: unparseable artifacts answer$/],
    ["null", /^Error: the artifacts answer holds no list$/],
    ["{}", /^Error: the artifacts answer holds no list$/],
    ['{"artifacts":{"0":{}}}', /^Error: the artifacts answer holds no list$/],
  ]) {
    assert.throws(() => ghArtifacts("q", env, answering(stdout)), message);
  }
  const failed = () => ({ status: 1, stdout: "", stderr: "HTTP 502\nbad" });
  assert.throws(
    () => ghArtifacts("q", env, failed),
    /^Error: gh exited 1: HTTP 502 bad$/,
  );
  const timedOut = new Error("spawnSync gh ETIMEDOUT");
  assert.throws(
    () => ghArtifacts("q", env, () => ({ error: timedOut })),
    (error) => error === timedOut,
  );
});

// ---------------------------------------------------------------- real git

test("a real checkout's identity signs its tree and the three blobs (real git)", () => {
  const identity = readIdentity(atHead(realGit, sha.comment), sha.comment);
  assert.equal(identity.tree, treeOf(sha.comment));
  for (const path of IDENTITY_MEMBERS) {
    assert.equal(
      identity.blobs[path],
      git(repo.dir, ["rev-parse", `${sha.comment}:${path}`]).trim(),
      path,
    );
  }
  assert.equal(identity.name, identityName(identity));
  assert.equal(identity.sha, sha.comment);
  // The fixture's checkout is the base branch, which is not this commit.
  assert.deepEqual(readIdentity(realGit, sha.comment), {
    missing: `HEAD ${short(sha.base)} is not GITHUB_SHA ${short(sha.comment)}`,
  });
});

test("identical content skips on real git", () => {
  const out = onRepo(sha.base, [sha.base]);
  assert.equal(out.run, false);
  assert.equal(out.reason, `identical content passed in run ${runIdOf(0)}`);
  assert.equal(out.identity, evidenceOf([sha.base]).artifacts[0].name);
  assert.ok(
    out.lines.includes("rust-gate: listed 1 green runs (0 malformed dropped)"),
  );
});

// Source-reading `include_str!` tests see comments, so a comment-only edit is
// a new identity like any other.
test("comment-only and code .rs changes both run the matrix (real git)", () => {
  for (const head of [sha.comment, sha.code]) {
    const out = onRepo(head, [sha.base]);
    assert.equal(out.run, true, head);
    assert.equal(out.reason, NO_EVIDENCE, head);
    assert.notEqual(out.identity, evidenceOf([sha.base]).artifacts[0].name);
    assert.ok(
      out.lines.includes(
        `rust-gate: 0 artifacts named ${out.identity}, 0 from green runs.`,
      ),
      out.text,
    );
  }
});

test("a head without the apt script has no identity (real git)", () => {
  const out = onRepo(sha.noapt, [sha.base]);
  assert.equal(out.run, true);
  assert.equal(out.reason, NO_IDENTITY);
  assert.match(out.lines[0], / gate=[0-9a-f]{40} apt=\?$/);
  assert.equal(out.gh.calls, 0);
});

test("an unresolved workflow blob is no identity on either side (real git)", () => {
  const noWorkflow = (args) =>
    args[0] === "rev-parse" && args[1].endsWith(`:${WORKFLOW_PATH}`)
      ? failing
      : realGit(args);
  const out = onRepo(sha.comment, [sha.base], {
    git: atHead(noWorkflow, sha.comment),
  });
  assert.equal(out.run, true);
  assert.equal(out.reason, NO_IDENTITY);
  assert.match(out.lines[0], / wf=\? /);
  assert.equal(out.gh.calls, 0);

  // A holed name never matches a holed checkout: with the workflow blob absent
  // on both sides, decide reads no identity and asks gh nothing.
  const past = readIdentity(atHead(noWorkflow, sha.base), sha.base);
  assert.equal(past.missing, NO_IDENTITY);
  assert.equal(past.blobs[WORKFLOW_PATH], "");
  const holed = identityName({ tree: treeOf(sha.base), blobs: past.blobs });
  const fed = run({
    env: pushEnv(sha.comment),
    git: atHead(noWorkflow, sha.comment),
    greens: ["1"],
    artifacts: [{ name: holed, expired: false, runId: "1" }],
  });
  assert.equal(fed.run, true);
  assert.equal(fed.reason, NO_IDENTITY);
  assert.equal(fed.gh.calls, 0);
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
    GITHUB_SHA: SHA_A,
    GITHUB_OUTPUT: output,
    GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  assert.equal(out.code, 0, out.output);
  assert.equal(readFileSync(output, "utf8"), "run=true\n");
  assert.ok(
    out.output.includes("decision run=true (could not resolve HEAD)"),
    out.output,
  );
});

test("the CLI without GITHUB_OUTPUT writes nothing and exits 1", () => {
  const dir = mkdtempSync(join(root, "cli-c-"));
  const out = cli(dir, {
    ATTEMPT: "1",
    EVENT: "push",
    GITHUB_SHA: SHA_A,
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
    const temp = mkdtempSync(join(root, "crash-temp-"));
    const lines = [];
    const code = runCli({
      env: { ...pushEnv(SHA_A), GITHUB_OUTPUT: output, RUNNER_TEMP: temp },
      argv: [],
      deps: {
        git: () => {
          throw thrown;
        },
        listGreens: () => [],
        log: (line) => lines.push(line),
      },
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.deepEqual(readdirSync(temp), []);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("::error::")),
      [
        "::error::rust-gate: git exploded - no decision written; the matrix runs (fail-open)",
      ],
    );
  }
});

test("git children get no forge token; the token list is exact", () => {
  const env = {
    PATH: "/bin",
    GH_TOKEN: "t1",
    GITHUB_TOKEN: "t2",
    GH_REPO: "o/r",
    gh_host: "h",
    github_token: "t3",
    GITHUB_ENTERPRISE_TOKEN: "t4",
    github_enterprise_token: "t5",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_ENTERPRISE_TOKENS: "kept",
    GITHUB_TOKEN_X: "kept",
    GHOST: "kept",
  };
  const kept = {
    PATH: "/bin",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_ENTERPRISE_TOKENS: "kept",
    GITHUB_TOKEN_X: "kept",
    GHOST: "kept",
  };
  assert.deepEqual(withoutForgeTokens(env), kept);
  const seen = [];
  const spawn = (cmd, args, options) => {
    seen.push([cmd, options.env]);
    return { status: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  gitRunner(root, env, spawn)(["rev-parse", "HEAD"]);
  assert.deepEqual(seen, [["git", kept]]);
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

/** runCli deps over a fake repo and its evidence store. */
const fakeDeps = (fake, lines) => ({
  git: fake.git,
  listGreens: () => fake.greens,
  findArtifacts: (name) =>
    artifactPage(fake.artifacts.filter((item) => item.name === name)),
  log: (line) => lines.push(line),
});

test("runCli writes the evidence file, then identity and run, after an exact match", () => {
  const fake = fakeRepo();
  const runId = fake.evidence(fake.tree);
  const dir = mkdtempSync(join(root, "skip-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const lines = [];
  const code = runCli({
    env: { ...fake.env, GITHUB_OUTPUT: output, RUNNER_TEMP: dir },
    argv: [],
    deps: fakeDeps(fake, lines),
  });
  assert.equal(code, 0);
  assert.equal(
    readFileSync(output, "utf8"),
    `identity=${fake.name}\nrun=false\n`,
  );
  assert.equal(
    readFileSync(join(dir, EVIDENCE_FILE), "utf8"),
    `${fake.name}\n${fake.head}\n`,
  );
  assert.equal(
    lines.at(-1),
    `rust-gate: decision run=false (identical content passed in run ${runId})`,
  );
});

test("runCli records no identity without RUNNER_TEMP or a writable evidence dir", () => {
  const dir = mkdtempSync(join(root, "norec-"));
  const blocker = join(dir, "a-file");
  writeFileSync(blocker, "");
  const unset = "rust-gate: RUNNER_TEMP is not set; identity not recorded.";
  const cases = [
    [undefined, (line) => line === unset],
    ["", (line) => line === unset],
    [
      blocker,
      (line) =>
        /^rust-gate: could not write the identity file \(.+\); identity not recorded\.$/.test(
          line,
        ),
    ],
  ];
  cases.forEach(([temp, logged], i) => {
    const fake = fakeRepo();
    fake.evidence(fake.tree);
    const output = join(dir, `output-${i}`);
    writeFileSync(output, "");
    const lines = [];
    const env = { ...fake.env, GITHUB_OUTPUT: output, RUNNER_TEMP: temp };
    if (temp === undefined) delete env.RUNNER_TEMP;
    const code = runCli({ env, argv: [], deps: fakeDeps(fake, lines) });
    assert.equal(code, 0, String(temp));
    assert.equal(readFileSync(output, "utf8"), "run=false\n");
    assert.equal(lines.filter(logged).length, 1, lines.join("\n"));
  });
  assert.equal(readFileSync(blocker, "utf8"), "");
});

// --- P-pins: the workflow's fail-open wiring. They check this repository's
// own workflows and apt script as written (block-mapping steps, plain or
// simply quoted scalars, one `set` command per `;`/`&&`/`||`/`|` segment) as
// drift pins, not a YAML or shell parser: a missing or duplicated job, step id
// or key, or a shape outside that subset, fails loudly, and the remedy is the
// house spelling.

const readRepoText = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
const WORKFLOW = readRepoText(WORKFLOW_PATH);
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
// The env scripts/check-rust-gate.mjs reads (gh reads the GH_ pair), by value;
// the checkout comes from the runner's own GITHUB_SHA, which no key may shadow.
const DECIDE_ENV = [
  ["ATTEMPT", "${{ github.run_attempt }}"],
  ["EVENT", "${{ github.event_name }}"],
  ["GH_REPO", "${{ github.repository }}"],
  ["GH_TOKEN", "${{ github.token }}"],
];
const RECORD_NAME = "Record the tested checkout's identity";
const RECORD_IF = "${{ !cancelled() && steps.decide.outputs.identity != '' }}";
const RECORD_WITH = [
  ["if-no-files-found", "error"],
  ["name", "${{ steps.decide.outputs.identity }}"],
  ["overwrite", "true"],
  ["path", `\${{ runner.temp }}/${EVIDENCE_FILE}`],
  ["retention-days", "14"],
];
const REPORT_RUN =
  'echo "::error::rust-tests gate made no decision (setup-node: $NODE, decide: $DECIDE); the test matrix runs (fail-open)."';
// What the gate signs: a change to any of these must trigger the workflow.
const IDENTITY_PATHS = ["src-tauri/**", WORKFLOW_PATH, GATE_PATH, APT_PATH];
const APT_NAME = "Install Linux dependencies";
const APT_RUN = `bash ${APT_PATH}`;
const APT_CALLERS = [
  [WORKFLOW_PATH, "test"],
  [".github/workflows/release.yml", "release"],
  [".github/workflows/appimage-check.yml", "appimage"],
];
const APT_SCRIPT = readRepoText(APT_PATH);

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

/** `on.<event>.paths` items as written after `- `, quotes and any trailing
 *  comment included. */
function rawPathsOf(text, event) {
  const on = entries(get(topOf(text), "on", "workflow").children, "on");
  const trigger = entries(get(on, event, "on").children, `on.${event}`);
  return get(trigger, "paths", `on.${event}`)
    .children.filter((line) => !isNoise(line))
    .map((line) => {
      const match = /^\s*- (\S.*)$/.exec(line);
      if (!match) throw new Error(`on.${event}.paths: unreadable ${line}`);
      return match[1];
    });
}

/** A plain or simply quoted scalar's value: a comment after a space or TAB
 *  outside the quotes dropped (YAML keeps any other blank in the value), `''`
 *  read as one quote, and a backslash in a double-quoted one (an escape)
 *  refused. Anything else comes back as written. */
function scalarOf(raw, where) {
  assert.ok(
    !(raw.startsWith('"') && raw.includes(BACKSLASH)),
    `${where}: escaped scalar ${raw}`,
  );
  const match = /^(?:"([^"]*)"|'((?:[^']|'')*)'|(.*?))(?:[ \t]+#.*)?$/.exec(
    raw,
  );
  return match[1] ?? match[2]?.replace(/''/g, "'") ?? match[3];
}

/** The items decoded as scalars. */
const pathsOf = (text, event) =>
  rawPathsOf(text, event).map((item) => scalarOf(item, `on.${event}.paths`));

/** A step's `uses:` value, decoded; "" when it has none. */
const usesOf = (step, where) => scalarOf(step.get("uses")?.value ?? "", where);

/** With no exclusion in a list, a literal item is matched as written, so no
 *  glob engine is needed. The raw text is read because a backslash in a
 *  double-quoted item is a YAML escape that may decode to `!`. */
function refuseExclusions(items, where) {
  for (const item of items) {
    assert.ok(!/^["']?!/.test(item), `${where}: exclusion ${item}`);
    assert.ok(
      !(item.startsWith('"') && item.includes(BACKSLASH)),
      `${where}: escaped item ${item}`,
    );
  }
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
    scalarOf(get(node.step, "uses", "setup-node").value, "setup-node"),
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
  assert.equal(get(report.step, "shell", "report").value, "bash");
  // The annotation is the whole run: no comment hides it, no line exits first.
  assert.deepEqual(runLines(get(report.step, "run", "report")), [REPORT_RUN]);
  assert.ok(report.index > decideStep.index, "report must follow decide");
}

/** The upload runs only after a decision that named an identity, can never
 *  fail the gate job, and uploads exactly the evidence file under that name. */
function pinRecord(text) {
  const steps = gateSteps(text);
  const record = stepWith(steps, "name", RECORD_NAME, "job gate");
  const decideStep = stepWith(steps, "id", "decide", "job gate");
  const report = stepWith(steps, "name", REPORT_NAME, "job gate");
  assert.ok(record.index > decideStep.index, "record must follow decide");
  assert.ok(record.index < report.index, "record must precede the report");
  assert.equal(get(record.step, "if", "record").value, RECORD_IF);
  assert.equal(get(record.step, "continue-on-error", "record").value, "true");
  // Decide's 8 plus this 1 leave checkout and setup-node room in the job's 10.
  assert.equal(get(record.step, "timeout-minutes", "record").value, "1");
  // Any non-empty ref: Dependabot bumps the action.
  assert.match(
    scalarOf(get(record.step, "uses", "record").value, "record"),
    /^actions\/upload-artifact@\S+$/,
  );
  const inputs = entries(
    get(record.step, "with", "record").children,
    "record with",
  );
  assert.deepEqual(
    [...inputs].map(([key, entry]) => [key, entry.value]).sort(),
    RECORD_WITH,
  );
}

/** The gate signs the commit the matrix tests only while both jobs check out
 *  the default commit into the default path. */
function pinCheckouts(text) {
  for (const job of ["gate", "test"]) {
    const where = `job ${job}`;
    // GitHub resolves the action's owner/repo case-insensitively, so every
    // spelling counts and any second checkout step is refused.
    const checkouts = stepsOf(jobOf(text, job), where).filter((step) =>
      /^actions\/checkout@/i.test(usesOf(step, where)),
    );
    assert.equal(checkouts.length, 1, `${where}: checkout steps`);
    const inputs = checkouts[0].has("with")
      ? entries(get(checkouts[0], "with", where).children, `${where} with`)
      : new Map();
    // The runner exports `with:` keys case-insensitively, as INPUT_<NAME>.
    const names = new Set([...inputs.keys()].map((key) => key.toLowerCase()));
    for (const key of ["ref", "repository", "path"]) {
      assert.ok(!names.has(key), `${where}: checkout ${key}`);
    }
  }
}

function pinPaths(text) {
  for (const event of ["pull_request", "push"]) {
    const where = `on.${event}.paths`;
    refuseExclusions(rawPathsOf(text, event), where);
    const paths = pathsOf(text, event);
    for (const path of IDENTITY_PATHS) {
      assert.ok(paths.includes(path), `${where} lacks ${path}`);
    }
  }
}

/** The apt step of `job`: once, 10 min, the shared script ahead of the update,
 *  no inline copy of the rewrite, and the checkout that provides the script
 *  ahead of it. */
function pinApt(text, job) {
  const where = `job ${job}`;
  const steps = stepsOf(jobOf(text, job), where);
  const apt = stepWith(steps, "name", APT_NAME, where);
  assert.equal(get(apt.step, "timeout-minutes", APT_NAME).value, "10");
  const lines = runLines(get(apt.step, "run", APT_NAME));
  assert.deepEqual(
    lines.filter((line) => !line.startsWith("#")).slice(0, 2),
    [APT_RUN, "sudo apt-get update"],
    where,
  );
  assert.ok(
    lines.every((line) => !line.includes("ec2")),
    `${where}: inline mirror rewrite`,
  );
  const checkout = steps.findIndex((step) =>
    /^actions\/checkout@/i.test(usesOf(step, where)),
  );
  assert.ok(
    checkout >= 0 && checkout < apt.index,
    `${where}: no checkout first`,
  );
}

/** appimage-check's own filter must fire on an apt-script edit. */
function pinAptPaths(text) {
  const where = "on.pull_request.paths";
  refuseExclusions(rawPathsOf(text, "pull_request"), where);
  assert.ok(pathsOf(text, "pull_request").includes(APT_PATH), where);
}

/** The rewrite is best-effort: the script always falls through to its end, so
 *  the caller's apt-get runs whatever the mirror files hold. */
function pinAptScript(text) {
  const lines = text.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env bash", "shebang");
  for (const line of lines) {
    if (line.trimStart().startsWith("#")) continue;
    for (const command of commandsOf(line)) {
      const on = setOptionsOn(command);
      assert.ok(!on.has("e") && !on.has("errexit"), `errexit: ${line}`);
      assert.ok(!on.has("pipefail"), `pipefail: ${line}`);
    }
    assert.ok(!/\bexit\s+[1-9]/.test(line), `failing exit: ${line}`);
  }
}

/** A line's commands: split at `;`, `&&`, `||` and `|` outside quotes, up to
 *  a `#` that starts a word outside quotes. */
function commandsOf(line) {
  const commands = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && /(?:^|\s)$/.test(current)) {
      break;
    } else if (c === ";" || c === "|" || (c === "&" && line[i + 1] === "&")) {
      commands.push(current);
      current = "";
      if (c !== ";" && line[i + 1] === c) i++;
      continue;
    }
    current += c;
  }
  commands.push(current);
  return commands;
}

/** The options a `set` command turns on: each letter of a `-` group, and the
 *  name after a group holding `o`; a `+` group turns its options off. */
function setOptionsOn(command) {
  const [first, ...words] = command.trim().split(/\s+/);
  const on = new Set();
  if (first !== "set") return on;
  for (let i = 0; i < words.length; i++) {
    const group = /^([-+])([A-Za-z]+)$/.exec(words[i]);
    if (!group) continue;
    const named = group[2].includes("o") ? words[++i] : undefined;
    if (group[1] === "+") continue;
    for (const letter of group[2]) on.add(letter);
    if (named !== undefined) on.add(named);
  }
  return on;
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
/** `text` with `edit` applied to job `name`'s block alone. */
function inJob(text, name, edit) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const next = text.slice(start + 1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  const end = next < 0 ? text.length : start + 1 + next;
  return text.slice(0, start) + edit(text.slice(start, end)) + text.slice(end);
}
/** The one checkout step line of a job's block, whatever its spelling or ref. */
function checkoutOf(body) {
  const hits = body.match(/^ {6}- uses: actions\/checkout@\S+\n/gim) ?? [];
  assert.equal(hits.length, 1, "one checkout line");
  return hits[0];
}
/** `text` with every checkout ref rewritten to `ref`, as a Dependabot bump;
 *  each action name keeps its spelling. */
function withCheckoutRef(text, ref) {
  const pattern = /(actions\/checkout@)\S+/gi;
  assert.ok((text.match(pattern) ?? []).length > 0, "a checkout ref");
  return text.replace(pattern, (_, name) => `${name}${ref}`);
}
/** `text` with every checkout spelled `Actions/Checkout`, which GitHub
 *  resolves to the same action. */
function respelledAll(text) {
  const pattern = /actions\/checkout@/gi;
  assert.ok((text.match(pattern) ?? []).length > 0, "a checkout to respell");
  return text.replace(pattern, () => "Actions/Checkout@");
}
/** `text` with job `job`'s checkout value wrapped in `quote`. */
const quotedCheckout = (text, job, quote) =>
  inJob(text, job, (body) => {
    const checkout = checkoutOf(body);
    const value = checkout.trim().slice("- uses: ".length);
    return swap(body, checkout, `      - uses: ${quote}${value}${quote}\n`);
  });
/** A validator for an error whose first message line is exactly `message`. */
const firstLine = (message) => (error) =>
  error.message.split("\n")[0] === message;
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
      "          ATTEMPT: ${{ github.run_attempt }}\n",
      "          ATTEMPT: ${{ github.run_attempt }}\n          PR_HEAD: ${{ github.event.pull_request.head.sha }}\n",
    ),
    swap(
      WORKFLOW,
      "          ATTEMPT: ${{ github.run_attempt }}\n",
      "          ATTEMPT: ${{ github.run_attempt }}\n          GITHUB_SHA: ${{ github.event.pull_request.head.sha }}\n",
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
    swap(
      WORKFLOW,
      '          echo "::error::',
      '          exit 0\n          echo "::error::',
    ),
  ]) {
    assert.throws(() => pinReport(broken));
  }
});

test("P6 both path filters list every identity member and no exclusion", () => {
  pinPaths(WORKFLOW);
  // Each entry occurs once per event, so controls edit one event's half.
  const push = WORKFLOW.indexOf("\n  push:\n") + 1;
  const pr = WORKFLOW.slice(0, push);
  const rest = WORKFLOW.slice(push);
  const gateLine = '      - "scripts/check-rust-gate.mjs"\n';
  const afterGate = (added) => swap(pr, gateLine, gateLine + added) + rest;
  for (const broken of [
    pr + swap(rest, gateLine, ""),
    pr + swap(rest, `      - "${APT_PATH}"\n`, ""),
    swap(pr, '      - "src-tauri/**"\n', "") + rest,
    afterGate('      - "!scripts/check-rust-gate.mjs"\n'),
    afterGate("      - '!scripts/check-rust-gate.mjs'\n"),
    afterGate('      - "!scripts/check-rust-gate.mjs" # why\n'),
    afterGate(`      - "${BACKSLASH}x21scripts/check-rust-gate.mjs"\n`),
  ]) {
    assert.throws(() => pinPaths(broken));
  }
  // A trailing comment outside the quotes is no part of the item.
  const workflowLine = `      - "${WORKFLOW_PATH}"\n`;
  const commented = (half) =>
    swap(
      half,
      workflowLine,
      `      - "${WORKFLOW_PATH}" # matrix definition\n`,
    );
  pinPaths(commented(pr) + commented(rest));
  pinPaths(
    swap(pr, '      - "src-tauri/**"\n', "      - src-tauri/** # x\n") + rest,
  );
  pinPaths(
    swap(pr, '      - "src-tauri/**"\n', "      - src-tauri/**\t# x\n") + rest,
  );
  // YAML ends a plain scalar only at a space or TAB before `#`; after any
  // other blank the comment stays in the pattern.
  const nbsp = String.fromCharCode(0xa0);
  const glued = swap(
    pr,
    '      - "src-tauri/**"\n',
    `      - src-tauri/**${nbsp}# backend\n`,
  );
  assert.throws(
    () => pinPaths(glued + rest),
    firstLine("on.pull_request.paths lacks src-tauri/**"),
  );
});

test("P7 job timeouts: gate 10, test 45", () => {
  pinTimeouts(WORKFLOW);
  const broken = swap(WORKFLOW, "\n    timeout-minutes: 45\n", "\n");
  assert.throws(() => pinTimeouts(broken));
});

/** `text` with job `job`'s checkout spelled `Actions/Checkout`, which GitHub
 *  resolves to the same action. */
const respelled = (text, job) =>
  inJob(text, job, (body) => {
    const checkout = checkoutOf(body);
    const other = checkout.replace(/actions\/checkout@/i, "Actions/Checkout@");
    return swap(body, checkout, other);
  });

/** P8's controls over `read(path)`, each `[text, job, message]`; the moved
 *  step finds its own job's checkout line, so a bumped ref keeps it live. */
function aptControls(read) {
  return APT_CALLERS.flatMap(([path, job]) => {
    const text = read(path);
    const step = stepText(text, APT_NAME);
    const moved = inJob(text, job, (body) => {
      const checkout = checkoutOf(body);
      return swap(swap(body, step, ""), checkout, step + checkout);
    });
    return [
      [
        swap(
          text,
          `          ${APT_RUN}\n          sudo apt-get update\n`,
          `          sudo apt-get update\n          ${APT_RUN}\n`,
        ),
        job,
        `job ${job}`,
      ],
      [swap(text, `          ${APT_RUN}\n`, ""), job, `job ${job}`],
      [
        swap(text, step, swap(step, "        timeout-minutes: 10\n", "")),
        job,
        `${APT_NAME}: missing key timeout-minutes`,
      ],
      [moved, job, `job ${job}: no checkout first`],
      [respelled(moved, job), job, `job ${job}: no checkout first`],
    ];
  });
}

test("P8 every apt step runs the shared mirror script after checkout", () => {
  const bumped = (path) => withCheckoutRef(readRepoText(path), "v99");
  const respelledRead = (path) => respelledAll(readRepoText(path));
  const respelledBumped = (path) => withCheckoutRef(respelledRead(path), "v99");
  const reads = [readRepoText, bumped, respelledRead, respelledBumped];
  for (const [path, job] of APT_CALLERS) {
    for (const read of reads) pinApt(read(path), job);
    assert.ok(!bumped(path).includes("actions/checkout@v7"), path);
    assert.ok(respelledBumped(path).includes("Actions/Checkout@v99"), path);
    // A respelled or quoted checkout ahead of the apt step still provides it.
    pinApt(respelled(readRepoText(path), job), job);
    pinApt(quotedCheckout(readRepoText(path), job, "'"), job);
    pinApt(quotedCheckout(readRepoText(path), job, '"'), job);
  }
  // A bumped or respelled checkout keeps every control throwing for its own
  // reason.
  for (const read of reads) {
    for (const [broken, job, message] of aptControls(read)) {
      assert.throws(() => pinApt(broken, job), firstLine(message));
    }
  }

  const appimage = readRepoText(".github/workflows/appimage-check.yml");
  pinAptPaths(appimage);
  const lastLine = '      - "pnpm-lock.yaml"\n';
  for (const broken of [
    swap(appimage, lastLine, `${lastLine}      - "!${APT_PATH}"\n`),
    swap(appimage, lastLine, `${lastLine}      - "!${APT_PATH}" # why\n`),
    swap(appimage, `      - "${APT_PATH}"\n`, ""),
  ]) {
    assert.throws(() => pinAptPaths(broken));
  }
});

test("P8b the apt script never stops early: no errexit, no failing exit", () => {
  pinAptScript(APT_SCRIPT);
  const added = (line, message) => [
    swap(APT_SCRIPT, "set -u\n", `set -u\n${line}\n`),
    message,
  ];
  // Turning an option off, or naming it in a comment, keeps the script going.
  const allowed = [
    "set +o errexit",
    "set +e",
    "set +o pipefail",
    "# pipefail is deliberately disabled",
    "# errexit stays off: set -e would stop the rewrite early",
    "set -u # not -e",
    // Only a command whose first word is `set` sets options.
    `set -u; printf '%s${BACKSLASH}n' -e`,
    'echo "a; set -e"',
    "echo '-e && set -e'",
  ].map((line) => swap(APT_SCRIPT, "set -u\n", `set -u\n${line}\n`));
  for (const text of allowed) pinAptScript(text);
  const controls = [
    ...[
      "set -e",
      "set -Ee",
      "set -u -e",
      "set -euo pipefail",
      "set -o errexit",
      "set -o pipefail -o errexit",
      "echo ready; set -e",
      "true && set -e",
      "false || set -o errexit",
      "echo x | set -e",
    ].map((line) => added(line, `errexit: ${line}`)),
    added("set -o pipefail", "pipefail: set -o pipefail"),
    added("exit 1", "failing exit: exit 1"),
    [swap(APT_SCRIPT, "#!/usr/bin/env bash\n", "#!/bin/sh\n"), "shebang"],
  ];
  for (const [broken, message] of controls) {
    assert.throws(() => pinAptScript(broken), firstLine(message));
  }
});

test("P9 the gate records its identity after deciding, never gating the decision", () => {
  pinRecord(WORKFLOW);
  const record = stepText(WORKFLOW, RECORD_NAME);
  const withoutRecord = swap(WORKFLOW, record, "");
  const decideHead = "      - name: Decide whether the matrix must run\n";
  const recordIf = `        if: ${RECORD_IF}\n`;
  for (const broken of [
    swap(WORKFLOW, `${recordIf}        continue-on-error: true\n`, recordIf),
    swap(
      WORKFLOW,
      "          overwrite: true\n",
      "          overwrite: false\n",
    ),
    swap(
      WORKFLOW,
      "name: ${{ steps.decide.outputs.identity }}",
      "name: ${{ steps.decide.outputs.run }}",
    ),
    swap(WORKFLOW, `/${EVIDENCE_FILE}\n`, "/rust-gate-evidence/other.txt\n"),
    swap(withoutRecord, decideHead, record + decideHead),
    swap(
      WORKFLOW,
      "${{ !cancelled() && steps.decide.outputs.identity",
      "${{ steps.decide.outputs.identity",
    ),
    swap(
      WORKFLOW,
      "          retention-days: 14\n",
      "          retention-days: 14\n          archive: false\n",
    ),
    swap(
      WORKFLOW,
      "          retention-days: 14\n",
      "          retention-days: 90\n",
    ),
    swap(
      WORKFLOW,
      "        timeout-minutes: 1\n",
      "        timeout-minutes: 2\n",
    ),
    swap(
      withoutRecord,
      "\n\n  test:\n",
      `\n\n${record.trimEnd()}\n\n  test:\n`,
    ),
    withoutRecord,
  ]) {
    assert.throws(() => pinRecord(broken));
  }
  pinRecord(
    swapRe(
      WORKFLOW,
      /uses: actions\/upload-artifact@\S*/,
      "uses: actions/upload-artifact@v8.0.0",
    ),
  );
});

/** P10's controls over `text`, each `[text, message]`, keyed on each job's own
 *  checkout line, so a bumped ref keeps them live. */
function checkoutControls(text) {
  const add = (job, input) =>
    inJob(text, job, (body) => {
      const head = `${checkoutOf(body)}        with:\n`;
      return swap(body, head, `${head}          ${input}\n`);
    });
  const extra = (job, uses = "Actions/Checkout@v7") =>
    inJob(text, job, (body) => {
      const checkout = checkoutOf(body);
      const step = `      - uses: ${uses}\n        with:\n          ref: master\n\n`;
      return swap(body, checkout, step + checkout);
    });
  return [
    [
      add("test", "ref: ${{ github.event.pull_request.head.sha }}"),
      "job test: checkout ref",
    ],
    [add("test", "repository: other/repo"), "job test: checkout repository"],
    [add("gate", "path: src"), "job gate: checkout path"],
    [add("gate", "ref: main"), "job gate: checkout ref"],
    // Mixed-case keys reach the action under the same input name.
    [add("test", "Ref: master"), "job test: checkout ref"],
    [add("gate", "Ref: master"), "job gate: checkout ref"],
    [add("test", "REPOSITORY: other/repo"), "job test: checkout repository"],
    [add("gate", "Path: src"), "job gate: checkout path"],
    // GitHub resolves the action's owner/repo case-insensitively too.
    [extra("test"), "job test: checkout steps"],
    [extra("gate"), "job gate: checkout steps"],
    // A quoted scalar names the same action.
    [extra("test", "'actions/checkout@v7'"), "job test: checkout steps"],
    [extra("test", '"actions/checkout@v7"'), "job test: checkout steps"],
    [extra("gate", "'actions/checkout@v7'"), "job gate: checkout steps"],
  ];
}

test("P10 both jobs test the same checkout", () => {
  const bumped = withCheckoutRef(WORKFLOW, "v99");
  const respelledText = respelledAll(WORKFLOW);
  const respelledBumped = withCheckoutRef(respelledText, "v99");
  const texts = [WORKFLOW, bumped, respelledText, respelledBumped];
  for (const text of texts) pinCheckouts(text);
  assert.ok(!bumped.includes("actions/checkout@v7"));
  assert.ok(respelledBumped.includes("Actions/Checkout@v99"));
  // A single quoted checkout per job is the same checkout.
  pinCheckouts(
    quotedCheckout(quotedCheckout(WORKFLOW, "test", "'"), "gate", '"'),
  );
  // A bumped or respelled checkout keeps every control throwing for its own
  // reason.
  for (const text of texts) {
    for (const [broken, message] of checkoutControls(text)) {
      assert.throws(() => pinCheckouts(broken), firstLine(message));
    }
  }
});

test("the P-pin reader throws on a missing or duplicated job, step id or key", () => {
  const pins = {
    pinGateOutput,
    pinSetupNode,
    pinDecide,
    pinReport,
    pinRecord,
    pinCheckouts,
    pinTestIf,
    pinTimeouts,
    pinAptTest: (text) => pinApt(text, "test"),
  };
  const gateJob = [
    "pinGateOutput",
    "pinSetupNode",
    "pinDecide",
    "pinReport",
    "pinRecord",
    "pinCheckouts",
    "pinTimeouts",
  ];
  const gateIds = ["pinSetupNode", "pinDecide", "pinReport", "pinRecord"];
  const testJob = ["pinCheckouts", "pinTestIf", "pinTimeouts", "pinAptTest"];
  const twice = (line) => `${line}${line.slice(1)}`;
  const controls = [
    [
      swap(WORKFLOW, "\n  gate:\n", "\n  gatekeeper:\n"),
      gateJob,
      /: missing key gate$/,
    ],
    [
      swap(WORKFLOW, "        id: node\n", "        id: decide\n"),
      gateIds,
      /: [02] steps with id: (node|decide)$/,
    ],
    [
      swap(WORKFLOW, "        id: decide\n", ""),
      gateIds,
      /: 0 steps with id: decide$/,
    ],
    [
      swap(
        WORKFLOW,
        "\n    timeout-minutes: 10\n",
        twice("\n    timeout-minutes: 10\n"),
      ),
      gateJob,
      /job gate: duplicate key timeout-minutes$/,
    ],
    [
      inJob(WORKFLOW, "test", (body) =>
        swap(
          body,
          "\n    timeout-minutes: 45\n",
          twice("\n    timeout-minutes: 45\n"),
        ),
      ),
      testJob,
      /job test: duplicate key timeout-minutes$/,
    ],
  ];
  // One assertion per pin: a chain inside one throw passes on its first pin.
  for (const [broken, names, pattern] of controls) {
    for (const name of names) {
      assert.throws(() => pins[name](broken), pattern, name);
    }
  }
});
