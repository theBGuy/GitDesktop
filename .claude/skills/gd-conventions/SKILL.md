---
name: gd-conventions
description: GitDesktop repo playbook — hard safety rules, frontend and Rust/Tauri conventions, verification commands, and hard-won gotchas that are NOT in CLAUDE.md. Consult this before writing, refactoring, or reviewing ANY code in this repo, even for small changes. Preloaded into the implementer and spec-reviewer subagents; the main conversation should read it before direct implementation work too.
---

# GitDesktop conventions & gotchas

You are working in the user's real repository. CLAUDE.md covers the project
brief and docs-sync; this file adds what past sessions learned the hard way.
Where this file and generic best practice disagree, this file wins.

## Hard rules (violations have destroyed user state before)

1. **Git is a whitelist.** Permitted: `git --no-pager diff / status / log /
   show` and `git branch --list`. Everything else — commit, add/stage,
   checkout, reset, stash, rm, clean, push, pull, fetch, merge, rebase, tag,
   branch create/delete, worktree, remote, config — is forbidden, even "just
   to test". The user commits their own work, possibly in parallel with your
   session; a past subagent's stray commit wiped `.gitignore` and broke the app.
2. **No stray files.** Create only what your task calls for. Scratch files go
   in the session scratchpad or `C:/temp`, never the repo; destructive
   experiments happen in a throwaway repo under `C:/temp`.
3. **Don't edit `src/components/ui/`** — vendored shadcn/Base UI primitives.
   Fix at the feature/call-site level.
4. **Never repo-wide `cargo fmt`** in `src-tauri` (~35 files of collateral).
   New files only: `rustfmt <that file>`.
5. **Report from evidence.** Verification claims come from command output in
   this session, never memory. Quote failures verbatim.

## Verification commands (allowlisted — run, don't ask)

```sh
pnpm build                             # tsc + bundle — the frontend gate
pnpm exec biome check ./src/           # lint/format CHECK (no mutation)
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cd site && pnpm build                  # when the marketing site changed
```

Frontend changes run the first pair; Rust changes add the cargo pair. Not
"done" until green.

⚠ **`pnpm lint` is a rewrite, not a check** — it runs
`biome check --write ./src/`, mutating every file under `src/` including the
user's parallel work. Implementers fix only their own files via
`pnpm exec biome check --write <files in scope>`; reviewers never run any
`--write` form.

⚠ **`biome check` false-fails on CRLF (this Windows worktree).** autocrlf checks
files out CRLF, and `biome check` (formatter included) flags a CR on **unedited**
files as an error — a red result that isn't yours. To verify YOUR change, run
`pnpm exec biome lint <your files>` (lint only, no formatter) plus
`git diff --numstat` (content-only edits show small, balanced counts; a whole-file
EOL flip shows huge matched +/−). Never "fix" it by converting line endings.

## Frontend conventions

**React best practices.** Before writing or refactoring any React component or
hook, invoke the `vercel-react-best-practices` skill (Vercel's 70-rule
performance + correctness playbook) and apply it as you write — it does not
auto-load, so pull it in yourself; don't defer it to an after-the-fact review pass.

