// Pins the task-editor scope-flip path repair and the run dialog's missing-file
// case (src/lib/scripts/script-path.ts). The contract: only a flip TO all
// repositories acts; a relative path flipped from this repository becomes the
// full path under the open checkout root, while one with no knowable root is
// flagged, never guessed; absolute, drive-relative, and empty paths stay as is.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module
// must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  absolutizeScriptPath,
  isAbsoluteScriptPath,
  missingScriptCase,
  pathOnScopeFlip,
} from "../src/lib/scripts/script-path.ts";

const ROOT = "C:/ProjectRepos/x";

const flip = (over) =>
  pathOnScopeFlip({
    from: "this-repo",
    to: "global",
    path: "scripts/release.mjs",
    repoRoot: ROOT,
    ...over,
  });

test("isAbsoluteScriptPath classifies POSIX, drive, and UNC forms", () => {
  const rows = [
    ["/x", true],
    ["/usr/x", true],
    ["C:/x", true],
    ["C:\\x", true],
    ["c:/x", true],
    ["\\\\srv\\s", true],
    ["//srv/s", true],
    ["scripts/x", false],
    ["./x", false],
    ["../x", false],
    ["C:x", false],
    ["x", false],
    ["", false],
  ];
  for (const [input, expected] of rows)
    assert.equal(isAbsoluteScriptPath(input), expected, JSON.stringify(input));
});

test("absolutizeScriptPath joins with forward slashes", () => {
  assert.equal(
    absolutizeScriptPath("C:\\ProjectRepos\\x\\", "scripts\\release.mjs"),
    "C:/ProjectRepos/x/scripts/release.mjs",
  );
  assert.equal(
    absolutizeScriptPath("/home/u/repo/", "scripts/x.mjs"),
    "/home/u/repo/scripts/x.mjs",
  );
  assert.equal(
    absolutizeScriptPath(ROOT, "./scripts/x.mjs"),
    `${ROOT}/scripts/x.mjs`,
  );
  // Only one leading "./" is stripped.
  assert.equal(absolutizeScriptPath(ROOT, "././x.mjs"), `${ROOT}/./x.mjs`);
});

test("absolutizeScriptPath keeps POSIX backslashes as filename characters", () => {
  assert.equal(
    absolutizeScriptPath("/home/u/repo", "scripts\\release.sh"),
    "/home/u/repo/scripts\\release.sh",
  );
  assert.equal(
    absolutizeScriptPath("/home/u/repo/", "./a.sh"),
    "/home/u/repo/a.sh",
  );
});

test("absolutizeScriptPath normalizes separators under a Windows root", () => {
  assert.equal(
    absolutizeScriptPath("C:\\r\\", "scripts\\x.ps1"),
    "C:/r/scripts/x.ps1",
  );
  assert.equal(absolutizeScriptPath("C:/r", ".\\x.ps1"), "C:/r/x.ps1");
  assert.equal(
    absolutizeScriptPath("\\\\srv\\share\\r", "a\\b.cmd"),
    "//srv/share/r/a/b.cmd",
  );
});

test("absolutizeScriptPath never resolves ..", () => {
  assert.equal(
    absolutizeScriptPath(ROOT, "../tools/x.mjs"),
    `${ROOT}/../tools/x.mjs`,
  );
  assert.equal(
    absolutizeScriptPath(`${ROOT}/`, "scripts/../x.mjs"),
    `${ROOT}/scripts/../x.mjs`,
  );
});

test("this repository -> all repositories repairs a relative path", () => {
  assert.deepEqual(flip({}), {
    kind: "repaired",
    path: `${ROOT}/scripts/release.mjs`,
    from: "scripts/release.mjs",
  });
});

test("a Windows root with a trailing separator and backslash input", () => {
  assert.deepEqual(
    flip({ repoRoot: "C:\\ProjectRepos\\x\\", path: "scripts\\release.mjs" }),
    {
      kind: "repaired",
      path: "C:/ProjectRepos/x/scripts/release.mjs",
      from: "scripts\\release.mjs",
    },
  );
});

