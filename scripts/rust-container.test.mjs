// Contract tests for scripts/rust-container.mjs, the container test loop.
//
// Port discipline: every listener binds port 0 on 127.0.0.1, so no test ever
// touches either lock's default port (R18 scans this file for them). Every
// file a test writes lives under one mkdtemp dir; the Linux-only shell cases
// run their scripts only against directories they created, and the refusal
// cases only in delta mode, whose precondition refuses before any write.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, sidecarPath } from "./full-suite.mjs";
import {
  APT_PACKAGES,
  absentPaths,
  buildDockerfile,
  buildSyncArchive,
  CACHE_LEAF,
  CARGO_SCRIPT,
  containerPortFromEnv,
  DEFAULT_CONTAINER_PORT,
  DOCKERFILE,
  defaultCacheDir,
  fileHash,
  imageName,
  listWorktree,
  main,
  missingChanged,
  nativeHolder,
  nativeLockSummary,
  nativeStartLine,
  needsLf,
  normalizeWorktreePath,
  parseEolListing,
  parseModeListing,
  planSync,
  probePort,
  readTree,
  rustVersionFromEnv,
  rustVersionFromRustc,
  STUB_DIST,
  SYNC_SCRIPT,
  sha256hex,
  spawnDocker,
  syncManifest,
  tarBuffer,
  toLf,
  VERIFY_PL,
  validTreePath,
  volumeNames,
  worktreeKey,
} from "./rust-container.mjs";

