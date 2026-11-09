// Pins the Rust side of the hide-whitespace mode: `-w` reaches a view diff's
// content argv only through `with_ignore_whitespace` (git/diff.rs), never a
// `--name-status`/`--name-only` probe (the pane must keep agreeing with its file
// list), never the shared `diff_with_rename_pairing`, and never a non-view diff,
// patch writer or MCP reader. Every pin reads source TEXT, so each one has an
// in-memory mutation control that must turn it red; nothing touches disk.
// Fails closed: an unreadable file, or an anchor found more or less than once,
// is a failure, never a skip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { braceBody, lexRust } from "./check-rust-invariants.mjs";

const SRC = new URL("../src-tauri/src/", import.meta.url);
const DIFF = "git/diff.rs";
const HISTORY = "git/history.rs";
const COMPARE = "git/compare.rs";
const OPS = "git/ops.rs";
const CONFLICT = "git/conflict.rs";
const READ_GIT = "mcp_server/read_git.rs";

function source(rel) {
  return readFileSync(new URL(rel, SRC), "utf8").replace(/\r\n/g, "\n");
}

function sources() {
  return Object.fromEntries(
    [DIFF, HISTORY, COMPARE, OPS, CONFLICT, READ_GIT].map((f) => [
      f,
      source(f),
    ]),
  );
}

/** The span of the file's `#[cfg(test)]` + `mod tests {` module, which must
 *  occur exactly once; a lone `#[cfg(test)]` also guards single items. */
function testSpan(file, masked) {
  const marker = "\n#[cfg(test)]\nmod tests {";
  const first = masked.indexOf(marker);
  if (first < 0 || masked.indexOf(marker, first + 1) >= 0) {
    throw new Error(`${file}: the test module marker is not unique`);
  }
  const open = first + marker.length - 1;
  return [first, open + 1 + braceBody(masked, open).length + 1];
}

/** Index of the delimiter closing the one opening at `at`, in `masked`. */
function matching(masked, at) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let k = at; k < masked.length; k++) {
    const ch = masked[k];
    if (ch in pairs) stack.push(pairs[ch]);
    else if (")]}".includes(ch)) {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return k;
    }
  }
  return -1;
}

/** A function found by its anchor at a line start, exactly once: its parameter
 *  list (when the anchor ends in `(`) and its body, as `code` slices. */
function fnParts(file, text, anchor) {
  const { code, masked } = lexRust(text);
  const hits = [];
  for (
    let at = masked.indexOf(anchor);
    at >= 0;
    at = masked.indexOf(anchor, at + 1)
  ) {
    if (at === 0 || masked[at - 1] === "\n") hits.push(at);
  }
  if (hits.length !== 1) {
    throw new Error(
      `${file}: anchor \`${anchor}\` found ${hits.length} times at a line start`,
    );
  }
  const start = hits[0];
  // From the anchor's own end: a `pub(crate)` lead holds a paren of its own.
  const parenAt = masked.indexOf("(", start + anchor.length - 1);
  const parenEnd = matching(masked, parenAt);
  const open = masked.indexOf("{", parenEnd);
  if (parenEnd < 0 || open < 0)
    throw new Error(`${file}: cannot bound \`${anchor}\``);
  const close = open + 1 + braceBody(masked, open).length;
  return {
    params: code
      .slice(parenAt + 1, parenEnd)
      .replace(/\s+/g, " ")
      .trim(),
    body: code.slice(open, close + 1),
    whole: code.slice(start, close + 1),
    open,
    close,
  };
}

function wCount(code) {
  return code.split('"-w"').length - 1;
}

// P1: diff.rs outside its tests holds one `"-w"`, inside the helper's body.
function helperProblems(text) {
  const problems = [];
  const { code, masked } = lexRust(text);
  const [ts, te] = testSpan(DIFF, masked);
  const outside = code.slice(0, ts) + code.slice(te);
  const helper = fnParts(DIFF, text, "pub(crate) fn with_ignore_whitespace<");
  if (wCount(outside) !== 1) {
    problems.push(
      `diff.rs holds ${wCount(outside)} "-w" literals outside its tests, not 1`,
    );
  }
  if (wCount(helper.body) !== 1)
    problems.push('the helper body does not hold the "-w"');
  return problems;
}

// P2: the shared rename-pairing helper never learns about the flag.
function pairingProblems(text) {
  const problems = [];
  const f = fnParts(
    DIFF,
    text,
    "pub(crate) async fn diff_with_rename_pairing(",
  );
  if (
    f.params !==
    "repo: &str, file_path: &str, content: &[&str], probe: &[&str],"
  ) {
    problems.push(`diff_with_rename_pairing parameters changed: ${f.params}`);
  }
  if (f.body.includes("ignore_whitespace") || wCount(f.body) > 0) {
    problems.push("diff_with_rename_pairing's body carries the flag");
  }
  return problems;
}

