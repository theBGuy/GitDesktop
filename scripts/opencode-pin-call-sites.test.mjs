// The opencode permission pin only binds when the production call sites in
// src-tauri/src/agent.rs feed it the run's own inputs: agent_review passes
// review_env the self-MCP server names, and both agent_session branches
// (container, then host) pass opencode_session_env the session's read_only
// flag and its opted-in server names. The checker is a pure function over the
// file's text, lexed so comments and string contents never satisfy a pin, and
// fed the real file plus in-memory mutants. An unreadable file, unterminated
// lexing, a missing anchor, an extra or missing call, or a bare mention of
// either fn fails closed.
// Out of reach: what review_env and opencode_session_env do with their
// arguments (the Rust tests pin that), a value reassigned or shadowed through a
// pattern binding or macro, calls in another file or through a re-export, and
// which branch actually runs at runtime: the branch is inferred from the
// `let container_env` / `let host_extra_env` anchors' source order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  braceBody,
  enclosingFn,
  lexRust,
  testModuleSpans,
} from "./check-rust-invariants.mjs";

const FILE = "src-tauri/src/agent.rs";

/** Top-level comma-split, whitespace-collapsed arguments of the call whose `(`
 *  sits at `open` in the masked view, or null when the parens never close. */
function callArgs(masked, open) {
  let depth = 0;
  let start = open + 1;
  const args = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      depth--;
      if (depth === 0) {
        args.push(masked.slice(start, i));
        return args.map((arg) => arg.replace(/\s+/g, " ").trim());
      }
    } else if (c === "," && depth === 1) {
      args.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/** [start, end) of `fn name`'s body in the masked view, or null. */
function fnBody(masked, name) {
  const header = new RegExp(`\\bfn ${name}\\b`).exec(masked);
  if (!header) return null;
  const open = masked.indexOf("{", header.index);
  if (open < 0) return null;
  return [open + 1, open + 1 + braceBody(masked, open).length];
}

/** The `let name … ;` statement opening inside [from, to), whitespace-collapsed,
 *  or null; `count` is how many such statements the range holds. */
function letStatement(masked, [from, to], name) {
  const re = new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\b`, "g");
  const hits = [...masked.slice(from, to).matchAll(re)];
  if (hits.length === 0) return { count: 0, text: null, at: -1 };
  const at = from + hits[0].index;
  const end = masked.indexOf(";", at);
  return {
    count: hits.length,
    at,
    text: masked.slice(at, end < 0 ? to : end).replace(/\s+/g, " "),
  };
}

function checkPinCallSites(text) {
  if (typeof text !== "string" || text.length === 0)
    return [`could not read ${FILE}`];
  const v = lexRust(text);
  if (v.unterminated >= 0) return [`could not scan ${FILE}`];
  const { masked } = v;
  const problems = [];
  const spans = testModuleSpans(masked);
  const inTest = (index) =>
    spans.some(([start, end]) => index >= start && index <= end);
  const lines = masked.split("\n");
  const lineAt = (index) => masked.slice(0, index).split("\n").length;

  const calls = { review_env: [], opencode_session_env: [] };
  for (const m of masked.matchAll(/\b(review_env|opencode_session_env)\b/g)) {
    if (inTest(m.index)) continue;
    const line = lineAt(m.index);
    if (/\bfn\s+$/.test(masked.slice(Math.max(0, m.index - 8), m.index)))
      continue;
    const rest = masked.slice(m.index + m[0].length);
    const paren = /^\s*\(/.exec(rest);
    if (!paren) {
      problems.push(
        `${FILE}:${line} mentions ${m[1]} without calling it; the pin can't follow it`,
      );
      continue;
    }
    const open = m.index + m[0].length + paren[0].length - 1;
    const args = callArgs(masked, open);
    if (!args) {
      problems.push(`${FILE}:${line} ${m[1]} call never closes`);
      continue;
    }
    calls[m[1]].push({
      index: m.index,
      line,
      fn: enclosingFn(lines, line - 1),
      args,
    });
  }

  const review = fnBody(masked, "agent_review");
  const session = fnBody(masked, "agent_session");
  if (!review) problems.push("missing anchor: fn agent_review");
  if (!session) problems.push("missing anchor: fn agent_session");
  if (!review || !session) return problems;

  // review_env: one call, in agent_review, fed the self-MCP server names.
  if (calls.review_env.length !== 1)
    problems.push(
      `expected 1 production review_env call, saw ${calls.review_env.length}${calls.review_env.map((c) => ` (${c.fn}:${c.line})`).join("")}`,
    );
  for (const call of calls.review_env) {
    if (call.fn !== "agent_review")
      problems.push(`${FILE}:${call.line} review_env called from ${call.fn}`);
    else if (call.args[3] !== "&self_names")
      problems.push(
        `${FILE}:${call.line} review_env must receive &self_names, got ${call.args[3] ?? "nothing"}`,
      );
  }
  const selfNames = letStatement(masked, review, "self_names");
  if (selfNames.count !== 1 || !/=\s*self_specs\.iter\(\)/.test(selfNames.text))
    problems.push(
      "agent_review must build self_names once, from self_specs.iter()",
    );
  const selfSpecs = letStatement(masked, review, "self_specs");
  if (
    selfSpecs.count !== 1 ||
    !/\bcrate::mcp::self_server_spec\s*\(/.test(selfSpecs.text ?? "")
  )
    problems.push(
      "agent_review must build self_specs once, from crate::mcp::self_server_spec",
    );

  // opencode_session_env: the container call, then the host call, both in
  // agent_session, both fed the session's read_only flag and server names.
  const container = letStatement(masked, session, "container_env");
  const host = letStatement(masked, session, "host_extra_env");
  if (container.count !== 1)
    problems.push("missing anchor: one let container_env in agent_session");
  if (host.count !== 1)
    problems.push("missing anchor: one let host_extra_env in agent_session");
  const sessionCalls = calls.opencode_session_env;
  if (sessionCalls.length !== 2)
    problems.push(
      `expected 2 production opencode_session_env calls, saw ${sessionCalls.length}${sessionCalls.map((c) => ` (${c.fn}:${c.line})`).join("")}`,
    );
  const branchOf = (call) => {
    if (container.at < 0 || host.at < 0 || container.at > host.at) return null;
    if (call.index > container.at && call.index < host.at) return "container";
    if (call.index > host.at && call.index < session[1]) return "host";
    return null;
  };
  const seen = new Set();
  for (const call of sessionCalls) {
    const branch = call.fn === "agent_session" ? branchOf(call) : null;
    if (!branch) {
      problems.push(
        `${FILE}:${call.line} opencode_session_env called outside agent_session's container/host branches (${call.fn})`,
      );
      continue;
    }
    if (seen.has(branch))
      problems.push(`${FILE}:${call.line} second ${branch} call`);
    seen.add(branch);
    if (call.args[0] !== "read_only")
      problems.push(
        `${FILE}:${call.line} ${branch} opencode_session_env must receive read_only, got ${call.args[0] ?? "nothing"}`,
      );
    if (call.args[3] !== "&mcp_names")
      problems.push(
        `${FILE}:${call.line} ${branch} opencode_session_env must receive &mcp_names, got ${call.args[3] ?? "nothing"}`,
      );
  }
  if (letStatement(masked, session, "read_only").count !== 0)
    problems.push("agent_session must not rebind read_only");
  // Only agent_session's own signature counts: other fns declare read_only too.
  const signature = masked.slice(
    /\bfn agent_session\b/.exec(masked).index,
    session[0],
  );
  if (!/\bread_only\s*:\s*bool\b/.test(signature))
    problems.push("missing anchor: agent_session's read_only: bool parameter");
  const mcpNames = letStatement(masked, session, "mcp_names");
  if (mcpNames.count !== 1 || !/=\s*mcp_specs\.iter\(\)/.test(mcpNames.text))
    problems.push(
      "agent_session must build mcp_names once, from mcp_specs.iter()",
    );
  return problems;
}

