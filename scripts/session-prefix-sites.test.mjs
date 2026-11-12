// Tripwire for the agent-session namespace check: every `src/` comparison
// against `gd/session/` goes through `isSessionBranchName`
// (src/lib/git/ref-name.ts), which matches the prefix in any case, because a
// case-insensitive filesystem can land `GD/Session/x` inside the namespace and
// a case-sensitive `startsWith` would then offer it in a picker.
//
// What it flags: outside ref-name.ts, any string or template literal whose
// WHOLE content is `gd/session/` (any quote, any case), and
// `startsWith(SESSION_BRANCH_PREFIX)`. Copy that merely starts with the prefix
// and fixture names (`"gd/session/abc"`) are not comparisons and pass.
// What it cannot see: a prefix built by concatenation, a regex, a comparison
// through a renamed or re-exported constant, `indexOf`/`slice` tests, and files
// outside `src/` (the Rust side has its own guard).
//
// Two allowances, each with its reason:
// - PERMITTED folders (`src/features/{pulls,issues,conversations,projects}/`)
//   may hold the literal and are never required to: another lane edits them
//   and may move or fix `useBranchPickerOptions.tsx`'s comparison, which must
//   not turn this scan red either way.
// - STRICT entries still hold the literal and MUST: an entry whose file no
//   longer holds it fails, so it cannot outlive the fix that removes it.
//
// Fails closed: an empty corpus, an unreadable file or a non-string entry is a
// failure, never a pass. Node's stdlib only, so the installless CI `guards` job
// runs it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const HELPER_HOME = "src/lib/git/ref-name.ts";

const PERMITTED_FOLDERS = [
  "src/features/pulls/",
  "src/features/issues/",
  "src/features/conversations/",
  "src/features/projects/",
];

/** Files that still spell the literal until the package that owns them swaps
 *  them onto the helper. Each entry must still match, or the scan fails. */
const STRICT = {};

const SESSION_LITERAL = /(?<!\\)(["'`])gd\/session\/\1/i;
const PREFIX_CONSTANT = /startsWith\(\s*SESSION_BRANCH_PREFIX\s*\)/;

/** Problems over a `{ path → text }` corpus; empty means clean. */
export function checkSessionPrefixSites(files, strict = STRICT) {
  const problems = [];
  const paths = Object.keys(files);
  if (paths.length === 0) return ["no src/ files were read"];
  for (const path of paths) {
    const text = files[path];
    if (typeof text !== "string") {
      problems.push(`${path}: unreadable (${String(text)})`);
      continue;
    }
    if (path === HELPER_HOME) continue;
    const spelled = SESSION_LITERAL.test(text) || PREFIX_CONSTANT.test(text);
    if (PERMITTED_FOLDERS.some((folder) => path.startsWith(folder))) continue;
    if (path in strict) {
      if (!spelled)
        problems.push(
          `${path}: STRICT entry no longer holds the literal; remove it from STRICT`,
        );
      continue;
    }
    if (spelled)
      problems.push(
        `${path}: compares against the session prefix case-sensitively; use isSessionBranchName from @/lib/git/ref-name`,
      );
  }
  for (const path of Object.keys(strict)) {
    if (!(path in files))
      problems.push(`${path}: STRICT entry names a file that was not read`);
  }
  return problems;
}

function walkSrc(dir = "src", out = {}) {
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      try {
        out[rel] = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
      } catch (e) {
        out[rel] = new Error(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return out;
}

const tree = walkSrc();
const CLEAN = "src/features/compare/ComparePanel.tsx";
const PERMITTED_FILE = "src/features/pulls/useBranchPickerOptions.tsx";

test("the tree compares against the session prefix only through the helper", () => {
  assert.deepEqual(checkSessionPrefixSites(tree), []);
});

test("the corpus is the real src/ tree", () => {
  assert.ok(Object.keys(tree).length > 100, "too few src/ files read");
  assert.ok(CLEAN in tree, `${CLEAN} was not read`);
  assert.ok(
    tree[HELPER_HOME].includes('SESSION_BRANCH_PREFIX = "gd/session/"'),
    "ref-name.ts no longer defines the prefix",
  );
});

for (const [quote, spelled] of [
  ["double", '!b.name.startsWith("gd/session/")'],
  ["single", "!b.name.startsWith('gd/session/')"],
  ["template", "!b.name.startsWith(`gd/session/`)"],
  ["upper-case", '!b.name.startsWith("GD/Session/")'],
  ["constant", "!b.name.startsWith(SESSION_BRANCH_PREFIX)"],
]) {
  test(`a mutant re-adding a ${quote} comparison outside the permitted folders fails`, () => {
    const mutant = {
      ...tree,
      [CLEAN]: `${tree[CLEAN]}\nconst x = ${spelled};\n`,
    };
    const problems = checkSessionPrefixSites(mutant);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /ComparePanel\.tsx: compares against/);
  });
}

test("an empty corpus fails", () => {
  assert.deepEqual(checkSessionPrefixSites({}), ["no src/ files were read"]);
});

test("an unreadable file fails", () => {
  const problems = checkSessionPrefixSites({
    ...tree,
    [CLEAN]: new Error("EACCES"),
  });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /ComparePanel\.tsx: unreadable/);
});

test("a stale STRICT entry fails", () => {
  // STRICT is empty once every site is swapped, so the entry is the test's own.
  const problems = checkSessionPrefixSites(tree, { [CLEAN]: "test" });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /STRICT entry no longer holds the literal/);
});

test("a STRICT entry naming an unread file fails", () => {
  const problems = checkSessionPrefixSites(tree, {
    ...STRICT,
    "src/features/repository/Gone.tsx": "test",
  });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /Gone\.tsx: STRICT entry names a file/);
});

test("a permitted folder may add or drop the literal", () => {
  const added = {
    ...tree,
    "src/features/issues/New.tsx": 'n.startsWith("gd/session/")',
  };
  assert.deepEqual(checkSessionPrefixSites(added), []);
  const dropped = {
    ...tree,
    [PERMITTED_FILE]: String(tree[PERMITTED_FILE] ?? "").replace(
      /(["'`])gd\/session\/\1/gi,
      "SESSION",
    ),
  };
  assert.deepEqual(checkSessionPrefixSites(dropped), []);
});

test("copy and fixture names that start with the prefix pass", () => {
  const files = {
    [CLEAN]: [
      '"gd/session/ is reserved for agent sessions — choose another name"',
      'const head = "gd/session/abc";',
      "const id = `gd/session/${n}`;",
      "// Names under \\`gd/session/\\` are reserved",
    ].join("\n"),
  };
  assert.deepEqual(checkSessionPrefixSites(files, {}), []);
});
