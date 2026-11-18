#!/usr/bin/env node
// Static gate for thirteen Rust invariants that have each cost this repo a fix
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
//      A bound value is judged as bindingInitializer's contract states.
//   E. compare basehead — a forge-sourced ref interpolated into a
//      `…/compare/<base>...<head>` path. `gh api` expands `{…}` as its own
//      placeholders and a URL parser truncates at `#`/`?`, so an unvalidated
//      segment answers 200 for the WRONG refs; fork head refs and owners are
//      attacker-chosen. `forge::validate_compare_branch` is the chokepoint.
//   F. short ref names — `rev-parse --abbrev-ref`, `symbolic-ref --short`,
//      `%(refname:short)` and `%(upstream:short)` disambiguate (`heads/<x>`,
//      `remotes/<r>/<x>`, or the full ref) whenever a tag or other ref shares the
//      name, so a NAME use misroutes. `git::branches::current_branch_name` /
//      `current_branch_ref` and a stripped `%(refname)` are the replacements.
//   G. bare branch revs — a branch name in a REV position (a range, a peel, a
//      rev-taking argv) resolves to a same-named tag first. A branch-first
//      resolver (`git::branches::branch_first_rev`) or the measured tip sha
//      (`git::branches::branch_tip_sha`) is the replacement.
//      A bound ident is judged as bindingInitializer's contract states.
//   H. merge into a checkout without the ignored-file guard — merge-ort ignores
//      --no-overwrite-ignore on 3-way merges, so checkout merges check first.
//   I. test-held update-marker branch names — process-wide root overrides
//      require holder names no other test uses.
//      A bound holder name is read as bindingInitializer's contract states.
//   J. gh exit read as absence — a GitHub read in github/ or forge/github.rs
//      that turns a non-zero gh exit into "none" (false, an empty list, a
//      default) answers a rate limit or a network failure with a false claim.
//      `forge::session::classify_gh_failure` only buckets the failure; the
//      read's own outcome fn decides absence (RateLimited/Transport are an Err,
//      and star status and the Explore README reject every failure but
//      NotFound). In the read outcome fns, an exit-0 body that won't parse is
//      an Err as well, which J doesn't scan: it reads exits only. Exempt:
//      `classify_repo_view` (github/pr.rs) keeps an unreadable repo view as
//      Unresolved, forge-status's answered "no repository" probe.
//   K. external diff drivers — diff argv carry --no-ext-diff so external tools
//      cannot replace patches or forge verdicts. An exemption requires
//      --numstat/--name-only/--name-status and every literal option after the
//      verb and before -- on KNOWN_NO_PATCH, or one of the =/attached value
//      forms the matcher accepts (bare --diff-filter M is not exempt). Each
//      member was measured beside every exempt mode, worktree and
//      --cached/--staged, under a trusted driver, git 2.51.1. Other options
//      require --no-ext-diff. --quiet can trust a driver via diff.trustExitCode,
//      diff.<driver>.trustExitCode or GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE, per
//      git's diff-options docs. --ext-diff is refused before -- in any
//      argv-shaped group; textconv remains enabled.
//      Not seen: builder chains (Command::new("git").arg("diff")...), argv
//      assembled across functions, a verb held in a variable, or an opaque
//      option beside an exempt flag (["diff", "--numstat", flag]); a leading
//      "git" program-name element, array-repeat ["diff"; N], alias verbs via
//      -c alias.x=…, and a same-named REQUESTED_ATTRS item nested inside a fn
//      (item rows match file+name). difftool is out of scope by design; a driver
//      set through GIT_EXTERNAL_DIFF in a command's env is not an argv site.
//      Only four bare owned-string forms resolve: .to_string(), .into(),
//      .to_owned() and String::from(...). Other conversions (.as_str() chains,
//      &*...to_owned(), format!, Cow::from, OsString::from, into::<String>())
//      are opaque, so a patch flag in one beside an exempt flag passes.
//      In-function growth of a literal vec via .push/.extend/.insert is not
//      tracked: let mut a = vec!["diff", "--numstat"]; a.push("-p"); passes K.
//   L. test git spawns on the product timeout — in test code (a module gated
//      `#[cfg(test)]` or `#[cfg(all(test, …))]`, or a fn gated
//      `#[cfg(test)]`), a non-test fn that passes `DEFAULT_TIMEOUT`, or a test
//      fn (closures in it included) that passes it as a direct argument of a
//      plain spawn runner (`run_git`, `run_git_raw`, their input/env variants
//      and the private `run_git_spawn`), inherits the product's 30 s spawn
//      budget, which fails fixture steps on a loaded machine;
//      `TEST_GIT_HANG_GUARD` (git/runner.rs, test builds only) is the hang
//      guard. A test fn passing it to product code under test, the
//      lock-taking, retrying or credential runner wrappers (git/runner.rs,
//      git/remote.rs) included, is not a site, and a runner-arm site takes no
//      allowlist row. A test attribute outside the code check L reads as test
//      code fails the census test (testAttrsOutsideTestCode); the other blind
//      spots print as its NOTE.
//   M. local branch ref delete outside the primitive — `branch -d/-D/--delete`
//      (or a --delete prefix such as --del) or an `update-ref` delete (-d, alone
//      or in a short cluster such as -dm) on a branch ref skips the in-use
//      guards and the old-value compare of `git::branches::delete_branch_ref_at`.
//      git permutes options, so update-ref's ref is its first operand after the
//      verb, wherever -d sits. The ref is read only when it is a string literal
//      or an inline format! template at the call, as Rust cooks it, through a
//      leading & and trailing .as_str(), .as_ref(), .clone(), .to_string() and
//      .to_owned(), and a literal also through .into() and String::from(…).
//      refs/heads/ counts in any ASCII letter case, and the exact literal HEAD
//      without --no-deref counts as a branch ref (git deletes the branch HEAD
//      names); a template is outside refs/heads/ only when its fixed lead
//      names a literal refs/<ns>/ namespace. Every other ref fails too
//      (allowlistable): a variable, field or call, whatever binds it; a
//      template whose lead names no namespace; a literal or template with an
//      escape Rust refuses or any other method chained on; an operand after a
//      `-`-led literal other than --, --no-deref, --create-reflog, --stdin or
//      a cluster of letters (--deref and -0 refuse, -Q is read past); a missing
//      operand. The check fails when it cannot find the primitive's own delete
//      in git/branches.rs. Allowlist rows are per function, so a second delete
//      in an allowlisted function is not reported. A `#[cfg(test)] fn` outside
//      a test module reads as production (reported, never missed). The branch
//      scan skips the separate value of --sort, --format, --points-at,
//      --set-upstream-to and -u only while every element before it after the
//      verb is a plain literal, a stuck --x=v, a short cluster not ending in u
//      or such a skipped pair; from the first non-literal, other bare long
//      option (--, --verbose or an abbreviation such as --so) or cluster ending
//      in u on, nothing is skipped, so an unknown option before --sort makes
//      its value read as a flag (reported), as does every value when the verb
//      is unresolved.
//      Not seen: a delete flag held in a variable or format! (["branch", &flag,
//      …]); a branch or update-ref verb, or update-ref's -d, held in a variable
//      ([verb, "-D", name]); a program element before the verb (["git",
//      "branch", "-D", name], a cmd /C git … argv); argv assembled across
//      statements or functions, or grown by .push/.extend (commit.rs
//      swap_inner, which never deletes); builder chains
//      (Command::new("git").arg(…)); a command spelled inside one string;
//      update-ref --stdin `delete` instructions (commit.rs reattach, the one
//      --stdin site, only verifies and updates); an update-ref <ref> <all-zero
//      oid>, which deletes (measured, git 2.51.1; the only all-zero value in
//      production is restore_deleted_ref's OLD value); a symbolic ref other
//      than the literal HEAD (main-worktree/HEAD) deleted without --no-deref;
//      symbolic-ref -d/--delete; renames (branch -m/-M); push . with --delete
//      <name>, :<name> or :refs/heads/x; and removing a loose ref file from
//      disk.
//
// Each check carries an ALLOWLIST of `{ file, fn, rationale }` records; check
// H's rows may add `builder: true` (the function's own argv sites are allowed,
// and every caller or reference of it must guard instead) or
// `guard: true` (`fn` wraps the guard: its calls count as guard calls, and the
// check fails unless that function's own body calls ignored_files_in_the_way).
// Checks H and K may add `item: true` (`fn` names a const/static whose
// argv-shaped value is not a git command).
// RATCHET RULE: the lists only shrink by default. Adding an entry is a
// reviewed change — it needs a rationale naming the guard that makes the
// site safe (a validator call, a trusted producer), and it lands in review
// like any other diff. A (file, fn) entry covers every site in that
// function, so entries are pruned when their site goes away rather than left
// behind to pre-authorize whatever the function grows next. The one
// exception is an entry carrying `retiring` (why its site is about to go):
// once nothing matches it, it prints a NOTE instead of failing, so a
// parallel change removing the site stays green.
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
    fn: "branch_full_ref",
    rationale:
      "validates with validate_branch_name at fn entry; the full ref is a for-each-ref pattern (the exact tip read and the deleted branch's upstream read), a show-ref --verify tip read, and update-ref's compare-and-delete and put-back target, never a refspec",
  },
  {
    file: "git/branches.rs",
    fn: "git_default_branch",
    rationale: "interpolates only the fixed literals main/master",
  },
  {
    file: "git/branches.rs",
    fn: "git_unpushed_count",
    rationale:
      "interpolates only git_default_branch's own output: a remote HEAD's target or the literals main/master",
  },
  {
    file: "git/branches.rs",
    fn: "git_branch_merge_states",
    rationale:
      "validates each pair's head/base with validate_branch_name inline",
  },
  {
    file: "git/branches.rs",
    fn: "branch_rewrite_status",
    rationale:
      "read-only `rev-list --walk-reflogs` of the branch (never a refspec); validates with validate_branch_name at fn entry",
  },
  {
    file: "git/branches.rs",
    fn: "branch_reset_to_upstream_within",
    rationale:
      "validates with validate_branch_name at fn entry; the full ref is update-ref's compare-and-swap target, never a refspec",
  },
  {
    file: "git/branches.rs",
    fn: "update_branch_from",
    rationale:
      "the fast-forward's local `fetch .` destination; validates branch and base with validate_branch_name at fn entry",
  },
  {
    file: "git/branches.rs",
    fn: "git_delete_remote_branch_core",
    rationale:
      "validates remote and name with validate_ref_name at fn entry; the full ref is the push --delete destination",
  },
  {
    file: "git/commit.rs",
    fn: "cas_ref",
    rationale:
      "validates with validate_branch_name in the Branch arm; the full ref is update-ref's compare-and-swap target, never a refspec",
  },
  {
    file: "git/ops.rs",
    fn: "fast_import_chain",
    rationale:
      "cfg(test) fast-import fixture; validates branch with validate_ref_name at fn entry, callers pass literal names",
  },
  {
    file: "git/ops.rs",
    fn: "branch_tip",
    rationale:
      "private helper reading a branch tip (never a refspec); every branch it reads is gated with validate_branch_name by its callers' entry points (merge_local_pr, finish_local_pr_merge, update_local_pr_head, finish_local_pr_update) or, for discard_local_pr_update, by update_already_landed and worktree_standing, which validate head themselves",
  },
  {
    file: "git/ops.rs",
    fn: "finalize_branch",
    rationale:
      "private helper; update_local_pr_head and finish_local_pr_update validate the target branch with validate_branch_name before calling it, and finalize_base forwards a target its own callers (merge_local_pr, finish_local_pr_merge) validated the same way",
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
    file: "git/pr_checkout.rs",
    fn: "qualified_head_ref",
    rationale:
      "validate_ref_name runs on the forge-supplied branch at fn entry, before refs/heads/<name> is built; the same validated name is the only source of the same-repo tracking refspec refs/heads/<name>:refs/remotes/<remote>/<name> (remote = a fixed lens literal); the pull/merge-request refs and the refs/gitdesktop pin are formatted from a u64 PR number (and, for the pin, the process id) only",
  },
  {
    file: "git/remote.rs",
    fn: "git_push_with_policy",
    rationale:
      "validates branch, remote and remote_branch with validate_ref_name at fn entry",
  },
  {
    file: "git/remote.rs",
    fn: "build_push_args",
    rationale:
      "the push-refspec chokepoint; its only caller (git_push_with_policy) validates every interpolated name first",
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
      "read-only `reflog exists` probe (never a refspec); the name is either git_push_with_policy's branch, validated with validate_ref_name at the arm entry, or HEAD's full `symbolic-ref` output stripped of `refs/heads/` — git's own ref name",
  },
  {
    file: "git/remote.rs",
    fn: "parse_upstream_tracking_matches_real_for_each_ref_output",
    rationale: "#[cfg(test)] fixture — the branch name is a test literal",
  },
  {
    file: "git/status.rs",
    fn: "fill_upstream_facts",
    rationale:
      "read-only for-each-ref tracking read of HEAD's branch (never a refspec); the name is git's own status branch.head, checked with validate_ref_name first",
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
    fn: "run_check_ignore_in_dir",
    rationale: "`check-ignore` read — stdout is the match list, never a report",
  },
  {
    file: "git/branches.rs",
    fn: "set_branch_archived_core",
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
    file: "git/runner.rs",
    fn: "exit_verdict",
    rationale:
      "THE stderr-only contract itself (the verdict run_git and run_git_input return) — callers whose failure rides stdout take run_git_raw and shape it with full_failure_text()",
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

// Check F. Production reads that keep git's short form on purpose, verified by
// reading each one.
const SHORT_REF_ALLOWLIST = [
  {
    file: "git/branches.rs",
    fn: "git_branches",
    rationale:
      "`%(upstream:short)` is a REV use: the UI hands it back as a rev, and the disambiguated short form resolves correctly where a stripped bare name would resolve to a same-named tag",
  },
];

// Check G. Rev positions that take a bare branch-named ident on purpose,
// verified by reading each one.
const BARE_REV_ALLOWLIST = [
  {
    file: "git/compare.rs",
    fn: "git_branch_ahead",
    rationale:
      "takes revs as given on purpose: release notes hand it TAGS, which branch_first_rev would lose to a same-named branch",
  },
  {
    file: "git/diff.rs",
    fn: "git_session_file_diff",
    rationale:
      "`base` is the agent session's base commit sha (the worktree's `rev-parse HEAD` at creation)",
  },
  {
    file: "git/diff.rs",
    fn: "git_staged_diff",
    rationale: "`base` is the fixed literal `HEAD` or `--cached`, never a name",
  },
  {
    file: "git/diff.rs",
    fn: "preview_rev_failure",
    rationale:
      "classifies a failed `git show <rev>:<path>`: `base` is that same rev minus its trailing `~`/`^` navigation suffixes, so it must resolve exactly as the read did",
  },
  {
    file: "git/history.rs",
    fn: "off_branch_commits",
    rationale:
      "`head` is the commit id head_commit resolved once, refused at fn entry unless is_full_hex_id, never a branch name",
  },
  {
    file: "git/ops.rs",
    fn: "refuse_untracked_reset_collisions",
    rationale:
      "its only production caller (git_reset_core_expecting) passes a hash validated with validate_hash",
  },
  {
    file: "git/ops.rs",
    fn: "cherry_pick_onto_with_timeouts",
    rationale:
      "`target_tip` is the tip sha the let-else after the lock and the pre-flight guards, before the picks, binds from branch_tip_sha(repo_path, target_branch), beyond the checker's binding window",
  },
  {
    file: "git/ops.rs",
    fn: "stash_file_diff_at",
    rationale:
      "`base` is the stash's own `<spec>^1` parent, never a branch name",
  },
  {
    file: "git/worktree.rs",
    fn: "git_worktree_squash",
    rationale:
      "`base` is the agent session's base commit sha (the worktree's `rev-parse HEAD` at creation)",
  },
  {
    file: "git/ops.rs",
    fn: "rewrite_commits_with_timeouts",
    rationale:
      "`base` is a commit sha, validated with validate_hash at fn entry",
  },
  {
    file: "git/ops.rs",
    fn: "rebase_edit_with_timeout",
    rationale:
      "`base` is a commit sha, validated with validate_hash at fn entry",
  },
  {
    file: "git/ops.rs",
    fn: "git_unpushed_messages",
    rationale:
      "`base` is a commit sha, validated with validate_hash at fn entry",
  },
  {
    file: "github/pr.rs",
    fn: "build_divergence_compare_path",
    rationale:
      "a forge REST compare path, not a git rev; its segments are check E's (validate_compare_branch)",
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

/** Stale entries split into those that fail and the `retiring` ones that only
 *  NOTE (see the RATCHET RULE's exception). */
export function splitStaleEntries(list, hits) {
  const stale = staleAllowlistEntries(list, hits);
  return {
    failing: stale.filter((e) => !e.retiring),
    retired: stale.filter((e) => e.retiring),
  };
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

/** The binding lookup of checks D and G, and check I's initializer read.
 *
 *  It answers with the text after the `=` of the nearest declaration of
 *  `name` above the use in text order. The walk starts on the use's line
 *  `fromIdx`, read only before the use's column `before`, so no declaration
 *  at or after the use answers; it covers that line and the 39 above it and
 *  stops at the first line FN_RE reads as a `fn` signature, a nested fn's
 *  included. A declaration is `let <name> =`, `mut` and a type annotation
 *  allowed; with `patterns` (check G) it is any `let` whose pattern names
 *  `name` before its `=`, an `if let` or `while let` included. With
 *  `masked` (the literal-blanked view of `lines`) the declaration is located
 *  there, so a string cannot spell one, and its text is read from `lines` at
 *  that offset, or from `masked` with `readMasked`, so no string can satisfy
 *  a verdict. The text runs from the `=` to the end of the first line that
 *  holds a `;` (one inside a string included), over at most five further
 *  lines, never past the use. It is more than the initializer: the rest of
 *  the `;` line, and for an `if let` or `while let` the first lines of its
 *  block, are read with it, so a call there counts for a verdict. `where`
 *  receives the declaration's line and the column of its `let`. The answer is
 *  null when no declaration is in reach (a parameter, one beyond the window
 *  or the fn line), when the declaration's line holds a second declaration of
 *  the name (on the use's own line, in the text before the use), when the
 *  code line reads no declaration at the masked offset, and when `before` is
 *  missing or `fromIdx` is past `lines`; checks D, G and I report a null.
 *
 *  It is a drift guard for ordinary code, not a scope analysis: it does not
 *  know Rust's scopes, so a nearer declaration that is not the binding in
 *  scope at the use is taken for it. Known gaps, each passing where the
 *  binding in scope would fail: a declaration in an inner block that has
 *  closed before the use; an `if let` or `while let` binding used after its
 *  block; a `for`, closure-parameter or match-arm binding that shadows it; a
 *  `let mut` reassigned before the use; `cfg`-gated alternatives, where the
 *  one nearer the use is taken; a use inside the name's own initializer,
 *  which reads that initializer; without `patterns` (check D), a pattern
 *  binding of the name (a tuple, a let-else, an `if let`), which is no
 *  declaration, so an outer plain `let` answers past it; and, with
 *  `patterns`, a struct pattern that renames a field spelled as the name
 *  (`S { <name>: other, .. }`).
 *
 *  By verdict design, not through the lookup: check G passes an initializer
 *  holding a resolver call (REV_SAFE_INIT_RE) anywhere in it, and check D
 *  passes an initializer holding `full_failure_text(` anywhere in it and
 *  judges a value or alias hop that is not a plain identifier by its own text
 *  alone, passing it unless it holds an identifier followed by `.stderr`
 *  (`output().stderr` and `run(x).await?.stderr` pass) or calls the
 *  substituting `failure_text(`.
 *
 *  Check I finds the declaration itself (the last `let <name>` before the
 *  site in the function's masked text, outside nested fns, its `;` before the
 *  site) and passes only that declaration's lines here, with
 *  `before: Infinity` (the use follows every line given). That search has
 *  the gaps above of a closed inner block, a `for`, closure-parameter or
 *  match-arm binding, a reassigned `let mut` and `cfg`-gated alternatives,
 *  and reads no pattern binding (a tuple, a let-else, an `if let`), so an
 *  earlier plain `let` answers past one.
 *
 *  scripts/checks.test.mjs pins each known gap and verdict-design pass above
 *  as a passing row; a row that starts failing means its gap closed, and this
 *  block changes with it. */
export function bindingInitializer(
  lines,
  fromIdx,
  name,
  { patterns, masked, readMasked, before, where } = {},
) {
  if (before === undefined || lines[fromIdx] === undefined) return null;
  const decl = patterns
    ? new RegExp(
        `\\blet\\s+(?:mut\\s+)?(?=[^=]*?(?<![\\w.:])${name}\\b)[^=]*?=(?!=)\\s*(.*)$`,
      )
    : new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\s*(?::[^=]*)?=\\s*(.*)$`);
  const view = masked ?? lines;
  const out = readMasked ? masked : lines;
  const upTo = (rows, j) =>
    j === fromIdx ? rows[j].slice(0, before) : rows[j];
  const last = before === Infinity ? lines.length - 1 : fromIdx;
  for (let i = fromIdx; i >= 0 && i > fromIdx - 40; i--) {
    if (FN_RE.test(lines[i])) return null;
    const row = upTo(view, i);
    const m = decl.exec(row);
    if (!m) continue;
    if (decl.test(row.slice(m.index + "let".length))) return null;
    // The masked capture skips a leading literal's blanks as whitespace, so the
    // initializer is re-read on the code line from the `let` itself.
    const at = decl.exec(upTo(lines, i).slice(m.index));
    if (at?.index !== 0) return null;
    let init = at[1];
    let text = upTo(out, i).slice(m.index + at[0].length - at[1].length);
    for (let j = i + 1; !init.includes(";") && j < i + 6 && j <= last; j++) {
      init += upTo(lines, j);
      text += upTo(out, j);
    }
    if (where) {
      where.line = i;
      where.col = m.index;
    }
    return text;
  }
  return null;
}

/** The column of offset `at` in `text`, the `before` bindingInitializer takes. */
function columnAt(text, at) {
  return at - (text.lastIndexOf("\n", at - 1) + 1);
}

/** The fix a stderr field value earns, or null when it is correctly shaped.
 *
 *  Follows a chain of bare-ident aliases (`let stderr = out.stderr; let report =
 *  stderr; … stderr: report`), because stopping after one hop lands on a value
 *  none of the shaping tests match — which reads as correctly shaped. The
 *  seen-set bounds the walk and makes a mutually-recursive pair fail closed,
 *  like every other step the checker cannot resolve. Each hop is looked up
 *  before the previous hop's declaration, the first before the field itself. */
function stderrValueVerdict(value, lines, masked, fieldIdx, fieldCol) {
  const seen = new Set();
  let at = fieldIdx;
  let before = fieldCol;
  for (let expr = value; ; ) {
    if (FULL_FAILURE_TEXT_RE.test(expr)) return null;
    if (SUBSTITUTING_RE.test(expr)) return SUBSTITUTION_FIX;
    if (STDERR_READ_RE.test(expr)) return STDERR_ONLY_FIX;
    if (!BARE_IDENT_RE.test(expr)) return null;
    if (seen.has(expr)) return UNRESOLVED_FIX;
    seen.add(expr);
    const where = {};
    const init = bindingInitializer(lines, at, expr, { masked, before, where });
    if (init === null) return UNRESOLVED_FIX;
    // Judge the WHOLE initializer. The split below truncates at the first `;`,
    // including one inside a string (`format!("a; {}", out.stderr)`), so it is
    // only ever good enough to name the next alias — never to decide a verdict.
    // The passing verdict reads the masked text, so no string can earn it.
    const shape = bindingInitializer(lines, at, expr, {
      masked,
      readMasked: true,
      before,
    });
    at = where.line;
    before = where.col;
    if (FULL_FAILURE_TEXT_RE.test(shape)) return null;
    if (SUBSTITUTING_RE.test(init)) return SUBSTITUTION_FIX;
    if (STDERR_READ_RE.test(init)) return STDERR_ONLY_FIX;
    expr = init.split(";")[0].trim();
  }
}

export function checkStderrOnlyGitError(file, _src, lines, hits) {
  const { code: codeSrc, masked } = lexRust(lines.join("\n"));
  const code = codeSrc.split("\n");
  const maskedLines = masked.split("\n");
  const spans = testModuleSpans(codeSrc);
  GIT_CTOR_RE.lastIndex = 0;
  for (let m = GIT_CTOR_RE.exec(codeSrc); m; m = GIT_CTOR_RE.exec(codeSrc)) {
    if (spans.some(([s, e]) => m.index > s && m.index < e)) continue;
    const line = codeSrc.slice(0, m.index).split("\n").length;
    const open = m.index + m[0].length - 1;
    const body = braceBody(codeSrc, open);
    const value = stderrFieldValue(body);
    if (value === null) continue;
    const field = open + 1 + stderrFieldStart(body);
    const fix = stderrValueVerdict(
      value,
      code,
      maskedLines,
      codeSrc.slice(0, field).split("\n").length - 1,
      columnAt(codeSrc, field),
    );
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

// The short-form spellings as they appear in argv/format literals. Read from the
// comment-stripped text so a doc comment naming them is not a use, and outside
// `#[cfg(test)]` modules, whose fixtures read git's output as a user would.
// `--short` counts only after `symbolic-ref` in the same argv list (or one command
// string): `rev-parse --short` abbreviates a sha and is no ref name at all.
const SHORT_REF_RE = new RegExp(
  [
    String.raw`"--abbrev-ref(?:=[^"]*)?"`,
    String.raw`%\((?:refname|upstream):short\)`,
    String.raw`"symbolic-ref"(?:\s*,\s*"[^"\n]*")*?\s*,\s*"--short"`,
    String.raw`"symbolic-ref\s[^"\n]*--short\b`,
  ].join("|"),
  "g",
);
const SHORT_REF_FIX =
  "git's short ref names disambiguate under a same-named tag or ref — read " +
  "HEAD's branch via git::branches::current_branch_name/current_branch_ref and " +
  "lists via %(refname) stripped of exactly refs/heads|remotes|tags/, or " +
  "allowlist a deliberate REV use with rationale";

export function checkShortRefNames(file, _src, lines, hits) {
  const codeSrc = lexRust(lines.join("\n")).code;
  const spans = testModuleSpans(codeSrc);
  SHORT_REF_RE.lastIndex = 0;
  for (let m = SHORT_REF_RE.exec(codeSrc); m; m = SHORT_REF_RE.exec(codeSrc)) {
    if (spans.some(([s, e]) => m.index > s && m.index < e)) continue;
    const line = codeSrc.slice(0, m.index).split("\n").length;
    const fn = enclosingFn(lines, line - 1);
    hits.push({
      file,
      line,
      fn,
      allowlisted: allowed(SHORT_REF_ALLOWLIST, file, fn),
      fix: SHORT_REF_FIX,
    });
  }
}

// A branch-typed NAME interpolated where git expects a REVISION. gitrevisions
// tries refs/tags/<x> before refs/heads/<x>, so a bare branch name in a range, a
// peel, or a rev argument resolves to a same-named tag first. Name-keyed by
// design: the idents below are the ones that carry branch names here, and an ident
// bound from a branch-first resolver (or a measured tip sha) passes. Two shapes:
// a `format!` rev template (`{x}..`, `..{x}`, `{x}^{{`, `{x}@{{`) and an argv list
// led by a rev-taking command holding the bare ident (for `fetch`, also a refspec
// template whose source is the ident). `{x}@{{upstream}}` (and
// `u`/`push`) is exempt: git looks the name up as a BRANCH there, and the
// full-ref spelling is refused outright ("no such branch", measured git 2.51.1).
// An ident right after `/` is part of a qualified path, not a bare rev.
const REV_NAME_RE = /^(?:branch|base|head|compare|target\w*)$/;
const REV_TEMPLATE_RE =
  /(?<![{/])\{(\w+)\}(?=\.\.|\^\{\{|@\{\{(?!(?:upstream|u|push)\}\}))|(?<=\.\.)\{(\w+)\}/g;
const REV_ARGV_RE =
  /\[\s*"(merge-base|rev-list|rev-parse|merge|log|diff|rebase|reset|merge-tree|show|cherry|revert|ls-tree|fetch)"/g;
const REV_SAFE_INIT_RE =
  /\b(?:branch_first_rev|local_branch_revs|(?:exact_)?branch_tip\w*)\s*\(/;
const BARE_REV_FIX =
  "a bare branch name in a rev position resolves to a same-named TAG first " +
  "(gitrevisions) — resolve it via git::branches::branch_first_rev, read the " +
  "tip sha (git::branches::branch_tip_sha), or allowlist a deliberate use with " +
  "rationale";

/** The body of the `[ … ]` opening at `openIdx`, bracket-balanced and
 *  literal-aware, so a `]` inside a string cannot end the argv list early. */
function bracketBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const lit = literalEnd(text, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth === 0)
      return text.slice(openIdx + 1, i);
  }
  return text.slice(openIdx + 1);
}

/** Top-level comma-separated elements of an argv `body`, with their offsets. */
function argvElements(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const lit = i < body.length ? literalEnd(body, i) : -1;
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const c = body[i];
    if (i === body.length || (c === "," && depth === 0)) {
      out.push({ text: body.slice(start, i), at: start });
      start = i + 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return out;
}

export function checkBareBranchRevs(file, _src, lines, hits) {
  const { code: codeSrc, masked } = lexRust(lines.join("\n"));
  const code = codeSrc.split("\n");
  const maskedLines = masked.split("\n");
  const spans = testModuleSpans(codeSrc);
  const inTest = (idx) => spans.some(([s, e]) => idx > s && idx < e);
  const report = (idx, name) => {
    const line = codeSrc.slice(0, idx).split("\n").length;
    // Read masked, so a string in or after the initializer cannot make it safe.
    const init = bindingInitializer(code, line - 1, name, {
      before: columnAt(codeSrc, idx),
      patterns: true,
      masked: maskedLines,
      readMasked: true,
    });
    if (init !== null && REV_SAFE_INIT_RE.test(init)) return;
    const fn = enclosingFn(lines, line - 1);
    hits.push({
      file,
      line,
      fn,
      allowlisted: allowed(BARE_REV_ALLOWLIST, file, fn),
      fix: BARE_REV_FIX,
    });
  };

  FORMAT_RE.lastIndex = 0;
  for (let m = FORMAT_RE.exec(codeSrc); m; m = FORMAT_RE.exec(codeSrc)) {
    if (inTest(m.index)) continue;
    REV_TEMPLATE_RE.lastIndex = 0;
    for (
      let t = REV_TEMPLATE_RE.exec(m[1]);
      t;
      t = REV_TEMPLATE_RE.exec(m[1])
    ) {
      const name = t[1] ?? t[2];
      if (REV_NAME_RE.test(name)) report(m.index, name);
    }
  }

  REV_ARGV_RE.lastIndex = 0;
  for (let m = REV_ARGV_RE.exec(codeSrc); m; m = REV_ARGV_RE.exec(codeSrc)) {
    if (inTest(m.index)) continue;
    const open = m.index;
    for (const el of argvElements(bracketBody(codeSrc, open))) {
      const bare = /^\s*&?\s*(\w+)\s*$/.exec(el.text);
      if (bare && REV_NAME_RE.test(bare[1])) {
        report(open + 1 + el.at + el.text.indexOf(bare[1]), bare[1]);
        continue;
      }
      // A fetch refspec's SOURCE resolves tag-first too (measured); its bare
      // destination is redirected under refs/heads/ by git, so only `{x}:` counts.
      if (m[1] !== "fetch") continue;
      const tmpl = /^\s*&?\s*format!\s*\(\s*"((?:[^"\\]|\\.)*)"/.exec(el.text);
      const src = tmpl && /(?<![{/])\{(\w+)\}:/.exec(tmpl[1]);
      if (src && REV_NAME_RE.test(src[1])) {
        report(open + 1 + el.at + el.text.indexOf("format!"), src[1]);
      }
    }
  }
}

// ----------------------------------------------------------------- rust lexer

const WORD = /[\p{ID_Continue}]/u;

/** A Rust source's two scan views, each exactly the input's length with every
 *  newline kept, so offsets and line numbers carry across both. `code` blanks
 *  comments (line, block, and NESTED block) and keeps literals; `masked` also
 *  blanks every literal (strings across lines and escapes, raw `r#"…"#`, byte
 *  and C strings, char literals) and lifetime ticks. A line-based stripper is
 *  not enough: a `/*` on a multi-line string's continuation line opens a
 *  comment that never closes, blanking the rest of the file — a pass on all of
 *  it — and a lifetime read as an open quote revives the comment after it.
 *  `unterminated` is the offset of a literal or comment that runs off the end
 *  (everything after it is unreadable), or -1. Callers only read the views,
 *  so checks D, F, G, H, I, J, K, L and M share one lexing of each file. */
let lexed = { text: null, views: null };
export function lexRust(text) {
  if (lexed.text === text) return lexed.views;
  const code = text.split("");
  const masked = text.split("");
  let unterminated = -1;
  const blank = (view, from, to) => {
    for (let k = from; k < to; k++) if (text[k] !== "\n") view[k] = " ";
  };
  const runsOff = (from) => {
    if (unterminated < 0) unterminated = from;
    return text.length;
  };
  // Past the closing quote of the escape-aware string opening at `open`.
  const quoted = (open) => {
    for (let j = open + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === '"') return j + 1;
    }
    return runsOff(open);
  };
  // Past a char literal's closing quote, or -1 when the tick opens a lifetime
  // or label (`'a`, `'_`, `'static`, `'outer:`).
  const charEnd = (open) => {
    const escaped = /^'\\(?:u\{[0-9a-fA-F_]*\}|x[0-9a-fA-F]{2}|[\s\S])'/.exec(
      text.slice(open, open + 16),
    );
    if (escaped) return open + escaped[0].length;
    const point = text.codePointAt(open + 1);
    if (point === undefined || text[open + 1] === "'") return -1;
    const width = point > 0xffff ? 2 : 1;
    return text[open + 1 + width] === "'" ? open + 2 + width : -1;
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl;
      blank(code, i, end);
      blank(masked, i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          j += 2;
          if (--depth === 0) break;
        } else j++;
      }
      if (depth > 0) runsOff(i);
      blank(code, i, j);
      blank(masked, i, j);
      i = j;
    } else if (c === '"') {
      const end = quoted(i);
      blank(masked, i, end);
      i = end;
    } else if (c === "'") {
      const end = charEnd(i);
      if (end < 0) {
        masked[i] = " ";
        i++;
      } else {
        blank(masked, i, end);
        i = end;
      }
    } else if (WORD.test(c)) {
      // Literal prefixes are only prefixes at a token start, which this is.
      const raw = /^(?:b|c)?r(#*)"/.exec(text.slice(i, i + 260));
      let end = -1;
      if (raw) {
        const close = `"${raw[1]}`;
        const at = text.indexOf(close, i + raw[0].length);
        end = at < 0 ? runsOff(i) : at + close.length;
      } else if ((c === "b" || c === "c") && text[i + 1] === '"') {
        end = quoted(i + 1);
      } else if (c === "b" && text[i + 1] === "'") {
        end = charEnd(i + 1);
      }
      if (end > 0) {
        blank(masked, i, end);
        i = end;
      } else {
        while (i < text.length && WORD.test(text[i])) i++;
      }
    } else i++;
  }
  const views = { code: code.join(""), masked: masked.join(""), unterminated };
  lexed = { text, views };
  return views;
}

/** `[start, end]` offsets of every `use` declaration in a masked view, shared
 *  by checks H and L. The keyword only: `r#use` and a longer identifier ending
 *  in `use` are bindings, and `\b` alone would read `let r#use = …;` as an
 *  import. `use{…}` with no space is not matched, so its names read as code. */
function useDeclarationSpans(masked) {
  return [...masked.matchAll(/(?<![\p{ID_Continue}#])use\s[^;]*;/gu)].map(
    (m) => [m.index, m.index + m[0].length],
  );
}

// ------------------------------------------------------------------- check H

// Rows key on (file, fn) like every other list, with two extensions. A
// `builder` row allowlists the argv sites inside that function and turns every
// MENTION of its name (a call, or a function reference like `.map(f)`) into a
// site that must be guarded where it sits. An `item` row names a const/static
// whose argv-shaped value is not a git command line; every other const argv is
// checked at each in-file use, and at its definition when `pub` or unused. A
// `guard` row names a wrapper around ignored_files_in_the_way: a call to it
// counts as a guard call anywhere (never as a `.name(` method call), and the
// row is verified: its function must exist in `file`, and every same-named
// `fn` in any scanned file must call ignored_files_in_the_way itself.
//
// Known false positives, each remedied by a reviewed row rather than a parser:
// a non-argv list led by "merge"/"pull", or by a label that may be one
// (`for op in ["merge", …]`, `[…].contains(x)`, `[op, "in progress"].join(" ")`
// with `op` chosen by if/else) — an `item` or fn row; a non-git receiver
// taking the word (`PathBuf::push("merge")`, `path_segments_mut().push(…)`,
// `Arg::new("merge")`); safe ff-only shapes outside one array literal (a
// `.args([…])` chain, error text naming --overwrite-ignore, `-c merge.ff=only`);
// `#[cfg(any(test, …))]` items and `#![cfg(test)]` files, scanned as
// production; a const TABLE of argvs, whose inner arrays report `<unresolved>`;
// a closure parameter shadowing an outer `let` of the verb's name; a union of
// two control flags (`if a { "--abort" } else { "--quit" }`), which grants no
// exemption; an integer-keyed map's `insert(0, "merge")`; `insert(1, "--ff")`
// on an argv, modelled as an append; a merge/pull-led literal spliced in after
// another verb (`vec!["log"]` then `.extend(["merge", x])`), a site by design.
export const MERGE_GUARD_ALLOWLIST = [
  {
    file: "forge/gitlab.rs",
    fn: "MERGE_METHODS",
    item: true,
    rationale:
      "GitLab merge-method names an MR input is validated against, never a git argv",
  },
  {
    file: "git/branches.rs",
    fn: "verify_pin_and_merge",
    rationale: "fresh gd-update checkout, with no user's ignored files",
  },
  {
    file: "git/ops.rs",
    fn: "merge_local_pr",
    rationale: "fresh resolve worktree, with no user's ignored files",
  },
  {
    file: "git/ops.rs",
    fn: "update_local_pr_head",
    rationale: "fresh resolve worktree, with no user's ignored files",
  },
  {
    file: "git/ops.rs",
    fn: "merge_remote_pr",
    rationale: "fresh resolve worktree, with no user's ignored files",
  },
  {
    file: "git/pull_guard.rs",
    fn: "plain_merge_argv",
    builder: true,
    rationale:
      "argv builder; merge_pinned and merge_pinned_autostash run the guard",
  },
];

const MERGE_GUARD_FIX =
  "merge/pull into a checkout must call ignored_files_in_the_way under its " +
  "working-tree hold before writing. Scope is the FUNCTION, with no dominance " +
  "check: a guard call anywhere in it covers every merge in it, so a merge " +
  "added to an already-guarded function passes, and an allowlisted (file, fn) " +
  "pre-authorizes any merge that function grows";

/** What check H cannot see, printed with its verdict so a green run is read for
 *  what it covers. */
export const MERGE_GUARD_NOTE =
  "Not seen: a verb or leading global option held in a parameter, a function " +
  "result, another file's const, or a variable reassigned after its `let`; a " +
  "verb shadowed inside a nested block or fn before an outer use; an if/match " +
  "arm that is neither a value nor a diverging return/panic; a verb handed to " +
  "a helper as its own argument rather than inside the argv; argv assembled " +
  "across functions or by iterator adapters (`once`, `chain` over non-literal " +
  "parts), VecDeque push_front/push_back, an insert at a VARIABLE index on a " +
  "receiver not seen starting argv-shaped (a literal non-zero index is " +
  "modelled as an append), extend(Some(…)), index assignment (`a[0] = …`), " +
  "a reassignment whose value re-reads the receiver " +
  "(`a = [a.as_slice(), …].concat()`), smallvec!, or a " +
  'labeled-break array; verb spellings `&"merge"[..]`, from_str/from_bytes, ' +
  "stringify!, format! with arguments, `as &str`, Into::into, a `{ … }` block, " +
  "tuple destructuring; argv split out of one string or built by concat! or a " +
  "macro_rules! expansion; a merge option's VALUE (-m, -F, -s, -X, " +
  "--into-name) spelling --no-overwrite-ignore or a control op; an " +
  "--overwrite-ignore, --ff or --no-ff held in a variable the resolver cannot " +
  "read, or an opaque single push/arg after --ff-only; a long option " +
  "abbreviated (`--overwrite-ignor`, `--ff-onl`); a builder " +
  "re-exported under another name and called from a third file; git run " +
  "through a shell command string";

// git's global options that take their value as the NEXT element (git.c
// handle_options, git 2.51.1); every other leading `-…` element is a flag or
// carries its value after `=`.
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--attr-source",
  "--shallow-file",
]);
const CONTROL_FLAGS = ["--abort", "--continue", "--quit"];
const OVERWRITE_IGNORE_RE = /(?<![\w-])--overwrite-ignore(?![\w-])/;
// Words after which a `[` opens an array rather than indexing. Not `let`: a
// `[` after `let`, `if let` or `while let` is always a slice pattern.
const EXPR_KEYWORDS = new Set([
  "box",
  "break",
  "else",
  "if",
  "in",
  "match",
  "move",
  "mut",
  "return",
  "while",
  "yield",
]);
// A keyword TOKEN followed by `tail`: never a raw identifier (`r#let`) or
// part of a longer name, since only the keyword introduces a pattern.
const keywordRe = (word, tail = "") =>
  new RegExp(
    String.raw`(?<![#\p{ID_Continue}])${word}(?!\p{ID_Continue})${tail}`,
    "gu",
  );
// A character a keyword token never follows: a raw identifier's `#` or a
// name's own character.
const BEFORE_NAME_RE = /[#\p{ID_Continue}]/u;

/** The string a Rust literal token spells, or undefined when `t` is not
 *  exactly one string literal or holds a `\u` escape that names no character
 *  (Rust refuses it). A line continuation skips what rustc skips: spaces,
 *  tabs, CR and LF. */
function literalValue(t) {
  const raw = /^(?:b|c)?r(#*)"([\s\S]*)"\1$/.exec(t);
  if (raw) return raw[2].includes(`"${raw[1]}`) ? undefined : raw[2];
  const str = /^(?:b|c)?"((?:[^"\\]|\\[\s\S])*)"$/.exec(t);
  if (!str) return undefined;
  const simple = { n: "\n", t: "\t", r: "\r", 0: "\0" };
  let cooks = true;
  const value = str[1].replace(
    /\\(?:\n[ \t\r\n]*|u\{([0-9a-fA-F_]+)\}|x([0-9a-fA-F]{2})|([\s\S]))/g,
    (_, u, x, ch) => {
      if (u) {
        const digits = u.replace(/_/g, "");
        const code = Number.parseInt(digits, 16);
        if (
          u.startsWith("_") ||
          digits.length > 6 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          cooks = false;
          return "";
        }
        return String.fromCodePoint(code);
      }
      if (x) return String.fromCharCode(Number.parseInt(x, 16));
      if (ch === "u") cooks = false;
      return ch === undefined ? "" : (simple[ch] ?? ch);
    },
  );
  return cooks ? value : undefined;
}

// The template token of a `format!` call leading a text, as written.
const FORMAT_TOKEN_RE =
  /^format\s*!\s*[([{]\s*((?:b|c)?r(#*)"[\s\S]*?"\2|"(?:[^"\\]|\\[\s\S])*")/;
/** The template of the `format!` call leading `t` as Rust reads it (escapes
 *  and line continuations cooked, a raw string verbatim): undefined when `t`
 *  does not lead with one, null when its token does not cook. */
function formatTemplate(t) {
  const token = FORMAT_TOKEN_RE.exec(t)?.[1];
  if (token === undefined) return undefined;
  return literalValue(token) ?? null;
}

// A block body's tail expression (its value, "" when it ends in `;`) and its
// last top-level statement.
function blockTail(text) {
  let depth = 0;
  const cuts = [0];
  for (let i = 0; i < text.length; i++) {
    const lit = literalEnd(text, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i])) depth--;
    else if (depth === 0 && text[i] === ";") cuts.push(i + 1);
  }
  const from = cuts.at(-1);
  return {
    tail: text.slice(from).trim(),
    last: text.slice(cuts.at(-2) ?? 0, from - 1).trim(),
  };
}

// Index of the first `{` outside brackets in `t` from `from`, skipping literals.
function openBrace(t, from) {
  let depth = 0;
  for (let i = from; i < t.length; i++) {
    const lit = literalEnd(t, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if ("([".includes(t[i])) depth++;
    else if (")]".includes(t[i])) depth--;
    else if (t[i] === "{" && depth === 0) return i;
  }
  return -1;
}

/** Each arm's expression text in a `match` body. */
function matchArms(body) {
  const arms = [];
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
    else if (depth === 0 && c === "=" && body[i + 1] === ">") {
      let j = i + 2;
      while (j < body.length && /\s/.test(body[j])) j++;
      let end = j;
      if (body[j] === "{") end = j + braceBody(body, j).length + 2;
      else {
        for (let d = 0; end < body.length; end++) {
          const l = literalEnd(body, end);
          if (l >= 0) end = l;
          else if ("([{".includes(body[end])) d++;
          else if (")]}".includes(body[end])) d--;
          else if (d === 0 && body[end] === ",") break;
        }
      }
      arms.push(body.slice(j, end));
      i = end;
    }
  }
  return arms;
}

// Thrown through a resolution that ran past check H's hop cap.
const CAPPED = Symbol("resolution capped");

const DIVERGES_RE =
  /^(?:return\b|break\b|continue\b|(?:panic|unreachable|todo|unimplemented)\s*!)/;

/** An if/else or match arm's possible values: [] for an arm that diverges,
 *  including a block whose last statement does (`{ log(); return Ok(()); }`). */
function armValues(text, resolve) {
  let t = text.trim();
  if (t.startsWith("{")) {
    const body = braceBody(t, 0);
    if (t.slice(body.length + 2).trim() !== "") return undefined;
    const { tail, last } = blockTail(body);
    if (tail === "") return DIVERGES_RE.test(last) ? [] : undefined;
    t = tail;
  }
  return DIVERGES_RE.test(t) ? [] : argValues(t, resolve);
}

/** The union of an `if`/`else` or `match` expression's arm values when every
 *  arm resolves, undefined when one does not, null when `t` is neither. */
function branchValues(t, resolve) {
  const head = /^(if|match)\b/.exec(t);
  if (!head) return null;
  const open = openBrace(t, head[0].length);
  if (open < 0) return undefined;
  const body = braceBody(t, open);
  const rest = t.slice(open + body.length + 2).trim();
  let arms;
  if (head[1] === "match") {
    if (rest !== "") return undefined;
    arms = matchArms(body).map((arm) => armValues(arm, resolve));
  } else {
    const otherwise = /^else\b\s*/.exec(rest);
    if (!otherwise) return undefined;
    const tail = rest.slice(otherwise[0].length);
    const other = tail.startsWith("{")
      ? armValues(tail, resolve)
      : (branchValues(tail, resolve) ?? undefined);
    arms = [armValues(`{${body}}`, resolve), other];
  }
  if (arms.length === 0 || arms.some((arm) => arm === undefined))
    return undefined;
  return [...new Set(arms.flat())];
}

/** The strings an argv element expression can evaluate to, as far as the text
 *  shows: a literal through borrows, zero-argument conversions (`.to_owned()`,
 *  `.into()`), `…::from` / `…::new` / `Cow` wrappers and a placeholder-free
 *  `format!`; the union of an if/else or match whose arms all resolve; or a
 *  name through `resolve`. A `format!` with placeholders keeps its template
 *  only when option-shaped (`--git-dir={dir}`). undefined = opaque. */
function argValues(text, resolve) {
  let t = text.trim();
  for (;;) {
    const before = t;
    t = t.replace(/^(?:&\s*(?:mut\s+)?|\*\s*)/, "").trim();
    const call =
      /^([\s\S]*?)\s*\.\s*[A-Za-z_]\w*\s*(?:::\s*<[^()]*>\s*)?\(\s*\)$/.exec(
        t,
      ) ??
      /^(?:[A-Za-z_]\w*\s*::\s*)*(?:from|new|Borrowed|Owned)\s*\(([\s\S]*)\)$/.exec(
        t,
      ) ??
      /^\(([\s\S]*)\)$/.exec(t);
    if (call) t = call[1].trim();
    if (t === before) break;
  }
  const branches = branchValues(t, resolve);
  if (branches !== null) return branches;
  const template = formatTemplate(t);
  if (template === null) return undefined;
  if (template !== undefined) {
    if (!template.replace(/\{\{|\}\}/g, "").includes("{"))
      return [template.replace(/\{\{/g, "{").replace(/\}\}/g, "}")];
    return template.startsWith("-") ? [template] : undefined;
  }
  const literal = literalValue(t);
  if (literal !== undefined) return [literal];
  const path = /^(?:(?:[A-Za-z_]\w*|<[^<>]*>)\s*::\s*)*([A-Za-z_]\w*)$/.exec(t);
  return path ? resolve(path[1]) : undefined;
}

/** Index of the argv VERB in `elements`: the first element past git's leading
 *  global options, or null when that slot is opaque (a variable, a call).
 *  Opaque splices (`.args(prefix)`) are passed over as options-only; an
 *  element that may be a non-option (one arm of an if) is the verb slot. */
function argvVerb(elements) {
  for (let k = 0; k < elements.length; k++) {
    const el = elements[k];
    if (el.opaque) continue;
    if (el.values === undefined) return null;
    if (!el.values.every((v) => v.startsWith("-"))) return k;
    if (el.values.some((v) => GIT_VALUE_OPTIONS.has(v))) k++;
  }
  return null;
}

// An element's one possible value, or undefined. Exemptions are granted only
// by a definite flag; anything that may void one counts on any arm.
const definite = (el) =>
  !el.opaque && el.values?.length === 1 ? el.values[0] : undefined;

/** Start of the postfix expression (`args`, `self.cmd`, `Command::new("git")`,
 *  `f(x).y`) that ends just before `end` in `masked`. */
function exprStart(masked, end) {
  let p = end;
  for (;;) {
    let q = p - 1;
    while (q >= 0 && /\s/.test(masked[q])) q--;
    if (q < 0) return p;
    if (masked[q] === ")" || masked[q] === "]") {
      let depth = 0;
      for (; q >= 0; q--) {
        if (")]}".includes(masked[q])) depth++;
        else if ("([{".includes(masked[q]) && --depth === 0) break;
      }
      if (q < 0) return p;
      p = q;
      continue;
    }
    if (!WORD.test(masked[q])) return p;
    while (q >= 0 && WORD.test(masked[q])) q--;
    p = q + 1;
    let r = q;
    while (r >= 0 && /\s/.test(masked[r])) r--;
    if (masked[r] === ".") p = r;
    else if (masked[r] === ":" && masked[r - 1] === ":") p = r - 1;
    else return p;
  }
}

/** Every `fn` with a body: name, signature start and brace span. */
function rustFunctions(masked) {
  const functions = [];
  const signature = /\bfn\s+(\w+)/g;
  for (let m = signature.exec(masked); m; m = signature.exec(masked)) {
    let depth = 0;
    let open = -1;
    for (let i = m.index + m[0].length; i < masked.length; i++) {
      const char = masked[i];
      if (depth === 0 && char === ";") break;
      if (depth === 0 && char === "{") {
        open = i;
        break;
      }
      if ("([".includes(char)) depth++;
      else if (")]".includes(char)) depth--;
    }
    if (open < 0) continue;
    const close = open + 1 + braceBody(masked, open).length;
    functions.push({ name: m[1], start: m.index, open, close });
  }
  return functions;
}

// An argv is any SEQUENCE of elements that can reach git: an array literal
// (`[…]`, `&[…]`, `vec!` with any delimiter) wherever it sits, or a receiver's
// elements in source order — its `let`/assignment initializer, then each
// `.push`/`.insert`/`.extend`/`.extend_from_slice`/`.arg`/`.args`. The verb is
// the first element past git's global options; a `merge`/`pull` verb makes a
// site. Control-op flags exempt only from inside the verb's own UNIT (its
// literal or its one chained call expression), since a separate push may be
// conditional; the ff-only pair exempts only from inside the verb's literal.
// Every pass can only ADD sites (fail closed): each literal alone, each
// receiver's whole fold, and each receiver event against just the elements
// that dominate it.
export function checkMergeIgnoredGuard(
  file,
  _src,
  lines,
  hits,
  allowlist = MERGE_GUARD_ALLOWLIST,
) {
  const { code, masked, unterminated } = lexRust(lines.join("\n"));
  if (unterminated >= 0) {
    hits.push({
      file,
      line: code.slice(0, unterminated).split("\n").length,
      fn: "<unreadable>",
      allowlisted: false,
      fix: "a literal or comment opening here never closes, so the rest of the file is unreadable to this check — fix the source, or the lexer in scripts/check-rust-invariants.mjs",
    });
  }
  const tests = testModuleSpans(masked);
  const inTest = (at) => tests.some(([s, e]) => at > s && at < e);
  const functions = rustFunctions(masked);
  const innermost = (at) =>
    functions.filter((fn) => at > fn.open && at < fn.close).at(-1);
  const fnKey = (at) => functions.indexOf(innermost(at));
  const lineOf = (at) => code.slice(0, at).split("\n").length;
  const useSpans = useDeclarationSpans(masked);
  const inUse = (at) => useSpans.some(([s, e]) => at >= s && at < e);

  // A function's own text, nested functions blanked: another operation's guard
  // is not a check in its caller.
  const ownBody = (fn) => {
    let body = masked.slice(fn.open + 1, fn.close);
    for (const nested of functions) {
      if (nested.start <= fn.open || nested.close >= fn.close) continue;
      const start = nested.start - fn.open - 1;
      const end = nested.close - fn.open;
      body = body.slice(0, start) + " ".repeat(end - start) + body.slice(end);
    }
    return body;
  };
  const rowAllowed = (name, item) =>
    allowlist.some(
      (e) =>
        e.file === file &&
        e.fn === name &&
        Boolean(e.item) === item &&
        !e.guard,
    );
  const guardRows = allowlist.filter((e) => e.guard);
  // A wrapper counts as a call, never as a `.name(` method of the same name.
  const wrappers = guardRows.map((e) => e.fn).join("|") || "(?!)";
  const guardCall = new RegExp(
    String.raw`(?:\bignored_files_in_the_way|(?<!\.\s*)\b(?:${wrappers}))\s*\(`,
  );
  const push = (at, fn, allowlisted) =>
    hits.push({
      file,
      line: lineOf(at),
      fn,
      allowlisted,
      fix: MERGE_GUARD_FIX,
    });
  // One site is judged once, whichever of the overlapping passes reaches it.
  const recorded = new Set();
  const record = (at, builder = false) => {
    if (recorded.has(at)) return;
    recorded.add(at);
    if (inTest(at)) return;
    const fn = innermost(at);
    if (fn && guardCall.test(ownBody(fn))) return;
    const name = fn?.name ?? "<unresolved>";
    push(at, name, !builder && rowAllowed(name, false));
  };
  // Every `fn` a guard row names, in any file, must run the real guard in its
  // own body. In the row's file a missing one leaves the row stale, which
  // main() fails; elsewhere only a hollow namesake is reported.
  for (const row of guardRows) {
    for (const fn of functions.filter((f) => f.name === row.fn)) {
      const real = /\bignored_files_in_the_way\s*\(/.test(ownBody(fn));
      if (real && row.file !== file) continue;
      hits.push({
        file,
        line: lineOf(fn.start),
        fn: row.fn,
        allowlisted: real,
        fix: real
          ? MERGE_GUARD_FIX
          : "a `guard: true` row names this function, but its own body never calls ignored_files_in_the_way — call it there, or drop the row",
      });
    }
  }
  const overwritesIgnored = (at) => {
    const fn = innermost(at);
    return OVERWRITE_IGNORE_RE.test(fn ? code.slice(fn.open, fn.close) : code);
  };

  // const/static items, anchored at a statement start so the `static` of a
  // `&'static str` annotation is never read as one.
  const items = [];
  const consts = new Map();
  const itemRe =
    /\b(?:const|static)\s+(?:mut\s+|ref\s+)?([A-Za-z_]\w*)\s*:(?!:)/g;
  for (let m = itemRe.exec(masked); m; m = itemRe.exec(masked)) {
    const lead = masked.slice(Math.max(0, m.index - 40), m.index);
    const vis = /pub(?:\s*\([^)]*\))?\s+$/.exec(lead);
    const start = vis ? m.index - vis[0].length : m.index;
    let p = start - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (p >= 0 && !";{}]".includes(masked[p])) continue;
    let depth = 0;
    let eq = -1;
    let semi = -1;
    for (let k = m.index + m[0].length; k < masked.length; k++) {
      const ch = masked[k];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (--depth < 0) break;
      } else if (depth === 0 && ch === ";") {
        semi = k;
        break;
      } else if (
        depth === 0 &&
        eq < 0 &&
        ch === "=" &&
        !"=>".includes(masked[k + 1]) &&
        !"=<>!".includes(masked[k - 1])
      )
        eq = k;
    }
    if (eq < 0 || semi < 0) continue;
    items.push({
      name: m[1],
      pub: Boolean(vis),
      at: m.index,
      start,
      eq,
      end: semi,
    });
    consts.set(m[1], { text: code.slice(eq + 1, semi), at: start });
  }

  // A name's value at `pos`: the nearest `let` of it before `pos` in the same
  // function, else an in-file const. A name inside an initializer resolves from
  // that `let`'s own position, so `let v = v.clone();` reaches the earlier `v`.
  // Memoized per (name, position) and seeded unresolved while in progress, so
  // a cycle or a re-visited arm costs O(1) instead of an exponential walk.
  // Past MAX_HOPS the element is UNREADABLE and reported, never passed.
  const MAX_HOPS = 512;
  const memo = new Map();
  const capped = new Set();
  const resolveName = (name, pos, hops) => {
    const key = `${name}@${pos}`;
    if (memo.get(key) === CAPPED) throw CAPPED;
    if (memo.has(key)) return memo.get(key);
    if (hops > MAX_HOPS) {
      memo.set(key, CAPPED);
      throw CAPPED;
    }
    memo.set(key, undefined);
    try {
      const value = lookupName(name, pos, hops);
      memo.set(key, value);
      return value;
    } catch (e) {
      if (e === CAPPED) memo.set(key, CAPPED);
      throw e;
    }
  };
  const lookupName = (name, pos, hops) => {
    const fn = innermost(pos);
    if (fn) {
      const letRe = new RegExp(
        String.raw`\blet\s+(?:mut\s+)?${name}\s*(?::[^=;]*)?=(?![=>])`,
        "g",
      );
      letRe.lastIndex = fn.open;
      let last;
      let lastEnd = -1;
      for (
        let m = letRe.exec(masked);
        m && m.index < pos;
        m = letRe.exec(masked)
      ) {
        // The initializer runs to the `;` at bracket depth 0: an if/match arm
        // block may hold statements of its own.
        let depth = 0;
        let end = m.index + m[0].length;
        for (; end < pos; end++) {
          if ("([{".includes(masked[end])) depth++;
          else if (")]}".includes(masked[end])) depth--;
          else if (depth === 0 && masked[end] === ";") break;
        }
        if (end < pos) [last, lastEnd] = [m, end];
      }
      if (last) {
        const from = last.index + last[0].length;
        return argValues(code.slice(from, lastEnd), (n) =>
          resolveName(n, last.index, hops + 1),
        );
      }
    }
    const item = consts.get(name);
    return item
      ? argValues(item.text, (n) => resolveName(n, item.at, hops + 1))
      : undefined;
  };
  const resolverAt = (at) => (name) => {
    try {
      return resolveName(name, at, 0);
    } catch (e) {
      if (e !== CAPPED) throw e;
      capped.add(at);
      return undefined;
    }
  };
  // Split on the masked view (a literal's comma is no separator), read on the
  // code view (where the literal still is).
  const elementsOf = (open, close) =>
    argvElements(masked.slice(open + 1, close))
      .map((el) => {
        const from = open + 1 + el.at;
        const text = code.slice(from, from + el.text.length);
        const at = from + text.length - text.trimStart().length;
        return { at, text };
      })
      .filter((el) => el.text.trim() !== "")
      .map(({ at, text }) => ({
        at,
        values: argValues(text, resolverAt(at)),
      }));

  // Bracket structure, shared by the pattern spans and dominance: each
  // position's innermost enclosing group (a close's own open, for a close),
  // each group's close, and the top-level `=>` of each match body.
  const inner = new Int32Array(masked.length).fill(-1);
  const closeOf = new Map();
  const stack = [];
  for (let i = 0; i < masked.length; i++) {
    inner[i] = stack.length ? stack[stack.length - 1] : -1;
    if ("([{".includes(masked[i])) stack.push(i);
    else if (")]}".includes(masked[i]) && stack.length)
      closeOf.set(stack.pop(), i);
  }
  const arrows = new Map();
  for (const m of masked.matchAll(keywordRe("match"))) {
    let depth = 0;
    for (let i = m.index + 5; i < masked.length; i++) {
      const ch = masked[i];
      if ("([".includes(ch)) depth++;
      else if (")]".includes(ch)) depth--;
      else if (ch === "{" && depth === 0) {
        arrows.set(i, []);
        break;
      } else if (ch === ";" || ch === "}") break;
    }
  }
  for (const m of masked.matchAll(/=>/g))
    arrows.get(inner[m.index])?.push(m.index);

  // A `[` is a slice pattern only by POSITION, inside a span a pattern
  // introducer opens: a `let` up to its first `=` (or `;`), a match arm or
  // `matches!` pattern up to its guard `if`, a closure's `|…|` and a fn's
  // `(…)` parameters. A `[` anywhere else is an expression, and an
  // unrecognized pattern spelling stays a site: fail closed.
  const patternSpans = [];
  const isPattern = (open) =>
    patternSpans.some(([s, e]) => open >= s && open < e);
  // Where a pattern in [start, end) of `group` ends: its first guard `if`.
  const guardEnd = (start, end, group) => {
    for (let p = start; p < end; p++) {
      if (
        inner[p] === group &&
        masked.startsWith("if", p) &&
        !BEFORE_NAME_RE.test(masked[p - 1] ?? "") &&
        !WORD.test(masked[p + 2] ?? "")
      )
        return p;
    }
    return end;
  };
  for (const m of masked.matchAll(keywordRe("let"))) {
    const group = inner[m.index];
    let end = m.index + 3;
    while (
      end < masked.length &&
      !(inner[end] === group && "=;)]}".includes(masked[end]))
    )
      end++;
    patternSpans.push([m.index, end]);
  }
  for (const [body, list] of arrows) {
    let from = body + 1;
    for (const arrow of list) {
      let start = from;
      for (let p = from; p < arrow; p++) {
        if (masked[p] === "," && inner[p] === body) start = p + 1;
        else if (masked[p] === "}" && inner[inner[p]] === body) start = p + 1;
      }
      patternSpans.push([start, guardEnd(start, arrow, body)]);
      from = arrow + 2;
    }
  }
  // A macro NAME, not a keyword: `r#matches!` invokes the same macro.
  for (const m of masked.matchAll(
    keywordRe("(?:r#)?(?:assert_)?matches", String.raw`\s*!\s*\(`),
  )) {
    const open = m.index + m[0].length - 1;
    const pattern = argvElements(bracketBody(masked, open))[1];
    if (!pattern) continue;
    const start = open + 1 + pattern.at;
    patternSpans.push([
      start,
      guardEnd(start, start + pattern.text.length, open),
    ]);
  }
  for (const m of masked.matchAll(
    keywordRe("fn", String.raw`\s+[A-Za-z_]\w*\s*`),
  )) {
    let p = m.index + m[0].length;
    if (masked[p] === "<") {
      for (let depth = 0; p < masked.length; p++) {
        if (masked[p] === "<") depth++;
        else if (masked[p] === ">" && masked[p - 1] !== "-" && --depth === 0)
          break;
      }
      p++;
      while (p < masked.length && /\s/.test(masked[p])) p++;
    }
    if (masked[p] === "(") patternSpans.push([p, closeOf.get(p) ?? p]);
  }
  // A closure opens where an expression can start, so never after a name, a
  // literal, a close or `?`, and never inside a pattern (an or-pattern's
  // leading `|`); its list ends at the next `|` of its own group, and a `=`
  // or `;` there first means it was no parameter list.
  const CLOSURE_KEYWORDS = new Set([
    "async",
    "break",
    "move",
    "return",
    "yield",
  ]);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "|") continue;
    if (masked[i + 1] === "|" || masked[i + 1] === "=") {
      i++;
      continue;
    }
    if (isPattern(i)) continue;
    let q = i - 1;
    while (q >= 0 && /\s/.test(code[q])) q--;
    if (q >= 0 && ")]}?\"'#".includes(code[q])) continue;
    if (q >= 0 && WORD.test(code[q])) {
      let w = q;
      while (w >= 0 && WORD.test(code[w])) w--;
      if (
        BEFORE_NAME_RE.test(code[w] ?? "") ||
        !CLOSURE_KEYWORDS.has(code.slice(w + 1, q + 1))
      )
        continue;
    }
    const group = inner[i];
    let j = i + 1;
    while (
      j < masked.length &&
      !(inner[j] === group && "|=;)]}".includes(masked[j]))
    )
      j++;
    if (masked[j] !== "|") continue;
    patternSpans.push([i, j]);
    i = j;
  }

  // Array-literal units: every `[` that is not an attribute or an index.
  const units = [];
  const unitByOpen = new Map();
  const addUnit = (open) => {
    if (isPattern(open)) return;
    const close = open + 1 + bracketBody(masked, open).length;
    const unit = { at: open, literal: true, elements: elementsOf(open, close) };
    for (const el of unit.elements) el.unit = unit;
    units.push(unit);
    unitByOpen.set(open, unit);
  };
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "[") continue;
    let p = i - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    const prev = masked[p];
    let q = p - 1;
    if (prev === "!") while (q >= 0 && /\s/.test(masked[q])) q--;
    if (prev === "#" || (prev === "!" && masked[q] === "#")) continue;
    if (prev === ")" || prev === "]" || prev === "?") continue;
    if (prev !== undefined && WORD.test(prev)) {
      while (q >= 0 && WORD.test(masked[q])) q--;
      if (!EXPR_KEYWORDS.has(masked.slice(q + 1, p + 1))) continue;
    }
    addUnit(i);
  }
  for (const m of masked.matchAll(/\bvec\s*!\s*[({]/g)) {
    addUnit(m.index + m[0].length - 1);
  }
  const unitStartingAt = (pos) => {
    const lead = /^\s*(?:&\s*(?:mut\s+)?)?(?:vec\s*!\s*)?/.exec(
      masked.slice(pos),
    );
    return unitByOpen.get(pos + lead[0].length);
  };
  const itemUnits = new Map();
  for (const item of items) {
    const unit = unitStartingAt(item.eq + 1);
    if (unit) itemUnits.set(unit, item);
  }

  // Receiver events, folded into sequences per (function, receiver) in source
  // order; a `let` or plain assignment starts a fresh sequence, argv-shaped
  // when it starts from a literal, `vec!` or `Vec::new`/`with_capacity`.
  const events = [];
  const VEC_INIT_RE =
    /^\s*(?:(?:std\s*::\s*)?(?:vec\s*::\s*)?Vec\s*(?:::\s*<[^>]*>\s*)?::\s*(?:new|with_capacity|default|from)\s*\()/;
  const letRe = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=(?![=>])/g;
  const assignRe = /(?<=^|[;{}])\s*([A-Za-z_]\w*)\s*=(?![=>])/g;
  for (const re of [letRe, assignRe]) {
    for (const m of masked.matchAll(re)) {
      const from = m.index + m[0].length;
      const unit = unitStartingAt(from);
      events.push({
        key: `${fnKey(m.index)}:${m[1]}`,
        pos: m.index,
        reset: true,
        argvInit:
          Boolean(unit) || VEC_INIT_RE.test(masked.slice(from, from + 120)),
        elements: unit ? unit.elements : [],
      });
    }
  }
  const chainEnds = new Map();
  const mutatorRe =
    /\.\s*(push|insert|args|arg|extend_from_slice|extend)\s*\(/g;
  for (const m of masked.matchAll(mutatorRe)) {
    const open = m.index + m[0].length - 1;
    const close = open + 1 + bracketBody(masked, open).length;
    let elements;
    let prepend = false;
    let needsArgvInit = false;
    if (m[1] === "push" || m[1] === "arg") {
      const text = code.slice(open + 1, close);
      const at = open + 1 + text.length - text.trimStart().length;
      elements = [{ at, values: argValues(text, resolverAt(at)) }];
    } else if (m[1] === "insert") {
      // A map's `insert(key, value)` is no argv: only an integer index, or a
      // receiver that started argv-shaped, makes one.
      const [index] = argvElements(masked.slice(open + 1, close));
      const from = open + 1 + (index?.at ?? 0);
      const indexText = code
        .slice(from, from + (index?.text.length ?? 0))
        .trim();
      prepend = indexText === "0";
      needsArgvInit = !/^\d[\d_]*(?:[iu](?:8|16|32|64|128|size))?$/.test(
        indexText,
      );
      elements = elementsOf(open, close).slice(1, 2);
    } else {
      const unit = unitStartingAt(open + 1);
      elements = unit
        ? unit.elements.map((el) => ({ ...el }))
        : [{ at: open + 1, opaque: true }];
    }
    // A call chained onto the previous mutator joins that call's unit and
    // receiver: `cmd.arg("merge").arg("--abort")` is one expression.
    let gap = m.index;
    while (gap > 0 && /\s/.test(masked[gap - 1])) gap--;
    let event = chainEnds.get(gap);
    if (!event) {
      const start = exprStart(masked, m.index);
      const base = masked.slice(start, m.index).replace(/\s+/g, "");
      const key = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(base)
        ? `${fnKey(m.index)}:${base}`
        : `@${start}`;
      event = {
        key,
        pos: m.index,
        needsArgvInit,
        elements: [],
        unit: { at: m.index },
      };
      events.push(event);
    }
    for (const el of elements) el.unit = event.unit;
    if (prepend) event.prepend = elements;
    else event.elements.push(...elements);
    chainEnds.set(close + 1, event);
  }
  // A collection-removal call breaks the receiver's run: what was there no
  // longer fills the verb slot of anything pushed after it. Only `.clear()`
  // empties it outright; the argv survives a partial removal.
  const removalRe =
    /\.\s*(clear|truncate|drain|retain(?:_mut)?|remove|swap_remove|split_off|pop|dedup(?:_by(?:_key)?)?|resize(?:_with)?|set_len)\s*\(/g;
  for (const m of masked.matchAll(removalRe)) {
    const base = masked
      .slice(exprStart(masked, m.index), m.index)
      .replace(/\s+/g, "");
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(base)) continue;
    events.push({
      key: `${fnKey(m.index)}:${base}`,
      pos: m.index,
      removal: true,
      clear: m[1] === "clear",
      elements: [],
    });
  }

  const sequences = [];
  const current = new Map();
  for (const event of events.sort((a, b) => a.pos - b.pos)) {
    let seq = current.get(event.key);
    // A `.clear()` ends the fold even where it may not run: the dominance pass
    // still judges an earlier merge against what follows a conditional one.
    if (event.clear && seq) {
      const { argvInit } = seq;
      seq = [];
      seq.argvInit = argvInit;
      sequences.push(seq);
      current.set(event.key, seq);
    }
    if (event.removal) continue;
    if (!seq || event.reset) {
      seq = [];
      seq.argvInit = Boolean(event.argvInit);
      sequences.push(seq);
      current.set(event.key, seq);
    }
    if (event.needsArgvInit && !seq.argvInit) continue;
    if (event.prepend) seq.unshift(...event.prepend);
    seq.push(...event.elements);
  }
  // Every array literal is also judged on its own: a receiver's earlier verb
  // must not dismiss a merge/pull-led literal spliced in after it.
  for (const unit of units) {
    if (!itemUnits.has(unit)) sequences.push(unit.elements);
  }

  // Whether the ff-only pair in the verb's own literal still holds: git takes
  // the LAST fast-forward flag and the last overwrite flag, so a later --ff or
  // --no-ff, an opaque splice after --ff-only, or an --overwrite-ignore after
  // the last --no-overwrite-ignore (resolved, or anywhere in the function's
  // text) turns the run back into a strategy merge.
  const ffOnlyHolds = (seq, k) => {
    const own = (el, i) => i > k && el.unit === seq[k].unit;
    const ff = seq.findIndex(
      (el, i) => own(el, i) && definite(el) === "--ff-only",
    );
    if (
      ff < 0 ||
      !seq.some(
        (el, i) => own(el, i) && definite(el) === "--no-overwrite-ignore",
      )
    )
      return false;
    const keep = seq.findLastIndex(
      (el) => definite(el) === "--no-overwrite-ignore",
    );
    for (let i = ff + 1; i < seq.length; i++) {
      const el = seq[i];
      if (el.opaque || el.values?.some((v) => v === "--ff" || v === "--no-ff"))
        return false;
    }
    for (let i = keep + 1; i < seq.length; i++) {
      if (seq[i].values?.includes("--overwrite-ignore")) return false;
    }
    return !overwritesIgnored(seq[k].at);
  };
  // The verb's index when `seq` runs merge/pull with no exemption, else -1.
  const mergeVerb = (seq) => {
    const k = argvVerb(seq);
    if (k === null) return -1;
    if (!seq[k].values.some((v) => v === "merge" || v === "pull")) return -1;
    const own = seq
      .slice(k + 1)
      .filter((el) => el.unit === seq[k].unit)
      .map(definite);
    if (own.some((flag) => CONTROL_FLAGS.includes(flag))) return -1;
    if (
      definite(seq[k]) === "merge" &&
      seq[k].unit.literal &&
      ffOnlyHolds(seq, k)
    )
      return -1;
    return k;
  };
  for (const seq of sequences) {
    const k = mergeVerb(seq);
    if (k >= 0) record(seq[k].at);
  }

  // An earlier position runs before a later one on every path only when each
  // group around it (if/else block, loop body, closure, call argument) also
  // holds the later one, and no match arm boundary falls between them.
  const dominates = (earlier, later) => {
    for (let g = inner[earlier]; g >= 0; g = inner[g]) {
      if (!(later > g && later < (closeOf.get(g) ?? masked.length)))
        return false;
      if (arrows.get(g)?.some((p) => p > earlier && p < later)) return false;
    }
    return true;
  };

  // Context only ADDS sites. Each receiver event is judged again against just
  // the earlier elements that dominate it since the last reset or removal, so
  // a sibling branch's verb or a cleared receiver can't dismiss what it adds.
  // Later elements stay in view, since they can only void an exemption, until
  // the receiver's lifetime ends: a reset's own elements and whatever a reset
  // or `.clear()` dominates build another argv.
  const byKey = new Map();
  for (const event of events) {
    if (!byKey.has(event.key)) byKey.set(event.key, []);
    byKey.get(event.key).push(event);
  }
  for (const list of byKey.values()) {
    let argvInit = false;
    let run = [];
    list.forEach((event, i) => {
      if (event.reset || event.removal) run = [];
      if (event.reset) argvInit = Boolean(event.argvInit);
      if (event.removal || (event.needsArgvInit && !argvInit)) return;
      const all = (e) => [...(e.prepend ?? []), ...e.elements];
      const verbs = all(event).some((el) =>
        el.values?.some((v) => v === "merge" || v === "pull"),
      );
      if (!verbs) {
        run.push(event);
        return;
      }
      const prefix = run
        .filter((e) => dominates(e.pos, event.pos))
        .flatMap(all);
      const after = list.slice(i + 1);
      const bounds = after.filter((e) => e.reset || e.clear);
      const later = after
        .filter(
          (e) =>
            !e.removal &&
            !e.reset &&
            !bounds.some((b) => b.pos < e.pos && dominates(b.pos, e.pos)),
        )
        .flatMap(all);
      const seq = [
        ...(event.prepend ?? []),
        ...prefix,
        ...event.elements,
        ...later,
      ];
      const own = new Set(all(event));
      const k = mergeVerb(seq);
      if (k >= 0 && own.has(seq[k])) record(seq[k].at);
      run.push(event);
    });
  }

  for (const [unit, item] of itemUnits) {
    if (inTest(item.at) || mergeVerb(unit.elements) < 0) continue;
    if (rowAllowed(item.name, true)) {
      push(item.at, item.name, true);
      continue;
    }
    const uses = [
      ...masked.matchAll(new RegExp(String.raw`\b${item.name}\b`, "g")),
    ]
      .map((m) => m.index)
      .filter((at) => (at < item.start || at > item.end) && !inUse(at));
    for (const at of uses) record(at);
    if (item.pub || uses.length === 0) {
      if (innermost(item.at)) record(item.at);
      else push(item.at, item.name, false);
    }
  }

  for (const at of capped) {
    if (inTest(at)) continue;
    hits.push({
      file,
      line: lineOf(at),
      fn: "<unreadable>",
      allowlisted: false,
      fix: `resolving this element's value ran past ${MAX_HOPS} let/const hops, so check H cannot read it — shorten the binding chain, or raise MAX_HOPS in scripts/check-rust-invariants.mjs`,
    });
  }

  for (const row of allowlist.filter((entry) => entry.builder)) {
    const names = new Set([row.fn]);
    const alias = new RegExp(
      String.raw`\b${row.fn}\s+as\s+([A-Za-z_]\w*)`,
      "g",
    );
    for (const m of masked.matchAll(alias)) names.add(m[1]);
    for (const name of names) {
      for (const m of masked.matchAll(
        new RegExp(String.raw`\b${name}\b`, "g"),
      )) {
        if (inUse(m.index)) continue;
        const declaration = functions.some(
          (fn) => fn.name === name && m.index >= fn.start && m.index <= fn.open,
        );
        if (!declaration) record(m.index, true);
      }
    }
  }
}

// ------------------------------------------------------------------- check I

// Production-path mints, dynamically built victim names and aliased UpdateMarker
// imports remain review concerns. Other types named TestRootOverride can match;
// a reviewed allowlist rationale must establish why such a holder is private.

// testModuleSpans misses #[cfg(all(unix, test))] and out-of-line `mod tests;` files.
// Delegation covers one same-file level only. Exact quoted literals miss victims
// using "refs/heads/<name>" or larger literals containing the marker branch name.

// Reverse delegation is skipped: a test-module helper that mints a marker
// is not checked when only its caller installs the override.

// Binding resolution uses the last same-named let before the call, even when
// that binding belongs to an already-closed inner block.
export const TEST_MARKER_ALLOWLIST = [];

let testMarkerCorpus;

function markerCorpus(file, src) {
  if (!testMarkerCorpus) {
    testMarkerCorpus = new Map(
      rustFiles(SRC).map((path) => {
        const rel = relative(SRC, path).replace(/\\/g, "/");
        return [
          rel,
          rel === file
            ? src
            : readFileSync(path, "utf8").replace(/\r\n/g, "\n"),
        ];
      }),
    );
  }
  return Array.from(testMarkerCorpus, ([key, value]) => ({
    file: key,
    src: key === file ? src : value,
  }));
}

export function checkTestMarkerBranches(file, src, _lines, hits, corpus) {
  src = src.replace(/\r\n/g, "\n");
  const push = (at, fn, fix) =>
    hits.push({
      file,
      line: src.slice(0, at).split("\n").length,
      fn,
      allowlisted: allowed(TEST_MARKER_ALLOWLIST, file, fn),
      fix,
    });
  let sources;
  try {
    sources = corpus === undefined ? markerCorpus(file, src) : corpus;
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some(
        (row) =>
          !row || typeof row.file !== "string" || typeof row.src !== "string",
      ) ||
      new Set(sources.map((row) => row.file)).size !== sources.length ||
      !sources.some((row) => row.file === file)
    ) {
      throw new Error("empty, absent, duplicate or unreadable Rust corpus");
    }
    sources = sources.map((row) => ({
      file: row.file,
      src: (row.file === file ? src : row.src).replace(/\r\n/g, "\n"),
    }));
  } catch (error) {
    push(
      0,
      "<unreadable>",
      `check I cannot read the Rust corpus: ${error.message}`,
    );
    return;
  }
  const { code, masked, unterminated } = lexRust(src);
  if (unterminated >= 0) {
    push(
      unterminated,
      "<unreadable>",
      "check I requires closed literals and comments",
    );
    return;
  }
  const tests = testModuleSpans(masked);
  const functions = rustFunctions(masked);
  const body = (fn) => masked.slice(fn.open + 1, fn.close);
  const override = /\bTestRootOverride\s*::\s*set\s*\(/;
  const helpers = functions.filter((fn) => override.test(body(fn)));
  const installsOverride = (fn) =>
    override.test(body(fn)) ||
    helpers.some((helper) =>
      new RegExp(String.raw`\b${helper.name}\s*\(`).test(body(fn)),
    );
  const literal = /^"(?:\\.|[^"\\])*"$/;
  for (const site of masked.matchAll(
    /\bUpdateMarker\s*::\s*create_for\s*\(/g,
  )) {
    if (!tests.some(([start, end]) => site.index > start && site.index < end))
      continue;
    const fn = functions
      .filter(
        (candidate) =>
          site.index > candidate.open && site.index < candidate.close,
      )
      .at(-1);
    if (!fn) {
      push(
        site.index,
        "<unreadable>",
        "check I cannot find the marker's enclosing function",
      );
      continue;
    }
    if (!installsOverride(fn)) continue;
    const args = [];
    let start = site.index + site[0].length;
    let depth = 0;
    let closed = false;
    for (let i = start; i < fn.close; i++) {
      const char = masked[i];
      if (char === ")" && depth === 0) {
        args.push(code.slice(start, i).trim());
        closed = true;
        break;
      }
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) depth--;
      else if (char === "," && depth === 0) {
        args.push(code.slice(start, i).trim());
        start = i + 1;
      }
    }
    let branch = closed ? args[1] : undefined;
    if (branch && /^[A-Za-z_]\w*$/.test(branch)) {
      const prefix = masked.slice(fn.open + 1, site.index);
      const binding = [
        ...prefix.matchAll(
          new RegExp(
            String.raw`\blet\s+(?:mut\s+)?${branch}\s*(?::[^=;]*)?=`,
            "g",
          ),
        ),
      ]
        .filter(
          (match) =>
            !functions.some(
              (nested) =>
                nested !== fn &&
                fn.open + 1 + match.index > nested.open &&
                fn.open + 1 + match.index < nested.close,
            ),
        )
        .at(-1);
      const init = binding ? fn.open + 1 + binding.index : -1;
      const end = init < 0 ? -1 : masked.indexOf(";", init);
      const declaration =
        end >= 0 && end < site.index
          ? code.slice(init, end + 1).split("\n")
          : [];
      branch = bindingInitializer(declaration, 0, branch, { before: Infinity })
        ?.replace(/;\s*$/, "")
        .trim();
    }
    const raw = /^r(#*)"/.exec(branch ?? "");
    if (
      !branch ||
      !(
        literal.test(branch) ||
        (raw && literalEnd(branch, 0) === branch.length - 1)
      )
    ) {
      push(
        site.index,
        fn.name,
        "cannot resolve the marker branch name — use a same-function string literal or add an allowlist row (check I)",
      );
      continue;
    }
    if (raw)
      branch = branch.slice(raw[0].length - 1, branch.length - raw[1].length);
    const shared = sources.some((row) => {
      for (
        let at = row.src.indexOf(branch);
        at >= 0;
        at = row.src.indexOf(branch, at + 1)
      ) {
        if (row.file !== file || at < fn.start || at > fn.close) return true;
      }
      return false;
    });
    if (shared) {
      push(
        site.index,
        fn.name,
        `check I: test-held update markers must use a branch name unique to their function; rename ${branch} and its same-function uses`,
      );
    }
  }
}

// ------------------------------------------------------------------- check J

// Function-level: a function that calls classify_gh_failure anywhere passes,
// since its outcome arms are what decide absence. Shapes outside the three
// below (a match on the exit code, an absence built through a helper, an
// `is_ok_and` over the exit, and an `Err(_)` arm over `run_gh`, which turns
// a non-zero exit into that Err) remain review concerns.
export const GH_EXIT_ABSENCE_ALLOWLIST = [
  {
    file: "github/avatar.rs",
    fn: "gh_bot_avatar",
    rationale:
      'decoration by contract: an empty URL draws initials, and Ok("") keeps virtualized rows from re-spawning gh per render',
  },
  {
    file: "github/insights.rs",
    fn: "parse_items",
    rationale:
      "parses a fan-out read that traffic_details_outcome already classified; only its NotFound/Answered responses reach the empty tolerance",
  },
  {
    file: "github/pr.rs",
    fn: "graphql_reset_at",
    rationale:
      "advisory reset hint: None omits the notice's time clause, never claims an absence",
  },
  {
    file: "github/pr.rs",
    fn: "detect_fork_pr_for_branch",
    rationale:
      "the matched exit is a local git rev-parse (no such branch); the gh lookups are fail-safe by contract, so publish proceeds",
  },
  {
    file: "github/pr.rs",
    fn: "gh_open_stack_memberships",
    rationale:
      "None is the unknown verdict (a failed probe), which callers keep apart from a known-empty stack map",
  },
  {
    file: "github/pr.rs",
    fn: "stack_members_from_output",
    rationale:
      "None is a shape failure the caller reads as unknown; hop 1 already proved membership",
  },
  {
    file: "github/pr.rs",
    fn: "gh_version_line",
    rationale:
      "fail-safe by contract: None reads as an unreadable version, which closes the attachment gate with its reason",
  },
];

/** Values a failed read must not answer with: no star, no rows, a default. */
const GH_ABSENCE = String.raw`(?:false|None|vec!\s*\[\s*\]|(?:Vec|String|HashMap|HashSet|BTreeMap|BTreeSet)::new\(\s*\)|(?:[A-Z]\w*(?:::<[^>]*>)?::)?(?:Default::)?default\(\s*\))`;
const GH_ABSENCE_ARM = new RegExp(
  String.raw`\bOk\s*\(\s*${GH_ABSENCE}\s*\)|\breturn\s+${GH_ABSENCE}\s*;`,
);
const GH_OK_EXIT_RE = /\bOk\s*\(\s*[\w.]+\.code\s*==\s*0\s*\)/g;
const GH_MAP_EXIT_RE =
  /\|\s*(\w+)\s*\|\s*\1\.code\s*==\s*0\s*\)\s*\.unwrap_or(?:\(\s*false\s*\)|_default\(\s*\))/g;
const GH_IF_FAILED_RE = /\bif\s+[\w.]+\.code\s*!=\s*0\s*\{/g;
const GH_EXIT_ABSENCE_FIX =
  "check J: a non-zero gh exit is not an absence — route it through " +
  "forge::session::classify_gh_failure, which only buckets the failure, and " +
  "let a pure *_outcome fn decide absence (RateLimited/Transport → Err; " +
  "NotFound/Answered → the read's absence, except star status and the Explore " +
  "README, which reject every failure but NotFound), or allowlist a fail-safe " +
  "or decoration read with rationale";

/** Check J reads only the GitHub files, so none in scope means it read
 *  nothing: that fails J itself, found by its `run`, whatever its position. */
export function reportEmptyGhScope(checks, relFiles) {
  if (relFiles.some(ghExitAbsenceScope)) return;
  const j = checks.find((c) => c.run === checkGhExitAbsence);
  if (j === undefined) throw new Error("check J is missing from CHECKS");
  j.hits.push({
    file: "github/",
    line: 0,
    fn: "<empty scope>",
    allowlisted: false,
    fix: "check J found no src-tauri/src/github/*.rs or forge/github.rs to scan — update ghExitAbsenceScope",
  });
}

/** Whether `file` is in check J's scope: the GitHub reads. */
export function ghExitAbsenceScope(file) {
  return file.startsWith("github/") || file === "forge/github.rs";
}

export function checkGhExitAbsence(
  file,
  _src,
  lines,
  hits,
  allowlist = GH_EXIT_ABSENCE_ALLOWLIST,
) {
  if (!ghExitAbsenceScope(file)) return;
  const { code, masked, unterminated } = lexRust(lines.join("\n"));
  const lineOf = (at) => code.slice(0, at).split("\n").length;
  if (unterminated >= 0) {
    hits.push({
      file,
      line: lineOf(unterminated),
      fn: "<unreadable>",
      allowlisted: false,
      fix: "check J: a literal or comment opening here never closes, so the rest of the file is unreadable to this check — fix the source, or the lexer in scripts/check-rust-invariants.mjs",
    });
  }
  const tests = testModuleSpans(masked);
  const functions = rustFunctions(masked);
  const report = (at) => {
    if (tests.some(([s, e]) => at > s && at < e)) return;
    const fn = functions.filter((f) => at > f.open && at < f.close).at(-1);
    if (fn && /\bclassify_gh_failure\b/.test(masked.slice(fn.open, fn.close)))
      return;
    const name = fn?.name ?? "<top level>";
    if (hits.some((h) => h.file === file && h.line === lineOf(at))) return;
    hits.push({
      file,
      line: lineOf(at),
      fn: name,
      allowlisted: allowlist.some((e) => e.file === file && e.fn === name),
      fix: GH_EXIT_ABSENCE_FIX,
    });
  };
  for (const m of masked.matchAll(GH_OK_EXIT_RE)) report(m.index);
  for (const m of masked.matchAll(GH_MAP_EXIT_RE)) report(m.index);
  for (const m of masked.matchAll(GH_IF_FAILED_RE)) {
    const body = braceBody(masked, m.index + m[0].length - 1);
    if (GH_ABSENCE_ARM.test(body)) report(m.index);
  }
}

// ---------------------------------------------------- K. external diff tools

const DIFF_DRIVER_ALLOWLIST = [
  {
    file: "git/diff.rs",
    fn: "REQUESTED_ATTRS",
    item: true,
    rationale:
      "Attribute names passed to check-attr, never a git argv; diff selects the attribute to read",
  },
];
const DIFF_DRIVER_FLAGS = new Set([
  "--numstat",
  "--name-only",
  "--name-status",
]);
const KNOWN_NO_PATCH = new Set([
  ...DIFF_DRIVER_FLAGS,
  "-z",
  "--no-color",
  "--cached",
  "--staged",
  "--no-renames",
  "--no-relative",
  "--find-renames",
  "-M",
  "--relative",
  "--ignore-submodules",
]);
const knownNoPatch = (value) =>
  KNOWN_NO_PATCH.has(value) ||
  /^(?:--(?:find-renames|diff-filter|relative|ignore-submodules)=[\s\S]*|-M\d+(?:\.\d+)?%?)$/.test(value);
const DIFF_DRIVER_FIX =
  "check K: add --no-ext-diff immediately after diff; --numstat, --name-only " +
  "and --name-status are the only exempt output modes, and only with no " +
  "literal option after the verb and before -- outside the known-no-patch list";

function diffArgLiteral(text) {
  const value = literalValue(text.trim());
  if (value !== undefined) return value;
  const owned = /^([\s\S]*)\.\s*(?:to_string|into|to_owned)\s*\(\s*\)$/.exec(text.trim());
  const from = /^String\s*::\s*from\s*\(([\s\S]*)\)$/.exec(text.trim());
  const inner = owned?.[1] ?? from?.[1];
  return inner === undefined ? undefined : literalValue(inner.trim());
}

export function checkDiffExternalDrivers(
  file,
  _src,
  lines,
  hits,
  allowlist = DIFF_DRIVER_ALLOWLIST,
) {
  const { code, masked, unterminated } = lexRust(lines.join("\n"));
  const report = (at, fn, item, fix, readable = true) =>
    hits.push({
      file,
      line: code.slice(0, at).split("\n").length,
      fn,
      item,
      allowlisted:
        readable &&
        allowlist.some(
          (e) => e.file === file && e.fn === fn && Boolean(e.item) === item,
        ),
      fix,
    });
  if (unterminated >= 0) {
    report(
      unterminated,
      "<unreadable>",
      false,
      "check K: a literal or comment opening here never closes — fix the source, or the lexer in scripts/check-rust-invariants.mjs",
      false,
    );
  }
  const tests = testModuleSpans(masked);
  const functions = rustFunctions(masked);
  const items = [];
  const itemRe = /\b(?:const|static)\s+(?:mut\s+|ref\s+)?(\w+)\s*:(?!:)/g;
  for (const m of masked.matchAll(itemRe)) {
    let depth = 0;
    let eq = -1;
    for (let k = m.index + m[0].length; k < masked.length; k++) {
      const ch = masked[k];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (--depth < 0) break;
      } else if (depth === 0 && ch === "=" && eq < 0) eq = k;
      else if (depth === 0 && ch === ";") {
        if (eq >= 0) items.push({ name: m[1], eq, end: k });
        break;
      }
    }
  }
  const opens = new Set([...masked.matchAll(/\[/g)].map((m) => m.index));
  for (const m of masked.matchAll(/\bvec\s*!\s*[({]/g)) {
    opens.add(m.index + m[0].length - 1);
  }
  for (const at of opens) {
    if (tests.some(([s, e]) => at > s && at < e)) continue;
    const body = bracketBody(code, at);
    const end = at + body.length + 1;
    const values = argvElements(body).map((e) => diffArgLiteral(e.text));
    const globalValues = new Set();
    let verb;
    for (let k = 0; k < values.length; k++) {
      const value = values[k];
      if (value === undefined) break;
      if (!value.startsWith("-")) {
        verb = k;
        break;
      }
      if (GIT_VALUE_OPTIONS.has(value)) globalValues.add(++k);
    }
    const args = verb === undefined ? values : values.slice(verb + 1);
    const separator = args.indexOf("--");
    const options = separator < 0 ? args : args.slice(0, separator);
    const pathStart = separator < 0 ? values.length : (verb === undefined ? 0 : verb + 1) + separator;
    const enablesDriver = values.slice(0, pathStart).some(
      (value, k) => value === "--ext-diff" && !globalValues.has(k),
    );
    if (!values.includes("diff") && !enablesDriver) continue;
    const item = items.filter((i) => at > i.eq && at < i.end).at(-1);
    const fn = functions.filter((f) => at > f.open && at < f.close).at(-1);
    const isItem = Boolean(item && (!fn || item.eq > fn.open));
    const name = isItem ? item.name : (fn?.name ?? "<top level>");
    // Balanced delimiters are required even when a flag would otherwise exempt.
    const stack = [];
    let bounded = code[end] === ")]}"["([{".indexOf(masked[at])];
    for (let k = at; k <= end && bounded; k++) {
      const ch = masked[k];
      if ("([{".includes(ch)) stack.push(ch);
      else if (")]}".includes(ch)) {
        if (stack.pop() !== "([{"[")]}".indexOf(ch)]) bounded = false;
      }
    }
    if (!bounded || stack.length) {
      report(
        at,
        name,
        isItem,
        "check K: cannot bound this git argv group — fix its delimiters or extend the parser",
        false,
      );
      continue;
    }
    if (enablesDriver) {
      report(
        at,
        name,
        isItem,
        "check K: drop --ext-diff; external drivers are refused before -- in any argv-shaped group",
        false,
      );
      continue;
    }
    if (verb === undefined) {
      report(
        at,
        name,
        isItem,
        "check K: cannot resolve the verb of this group containing diff — use a literal git verb or extend the parser",
        false,
      );
    } else if (values[verb] === "diff") {
      const exempt = options.some((value) => DIFF_DRIVER_FLAGS.has(value)) &&
        options.every(
          (value) => value === undefined || !value.startsWith("-") || knownNoPatch(value),
      );
      if (!options.includes("--no-ext-diff") && !exempt)
        report(at, name, isItem, DIFF_DRIVER_FIX);
    }
  }
}

// ---------------------------------- L. test git spawns on the product timeout

export const TEST_HANG_GUARD_ALLOWLIST = [
  {
    file: "git/ops.rs",
    fn: "start_with_todo",
    rationale:
      "its DEFAULT_TIMEOUT tokens are arguments to start_planned_rebase, the product function under test, not a fixture spawn budget",
  },
];

export const TEST_HANG_GUARD_NOTE =
  "Not seen: an alias (`use … DEFAULT_TIMEOUT as X`); a value bound to DEFAULT_TIMEOUT and passed to a helper by name; a helper delegating to product code that applies the budget; a nested fn inside a `#[cfg(test)]` fn outside any test module, methods of a `#[cfg(test)] impl` outside one, and `#[cfg(test)]` consts or statics outside one (all read as production); a helper outside any test module gated by a compound cfg that contains test (`#[cfg(all(test, unix))]`), read as production: a fn is test code only under an exact `#[cfg(test)]`, a module only under `#[cfg(test)]` or `#[cfg(all(test, …))]`; a fn outside any test module gated by an exact `#[cfg(test)]` whose signature holds a brace (`-> Foo<{ N }>`), whose body neither check L nor the census reads; a test module check L cannot read (gated `#[cfg(all(<x>, test))]` or `#[cfg(any(test, unix))]`, a gate spaced as `#[cfg (test)]` or `# [cfg(test)]`, a nested-bracket attribute between the gate and `mod`, `mod r#tests`, an inner `#![cfg(test)]` inside `mod tests {` (credited to the module's first fn only when that fn directly follows it), an out-of-line `mod tests;` file) fails the census test (testAttrsOutsideTestCode) as soon as it holds a test attribute check L does not read as test code, as does a bare `#[test]` fn outside any module, so what stays unseen there is a helper-only module under an unread gate (or one whose test fns each carry their own `#[cfg(test)]`, or an inner-gated module whose single test fn comes first); the census counts only an attribute whose last path segment is `test`, so a test spelled through `cfg_attr` (`#[cfg_attr(not(miri), test)]`) or by a test macro of another name (`#[rstest]`, `#[test_case(..)]`) is not counted; closure-form helpers inside test-fn bodies, except their direct runner calls; anywhere, a budget spelled other than the DEFAULT_TIMEOUT token (`Duration::from_secs(30)`, another constant), such as a `tokio::time::timeout` bound around a spawn; in a test fn, a DEFAULT_TIMEOUT that is not a direct argument of a plain spawn runner (product code under test keeps the product's budget on purpose), a lock-taking or retrying runner wrapper (`run_git_mutating*`, `run_git_config_write*`, `run_git_raw_index_retry`, `run_git_worktree_admin`, and git/remote.rs's credential wrappers `run_git_with_creds_*` and `run_git_mutating_with_creds*`), read as product code under test, a budget bound to a local first (`let t = DEFAULT_TIMEOUT;`) and passed by name, a token nested inside another call among a runner's arguments (`run_git(.., f(DEFAULT_TIMEOUT))`), a token inside a block, if/match, struct-literal, array or tuple argument of a runner, a turbofish or parenthesized runner call (`run_git::<T>(…)`, `(run_git)(…)`), and a runner reached through a wrapper or an alias; and out of reach by design: a fn named by a raw identifier or a non-ASCII name, which check L reads under the name's leading ASCII run (`r` for `fn r#helper`, `h` for `fn hélper`), so no allowlist row can target it and a row for that run covers every helper read under it in the file; such a name with no leading ASCII word character, which is `<unreadable>` directly in a test module and silent when nested in a test fn (except a direct runner argument, read as the test fn's) or gated `#[cfg(test)]` outside any module; a `macro_rules!` body defined outside test code and used by tests, and one allowlist row covers every same-named helper in its file";

const TEST_HANG_GUARD_FIX =
  "check L: a test helper's git spawn budget is a hang guard — pass " +
  "crate::git::runner::TEST_GIT_HANG_GUARD (test builds only), never the " +
  "product's DEFAULT_TIMEOUT, or allowlist a token that is an argument to " +
  "the product code under test";
const TEST_RUNNER_FIX =
  "check L: a git runner called from a test passes the product's " +
  "DEFAULT_TIMEOUT — pass crate::git::runner::TEST_GIT_HANG_GUARD (test " +
  "builds only); a runner's spawn budget in a test is a hang guard";
// Every `fn run_git*` declared outside test modules anywhere under
// src-tauri/src (git/runner.rs and git/remote.rs today), private ones
// included, is in exactly one list: the runner arm matches a callee by its
// last path segment in every file, so the pin test reads every file through
// gitRunnerDeclarations. The runner arm guards the PLAIN spawn runners, which
// only spawn git on the caller's budget. The wrappers take a lock, retry, or
// inject credentials and retry: a test calling one is testing product code,
// so its DEFAULT_TIMEOUT stays the product's budget and is not a site.
export const PLAIN_GIT_RUNNERS = new Set([
  "run_git",
  "run_git_raw",
  "run_git_input",
  "run_git_raw_input",
  "run_git_raw_input_bytes",
  "run_git_raw_env",
  "run_git_raw_input_env",
  "run_git_spawn",
]);
export const UNGUARDED_GIT_RUNNERS = new Set([
  "run_git_mutating",
  "run_git_mutating_raw",
  "run_git_mutating_input",
  "run_git_raw_index_retry",
  "run_git_config_write",
  "run_git_config_write_held",
  "run_git_mutating_config_write",
  "run_git_worktree_admin",
  "run_git_with_creds_once",
  "run_git_with_creds_rechecked",
  "run_git_mutating_with_creds",
  "run_git_mutating_with_creds_for_branch",
  "run_git_mutating_with_creds_checked",
]);

/** The name of every `fn run_git*` declared in `text` outside its test
 *  modules: any visibility or qualifiers (only the `fn` keyword and the name
 *  are read), a raw identifier read without its `r#`. It returns every such
 *  fn it sees, trait methods, nested fns and macro bodies included, so a
 *  non-runner it reads fails closed through the pin test, never silently. */
export function gitRunnerDeclarations(text) {
  const { masked } = lexRust(text);
  const tests = testModuleSpans(masked);
  return [...masked.matchAll(/\bfn\s+(?:r#)?(run_git\w*)/g)]
    .filter((m) => !tests.some(([s, e]) => m.index > s && m.index < e))
    .map((m) => m[1]);
}
const CLOSER_OF = { "(": ")", "[": "]", "{": "}" };
const OPENER_OF = { ")": "(", "]": "[", "}": "{" };
const FN_QUALIFIERS = new Set(["pub", "const", "async", "unsafe", "extern"]);
const TEST_ATTR_RE = /^#\[(?:::)?(?:tokio::)?test(?:\]|\()/;
const CFG_TEST_RE = /^#!?\[cfg\(test\)\]$/;

/** The outer attributes of the `fn` whose keyword sits at `start` in a masked
 *  view, whitespace removed, or null when the run cannot be read. FN_RE's
 *  qualifiers sit between the attributes and `fn`, so they are skipped first;
 *  the run must then start at an item boundary (`{`, `}`, `;` or the file's
 *  start), or a stray token would be read as the start of the item. */
export function fnAttributes(masked, start) {
  return attributeRun(masked, start)?.attributes ?? null;
}

/** fnAttributes' reading, with the offset where the attribute run starts. */
function attributeRun(masked, start) {
  let p = start;
  const skipSpace = () => {
    while (p > 0 && /\s/.test(masked[p - 1])) p--;
  };
  const wordStart = (end) => {
    let s = end;
    while (s > 0 && WORD.test(masked[s - 1])) s--;
    return s;
  };
  for (;;) {
    skipSpace();
    let end = p;
    if (masked[p - 1] === ")") {
      const open = masked.lastIndexOf("(", p - 1);
      end = open;
      while (end > 0 && /\s/.test(masked[end - 1])) end--;
      if (open < 0 || masked.slice(wordStart(end), end) !== "pub") break;
    }
    const s = wordStart(end);
    if (!FN_QUALIFIERS.has(masked.slice(s, end))) break;
    p = s;
  }
  const attributes = [];
  for (;;) {
    skipSpace();
    if (masked[p - 1] !== "]") break;
    let depth = 0;
    let open = -1;
    for (let i = p - 1; i >= 0; i--) {
      if (masked[i] === "]") depth++;
      else if (masked[i] === "[" && --depth === 0) {
        open = i;
        break;
      }
    }
    let hash = open - 1;
    if (masked[hash] === "!") hash--;
    if (open < 0 || masked[hash] !== "#") return null;
    attributes.push(masked.slice(hash, p).replace(/\s+/g, ""));
    p = hash;
  }
  skipSpace();
  return p === 0 || "{};".includes(masked[p - 1])
    ? { attributes, start: p }
    : null;
}

/** The runner a token at `at` is a DIRECT argument of (its innermost bracket
 *  is a `(` whose callee's last path segment is in PLAIN_GIT_RUNNERS), false
 *  when it is not, or null when the brackets between it and `fn`'s body don't
 *  balance. A token nested in another call among a runner's arguments is that
 *  call's argument, not the runner's: the inner callee may be product code. */
export function runnerCallOf(masked, at, fn) {
  const pending = [];
  let open = -1;
  for (let i = at - 1; i > fn.open; i--) {
    const char = masked[i];
    if (OPENER_OF[char]) pending.push(OPENER_OF[char]);
    else if (CLOSER_OF[char]) {
      if (pending.length === 0) {
        open = i;
        break;
      }
      if (pending.pop() !== char) return null;
    }
  }
  if (open < 0) return pending.length === 0 ? false : null;
  const nested = [];
  let closed = false;
  for (let i = at; i < fn.close && !closed; i++) {
    const char = masked[i];
    if (CLOSER_OF[char]) nested.push(char);
    else if (OPENER_OF[char]) {
      if (nested.length > 0) {
        if (nested.pop() !== OPENER_OF[char]) return null;
      } else if (char === CLOSER_OF[masked[open]]) closed = true;
      else return null;
    }
  }
  if (!closed) return null;
  if (masked[open] !== "(") return false;
  let end = open;
  while (end > 0 && /\s/.test(masked[end - 1])) end--;
  let start = end;
  while (start > 0 && WORD.test(masked[start - 1])) start--;
  const callee = masked.slice(start, end);
  return PLAIN_GIT_RUNNERS.has(callee) ? callee : false;
}

/** In test code (a module gated `#[cfg(test)]` or `#[cfg(all(test, …))]`, or
 *  a fn gated `#[cfg(test)]`), a `DEFAULT_TIMEOUT` token is a site when its
 *  innermost enclosing `fn` is not a test fn (the helper arm: any token), or
 *  when it is a direct argument of a plain spawn runner inside a test fn (the
 *  runner arm). A nested fn in a test fn is a helper; a closure is read as the
 *  fn around it. `corpus` tallies what the run saw for
 *  reportEmptyHangGuardScope. */
export function checkTestHangGuard(
  file,
  _src,
  lines,
  hits,
  allowlist = TEST_HANG_GUARD_ALLOWLIST,
  corpus = undefined,
) {
  const { masked, unterminated } = lexRust(lines.join("\n"));
  const report = (at, fn, fix, readable = true, arm = "helper", callee) =>
    hits.push({
      file,
      line: masked.slice(0, at).split("\n").length,
      fn,
      // A runner-arm hit is never allowlisted: a row names a fn, and a test
      // fn's name would cover every runner call it makes.
      allowlisted:
        readable &&
        arm === "helper" &&
        allowlist.some((e) => e.file === file && e.fn === fn),
      fix,
      arm,
      callee,
    });
  if (unterminated >= 0) {
    report(
      unterminated,
      "<unreadable>",
      "check L: a literal or comment opening here never closes, so the rest of the file is unreadable to this check — fix the source, or the lexer in scripts/check-rust-invariants.mjs",
      false,
    );
    return;
  }
  const tests = testModuleSpans(masked);
  if (corpus) {
    corpus.spans += tests.length;
    if (
      file === "git/runner.rs" &&
      /\bpub\s+const\s+DEFAULT_TIMEOUT\s*:/.test(masked)
    )
      corpus.definition = true;
  }
  const functions = rustFunctions(masked);
  const uses = useDeclarationSpans(masked);
  for (const { index: at } of masked.matchAll(/\bDEFAULT_TIMEOUT\b/g)) {
    if (uses.some(([s, e]) => at > s && at < e)) continue;
    const inTests = tests.some(([s, e]) => at > s && at < e);
    const fn = functions.filter((f) => at > f.open && at < f.close).at(-1);
    if (!fn) {
      if (inTests)
        report(
          at,
          "<unreadable>",
          "check L: DEFAULT_TIMEOUT in a test module outside any function body check L can find, such as a const or static initializer, a `macro_rules!` body, a fn whose name starts with a non-ASCII character, or a fn whose signature holds a brace (read as its body) — check L cannot tell which spawns it budgets",
          false,
        );
      continue;
    }
    const attributes = fnAttributes(masked, fn.start);
    if (attributes === null) {
      report(
        fn.start,
        "<unreadable>",
        `check L cannot read the attribute run before fn ${fn.name}, so it cannot tell a test fn from a helper or production code`,
        false,
      );
      continue;
    }
    if (!inTests && !attributes.some((a) => CFG_TEST_RE.test(a))) continue;
    if (!attributes.some((a) => TEST_ATTR_RE.test(a))) {
      report(at, fn.name, TEST_HANG_GUARD_FIX);
      continue;
    }
    const callee = runnerCallOf(masked, at, fn);
    if (callee === null)
      report(
        at,
        "<unreadable>",
        `check L cannot balance the brackets around this DEFAULT_TIMEOUT in test fn ${fn.name}, so it cannot tell whether a git runner receives it`,
        false,
        "runner",
      );
    else if (callee)
      report(at, fn.name, TEST_RUNNER_FIX, true, "runner", callee);
  }
}

// Looser than TEST_ATTR_RE on purpose: any attribute whose last path segment
// is `test`, spaced or not, so a test fn check L misreads is still counted.
const LOOSE_TEST_ATTR_RE = /#\s*\[\s*(?:::\s*)?(?:\w+\s*::\s*)*test\s*[\](]/g;

/** The census behind check L's module contract: every attribute in `text`
 *  whose last path segment is `test` (`scanned`; `cfg_attr` spellings and test
 *  macros of other names are not counted), and the 1-based lines of those
 *  outside the code check L reads as test code (`outside`), which is the same
 *  reading checkTestHangGuard makes: testModuleSpans over the masked view,
 *  plus a fn whose own attribute run holds an exact `#[cfg(test)]`. A test
 *  module check L cannot read shows up here as soon as it holds a test fn
 *  without its own `#[cfg(test)]`. CRLF text reads as is: every pattern takes
 *  `\r` as whitespace, and lines count `\n`. */
export function testAttrsOutsideTestCode(text) {
  const { masked } = lexRust(text);
  const spans = testModuleSpans(masked);
  const gated = [];
  for (const fn of rustFunctions(masked)) {
    const run = attributeRun(masked, fn.start);
    if (run?.attributes.some((a) => CFG_TEST_RE.test(a)))
      gated.push([run.start, fn.start]);
  }
  let scanned = 0;
  const outside = [];
  for (const { index: at } of masked.matchAll(LOOSE_TEST_ATTR_RE)) {
    scanned++;
    if (spans.some(([s, e]) => at > s && at < e)) continue;
    if (gated.some(([s, e]) => at >= s && at < e)) continue;
    outside.push(masked.slice(0, at).split("\n").length);
  }
  return { scanned, outside };
}

/** A run whose corpus held no DEFAULT_TIMEOUT definition in git/runner.rs, or
 *  no test module at all, read nothing check L guards: a hit, never a pass. */
export function reportEmptyHangGuardScope(hits, corpus) {
  if (corpus?.definition !== true)
    hits.push({
      file: "git/runner.rs",
      line: 0,
      fn: "<empty scope>",
      allowlisted: false,
      fix: "check L found no `pub const DEFAULT_TIMEOUT` in git/runner.rs — update check L to the budget's new name or home",
    });
  if (!(corpus?.spans > 0))
    hits.push({
      file: "**/*.rs",
      line: 0,
      fn: "<empty scope>",
      allowlisted: false,
      fix: "check L scanned no #[cfg(test)] module — check testModuleSpans and the Rust corpus",
    });
}

// -------------------------------------------------- M. local branch deletes

// Check M. Each row is the primitive itself, or deletes a branch ref or a ref
// the check cannot read for a reason the primitive does not cover — verified by
// reading each site.
export const LOCAL_BRANCH_DELETE_ALLOWLIST = [
  {
    file: "git/branches.rs",
    fn: "delete_branch_ref_at",
    rationale:
      "the guarded primitive itself: `update-ref --no-deref -d` at the measured tip, inside the config-write lock after refuse_if_branch_in_use, with a read-after-delete put-back (restore_deleted_ref)",
  },
  {
    file: "git/commit.rs",
    fn: "delete_root_ref",
    rationale:
      "root-commit undo: deletes the ref HEAD named under the undo's hold, old-value guarded by the root oid, leaving that branch unborn by design",
  },
  {
    file: "git/commit.rs",
    fn: "git_undo_commit_core",
    rationale:
      "its `update-ref -d HEAD` runs only in the unborn arm (target None), where HEAD did not resolve under the undo's hold; the attached arm goes through delete_root_ref",
  },
  {
    file: "git/commit.rs",
    fn: "roll_back",
    rationale:
      "the ref is the CasRef being swapped (a branch or HEAD); with old None it deletes, --no-deref and old-value guarded by current, exactly the ref the swap from None created, so it undoes its own write",
  },
  {
    file: "git/ops.rs",
    fn: "clear_branch_state",
    rationale:
      "name iterates the pseudo-refs AUTO_MERGE, CHERRY_PICK_HEAD and REVERT_HEAD under --no-deref; no branch ref is reachable",
  },
  {
    file: "git/pr_checkout.rs",
    fn: "fetch_pr_tip",
    rationale:
      "pin is pin_ref(number) = refs/gitdesktop/pr-checkout/<number>-<pid>, the fetch's own temporary pin ref, never under refs/heads/",
  },
  {
    file: "git/pr_checkout.rs",
    fn: "worktree_add",
    rationale:
      "rolls back the branch git's own `worktree add -b` minted before refusing the folder, old-value guarded by pr_tip so a branch moved since is kept; git refused the add, so no checkout holds it",
  },
];
const LOCAL_BRANCH_DELETE_FIX =
  "check M: a local branch ref delete goes only through " +
  "git::branches::delete_branch_ref_at (old-value compare-and-delete under the " +
  "config-write lock, after the in-use guards); a bare `branch -d/-D` or " +
  "`update-ref -d` on a branch ref skips them — call the primitive; a " +
  "deliberate delete is allowlisted with its rationale";
const OPAQUE_DELETE_REF_FIX =
  "check M cannot resolve this `update-ref -d` ref to a ref outside " +
  "refs/heads/ — spell a non-branch ref as a literal or a fixed `refs/<ns>/` " +
  "template, route a branch delete through delete_branch_ref_at, or allowlist " +
  "with a rationale naming what the ref is and why the primitive does not apply";
const BRANCH_DELETE_SCOPE_FIX =
  "check M saw no `update-ref -d` in git/branches.rs fn delete_branch_ref_at — " +
  "update check M to the primitive's new name or home (never remove its " +
  "allowlist row to silence this)";
// git branch's delete flags: --delete or a prefix of it git accepts (--d at
// least), or a short cluster holding -d or -D.
const BRANCH_DELETE_CLUSTER_RE = /^-[A-Za-z]*[dD][A-Za-z]*$/;
const isBranchDeleteFlag = (value) =>
  value !== undefined &&
  ((value.length >= 3 && "--delete".startsWith(value)) ||
    BRANCH_DELETE_CLUSTER_RE.test(value));
// git branch options whose value is required: given as its own element, git
// reads that element as the value, never as a flag (measured, git 2.51.1).
const BRANCH_VALUE_OPTIONS = new Set([
  "--sort",
  "--format",
  "--points-at",
  "--set-upstream-to",
  "-u",
]);
// An element git may read as taking the next one as its value: a non-literal,
// a bare long option (abbreviations included) or a cluster ending in u. `--`
// takes no value: everything after it is positional, so skipping stops there.
const mayTakeBranchValue = (value) =>
  value === undefined ||
  (value.startsWith("--") && !value.includes("=")) ||
  /^-[A-Za-z]*u$/.test(value);
/** Whether a git branch argv tail holds a delete flag. A value option's
 *  separate value is skipped only while `trusted`: the first element that may
 *  take a value ends skipping for the rest of the tail, since git may then read
 *  a value option as another option's value. */
function hasBranchDeleteFlag(flags, trusted) {
  for (let k = 0; k < flags.length; k++) {
    const value = flags[k];
    if (trusted && BRANCH_VALUE_OPTIONS.has(value)) {
      k++;
      continue;
    }
    if (isBranchDeleteFlag(value)) return true;
    if (mayTakeBranchValue(value)) trusted = false;
  }
  return false;
}
// update-ref's delete flag: -d, alone or in a short cluster (-dm).
const SHORT_CLUSTER_RE = /^-[A-Za-z]+$/;
const isRefDeleteFlag = (value) =>
  value !== undefined && SHORT_CLUSTER_RE.test(value) && value.includes("d");
// update-ref options that take no value; -m and a cluster ending in m take the next element.
const UPDATE_REF_FLAGS = new Set(["--no-deref", "--create-reflog", "--stdin", "-z"]);
const REF_TAIL_RE = /\.\s*(?:as_str|as_ref|clone|to_string|to_owned)\s*\(\s*\)$/;

/** `&x`, `x.as_str()` and their kin name the same ref as `x`. */
function deleteRefText(text) {
  let ref = text.trim().replace(/^&\s*/, "");
  while (REF_TAIL_RE.test(ref)) ref = ref.replace(REF_TAIL_RE, "").trim();
  return ref;
}

/** The ref operand of an `update-ref` argv tail (the elements after the verb)
 *  and whether --no-deref precedes it. git permutes options, so the operand is
 *  the first element that is neither an option nor -m's value, wherever -d
 *  sits; after `--` it is the next element. A `-`-led literal the check does
 *  not know, before the operand, leaves the operand undefined (opaque). */
function updateRefOperand(elements, values) {
  let noDeref = false;
  for (let k = 0; k < values.length; k++) {
    const value = values[k];
    if (value === "--") return { ref: elements[k + 1], noDeref };
    if (value === undefined || !value.startsWith("-"))
      return { ref: elements[k], noDeref };
    if (value === "--no-deref") noDeref = true;
    if (UPDATE_REF_FLAGS.has(value)) continue;
    if (!SHORT_CLUSTER_RE.test(value)) return { ref: undefined, noDeref };
    if (value.endsWith("m")) k++;
  }
  return { ref: undefined, noDeref };
}

/** The fix a literal or `format!` ref earns, null for a ref outside
 *  refs/heads/, undefined when `ref` is neither. A literal HEAD deletes the
 *  branch it names unless --no-deref; a template is outside refs/heads/ only
 *  when its fixed lead names a literal namespace. Both read the value as Rust
 *  cooks it, and refs/heads/ in any ASCII letter case: a case-folding disk
 *  deletes the loose branch through refs/HEADS/<name> (measured, git 2.51.1,
 *  NTFS). */
function spelledRefFix(ref, noDeref) {
  const value = diffArgLiteral(ref);
  if (value !== undefined) {
    if (/^refs\/heads\//i.test(value)) return LOCAL_BRANCH_DELETE_FIX;
    if (value === "HEAD" && !noDeref) return LOCAL_BRANCH_DELETE_FIX;
    return null;
  }
  // A method chained onto format!(…) beyond the stripped tails can rewrite it.
  const open = /^format\s*!\s*[([{]/.exec(ref)?.[0].length;
  if (open !== undefined && open + bracketBody(ref, open - 1).length + 1 !== ref.length)
    return OPAQUE_DELETE_REF_FIX;
  const template = formatTemplate(ref);
  if (template === undefined) return undefined;
  if (template === null) return OPAQUE_DELETE_REF_FIX;
  if (/refs\/heads\//i.test(template)) return LOCAL_BRANCH_DELETE_FIX;
  return /^refs\/[^/{}]+\//.test(template.split("{")[0])
    ? null
    : OPAQUE_DELETE_REF_FIX;
}

/** The fix the ref element of an `update-ref -d` group earns, null when it
 *  names a ref outside refs/heads/. What it reads is check M's header. */
function deleteRefFix(element, noDeref) {
  const ref = element === undefined ? "" : deleteRefText(element.text);
  const spelled = spelledRefFix(ref, noDeref);
  return spelled === undefined ? OPAQUE_DELETE_REF_FIX : spelled;
}

/** Check M over one file. `corpus.primitive` turns true on reading the
 *  primitive's own `update-ref -d` group (git/branches.rs, fn
 *  delete_branch_ref_at), which reportEmptyBranchDeleteScope requires. */
export function checkLocalBranchDeletes(
  file,
  _src,
  lines,
  hits,
  allowlist = LOCAL_BRANCH_DELETE_ALLOWLIST,
  corpus = undefined,
) {
  const { code, masked, unterminated } = lexRust(lines.join("\n"));
  const lineOf = (at) => code.slice(0, at).split("\n").length;
  const report = (at, fn, fix, failClosed = false) =>
    hits.push({
      file,
      line: lineOf(at),
      fn,
      allowlisted:
        !failClosed && allowlist.some((e) => e.file === file && e.fn === fn),
      fix,
      ...(failClosed ? { failClosed } : {}),
    });
  if (unterminated >= 0) {
    report(
      unterminated,
      "<unreadable>",
      "check M: a literal or comment opening here never closes — fix the source, or the lexer in scripts/check-rust-invariants.mjs",
      true,
    );
  }
  const tests = testModuleSpans(masked);
  const functions = rustFunctions(masked);
  const opens = new Set([...masked.matchAll(/\[/g)].map((m) => m.index));
  for (const m of masked.matchAll(/\bvec\s*!\s*[({]/g)) {
    opens.add(m.index + m[0].length - 1);
  }
  for (const at of opens) {
    if (tests.some(([s, e]) => at > s && at < e)) continue;
    const body = bracketBody(code, at);
    const end = at + body.length + 1;
    const elements = argvElements(body);
    const values = elements.map((e) => diffArgLiteral(e.text));
    if (!values.includes("branch") && !values.includes("update-ref")) continue;
    const fn = functions.filter((f) => at > f.open && at < f.close).at(-1);
    const name = fn?.name ?? "<top level>";
    const stack = [];
    let bounded = code[end] === ")]}"["([{".indexOf(masked[at])];
    for (let k = at; k <= end && bounded; k++) {
      const ch = masked[k];
      if ("([{".includes(ch)) stack.push(ch);
      else if (")]}".includes(ch)) {
        if (stack.pop() !== "([{"[")]}".indexOf(ch)]) bounded = false;
      }
    }
    if (!bounded || stack.length) {
      report(
        at,
        name,
        "check M: cannot bound this git argv group — fix its delimiters or extend the parser",
        true,
      );
      continue;
    }
    let verb;
    for (let k = 0; k < values.length; k++) {
      const value = values[k];
      if (value === undefined) break;
      if (!value.startsWith("-")) {
        verb = k;
        break;
      }
      if (GIT_VALUE_OPTIONS.has(value)) k++;
    }
    const flags = verb === undefined ? values : values.slice(verb + 1);
    // Without a resolved verb, git branch's options are not known to apply: no skip.
    const branchFlag = hasBranchDeleteFlag(flags, verb !== undefined);
    const refDelete = flags.some(isRefDeleteFlag);
    if (verb === undefined) {
      if (
        (values.includes("branch") && branchFlag) ||
        (values.includes("update-ref") && refDelete)
      )
        report(
          at,
          name,
          "check M: cannot resolve the verb of this group holding a branch or update-ref delete flag — use a literal git verb or extend the parser",
          true,
        );
      continue;
    }
    if (values[verb] === "branch") {
      if (branchFlag) report(at, name, LOCAL_BRANCH_DELETE_FIX);
    } else if (values[verb] === "update-ref" && refDelete) {
      if (corpus && file === "git/branches.rs" && name === "delete_branch_ref_at")
        corpus.primitive = true;
      const { ref, noDeref } = updateRefOperand(
        elements.slice(verb + 1),
        values.slice(verb + 1),
      );
      const fix = deleteRefFix(ref, noDeref);
      if (fix) report(at, name, fix);
    }
  }
}

/** A run whose corpus never held the primitive's own `update-ref -d` read
 *  nothing check M exists for: a hit, never a pass. */
export function reportEmptyBranchDeleteScope(hits, corpus) {
  if (corpus?.primitive !== true)
    hits.push({
      file: "git/branches.rs",
      line: 0,
      fn: "<empty scope>",
      allowlisted: false,
      failClosed: true,
      fix: BRANCH_DELETE_SCOPE_FIX,
    });
}

// ---------------------------------------------------------------------- main

function main() {
  const hangGuardCorpus = { definition: false, spans: 0 };
  const hangGuard = {
    name: "L. test git spawns on the product timeout",
    run: (file, src, lines, hits) =>
      checkTestHangGuard(
        file,
        src,
        lines,
        hits,
        TEST_HANG_GUARD_ALLOWLIST,
        hangGuardCorpus,
      ),
    allowlist: TEST_HANG_GUARD_ALLOWLIST,
    note: TEST_HANG_GUARD_NOTE,
    hits: [],
  };
  const branchDeleteCorpus = { primitive: false };
  const branchDelete = {
    name: "M. local branch ref delete outside the primitive",
    run: (file, src, lines, hits) =>
      checkLocalBranchDeletes(
        file,
        src,
        lines,
        hits,
        LOCAL_BRANCH_DELETE_ALLOWLIST,
        branchDeleteCorpus,
      ),
    allowlist: LOCAL_BRANCH_DELETE_ALLOWLIST,
    hits: [],
  };
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
    {
      name: "F. short ref names",
      run: checkShortRefNames,
      allowlist: SHORT_REF_ALLOWLIST,
      hits: [],
    },
    {
      name: "G. bare branch revs",
      run: checkBareBranchRevs,
      allowlist: BARE_REV_ALLOWLIST,
      hits: [],
    },
    {
      name: "H. merge into a checkout without the ignored-file guard",
      run: checkMergeIgnoredGuard,
      allowlist: MERGE_GUARD_ALLOWLIST,
      note: MERGE_GUARD_NOTE,
      hits: [],
    },
    {
      name: "I. test-held update-marker branch names",
      run: checkTestMarkerBranches,
      allowlist: TEST_MARKER_ALLOWLIST,
      hits: [],
    },
    {
      name: "J. gh exit read as absence",
      run: checkGhExitAbsence,
      allowlist: GH_EXIT_ABSENCE_ALLOWLIST,
      hits: [],
    },
    {
      name: "K. diff argv bypass external drivers",
      run: checkDiffExternalDrivers,
      allowlist: DIFF_DRIVER_ALLOWLIST,
      hits: [],
    },
    hangGuard,
    branchDelete,
  ];

  const files = rustFiles(SRC);
  reportEmptyGhScope(
    CHECKS,
    files.map((path) => relative(SRC, path).replace(/\\/g, "/")),
  );
  for (const path of files) {
    // Normalise CRLF: on Windows a git checkout materialises these files with
    // CRLF, and a trailing `\r` would leak into every reported line.
    const rel = relative(SRC, path).replace(/\\/g, "/");
    const src =
      testMarkerCorpus?.get(rel) ??
      readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const lines = src.split("\n");
    for (const check of CHECKS) check.run(rel, src, lines, check.hits);
  }
  reportEmptyHangGuardScope(hangGuard.hits, hangGuardCorpus);
  reportEmptyBranchDeleteScope(branchDelete.hits, branchDeleteCorpus);

  let failed = false;
  for (const check of CHECKS) {
    const violations = check.hits.filter((h) => !h.allowlisted);
    const allowlisted = check.hits.length - violations.length;
    const { failing: stale, retired } = splitStaleEntries(
      check.allowlist,
      check.hits,
    );
    for (const e of retired) {
      process.stdout.write(
        `${check.name}: NOTE src-tauri/src/${e.file} fn ${e.fn} no longer matches (${e.retiring}) — remove its allowlist entry\n`,
      );
    }
    const note = check.note ? `  ${check.note}\n` : "";
    if (violations.length === 0 && stale.length === 0) {
      process.stdout.write(
        `${check.name}: OK (${files.length} files, ${allowlisted} allowlisted)\n${note}`,
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
    process.stderr.write(note);
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