function readSource() {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(readFileSync(new URL(`../${FILE}`, import.meta.url)))
      .replaceAll("\r\n", "\n");
  } catch {
    return null;
  }
}

const source = readSource();

function mutate(edit) {
  const next = edit(source);
  assert.notEqual(next, source, "mutant changed nothing");
  return next;
}

const CONTAINER_CALL =
  "opencode_session_env(read_only, opencode_research, config_path, &mcp_names)";
const HOST_CALL =
  "opencode_session_env(read_only, opencode_research, mcp_config_path, &mcp_names)";
const REVIEW_CALL =
  "review_env(kind, repo_aware, mcp_config_path.as_deref(), &self_names)";

test("P1: the real agent.rs call sites pass the run's own inputs", () => {
  assert.ok(source, `${FILE} unreadable`);
  assert.deepEqual(checkPinCallSites(source), []);
});

test("P2: review_env fed &[] instead of &self_names is refused", () => {
  const problems = checkPinCallSites(
    mutate((t) =>
      t.replace(REVIEW_CALL, () => REVIEW_CALL.replace("&self_names", "&[]")),
    ),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /review_env must receive &self_names, got &\[\]/);
});

test("P3: a hard-coded read_only on either branch is refused", () => {
  for (const [call, branch] of [
    [CONTAINER_CALL, "container"],
    [HOST_CALL, "host"],
  ]) {
    for (const literal of ["false", "true"]) {
      const problems = checkPinCallSites(
        mutate((t) =>
          t.replace(call, () => call.replace("read_only", literal)),
        ),
      );
      assert.deepEqual(
        problems.map((p) => p.replace(/^[^ ]+ /, "")),
        [
          `${branch} opencode_session_env must receive read_only, got ${literal}`,
        ],
      );
    }
  }
});

