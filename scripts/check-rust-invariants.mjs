#!/usr/bin/env node
// Static gate for five Rust invariants that have each cost this repo a fix
// round. Text-level checks over `src-tauri/src/**/*.rs` — no compiler, no deps,
// Node built-ins only — so they run anywhere `node` does:
//
//   A. refspec templates — a user-named ref must not reach `refs/heads/<name>`
//      (the refspec-injection class of PR #76, which re-opened once because the
//      chokepoint was convention rather than enforcement).
//   B. secret-shaped argv — a secret in `gh -f key=value` is world-readable in
//      the process table.
//   C. sync `#[tauri::command]` — a blocking command body runs on the main
//      thread and freezes the UI.
//   D. stderr-only `AppError::Git` — whole families of git command report a
//      failure on STDOUT with stderr EMPTY (a conflicted merge, a refused
//      `commit`, a conflicted `stash pop`), so an error built from stderr alone
//      renders to the user as the bare "git exited with code N".
//      `GitOutput::full_failure_text()` is the shaping that carries both halves.
//      Scoped to `AppError::Git` constructions on purpose: the `Gh`/`Glab`
//      variants are tuple-shaped and their CLIs do not split a report this way.
//   E. compare basehead — a forge-sourced ref interpolated into a
//      `…/compare/<base>...<head>` path. `gh api` expands `{…}` as its own
//      placeholders and a URL parser truncates at `#`/`?`, so an unvalidated
//      segment answers 200 for the WRONG refs; fork head refs and owners are
//      attacker-chosen. `forge::validate_compare_branch` is the chokepoint.
//
// Each check carries an ALLOWLIST of `{ file, fn, rationale }` records. RATCHET
// RULE: the lists only shrink by default. Adding an entry is a reviewed change —
// it needs a rationale naming the guard that makes the site safe (a validator
// call, a trusted producer), and it lands in review like any other diff. A
// (file, fn) entry covers every site in that function, so entries are pruned
// when their site goes away rather than left behind to pre-authorize whatever
// the function grows next.
//
// Run: node scripts/check-rust-invariants.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./check-banned-patterns.mjs";

const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "src",
);

// ---------------------------------------------------------------- allowlists

// Check A. Every entry either validates the interpolated name itself or receives
// it from a producer that did — verified by reading each site.
const REFSPEC_ALLOWLIST = [
  {
    file: "forge/bitbucket.rs",
    fn: "ref_is_tag",
    rationale:
      "Bitbucket REST path, not a git refspec — every segment is encode_query_value'd",
  },
  {
    file: "git/branches.rs",
    fn: "branch_tip_sha",
    rationale:
      "read-only rev-parse tip probe (never a refspec); validates with validate_branch_name at fn entry",
  },
  {
    file: "git/branches.rs",
    fn: "git_default_branch",
    rationale: "interpolates only the fixed literals main/master",
  },
  {
    file: "git/branches.rs",
    fn: "git_branch_merge_states",
    rationale:
      "validates each pair's head/base with validate_branch_name inline",
  },
  {
    file: "git/branches.rs",
    fn: "repo_with_local_upstream",
    rationale:
      "#[cfg(test)] fixture — interpolates the default-branch name read back from git's own rev-parse on a repo the test creates; no user-named ref reaches it",
  },
  {
    file: "git/ops.rs",
    fn: "branch_tip",
    rationale:
      "private helper reading a branch tip (never a refspec); both callers (merge_local_pr, finalize_base via its own callers) validate base with validate_branch_name",
  },
  {
    file: "git/ops.rs",
    fn: "finalize_base",
    rationale:
      "private helper; both callers (merge_local_pr, finish_local_pr_merge) validate base with validate_branch_name",
  },
  {
    file: "git/ops.rs",
    fn: "push_pr_head",
    rationale:
      "private helper; both callers (merge_remote_pr, finish_remote_pr_resolve) validate head with validate_branch_name",
  },
  {
    file: "git/ops.rs",
    fn: "merge_remote_pr",
    rationale: "validates base and head with validate_branch_name at fn entry",
  },
  {
    file: "git/ops.rs",
    fn: "git_push_tag_core",
    rationale: "validates the tag name with validate_tag_name at fn entry",
  },
  {
    file: "git/ops.rs",
    fn: "git_delete_tag_core",
    rationale: "validates the tag name with validate_tag_name at fn entry",
  },
  {
    file: "git/remote.rs",
    fn: "git_push_core",
    rationale:
      "validates branch, remote and remote_branch with validate_ref_name at fn entry",
  },
  {
    file: "git/remote.rs",
    fn: "build_push_args",
    rationale:
      "the push-refspec chokepoint; its only caller (git_push_core) validates every interpolated name first",
  },
  {
    file: "git/remote.rs",
    fn: "publish_refspec",
    rationale: "the publish-refspec chokepoint; callers validate the branch",
  },
  {
    file: "git/remote.rs",
    fn: "branch_has_reflog",
    rationale:
      "read-only `reflog exists` probe (never a refspec); the name is either git_push_core's branch, validated with validate_ref_name at the arm entry, or `symbolic-ref --short` output — git's own ref name",
  },
  {
    file: "git/remote.rs",
    fn: "parse_upstream_tracking_matches_real_for_each_ref_output",
    rationale: "#[cfg(test)] fixture — the branch name is a test literal",
  },
  {
    file: "git/worktree.rs",
    fn: "validated_branch_tip",
    rationale:
      "read-only rev-parse tip probe gating the removal's best-effort branch delete (never a refspec); validates with validate_ref_name at fn entry",
  },
  {
    file: "github/pr.rs",
    fn: "gh_delete_remote_head_branch",
    rationale:
      "server-reported head ref, and the endpoint is a REST path the API validates",
  },
  {
    file: "github/pr.rs",
    fn: "detect_fork_pr_for_branch",
    rationale: "validates branch with validate_ref_name at fn entry",
  },
  {
    file: "mcp_server/generate.rs",
    fn: "committed_base_ref",
    rationale: "interpolates git_default_branch's own output, never user input",
  },
  {
    file: "mcp_server/write_local.rs",
    fn: "verify_branch",
    rationale:
      "validates via validate_branch_name at fn entry (rev-expression syntax rejected before the probe)",
  },
];

