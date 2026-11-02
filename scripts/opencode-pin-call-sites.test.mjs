// The opencode permission pin only binds when the production call sites in
// src-tauri/src/agent.rs feed it the run's own inputs: agent_review passes
// review_env kind, repo_aware, the run's OPENCODE_CONFIG, the self-MCP server
// names and the mirrored read rules, and opencode_review_args repo_aware and
// the dir; both agent_session branches (container, then host) pass
// opencode_session_env read_only, opencode_research, an OPENCODE_CONFIG
// (container config_path, host mcp_config_path), mcp_names, and on the host the
// mirrored read rules, which the container's opencode never reads. Each input
// is pinned to its one producer: kind, repo_aware and read_only to a parameter
// declared without `mut` and never rebound (agent_session's kind to its one
// non-mut `let`); opencode_research, mcp_names, self_names and the container
// config_path to their exact `let`; the host mcp_config_path to its one `None`
// declaration and agent_review's to one non-mut declaration, each unnamed
// between its read_mirror and its call. Each run's env vector is named only by
// its `let` and its spawn argument. Each read_mirror is built once, by
// opencode_read_mirror from the run's OPENCODE_CONFIG and repo_path or
// worktree_path, in the ReadOnly-pinned arm (a repo-aware opencode review, a
// read-only session); the other arm mirrors nothing. That path is also the
// run's spawn cwd and --dir (opencode_review_args, or the `run_dir` dir
// opencode_session_args gets). The checker lexes, so comments and strings never
// satisfy a pin, and ignores a `,` before `)`, so a rustfmt reflow passes. An
// unreadable file, unfinished lexing, a missing anchor, an extra or missing
// call, or a bare env-fn mention fails closed. Contract: ordinary edits are
// caught; these deliberate shapes are not, and code review owns them: what the
// env fns, run_dir and stream_agent do with their inputs, what the per-CLI code
// assigns each mcp_config_path, the container's client-side extra_env, calls in
// another file or via a re-export, an early return spawning another way (an
// aliased stream_agent, a raw Command, a spawn outside the pinned branch), cfg
// and cfg_attr attributes, macros (macro_rules!, stringify! and friends),
// closures and async blocks, nested, shadowing or decoy fn and use items (a
// same-named fn included), conditional or dead wrappers around a pinned
// statement or call (if false, match arms, cfg!()), raw identifiers (r#name),
// pattern bindings (let ref, parenthesized or tuple patterns, match, if-let and
// closure-parameter shadows), raw pointers and unsafe writes, non-ASCII
// identifiers, and which branch runs (read from the order of the container_env
// and host_extra_env lets).
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

/** `name` is a parameter of `fn`'s own signature, typed `type`, never `mut` (so
 *  nothing can assign it) and never rebound by a `let` in `body`. */
function pinParameter(masked, fn, body, name, type, problems) {
  if (letStatement(masked, body, name).count !== 0)
    problems.push(`${fn} must not rebind ${name}`);
  // Only the fn's own signature counts: other fns declare the same names.
  const signature = masked.slice(
    new RegExp(`\\bfn ${fn}\\b`).exec(masked).index,
    body[0],
  );
  const declared = new RegExp(
    `(\\bmut\\s+)?\\b${name}\\s*:\\s*${type}\\b`,
  ).exec(signature);
  if (!declared)
    problems.push(`missing anchor: ${fn}'s ${name}: ${type} parameter`);
  else if (declared[1]) problems.push(`${fn} must declare ${name} without mut`);
}

/** An env vector is named exactly twice in `body`, by its one `let` (opening
 *  with `head`) and its spawn argument, so nothing between them can shadow,
 *  mutate, reassign or narrow it. `bound.count !== 1` is the caller's anchor. */
function pinEnvVector(masked, fn, body, bound, name, head, problems) {
  const uses = [
    ...masked.slice(...body).matchAll(new RegExp(`\\b${name}\\b`, "g")),
  ].length;
  if (uses !== 2)
    problems.push(
      `${fn} must use ${name} exactly twice (its let, its spawn argument), saw ${uses}`,
    );
  if (bound.count === 1 && !bound.text.startsWith(head))
    problems.push(`${fn} must build ${name}: ${head}`);
}