const root = mkdtempSync(join(tmpdir(), "gd-rust-container-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirCount = 0;
function fresh(name) {
  const dir = join(root, `${name}-${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const linuxOnly = (needs) =>
  process.platform === "linux"
    ? false
    : `needs ${needs}; runs on Linux (CI's guards job)`;
const SYNC_ONLY = linuxOnly("bash, GNU tar, flock and perl");
const CARGO_ONLY = linuxOnly("bash, flock and perl");
const PERL_ONLY = linuxOnly("perl with Digest::SHA");
const BASH_ONLY = linuxOnly("bash for a fake docker");
const UNIX_ONLY = linuxOnly("POSIX file modes");

// ---------------------------------------------------------------- R1 tar

const TAR =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

function extract(archive) {
  const dir = fresh("untar");
  const result = spawnSync(TAR, ["-x", "-f", "-"], {
    cwd: dir,
    input: archive,
  });
  return { dir, status: result.status, stderr: String(result.stderr) };
}

function assertRoundTrip(entries) {
  const { dir, status, stderr } = extract(tarBuffer(entries));
  assert.equal(status, 0, stderr);
  for (const { name, data } of entries) {
    const got = readFileSync(join(dir, ...name.split("/")));
    assert.ok(got.equals(data), `bytes differ for ${name}`);
  }
}

const PAX_ASCII = [
  `q/${"M".repeat(150)}`,
  `${"a".repeat(120)}/${"b".repeat(120)}/${"c".repeat(99)}`,
];
const SPLIT_ASCII = `${"p".repeat(90)}/${"n".repeat(89)}`;

test("R1 tarBuffer round-trips ASCII names and raw bytes through the platform tar", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello\n") },
    { name: `d/${"x".repeat(98)}`, data: Buffer.from("exactly 100 bytes\n") },
    { name: SPLIT_ASCII, data: Buffer.from("split\n") },
    ...PAX_ASCII.map((name) => ({
      name,
      data: Buffer.from(`pax ${name.length}\n`),
    })),
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "bin/raw.dat", data: Buffer.from([0, 13, 10, 13, 0, 255, 10, 13]) },
  ];
  assert.equal(Buffer.byteLength(entries[1].name), 100);
  assert.equal(Buffer.byteLength(SPLIT_ASCII), 180);
  assertRoundTrip(entries);
});

test("R1 tarBuffer picks plain, prefix-split and pax headers by byte length", () => {
  const plain = tarBuffer([
    { name: `d/${"x".repeat(98)}`, data: Buffer.alloc(0) },
  ]);
  assert.equal(plain[156], "0".charCodeAt(0));
  assert.equal(plain[345], 0);
  const split = tarBuffer([{ name: SPLIT_ASCII, data: Buffer.alloc(0) }]);
  assert.equal(split.subarray(345, 345 + 90).toString(), "p".repeat(90));
  assert.equal(split.subarray(0, 89).toString(), "n".repeat(89));
  for (const name of PAX_ASCII) {
    const archive = tarBuffer([{ name, data: Buffer.alloc(0) }]);
    assert.equal(archive[156], "x".charCodeAt(0), name);
    const record = `${name.length + 7 + String(name.length + 10).length} path=${name}\n`;
    assert.equal(
      archive.subarray(512, 512 + Buffer.byteLength(record)).toString(),
      record,
    );
    assert.equal(Number.parseInt(record, 10), Buffer.byteLength(record));
  }
  const header = plain.subarray(0, 512);
  const stored = Number.parseInt(header.subarray(148, 154).toString(), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  assert.equal(stored, sum);
  assert.equal(header.subarray(154, 156).toString("latin1"), "\0 ");
  assert.equal(plain.length, 512 * 3);
  assert.equal(header.subarray(100, 108).toString("latin1"), "0000644\0");
  const exec = tarBuffer([
    { name: "run.sh", data: Buffer.alloc(0), mode: 0o755 },
  ]);
  assert.equal(exec.subarray(100, 108).toString("latin1"), "0000755\0");
});

test("R1 tarBuffer refuses names outside a relative tree, allowing the control dir", () => {
  for (const name of [
    "",
    "/abs",
    "a//b",
    "../x",
    "a/./b",
    "a\\b",
    "a\0b",
    "a/",
  ]) {
    assert.throws(
      () => tarBuffer([{ name, data: Buffer.alloc(0) }]),
      /invalid archive member/,
      name,
    );
  }
  assert.doesNotThrow(() =>
    tarBuffer([{ name: ".gd-rust-container/end", data: Buffer.alloc(0) }]),
  );
});

test("R1 tarBuffer round-trips UTF-8 names (byte lengths, pax and prefix split)", {
  skip:
    process.platform === "win32"
      ? "System32 bsdtar decodes ustar names in the OEM code page; runs on Linux (CI's guards job)"
      : false,
}, () => {
  const paxName = `d/${"é".repeat(60)}`;
  const splitName = `${"é".repeat(50)}/${"日".repeat(30)}`;
  assert.equal(paxName.length, 62);
  assert.equal(Buffer.byteLength(paxName), 122);
  assert.equal(
    tarBuffer([{ name: paxName, data: Buffer.alloc(0) }])[156],
    "x".charCodeAt(0),
  );
  assert.equal(
    tarBuffer([{ name: splitName, data: Buffer.alloc(0) }])[156],
    "0".charCodeAt(0),
  );
  assertRoundTrip([
    { name: "é.txt", data: Buffer.from("e\n") },
    { name: "日本/x.txt", data: Buffer.from("x\n") },
    { name: paxName, data: Buffer.from("pax\n") },
    { name: splitName, data: Buffer.from("split\n") },
  ]);
});

test("R1 control: a flipped byte in the first header makes the real tar fail", () => {
  const archive = tarBuffer([{ name: "a.txt", data: Buffer.from("a\n") }]);
  assert.equal(extract(archive).status, 0);
  const broken = Buffer.from(archive);
  broken[0] ^= 0x01;
  assert.notEqual(extract(broken).status, 0);
});

// ------------------------------------------------------- R2/R3 line endings

const INDEXES = ["lf", "crlf", "mixed", "none", "-text", ""];
const AUTOCRLFS = ["true", "input", "false", null];
// Each attribute set with the arm it must take (convert.c, first match wins).
const ATTR_ARMS = [
  [["-text"], "raw"],
  [["binary"], "raw"],
  [["-crlf"], "raw"],
  [["text", "eol=crlf"], "raw"],
  [["text=auto", "eol=crlf"], "raw"],
  [["text"], "text"],
  [["text", "eol=lf"], "text"],
  [["eol=lf"], "text"],
  [["text=auto"], "auto"],
  [["text=auto", "eol=lf"], "auto"],
  [[], "config"],
];

test("R2 needsLf truth table over every arm, index, worktree and autocrlf", () => {
  for (const [attrs, arm] of ATTR_ARMS) {
    for (const autocrlf of AUTOCRLFS) {
      for (const index of INDEXES) {
        for (const worktree of INDEXES) {
          const autoRule =
            !["crlf", "mixed"].includes(index) && worktree !== "-text";
          const want = {
            raw: false,
            text: !["crlf", "mixed"].includes(index),
            auto: autoRule,
            config: (autocrlf === "true" || autocrlf === "input") && autoRule,
          }[arm];
          assert.equal(
            needsLf({ index, worktree, attrs }, autocrlf),
            want,
            JSON.stringify({ index, worktree, attrs, autocrlf }),
          );
        }
      }
    }
  }
  // An explicit `text` file git classifies -text still converts.
  assert.equal(
    needsLf({ index: "-text", worktree: "-text", attrs: ["text"] }, "true"),
    true,
  );
  assert.equal(needsLf({ index: "", worktree: "crlf", attrs: [] }), false);
  assert.equal(
    needsLf({ index: "", worktree: "crlf", attrs: [] }, "true"),
    true,
  );
});

test("R3 toLf drops only the CR of each CRLF", () => {
  const cases = [
    ["a\r\nb\r\n", "a\nb\n"],
    ["a\rb", "a\rb"],
    ["a\r", "a\r"],
    ["a\r\n\rb\n\r\r\n", "a\n\rb\n\r\n"],
    ["", ""],
    ["no newline", "no newline"],
  ];
  for (const [input, want] of cases) {
    assert.equal(
      toLf(Buffer.from(input)).toString("latin1"),
      want,
      JSON.stringify(input),
    );
  }
});

// ------------------------------------------------------------ R4 listing

function listing(records) {
  return Buffer.from(records.map((record) => `${record}\0`).join(""));
}

test("R4 parseEolListing reads the probed record shapes", () => {
  const rows = parseEolListing(
    listing([
      "i/lf    w/crlf  attr/                 \tcrlf.txt",
      "i/      w/crlf  attr/text eol=crlf    \ts.ps1",
      "i/      w/crlf  attr/text eol=crlf\ts2.ps1",
      "i/-text w/-text attr/                 \tbin.dat",
      "i/      w/crlf  attr/-text            \tz.b",
      "i/lf    w/      attr/                 \tgone.txt",
      "i/      w/      attr/                 \tnested/",
      "i/lf    w/lf    attr/                 \ta b/c d.txt",
      "i/lf    w/lf    attr/                 \ttab\there.txt",
      "i/lf    w/lf    attr/                 \t日本/é.txt",
      "i/crlf  w/crlf  attr/                 \tcrlf.txt",
    ]),
  );
  assert.deepEqual(rows, [
    { path: "crlf.txt", index: "lf", worktree: "crlf", attrs: [] },
    { path: "s.ps1", index: "", worktree: "crlf", attrs: ["text", "eol=crlf"] },
    {
      path: "s2.ps1",
      index: "",
      worktree: "crlf",
      attrs: ["text", "eol=crlf"],
    },
    { path: "bin.dat", index: "-text", worktree: "-text", attrs: [] },
    { path: "z.b", index: "", worktree: "crlf", attrs: ["-text"] },
    { path: "gone.txt", index: "lf", worktree: "", attrs: [] },
    { path: "nested/", index: "", worktree: "", attrs: [] },
    { path: "a b/c d.txt", index: "lf", worktree: "lf", attrs: [] },
    { path: "tab\there.txt", index: "lf", worktree: "lf", attrs: [] },
    { path: "日本/é.txt", index: "lf", worktree: "lf", attrs: [] },
  ]);
  assert.deepEqual(parseEolListing(Buffer.alloc(0)), []);
  assert.throws(() => parseEolListing(listing(["no tab here"])), /unreadable/);
  assert.throws(
    () => parseEolListing(listing(["x/lf w/lf attr/\tp"])),
    /unreadable/,
  );
});

/** NUL-terminated records of an ASCII head, a tab and raw path bytes. */
function byteListing(head, paths) {
  return Buffer.concat(
    paths.map((bytes) =>
      Buffer.concat([
        Buffer.from(`${head}\t`),
        Buffer.from(bytes),
        Buffer.from([0]),
      ]),
    ),
  );
}

const EOL_HEAD = "i/lf    w/lf    attr/                 ";
const MODE_HEAD = `100644 ${"e".repeat(40)} 0`;
const REPLACEMENT = String.fromCharCode(0xfffd);

test("R4 a listed path that is not UTF-8 is skipped by hex, never merged", () => {
  const paths = [
    [0x61, 0xff, 0x2e, 0x72, 0x73],
    [0x61, 0xfe, 0x2e, 0x72, 0x73],
    [0x61, 0xef, 0xbf, 0xbd, 0x2e, 0x72, 0x73],
  ];
  const sink = new Set();
  const rows = parseEolListing(byteListing(EOL_HEAD, paths), sink);
  assert.deepEqual(
    rows.map((r) => r.path),
    [`a${REPLACEMENT}.rs`],
  );
  assert.deepEqual([...sink], ["61ff2e7273", "61fe2e7273"]);
  const modeSink = new Set();
  const modes = parseModeListing(byteListing(MODE_HEAD, paths), modeSink);
  assert.deepEqual([...modes.keys()], [`a${REPLACEMENT}.rs`]);
  assert.deepEqual([...modeSink], ["61ff2e7273", "61fe2e7273"]);
});

test("R4 BOM-prefixed and literal U+FFFD names parse unchanged", () => {
  const sink = new Set();
  const rows = parseEolListing(
    byteListing(EOL_HEAD, [
      [0xef, 0xbb, 0xbf, 0x66, 0x2e, 0x72, 0x73],
      [0x66, 0x2e, 0x72, 0x73],
    ]),
    sink,
  );
  assert.deepEqual(
    rows.map((r) => r.path),
    [`${String.fromCharCode(0xfeff)}f.rs`, "f.rs"],
  );
  assert.equal(sink.size, 0);
});

// Machine-wide and per-user git state (autocrlf, hooks, the default excludes
// and attributes files under HOME/XDG) and any inherited GIT_* variable must
// not reach the fixture.
const gitHome = fresh("git-home");
const emptyFile = join(gitHome, "empty");
writeFileSync(emptyFile, "");
const fixtureConfig = join(gitHome, "fixture.gitconfig");
writeFileSync(
  fixtureConfig,
  `[core]\n\texcludesFile = ${emptyFile.replaceAll("\\", "/")}\n\tattributesFile = ${emptyFile.replaceAll("\\", "/")}\n`,
);
function gitEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("GIT_")) env[name] = value;
  }
  return {
    ...env,
    HOME: gitHome,
    USERPROFILE: gitHome,
    XDG_CONFIG_HOME: gitHome,
    GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: fixtureConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    env: gitEnv(),
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

test("R4 real git: listing, needsLf decisions and row handling", () => {
  const repo = fresh("repo");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "crlf.txt"), "a\r\nb\r\n");
  writeFileSync(join(repo, "lf.txt"), "a\nb\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 13, 10, 13]));
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  git(repo, ["config", "core.autocrlf", "true"]);
  writeFileSync(
    join(repo, ".gitattributes"),
    "*.ps1 text eol=crlf\n*.raw -text\n*.t text\n",
  );
  writeFileSync(join(repo, "s.ps1"), "x\r\ny\r\n");
  writeFileSync(join(repo, "z.raw"), "r\r\n");
  writeFileSync(join(repo, "x.t"), "a\r\nb\rc\r\n");
  writeFileSync(join(repo, "u.txt"), "u\r\nv\r\n");
  unlinkSync(join(repo, "gone.txt"));
  const nested = join(repo, "nested");
  mkdirSync(nested);
  git(nested, ["init", "-b", "main"]);
  writeFileSync(join(nested, "inner.txt"), "inner\n");

  const rows = parseEolListing(
    git(repo, ["ls-files", "-z", "-co", "--exclude-standard", "--eol"]),
  );
  const byPath = new Map(rows.map((row) => [row.path, row]));
  assert.deepEqual([...byPath.keys()].sort(), [
    ".gitattributes",
    "bin.dat",
    "crlf.txt",
    "gone.txt",
    "lf.txt",
    "nested/",
    "s.ps1",
    "u.txt",
    "x.t",
    "z.raw",
  ]);
  assert.equal(byPath.get("crlf.txt").index, "crlf");
  assert.equal(byPath.get("x.t").worktree, "-text");
  assert.deepEqual(byPath.get("x.t").attrs, ["text"]);
  assert.equal(byPath.get("lf.txt").index, "lf");
  assert.equal(byPath.get("bin.dat").index, "-text");
  assert.equal(byPath.get("gone.txt").worktree, "");
  assert.equal(byPath.get("u.txt").index, "");
  assert.equal(byPath.get("u.txt").worktree, "crlf");
  assert.ok(byPath.get("s.ps1").attrs.includes("eol=crlf"));
  assert.ok(byPath.get("z.raw").attrs.includes("-text"));
  const decisions = Object.fromEntries(
    ["crlf.txt", "lf.txt", "bin.dat", "s.ps1", "z.raw", "u.txt", "x.t"].map(
      (p) => [p, needsLf(byPath.get(p), "true")],
    ),
  );
  assert.deepEqual(decisions, {
    "crlf.txt": false,
    "lf.txt": true,
    "bin.dat": false,
    "s.ps1": false,
    "z.raw": false,
    "u.txt": true,
    "x.t": true,
  });

  const tree = readTree(repo, rows, undefined, { autocrlf: "true" });
  // What git stores for an explicit-text file holding a lone CR.
  assert.equal(tree.files.get("x.t").data.toString("latin1"), "a\nb\rc\n");
  git(repo, ["add", "x.t"]);
  assert.equal(
    git(repo, ["cat-file", "-p", ":x.t"]).toString("latin1"),
    "a\nb\rc\n",
  );
  git(repo, ["config", "core.autocrlf", "false"]);
  const unset = parseEolListing(
    git(repo, ["ls-files", "-z", "-co", "--exclude-standard", "--eol"]),
  ).find((r) => r.path === "u.txt");
  assert.equal(needsLf(unset, "false"), false);
  assert.equal(
    readTree(repo, [unset], undefined, { autocrlf: "false" })
      .files.get("u.txt")
      .data.toString("latin1"),
    "u\r\nv\r\n",
  );
  assert.deepEqual(tree.skipped, ["nested/"]);
  assert.deepEqual(tree.missing, ["gone.txt"]);
  const text = (path) => tree.files.get(path).data.toString("latin1");
  assert.equal(text("crlf.txt"), "a\r\nb\r\n");
  assert.equal(text("lf.txt"), "a\nb\n");
  assert.equal(text("u.txt"), "u\nv\n");
  assert.equal(text("s.ps1"), "x\r\ny\r\n");
  assert.equal(text("z.raw"), "r\r\n");
  assert.ok(
    tree.files.get("bin.dat").data.equals(Buffer.from([0, 1, 13, 10, 13])),
  );
  assert.ok(tree.files.get(STUB_DIST.path).data.equals(STUB_DIST.data));
  for (const { data, hash, mode } of tree.files.values()) {
    assert.equal(mode, "100644");
    assert.equal(hash, fileHash(mode, data));
  }
});

test("R4 readTree row handling with injected file errors", () => {
  const file = { isFile: () => true };
  const link = { isFile: () => false };
  const failing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const fs = {
    lstat: (full) =>
      full.endsWith("link")
        ? link
        : full.endsWith("gone")
          ? failing("ENOENT")()
          : file,
    readFile: (full) =>
      full.endsWith("locked") ? failing("EACCES")() : Buffer.from("a\r\n"),
  };
  const tree = readTree(
    root,
    [
      treeRow("ok"),
      treeRow("link"),
      treeRow("gone"),
      treeRow("dist/index.html"),
    ],
    fs,
  );
  assert.deepEqual([...tree.files.keys()], ["ok", "dist/index.html"]);
  // CI overwrites a listed dist/index.html, so the stub wins.
  assert.ok(tree.files.get("dist/index.html").data.equals(STUB_DIST.data));
  assert.deepEqual(tree.skipped, ["link"]);
  assert.deepEqual(tree.missing, ["gone"]);
  // A real symlink arrives as its target text, counted as a symlink.
  const target = Buffer.from("../lib/real.rs");
  const linked = readTree(
    root,
    [treeRow("sym"), treeRow("lib/dir")],
    {
      lstat: (full) =>
        full.endsWith("sym")
          ? { isFile: () => false, isSymbolicLink: () => true }
          : { isFile: () => false, isSymbolicLink: () => false },
      readFile: failing("EISDIR"),
      readlink: () => target,
    },
    { modes: new Map([["sym", "120000"]]) },
  );
  assert.ok(linked.files.get("sym").data.equals(target));
  assert.equal(linked.files.get("sym").mode, "100644");
  assert.equal(linked.files.get("sym").hash, fileHash("100644", target));
  assert.deepEqual(linked.symlinks, ["sym"]);
  assert.deepEqual(linked.skipped, ["lib/dir"]);
  assert.throws(
    () => readTree(root, [treeRow("locked")], fs),
    /"locked" \(EACCES\)/,
  );
  assert.throws(
    () => readTree(root, [treeRow("a/../b")], fs),
    /not a valid tree path: "a\/..\/b"/,
  );
  assert.throws(
    () => readTree(root, [treeRow(".gd-rust-container/end")], fs),
    /not a valid tree path/,
  );
});

test("R4 index modes: 100755 is executable, a symlink is counted, mode is hashed", () => {
  const sha = "0".repeat(40);
  const modes = parseModeListing(
    listing([
      `100755 ${sha} 0\trun.sh`,
      `120000 ${sha} 0\tlink`,
      `100644 ${sha} 1\tboth.txt`,
      `100755 ${sha} 2\tboth.txt`,
      `100644 ${sha} 3\tboth.txt`,
      `100755 ${sha} 1\ttheirs.txt`,
      `100644 ${sha} 3\ttheirs.txt`,
      `100644 ${"1".repeat(64)} 0\ta b\tc.txt`,
    ]),
  );
  // An unmerged path takes ours (stage 2), else the first stage listed.
  assert.deepEqual(Object.fromEntries(modes), {
    "run.sh": "100755",
    link: "120000",
    "both.txt": "100755",
    "theirs.txt": "100755",
    "a b\tc.txt": "100644",
  });
  assert.throws(
    () => parseModeListing(listing(["100644 x 0\tp"])),
    /unreadable/,
  );
  const fs = {
    lstat: () => ({ isFile: () => true }),
    readFile: () => Buffer.from("#!/bin/sh\n"),
  };
  const tree = readTree(
    root,
    [treeRow("run.sh"), treeRow("link"), treeRow("plain")],
    fs,
    {
      modes,
    },
  );
  assert.equal(tree.files.get("run.sh").mode, "100755");
  assert.equal(tree.files.get("link").mode, "100644");
  assert.equal(tree.files.get("plain").mode, "100644");
  assert.deepEqual(tree.symlinks, ["link"]);
  assert.notEqual(tree.files.get("run.sh").hash, tree.files.get("plain").hash);
  assert.equal(
    tree.files.get("plain").hash,
    fileHash("100644", Buffer.from("#!/bin/sh\n")),
  );
});

test("R4 only a tracked symlink is read as its link text; win32 maps its separators", () => {
  // Git for Windows writes a link blob's `/` as a backslash on checkout.
  const backslashed = Buffer.from(
    ["sub", "f.txt"].join(String.fromCharCode(92)),
  );
  const fs = {
    lstat: () => ({ isFile: () => false, isSymbolicLink: () => true }),
    readFile: () => {
      throw new Error("a link was read as a file");
    },
    readlink: () => backslashed,
  };
  const modes = new Map([
    ["link", "120000"],
    ["plain", "100644"],
  ]);
  const rows = [treeRow("link"), treeRow("loose"), treeRow("plain")];
  const win = readTree(root, rows, fs, { modes, platform: "win32" });
  assert.equal(String(win.files.get("link").data), "sub/f.txt");
  assert.equal(
    win.files.get("link").hash,
    fileHash("100644", Buffer.from("sub/f.txt")),
  );
  assert.deepEqual(win.symlinks, ["link"]);
  assert.deepEqual(win.skipped, ["loose", "plain"]);
  const linux = readTree(root, rows, fs, { modes, platform: "linux" });
  assert.ok(linux.files.get("link").data.equals(backslashed));
  assert.deepEqual(linux.skipped, ["loose", "plain"]);
});

test("R4 absentPaths leaves out CI's stub, which every sync writes", () => {
  const fs = {
    lstat: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFile: () => Buffer.alloc(0),
  };
  const tree = readTree(
    root,
    [treeRow("z-gone"), treeRow(STUB_DIST.path), treeRow("a-gone")],
    fs,
  );
  assert.deepEqual(tree.missing, ["z-gone", STUB_DIST.path, "a-gone"]);
  assert.deepEqual(absentPaths(tree), ["a-gone", "z-gone"]);
});

test("R4 listWorktree lists its root whatever GIT_DIR or GIT_INDEX_FILE say", async () => {
  const repo = fresh("listed");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "core.autocrlf", "input"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
  git(repo, ["add", "-A"]);
  git(repo, ["update-index", "--chmod=+x", "run.sh"]);
  const elsewhere = fresh("elsewhere");
  git(elsewhere, ["init", "-b", "main"]);
  writeFileSync(join(elsewhere, "other.txt"), "o\n");
  git(elsewhere, ["add", "-A"]);
  const listed = await listWorktree(repo, {
    ...gitEnv(),
    GIT_DIR: join(elsewhere, ".git"),
    GIT_INDEX_FILE: join(elsewhere, ".git", "index"),
  });
  assert.deepEqual(
    parseEolListing(listed.eol)
      .map((r) => r.path)
      .sort(),
    ["a.txt", "run.sh"],
  );
  assert.deepEqual(Object.fromEntries(parseModeListing(listed.stage)), {
    "a.txt": "100644",
    "run.sh": "100755",
  });
  assert.equal(listed.autocrlf, "input");
  git(repo, ["config", "--unset", "core.autocrlf"]);
  assert.equal((await listWorktree(repo, gitEnv())).autocrlf, null);
});

test("R4 listWorktree reads core.autocrlf the way git does", async () => {
  const repo = fresh("autocrlf");
  git(repo, ["init", "-b", "main"]);
  const configFile = join(repo, ".git", "config");
  const base = readFileSync(configFile, "utf8");
  const read = async (line) => {
    writeFileSync(configFile, `${base}[core]\n\t${line}\n`);
    return (await listWorktree(repo, gitEnv())).autocrlf;
  };
  for (const [line, expected] of [
    ["autocrlf", "true"],
    ["autocrlf =", "false"],
    ["autocrlf = 2", "true"],
    ["autocrlf = -1", "true"],
    ["autocrlf = yes", "true"],
    ["autocrlf = Off", "false"],
    ["autocrlf = Input", "input"],
  ]) {
    assert.equal(await read(line), expected, line);
  }
  // git's own listing refuses it first; either way the run cannot list.
  await assert.rejects(read("autocrlf = sometimes"), /core\.autocrlf/);
  // The empty spelling is false to git: an untracked CRLF file stays raw.
  assert.equal(await read("autocrlf ="), "false");
  writeFileSync(join(repo, "u.txt"), "u\r\nv\r\n");
  const rows = parseEolListing(
    git(repo, ["ls-files", "-z", "-co", "--exclude-standard", "--eol"]),
  );
  const tree = readTree(repo, rows, undefined, { autocrlf: "false" });
  assert.equal(tree.files.get("u.txt").data.toString("latin1"), "u\r\nv\r\n");
  git(repo, ["add", "u.txt"]);
  assert.equal(
    git(repo, ["cat-file", "-p", ":u.txt"]).toString("latin1"),
    "u\r\nv\r\n",
  );
});

test("R4 a real tracked symlink arrives as its target text; an untracked one is skipped", {
  skip: process.platform === "win32" ? "symlinks need privileges here" : false,
}, () => {
  const dir = fresh("symlink");
  writeFileSync(join(dir, "real.rs"), "fn a() {}\n");
  symlinkSync("real.rs", join(dir, "link.rs"));
  const tree = readTree(
    dir,
    [treeRow("link.rs"), treeRow("real.rs")],
    undefined,
    {
      modes: new Map([["link.rs", "120000"]]),
    },
  );
  assert.equal(String(tree.files.get("link.rs").data), "real.rs");
  assert.deepEqual(tree.symlinks, ["link.rs"]);
  assert.deepEqual(tree.skipped, []);
  const untracked = readTree(dir, [treeRow("link.rs")]);
  assert.deepEqual(untracked.skipped, ["link.rs"]);
  assert.deepEqual(untracked.symlinks, []);
});

// ------------------------------------------------------- R5-R9 naming

const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

test("R5 worktree paths normalize per platform and key their volumes", () => {
  assert.equal(normalizeWorktreePath("C:\\Foo\\Bar\\", "win32"), "c:/foo/bar");
  assert.equal(normalizeWorktreePath("C:\\", "win32"), "c:/");
  assert.equal(
    worktreeKey("C:\\Foo\\Bar\\", "win32"),
    worktreeKey("c:/foo/bar", "win32"),
  );
  assert.equal(normalizeWorktreePath("/a/b/", "linux"), "/a/b");
  assert.equal(normalizeWorktreePath("/", "linux"), "/");
  assert.notEqual(worktreeKey("/a/B", "linux"), worktreeKey("/a/b", "linux"));
  assert.equal(
    worktreeKey("/a/b", "linux"),
    `b-${sha256hex("/a/b").slice(0, 8)}`,
  );
  const slug = (path) =>
    worktreeKey(path, "linux").replace(/-[0-9a-f]{8}$/, "");
  assert.equal(slug("/x/My Repo.v2"), "my-repo-v2");
  assert.equal(slug("/x/Größe"), "gr-e");
  assert.equal(slug(`/x/${"a".repeat(40)}`), "a".repeat(24));
  assert.equal(slug(`/x/${"a".repeat(23)}--${"b".repeat(15)}`), "a".repeat(23));
  assert.equal(slug("/x/@@@"), "tree");
  assert.equal(slug("/x/..."), "tree");
  for (const key of [
    worktreeKey("C:\\Foo\\Bar", "win32"),
    worktreeKey("/x/@@@", "linux"),
    worktreeKey(`/x/${"a".repeat(40)}`, "linux"),
    worktreeKey("/", "linux"),
  ]) {
    for (const name of Object.values(volumeNames(key)))
      assert.match(name, DOCKER_NAME, name);
  }
  assert.deepEqual(volumeNames("k-12345678"), {
    src: "gd-rust-container-k-12345678-src",
    target: "gd-rust-container-k-12345678-target",
    cargo: "gd-rust-container-cargo",
  });
});

const DIGEST = `rust@sha256:${"1f".repeat(32)}`;

test("R6 imageName follows the Dockerfile text and rustc version only", () => {
  const base = imageName(DOCKERFILE, "1.100.0");
  assert.match(base, /^gd-rust-container:[0-9a-f]{12}$/);
  assert.equal(imageName(DOCKERFILE, "1.100.0"), base);
  assert.notEqual(imageName(`${DOCKERFILE}# x\n`, "1.100.0"), base);
  assert.notEqual(imageName(DOCKERFILE, "1.100.1"), base);
  assert.equal(
    base,
    `gd-rust-container:${sha256hex(`${DOCKERFILE}\nrustc 1.100.0`).slice(0, 12)}`,
  );
});

test("R6 buildDockerfile pins only the FROM line to the local rust digest", () => {
  const rest = DOCKERFILE.slice(DOCKERFILE.indexOf("\n"));
  assert.equal(DOCKERFILE.split("\n")[0], "FROM rust:1");
  assert.equal(
    buildDockerfile(DOCKERFILE, ["other@sha256:00", DIGEST]),
    `FROM ${DIGEST}${rest}`,
  );
  assert.equal(
    buildDockerfile(DOCKERFILE, [DIGEST, `rust@sha256:${"2e".repeat(32)}`]),
    `FROM ${DIGEST}${rest}`,
  );
  for (const digests of [
    [],
    null,
    undefined,
    ["other@sha256:00"],
    ["rust@sha256:short"],
  ]) {
    assert.equal(buildDockerfile(DOCKERFILE, digests), DOCKERFILE);
  }
  assert.ok(DOCKERFILE.endsWith("\n") && !DOCKERFILE.endsWith("\n\n"));
  assert.ok(!DOCKERFILE.includes("\r"));
});

/** The apt package list of rust-tests.yml's "Install Linux dependencies" step. */
function workflowAptPackages(text) {
  const lines = text.split(/\r?\n/);
  const step = lines.findIndex((line) =>
    /^\s*- name: Install Linux dependencies\s*$/.test(line),
  );
  assert.notEqual(step, -1, "step not found");
  let i = step + 1;
  while (i < lines.length && !/apt-get install -y \\$/.test(lines[i])) {
    assert.doesNotMatch(
      lines[i],
      /^\s*- name:/,
      "install line not found in the step",
    );
    i++;
  }
  assert.ok(i < lines.length, "install line not found");
  const packages = [];
  let continued = true;
  while (continued) {
    i++;
    const line = lines[i].trim();
    continued = line.endsWith("\\");
    packages.push(...line.replace(/\\$/, "").split(/\s+/).filter(Boolean));
  }
  return packages;
}

function sameList(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

test("R7 APT_PACKAGES mirrors CI's Linux dependency step (set and order)", () => {
  const file = fileURLToPath(
    new URL("../.github/workflows/rust-tests.yml", import.meta.url),
  );
  const lf = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const text of [lf, lf.replace(/\n/g, "\r\n")]) {
    const parsed = workflowAptPackages(text);
    assert.ok(sameList(APT_PACKAGES, parsed), JSON.stringify(parsed));
  }
  const install = /--no-install-recommends (.*) \\$/m.exec(DOCKERFILE);
  assert.ok(install);
  assert.ok(sameList(install[1].split(" "), APT_PACKAGES));
  assert.equal(sameList(APT_PACKAGES.slice(1), workflowAptPackages(lf)), false);
});

test("R8 rust version parsers", () => {
  assert.equal(
    rustVersionFromEnv(["PATH=/x", "RUST_VERSION=1.100.0"]),
    "1.100.0",
  );
  assert.equal(rustVersionFromEnv(["PATH=/x"]), null);
  assert.equal(rustVersionFromEnv(["RUST_VERSION="]), null);
  assert.equal(rustVersionFromEnv(["RUST_VERSION=1.100.0\nX"]), null);
  assert.equal(rustVersionFromEnv(null), null);
  assert.equal(
    rustVersionFromRustc("rustc 1.100.0 (abcdef012 2026-11-01)\n"),
    "1.100.0",
  );
  assert.equal(
    rustVersionFromRustc("rustc 1.101.0-nightly (abc 2026-11-01)"),
    "1.101.0-nightly",
  );
  assert.equal(rustVersionFromRustc("cargo 1.100.0"), null);
  assert.equal(rustVersionFromRustc(""), null);
});

test("R9 containerPortFromEnv accepts the range and refuses the rest", () => {
  const port = String(DEFAULT_CONTAINER_PORT);
  assert.equal(DEFAULT_CONTAINER_PORT, DEFAULT_PORT + 1);
  assert.equal(containerPortFromEnv(undefined), DEFAULT_CONTAINER_PORT);
  assert.equal(containerPortFromEnv(""), DEFAULT_CONTAINER_PORT);
  assert.equal(containerPortFromEnv("1024"), 1024);
  assert.equal(containerPortFromEnv("65535"), 65535);
  for (const value of [
    "1023",
    "65536",
    `${port}x`,
    ` ${port}`,
    "-1",
    "1e4",
    "abc",
  ]) {
    assert.throws(
      () => containerPortFromEnv(value),
      /GD_RUST_CONTAINER_PORT/,
      value,
    );
  }
});

// ----------------------------------------------------------- R10 planning

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const DIGEST_D = "d".repeat(64);

test("R10 planSync goes full without a usable cache", () => {
  const files = new Map([
    ["b", "h2"],
    ["a", "h1"],
  ]);
  const full = {
    mode: "full",
    prev: null,
    prevDigest: null,
    send: ["a", "b"],
    deletes: [],
  };
  assert.deepEqual(planSync({ files, cache: null }), full);
  const v5 = { version: 5, digest: DIGEST_D };
  for (const cache of [
    { version: 1, syncId: ID_A, files: {} },
    { version: 2, syncId: ID_A, files: { a: "h1", b: "h2" } },
    { version: 3, syncId: ID_A, files: {}, missing: [] },
    { version: 4, syncId: ID_A, files: {}, missing: [] },
    { ...v5, syncId: ID_A.toUpperCase(), files: {}, missing: [] },
    { ...v5, syncId: "a".repeat(31), files: {}, missing: [] },
    { ...v5, files: {}, missing: [] },
    { ...v5, syncId: ID_A, files: null, missing: [] },
    { ...v5, syncId: ID_A, files: [], missing: [] },
    { ...v5, syncId: ID_A, files: { "../x": "h" }, missing: [] },
    { ...v5, syncId: ID_A, files: { a: 1 }, missing: [] },
    { ...v5, syncId: ID_A, files: {} },
    { ...v5, syncId: ID_A, files: {}, missing: "a" },
    { ...v5, syncId: ID_A, files: {}, missing: ["../x"] },
    { version: 5, syncId: ID_A, files: {}, missing: [] },
    {
      ...v5,
      digest: DIGEST_D.toUpperCase(),
      syncId: ID_A,
      files: {},
      missing: [],
    },
    { ...v5, digest: "d".repeat(63), syncId: ID_A, files: {}, missing: [] },
    "not an object",
  ]) {
    assert.deepEqual(planSync({ files, cache }), full, JSON.stringify(cache));
  }
});

test("R10 a v4 cache plans full; a v5 cache needs its digest", () => {
  const files = new Map([["a", "h1"]]);
  const v4 = { version: 4, syncId: ID_A, files: { a: "h1" }, missing: [] };
  assert.equal(planSync({ files, cache: v4 }).mode, "full");
  assert.deepEqual(
    planSync({ files, cache: { ...v4, version: 5, digest: DIGEST_D } }),
    { mode: "delta", prev: ID_A, prevDigest: DIGEST_D, send: [], deletes: [] },
  );
  assert.equal(planSync({ files, cache: { ...v4, version: 5 } }).mode, "full");
});

test("R10 syncManifest sorts by path bytes and writes f and a records", () => {
  const halfwidth = String.fromCharCode(0xff61);
  const emoji = String.fromCodePoint(0x1f600);
  const hash = (n) => String(n).repeat(64);
  const bytes = syncManifest(
    new Map([
      ["b", hash(1)],
      ["a", hash(2)],
      [halfwidth, hash(3)],
      [emoji, hash(4)],
      ["a\nb", hash(5)],
    ]),
    ["c"],
  );
  const expected = Buffer.from(
    [
      `f ${hash(2)} a\0`,
      `f ${hash(5)} a\nb\0`,
      `f ${hash(1)} b\0`,
      "a c\0",
      `f ${hash(3)} ${halfwidth}\0`,
      `f ${hash(4)} ${emoji}\0`,
    ].join(""),
  );
  assert.ok(bytes.equals(expected), bytes.toString("hex"));
  assert.equal(sha256hex(bytes), sha256hex(expected));
  assert.equal(syncManifest(new Map(), []).length, 0);
});

test("R10 syncManifest refuses bad paths, bad hashes and a path in both sets", () => {
  const good = "0".repeat(64);
  for (const [files, absent] of [
    [new Map([["../x", good]]), []],
    [new Map([[".gd-rust-container/end", good]]), []],
    [new Map([["a", good.toUpperCase().replace(/0/g, "A")]]), []],
    [new Map([["a", "0".repeat(63)]]), []],
    [new Map([["a", 1]]), []],
    [new Map(), ["/abs"]],
    [new Map([["a", good]]), ["a"]],
  ]) {
    assert.throws(
      () => syncManifest(files, absent),
      Error,
      JSON.stringify([[...files], absent]),
    );
  }
});

test("R10 planSync sends changed and new paths, deletes vanished ones", () => {
  const files = new Map([
    ["new.txt", "h3"],
    ["changed.txt", "h2"],
    ["same.txt", "h1"],
  ]);
  const cache = {
    version: 5,
    syncId: ID_A,
    digest: DIGEST_D,
    missing: [],
    files: {
      "same.txt": "h1",
      "changed.txt": "old",
      "z-gone.txt": "h4",
      "a-gone.txt": "h5",
    },
  };
  assert.deepEqual(planSync({ files, cache }), {
    mode: "delta",
    prev: ID_A,
    prevDigest: DIGEST_D,
    send: ["changed.txt", "new.txt"],
    deletes: ["a-gone.txt", "z-gone.txt"],
  });
  assert.deepEqual(
    planSync({
      files: new Map([["same.txt", "h1"]]),
      cache: { ...cache, files: { "same.txt": "h1" } },
    }),
    {
      mode: "delta",
      prev: ID_A,
      prevDigest: DIGEST_D,
      send: [],
      deletes: [],
    },
  );
});

test("R10 missingChanged compares the sorted missing paths with the cache's", () => {
  const cache = { missing: ["a", "b"] };
  assert.equal(missingChanged(cache, ["b", "a"]), false);
  assert.equal(missingChanged(cache, ["a"]), true);
  assert.equal(missingChanged(cache, ["a", "c"]), true);
  assert.equal(missingChanged(cache, ["a", "b", "c"]), true);
  assert.equal(missingChanged({ missing: [] }, []), false);
});

test("R10 validTreePath refuses non-relative, dotted and reserved paths", () => {
  for (const path of [
    "",
    "/a",
    "a/",
    "a//b",
    "./a",
    "a/./b",
    "a/../b",
    "..",
    "a\\b",
    "a\0b",
    ".gd-rust-container",
    ".gd-rust-container/end",
    ".gd-rust-container/x/y",
    null,
  ]) {
    assert.equal(validTreePath(path), false, JSON.stringify(path));
  }
  for (const path of [
    "a",
    "a/b.txt",
    ".gd-rust-containerx",
    "x/.gd-rust-container",
    "a b/c\td",
    ".hidden",
  ]) {
    assert.equal(validTreePath(path), true, path);
  }
});

// ------------------------------------------------- R11 sync script (Linux)

const nulList = (paths) => Buffer.from(paths.map((p) => `${p}\0`).join(""));
const D_PREV = "d".repeat(64);
const D_NEXT = "e".repeat(64);
const asRoot = process.getuid?.() === 0;
const ROOT_SKIP = "root bypasses permission checks; runs as a non-root uid";

/** The fileHash of a `[name, data, mode?]` entry, as readTree computes it. */
const entryHash = ([, data, mode]) =>
  fileHash(mode === 0o755 ? "100755" : "100644", Buffer.from(data));

const manifestOf = (listed, absent = []) =>
  syncManifest(
    new Map(listed.map((entry) => [entry[0], entryHash(entry)])),
    absent,
  );

/**
 * A sync archive whose manifest lists `listed` (`[name, data, mode?]`, the
 * sent files by default) and `absent`. The Buffer carries its manifest as
 * `manifest` and the manifest's sha256 as `digest`.
 */
function syncArchive({
  deletes = [],
  files = [],
  listed = files,
  absent = [],
  end,
}) {
  const manifest = manifestOf(listed, absent);
  const entries = [
    { name: ".gd-rust-container/deletes", data: nulList(deletes) },
    ...files.map(([name, data, mode]) => ({
      name,
      data: Buffer.from(data),
      mode,
    })),
    { name: ".gd-rust-container/manifest", data: manifest },
  ];
  if (end !== undefined)
    entries.push({ name: ".gd-rust-container/end", data: Buffer.from(end) });
  return Object.assign(tarBuffer(entries), {
    manifest,
    digest: sha256hex(manifest),
  });
}

function runSync(script, args, input, cwd = root, env = process.env) {
  const result = spawnSync("bash", ["-c", script, "sync", ...args], {
    cwd,
    env,
    input,
    timeout: 30_000,
  });
  return { status: result.status, stderr: String(result.stderr) };
}

/** The six sync arguments of a delta from `prev` to `next` onto `vol`. */
const deltaArgs = (vol, prevDigest, archive, prev = ID_A, next = ID_B) => [
  "delta",
  vol,
  prev,
  prevDigest,
  next,
  archive.digest,
];

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) {
        out[path] = "dir";
        walk(path);
      } else {
        out[path] = readFileSync(join(dir, path)).toString("base64");
      }
    }
  };
  walk("");
  return out;
}

const BASE_FILES = [
  ["a.txt", "a1\n"],
  ["keep.txt", "keep\n"],
  ["sub/b.txt", "b\n"],
  ["x", "x was a file\n"],
  ["d/e", "d was a dir\n"],
];

function fullVolume({ absent, files = BASE_FILES } = {}) {
  const vol = fresh("vol");
  const archive = syncArchive({ files, absent, end: ID_A });
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_A, archive.digest],
    archive,
  );
  assert.equal(result.status, 0, result.stderr);
  return { vol, digest: archive.digest };
}

const DELTA = {
  deletes: ["sub/b.txt", "x", "d/e"],
  files: [
    ["a.txt", "a2\n"],
    ["c.txt", "new\n"],
    ["x/y", "x is a dir now\n"],
    ["d", "d is a file now\n"],
  ],
};