test("P4: &[] instead of &mcp_names on either branch is refused", () => {
  for (const [call, branch] of [
    [CONTAINER_CALL, "container"],
    [HOST_CALL, "host"],
  ]) {
    const problems = checkPinCallSites(
      mutate((t) => t.replace(call, () => call.replace("&mcp_names", "&[]"))),
    );
    assert.deepEqual(
      problems.map((p) => p.replace(/^[^ ]+ /, "")),
      [`${branch} opencode_session_env must receive &mcp_names, got &[]`],
    );
  }
});

test("P5: a fourth call site is refused", () => {
  const planted =
    "\nfn planted(read_only: bool, mcp_names: &[&str]) { let _ = opencode_session_env(read_only, false, None, mcp_names); }\n";
  const problems = checkPinCallSites(mutate((t) => `${t}${planted}`));
  assert.ok(
    problems.some((p) =>
      p.startsWith("expected 2 production opencode_session_env calls, saw 3"),
    ),
  );
  assert.ok(problems.some((p) => p.includes("outside agent_session")));
  const review = checkPinCallSites(
    mutate(
      (t) =>
        `${t}\nfn planted2(k: AgentKind) { let _ = review_env(k, true, None, &[]); }\n`,
    ),
  );
  assert.ok(
    review.some((p) =>
      p.startsWith("expected 1 production review_env call, saw 2"),
    ),
  );
});

test("P6: comments and strings cannot satisfy a pin", () => {
  const problems = checkPinCallSites(
    mutate((t) =>
      t.replace(
        HOST_CALL,
        () =>
          `opencode_session_env(false, opencode_research, mcp_config_path, &[]) // ${HOST_CALL}`,
      ),
    ),
  );
  assert.equal(problems.length, 2);
  const quoted = checkPinCallSites(
    mutate((t) =>
      t.replace(
        REVIEW_CALL,
        () =>
          `review_env(kind, repo_aware, mcp_config_path.as_deref(), &[]); let _ = "${REVIEW_CALL}"`,
      ),
    ),
  );
  assert.ok(quoted.some((p) => p.includes("must receive &self_names")));
});

test("P7: missing anchors, rebinding and bare mentions fail closed", () => {
  assert.deepEqual(checkPinCallSites(null), [`could not read ${FILE}`]);
  assert.deepEqual(checkPinCallSites(""), [`could not read ${FILE}`]);
  assert.deepEqual(checkPinCallSites(`${source}\n"unfinished`), [
    `could not scan ${FILE}`,
  ]);
  assert.ok(
    checkPinCallSites(
      mutate((t) => t.replace("let host_extra_env", "let host_env")),
    ).includes("missing anchor: one let host_extra_env in agent_session"),
  );
  assert.ok(
    checkPinCallSites(
      mutate((t) => t.replace("fn agent_session(", "fn agent_turn(")),
    ).includes("missing anchor: fn agent_session"),
  );
  assert.ok(
    checkPinCallSites(
      mutate((t) =>
        t.replace(
          "let container = isolation",
          "let read_only = false;\n    let container = isolation",
        ),
      ),
    ).includes("agent_session must not rebind read_only"),
  );
  assert.ok(
    checkPinCallSites(
      mutate((t) =>
        t.replace(
          "let self_names: Vec<&str> = self_specs.iter()",
          "let self_names: Vec<&str> = Vec::<McpServerSpec>::new().iter()",
        ),
      ),
    ).includes(
      "agent_review must build self_names once, from self_specs.iter()",
    ),
  );
  assert.ok(
    checkPinCallSites(
      mutate((t) => `${t}\nconst F: fn() = opencode_session_env;\n`),
    ).some((p) => p.includes("mentions opencode_session_env without calling")),
  );
});

test("P8: only agent_session's own signature anchors read_only", () => {
  const PARAM = "read_only: bool";
  const mutant = mutate((t) => {
    const param = t.indexOf(PARAM, t.indexOf("fn agent_session("));
    assert.ok(param > 0, "agent_session declares no read_only parameter");
    return `${t.slice(0, param)}plan_only: bool${t.slice(param + PARAM.length)}`;
  });
  // Earlier fns still declare the parameter, so a whole-prefix search would pass.
  assert.match(
    mutant.slice(0, mutant.indexOf("fn agent_session(")),
    /\bread_only: bool\b/,
  );
  assert.deepEqual(checkPinCallSites(mutant), [
    "missing anchor: agent_session's read_only: bool parameter",
  ]);
});
