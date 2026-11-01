// The opencode permission pin only binds when the production call sites in
// src-tauri/src/agent.rs feed it the run's own inputs: agent_review passes
// review_env the self-MCP server names and the user's mirrored read rules,
// and both agent_session branches (container, then host) pass
// opencode_session_env the session's read_only flag and its opted-in server
// names; the host branch passes the mirrored read rules, the container
// branch none (its opencode loads none of the host's config files). Each
// read_mirror is built once, from opencode_read_mirror fed the OPENCODE_CONFIG
// the run gets and Path::new(&repo_path) / Path::new(&worktree_path), in the arm
// that pins the run (an opencode review, a read-only session); the other arm
// mirrors nothing. That same path is pinned as the run's spawn cwd (the
// stream_agent cwd argument of the review and of the host session) and its
// --dir (opencode_review_args' dir; agent_session's
// `let dir = run_dir(container, &worktree_path)` handed to
// opencode_session_args). The checker is a pure function over the file's text,
// lexed so comments and string contents never satisfy a pin, and fed the real
// file plus in-memory mutants; a `,` before `)` is ignored, so a rustfmt reflow
// passes. An unreadable file, unterminated lexing, a missing anchor, an extra
// or missing call, or a bare mention of either env fn fails closed.
// Out of reach: what review_env and opencode_session_env do with their
// arguments (the Rust tests pin that), what run_dir returns for a host session
// (its Rust test pins that), a value reassigned or shadowed through a pattern
// binding or macro, calls in another file or through a re-export, and which
// branch actually runs at runtime: the branch is inferred from the
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

/** Whitespace collapsed to one space, then dropped after `(` and before `)`,
 *  along with a `,` before `)`: the spots where a rustfmt reflow of the same call
 *  differs. */
const collapse = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/,\s*\)/g, ")")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");

/** The `let name … ;` statement opening inside [from, to), collapsed, or null;
 *  `count` is how many such statements the range holds. */
function letStatement(masked, [from, to], name) {
  const re = new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\b`, "g");
  const hits = [...masked.slice(from, to).matchAll(re)];
  if (hits.length === 0) return { count: 0, text: null, at: -1 };
  const at = from + hits[0].index;
  const end = masked.indexOf(";", at);
  return {
    count: hits.length,
    at,
    text: collapse(masked.slice(at, end < 0 ? to : end)),
  };
}

/** Every call of `name` opening inside [from, to): its arguments, or null when
 *  its parens never close. */
function callsIn(masked, [from, to], name) {
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  return [...masked.slice(from, to).matchAll(re)].map((m) =>
    callArgs(masked, from + m.index + m[0].length - 1),
  );
}

/** The whitespace-collapsed `let read_mirror` each fn holds, up to its `;`: the
 *  resolver, fed the run's OPENCODE_CONFIG and --dir, in the arm that pins it. */
const REVIEW_MIRROR =
  "let read_mirror = if kind == AgentKind::Opencode { opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&repo_path)) } else { OpencodeReadMirror::default() }";
const HOST_MIRROR =
  "let read_mirror = if read_only { opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&worktree_path)) } else { OpencodeReadMirror::default() }";
const RUN_DIR = "let dir = run_dir(container, &worktree_path)";

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
    if (call.fn !== "agent_review") {
      problems.push(`${FILE}:${call.line} review_env called from ${call.fn}`);
      continue;
    }
    if (call.args[3] !== "&self_names")
      problems.push(
        `${FILE}:${call.line} review_env must receive &self_names, got ${call.args[3] ?? "nothing"}`,
      );
    if (call.args[4] !== "&read_mirror")
      problems.push(
        `${FILE}:${call.line} review_env must receive &read_mirror, got ${call.args[4] ?? "nothing"}`,
      );
  }
  const reviewMirror = letStatement(masked, review, "read_mirror");
  if (reviewMirror.count !== 1 || reviewMirror.text !== collapse(REVIEW_MIRROR))
    problems.push(`agent_review must build read_mirror once: ${REVIEW_MIRROR}`);
  // The dir the resolver gets is the child's --dir and spawn cwd.
  const reviewDir = callsIn(masked, review, "opencode_review_args");
  if (reviewDir.length !== 1 || reviewDir[0]?.[3] !== "&repo_path")
    problems.push(
      "agent_review must pass opencode_review_args &repo_path once",
    );
  const reviewSpawn = callsIn(masked, review, "stream_agent");
  if (reviewSpawn.length !== 1 || reviewSpawn[0]?.[5] !== "&repo_path")
    problems.push("agent_review must spawn stream_agent once, in &repo_path");
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
    const denies =
      branch === "host" ? "&read_mirror" : "&OpencodeReadMirror::default()";
    if (call.args[4] !== denies)
      problems.push(
        `${FILE}:${call.line} ${branch} opencode_session_env must receive ${denies}, got ${call.args[4] ?? "nothing"}`,
      );
  }
  const sessionMirror = letStatement(masked, session, "read_mirror");
  if (
    sessionMirror.count !== 1 ||
    sessionMirror.at < host.at ||
    sessionMirror.text !== collapse(HOST_MIRROR)
  )
    problems.push(
      `agent_session's host branch must build read_mirror once: ${HOST_MIRROR}`,
    );
  const runDir = letStatement(masked, session, "dir");
  if (runDir.count !== 1 || runDir.text !== collapse(RUN_DIR))
    problems.push(`agent_session must build dir once: ${RUN_DIR}`);
  const sessionDir = callsIn(masked, session, "opencode_session_args");
  if (sessionDir.length !== 1 || sessionDir[0]?.[6] !== "dir")
    problems.push("agent_session must pass opencode_session_args dir once");
  const hostSpawn =
    host.at < 0 ? [] : callsIn(masked, [host.at, session[1]], "stream_agent");
  if (hostSpawn.length !== 1 || hostSpawn[0]?.[5] !== "&worktree_path")
    problems.push(
      "agent_session's host branch must spawn stream_agent once, in &worktree_path",
    );
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
  "opencode_session_env(\n                read_only,\n                opencode_research,\n                config_path,\n                &mcp_names,\n                &OpencodeReadMirror::default(),\n            )";