// Check B. Empty by design: secrets ride `run_gh_input` / `json_body_args` stdin
// bodies, and no site pairs a `-f`-family flag with a secret-shaped key.
const SECRET_ARGV_ALLOWLIST = [];

// Check C. The 9 sync commands that predate the rule. Each is main-thread-safe
// for its own reason; converting them is separate work, not a reason to widen
// the gate. Entries are (file, fn), so app_menu's two cfg-twin declarations of
// `set_recent_repos_menu` share one.
const SYNC_COMMAND_ALLOWLIST = [
  {
    file: "app_menu.rs",
    fn: "set_recent_repos_menu",
    rationale: "menu-bar mutation — Tauri requires it on the main thread",
  },
  {
    file: "github/issue.rs",
    fn: "read_issue_templates",
    rationale: "reads a handful of small template files from the repo dir",
  },
  {
    file: "path_launcher.rs",
    fn: "path_launcher_status",
    rationale: "stats one shim path",
  },
  {
    file: "path_launcher.rs",
    fn: "path_launcher_remove",
    rationale: "removes one shim file",
  },
  {
    file: "pty.rs",
    fn: "pty_write",
    rationale: "writes to an in-memory PTY handle behind a mutex",
  },
  {
    file: "pty.rs",
    fn: "pty_resize",
    rationale: "resizes an in-memory PTY handle behind a mutex",
  },
  {
    file: "pty.rs",
    fn: "pty_close",
    rationale: "drops an in-memory PTY handle behind a mutex",
  },
  {
    file: "tray.rs",
    fn: "set_close_to_tray",
    rationale: "flips one in-memory AppState flag",
  },
];

