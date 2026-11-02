// Production paths under the system temp dir must be created through tempfile,
// except for the closed, counted exclusions below: guessable names in a shared
// temp dir can be planted or swapped before their consumer opens them.
// The checker is a pure function over source text, fed real files and in-memory
// mutants. Invalid UTF-8, empty input, unreadable lexing and stale exclusions
// fail closed.
// Out of reach: non-literal env keys, another crate's temp-root API, macro-built
// paths, fragment-built temp paths ("/t" + "mp", concat! or format! pieces),
// further paths derived from an excluded call's value, dirs::cache_dir() and
// other shared roots, other shared-temp literals ("/var/tmp", "/dev/shm",
// %TEMP%/%TMP% script text), and code outside src-tauri/src (including
// build.rs). Attribute-gated test items outside a mod are scanned as
// production, and env-key literals match in any case (a bare lowercase "tmp"
// only as an env call's key or the first element of a parenthesized list, so
// any call's first argument too), both deliberately over-reporting in the safe
// direction.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import {
  enclosingFn,
  lexRust,
  testModuleSpans,
} from "./check-rust-invariants.mjs";

const EXCLUDED = [
  {
    file: "git/compare.rs",
    fn: "ephemeral_review_worktree",
    count: 1,
    reason:
      "Mints the guessable review-worktree path temp_dir()/gd-review-{short}-{nanos}; remove this entry when ephemeral_review_worktree moves to a private temp dir.",
  },
  {
    file: "git/compare.rs",
    fn: "is_review_worktree_temp_path",
    count: 1,
    reason:
      "This fn only compares a path's parent with temp_dir() to confirm it is a review worktree the app handed out; it creates nothing.",
  },
  {
    file: "git/compare.rs",
    fn: "sweep_review_worktree_husks",
    count: 1,
    reason:
      "This fn only passes temp_dir() to sweep_review_husks_in, which deletes empty review-worktree husks; it creates nothing.",
  },
  {
    file: "local_prs.rs",
    fn: "resolve_store_dir",
    count: 1,
    reason:
      "This call is the is_test arm of the store resolver, which callers take only under cfg!(test), so release builds never build this path.",
  },
  {
    file: "oplog.rs",
    fn: "resolve_test_store",
    count: 2,
    reason:
      "This fn resolves the oplog's test-only store (one call canonicalizes temp_dir() to check that a repo lives under it, the other joins the fixed gd-oplog-test dir). Its only callers are store_path's cfg!(test) arm and resolve_store_base's is_test arm, which store_path calls with is_test = false, so release builds never reach it.",
  },
  {
    file: "review_notes.rs",
    fn: "resolve_store_base",
    count: 1,
    reason:
      "This call is the is_test arm of the store resolver, which callers take only under cfg!(test), so release builds never build this path.",
  },
];

const REMEDY =
  "create it with tempfile::Builder (random name, exclusive create, owner-only on unix), as agent_sandbox::private_temp_dir / write_temp_script do";