/** The whitespace-collapsed `let read_mirror` each fn holds, up to its `;`: the
 *  resolver, fed the run's OPENCODE_CONFIG and --dir, in the ReadOnly-pinned arm. */
const REVIEW_MIRROR =
  "let read_mirror = if kind == AgentKind::Opencode && repo_aware { opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&repo_path)) } else { OpencodeReadMirror::default() }";
const HOST_MIRROR =
  "let read_mirror = if read_only { opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&worktree_path)) } else { OpencodeReadMirror::default() }";
const RUN_DIR = "let dir = run_dir(container, &worktree_path)";
/** Every opted-in server's name, so the pin admits each one's tools. */
const MCP_NAMES =
  "let mcp_names: Vec<&str> = mcp_specs.iter().map(|s| s.name.as_str()).collect()";
/** The host OPENCODE_CONFIG's one declaration; only the per-CLI writes assign it. */
const MCP_CONFIG_PATH = "let mut mcp_config_path: Option<String> = None";
/** agent_review's OPENCODE_CONFIG: bound once, never `mut`. */
const REVIEW_CONFIG_PATH = "let mcp_config_path: Option<String> =";
/** Every self-MCP server's name, so the review's pin admits each one's tools. */
const SELF_NAMES =
  "let self_names: Vec<&str> = self_specs.iter().map(|s| s.name.as_str()).collect()";
/** agent_session's kind: one non-mut `let`, so nothing can assign it. */
const SESSION_KIND = "let kind = match agent.as_str() {";
/** Each run's env vector opens its one `let` with these (the rest is pinned
 *  through the env fn's call). */
const REVIEW_ENV = "let extra_env = review_env(";
const CONTAINER_ENV =
  "let container_env: Vec<(&str, String)> = if kind == AgentKind::Opencode {";
const HOST_ENV =
  "let host_extra_env: Vec<(&str, String)> = if kind == AgentKind::Opencode {";
const RESEARCH = "let opencode_research = kind == AgentKind::Opencode && web";
/** The container OPENCODE_CONFIG, compared in source text: its "opencode" key is a
 *  string literal, which the masked view blanks. */