// Check D. Sites whose git command provably reports on stderr alone, verified by
// reading each one: read-only scans and parses, where a non-zero exit is git
// refusing the READ (bad revision, unreadable path) rather than a working-tree
// operation half-finishing across two streams.
const STDERR_ONLY_ALLOWLIST = [
  {
    file: "git/ai_ignore.rs",
    fn: "run_check_ignore",
    rationale: "`check-ignore` read — stdout is the match list, never a report",
  },
  {
    file: "git/branches.rs",
    fn: "git_set_branch_archived",
    rationale: "`config` write — no working-tree operation to half-finish",
  },
  {
    file: "git/compare.rs",
    fn: "run_grep",
    rationale: "`grep` read — stdout is the match list, never a report",
  },
  {
    file: "git/conflict.rs",
    fn: "git_diff_contents",
    rationale:
      "`show`/`cat-file` read — stdout is the file content being parsed",
  },
  {
    file: "git/diff.rs",
    fn: "git_diff_file",
    rationale: "`diff` read — stdout is the patch being parsed",
  },
  {
    file: "git/diff.rs",
    fn: "git_session_file_diff",
    rationale: "`diff --no-index` read — stdout is the patch being parsed",
  },
  {
    file: "git/ops.rs",
    fn: "classify_failure",
    rationale:
      "`report` is a parameter, so no binding is in range — its doc contract requires full_failure_text() and every caller passes it",
  },
  {
    file: "git/ops.rs",
    fn: "git_rebase_edit",
    rationale:
      "interactive-rebase START failure, reached only when nothing is in progress — a paused rebase returns Ok, so there is no stdout report to lose",
  },
  {
    file: "git/runner.rs",
    fn: "run_git_input",
    rationale:
      "THE stderr-only contract itself — callers whose failure rides stdout take run_git_raw and shape it with full_failure_text()",
  },
  {
    file: "git/todos.rs",
    fn: "git_todo_scan",
    rationale: "`grep` read — stdout is the match list, never a report",
  },
];

// Check E. Both sites route every interpolated segment — base, head, and the
// cross-repo owner sharing the head's path segment — through
// `forge::validate_compare_branch`, verified by reading each one.
const COMPARE_ENDPOINT_ALLOWLIST = [
  {
    file: "forge/github.rs",
    fn: "fork_divergence",
    rationale:
      "its only caller (forge::forge_fork_divergence) validates base_branch and fork_branch with validate_compare_branch, and the owner via fork_owner_from_full_name, before dispatch",
  },
  {
    file: "github/pr.rs",
    fn: "build_divergence_compare_path",
    rationale:
      "validates base, head and the cross-repository owner with validate_compare_branch at fn entry",
  },
];

// ------------------------------------------------------------------- helpers

/** Every `.rs` file under `src-tauri/src`, as absolute paths. */
function rustFiles(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) rustFiles(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

// Attribution is textual: the nearest preceding signature. A match inside a
// closure or a nested block is therefore reported against the function that
// encloses it, which is exactly the granularity the allowlists key on.
// Every qualifier a signature can carry must be here, in any order `const`,
// `async` and `unsafe` legally combine: a signature the pattern misses is
// silently attributed to the PRECEDING function instead (five `const fn`s in
// forge/model.rs were invisible to the narrower `(?:async\s+)?` form).
// The ABI string is optional because a bare `extern fn` is legal and defaults
// to "C".
export const FN_RE =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe)\s+)*(?:extern(?:\s+"[^"]*")?\s+)?fn\s+(\w+)/;

export function enclosingFn(lines, lineIdx) {
  for (let i = lineIdx; i >= 0; i--) {
    const m = FN_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return "<top level>";
}

const allowed = (list, file, fn) =>
  list.some((e) => e.file === file && e.fn === fn);

/** Allowlist records no hit mapped to. Their site is gone, so the entry is
 *  stale — and the RATCHET RULE above is only a ratchet if a leftover entry is
 *  a finding: left in place it silently pre-authorizes whatever that function
 *  grows next. */
export function staleAllowlistEntries(list, hits) {
  return list.filter(
    (e) => !hits.some((h) => h.file === e.file && h.fn === e.fn),
  );
}

// -------------------------------------------------------------------- checks

// `format!(` through to its template, tolerating a newline before the literal
// (rustfmt breaks long calls that way) and raw strings.
const FORMAT_RE = /\bformat!\s*\(\s*r?#*"((?:[^"\\]|\\.)*)"/g;
const REFSPEC_MARKERS = ["refs/heads/{", "refs/tags/{", ":refs/"];
const REFSPEC_FIX =
  "names reaching a refspec route through validate_ref_name/validate_tag_name " +
  "(gd-conventions Security hot spots) — validate, or allowlist with rationale";

export function checkRefspecTemplates(file, src, lines, hits) {
  FORMAT_RE.lastIndex = 0;
  for (let m = FORMAT_RE.exec(src); m; m = FORMAT_RE.exec(src)) {
    if (!REFSPEC_MARKERS.some((marker) => m[1].includes(marker))) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const fn = enclosingFn(lines, line - 1);
    hits.push({
      file,
      line,
      fn,
      allowlisted: allowed(REFSPEC_ALLOWLIST, file, fn),
      fix: REFSPEC_FIX,
    });
  }
}

// A `format!` template whose `…/compare/…` path interpolates ANYTHING after
// the `/compare/` marker — that tail is the basehead, the only part a
// forge-sourced ref reaches. A fully literal compare path is not a hit
// (nothing to inject), and, like check A, a path built by `push_str`/`+` is
// invisible here by construction — that is what the allowlist is for.
const COMPARE_MARKER = "/compare/";
const COMPARE_FIX =
  "refs reaching a compare basehead route through " +
  "forge::validate_compare_branch (gh expands `{…}` as placeholders; `#`/`?` " +
  "truncate the path) — validate, or allowlist with rationale";

export function checkCompareEndpoints(file, src, lines, hits) {
  FORMAT_RE.lastIndex = 0;
  for (let m = FORMAT_RE.exec(src); m; m = FORMAT_RE.exec(src)) {
    const at = m[1].indexOf(COMPARE_MARKER);
    if (at < 0) continue;
    if (!m[1].slice(at + COMPARE_MARKER.length).includes("{")) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const fn = enclosingFn(lines, line - 1);
    hits.push({
      file,
      line,
      fn,
      allowlisted: allowed(COMPARE_ENDPOINT_ALLOWLIST, file, fn),
      fix: COMPARE_FIX,
    });
  }
}

// The `-f`-family flags as standalone argv literals, and any string literal in
// the same 3-line window whose key segment looks like a credential. The window
// exists because rustfmt routinely splits `.arg("-f").arg(format!(…))` across
// lines; a key built at runtime (`format!("{k}={v}")`) is invisible here by
// construction, which is what the allowlist is for.
const ARGV_FLAG_RE = /"(?:-f|-F|--field|--raw-field)"/;
const STRING_RE = /"((?:[^"\\]|\\.)*)"/g;
const SECRET_KEY_RE = /token|secret|passw|credential|api[_-]?key/i;
const SECRET_ARGV_FIX =
  "secrets never ride argv — send them via run_gh_input / json_body_args stdin bodies";