test("R11 full sync materializes the tree and records its id", {
  skip: SYNC_ONLY,
}, () => {
  const { vol } = fullVolume();
  const tree = snapshot(join(vol, "tree"));
  assert.deepEqual(Object.keys(tree), [
    "a.txt",
    "d",
    "d/e",
    "keep.txt",
    "sub",
    "sub/b.txt",
    "x",
  ]);
  assert.equal(readFileSync(join(vol, "tree", "sub", "b.txt"), "utf8"), "b\n");
  assert.equal(readFileSync(join(vol, ".sync-id"), "utf8"), `${ID_A}\n`);
  assert.equal(existsSync(join(vol, "tree", ".gd-rust-container")), false);
});

test("R11 delta applies changes, deletes, swaps and keeps unchanged mtimes", {
  skip: SYNC_ONLY,
}, () => {
  const { vol, digest } = fullVolume();
  const old = new Date("2000-01-01T00:00:00Z");
  utimesSync(join(vol, "tree", "keep.txt"), old, old);
  utimesSync(join(vol, "tree", "a.txt"), old, old);
  const archive = syncArchive({ ...DELTA, end: ID_B });
  const result = runSync(SYNC_SCRIPT, deltaArgs(vol, digest, archive), archive);
  assert.equal(result.status, 0, result.stderr);
  const dir = join(vol, "tree");
  assert.deepEqual(Object.keys(snapshot(dir)), [
    "a.txt",
    "c.txt",
    "d",
    "keep.txt",
    "x",
    "x/y",
  ]);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a2\n");
  assert.equal(readFileSync(join(dir, "d"), "utf8"), "d is a file now\n");
  assert.equal(readFileSync(join(dir, "x", "y"), "utf8"), "x is a dir now\n");
  assert.equal(statSync(join(dir, "keep.txt")).mtimeMs, old.getTime());
  assert.ok(statSync(join(dir, "a.txt")).mtimeMs > Date.now() - 3_600_000);
  assert.equal(readFileSync(join(vol, ".sync-id"), "utf8"), `${ID_B}\n`);
});

test("R11 a delta against the wrong prev exits 75 and changes nothing", {
  skip: SYNC_ONLY,
}, () => {
  const { vol, digest } = fullVolume();
  const before = snapshot(vol);
  const archive = syncArchive({ ...DELTA, end: ID_B });
  const result = runSync(
    SYNC_SCRIPT,
    deltaArgs(vol, digest, archive, ID_C),
    archive,
  );
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(snapshot(vol), before);
});

/** The delta archive cut at a member boundary just before its end member. */
function truncatedArchive() {
  const archive = syncArchive({ ...DELTA });
  return Object.assign(archive.subarray(0, archive.length - 1024), {
    digest: archive.digest,
  });
}

test("R11 an archive without its end member exits 3 and changes nothing", {
  skip: SYNC_ONLY,
}, () => {
  const { vol } = fullVolume();
  const before = snapshot(vol);
  const archive = truncatedArchive();
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_B, archive.digest],
    archive,
  );
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(snapshot(vol), before);
});

function refusalRoots() {
  const link = join(fresh("link"), "root-link");
  symlinkSync("/", link);
  return { link, roots: ["/", "//", "/.", "/..", link, "x/y"] };
}

test("R11 volume roots resolving to / or relative are refused (delta mode)", {
  skip: SYNC_ONLY,
}, () => {
  const cwd = fresh("empty-cwd");
  const { link, roots } = refusalRoots();
  try {
    for (const vol of roots) {
      const result = runSync(
        stopAfterGuard(SYNC_SCRIPT),
        ["delta", vol, ID_A, D_PREV, ID_B, D_NEXT],
        syncArchive({ end: ID_B }),
        cwd,
      );
      assert.equal(result.status, 2, `${vol}: ${result.stderr}`);
      assert.match(
        result.stderr,
        vol === "x/y" ? /must be absolute/ : /resolves to \//,
        vol,
      );
    }
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    unlinkSync(link);
  }
});

function mutated(script, from, to) {
  assert.ok(script.includes(from), `mutation anchor missing: ${from}`);
  const out = script.replace(from, () => to);
  assert.notEqual(out, script);
  return out;
}

// Ends the sync script right after its root guard, before it opens .lock, so
// no form of the guard can create /.lock; 64 is no exit the script uses.
function stopAfterGuard(script) {
  const lock = "exec 9> .lock\n";
  assert.equal(script.split(lock).length, 2, "the lock line must occur once");
  return script.replace(
    lock,
    () => 'echo "rust-container: guard passed" >&2; exit 64\n',
  );
}

test("R11 control: a pwd -P string compare lets // through the guard", {
  skip: SYNC_ONLY,
}, () => {
  const weak = stopAfterGuard(
    mutated(
      SYNC_SCRIPT,
      "if [ . -ef / ]; then",
      'if [ "$(pwd -P)" = / ]; then',
    ),
  );
  const cwd = fresh("empty-cwd");
  const args = ["delta", "//", ID_A, D_PREV, ID_B, D_NEXT];
  const result = runSync(weak, args, syncArchive({ end: ID_B }), cwd);
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /guard passed/);
  const strong = runSync(
    stopAfterGuard(SYNC_SCRIPT),
    args,
    syncArchive({ end: ID_B }),
    cwd,
  );
  assert.equal(strong.status, 2, strong.stderr);
  assert.match(strong.stderr, /volume root resolves to \/: \/\//);
  assert.deepEqual(readdirSync(cwd), []);
});

test("R11 control: without the deletes line a deleted file stays", {
  skip: SYNC_ONLY,
}, () => {
  const line =
    'tar -x -O -f "$work/sync.tar" .gd-rust-container/deletes | xargs -0 -r rm -f --\n';
  const noDeletes = mutated(SYNC_SCRIPT, line, "");
  const { vol, digest } = fullVolume();
  const archive = syncArchive({ deletes: ["sub/b.txt"], end: ID_B });
  assert.equal(
    runSync(noDeletes, deltaArgs(vol, digest, archive), archive).status,
    0,
  );
  assert.equal(existsSync(join(vol, "tree", "sub", "b.txt")), true);
  const real = fullVolume();
  assert.equal(
    runSync(SYNC_SCRIPT, deltaArgs(real.vol, real.digest, archive), archive)
      .status,
    0,
  );
  assert.equal(existsSync(join(real.vol, "tree", "sub", "b.txt")), false);
});

test("R11 control: without the sentinel check a truncated archive is applied", {
  skip: SYNC_ONLY,
}, () => {
  const check =
    '[ "$(tar -x -O -f "$work/sync.tar" .gd-rust-container/end 2>/dev/null || true)" = "$next" ] \\\n  || { echo "rust-container: sync: the archive is incomplete" >&2; exit 3; }\n';
  const noSentinel = mutated(SYNC_SCRIPT, check, "");
  const { vol } = fullVolume();
  const archive = truncatedArchive();
  const result = runSync(
    noSentinel,
    ["full", vol, "-", "-", ID_B, archive.digest],
    archive,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(vol, "tree", "c.txt"), "utf8"), "new\n");
});

/** Holds `<dir>/.lock` the way another container would; SIGKILL releases it. */
async function holdVolumeLock(dir) {
  const holder = spawn(
    "bash",
    [
      "-c",
      'exec 9>"$1"; flock 9; echo held; exec sleep 30',
      "hold",
      join(dir, ".lock"),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((done, reject) => {
    holder.stdout.once("data", done);
    holder.once("exit", () => reject(new Error("the lock holder exited")));
  });
  return holder;
}

test("R11 a held volume lock exits 73 and changes nothing", {
  skip: SYNC_ONLY,
}, async () => {
  const { vol, digest } = fullVolume();
  const holder = await holdVolumeLock(vol);
  try {
    const before = snapshot(vol);
    const archive = syncArchive({ ...DELTA, end: ID_B });
    const result = runSync(
      SYNC_SCRIPT,
      deltaArgs(vol, digest, archive),
      archive,
    );
    assert.equal(result.status, 73, result.stderr);
    assert.deepEqual(snapshot(vol), before);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("R11 a full sync replaces an existing tree and lands the manifest", {
  skip: SYNC_ONLY,
}, () => {
  const { vol, digest } = fullVolume();
  assert.equal(sha256hex(readFileSync(join(vol, ".sync-manifest"))), digest);
  const archive = syncArchive({
    files: [["only.txt", "only\n"]],
    absent: ["extra/listed.txt"],
    end: ID_B,
  });
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_B, archive.digest],
    archive,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(snapshot(join(vol, "tree"))), ["only.txt"]);
  const landed = readFileSync(join(vol, ".sync-manifest"));
  assert.ok(landed.equals(archive.manifest));
  assert.equal(sha256hex(landed), archive.digest);
  assert.equal(readFileSync(join(vol, ".sync-id"), "utf8"), `${ID_B}\n`);
});

test("R11 a full sync heals a directory at .sync-manifest", {
  skip: SYNC_ONLY,
}, () => {
  const { vol } = fullVolume();
  rmSync(join(vol, ".sync-manifest"));
  mkdirSync(join(vol, ".sync-manifest"));
  writeFileSync(join(vol, ".sync-manifest", "inside"), "x");
  const archive = syncArchive({ files: BASE_FILES, end: ID_B });
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_B, archive.digest],
    archive,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(join(vol, ".sync-manifest")).equals(archive.manifest));
  assert.equal(readFileSync(join(vol, ".sync-id"), "utf8"), `${ID_B}\n`);
});

/** Stamps a tree file a minute ahead, as a write after the sync would. */
function rewriteLater(file, text) {
  writeFileSync(file, text);
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
}

test("R11 absent paths land in the manifest; a v4 .sync-absent is removed", {
  skip: SYNC_ONLY,
}, () => {
  const { vol, digest } = fullVolume({
    absent: ["gone.txt", "src/Cargo.lock"],
  });
  const manifest = readFileSync(join(vol, ".sync-manifest"), "latin1");
  assert.ok(manifest.includes("a gone.txt\0"), manifest);
  assert.ok(manifest.includes("a src/Cargo.lock\0"), manifest);
  writeFileSync(join(vol, ".sync-absent"), "gone.txt\0");
  const archive = syncArchive({ files: [["a.txt", "a2\n"]], end: ID_B });
  const result = runSync(SYNC_SCRIPT, deltaArgs(vol, digest, archive), archive);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(vol, ".sync-absent")), false);
  assert.equal(existsSync(join(vol, "tree", ".gd-rust-container")), false);
});

test("R11 a delta over a tree changed since its sync exits 75 and changes nothing", {
  skip: SYNC_ONLY,
}, () => {
  const cases = [
    ["rewritten", (tree) => rewriteLater(join(tree, "keep.txt"), "cargo\n")],
    ["deleted", (tree) => unlinkSync(join(tree, "keep.txt"))],
    [
      "absent now present",
      (tree) => writeFileSync(join(tree, "gone.txt"), "g"),
    ],
  ];
  for (const [name, drift] of cases) {
    const { vol, digest } = fullVolume({ absent: ["gone.txt"] });
    drift(join(vol, "tree"));
    const before = snapshot(vol);
    const archive = syncArchive({ ...DELTA, end: ID_B });
    const result = runSync(
      SYNC_SCRIPT,
      deltaArgs(vol, digest, archive),
      archive,
    );
    assert.equal(result.status, 75, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /changed since its last sync/, name);
    assert.deepEqual(snapshot(vol), before, name);
  }
});

test("R11 a generated unsynced file lets a delta through; a volume without a manifest exits 75", {
  skip: SYNC_ONLY,
}, () => {
  const generated = fullVolume({ absent: ["gone.txt"] });
  mkdirSync(join(generated.vol, "tree", "gen"));
  rewriteLater(join(generated.vol, "tree", "gen", "out.txt"), "new\n");
  const archive = syncArchive({ files: [["a.txt", "a2\n"]], end: ID_B });
  assert.equal(
    runSync(
      SYNC_SCRIPT,
      deltaArgs(generated.vol, generated.digest, archive),
      archive,
    ).status,
    0,
  );
  const old = fullVolume();
  rmSync(join(old.vol, ".sync-manifest"));
  rewriteLater(join(old.vol, "tree", "keep.txt"), "cargo\n");
  const before = snapshot(join(old.vol, "tree"));
  const result = runSync(
    SYNC_SCRIPT,
    deltaArgs(old.vol, old.digest, archive),
    archive,
  );
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /changed since its last sync/);
  assert.equal(readFileSync(join(old.vol, ".sync-id"), "utf8"), `${ID_A}\n`);
  assert.deepEqual(snapshot(join(old.vol, "tree")), before);
});

test("R11 a delta into a volume without a tree exits 75", {
  skip: SYNC_ONLY,
}, () => {
  const vol = fresh("vol");
  writeFileSync(join(vol, ".sync-id"), `${ID_A}\n`);
  const archive = syncArchive({ ...DELTA, end: ID_B });
  const result = runSync(SYNC_SCRIPT, deltaArgs(vol, D_PREV, archive), archive);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(existsSync(join(vol, "tree")), false);
});

test("R11 the container scripts render without a NUL and quote the verifier safely", () => {
  for (const [name, text] of [
    ["SYNC_SCRIPT", SYNC_SCRIPT],
    ["CARGO_SCRIPT", CARGO_SCRIPT],
    ["VERIFY_PL", VERIFY_PL],
  ]) {
    assert.equal(text.includes("\0"), false, name);
  }
  assert.equal(VERIFY_PL.includes("'"), false);
  assert.equal(VERIFY_PL.includes("`"), false);
});

test("R11 perl compiles the verifier", { skip: PERL_ONLY }, () => {
  const result = spawnSync("perl", ["-c", "-e", VERIFY_PL]);
  assert.equal(result.status, 0, String(result.stderr));
});

test("R11 a module the verifier cannot load exits 75", {
  skip: PERL_ONLY,
}, () => {
  const lib = fresh("perl5lib");
  mkdirSync(join(lib, "Digest"));
  writeFileSync(
    join(lib, "Digest", "SHA.pm"),
    'package Digest::SHA; die "planted load failure\\n"; 1;\n',
  );
  const manifest = join(fresh("manifest"), "manifest");
  writeFileSync(manifest, "");
  const result = spawnSync(
    "perl",
    ["-e", VERIFY_PL, "--", manifest, sha256hex("")],
    { env: { ...process.env, PERL5LIB: lib } },
  );
  assert.equal(result.status, 75, String(result.stderr));
  assert.ok(
    String(result.stderr).includes(
      "rust-container: verify: cannot check the tree (planted load failure)",
    ),
    String(result.stderr),
  );
});

test("R11 the verifier passes a die a module catches while loading", {
  skip: PERL_ONLY,
}, () => {
  const lib = fresh("perl5lib");
  mkdirSync(join(lib, "Digest"));
  // Digest::SHA requires Digest::base inside an eval of its own.
  writeFileSync(
    join(lib, "Digest", "base.pm"),
    'package Digest::base; print STDERR "stub loaded\\n"; die "optional module failed\\n";\n',
  );
  const manifest = join(fresh("manifest"), "manifest");
  writeFileSync(manifest, "");
  const result = spawnSync(
    "perl",
    ["-e", VERIFY_PL, "--", manifest, sha256hex("")],
    { cwd: fresh("tree"), env: { ...process.env, PERL5LIB: lib } },
  );
  assert.ok(
    String(result.stderr).includes("stub loaded"),
    String(result.stderr),
  );
  assert.equal(result.status, 0, String(result.stderr));
});

test("R11 a multi-line load failure names its first line", {
  skip: PERL_ONLY,
}, () => {
  const lib = fresh("perl5lib");
  mkdirSync(join(lib, "Digest"));
  writeFileSync(
    join(lib, "Digest", "SHA.pm"),
    'package Digest::SHA; die "first line\\nsecond line\\n"; 1;\n',
  );
  const manifest = join(fresh("manifest"), "manifest");
  writeFileSync(manifest, "");
  const result = spawnSync(
    "perl",
    ["-e", VERIFY_PL, "--", manifest, sha256hex("")],
    { cwd: fresh("tree"), env: { ...process.env, PERL5LIB: lib } },
  );
  assert.equal(result.status, 75, String(result.stderr));
  assert.equal(
    String(result.stderr),
    "rust-container: verify: cannot check the tree (first line)\n",
  );
});

const hashesOf = (tree) =>
  new Map([...tree.files].map(([path, file]) => [path, file.hash]));

test("R11 a real readTree snapshot syncs full then delta and verifies", {
  skip: SYNC_ONLY,
}, () => {
  const host = fresh("host");
  const utf8Name = Buffer.from([0x75, 0xc3, 0xa9, 0x2e, 0x74, 0x78, 0x74]);
  const contents = new Map([
    ["a.txt", "a1\n"],
    ["sub/b.txt", "b\n"],
    ["run.sh", "#!/bin/sh\n"],
    ["with space.txt", "s\n"],
    [utf8Name.toString(), "u\n"],
    ["new\nline.txt", "n\n"],
  ]);
  for (const [name, data] of contents) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), data);
  }
  const rows = [...contents.keys(), "gone.txt"].map(treeRow);
  const options = { modes: new Map([["run.sh", "100755"]]) };
  const tree = readTree(host, rows, undefined, options);
  const plan = planSync({ files: hashesOf(tree), cache: null });
  const first = buildSyncArchive(tree, plan, ID_A);
  const vol = fresh("vol");
  const full = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_A, first.digest],
    first.archive,
  );
  assert.equal(full.status, 0, full.stderr);
  assert.equal(
    sha256hex(readFileSync(join(vol, ".sync-manifest"))),
    first.digest,
  );
  assert.ok(statSync(join(vol, "tree", "run.sh")).mode & 0o100);
  writeFileSync(join(host, "a.txt"), "a2\n");
  const again = readTree(host, rows, undefined, options);
  const delta = planSync({
    files: hashesOf(again),
    cache: {
      version: 5,
      syncId: ID_A,
      digest: first.digest,
      files: Object.fromEntries(hashesOf(tree)),
      missing: [...tree.missing].sort(),
    },
  });
  assert.equal(delta.mode, "delta");
  assert.deepEqual(delta.send, ["a.txt"]);
  const second = buildSyncArchive(again, delta, ID_B);
  const result = runSync(
    SYNC_SCRIPT,
    ["delta", vol, ID_A, delta.prevDigest, ID_B, second.digest],
    second.archive,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(vol, ".sync-id"), "utf8"), `${ID_B}\n`);
});

const KEEP = "keep\n";
const VERIFIED_FILES = [
  ["keep.txt", KEEP],
  ["src/deep/mod.rs", "mod\n"],
  ["run.sh", "#!/bin/sh\n", 0o755],
  ["\n", "nl\n"],
];

/** A volume fully synced from VERIFIED_FILES with gone.txt absent. */
function verifiedVolume() {
  const vol = fresh("vol");
  const archive = syncArchive({
    files: VERIFIED_FILES,
    absent: ["gone.txt"],
    end: ID_A,
  });
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_A, archive.digest],
    archive,
  );
  assert.equal(result.status, 0, result.stderr);
  return { vol, tree: join(vol, "tree"), digest: archive.digest };
}

/** A delta sending c.txt onto a verifiedVolume. */
function deltaOnto(v, env) {
  const archive = syncArchive({ files: [["c.txt", "c\n"]], end: ID_B });
  return runSync(
    SYNC_SCRIPT,
    deltaArgs(v.vol, v.digest, archive),
    archive,
    root,
    env,
  );
}

// The manifest's state without reading a FIFO (a read would block).
function manifestState(vol) {
  const file = join(vol, ".sync-manifest");
  const stat = lstatSyncOrNull(file);
  if (stat === null) return "absent";
  if (!stat.isFile()) return stat.isFIFO() ? "fifo" : "other";
  return readFileSync(file).toString("base64");
}

function lstatSyncOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

const OLD = new Date("2001-01-01T00:00:00Z");

test("R11 a delta into a tree that fails the content check exits 75 and changes nothing", {
  skip: SYNC_ONLY,
}, () => {
  const cases = [
    [
      "rewrite, mtime restored",
      "content or mode differs: keep.txt",
      ({ tree }) => {
        const file = join(tree, "keep.txt");
        const stat = statSync(file);
        writeFileSync(file, "cargo\n");
        utimesSync(file, stat.atime, stat.mtime);
      },
    ],
    [
      "chmod +x",
      "content or mode differs: keep.txt",
      ({ tree }) => chmodSync(join(tree, "keep.txt"), 0o755),
    ],
    [
      "chmod -x",
      "content or mode differs: run.sh",
      ({ tree }) => chmodSync(join(tree, "run.sh"), 0o644),
    ],
    [
      "mv of an older file",
      "content or mode differs: keep.txt",
      ({ tree }) => {
        const older = join(tree, "older.txt");
        writeFileSync(older, "moved\n");
        utimesSync(older, OLD, OLD);
        renameSync(older, join(tree, "keep.txt"));
      },
    ],
    [
      "cp -p of an older file",
      "content or mode differs: keep.txt",
      ({ tree }) => {
        const copy = join(fresh("cp"), "copy.txt");
        writeFileSync(copy, "copied\n");
        copyFileSync(copy, join(tree, "keep.txt"));
        utimesSync(join(tree, "keep.txt"), OLD, OLD);
      },
    ],
    [
      "manifest removed",
      "cannot open the manifest",
      ({ vol }) => rmSync(join(vol, ".sync-manifest")),
    ],
    [
      "FIFO at the manifest",
      "the manifest is not a regular file",
      ({ vol }) => {
        rmSync(join(vol, ".sync-manifest"));
        const made = spawnSync("mkfifo", [join(vol, ".sync-manifest")]);
        assert.equal(made.status, 0, String(made.stderr));
      },
    ],
    [
      "hiding forge",
      "the manifest does not match the host",
      ({ vol, tree }) => {
        writeFileSync(join(tree, "keep.txt"), "cargo\n");
        const forged = VERIFIED_FILES.map((entry) =>
          entry[0] === "keep.txt" ? ["keep.txt", "cargo\n"] : entry,
        );
        writeFileSync(
          join(vol, ".sync-manifest"),
          manifestOf(forged, ["gone.txt"]),
        );
      },
    ],
    [
      "directory at an absent path",
      "an entry exists at an absent path: gone.txt",
      ({ tree }) => mkdirSync(join(tree, "gone.txt")),
    ],
    [
      "symlink at an absent path",
      "not a regular file or directory: gone.txt",
      ({ tree }) => symlinkSync("keep.txt", join(tree, "gone.txt")),
    ],
    [
      "FIFO in the tree",
      "not a regular file or directory: src/fifo",
      ({ tree }) => {
        const made = spawnSync("mkfifo", [join(tree, "src", "fifo")]);
        assert.equal(made.status, 0, String(made.stderr));
      },
    ],
    [
      "symlinked directory",
      "not a regular file or directory: src/deep",
      ({ tree }) => {
        const outside = join(fresh("outside"), "deep");
        renameSync(join(tree, "src", "deep"), outside);
        symlinkSync(outside, join(tree, "src", "deep"));
      },
    ],
    [
      "file replaced by a directory",
      "missing or not a regular file: keep.txt",
      ({ tree }) => {
        unlinkSync(join(tree, "keep.txt"));
        mkdirSync(join(tree, "keep.txt"));
      },
    ],
    [
      "newline-named file removed",
      "missing or not a regular file: \\x0a",
      ({ tree }) => unlinkSync(join(tree, "\n")),
    ],
    [
      "rewrite under a touched sync id",
      "content or mode differs: keep.txt",
      ({ vol, tree }) => {
        writeFileSync(join(tree, "keep.txt"), "cargo\n");
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(vol, ".sync-id"), later, later);
      },
    ],
  ];
  for (const [name, line, mutate] of cases) {
    const v = verifiedVolume();
    mutate(v);
    const manifest = manifestState(v.vol);
    const result = deltaOnto(v);
    assert.equal(result.status, 75, `${name}: ${result.stderr}`);
    assert.ok(
      result.stderr.includes(`rust-container: verify: ${line}`),
      `${name}: ${result.stderr}`,
    );
    assert.match(result.stderr, /changed since its last sync/, name);
    assert.equal(
      readFileSync(join(v.vol, ".sync-id"), "utf8"),
      `${ID_A}\n`,
      name,
    );
    assert.equal(manifestState(v.vol), manifest, name);
    assert.equal(lstatSyncOrNull(join(v.tree, "c.txt")), null, name);
  }
});