test("a POSIX root with a trailing slash", () => {
  assert.deepEqual(flip({ repoRoot: "/home/u/repo/", path: "scripts/x.mjs" }), {
    kind: "repaired",
    path: "/home/u/repo/scripts/x.mjs",
    from: "scripts/x.mjs",
  });
});

test("a POSIX root keeps a backslash in the file name", () => {
  assert.deepEqual(
    flip({ repoRoot: "/home/u/repo", path: "scripts\\release.sh" }),
    {
      kind: "repaired",
      path: "/home/u/repo/scripts\\release.sh",
      from: "scripts\\release.sh",
    },
  );
});

test("a ./-prefixed path drops the ./", () => {
  assert.deepEqual(flip({ path: "./scripts/x.mjs" }), {
    kind: "repaired",
    path: `${ROOT}/scripts/x.mjs`,
    from: "./scripts/x.mjs",
  });
});

test("a padded path absolutizes trimmed and restores untrimmed", () => {
  assert.deepEqual(flip({ path: " scripts/x.mjs " }), {
    kind: "repaired",
    path: `${ROOT}/scripts/x.mjs`,
    from: " scripts/x.mjs ",
  });
});

test("a parent-relative path is joined, never resolved", () => {
  assert.deepEqual(flip({ path: "../tools/x.mjs" }), {
    kind: "repaired",
    path: `${ROOT}/../tools/x.mjs`,
    from: "../tools/x.mjs",
  });
});

test("a drive-relative path resolves without the repo, so is left alone", () => {
  assert.deepEqual(flip({ path: "C:x" }), { kind: "none" });
  assert.deepEqual(flip({ path: "d:scripts\\x.ps1" }), { kind: "none" });
});

test("absolute paths are left alone", () => {
  for (const path of [
    "C:/x",
    "C:\\x",
    "/usr/x",
    "\\\\srv\\share\\x",
    "//srv/s/x",
  ])
    assert.deepEqual(flip({ path }), { kind: "none" }, path);
});

test("empty and whitespace paths are left alone", () => {
  assert.deepEqual(flip({ path: "" }), { kind: "none" });
  assert.deepEqual(flip({ path: "   " }), { kind: "none" });
  assert.deepEqual(flip({ from: "unknown", path: " " }), { kind: "none" });
});

test("no knowable root makes a relative path unrepairable", () => {
  assert.deepEqual(flip({ from: "elsewhere" }), { kind: "unrepairable" });
  assert.deepEqual(flip({ from: "unknown" }), { kind: "unrepairable" });
  assert.deepEqual(flip({ repoRoot: null }), { kind: "unrepairable" });
});

test("no knowable root still leaves an absolute path alone", () => {
  assert.deepEqual(flip({ from: "elsewhere", path: "/usr/x" }), {
    kind: "none",
  });
  assert.deepEqual(flip({ from: "unknown", path: "C:/x" }), { kind: "none" });
  assert.deepEqual(flip({ from: "elsewhere", path: "C:x" }), { kind: "none" });
});

test("only a flip to all repositories acts", () => {
  for (const to of ["this-repo", "elsewhere", "unknown"]) {
    assert.deepEqual(flip({ from: "global", to }), { kind: "none" }, to);
    assert.deepEqual(flip({ to }), { kind: "none" }, to);
  }
  // Staying global is not a flip.
  assert.deepEqual(flip({ from: "global" }), { kind: "none" });
});

test("missingScriptCase keys on absoluteness first, then scope", () => {
  const rows = [
    [true, "C:/tools/x.mjs", "absolute"],
    [false, "C:/tools/x.mjs", "absolute"],
    [true, "/usr/x", "absolute"],
    [false, "\\\\srv\\s\\x", "absolute"],
    [false, "scripts/x.mjs", "repo-relative"],
    [true, "scripts/x.mjs", "global-relative"],
    [true, "C:x", "absolute"],
    [false, "C:x", "absolute"],
  ];
  for (const [isGlobal, path, expected] of rows)
    assert.equal(
      missingScriptCase(isGlobal, path),
      expected,
      `${isGlobal} ${path}`,
    );
});
