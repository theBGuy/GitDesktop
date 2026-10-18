---
paths:
  - "src-tauri/**"
---

# Rust / Tauri quick rules (the most-violated subset)

> Excerpted from `.claude/skills/gd-conventions/SKILL.md` §Rust/Tauri — read that section
> in full before substantive Rust work; this file is the tripwire, not the playbook.

- Never repo-wide `cargo fmt`; new files only via `rustfmt --edition 2021 <file>`, never
  on a `mod.rs` (rustfmt follows its `mod` declarations into every child file).
- Large ints over IPC serialize as strings (u64 loses precision as a JS number).
- GraphQL fields without `!` deserialize into `Option<T>`; never `unwrap_or_default()` a
  `from_value`.
- Untrusted JSON (CLI output, forge APIs): tolerant serde (`Option<T>`, null-tolerant
  defaults); timestamps validate before formatting.
- User input → git refspecs/argv routes through the existing chokepoints
  (`validate_ref_name`, `validate_tag_name`, `build_push_args`,
  `forge::validate_compare_branch`) — never an inline refspec.
- Tests never read the real settings store — `TEST_STORE_DIR` seam in `app_store.rs`;
  new store modules mirror an existing seam and adopt `store_lock` when a second process
  writes.
- Sync Tauri commands run on the main thread — take the value under the lock, drop the
  guard, then block.
- Compound working-tree ops hold the per-repo lock across read → write → stage; the
  non-re-acquiring runner inside, or you deadlock.
- Advisory probes fail SAFE toward inaction: verdict "unknown" on any failed sub-probe;
  destructive actions target the measured sha, never a re-resolved ref.
- Verification: `cargo test` (manifest-path src-tauri) +
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`;
  a `///` line starting with `+`/`-`/`*` mid-sentence lints as `doc_lazy_continuation`.