test("R11 an unreadable listed file fails the check", {
  skip: SYNC_ONLY || (asRoot ? ROOT_SKIP : false),
}, () => {
  for (const [name, target, line] of [
    ["file", (v) => join(v.tree, "keep.txt"), "cannot open keep.txt"],
    [
      "manifest",
      (v) => join(v.vol, ".sync-manifest"),
      "cannot open the manifest",
    ],
  ]) {
    const v = verifiedVolume();
    const file = target(v);
    chmodSync(file, 0);
    try {
      const result = deltaOnto(v);
      assert.equal(result.status, 75, `${name}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes(
          `rust-container: verify: ${line} (Permission denied)`,
        ),
        `${name}: ${result.stderr}`,
      );
      assert.equal(
        readFileSync(join(v.vol, ".sync-id"), "utf8"),
        `${ID_A}\n`,
        name,
      );
    } finally {
      chmodSync(file, 0o644);
    }
  }
});

test("R11 unlisted files and directories in the tree pass", {
  skip: SYNC_ONLY,
}, () => {
  const v = verifiedVolume();
  mkdirSync(join(v.tree, "gen", "schemas"), { recursive: true });
  writeFileSync(join(v.tree, "gen", "schemas", "app.json"), "{}\n");
  const result = deltaOnto(v);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(v.vol, ".sync-id"), "utf8"), `${ID_B}\n`);
});

test("R11 a delta never deletes or writes through a symlinked directory", {
  skip: SYNC_ONLY,
}, () => {
  const { vol, digest } = fullVolume({
    files: [
      ["src/deep/victim.rs", "victim\n"],
      ["keep.txt", KEEP],
    ],
  });
  const outside = fresh("outside");
  writeFileSync(join(outside, "victim.rs"), "victim\n");
  rmSync(join(vol, "tree", "src", "deep"), { recursive: true });
  symlinkSync(outside, join(vol, "tree", "src", "deep"));
  const archive = syncArchive({
    deletes: ["src/deep/victim.rs"],
    files: [["src/deep/mod.rs", "mod\n"]],
    end: ID_B,
  });
  const result = runSync(SYNC_SCRIPT, deltaArgs(vol, digest, archive), archive);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(existsSync(join(outside, "victim.rs")), true);
  assert.equal(existsSync(join(outside, "mod.rs")), false);
});

test("R11 a sync whose result does not match its manifest exits 75 and records no id", {
  skip: SYNC_ONLY,
}, () => {
  const vol = fresh("vol");
  const archive = syncArchive({
    files: [["keep.txt", KEEP]],
    listed: [["keep.txt", "other bytes\n"]],
    end: ID_A,
  });
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_A, archive.digest],
    archive,
  );
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /does not match this sync/);
  assert.equal(existsSync(join(vol, ".sync-id")), false);
});

/** A dir holding a `perl` that exits 127, as a missing perl would. */
function perlStub() {
  const dir = fresh("perl-stub");
  writeFileSync(join(dir, "perl"), "#!/bin/sh\nexit 127\n");
  chmodSync(join(dir, "perl"), 0o755);
  return dir;
}

test("R11 a missing perl is a mismatch, never a pass", {
  skip: SYNC_ONLY,
}, () => {
  const vol = fresh("vol");
  const archive = syncArchive({ files: BASE_FILES, end: ID_A });
  const result = runSync(
    SYNC_SCRIPT,
    ["full", vol, "-", "-", ID_A, archive.digest],
    archive,
    root,
    { ...process.env, PATH: `${perlStub()}:${process.env.PATH}` },
  );
  assert.equal(result.status, 75, result.stderr);
  assert.equal(existsSync(join(vol, ".sync-id")), false);
});

// ------------------------------------------------ R12 cargo script (Linux)

const FAKE_CARGO = `#!/bin/bash
printf '%s\\0' "$@" > "$FAKE_ARGS"
pwd > "$FAKE_CWD"
case \${FAKE_MODE:-exit} in
  sleep) : > "$FAKE_READY"; exec sleep 30 ;;
  slow) sleep 1; exit "\${FAKE_EXIT:-0}" ;;
  rewrite) printf 'cargo wrote this\\n' > synced.txt; exit "\${FAKE_EXIT:-0}" ;;
  restamp) t=$(stat -c %Y synced.txt); printf 'cargo wrote this\\n' > synced.txt; touch -d "@$t" synced.txt; exit "\${FAKE_EXIT:-0}" ;;
  generate) mkdir -p gen; printf 'new\\n' > gen/out.txt; exit "\${FAKE_EXIT:-0}" ;;
  regenerate) printf 'g\\n' > gone.txt; exit "\${FAKE_EXIT:-0}" ;;
  delete) rm synced.txt; exit "\${FAKE_EXIT:-0}" ;;
  *) exit "\${FAKE_EXIT:-0}" ;;
esac
`;

const CARGO_TREE = ["synced.txt", "other.txt"];

/**
 * A source volume root (`src/`, the script's cwd) holding a synced tree, its
 * manifest (unless `manifest: false`) and a sync id, a target dir and a fake
 * cargo. Synced files predate the sync id, as after a real sync.
 */
function cargoVolume({ syncId = ID_A, manifest = true, absent = [] } = {}) {
  const vol = fresh("cargo-vol");
  const bin = join(vol, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cargo"), FAKE_CARGO);
  chmodSync(join(bin, "cargo"), 0o755);
  const src = join(vol, "src");
  const tree = join(src, "tree");
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(vol, "target"));
  const old = new Date(Date.now() - 120_000);
  for (const name of CARGO_TREE) {
    writeFileSync(join(tree, name), `${name}\n`);
    utimesSync(join(tree, name), old, old);
  }
  const bytes = manifestOf(
    CARGO_TREE.map((name) => [name, `${name}\n`]),
    absent,
  );
  if (manifest) writeFileSync(join(src, ".sync-manifest"), bytes);
  writeFileSync(join(src, ".sync-id"), `${syncId}\n`);
  const synced = new Date(Date.now() - 60_000);
  utimesSync(join(src, ".sync-id"), synced, synced);
  return {
    vol,
    src,
    tree,
    digest: sha256hex(bytes),
    target: join(vol, "target"),
    argsFile: join(vol, "args"),
    cwdFile: join(vol, "cwd"),
    readyFile: join(vol, "ready"),
  };
}

function runCargo(script, args, setup, { env = {}, closeWhenReady } = {}) {
  return new Promise((done, reject) => {
    const child = spawn("bash", ["-c", script, "cargo-test", ...args], {
      cwd: setup.src,
      env: {
        PATH: `${join(setup.vol, "bin")}:${process.env.PATH}`,
        FAKE_ARGS: setup.argsFile,
        FAKE_CWD: setup.cwdFile,
        FAKE_READY: setup.readyFile,
        GD_IMAGE: "img-a",
        GD_SYNC_ID: ID_A,
        GD_SYNC_DIGEST: setup.digest,
        CARGO_TARGET_DIR: setup.target,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let exit;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.stdin.on("error", () => {});
    // Closes stdin only once the fake cargo says it runs: no timing race.
    const poll = closeWhenReady
      ? setInterval(() => {
          if (!existsSync(setup.readyFile)) return;
          clearInterval(poll);
          child.stdin.end();
        }, 10)
      : null;
    const hang = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearInterval(poll);
      clearTimeout(hang);
      child.stdin.end();
      exit = { code, signal };
    });
    child.on("close", () => done({ ...exit, stderr }));
  });
}

function receivedArgs(setup) {
  return readFileSync(setup.argsFile, "utf8").split("\0").slice(0, -1);
}

const CARGO_PREFIX = ["test", "--manifest-path", "src-tauri/Cargo.toml"];
const HOSTILE_ARGS = ["a b", "$(touch pwned)", "--lib", ""];
const changedLine = (detail) =>
  `rust-container: cargo changed the source volume's tree (${detail}); the next run does a full sync`;
const SYNCED = { absent: ["gone.txt"] };

test("R12 cargo args arrive verbatim as positional parameters, in the tree", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, HOSTILE_ARGS, setup);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(receivedArgs(setup), [...CARGO_PREFIX, ...HOSTILE_ARGS]);
  assert.equal(readFileSync(setup.cwdFile, "utf8").trim(), setup.tree);
  assert.equal(existsSync(join(setup.tree, "pwned")), false);
  assert.equal(existsSync(join(setup.src, "pwned")), false);
});

test("R12 control: unquoted $* splits the args", {
  skip: CARGO_ONLY,
}, async () => {
  const split = mutated(CARGO_SCRIPT, '"$@" 9>&- &', "$* 9>&- &");
  const setup = cargoVolume();
  const result = await runCargo(split, ["a b", "--lib"], setup);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(receivedArgs(setup), [...CARGO_PREFIX, "a", "b", "--lib"]);
});

test("R12 cargo's exit code is the script's", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], setup, {
    env: { FAKE_EXIT: "101" },
  });
  assert.equal(result.code, 101, result.stderr);
});

test("R12 another sync id or no tree exits 75 before cargo", {
  skip: CARGO_ONLY,
}, async () => {
  const other = cargoVolume({ syncId: ID_B });
  const result = await runCargo(CARGO_SCRIPT, [], other);
  assert.equal(result.code, 75, result.stderr);
  assert.equal(existsSync(other.argsFile), false);
  const treeless = cargoVolume();
  rmSync(treeless.tree, { recursive: true });
  const none = await runCargo(CARGO_SCRIPT, [], treeless);
  assert.equal(none.code, 75, none.stderr);
  assert.equal(existsSync(treeless.argsFile), false);
  assert.equal(existsSync(treeless.tree), false);
});

test("R12 a held volume lock exits 73 before cargo", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const holder = await holdVolumeLock(setup.src);
  try {
    const result = await runCargo(CARGO_SCRIPT, [], setup);
    assert.equal(result.code, 73, result.stderr);
    assert.equal(existsSync(setup.argsFile), false);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("R12 the target volume is cleared when its image marker differs", {
  skip: CARGO_ONLY,
}, async () => {
  const marker = (setup) => join(setup.target, ".gd-rust-container-image");
  const seed = (setup, markerText) => {
    mkdirSync(join(setup.target, "debug"));
    writeFileSync(join(setup.target, "debug", "junk"), "old build\n");
    if (markerText !== undefined) writeFileSync(marker(setup), markerText);
  };
  const cases = [
    { name: "missing", markerText: undefined, kept: false },
    { name: "equal", markerText: "img-a\n", kept: true },
    { name: "different", markerText: "img-old\n", kept: false },
  ];
  for (const { name, markerText, kept } of cases) {
    const setup = cargoVolume();
    seed(setup, markerText);
    const result = await runCargo(CARGO_SCRIPT, [], setup);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.equal(existsSync(join(setup.target, "debug", "junk")), kept, name);
    assert.equal(readFileSync(marker(setup), "utf8"), "img-a\n", name);
  }
});

test("R12 a synced file cargo rewrote voids the sync id; cargo's code stays", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], setup, {
    env: { FAKE_MODE: "rewrite", FAKE_EXIT: "101" },
  });
  assert.equal(result.code, 101, result.stderr);
  assert.ok(
    result.stderr.includes(changedLine("content or mode differs: synced.txt")),
    result.stderr,
  );
  assert.equal(existsSync(join(setup.src, ".sync-id")), false);
});

test("R12 a file cargo generated keeps the sync id; no manifest exits 75 before cargo", {
  skip: CARGO_ONLY,
}, async () => {
  const generated = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], generated, {
    env: { FAKE_MODE: "generate" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(generated.tree, "gen", "out.txt")));
  assert.equal(result.stderr.includes("cargo changed"), false, result.stderr);
  assert.equal(existsSync(join(generated.src, ".sync-id")), true);
  const bare = cargoVolume({ manifest: false });
  const rewrote = await runCargo(CARGO_SCRIPT, [], bare, {
    env: { FAKE_MODE: "rewrite" },
  });
  assert.equal(rewrote.code, 75, rewrote.stderr);
  assert.match(rewrote.stderr, /changed since its last sync/);
  assert.equal(existsSync(bare.argsFile), false);
  assert.equal(existsSync(join(bare.src, ".sync-id")), true);
});

test("R12 a tree changed since its sync exits 75 before cargo, id kept", {
  skip: CARGO_ONLY,
}, async () => {
  const cases = [
    ["rewritten", (tree) => rewriteLater(join(tree, "synced.txt"), "cargo\n")],
    ["deleted", (tree) => unlinkSync(join(tree, "synced.txt"))],
    [
      "absent now present",
      (tree) => writeFileSync(join(tree, "gone.txt"), "g"),
    ],
  ];
  for (const [name, drift] of cases) {
    const setup = cargoVolume(SYNCED);
    drift(setup.tree);
    const result = await runCargo(CARGO_SCRIPT, [], setup);
    assert.equal(result.code, 75, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /changed since its last sync/, name);
    assert.equal(existsSync(setup.argsFile), false, name);
    assert.equal(existsSync(join(setup.src, ".sync-id")), true, name);
  }
});

test("R12 the content check before cargo: a mismatch exits 75 and cargo never runs, id kept", {
  skip: CARGO_ONLY,
}, async () => {
  const cases = [
    [
      "rewrite, mtime restored",
      (setup) => {
        const file = join(setup.tree, "synced.txt");
        const stat = statSync(file);
        writeFileSync(file, "cargo\n");
        utimesSync(file, stat.atime, stat.mtime);
      },
    ],
    ["chmod +x", (setup) => chmodSync(join(setup.tree, "synced.txt"), 0o755)],
    ["no manifest", (setup) => rmSync(join(setup.src, ".sync-manifest"))],
    [
      "perl exits 127",
      (setup) => ({
        PATH: `${perlStub()}:${join(setup.vol, "bin")}:${process.env.PATH}`,
      }),
    ],
    ["another digest", () => ({ GD_SYNC_DIGEST: "f".repeat(64) })],
  ];
  for (const [name, mutate] of cases) {
    const setup = cargoVolume();
    const env = mutate(setup) ?? {};
    const result = await runCargo(CARGO_SCRIPT, [], setup, { env });
    assert.equal(result.code, 75, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /changed since its last sync/, name);
    assert.equal(existsSync(setup.argsFile), false, name);
    assert.equal(existsSync(join(setup.src, ".sync-id")), true, name);
  }
});

test("R12 an unset GD_SYNC_DIGEST never runs cargo", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], setup, {
    env: { GD_SYNC_DIGEST: undefined },
  });
  assert.equal(result.code, 74, result.stderr);
  assert.equal(existsSync(setup.argsFile), false);
});

test("R12 missing or malformed run settings exit 74 before cargo", {
  skip: CARGO_ONLY,
}, async () => {
  const rows = [
    ["GD_SYNC_DIGEST unset", { GD_SYNC_DIGEST: undefined }],
    ["GD_SYNC_DIGEST empty", { GD_SYNC_DIGEST: "" }],
    ["GD_SYNC_DIGEST malformed", { GD_SYNC_DIGEST: "abc" }],
    ["GD_SYNC_ID unset", { GD_SYNC_ID: undefined }],
    ["GD_IMAGE unset", { GD_IMAGE: undefined }],
    ["GD_IMAGE empty", { GD_IMAGE: "" }],
    ["CARGO_TARGET_DIR unset", { CARGO_TARGET_DIR: undefined }],
  ];
  for (const [name, env] of rows) {
    const setup = cargoVolume();
    const result = await runCargo(CARGO_SCRIPT, [], setup, { env });
    assert.equal(result.code, 74, `${name}: ${result.stderr}`);
    assert.ok(
      result.stderr.includes(
        "rust-container: the cargo container started without valid run settings",
      ),
      `${name}: ${result.stderr}`,
    );
    assert.equal(existsSync(setup.argsFile), false, name);
  }
});

test("R12 a rewrite cargo hid with its old mtime voids the id", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], setup, {
    env: { FAKE_MODE: "restamp" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stderr.includes(changedLine("content or mode differs: synced.txt")),
    result.stderr,
  );
  assert.equal(existsSync(join(setup.src, ".sync-id")), false);
});

test("R12 cargo regenerating an absent path or deleting a synced one voids the id", {
  skip: CARGO_ONLY,
}, async () => {
  for (const [mode, exit, detail] of [
    ["regenerate", "101", "an entry exists at an absent path: gone.txt"],
    ["delete", "0", "missing or not a regular file: synced.txt"],
  ]) {
    const setup = cargoVolume(SYNCED);
    const result = await runCargo(CARGO_SCRIPT, [], setup, {
      env: { FAKE_MODE: mode, FAKE_EXIT: exit },
    });
    assert.equal(result.code, Number(exit), `${mode}: ${result.stderr}`);
    assert.ok(result.stderr.includes(changedLine(detail)), result.stderr);
    assert.equal(existsSync(join(setup.src, ".sync-id")), false, mode);
  }
});

test("R12 a failure before cargo starts exits 74", {
  skip: CARGO_ONLY,
}, async () => {
  const locked = cargoVolume(SYNCED);
  mkdirSync(join(locked.src, ".lock"));
  const lock = await runCargo(CARGO_SCRIPT, [], locked);
  assert.equal(lock.code, 74, lock.stderr);
  assert.equal(existsSync(locked.argsFile), false);
  const markerless = cargoVolume(SYNCED);
  const missing = join(markerless.vol, "no-such-target");
  const marker = await runCargo(CARGO_SCRIPT, [], markerless, {
    env: { CARGO_TARGET_DIR: missing },
  });
  assert.equal(marker.code, 74, marker.stderr);
  assert.equal(existsSync(markerless.argsFile), false);
});

test("R12 closing the script's stdin stops a running cargo", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], setup, {
    env: { FAKE_MODE: "sleep" },
    closeWhenReady: true,
  });
  // 143 = cargo ended by the watcher's SIGTERM; the hang guard is a SIGKILL.
  assert.equal(result.code, 143, `${result.signal}: ${result.stderr}`);
});

test("R12 with stdin open cargo runs to its own exit", {
  skip: CARGO_ONLY,
}, async () => {
  const setup = cargoVolume();
  const result = await runCargo(CARGO_SCRIPT, [], setup, {
    env: { FAKE_MODE: "slow", FAKE_EXIT: "7" },
  });
  assert.equal(result.code, 7, result.stderr);
});

test("R12 control: a watcher reading its own stdin kills cargo at once", {
  skip: CARGO_ONLY,
}, async () => {
  const plain = mutated(
    mutated(CARGO_SCRIPT, "exec 3<&0\n", ""),
    "cat <&3",
    "cat",
  );
  const setup = cargoVolume();
  const result = await runCargo(plain, [], setup, {
    env: { FAKE_MODE: "slow", FAKE_EXIT: "7" },
  });
  assert.equal(result.code, 143, `${result.signal}: ${result.stderr}`);
});

// ------------------------------------------------- R9, R13-R17 main

const TEST_ENV = {
  GD_RUST_CONTAINER_PORT: "40101",
  GD_FULL_SUITE_PORT: "40102",
};
const NOW = Date.UTC(2026, 10, 27, 12);
const TODAY = "2026-11-27";
const IMAGE = imageName(DOCKERFILE, "1.100.0");
const RUST1 = {
  Id: "sha256:old",
  Config: { Env: ["PATH=/usr/bin", "RUST_VERSION=1.100.0"] },
  RepoDigests: [DIGEST],
};
const EMPTY = Buffer.alloc(0);
const IMAGE_ID = `sha256:${sha256hex(IMAGE)}`;
const SUMMARY_FREE =
  /^rust-container: native lock \(port 40102\) was free at all \d+ checks during this run \(sampled every 3600s\)$/;

function flagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

