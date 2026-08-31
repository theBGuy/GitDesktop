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
   Fix at the feature/call-site level. That folder's `README.md` inventories
   the sanctioned local modifications (a re-vendor silently reverts them);
   any future sanctioned edit updates it in the same change.
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
pnpm run checks                        # guard scripts + self-tests — CI quality.yml guards job
```

Frontend changes run the first pair; Rust changes add the cargo pair. Not
"done" until green.

⚠ **`pnpm lint` is a rewrite, not a check** — it runs `biome check --write
./src/ ./site/`, mutating every file under `src/` AND `site/` including
the user's parallel work. Implementers fix only their own files via the
targeted `pnpm exec biome check --write <files in scope>`; reviewers never
run any `--write` form.

⚠ **`biome check` false-fails on CRLF (this Windows worktree).** autocrlf checks
files out CRLF, and `biome check` (formatter included) flags a CR on **unedited**
files as an error — a red result that isn't yours. The one trustworthy local
gate is the CI form over LF-normalized copies: copy each edited file to a
`__cigate__<name>` sibling (CRLF→LF), run `pnpm exec biome ci` on the copies,
delete them after. `biome lint` is NOT a gate — it skips the formatter and
assist layers `biome ci` enforces (a measured false clean, three CI reds).
Never "fix" a red by converting line endings.

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
the same change (`listKeyboardNav` in `src/lib/list-keyboard-nav.ts`) — an
invariant, not polish. A list container that co-hosts a text editor (inline
edit field, reply box) passes `ignoreTextEntry` so arrows keep moving the
caret; leave it off where arrows deliberately drive nav from a filter input.
Destructive paths stay behind confirmation via the
shared `useConfirm`/`ConfirmDialogHost` primitive (`src/lib/stores/confirm.ts`,
host in `src/components/confirm-dialog-host.tsx`) — never a bespoke confirm
dialog. Commit-level destructive prompts (checkout, revert, cherry-pick, undo)
share their wording through `src/features/history/commit-confirms.ts`: a new
route to one of those ops imports the existing prompt, never re-spells it.

**Command palette.** Any new tab/surface/action needs an ACTIONS entry in
`src/lib/hotkeys/registry.ts` + `useHotkeyAction` wiring in the same change
(`defaultBinding: null` = palette-only). Missed twice before. Labels use the
words the user reads on screen. Action-text search lives in
`src/lib/hotkeys/search.ts` (`queryTokens` + `matchesActionText`), shared by the
palette and Settings → Keyboard so a query can't hit in one and miss in the
other — a new surface searching ACTIONS imports it rather than re-spelling the
match. It AND-s the query's whitespace-separated tokens over label + category
with hyphens stripped from both sides, so word order, gaps, and hyphenation cost
nothing ("cancel pipeline" finds "Cancel workflow run/pipeline", "rerun" finds
"Re-run…", and #255's "ai excluded" against a tab labeled "AI excluded" would
match today). Each token still has to be a literal substring of what remains, so
a label built from different words than the surface shows stays unfindable.
Keyboard's binding arms deliberately stay literal — key text means its
separators.

**Mod-key display.** Shortcut hints render via `isMac` / `formatBinding` from
`@/lib/hotkeys/binding` — never a literal ⌘ or "Ctrl+"; only labels branch.

**Patterns the user has ruled on:**
- No hover-revealed per-row buttons — contextual actions are always-visible,
  or live in keyboard/context-menu/toolbar.
- Truncated user/repo content gets a `title` tooltip, added
  only-when-actually-clipped via `clipTitle`/`clipTitleFromText`
  (`src/lib/clip-title.ts`) — never inline: blanking with `title=""`
  suppresses a titled ancestor's tooltip, and the `inline-clip-title` guard
  in `pnpm run checks` fails on rewrites. Base UI Select popup rows route
  through `SelectClipText` (`src/components/select-clip-text.tsx`), which
  must be the row's SOLE child. A bare truncate child never engages there and
  an item-level handler is dead once the row span self-bounds (the
  `select-item-clip-title` guard fails on both); the closed field takes
  `onMouseEnter={clipTitleFromText}` on its `SelectValue`.
- A `SelectControl`/`SelectField` `items` Record silently reorders integer-like
  keys to the front (JS object semantics) — any picker whose option values are
  user-supplied identifiers that can be all-digits (logins, slugs) must pass
  the `order` prop with the sequence it means (exactly the keys of `items`).
- Per-file `+added -deleted` counts render through `DiffStat`
  (`src/components/diff-stat.tsx`) — plain numbers in, optional `isBinary`
  (a muted `bin`) and `format` (Insights abbreviates via `fmt`); never
  hand-rolled, and the `hand-rolled-diff-stat` guard in `pnpm run checks`
  fails on a new pair.
- Disabled actions explain why via `DisabledReasonButton`
  (`src/components/disabled-reason-button.tsx`) — reason as tooltip + AT
  announcement; menu/popover trigger sites keep the reason on a titled span
  wrapper (its doc comment shows the idiom — a bare `title` on a disabled
  element never shows). A disabled submit may instead explain via the field's
  `warning` hint. Raw-`<button>` sites the vendored Button can't size (reaction
  chips, the discussion upvote chip) take the SAME contract from the shared
  `useDisabledReason` hook + `ARIA_DISABLED_CLASS`
  (`src/lib/use-disabled-reason.ts`) — never hand-rolled.
- A conversation surface's own actions sit before the submit button via
  `CommentComposer`'s `leadingActions` slot when submit is the row's last
  action (the issue views); a surface whose right-slot action is itself a
  primary (Approve / Review… on the PR views) keeps it in `actions`, which
  renders after submit — the caller owns the row layout up to that boundary,
  spacers included.
- The AI-generate chord in a dialog goes through `useGenerateChord`
  (`src/lib/hotkeys/useGenerateChord.ts`) — never a hand-rolled handler. Its
  invariants: effective-binding read (null = fully inert), `eventToBinding`
  match, `preventDefault` before `enabled` on any surface WITH a generator,
  run only under the visible button's gate, swallow-don't-cancel while
  generating, handler mounted on `DialogContent` (the X close is a form
  sibling). The hook returns the `hint` string so buttons can't forget it.
  Recorded exception: surfaces with several per-row generators and no
  focused-row concept (Edit history's reword buttons) carry no chord.
- Worktree actions gate on in-flight removal/promote state: menu items disable
  with the parenthetical reason riding the label (a disabled menu item can't
  carry a tooltip), and mutation choke points re-check at fire time —
  `useIsRemovingWorktree`/`useWorktreeRemovals` for render,
  `refuseWhileLeaving` (WorktreesDialog.tsx) plus `isWorktreePromoting`
  (worktree-removal store; fire-time only, deliberately non-reactive) for the
  refusal toast.
- Per-variant copy/labels/glyphs are `Record` lookups, never ternary chains:
  an exact union discriminant gets a total `Record` (compiler
  exhaustiveness); a wide wire string gets `Partial<Record>` + explicit
  fallback; genuinely mixed-predicate chains stay ternaries (precedents:
  `PICKER_COPY`, `OP_LABELS`, `KIND_GLYPH`).
- API-impossible features get an explicit "… on GitHub/GitLab" link item,
  not a silent gap.
- Never degrade a surface to dodge machinery: no plain `<pre>` where the app
  highlights, no spinner where skeletons exist.
- A lazy panel's `Suspense` fallback is `LazyPanelFallback`
  (`src/components/lazy-panel-fallback.tsx`) — never `fallback={null}`: a blank
  region has no aria-busy and announces nothing to assistive tech.
- Loading placeholders for a bordered row list are `ListRowSkeletons`
  (`src/components/list-row-skeleton.tsx`), with `lines` matching the real row's
  line count and `name` naming the content ("Loading pull requests…") — flush
  `border-b px-3 py-2` rows, never a padded stack of fixed-height bars, so a
  cold load doesn't shift the list as rows arrive. It carries the group's
  `aria-busy` + sr-only status; `ListRowSkeleton` is the single row it wraps,
  not a call-site component.
- Avatars: vendored `Avatar`/`AvatarImage`/`AvatarFallback` (canonical:
  `AuthorAvatar` in `src/features/conversations/Thread.tsx`) — never
  hand-rolled `<img>`/background divs. Biome-ignore comments use `/*`, not `/**`.
- Shared-ContextMenu suppression for non-target right-clicks goes through
  `suppressContextMenu` (`src/lib/context-menu.ts`) — `preventDefault` alone
  still opens Base UI's menu as an empty popup.
- CI copy comes from `src/features/actions/status.tsx`, never hand-spelled: the
  provider's noun via `ciRunNoun` (labels and toasts derive from it, so no
  surface says "run" beside another's "pipeline"), the gitlab-or-bitbucket test
  via `isPipelineProvider`, and the re-run offers, titles, and cancel wording
  via `rerunOffers`/`RERUN_TITLES`/`cancelLabel` — shared so the runs list and
  the run detail view can't drift.
- Header meta fields (the PR header's label/value grid: labels, assignees,
  projects, reviewers) render through `MetaValueCell` / `MetaFieldLabel`
  (`src/components/meta-field-cells.tsx`) — never a hand-rolled `role="group"`
  value cell or a re-spelled empty-dash placeholder. A forge user inside one of
  those cells is a `UserChip` from the same module — never a hand-rolled
  avatar + truncating-label span — and any chip that shares a value cell with
  another but keeps its own markup wears the `USER_CHIP_CLASS` box. The
  pickers emit those two cells only under their `cells` prop; unset, each still
  renders its own inline trigger+chips row. Scope is that grid alone:
  `MrTimeTracking` (GitLab-only) deliberately keeps its own full-width row below
  it, and form-dialog field groups (CreatePrDialog / CreateIssueDialog's `Label`
  + `aria-labelledby` wrappers) are a richer separate pattern this rule doesn't
  govern.

**Layout gotchas.** `DialogContent` is a grid — truncating flex content needs
`min-w-0` on the grid item; cap tall dialogs at `max-h-[85vh]`. Link-styled
clickables add `cursor-pointer` at the call site (vendored Button sets none).
Main-side panels (children of RepositoryView's `<main>`, a display:block host) root
with `flex h-full min-h-0 flex-col` — `flex-1` is inert there, and the panel's
natural height document-scrolls the whole tab, chrome included (#261's
InsightsBoard was the outlier; every other main-side panel already complies).
Tailwind animation overrides need the `!` important modifier — tw-merge doesn't
dedupe the animate group, so `animate-none` vs an existing `animate-in` is a
build-order lottery (tailwind-merge 3.6.0; in-repo: `data-open:animate-none!`).

**State & rendering gotchas.**
- **`gd/session/*` branches are filtered from every branch surface** (lists,
  pickers, bulk actions) — the user dogfoods agent sessions on them; deleting
  one breaks Resume. Hard invariant.
- `<Activity>`-hidden subtrees still render and fetch — gate query `enabled`
  on the active tab; gate agent-surface notifications on the tab being watched.
- Open-TRANSITION resets ride `useSeedOnOpen` (`src/lib/use-seed-on-open.ts`) —
  a bare `useEffect(() => { if (open) seed(); }, [open])` re-fires when a hidden
  `<Activity>` tab re-mounts its effects on show, wiping the user's draft. The
  carve-out: data-arrival seeds (`[open, thatQuery.data]`) and `onOpenChange`
  seeds stay bare, and each must be idempotent — never stomping a user's pick.
  The `seed-effect-on-open` guard allowlists the recorded ones.
- Zustand + view transitions: `openRepo`/`closeRepo`/`openSettings` issue
  deferred sets that clobber a plain `set()` right after — navigate in ONE
  atomic action.
- React Compiler already memoizes call results — don't add `useMemo` for perf
  reflexively (~40% false-positive rate); render reads of mutable module
  state go stale under it.
- Never read the clock in render — live times ride the shared 30s ticker:
  `<RelativeTime>` / `<ElapsedTime>`, `useRelativeNow()` for composed
  strings, `formatDurationBetween` for finished spans
  (`src/components/relative-time.tsx`, `src/components/elapsed-time.tsx`,
  `src/lib/time.ts`).
- Feed/timeline children mixing entity types prefix React keys per slot
  (`comment-${id}`, `event-${id}`) — bare cross-type ids collide and React
  keeps the earlier duplicate's DOM alive.
- Queries with identity axes beyond the repo (entity id, lens, state) keep
  previous data via `keepPreviousDataForKeyAxes` (`src/lib/git/queries.ts`),
  and callers gate derived UI on `!isPlaceholderData` — a disabled query
  still renders its placeholder.
- Virtualized lists: a variable-height first row races `measureElement` —
  mount the virtualizer in a child gated on data (`docs/list-virtualization.md`).
- Multi-toggle settings batch behind a Save/Discard bar (draft + dirty), not
  per-toggle auto-save; a single discrete select may apply-on-change.
- Repo-content config features (FUNDING.yml, CODEOWNERS, …) scaffold the
  local file for the user to commit — never write repo content via an API.
- A mutation whose host can unmount mid-flight (a dialog closable by Esc / ✕ /
  backdrop, a keyed remount) rides `await mutateAsync` continuations, never
  `.mutate(vars, { onSuccess, onError })` — react-query drops per-call
  callbacks when the observer unmounts, so the toast, navigation, or cleanup
  that lived in them silently never runs. The house idiom is `form.ts`'s
  awaited-submit convention (`SquashDialog` in
  `src/features/history/RewriteDialogs.tsx` is the reference).
- A follow-up that needs the DOM from a state flip (focus a just-revealed
  input, re-pin a grown scroll region) never rides a bare
  `requestAnimationFrame` from the event handler: when the state lives in
  react-query, the notify-batched re-render can land AFTER that rAF, so the
  callback hits a still-hidden node and silently no-ops. Arm a pending ref and
  consume it in a `useLayoutEffect` keyed on the flipped state's commit
  (reference: `CommentComposer`'s collapse/expand pending flags); an rAF
  belongs inside that effect only to outlast Base UI's close-time focus-return.

## Rust / Tauri conventions

- **Large ints over IPC:** snowflake/`u64` ids lose precision as JS numbers —
  serialize as strings end-to-end.
- **Advisory probes fail SAFE toward inaction:** a probe whose verdict can
  unlock a destructive offer (`BranchRewriteStatus` is the model) keeps its
  VERDICT "unknown" on any failed sub-probe, and never ships a defaulted
  count PRESENTED AS MEASURED — the pre-verdict shape zeroes the counts, and
  the null verdict is what makes them unreadable (every consumer gates on
  the verdict first). Callers render exactly what they render without the
  data. The unlock condition must rest on measured evidence (e.g. rewrite =
  reflog miss AND patch-twins present — strong evidence, not proof; the
  failure direction stays inaction), and the destructive action targets the
  measured sha, never a re-resolved ref.
- **GraphQL nullability:** fields without `!` deserialize into `Option<T>`;
  never `unwrap_or_default()` a `from_value`; confirm a field exists before
  querying it.
- **Sync Tauri commands run on the main thread** — take the value under the
  lock, drop the guard, then block; prefer `try_wait`-style non-blocking.
- **Untrusted JSON** (CLI output, forge APIs): TS derivers `typeof`/shape-guard
  each field with `try/catch` per item; Rust uses tolerant serde (`Option<T>`,
  null-tolerant defaults) over strict shapes. Grammar-validate command/URL
  values either side. Third-party timestamps validate before formatting —
  `parseableDate` for ISO strings, `validEpochMs` for epoch numbers
  (`src/lib/time.ts`); never raw `new Date(x)` on forge/CLI data.
- **Windows spawning:** never pass multi-line argv to `.cmd` shims
  (BatBadBut rejection) — feed multi-line input via stdin.
- **User input → git refspecs/argv** routes through the existing chokepoints:
  `validate_ref_name` (git/branches.rs), `validate_tag_name` (git/ops.rs),
  pushes via `build_push_args` (git/remote.rs) — never construct an inline
  refspec or re-derive the validation. Refs reaching a compare-endpoint
  basehead route through `forge::validate_compare_branch`
  (guard: check-rust-invariants check E).
- **Rust tests never read the real settings store** — use the
  `TEST_STORE_DIR` seam in `app_store.rs` (arm 0 of `store_path`). The other
  app-data modules carry their own seams with the opposite arm order
  (`oplog.rs` `GD_OPLOG_DIR`, `review_notes.rs` `GD_REVIEW_NOTES_DIR`:
  env override outranks the `cfg!(test)` temp arm; both ship in release) —
  a new store module mirrors one of these, never resolves app-data bare.
  Concurrency: the MCP server is a second writing process, so both stores'
  read→modify→writes take the cross-process file lock in `store_lock.rs` (a
  `create_new` lock file beside the store, stale-evicted, fail-open) on top of
  their own in-process guards — `oplog.rs` its `OPLOG_LOCK` mutex,
  `review_notes.rs` its `notes_lock()` mutex — with the atomic whole-file
  replace underneath both (torn-file safety, not lost-update safety). The GUI's
  review-notes writes route through the locked `review_notes_set_branch` /
  `review_notes_delete_branch` Tauri commands rather than the plugin store
  (cold-start test mode is the one exception: it aliases the store file and
  has no second writer). A NEW store module with more than one process
  writing adopts `store_lock` — don't assume last-writer-wins is acceptable.
- **Forge gating:** per-action `Implemented` flags. Shared-with-GitHub
  controls gate on `canWrite || forgeFeatureReady` (GitHub must be zero-diff);
  provider-only controls gate on `forgeFeatureReady` alone with the flag
  `false` for GitHub; shared controls with different per-provider ids
  guard/dispatch on the common key and carry both id pairs. Write-access
  axes: availability decides what RENDERS; permission decides what's ENABLED
  (disable-with-reason, never hide); triage is its own lower tier — see
  `src/features/pulls/usePrCapabilities.ts`.
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
(payload sizes, timed runs) may stay and cite their source (a PR or run
reference is fine there).

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
release time; one file per change keeps parallel branches conflict-free. The
`fragment` check is **required** on master and keys on paths — any `src/` or
`src-tauri/` change needs a fragment, the `no-changelog` label, or
`skip-changelog` in the PR title.

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

## Prevention standing rules (owner-adopted 2026-08-15)

- **Tripwire:** a fix that closes a CLASS of defect ships its mechanical guard
  in the same change — a biome `noRestrictedImports` entry, a `scripts/check-*`
  pattern or allowlist rule, or a pinning test. A swept class without a
  tripwire has re-opened before; the sweep alone is not the fix.
- **Class-grep at accept time:** when a review or session finding is accepted,
  grep its class immediately — fix every sibling in the same batch, or record
  the count with a named home. Never leave the Nth instance for a later PR.
- **Conventions-sync:** a change that builds a reusable primitive adds its line
  to THIS file in the same change (the docs-sync rule, applied to idioms).

## Definition of done

Verification green (failures quoted verbatim, passes one line each); edge
cases exercised (first/last/empty, boundaries); keyboard nav + palette
registration wired for new UI; docs-sync per the spec's `Docs-sync:` field
(gaps flagged, never silently skipped); footprint sweep via
`git --no-pager status` accounting for YOUR files only (the tree may hold the
user's parallel WIP and sibling packages — don't touch or explain what isn't
yours); nothing committed, ever.