export function checkSecretArgv(file, _src, lines, hits) {
  for (let i = 0; i < lines.length; i++) {
    if (!ARGV_FLAG_RE.test(lines[i])) continue;
    const window = lines.slice(i, i + 3).join("\n");
    STRING_RE.lastIndex = 0;
    for (let m = STRING_RE.exec(window); m; m = STRING_RE.exec(window)) {
      const eq = m[1].indexOf("=");
      if (eq < 0 || !SECRET_KEY_RE.test(m[1].slice(0, eq))) continue;
      const fn = enclosingFn(lines, i);
      hits.push({
        file,
        line: i + 1,
        fn,
        allowlisted: allowed(SECRET_ARGV_ALLOWLIST, file, fn),
        fix: SECRET_ARGV_FIX,
      });
      break;
    }
  }
}

const COMMAND_ATTR_RE = /^\s*#\[tauri::command/;
const STALE_FIX =
  "stale allowlist entry — nothing in this function trips the check any more " +
  "(fixed, renamed, deleted, or moved to another file/fn); remove the entry " +
  "(RATCHET RULE: the lists only shrink)";
const SYNC_COMMAND_FIX =
  "sync #[tauri::command]s run on the main thread (gd-conventions Rust) — " +
  "make it async (spawn_blocking for IO), or allowlist with rationale";

export function checkSyncCommands(file, _src, lines, hits) {
  for (let i = 0; i < lines.length; i++) {
    if (!COMMAND_ATTR_RE.test(lines[i])) continue;
    // Skip the attributes, cfg gates and doc comments between the marker and
    // the signature.
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("#[") || t.startsWith("//")) j++;
      else break;
    }
    const sig = lines[j] ?? "";
    if (!/\bfn\s+\w+/.test(sig)) {
      // Fail closed: an unreadable signature is a checker bug, never a pass.
      hits.push({
        file,
        line: i + 1,
        fn: "<unresolved>",
        allowlisted: false,
        fix: "the checker could not find this command's signature — update scripts/check-rust-invariants.mjs",
      });
      continue;
    }
    if (/\basync\s+fn\b/.test(sig)) continue;
    const fn = /\bfn\s+(\w+)/.exec(sig)[1];
    hits.push({
      file,
      line: j + 1,
      fn,
      allowlisted: allowed(SYNC_COMMAND_ALLOWLIST, file, fn),
      fix: SYNC_COMMAND_FIX,
    });
  }
}