const HOST_CALL =
  "opencode_session_env(\n            read_only,\n            opencode_research,\n            mcp_config_path,\n            &mcp_names,\n            &read_mirror,\n        )";
const REVIEW_CALL =
  "review_env(\n        kind,\n        repo_aware,\n        mcp_config_path.as_deref(),\n        &self_names,\n        &read_mirror,\n    )";
const REVIEW_RESOLVE =
  "opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&repo_path))";
const HOST_RESOLVE =
  "opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&worktree_path))";

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
          `opencode_session_env(false, opencode_research, mcp_config_path, &[], &read_mirror) /* ${HOST_CALL} */`,
      ),
    ),
  );
  assert.equal(problems.length, 2);
  const quoted = checkPinCallSites(
    mutate((t) =>
      t.replace(
        REVIEW_CALL,
        () =>
          `review_env(kind, repo_aware, mcp_config_path.as_deref(), &[], &read_mirror); let _ = "${REVIEW_CALL}"`,
      ),
    ),
  );
  assert.ok(quoted.some((p) => p.includes("must receive &self_names")));
});

test("P9: the mirrored read rules reach each call from the resolver", () => {
  const strip = (problems) => problems.map((p) => p.replace(/^[^ ]+ /, ""));
  assert.deepEqual(
    strip(
      checkPinCallSites(
        mutate((t) =>
          t.replace(REVIEW_CALL, () =>
            REVIEW_CALL.replace(
              "&read_mirror",
              "&OpencodeReadMirror::default()",
            ),
          ),
        ),
      ),
    ),
    [
      "review_env must receive &read_mirror, got &OpencodeReadMirror::default()",
    ],
  );
  assert.deepEqual(
    strip(
      checkPinCallSites(
        mutate((t) =>
          t.replace(HOST_CALL, () =>
            HOST_CALL.replace("&read_mirror", "&OpencodeReadMirror::default()"),
          ),
        ),
      ),
    ),
    [
      "host opencode_session_env must receive &read_mirror, got &OpencodeReadMirror::default()",
    ],
  );
  assert.deepEqual(
    strip(
      checkPinCallSites(
        mutate((t) =>
          t.replace(CONTAINER_CALL, () =>
            CONTAINER_CALL.replace(
              "&OpencodeReadMirror::default()",
              "&read_mirror",
            ),
          ),
        ),
      ),
    ),
    [
      "container opencode_session_env must receive &OpencodeReadMirror::default(), got &read_mirror",
    ],
  );
  const reviewRefused = `agent_review must build read_mirror once: ${REVIEW_MIRROR}`;
  const hostRefused = `agent_session's host branch must build read_mirror once: ${HOST_MIRROR}`;
  // A resolver fed no config path, or the wrong run dir, in either fn, is refused.
  // The host call is replaced first: a mutant review call can spell HOST_RESOLVE.
  for (const [review, host] of [
    [
      REVIEW_RESOLVE.replace("mcp_config_path.as_deref()", "None"),
      HOST_RESOLVE.replace("mcp_config_path.as_deref()", "None"),
    ],
    [
      REVIEW_RESOLVE.replace("&repo_path", "&worktree_path"),
      HOST_RESOLVE.replace("&worktree_path", "&repo_path"),
    ],
  ]) {
    const mutant = mutate((t) =>
      t.replace(HOST_RESOLVE, () => host).replace(REVIEW_RESOLVE, () => review),
    );
    assert.deepEqual(checkPinCallSites(mutant), [reviewRefused, hostRefused]);
  }
  // Each arm condition is pinned: the resolver runs exactly for the pinned run.
  for (const [condition, mutantCondition, refused] of [
    [
      "if kind == AgentKind::Opencode {",
      "if kind != AgentKind::Opencode {",
      reviewRefused,
    ],
    ["if kind == AgentKind::Opencode {", "if true {", reviewRefused],
    ["if read_only {", "if !read_only {", hostRefused],
    ["if read_only {", "if true {", hostRefused],
  ]) {
    const mutant = mutate((t) => {
      const at = t.indexOf(`let read_mirror = ${condition}`);
      assert.ok(at > 0, `no let read_mirror = ${condition}`);
      const head = `let read_mirror = ${condition}`;
      return `${t.slice(0, at)}let read_mirror = ${mutantCondition}${t.slice(at + head.length)}`;
    });
    assert.deepEqual(checkPinCallSites(mutant), [refused], mutantCondition);
  }
  // Swapping the arms resolves for the unpinned run instead.
  const swapped = mutate((t) =>
    t.replace(
      `{\n        ${REVIEW_RESOLVE}\n    } else {\n        OpencodeReadMirror::default()\n    }`,
      () =>
        `{\n        OpencodeReadMirror::default()\n    } else {\n        ${REVIEW_RESOLVE}\n    }`,
    ),
  );
  assert.deepEqual(checkPinCallSites(swapped), [reviewRefused]);
});