const CONTAINER_CONFIG =
  'let config_path = crate::agent_sandbox::container_mcp_config("opencode") .map(|(_, path)| path) .filter(|_| !mcp_specs.is_empty() || opencode_research)';

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
    // repo_aware picks the pin: `true` gives a diff-only run ReadOnly unmirrored.
    for (const [at, want] of [
      [0, "kind"],
      [1, "repo_aware"],
      [2, "mcp_config_path.as_deref()"],
    ])
      if (call.args[at] !== want)
        problems.push(
          `${FILE}:${call.line} review_env must receive ${want}, got ${call.args[at] ?? "nothing"}`,
        );
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
  if (reviewDir.length === 1 && reviewDir[0]?.[1] !== "repo_aware")
    problems.push(
      `agent_review must pass opencode_review_args repo_aware, got ${reviewDir[0]?.[1] ?? "nothing"}`,
    );
  const reviewSpawn = callsIn(masked, review, "stream_agent");
  if (reviewSpawn.length !== 1 || reviewSpawn[0]?.[5] !== "&repo_path")
    problems.push("agent_review must spawn stream_agent once, in &repo_path");
  // stream_agent's 12th parameter is the child's environment.
  if (reviewSpawn.length === 1 && reviewSpawn[0]?.[11] !== "&extra_env")
    problems.push(
      `agent_review must spawn stream_agent with &extra_env, got ${reviewSpawn[0]?.[11] ?? "nothing"}`,
    );
  const reviewEnv = letStatement(masked, review, "extra_env");
  if (reviewEnv.count !== 1)
    problems.push("missing anchor: one let extra_env in agent_review");
  pinEnvVector(
    masked,
    "agent_review",
    review,
    reviewEnv,
    "extra_env",
    REVIEW_ENV,
    problems,
  );
  const selfNames = letStatement(masked, review, "self_names");
  if (selfNames.count !== 1 || selfNames.text !== collapse(SELF_NAMES))
    problems.push(`agent_review must build self_names once: ${SELF_NAMES}`);
  const selfSpecs = letStatement(masked, review, "self_specs");
  if (
    selfSpecs.count !== 1 ||
    !/\bcrate::mcp::self_server_spec\s*\(/.test(selfSpecs.text ?? "")
  )
    problems.push(
      "agent_review must build self_specs once, from crate::mcp::self_server_spec",
    );
  pinParameter(masked, "agent_review", review, "kind", "AgentKind", problems);
  pinParameter(masked, "agent_review", review, "repo_aware", "bool", problems);
  // Only the prefix is compared: the per-CLI body after `=` is out of reach.
  const reviewConfig = letStatement(masked, review, "mcp_config_path");
  if (
    reviewConfig.count !== 1 ||
    !reviewConfig.text.startsWith(REVIEW_CONFIG_PATH)
  )
    problems.push(
      `agent_review must declare mcp_config_path once, not mut: ${REVIEW_CONFIG_PATH}`,
    );
  const reviewCall = calls.review_env.find((c) => c.fn === "agent_review");
  if (reviewMirror.count === 1 && reviewCall) {
    const mirrorEnd = masked.indexOf(";", reviewMirror.at);
    if (
      mirrorEnd < 0 ||
      /\bmcp_config_path\b/.test(masked.slice(mirrorEnd, reviewCall.index))
    )
      problems.push(
        "agent_review must not touch mcp_config_path between read_mirror and review_env",
      );
  }

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
    if (call.args[1] !== "opencode_research")
      problems.push(
        `${FILE}:${call.line} ${branch} opencode_session_env must receive opencode_research, got ${call.args[1] ?? "nothing"}`,
      );
    // Each branch hands the run its own OPENCODE_CONFIG: the container's mounted
    // path, the host's generated file.
    const configPath = branch === "host" ? "mcp_config_path" : "config_path";
    if (call.args[2] !== configPath)
      problems.push(
        `${FILE}:${call.line} ${branch} opencode_session_env must receive ${configPath}, got ${call.args[2] ?? "nothing"}`,
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
  if (hostSpawn.length === 1 && hostSpawn[0]?.[11] !== "&host_extra_env")
    problems.push(
      `agent_session's host branch must spawn stream_agent with &host_extra_env, got ${hostSpawn[0]?.[11] ?? "nothing"}`,
    );
  // build_run_args' 9th parameter becomes the container's `-e` environment.
  const runArgs =
    container.at >= 0 && host.at > container.at
      ? callsIn(masked, [container.at, host.at], "build_run_args")
      : [];
  if (runArgs.length !== 1 || runArgs[0]?.[8] !== "&container_env")
    problems.push(
      "agent_session's container branch must pass build_run_args &container_env once",
    );
  pinEnvVector(
    masked,
    "agent_session",
    session,
    container,
    "container_env",
    CONTAINER_ENV,
    problems,
  );
  pinEnvVector(
    masked,
    "agent_session",
    session,
    host,
    "host_extra_env",
    HOST_ENV,
    problems,
  );
  pinParameter(masked, "agent_session", session, "read_only", "bool", problems);
  const sessionKind = letStatement(masked, session, "kind");
  if (sessionKind.count !== 1 || !sessionKind.text.startsWith(SESSION_KIND))
    problems.push(
      `agent_session must declare kind once, not mut: ${SESSION_KIND}`,
    );
  const mcpNames = letStatement(masked, session, "mcp_names");
  if (mcpNames.count !== 1 || mcpNames.text !== collapse(MCP_NAMES))
    problems.push(`agent_session must build mcp_names once: ${MCP_NAMES}`);
  const research = letStatement(masked, session, "opencode_research");
  if (research.count !== 1 || research.text !== RESEARCH)
    problems.push(
      `agent_session must build opencode_research once: ${RESEARCH}`,
    );
  const configDecl = letStatement(masked, session, "mcp_config_path");
  if (configDecl.count !== 1 || configDecl.text !== MCP_CONFIG_PATH)
    problems.push(
      `agent_session must declare mcp_config_path once: ${MCP_CONFIG_PATH}`,
    );
  // A rebind, assignment, take() or &mut between the mirror and the call would
  // hand the run a different config from the one the mirror read.
  const hostCall = sessionCalls.find(
    (c) => c.fn === "agent_session" && branchOf(c) === "host",
  );
  if (sessionMirror.count === 1 && hostCall) {
    const mirrorEnd = masked.indexOf(";", sessionMirror.at);
    if (
      mirrorEnd < 0 ||
      /\bmcp_config_path\b/.test(masked.slice(mirrorEnd, hostCall.index))
    )
      problems.push(
        "agent_session's host branch must not touch mcp_config_path between read_mirror and opencode_session_env",
      );
  }
  if (container.at >= 0 && host.at > container.at) {
    const config = letStatement(masked, [container.at, host.at], "config_path");
    const end = masked.indexOf(";", config.at);
    if (
      config.count !== 1 ||
      end < 0 ||
      collapse(text.slice(config.at, end)) !== CONTAINER_CONFIG
    )
      problems.push(
        `agent_session's container branch must build config_path once: ${CONTAINER_CONFIG}`,
      );
  }
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
    ).includes(`agent_review must build self_names once: ${SELF_NAMES}`),
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
  // Each arm condition is pinned: the resolver runs only for a ReadOnly-pinned run.
  for (const [condition, mutantCondition, refused] of [
    [
      "if kind == AgentKind::Opencode && repo_aware {",
      "if kind != AgentKind::Opencode && repo_aware {",
      reviewRefused,
    ],
    [
      "if kind == AgentKind::Opencode && repo_aware {",
      "if kind == AgentKind::Opencode {",
      reviewRefused,
    ],
    [
      "if kind == AgentKind::Opencode && repo_aware {",
      "if kind == AgentKind::Opencode && !repo_aware {",
      reviewRefused,
    ],
    [
      "if kind == AgentKind::Opencode && repo_aware {",
      "if true {",
      reviewRefused,
    ],
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
  // Swapping the arms resolves for the run without the ReadOnly pin instead.
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

test("P12: each branch's research flag, config path and server names are pinned", () => {
  const strip = (problems) => problems.map((p) => p.replace(/^[^ ]+ /, ""));
  for (const [call, branch] of [
    [CONTAINER_CALL, "container"],
    [HOST_CALL, "host"],
  ]) {
    const problems = checkPinCallSites(
      mutate((t) =>
        t.replace(call, () => call.replace("opencode_research", "false")),
      ),
    );
    assert.deepEqual(strip(problems), [
      `${branch} opencode_session_env must receive opencode_research, got false`,
    ]);
  }
  const swapped = mutate((t) =>
    t
      .replace(HOST_CALL, () =>
        HOST_CALL.replace("mcp_config_path", "config_path"),
      )
      .replace(CONTAINER_CALL, () =>
        CONTAINER_CALL.replace("config_path", "mcp_config_path"),
      ),
  );
  assert.deepEqual(strip(checkPinCallSites(swapped)), [
    "container opencode_session_env must receive config_path, got mcp_config_path",
    "host opencode_session_env must receive mcp_config_path, got config_path",
  ]);
  const refused = `agent_session must build mcp_names once: ${MCP_NAMES}`;
  for (const producer of [
    "let mcp_names: Vec<&str> = mcp_specs.iter().take(1).map(|s| s.name.as_str()).collect()",
    "let mcp_names: Vec<&str> = mcp_specs.iter().map(|s| s.name.as_str()).skip(1).collect()",
    'let mcp_names: Vec<&str> = vec!["gitdesktop"]',
    "let mcp_names: Vec<&str> = Vec::new()",
  ]) {
    const mutant = mutate((t) => {
      assert.equal(t.split(MCP_NAMES).length, 2, `not unique: ${MCP_NAMES}`);
      return t.replace(MCP_NAMES, () => producer);
    });
    assert.deepEqual(checkPinCallSites(mutant), [refused], producer);
  }
});

test("P13: each OPENCODE_CONFIG and the research flag are bound once", () => {
  const declare = `agent_session must declare mcp_config_path once: ${MCP_CONFIG_PATH}`;
  const touched =
    "agent_session's host branch must not touch mcp_config_path between read_mirror and opencode_session_env";
  const research = `agent_session must build opencode_research once: ${RESEARCH}`;
  const container = `agent_session's container branch must build config_path once: ${CONTAINER_CONFIG}`;
  const unique = (t, from) =>
    assert.equal(t.split(from).length, 2, `not unique: ${from}`);
  const before = (anchor, line) =>
    mutate((t) => {
      unique(t, anchor);
      return t.replace(anchor, () => `${line}\n${anchor}`);
    });
  const swap = (from, to) =>
    mutate((t) => {
      unique(t, from);
      return t.replace(from, () => to);
    });
  const HOST_AT = `        ${HOST_CALL}`;
  const OPENS_CONTAINER =
    "let container_env: Vec<(&str, String)> = if kind == AgentKind::Opencode {";
  for (const [mutant, refused] of [
    [
      before(HOST_AT, "        let mcp_config_path: Option<String> = None;"),
      [declare, touched],
    ],
    [before(HOST_AT, "        mcp_config_path = None;"), [touched]],
    [before(HOST_AT, "        let _ = mcp_config_path.take();"), [touched]],
    [
      before(
        "    let container = isolation",
        "    let mcp_config_path: Option<String> = None;",
      ),
      [declare],
    ],
    [swap(`${RESEARCH};`, "let opencode_research = false;"), [research]],
    [
      swap(
        OPENS_CONTAINER,
        `${OPENS_CONTAINER}\n            let opencode_research = false;`,
      ),
      [research],
    ],
    [
      swap(
        ".filter(|_| !mcp_specs.is_empty() || opencode_research);",
        ".filter(|_| false);",
      ),
      [container],
    ],
    [
      before(
        `            ${CONTAINER_CALL}`,
        "            let config_path: Option<String> = None;",
      ),
      [container],
    ],
  ]) {
    assert.deepEqual(checkPinCallSites(mutant), refused);
  }
});

test("P14: agent_review's pin-choosing inputs are pinned to their producers", () => {
  const L = `${FILE}:${source.slice(0, source.indexOf(REVIEW_CALL)).split("\n").length} `;
  const OPENS_MIRROR =
    "    let read_mirror = if kind == AgentKind::Opencode && repo_aware {";
  const REVIEW_AT = "    let extra_env = review_env(";
  const DECLARE =
    "let mcp_config_path: Option<String> = if self_specs.is_empty() {";
  const declare = `agent_review must declare mcp_config_path once, not mut: ${REVIEW_CONFIG_PATH}`;
  const touched =
    "agent_review must not touch mcp_config_path between read_mirror and review_env";
  const unique = (t, from) =>
    assert.equal(t.split(from).length, 2, `not unique: ${from}`);
  const before = (anchor, line) =>
    mutate((t) => {
      unique(t, anchor);
      return t.replace(anchor, () => `${line}\n${anchor}`);
    });
  const swap = (from, to) =>
    mutate((t) => {
      unique(t, from);
      return t.replace(from, () => to);
    });
  const call = (from, to) => swap(REVIEW_CALL, REVIEW_CALL.replace(from, to));
  for (const [mutant, refused] of [
    [
      call("repo_aware", "true"),
      [`${L}review_env must receive repo_aware, got true`],
    ],
    [
      call("repo_aware", "false"),
      [`${L}review_env must receive repo_aware, got false`],
    ],
    [
      call("mcp_config_path.as_deref()", "None"),
      [`${L}review_env must receive mcp_config_path.as_deref(), got None`],
    ],
    [
      call("kind", "AgentKind::Claude"),
      [`${L}review_env must receive kind, got AgentKind::Claude`],
    ],
    [
      swap(
        "opencode_review_args(&model, repo_aware, &effort, &repo_path)",
        "opencode_review_args(&model, true, &effort, &repo_path)",
      ),
      ["agent_review must pass opencode_review_args repo_aware, got true"],
    ],
    [
      before(OPENS_MIRROR, "    let repo_aware = true;"),
      ["agent_review must not rebind repo_aware"],
    ],
    [
      before(REVIEW_AT, "    let mcp_config_path: Option<String> = None;"),
      [declare, touched],
    ],
    [before(REVIEW_AT, "    mcp_config_path = None;"), [touched]],
    [swap(DECLARE, DECLARE.replace("let ", "let mut ")), [declare]],
  ]) {
    assert.deepEqual(checkPinCallSites(mutant), refused);
  }
  const mutant = mutate((t) => {
    const at = t.indexOf("repo_aware: bool", t.indexOf("fn agent_review("));
    assert.ok(at > 0, "agent_review declares no repo_aware parameter");
    return `${t.slice(0, at)}diff_only: bool${t.slice(at + "repo_aware: bool".length)}`;
  });
  // Earlier fns still declare the parameter, so a whole-prefix search would pass.
  assert.match(
    mutant.slice(0, mutant.indexOf("fn agent_review(")),
    /\brepo_aware: bool\b/,
  );
  assert.deepEqual(checkPinCallSites(mutant), [
    "missing anchor: agent_review's repo_aware: bool parameter",
  ]);
});

test("P15: pinned parameters, env vectors and self_names admit no ordinary edit", () => {
  const unique = (t, from) =>
    assert.equal(t.split(from).length, 2, `not unique: ${from}`);
  const swap = (from, to) => (t) => {
    unique(t, from);
    return t.replace(from, () => to);
  };
  const before = (anchor, line) => swap(anchor, `${line}\n${anchor}`);
  const after = (anchor, line) => swap(anchor, `${anchor}\n${line}`);
  // Retypes `name: type` in fn's own signature, past the earlier fns' copies.
  const param = (fn, name, type, to) => (t) => {
    const at = t.indexOf(`${name}: ${type}`, t.indexOf(`fn ${fn}(`));
    assert.ok(at > 0, `${fn} declares no ${name}: ${type}`);
    return `${t.slice(0, at)}${to}${t.slice(at + `${name}: ${type}`.length)}`;
  };
  const mut = (fn, name, type) => param(fn, name, type, `mut ${name}: ${type}`);
  const all =
    (...edits) =>
    (t) =>
      edits.reduce((text, edit) => edit(text), t);
  const OPENS_REVIEW_ENV = "    let extra_env = review_env(";
  const OPENS_HOST_ENV = `    ${HOST_ENV}`;
  const OPENS_CONTAINER_ENV = `        ${CONTAINER_ENV}`;
  const REVIEW_ENV_LET = `    let extra_env = ${REVIEW_CALL};`;
  const CONTAINER_ENV_LET = `${CONTAINER_CALL}\n        } else {\n            Vec::new()\n        };`;
  const HOST_ENV_LET = `${HOST_CALL}\n    } else {\n        Vec::new()\n    };`;
  const twice = (fn, name, saw) =>
    `${fn} must use ${name} exactly twice (its let, its spawn argument), saw ${saw}`;
  const reviewAnchor = "missing anchor: one let extra_env in agent_review";
  const containerAnchor =
    "missing anchor: one let container_env in agent_session";
  const hostAnchor = "missing anchor: one let host_extra_env in agent_session";
  const reviewBuild = `agent_review must build extra_env: ${REVIEW_ENV}`;
  const containerBuild = `agent_session must build container_env: ${CONTAINER_ENV}`;
  const hostBuild = `agent_session must build host_extra_env: ${HOST_ENV}`;
  const sessionKind = `agent_session must declare kind once, not mut: ${SESSION_KIND}`;
  const SHADOW = (name, indent) =>
    `${indent}let ${name}: Vec<(&str, String)> = Vec::new();`;
  const RETAIN = (name, indent) =>
    `${indent}${name}.retain(|(k, _)| *k != "OPENCODE_PERMISSION");`;
  const PUSH = (name, indent) =>
    `${indent}${name}.push(("OPENCODE_PERMISSION", "{}".to_string()));`;
  const mutLet = (opens, name) =>
    swap(opens, opens.replace(`let ${name}`, `let mut ${name}`));
  for (const [id, edit, refused] of [
    [
      "review mut repo_aware, assigned",
      all(
        mut("agent_review", "repo_aware", "bool"),
        before(OPENS_REVIEW_ENV, "    repo_aware = true;"),
      ),
      ["agent_review must declare repo_aware without mut"],
    ],
    [
      "review mut kind, assigned",
      all(
        mut("agent_review", "kind", "AgentKind"),
        before(OPENS_REVIEW_ENV, "    kind = AgentKind::Copilot;"),
      ),
      ["agent_review must declare kind without mut"],
    ],
    [
      "review kind rebound",
      before(OPENS_REVIEW_ENV, "    let kind = AgentKind::Copilot;"),
      ["agent_review must not rebind kind"],
    ],
    [
      "review kind parameter renamed",
      param("agent_review", "kind", "AgentKind", "flavor: AgentKind"),
      ["missing anchor: agent_review's kind: AgentKind parameter"],
    ],
    [
      "session mut read_only, assigned",
      all(
        mut("agent_session", "read_only", "bool"),
        before(OPENS_HOST_ENV, "    read_only = false;"),
      ),
      ["agent_session must declare read_only without mut"],
    ],
    [
      "session kind rebound",
      before(OPENS_HOST_ENV, "    let kind = AgentKind::Copilot;"),
      [sessionKind],
    ],
    [
      "session mut kind",
      swap(SESSION_KIND, SESSION_KIND.replace("let ", "let mut ")),
      [sessionKind],
    ],
    [
      "review env shadowed",
      after(REVIEW_ENV_LET, SHADOW("extra_env", "    ")),
      [reviewAnchor, twice("agent_review", "extra_env", 3)],
    ],
    [
      "review env retained",
      all(
        after(REVIEW_ENV_LET, RETAIN("extra_env", "    ")),
        mutLet(OPENS_REVIEW_ENV, "extra_env"),
      ),
      [twice("agent_review", "extra_env", 3), reviewBuild],
    ],
    [
      "review env pushed",
      all(
        after(REVIEW_ENV_LET, PUSH("extra_env", "    ")),
        mutLet(OPENS_REVIEW_ENV, "extra_env"),
      ),
      [twice("agent_review", "extra_env", 3), reviewBuild],
    ],
    [
      "review spawn env &[]",
      swap(
        "        &extra_env,\n        &on_event,",
        "        &[],\n        &on_event,",
      ),
      [
        "agent_review must spawn stream_agent with &extra_env, got &[]",
        twice("agent_review", "extra_env", 1),
      ],
    ],
    [
      "container env shadowed",
      after(CONTAINER_ENV_LET, SHADOW("container_env", "        ")),
      [containerAnchor, twice("agent_session", "container_env", 3)],
    ],
    [
      "container env retained",
      all(
        mutLet(OPENS_CONTAINER_ENV, "container_env"),
        after(CONTAINER_ENV_LET, RETAIN("container_env", "        ")),
      ),
      [twice("agent_session", "container_env", 3), containerBuild],
    ],
    [
      "container env pushed",
      all(
        mutLet(OPENS_CONTAINER_ENV, "container_env"),
        after(CONTAINER_ENV_LET, PUSH("container_env", "        ")),
      ),
      [twice("agent_session", "container_env", 3), containerBuild],
    ],
    [
      "container run env &[]",
      swap("            &container_env,\n", "            &[],\n"),
      [
        "agent_session's container branch must pass build_run_args &container_env once",
        twice("agent_session", "container_env", 1),
      ],
    ],
    [
      "container env condition swapped",
      swap(
        OPENS_CONTAINER_ENV,
        OPENS_CONTAINER_ENV.replace("Opencode", "Claude"),
      ),
      [containerBuild],
    ],
    [
      "host env shadowed",
      after(HOST_ENV_LET, SHADOW("host_extra_env", "    ")),
      [hostAnchor, twice("agent_session", "host_extra_env", 3)],
    ],
    [
      "host env retained",
      all(
        mutLet(OPENS_HOST_ENV, "host_extra_env"),
        after(HOST_ENV_LET, RETAIN("host_extra_env", "    ")),
      ),
      [twice("agent_session", "host_extra_env", 3), hostBuild],
    ],
    [
      "host env pushed",
      all(
        mutLet(OPENS_HOST_ENV, "host_extra_env"),
        after(HOST_ENV_LET, PUSH("host_extra_env", "    ")),
      ),
      [twice("agent_session", "host_extra_env", 3), hostBuild],
    ],
    [
      "host spawn env &[]",
      swap("        &host_extra_env,\n", "        &[],\n"),
      [
        "agent_session's host branch must spawn stream_agent with &host_extra_env, got &[]",
        twice("agent_session", "host_extra_env", 1),
      ],
    ],
    [
      "host env condition swapped",
      swap(OPENS_HOST_ENV, OPENS_HOST_ENV.replace("Opencode", "Claude")),
      [hostBuild],
    ],
    [
      "self_names chained",
      swap(
        SELF_NAMES,
        SELF_NAMES.replace(".collect()", '.chain(["filesystem"]).collect()'),
      ),
      [`agent_review must build self_names once: ${SELF_NAMES}`],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});
