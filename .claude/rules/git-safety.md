# Hard safety rules (always loaded — violations have destroyed user state before)

> Excerpted from `.claude/skills/gd-conventions/SKILL.md` (the canonical playbook — the
> conventions-sync rule updates every file that states the changed rule, wherever it is
> restated: this excerpt, the repo `AGENTS.md`, the agent definitions, and any carrier
> added later). `scripts/check-rule-mirrors.mjs` holds the gated list for the git
> whitelist (the codex spec preamble restates it condensed, synced by hand). Consult
> that skill before writing any code here.

1. **Git is a whitelist.** Permitted: `git --no-pager diff / status / log / show` and
   `git branch --list`, each optionally prefixed with `-C <path>` to address a task
   worktree. Everything else — commit, add/stage, checkout, reset, stash, rm, clean,
   push, pull, fetch, merge, rebase, tag, branch create/delete, worktree, remote,
   config — is forbidden, even "just to test". The user commits their own work,
   possibly in parallel with your session.
2. **No stray files.** Create only what your task calls for. Scratch files go in the
   session scratchpad or `C:/temp`, never the repo. (One exception, for runs that may
   create files: the LF-copy gate's `__cigate__<name>` sibling, deleted after the
   check — reviewers never create it; see rule 7.)
3. **Don't edit `src/components/ui/`** — vendored primitives; fix at the call site. That
   folder's `README.md` inventories sanctioned local modifications.
4. **Never repo-wide `cargo fmt`** in `src-tauri`. New files only: `rustfmt <that file>` —
   and never on a `mod.rs` (rustfmt follows `mod` declarations into every child file).
5. **Report from evidence** — verification claims come from command output in this
   session, never memory. Quote failures verbatim.
6. **`gd/session/*` branches are filtered from every branch surface** and never deleted —
   the user dogfoods agent sessions on them; deleting one breaks Resume.
7. **`pnpm lint` is a rewrite, not a check** (`biome check --write` over `src/` AND
   `site/`). Check form: `pnpm exec biome check ./src/`. In a task worktree that check
   false-fails on CRLF, so the remedy splits by role. WRITERS: use the per-file LF-copy
   `biome ci` gate (gd-conventions), or whatever the spec's Verification field names.
   REVIEWERS: run the check-only form scoped to the package's own files, and in a fresh
   worktree treat tree-wide formatting as unverifiable and report it as such — never
   create files (an LF copy is a file), never any `--write` form.