// Members of a ustar archive with plain or prefix-split names.
function tarMembers(archive) {
  const members = [];
  let at = 0;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const nul = raw.indexOf(0);
      return raw.subarray(0, nul === -1 ? length : nul).toString("utf8");
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12), 8);
    members.push({
      name: prefix ? `${prefix}/${name}` : name,
      mode: Number.parseInt(field(100, 8), 8),
      data: Buffer.from(archive.subarray(at + 512, at + 512 + size)),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

function kindOf(args) {
  const [verb, sub] = args;
  if (verb === "image" && sub === "inspect") {
    return args[2] === "rust:1" ? "inspect rust:1" : "inspect image";
  }
  if (verb === "image" || verb === "volume") return `${verb} ${sub}`;
  if (verb === "run") {
    if (args.includes("rustc")) return "rustc";
    return flagValues(args, "--name")[0].includes("-sync-") ? "sync" : "cargo";
  }
  return verb;
}

const ok = (stdout = "") => ({
  code: 0,
  signal: null,
  stdout: Buffer.from(stdout),
  stderr: EMPTY,
  stdinError: null,
});
const fail = (code, stderr = "", stdout = "") => ({
  ...ok(stdout),
  code,
  stderr: Buffer.from(stderr),
});

/**
 * A docker inventory that answers the calls main makes. The source volume's
 * `.sync-id` is emulated, so delta preconditions and cargo's id check behave
 * like the container scripts; queued codes override them.
 */
function dockerFake(events) {
  const state = {
    reachable: true,
    rust1: RUST1,
    pulled: RUST1,
    pullCode: 0,
    images: new Set([IMAGE]),
    buildCode: 0,
    volumes: new Map(),
    inUse: new Set(),
    imageList: [],
    orphans: [],
    volumeId: null,
    volumeDigest: null,
    syncCodes: [],
    cargoCode: 0,
    cargoCodes: [],
    cargoHook: null,
    // kind -> a result returned for that call kind, before anything else.
    forced: new Map(),
  };
  const calls = [];
  let pid = 9000;
  async function docker(args, options = {}) {
    const kind = kindOf(args);
    events.push(kind);
    const call = { kind, args, options };
    calls.push(call);
    const start = (kill = () => {}) => options.onStart?.({ pid: ++pid, kill });
    if (state.forced.has(kind)) return state.forced.get(kind);
    switch (kind) {
      case "version":
        return state.reachable
          ? ok("29.0.0\n")
          : fail(1, "error during connect");
      case "ps":
        return ok(state.orphans.join("\n"));
      case "rm":
        return ok();
      case "inspect rust:1":
        return state.rust1
          ? ok(JSON.stringify([state.rust1]))
          : fail(1, "Error: No such image: rust:1", "[]");
      case "pull":
        start();
        if (state.pullCode !== 0) {
          return fail(
            state.pullCode,
            "Error response from daemon: offline\nmore",
          );
        }
        state.rust1 = state.pulled;
        return ok();
      case "rustc":
        return ok("rustc 1.100.0 (abc 2026-11-01)\n");
      case "inspect image":
        if (!state.images.has(args[2])) {
          return fail(
            1,
            `Error response from daemon: No such image: ${args[2]}`,
          );
        }
        return args.includes("--format")
          ? ok(`sha256:${sha256hex(args[2])}\n`)
          : ok("[{}]");
      case "build":
        start();
        if (state.buildCode !== 0) return fail(state.buildCode);
        state.images.add(flagValues(args, "-t")[0]);
        return ok();
      case "volume inspect":
        return state.volumes.has(args[2])
          ? ok(
              JSON.stringify([
                { Name: args[2], Labels: state.volumes.get(args[2]) },
              ]),
            )
          : fail(1, "no such volume", "[]");
      case "volume create": {
        const labels = Object.fromEntries(
          flagValues(args, "--label").map((label) => label.split(/=(.*)/s, 2)),
        );
        state.volumes.set(args.at(-1), labels);
        return ok(args.at(-1));
      }
      case "volume ls":
        return ok(
          [...state.volumes]
            .filter(([, labels]) => labels?.["gd.rust-container"] === "1")
            .map(([name]) => name)
            .join("\n"),
        );
      case "volume rm":
        if (state.inUse.has(args[2])) {
          return fail(
            1,
            `Error response from daemon: remove ${args[2]}: volume is in use`,
          );
        }
        state.volumes.delete(args[2]);
        return ok(args[2]);
      case "image ls":
        return ok(state.imageList.join("\n"));
      case "image rm":
        return ok();
      case "sync": {
        start();
        const [, mode, , prev, prevDigest, next, digest] = args.slice(
          args.indexOf("-c") + 2,
        );
        const members = tarMembers(options.input);
        call.sync = { mode, prev, prevDigest, next, digest, members };
        if (state.syncCodes.length > 0) {
          const forced = state.syncCodes.shift();
          if (typeof forced === "number") return fail(forced);
          return typeof forced === "function" ? forced(call) : forced;
        }
        if (
          mode === "delta" &&
          (prev !== state.volumeId || prevDigest !== state.volumeDigest)
        ) {
          return fail(75);
        }
        const end = members.at(-1);
        if (
          end.name !== ".gd-rust-container/end" ||
          String(end.data) !== next
        ) {
          return fail(3);
        }
        state.volumeId = next;
        state.volumeDigest = digest;
        return ok();
      }
      case "cargo": {
        const env = (name) =>
          flagValues(args, "-e")
            .find((entry) => entry.startsWith(`${name}=`))
            .slice(name.length + 1);
        call.syncId = env("GD_SYNC_ID");
        call.digest = env("GD_SYNC_DIGEST");
        if (state.cargoHook) return state.cargoHook(call, start);
        start();
        if (state.cargoCodes.length > 0) return fail(state.cargoCodes.shift());
        if (call.syncId !== state.volumeId) return fail(75);
        if (call.digest !== state.volumeDigest) return fail(75);
        return state.cargoCode === 0 ? ok() : fail(state.cargoCode);
      }
    }
    throw new Error(`unexpected docker call: ${args.join(" ")}`);
  }
  return { docker, state, calls, events };
}

function fakeLock(events, { degraded = false, signals } = {}) {
  const lock = { calls: [], children: [], released: 0, handlersAtAcquire: [] };
  lock.acquire = async (options) => {
    lock.calls.push(options);
    lock.handlersAtAcquire.push([...(signals?.handlers.keys() ?? [])]);
    events.push("lock");
    return {
      port: options.port,
      degraded,
      setChild: (pid) => lock.children.push(pid),
      release: async () => {
        lock.released += 1;
        events.push("release");
      },
    };
  };
  return lock;
}

function fakeSignals() {
  const handlers = new Map();
  return {
    handlers,
    on(signal, fn) {
      handlers.set(signal, [...(handlers.get(signal) ?? []), fn]);
    },
    removeListener(signal, fn) {
      const rest = (handlers.get(signal) ?? []).filter((h) => h !== fn);
      if (rest.length > 0) handlers.set(signal, rest);
      else handlers.delete(signal);
    },
    emit(signal) {
      for (const fn of handlers.get(signal) ?? []) fn(signal);
    },
  };
}

/** A readTree row for a path with LF index and worktree text and no attributes. */
function treeRow(path) {
  return { path, index: "lf", worktree: "lf", attrs: [] };
}

const row = (path, index = "lf", worktree = "crlf") =>
  `i/${index.padEnd(6)} w/${worktree.padEnd(6)} attr/                 \t${path}`;

const WORKTREE_FILES = {
  "src-tauri/Cargo.toml": '[package]\r\nname = "x"\r\n',
  "src-tauri/src/lib.rs": "fn a() {}\r\n",
};

/** A worktree on disk, a docker inventory with everything present, a lock. */
function scenario({
  files = WORKTREE_FILES,
  pulledToday = true,
  degraded = false,
} = {}) {
  const repoRoot = fresh("wt");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repoRoot, dirname(path)), { recursive: true });
    writeFileSync(join(repoRoot, path), content);
  }
  // Private, as ensurePrivateDir requires whatever the host's umask.
  const cacheDir = fresh("cache");
  chmodSync(cacheDir, 0o700);
  if (pulledToday) {
    writeFileSync(
      join(cacheDir, "rust1-pull.json"),
      JSON.stringify({ utcDate: TODAY }),
    );
  }
  const events = [];
  const fake = dockerFake(events);
  const signals = fakeSignals();
  const lock = fakeLock(events, { degraded, signals });
  const key = worktreeKey(repoRoot);
  const names = volumeNames(key);
  for (const role of ["src", "target", "cargo"]) {
    fake.state.volumes.set(names[role], {
      "gd.rust-container": "1",
      ...(role === "cargo" ? {} : { "gd.rust-container.worktree": repoRoot }),
    });
  }
  const s = {
    repoRoot,
    cacheDir,
    fake,
    lock,
    events,
    key,
    names,
    signals,
    rows: Object.keys(files).map((path) => row(path)),
    stage: [],
    autocrlf: "true",
    cacheFile: join(cacheDir, `sync-${names.src}.json`),
  };
  s.run = async (argv = ["test"], extra = {}) => {
    const lines = [];
    const code = await main(argv, {
      env: TEST_ENV,
      log: (line) => lines.push(line),
      repoRoot,
      cacheDir,
      sidecarDir: cacheDir,
      docker: fake.docker,
      acquire: lock.acquire,
      probe: async () => ({ state: "free" }),
      listTree: async () => ({
        eol: listing(s.rows),
        stage: listing(s.stage),
        autocrlf: s.autocrlf,
      }),
      signals: s.signals,
      now: () => NOW,
      monitorMs: 3_600_000,
      ...extra,
    });
    return { code, lines };
  };
  s.kinds = () => fake.calls.map((call) => call.kind);
  s.only = (kind) => fake.calls.filter((call) => call.kind === kind);
  return s;
}

const VOLUME_SETUP = ["volume inspect", "volume inspect", "volume inspect"];

function assertLine(lines, expected) {
  assert.ok(
    lines.includes(`rust-container: ${expected}`),
    `missing line ${JSON.stringify(expected)} in:\n${lines.join("\n")}`,
  );
}

test("R9 main refuses invalid or equal ports before docker or the lock", async () => {
  const s = scenario();
  for (const [env, pattern] of [
    [{ ...TEST_ENV, GD_FULL_SUITE_PORT: "abc" }, /GD_FULL_SUITE_PORT must be/],
    [
      { ...TEST_ENV, GD_RUST_CONTAINER_PORT: "80" },
      /GD_RUST_CONTAINER_PORT must be/,
    ],
    [
      { GD_RUST_CONTAINER_PORT: "40103", GD_FULL_SUITE_PORT: "40103" },
      /GD_RUST_CONTAINER_PORT and GD_FULL_SUITE_PORT both name port 40103/,
    ],
  ]) {
    const { code, lines } = await s.run(["test"], { env });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), pattern);
  }
  for (const argv of [
    [],
    ["bogus"],
    ["info", "x"],
    ["clean", "--stale", "--all"],
    ["clean", "--worktree"],
  ]) {
    const { code, lines } = await s.run(argv);
    assert.equal(code, 2, argv.join(" "));
    assert.match(lines[0], /^rust-container: usage: /);
  }
  assert.deepEqual(s.events, []);
});

test("R13 test happy path: call order, cargo argv, exit code and cache", async () => {
  const s = scenario();
  const { code, lines } = await s.run(["test", "--lib", "a b", ""]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(s.events, [
    "version",
    "lock",
    "ps",
    "inspect rust:1",
    "inspect image",
    ...VOLUME_SETUP,
    "sync",
    "cargo",
    "release",
  ]);
  const [lockCall] = s.lock.calls;
  assert.equal(lockCall.port, 40101);
  assert.equal(lockCall.record.suite, "test");
  assert.equal(lockCall.record.cwd, s.repoRoot);
  assert.ok(
    lockCall.sidecarFile.endsWith("gitdesktop-rust-container-40101.json"),
  );
  const [sync] = s.only("sync");
  const [cargo] = s.only("cargo");
  assert.equal(s.lock.children.length, 2);
  const args = cargo.args;
  assert.match(
    flagValues(args, "--name")[0],
    new RegExp(`^gd-rust-container-${s.key}-${process.pid}-test-[0-9a-f]{6}$`),
  );
  assert.deepEqual(flagValues(args, "--label"), [
    "gd.rust-container=1",
    "gd.rust-container.port=40101",
    `gd.rust-container.ns=${process.platform}`,
  ]);
  assert.deepEqual(args.slice(0, 6), [
    "run",
    "--rm",
    "--pull",
    "never",
    "-i",
    "--init",
  ]);
  assert.deepEqual(sync.args.slice(0, 6), args.slice(0, 6));
  assert.deepEqual(
    flagValues(sync.args, "--label"),
    flagValues(args, "--label"),
  );
  assert.equal(sync.args[sync.args.indexOf("bash") - 1], IMAGE_ID);
  assert.equal(args.includes("--network"), false);
  assert.deepEqual(flagValues(args, "-v"), [
    `${s.names.cargo}:/home/builder/.cargo-home`,
    `${s.names.target}:/home/builder/target`,
    `${s.names.src}:/home/builder/src`,
  ]);
  assert.deepEqual(flagValues(args, "-w"), ["/home/builder/src"]);
  assert.deepEqual(flagValues(args, "-e"), [
    `GD_IMAGE=${IMAGE_ID}`,
    `GD_SYNC_ID=${sync.sync.next}`,
    `GD_SYNC_DIGEST=${sync.sync.digest}`,
  ]);
  const bash = args.indexOf("bash");
  assert.equal(args[bash - 1], IMAGE_ID);
  assert.deepEqual(args.slice(bash), [
    "bash",
    "-c",
    CARGO_SCRIPT,
    "cargo-test",
    "--lib",
    "a b",
    "",
  ]);
  assert.equal(cargo.options.holdStdin, true);
  assert.equal(cargo.options.input, undefined);
  assert.deepEqual(flagValues(sync.args, "--network"), ["none"]);
  assert.deepEqual(sync.args.slice(sync.args.indexOf("bash")), [
    "bash",
    "-c",
    SYNC_SCRIPT,
    "sync",
    "full",
    "/home/builder/src",
    "-",
    "-",
    sync.sync.next,
    sync.sync.digest,
  ]);
  assert.match(sync.sync.next, /^[0-9a-f]{32}$/);
  const cache = JSON.parse(readFileSync(s.cacheFile, "utf8"));
  assert.equal(cache.version, 5);
  assert.deepEqual(cache.missing, []);
  assert.equal(cache.syncId, sync.sync.next);
  assert.equal(cache.digest, sync.sync.digest);
  assert.deepEqual(Object.keys(cache.files).sort(), [
    "dist/index.html",
    "src-tauri/Cargo.toml",
    "src-tauri/src/lib.rs",
  ]);
  assert.equal(
    cache.files["src-tauri/src/lib.rs"],
    fileHash("100644", Buffer.from("fn a() {}\n")),
  );
  const lib = sync.sync.members.find((m) => m.name === "src-tauri/src/lib.rs");
  assert.equal(String(lib.data), "fn a() {}\n");
  assert.equal(lib.mode, 0o644);
  assert.deepEqual(sync.sync.members.map((m) => m.name).slice(-2), [
    ".gd-rust-container/manifest",
    ".gd-rust-container/end",
  ]);
  const manifest = sync.sync.members.at(-2).data;
  const lf = (text) => Buffer.from(text.replaceAll("\r\n", "\n"));
  assert.ok(
    manifest.equals(
      syncManifest(
        new Map([
          ["dist/index.html", fileHash("100644", STUB_DIST.data)],
          [
            "src-tauri/Cargo.toml",
            fileHash("100644", lf(WORKTREE_FILES["src-tauri/Cargo.toml"])),
          ],
          [
            "src-tauri/src/lib.rs",
            fileHash("100644", lf(WORKTREE_FILES["src-tauri/src/lib.rs"])),
          ],
        ]),
        [],
      ),
    ),
  );
  assert.equal(sync.sync.digest, sha256hex(manifest));
  assert.deepEqual(s.lock.handlersAtAcquire, [[]]);
  assert.equal(s.only("ps")[0].options.timeoutMs, 120_000);
  assert.equal(cargo.options.timeoutMs, undefined);
  assert.equal(sync.options.timeoutMs, undefined);
  for (const line of [
    "native lock (port 40102): free at start",
    `image ${IMAGE} (rustc 1.100.0) ready`,
    "sync (full): 3 files sent in 0.0s",
    "cargo test exited 0 after 0.0s",
    "done in 0.0s (exit 0)",
  ]) {
    assertLine(lines, line);
  }
  assert.ok(lines.some((line) => SUMMARY_FREE.test(line)));
  assert.deepEqual([...s.signals.handlers.keys()], []);
});

test("R13 the cargo container's exit code is the run's", async () => {
  const s = scenario();
  s.fake.state.cargoCode = 101;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 101);
  assertLine(lines, "cargo test exited 101 after 0.0s");
  assertLine(lines, "done in 0.0s (exit 101)");
  assert.deepEqual(s.only("cargo")[0].args.slice(-1), ["cargo-test"]);
});

test("R13 a due daily check pulls rust:1 and inspects it again", async () => {
  for (const [pulled, line] of [
    [
      { ...RUST1, Id: "sha256:new" },
      "daily rust:1 check: pulled a newer rust:1 (rustc 1.100.0, unchanged)",
    ],
    [
      { ...RUST1, Id: "sha256:new", Config: { Env: ["RUST_VERSION=1.101.0"] } },
      "daily rust:1 check: pulled a newer rust:1 (rustc 1.100.0 -> 1.101.0)",
    ],
    [RUST1, "daily rust:1 check: up to date"],
  ]) {
    const s = scenario({ pulledToday: false });
    s.fake.state.pulled = pulled;
    const { code, lines } = await s.run(["test"]);
    assert.equal(code, 0);
    assert.deepEqual(s.events.slice(0, 7), [
      "version",
      "lock",
      "ps",
      "inspect rust:1",
      "pull",
      "inspect rust:1",
      "inspect image",
    ]);
    assertLine(lines, line);
    assert.deepEqual(
      JSON.parse(readFileSync(join(s.cacheDir, "rust1-pull.json"), "utf8")),
      {
        utcDate: TODAY,
      },
    );
  }
  const s = scenario({ pulledToday: false });
  s.fake.state.pullCode = 1;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0);
  assertLine(
    lines,
    "daily rust:1 check failed (Error response from daemon: offline); using the local rust:1",
  );
  assert.deepEqual(s.events.slice(3, 6), [
    "inspect rust:1",
    "pull",
    "inspect image",
  ]);
  assert.equal(
    JSON.parse(readFileSync(join(s.cacheDir, "rust1-pull.json"), "utf8"))
      .utcDate,
    TODAY,
  );
});

test("R13 a missing rust:1 is pulled first; no RUST_VERSION asks rustc; a missing image builds", async () => {
  const s = scenario({ pulledToday: false });
  s.fake.state.rust1 = null;
  s.fake.state.pulled = { ...RUST1, Config: { Env: ["PATH=/usr/bin"] } };
  s.fake.state.images.clear();
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(s.events.slice(0, 9), [
    "version",
    "lock",
    "ps",
    "inspect rust:1",
    "pull",
    "inspect rust:1",
    "rustc",
    "inspect image",
    "build",
  ]);
  assertLine(lines, "rust:1 is not pulled; pulling it");
  assertLine(lines, `building image ${IMAGE} (rustc 1.100.0)`);
  assertLine(lines, "image built in 0.0s");
  const [build] = s.only("build");
  assert.equal(
    String(build.options.input),
    buildDockerfile(DOCKERFILE, [DIGEST]),
  );
  assert.ok(String(build.options.input).startsWith(`FROM ${DIGEST}\n`));
  assert.deepEqual(flagValues(build.args, "--label"), [
    "gd.rust-container=1",
    "gd.rust-container.rustc=1.100.0",
  ]);
  assert.equal(build.args.at(-1), "-");
  assert.equal(s.lock.children.length, 4);
  // Only the optional daily pull is bounded.
  assert.equal(s.only("pull")[0].options.timeoutMs, undefined);
});

test("R13 missing volumes are created with their labels; orphans are reaped", async () => {
  const s = scenario();
  s.fake.state.volumes.clear();
  s.fake.state.orphans = ["abc", "def"];
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0);
  assert.deepEqual(s.only("rm")[0].args, ["rm", "-f", "abc", "def"]);
  assertLine(lines, "removed 2 orphaned container(s) left by a killed run");
  assert.deepEqual(s.only("ps")[0].args, [
    "ps",
    "-aq",
    "--filter",
    "label=gd.rust-container.port=40101",
    "--filter",
    `label=gd.rust-container.ns=${process.platform}`,
  ]);
  assert.deepEqual(Object.fromEntries(s.fake.state.volumes), {
    [s.names.src]: {
      "gd.rust-container": "1",
      "gd.rust-container.role": "src",
      "gd.rust-container.worktree": s.repoRoot,
      "gd.rust-container.platform": process.platform,
    },
    [s.names.target]: {
      "gd.rust-container": "1",
      "gd.rust-container.role": "target",
      "gd.rust-container.worktree": s.repoRoot,
      "gd.rust-container.platform": process.platform,
    },
    [s.names.cargo]: {
      "gd.rust-container": "1",
      "gd.rust-container.role": "cargo",
    },
  });
});

test("R13 the rustc fallback runs offline under the run's labels", async () => {
  const s = scenario();
  s.fake.state.rust1 = { ...RUST1, Config: { Env: ["PATH=/usr/bin"] } };
  assert.equal((await s.run(["test"])).code, 0);
  assert.deepEqual(s.only("rustc")[0].args, [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--network",
    "none",
    "--label",
    "gd.rust-container=1",
    "--label",
    "gd.rust-container.port=40101",
    "--label",
    `gd.rust-container.ns=${process.platform}`,
    "rust:1",
    "rustc",
    "--version",
  ]);
});

test("R13 a daily pull that times out falls back to the local rust:1", async () => {
  const s = scenario({ pulledToday: false });
  s.fake.state.forced.set("pull", {
    ...fail(null),
    signal: "SIGTERM",
    timedOut: true,
  });
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assertLine(
    lines,
    "daily rust:1 check failed (timed out after 600.0s); using the local rust:1",
  );
  assert.equal(s.only("pull")[0].options.timeoutMs, 600_000);
});

test("R14 docker unreachable exits 2 before the lock", async () => {
  const s = scenario();
  s.fake.state.reachable = false;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 2);
  assert.deepEqual(s.events, ["version"]);
  assert.deepEqual(lines, [
    "rust-container: cannot start: docker is not reachable (is Docker Desktop running?)",
  ]);
});

function assertFailedUnderLock(
  s,
  { code, lines },
  line,
  { cargo = false, label = line } = {},
) {
  assert.equal(code, 2, `${label}:\n${lines.join("\n")}`);
  assertLine(lines, line);
  assert.equal(s.lock.released, 1);
  assert.equal(s.events.at(-1), "release");
  assert.ok(
    lines.some((l) => SUMMARY_FREE.test(l)),
    lines.join("\n"),
  );
  assertLine(lines, "done in 0.0s (exit 2)");
  assert.equal(s.kinds().includes("cargo"), cargo);
  if (!cargo) assert.equal(existsSync(s.cacheFile), false, "cache written");
}

