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
//
// The N-series pins the opencode version gate in front of every opencode 2
// path. agent_review and agent_session reach an opencode2_* entry function only
// through one dispatch statement each, compared as whitespace-collapsed code
// within the enclosing fn's body (comments and string literals blanked, so a
// reworded string never fails it, nor a comment where the code already has
// whitespace; one between tokens the pinned text joins, `::/*x*/`, does)
// around the entry call (its argument list is the implementer's): the review's
// after its binary resolve and before self_mcp_wanted, the host session's after
// mcp_names and before mcp_config_path, the container's after the
// image_has_agent refusal and the `..` check and before seed_session_home.
// The two host dispatches read their Cli from opencode_cli(..).await?, whose `?`
// is the refusal. The host session's 1.x branch runs the binary its dispatch
// classified (agent_session resolves twice: the dispatch's lookup and the other
// CLIs' host lookup in the `None` arm, a statement pinned whole, literals
// blanked) and spawns it as &binary, with nothing naming opencode_v1_binary
// between the dispatch and that lookup or binary between the lookup and the
// spawn; classify_version is called once, in opencode_verdict_with; the
// container entry's first call is its image gate; agent.rs names core items
// only as crate::opencode2::… (no use, no alias, no other path). Only that
// spelling (crate::opencode2::review_env) is core's and never counts as the 1.x
// call; any other path (self::, super::) counts as the bare name. Out of reach,
// besides the shapes above: what the opencode2_* bodies do with their inputs,
// which N4-N11 and N13 take over.
//
// N4-N11 hold the lock of every wired opencode 2 run: core's three lock producers
// (probe_document, read_back, lock_document) are called once each, in
// opencode2_lock; opencode2_lock is called only from opencode2_compose, the one
// caller of core's argv and env builders, which each wired entry function calls
// once; review_args takes &lock and review_env compose's one config_path; the
// session argv takes SessionAgent::Locked(&lock), or SessionAgent::Write only in
// the arm of a pinless session turn, and the session env compose's config_path
// as its String; each wired entry function picks its pin from its own non-mut
// parameters (a session binds it once and hands it to its turn), destructures
// one TurnPlan::Run, builds its stream parser from that lock and spawns
// stream_agent with the plan's argv and env; stream_agent and Command::new are
// called only where listed; the opencode2_* bodies name no 1.x builder and spell
// none of the run's flags, and the 1.x literal pairs stay where they are. The
// container entry function is the one caller of build_run_args_full, once for
// its probe and once for its run, each with its plan's argv and the env split by
// split_container_env, whose client half carries the lock document: the probe
// always names that document by `-e` alone, the run only through its pinned
// env_by_name binding. "--standalone" appears in production only in
// OPENCODE2_AUTH_EXPORT_ARGS. The counts are the constants above checkLockGate.
// Out of reach as well: what core does with a lock, and a pinned spawn through a
// callee these pins do not list.
//
// N13 holds the sign-in export inside its three uses: export_stdout is bound
// once, counted once by credential_export_count(&export_stdout) and handed once
// to the import as stdin: Some(export_stdout). It is counted with string
// literals kept, so a format string naming it is a fourth mention, and no line
// naming it may format, log or decode it. It also holds the export arm's own
// bindings: in opencode2_copy_sign_ins, no statement after the export's `let`, up
// to and including export_stdout's binding, names stdout or export beside a
// format, log, print or decode call. Out of reach: what capture_tree and
// credential_export_count do with the bytes, which code review owns.
//
// N14-N17 hold what each plan carries to its spawn. Between a wired entry
// function's TurnPlan::Run and its stream_agent( call, no `let` binds run, run_args
// or client_env beyond the container's one run_args and one client_env, none
// `mut`, and nothing indexes, assigns or calls through run.args, run.env, run.cwd,
// run_args or client_env (N14). Each read-back closure builds one CaptureRequest
// whose program, args, cwd and env are pinned per site, and each 2.x stream_agent(
// takes &run.cwd (N15). agent_models' listing statement is pinned in text (the 2.x
// arm reads MODELS_ARGS, the 1.x arm the args of kind.models_args()),
// opencode2_catalog reads CATALOG_ARGS, and opencode2_read_request, the one
// builder of both reads, sets the project-disable pair (N16). agent_session's 1.x
// restart rebinding is pinned in text, once, before its opencode_session_args(
// call (N17). Out of reach: a closure, macro or callee that changes them.
//
// N18 reads src-tauri/src/health.rs too, and holds each detect row to one
// version observation: agent_detect and health::detect each hold one opencode
// arm, which calls opencode_detection( once and no run_capture*(
// (run_capture_parts included), the bodies of opencode_detection,
// opencode_detection_with and opencode_verdict_with call no run_capture*(, and
// production calls opencode_verdict_probe( only in opencode_verdict and
// opencode_detection, once each, in either order. Counted on the masked view,
// so a comment or literal spelling a call never counts. Out of reach: a probe
// through another callee than opencode_verdict_probe or run_capture* (such as
// capture_tree or a raw Command); a probe added in agent_detect or
// health::detect outside the opencode arm; and what opencode_verdict_with does
// with the probe it is handed.
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
const HEALTH_FILE = "src-tauri/src/health.rs";

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
/** The one path that names core's fn rather than this file's. */
const CORE_PATH = "crate::opencode2::";
/** The container OPENCODE_CONFIG, compared in source text: its "opencode" key is a
 *  string literal, which the masked view blanks. */
const CONTAINER_CONFIG =
  'let config_path = crate::agent_sandbox::container_mcp_config("opencode") .map(|(_, path)| path) .filter(|_| !mcp_specs.is_empty() || opencode_research)';

function checkPinCallSites(text) {
  if (typeof text !== "string" || text.length === 0)
    return [`could not read ${FILE}`];
  const v = lexRust(text);
  if (v.unterminated >= 0) return [`could not scan ${FILE}`];
  const { masked, code } = v;
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
    // Only crate::opencode2:: names core's fn; any other path is this file's.
    if (masked.endsWith(CORE_PATH, m.index)) continue;
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
  // stream_agent's 3rd parameter is the program it runs.
  if (hostSpawn.length === 1 && hostSpawn[0]?.[2] !== "&binary")
    problems.push(
      `agent_session's host branch must spawn stream_agent with &binary, got ${hostSpawn[0]?.[2] ?? "nothing"}`,
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
  checkVersionGate(
    masked,
    inTest,
    lines,
    lineAt,
    { agent_review: review, agent_session: session },
    problems,
  );
  checkLockGate(code, masked, inTest, lines, lineAt, problems);
  checkSignInExport(code, masked, inTest, lineAt, problems);
  checkPlanCarriage(masked, inTest, lines, lineAt, problems);
  return problems;
}

/** Index of the `)` closing the call whose `(` sits at `open`, or -1. */
function callClose(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if ("([{".includes(masked[i])) depth++;
    else if (")]}".includes(masked[i]) && --depth === 0) return i;
  }
  return -1;
}

/** The opencode 2 dispatch statements: the whitespace-collapsed source text up to
 *  and after the entry call's argument list, and the anchors each sits between. */