const SHARED_TEMP_LITERALS = [
  /"\/tmp(?:\/[^"]*)?"/g,
  /"(?:TMPDIR|TEMP|TMP)"/gi,
];
// A bare lowercase "tmp" is also a file-name word (temp-file suffixes), so it is
// refused only where it can be an env key: the first argument of an env read or
// write, or a tuple's first element (`("tmp", dir)` pairs feed `.envs(…)`, and
// Windows env names ignore case). Every other spelling of the keys is refused
// anywhere.
const TMP_KEY_ARMS = [
  {
    before: /\b(?:var|var_os|set_var|remove_var|env|env_remove)\s*\(\s*$/,
    after: /^/,
  },
  { before: /\(\s*$/, after: /^\s*,/ },
];

function checkTempPaths(
  sources,
  literals = SHARED_TEMP_LITERALS,
  tmpKeyArms = TMP_KEY_ARMS,
) {
  const problems = [];
  const counts = new Map(EXCLUDED.map((entry) => [entry, 0]));
  if (Object.keys(sources).length === 0) problems.push("empty corpus");
  for (const [file, text] of Object.entries(sources)) {
    if (typeof text !== "string") {
      problems.push(`could not scan ${file}`);
      continue;
    }
    const v = lexRust(text);
    if (v.unterminated >= 0) {
      problems.push(`could not scan ${file}`);
      continue;
    }
    const spans = testModuleSpans(v.masked);
    const inTest = (index) =>
      spans.some(([start, end]) => index >= start && index <= end);
    const codeLines = v.code.split("\n");
    const lineAt = (index) => v.code.slice(0, index).split("\n").length;
    for (const match of v.masked.matchAll(/\btemp_dir\b/g)) {
      if (inTest(match.index)) continue;
      const line = lineAt(match.index);
      if (!/^\s*\(/.test(v.masked.slice(match.index + match[0].length))) {
        problems.push(
          `${file}:${line} references temp_dir without calling it (an import, alias or fn pointer); the check can't follow it — create the path with tempfile::Builder instead`,
        );
        continue;
      }
      const fn = enclosingFn(codeLines, line - 1);
      const excluded = EXCLUDED.find(
        (entry) => entry.file === file && entry.fn === fn,
      );
      if (excluded) counts.set(excluded, counts.get(excluded) + 1);
      else
        problems.push(
          `${file}:${line} (${fn}) builds a path under std::env::temp_dir(); ${REMEDY}`,
        );
    }
    for (const pattern of literals) {
      for (const match of v.code.matchAll(pattern)) {
        if (inTest(match.index)) continue;
        if (match[0] === '"tmp"') {
          const before = v.code.slice(
            Math.max(0, match.index - 64),
            match.index,
          );
          const end = match.index + match[0].length;
          const after = v.code.slice(end, end + 64);
          if (
            !tmpKeyArms.some(
              (arm) => arm.before.test(before) && arm.after.test(after),
            )
          )
            continue;
        }
        problems.push(
          `${file}:${lineAt(match.index)} uses shared-temp literal ${match[0]}; ${REMEDY}`,
        );
      }
    }
  }
  for (const entry of EXCLUDED) {
    const missing = !Object.hasOwn(sources, entry.file);
    const count = counts.get(entry);
    if (missing || count !== entry.count)
      problems.push(
        `stale exclusion ${entry.file}/${entry.fn}: expected ${entry.count}, saw ${count}${missing ? " (missing file)" : ""}`,
      );
  }
  return problems;
}

function decodeSource(file, bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replaceAll("\r\n", "\n");
  } catch {
    return { problem: `could not scan ${file}` };
  }
}

function realSources() {
  const root = new URL("../src-tauri/src/", import.meta.url);
  const sources = {};
  function walk(relative) {
    for (const name of readdirSync(new URL(relative, root)).sort()) {
      const file = `${relative}${name}`;
      const url = new URL(file, root);
      if (statSync(url).isDirectory()) walk(`${file}/`);
      else if (file.endsWith(".rs"))
        sources[file] = decodeSource(file, readFileSync(url));
    }
  }
  walk("");
  return sources;
}

function mutate(sources, file, edit) {
  const next = edit(sources[file]);
  assert.notEqual(next, sources[file], `mutant of ${file} changed nothing`);
  return { ...sources, [file]: next };
}

function mutateReviewBody(sources, edit) {
  return mutate(sources, "git/compare.rs", (text) => {
    const { masked } = lexRust(text);
    const header = /\bfn ephemeral_review_worktree\b[^{}]*\{/.exec(masked);
    assert.ok(header, "ephemeral_review_worktree not found");
    const start = header.index + header[0].length;
    let end = start;
    let depth = 1;
    while (end < masked.length && depth > 0) {
      if (masked[end] === "{") depth++;
      if (masked[end] === "}") depth--;
      end++;
    }
    assert.equal(depth, 0, "ephemeral_review_worktree body not closed");
    return (
      text.slice(0, start) +
      edit(text.slice(start, end - 1)) +
      text.slice(end - 1)
    );
  });
}

const sources = realSources();
const planted =
  'fn planted() { let _ = std::env::temp_dir().join(format!("gd-x-{}", std::process::id())); }';

test("T1: real production sources use private temp paths", () => {
  const problems = checkTempPaths(sources);
  assert.ok(!problems.some((problem) => problem.includes("could not scan")));
  assert.deepEqual(problems, []);
});

test("T2: a production temp_dir mint is refused", () => {
  const problems = checkTempPaths(
    mutate(sources, "agent_sandbox.rs", (text) => `${text}\n${planted}\n`),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /agent_sandbox\.rs:\d+ \(planted\)/);
});

test("T3: a mint inside a test module is ignored", () => {
  assert.deepEqual(
    checkTempPaths(
      mutate(
        sources,
        "agent_sandbox.rs",
        (text) => `${text}\n#[cfg(test)]\nmod planted_tests {\n${planted}\n}\n`,
      ),
    ),
    [],
  );
});

test("T4: comments and string contents do not mint paths", () => {
  assert.deepEqual(
    checkTempPaths(
      mutate(
        sources,
        "agent_sandbox.rs",
        (text) =>
          `${text}\n// ${planted}\nconst PLANTED: &str = r#"${planted}"#;\n`,
      ),
    ),
    [],
  );
});

test("T5: imported aliases cannot bypass the check", () => {
  const problems = checkTempPaths(
    mutate(
      sources,
      "pty.rs",
      (text) => `${text}\nuse std::env::temp_dir as td;\n`,
    ),
  );
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /pty\.rs:\d+ references temp_dir without calling it/,
  );
});

test("T6: another call in an excluded function is refused", () => {
  const problems = checkTempPaths(
    mutateReviewBody(sources, (body) => `\nstd::env::temp_dir();\n${body}`),
  );
  assert.deepEqual(problems, [
    "stale exclusion git/compare.rs/ephemeral_review_worktree: expected 1, saw 2",
  ]);
});

test("T7: a retired call makes its exclusion stale", () => {
  const problems = checkTempPaths(
    mutateReviewBody(sources, (body) =>
      body.replaceAll("temp_dir", "private_dir"),
    ),
  );
  assert.deepEqual(problems, [
    "stale exclusion git/compare.rs/ephemeral_review_worktree: expected 1, saw 0",
  ]);
});

test("T8: shared-temp path and environment literals are refused", () => {
  const problems = checkTempPaths(
    mutate(
      sources,
      "pty.rs",
      (text) =>
        `${text}\nfn planted() { let _ = "/tmp/gd-x"; let _ = "TMPDIR"; }\n`,
    ),
  );
  assert.equal(problems.length, 2);
  assert.ok(
    problems.some((problem) => problem.includes('literal "/tmp/gd-x"')),
  );
  assert.ok(problems.some((problem) => problem.includes('literal "TMPDIR"')));
});

test("T9: unreadable, empty and missing input fails closed", () => {
  const problems = checkTempPaths({
    "pty.rs": `${sources["pty.rs"]}\n"unfinished`,
  });
  assert.ok(problems.includes("could not scan pty.rs"));
  assert.ok(checkTempPaths({}).includes("empty corpus"));
  const missing = { ...sources };
  delete missing["git/compare.rs"];
  assert.ok(
    checkTempPaths(missing).includes(
      "stale exclusion git/compare.rs/ephemeral_review_worktree: expected 1, saw 0 (missing file)",
    ),
  );
});

test("T10: clean lexing still scans production calls", () => {
  const problems = checkTempPaths({ "agent_sandbox.rs": `${planted}\n` });
  assert.ok(
    problems.some((problem) => /agent_sandbox\.rs:1 \(planted\)/.test(problem)),
  );
  assert.ok(!problems.some((problem) => problem.includes("could not scan")));
});

test("T11: a call after the rulesets test module remains production", () => {
  const problems = checkTempPaths(
    mutate(sources, "github/rulesets.rs", (text) => `${text}\n${planted}\n`),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /github\/rulesets\.rs:\d+ \(planted\)/);
});

test("T12: invalid UTF-8 fails closed before scanning", () => {
  const decoded = decodeSource("pty.rs", new Uint8Array([0xff]));
  assert.deepEqual(decoded, { problem: "could not scan pty.rs" });
  assert.ok(
    checkTempPaths({ ...sources, "pty.rs": decoded }).includes(
      "could not scan pty.rs",
    ),
  );
});

test("T13: lowercase and mixed-case env-key literals are refused", () => {
  const planted = mutate(
    sources,
    "pty.rs",
    (text) =>
      `${text}\nfn planted() { let _ = "tmpdir"; let _ = "Temp"; let _ = "tMp"; let _ = std::env::var_os("tmp"); cmd.env_remove( "tmp"); }\n`,
  );
  const refusesEveryCase = (literals) => {
    const problems = checkTempPaths(planted, literals);
    assert.equal(problems.length, 5);
    for (const key of ["tmpdir", "Temp", "tMp"])
      assert.ok(problems.some((problem) => problem.includes(`"${key}"`)));
    assert.equal(
      problems.filter((problem) => problem.includes('"tmp"')).length,
      2,
    );
  };
  refusesEveryCase(SHARED_TEMP_LITERALS);
  const caseSensitive = SHARED_TEMP_LITERALS.map(
    (re) => new RegExp(re.source, re.flags.replace("i", "")),
  );
  assert.throws(() => refusesEveryCase(caseSensitive));
});

test("T14: a lowercase tmp outside an env call's key stays a file-name word", () => {
  assert.deepEqual(
    checkTempPaths(
      mutate(
        sources,
        "pty.rs",
        (text) =>
          `${text}\nfn planted() { let _ = unique_sibling(dest, "tmp"); let _ = name.unwrap_or("tmp"); let _ = ("tmp"); }\n`,
      ),
    ),
    [],
  );
});

test("T15: a lowercase tmp as a tuple's first element is refused", () => {
  const planted = mutate(
    sources,
    "pty.rs",
    (text) =>
      `${text}\nfn planted() { let mut env = Vec::new(); env.push(("tmp", dir)); cmd.envs([( "tmp" ,\n dir)]); }\n`,
  );
  const refusesBothTuples = (arms) => {
    const problems = checkTempPaths(planted, SHARED_TEMP_LITERALS, arms);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((problem) => problem.includes('literal "tmp"')));
  };
  refusesBothTuples(TMP_KEY_ARMS);
  // The env-call arm alone lets both tuples through.
  assert.throws(() => refusesBothTuples(TMP_KEY_ARMS.slice(0, 1)));
});
