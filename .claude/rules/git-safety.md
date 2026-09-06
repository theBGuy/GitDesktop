# Hard safety rules (always loaded — violations have destroyed user state before)

> Excerpted from `.claude/skills/gd-conventions/SKILL.md` (the canonical playbook — the
> conventions-sync rule updates all THREE copies: the playbook, this excerpt, and the
> repo `AGENTS.md`). Consult that skill before writing any code here.

1. **Git is a whitelist.** Permitted: `git --no-pager diff / status / log / show` and
   `git branch --list`. Everything else — commit, add/stage, checkout, reset, stash, rm,
   clean, push, pull, fetch, merge, rebase, tag, branch create/delete, worktree, remote,
   config — is forbidden, even "just to test". The user commits their own work, possibly
   in parallel with your session.
2. **No stray files.** Create only what your task calls for. Scratch files go in the
   session scratchpad or `C:/temp`, never the repo.
3. **Don't edit `src/components/ui/`** — vendored primitives; fix at the call site. That
   folder's `README.md` inventories sanctioned local modifications.
4. **Never repo-wide `cargo fmt`** in `src-tauri`. New files only: `rustfmt <that file>`.
5. **Report from evidence** — verification claims come from command output in this
   session, never memory. Quote failures verbatim.
6. **`gd/session/*` branches are filtered from every branch surface** and never deleted —
   the user dogfoods agent sessions on them; deleting one breaks Resume.
7. **`pnpm lint` is a rewrite, not a check** (`biome check --write` over `src/` AND
   `site/`). Check form: `pnpm exec biome check ./src/`. Reviewers never run any
   `--write` form.