test("R14 failures under the lock exit 2, release and summarize", async () => {
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const cases = [
    [
      "sync exit 1",
      (s) => s.fake.state.syncCodes.push(1),
      "sync failed (exit 1)",
    ],
    [
      "sync exit 3",
      (s) => s.fake.state.syncCodes.push(3),
      "sync failed (exit 3)",
    ],
    [
      "sync exit 125",
      (s) => s.fake.state.syncCodes.push(125),
      "sync container could not start (docker exit 125)",
    ],
    [
      "sync stdin error",
      (s) => s.fake.state.syncCodes.push({ ...ok(), stdinError: epipe }),
      "sync failed: the archive was not fully written (EPIPE)",
    ],
    [
      "image build",
      (s) => {
        s.fake.state.images.clear();
        s.fake.state.buildCode = 1;
      },
      "image build failed (exit 1)",
    ],
    [
      "invalid listed path",
      (s) => s.rows.push(row("../escape")),
      'cannot read the worktree: listed path is not a valid tree path: "../escape"',
    ],
    [
      "unreadable listing record",
      (s) => s.rows.push("garbage"),
      'cannot list the worktree: unreadable ls-files --eol record: "garbage"',
    ],
    [
      "rust:1 missing and pull failing",
      (s) => {
        s.fake.state.rust1 = null;
        s.fake.state.pullCode = 1;
      },
      "could not pull rust:1 (Error response from daemon: offline)",
    ],
    [
      "full sync mismatch",
      (s) => s.fake.state.syncCodes.push(75),
      "the source volume does not match after a full sync",
    ],
  ];
  for (const [name, arrange, line] of cases) {
    const s = scenario();
    arrange(s);
    const result = await s.run(["test"]);
    assertFailedUnderLock(s, result, line, { label: name });
  }
  const s = scenario();
  s.fake.state.cargoCodes.push(125);
  const result = await s.run(["test"]);
  assertFailedUnderLock(
    s,
    result,
    "cargo container could not start (docker exit 125)",
    {
      cargo: true,
    },
  );
});

test("R14 a full sync's exit 75 fails at once, never as a cache mismatch", async () => {
  const s = scenario();
  s.fake.state.syncCodes.push(75);
  const result = await s.run(["test"]);
  assertFailedUnderLock(
    s,
    result,
    "the source volume does not match after a full sync",
  );
  assert.deepEqual(
    s.only("sync").map((call) => call.sync.mode),
    ["full"],
  );
  assert.equal(
    result.lines.some((l) =>
      l.includes("does not match this worktree's sync cache"),
    ),
    false,
    result.lines.join("\n"),
  );
});

test("R14 a delta's exit 75 then a full sync's exit 75 exits 2", async () => {
  const s = scenario();
  assert.equal((await s.run(["test"])).code, 0);
  writeFileSync(join(s.repoRoot, "src-tauri/src/lib.rs"), "fn h() {}\n");
  s.fake.state.syncCodes.push(75, 75);
  s.events.length = 0;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 2, lines.join("\n"));
  assertLine(lines, "the source volume does not match after a full sync");
  assert.deepEqual(
    s.only("sync").map((call) => call.sync.mode),
    ["full", "delta", "full"],
  );
  assertLine(
    lines,
    "source volume does not match this worktree's sync cache; doing a full sync",
  );
  assert.deepEqual(s.events.slice(-3), ["sync", "sync", "release"]);
  assert.equal(s.events.includes("cargo"), false);
  assert.equal(existsSync(s.cacheFile), false, "cache written");
});

test("R14 a held volume lock (exit 73) in either container exits 2", async () => {
  const line =
    "another run is using this worktree's source volume (its lock is held inside the volume)";
  const sync = scenario();
  sync.fake.state.syncCodes.push(73);
  assertFailedUnderLock(sync, await sync.run(["test"]), line);
  const cargo = scenario();
  cargo.fake.state.cargoCodes.push(73);
  assertFailedUnderLock(cargo, await cargo.run(["test"]), line, {
    cargo: true,
  });
});

test("R14 a cargo container failing before cargo starts (exit 74) exits 2", async () => {
  const s = scenario();
  s.fake.state.cargoCodes.push(74);
  assertFailedUnderLock(
    s,
    await s.run(["test"]),
    "the cargo container failed before cargo started (exit 74)",
    { cargo: true },
  );
  assert.equal(s.only("cargo").length, 1);
});

test("R14 a volume this worktree does not own stops the run before any sync", async () => {
  const s = scenario();
  s.fake.state.volumes.set(s.names.target, {
    "gd.rust-container": "1",
    "gd.rust-container.worktree": "/elsewhere/wt",
  });
  assertFailedUnderLock(
    s,
    await s.run(["test"]),
    `volume ${s.names.target} exists but is not this worktree's (worktree label: /elsewhere/wt); remove it with docker volume rm ${s.names.target} or run node scripts/rust-container.mjs clean --worktree /elsewhere/wt`,
  );
  assert.equal(s.kinds().includes("sync"), false);
  const bare = scenario();
  bare.fake.state.volumes.set(bare.names.cargo, null);
  assertFailedUnderLock(
    bare,
    await bare.run(["test"]),
    `the shared volume ${bare.names.cargo} exists without this tool's label; remove it with docker volume rm ${bare.names.cargo}`,
  );
  const unlabeled = scenario();
  unlabeled.fake.state.volumes.set(unlabeled.names.target, null);
  assertFailedUnderLock(
    unlabeled,
    await unlabeled.run(["test"]),
    `volume ${unlabeled.names.target} exists but is not this worktree's (worktree label: none); remove it with docker volume rm ${unlabeled.names.target}`,
  );
  const ownPath = scenario();
  ownPath.fake.state.volumes.set(ownPath.names.src, {
    "gd.rust-container.worktree": ownPath.repoRoot,
  });
  assertFailedUnderLock(
    ownPath,
    await ownPath.run(["test"]),
    `volume ${ownPath.names.src} is not labeled gd.rust-container=1; remove it with docker volume rm ${ownPath.names.src}`,
  );
  const same = scenario();
  same.fake.state.volumes.set(same.names.src, {
    "gd.rust-container": "1",
    "gd.rust-container.worktree": `${same.repoRoot}/`,
  });
  assert.equal((await same.run(["test"])).code, 0);
});

test("R14 an inspect failing for any reason but absence is a failure", async () => {
  const s = scenario();
  s.fake.state.forced.set(
    "volume inspect",
    fail(1, "Error response from daemon: connection refused"),
  );
  assertFailedUnderLock(
    s,
    await s.run(["test"]),
    `\`docker volume inspect ${s.names.src}\` failed (Error response from daemon: connection refused)`,
  );
  const info = scenario();
  info.fake.state.forced.set("inspect rust:1", fail(1, "error during connect"));
  const result = await info.run(["info"]);
  assert.equal(result.code, 2);
  assertLine(
    result.lines,
    "`docker image inspect rust:1` failed (error during connect)",
  );
  const image = scenario();
  image.fake.state.forced.set("inspect image", fail(1, "context canceled"));
  assertFailedUnderLock(
    image,
    await image.run(["test"]),
    `\`docker image inspect ${IMAGE}\` failed (context canceled)`,
  );
});

test("R14 a short docker call that times out fails the run", async () => {
  const timedOut = { ...fail(null), signal: "SIGTERM", timedOut: true };
  const s = scenario();
  s.fake.state.forced.set("ps", timedOut);
  assertFailedUnderLock(
    s,
    await s.run(["test"]),
    "`docker ps` timed out after 120.0s",
  );
  const early = scenario();
  early.fake.state.forced.set("version", timedOut);
  const result = await early.run(["test"]);
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, [
    "rust-container: cannot start: `docker version` timed out after 120.0s",
  ]);
  assert.equal(early.lock.calls.length, 0);
});

test("R14 a short archive at exit 0, docker not running and a start failure each fail in one line", async () => {
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const short = scenario();
  short.fake.state.syncCodes.push({ ...ok(), stdinError: epipe });
  const shortRun = await short.run(["test"]);
  assertFailedUnderLock(
    short,
    shortRun,
    "sync failed: the archive was not fully written (EPIPE)",
  );
  assert.deepEqual(
    shortRun.lines.filter(
      (l) => l.includes("not fully written") || l.includes("(exit 0)"),
    ),
    ["rust-container: sync failed: the archive was not fully written (EPIPE)"],
  );
  const enoent = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
  });
  const notRun = { ...fail(null), error: enoent };
  for (const [kind, arrange, cargo] of [
    ["sync", () => {}, false],
    ["build", (s) => s.fake.state.images.clear(), false],
    ["cargo", () => {}, true],
  ]) {
    const s = scenario();
    arrange(s);
    s.fake.state.forced.set(kind, notRun);
    const result = await s.run(["test"]);
    assertFailedUnderLock(s, result, "could not run docker (ENOENT)", {
      cargo,
      label: kind,
    });
    assert.equal(
      result.lines.some((l) => l.includes("exit ENOENT")),
      false,
      kind,
    );
  }
  // Docker failing to start a delta's container is not retried in full.
  const delta = scenario();
  assert.equal((await delta.run(["test"])).code, 0);
  writeFileSync(join(delta.repoRoot, "src-tauri/src/lib.rs"), "fn f() {}\n");
  delta.fake.state.syncCodes.push(125);
  delta.lock.released = 0;
  const result = await delta.run(["test"]);
  assertFailedUnderLock(
    delta,
    result,
    "sync container could not start (docker exit 125)",
    { cargo: true },
  );
  assert.deepEqual(
    delta.only("sync").map((call) => call.sync.mode),
    ["full", "delta"],
  );
  assert.equal(
    result.lines.some((l) => l.includes("retrying with a full sync")),
    false,
  );
});

test("R15 a second run sends exactly the changed file, deletes first, sentinel last", async () => {
  const s = scenario();
  assert.equal((await s.run(["test"])).code, 0);
  const first = s.only("sync")[0].sync;
  writeFileSync(join(s.repoRoot, "src-tauri/src/lib.rs"), "fn b() {}\r\n");
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0);
  const second = s.only("sync")[1].sync;
  assert.equal(second.mode, "delta");
  assert.equal(second.prev, first.next);
  assert.equal(second.prevDigest, first.digest);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(
    second.members.map((m) => m.name),
    [
      ".gd-rust-container/deletes",
      "src-tauri/src/lib.rs",
      ".gd-rust-container/manifest",
      ".gd-rust-container/end",
    ],
  );
  assert.equal(second.members[0].data.length, 0);
  assert.equal(String(second.members[1].data), "fn b() {}\n");
  assert.equal(String(second.members[3].data), second.next);
  assertLine(lines, "sync (delta): 1 changed, 0 deleted, 2 unchanged in 0.0s");
  assert.equal(s.only("cargo")[1].syncId, second.next);
  assert.equal(s.only("cargo")[1].digest, second.digest);
  assert.equal(
    JSON.parse(readFileSync(s.cacheFile, "utf8")).syncId,
    second.next,
  );
});

test("R15 nothing changed skips the sync container and runs on the cached id", async () => {
  const s = scenario();
  await s.run(["test"]);
  const cached = JSON.parse(readFileSync(s.cacheFile, "utf8")).syncId;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0);
  assert.equal(s.only("sync").length, 1);
  assert.equal(s.only("cargo")[1].syncId, cached);
  assert.equal(s.only("cargo")[1].digest, s.only("sync")[0].sync.digest);
  assertLine(lines, "sync (delta): nothing changed (3 files) in 0.0s");
});

test("R15 cargo exit 75 after a skipped sync does one full sync and one re-run", async () => {
  const s = scenario();
  await s.run(["test"]);
  s.fake.state.volumeId = ID_C;
  s.events.length = 0;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(s.events.slice(-4), ["cargo", "sync", "cargo", "release"]);
  assert.equal(s.only("sync")[1].sync.mode, "full");
  assertLine(
    lines,
    "source volume does not match this worktree's sync cache; doing a full sync",
  );
  assert.equal(s.only("cargo")[2].syncId, s.only("sync")[1].sync.next);
  assert.equal(
    JSON.parse(readFileSync(s.cacheFile, "utf8")).syncId,
    s.only("sync")[1].sync.next,
  );
});

test("R15 cargo exit 75 again after the recovery sync exits 2", async () => {
  const s = scenario();
  await s.run(["test"]);
  s.fake.state.volumeId = ID_C;
  s.fake.state.cargoCodes.push(75, 75);
  s.events.length = 0;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 2, lines.join("\n"));
  assertLine(lines, "the source volume does not hold this run's sync");
  assert.deepEqual(s.events.slice(-4), ["cargo", "sync", "cargo", "release"]);
  assert.equal(s.only("sync")[1].sync.mode, "full");
  assert.ok(lines.some((l) => SUMMARY_FREE.test(l)));
});

test("R15 cargo exit 75 right after this run's sync exits 2", async () => {
  const s = scenario();
  s.fake.state.cargoCodes.push(75);
  const result = await s.run(["test"]);
  assertFailedUnderLock(
    s,
    result,
    "the source volume does not hold this run's sync; is another run using it?",
    { cargo: true },
  );
  assert.equal(s.only("cargo").length, 1);
});

test("R15 sync exit 75 drops the cache and re-syncs in full", async () => {
  const s = scenario();
  await s.run(["test"]);
  s.fake.state.volumeId = ID_C;
  writeFileSync(join(s.repoRoot, "src-tauri/src/lib.rs"), "fn c() {}\n");
  s.events.length = 0;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(s.events.slice(-4), ["sync", "sync", "cargo", "release"]);
  const [, delta, full] = s.only("sync").map((call) => call.sync);
  assert.equal(delta.mode, "delta");
  assert.equal(full.mode, "full");
  assert.equal(full.members.length, 6);
  assertLine(
    lines,
    "source volume does not match this worktree's sync cache; doing a full sync",
  );
  assertLine(lines, "sync (full): 3 files sent in 0.0s");
});

test("R15 a tracked file gone from disk is deleted; a nested repo row is skipped", async () => {
  const s = scenario({ files: { ...WORKTREE_FILES, "gone.txt": "x\n" } });
  await s.run(["test"]);
  unlinkSync(join(s.repoRoot, "gone.txt"));
  s.rows = s.rows.map((r) =>
    r.endsWith("\tgone.txt") ? row("gone.txt", "lf", "") : r,
  );
  s.rows.push(row("nested/", "", ""));
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0);
  const delta = s.only("sync")[1].sync;
  assert.deepEqual(
    delta.members.map((m) => m.name),
    [
      ".gd-rust-container/deletes",
      ".gd-rust-container/manifest",
      ".gd-rust-container/end",
    ],
  );
  assert.equal(String(delta.members[0].data), "gone.txt\0");
  const cached = JSON.parse(readFileSync(s.cacheFile, "utf8"));
  const manifest = syncManifest(new Map(Object.entries(cached.files)), [
    "gone.txt",
  ]);
  assert.ok(delta.members[1].data.equals(manifest));
  assert.equal(delta.digest, sha256hex(manifest));
  assert.equal(cached.digest, delta.digest);
  assertLine(
    lines,
    "sync: 1 tracked path(s) missing from disk are treated as deleted (first: gone.txt)",
  );
  assertLine(
    lines,
    "sync: skipped 1 listed path(s) that are not regular files (first: nested/)",
  );
  assertLine(lines, "sync (delta): 0 changed, 1 deleted, 3 unchanged in 0.0s");
  assert.equal(
    "gone.txt" in JSON.parse(readFileSync(s.cacheFile, "utf8")).files,
    false,
  );
});

test("R15 index modes reach the archive; a mode-only change is a delta", async () => {
  const s = scenario({
    files: { ...WORKTREE_FILES, "run.sh": "#!/bin/sh\n", link: "lib.rs" },
  });
  const sha = "0".repeat(40);
  s.stage = [`100755 ${sha} 0\trun.sh`, `120000 ${sha} 0\tlink`];
  const first = await s.run(["test"]);
  assert.equal(first.code, 0, first.lines.join("\n"));
  const members = s.only("sync")[0].sync.members;
  assert.equal(members.find((m) => m.name === "run.sh").mode, 0o755);
  assert.equal(members.find((m) => m.name === "link").mode, 0o644);
  assertLine(
    first.lines,
    "sync: 1 tracked symlink(s) arrive as regular files (first: link)",
  );
  s.stage = [`100644 ${sha} 0\trun.sh`, `120000 ${sha} 0\tlink`];
  assert.equal((await s.run(["test"])).code, 0);
  const delta = s.only("sync")[1].sync;
  assert.equal(delta.mode, "delta");
  assert.deepEqual(
    delta.members.map((m) => m.name),
    [
      ".gd-rust-container/deletes",
      "run.sh",
      ".gd-rust-container/manifest",
      ".gd-rust-container/end",
    ],
  );
  assert.equal(delta.members[1].mode, 0o644);
});

test("R15 a failed delta sync retries once in full; a failed full sync exits 2", async () => {
  const s = scenario();
  assert.equal((await s.run(["test"])).code, 0);
  writeFileSync(join(s.repoRoot, "src-tauri/src/lib.rs"), "fn d() {}\n");
  s.fake.state.syncCodes.push(2);
  s.events.length = 0;
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(s.events.slice(-4), ["sync", "sync", "cargo", "release"]);
  const [, delta, full] = s.only("sync").map((call) => call.sync);
  assert.equal(delta.mode, "delta");
  assert.equal(full.mode, "full");
  assertLine(lines, "sync (delta) failed (exit 2); retrying with a full sync");
  assertLine(lines, "sync (full): 3 files sent in 0.0s");
  assert.equal(JSON.parse(readFileSync(s.cacheFile, "utf8")).syncId, full.next);
  const twice = scenario();
  assert.equal((await twice.run(["test"])).code, 0);
  writeFileSync(join(twice.repoRoot, "src-tauri/src/lib.rs"), "fn e() {}\n");
  twice.fake.state.syncCodes.push(2, 2);
  twice.events.length = 0;
  twice.lock.released = 0;
  const result = await twice.run(["test"]);
  assertFailedUnderLock(twice, result, "sync failed (exit 2)", {
    cargo: true,
  });
  assert.equal(twice.only("cargo").length, 1);
  assert.equal(existsSync(twice.cacheFile), false);
});

test("R15 a delta that exits 73, exits 2 on a short archive or is stopped is not retried in full", async () => {
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const deltaRun = async (forced) => {
    const s = scenario();
    assert.equal((await s.run(["test"])).code, 0);
    writeFileSync(join(s.repoRoot, "src-tauri/src/lib.rs"), "fn g() {}\n");
    s.fake.state.syncCodes.push(forced(s));
    s.lock.released = 0;
    const result = await s.run(["test"]);
    assert.deepEqual(
      s.only("sync").map((call) => call.sync.mode),
      ["full", "delta"],
    );
    assert.equal(s.only("cargo").length, 1);
    assert.equal(
      result.lines.some((l) => l.includes("retrying with a full sync")),
      false,
    );
    return { s, result };
  };
  const locked = await deltaRun(() => 73);
  assertFailedUnderLock(
    locked.s,
    locked.result,
    "another run is using this worktree's source volume (its lock is held inside the volume)",
    { cargo: true },
  );
  const short = await deltaRun(() => ({ ...fail(2), stdinError: epipe }));
  assertFailedUnderLock(short.s, short.result, "sync failed (exit 2)", {
    cargo: true,
  });
  const stopped = await deltaRun(
    (s) => () =>
      new Promise((done) => {
        setImmediate(() => {
          s.signals.emit("SIGTERM");
          done(fail(137));
        });
      }),
  );
  assert.equal(stopped.result.code, 1);
  assert.equal(stopped.s.lock.released, 1);
});