// An `AppError::Git { … }` whose `stderr:` field is built from stderr alone.
// The verdict is read from the FIELD VALUE as an expression, never from the
// surrounding text: a comment naming `full_failure_text` must not disarm the
// check, and a value that only names a binding is chased through its
// initializers, so substituting `.stderr` anywhere along that chain is caught.
// The constructor is delimited by brace balance, not a line count — every
// fail-open this check has had came from a scan that ended too early.
//
// Requiring a `stderr:` FIELD is what keeps destructuring out — `{ stderr, .. }`
// binds a name, it does not assign one. A pattern that RENAMES (`stderr: a_err`)
// still looks like a field, and its binding resolves to nothing; those live in
// test code, which this check skips by span (see `testModuleSpans`).
const GIT_CTOR_RE = /AppError::Git\s*\{/g;
const STDERR_READ_RE = /\b[A-Za-z_]\w*\s*\.\s*stderr\b/;
const BARE_IDENT_RE = /^[A-Za-z_]\w*$/;
const FULL_FAILURE_TEXT_RE = /\bfull_failure_text\s*\(/;
// `full_failure_text` ENDS with this name, so the character in front is the only
// thing telling the substituting helper from the combining one.
const SUBSTITUTING_RE = /(?:^|[^_\w])failure_text\s*\(/;
const STDERR_ONLY_FIX =
  "a failing git command can report on STDOUT with stderr empty (gd-conventions) — " +
  "shape the error with GitOutput::full_failure_text(), or allowlist with rationale";
const SUBSTITUTION_FIX =
  "GitOutput::failure_text() SUBSTITUTES one stream for the other, so it drops half " +
  "of any report that splits — use full_failure_text(), or allowlist with rationale";
const UNRESOLVED_FIX =
  "this stderr value names a binding the checker cannot resolve, so it cannot tell " +
  "which shaping built it — inline the shaping, or allowlist with rationale";

/** Character spans of every `#[cfg(test)]`-gated `mod`, as `[open, close]` brace
 *  indices. The invariant governs how PRODUCTION code shapes a user-facing
 *  error; test code destructures those same shapes, and a fail-closed binding
 *  check reads every renaming pattern as an unresolvable field.
 *
 *  Spans, not a cut at the first attribute: a cut leaves every constructor after
 *  a test module unscanned, which is a fail-open that grows with the file.
 *  Matching `mod` specifically is load-bearing too — `#[cfg(test)]` also gates
 *  statics, functions and even `if let` blocks (`app_store.rs`), whose next
 *  brace would otherwise be read as a module body. */
export function testModuleSpans(text) {
  // Outer attributes may sit between the gate and the module
  // (`#[cfg(test)] #[allow(…)] mod tests {`); only whitespace separates them, so
  // tolerating a run of them cannot skip over an intervening ITEM.
  const attr =
    /#\[cfg\(\s*(?:all\(\s*)?test\b[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  const spans = [];
  for (let m = attr.exec(text); m; m = attr.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = open + 1 + braceBody(text, open).length;
    spans.push([open, close]);
    attr.lastIndex = close;
  }
  return spans;
}

/** Index of a char literal's closing quote at `i`, or -1 when the `'` opens a
 *  LIFETIME (`&'a str`, `State<'_, AppState>`) instead. Rust reuses the
 *  character, and reading a lifetime as an open quote swallows the rest of the
 *  scan as string content — silently, and as a pass. */
function charLiteralEnd(text, i) {
  const m = /^'(?:\\u\{[0-9a-fA-F]*\}|\\.|[^\\'])'/.exec(text.slice(i, i + 24));
  return m ? i + m[0].length - 1 : -1;
}

/** Index of the closing delimiter of the string or char literal starting at `i`,
 *  or -1 when the character opens neither.
 *
 *  A RAW literal (`r"…"`, `br#"…"#`) ends at a quote followed by its own hash
 *  count and honors no escapes at all, so it needs its own branch: the
 *  escape-aware scan walks straight past the closing quote of
 *  `r"\\?\"` (`git/worktree.rs`) and reads the rest of the file as string
 *  content. `b"…"` / `c"…"` are NOT raw and stay on the escape-aware branch.
 *  An unterminated literal ends at the text, so a scan can never run past its
 *  own input. */
function literalEnd(text, i) {
  if (text[i] === "'") return charLiteralEnd(text, i);
  const raw = /^(?:b|c)?r(#*)"/.exec(text.slice(i, i + 16));
  if (raw) {
    const close = `"${raw[1]}`;
    const at = text.indexOf(close, i + raw[0].length);
    return at === -1 ? text.length - 1 : at + close.length - 1;
  }
  if (text[i] !== '"') return -1;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j;
  }
  return text.length - 1;
}

/** The body of the `{ … }` opening at `openIdx`, brace-balanced. Rustfmt and a
 *  long field expression can push `stderr:` arbitrarily far down a constructor,
 *  and a fixed line window that ends before it reads as "no stderr field" — a
 *  pass, on the shape most likely to be wrong. */
export function braceBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const lit = literalEnd(text, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0)
      return text.slice(openIdx + 1, i);
  }
  // Unbalanced (a truncated file): hand back the remainder rather than nothing,
  // so a `stderr:` below still gets read.
  return text.slice(openIdx + 1);
}

