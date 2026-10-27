# Repo safety rules (always loaded)

> Excerpted from `.claude/skills/gd-conventions/SKILL.md` (the canonical playbook; a
> change to one of these rules also updates every file that states it: this excerpt
> and the repo `AGENTS.md`). Consult that skill before writing any code here.

1. **Don't edit `src/components/ui/`** — vendored primitives; fix at the call site. That
   folder's `README.md` inventories sanctioned local modifications.
2. **Never repo-wide `cargo fmt`** in `src-tauri`. New files only:
   `rustfmt --edition 2021 <that file>` — and never on a `mod.rs` (rustfmt follows
   `mod` declarations into every child file).
3. **`gd/session/*` branches are filtered from every branch surface** and never deleted —
   the user dogfoods agent sessions on them; deleting one breaks Resume.
4. **`pnpm lint` is a rewrite, not a check** (`biome check --write` over `src/` AND
   `site/`). Check form: `pnpm exec biome check ./src/`. In a task worktree that check
   false-fails on CRLF, so the remedy splits by role. WRITERS: use the per-file LF-copy
   `biome ci` gate (gd-conventions), whose `__cigate__<name>` sibling is deleted after
   the check, or whatever the spec's Verification field names. REVIEWERS: run the
   check-only form scoped to the package's own files, and in a fresh worktree treat
   tree-wide formatting as unverifiable and report it as such — never create files (an
   LF copy is a file), never any `--write` form.