const DISPATCHES = [
  {
    id: "N1",
    fn: "agent_review",
    call: "opencode2_review",
    head: "if kind == AgentKind::Opencode { if let (crate::opencode2::Cli::V2(version), identity) = opencode_cli(&binary).await? { return Box::pin(opencode2_review(",
    tail: ")) .await; } }",
    after: [["let binary = resolve(", /\blet\s+binary\s*=\s*resolve\s*\(/]],
    before: ["let self_mcp_wanted", /\blet\s+self_mcp_wanted\b/],
  },
  {
    id: "N2 host",
    fn: "agent_session",
    call: "opencode2_host_session",
    head: 'let (opencode_v1_restart, opencode_v1_binary) = if kind == AgentKind::Opencode && !container { let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| { AppError::Command(format!("{} CLI not found. Install it or set its path in Settings.", kind.label())) })?; match opencode_cli(&binary).await? { (crate::opencode2::Cli::V2(version), identity) => { return Box::pin(opencode2_host_session(',
    tail: ")) .await; } (crate::opencode2::Cli::V1(_), _) => (opencode1_must_restart(resume, native_session_id.as_deref()), Some(binary)), } } else { (false, None) };",
    after: [["let mcp_names", /\blet\s+mcp_names\b/]],
    before: ["let mut mcp_config_path", /\blet\s+mut\s+mcp_config_path\b/],
  },
  {
    id: "N2 container",
    fn: "agent_session",
    call: "opencode2_container_session",
    head: "if kind == AgentKind::Opencode { return Box::pin(opencode2_container_session(",
    tail: ")) .await; }",
    after: [
      ["the image_has_agent refusal", /\bimage_has_agent\s*\(/],
      ["the `..` check", /\bstd::path::Component::ParentDir\b/],
    ],
    before: ["seed_session_home(", /\bseed_session_home\s*\(/],
  },
];

/** A DISPATCHES text as the masked view reads it: string literals blanked. */
const asMasked = (text) => collapse(text.replace(/"(?:[^"\\]|\\.)*"/g, " "));

/** The host session's own lookup, whole: the 1.x branch takes the binary its
 *  dispatch classified, and only the other CLIs resolve again. */
const HOST_BINARY =
  'let binary = match opencode_v1_binary { Some(binary) => binary, None => resolve(kind, bin_path.as_deref()).await.ok_or_else(|| { AppError::Command(format!("{} CLI not found. Install it or set its path in Settings.", kind.label())) })?, };';


/** N1, N2, N3, N12: the version gate in front of every opencode 2 path (N13 is
 *  checkSignInExport). Dispatch text is read from `masked` within the enclosing fn's
 *  body, so neither comments nor string literals count. */
function checkVersionGate(masked, inTest, lines, lineAt, bodies, problems) {
  const production = (re) =>
    [...masked.matchAll(re)].filter(
      (m) =>
        !inTest(m.index) &&
        !/\bfn\s+$/.test(masked.slice(Math.max(0, m.index - 8), m.index)),
    );
  const firstIn = (body, re) => {
    const m = re.exec(masked.slice(...body));
    return m ? body[0] + m.index : -1;
  };
  for (const d of DISPATCHES) {
    const body = bodies[d.fn];
    const calls = production(new RegExp(`\\b${d.call}\\s*\\(`, "g"));
    if (calls.length !== 1) {
      problems.push(
        `${d.id}: expected 1 production ${d.call} call, saw ${calls.length}`,
      );
      continue;
    }
    const at = calls[0].index;
    if (at < body[0] || at >= body[1]) {
      problems.push(`${d.id}: ${d.call} called outside ${d.fn}`);
      continue;
    }
    const open = masked.indexOf("(", at);
    const close = callClose(masked, open);
    const head = collapse(masked.slice(body[0], open + 1));
    const tail = close < 0 ? "" : collapse(masked.slice(close, body[1]));
    if (
      !` ${head}`.endsWith(` ${asMasked(d.head)}`) ||
      !tail.startsWith(asMasked(d.tail))
    )
      problems.push(
        `${d.id}: ${d.fn} must dispatch with: ${d.head}..${d.tail}`,
      );
    const limit = firstIn(body, d.before[1]);
    const late = d.after.filter(([, re]) => {
      const i = firstIn(body, re);
      return i < 0 || i > at;
    });
    if (limit < 0 || at > limit || late.length > 0)
      problems.push(
        `${d.id}: ${d.call}'s dispatch must sit after ${d.after.map(([name]) => name).join(" and ")} and before ${d.before[0]} in ${d.fn}`,
      );
  }
  const session = bodies.agent_session;
  const resolves = callsIn(masked, session, "resolve").length;
  if (resolves !== 2)
    problems.push(
      `N2 host: agent_session must call resolve( 2 times (the dispatch's and the other CLIs' host lookup), saw ${resolves}`,
    );
  const binaries = [...masked.slice(...session).matchAll(/\blet\s+binary\s*=/g)];
  const hostAt = binaries.length === 2 ? session[0] + binaries[1].index : -1;
  const hostEnd = hostAt < 0 ? -1 : statementEnd(masked, hostAt);
  if (
    hostEnd < 0 ||
    collapse(masked.slice(hostAt, hostEnd)) !== asMasked(HOST_BINARY)
  )
    problems.push(
      `N2 host: the 1.x host branch must run its classified binary: ${HOST_BINARY}`,
    );
  if (hostEnd >= 0) {
    const spawn = /\bstream_agent\s*\(/.exec(masked.slice(hostEnd, session[1]));
    const named = spawn
      ? [...masked.slice(hostEnd, hostEnd + spawn.index).matchAll(/\bbinary\b/g)]
          .length
      : 0;
    if (named !== 0)
      problems.push(
        `N2 host: nothing may bind or name binary between the 1.x host lookup and its spawn, saw ${named}`,
      );
  }
  const dispatch =
    /\blet\s*\(\s*opencode_v1_restart\s*,\s*opencode_v1_binary\s*\)\s*=/.exec(
      masked.slice(...session),
    );
  const dispatchEnd = dispatch
    ? statementEnd(masked, session[0] + dispatch.index)
    : -1;
  if (dispatchEnd >= 0 && hostAt >= 0) {
    const named = [
      ...masked.slice(dispatchEnd, hostAt).matchAll(/\bopencode_v1_binary\b/g),
    ].length;
    if (named !== 0)
      problems.push(
        `N2 host: nothing may bind or name opencode_v1_binary between its dispatch and the host lookup, saw ${named}`,
      );
  }
  const gate = fnBody(masked, "opencode2_container_session");
  if (!gate) problems.push("missing anchor: fn opencode2_container_session");
  else {
    const first = /\b([A-Za-z_]\w*)\s*\(/.exec(masked.slice(...gate));
    if (first?.[1] !== "image_opencode_state")
      problems.push(
        `N2: opencode2_container_session's first call must be image_opencode_state(, got ${first?.[1] ?? "none"}(`,
      );
  }

  const classify = production(/\bopencode2::classify_version\s*\(/g);
  if (
    classify.length !== 1 ||
    enclosingFn(lines, lineAt(classify[0].index) - 1) !==
      "opencode_verdict_with"
  )
    problems.push(
      `N3: classify_version must be called once in production, in opencode_verdict_with, saw ${classify.length}`,
    );
  for (const fn of ["agent_review", "agent_session"]) {
    const n = callsIn(masked, bodies[fn], "opencode_cli").length;
    if (n !== 1)
      problems.push(
        `N3: ${fn} must read its Cli from one opencode_cli( call, saw ${n}`,
      );
  }

  for (const [re, form] of [
    [/\buse\s+(?:crate|super|self)::opencode2\b/, "use crate::opencode2"],
    [/\buse\s+(?:crate|super|self)::\{[^}]*\bopencode2\b/, "use crate::{opencode2}"],
    [/\bopencode2\s+as\b/, "opencode2 as"],
    [/\bopencode2::\{/, "opencode2::{"],
  ])
    if (re.test(masked)) problems.push(`N12: agent.rs must not spell ${form}`);
  for (const m of masked.matchAll(/\bopencode2::/g))
    if (
      !inTest(m.index) &&
      masked.slice(Math.max(0, m.index - 7), m.index) !== "crate::"
    )
      problems.push(
        `${FILE}:${lineAt(m.index)} N12: core items are spelled crate::opencode2::`,
      );
}

/** Production mentions of the sign-in export's stdout binding, and the three uses
 *  they must be. */
const EXPORT_STDOUT_MENTIONS = 3;
const EXPORT_STDOUT_USES = [
  /\blet\s+export_stdout\s*=/g,
  /\bcredential_export_count\s*\(\s*&export_stdout\s*\)/g,
  /\bstdin\s*:\s*Some\s*\(\s*export_stdout\s*\)/g,
];
const SECRET_SINKS =
  /\bformat!|\blog::|\beprintln!|\bprintln!|\bdbg!|\bto_string\b|\bfrom_utf8\b/;
/** The sinks a statement naming the export arm's stdout or export may not hold. */
const EXPORT_SINKS =
  /\b(?:format|format_args|print|println|eprint|eprintln|write|writeln|panic|dbg|trace|debug|info|warn|error)!|\b(?:log|tracing)::|\b(?:to_string|to_owned|into_owned|from_utf8\w*)\b/;

/** Index just past the `;` that ends, at bracket depth 0, the statement opening at
 *  `at` in the masked view, or -1. */
function statementEnd(masked, at) {
  let depth = 0;
  for (let i = at; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return i + 1;
  }
  return -1;
}

/** N13, over `code` (literals kept, comments blanked), so a format string naming
 *  the binding counts as a mention; `masked` finds the statements. */
function checkSignInExport(code, masked, inTest, lineAt, problems) {
  const production = (re) =>
    [...code.matchAll(re)].filter((m) => !inTest(m.index));
  const mentions = production(/\bexport_stdout\b/g);
  if (mentions.length !== EXPORT_STDOUT_MENTIONS)
    problems.push(
      `N13: export_stdout must appear ${EXPORT_STDOUT_MENTIONS} times in production, saw ${mentions.length}`,
    );
  if (EXPORT_STDOUT_USES.some((re) => production(re).length !== 1))
    problems.push(
      "N13: export_stdout must be bound once, counted once by credential_export_count(&export_stdout) and piped once as stdin: Some(export_stdout)",
    );
  const lines = code.split("\n");
  for (const line of new Set(mentions.map((m) => lineAt(m.index))))
    if (SECRET_SINKS.test(lines[line - 1]))
      problems.push(
        `${FILE}:${line} N13: a line naming export_stdout must not format, log or decode it`,
      );
  const copy = fnBody(masked, "opencode2_copy_sign_ins");
  const exportLet = copy && /\blet\s+export\s*=/.exec(masked.slice(...copy));
  const stdoutLet =
    copy && /\blet\s+export_stdout\s*=/.exec(masked.slice(...copy));
  let at = exportLet ? statementEnd(masked, copy[0] + exportLet.index) : -1;
  const stop = stdoutLet ? statementEnd(masked, copy[0] + stdoutLet.index) : -1;
  if (at < 0 || stop < 0 || at > stop) {
    problems.push(
      "missing anchor: opencode2_copy_sign_ins's let export, then its let export_stdout",
    );
    return;
  }
  while (at < stop) {
    const end = statementEnd(masked, at);
    const statement = code.slice(at, end);
    if (/\b(?:stdout|export)\b/.test(statement) && EXPORT_SINKS.test(statement))
      problems.push(
        `${FILE}:${lineAt(at + statement.search(/\S/))} N13: a statement naming stdout or export before export_stdout is bound must not format, log or decode it`,
      );
    at = end;
  }
}

/** N14: how many `let`s may bind each plan piece between a wired entry function's
 *  TurnPlan::Run and its spawn. */
const PLAN_PIECES = ["run", "run_args", "client_env"];
const PLAN_LETS = {
  opencode2_review: {},
  opencode2_host_session: {},
  opencode2_container_session: { run_args: 1, client_env: 1 },
};
/** An index, an assignment or a call through a plan piece; `let` heads are blanked
 *  first, so a binding's own `=` never matches. */
const PLAN_CHANGE =
  /\b(?:run\.(?:args|env|cwd)|run_args|client_env)\s*(?:\.|\[|=(?![=>])|\+=)/;
/** N15: each read-back's CaptureRequest up to its stdin field, collapsed. */
const PROBE_REQUESTS = {
  opencode2_review:
    "CaptureRequest { program: binary, args: plan.args, cwd: Some(plan.cwd.as_str()), env: plan.env,",
  opencode2_host_session:
    "CaptureRequest { program: binary, args: plan.args, cwd: Some(plan.cwd.as_str()), env: plan.env,",
  opencode2_container_session:
    "CaptureRequest { program: runtime_bin, args: probe_args, cwd: Some(plan.cwd.as_str()), env: client_env,",
};
const SPAWN_CWD = "&run.cwd";
/** N16: agent_models' listing statement, collapsed. */
const MODELS_LISTING =
  "let listed = if v2 { let captured = Box::pin(capture_tree(opencode2_read_request(&binary, crate::opencode2::MODELS_ARGS, None))) .await; opencode2_listing(captured) } else { run_capture_parts(&binary, args, MODELS_TIMEOUT).await }";
const MODELS_ARGS_LET =
  /\blet\s+Some\s*\(\s*args\s*\)\s*=\s*kind\s*\.\s*models_args\s*\(\s*\)\s*else\b/g;
/** The production opencode2_read_request( calls in file order: fn, arguments. */
const READ_REQUESTS = [
  ["agent_models", ["&binary", "crate::opencode2::MODELS_ARGS", "None"]],
  ["opencode2_catalog", ["binary", "crate::opencode2::CATALOG_ARGS", "cancel"]],
];
const READ_REQUEST_ENV = "env: crate::opencode2::project_disable_env().into(),";
/** N17: the 1.x restart rebinding, collapsed. */
const RESTART_REBIND =
  "let (resume, native_session_id) = if opencode_v1_restart { (false, None) } else { (resume, native_session_id) }";

/** N14-N17: what each opencode 2 plan and read carries to its spawn. */
function checkPlanCarriage(masked, inTest, lines, lineAt, problems) {
  const fnOf = (index) => enclosingFn(lines, lineAt(index) - 1);
  const flat = (text) => collapse(text).trim();
  for (const [fn, lets] of Object.entries(PLAN_LETS)) {
    const span = fnBody(masked, fn);
    if (!span) {
      problems.push(`missing anchor: fn ${fn}`);
      continue;
    }
    const run = /\bTurnPlan::Run\s*\{/.exec(masked.slice(...span));
    const from = run
      ? callClose(masked, span[0] + run.index + run[0].length - 1) + 1
      : 0;
    const spawn =
      from > 0 && /\bstream_agent\s*\(/.exec(masked.slice(from, span[1]));
    if (!spawn) {
      problems.push(
        `missing anchor: ${fn}'s stream_agent( after its TurnPlan::Run`,
      );
      continue;
    }
    const between = masked.slice(from, from + spawn.index);
    const seen = Object.fromEntries(PLAN_PIECES.map((name) => [name, 0]));
    for (const m of between.matchAll(/\blet\b([^=;]*)=/g))
      for (const name of PLAN_PIECES) {
        if (!new RegExp(`\\b${name}\\b`).test(m[1])) continue;
        seen[name]++;
        if (/\bmut\b/.test(m[1]))
          problems.push(
            `N14: ${fn} must not bind ${name} as mut before its spawn`,
          );
      }
    for (const name of PLAN_PIECES)
      if (seen[name] !== (lets[name] ?? 0))
        problems.push(
          `N14: ${fn} must bind ${name} ${lets[name] ?? 0} times between its TurnPlan::Run and its spawn, saw ${seen[name]}`,
        );
    const change = PLAN_CHANGE.exec(
      between.replace(/\blet\b[^=;]*=/g, (head) => " ".repeat(head.length)),
    );
    if (change)
      problems.push(
        `N14: ${fn} must not change its plan before its spawn: ${change[0].replace(/\s+/g, "")}`,
      );
    const spawnOpen = from + spawn.index + spawn[0].length - 1;
    const cwd = callArgs(masked, spawnOpen)?.[5];
    if (cwd !== SPAWN_CWD)
      problems.push(
        `N15: ${fn}'s stream_agent( must take ${SPAWN_CWD} as its cwd, got ${cwd}`,
      );
    const compose = /\bopencode2_compose\s*\(/.exec(masked.slice(...span));
    const open = compose ? span[0] + compose.index + compose[0].length - 1 : -1;
    const closure = open < 0 ? "" : masked.slice(open, callClose(masked, open));
    const requests = [...closure.matchAll(/\bCaptureRequest\s*\{/g)];
    const stdin =
      requests.length === 1 &&
      /\bstdin\s*:/.exec(closure.slice(requests[0].index));
    const asked = stdin
      ? flat(closure.slice(requests[0].index, requests[0].index + stdin.index))
      : `${requests.length} requests`;
    // A missing compose call is N4's to report.
    if (compose && asked !== PROBE_REQUESTS[fn])
      problems.push(
        `N15: ${fn}'s read-back must build ${PROBE_REQUESTS[fn]}.. once, got ${asked}`,
      );
  }

  const models = fnBody(masked, "agent_models");
  if (!models) problems.push("missing anchor: fn agent_models");
  else {
    const listed = letStatement(masked, models, "listed");
    const end = listed.count === 1 ? statementEnd(masked, listed.at) : -1;
    if (end < 0 || flat(masked.slice(listed.at, end - 1)) !== MODELS_LISTING)
      problems.push(`N16: agent_models must list once as ${MODELS_LISTING}`);
    const argsLets = [...masked.slice(...models).matchAll(MODELS_ARGS_LET)]
      .length;
    if (argsLets !== 1 || letStatement(masked, models, "args").count !== 0)
      problems.push(
        "N16: agent_models must bind args once, as let Some(args) = kind.models_args() else",
      );
  }
  const requests = [...masked.matchAll(/\bopencode2_read_request\s*\(/g)]
    .filter(
      (m) =>
        !inTest(m.index) &&
        !/\bfn\s+$/.test(masked.slice(Math.max(0, m.index - 8), m.index)),
    )
    .map((m) => {
      const args = callArgs(masked, m.index + m[0].length - 1) ?? [];
      // A trailing comma leaves an empty last argument.
      const kept = args.filter((arg, at) => arg !== "" || at < args.length - 1);
      return JSON.stringify([fnOf(m.index), kept]);
    });
  if (
    requests.join("\n") !==
    READ_REQUESTS.map((r) => JSON.stringify(r)).join("\n")
  )
    problems.push(
      `N16: opencode2_read_request( must be called ${READ_REQUESTS.map(([fn, args]) => `in ${fn} with ${args.join(", ")}`).join(", then ")}`,
    );
  const builder = fnBody(masked, "opencode2_read_request");
  if (
    !builder ||
    [...masked.slice(...builder).matchAll(/\benv\s*:/g)].length !== 1 ||
    !flat(masked.slice(...builder)).includes(READ_REQUEST_ENV)
  )
    problems.push(`N16: opencode2_read_request must set ${READ_REQUEST_ENV}`);

  const session = fnBody(masked, "agent_session");
  if (!session) problems.push("missing anchor: fn agent_session");
  else {
    const body = masked.slice(...session);
    const rebinds = [
      ...body.matchAll(/\blet\s*\(\s*resume\s*,\s*native_session_id\s*\)/g),
    ];
    const argvs = [...body.matchAll(/\bopencode_session_args\s*\(/g)];
    const at = rebinds.length === 1 ? session[0] + rebinds[0].index : -1;
    const end = at < 0 ? -1 : statementEnd(masked, at);
    if (
      end < 0 ||
      argvs.length !== 1 ||
      flat(masked.slice(at, end - 1)) !== RESTART_REBIND ||
      at > session[0] + argvs[0].index
    )
      problems.push(
        `N17: agent_session must rebind ${RESTART_REBIND} once, before its opencode_session_args( call`,
      );
  }
}

/** N4-N11 counts, with every entry function wired. */
const LOCK_CALLS = 2;
const COMPOSE_CALLS = {
  opencode2_review: 1,
  opencode2_host_session: 1,
  opencode2_container_session: 1,
};
/** Each session entry function's opencode2_session_pin( calls; a wired one binds
 *  SESSION_PIN_LET once and hands that binding to its turn as `pin`. */
const SESSION_PIN_CALLS = {
  opencode2_host_session: 1,
  opencode2_container_session: 1,
};
const SESSION_PIN_LET = "let pin = opencode2_session_pin(read_only, web)";
/** The first argument of each crate::opencode2::session_args( call, in file order. */
const SESSION_AGENTS = [
  "crate::opencode2::SessionAgent::Locked(&lock)",
  "crate::opencode2::SessionAgent::Write",
];
/** The compose arm the write argv sits in. */
const WRITE_ARM = "Opencode2Turn::Session { pin: None, session_id }";
const SESSION_AGENT_MENTIONS = { Locked: 1, Write: 1 };
const SESSION_ENV_CALLS = 2;
const SESSION_ENV_CONFIG = "config_path.map(String::from)";
/** Each wired entry function's one plan destructuring. */
const RUN_PATTERNS = {
  opencode2_review: "TurnPlan::Run { run, lock, read_back }",
  opencode2_host_session: "TurnPlan::Run { run, lock, .. }",
  opencode2_container_session: "TurnPlan::Run { run, lock, .. }",
};
/** Production stream_agent( calls in file order and what each passes at index 13. */
const SPAWNS = [
  ["agent_review", "None"],
  ["agent_session", "None"],
  ["agent_session", "None"],
  ["opencode2_review", "Some"],
  ["opencode2_host_session", "Some"],
  ["opencode2_container_session", "Some"],
];
/** A 2.x spawn's argv (index 3) and env (index 11). */
const SPAWN_INPUTS = {
  opencode2_review: ["run.args", "&run.env"],
  opencode2_host_session: ["run.args", "&run.env"],
  opencode2_container_session: ["run_args", "&client_env"],
};
const COMMAND_FNS = [
  "capture_command",
  "kill_process_tree",
  "run_capture_parts",
  "run_login_shell",
  "stream_agent",
];
/** The container argv builds, in file order (the probe's, then the run's): the
 *  binding each opens, and its last three arguments (the `-e K=V` pairs, the names
 *  forwarded by `-e NAME`, the plan's argv). */
const CONTAINER_ARGVS = [
  [
    "let probe_args = crate::agent_sandbox::build_run_args_full(",
    ["&container_env", "&[crate::opencode2::CONTENT_ENV]", "&plan.args"],
  ],
  [
    "let run_args = crate::agent_sandbox::build_run_args_full(",
    ["&container_env", "env_by_name", "&run.args"],
  ],
];
const BUILD_RUN_ARGS_FULL_CALLS = CONTAINER_ARGVS.length;
/** The env split each container argv is built from, in file order. */
const CONTAINER_SPLITS = [
  "let (container_env, client_env) = split_container_env(plan.env)",
  "let (container_env, client_env) = split_container_env(run.env)",
];
/** The container run's `let env_by_name` text. */
const ENV_BY_NAME =
  "let env_by_name: &[&'static str] = if lock.is_some() { &[crate::opencode2::CONTENT_ENV] } else { &[] }";
const STANDALONE_LITERALS = 1;
const STANDALONE_HOME = "const OPENCODE2_AUTH_EXPORT_ARGS";
const OLD_BUILDERS =
  /\b(?:opencode_permission_json|opencode_read_mirror|opencode_review_args|opencode_session_args|opencode_session_env|opencode_variant|write_opencode_config|build_opencode_config|GD_RESEARCH_AGENT)\b/;
const RUN_FLAGS = ['"--auto"', '"--yolo"', '"--standalone"', '"--agent"', '"run"'];
const OLD_LITERALS = [
  ['"OPENCODE_CONFIG_CONTENT"', ["opencode_config_sources", "opencode_read_mirror_with"]],
  ['"--dangerously-skip-permissions"', ["opencode_session_args", "opencode_review_args"]],
];

/** N4-N11: no opencode 2 run is planned or spawned without its lock. `code` keeps
 *  literals and blanks comments; `masked` blanks both. */
function checkLockGate(code, masked, inTest, lines, lineAt, problems) {
  const production = (re) =>
    [...masked.matchAll(re)].filter(
      (m) =>
        !inTest(m.index) &&
        !/\bfn\s+$/.test(masked.slice(Math.max(0, m.index - 8), m.index)),
    );
  const fnOf = (index) => enclosingFn(lines, lineAt(index) - 1);
  const argsAt = (m) => callArgs(masked, m.index + m[0].length - 1);
  const body = (name) => {
    const span = fnBody(masked, name);
    if (!span) problems.push(`missing anchor: fn ${name}`);
    return span;
  };

  for (const name of ["probe_document", "read_back", "lock_document"]) {
    const hits = production(
      new RegExp(`\\bcrate::opencode2::${name}\\s*\\(`, "g"),
    );
    if (hits.length !== 1 || fnOf(hits[0].index) !== "opencode2_lock")
      problems.push(
        `N4: crate::opencode2::${name}( must be called once in production, in opencode2_lock, saw ${hits.length}`,
      );
  }
  const locks = production(/\bopencode2_lock\s*\(/g);
  if (
    locks.length !== LOCK_CALLS ||
    locks.some((m) => fnOf(m.index) !== "opencode2_compose")
  )
    problems.push(
      `N4: opencode2_lock( must be called ${LOCK_CALLS} times in production, all in opencode2_compose, saw ${locks.length}`,
    );
  const composes = production(/\bopencode2_compose\s*\(/g);
  for (const [fn, n] of Object.entries(COMPOSE_CALLS)) {
    const seen = composes.filter((m) => fnOf(m.index) === fn).length;
    if (seen !== n)
      problems.push(`N4: ${fn} must call opencode2_compose( ${n} times, saw ${seen}`);
  }
  if (composes.some((m) => !Object.hasOwn(COMPOSE_CALLS, fnOf(m.index))))
    problems.push("N4: opencode2_compose( is called outside the entry functions");

  const review = body("opencode2_review");
  if (review) {
    pinParameter(masked, "opencode2_review", review, "repo_aware", "bool", problems);
    const pins = production(/\bopencode2_review_pin\s*\(/g);
    const asField = pins.filter(
      (m) =>
        fnOf(m.index) === "opencode2_review" &&
        argsAt(m)?.join() === "repo_aware" &&
        /\bOpencode2Turn::Review\s*\{\s*version\s*,\s*pin\s*:\s*$/.test(
          masked.slice(Math.max(0, m.index - 120), m.index),
        ),
    );
    if (pins.length !== 1 || asField.length !== 1)
      problems.push(
        "N5: opencode2_review must pass opencode2_review_pin(repo_aware) once, as its turn's pin",
      );
  }
  const sessionPins = production(/\bopencode2_session_pin\s*\(/g);
  for (const [fn, n] of Object.entries(SESSION_PIN_CALLS)) {
    const seen = sessionPins.filter((m) => fnOf(m.index) === fn).length;
    if (seen !== n)
      problems.push(`N5: ${fn} must call opencode2_session_pin( ${n} times, saw ${seen}`);
    if (n === 0) continue;
    const span = body(fn);
    if (!span) continue;
    pinParameter(masked, fn, span, "read_only", "bool", problems);
    pinParameter(masked, fn, span, "web", "bool", problems);
    const bound = letStatement(masked, span, "pin");
    const turns = [
      ...masked.slice(...span).matchAll(/\bOpencode2Turn::Session\s*\{\s*pin\s*,/g),
    ].length;
    if (bound.count !== 1 || bound.text !== SESSION_PIN_LET || turns !== 1)
      problems.push(
        `N5: ${fn} must bind ${SESSION_PIN_LET} once and pass it as its turn's pin`,
      );
  }
  if (sessionPins.some((m) => !Object.hasOwn(SESSION_PIN_CALLS, fnOf(m.index))))
    problems.push("N5: opencode2_session_pin( is called outside the session entry functions");

  const reviewArgs = production(/\bcrate::opencode2::review_args\s*\(/g);
  if (
    reviewArgs.length !== 1 ||
    fnOf(reviewArgs[0].index) !== "opencode2_compose" ||
    argsAt(reviewArgs[0])?.[1] !== "&lock"
  )
    problems.push(
      `N6: crate::opencode2::review_args( must be called once, in opencode2_compose, with &lock second, saw ${reviewArgs.length}`,
    );
  const sessionArgs = production(/\bcrate::opencode2::session_args\s*\(/g);
  const agents = sessionArgs.map((m) => argsAt(m)?.[0]);
  if (
    agents.join("\n") !== SESSION_AGENTS.join("\n") ||
    sessionArgs.some((m) => fnOf(m.index) !== "opencode2_compose")
  )
    problems.push(
      `N6: crate::opencode2::session_args( must be called ${SESSION_AGENTS.length} times, in opencode2_compose, first with ${SESSION_AGENTS.join(" then ")}, saw ${agents.join(", ") || "none"}`,
    );
  // The arm a call sits in: the last `Opencode2Turn::<arm> { .. } =>` head before it in compose.
  const composeSpan = fnBody(masked, "opencode2_compose");
  const armOf = (index) => {
    if (!composeSpan) return null;
    let arm = null;
    for (const m of masked
      .slice(...composeSpan)
      .matchAll(/\bOpencode2Turn::\w+\s*\{[^{}]*\}\s*=>/g)) {
      if (composeSpan[0] + m.index > index) break;
      arm = collapse(m[0].replace(/\s*=>$/, "")).replace(/,\s*\}$/, " }");
    }
    return arm;
  };
  const writes = sessionArgs.filter(
    (m) => argsAt(m)?.[0] === "crate::opencode2::SessionAgent::Write",
  );
  if (writes.length !== 1 || armOf(writes[0].index) !== WRITE_ARM)
    problems.push(`N6: the write argv must sit, once, in the arm ${WRITE_ARM}`);
  for (const [variant, n] of Object.entries(SESSION_AGENT_MENTIONS)) {
    const seen = production(new RegExp(`\\bSessionAgent::${variant}\\b`, "g")).length;
    if (seen !== n)
      problems.push(
        `N6: expected ${n} production SessionAgent::${variant} mentions, saw ${seen}`,
      );
  }

  for (const [fn, pattern] of Object.entries(RUN_PATTERNS)) {
    const span = body(fn);
    if (!span) continue;
    const runs = [...masked.slice(...span).matchAll(/\bTurnPlan::Run\s*\{/g)].map(
      (m) => {
        const at = span[0] + m.index;
        const close = callClose(masked, at + m[0].length - 1);
        return collapse(masked.slice(at, close + 1)).replace(/,\s*\}$/, " }");
      },
    );
    if (runs.length !== 1 || runs[0] !== pattern)
      problems.push(`N7: ${fn} must destructure its plan once as ${pattern}`);
    if (letStatement(masked, span, "lock").count !== 0)
      problems.push(`N7: ${fn} must not rebind lock`);
    const parsers = callsIn(masked, span, "crate::opencode2::StreamParser::new");
    if (parsers.length !== 1 || parsers[0]?.[0] !== "lock.as_ref()")
      problems.push(`N7: ${fn} must build its stream parser once, from lock.as_ref()`);
  }
  const parsers = production(/\bStreamParser::new\s*\(/g).length;
  const wired = Object.keys(RUN_PATTERNS).length;
  if (parsers !== wired)
    problems.push(
      `N7: expected ${wired} production StreamParser::new( calls, saw ${parsers}`,
    );

  const reviewEnv = production(/\bcrate::opencode2::review_env\s*\(/g);
  if (
    reviewEnv.length !== 1 ||
    fnOf(reviewEnv[0].index) !== "opencode2_compose" ||
    argsAt(reviewEnv[0])?.[0] !== "config_path"
  )
    problems.push(
      `N8: crate::opencode2::review_env( must be called once in production, in opencode2_compose, with config_path first, saw ${reviewEnv.length}`,
    );
  const sessionEnv = production(/\bcrate::opencode2::session_env\s*\(/g);
  if (
    sessionEnv.length !== SESSION_ENV_CALLS ||
    sessionEnv.some(
      (m) =>
        fnOf(m.index) !== "opencode2_compose" ||
        argsAt(m)?.[0] !== SESSION_ENV_CONFIG,
    )
  )
    problems.push(
      `N8: crate::opencode2::session_env( must be called ${SESSION_ENV_CALLS} times in production, in opencode2_compose, with ${SESSION_ENV_CONFIG} first, saw ${sessionEnv.length}`,
    );
  const compose = body("opencode2_compose");
  if (compose) {
    const local = letStatement(masked, compose, "config_path");
    if (local.count !== 1 || local.text !== "let config_path = inputs.config_path")
      problems.push(
        "N8: opencode2_compose must bind config_path once: let config_path = inputs.config_path",
      );
  }

  const spawns = production(/\bstream_agent\s*\(/g).map((m) => {
    const args = argsAt(m) ?? [];
    const stream = args[13] ?? "nothing";
    const kind = stream.startsWith("Some(Opencode2Stream {") ? "Some" : stream;
    return { fn: fnOf(m.index), args, kind };
  });
  const order = spawns.map((s) => `${s.fn}:${s.kind}`).join(", ");
  const expected = SPAWNS.map(([fn, kind]) => `${fn}:${kind}`).join(", ");
  if (order !== expected)
    problems.push(`N9: the stream_agent( calls are ${order}, expected ${expected}`);
  for (const s of spawns.filter((s) => s.kind === "Some")) {
    const want = SPAWN_INPUTS[s.fn];
    if (!want || s.args[3] !== want[0] || s.args[11] !== want[1])
      problems.push(
        `N9: ${s.fn}'s stream_agent( must pass ${want?.join(" and ")}, got ${s.args[3]} and ${s.args[11]}`,
      );
  }
  const spawners = [
    ...new Set(production(/\bCommand::new\s*\(/g).map((m) => fnOf(m.index))),
  ].sort();
  if (spawners.join() !== COMMAND_FNS.join())
    problems.push(
      `N9: Command::new( sits in ${spawners.join(", ")}, expected ${COMMAND_FNS.join(", ")}`,
    );
  const container = "opencode2_container_session";
  const statementAt = (index) => {
    const at = masked.lastIndexOf("let ", index);
    return collapse(masked.slice(at, masked.indexOf(";", index)));
  };
  const full = production(/\bbuild_run_args_full\s*\(/g);
  if (
    full.length !== BUILD_RUN_ARGS_FULL_CALLS ||
    full.some((m) => fnOf(m.index) !== container)
  )
    problems.push(
      `N9: expected ${BUILD_RUN_ARGS_FULL_CALLS} production build_run_args_full( calls, all in ${container}, saw ${full.length}`,
    );
  else
    full.forEach((m, i) => {
      const [head, tail] = CONTAINER_ARGVS[i];
      // A trailing comma leaves an empty last argument.
      const args = (argsAt(m) ?? []).filter(
        (arg, at, all) => arg !== "" || at < all.length - 1,
      );
      if (
        !statementAt(m.index).startsWith(head) ||
        args.slice(-3).join("\n") !== tail.join("\n")
      )
        problems.push(
          `N9: ${container}'s argv build ${i + 1} must be ${head}.. ${tail.join(", ")})`,
        );
    });
  const splits = production(/\bsplit_container_env\s*\(/g);
  const splitTexts = splits.map((m) => statementAt(m.index));
  if (
    splits.some((m) => fnOf(m.index) !== container) ||
    splitTexts.join("\n") !== CONTAINER_SPLITS.join("\n")
  )
    problems.push(
      `N9: ${container} must split its env as ${CONTAINER_SPLITS.join(", then ")}`,
    );
  // Read from `code`: the masked view blanks the lifetime's quote.
  const byName = letStatement(masked, [0, masked.length], "env_by_name");
  if (
    byName.count !== 1 ||
    fnOf(byName.at) !== container ||
    collapse(code.slice(byName.at, masked.indexOf(";", byName.at))) !==
      collapse(ENV_BY_NAME)
  )
    problems.push(`N9: the env_by_name binding must be ${ENV_BY_NAME}`);

  const entries = [...masked.matchAll(/\bfn\s+(opencode2_\w+)/g)]
    .filter((m) => !inTest(m.index))
    .map((m) => m[1]);
  for (const name of entries) {
    const span = fnBody(masked, name);
    const old = span && OLD_BUILDERS.exec(masked.slice(...span));
    if (old) problems.push(`N10: ${name} names the 1.x ${old[0]}`);
    for (const flag of RUN_FLAGS)
      if (span && code.slice(...span).includes(flag))
        problems.push(`N11: ${name} spells ${flag}`);
  }
  for (const fn of ["agent_review", "agent_session"]) {
    const span = fnBody(masked, fn);
    if (!span) continue;
    const seen = (masked.slice(...span).match(/\bopencode2/g) ?? []).length;
    const allowed = DISPATCHES.filter((d) => d.fn === fn).reduce(
      (n, d) => n + (`${d.head} ${d.tail}`.match(/\bopencode2/g) ?? []).length,
      0,
    );
    if (seen !== allowed)
      problems.push(`N10: ${fn} names opencode2 outside its dispatch statements`);
  }

  const literals = (lit) => {
    const at = [];
    for (let i = code.indexOf(lit); i >= 0; i = code.indexOf(lit, i + 1))
      if (!inTest(i)) at.push(i);
    return at;
  };
  const standalone = literals('"--standalone"');
  const codeLines = code.split("\n");
  if (
    standalone.length !== STANDALONE_LITERALS ||
    standalone.some((i) => !codeLines[lineAt(i) - 1].startsWith(STANDALONE_HOME))
  )
    problems.push(
      `N11: "--standalone" must appear ${STANDALONE_LITERALS} times in production, in ${STANDALONE_HOME}, saw ${standalone.length}`,
    );
  for (const [lit, fns] of OLD_LITERALS) {
    const where = literals(lit).map(fnOf);
    if (where.join() !== fns.join())
      problems.push(
        `N11: ${lit} must appear in production only in ${fns.join(" and ")}, saw ${where.join(", ") || "none"}`,
      );
  }
}

/** N18's detect rows: each `fn`'s opencode arm, found by `arm` in the `code` view
 *  (health.rs's anchor is a string literal, which `masked` blanks). */
const DETECT_ROWS = [
  {
    file: FILE,
    fn: "agent_detect",
    label: "agent_detect",
    arm: /\bif\s+kind\s*==\s*AgentKind::Opencode\s*\{/,
  },
  {
    file: HEALTH_FILE,
    fn: "detect",
    label: "health::detect",
    arm: /\bif\s+id\s*==\s*"opencode"\s*\{/,
  },
];
const DETECTION_FNS = [
  "opencode_detection",
  "opencode_detection_with",
  "opencode_verdict_with",
];

/** N18: each detect fn holds one opencode arm, which reads its version through one
 *  opencode_detection( call and never probes run_capture* itself; the bodies of
 *  opencode_detection, opencode_detection_with and opencode_verdict_with probe no
 *  run_capture*; opencode_verdict_probe( is called in production once in
 *  opencode_verdict and once in opencode_detection, in either order. `texts` maps a
 *  path to its text; counts read the masked view, so comments and literals never
 *  count. */
function checkDetectRows(texts) {
  const problems = [];
  const views = {};
  for (const file of [FILE, HEALTH_FILE]) {
    const text = texts[file];
    if (typeof text !== "string" || text.length === 0) {
      problems.push(`could not read ${file}`);
      continue;
    }
    const { code, masked, unterminated } = lexRust(text);
    if (unterminated >= 0) problems.push(`could not scan ${file}`);
    else views[file] = { code, masked };
  }
  const runCaptures = (masked, [from, to]) =>
    [...masked.slice(from, to).matchAll(/\brun_capture\w*\s*\(/g)].length;
  for (const row of DETECT_ROWS) {
    const view = views[row.file];
    if (!view) continue;
    const { code, masked } = view;
    const body = fnBody(masked, row.fn);
    if (!body) {
      problems.push(`missing anchor: ${row.file} fn ${row.fn}`);
      continue;
    }
    const anchors = [
      ...code.slice(...body).matchAll(new RegExp(row.arm.source, "g")),
    ];
    const m = anchors[0];
    if (!m) {
      problems.push(`missing anchor: ${row.label}'s opencode arm`);
      continue;
    }
    if (anchors.length !== 1)
      problems.push(
        `N18: ${row.label} must hold one opencode arm, saw ${anchors.length}`,
      );
    const braceAt = body[0] + m.index + m[0].length - 1;
    const arm = [braceAt + 1, braceAt + 1 + braceBody(masked, braceAt).length];
    const detections = callsIn(masked, arm, "opencode_detection").length;
    if (detections !== 1)
      problems.push(
        `N18: ${row.label}'s opencode arm must call opencode_detection( once, saw ${detections}`,
      );
    const probes = runCaptures(masked, arm);
    if (probes !== 0)
      problems.push(
        `N18: ${row.label}'s opencode arm must not call run_capture, saw ${probes}`,
      );
  }
  const agent = views[FILE];
  if (!agent) return problems;
  const { masked } = agent;
  for (const name of DETECTION_FNS) {
    const body = fnBody(masked, name);
    if (!body) {
      problems.push(`missing anchor: ${FILE} fn ${name}`);
      continue;
    }
    const probes = runCaptures(masked, body);
    if (probes !== 0)
      problems.push(`N18: ${name} must not call run_capture, saw ${probes}`);
  }
  const spans = testModuleSpans(masked);
  const inTest = (index) =>
    spans.some(([start, end]) => index >= start && index <= end);
  const lines = masked.split("\n");
  const lineAt = (index) => masked.slice(0, index).split("\n").length;
  const sites = [...masked.matchAll(/\bopencode_verdict_probe\s*\(/g)]
    .filter(
      (m) =>
        !inTest(m.index) &&
        !/\bfn\s+$/.test(masked.slice(Math.max(0, m.index - 8), m.index)),
    )
    .map((m) => enclosingFn(lines, lineAt(m.index) - 1))
    .sort();
  if (sites.join(", ") !== "opencode_detection, opencode_verdict")
    problems.push(
      `N18: opencode_verdict_probe( must be called in production only in opencode_verdict and opencode_detection, once each, saw ${sites.join(", ") || "none"}`,
    );
  return problems;
}

function readSource(path = FILE) {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(readFileSync(new URL(`../${path}`, import.meta.url)))
      .replaceAll("\r\n", "\n");
  } catch {
    return null;
  }
}

const source = readSource();
const healthSource = readSource(HEALTH_FILE);

function mutate(edit, from = source) {
  const next = edit(from);
  assert.notEqual(next, from, "mutant changed nothing");
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
      swap("            &container_env,\n            &inner,\n", "            &[],\n            &inner,\n"),
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

/** `t` with the block from `opens` through the first `closes` after it moved to
 *  just after the line holding `anchor`. */
function moveBlock(t, opens, closes, anchor) {
  assert.equal(t.split(opens).length, 2, `not unique: ${opens}`);
  const start = t.indexOf(opens);
  const end = t.indexOf(closes, start) + closes.length;
  const rest = t.slice(0, start) + t.slice(end);
  assert.ok(rest.includes(anchor), `no ${anchor}`);
  const at = rest.indexOf("\n", rest.indexOf(anchor)) + 1;
  return rest.slice(0, at) + t.slice(start, end) + rest.slice(at);
}

const strip = (problems) => problems.map((p) => p.replace(/^[^ ]+ /, ""));
const uniqueSwap = (from, to) => (t) => {
  assert.equal(t.split(from).length, 2, `not unique: ${from}`);
  return t.replace(from, () => to);
};
const plant = (body) => (t) => `${t}\n${body}\n`;
/** `text` inserted right before the one occurrence of `line`. */
const insertBefore = (line, text) => uniqueSwap(line, `${text}${line}`);
/** uniqueSwap inside `fn name` only: the session entry functions share text. */
const fnSwap = (name, from, to) => (t) => {
  const head = t.indexOf(`\nasync fn ${name}(`);
  assert.ok(head >= 0, `no fn ${name}`);
  const end = t.indexOf("\n}\n", head) + 3;
  const body = t.slice(head, end);
  assert.equal(body.split(from).length, 2, `not unique in ${name}: ${from}`);
  return t.slice(0, head) + body.replace(from, () => to) + t.slice(end);
};
const HOST = "opencode2_host_session";
const CONTAINER = "opencode2_container_session";
const REVIEW_DISPATCH =
  "    if kind == AgentKind::Opencode {\n        if let (crate::opencode2::Cli::V2(version), identity) = opencode_cli(&binary).await? {\n";
const HOST_DISPATCH =
  "    let (opencode_v1_restart, opencode_v1_binary) = if kind";
/** The host session's own binary statement, as rustfmt lays it out. */
const HOST_LOOKUP =
  "    let binary = match opencode_v1_binary {\n        Some(binary) => binary,\n        None => resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {\n            AppError::Command(format!(\n                \"{} CLI not found. Install it or set its path in Settings.\",\n                kind.label()\n            ))\n        })?,\n    };\n";
const CONTAINER_DISPATCH =
  "        if kind == AgentKind::Opencode {\n            return Box::pin(opencode2_container_session(";

test("N0: a path-qualified review_env is another module's, never the 1.x call", () => {
  assert.deepEqual(
    checkPinCallSites(
      mutate(
        (t) =>
          `${t}\nfn planted(doc: &str) { let _ = crate::opencode2::review_env(None, doc); }\n`,
      ),
    ),
    [
      "N8: crate::opencode2::review_env( must be called once in production, in opencode2_compose, with config_path first, saw 2",
    ],
  );
});

test("N0: any other path names this file's fn, so it is counted", () => {
  const review = checkPinCallSites(
    mutate(
      (t) =>
        `${t}\nfn planted2(k: AgentKind) { let _ = self::review_env(k, true, None, &[]); }\n`,
    ),
  );
  assert.ok(
    review.some((p) =>
      p.startsWith("expected 1 production review_env call, saw 2"),
    ),
    review.join("\n"),
  );
  const mention = checkPinCallSites(
    mutate((t) => `${t}\nconst F: fn() = self::opencode_session_env;\n`),
  );
  assert.ok(
    mention.some((p) =>
      p.includes("mentions opencode_session_env without calling"),
    ),
    mention.join("\n"),
  );
});

test("N1: agent_review's dispatch is pinned in text and place", () => {
  const shape = `N1: agent_review must dispatch with: ${DISPATCHES[0].head}..${DISPATCHES[0].tail}`;
  for (const [id, edit, refused] of [
    [
      "moved below self_mcp_wanted",
      (t) => moveBlock(t, REVIEW_DISPATCH, "\n    }\n", "let self_mcp_wanted"),
      [
        "N1: opencode2_review's dispatch must sit after let binary = resolve( and before let self_mcp_wanted in agent_review",
      ],
    ],
    [
      "refusal unwrapped",
      uniqueSwap(
        "opencode_cli(&binary).await? {\n            return Box::pin(opencode2_review(",
        "opencode_cli(&binary).await.unwrap() {\n            return Box::pin(opencode2_review(",
      ),
      [shape],
    ],
    [
      "version check dropped",
      uniqueSwap(
        "if let (crate::opencode2::Cli::V2(version), identity) = opencode_cli(&binary).await? {\n            return Box::pin(opencode2_review(",
        "if let (crate::opencode2::Cli::V2(version), identity) = (V2, None) {\n            return Box::pin(opencode2_review(",
      ),
      [shape, "N3: agent_review must read its Cli from one opencode_cli( call, saw 0"],
    ],
    [
      "a second call",
      (t) => `${t}\nfn planted() { opencode2_review(); }\n`,
      ["N1: expected 1 production opencode2_review call, saw 2"],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N2: agent_session's dispatches are pinned in text and place", () => {
  const host = DISPATCHES[1];
  for (const [id, edit, refused] of [
    [
      "host moved below mcp_config_path",
      (t) =>
        moveBlock(
          t,
          HOST_DISPATCH,
          "\n    };\n",
          "let mut mcp_config_path: Option<String> = None;",
        ),
      [
        "N2 host: opencode2_host_session's dispatch must sit after let mcp_names and before let mut mcp_config_path in agent_session",
      ],
    ],
    [
      "host 1.x arm never restarts",
      uniqueSwap(
        "                opencode1_must_restart(resume, native_session_id.as_deref()),\n                Some(binary),\n",
        "                false,\n                Some(binary),\n",
      ),
      [`N2 host: agent_session must dispatch with: ${host.head}..${host.tail}`],
    ],
    [
      "container moved below seed_session_home",
      (t) =>
        moveBlock(
          t,
          CONTAINER_DISPATCH,
          "\n        }\n",
          "let home = crate::agent_sandbox::seed_session_home(",
        ),
      [
        "N2 container: opencode2_container_session's dispatch must sit after the image_has_agent refusal and the `..` check and before seed_session_home( in agent_session",
      ],
    ],
    [
      "image gate not first",
      uniqueSwap(
        "    match crate::agent_sandbox::image_opencode_state(&runtime).await {",
        "    let _ = binary_identity(&runtime);\n    match crate::agent_sandbox::image_opencode_state(&runtime).await {",
      ),
      [
        "N2: opencode2_container_session's first call must be image_opencode_state(, got binary_identity(",
      ],
    ],
    [
      "second calls",
      (t) =>
        `${t}\nfn planted() { opencode2_host_session(); opencode2_container_session(); }\n`,
      [
        "N2 host: expected 1 production opencode2_host_session call, saw 2",
        "N2 container: expected 1 production opencode2_container_session call, saw 2",
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N2: the 1.x host branch runs the binary it classified", () => {
  const resolves =
    "N2 host: agent_session must call resolve( 2 times (the dispatch's and the other CLIs' host lookup), saw 3";
  const statement = `N2 host: the 1.x host branch must run its classified binary: ${HOST_BINARY}`;
  const rebound =
    "N2 host: nothing may bind or name binary between the 1.x host lookup and its spawn, saw 1";
  const HOST_EXTRA_ENV =
    "    let host_extra_env: Vec<(&str, String)> = if kind == AgentKind::Opencode {";
  for (const [id, edit, refused] of [
    [
      "a second lookup",
      uniqueSwap(
        "Some(binary) => binary,",
        "Some(_) => resolve(kind, None).await.unwrap(),",
      ),
      [resolves, statement],
    ],
    [
      "the old shape",
      uniqueSwap(
        HOST_LOOKUP,
        "    let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {\n        AppError::Command(format!(\n            \"{} CLI not found. Install it or set its path in Settings.\",\n            kind.label()\n        ))\n    })?;\n",
      ),
      [statement],
    ],
    [
      "a suffix after the lookup",
      uniqueSwap(
        HOST_LOOKUP,
        HOST_LOOKUP.replace(
          /\n {4}\};\n$/,
          () => '\n    }.with_file_name("opencode1");\n',
        ),
      ),
      [statement],
    ],
    [
      "the spawn runs a name",
      uniqueSwap(
        "        &binary,\n        inner,",
        '        Path::new("opencode"),\n        inner,',
      ),
      [
        "agent_session's host branch must spawn stream_agent with &binary, got Path::new( )",
      ],
    ],
    [
      "a tuple rebind",
      insertBefore(HOST_EXTRA_ENV, '    let (binary, _) = (PathBuf::from("opencode"), ());\n'),
      [rebound],
    ],
    [
      "a let-else rebind",
      insertBefore(
        HOST_EXTRA_ENV,
        '    let Some(binary) = Some(PathBuf::from("opencode")) else { unreachable!() };\n',
      ),
      [rebound],
    ],
    [
      "a shadowed dispatch binary",
      insertBefore(
        "    let binary = match opencode_v1_binary {\n",
        '    let opencode_v1_binary = Some(PathBuf::from("opencode"));\n',
      ),
      [
        "N2 host: nothing may bind or name opencode_v1_binary between its dispatch and the host lookup, saw 1",
      ],
    ],
    [
      "a comment naming binary",
      insertBefore(HOST_EXTRA_ENV, "    // binary is the classified one\n"),
      [],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N2: the host lookup's sentence is not pinned, its refusal is", () => {
  const sentence =
    '"{} CLI not found. Install it or set its path in Settings.",\n                kind.label()\n            ))\n        })?;\n        match opencode_cli(&binary).await? {';
  assert.deepEqual(
    checkPinCallSites(
      mutate(
        uniqueSwap(
          sentence,
          sentence.replace(
            "{} CLI not found. Install it or set its path in Settings.",
            () => "{} is not installed here. Set its path in Settings.",
          ),
        ),
      ),
    ),
    [],
  );
  assert.deepEqual(
    checkPinCallSites(
      mutate(
        uniqueSwap(
          '        let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {\n            AppError::Command(format!(\n                "{} CLI not found. Install it or set its path in Settings.",\n                kind.label()\n            ))\n        })?;\n        match',
          "        let binary = resolve(kind, bin_path.as_deref()).await.unwrap_or_default();\n        match",
        ),
      ),
    ),
    [
      `N2 host: agent_session must dispatch with: ${DISPATCHES[1].head}..${DISPATCHES[1].tail}`,
    ],
  );
});

test("N1-N2: a comment inside a dispatch statement passes", () => {
  const notes = (indent, n) =>
    `${indent}// ${"x".repeat(72)}\n`.repeat(n);
  for (const [id, edit] of [
    [
      "inside the review's head",
      uniqueSwap(
        "opencode_cli(&binary).await? {\n            return Box::pin(opencode2_review(",
        "opencode_cli(&binary).await? {\n            // a note\n            return Box::pin(opencode2_review(",
      ),
    ],
    [
      "inside the host dispatch's tail",
      uniqueSwap(
        "                .await;\n            }\n            (crate::opencode2::Cli::V1(_), _) => (",
        "                .await;\n                // a note\n            }\n            (crate::opencode2::Cli::V1(_), _) => (",
      ),
    ],
    [
      "long notes inside the host dispatch's tail",
      uniqueSwap(
        "                .await;\n            }\n            (crate::opencode2::Cli::V1(_), _) => (",
        `                .await;\n${notes("                ", 3)}            }\n            (crate::opencode2::Cli::V1(_), _) => (`,
      ),
    ],
    ...[3, 30].map((n) => [
      `${n} long notes inside the review's head`,
      uniqueSwap(
        "opencode_cli(&binary).await? {\n            return Box::pin(opencode2_review(",
        `opencode_cli(&binary).await? {\n${notes("            ", n)}            return Box::pin(opencode2_review(`,
      ),
    ]),
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), [], id);
});

test("N18: each detect row's opencode arm reads one observation", () => {
  assert.ok(healthSource);
  const rows = (agent, health) => ({ [FILE]: agent, [HEALTH_FILE]: health });
  assert.deepEqual(checkDetectRows(rows(source, healthSource)), []);
  const AGENT_ARM =
    "        let detection = Box::pin(opencode_detection(&binary)).await;\n";
  const HEALTH_ARM =
    "        let detection = Box::pin(crate::agent::opencode_detection(&binary)).await;\n";
  const probe =
    '        let _ = run_capture(&binary, &["--version"], DETECT_TIMEOUT).await;\n';
  const bodyProbe =
    '    let _ = run_capture(binary, &["--version"], DETECT_TIMEOUT).await;\n';
  const spelled =
    '        // run_capture(&binary, &["--version"])\n        let _ = "run_capture(";\n';
  /** `line` inserted as the first line of the body opening after `header`. */
  const firstInBody = (header, line) => (t) => {
    const at = t.indexOf(header);
    assert.ok(at >= 0 && t.indexOf(header, at + 1) < 0, `not unique: ${header}`);
    const open = t.indexOf("{\n", at) + 2;
    return t.slice(0, open) + line + t.slice(open);
  };
  const DETECTION =
    "pub(crate) async fn opencode_detection(binary: &Path) -> OpencodeDetection {\n";
  const sites =
    "N18: opencode_verdict_probe( must be called in production only in opencode_verdict and opencode_detection, once each, saw ";
  for (const [id, file, edit, refused] of [
    [
      "agent arm probe",
      FILE,
      insertBefore(AGENT_ARM, probe),
      ["N18: agent_detect's opencode arm must not call run_capture, saw 1"],
    ],
    [
      "health arm probe",
      HEALTH_FILE,
      insertBefore(HEALTH_ARM, probe),
      ["N18: health::detect's opencode arm must not call run_capture, saw 1"],
    ],
    [
      "agent arm second detection",
      FILE,
      insertBefore(AGENT_ARM, "        let _ = opencode_detection(&binary).await;\n"),
      [
        "N18: agent_detect's opencode arm must call opencode_detection( once, saw 2",
      ],
    ],
    [
      "health arm second detection",
      HEALTH_FILE,
      insertBefore(
        HEALTH_ARM,
        "        let _ = crate::agent::opencode_detection(&binary).await;\n",
      ),
      [
        "N18: health::detect's opencode arm must call opencode_detection( once, saw 2",
      ],
    ],
    [
      "a second probe site",
      FILE,
      firstInBody(DETECTION, "    let _ = opencode_verdict_probe(binary).await;\n"),
      [`${sites}opencode_detection, opencode_detection, opencode_verdict`],
    ],
    [
      "the probe sites in the other order",
      FILE,
      (t) => {
        const start = t.indexOf("/// Detect paths: never an error");
        const end = t.indexOf("\n}\n", t.indexOf(DETECTION, start)) + 3;
        const rest = t.slice(0, start) + t.slice(end);
        const at = rest.indexOf("\nasync fn opencode_verdict(") + 1;
        const moved = rest.slice(0, at) + t.slice(start, end) + rest.slice(at);
        assert.ok(
          moved.indexOf(DETECTION) < moved.indexOf("\nasync fn opencode_verdict("),
          "opencode_detection moved above opencode_verdict",
        );
        return moved;
      },
      [],
    ],
    [
      "a second agent arm",
      FILE,
      insertBefore(
        "    let version = printed\n",
        '    let _ = if kind == AgentKind::Opencode {\n        run_capture(&binary, &["--version"], DETECT_TIMEOUT).await.ok()\n    } else {\n        None\n    };\n',
      ),
      ["N18: agent_detect must hold one opencode arm, saw 2"],
    ],
    [
      "a second health arm",
      HEALTH_FILE,
      insertBefore(
        "    let version = printed\n",
        '    let _ = if id == "opencode" {\n        run_capture(&binary, &["--version"], DETECT_TIMEOUT).await.ok()\n    } else {\n        None\n    };\n',
      ),
      ["N18: health::detect must hold one opencode arm, saw 2"],
    ],
    [
      "the verdict's probe site gone",
      FILE,
      fnSwap(
        "opencode_verdict",
        "opencode_verdict_probe(binary)",
        "async { VersionProbe::Failed(String::new()) }",
      ),
      [`${sites}opencode_detection`],
    ],
    [
      "a probe in opencode_detection",
      FILE,
      firstInBody(DETECTION, bodyProbe),
      ["N18: opencode_detection must not call run_capture, saw 1"],
    ],
    [
      "a probe in opencode_detection_with",
      FILE,
      firstInBody(
        "async fn opencode_detection_with<",
        '    let _ = run_capture_parts(binary, &["--version"], DETECT_TIMEOUT).await;\n',
      ),
      ["N18: opencode_detection_with must not call run_capture, saw 1"],
    ],
    [
      "a probe in opencode_verdict_with",
      FILE,
      firstInBody("async fn opencode_verdict_with<", bodyProbe),
      ["N18: opencode_verdict_with must not call run_capture, saw 1"],
    ],
    ["a spelling in the agent arm", FILE, insertBefore(AGENT_ARM, spelled), []],
    ["a spelling in the health arm", HEALTH_FILE, insertBefore(HEALTH_ARM, spelled), []],
  ]) {
    const texts =
      file === FILE
        ? rows(mutate(edit), healthSource)
        : rows(source, mutate(edit, healthSource));
    assert.deepEqual(checkDetectRows(texts), refused, id);
  }
  const unread = checkDetectRows(rows(source, null));
  assert.ok(unread.includes(`could not read ${HEALTH_FILE}`), unread.join("\n"));
  const renamed = checkDetectRows(
    rows(
      source,
      mutate(
        uniqueSwap('if id == "opencode" {', 'if id.eq("opencode") {'),
        healthSource,
      ),
    ),
  );
  assert.ok(
    renamed.includes("missing anchor: health::detect's opencode arm"),
    renamed.join("\n"),
  );
});

test("N3: one version classifier, and each host dispatch reads opencode_cli", () => {
  for (const [id, edit, refused] of [
    [
      "a second classifier call",
      (t) =>
        `${t}\nfn planted() { let _ = crate::opencode2::classify_version(""); }\n`,
      [
        "N3: classify_version must be called once in production, in opencode_verdict_with, saw 2",
      ],
    ],
    [
      "a second opencode_cli in agent_review",
      uniqueSwap(
        "    let self_mcp_wanted",
        "    let _ = opencode_cli(&binary).await;\n    let self_mcp_wanted",
      ),
      ["N3: agent_review must read its Cli from one opencode_cli( call, saw 2"],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N12: core items are named only as crate::opencode2::…", () => {
  for (const [id, edit, refused] of [
    [
      "use import",
      (t) => `use crate::opencode2::Cli;\n${t}`,
      ["N12: agent.rs must not spell use crate::opencode2"],
    ],
    [
      "grouped import",
      (t) => `use crate::{error, opencode2};\n${t}`,
      ["N12: agent.rs must not spell use crate::{opencode2}"],
    ],
    [
      "alias",
      (t) => `use crate::opencode2 as oc2;\n${t}`,
      [
        "N12: agent.rs must not spell use crate::opencode2",
        "N12: agent.rs must not spell opencode2 as",
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
  assert.deepEqual(
    strip(
      checkPinCallSites(
        mutate(
          uniqueSwap(
            "crate::opencode2::classify_version(&text)",
            "super::opencode2::classify_version(&text)",
          ),
        ),
      ),
    ),
    ["N12: core items are spelled crate::opencode2::"],
  );
});

test("N13: the sign-in export never leaves its three uses", () => {
  const uses =
    "N13: export_stdout must be bound once, counted once by credential_export_count(&export_stdout) and piped once as stdin: Some(export_stdout)";
  const sink = `${FILE}:? N13: a line naming export_stdout must not format, log or decode it`;
  for (const [id, edit, refused] of [
    [
      "logged through a format string",
      uniqueSwap(
        "    let _ = run_capture(runtime, &[\"rm\", \"-f\", import_container], DETECT_TIMEOUT).await;\n    let import",
        "    log::debug!(\"{export_stdout:?}\");\n    let _ = run_capture(runtime, &[\"rm\", \"-f\", import_container], DETECT_TIMEOUT).await;\n    let import",
      ),
      ["N13: export_stdout must appear 3 times in production, saw 4", sink],
    ],
    [
      "decoded on its way to the import",
      uniqueSwap(
        "stdin: Some(export_stdout),",
        "stdin: Some(String::from_utf8_lossy(&export_stdout).to_string().into_bytes()),",
      ),
      [uses, sink],
    ],
    [
      "a second binding",
      uniqueSwap(
        "    match crate::agent_sandbox::credential_export_count(&export_stdout) {",
        "    let kept = export_stdout.clone();\n    match crate::agent_sandbox::credential_export_count(&export_stdout) {",
      ),
      ["N13: export_stdout must appear 3 times in production, saw 4"],
    ],
    [
      "never counted",
      uniqueSwap(
        "credential_export_count(&export_stdout)",
        "credential_export_count(&[])",
      ),
      ["N13: export_stdout must appear 3 times in production, saw 2", uses],
    ],
  ])
    assert.deepEqual(strip(checkPinCallSites(mutate(edit))), strip(refused), id);
  // A comment naming it is no mention.
  assert.deepEqual(
    checkPinCallSites(mutate(plant("// println!(\"{export_stdout:?}\")"))),
    [],
  );
});

test("N13: the export arm's own bindings never reach a sink", () => {
  const sink = `${FILE}:? N13: a statement naming stdout or export before export_stdout is bound must not format, log or decode it`;
  const COPY = "opencode2_copy_sign_ins";
  for (const [id, edit] of [
    [
      "the arm's stdout logged",
      fnSwap(
        COPY,
        "        }) => stdout,\n",
        '        }) => {\n            log::debug!("{stdout:?}");\n            stdout\n        }\n',
      ),
    ],
    [
      "the arm's stdout decoded",
      fnSwap(
        COPY,
        "        }) => stdout,\n",
        "        }) => String::from_utf8_lossy(&stdout).into_owned().into_bytes(),\n",
      ),
    ],
    [
      "the export formatted before the binding",
      fnSwap(
        COPY,
        "    let export_stdout = match export {",
        '    let _ = format!("{}", export.is_ok());\n    let export_stdout = match export {',
      ),
    ],
  ])
    assert.deepEqual(strip(checkPinCallSites(mutate(edit))), strip([sink]), id);
  // A statement naming neither may format; one naming them without a sink is free.
  assert.deepEqual(
    checkPinCallSites(
      mutate(
        fnSwap(
          COPY,
          "    let export_stdout = match export {",
          '    let _ = format!("{}", 1);\n    let _ = export.is_ok();\n    let export_stdout = match export {',
        ),
      ),
    ),
    [],
  );
});

test("N14: nothing changes a plan between its TurnPlan::Run and its spawn", () => {
  for (const [id, edit, refused] of [
    [
      "a mut rebinding that truncates the argv",
      fnSwap(
        HOST,
        "    let tag = NativeTag {",
        "    let mut run = run;\n    run.args.truncate(4);\n    let tag = NativeTag {",
      ),
      [
        "N14: opencode2_host_session must not bind run as mut before its spawn",
        "N14: opencode2_host_session must bind run 0 times between its TurnPlan::Run and its spawn, saw 1",
        "N14: opencode2_host_session must not change its plan before its spawn: run.args.",
      ],
    ],
    [
      "a struct-update rebinding that narrows the argv",
      fnSwap(
        CONTAINER,
        "    let (container_env, client_env) = split_container_env(run.env);",
        "    let run = SpawnPlan { args: run.args[..4].to_vec(), ..run };\n    let (container_env, client_env) = split_container_env(run.env);",
      ),
      [
        "N14: opencode2_container_session must bind run 0 times between its TurnPlan::Run and its spawn, saw 1",
        "N14: opencode2_container_session must not change its plan before its spawn: run.args[",
      ],
    ],
    [
      "a second client env",
      fnSwap(
        CONTAINER,
        "    let run_args = crate::agent_sandbox::build_run_args_full(",
        "    let client_env = Vec::new();\n    let run_args = crate::agent_sandbox::build_run_args_full(",
      ),
      [
        "N14: opencode2_container_session must bind client_env 1 times between its TurnPlan::Run and its spawn, saw 2",
      ],
    ],
    [
      "the review's env emptied",
      fnSwap(
        "opencode2_review",
        "        if opencode2_cancel_fired(&cancel) {",
        "        run.env.clear();\n        if opencode2_cancel_fired(&cancel) {",
      ),
      [
        "N14: opencode2_review must not change its plan before its spawn: run.env.",
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N15: each read-back and spawn runs on its plan's own inputs", () => {
  const refusal = (fn, got) =>
    `N15: ${fn}'s read-back must build ${PROBE_REQUESTS[fn]}.. once, got ${got}`;
  const NO_CWD = "cwd: Some(plan.cwd.as_str()),";
  for (const [id, edit, refused] of [
    [
      "the host read-back without a cwd",
      fnSwap(HOST, NO_CWD, "cwd: None,"),
      [
        refusal(
          HOST,
          "CaptureRequest { program: binary, args: plan.args, cwd: None, env: plan.env,",
        ),
      ],
    ],
    [
      "the container read-back without a cwd",
      fnSwap(CONTAINER, NO_CWD, "cwd: None,"),
      [
        refusal(
          CONTAINER,
          "CaptureRequest { program: runtime_bin, args: probe_args, cwd: None, env: client_env,",
        ),
      ],
    ],
    [
      "the review read-back on another env",
      fnSwap("opencode2_review", "env: plan.env,", "env: Vec::new(),"),
      [
        refusal(
          "opencode2_review",
          "CaptureRequest { program: binary, args: plan.args, cwd: Some(plan.cwd.as_str()), env: Vec::new(),",
        ),
      ],
    ],
    [
      "the container run in another cwd",
      fnSwap(CONTAINER, "        &run.cwd,\n", "        &worktree_path,\n"),
      [
        `N15: ${CONTAINER}'s stream_agent( must take &run.cwd as its cwd, got &worktree_path`,
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N16: each 2.x model read keeps its argv and the project-disable pair", () => {
  const swapArms = (t) => {
    const head = "    let listed = if v2 {\n";
    const split = "\n    } else {\n";
    const start = t.indexOf(head) + head.length;
    const mid = t.indexOf(split, start);
    const end = t.indexOf("\n    };\n", mid);
    assert.ok(start >= head.length && mid > start && end > mid, "no listing");
    return (
      t.slice(0, start) +
      t.slice(mid + split.length, end) +
      split +
      t.slice(start, mid) +
      t.slice(end)
    );
  };
  const calls = `N16: opencode2_read_request( must be called ${READ_REQUESTS.map(([fn, args]) => `in ${fn} with ${args.join(", ")}`).join(", then ")}`;
  for (const [id, edit, refused] of [
    [
      "swapped arms",
      swapArms,
      [`N16: agent_models must list once as ${MODELS_LISTING}`],
    ],
    [
      "the catalog reading the models argv",
      fnSwap(
        "opencode2_catalog",
        "crate::opencode2::CATALOG_ARGS",
        "crate::opencode2::MODELS_ARGS",
      ),
      [calls],
    ],
    [
      "the 1.x arm on another argv",
      uniqueSwap(
        "    let Some(args) = kind.models_args() else {",
        '    let Some(args) = Some(&["x"][..]) else {',
      ),
      [
        "N16: agent_models must bind args once, as let Some(args) = kind.models_args() else",
      ],
    ],
    [
      "the project-disable pair dropped",
      uniqueSwap(READ_REQUEST_ENV, "env: Vec::new(),"),
      [`N16: opencode2_read_request must set ${READ_REQUEST_ENV}`],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N17: the 1.x restart rebinding precedes the 1.x session argv", () => {
  const refused = [
    `N17: agent_session must rebind ${RESTART_REBIND} once, before its opencode_session_args( call`,
  ];
  const REBIND =
    "    let (resume, native_session_id) = if opencode_v1_restart {\n        (false, None)\n    } else {\n        (resume, native_session_id)\n    };\n";
  for (const [id, edit] of [
    ["deleted", uniqueSwap(REBIND, "")],
    [
      "moved below the session argv",
      (t) =>
        moveBlock(
          t,
          "    let (resume, native_session_id) = if opencode_v1_restart {",
          "\n    };\n",
          "Container isolation: wrap the same invocation",
        ),
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N4: the lock is produced in opencode2_lock, which only compose calls", () => {
  for (const [id, edit, refused] of [
    [
      "a second read-back",
      plant('fn planted() { let _ = crate::opencode2::read_back("", a, b); }'),
      [
        "N4: crate::opencode2::read_back( must be called once in production, in opencode2_lock, saw 2",
      ],
    ],
    [
      "a second lock document",
      plant("fn planted() { let _ = crate::opencode2::lock_document(a, b); }"),
      [
        "N4: crate::opencode2::lock_document( must be called once in production, in opencode2_lock, saw 2",
      ],
    ],
    [
      "a lock outside compose",
      plant("fn planted() { opencode2_lock(); }"),
      [
        "N4: opencode2_lock( must be called 2 times in production, all in opencode2_compose, saw 3",
      ],
    ],
    [
      "a review that skips compose",
      uniqueSwap(
        "\n        let plan = opencode2_compose(&inputs,",
        "\n        let plan = opencode2_plan(&inputs,",
      ),
      ["N4: opencode2_review must call opencode2_compose( 1 times, saw 0"],
    ],
    [
      "a host session that skips compose",
      fnSwap(
        HOST,
        "\n    let plan = opencode2_compose(&inputs,",
        "\n    let plan = opencode2_plan(&inputs,",
      ),
      ["N4: opencode2_host_session must call opencode2_compose( 1 times, saw 0"],
    ],
    [
      "a container session that skips compose",
      fnSwap(
        CONTAINER,
        "\n    let plan = opencode2_compose(&inputs,",
        "\n    let plan = opencode2_plan(&inputs,",
      ),
      ["N4: opencode2_container_session must call opencode2_compose( 1 times, saw 0"],
    ],
    [
      "compose from elsewhere",
      plant("fn planted() { opencode2_compose(); }"),
      ["N4: opencode2_compose( is called outside the entry functions"],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N5: each pin comes from its own entry function's parameters", () => {
  const hostPin = `N5: opencode2_host_session must bind ${SESSION_PIN_LET} once and pass it as its turn's pin`;
  const containerPin = `N5: opencode2_container_session must bind ${SESSION_PIN_LET} once and pass it as its turn's pin`;
  for (const [id, edit, refused] of [
    [
      "a hard-coded pin",
      uniqueSwap(
        "version,\n                pin: opencode2_review_pin(repo_aware),",
        "version,\n                pin: opencode2_review_pin(true),",
      ),
      [
        "N5: opencode2_review must pass opencode2_review_pin(repo_aware) once, as its turn's pin",
      ],
    ],
    [
      "a mut parameter",
      uniqueSwap(
        "    repo_aware: bool,\n    mcp_self: bool,\n    timeout_secs: Option<u64>,\n    timeout_configurable: Option<bool>,\n    review_id: String,\n    on_event: Channel<ReviewEvent>,\n) -> AppResult<Option<ReviewEvent>> {\n    let self_specs",
        "    mut repo_aware: bool,\n    mcp_self: bool,\n    timeout_secs: Option<u64>,\n    timeout_configurable: Option<bool>,\n    review_id: String,\n    on_event: Channel<ReviewEvent>,\n) -> AppResult<Option<ReviewEvent>> {\n    let self_specs",
      ),
      ["opencode2_review must declare repo_aware without mut"],
    ],
    [
      "a hard-coded session pin",
      fnSwap(
        HOST,
        "let pin = opencode2_session_pin(read_only, web);",
        "let pin = opencode2_session_pin(true, web);",
      ),
      [hostPin],
    ],
    [
      "a write turn whatever the pin",
      fnSwap(
        HOST,
        "        turn: Opencode2Turn::Session {\n            pin,\n",
        "        turn: Opencode2Turn::Session {\n            pin: None,\n",
      ),
      [hostPin],
    ],
    [
      "a mut pin",
      fnSwap(
        HOST,
        "let pin = opencode2_session_pin(read_only, web);",
        "let mut pin = opencode2_session_pin(read_only, web);",
      ),
      [hostPin],
    ],
    [
      "a hard-coded container pin",
      fnSwap(
        CONTAINER,
        "let pin = opencode2_session_pin(read_only, web);",
        "let pin = opencode2_session_pin(read_only, false);",
      ),
      [containerPin],
    ],
    [
      "a container write turn whatever the pin",
      fnSwap(
        CONTAINER,
        "        turn: Opencode2Turn::Session {\n            pin,\n",
        "        turn: Opencode2Turn::Session {\n            pin: None,\n",
      ),
      [containerPin],
    ],
    [
      "a mut container read_only",
      fnSwap(CONTAINER, "    read_only: bool,\n", "    mut read_only: bool,\n"),
      ["opencode2_container_session must declare read_only without mut"],
    ],
    [
      "a rebound container web",
      fnSwap(
        CONTAINER,
        "    let pin = opencode2_session_pin(read_only, web);",
        "    let web = false;\n    let pin = opencode2_session_pin(read_only, web);",
      ),
      ["opencode2_container_session must not rebind web"],
    ],
    [
      "a mut read_only",
      uniqueSwap(
        "    read_only: bool,\n    web: bool,\n    native_session_id: Option<String>,\n    mcp_specs: &[crate::mcp::McpServerSpec],\n    on_event: Channel<ReviewEvent>,\n) -> AppResult<Option<ReviewEvent>> {\n    let pin",
        "    mut read_only: bool,\n    web: bool,\n    native_session_id: Option<String>,\n    mcp_specs: &[crate::mcp::McpServerSpec],\n    on_event: Channel<ReviewEvent>,\n) -> AppResult<Option<ReviewEvent>> {\n    let pin",
      ),
      ["opencode2_host_session must declare read_only without mut"],
    ],
    [
      "a rebound web",
      fnSwap(
        HOST,
        "    let pin = opencode2_session_pin(read_only, web);",
        "    let web = true;\n    let pin = opencode2_session_pin(read_only, web);",
      ),
      ["opencode2_host_session must not rebind web"],
    ],
    [
      "a second container pin",
      fnSwap(
        CONTAINER,
        "    let stored = parse_native_ref(",
        "    let _ = opencode2_session_pin(true, true);\n    let stored = parse_native_ref(",
      ),
      ["N5: opencode2_container_session must call opencode2_session_pin( 1 times, saw 2"],
    ],
    [
      "a session pin elsewhere",
      plant("fn planted() { opencode2_session_pin(a, b); }"),
      ["N5: opencode2_session_pin( is called outside the session entry functions"],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N6: each argv takes the lock, and the write argv sits in the write arm", () => {
  const argv = (saw) =>
    `N6: crate::opencode2::session_args( must be called 2 times, in opencode2_compose, first with ${SESSION_AGENTS.join(" then ")}, saw ${saw}`;
  const arm = `N6: the write argv must sit, once, in the arm ${WRITE_ARM}`;
  const write = "crate::opencode2::SessionAgent::Write";
  for (const [id, edit, refused] of [
    [
      "another document",
      uniqueSwap(
        "review_args(version, &lock, inputs.model, variant)",
        "review_args(version, &other, inputs.model, variant)",
      ),
      [
        "N6: crate::opencode2::review_args( must be called once, in opencode2_compose, with &lock second, saw 1",
      ],
    ],
    [
      "a pinned turn's argv without its lock",
      uniqueSwap("crate::opencode2::SessionAgent::Locked(&lock),", `${write},`),
      [
        argv(`${write}, ${write}`),
        arm,
        "N6: expected 1 production SessionAgent::Locked mentions, saw 0",
        "N6: expected 1 production SessionAgent::Write mentions, saw 2",
      ],
    ],
    [
      "the write argv under another arm",
      uniqueSwap(
        "            pin: None,\n            session_id,\n        } => Ok(TurnPlan::Run {",
        "            pin: _,\n            session_id,\n        } => Ok(TurnPlan::Run {",
      ),
      [arm],
    ],
    [
      "another session argv",
      plant(
        `fn planted() { let _ = crate::opencode2::session_args(${write}, a, b, c); }`,
      ),
      [
        argv(`${SESSION_AGENTS[0]}, ${write}, ${write}`),
        arm,
        "N6: expected 1 production SessionAgent::Write mentions, saw 2",
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N7: the run's parser knows the lock its plan carries", () => {
  for (const [id, edit, refused] of [
    [
      "a review parser without the lock",
      uniqueSwap(
        "StreamParser::new(lock.as_ref()),\n                native: None,",
        "StreamParser::new(None),\n                native: None,",
      ),
      ["N7: opencode2_review must build its stream parser once, from lock.as_ref()"],
    ],
    [
      "a session parser without the lock",
      fnSwap(
        HOST,
        "StreamParser::new(lock.as_ref()),\n            native: Some(tag),",
        "StreamParser::new(None),\n            native: Some(tag),",
      ),
      [
        "N7: opencode2_host_session must build its stream parser once, from lock.as_ref()",
      ],
    ],
    [
      "a mut session destructuring",
      fnSwap(
        HOST,
        "let TurnPlan::Run { run, lock, .. } = plan else {",
        "let TurnPlan::Run { run, mut lock, .. } = plan else {",
      ),
      [
        "N7: opencode2_host_session must destructure its plan once as TurnPlan::Run { run, lock, .. }",
      ],
    ],
    [
      "a container parser without the lock",
      fnSwap(
        CONTAINER,
        "StreamParser::new(lock.as_ref()),\n            native: Some(tag),",
        "StreamParser::new(None),\n            native: Some(tag),",
      ),
      [
        "N7: opencode2_container_session must build its stream parser once, from lock.as_ref()",
      ],
    ],
    [
      "a rebound container lock",
      fnSwap(
        CONTAINER,
        "    let tag = NativeTag {",
        "    let lock = None;\n    let tag = NativeTag {",
      ),
      ["N7: opencode2_container_session must not rebind lock"],
    ],
    [
      "a rebound lock",
      uniqueSwap(
        "        let diff_only = matches!(",
        "        let lock = None;\n        let diff_only = matches!(",
      ),
      ["N7: opencode2_review must not rebind lock"],
    ],
    [
      "a mut destructuring",
      uniqueSwap("            run,\n            lock,\n            read_back,\n", "            run,\n            mut lock,\n            read_back,\n"),
      [
        "N7: opencode2_review must destructure its plan once as TurnPlan::Run { run, lock, read_back }",
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N8: each env reads compose's one config_path", () => {
  const sessionEnv = (saw) =>
    `N8: crate::opencode2::session_env( must be called 2 times in production, in opencode2_compose, with ${SESSION_ENV_CONFIG} first, saw ${saw}`;
  for (const [id, edit, refused] of [
    [
      "no config",
      uniqueSwap(
        "crate::opencode2::review_env(config_path, doc)",
        "crate::opencode2::review_env(None, doc)",
      ),
      [
        "N8: crate::opencode2::review_env( must be called once in production, in opencode2_compose, with config_path first, saw 1",
      ],
    ],
    [
      "a mut local",
      uniqueSwap(
        "let config_path = inputs.config_path;",
        "let mut config_path = inputs.config_path;",
      ),
      [
        "N8: opencode2_compose must bind config_path once: let config_path = inputs.config_path",
      ],
    ],
    [
      "a write env without the config",
      uniqueSwap(
        "crate::opencode2::session_env(config_path.map(String::from), None)",
        "crate::opencode2::session_env(None, None)",
      ),
      [sessionEnv(2)],
    ],
    [
      "a pinned env from another binding",
      uniqueSwap(
        "crate::opencode2::session_env(config_path.map(String::from), Some(doc))",
        "crate::opencode2::session_env(inputs.config_path.map(String::from), Some(doc))",
      ),
      [sessionEnv(2)],
    ],
    [
      "another session env",
      plant(
        "fn planted() { let _ = crate::opencode2::session_env(config_path.map(String::from), None); }",
      ),
      [sessionEnv(3)],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N9: every spawn is a listed one, with the plan's argv and env", () => {
  const spawners = (extra) =>
    `N9: Command::new( sits in ${[...COMMAND_FNS, extra].sort().join(", ")}, expected ${COMMAND_FNS.join(", ")}`;
  for (const [id, edit, refused] of [
    [
      "another env",
      uniqueSwap("            &run.env,\n", "            &[],\n"),
      ["N9: opencode2_review's stream_agent( must pass run.args and &run.env, got run.args and &[]"],
    ],
    [
      "another session env",
      uniqueSwap("\n        &run.env,\n", "\n        &[],\n"),
      [
        "N9: opencode2_host_session's stream_agent( must pass run.args and &run.env, got run.args and &[]",
      ],
    ],
    [
      "a 2.x run on the 1.x parser",
      uniqueSwap(
        "            Some(Opencode2Stream {\n                parser: crate::opencode2::StreamParser::new(lock.as_ref()),\n                native: None,\n            }),\n",
        "            None,\n",
      ),
      [
        "N7: opencode2_review must build its stream parser once, from lock.as_ref()",
        "N7: expected 3 production StreamParser::new( calls, saw 2",
        "N9: the stream_agent( calls are agent_review:None, agent_session:None, agent_session:None, opencode2_review:None, opencode2_host_session:Some, opencode2_container_session:Some, expected agent_review:None, agent_session:None, agent_session:None, opencode2_review:Some, opencode2_host_session:Some, opencode2_container_session:Some",
      ],
    ],
    [
      "a raw spawn",
      plant('fn planted() { let _ = std::process::Command::new("x"); }'),
      [spawners("planted")],
    ],
    [
      "a container argv builder elsewhere",
      plant("fn planted() { let _ = crate::agent_sandbox::build_run_args_full(a); }"),
      [
        "N9: expected 2 production build_run_args_full( calls, all in opencode2_container_session, saw 3",
      ],
    ],
    [
      "the container run's document in argv",
      fnSwap(CONTAINER, "        &client_env,\n", "        &[],\n"),
      [
        "N9: opencode2_container_session's stream_agent( must pass run_args and &client_env, got run_args and &[]",
      ],
    ],
    [
      "a container run that never names its document",
      fnSwap(CONTAINER, "if lock.is_some() {", "if lock.is_none() {"),
      [`N9: the env_by_name binding must be ${ENV_BY_NAME}`],
    ],
    [
      "a probe that never names its document",
      fnSwap(
        CONTAINER,
        "            &[crate::opencode2::CONTENT_ENV],\n            &plan.args,\n",
        "            &[],\n            &plan.args,\n",
      ),
      [
        `N9: opencode2_container_session's argv build 1 must be ${CONTAINER_ARGVS[0][0]}.. ${CONTAINER_ARGVS[0][1].join(", ")})`,
      ],
    ],
    [
      "a container run on another argv",
      fnSwap(CONTAINER, "        &run.args,\n    );", "        &inner,\n    );"),
      [
        `N9: opencode2_container_session's argv build 2 must be ${CONTAINER_ARGVS[1][0]}.. ${CONTAINER_ARGVS[1][1].join(", ")})`,
      ],
    ],
    [
      "an unsplit container env",
      fnSwap(
        CONTAINER,
        "let (container_env, client_env) = split_container_env(run.env);",
        "let (container_env, client_env) = (run.env, Vec::new());",
      ),
      [`N9: opencode2_container_session must split its env as ${CONTAINER_SPLITS.join(", then ")}`],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N10: no 1.x builder in an opencode2 body, no opencode2 outside a dispatch", () => {
  for (const [id, edit, refused] of [
    [
      "a 1.x mirror in the review",
      uniqueSwap(
        "    let self_specs = if mcp_self {",
        "    let _ = opencode_read_mirror;\n    let self_specs = if mcp_self {",
      ),
      ["N10: opencode2_review names the 1.x opencode_read_mirror"],
    ],
    [
      "a 1.x env in the host session",
      fnSwap(
        HOST,
        "    let pin = opencode2_session_pin(read_only, web);",
        "    let _ = opencode_variant;\n    let pin = opencode2_session_pin(read_only, web);",
      ),
      ["N10: opencode2_host_session names the 1.x opencode_variant"],
    ],
    [
      "opencode2 in agent_review",
      uniqueSwap(
        "    let self_mcp_wanted = ",
        "    let _ = opencode2_review_pin;\n    let self_mcp_wanted = ",
      ),
      ["N10: agent_review names opencode2 outside its dispatch statements"],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
});

test("N11: run flags stay in core, and the literal counts hold", () => {
  for (const [id, edit, refused] of [
    [
      "a flag in an opencode2 body",
      plant('fn opencode2_planted() { let _ = "--auto"; }'),
      ['N11: opencode2_planted spells "--auto"'],
    ],
    [
      "a standalone spelling",
      plant('fn planted() { let _ = "--standalone"; }'),
      [
        'N11: "--standalone" must appear 1 times in production, in const OPENCODE2_AUTH_EXPORT_ARGS, saw 2',
      ],
    ],
    [
      "the export flag moved out of its const",
      (t) =>
        plant('fn planted() { let _ = "--standalone"; }')(
          uniqueSwap('&["auth", "export", "--standalone"];', '&["auth", "export"];')(t),
        ),
      [
        'N11: "--standalone" must appear 1 times in production, in const OPENCODE2_AUTH_EXPORT_ARGS, saw 1',
      ],
    ],
    [
      "a flag in the sign-in copy",
      fnSwap(
        "opencode2_copy_sign_ins",
        "        cwd: None,\n",
        '        cwd: Some("--yolo"),\n',
      ),
      ['N11: opencode2_copy_sign_ins spells "--yolo"'],
    ],
    [
      "a third CONTENT spelling",
      plant('fn planted() { let _ = "OPENCODE_CONFIG_CONTENT"; }'),
      [
        'N11: "OPENCODE_CONFIG_CONTENT" must appear in production only in opencode_config_sources and opencode_read_mirror_with, saw opencode_config_sources, opencode_read_mirror_with, planted',
      ],
    ],
  ])
    assert.deepEqual(checkPinCallSites(mutate(edit)), refused, id);
  // A comment is not a literal.
  assert.deepEqual(
    checkPinCallSites(mutate(plant('// fn opencode2_planted() { "--auto" }'))),
    [],
  );
});
