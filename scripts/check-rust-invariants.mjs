#!/usr/bin/env node
// Static gate for three Rust invariants that have each cost this repo a fix
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
    fn: "parse_upstream_tracking_matches_real_for_each_ref_output",
    rationale: "#[cfg(test)] fixture — the branch name is a test literal",
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