/** Index just past the `stderr:` field's colon in a constructor `body`, or -1.
 *  Found by scanning at depth 0 outside literals rather than by matching text:
 *  an earlier field whose STRING happens to contain `stderr: …` would otherwise
 *  answer for the real field and hide it. */
function stderrFieldStart(body) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const lit = literalEnd(body, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const c = body[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < body.length && /\w/.test(body[j])) j++;
      let k = j;
      while (k < body.length && /\s/.test(body[k])) k++;
      // `::` is a path, not a field.
      if (
        body.slice(i, j) === "stderr" &&
        body[k] === ":" &&
        body[k + 1] !== ":"
      )
        return k + 1;
      i = j - 1;
    }
  }
  return -1;
}

/** The `stderr:` field's value expression, or null when the constructor `body`
 *  has no such field. Scans to the `,` or `}` that closes the field at bracket
 *  depth 0, skipping literals so a `format!("…{stderr}")` brace cannot end it. */
export function stderrFieldValue(body) {
  const start = stderrFieldStart(body);
  if (start < 0) return null;
  let depth = 0;
  let out = "";
  for (let i = start; i < body.length; i++) {
    const lit = literalEnd(body, i);
    if (lit >= 0) {
      out += body.slice(i, lit + 1);
      i = lit;
      continue;
    }
    const c = body[i];
    if ("([{".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
    out += c;
  }
  return out.trim();
}

/** The initializer of the nearest preceding `let <name> = …`, bounded by the
 *  enclosing signature so a same-named binding in another function can't answer.
 *  null when there is none — a parameter, or a pattern's binding. */
export function bindingInitializer(lines, fromIdx, name) {
  const decl = new RegExp(
    `\\blet\\s+(?:mut\\s+)?${name}\\s*(?::[^=]*)?=\\s*(.*)$`,
  );
  for (let i = fromIdx; i >= 0 && i > fromIdx - 40; i--) {
    if (FN_RE.test(lines[i])) return null;
    const m = decl.exec(lines[i]);
    if (!m) continue;
    let init = m[1];
    for (
      let j = i + 1;
      !init.includes(";") && j < i + 6 && j < lines.length;
      j++
    ) {
      init += lines[j];
    }
    return init;
  }
  return null;
}

/** The fix a stderr field value earns, or null when it is correctly shaped.
 *
 *  Follows a chain of bare-ident aliases (`let stderr = out.stderr; let report =
 *  stderr; … stderr: report`), because stopping after one hop lands on a value
 *  none of the shaping tests match — which reads as correctly shaped. The
 *  seen-set bounds the walk and makes a mutually-recursive pair fail closed,
 *  like every other step the checker cannot resolve. */
function stderrValueVerdict(value, lines, ctorIdx) {
  const seen = new Set();
  for (let expr = value; ; ) {
    if (FULL_FAILURE_TEXT_RE.test(expr)) return null;
    if (SUBSTITUTING_RE.test(expr)) return SUBSTITUTION_FIX;
    if (STDERR_READ_RE.test(expr)) return STDERR_ONLY_FIX;
    if (!BARE_IDENT_RE.test(expr)) return null;
    if (seen.has(expr)) return UNRESOLVED_FIX;
    seen.add(expr);
    const init = bindingInitializer(lines, ctorIdx, expr);
    if (init === null) return UNRESOLVED_FIX;
    // Judge the WHOLE initializer. The split below truncates at the first `;`,
    // including one inside a string (`format!("a; {}", out.stderr)`), so it is
    // only ever good enough to name the next alias — never to decide a verdict.
    if (FULL_FAILURE_TEXT_RE.test(init)) return null;
    if (SUBSTITUTING_RE.test(init)) return SUBSTITUTION_FIX;
    if (STDERR_READ_RE.test(init)) return STDERR_ONLY_FIX;
    expr = init.split(";")[0].trim();
  }
}

export function checkStderrOnlyGitError(file, _src, lines, hits) {
  const code = stripComments(lines);
  const codeSrc = code.join("\n");
  const spans = testModuleSpans(codeSrc);
  GIT_CTOR_RE.lastIndex = 0;
  for (let m = GIT_CTOR_RE.exec(codeSrc); m; m = GIT_CTOR_RE.exec(codeSrc)) {
    if (spans.some(([s, e]) => m.index > s && m.index < e)) continue;
    const line = codeSrc.slice(0, m.index).split("\n").length;
    const open = m.index + m[0].length - 1;
    const value = stderrFieldValue(braceBody(codeSrc, open));
    if (value === null) continue;
    const fix = stderrValueVerdict(value, code, line - 1);
    if (fix === null) continue;
    const fn = enclosingFn(lines, line - 1);
    hits.push({
      file,
      line,
      fn,
      allowlisted: allowed(STDERR_ONLY_ALLOWLIST, file, fn),
      fix,
    });
  }
}

// ---------------------------------------------------------------------- main

function main() {
  const CHECKS = [
    {
      name: "A. refspec templates",
      run: checkRefspecTemplates,
      allowlist: REFSPEC_ALLOWLIST,
      hits: [],
    },
    {
      name: "B. secret-shaped argv",
      run: checkSecretArgv,
      allowlist: SECRET_ARGV_ALLOWLIST,
      hits: [],
    },
    {
      name: "C. sync #[tauri::command]",
      run: checkSyncCommands,
      allowlist: SYNC_COMMAND_ALLOWLIST,
      hits: [],
    },
    {
      name: "D. stderr-only AppError::Git",
      run: checkStderrOnlyGitError,
      allowlist: STDERR_ONLY_ALLOWLIST,
      hits: [],
    },
    {
      name: "E. compare basehead",
      run: checkCompareEndpoints,
      allowlist: COMPARE_ENDPOINT_ALLOWLIST,
      hits: [],
    },
  ];

  const files = rustFiles(SRC);
  for (const path of files) {
    // Normalise CRLF: on Windows a git checkout materialises these files with
    // CRLF, and a trailing `\r` would leak into every reported line.
    const src = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const lines = src.split("\n");
    const rel = relative(SRC, path).replace(/\\/g, "/");
    for (const check of CHECKS) check.run(rel, src, lines, check.hits);
  }

  let failed = false;
  for (const check of CHECKS) {
    const violations = check.hits.filter((h) => !h.allowlisted);
    const allowlisted = check.hits.length - violations.length;
    const stale = staleAllowlistEntries(check.allowlist, check.hits);
    if (violations.length === 0 && stale.length === 0) {
      process.stdout.write(
        `${check.name}: OK (${files.length} files, ${allowlisted} allowlisted)\n`,
      );
      continue;
    }
    failed = true;
    process.stderr.write(
      `${check.name}: FAIL (${files.length} files, ${violations.length} violation(s), ${allowlisted} allowlisted, ${stale.length} stale)\n`,
    );
    for (const v of violations) {
      process.stderr.write(`  src-tauri/src/${v.file}:${v.line}  fn ${v.fn}\n`);
      process.stderr.write(`    ${v.fix}\n`);
    }
    for (const e of stale) {
      process.stderr.write(`  src-tauri/src/${e.file}  fn ${e.fn}\n`);
      process.stderr.write(`    ${STALE_FIX}\n`);
    }
  }

  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // violation list the failure is about on a CI runner.
  process.exitCode = failed ? 1 : 0;
}

// Main-module detection by PATH comparison, not `import.meta.main`: this form
// works on any node, while `import.meta.main` only exists from 24.2 — a cliff
// the documented floor should not have to track, and one that fails SILENTLY
// (the gate reads `if (undefined)` and the script exits 0 having scanned
// nothing — the fail-open this whole file exists to prevent).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