**Design tokens.** Mono + dark + one mint accent; semantic state tokens in
`src/App.css`: `--success`, `--warning`, `--info`, `--merged`; danger is
`--destructive`. No hardcoded green/amber/red classes in new code (a few
*intentional* pre-existing hardcodes exist, e.g. file-list status colors —
leave them, don't re-flag them). Never convey meaning by color alone (WCAG AA).

**Keyboard-first.** Every new selectable list gets arrow-key navigation in
the same change — an invariant, not polish. Destructive paths stay behind
confirmation.

**Command palette.** Any new tab/surface/action needs an ACTIONS entry in
`src/lib/hotkeys/registry.ts` + `useHotkeyAction` wiring in the same change
(`defaultBinding: null` = palette-only). Missed twice before.

**Mod-key display.** Shortcut hints render via `isMac` / `formatBinding` from
`@/lib/hotkeys/binding` — never a literal ⌘ or "Ctrl+"; only labels branch.

**Patterns the user has ruled on:**
- No hover-revealed per-row buttons — contextual actions are always-visible,
  or live in keyboard/context-menu/toolbar.
- Truncated user/repo content gets a `title` tooltip, added
  only-when-actually-clipped; Base UI Select clips at the POPUP — measure the
  `SelectItem`, not the span.
- A disabled submit explains why via the field's `warning` hint; disabled
  menu items carry the reason in `title` (precedent: TagsPanel).
- API-impossible features get an explicit "… on GitHub/GitLab" link item,
  not a silent gap.
- Never degrade a surface to dodge machinery: no plain `<pre>` where the app
  highlights, no spinner where skeletons exist.
- Avatars: vendored `Avatar`/`AvatarImage`/`AvatarFallback` (canonical:
  `AuthorAvatar` in `src/features/conversations/Thread.tsx`) — never
  hand-rolled `<img>`/background divs. Biome-ignore comments use `/*`, not `/**`.

**Layout gotchas.** `DialogContent` is a grid — truncating flex content needs
`min-w-0` on the grid item; cap tall dialogs at `max-h-[85vh]`. Link-styled
clickables add `cursor-pointer` at the call site (vendored Button sets none).

**State & rendering gotchas.**
- **`gd/session/*` branches are filtered from every branch surface** (lists,
  pickers, bulk actions) — the user dogfoods agent sessions on them; deleting
  one breaks Resume. Hard invariant.
- `<Activity>`-hidden subtrees still render and fetch — gate query `enabled`
  on the active tab; gate agent-surface notifications on the tab being watched.
- Zustand + view transitions: `openRepo`/`closeRepo`/`openSettings` issue
  deferred sets that clobber a plain `set()` right after — navigate in ONE
  atomic action.
- React Compiler already memoizes call results — don't add `useMemo` for perf
  reflexively (~40% false-positive rate); render reads of mutable module
  state go stale under it.
- Virtualized lists: a variable-height first row races `measureElement` —
  mount the virtualizer in a child gated on data (`docs/list-virtualization.md`).
- Multi-toggle settings batch behind a Save/Discard bar (draft + dirty), not
  per-toggle auto-save; a single discrete select may apply-on-change.
- Repo-content config features (FUNDING.yml, CODEOWNERS, …) scaffold the
  local file for the user to commit — never write repo content via an API.

## Rust / Tauri conventions

- **Large ints over IPC:** snowflake/`u64` ids lose precision as JS numbers —
  serialize as strings end-to-end.
- **GraphQL nullability:** fields without `!` deserialize into `Option<T>`;
  never `unwrap_or_default()` a `from_value`; confirm a field exists before
  querying it.
- **Sync Tauri commands run on the main thread** — take the value under the
  lock, drop the guard, then block; prefer `try_wait`-style non-blocking.
- **Untrusted JSON** (CLI output, forge APIs): TS derivers `typeof`/shape-guard
  each field with `try/catch` per item; Rust uses tolerant serde (`Option<T>`,
  null-tolerant defaults) over strict shapes. Grammar-validate command/URL
  values either side.
- **Windows spawning:** never pass multi-line argv to `.cmd` shims
  (BatBadBut rejection) — feed multi-line input via stdin.
- **Forge gating:** per-action `Implemented` flags. Shared-with-GitHub
  controls gate on `canWrite || forgeFeatureReady` (GitHub must be zero-diff);
  provider-only controls gate on `forgeFeatureReady` alone with the flag
  `false` for GitHub; shared controls with different per-provider ids
  guard/dispatch on the common key and carry both id pairs.
- A server-constrained field in a shared PATCH rejects the whole request when
  ineligible — model as `Option` + eligibility check; hide/omit when ineligible.

## Code comments

Constraint-statements only: the decision + one sentence of why (≤3 lines
typical, ~6 for genuinely multi-constraint blocks). KEEP-class content:
invariants, ordering/locking rules, deliberate non-obvious choices, cross-module
and IPC contracts, empirically-learned external-API/platform behavior, public-API
doc contracts. NEVER: what the code used to do or replaced, PR/issue/review
references, how a bug was caught, worked numeric examples where the principle
sentence suffices, narrating the next line, arguing the change is correct (the
commit message and PR own the story). Trim any comment you touch to this
standard.
Carve-out: measured figures a later reader would otherwise have to re-measure
(payload sizes, timed runs) may stay and cite their source.

⚠ Rust doc-comment rewrites are a clippy surface — a `///` line starting with a
Markdown bullet char (`+`/`-`/`*`) mid-sentence turns the following lines into
`doc_lazy_continuation` lints. Run the Verification block's clippy line after any
doc-comment edit.

## Docs-sync (same change, unprompted)

CLAUDE.md defines the full rule; short form for a user-facing feature: README
*Highlights/Features* bullet → site `capabilities` (+ `FeatureRow` when it
warrants; non-AI features in both site views) → in-app guide
`src/features/help/content.ts` → a `changelog.d/<added|changed|fixed>-<slug>.md`
fragment (its body is the finished Keep-a-Changelog bullet). **Never hand-edit
`## [Unreleased]` in `CHANGELOG.md`** — it's *generated* from the fragments at
release time; one file per change keeps parallel branches conflict-free.

**In a delegated package the spec's `Docs-sync:` field is authoritative:**
apply exactly what it lists (those files are thereby in scope); "orchestrator
handles" → skip docs; silent spec + user-facing change → flag the gap in your
report, don't exceed scope.

Help-content specifics: shortcuts are `{{kbd:action-id}}` / `{{key:…}}`
tokens, never literal keys — but a `defaultBinding: null` (palette-only)
action gets **no token at all** (it renders the literal word "unbound");
mention it as plain prose. AI-only content gated with `ai: true` +
`{{ai}}…{{/ai}}`. Verify every claim against code; sweep stale "coming soon"
mentions when a feature ships.

## Definition of done

Verification green (failures quoted verbatim, passes one line each); edge
cases exercised (first/last/empty, boundaries); keyboard nav + palette
registration wired for new UI; docs-sync per the spec's `Docs-sync:` field
(gaps flagged, never silently skipped); footprint sweep via
`git --no-pager status` accounting for YOUR files only (the tree may hold the
user's parallel WIP and sibling packages — don't touch or explain what isn't
yours); nothing committed, ever.