test("R15 a failed cache write leaves no temp file and the run goes on", async () => {
  const s = scenario();
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  const { code, lines } = await s.run(["test"], {
    fs: {
      rename: () => {
        throw busy;
      },
    },
  });
  assert.equal(code, 0);
  assertLine(
    lines,
    "could not write the sync cache (EBUSY); the next run does a full sync",
  );
  assert.deepEqual(
    readdirSync(s.cacheDir).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("R15 a cache write failing after its temp was created removes the temp", async () => {
  const s = scenario();
  const full = Object.assign(new Error("full"), { code: "ENOSPC" });
  const { code, lines } = await s.run(["test"], {
    fs: {
      writeFile: () => {
        throw full;
      },
    },
  });
  assert.equal(code, 0, lines.join("\n"));
  assertLine(
    lines,
    "could not write the sync cache (ENOSPC); the next run does a full sync",
  );
  assert.deepEqual(
    readdirSync(s.cacheDir).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.equal(existsSync(s.cacheFile), false);
});

test("R15 a cache temp this run could not create is never removed", async () => {
  for (const errCode of ["EEXIST", "EACCES"]) {
    const s = scenario();
    const removed = [];
    const { code, lines } = await s.run(["test"], {
      fs: {
        open: () => {
          throw Object.assign(new Error(errCode), { code: errCode });
        },
        rm: (path, options) => {
          removed.push(path);
          rmSync(path, options);
        },
      },
    });
    assert.equal(code, 0, `${errCode}\n${lines.join("\n")}`);
    assertLine(
      lines,
      `could not write the sync cache (${errCode}); the next run does a full sync`,
    );
    assert.deepEqual(
      removed.filter((path) => path.endsWith(".tmp")),
      [],
      errCode,
    );
  }
});

test("R15 a listed dist/index.html is replaced by CI's stub", async () => {
  const s = scenario({
    files: { ...WORKTREE_FILES, "dist/index.html": "<p>built</p>\n" },
  });
  assert.equal((await s.run(["test"])).code, 0);
  const member = s
    .only("sync")[0]
    .sync.members.find((m) => m.name === "dist/index.html");
  assert.ok(member.data.equals(STUB_DIST.data));
});

test("R15 a change in the tracked paths missing from disk syncs and deletes them", async () => {
  const s = scenario();
  assert.equal((await s.run(["test"])).code, 0);
  s.rows.push(row("ghost.txt", "lf", ""));
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  const delta = s.only("sync")[1].sync;
  assert.equal(delta.mode, "delta");
  const member = (name) =>
    String(
      delta.members.find((m) => m.name === `.gd-rust-container/${name}`).data,
    );
  assert.equal(member("deletes"), "ghost.txt\0");
  assert.ok(member("manifest").includes("a ghost.txt\0"));
  assertLine(lines, "sync (delta): 0 changed, 0 deleted, 3 unchanged in 0.0s");
  assert.deepEqual(JSON.parse(readFileSync(s.cacheFile, "utf8")).missing, [
    "ghost.txt",
  ]);
  assert.equal((await s.run(["test"])).code, 0);
  assert.equal(s.only("sync").length, 2);
});

test("R15 the digest reaches the sync argv and the cargo env; a v4 cache syncs in full", async () => {
  const s = scenario();
  assert.equal((await s.run(["test"])).code, 0);
  const first = s.only("sync")[0];
  const manifest = first.sync.members.find(
    (m) => m.name === ".gd-rust-container/manifest",
  ).data;
  assert.equal(first.sync.digest, sha256hex(manifest));
  assert.deepEqual(first.args.slice(-4), [
    "-",
    "-",
    first.sync.next,
    first.sync.digest,
  ]);
  assert.ok(
    flagValues(s.only("cargo")[0].args, "-e").includes(
      `GD_SYNC_DIGEST=${first.sync.digest}`,
    ),
  );
  const v5 = JSON.parse(readFileSync(s.cacheFile, "utf8"));
  assert.equal(v5.version, 5);
  const v4 = Object.fromEntries(
    Object.entries({ ...v5, version: 4 }).filter(([key]) => key !== "digest"),
  );
  writeFileSync(s.cacheFile, JSON.stringify(v4));
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(
    s.only("sync").map((call) => call.sync.mode),
    ["full", "full"],
  );
});

test("R15 a non-UTF-8 listed path is reported once by hex and never synced", async () => {
  const s = scenario();
  const bad = [0x61, 0xff, 0x2e, 0x72, 0x73];
  const { code, lines } = await s.run(["test"], {
    listTree: async () => ({
      eol: Buffer.concat([listing(s.rows), byteListing(EOL_HEAD, [bad])]),
      stage: byteListing(MODE_HEAD, [bad]),
      autocrlf: s.autocrlf,
    }),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(
    lines.filter((line) => line.includes("not valid UTF-8")),
    [
      "rust-container: sync: skipped 1 listed path(s) that are not valid UTF-8 (first, as hex: 61ff2e7273)",
    ],
  );
  assert.equal(
    lines.some((line) => line.includes("missing from disk")),
    false,
  );
  const { members } = s.only("sync")[0].sync;
  const deletes = members.find((m) => m.name === ".gd-rust-container/deletes");
  assert.equal(String(deletes?.data ?? "").includes(REPLACEMENT), false);
  assert.equal(
    members.some((m) => m.name.includes(REPLACEMENT)),
    false,
  );
});

// ------------------------------------------------------ R16 native monitor

const PORT_TEXT = 4321;
const at = (seconds, state, extra = {}) => ({
  atMs: seconds * 1000,
  state,
  ...extra,
});

test("R16 summary: free throughout, unknown only, free plus unknown", () => {
  assert.equal(
    nativeLockSummary(
      [at(0, "free"), at(5, "free"), at(9.2, "free")],
      PORT_TEXT,
    ),
    `native lock (port ${PORT_TEXT}) was free at all 3 checks during this run (sampled every 5s)`,
  );
  assert.equal(
    nativeLockSummary([at(0, "free")], PORT_TEXT, 2500),
    `native lock (port ${PORT_TEXT}) was free at all 1 checks during this run (sampled every 2.5s)`,
  );
  assert.equal(
    nativeLockSummary(
      [
        at(0, "unknown", { reason: "ETIMEDOUT" }),
        at(5, "unknown", { reason: "timeout" }),
      ],
      PORT_TEXT,
    ),
    `native lock (port ${PORT_TEXT}) was not seen held, but 2 of 2 checks could not tell (ETIMEDOUT)`,
  );
  assert.equal(
    nativeLockSummary(
      [at(0, "free"), at(5, "unknown", { reason: "EPERM" })],
      PORT_TEXT,
    ),
    `native lock (port ${PORT_TEXT}) was not seen held, but 1 of 2 checks could not tell (EPERM)`,
  );
});

test("R16 summary: any held sample wins, holders named from the sidecar", () => {
  const dir = fresh("sidecars");
  writeFileSync(
    sidecarPath(PORT_TEXT, dir),
    JSON.stringify({
      wrapperPid: process.pid,
      suite: "rust",
      cwd: "C:/work/tree",
    }),
  );
  const holder = nativeHolder(PORT_TEXT, { sidecarDir: dir });
  assert.equal(holder, "rust in C:/work/tree");
  const samples = [
    at(0, "free"),
    at(5, "held", { holder }),
    at(10, "unknown", { reason: "timeout" }),
    at(12.34, "held", { holder: "vitest in /other" }),
    at(15, "held", { holder }),
    at(16, "free"),
  ];
  assert.equal(
    nativeLockSummary(samples, PORT_TEXT),
    `native lock (port ${PORT_TEXT}) was HELD during this run: 3 of 6 checks, first at +5.0s, last at +15.0s (rust in C:/work/tree; vitest in /other); timings beside a native suite are not comparable to quiet ones`,
  );
  assert.equal(
    nativeLockSummary(
      [at(0, "unknown", { reason: "x" }), at(1.25, "held", { holder })],
      PORT_TEXT,
    ),
    `native lock (port ${PORT_TEXT}) was HELD during this run: 1 of 2 checks, first at +1.3s, last at +1.3s (rust in C:/work/tree); timings beside a native suite are not comparable to quiet ones`,
  );
});

test("R16 a dead or missing sidecar holder is an unknown process", () => {
  const dir = fresh("sidecars");
  assert.equal(
    nativeHolder(PORT_TEXT, { sidecarDir: dir }),
    "an unknown process",
  );
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(
    sidecarPath(PORT_TEXT, dir),
    JSON.stringify({ wrapperPid: dead, suite: "rust", cwd: "/x" }),
  );
  assert.equal(
    nativeHolder(PORT_TEXT, { sidecarDir: dir }),
    "an unknown process",
  );
  writeFileSync(
    sidecarPath(PORT_TEXT, dir),
    JSON.stringify({ wrapperPid: process.pid, suite: 1, cwd: "/x" }),
  );
  assert.equal(
    nativeHolder(PORT_TEXT, { sidecarDir: dir }),
    "an unknown process",
  );
});

test("R16 start lines for each sample state", () => {
  assert.equal(
    nativeStartLine(at(0, "free"), PORT_TEXT),
    `native lock (port ${PORT_TEXT}): free at start`,
  );
  assert.equal(
    nativeStartLine(at(0, "held", { holder: "rust in /x" }), PORT_TEXT),
    `native lock (port ${PORT_TEXT}): HELD at start by rust in /x`,
  );
  assert.equal(
    nativeStartLine(at(0, "unknown", { reason: "timeout" }), PORT_TEXT),
    `native lock (port ${PORT_TEXT}): unknown at start (timeout)`,
  );
});

test("R16 probePort sees a real listener, then its absence", async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  assert.deepEqual(await probePort(port), { state: "held" });
  await new Promise((done) => server.close(done));
  assert.deepEqual(await probePort(port), { state: "free" });
});

test("R16 main monitor: start line, periodic samples, holder, final sample, 5 s default", async () => {
  const s = scenario();
  const timers = [];
  const delays = [];
  let clock = NOW;
  const answers = ["free", "held", "free", "free"];
  let probes = 0;
  const fire = async () => {
    const timer = timers.shift();
    clock += timer.ms;
    timer.fn();
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  };
  s.fake.state.cargoHook = async (_call, start) => {
    start();
    await fire();
    await fire();
    return ok();
  };
  const { code, lines } = await s.run(["test"], {
    monitorMs: undefined,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      delays.push(ms);
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer);
      if (at !== -1) timers.splice(at, 1);
    },
    probe: async () => ({ state: answers[probes++] }),
    holderOf: () => "rust in C:/elsewhere",
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(probes, 4);
  assert.deepEqual(delays, [5000, 5000, 5000]);
  assert.equal(timers.length, 0);
  assertLine(lines, "native lock (port 40102): free at start");
  assertLine(
    lines,
    "native lock (port 40102) was HELD during this run: 1 of 4 checks, first at +5.0s, last at +5.0s (rust in C:/elsewhere); timings beside a native suite are not comparable to quiet ones",
  );
});

// --------------------------------------------------- R17 clean and stop

/** Volumes of this worktree, of a removed one, the shared cargo one, a foreign one. */
function cleanScenario(options) {
  const s = scenario(options);
  const gone = join(root, "removed-worktree-never-created");
  const goneNames = volumeNames(worktreeKey(gone));
  const label = (role, worktree) => ({
    "gd.rust-container": "1",
    "gd.rust-container.role": role,
    ...(worktree ? { "gd.rust-container.worktree": worktree } : {}),
  });
  s.fake.state.volumes = new Map([
    [s.names.src, label("src", `${s.repoRoot}/`)],
    [s.names.target, label("target", s.repoRoot)],
    [s.names.cargo, label("cargo")],
    [goneNames.src, label("src", gone)],
    [goneNames.target, null],
    ["gd-rs1b-src", null],
  ]);
  // The alias shares the current image's ID, so --stale must keep it.
  s.fake.state.imageList = [
    `${IMAGE_ID} ${IMAGE}`,
    `${IMAGE_ID} gd-rust-container:alias`,
    `sha256:${"2".repeat(64)} gd-rust-container:000000000000`,
    `sha256:${"3".repeat(64)} <none>:<none>`,
  ];
  s.gone = gone;
  s.goneNames = goneNames;
  s.goneCache = join(s.cacheDir, `sync-${goneNames.src}.json`);
  writeFileSync(s.cacheFile, "{}");
  writeFileSync(s.goneCache, "{}");
  s.removed = (kind) => s.only(`${kind} rm`).map((call) => call.args[2]);
  return s;
}

test("R17 clean (this worktree) removes only its volumes and cache", async () => {
  const s = cleanScenario();
  const { code, lines } = await s.run(["clean"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(s.lock.calls[0].record.suite, "clean");
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.names.src, s.names.target].sort(),
  );
  assert.deepEqual(s.removed("image"), []);
  assert.equal(existsSync(s.cacheFile), false);
  assert.equal(existsSync(s.goneCache), true);
  assert.ok(s.fake.state.volumes.has(s.names.cargo));
  assert.equal(s.events[2], "ps");
  assertLine(lines, `removed volume ${s.names.src}`);
  assert.equal(
    lines.some((line) => line.includes("no volumes found")),
    false,
  );
  assert.equal(s.lock.released, 1);
});

test("R17 clean --worktree of a missing path matches by label and computed name", async () => {
  const s = cleanScenario();
  const { code } = await s.run(["clean", "--worktree", s.gone]);
  assert.equal(code, 0);
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.goneNames.src, s.goneNames.target].sort(),
  );
  assert.equal(existsSync(s.goneCache), false);
  assert.equal(existsSync(s.cacheFile), true);
  assert.ok(s.fake.state.volumes.has(s.names.cargo));
});

test("R17 clean --stale removes gone worktrees' volumes and non-current images", async () => {
  const s = cleanScenario();
  const { code } = await s.run(["clean", "--stale"], {
    exists: (path) =>
      normalizeWorktreePath(path) !== normalizeWorktreePath(s.gone),
  });
  assert.equal(code, 0);
  assert.deepEqual(s.removed("volume"), [s.goneNames.src]);
  assert.deepEqual(s.removed("image"), [
    "gd-rust-container:000000000000",
    `sha256:${"3".repeat(64)}`,
  ]);
  assert.ok(s.only("image ls")[0].args.includes("--no-trunc"));
  assert.equal(existsSync(s.goneCache), false);
  assert.ok(s.fake.state.volumes.has(s.names.cargo));
  const missing = cleanScenario();
  missing.fake.state.rust1 = null;
  const result = await missing.run(["clean", "--stale"], {
    exists: () => true,
  });
  assert.equal(result.code, 0);
  assertLine(result.lines, "rust:1 is not pulled; not removing images");
  assert.deepEqual(missing.removed("image"), []);
  assert.equal(missing.kinds().includes("pull"), false);
});

test("R17 clean --all removes every labeled volume and image and the cache dir", async () => {
  const s = cleanScenario();
  const { code } = await s.run(["clean", "--all"]);
  assert.equal(code, 0);
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.names.src, s.names.target, s.names.cargo, s.goneNames.src].sort(),
  );
  assert.deepEqual(s.removed("image"), [
    IMAGE,
    "gd-rust-container:alias",
    "gd-rust-container:000000000000",
    `sha256:${"3".repeat(64)}`,
  ]);
  assert.equal(existsSync(s.cacheDir), false);
  assert.ok(s.fake.state.volumes.has("gd-rs1b-src"));
});

test("R17 an in-use volume makes clean exit 1 and keeps its cache", async () => {
  const s = cleanScenario();
  s.fake.state.inUse.add(s.names.src);
  const { code, lines } = await s.run(["clean"]);
  assert.equal(code, 1);
  assertLine(
    lines,
    `could not remove volume ${s.names.src} (Error response from daemon: remove ${s.names.src}: volume is in use)`,
  );
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.names.src, s.names.target].sort(),
  );
  assert.equal(existsSync(s.cacheFile), true);
});

test("R17 clean --stale skips another platform's volumes and paths it cannot check", async () => {
  const s = cleanScenario();
  const foreignPath =
    process.platform === "win32" ? "/home/me/wt" : "C:\\work\\wt";
  const labeled = (worktree, platform) => ({
    "gd.rust-container": "1",
    "gd.rust-container.worktree": worktree,
    ...(platform ? { "gd.rust-container.platform": platform } : {}),
  });
  s.fake.state.volumes.set(
    "gd-rust-container-other-1-src",
    labeled(s.gone, "other-os"),
  );
  s.fake.state.volumes.set("gd-rust-container-wsl-2-src", labeled(foreignPath));
  s.fake.state.volumes.set(
    "gd-rust-container-mine-3-src",
    labeled(s.gone, process.platform),
  );
  const { code, lines } = await s.run(["clean", "--stale"], {
    exists: (path) =>
      normalizeWorktreePath(path) !== normalizeWorktreePath(s.gone),
  });
  assert.equal(code, 0);
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.goneNames.src, "gd-rust-container-mine-3-src"].sort(),
  );
  for (const [name, path] of [
    ["gd-rust-container-other-1-src", s.gone],
    ["gd-rust-container-wsl-2-src", foreignPath],
  ]) {
    assertLine(
      lines,
      `skipped volume ${name}: labeled by another platform or a path this platform cannot check (${path})`,
    );
  }
});

test("R17 clean drops this worktree's cache with no volume left; a claimed computed name stays", async () => {
  const s = scenario();
  s.fake.state.volumes = new Map([
    [s.names.src, null],
    [s.names.target, { "gd.rust-container.worktree": "/elsewhere/wt" }],
  ]);
  writeFileSync(s.cacheFile, "{}");
  const { code } = await s.run(["clean"]);
  assert.equal(code, 0);
  assert.deepEqual(
    s.only("volume rm").map((call) => call.args[2]),
    [s.names.src],
  );
  assert.equal(existsSync(s.cacheFile), false);
  const empty = scenario();
  empty.fake.state.volumes.clear();
  writeFileSync(empty.cacheFile, "{}");
  assert.equal((await empty.run(["clean"])).code, 0);
  assert.equal(empty.kinds().includes("volume rm"), false);
  assert.equal(existsSync(empty.cacheFile), false);
});

test("R17 clean --all also removes this worktree's unlabeled volumes", async () => {
  const s = cleanScenario();
  for (const name of [s.names.src, s.names.cargo]) {
    s.fake.state.volumes.set(name, null);
  }
  s.fake.state.volumes.set(s.names.target, { other: "x" });
  const { code } = await s.run(["clean", "--all"]);
  assert.equal(code, 0);
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.names.src, s.names.cargo, s.goneNames.src].sort(),
  );
  assert.ok(s.fake.state.volumes.has(s.names.target));
});

test("R17 a removal that times out is that item's failure; clean goes on", async () => {
  const s = cleanScenario();
  const timedOut = { ...fail(null), signal: "SIGTERM", timedOut: true };
  s.fake.state.forced.set("volume rm", timedOut);
  const { code, lines } = await s.run(["clean"]);
  assert.equal(code, 1, lines.join("\n"));
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.names.src, s.names.target].sort(),
  );
  for (const name of [s.names.src, s.names.target]) {
    assertLine(
      lines,
      `could not remove volume ${name} (timed out after 600.0s)`,
    );
  }
  assert.ok(s.only("volume rm").every((c) => c.options.timeoutMs === 600_000));
  assert.equal(existsSync(s.cacheFile), true);
  const images = cleanScenario();
  images.fake.state.forced.set("image rm", timedOut);
  const all = await images.run(["clean", "--all"]);
  assert.equal(all.code, 1);
  assert.equal(images.removed("image").length, 4);
  assert.equal(existsSync(images.cacheDir), false);
});

test("R17 a cache that cannot be removed fails the clean, which goes on", async () => {
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  const s = cleanScenario();
  const { code, lines } = await s.run(["clean"], {
    fs: {
      rm: (path, options) => {
        if (path === s.cacheFile) throw busy;
        rmSync(path, options);
      },
    },
  });
  assert.equal(code, 1, lines.join("\n"));
  assertLine(lines, `could not remove ${s.cacheFile} (EBUSY)`);
  assert.deepEqual(
    s.removed("volume").sort(),
    [s.names.src, s.names.target].sort(),
  );
  const all = cleanScenario();
  const result = await all.run(["clean", "--all"], {
    fs: {
      rm: (path, options) => {
        if (path === all.cacheDir) throw busy;
        rmSync(path, options);
      },
    },
  });
  assert.equal(result.code, 1, result.lines.join("\n"));
  assertLine(result.lines, `could not remove ${all.cacheDir} (EBUSY)`);
  assert.equal(
    result.lines.includes(`rust-container: removed ${all.cacheDir}`),
    false,
  );
  assert.equal(all.removed("image").length, 4);
});

test("R17 a degraded lock never reaps (test and clean)", async () => {
  for (const argv of [["test"], ["clean"]]) {
    const s = cleanScenario({ degraded: true });
    s.fake.state.orphans = ["abc"];
    const { lines } = await s.run(argv);
    assert.equal(s.kinds().includes("ps"), false, argv[0]);
    assert.equal(s.kinds().includes("rm"), false, argv[0]);
    assertLine(
      lines,
      "lock degraded (port 40101 could not be bound); not removing orphaned containers",
    );
  }
});

test("R17 a degraded run labels its containers without the port", async () => {
  const s = scenario({ degraded: true });
  assert.equal((await s.run(["test"])).code, 0);
  for (const kind of ["sync", "cargo"]) {
    assert.deepEqual(flagValues(s.only(kind)[0].args, "--label"), [
      "gd.rust-container=1",
      "gd.rust-container.degraded=1",
      `gd.rust-container.ns=${process.platform}`,
    ]);
  }
});

test("R17 a stop while cargo runs kills it, removes its container and returns 1", async () => {
  const s = scenario();
  let registered;
  let killed = false;
  s.fake.state.cargoHook = (_call, start) =>
    new Promise((done) => {
      // Ends on its own if nothing kills it, so a broken stop fails, not hangs.
      const timer = setTimeout(() => done(ok()), 1000);
      start(() => {
        killed = true;
        clearTimeout(timer);
        done(fail(137));
      });
      registered = [...s.signals.handlers.keys()].sort();
      s.signals.emit("SIGINT");
    });
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 1);
  assert.equal(killed, true, "the stop did not kill the cargo child");
  assert.deepEqual(
    registered,
    (process.platform === "win32"
      ? ["SIGBREAK", "SIGINT", "SIGTERM"]
      : ["SIGHUP", "SIGINT", "SIGTERM"]
    ).sort(),
  );
  const name = flagValues(s.only("cargo")[0].args, "--name")[0];
  assert.deepEqual(s.only("rm").at(-1).args, ["rm", "-f", name]);
  assert.deepEqual(s.events.slice(-3), ["cargo", "rm", "release"]);
  assert.ok(lines.some((l) => SUMMARY_FREE.test(l)));
  assertLine(lines, "done in 0.0s (exit 1)");
  assert.equal(
    lines.some((l) => l.includes("cargo test exited")),
    false,
  );
  assert.deepEqual([...s.signals.handlers.keys()], []);
});

test("R17 a stop during the sync writes no cache and never starts cargo", async () => {
  const s = scenario();
  s.fake.state.syncCodes.push(
    () =>
      new Promise((done) => {
        setImmediate(() => {
          s.signals.emit("SIGTERM");
          done(fail(137));
        });
      }),
  );
  const { code } = await s.run(["test"]);
  assert.equal(code, 1);
  assert.equal(s.kinds().includes("cargo"), false);
  assert.equal(existsSync(s.cacheFile), false);
  assert.equal(s.only("rm").length, 1);
  assert.equal(s.lock.released, 1);
});

test("R17 a stop after cargo failed keeps cargo's code", async () => {
  const s = scenario();
  s.fake.state.cargoCode = 101;
  const { code, lines } = await s.run(["test"], {
    probe: async () => {
      if (s.only("cargo").length > 0) s.signals.emit("SIGINT");
      return { state: "free" };
    },
  });
  assert.equal(code, 101);
  assertLine(lines, "cargo test exited 101 after 0.0s");
  assertLine(lines, "done in 0.0s (exit 101)");
  assert.deepEqual([...s.signals.handlers.keys()], []);
});

/**
 * Stops the run from inside its cargo call, as "R17 a stop while cargo runs
 * kills it, removes its container and returns 1" does.
 */
function stopDuringCargo(s) {
  s.fake.state.cargoHook = (_call, start) =>
    new Promise((done) => {
      const timer = setTimeout(() => done(ok()), 1000);
      start(() => {
        clearTimeout(timer);
        done(fail(137));
      });
      s.signals.emit("SIGINT");
    });
}

const unconfirmed = (name, reason) =>
  `could not confirm container ${name} was removed (${reason}); the next run on this lock removes it if it is still there`;

test("R17 a stop whose container removal fails says so; the lock is released once and the run exits 1", async () => {
  const daemon =
    "Error response from daemon: cannot remove container: daemon busy";
  const spawnError = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
  });
  for (const [forced, reason] of [
    [fail(1, daemon), daemon],
    [{ ...fail(null), error: spawnError }, "ENOENT"],
  ]) {
    const s = scenario();
    stopDuringCargo(s);
    s.fake.state.forced.set("rm", forced);
    const { code, lines } = await s.run(["test"]);
    assert.equal(code, 1, lines.join("\n"));
    const name = flagValues(s.only("cargo")[0].args, "--name")[0];
    assertLine(lines, unconfirmed(name, reason));
    assert.equal(s.lock.released, 1);
    assert.deepEqual(s.events.slice(-3), ["cargo", "rm", "release"]);
  }
});

test("R17 a removal whose result handling throws before cargo ends still releases the lock", async () => {
  const s = scenario();
  s.fake.state.cargoHook = (_call, start) =>
    new Promise((done) => {
      // The rm result settles first: cargo ends a macrotask after the kill.
      start(() => setTimeout(() => done(fail(137)), 50));
      s.signals.emit("SIGINT");
    });
  s.fake.state.forced.set("rm", fail(1, "daemon busy"));
  const lines = [];
  const { code } = await s.run(["test"], {
    log: (line) => {
      if (line.includes("could not confirm")) throw new Error("log threw");
      lines.push(line);
    },
  });
  assert.equal(code, 1, lines.join("\n"));
  assert.equal(s.lock.released, 1);
  assert.ok(
    lines.some((l) => SUMMARY_FREE.test(l)),
    lines.join("\n"),
  );
  assertLine(lines, "done in 0.0s (exit 1)");
});