test("P10: a rustfmt reflow with a trailing comma still passes", () => {
  const reflowed = mutate((t) =>
    t.replace(
      REVIEW_RESOLVE,
      () =>
        "opencode_read_mirror(\n            mcp_config_path.as_deref(),\n            Path::new(&repo_path),\n        )",
    ),
  );
  assert.deepEqual(checkPinCallSites(reflowed), []);
});

test("P11: the resolver's dir is each run's --dir and spawn cwd", () => {
  for (const [from, to, refused] of [
    [
      "opencode_review_args(&model, repo_aware, &effort, &repo_path)",
      "opencode_review_args(&model, repo_aware, &effort, &other_path)",
      "agent_review must pass opencode_review_args &repo_path once",
    ],
    [
      "stdin_text,\n        &repo_path,\n        timeout,",
      "stdin_text,\n        &other_path,\n        timeout,",
      "agent_review must spawn stream_agent once, in &repo_path",
    ],
    [
      "stdin_text,\n        &worktree_path,\n        SESSION_TIMEOUT,",
      "stdin_text,\n        &other_path,\n        SESSION_TIMEOUT,",
      "agent_session's host branch must spawn stream_agent once, in &worktree_path",
    ],
    [
      "let dir = run_dir(container, &worktree_path);",
      "let dir = run_dir(true, &worktree_path);",
      `agent_session must build dir once: ${RUN_DIR}`,
    ],
    [
      "web,\n                    dir,\n                )",
      "web,\n                    &worktree_path,\n                )",
      "agent_session must pass opencode_session_args dir once",
    ],
  ]) {
    const mutant = mutate((t) => {
      assert.equal(t.split(from).length, 2, `not unique: ${from}`);
      return t.replace(from, () => to);
    });
    assert.deepEqual(checkPinCallSites(mutant), [refused], to);
  }
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
