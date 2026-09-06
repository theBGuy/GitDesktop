# AGENTS.md — GitDesktop

GitDesktop is an AI-native, keyboard-first Git desktop client (Tauri 2 +
React 19) with an Astro marketing site in `site/`. Codex and other agents that
follow the AGENTS.md convention auto-load this file whatever their role (Claude
sessions load `CLAUDE.md` instead), so it carries repo context and hard
boundaries only.

## Binding context — read before substantive work

`CLAUDE.md` and `.claude/skills/gd-conventions/SKILL.md` are the binding agent
context: the standing brief and the repo playbook of conventions and gotchas.
`CONTRIBUTING.md` holds the human conventions, `PRODUCT.md` the product intent.

## Hard boundaries

- **Git is a whitelist.** Permitted: `git --no-pager diff`, `git --no-pager
  status`, `git --no-pager log`, `git --no-pager show`, `git branch --list` —
  each may be prefixed with `-C <path>` to address a task worktree.
  Every state-mutating git command — commit, add/stage, checkout, reset, stash,
  rm, clean, push, pull, fetch, merge, rebase, tag, branch create/delete,
  worktree, remote, config — is forbidden, even "just to test": the user commits
  their own work, possibly in parallel with this run.
  `.claude/skills/gd-conventions/SKILL.md` is the canonical playbook and
  `.claude/rules/git-safety.md` its always-loaded excerpt; read either in the
  tree.
- In a task worktree the sandbox additionally denies the git commands that write
  the git dir (measured on add, commit, checkout, rm, stash), and a denial there
  is the policy working, not an obstacle to route around. Commands touching only
  worktree files (`git clean`, for one) are **not** blocked, so the whitelist
  above is the only thing protecting them.
- **Repo files are written only when the run is executing a delegated
  work-package spec** (CLAUDE.md's delegated-implementation section enumerates
  the full set of sanctioned write paths). A run handed no spec treats the repo
  as read-only.
- **Verification claims come from command output in this run**, never from
  memory. Quote failures verbatim.
- **Never edit `src/components/ui/`** — vendored shadcn/Base UI primitives; fix
  at the feature or call site (that folder's `README.md` inventories the
  sanctioned local deltas).
- **No tree-wide rewrites.** `pnpm lint` is `biome check --write` over `src/`
  AND `site/` — a rewrite, not a check; the check form is `pnpm exec biome check
  ./src/`. In a task worktree even that tree-wide check false-fails on CRLF, so
  the trustworthy gate is the per-file LF-copy `biome ci` form (gd-conventions),
  or whatever the spec's Verification field names. Never run repo-wide
  `cargo fmt` in `src-tauri`; `rustfmt <file>` on individual new files only.
- **No scratch or temp files inside the repo** — working files belong in the
  session scratchpad or `C:/temp`. The one sanctioned exception: a run that may
  create files judges formatting with the per-file LF-copy `biome ci` gate,
  whose `__cigate__<name>` sibling lives beside the original for the length of
  the check and is deleted after. A read-only run creates nothing and reports
  tree-wide formatting as unverified instead.

## Verification commands

- `pnpm build` — typecheck plus frontend bundle. Plain `tsc --noEmit` is a no-op
  in this repo; only `tsc -b` (or `pnpm build`) typechecks.
- `pnpm run checks` — the repo guard scripts CI runs.
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- `cd site && pnpm build` — the marketing site.

## When the run was given a task spec

Stay strictly inside its stated file scope: a spec that looks wrong, or a fix
that would need a file the spec did not list, is reported back rather than
improvised around. A Permission-denied on a path outside the workspace is an
environment limit — report it, don't work around it.
