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

`.claude/skills/gd-conventions/SKILL.md` is the canonical playbook and
`.claude/rules/repo-safety.md` its always-loaded excerpt of these rules; read
either in the tree.

- **Never edit `src/components/ui/`** — vendored shadcn/Base UI primitives; fix
  at the feature or call site (that folder's `README.md` inventories the
  sanctioned local deltas).
- **Never run repo-wide `cargo fmt`** in `src-tauri`; `rustfmt --edition 2021
  <file>` on individual new files only, never on a `mod.rs` (rustfmt follows
  its `mod` declarations into every child file).
- **`gd/session/*` branches are filtered from every branch surface** and never
  deleted — the user dogfoods agent sessions on them; deleting one breaks
  Resume.
- **`pnpm lint` is a rewrite, not a check.** It is `biome check --write` over
  `src/` AND `site/`; the check form is `pnpm exec biome check ./src/`. In a
  task worktree even that tree-wide check false-fails on CRLF, so the
  trustworthy gate is the per-file LF-copy `biome ci` form (gd-conventions),
  whose `__cigate__<name>` sibling lives beside the original for the length of
  the check and is deleted after, or whatever the spec's Verification field
  names. A read-only run creates nothing and reports tree-wide formatting as
  unverified instead.
- **A skill edited in one tree is edited in both.** The skills you load from
  `.agents/skills/<name>` have a committed twin at `.claude/skills/<name>`, and
  nothing propagates an edit between them — editing only the copy you read
  leaves the other store stale. `scripts/check-skill-mirrors.mjs` is a required
  `guards` step and fails on any difference beyond line endings, the two trees'
  `.claude/`-vs-`.agents/` path references, the `/cmd`-vs-`$cmd` sigil, and
  harness-only frontmatter keys. Skills it deliberately skips are declared in
  that script with their reason, and its header states the one difference the
  path rewrite cannot see.

## Verification commands

- `pnpm build` — typecheck plus frontend bundle. Plain `tsc --noEmit` is a no-op
  in this repo; only `tsc -b` (or `pnpm build`) typechecks.
- `pnpm run checks` — the repo guard scripts CI runs.
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cd site && pnpm build` — the marketing site.

## When the run was given a task spec

Stay strictly inside its stated file scope: a spec that looks wrong, or a fix
that would need a file the spec did not list, is reported back rather than
improvised around. A Permission-denied on a path outside the workspace is an
environment limit — report it, don't work around it.