// P3: every helper call's own argv holds no probe flag.
const HELPER_CALLS = { [DIFF]: 5, [HISTORY]: 1, [COMPARE]: 1, [OPS]: 2 };
function probeProblems(texts) {
  const problems = [];
  let total = 0;
  for (const [file, expected] of Object.entries(HELPER_CALLS)) {
    const { code, masked } = lexRust(texts[file]);
    const [ts, te] = testSpan(file, masked);
    let calls = 0;
    for (const m of masked.matchAll(/\bwith_ignore_whitespace\(/g)) {
      if (m.index > ts && m.index < te) continue;
      calls++;
      const open = m.index + m[0].length - 1;
      const end = matching(masked, open);
      if (end < 0) {
        problems.push(`${file}: cannot bound a with_ignore_whitespace( call`);
        continue;
      }
      const args = code.slice(open, end + 1);
      if (args.includes('"--name-status"') || args.includes('"--name-only"')) {
        problems.push(
          `${file}: a probe argv is wrapped: ${args.replace(/\s+/g, " ")}`,
        );
      }
    }
    if (calls < expected)
      problems.push(`${file}: ${calls} helper calls, expected ${expected}`);
    total += calls;
  }
  if (total < 9) problems.push(`${total} helper calls in all, expected 9`);
  return problems;
}

// P4: view commands outside diff.rs never spell the flag themselves.
const SELF_PUSH = [
  [HISTORY, "pub async fn git_commit_file_diff("],
  [COMPARE, "pub async fn git_branch_file_diff("],
  [OPS, "async fn stash_file_diff_at("],
];
function selfPushProblems(texts) {
  return SELF_PUSH.filter(
    ([file, anchor]) => wCount(fnParts(file, texts[file], anchor).body) > 0,
  ).map(([file, anchor]) => `${file}: \`${anchor}\` spells "-w" itself`);
}

// P5: the non-view diff surface, patch writers and conflict reads stay flagless.
const NON_VIEW = [
  [DIFF, "pub async fn git_staged_diff("],
  [DIFF, "pub async fn git_apply_patch("],
  [DIFF, "pub async fn git_apply_partial("],
  [DIFF, "pub fn build_partial_patch("],
  [COMPARE, "pub async fn git_branch_diff("],
  [COMPARE, "pub async fn git_diff_between_refs("],
  [HISTORY, "pub async fn git_commit_diff("],
  [OPS, "pub async fn git_discard_untracked_lines("],
  [OPS, "pub(crate) async fn git_discard_untracked_lines_core("],
  [CONFLICT, "pub async fn git_diff_contents("],
];
function nonViewProblems(texts) {
  return NON_VIEW.filter(([file, anchor]) => {
    const { whole } = fnParts(file, texts[file], anchor);
    return whole.includes("ignore_whitespace") || wCount(whole) > 0;
  }).map(([file, anchor]) => `${file}: \`${anchor}\` carries the flag`);
}

// P6: the MCP reader never sees the flag.
function mcpProblems(text) {
  const { code } = lexRust(text);
  return code.includes("ignore_whitespace") || wCount(code) > 0
    ? ["read_git.rs carries the whitespace flag"]
    : [];
}

// P7: the seven view functions take the parameter and route it.
const VIEW = [
  [DIFF, "pub async fn git_diff_file(", "helper"],
  [DIFF, "pub async fn git_session_file_diff(", "helper"],
  [HISTORY, "pub async fn git_commit_file_diff(", "helper"],
  [COMPARE, "pub async fn git_branch_file_diff(", "helper"],
  [OPS, "async fn stash_file_diff_at(", "helper"],
  [OPS, "pub async fn git_stash_file_diff(", "forward"],
  [OPS, "pub async fn git_orphaned_stash_file_diff(", "forward"],
];
function viewProblems(texts) {
  const problems = [];
  for (const [file, anchor, route] of VIEW) {
    const text = texts[file];
    const f = fnParts(file, text, anchor);
    if (!f.params.includes("ignore_whitespace: Option<bool>")) {
      problems.push(`${file}: \`${anchor}\` lacks the parameter`);
    }
    if (route === "helper" && !f.body.includes("with_ignore_whitespace(")) {
      problems.push(`${file}: \`${anchor}\` does not call the helper`);
    }
    if (route === "forward") {
      const { code, masked } = lexRust(text);
      const at = masked.indexOf("stash_file_diff_at(", f.open);
      const end =
        at < 0 || at > f.close
          ? -1
          : matching(masked, at + "stash_file_diff_at".length);
      if (end < 0 || !/\bignore_whitespace\b/.test(code.slice(at, end))) {
        problems.push(`${file}: \`${anchor}\` does not forward the flag`);
      }
    }
  }
  return problems;
}

function mutate(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation target not unique: ${from}`);
  return parts.join(to);
}

/** A mutant goes red only by the pin reporting a problem: an anchor or lookup
 *  error thrown on the way propagates, so a control can never pass for it. */
function red(pin, input) {
  return pin(input).length > 0;
}

test("the whitespace flag rides only the view diffs' content argv", () => {
  const t = sources();
  assert.deepEqual(helperProblems(t[DIFF]), []);
  assert.deepEqual(pairingProblems(t[DIFF]), []);
  assert.deepEqual(probeProblems(t), []);
  assert.deepEqual(selfPushProblems(t), []);
  assert.deepEqual(nonViewProblems(t), []);
  assert.deepEqual(mcpProblems(t[READ_GIT]), []);
  assert.deepEqual(viewProblems(t), []);
});

test("P1 mutation control: a stray -w outside the helper goes red", () => {
  const t = sources();
  const mutant = mutate(
    t[DIFF],
    '        args.extend(["--", spec.as_str()]);\n',
    '        args.extend(["--", spec.as_str()]);\n        args.push("-w");\n',
  );
  assert.ok(red(helperProblems, mutant));
});

test("P2 mutation controls: the pairing helper's body and signature go red", () => {
  const t = sources();
  const body = mutate(
    t[DIFF],
    '    let mut args = content.to_vec();\n    args.extend(["--", new_spec.as_str()]);\n',
    '    let mut args = content.to_vec();\n    args.push("-w");\n    args.extend(["--", new_spec.as_str()]);\n',
  );
  const signature = mutate(
    t[DIFF],
    "    probe: &[&str],\n) -> AppResult<PathDiff> {",
    "    probe: &[&str],\n    ignore_whitespace: Option<bool>,\n) -> AppResult<PathDiff> {",
  );
  assert.ok(red(pairingProblems, body));
  assert.ok(red(pairingProblems, signature));
});

test("P3 mutation control: a wrapped probe argv goes red", () => {
  const t = sources();
  const compare = mutate(
    t[COMPARE],
    '        &["diff", "--no-ext-diff", "--name-status", "-z", &range],',
    '        &crate::git::diff::with_ignore_whitespace(\n            &["diff", "--no-ext-diff", "--name-status", "-z", &range],\n            ignore_whitespace,\n        ),',
  );
  assert.ok(red(probeProblems, { ...t, [COMPARE]: compare }));
});

test("P4 mutation controls: a view command pushing -w itself goes red", () => {
  const t = sources();
  const cases = [
    [
      HISTORY,
      "    validate_hash(&hash)?;\n    // The helper passes literal pathspecs",
    ],
    [COMPARE, '    let range = format!("{base}...{compare}");\n'],
    [
      OPS,
      '    let base = format!("{spec}^1");\n    let out = crate::git::diff::diff_with_rename_pairing(',
    ],
  ];
  for (const [file, anchor] of cases) {
    const mutant = mutate(t[file], anchor, `    args.push("-w");\n${anchor}`);
    assert.ok(red(selfPushProblems, { ...t, [file]: mutant }), file);
  }
});

test("P5 mutation controls: the flag on a non-view function goes red", () => {
  const t = sources();
  const staged = mutate(
    t[DIFF],
    "    worktree: Option<bool>,\n) -> AppResult<StagedDiff> {",
    "    worktree: Option<bool>,\n    ignore_whitespace: Option<bool>,\n) -> AppResult<StagedDiff> {",
  );
  const apply = mutate(
    t[DIFF],
    'let mut args = vec!["apply", "--whitespace=nowarn"];',
    'let mut args = vec!["apply", "--whitespace=nowarn", "-w"];',
  );
  assert.ok(red(nonViewProblems, { ...t, [DIFF]: staged }));
  assert.ok(red(nonViewProblems, { ...t, [DIFF]: apply }));
});

test("P6 mutation control: -w in the MCP reader goes red", () => {
  const t = sources();
  const mutant = mutate(
    t[READ_GIT],
    'let content = ["show", "--no-show-signature", "--no-color", sha];',
    'let content = ["show", "--no-show-signature", "--no-color", "-w", sha];',
  );
  assert.ok(red(mcpProblems, mutant));
});

test("P7 mutation control: a view command passing its argv bare goes red", () => {
  const t = sources();
  const compare = mutate(
    t[COMPARE],
    '        &crate::git::diff::with_ignore_whitespace(\n            &["diff", "--no-ext-diff", "--no-color", &range],\n            ignore_whitespace,\n        ),\n',
    '        &["diff", "--no-ext-diff", "--no-color", &range],\n',
  );
  assert.ok(red(viewProblems, { ...t, [COMPARE]: compare }));
});

test("P7 mutation controls: a stash command forwarding None goes red", () => {
  const t = sources();
  for (const spec of ["&spec", "&sha"]) {
    const call = `    stash_file_diff_at(&repo_path, ${spec}, &file_path, ignore_whitespace).await
`;
    const mutant = mutate(
      t[OPS],
      call,
      call.replace("ignore_whitespace", "None"),
    );
    const problems = viewProblems({ ...t, [OPS]: mutant });
    assert.equal(problems.length, 1, spec);
    assert.match(problems[0], /does not forward the flag/);
  }
});