test("R17 a stop whose removal times out says so", async () => {
  const s = scenario();
  stopDuringCargo(s);
  s.fake.state.forced.set("rm", {
    ...fail(null),
    signal: "SIGTERM",
    timedOut: true,
  });
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 1, lines.join("\n"));
  const name = flagValues(s.only("cargo")[0].args, "--name")[0];
  assertLine(lines, unconfirmed(name, "`docker rm` timed out after 120.0s"));
  assert.equal(s.lock.released, 1);
});

test("R17 a degraded stop's unconfirmed removal names docker rm -f", async () => {
  const s = scenario({ degraded: true });
  stopDuringCargo(s);
  s.fake.state.forced.set("rm", fail(1, "daemon busy"));
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 1, lines.join("\n"));
  const name = flagValues(s.only("cargo")[0].args, "--name")[0];
  assertLine(
    lines,
    `could not confirm container ${name} was removed (daemon busy); remove it with docker rm -f ${name}`,
  );
  assert.equal(s.lock.released, 1);
});

test("R17 a removal already gone or under way logs nothing", async () => {
  for (const stderr of [
    "Error response from daemon: removal of container gd-x is already in progress",
    "Error: No such container: gd-x",
  ]) {
    const s = scenario();
    stopDuringCargo(s);
    s.fake.state.forced.set("rm", fail(1, stderr));
    const { code, lines } = await s.run(["test"]);
    assert.equal(code, 1, lines.join("\n"));
    assert.equal(
      lines.some((line) => line.includes("could not confirm")),
      false,
      stderr,
    );
    assert.equal(s.lock.released, 1);
  }
});

test("R17 clean of a worktree with no volumes says so", async () => {
  const s = cleanScenario();
  const never = join(root, "never-had-volumes");
  const { code, lines } = await s.run(["clean", "--worktree", never]);
  assert.equal(code, 0, lines.join("\n"));
  assertLine(lines, `no volumes found for worktree ${resolve(never)}`);
  const empty = scenario();
  empty.fake.state.volumes.clear();
  const result = await empty.run(["clean"]);
  assert.equal(result.code, 0, result.lines.join("\n"));
  assertLine(result.lines, `no volumes found for worktree ${empty.repoRoot}`);
});

// --------------------------------------------------- R21 host cache dir

const CASES = [
  {
    platform: "linux",
    env: { TMPDIR: "/tmp" },
    home: "/home/u",
    dir: `/home/u/.cache/${CACHE_LEAF}`,
  },
  {
    platform: "linux",
    env: { XDG_CACHE_HOME: "/x/c" },
    home: "/home/u",
    dir: `/x/c/${CACHE_LEAF}`,
  },
  {
    platform: "linux",
    env: { XDG_CACHE_HOME: "rel/c" },
    home: "/home/u",
    dir: `/home/u/.cache/${CACHE_LEAF}`,
  },
  {
    platform: "linux",
    env: { XDG_CACHE_HOME: "" },
    home: "/home/u",
    dir: `/home/u/.cache/${CACHE_LEAF}`,
  },
  {
    platform: "darwin",
    env: {},
    home: "/Users/u",
    dir: `/Users/u/Library/Caches/${CACHE_LEAF}`,
  },
  {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    home: "C:\\Users\\u",
    dir: `C:\\Users\\u\\AppData\\Local\\${CACHE_LEAF}`,
  },
  {
    platform: "win32",
    env: {},
    home: "C:\\Users\\u",
    dir: `C:\\Users\\u\\AppData\\Local\\${CACHE_LEAF}`,
  },
];

test("R21 defaultCacheDir: the linux default is ~/.cache even with TMPDIR=/tmp", () => {
  assert.equal(defaultCacheDir(CASES[0]), CASES[0].dir);
});

test("R21 defaultCacheDir honours only an absolute XDG_CACHE_HOME", () => {
  for (const c of CASES.slice(1, 4)) {
    assert.equal(defaultCacheDir(c), c.dir, JSON.stringify(c.env));
  }
});

test("R21 defaultCacheDir on darwin and win32", () => {
  for (const c of CASES.slice(4)) {
    assert.equal(defaultCacheDir(c), c.dir, JSON.stringify(c));
  }
});

test("R21 defaultCacheDir ignores a LOCALAPPDATA that is not absolute", () => {
  for (const local of ["rel\\Local", "C:rel"]) {
    assert.equal(
      defaultCacheDir({
        platform: "win32",
        env: { LOCALAPPDATA: local },
        home: "C:\\Users\\u",
      }),
      `C:\\Users\\u\\AppData\\Local\\${CACHE_LEAF}`,
      local,
    );
  }
});

/**
 * The SystemError os.userInfo throws for a uid with no passwd entry; os.homedir
 * throws it only when HOME is unset as well.
 */
function noPasswdEntry(syscall) {
  return Object.assign(
    new Error(
      `A system error occurred: ${syscall} returned ENOENT (no such file or directory)`,
    ),
    { code: "ERR_SYSTEM_ERROR", info: { errno: -2, code: "ENOENT", syscall } },
  );
}

test("R21 defaultCacheDir reads home only when no env dir is usable", () => {
  const rows = [
    ["win32", { LOCALAPPDATA: "C:\\L" }, `C:\\L\\${CACHE_LEAF}`],
    ["linux", { XDG_CACHE_HOME: "/x/c" }, `/x/c/${CACHE_LEAF}`],
  ];
  for (const [platform, env, dir] of rows) {
    let called = 0;
    const home = () => {
      called++;
      throw noPasswdEntry("uv_os_homedir");
    };
    assert.equal(defaultCacheDir({ platform, env, home }), dir, platform);
    assert.equal(called, 0, platform);
  }
  for (const [platform, env, dir] of [
    [
      "win32",
      { LOCALAPPDATA: "C:rel" },
      `C:\\H\\AppData\\Local\\${CACHE_LEAF}`,
    ],
    ["linux", { XDG_CACHE_HOME: "rel" }, `/h/.cache/${CACHE_LEAF}`],
    ["darwin", {}, `/h/Library/Caches/${CACHE_LEAF}`],
  ]) {
    let called = 0;
    const home = () => {
      called++;
      return platform === "win32" ? "C:\\H" : "/h";
    };
    assert.equal(defaultCacheDir({ platform, env, home }), dir, platform);
    assert.equal(called, 1, platform);
  }
});

test("R21 every default cache dir ends in the tool's own leaf", () => {
  for (const c of CASES) {
    const dir = defaultCacheDir(c);
    const path = c.platform === "win32" ? win32 : posix;
    assert.equal(path.basename(dir), CACHE_LEAF, dir);
  }
});

test("R21 a planted entry at the cache temp path is neither written through nor removed", async () => {
  const s = scenario();
  const planted = `${s.cacheFile}.${"0".repeat(16)}.tmp`;
  writeFileSync(planted, "planted");
  const { code, lines } = await s.run(["test"], {
    randomHex: (bytes) => "0".repeat(bytes * 2),
  });
  assert.equal(code, 0, lines.join("\n"));
  assertLine(
    lines,
    "could not write the sync cache (EEXIST); the next run does a full sync",
  );
  assert.equal(readFileSync(planted, "utf8"), "planted");
  assert.equal(existsSync(s.cacheFile), false);
});

test("R21 the host cache dir and files are private", {
  skip: UNIX_ONLY,
}, async () => {
  const s = scenario();
  const dir = join(fresh("c"), "cache");
  const { code, lines } = await s.run(["test"], { cacheDir: dir });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(
    statSync(join(dir, `sync-${s.names.src}.json`)).mode & 0o777,
    0o600,
  );
});

const NO_HOME_LINE =
  "rust-container: no usable host cache dir (ENOENT); every run does a full sync and the daily rust:1 check";
const NO_CACHE_LEAD = "rust-container: no usable host cache dir (";
const NO_CACHE_DAILY_LINE =
  "last daily rust:1 check: not recorded (no usable host cache dir)";

/** Run options with no home directory and fs writes that only record. */
function noHome() {
  const calls = [];
  const spy =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    extra: {
      cacheDir: undefined,
      homedir: () => {
        throw noPasswdEntry("uv_os_homedir");
      },
      fs: {
        mkdir: spy("mkdir"),
        stat: spy("stat"),
        lstat: spy("lstat"),
        open: spy("open"),
        close: spy("close"),
        writeFile: spy("writeFile"),
        rename: spy("rename"),
        rm: spy("rm"),
      },
    },
  };
}

test("R21 without a home directory the run has no host cache and never uses tmpdir", async () => {
  const s = scenario();
  const { calls, extra } = noHome();
  for (let i = 0; i < 2; i++) {
    const { code, lines } = await s.run(["test"], extra);
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(lines.filter((line) => line === NO_HOME_LINE).length, 1);
  }
  assert.deepEqual(
    s.only("sync").map((call) => call.sync.mode),
    ["full", "full"],
  );
  assert.equal(s.only("pull").length, 2);
  assert.deepEqual(calls, []);
});

test("R21 clean and info without a home directory touch no cache", async () => {
  const runs = [
    [cleanScenario(), ["clean"]],
    [cleanScenario(), ["clean", "--all"]],
    [scenario(), ["info"]],
  ];
  for (const [s, argv] of runs) {
    const { calls, extra } = noHome();
    const { code, lines } = await s.run(argv, extra);
    const label = argv.join(" ");
    assert.equal(code, 0, `${label}\n${lines.join("\n")}`);
    assert.equal(
      lines.filter((line) => line === NO_HOME_LINE).length,
      1,
      label,
    );
    assert.deepEqual(
      lines.filter(
        (line) =>
          line.startsWith("rust-container: removed ") &&
          !/^rust-container: removed (volume|image) /.test(line),
      ),
      [],
      label,
    );
    assert.deepEqual(calls, [], label);
    assert.equal(existsSync(s.cacheDir), true, label);
    if (argv[0] === "info") {
      assertLine(lines, NO_CACHE_DAILY_LINE);
    }
  }
});

test("R21 a relative home directory gives no host cache", async () => {
  const s = scenario();
  const { calls, extra } = noHome();
  const { code, lines } = await s.run(["info"], {
    ...extra,
    platform: "linux",
    env: { ...TEST_ENV },
    homedir: () => "rel",
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(
    lines.filter((line) => line.startsWith(NO_CACHE_LEAD)),
    [
      "rust-container: no usable host cache dir (not an absolute path: rel/.cache/gitdesktop-rust-container); every run does a full sync and the daily rust:1 check",
    ],
  );
  assertLine(lines, NO_CACHE_DAILY_LINE);
  assert.deepEqual(calls, []);
});

test("R21 a LOCALAPPDATA rooted only at the cwd's drive is ignored", () => {
  for (const local of ["\\Users\\u\\Local", "/Local", "\\\\srv"]) {
    let called = 0;
    const home = () => {
      called++;
      return "C:\\Users\\u";
    };
    assert.equal(
      defaultCacheDir({
        platform: "win32",
        env: { LOCALAPPDATA: local },
        home,
      }),
      `C:\\Users\\u\\AppData\\Local\\${CACHE_LEAF}`,
      local,
    );
    assert.equal(called, 1, local);
  }
});

test("R21 a home rooted only at the cwd's drive gives no host cache", {
  skip:
    process.platform === "win32"
      ? false
      : "a win32 main row; never run on a POSIX host",
}, async () => {
  const s = scenario();
  const { calls, extra } = noHome();
  const { code, lines } = await s.run(["info"], {
    ...extra,
    platform: "win32",
    env: { ...TEST_ENV },
    homedir: () => "\\Users\\u",
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(
    lines.filter((line) => line.startsWith(NO_CACHE_LEAD)),
    [
      `rust-container: no usable host cache dir (not rooted at a drive or share: \\Users\\u\\AppData\\Local\\${CACHE_LEAF}); every run does a full sync and the daily rust:1 check`,
    ],
  );
  assert.deepEqual(calls, []);
});

test("R21 a cache dir other users can write is never read or written", {
  skip: UNIX_ONLY,
}, async () => {
  const s = scenario();
  assert.equal((await s.run(["test"])).code, 0);
  const planted = readFileSync(s.cacheFile, "utf8");
  chmodSync(s.cacheDir, 0o777);
  const listing = readdirSync(s.cacheDir).sort();
  const { code, lines } = await s.run(["test"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(
    lines.filter((line) => line.startsWith(NO_CACHE_LEAD)),
    [
      `rust-container: no usable host cache dir (${s.cacheDir} is writable by other users); every run does a full sync and the daily rust:1 check`,
    ],
  );
  assert.deepEqual(
    s.only("sync").map((call) => call.sync.mode),
    ["full", "full"],
  );
  assert.equal(s.only("pull").length, 1);
  assert.equal(readFileSync(s.cacheFile, "utf8"), planted);
  assert.deepEqual(readdirSync(s.cacheDir).sort(), listing);
});

test("R21 a cache dir found shared at write time is refused there", {
  skip: UNIX_ONLY,
}, async () => {
  const s = scenario({ pulledToday: false });
  const dir = join(fresh("c"), "cache");
  const shared = {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    uid: process.getuid(),
    mode: 0o40777,
  };
  const { code, lines } = await s.run(["test"], {
    cacheDir: dir,
    fs: { lstat: (path) => (path === dir ? shared : lstatSync(path)) },
  });
  assert.equal(code, 0, lines.join("\n"));
  assertLine(
    lines,
    `could not write the sync cache (${dir} is writable by other users); the next run does a full sync`,
  );
  assertLine(
    lines,
    `could not record the daily rust:1 check (${dir} is writable by other users)`,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test("R21 the cache dir is checked up front, and never made by the check", async () => {
  const cache = "/home/u/.cache/gitdesktop-rust-container";
  const rows = [
    [4242, null],
    [
      0,
      "rust-container: no usable host cache dir (/home/u belongs to uid 1000); every run does a full sync and the daily rust:1 check",
    ],
  ];
  for (const [uid, want] of rows) {
    const s = scenario();
    const calls = [];
    const owned = (owner) => ({ isDirectory: () => true, uid: owner });
    const { code, lines } = await s.run(["info"], {
      platform: "linux",
      env: { ...TEST_ENV },
      uid,
      cacheDir: cache,
      fs: {
        stat: (path) => {
          calls.push(["stat", path]);
          if (path === "/home/u") return owned(uid === 0 ? 1000 : uid);
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        lstat: (path) => {
          calls.push(["lstat", path]);
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        mkdir: (path) => calls.push(["mkdir", path]),
        readFile: (path) => {
          calls.push(["readFile", path]);
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      },
    });
    const label = `uid ${uid}`;
    assert.equal(code, 0, `${label}\n${lines.join("\n")}`);
    assert.deepEqual(
      lines.filter((line) => line.startsWith(NO_CACHE_LEAD)),
      want === null ? [] : [want],
      label,
    );
    assert.deepEqual(
      calls.slice(0, 2),
      [
        ["lstat", cache],
        ["stat", cache],
      ],
      label,
    );
    assert.deepEqual(
      calls.filter(([kind]) => kind === "mkdir" || kind === "lstat"),
      [["lstat", cache]],
      label,
    );
    assert.equal(
      calls.some(
        ([kind, path]) =>
          kind === "readFile" && path === join(cache, "rust1-pull.json"),
      ),
      want === null,
      label,
    );
    assertLine(
      lines,
      want === null ? "last daily rust:1 check: never" : NO_CACHE_DAILY_LINE,
    );
  }
});

const POSIX_SIDECAR = linuxOnly(
  "the POSIX sidecar default, which main() takes from the host platform",
);
const SIDECAR_LINE =
  "rust-container: no per-user dir for the lock sidecar (ENOENT); this run is not named, and if it is killed the next run does not wait for its children";

test("R16 the container lock's sidecar sits in the native wrapper's per-user dir", {
  skip: POSIX_SIDECAR,
}, async () => {
  const s = scenario();
  const { code, lines } = await s.run(["test"], {
    sidecarDir: undefined,
    uid: 4242,
    userHome: () => "/home/u",
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(
    s.lock.calls[0].sidecarDir,
    "/home/u/.cache/gitdesktop-full-suite-4242",
  );
  assert.equal(
    s.lock.calls[0].sidecarFile,
    "/home/u/.cache/gitdesktop-full-suite-4242/gitdesktop-rust-container-40101.json",
  );
  assert.equal(lines.includes(SIDECAR_LINE), false);
});

test("R16 without a per-user dir the container lock has no sidecar", {
  skip: POSIX_SIDECAR,
}, async () => {
  const s = scenario();
  const { code, lines } = await s.run(["test"], {
    sidecarDir: undefined,
    uid: 4242,
    userHome: () => {
      throw noPasswdEntry("uv_os_get_passwd");
    },
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(s.lock.calls.length, 1);
  assert.equal(s.lock.calls[0].sidecarDir, null);
  assert.equal("sidecarFile" in s.lock.calls[0], false);
  assert.equal(lines.filter((line) => line === SIDECAR_LINE).length, 1);
});

test("R16 nativeHolder reads the native wrapper's default dir", () => {
  const dir = fresh("native-default");
  writeFileSync(
    sidecarPath(PORT_TEXT, dir),
    JSON.stringify({ wrapperPid: process.pid, suite: "rust", cwd: "/w" }),
  );
  let calls = 0;
  const resolveSidecarDir = () => {
    calls++;
    return { dir, problem: null };
  };
  assert.equal(nativeHolder(PORT_TEXT, { resolveSidecarDir }), "rust in /w");
  assert.equal(calls, 1);
  assert.equal(
    nativeHolder(PORT_TEXT, {
      resolveSidecarDir: () => ({ dir: null, problem: "no user id" }),
    }),
    "an unknown process",
  );
});

// ----------------------------------------------- R19 spawnDocker (Linux)
// The real child-process wrapper against a fake docker script on PATH.

const FAKE_DOCKER = `#!/bin/bash
case $1 in
  read-all) cat > /dev/null; exit 0 ;;
  no-read) exit 0 ;;
  hold) cat > /dev/null; : > "$2"; exit 0 ;;
  print) echo out; echo err >&2; exit 3 ;;
  quiet) exit 3 ;;
  hang) exec sleep 30 ;;
  orphan-hang) (sleep 20) & exec sleep 30 ;;
  orphan-exit) (sleep 2) & exit 0 ;;
esac
`;

async function withFakeDocker(fn) {
  const bin = fresh("docker-bin");
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("R19 spawnDocker accepts stdin only when every byte was written", {
  skip: BASH_ONLY,
}, async () => {
  await withFakeDocker(async () => {
    const input = Buffer.alloc(8 << 20, 0x61);
    const read = await spawnDocker(["read-all"], { input });
    assert.equal(read.code, 0);
    assert.equal(read.stdinError, null);
    const unread = await spawnDocker(["no-read"], { input });
    assert.equal(unread.code, 0);
    assert.notEqual(unread.stdinError, null);
  });
});

test("R19 spawnDocker holdStdin keeps the pipe open until the child dies", {
  skip: BASH_ONLY,
}, async () => {
  await withFakeDocker(async () => {
    const eof = join(fresh("hold"), "eof");
    let child;
    let settled = false;
    const pending = spawnDocker(["hold", eof], {
      holdStdin: true,
      onStart: (started) => {
        child = started;
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(settled, false);
    assert.equal(existsSync(eof), false);
    child.kill();
    const result = await pending;
    assert.equal(result.signal, "SIGTERM");
    assert.equal(existsSync(eof), false);
  });
});

test("R19 spawnDocker captures or inherits output, and times out a hung call", {
  skip: BASH_ONLY,
}, async () => {
  await withFakeDocker(async () => {
    const captured = await spawnDocker(["print"]);
    assert.equal(captured.code, 3);
    assert.equal(String(captured.stdout), "out\n");
    assert.equal(String(captured.stderr), "err\n");
    const inherited = await spawnDocker(["quiet"], { inherit: true });
    assert.equal(inherited.code, 3);
    assert.equal(inherited.stdout.length + inherited.stderr.length, 0);
    const hung = await spawnDocker(["hang"], { timeoutMs: 200 });
    assert.equal(hung.timedOut, true);
    assert.equal(hung.signal, "SIGTERM");
    const quick = await spawnDocker(["quiet"], { timeoutMs: 10_000 });
    assert.equal(quick.timedOut, false);
  });
});

test("R19 spawnDocker settles a timed-out call on exit though a descendant holds its pipes", {
  skip: BASH_ONLY,
}, async () => {
  await withFakeDocker(async () => {
    const started = Date.now();
    const pinned = await spawnDocker(["orphan-hang"], { timeoutMs: 200 });
    assert.equal(pinned.timedOut, true);
    assert.equal(pinned.signal, "SIGTERM");
    // The descendant sleeps 20 s; settling on 'close' would wait for it.
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
    // Exited before its bound, so never timed out, whatever 'close' waits on.
    const early = await spawnDocker(["orphan-exit"], { timeoutMs: 300 });
    assert.equal(early.timedOut, false);
    assert.equal(early.code, 0);
  });
});

test("R19 spawnDocker settles a bounded call that exited within its grace; an unbounded one waits for its pipes", {
  skip: BASH_ONLY,
}, async () => {
  await withFakeDocker(async () => {
    let started = Date.now();
    const bounded = await spawnDocker(["orphan-exit"], {
      timeoutMs: 10_000,
      graceMs: 200,
    });
    assert.equal(bounded.timedOut, false);
    assert.equal(bounded.code, 0);
    // The descendant holds the pipes for 2 s; the grace settles before it.
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
    started = Date.now();
    const unbounded = await spawnDocker(["orphan-exit"]);
    assert.equal(unbounded.code, 0);
    assert.ok(Date.now() - started >= 1500, `${Date.now() - started} ms`);
  });
});

// ------------------------------------------------------------- R20 info
// `info` reports the worktree's state without taking the lock.

test("R20 info reports state without the lock", async () => {
  const s = scenario();
  s.fake.state.volumes.delete(s.names.target);
  const { code, lines } = await s.run(["info"]);
  assert.equal(code, 0);
  assert.equal(s.lock.calls.length, 0);
  assertLine(lines, `worktree ${s.repoRoot} (key ${s.key})`);
  assertLine(lines, "container lock port 40101; native lock port 40102");
  assertLine(lines, `volume ${s.names.src}: present`);
  assertLine(lines, `volume ${s.names.target}: missing`);
  assertLine(lines, "rust:1: rustc 1.100.0");
  assertLine(lines, `image ${IMAGE}: built`);
  assertLine(lines, `last daily rust:1 check: ${TODAY}`);
});

// ------------------------------------------------------------- R18 ports

test("R18 no test here names a lock's default port as a port to bind", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const name of ["DEFAULT_PORT", "DEFAULT_CONTAINER_PORT"]) {
    assert.equal(source.includes(["port", name].join(": ")), false, name);
    assert.equal(source.includes([`listen(${name}`].join("")), false, name);
  }
  for (const port of [DEFAULT_PORT, DEFAULT_CONTAINER_PORT]) {
    assert.equal(source.includes(String(port)), false, String(port));
  }
});
