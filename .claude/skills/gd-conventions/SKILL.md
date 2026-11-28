---
name: gd-conventions
description: GitDesktop repo playbook — hard repo rules, frontend and Rust/Tauri conventions, verification commands, and hard-won gotchas that are NOT in CLAUDE.md. Consult this before writing, refactoring, or reviewing ANY code in this repo, even for small changes. Preloaded into the implementer, spec-reviewer and spec-writer subagents; the main conversation should read it before direct implementation work too.
---

# GitDesktop conventions & gotchas

You are working in the user's real repository. CLAUDE.md covers the project
brief and docs-sync; this file adds what past sessions learned the hard way.
Where this file and generic best practice disagree, this file wins.

## Hard rules

1. **Don't edit `src/components/ui/`** — vendored shadcn/Base UI primitives.
   Fix at the feature/call-site level. That folder's `README.md` inventories
   the sanctioned local modifications (a re-vendor silently reverts them);
   any future sanctioned edit updates it in the same change.
2. **Never repo-wide `cargo fmt`** in `src-tauri` (~35 files of collateral).
   New files only: `rustfmt --edition 2021 <that file>` — and never on a
   `mod.rs`: rustfmt follows its `mod` declarations into every child file
   (measured: 6-file collateral). Verify an edit's formatting with
   `rustfmt --edition 2021 --check --config skip_children=true <that file>`
   and compare flagged hunks to your lines.
3. **`gd/session/*` branches are filtered from every branch surface** and
   never deleted — the user dogfoods agent sessions on them; deleting one
   breaks Resume.
4. **`pnpm lint` is a rewrite, not a check** (`biome check --write` over
   `src/` AND `site/`). Check form: `pnpm exec biome check ./src/`. In a task
   worktree that check false-fails on CRLF, so the remedy splits by role.
   WRITERS: use the per-file LF-copy `biome ci` gate (below), whose
   `__cigate__<name>` sibling is deleted after the check, or whatever the
   spec's Verification field names. REVIEWERS: run the check-only form scoped
   to the package's own files, and in a fresh worktree treat tree-wide
   formatting as unverifiable and report it as such — never create files (an
   LF copy is a file), never any `--write` form.

## Verification commands (allowlisted — run, don't ask)

```sh
pnpm build                             # tsc + bundle — the frontend gate
pnpm exec tsc -b --noEmit              # typecheck alone — plain `tsc --noEmit` is a NO-OP here (project refs); only -b checks
pnpm exec biome check ./src/           # lint/format CHECK (no mutation)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cd site && pnpm build                  # when the marketing site changed
pnpm run checks                        # guard scripts + self-tests — CI quality.yml guards job
# while iterating: SCOPED tests (rules below)
cargo test --manifest-path src-tauri/Cargo.toml <module path>::
pnpm exec vitest related --run <changed src files> <edited test files>
# before done / commit-ready / handback: the FULL suites ONCE, through the wrapper
pnpm test:rust:full                    # Rust changed
pnpm test:vitest:full                  # frontend changed (Vitest component tests, jsdom; CI runs Vitest in frontend.yml)
pnpm test:all:full                     # both
```

Frontend changes run the first pair; Rust changes add clippy; both run the
scoped tests while iterating and the matching full suite once at the end. Not
"done" until all of it is green.

### Scoped while iterating, full once at the end

Two full suites overlapping across sessions on one machine time out git calls
and red tests that pass solo. `scripts/full-suite.mjs` (the `test:*:full`
scripts) serializes FULL runs machine-wide by holding localhost port 27483 for
the length of the run; its exit code is the suite's.

- **Scoped, while iterating.** Rust: the tests of each edited module,
  `cargo test --manifest-path src-tauri/Cargo.toml <module path>::` (file
  `src-tauri/src/git/branches/delete.rs` → `git::branches::delete::`;
  several modules go after `--`:
  `cargo test --manifest-path src-tauri/Cargo.toml -- git::branches:: git::remote::`),
  plus the modules that CALL each changed item, found with
  `git grep -n "<item>" -- src-tauri/src`. A test that only NAMES the item
  counts as a caller: source-scan rosters (`include_str!` over a sibling file,
  such as `github/repo_meta.rs`'s timeout-hedge roster) find a write by text
  inside its function, so moving that text into a helper reds them. Take the
  module set from the grep's output, never from memory. Frontend:
  `pnpm exec vitest related --run <changed src files> <edited test files>`,
  plus `node scripts/check-banned-patterns.mjs` on every frontend step: it
  scans `src/test/` too, and tsc, biome and vitest all pass code it fails; the
  required `guards` job runs it.
  In a session whose worktree-isolated Bash guard refuses a cargo filter
  containing `git::`, run the same command with the PowerShell tool.
- **Full, once, at the end.** Before reporting done, commit-ready, or handing
  a package back: `pnpm test:rust:full` (Rust changed),
  `pnpm test:vitest:full` (frontend changed), `pnpm test:all:full` (both). It
  is mandatory because which surfaces a suite exercises is not decidable
  locally. Extra args pass through:
  `node scripts/full-suite.mjs vitest [args]`,
  `node scripts/full-suite.mjs rust [args]` (`all` takes none).
- **Shared test infrastructure goes straight to the full run**, not a scoped
  one: tests of one binary share a process, so state that several modules'
  tests mutate interferes only when they run together, which a module-scoped
  run never does. Rust members, and the greps that find them:
  - in-process test seams: `git grep -nE "static TEST_[A-Z_]+" -- src-tauri/src`;
  - env-var seams:
    `git grep -nE "env::var(_os)?\(\s*\"GD_[A-Z_]+\"" -- src-tauri/src`, and
    tests that set process env: `git grep -n "env::set_var" -- src-tauri/src`;
  - the shared runners and their process-wide state:
    `src-tauri/src/git/runner.rs` (the one spawn path under every git call)
    and `src-tauri/src/github/runner.rs` (auth epoch, body cache, rate gate);
  - shared test helpers: `git grep -n "mod test_support" -- src-tauri/src`;
  - what every module compiles against: `src-tauri/src/error.rs`, `state.rs`,
    `lib.rs`, `build.rs`, `Cargo.toml`, `Cargo.lock`;
  - the rest, measured: an item whose caller grep spans more than five
    modules counts as shared.

  Frontend members: `package.json`, `vite.config.ts` and `vitest.config.ts`
  (Vitest's `forceRerunTriggers` reruns every file for them, so `related` over
  them IS a raw full run); `src/test/setup.ts` and everything it imports
  (`@/lib/transport`), since a changed setup dependency returns every spec;
  `pnpm-lock.yaml` (a dependency move is in no import graph `related` walks).
- **The violation:** a raw full
  `cargo test --manifest-path src-tauri/Cargo.toml` (no filter), `pnpm test`
  or `vitest run` outside the wrapper, which re-opens the cross-session overlap
  above.
- **Unlocked:** scoped runs and clippy never take the lock (nor does
  `pnpm run checks`).
- **Always in the background** (the Bash tool's `run_in_background`, or the
  PowerShell tool's): a full run may wait for another session's, and a
  foreground tool timeout on Windows kills the shell but not the wrapper and
  its children, which keep running and holding the lock with nobody reading
  them. Read its `full-suite:` lines (`waiting - …`, `lock acquired …`,
  `<suite> exited <code> after <n>s`); never work around a wait with a raw
  run, and never set `GD_FULL_SUITE_PORT` to get past one. Before quoting a
  chain's end time, grep its log for `full-suite: waiting`: a chain that
  looked busy had run 0 tests while it waited 10 minutes on another
  session's `all` run (measured, #729). Don't force-stop a
  full run mid-run except deliberately: its verdict is lost. On Windows a hard
  kill of the wrapper ends cargo and its test binary with it (measured), so no
  orphan outlives it there. On POSIX cargo and its test binary run in the
  suite's own process group (the app's git and CLI children start groups of
  their own, which it does not cover). The wrapper forwards signals, job
  control included, to that group and holds the port until the group is
  empty, or about 10 s after cargo exits (SIGKILL, then released anyway); the
  next run waits on a killed wrapper's group, so a test binary that outlives
  cargo still blocks it. A container needs an init (`docker run --init`):
  without one, a killed run's unreaped zombies read as alive until the 2 h cap.
- **Not yet evidence:** a `vitest related` run that finds no test files exits
  0 and is NO coverage (say so; the end run is that file's coverage). A red in
  a scoped Rust run and a red in a full run are each re-run alone,
  `cargo test --manifest-path src-tauri/Cargo.toml -- --exact <full::test::path>`,
  before they are believed: the lock serializes full suites only, and another
  session's scoped run can still overlap.
- **CI can disagree:** the local end run is `cargo test`, which runs a
  binary's tests as threads of one process; a CI leg under nextest gives each
  test its own process, so in-process interference shows up locally or not at
  all. On Windows the rust step puts the real git's `<prefix>\bin` first on
  PATH, skipping the `Git\cmd\git.exe` shim; when a change touches `proc_tree`
  or the git runner's kill paths, also run it with `GD_FULL_SUITE_KEEP_PATH=1`.

⚠ **Formatting fixes stay in scope:** implementers format only their own files,
via the targeted `pnpm exec biome check --write <files in scope>`, never the
tree-wide `pnpm lint` (hard rule 4), which would rewrite the user's parallel
work too.

⚠ **`biome check` false-fails on CRLF (this Windows worktree).** autocrlf checks
files out CRLF, and `biome check` (formatter included) flags a CR on **unedited**
files as an error — a red result that isn't yours. The one trustworthy local
gate is the CI form over LF-normalized copies: copy each edited file to a
`__cigate__<name>` sibling (CRLF→LF), run `pnpm exec biome ci` on the copies,
delete them after. `biome lint` is NOT a gate — it skips the formatter and
assist layers `biome ci` enforces (a measured false clean, three CI reds).
Never "fix" a red by converting line endings.

## Frontend testing — two layers, routed by what the test asserts

Two frontend test layers exist; pick by assertion kind, never by habit:

- **Behaviour a user could observe** (render, interact, assert the outcome) →
  a Vitest interaction test in `src/test/**/*.test.{ts,tsx}` (RTL + user-event
  on jsdom), run scoped with `pnpm exec vitest related --run <files>` while
  iterating and through `pnpm test:vitest:full` at the end (CI runs the layer
  in frontend.yml). Never add a NEW source-scan pin for behaviour a jsdom test
  can exercise.
- **"Every X does Y" class invariants** (roster/adopter scans over `src/`) and
  **pure-logic `.ts` imports** → `scripts/*.test.mjs` as before (installless:
  the `guards` job runs that glob with NO node_modules — a vitest-style test
  there reds every PR).

**Conversion is opportunistic, never a mass rewrite:** when a change touches
behaviour an existing scan suite pins, convert those pins to interaction tests
in the same change and delete only the pins the new tests replace; shape-guard
scans stay scans. A conversion proves itself the way scan suites always have —
a mutation of the pinned wiring goes red under the NEW tests before the old
pin is deleted.

Component-layer mechanics (set by the spike; extend, don't re-derive):
- `src/test/setup.ts` installs a transport that REJECTS any unmocked `invoke()`
  command (and records it in `unmockedCommands`) — mock at the api-module seam
  (`vi.mock("@/lib/<area>/api")`), and never spell `invoke("literal")` in a
  test: the dead-surface guard pairs those with registered Rust commands. A
  module importing `@tauri-apps/api/core` or a Tauri plugin directly bypasses
  that transport (five src files outside `src/lib/transport/` import the core
  module today), so a test reaching one mocks that module itself. Every
  clipboard write goes through `writeClipboard` / `copyText`
  (`src/lib/clipboard.ts`): a test asserting a Windows copy mocks
  `@tauri-apps/plugin-clipboard-manager` and `isWindows` and stubs the
  `isTauri` global (`vi.stubGlobal`); most tests mock `@/lib/clipboard`
  instead of reaching the real helper, and a test that does reach it without
  those mocks takes the web branch and stubs `navigator.clipboard` itself,
  since jsdom defines none. The `raw-clipboard-write` guard fails the raw
  clipboard spellings it lists, in `src` outside that file and `src/test/`.
- The React Compiler is ACTIVE under Vitest (vitest.config.ts merges
  vite.config.ts) — tests exercise the shipped artifact, so no render-count or
  referential-identity assertions.
- jsdom shims live in setup.ts (`matchMedia`, `ResizeObserver`,
  `Element.prototype.getAnimations` — Base UI's ScrollArea and Dialog need the
  last one; without it every test still passes, but Vitest reports the thrown
  errors as unhandled and exits non-zero). Add a shim only on an observed
  failure, with the failing module cited beside it.
- tsconfig.test.json puts the test project under `tsc -b`, so every app module
  a test imports is also typechecked with `types: ["vite/client", "node"]`: a
  `pnpm build` error naming an app file can come from the test project.
- The src-wide guard scans read `src/test/` too — a guard red against a test
  file is fixed in the test, never by widening the guard.
- Under an agent session vitest picks its minimal reporter, which hides console
  output from passing tests — act warnings and the unmocked-command warning only
  show under `--silent=false`, added to a scoped run
  (`pnpm exec vitest related --run <files> --silent=false`) or passed through
  the wrapper (`node scripts/full-suite.mjs vitest --silent=false`).

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
A combobox-driven listbox whose rows aren't tabbable (My work, Explore) takes
`keepNonRowPressOffList` (same module) as its `onMouseDown`, so a press off the
rows never moves focus out of the input.
The clamped pickers (command palette, task picker, the co-author and
Bitbucket add-reviewer popovers, RepoList, the session composer's @ and /
menus) read one cursor that `clampHighlight` derives from the stored index
(`src/features/shortcuts/palette-highlight.ts`; RepoList keeps a -1 no-cursor
sentinel ahead of it), so the marker, Enter and any aria or scroll the picker
has read one clamped index even when the list shrinks under it. They step with
`stepHighlight`, except the composer's @ and / menus, which wrap with a modulo
from the clamped cursor (don't move them onto `stepHighlight`: it clamps at the
ends). `scripts/palette-highlight.test.mjs` pins each one, uniform
palette-shaped pickers in `CALL_SITES` and the rest in per-site `SITE_PINS`.
Not adopters: `mention-autocomplete.tsx` keys its highlight by candidate (a later
read's rows can land above it); `listKeyboardNav` lists are a separate primitive.
Destructive paths stay behind confirmation via the
shared `useConfirm`/`ConfirmDialogHost` primitive (`src/lib/stores/confirm.ts`,
host in `src/components/confirm-dialog-host.tsx`) — never a bespoke confirm
dialog. A prompt is repo-scoped by default: switching or closing the repository
while it is open cancels it (the caller gets `false`, an info toast names what
didn't happen). Prompts that act outside the open repository (quit/update,
recents, Settings, Explore, task deletion) pass `scope: "app"`. A prompt whose
confirm button must hold or annotate LIVE asks with `heldReason` and updates
through `setRequestHold(target, hold)` (same store): identity-pinned, a no-op
once the request moved on; `holdOffline` outranks the hold's reason; and the
reason/note line is reserved from open so it never moves the buttons, and it is
the dialog's one polite live region (the publish routes' fork-PR check is the
reference). Commit-level destructive prompts (checkout, revert, cherry-pick,
undo) share their wording through `src/features/history/commit-confirms.ts`: a
new route to one of those ops imports the existing prompt, never re-spells it.
Staging-over-conflict-markers prompts likewise live in
`src/features/repository/conflict-confirms.ts`: the generic stage gate and
Mark resolved both build theirs there.
A prompt asked from a closing Menu/Popover/ContextMenu item awaits
`useCloseSettled`'s `waitClosed()`
(`src/features/repository/publish-confirm.tsx`, its `onOpenChangeComplete`
spread on that Root) before asking — never a bare rAF from the handler: Base
UI returns focus to the trigger when the closing popup unmounts, which lands
after the dialog's initial focus and steals it.
Whether a push publishes or would CREATE its branch on the remote reads
`willPublish` / `willCreateOnRemote`
(`src/features/repository/branch-sync-state.ts`), never an inline
`!upstream || upstreamGone`; a local upstream (remote `.` or null in the
branch list) is `isLocalUpstream` from the same module.

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
A default that differs on macOS lives in `MAC_DEFAULT_BINDINGS` (registry.ts),
never in the ACTIONS row; every read of a default goes through `defaultBindingOf`
(`src/lib/hotkeys/default-binding.ts`), since the row alone holds the
Windows and Linux chord (guard `raw-default-binding-read`, which can't
see a destructured or bracket read). The binding an action answers to
comes from `effectiveBindings` / `useEffectiveBindings`, never a local
override-else-default: a user's override beats another action's default on the
same chord, and that action then reads as Unbound, a reset included.

**Mod-key display.** Shortcut hints render via `isMac` / `formatBinding` from
`@/lib/hotkeys/binding` — never a literal ⌘ or "Ctrl+"; only labels branch.

**Key-dispatch guards are shared, never re-derived:** `hasModifier`,
`isTypeaheadTarget`, `isTypeaheadKey`, and `isEditableTarget` / `firesInEditable`
all live in `src/lib/hotkeys/binding.ts`. Any path that compares
`eventToBinding(e)` against a user binding and then `preventDefault`s applies the
same three-predicate clause the global listener does — `isEditableTarget`,
`isTypeaheadTarget`, `isTypeaheadKey` — because bindings are rebindable down
to a single key, a dispatcher missing any of them either steals keystrokes from
a text field or typeahead list, or withholds a named key that should still fire.
Inner-clause drift between two dispatchers is the regression this prevents; the
`unguarded-binding-dispatcher` guard in `pnpm run checks` is the ratchet.
Each dispatcher also takes the listener's bare-Space carve-out: it consumes
`space` only when its action ran (`consumeRequiresDispatch`), so a disabled
one leaves the press to the focused control. An Enter/Space handler that
activates a focused row, card or chip, or a list's marked row from its filter
input, returns on `hasChordModifier(e)` (binding.ts) before any preventDefault,
so bound chords reach the window listener, except inside a modal that owns no
chord of its own, whose sites keep their swallow under an `OWNS_CHORD` entry
(app chords other than app zoom are inert under a modal anyway).
The `scripts/activation-key-chords.test.mjs` scan is the ratchet.
A handler that acts on a bare ArrowLeft or ArrowRight and can run outside
a modal dialog returns on `hasChordModifier(e)` first, so Go back's
Alt+arrow reaches the window listener. One that renders only inside a modal
keeps its swallow under an allowlist entry: under a modal, Go back and every
other app chord but app zoom are inert anyway (guard `chorded-arrow-handler`;
its message names what it can't see, such as a second handler in a file that
already holds a guard token). A surface that swallows chords it does not own
lets the effective `go-back` and `go-forward` bindings through after its own
chords, without preventing them (the Projects board card and table row are the
reference).

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
- File/directory paths middle-truncate through `PathText`
  (`src/components/path-text.tsx`) — head context and the filename both
  survive. It owns its only-when-clipped tooltip (allowlisted in
  `inline-clip-title`: the outer span it titles never overflows itself). A
  new path display hand-rolling `truncate` re-mints the inconsistency this
  fixed. Label composites (`Saved to <PathText/>`) space via `gap-*` on the
  flex row, never a trailing space in the label — flex line boxes trim it.
  Non-flex-item text is exempt: the absolutely-positioned `sr-only` badge
  spans keep their trailing announcement space. A path with a directory takes
  its accessible name from a visually hidden full-path copy behind
  `aria-hidden` visual spans, so a text query on such a path finds that copy
  and an exact `textContent` holds the path twice; a test reads the shown text
  with the copy removed.
- A `SelectControl`/`SelectField` `items` Record silently reorders integer-like
  keys to the front (JS object semantics) — any picker whose option values are
  user-supplied identifiers that can be all-digits (logins, slugs) must pass
  the `order` prop with the sequence it means (exactly the keys of `items`).
- Per-file `+added -deleted` counts render through `DiffStat`
  (`src/components/diff-stat.tsx`) — plain numbers in, optional `isBinary`
  (a muted `bin`) and `format` (Insights abbreviates via `fmt`); never
  hand-rolled, and the `hand-rolled-diff-stat` guard in `pnpm run checks`
  fails on a new pair. A file-list row whose counts load after the row (the
  Changes list, the commit dialog) renders `DiffStatSlot` from the same module
  on EVERY row, stat or not: it reserves the cell's width, so late counts don't
  reflow the names. The `list-row-diff-stat-slot` guard fails on any
  conditionally rendered `<DiffStat>` in a feature `.tsx` (`&&`, `||`, `??`,
  either ternary branch); a non-row total hidden on purpose takes an
  allowlist entry with its rationale. DiffStat itself keeps no width.
- Byte sizes render through `formatBytes` (`src/lib/format-bytes.ts`, base 1024,
  shared by Insights, tag detail and the binary-diff summary); never a local
  formatter. A full object id is tested with `FULL_OID_RE` (`src/lib/git/oid.ts`:
  40 or 64 hex, so SHA-256 repos pass). `scripts/oid-width-guard.test.mjs` fails
  on a new 40-only width in `src/` (a `{40}` quantifier with no `{64}` beside it,
  a 40-zero literal, a length compared to 40); slices, named constants and split
  lines are out of its reach.
- Insights blocks take their accessible name from visible text
  (`src/features/repository/insights/primitives.tsx`): a card is `InsightCard`
  and a titled block (in a card or the sidebar) is `TitledSection`, each a named
  `role="group"` (not a region, which would flood the landmark list). A figure in
  a card is labelled by the card title through the card title context
  (`ChartFigure` does this itself; a hand-built figure takes `useCardTitle()`),
  its chart svg is `aria-label` "<title> chart" via `useChartLabel()`, and a
  `DataTable` is named "<title> data" (unnamed outside a card), so nested names
  stay distinct. Never a recharts `title` prop, which also renders a hover
  tooltip.
- Icon-only copy buttons are `CopyIconButton`
  (`src/components/CopyIconButton.tsx`), never a raw button around `CopyIcon`;
  it always stops click propagation, and the `raw-copy-icon-button` guard in
  `pnpm run checks` fails on a new one.
- Disabled actions explain why via `DisabledReasonButton`
  (`src/components/disabled-reason-button.tsx`) — reason as tooltip + AT
  announcement; menu/popover trigger sites take the render arm with `disabled`
  on the BUTTON, never the Trigger — a disabled Trigger leaves the tab order,
  so its reason would reach hover only. The exact composition to copy is
  `<Trigger render={<DisabledReasonButton disabled reason/>}>`; the full
  contract sits in the primitive's doc comment. A disabled submit may instead
  explain via the field's `warning` hint. Raw-`<button>` sites the vendored
  Button can't size (reaction chips, the discussion upvote chip) take the SAME
  contract from the shared `useDisabledReason` hook + `ARIA_DISABLED_CLASS`
  (`src/lib/use-disabled-reason.ts`) — never hand-rolled. A vendored Button the
  render composition can't reach because a form component wraps it
  (`form.SubmitButton`, which forwards props but isn't itself a Trigger) takes
  the same hook directly: `focusableWhenDisabled`/`aria-describedby`/
  `wrapperTitle` passed straight through, plus its own sr-only reason span
  alongside (`src/features/welcome/CloneRepoDialog.tsx` is the reference).
  Base UI swallows every key but Tab on a disabled `focusableWhenDisabled`
  button, so a tag carrying that prop takes its `render` from the helper
  `heldButtonRender(held, render)` in `src/lib/use-disabled-reason.ts`, `held`
  true exactly while it is disabled and focusable (a busy Load more: its
  fetching flag), and a new site pairs it with `ARIA_DISABLED_CLASS`; Escape
  and app hotkeys then still work with focus on it. DisabledReasonButton
  applies the helper and the class itself; form.SubmitButton applies only the
  helper, so its caller passes `className={ARIA_DISABLED_CLASS}`
  (`src/features/welcome/CloneRepoDialog.tsx` is the reference). The
  `focusable-held-button-render` guard fails any other tag carrying the prop
  as a literal JSX attribute without that `render`. Out of its reach: a
  spread or a props object, whether `held` is right (any helper call passes),
  and a spread after the helper's `render=`, which can override it.
- A status badge or chip whose explanation isn't visible text is a
  `StatusDetailChip` (`src/components/status-detail-chip.tsx`) — a click popover
  keyboard, touch, and AT all reach, and a plain Badge when there's no detail. A
  `title` alone is mouse-only; the `titled-badge` guard bans it on Badge.
- ICON-LED informational strips (InfoIcon + one line of muted text above a pane
  body: a hint, a disclosure, a capability note) are `InfoNote`
  (`src/components/info-note.tsx`) — never a hand-rolled InfoIcon +
  `border-b bg-muted/40` row; a plain div, not a live region, with a trailing
  `action` slot for a dismiss control. Icon-less `border-b bg-muted/40` rows
  (action strips, section headers) are a different class and stay as they are.
  A note that must hold its place while hidden (a loading frame's reservation)
  passes `reserve`: same box, children invisible, the whole strip `aria-hidden`.
  The `hand-rolled-info-strip` guard in `pnpm run checks` fails an InfoIcon beside
  a `border-b bg-muted/40` class string outside `src/components/info-note.tsx`
  and the vendored `src/components/ui/`.
- A conversation surface's own actions sit before the submit button via
  `CommentComposer`'s `leadingActions` slot when submit is the row's last
  action (the issue views); a surface whose right-slot action is itself a
  primary (Approve / Review… on the PR views) keeps it in `actions`, which
  renders after submit — the caller owns the row layout up to that boundary,
  spacers included.
- The AI-generate chord in a dialog goes through `useGenerateChord`
  (`src/lib/hotkeys/useGenerateChord.ts`) — never a hand-rolled handler. Its
  invariants: effective-binding read (null = fully inert), `eventToBinding`
  match, `preventDefault` whatever `enabled` says on any surface WITH a generator
  while `generate-commit-message` is the chord's first holder (`useOwnsChord`; a
  chord an earlier action also holds falls through untouched, neither run nor
  swallowed), bare Space excepted (consumed only when Generate runs, otherwise
  it only stops propagation, so the focused control's native press still
  happens), run only under the visible button's gate, swallow-don't-cancel while
  generating, handler mounted on `DialogContent` (the X close is a form
  sibling). The hook returns the `hint` string so buttons can't forget it.
  `enabled` may be a function read at keydown: a shell whose sections come and
  go passes its sink's `canRun`, never `true`. A key without Ctrl/⌘/Alt that a
  focused control already default-prevented stays that control's, neither run
  nor stopped, matching the global listener's defaultPrevented skip.
  Recorded exception: surfaces with several per-row generators and no
  focused-row concept (Edit history's reword buttons) carry no chord.
- A generator dialog that stays mounted across its own close rides
  `useFinishAndSurface` (`src/features/conversations/useAiStream.ts`) — closing
  never cancels the run; a settle while closed latches skip-seed (the reopen
  shows the whole draft) and toasts it with a "View" reopen. The
  `generator-dialog-finish-and-surface` guard in `pnpm run checks` is the
  ratchet; the deliberate abort-on-close surfaces (the PR edit dialogs, branch /
  rename / task dialogs) are exempt by hook choice or by having no
  `useSeedOnOpen`. A generation belongs to the repo it started in: the hook takes
  `repoPath` plus the dialog's own `cancel` and `close`, and a switch aborts the
  run and closes an open dialog — `<RepositoryView>` is a single instance across
  repo switches, so dialog state outlives the repo. A settled-unseen latch is
  STAMPED with its run's repo and survives navigation; the first open releases
  it, this repo's showing the draft and a foreign one destroying latch and toast
  with the form its seed resets, while the toast's View re-checks the live repo
  and names the origin on mismatch. Two contracts the types can't enforce: the
  seed guard is `surface.shouldSkipSeed(generating)`, never a caller-owned
  `generating ||` arm (a cancelled run keeps that flag true through its context
  fetch; `consumeSkipSeed` is only for a caller discarding the waiting draft on
  purpose — an identity axis that moved on, or an explicit draft request that
  outranks it), and the repo-description store delivers only while the dialog
  reports General active, stashing otherwise. While a dialog's own form submits,
  its Generate holds with a reason (`CREATE_PENDING_GENERATE_REASON` from
  useAiStream.ts for creates) and its chord's `enabled` carries `!isSubmitting`:
  the draft is already sent and the settle closes the dialog holding it (the
  `generate-held-while-submitting` guard in `pnpm run checks` is the ratchet). A
  dialog a settle may close without a generation stamp carries an open-session
  token (`{}`) minted in its open handler, its `useSeedOnOpen` seed, or the open
  branch of a latched seed effect (re-minted when a reseed replaces the draft),
  captured at submit, dropped on every close and compared after the await. When
  the settle CLOSES the dialog it is never minted in an `[open]` effect whose
  cleanup clears it: an `<Activity>` hide runs that cleanup, so a create
  settling while hidden would leave its dialog open. A settle that only
  navigates may (`RunWorkflowDialog`): a cleared token lands its safe arm.
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
- A docked action bar that a bottom-right toast can cover publishes its top
  edge through `useToastClearance(ref, active)`
  (`src/lib/use-toast-clearance.ts`), which lifts every toast above it while
  `active`; when several bars are active, toasts clear the highest. A docked
  `CommentComposer` passes its `toastClearance` prop instead and measures its
  own root: a call-site wrapper would break its scroll-pin lookup over its
  preceding siblings (`scripts/toast-clearance-adopters.test.mjs`). Beyond
  `position` and `closeButton`, only `theme` and the offset props ride along on
  the app Toaster (`AppToaster` in `src/main.tsx`): the vendored wrapper spreads
  caller props last, so `toastOptions` would drop its `cn-toast` class,
  `className` its `toaster group` class, and `style` its CSS variables. `theme`
  comes from `useIsDark`, since the wrapper's next-themes read has no provider
  and would follow the OS scheme instead of the app's.
- Caught errors surface via `toastError` (`src/lib/toast.ts`), or `errorMessage`
  (`src/lib/tauri/invoke.ts`) where a toast is wrong (a terminal buffer) — never
  `String(e)`: `invoke` rejects a PLAIN AppError, stringified "[object Object]".
- A failure line rendered in place (not a toast, not a terminal buffer) shows
  `presentError(e).summary` from `@/lib/error-summary`, never a raw
  `errorMessage(e)`, which keeps the Rust error-kind lead (`invalid argument: …`)
  and every line of a multi-line message.
- A caption over a GROUP of controls rides `LabeledGroup`
  (`src/components/form/labeled-group.tsx`), which ties the group to it via
  `role="group"` + `aria-labelledby` — a `<Label>` that associates with nothing
  names nothing for assistive tech, however it is styled; the `bare-group-label`
  guard in `pnpm run checks` fails on any `<Label>` carrying neither `htmlFor`
  nor `id`. Existing idioms that already do their own aria wiring stay as they
  are: the CreatePrDialog / CreateIssueDialog field-group wrappers and
  McpServersSection's `role="group"` scope groups. A single control that carries
  its own group role (a `RadioGroup`) takes its name through `aria-labelledby`
  on an id'd caption (a `<Label id>`, or an existing caption element) instead
  of a LabeledGroup wrapper, whose group would repeat the name
  (BoardBulkFieldsDialog's mode picker, ProjectLifecycleDialogs' Layout,
  RepositoryMenu's fork intent, the Diff options sheet's Diff display); a group
  with no visible caption takes `aria-label` instead. The `unnamed-radio-group`
  guard in `pnpm run checks` fails on a `RadioGroup` carrying neither.
- A lazy panel's `Suspense` fallback is `LazyPanelFallback`
  (`src/components/lazy-panel-fallback.tsx`) — never `fallback={null}`: a blank
  region has no aria-busy and announces nothing to assistive tech. The
  carve-out: a boot-path boundary over a panel with a settled resting state
  renders that state as its fallback (`DiffRestingFallback`, sharing its
  message with DiffViewer through `diff-resting-message.ts`), with an aria-busy
  region and its sr-only status beside it rather than inside it, so the first
  frame already shows the panel's own resting message. The lazy DiffSurface and
  DiffContent wrappers (`DiffSurfaceLazy.tsx`) fall back to `DiffPaneFallback`
  in the same shape, which paints the file's path row. Still never
  `fallback={null}`.
- Loading placeholders for a bordered row list are `ListRowSkeletons`
  (`src/components/list-row-skeleton.tsx`), with `lines` matching the real row's
  line count and `name` naming the content ("Loading pull requests…") — flush
  `border-b px-3 py-2` rows, never a padded stack of fixed-height bars, so a
  cold load doesn't shift the list as rows arrive. It carries the group's
  `aria-busy` + sr-only status; `ListRowSkeleton` is the single row it wraps,
  not a call-site component.
- A panel with a probe arm and a list arm paints the SAME skeleton row count in
  both (one shared constant or prop), so a load whose probe hasn't failed
  never grows at the probe→list flip; while a probe has failed with nothing
  loaded, its retries may pin 1 row.
- The diff panes swap files through a two-slot hold: `useFileSlots` +
  `FileSlots` in `src/features/diff/file-slot.tsx` is the reference
  implementation (the Changes pane and every file-rail host render it; it
  imports nothing that reaches `./DiffSurface`, so hosts stay off the diff
  chunk), with its transitions in `diff-pane-slots.ts` and the `DiffPaneHold`
  context (`diff-pane-hold.tsx`) carrying `interactive` and the settle reports
  down to the surfaces. The held view (the last settled one) stays in flow and
  `inert`; a held FILE slot is also dimmed (`PLACEHOLDER_FADE` +
  `opacity-80` + `delay-100`), while a held placeholder stays undimmed. The
  target prepares out of sight at full size, clipped over the held view (how
  the slot hides, and what the guard enforces: the preparing-slot rule below).
  It is promoted on its first settled report or a 400 ms bound. A slot
  reports both edges of its settle, so a shown file that is not settled right
  now (one the bound promoted, or one loading again after Raw to Preview or a
  rebuild) is replaced outright on the next click, never held; it is held
  again once it settles. `aria-busy` sits on the non-inert pane root while
  holding, since an inert subtree is out of the accessibility tree. A slot
  counts as settled once it has at least one reporting gate and every gate
  that HAS reported is settled, so a render-null arm that never reports lets
  the slot promote early onto blank content: every such arm under a slot calls
  `useReportPaneSettled` before its early return. Entity detail views (PR,
  issue, workflow run) hold through `useEntityHold`
  (`src/lib/use-entity-hold.ts`; pure transitions in the import-free
  `src/lib/entity-hold.ts`, pinned by `scripts/entity-hold.test.mjs`) and
  `HeldFrame` (`src/components/held-frame.tsx`: the same dim, `inert`, and a
  sibling focus sink; its non-inert parent spreads `heldParentProps` for
  `aria-busy`). A single-instance host paints its held item from reads keyed
  on the hold's `shownKey`, while the selection's own reads decide `settled`
  (the PR and issue views read details on both keys), so no part of the new
  item lands inside the held one; `canHold` means the same repo and lens over
  a settled shown item, never "the target is a placeholder" (a hover-prefetched
  target has none). The 400 ms bound runs from the hold's START, so a fast run
  through a list holds the item it left once, never per step (the diff pane
  re-arms per target). Phase `loading` (bound expired, target unanswered)
  paints the target's loading frame, never a placeholder, which react-query
  keeps serving as the item the hold left; phase `offline` (the target's read
  paused) never holds and keeps the undimmed "showing the last opened …"
  notice; a move made while the tab is hidden shows directly. A keyed two-slot
  host renders `entityHoldSlots` (held, preparing, shown) over the same
  transitions. Runs use `RunSlots` (`src/features/actions/run-slots.tsx`): one
  keyed slot per run, promoted on `useReportRunSettled`, which the run view
  calls before any early return so a render-null arm still reports.
  The PR, issue and workflow-run views paint `loading` as a slot-shaped
  frame (`PrLoadingFrame`, `IssueLoadingFrame`, and the run view's shared
  `RunHeader` over `RunLoadingFrame` for its jobs slot), never generic bars; the
  PR view reserves its strip line and waits for its feed (`feedReady`), the
  issue view's late sections reserve their minimum loaded height with an error
  arm (`SectionReadLine`), and the run frame's jobs slot fills downward under a
  header seeded from a cached row and latched for the frame (a late forge-status
  answer, or a stale row when the run's detail lands, can still re-lay it).
  Each frame mirrors the loaded header's rows, titled from the cached list row
  of the LIVE selection (the view's own number lags a reveal), latched when the
  frame starts so a row that lands later never re-lays it. `RepositoryView`
  feeds detail views `deferred ?? live`, never an empty state over a selection.
  Every host computes `active` and its reveal frame through `useRevealGuard`
  (same module), never a deferred tab flag: a navigator that reveals the tab
  and moves the selection in one update leaves the deferred selection behind
  the reveal, so while `revealing` the host paints its loading frame, never
  the stale item, and `active` stays false until a visible commit painted the
  view's item, so that move shows the new item directly instead of holding
  one the user never saw on screen. File rails (History's commit and
  file-history panes, Compare, stashes, the agent worktree, a pull request's
  Files pane and commit drill-in) hold through `FileSlots`, not `useEntityHold`:
  they are arrowed at keyboard speed, and the diff pane's bound re-arms per
  target where the entity hold's runs from the hold's start. A change of the
  entity a host's `keyedPaneView` carries never holds (it is whatever the rail
  lists files of: a commit, comparison, stash or pull request; file history's
  entity is its file, so its commit moves hold, and the agent view's is the
  worktree): the shown slot re-targets in place under its slot id, so a read
  that keeps previous data serves it there (History's commit view and Compare
  dim it, never over a held slot). Each slot child paints its own file: it owns
  that file's read or takes the host's (the pull request Files pane's patch and
  composer belong to the parent and are handed down), and builds the comment
  anchors for its own path. It calls `useSlotRead` with the read it shows (a
  not-pending stand-in for an in-memory patch), so the host's busy and dim
  follow the shown slot and a previous entity's answer never counts as settled,
  and passes any line widget through `useSlotWidget`, so a held slot's composer
  stays as it was. A value only the shown slot's read supplies, kept for when
  the slot is held, goes through `useSlotRetained` (`heldRetained`): it comes
  back only to a held slot of the entity and path it was read under, never to a
  shown or preparing one. `scripts/diff-pane-hold.test.mjs` pins the host roster
  (`SLOT_HOSTS`, closed by the lazy diff wrapper's consumers). A placeholder
  across a key whose response can't prove identity may drive RENDERING only,
  with every interactive or forge consumer gated on `!isPlaceholderData`
  (commit-on-remote is the example); the Changes diff takes none, since
  `FileDiff` echoes only the path and a same-path staged/unstaged placeholder
  would put live buttons on the other side's hunks. `inert` covers pointer,
  focus and AT but NOT global hotkeys (gate `useHotkeyAction` on `interactive`)
  or portals: gate dialogs' `open`; a menu or popover open when the hold starts
  stays live, so it closes then (key it on the identity, or pass `held`) or its
  handlers refuse, and per-item dialog state resets on both edges of the hold.
  The held paint keeps its look: render gates read only the rendered item's
  placeholder, while the hold and the deferred selection's one-render lag feed
  interaction gates (handlers, hotkeys, palette); a render gate that reads the
  lag flickers before the hold starts.
- The preparing-slot rule: every two-slot host's preparing slot (the diff
  panes' `FileSlot`, the Actions tab's `RunSlots`, and any host that adopts the
  pattern) hides only by a full clip (`[clip-path:inset(50%)]`) plus `inert`,
  set as the `preparing` entry of the host's role-keyed class map, written as a
  plain class string (a literal, a literal-only `+` chain or interpolation-free
  template, or a same-file const of one) whose only clip-path token is the
  clip. Never `invisible` or `collapse`: the vendored Button's `transition-all`
  transitions the inherited visibility, so its buttons paint a frame late when
  the slot shows. Never an opacity below full: the slot would fade in instead
  of showing at once (both hosts' frames carry `PLACEHOLDER_FADE`). Never
  `hidden` or `sr-only`: the slot must lay out at full size before it shows.
  The `preparing-slot-hide` guard in `pnpm run checks` reads slot-host files and
  slot-shaped class maps (a `preparing` key beside `held` or `shown`; outside a
  host, a class-valued one), and fails on those utilities in any preparing-slot
  class it reads (role-keyed entries, role guards, role branches), on class code
  it cannot read there, and on a slot host whose slot maps' `preparing` entries
  aren't plain clipped class strings, or that keeps no slot map; its message
  names the spellings it does not read yet.
- A diff pane's path row and its lazy-chunk fallback both come from
  `src/features/diff/DiffPathRow.tsx` (`DiffPathRow`, `DiffPaneFallback`; it
  imports nothing that reaches `./DiffSurface`), so the pane paints its file
  header before the diff chunk loads. The pane's scroll keys, the hunk-focus
  landing (`landHunkFocus`) and the layout-switch line anchor's pure math live in
  `src/features/diff/diff-rows.ts`, shared by the rendered diff and the staging
  viewer; never a local copy (`scripts/staging-scroll-keep.test.mjs` pins the
  staging viewer's import). A scrolling diff host keeps its top line across a
  split/unified switch through `useModeLineAnchor` (`DiffSurface.tsx`), passing
  its scroller ref, the effective mode, the path and the built diff, and
  rendering the `mark` it returns inside the arm that mounts its rows: a
  `SnapshotMark` (`src/features/diff/snapshot-mark.tsx`) whose
  `getSnapshotBeforeUpdate` reads the pane's top line in the commit that
  switches the layout, before any DOM change, so the restore never rides the
  frame-deferred scroll sample; the hook's layout cleanup takes the same read at
  hide time. An expand of the same diff (Show full diff) calls the hook's
  `keepLine` before it flips, so the line read before the press is restored
  after the browser re-lays the rows. A host that changes the layout above the
  rows in a commit of its own (the image panes) takes the hook's keeper: it
  renders a `SnapshotMark` on its own trigger calling the keeper's `read`, and
  calls `restore` in its layout effect. Every library view (`<DiffView>`,
  `<DiffViewWithMultiSelect>`) is keyed on its retained source's `getId()`: the
  library clears the on-screen clone during render when it sees a new source, so
  an unkeyed view repaints light when React discards that render.
  `scripts/diff-view-host-key.test.mjs` pins the keys, the marks and the keeper
  sites.
  One gap remains: the staging viewer's Show full diff doesn't keep the line
  (only a focused press moves focus to the first revealed hunk). The agent
  session column keeps its place across a switch through `useColumnLayoutAnchor`
  (`src/features/sessions/use-column-layout-anchor.ts`), which anchors on the
  open step diffs (`data-transcript-diff`) around the column's top edge. It keeps
  no anchor between switches: each step box renders a `ColumnLayoutMark` (context
  from the hook) whose `getSnapshotBeforeUpdate` reads the column in the commit
  that changes the box's drawn layout (`drawnLayout`,
  `src/features/diff/drawn-layout.ts`, shared with DiffSurface), and the
  column's layout cleanup reads it at hide time; a restore places only that read.
- A file rail's filter rides `DetailRail`'s `filter` prop
  (`src/components/detail-rail.tsx`), built only by `useFileListFilter`
  (`src/components/use-file-list-filter.ts`), and renders its field in the
  caret strip. With a filter, the strip and the collapsed caret box wrap an
  `h-7` line in the same `FILTER_BOX_Y` padding, so the caret sits at the
  same height in both branches: the expanded strip adds its bottom border
  (41px, matching the diff path row) and the collapsed box has none (40px);
  without one, both stay `h-7`. A consumer derives its rendered rows, its
  `listKeyboardNav` items and its open path from the hook (`visible`,
  `activeIndex`, `openPath`), never from the full list, and renders
  `DetailRailFilterStatus` outside its own `aria-busy` wrapper. The pull
  request view is the sanctioned exception, with three placements: the Files
  status renders in its hold frame's host (`aria-busy` only during a hold)
  before `<HeldFrame>`, outside the inert frame that holds the field; the
  Commits drill-in's renders inside the frame, first in `PrCommitDetail`'s own
  host above its arms; and the conflict-resolve takeover's host renders an
  always-blank status as its first child, so the same node survives leaving
  the takeover. A rail without a filter takes no header line and never a
  first-child band inside `children`: the strip is already a bordered row, so
  a band under it stacks a second border and spends vertical space the list
  wants. When a whole rail goes away with its field focused, a same-scope rail
  mounting in that commit takes focus over by itself, onto its field, or onto
  its caret when it mounts collapsed (the module's `fieldHandoff`, cleared by
  a microtask; only while focus fell to `<body>`); a host that swaps views of
  different types lands the rest with `useRetryFocusRescue`, one instance per
  view on a keyed `contents` wrapper, so focus moves only when it was inside
  the view that left (`SessionChanges` in
  `src/features/sessions/SessionView.tsx`).
- Avatars: vendored `Avatar`/`AvatarImage`/`AvatarFallback` (canonical:
  `AuthorAvatar` in `src/features/conversations/Thread.tsx`) — never
  hand-rolled `<img>`/background divs. Biome-ignore comments use `/*`, not `/**`.
- Shared-ContextMenu suppression for non-target right-clicks goes through
  `suppressContextMenu` (`src/lib/context-menu.ts`) — `preventDefault` alone
  still opens Base UI's menu as an empty popup. A keydown that opens an app
  menu for the Menu key arms `useMenuKeyFollowUpCanceller`
  (`src/lib/menu-key-follow-up.ts`) right after its own dispatch, so
  WebView2's trusted follow-up `contextmenu` can't stack the native menu over
  it.
- CI copy comes from `src/features/actions/status.tsx`, never hand-spelled: the
  provider's noun via `ciRunNoun` (labels and toasts derive from it, so no
  surface says "run" beside another's "pipeline"), the gitlab-or-bitbucket test
  via `isPipelineProvider`, and the re-run offers, titles, and cancel wording
  via `rerunOffers`/`RERUN_TITLES`/`cancelLabel` — shared so the runs list and
  the run detail view can't drift.
- Per-repo/per-item labels name the DETECTED provider ("View on GitLab"),
  derived from the item's own host, which is persisted on `RecentRepo` so the
  first frame is right; unrecognized hosts label as GitHub; the static
  command-palette registry entry is the one sanctioned combined label.
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
- A dialog whose search input sits over a filtered list pins to the top inset
  through `PINNED_DIALOG_CLASS` (`src/features/shortcuts/palette-dialog.ts`), so
  a filter moves only the bottom edge and the input never shifts under typing.
  The caller adds its own width and lets the list be the member that shrinks
  (`min-h-* flex-1`); `scripts/palette-dialog.test.mjs` covers the adopters.

**Layout gotchas.** `DialogContent` is a grid — truncating flex content needs
`min-w-0` on the grid item; cap tall dialogs at `max-h-[85vh]`. A Dialog/Sheet
title that can reach the close button (dynamic children, `truncate`, or static
text of >=40 chars) carries `pr-8` on the title or its first-row container;
`showCloseButton={false}` exempts — the `dialog-title-inset` suite in
`pnpm run checks` is the ratchet. Link-styled clickables add `cursor-pointer`
at the call site (vendored Button sets none).
Main-side panels (children of RepositoryView's `<main>`, a display:block host) root
with `flex h-full min-h-0 flex-col` — `flex-1` is inert there, and the panel's
natural height document-scrolls the whole tab, chrome included (#261's
InsightsBoard was the outlier; every other main-side panel already complies).
An element or component root that takes its parent's whole height (`h-full`)
beside in-flow siblings in a flex column carries `min-h-0` (`flex-1 min-h-0` to
take the rest), or sits alone in a `min-h-0 flex-1` box: without it the item
can't shrink below its content, so tall content pushes it past the column and
the app root's `overflow-clip` cuts it off with no scrollbar; the ratchet is
`scripts/flex-column-rigid-fill.test.mjs`, whose header lists what it can't see.
Tailwind animation overrides need the `!` important modifier — tw-merge doesn't
dedupe the animate group, so `animate-none` vs an existing `animate-in` is a
build-order lottery (tailwind-merge 3.6.0; in-repo: `data-open:animate-none!`).
A scroller holding a Checkbox, Radio or Switch anywhere keeps at least
8px of bottom padding, since their hit area overhangs 8px: `DIALOG_SCROLL` /
`DIALOG_SCROLL_X_HIDDEN` carry `pb-2 -mb-2`, a call site never overrides that
padding (a stretched flex-row scroller takes `mb-0`), and other scrollers pad
themselves; the ratchet is `scripts/scroller-toggle-bleed.test.mjs`, whose
header lists what it can't see.
An `sr-only` copy is `position: absolute`, so in a body-portaled popup it escapes
a scroller that isn't positioned and grows the document (a window scrollbar over
empty space): a scroller inside a popup carries `relative`, and every
`ScrollArea` carries a call-site `overflow-hidden` or `overflow-clip` or an
allowlist row with its reason. A clipped root cuts the viewport's outset focus
ring (WebKit has no `overflow-clip-margin`), so RepoList draws an inset outline;
the ratchet is `scripts/popup-scroller-containment.test.mjs`.

**State & rendering gotchas.**
- `<Activity>`-hidden subtrees still render but hold no query observers, so
  they fetch nothing while hidden; the re-show refetches anything past its
  staleTime. Keep a heavy query's `enabled` gated on the active tab as a
  backstop; gate agent-surface notifications on the tab being watched.
- Open-TRANSITION resets ride `useSeedOnOpen` (`src/lib/use-seed-on-open.ts`) —
  a bare `useEffect(() => { if (open) seed(); }, [open])` re-fires when a hidden
  `<Activity>` tab re-mounts its effects on show, wiping the user's draft. The
  carve-out: data-arrival seeds (`[open, thatQuery.data]`) and `onOpenChange`
  seeds stay bare, and each must be idempotent — never stomping a user's pick.
  The `seed-effect-on-open` guard allowlists the recorded ones.
- A create dialog whose form a reopen can reseed while its create runs holds
  through `useDraftCreateHold` (`src/lib/use-draft-create-hold.ts`): form-core
  keeps ONE `isSubmitting` per form, which a reseed clears and an older draft's
  settle clears again under a newer draft's create. The hook owns the draft
  generation (`nextDraft` where the form takes another draft, `begin`/`end`
  around the submit, `holds` at the settle); every submit path asks
  `isRunning()`, and the dialog's `form.SubmitButton` takes `disabled` and
  `pending` from `running`. A dialog whose duplicate guard lives where a reset
  can't clear it (a store lane, a mutation-cache read) takes an allowlist entry
  in the `draft-create-hold` guard instead.
- Zustand + view transitions: navigators (`openRepo`, `openPr`, `closeRepo`,
  `openSettings`, …) apply their set through `startViewTransition`, which runs
  it in a later task wherever the View Transitions API is available (at once
  only under reduced motion or without the API). The repo-view navigators
  (`openRepo`, `openPr`, `openIssue`, `openRun`, `openAgentTab`, `openRepoView`)
  crossfade only when the top-level view changes and otherwise skip the
  animation (`{ animate: false }`), still applying after any pending
  transition's update; the screen navigators always crossfade. A plain `set()`
  right after a navigator can be clobbered by that later apply — navigate in
  ONE atomic action. A side effect that must count only when a navigation
  LANDS (a read-mark, an analytics event) rides the navigator's `onApplied`,
  run inside the transition callback after the landing's set: `openPr`,
  `openRun`, `openAgentTab` and `openRepoView` skip it on a stillValid-refused
  landing and on a cross-repo landing superseded during its warm-up
  (`openIssue` takes none). Those five navigators' cross-repo arms hold on that
  warm-up, so they apply up to its budget (250 ms) after the request.
  `openRepo` applies every call that reaches its callback (a skipped view
  transition still runs its update), so its callers gate with
  `claimRepoOpen`/`repoOpenWatermark` before calling. `onApplied` itself never
  bumps the epoch.
- Navigators that can leave Settings open with
  `if (interceptSettingsLeave(() => get().<self>(<original args>))) return;`
  ahead of their own epoch bump: the intercept bumps for the request and hands
  the move to Settings' leave guard (registered while anything is unsaved or a
  save is writing), which asks, holds the move until the write lands, or lets
  it go; the resume re-invokes the navigator with its original arguments.
  System landings escape only via `bypassLeaveGuard: true` (`openRepo`) or
  `closeRepoUnguarded`. The exempt navigators and both escapes are pinned by
  `scripts/settings-leave-guard.test.mjs`.
- Opening a repo the user picked goes through `useOpenRecordedRepo`
  (`src/features/repository/useOpenRepoByPath.ts`): it warms the repo's
  shell reads (`warmRepoShell`, a 250 ms budget on cold keys), records it in
  recents, and switches only if no newer open or navigation arrived — never
  a hand-rolled `addRecent` → `openRepo`. A caller whose own awaits are part
  of the request claims first (`claimRepoOpen`); one whose pre-open await
  may end in something other than an open (BranchSwitcher's worktree lookups)
  takes `repoOpenWatermark()` and yields to a newer open instead. The known
  bypasses hold on the same warm-up: RepoDialogs' failure reopen and a worktree
  promote's landing call `openRepo` after awaiting `claimWarmRepoShell`
  (ui.ts), `useOpenWorktree` warms without recording, and the store navigators'
  cross-repo arms (notification, My work and board-card jumps) hold through
  the provider `useOpenRepoByPath` registers (`registerRepoShellWarmup`).
  The reads that paint the repo view stay cached `REPO_SHELL_GC_TIME`
  (`src/lib/query-cache-times.ts`) through curated `<thing>Options` factories:
  the local ones are spread by their hook and the warm-up, the network-backed
  ones (`publishTargetsOptions`, `latestRunOptions`) by their hook only. A
  warmed read nothing on the first paint shows warms unheld (`into: []`), so
  it never spends the budget: `remoteBranchesOptions` and `branchesOptions`
  (the closed branch menu's Remote group and its local list). The shell
  factories without a window of their own carry `REPO_SHELL_WARM_STALE_MS`
  (src/lib/query-cache-times.ts), so the mount right after a warm-up serves the
  prefetched answer instead of respawning git; an observer that must re-check
  on open (PromoteWorktreeDialog's status and op-state preconditions) passes
  `staleTime: 0` explicitly. BranchSwitcher still prefetches remote branches
  once per repo for a same-repo remount from a non-repo view, and its hook
  stays open-gated. Never a `["repo"]` prefix default (it would catch the
  notification baselines).
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
  previous data via `keepPreviousDataForKeyAxes`
  (`src/lib/git/queries/core.ts`), and callers gate derived UI on
  `!isPlaceholderData` — a disabled query still renders its placeholder.
- The remote PR and issue list hooks file a SAME-state placeholder through
  `filterPlaceholderRows` (another tab's page passes whole; a non-empty one
  that files down to nothing serves none), and `remoteStateMatches`
  (`src/lib/remote-state-filter.ts`) is the one predicate that files a remote
  row into the Open or Closed tab (`scripts/remote-row-state-wiring.test.mjs`
  pins the sites).
- Virtualized lists: a variable-height first row races `measureElement` —
  mount the virtualizer in a child gated on data (`docs/list-virtualization.md`).
- Multi-toggle settings batch behind a Save/Discard bar (draft + dirty), not
  per-toggle auto-save; a single discrete select may apply-on-change.
- A stored note/verdict that DESCRIBES form-draft values carries the draft
  signature it was produced under — never clear-at-every-writer: the footer's
  Discard `form.reset()`s from outside the section, which no in-file clear can
  reach. An advisory NOTICE is retired — state cleared — on the first mismatch,
  so a draft returning to that signature can't resurrect a dismissed one (`note`
  in KeyboardSection, `warn` in AllowedHostsField); a VERDICT stays render-gated
  (`testConfig` in AiProviderSection), being valid again on return. Imperative
  clears only for validity axes the signature can't see (typed input).
- Repo-content config features (FUNDING.yml, CODEOWNERS, …) scaffold the
  local file for the user to commit — never write repo content via an API.
- A mutation whose host can unmount mid-flight (a dialog closable by Esc / ✕ /
  backdrop, a keyed remount) rides `await mutateAsync` continuations, never
  `.mutate(vars, { onSuccess, onError })` — react-query drops per-call
  callbacks when the observer unmounts, so the toast, navigation, or cleanup
  that lived in them silently never runs. The house idiom is `form.ts`'s
  awaited-submit convention (`SquashDialog` in
  `src/features/history/RewriteDialogs.tsx` is the reference).
- An awaited continuation that writes GLOBAL selection/navigation state
  (`selectIssue` / `selectTag` / `selectDiscussion`, `setRepoTab`,
  `setCommitDraft`) guards on the live `repoPath` — and the live entity, for
  deselects — read via `useUiStore.getState()` after the await: mutateAsync
  continuations outlive Activity hides AND unmounts, so an unguarded write
  retargets whatever repo/entity the user switched to (reference:
  `deselectIfStillHere` in `src/features/issues/RemoteIssueView.tsx`). Toasts
  stay unconditional — the operation happened regardless.
- `interactionEpoch` bumps belong to the user's request, synchronously (the
  store contract on `UiState.interactionEpoch`): a late bump retires whatever
  newer action is pending, a repo open included. Automatic corrections and
  prunes write through setters that never bump (`clearSelectedFile`,
  `advanceSelectedFile`, `clearSelectedCommit`, `defaultCompareBranch` and
  `clearRemoteSelections`), and a navigator's `beforeSelect` never bumps
  (`noteUserInteraction` is a no-op there; the navigator already counted the
  gesture). A continuation that would bump after its await bumps at its
  request instead, re-checks the epoch and live repo after the await, and
  lands through a non-bumping write (`useAmendCommit` + `landAmend` is the
  reference); the guarded post-await writes in the bullet above still bump
  late, a tracked follow-up. The store's one sanctioned late bump: a held
  cross-repo navigator's settle-time Settings re-check, up to the warm-up
  budget after the request and only while Settings' leave guard is
  registered (it asks about unsaved edits, or holds the move while a save is
  writing). Review-enforced, not guarded: a regex over effect and
  continuation bodies would fail open.
- A follow-up that needs the DOM from a state flip (focus a just-revealed
  input, re-pin a grown scroll region) never rides a bare
  `requestAnimationFrame` from the event handler: when the state lives in
  react-query, the notify-batched re-render can land AFTER that rAF, so the
  callback hits a still-hidden node and silently no-ops. Arm a pending ref and
  consume it in a `useLayoutEffect` keyed on the flipped state's commit
  (reference: `CommentComposer`'s collapse/expand pending flags); an rAF
  belongs inside that effect only to outlast Base UI's close-time focus-return.
- A mode swap that unmounts the control holding focus (a toolbar cluster
  swapping its controls) drops focus to `<body>` on the PALETTE route — the
  palette closes-then-dispatches, so its focus-restore lands on the
  about-to-unmount control. Rescue via `useFocusOnControlsSwap`
  (`src/features/diff/use-hidden-trigger-focus.ts`): change-only by design so
  a mount never steals focus; its sibling `useHiddenTriggerFocus` owns the
  container-query-hidden-trigger close arm. Never a hand-rolled focus effect.
- A dialog whose controls can go natively `disabled` while focused (a picker
  or Generate held by a pending read) calls `useLandStrandedFocus(landId)`
  (`src/features/pulls/use-land-stranded-focus.ts`): the element `landId`
  names (Title in the create dialogs) takes focus before the browser blurs the
  dead control to `<body>`. It acts only inside the open popup (`data-open`)
  holding `landId`, and leaves a reasoned `aria-disabled` hold focused, since
  that doesn't match `:disabled`. Pinned by
  `src/test/land-stranded-focus.test.tsx`.
- Whether focus is lost is `focusIsLost()` (`src/lib/focus-lost.ts`): on
  `<body>`, on nothing, on a detached node, or on an element that isn't
  rendered. The last is the `<Activity>` reveal: the commit that shows a tab
  hides the old one while focus still sits on its control, which a body-only
  test misses. Every LANDING reads it: `RemoteIssueView`, `RemotePrView` and
  `DiscussionView` on mount and show, and ConversationListPanel when its
  detail closes, fed `detailKeyOf` of RepositoryView's deferred selection
  (the one the pane renders from, never a deferral of the list's own). A
  frame rescue that runs while its view stays mounted may keep the body-only
  test. A landing still only TAKES lost focus, never moves it off a visible
  element.

## Seam idioms (the spec template's "Idioms at this seam" field reads this list)

Wiring a NEW call site onto one of these surfaces means the governing idiom
applies — cite it in the spec or record "none applies"; the canonical site is
one grep away on the named symbol. Grows via Conventions-sync.

- **Hotkey dispatch: who answers a key** — every route that is not a press on
  a visible control (the window listener, a palette pick, the macOS menu, the
  mouse side buttons) calls `dispatchShortcut`
  (`src/lib/hotkeys/dispatch-shortcut.ts`); a control's own press calls raw
  `dispatchAction`. Under any open, rendered modal (dialog, sheet, drawer,
  confirm prompt) `dispatchShortcut` reaches only registrations made inside the
  topmost modal's content (app zoom excepted), so a dialog's own shortcuts
  register from inside its `DialogContent` / `SheetContent`, whose
  `PanelPortalReset` gives `useHotkeyAction` its modal scope; an owner
  that would register from its body behind an open-state gate renders
  `<HotkeyAction>` (`src/lib/hotkeys/HotkeyAction.tsx`) inside the content
  instead (CommitDialog is the reference; T1 in
  `scripts/hotkey-registry.test.mjs` is the tripwire, and T2 there fails a
  `keepMounted` dialog outside the vendored primitives, whose mounted scope
  would outrank the dialog actually open). A drawer opens no scope, so under
  one every entry but app zoom is inert, its own included. Precedence is a tier
  per entry: an app-level fallback takes `tier: "fallback"` (AppCreateHotkeys,
  RepositoryView's create-issue pair), a popup's content takes `tier: "popup"`
  (RepoList), and registration order decides only inside one tier
  (`scripts/app-create-hotkeys-mount.test.mjs` pins the tiers). A local matcher
  comparing `eventToBinding` against an effective binding swallows only a chord
  its action owns, asked through `useOwnsChord` (the listener's first-holder map,
  from `chordOwners` in binding.ts); the roster in
  `scripts/activation-key-chords.test.mjs` fails a new matcher that skips it.
  The topmost modal is the scope created last, not a DOM lookup, with two
  accepted edges: while a newer dialog plays its exit over an older one, the
  older one's shortcuts stay inert until the newer unmounts, and a tab-panel
  dialog opening by itself after a still-open app-level modal answers though
  that modal paints above it. A native-menu route carrying no action id (File >
  Open Recent) gates on `anyOpenModal()` itself. A dialog-local chord handler
  on a container ignores events from a nested modal through `fromOtherModal`
  (`src/lib/hotkeys/open-modal.ts`), because React bubbles synthetic events
  across portals; T3 in `scripts/hotkey-registry.test.mjs` is its tripwire.
  A hard-coded submit chord tests `eventToBinding(e) === "mod+enter"`, never
  `(e.ctrlKey || e.metaKey) && e.key === "Enter"`, which also takes Enter
  with Shift or Alt added (check-banned-patterns fails it).
- **Keydown ownership** — a keydown has one owner, decided in this order, and
  nothing below the owner acts on it or prevents it. First the input method:
  any keydown with `isComposing` or keyCode 229 (`isImeKeydown` in binding.ts,
  which the window listener and `eventToBinding` both check). Then the
  focused control, for a fresh press of the unmodified key it natively means
  (Shift allowed) while no enabled action is bound to that key, or an exact
  `eventToBinding` chord it owns. A text field keeps every key without
  Ctrl/Meta/Alt, bound or not (F5 included), and the native editing chords;
  a typeahead list keeps its bare character keys and Space. Every other key
  bound to an enabled action, and every other key carrying Ctrl/Meta/Alt,
  belongs to the window listener, which consumes a fresh press of a
  registered chord even when nothing runs (bare Space only when its
  action ran). The listener applies the whole order, and `eventToBinding`
  answers null for an input-method key.
  The palette, the shared Markdown editor and its mention list, the projects
  board and table, and Edit History apply the input-method tier; a local IME
  branch also stops propagation, since Base UI's document-level Escape
  dismissal sits above it. The local submit matchers apply the exact-chord
  rule. Older handlers predate it and still break it (text-field Enter
  submits that act with Ctrl or Alt held, the mention list's Enter arm, the
  Escape handlers of full-screen surfaces, the shortcut recorder).
- **Back/Forward history** — the recorder (the ui store subscriber at the
  end of `src/lib/stores/ui.ts`, whose rules are `recordNavigation` in
  `src/lib/stores/nav-history.ts`) observes committed location changes,
  so no call site pushes: a tab change always adds an entry, a selection
  change only after `markLinkHop()`. A new tab or selection field joins
  `NAV_SELECTION_FIELDS`. A same-tab jump that follows a reference (a `#N`
  link, a linked issue, a badge) calls `markLinkHop()` on the line before its
  select; list browsing never does, since it rewrites the current entry in
  place (a list row's click may mark, its arrow route never: StackSection's
  `followed`). A tab whose place the store can't name registers an anchor
  provider (`registerNavAnchorProvider`) and consumes its return request while
  active, epoch-checked (`useBoardReturn` on Projects is the instance); leaving
  the repo view for an overlay records the current tab's anchor first, since
  the panel unmounts under the overlay. A tab whose panel can stop rendering is
  reported through `setNavHiddenTabs`. The history is a list of segments, one
  per stretch of one repository under one lens, and `useNavLensSync` re-seeds
  the current segment alone when the live lens differs. A repository change
  empties it, except a navigator landing that passes `carryHistory: true`
  (the board's card opens and the Activity dock's four jumps): a change of
  repository or of the same repository's lens then starts a new segment, with
  the departing tab's anchor read at the landing; from under an overlay the
  departing stop is the stored one, its anchor read when the view left. A
  stamped segment left from under an overlay for another repository keeps its
  stamp and its stops up to the current one, whatever the live lens; a
  same-repository hop that lands under that stamp after the live lens moved off
  it rejoins the segment the same way. `openPr` and `openIssue` report the state
  they left from, read before `beforeSelect`, on every landing; a landing that
  stays in its segment and is known to stay under the departing segment's lens
  records from that stop and trail, since a selection clear in the callback is
  no deselect of the user's. Every writer that keeps or adds entries returns
  through the module's one normalizer (seeding writes one entry, and the
  stamp-only lens path returns the entries unchanged). Back and Forward restore
  inside a segment in one set and never call a navigator; a step into another
  segment goes through `restoreNav`'s cross-segment arm (ui.ts): into the same
  repository under the other lens it lands with no hold, its set applied through
  `startViewTransition` (a task later, unless motion is reduced or the API is
  missing); into another repository it is a held landing that warms the
  repository shell and validates the target folder beside it, for at most 10 s.
  Two answers each drop every segment of that repository and toast once: gone
  (the backend answers not a directory or not a repository, or answers another
  root) and refused (git answers and the folder cannot be opened: its fatal exit,
  or a working tree it names that is not a directory). A check that fails any
  other way, or passes the 10 s, drops nothing, lands nothing and toasts once.
  All three act only while their press is still the current one. When the
  repository's cached remotes list no longer holds `upstream`, a landing on a
  segment stamped upstream applies no lens, drops the restored remote pull
  request or issue, re-seeds that segment as origin and arms no board return.
  When the list loses it under a segment stamped upstream while the stored choice
  is still Upstream, `useNavLensSync` drops the remote selection and re-seeds the
  segment as origin, without waiting for the forge status. `restoreNav` is the
  sixth hold site `scripts/settings-leave-guard.test.mjs` pins, under its own
  `RESTORE_HELPER` constant outside the five held navigators. A mouse side-button
  press a surface spends on something else (cancelling a drag) calls
  `vetoSideButtonNavigation` from its mousedown, so the release doesn't also
  navigate.
- **Repo-identity keying** — per-repo state keys on the repo IDENTITY
  (`useRepoIdentity` / the shared `--git-common-dir` resolver), never a raw
  checkout path; a raw-path key diverges across worktrees of one repo.
- **Held repo navigation** — every route that opens a repo warms the shell
  first and, except the worktree promote's landing (a system move off
  a folder it is deleting), yields to newer intent: picked opens via
  `useOpenRecordedRepo` / `useOpenWorktree`, the ui-store navigators'
  cross-repo arms via the `registerRepoShellWarmup` provider (registered in
  useOpenRepoByPath.ts; same-repo arms stay synchronous), and the two direct
  `openRepo` sites and the cross-segment Back/Forward restore (`restoreNav`)
  via `claimWarmRepoShell` (ui.ts). A new route that opens a repo goes through
  one of these, never a bare `openRepo`. Except at the promote's landing,
  which ignores its claim and keeps `bypassLeaveGuard`, a held landing checks
  a `claimRepoOpen` claim (plus RepoDialogs' request-time `repoOpenWatermark`)
  for supersession and re-runs `interceptSettingsLeave` at settle — the guard
  can be registered during the hold without an epoch bump. `restoreNav` is
  the one held landing that doesn't re-run it: it lands only while the repo
  view shows and its press's epoch stands, and opening Settings moves both. A
  caller whose own awaits precede the navigator call claims (`claimRepoOpen`)
  before them and checks that claim before calling, so a newer click retires
  an older held landing and a newer open retires the click (My work's
  `openItem`, the board's `openInClone`, the Activity dock's `navigate`).
  A submodule opens as a repository only through `useOpenSubmoduleAsRepo`
  (`src/features/repository/`), which claims before its probe, drops
  a press retired while the probe ran, and reports a bad folder by its
  submodule-relative path.
- **Forge item in a local clone** — opening a forge issue or pull request in
  a local clone of its repository goes through `src/lib/local-landing`: the
  synchronous candidate check (`hasOpenableMatch` / `openableMatches` in
  `match.ts`, what a menu label may promise) and `resolveLocalLanding`
  (`resolve.ts`, one `LOCAL_LANDING_BUDGET_MS` budget, the first folder check
  included, and a non-pruning worktree read), never a copy of the matcher.
  Each caller keeps its own generation, claim, `superseded()` and wait, and
  re-checks `superseded()` after the await before acting on any result, a
  browser one included (My work's `openItem` and the board's `useCardOpen`
  are the instances). The wait's spoken line is `openingStatus` (`match.ts`).
- **Same repository on the board** — whether a Projects card's
  `owner/name` is the open repository (or its other fork side) is
  `sameRepoSlug` (`src/features/projects/card-destination.ts`), the folder's
  one case-insensitive slug compare; a new projects surface imports it rather
  than comparing slugs inline.
- **App-level announcements** — a status a screen reader must hear after the
  view that raised it unmounts (a landing that switches repository) goes
  through `announceApp` (`src/lib/app-announce.ts`), read by the one
  `<AppAnnouncer />` App mounts; never a second app-wide live region. A view's
  own waits stay in its own `role="status"` region.
- **View lens** — a PR/issue number or blob is valid only in the lens that
  produced it (origin vs upstream vs local match); navigation and dock entry
  points thread the lens (`beforeSelect`), never pass a bare number across. The
  open repository's cached lens stays observed app-wide (`OpenRepoLensKeeper`),
  so a session-only lens lives as long as the selections minted under it; a
  repository left behind keeps the default expiry.
- **Force/retry threading** — a re-run or retry carries its force/trigger
  marker end-to-end; downstream code distinguishing "original vs re-run" reads
  the marker, never infers from timing.
- **asText rendering** — user-and-forge-supplied strings render through the
  file's asText discipline, never raw interpolation.
- **networkMode / offline parking** — react-query calls on possibly-offline
  surfaces set the documented `networkMode`; the default PARKS offline and the
  query never resolves.
- **Retry focus rescue** — a Retry control whose press can unmount it (an
  error arm swapping to a skeleton or notice) rides `useRetryFocusRescue`
  (ConversationListPanel) with a host that survives the swap: a `tabIndex={-1}`
  box, or a persistent control such as the list's driving search input. A host
  handed to the `hostRef` callback imperatively is captured once, so it must
  outlive the Retry's owner. Focus must never fall to `<body>` on the
  shown→hidden edge. A detail pane's error-arm Retry carries no disabled
  state or in-flight label (the arm unmounts the moment the retry fetches),
  pinned by `scripts/detail-pane-retry.test.mjs`.
- **Detail-pane retention** — a detail pane over a read renders through
  `resolveDetailPane` + `DegradedListNotice`: a failed refresh keeps the loaded
  content under the notice and its Retry, never a swap to an error on a raw
  `isError`, which would make a transient failure read as data loss.
  `scripts/detail-pane-retention.test.mjs` pins the adopters; a new pane joins
  its `SITES`.
- **Empty-picker copy** — a picker's line while it draws no options rides
  `emptyPickerCopy` (remote-section-state); a read parked with nothing loaded,
  or over a failure, says offline; only a successful read may claim none.
- **Degraded-list copy** — a list that may be partial rides `unknownListNotice`
  (remote-section-state), keyed on the read's WIRE flags, never row count:
  truncated says "may be incomplete" with no Retry; a failure offers Retry; a
  park never does. Several sub-lists of ONE read share one line and one Retry
  through `unknownListsNotice`, never stacked per-list notices.
- **Fail toward unknown** — empty, negative or advisory copy ("no X", "not
  pushed", "unavailable") renders only from a SUCCESSFUL read that answered so,
  gated on the read's data, never on its absence: a failed read keeps loaded
  content under a notice or says it couldn't load, with Retry. An infinite query
  splits a failed Load more from a failed refresh through `splitInfiniteFailure`
  (remote-section-state) before `listNotice`. A failure that must hold through
  the read's own background refetches (a board notice, a hold reason) reads
  `failedSinceLastSuccess` from the same module, never `refreshFailed`, which
  goes quiet while a refetch is in flight. The Rust twin of "Advisory probes
  fail SAFE toward inaction": a probe returns Err for a failed git run, never a
  defaulted verdict, and reads its negative answer only from a run that gave it
  (exit 0 with nothing matched, or an unborn HEAD). The shared unborn probe is
  `unborn_head` (git/history.rs), which on git 2.43+ tells a missing branch ref
  from a broken one; a read that runs first and probes only after it fails goes
  through `read_unless_unborn` (same file). `commit_on_remote` and
  `git_unpushed_count` in git/branches/unpushed.rs are the models.
- **AppError message classifiers** — a check over an AppError's `message`
  matches through `appErrorDetail` (`@/lib/error-summary`), since the wire
  message keeps the Rust Display lead (`invalid argument: …`); it strips only
  `": "`-ended leads from the shared `DISPLAY_LEADS` mirror. A git failure
  reads its `stderr`, which carries no lead. Model:
  `src/features/history/blame-errors.ts`, pinned over serialized payloads by
  `scripts/blame-errors.test.mjs`.
- **Writes that may have landed** — a frontend arm asks `mayHaveLanded(error)`
  (`@/lib/error-summary`) before it says an item wasn't created, saved or
  posted, and never matches the sentence itself. Two families of Rust builders
  in forge/mod.rs feed it. A timed-out write returns `AppError::WriteTimedOut`
  (kind `timeout`): `write_timed_out` for a CLI run, `request_timed_out` for a
  Bitbucket or Jira request that was sent and not answered (never a connect
  timeout; `send_error` in forge/http.rs builds it). A CLI write hedges only
  when its Err passes through `timed_out_write`, which also re-leads a generic
  sentence with its caller's noun: at a helper (`glab_write`,
  `glab_write_fields`, `run_gh_api_write` / `run_gh_api_write_json`,
  `discussion_write_error`, the Projects reply helpers `project_reply`,
  `write_reply` and `bulk_response`) or in a direct call at the write (the
  GitHub issue create and REST edits, the webhook saves, a card's field edit,
  the Bitbucket repository create, GitLab's positioned commit comment). Direct
  calls also cover every other GitHub write under `src-tauri/src/github` and
  forge/github.rs, one roster row each in
  `every_listed_github_write_hedges_its_timeout` (github/repo_meta.rs, which
  sees only its rows), and GitLab's JSON-body and raw writes (a new review
  thread, a pipeline run, the webhook saves, a CI variable, the merge, fork and
  star) and its reviewer save (`set_pr_reviewers`), a set
  `every_gitlab_write_route_hedges_or_is_listed` (forge/gitlab.rs) closes for
  writes whose method token is a literal in their own function. A new GitHub or
  GitLab write adds its map and its roster row in the same change.
  `run_gh_maybe_attached` maps through `gh_write_error` (github/pr.rs). A write
  with no noun at its helper takes `LandedWrite::Changed`. Left bare on purpose:
  on GitHub, the publish create (its own sentence under kind `gh`) and the
  writes reported under a sentence that says they did not happen (the
  head-branch delete after a merge; the label, assignee and detail follow-ups of
  a create); on GitLab, an image upload (its refusal says nothing was posted or
  saved, or carries the pushed lead on a new merge request), a review's draft
  notes, the merge's attribute PUT, the reviewer add and restores around a
  change request (`set_mr_reviewer_ids`, hedged only at `set_pr_reviewers`), and
  publish (its older sentence). A compound review wrap gives a timed-out step
  its own may-or-may-not sentence under its forge's own kind instead of printing
  the hedge under "failed": Bitbucket's summary and comment steps, and both
  forges' verdict step and change-request comment, have a timeout arm; GitLab's
  publish step has its own sentence on its plain timeout; GitLab's summary-draft
  and comment-draft steps keep the plain timeout under their "not submitted"
  leads. A read keeps the bare timeout, and so does a read that runs before a
  write in the same function. A Bitbucket or Jira write reads a received 2xx
  whose body couldn't be read through its classifier (`bb_write_answer` in
  forge/http.rs; `merge_answer`, `created_pr_response` and
  `created_repo_response` in forge/bitbucket.rs; `write_answer` in
  forge/jira.rs), never as the transport error. The outcome follows the helper,
  not whether the caller uses the reply: `bb_post_empty`, `bb_delete`, Jira's
  `send_no_content` and a 200 or 202 merge succeed with the body unread;
  `bb_put_json` and Jira's `put_json` give `saved_reply_unreadable`'s sentence
  under its forge's own kind, callers that discard the reply included, and so
  does a GitLab issue close or reopen whose answer can't be read and whose one
  re-read fails (`gl_issue_closed_after` in forge/gitlab.rs); a create
  gives the may-already-exist sentence, except Bitbucket's pull request create
  (`created_pr_response`: created, number unknown) and repository create
  (`created_repo_response`: reported as created at its URL). A non-2xx and every
  read keep their error. Jira's `raw_request` serves reads only (the POST search
  included); its writes send through `raw_request_split`. A create whose exit-0
  or 2xx reply is neither empty nor JSON returns `created_reply_unreadable`'s
  sentence under its forge's own kind (`jira_reply_unreadable` for Jira): the
  readers that parse a create's reply call `created_reply` before reading a
  field (GitLab's `created_ref`, `created_release_url`, `forked_project` and
  `added_time_stats`; GitHub's `created_issue_ref`, `created_discussion_ref` and
  `created_from_reply`; Bitbucket's `created_pr_ref` and `bb_created_reply`);
  GitHub's pull request create, attached issue create and release create
  (`gh_release_create`) scrape a URL instead. A create that must return its item
  gives the same sentence when the accepted reply carries none: `bb_post_json`
  (every other Bitbucket POST create; an empty 2xx is accepted), Jira's
  `post_created` (its comment and worklog through `created_with_id`), GitLab's
  fork and add-spent-time through `forked_project` and `added_time_stats` (the
  add route only; the estimate and reset routes keep their parse error), the
  Projects creates through `created_from_reply` (a reply with GraphQL `errors`
  returns its reader's own result, unhedged; gh exits non-zero on GraphQL
  errors, so no write reaches it with one) and `gh_hook_create`. A New pull
  request or merge request that fails after its push says the branch was pushed:
  a plain failure leads with `BRANCH_PUSHED_FAILED_LEAD` (`@/lib/error-summary`;
  built by `after_push_error`, `mr_post_error` and `pr_post_error`; a missing
  gh, or a missing glab at the merge request's POST, passes through unwrapped,
  while a new merge request's image upload error after the push is always a
  refusal under that lead, a timeout and a missing glab included), and a
  timed-out or unreadable reply to the create keeps its own after-push sentence.
  Every step after the push sits inside that wrap, so no create returns a
  `git`-kind error once the branch is pushed, and the summary composes the lead
  with the network sentence. A push that itself times out is recognised only by
  its exact message, `GIT_PUSH_TIMEOUT_MESSAGE` (defined in
  `@/lib/error-summary`, read by `createTimedOutAtPush` in
  `@/lib/notifications/pr-create-failed`, tied to `NETWORK_TIMEOUT` in
  git/runner.rs). The compound review wraps live in GitLab's `review_submit` and
  the pure fns `publish_step_error`, `verdict_step_error` and
  `change_request_comment_error` (forge/gitlab.rs), and in Bitbucket's pure fns
  `change_request_comment_error`, `review_summary_error`, `review_comment_error`
  and `verdict_step_error` (forge/bitbucket.rs); `review_submit`,
  `request_changes_mr` and `request_changes_pr` call them. The wraps that set
  the step's error in parentheses (two on Bitbucket: a review comment and the
  verdict; three on GitLab: the staged drafts, the failed publish and the
  verdict) split it through `paren_parts` (forge/mod.rs), so a multi-line
  error's first line closes the parenthesis and the rest follows it. Each pure
  fn's timeout arm holds only its error's cause in parentheses, from
  `crate::forge::timed_out_cause` (nothing when it carried none;
  `publish_step_error`, whose bare `run_glab` times out as a plain `Timeout`,
  first builds `write_timed_out`'s error from its seconds and reads the cause
  back); the other wraps put the error after a colon. Every wrap keeps its
  partial-state line ahead of the network rewrite through `PARTIAL_STATE_WRAPS`
  (`@/lib/error-summary`): a new wrap literal in any of those fns joins that
  table. `reviewMayHavePosted` (same module) answers true for a `mayHaveLanded`
  error or for a table row not marked `nothingPosted`; a marked row answers
  false unless its embedded error shows that step may have landed. The Submit
  review dialog records it at a failure, when the attempt carried a summary or a
  comment, and asks before the next post.
  `scripts/attached-failure-leads.test.mjs` counts each of those fns'
  `AppError::<Variant>(format!(` literals and fails unless they match its wrap
  rows plus its listed non-wraps (a message bound before it is wrapped goes
  uncounted), and pins the builders and both contracts from both sides.
- **Linked-issue reference lines** — every create and edit save composes the
  body with its chips through `composeBodyWithRefs` /
  `composeBodyWithJiraRefs` (`src/features/pulls/useLinkedIssueChips.ts`),
  never a hand-appended line. Whether a chip's line is already written is
  `writtenRefs`'s call (same module), which reads a plain GFM `marked`
  lexer's blocks and is built to err one way: it may miss a real line (the
  chip then writes a second one) but must never count one a forge renders as
  code or hides. Its doc comment lists what is out of its sight, where that
  direction isn't guaranteed; a new skip or stop rule keeps the direction.
- **Settings dirty compare** — a settings form holding a list the forge
  normalises (topics) compares its draft through `settingsDirty`
  (`src/features/repo-settings/settings-dirty.ts`), never through a raw
  `JSON.stringify`: the forge may answer a save in another order and keeps
  one spelling of topics that differ only in letter case, so a raw compare
  of the draft stays dirty after the save lands.
- **Settings list retention** — a repo-settings list read renders through
  `RemoteListSection` (repo-settings/parts), never `AsyncListBody` fed a raw
  query error: a failed or parked refresh keeps loaded rows under a notice.
  Settled by omission (no `fetching`), so Retry survives its own press.
- **Settings form retention** — a repo-settings FORM over one read renders
  through `RemoteFormSection` (repo-settings/parts): gated on absent data,
  never `isError`, so a failed or parked refresh keeps the form and its draft
  under a notice above it. A draft that reseeds after a save holds only touched
  fields and retires them through `reconcileTouched` + `stampSent`
  (repo-settings/touched-draft, pinned by its test; a save that canonicalizes
  client-side, like Funding's, remaps its draft to the canonical form and
  stamps that) — never a clear on
  save (a failed post-save refetch shows the pre-save values) or a
  `dataUpdatedAt` key (every focus refetch wipes the draft); a whole-object
  draft would send another client's newer values back stale.
- **Offline remote writes** — a repo-settings control that fires a remote
  write (add, save, delete, role, toggle) gates on `useOnline()`
  (`src/lib/use-online.ts`) with the shared `OFFLINE_WRITE_REASON`
  (`@/lib/offline-writes` — the hold reason; its parked-write sibling is
  `OFFLINE_QUEUED_REASON` via `pendingWriteReason`), disabled with reason,
  never hidden: a mutation pressed offline parks silently and fires on
  reconnect. Confirms take `InlineConfirm`'s / `DangerDialog`'s `heldReason`,
  pickers `HeldRoleSelect`'s, switches `HeldSwitch`'s
  (`@/components/held-switch`; readOnly, never `disabled`:
  one node that keeps its tab stop and gives keyboard and AT its reason;
  inside a wrapping `<label>` pass `inLabel` and title the label). Openers
  that only reveal a form or confirm stay enabled, as do local writes
  (FUNDING.yml, dependabot.yml, removing the upstream remote).
- **Held row pickers** — a row's select (role, ruleset enforcement) held while
  saving or offline rides `HeldRoleSelect` (repo-settings/parts): readOnly +
  gated open, never Base UI's `disabled`, which drops the trigger and its
  reason from the tab order.
- **Flip-capable menu rows** — a menu item whose `disabled` can change while
  the menu is open (an offline flip, a pending write starting or settling)
  carries `MENU_HELD_ROW_CLASS` (`@/components/menu-held-row`): the vendored
  `data-disabled:pointer-events-none` otherwise makes the hovered row stop
  being a hit target, and the resulting `pointerleave` drops focus to the
  menu popup (keyboard navigation is unaffected). The override keeps the row
  hit-testable; Base UI's `useButton` still gates clicks on disabled rows.
- **Confirm-swap focus** — a control that swaps with an inline confirm hands
  focus across the swap via `useConfirmSwapFocus` from
  `@/components/confirm-swap-focus` (re-exported by repo-settings/parts): the
  same ref on the trigger and on `InlineConfirm`'s `swapFocusRef`, keyed per
  row in lists; without it the dialog's focus fallback sends focus to the
  popup when the focused node unmounts. A confirm that removes its own row or
  container lands on a successor: mark the row `data-confirm-row`, the section
  root `data-confirm-section`, and its first input or add control
  `data-confirm-fallback`. A roving-stop row is its own successor when the row
  element carries a literal `data-confirm-swap`, and a leave that takes the
  section itself tries the `data-confirm-host` ancestor's fallbacks before the
  host. A successor never runs, sends or deletes on Enter, since a held Enter
  repeats. One whose fresh Enter still acts ignores a repeat: a button takes
  `onKeyDown={ignoreHeldEnter}` from the same module (preventing the keydown
  cancels its click), while an editor-opening row or an add input checks
  `!e.repeat` in its own Enter handler. A row whose safe control is a
  component that takes no DOM props marks it with `markSwapStop(selector)` on
  the row ref. The act button holds by reason while pending, so it keeps
  focus through the write.
- **Invalidation keys** — cache invalidation goes through the shared key
  builders in `src/lib/git/queries/`; a hand-built key or raw-path key
  silently fails to co-invalidate siblings.
- **View-diff whitespace mode** — a view-diff fetch (working tree, commit,
  compare, stash, session) reads `useHideWhitespace()`, keys on it last, and
  fetches through `readViewDiff` (`src/lib/git/whitespace-diff.ts`), which
  stamps `whitespaceHidden` / `whitespaceOnly` on the result. Gates and arms
  read those marks, never the setting alone, and no patch is applied from a
  `whitespaceHidden` diff. `scripts/hide-whitespace.test.mjs` is the ratchet.
  Both settings are app-wide and a flip rebuilds a hidden tab's open line
  composer, so any writer of `diffHideWhitespace` or `diffViewMode` checks the
  shared probe first (`whitespaceComposerOpen` / `lineComposerOpen`,
  `src/features/diff/whitespace-mode.ts`); that test's writer roster fails a
  new unguarded writer. A listed comment's open edit is no probe arm: its row
  is pinned to the list (see *Commit comment placement*). The two forge-patch
  hosts (a pull request's Files pane and commit drill-in) take the mode through
  `useForgeWhitespaceDiff` (`src/features/diff/use-forge-whitespace-diff.ts`):
  a proven `-w` diff of the two file versions, stamped with the same marks,
  never `readViewDiff`. The composer's anchor and position math reads the forge
  section, and the probe counts an in-anchor editor only under
  `[data-diff-anchor="whitespace"]`. The setting is a request: only the view
  producers and the toggle controls read `useHideWhitespace` (the test's
  reader roster), and whatever describes the screen reads the painted report.
- **Queries package boundary** — import the git query layer through the
  `@/lib/git/queries` barrel; `queries/internal.ts` is package-private. Modules
  inside the package may import it but never re-export it, since `export *`
  chains would republish it through the barrel. Guards: `queries-internal-import`
  (callers outside), `queries-internal-reexport` (re-exports anywhere inside),
  `queries-barrel-internal-reference` (the barrel may not name it at all).
- **Git-only invalidation** — a git mutation that can't change forge state
  (fetch, pull, checkout, switch, stash, whole-file discard) passes
  `localOnly: true` to `useRepoMutation`, which invalidates the repo subtree
  filtered by `isLocalRepoQuery` (`queries/local-query-filter.ts`): a query
  is local when it sets `networkMode: "always"` (the split the ratchet test
  `networkmode-local-queries` enforces), minus the overrides it names in
  `NETWORKED_ALWAYS_OVERRIDES`. The ratchet fails only on networked "always"
  reads it can recognize (named callees, the `forge`/`gh`/`jira` families,
  classified commands); any other networked read under "always" (a `fetch…`
  helper, a raw `fetch()`) can't be listed as-is, since an entry matching no
  recognized read fails as stale. Route its callee through a recognized name
  first (a `NETWORK_CALLEES` entry or a `forge`/`gh`/`jira` name; a misfiled
  command moves to `NETWORK_COMMANDS` or `MIXED_COMMANDS`), then list it in
  `NETWORKED_ALWAYS`, state `refetchOnReconnect` on the query itself, and add
  a repo-rooted key to `NETWORKED_ALWAYS_OVERRIDES`. Push, tag push and forge
  writes keep the whole-repo default, since a push moves PR heads and starts
  runs; reset, merge, rebase, revert and cherry-pick still take it for now,
  and hot working-tree ops keep their narrow `invalidate`. The window-focus
  pass refetches only active queries that are stale by their own staleTime
  or errored, never a blanket invalidation.
- **Whole-repo settles skip star history** — every whole-repo write settle
  (the `useRepoMutation` default via `filtersOf`, `invalidateRepoAfterWrite`,
  the update-from holder release in `queries/branches.ts`) carries
  `settlesOnRepoWrite` (`queries/repo-mutation-options.ts`), which leaves
  `repoKeys.starHistory` alone, since an infinite-query refetch re-walks every
  loaded page, and also leaves alone a board lens a date-shift chase holds
  (`shiftChasedLenses`, `queries/board-writes.ts`, matched by query hash), since
  a read landing mid-chase would have it write the server's older dates back. Star
  history's key ends in the series it reads, host and slug
  (`starHistorySeries`, from the forge status), and the backend reads only
  that series (`--hostname` pinned to origin's gh login spelling, refused
  while that login's host isn't the series host), so a write that re-points
  origin (fork, an `origin` set-url) moves the writing checkout to a fresh
  series through the forge status its settle refreshes; a sibling checkout
  moves when its own forge status refreshes. The writes that move its stars
  settle every cached series of it themselves: Star/Unstar through
  `invalidateStarHistory`, Explore's Star/Unstar through
  `invalidateStarHistoryForSlug`, delete and visibility through
  `resetStarHistory` (`queries/insights.ts`); a new write of that kind joins
  them. An
  out-of-band origin edit (terminal, MCP) moves the read once the forge status
  next refreshes; until then it reads the old series, never a mix. A failed
  older page is a marker page in the series, so the read stays a success that
  ages normally.
  A new bare `["repo", repo]` invalidation outside `filtersOf` takes the same
  predicate. A read that must not be re-walked by
  the offline park sets `meta: { [OFFLINE_PARK_META]: false }`
  (`src/lib/offline-park.ts`).
- **Push-like run recheck** — writes whose own default trigger starts CI for
  the code they touch arm `recheckRunsAfterPush` (`queries/push-writes.ts`) on
  success, because the run can appear, or flip status, after the settle-time
  read. They are: pushing commits or tags; renaming a branch on its remote
  (`useRenameBranchOnRemote`, `queries/branches.ts`, whenever its push landed:
  renamed or old name kept); opening, reopening or landing a pull
  request (origin-lens merge, GitLab arm-auto-merge) or updating its branch; a
  resolve push; publishing or deleting a release; publishing a repository;
  creating a linked branch on the origin lens; dispatching a workflow; and
  re-running, playing or approving a run. Out of scope: non-default activity
  types (ready-for-review) and other events (labels, comments, reviews, Pages
  builds). Deletion pushes and cancel are reasoned exclusions. Some arms also
  hand it `prChecksRecheck` (`queries/pr-actions.ts`), so the PR's checks
  rollup and the list's CI badges are re-read with the run lists. Create, the
  merge-resolve push (`useMergeRemotePr`), update-branch (on accept and on the
  head move), reopen and merge name their PR; the finish-resolve push
  (`useFinishRemotePrResolve`) covers every PR in its lens. A plain push,
  re-run, re-run job, play job and approve name no PR and cover both lenses.
  A remote rename hands none: the name it pushes has no PR yet.
  Merge hands them because a Bitbucket fast-forward puts the PR's head sha on
  the base, and Bitbucket's checks read that sha's statuses; for any other
  merge it is a precaution. A later arm re-arms the per-repo timer, and its
  one fire covers every coalesced arm's reads. A remote-branch delete instead
  schedules `recheckListsLater` with `headDeletePrListKeys`, and a remote
  rename that deleted the old name (`renamed`) schedules the same re-read
  besides its run recheck (both in `queries/branches.ts`; GitHub closes a
  head-deleted PR asynchronously); a PR merge (unless queued), close or
  reopen and an issue close or reopen arm the same re-read with lens-scoped
  list keys, since the forge's list membership lags the row's own state. A
  merge also owes that re-read the lens's issue lists and issue detail
  reads, since the forge closes the issues a merge resolves after it
  answers. Its per-repo entry holds the union of the keys owed and fires ONE
  invalidation. Guards: `scripts/push-recheck-family.test.mjs` pins the arm
  sites (the run rechecks, keyed on the api callees; the branch-delete,
  remote-rename, merge, close and reopen list re-reads, which no other write
  schedules), and
  `scripts/push-writes.test.mjs` pins the union fire.
- **Remote state re-file** — a write that changes a remote PR's or issue's
  open/closed state (a merge unless queued, a close, a reopen) re-files that
  row in every cached list page of its lens on success, right after arming
  its delayed list re-read (it doesn't wait for that re-read to fire),
  through `patchRowState` (`src/lib/remote-state-filter.ts`) via the
  module-private twins `patchPrListState` / `patchIssueListState`: it
  rewrites the row's state only, never inserting or removing a row, and an
  untouched page bails so it keeps its identity. A merge of a native GitHub
  stack also re-files as merged the open layers below it, the set the cached
  PR details listed when the merge started (`cascadedStackNumbers`,
  `src/lib/remote-state-filter.ts`). One deliberate non-member:
  GitLab's arm-auto-merge (`useGlArmAutoMerge`) patches nothing even though
  arming can merge at once, because its void outcome can't tell armed from
  merged; the whole-repo invalidation covers an immediate merge. The
  src/-wide scan in `scripts/remote-row-state-wiring.test.mjs` pins every
  caller of the five forge state writes it can see; that test's header lists
  the shapes the scan can't see.
- **Landed-merge details** — a merge that landed (not queued) also marks the
  request's details through `markMergeLanded` (`src/lib/git/queries/prs.ts`),
  per QueryClient and keyed on the details query key, for `LANDED_MERGE_TTL_MS`.
  Each mark holds one QueryCache listener that keeps the STORED entry out of
  OPEN and MERGING for every writer (a read in flight at the mint, a mutation
  rollback, a manual `setQueryData`), patching in the same notify batch, so a
  synchronous observer can still see the OPEN first. Only an accepted fetch
  answer of CLOSED retires it (query-core marks `setQueryData` writes `manual`,
  a cancelled read stores nothing); the listener stops at the deadline, and the
  expiry invalidates the details once by exact key (an active view re-reads, an
  inactive entry is only marked stale). The details queryFn's overlay is a pure
  transform (OPEN or MERGING answers return as MERGED) that never touches the
  record or reads `signal`. While a GitLab MR's details read MERGING,
  `useGlMergingWatch` (`queries/pr-actions.ts`) polls the slim merge-state read
  under the view's own key every 2 s for up to 10 answers; an unlocked answer
  invalidates the details by exact key (joining a read in flight), and an
  unlocked MERGED marks the merge landed. The neutral PR states are OPEN,
  MERGED, CLOSED and MERGING (GitLab's `locked`); MERGING behaves as CLOSED in
  every list and align predicate, and its words come from `prStateWord` /
  `prPill` (`src/lib/pulls/pr-state.ts`).
- **Run-scoped forge reads** — an automation pass shares its diff and each
  action's review-activity read, and an interactive review run shares its one
  review-activity read, through `createRunReads`
  (`src/lib/automations/run-reads.ts`): single-flight, rejection-evicting, and
  entries the run's own delivery can change are evicted after each action that
  ran. Consumers never mutate a shared result.
- **Mutation identity pinning** — every mutation is constructed through
  `useMutation` from `@/lib/started-mutation`, never react-query's own (guard:
  `raw-react-query-mutation`, with `started-mutation-present` pinning the
  helper's path). It snapshots each mutation's options into the context
  react-query builds once per execution, so a mutation's mutationFn and option
  callbacks are the ones in effect when it started (the observer's options at
  the `mutate` call; a per-call `mutate(v, { … })` callback is fixed at the call
  anyway), however its host re-renders before it settles: a write parked
  offline lands on, refreshes and patches the repo/PR/lens/link it started on.
  `scope` and `gcTime` are not snapshotted (query-core reads them off the live
  options), so a `scope.id` derived from render state would follow a switch.
  The helper's `meta` key (`STARTED_KEY`) is reserved (wrapping throws on
  any other options carrying it), and client mutation defaults are banned,
  since its trampolines shadow them: the `mutation-defaults` guard fails
  any use of the client's defaults API and any `defaultOptions` beyond a
  `queries`-only literal. Every `getMutationCache()` call leads straight into a
  member that makes no mutation (`getAll`, `find`, `findAll`, `subscribe`,
  `hasListeners` or `clear`), never `build(…)`, which makes one the helper never
  saw (guard: `mutation-cache-access`; its one exemption is the reference
  `useMutationCacheSnapshot` holds in `queries/internal.ts`, pinned to its exact
  statement). The snapshot can't reach a mutation not yet started: a
  handler that calls `mutate` after an await, or from a confirm whose state
  outlives a switch, builds from the observer's CURRENT options, so it must
  record the repo when it starts (a dialog: when it opens) and refuse through
  `refuseIfSwitched` (`@/lib/stores/notifications`, beside `landedIn`) at the
  point the write would start, passing its outcome and, once the prompt is gone,
  a `when` lead (the reference is `doResetToUpstream` in SyncControls.tsx). Copy
  that can't take that shape (a partial-state error, or a "Didn't <verb> …" line
  kept in step with a twin) reads `landedIn` once and builds its message from
  that one result's `live` and `away` (`closed` picks "you closed the
  repository" over "you switched repositories"; the publish twins don't yet).
  The shared confirm store covers the prompt window once the switch applies (a
  repo-scoped `ask` resolves `false` on a switch), so a per-site stamp is for
  writes started after a NON-confirm await, or after further awaits that follow
  the answer. The store stamps the repo at ASK time, so a caller whose repo
  predates an earlier await (a render-time closure, as in CommitDetailView's
  `doCherryPick`) keeps its own `refuseIfSwitched` after the ask. A view whose
  repo can be a worktree rather than the open one compares its own prop instead
  (`useRefuseIfMoved` in `src/features/repository/use-refuse-if-moved.ts`, shared
  by the two conflict views). `refuseIfSwitched` passes again after a switch
  away and back, so a confirm that closes on a switch drops its own session
  (an effect on the repo, marked as switched; an unmount cleanup) and the
  step that resumes raises the same notice through `notifyRepoChanged` for
  the switch, or its dismissal line after an unmount (the reference is
  `doDelete` in BranchSwitcher.tsx). A `useRepoMutation` whose mutationFn or
  callbacks close over repo/lens AND whose host survives a repo switch passes
  `identity: ["<op>", repo, lens]`, which scopes the HOLD: a changed key hash
  detaches the pending mutation at the switch, so the new repo's controls don't
  read the old repo's write as busy. Callers must consume the promise
  (`mutateAsync`), since the observer's `isPending`/`data` go idle at the
  switch. Exemplar: `useCreateIssue`; a plain `useMutation` spells the same
  pin `mutationKey:`.
  Guard: `mutation-identity-pinning` ratchets the cache-seeding sites and the
  create-family ones it can see by NAME, following delegation one level inside a
  module. It scans the git-queries package, `lib/jira/queries.ts` and the local
  PR/issue query modules (both local wrappers key unconditionally,
  `["local-pr" | "local-issue", op, repo]`; a wrapper keyed through an optional
  parameter would oblige its delegating call to pass one) — a repo-scoped create
  written anywhere else is unratcheted, and the wider class stays a review
  concern. The creates `useAddRemote`, `useAddCollaborator`, `useAddSubmodule`,
  `useAddUserWorktree`, `useAddMrSpentTime` and `useForkRepo` (repo-access.ts —
  RepositoryMenu reads its observer as the re-entry guard) stay unpinned BY
  DECISION: their callers read `isPending` as a re-entry guard, which a pin
  idles, so the isPending → cache-reader migration comes first.
  (`useSubmitReview`, `useAddIssueSpentTime`, `useAddDiscussionComment` and
  `useForkRepoByName` — a different hook from `useForkRepo` — are pinned, their
  re-entry guards on mutation-cache readers.) A cache WRITE
  (`setQueryData`/`setQueriesData`) in `onSuccess`/`onError`/`onSettled` keys
  from the callback's own parameters, never hook scope. The snapshot already
  runs the settle callbacks in effect at the start, so this is defense in depth:
  `onMutate` runs once at mutate time and its result rides the mutation's own
  state, which would still name the right entity if a settle ever ran through
  other callbacks than the ones `onMutate` ran with (no path does: react-query
  re-executes a mutation outside its original execution only after hydration,
  building it from mutation defaults rather than a render's options, and nothing
  here hydrates). Build the key in `onMutate`, return it in the context, read it
  back (`useSetRepoStar` is the reference). The carve-out is a pinned
  `useRepoMutation` seed: it has no `onMutate` to key from, so it relies on the
  snapshot (`useCreateIssue`, writing through `insertCreatedIssue`, is the live
  instance). Context-keying needs no pin of its own, so `isPending`
  stays live — but the pin rule above is separate and still applies: an EXPORTED
  repo-scoped hook whose `onSuccess` seeds the cache keeps its mutation key
  however the seed is keyed. Guard: `settle-cache-write-identity`, over the
  same modules; a write through a helper, a callback passed by name, and
  `useOptimisticCacheMutation`'s `reconcile` stay review concerns (the check's
  message lists the rest).
- **Pending-write holds** read the mutation cache through
  `useMutationCacheSnapshot` (`queries/internal.ts`) with a caller-memoized
  `select` (`useCallback` over stable deps: primitives or module-level
  constants), never `useMutationState` (its ref goes stale across an
  `<Activity>` hide) and never the observer (it tracks only its latest
  call). The pure projection goes in an import-free module (`pr-writes.ts`,
  `board-writes.ts`). A projection that CASTS the variables
  casts through the same exported type the mutation's generic uses
  (`ThreadWriteVars`, `DiscussionUpvoteVars`), so a renamed field fails to
  compile; the runtime-guarded readers (`boardWriteVars`, `pendingPrWriteTarget`,
  `releaseWriteTag`, `usePendingStatusUpdateWrites`) `typeof`-check each field
  instead. A per-record write in a `[family, kind, repo]` family is read with
  `usePendingRepoWrites` + `pendingWriteMatching` (typed twins:
  `pendingIssueWrite`, `pendingDiscussionWrite`), matched on the record its
  variables name.
- **Branch-push family** — a branch push and a remote rename share one mutation
  key (`branchPushKey`, `queries/push-writes.ts`), so every hold that
  reads the family (`usePendingBranchPushes`, `refuseWhilePushRuns`,
  `refuseWhileBranchPushes`) covers both. `pendingBranchPushesFor` reads a
  rename (`RemoteRenameVars`) as TWO states, the old name and the new, marked
  `renaming`: the row carries either one while it runs. A new write that sends
  a branch, or holds the repository's network lock for as long, joins the
  family instead of growing a hold of its own. The one route the family leaves
  open is the rename dialog on a branch whose own remote rename runs in this
  checkout, which shows the running state. Both halves carry the exception:
  the render-time hold (`renameHoldOf`, `BranchSwitcher.tsx`) and the
  fire-time refusal (`refuseWhileBranchPushes`' `exceptOwnRename`).
- **Record-scoped pending** — a detail view or strip that one mounted instance
  reuses across records (the roster is the guard's `MEMBERS` list, below; a new
  reused view joins it in the same change) never reads a mutation observer's
  `isPending`/`isPaused`: that is instance state, so the next record shows the
  previous one's spinner or held control. It reads the cache per record (the
  bullet above). A run spanning several mutations takes a submit-time record
  slot `{repo, …id}` behind a one-run gate (the promote dialogs' `pendingPub`);
  a non-idempotent local write that must hold from the click, before the
  batched cache notification lands, adds a slot set as an object token and
  cleared compare-and-clear, so one press's settle never frees another's
  (LocalIssueView's `statusSavingFor` is the reference). Guard:
  `scripts/check-reused-view-pending.mjs` scans the member files, with reviewed
  allowlist entries pinned to their enclosing function and binding (query
  reads, repo-wide working-tree writes, mounts keyed per record); a plain
  `useState` busy flag and a view outside its member list stay review concerns.
- **Plugin-store open/reload** — an app-data store opens via
  `memoizedStoreLoader` and re-reads via `reloadToleratingEmptyStore`
  (`src/lib/plugin-store.ts`), never a hand-rolled `??= load(storeName(…))` or a
  bare `store.reload()`: the former memoizes a REJECTED load (store dead until
  restart), the latter swallows an unreadable file and saves the cache over it.
  The `raw-store-reload` guard allowlists two files. `writeWithRollback`'s own
  `reload({ ignoreDefaults: true })` (below): the tolerant reload treats a
  missing or empty file as success without touching memory, so the failed
  values would stay; the raw one rejects there and the helper falls back to
  its pre-write snapshot instead. And the relocate migration's reloads
  (`src/lib/repo-data-migration.ts`): re-homing runs outside the feature
  modules' write queues and writes back unconditionally, so the tolerant
  reload's tolerate-or-rethrow decision isn't the guard it needs. Every opener
  passes `storeLoadOptions(file)`: autosave is off unless the file is in
  `AUTOSAVE_STORES`, so each write force-saves or its file joins that list
  (pinned by `scripts/plugin-store-rollback.test.mjs`).
- **Plugin-store writes take the cross-process lock** — a store a second app
  instance (or the MCP server) can write wraps its read-modify-write in
  `withAppStoreLock` (`src/lib/app-store-lock.ts`): identity/git resolution
  BEFORE the lock, reload → mutate → forced `save()` inside it, all within the
  module's serialize queue. Advisory and fail-open; cold-start instances skip it.
  Everything after the entry reload, the forced `save()` included, runs inside
  `writeWithRollback(store, …)` (`src/lib/plugin-store-rollback.ts`), returned
  from the lock callback: a failed write restores the store when it can (from
  disk, else from its snapshot; when both fail, nothing is restored or saved)
  and rethrows the original error, which callers' error handlers match on.
- **Per-repository records** follow `src/lib/deleted-branches/store.ts`: keyed
  by `repoIdentityStrict`, written under `withAppStoreLock` with the tolerant
  reload and `writeWithRollback`, registered in `repo-data-migration.ts` and in
  `scripts/app-store-lock.test.mjs`'s ADOPTED roster — a record that skips one
  strands across worktrees, races another writer (a second app instance, or
  the MCP server for a store it writes) or orphans on relocate.
- **Settings writes seed the cache** — component-started settings writes go
  through the `src/lib/settings/queries.ts` hooks, and any new settings
  `useMutation` spreads `...settingsSeedCallbacks(queryClient,
  settingsKeys.settings)` (`src/lib/settings/heal.ts`): a resolved write leaves
  its committed snapshot cached even when the re-read fails, unless a newer
  settings mutation started. Raw api writers that bypass the hooks invalidate
  the cache themselves. The queries.ts pin in
  `scripts/settings-cache-seed.test.mjs` enforces the spread.
- **Per-record repo scope** — a record offered per-repo-or-globally carries a
  `scope` string: the `"global"` sentinel (also the absent-value default) or
  an identity key. Reads match BOTH key forms (raw + identity, most-preferred
  last); writes fold raw→identity; an UNKNOWN scope fails closed (never widens
  to global); the owning store re-homes old-path keys on relocate, inside its
  own serialized write. Two instances: `settings/mcp.ts` (`serverScope`;
  `rehomeServerRepoKeys`, run by `relocateRecentRepo` on the settings chain)
  and `scripts/scope.ts` (`taskScope`; its re-home is `rehomeTaskScopes` in
  `scripts/store.ts`, run from repo-data-migration.ts) — deliberate mirrors of
  each other, not a shared import.
- **Repo-identity observers** — every observer of `["repo-identity", repoPath]`
  spreads the ONE factory `repoIdentityQueryOptions`
  (`src/lib/git/repo-identity-query.ts`), never an inline query: its strict
  queryFn REJECTS on IPC failure, so a transient error retries instead of pinning
  the raw-path fallback for the session. Three steady states, not two — resolved,
  pending, and a MOUNTED observer sitting on `isError` with no data until a
  remount: a consumer gating on `data !== undefined` must treat the error as
  settled (fall back to the raw path, the key the swallowing `repoIdentity` and
  the disk loaders use) or its gate never opens. A store's WRITER takes
  `repoIdentityStrict` unless its reads heal through a `foldIdentityKey` fold:
  swallowing in a fold-less writer mints a record no healed read consults (the
  exemplar is `conversation-filters/store.ts`); loaders may still swallow, since
  a defaults read costs one session, never a strand. `pnpm run checks` fails the
  `inline-repo-identity-query` guard on the key spelled anywhere but the factory.
- **Hydrate gating** — a `hydrate` that swallows its read must NEVER set the
  ready flag, and a snapshot write gates on a RESOLVED `hydrate()`, not on the
  flag: `memoizedStoreLoader` retries after a transient failure, so a store
  marked ready on an empty read will write that empty snapshot over data it
  never read (re-attempting on the write path is what makes it self-heal).
  The flag alone suffices only where the state provably cannot change before
  the read lands — `agentNumber`, whose `ensure` won't mint while it's false.
- **Ref names vs short refs** — HEAD's branch comes from
  `git::branches::current_branch_name` (or `current_branch_ref` for a rev
  position), never `rev-parse --abbrev-ref HEAD`; ref lists read `%(refname)`
  and strip exactly `refs/heads/` / `refs/remotes/` / `refs/tags/`, never
  `%(refname:short)`. git's short forms disambiguate (`heads/<x>`,
  `remotes/<r>/<x>`, or the full ref) whenever a tag or other ref shares the
  name, so a NAME use (comparison, branch argument, config key, refspec, forge
  API) misroutes. A REV use keeps git's form or the full ref, never a stripped
  bare name, which resolves to a same-named tag first. `symbolic-ref` also
  answers on an unborn branch — a site that must refuse before the first commit
  checks `git::history::unborn_head`, which errs on a non-repository or an
  unresolvable detached HEAD, and on git 2.43+ on a corrupt branch ref too
  (`branches::head_is_unborn` still reads any failed probe as unborn).
- **Branch names as revs** — a branch name never reaches a REV position (a
  range, a `^{commit}` peel, a rev-taking argv, a `fetch` refspec source) bare:
  gitrevisions resolves a same-named tag first. Resolve it via
  `git::branches::branch_first_rev` (once per side for a pair; inside
  compare.rs, `local_branch_revs`) or read the tip sha via
  `git::branches::branch_tip_sha`; frontend composes pass `refs/heads/…` /
  `refs/remotes/…` as the rev and keep the short name for display.
  `<branch>@{upstream}` stays bare — git looks that name up as a branch and
  refuses the `refs/heads/` spelling (measured, git 2.51.1)
  (guard: check-rust-invariants check G).
- **Listed values latch per name** — a list that later acts on a value it
  measured (Clean up's delete at each listed tip) latches it the way
  `useListedBranchTips` (`queries/branches.ts`) does: the first successful read
  wins, names that appear later are read when they appear, and the action holds
  while a read is pending or failed, so it never acts on a value re-read since.
- **Agent stream notices** — a store that consumes `runAgentSession` passes
  each `notice` event to `noticeEffect` (`src/lib/ai/agent.ts`) and applies
  its result: a `note` transcript segment in the turn it arrived in, and on
  `replaceNativeSession` a run-local flag that lets the next `nativeSession`
  of that run replace the stored id under the store's ownership gate, while
  the notice alone never drops the id. The conversation-id token is opaque and
  never parsed.
- **Per-model effort levels** — every effort picker renders from
  `useEffortControl` (`src/lib/ai/effort-levels.ts`) with the kind, binary
  path, model and isolation its run will pass. Unavailable levels stay listed
  and disabled with one reason line, a stored level is kept, and a
  Select-based picker marks a blocked level in its option text (the vendored
  Select does not skip a disabled item on arrow keys). A new picker joins the set
  that `git grep -E "EFFORT_LEVELS|EFFORT_LEVEL_LABELS|REVIEW_EFFORTS" -- src`
  closes.
- **In-diff editor keep** — an editor that can open in a diff row (the line
  composer, and in an anchor row a comment edit, a thread Reply or a pending
  draft's edit) keeps its text through `useKeptDraft`
  (`src/features/diff/editor-keep.tsx`). A rebuild of the rows restores it on
  the same line number (an insert above it holds) when that line and its two
  neighbours still read the same: a provable file edge (before line 1, or past
  the end of a whole-file build) reads as a sentinel no line's text equals, so
  it matches only another edge (a blank line added or removed there holds),
  and a gap
  placeholder or a line past a hunk-only build's hunks never matches.
  Otherwise that file's earlier rows stay drawn until it closes, and while
  those rows show an older text the line composers (`ReviewComposer`,
  `CommitLineComposer`) hold their submits with `DIFF_ROWS_HELD_REASON`
  (rows that catch up by themselves, a build waiting on its read, hold with
  the loading reason instead). An
  editor that marks itself for `DIFF_EDITOR_SELECTOR` without adopting the
  hook is held across rebuilds within one record, never dropped; a record
  move, or a new build on a host that names no record, drops it. A diff with
  no `forgePatch` whose rows belong to a host record (a typechange's text
  half) passes that record as `keepScope`. Each comment's editor and its
  controls sit inside an element carrying `data-keep-id` (`KEEP_ID_ATTR`)
  set to the editor's keep id, so a restore refocuses that comment's field
  or the control that had focus (its Comment actions menu, a pending draft's
  Edit), never a same-labelled one of another comment in the row. A control
  is recorded only by its `aria-label`, so each of these carries one. While an
  editor holds rows or an arm, the pane draws one held paint, data only (the
  comment above DiffContent's `armHeld`): a `DiffLineAnchor` is a placement
  (side, line, `items`, editor `ids`, compared by value), and its body comes
  from the host's `renderAnchor`, passed straight through and read live by
  each row, never stored (an `Assert<IsData<…>>` beside each held type, from
  `src/features/diff/held-data.ts`, fails `tsc -b` when anything reachable
  from it is or may be callable, an optional member, a union constituent or a
  member declared beside an index signature included; out of its reach, and
  read as data: a member a brand adds under its primitive's own key, one a
  readonly array adds under a mutable array's method name, an Array
  subclass's non-public member, a template-pattern index signature's value
  beside a `string` one, and a member declared beside an
  index signature on a brand, array or tuple, a split made on plain objects
  only). So every card action runs on live
  state, resolved by item id, and a held row whose items the host no longer
  lists gets a null body: no row chrome and no `AnchorMount`, so its ids are
  absent from the report's `drawn`, which holds the item ids of mounted
  placements whose body is non-null (every id the placement carries). The host
  lists any comment it still has whose id `drawn` lacks, so a newer item on a
  held row's line stays listed until a placement carrying it mounts.
  Line posting and Add suggestion are refused while held. A thread resolved
  elsewhere stays open while it draws an open Reply or edit, an `<Activity>`
  hide included: `DiffThreadAnchor` owns the row's open editor set
  (`useOpenEditorsHost`, read by the fold and by each editor's
  `useKeptOpen`). A host pairs a placeholder's anchors itself, by text
  (the Files slot keeps its last own paint's placements, History gates on its
  settled read), and DiffContent draws exactly the anchors it is handed. Not covered: a push swapping an
  outgoing body that is no capture node (arm landing, image arm); an
  `<Activity>` hide during a hold; an arm change over a same-arm hold can draw
  the panes above the rows from the refused candidate. Accepted: thread
  positions are the forge's newest, so threads read before the details name
  the new head place its lines on the older text; an editor whose item the
  host drops goes with its card; items created since the held or older-head
  paint stay off the rows until release (the Conversation tab and the
  pending-review bar list them); a held card shows the live thread at the held
  row; Apply reads the live branch, thread and section, its only content guard
  the backend's expected-lines check.
- **Forge-patch diff hosts** — a host whose diff text comes from a forge (a
  pull request's Files pane and commit drill-in) passes `forgePatch` beside
  its `contentRevs` / `imageRevs`: the hunk-match guard
  (`src/features/diff/hunk-match.ts`) decides whether content mode builds,
  and the build upgrades in place. The diff panes' whole-file reads (content
  mode, image diffs) go through `src/features/diff/content-source.ts`, never
  `useFileAtRev` directly; Markdown preview stays a local read. A size gate
  that judges such a read without decoding it takes its byte count from
  `base64Bytes` (`forge-whitespace.ts`), never a local length formula. An editor that
  can open inside a diff row is counted by `DIFF_EDITOR_SELECTOR`
  (`src/features/diff/whitespace-mode.ts`), the one predicate behind
  `lineComposerOpen()` and the upgrade hold; a new one marks its open state with
  `data-diff-editor`. It counts a `data-diff-editor` or `data-thread-editing`
  mark only inside a `[data-diff-anchor]` row; the line composer matches by its
  own `[data-diff-line-widget]` wrapper. The pull request diff keys on the
  target its details name (head, base ref and base sha, from `prDiffTarget`,
  which lowercases a full head and base sha once, so a case-only change never
  re-keys; branch names stay exact), and `usePrDiff` reports `placeholderOf`, so a host tells an older head of
  the same pull request from another record's diff. The content revs key on
  the same target and send it: GitHub compares from the target's base sha
  when it is known, and a re-read naming another base branch (on GitLab,
  another base sha too), or none when the branch is the only base identity,
  refuses; Bitbucket reads the live destination commit and checks only its
  branch. `refreshOpenPr` (`queries/prs.ts`) is the one
  re-read that orders the details before the head-keyed children, which it
  addresses by the exact key of the target the details then name, never by
  prefix. The diff's queryFn is a pure read: a shared-query event may
  trigger a run, never prove one, so it subscribes to no cache, writes no
  key and never reads `signal`. Each run returns one `PrDiffRead` carrying
  its proof: `proven` from the forge, or from the head proof the run starts
  after an `unproven` diff answer, `forge_pr_head_proof` (`forgePrHeadProof`):
  a fresh forge read judged in Rust, never the details query or its display
  view, its answer clamped like the diff's (any other value, or a failed
  read, files `unproven`). A record naming no full head reads by number,
  filed `proven` only on Bitbucket (`PrDiffTarget.byNumberProven`, from the
  record's own URL; an absent flag holds), whose record abbreviates its head;
  elsewhere the target itself holds the review actions on the unproven reason
  (`headUnnamed`), whatever its read's state (cold, in flight, failed, parked or
  answered), until the details name the full commit. The target's head is the
  backend's `headSha`: GitLab and Bitbucket fall back to their newest-first
  list's newest commit (a partial first page still names the head), GitHub's
  never does, and the commits tail counts only from a complete list. On the
  Rust side every head or base field a forge payload carries is an axis of
  its own, judged by the one verdict function `head_proof_verdict`
  (`forge/pr_content.rs`): a readable one naming another comparison answers
  `moved`, missing or malformed evidence proves nothing, and a field the
  proof does not rest on (GitLab's top-level `sha` beside `diff_refs`) can
  only contradict. Bitbucket's diff read gets the pull request first and,
  when it names the caller's head and base branch and a destination hash,
  asks for the diff by commit
  (`diff/{source full_name}:{head}%0D{dest}?topic=true`, the by-number text
  byte for byte), so the request ties the text to the head; a contradiction
  drops it unfetched, and an unreadable read or a failed by-commit request
  falls back to the by-number diff, unproven. GitHub's diff read compares by
  sha from the target's base sha, or, when the record names none (a gh older
  than 2.63.0), from a pull request read naming the target's head and base
  branch. A compare over the cap or refused for any reason except a rate
  limit or a transport failure falls back to the by-number diff. The same
  fallback applies when the pull request is unreadable or names anything
  else. A by-number text carries no identity, so a replica flipping back can
  still prove another head's text. GitHub's by-number fallback and
  Bitbucket's fallback keep that exposure. GitHub's head proof,
  and Bitbucket's after its fallback, is the
  diff read's own re-read; GitLab's is
  contradiction-only (`gl_head_read_proof`: `moved` or `unproven`, never
  `proven`), since its `/changes` text carries its own identity and a later
  payload can't vouch for it. GitLab judges `/changes` on the raw JSON before
  the typed decode (`changes_payload_at`), so a malformed field never hides a
  readable contradiction. Bitbucket's abbreviated hashes need 12 hex at
  least. A moved answer is data
  (`{ proof: "moved", text, checks, recheckAt }`, the prior own text or
  null), re-checked by the options' `refetchInterval` (soon, then at the
  settle deadline `recheckAt`, on the monotonic clock (`performance.now()`,
  so a wall-clock step never spends it), which the first moved answer sets
  `PR_DIFF_MOVED_RECHECK_MS` ahead, since a forge's reads can flip back to
  the older head for most of a second after a push; off while a re-check
  failed and while any read runs or parks, so a passed deadline never ticks
  every millisecond; running unfocused). Once an entry is moved, only a run
  started at or after its deadline may leave moved or end the check: an
  earlier run's answer of any proof (the 50 ms re-check, focus, Retry, a
  refresh) files the second check, deadline kept. The run that ends the
  check files `endedAt`, which later moved reads carry forward; the first
  mounted `usePrDiff` that sees an unclaimed `endedAt` asks the details to
  re-read (once per ended check, whichever view and whenever; a Retry over
  an ended check asks again), so a real push re-keys the view.
  `placeholderData` stamps each placeholder's owner (`olderHead` or
  `otherRecord`) from the previous query's repo, lens and number, never a
  text compare or a render-time copy: a re-key batched before React renders
  can hand over an entry no render drew. A textless entry is served only to
  its own record. The interval lives
  on the observer, so leaving the pull request stops it, and offline it
  parks. `usePrDiff` re-reads an unproven or ended entry when the details
  answer anew, and raw readers take the text through `prDiffText`, which
  throws on a moved entry. `ReviewComposer` (its hold-reason chain),
  `SubmitReviewDialog` and the view's direct Approve and Request changes
  (through `submitReviewHeadHold`; revoking either stays free) hold their
  submits while the painted diff is an older head's, unproven (`usePrDiff`'s
  `headUnproven`, which reads only the key's own text: an older head's
  retained text keeps its failed, offline or loading arm), or under a moved
  check (`headChecking`, read from the data, so a failed or parked re-check
  still holds, on the pane's own loading, failed or offline arm), the
  editor and the dialog staying mounted. Until a full head's target has an
  own answer (`headProving`: under way, failed or parked, whatever
  placeholder is painted, another pull request's included) they hold on
  the cold reasons (`HEAD_COLD_REVIEW_REASON` / `HEAD_COLD_DIALOG_REASON`
  in head-pending.ts), which claim no update; the older-head and
  moved-check arms keep their "was updated" reasons. The failed reason's
  Retry always renders: a diff read that failed while the open slot has
  nothing to draw (no text, an older text without that file, or no file to
  open) shows `PrDiffFailedNotice` (RemotePrViewParts.tsx), wired to
  `prDiff.refetch()`, in place of the Files pane's file slot, or under the
  files notice when no file rows loaded; a slot the older text can draw keeps
  it and its own Retry. One Retry per failure, owned at the Files level
  (`useDiffRetryOwner`, RemotePrView.tsx): focus on a Retry that moves
  between the two placements follows it. A record's own drawn text, its
  entry's or a placeholder stamped as one of its older heads, is what a
  failed or textless read keeps.
- **Commit comment placement** — a resolved comment is inline exactly while
  its anchor row is mounted in the visible slot, else listed: never both,
  and never neither while the host's list is mounted (the PR commit view
  unmounts its list while its patch is pending or failed;
  `src/features/diff/painted-view.ts`). Each diff pane in a file slot
  publishes one painted report of what is MOUNTED (`patch`, the text its rows
  build from, its `-w` and truncation marks, `cut`, and the anchor rows a
  layout effect registered, ref-counted); no report means nothing is inline.
  A host reads its visible slot's report through `usePaintedView(slots)`
  (`file-slot.tsx`), never `useHideWhitespace` or a patch's text, and
  `placeComments` lists everything unmounted plus the pinned. Every note is
  decided in painted-view.ts: the ordered controls that draw the line (Raw,
  Show diff anyway, Show full diff, derived from the cut, the patch's longest
  line and the cap, never an enumerated product), `unplaced`, or
  `whitespace`, a candidate `confirmWhitespace` checks against a
  whitespace-shown read. The pane's side is a second computation the host
  keeps in step: each slot anchors every resolved comment on its path but the
  pinned ones (`useCommitLineAnchors`), resolving lines through `commentLine`
  over the same sections the list passes, from the same comment read the list
  holds. Anchors mount only on a build of the path they were built for (their
  keys carry no path). An open list edit pins its row (`useCommentPins`,
  Thread's `onEditingChange`, reported from a layout effect's setup, never a
  cleanup an `<Activity>` hide runs), so no row change unmounts the edit and
  no control holds for it. A pending cut (no notes) has one producer,
  DiffContent: while its rows haven't reported, a read failed with nothing to
  show, or the host says the paint is another commit's (`paintsOtherCommit`;
  History derives it from the same expression that gates its anchors).

## Rust / Tauri conventions

- **Large ints over IPC:** snowflake/`u64` ids lose precision as JS numbers —
  serialize as strings end-to-end.
- **Lean forge reads:** an MCP tool that needs one or two forge fields reads
  them with a narrow `--json` view on the GitHub arm (`gh_pr_title_body`,
  `gh_issue_node_id`, `gh_issue_summary`), never the full view, and non-GitHub
  arms keep their `forge_*_view` until they get a lean read of their own. Reads
  that should revalidate keep their argv unshaped (see *Cached GitHub reads stay
  true*).
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
- **Local branch deletes compare-and-delete:** a user-requested local branch
  delete goes only through `git::branches::delete_branch_ref_at` (`update-ref
  -d` at a measured tip, its guards run under the config-write mutex), never a
  new `branch -D`: that deletes whatever the ref points at when git runs. Any
  other local branch ref delete (the root-commit undo, PR checkout's
  stray-branch cleanup) stays old-value guarded (`update-ref -d <ref> <oid>`)
  wherever a tip was read to compare (the undo's `-d HEAD` runs only when HEAD
  did not resolve). Guard: check-rust-invariants check M, which reads an
  `update-ref` delete's ref as its first operand wherever `-d` sits, and also
  fails one whose ref it cannot resolve to a non-branch ref.
- **Cached GitHub reads stay true:** gh REST GETs that adopt runner.rs's
  conditional layer (`run_gh_cached_get`/`run_gh_cached_get_raw`) key on
  (repo_path, host, argv) with the auth epoch in the value, detect a 304
  from the `-i` status line only, and never cache a failure; `bypasses()`
  sends paginated, jq/template, include/cache, non-GET and field-without-GET
  argv straight through. An in-app write that moves a cached repos/{slug} or
  stack field evicts after the attempt (`invalidate_repo_meta_after` /
  `invalidate_stack_memo_after` on the spawn's result), and form-feeding
  reads stay fresh. Account-derived memos read the epoch before the fetch,
  keep it in the value, and always carry a TTL (a terminal `gh auth` is
  invisible to the app).
- **GraphQL nullability:** fields without `!` deserialize into `Option<T>`;
  never `unwrap_or_default()` a `from_value`; confirm a field exists before
  querying it.
- **Sync Tauri commands run on the main thread** — take the value under the
  lock, drop the guard, then block; prefer `try_wait`-style non-blocking.
- **Command futures stay small:** the invoke handler CONSTRUCTS a
  `#[tauri::command]`'s future on the WebView2 UI-thread stack before the
  runtime polls it on a worker — a large command future overflows that stack
  in release builds (dev never reproduced it: the debug-profile future
  measured 123,000 B against a ~721 KB release handler frame, and debug
  `Box::pin`s command futures at the IPC boundary; on Windows dev IPC uses
  the same custom protocol). The trigger is per-future stack footprint, not join
  arity: sub-futures holding capture buffers or nested async chains get
  spawned (`tauri::async_runtime::spawn`) or `Box::pin`ned before a `join!`.
  A 7-way inline join of process-spawning probes shipped a stack-overflow
  crash (v0.12.1 About page). (guard: `system_health_future_stays_small`,
  src-tauri/src/health.rs — per-command by choice; a new command joining
  capture-buffer futures adds its own.)
- **Untrusted JSON** (CLI output, forge APIs): TS derivers `typeof`/shape-guard
  each field with `try/catch` per item; Rust uses tolerant serde (`Option<T>`,
  null-tolerant defaults) over strict shapes. Grammar-validate command/URL
  values either side. Third-party timestamps validate before formatting —
  `parseableDate` for ISO strings, `validEpochMs` for epoch numbers
  (`src/lib/time.ts`); never raw `new Date(x)` on forge/CLI data.
- **Windows spawning:** never pass multi-line argv to `.cmd` shims
  (BatBadBut rejection) — feed multi-line input via stdin. Generated launcher
  scripts build through `agent_sandbox`'s `cmd_script_quoted`/`cmd_script_arg`
  helpers under `CMD_SCRIPT_PRELUDE` (refusals before any write; `%` escaped;
  trailing backslashes per the receiving program) — never inline
  quote-wrapping into a script body.
- **Whole-tree kills:** a spawned child whose descendants must die with it (a
  timeout, a cancel, a dropped future) rides `proc_tree::TreeGuard`:
  `TreeGuard::prepare(&mut cmd)` before the spawn, `TreeGuard::arm(&child)`
  right after it, the guard declared after the `Child` so it drops first (an
  unreaped leader pins the unix group id), and `disarm()` only once
  `child.wait()` returned Ok, whatever the exit code. Every abandoned path
  stays armed, and `kill_on_drop(true)` stays as the fallback for a failed
  arm: alone it reaches only the direct child, so Git for Windows' `git.exe`
  shim would leave the real git and its hooks running. A caller that must kill
  before it can reap (an agent run's Stop) calls `terminate()` on Windows, or
  signals the group on unix, and still disarms only after a reap. Adopters:
  the git runner (`run_git_spawn`), the gh and glab runners, host-mode agent
  runs, the opencode 2.x captured commands (agent.rs `capture_tree`: the lock
  read-back, the model listing and catalog, the sign-in export, and the
  container probe and import clients), and the login-shell probes, which arm
  their `setsid` child and never call `prepare`. Unarmed on purpose: the
  gh/glab sign-in child in forge/session.rs and the two console launchers.
  Not armed yet: the PTY children and their `taskkill` path (pty.rs
  `kill_tree`), mcp.rs `run_client_cli`, agent_sandbox.rs `run_build`,
  hooks.rs `git_run_hook_manager` and agent.rs `run_capture_parts` (the CLI
  version and sign-in probes, the opencode 1.x, codex and copilot model
  listings, and the container runtime commands). Tree tests build
  on the fixtures in `proc_tree::test_support` (`Holder`, `wait_until`,
  `HANG_GUARD`, `started_within`, `remove_when_free`): they observe the
  holder start and die and never sleep for either, and a survivor is proven
  by `confirm_alive`, never by a bare `alive()`.
- **User input → git refspecs/argv** routes through the existing chokepoints:
  `validate_ref_name` (git/branches/names.rs), `validate_tag_name` (git/ops.rs),
  pushes via `build_push_args` (git/remote/push.rs) — never construct an inline
  refspec or re-derive the validation. Session-reserved branch names refuse
  through the shared `refuse_session_branch_name`/`is_session_branch_name`
  guard (git/branches/names.rs, case-insensitive) at every branch-minting entry
  point; the two local-switch routes refuse only guess-creation so existing
  session-named branches stay reachable — never re-derive the prefix check.
  MCP tools push only through `git_push_same_name_core` (it refuses a named
  push onto a differently named branch of a named remote) and the HEAD-only
  `git_force_push_head_core` (git/remote/push.rs); `git_push_core`, the GUI's
  follow-tracking entry, stays private to `git::remote` so no MCP tool can
  reach it. Refs reaching a compare-endpoint basehead route through
  `forge::validate_compare_branch` (guard: check-rust-invariants check E).
  Branch names in GitHub REST paths encode via the escaping idiom (the
  `refuse_braced` + `escape_branch_path` pair in rulesets.rs, and the twin
  `escape_head_branch_path` in github/pr.rs — `%`/`#` encoded, braces refused
  before the call); Bitbucket requests resolve through the one choke point
  `forge::http::resolve_url`, which accepts absolute URLs only on `BB_API_BASE`.
  A repo-relative path that a git/ write command receives over IPC and joins
  onto the working tree passes `discard_rel_path` (git/ops.rs) before the join
  (in conflict.rs through its wrapper `conflict_rel_path`), even when git
  listed it first, with the site's own operation sentence around its reason,
  and git receives the spelling it returns. The one exemption is an ignore
  rule's `source`, which may legitimately be absolute or inside `.git`.
  MCP git write tools that take paths pass `GitDesktopMcp::toplevel()` to
  their cores, or call a core that anchors itself as the discard cores do, so
  paths resolve from the root `repo_status` reports.
- **Patch-producing `git diff` argv carry `--no-ext-diff`; never add
  `--no-textconv`:** external drivers replace the app's patches;
  exemptions require `--numstat`/`--name-only`/`--name-status` and no literal
  option after the verb and before `--` outside check K's known-no-patch
  list, since other options may enable a patch or trust a driver's verdict.
  Anything else, including `--quiet`, `--exit-code`, `--binary` and patch
  flags, needs `--no-ext-diff`; `--ext-diff` is refused before `--` in any
  argv-shaped group (guard: check-rust-invariants check K).
- **Merges into a checkout check for ignored files first:** git's merge
  default silently replaces an ignored file the incoming side tracks, and
  merge-ort ignores `--no-overwrite-ignore` on 3-way merges (measured, git
  2.51.1). Every merge or non-rebase pull into a user checkout calls
  `git::ignored_guard::ignored_files_in_the_way` under its working-tree hold,
  before any stash push, and refuses on a hit with fixed copy free of the
  frontend's dirty-tree and conflict markers. It may step aside where git
  refuses on its own (unmerged entries, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, an
  unresolvable target or missing upstream, a non-fast-forward `--ff-only` pull,
  unrelated histories). Exempt: a `merge` argv whose own literal carries
  `--ff-only --no-overwrite-ignore` (git refuses natively) and fresh throwaway
  checkouts. A caller of an argv builder runs the guard itself (guard:
  check-rust-invariants check H, per function).
- Test-side update-marker holders under the process-wide root override use
  branch names no other test uses (guard: check-rust-invariants check I for
  `UpdateMarker::create_for` calls in test modules, following one level of
  same-file helper delegation for the override). Production-path mints and
  the other gaps listed in check I's header comment are review-enforced.
- **Every test-build git goes through `TestGitEnv`** (`git/runner.rs`): the
  runner applies it, and a test that spawns git itself calls `.test_git_env()` —
  no system, global or XDG config, and no inherited repository or config
  redirects. A test that needs global config passes a `GIT_CONFIG_GLOBAL`
  file of its own: the runner panics on a `config --global` write without
  one. The removal list covers git's `local_repo_env` (v2.51.1) except
  `GIT_CONFIG_COUNT`, plus `GIT_TEMPLATE_DIR` and a few other repository-shape
  names, and a test pins that coverage. Two names stay on purpose:
  `GIT_CEILING_DIRECTORIES` (a caller sets that pair before the trait) and
  `GIT_CONFIG_COUNT` (the submodule tests set it process-wide). The consts behind
  it are private, so a hand-copied `.envs(…)` fails to compile.
- **Rust tests never read the real settings store** — use the
  `TEST_STORE_DIR` seam in `app_store.rs` (arm 0 of `store_path`). The other
  app-data modules carry their own seams in the same arm order (`oplog.rs`
  `GD_OPLOG_DIR`, `review_notes.rs` `GD_REVIEW_NOTES_DIR`: the `cfg!(test)` temp
  arm outranks the env override, which only non-test builds read) — a new store
  module mirrors one of these, never resolves app-data bare.
  Its `cfg!(test)` temp arm calls `crate::oplog::test_fallback_dir`, never a
  hand-rolled `temp_dir()` join: the helper gives each test process its own
  `<name>-<pid>` dir (concurrent runs and nextest's per-test processes never
  share a store file) and, on its first use per store name in a process,
  removes a dead predecessor's same-pid dir and, outside nextest, sweeps that
  store's day-old leftovers. The app also removes EMPTY `<temp>/gd-review-*`
  dirs at startup, so never name a test folder `gd-review-…`; before picking a
  temp name, ask what else sweeps that dir by prefix.
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
- **A journal entry a record names is finished through a claim:** a finish
  or merge abort of an entry whose handles left its start (a local PR's
  paused merge or branch update) takes `oplog::claim_finish` before it
  touches the worktree and closes through `oplog::settle_finish_claim`. Each
  path re-asserts the claim (`oplog::renew_finish_claim`) at different
  points, and only some renewals gate anything. Both finishes renew after
  their gates and commit and again immediately before the branch moves, and
  both of those gate the move: `LostOrUnknown` stops with the branch unmoved,
  and so does `Closed` unless the branch already holds the commit, when the
  finish carries on as landed. The merge finish renews once more before it
  removes its worktree and does not act on the answer (the base already
  moved). The update finish settles done first and removes its worktree
  with no renewal. The merge abort renews before its removal and that
  renewal gates it: `LostOrUnknown` releases the claim and refuses with
  nothing removed, and `Closed` goes on unclaimed. The update discard, the
  abandoned-entry sweep and a merge finish or abort that holds no claim
  close through the conditional close (`oplog::close_unfinished` /
  `finish_if_unfinished`), which refuses over a live claim. The claim is a
  lease (`FINISH_CLAIM_TTL`, 120 s): a liveness bound, not mutual exclusion.
  While holders keep running, two windows or processes never both move a
  branch for one entry, and a crashed holder blocks for at most the limit.
  It does not cover a holder stopped for longer than the limit that then
  resumes (process suspension), a wall-clock jump, or a journal lock that
  could not be acquired (`store_lock` fails open). A merge finish that holds
  a claim records the commit it is about to land (`oplog::record_landing`,
  the entry's `landing`, never on the listing) before the base moves, and
  only when the entry's starting tip is known and that commit builds on the
  tip without being it. A record that cannot be written, or a containment
  read that fails, refuses the finish before the base moves. A later
  finish or abort reads it (`oplog::landing`) and treats the merge as
  landed only when the base contains that commit: a finish then reports
  merged before its gates, whatever the worktree holds, and cleans up; an
  abort refuses and removes nothing, so Finish is always the next step. A
  bare `oplog::finish` on such an entry is written only after the branch
  provably holds the commit: the update discard's landed-under-claim done
  write, and a finish's (merge or update) done write when its settle fails.
  `reconcile` closes only `pending` entries and reads no claim.
- **Test code runs git on `TEST_GIT_HANG_GUARD`** (`git/runner.rs`, test
  builds only): fixture helpers and direct calls to the plain spawn runners
  (`PLAIN_GIT_RUNNERS` in check L's script) in tests pass it, never
  `DEFAULT_TIMEOUT`. A budget a test passes to product code under test, the
  lock-taking and retrying wrappers included, stays the product's (a helper
  that does so takes an allowlist row; guard: check-rust-invariants check L).
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
- **A Tauri package's two halves move together:** the crate
  (`src-tauri/Cargo.toml` → `Cargo.lock`) and its npm half (`package.json` →
  `pnpm-lock.yaml`) must agree on major.minor or `tauri build` refuses the
  pair. An npm bump already reddens appimage-check (its paths filter lists
  `package.json`); the blind spots are a crate-only bump and a lockfile-only
  drift inside a caret range, both gated by check-tauri-plugin-parity.mjs on
  every PR. A Dependabot group can't span ecosystems, so the two PRs combine.
- **CodeMirror/Lezer core packages are lockfile SINGLETONS**, gated by
  `scripts/check-lockfile-dedupe.mjs` (its `SINGLETONS` list): two installed
  copies of `@codemirror/state` throw at editor open, and a split
  `@lezer/highlight` drops theme coloring — neither shows in build or tests.
  Remedy is `pnpm dedupe`, then an `overrides:` pin in `pnpm-workspace.yaml`
  for a split that survives it.
- **Rate limits and absent gh reads:** limit copy comes from `forge-backoff.ts`,
  never a hard-coded provider: `rateLimitSummary` gives the one-sentence reason
  and `rateLimitClause` is the one spelling of "while {Provider}'s API rate
  limit is in effect", both over the one kind→provider map `FORGE_KIND_HOSTS`
  and the runner-pinned `HELD_RATE_LIMIT_TEXTS`. `rateLimitSummary` answers only
  for a bare limit, so a cause an app headline wraps keeps that headline. A Rust
  gh read that can mean absence sends a failure through `classify_gh_failure` in
  a pure `*_outcome` fn (RateLimited/Transport → Err, NotFound/Answered →
  absence), never "none" on a non-zero exit (guard: check-rust-invariants check
  J). The exceptions: star status (github/pr.rs, forge/github.rs) and the
  Explore README map Answered → Err too. An exit-0 body that won't parse rejects
  as well, while a parsed body missing a field keeps that field's meaning; the
  lock read needs a readable `locked`. The repo view is exempt: unreadable, it
  stays forge-status's Unresolved.
- **gh rate-limit hold:** `github/runner.rs` holds a gh call whose argv
  classifies to a limited (host, bucket) pair (REST core, GraphQL or search)
  and returns gh-shaped rate-limit stderr without spawning. Evidence comes
  from `forge::session::gh_error_is_rate_limit` (the one shared predicate) or
  a 429 status line. A hold ends when it runs out, when a call on its bucket
  that started after it succeeds (or gets a non-limit 4xx), on a recheck that
  sees quota (primary holds only, never before any secondary evidence on the
  hold has run out: a quota read can't lift a secondary limit), or on an
  auth-epoch bump. A result from a call or probe that started before the hold
  may lengthen it but never clears or shortens it. A new gh family joins
  `classify_call` only after its bucket is verified in gh's source, and
  unknown argv is never held. Frontend retry and backoff key on the shared
  `isRateLimitError` / `isAuthError` (`src/lib/forge-backoff.ts`), never a
  re-spelled match.
- **CI run polling** (run lists, run details, PR rollups) takes its cadence
  from `src/lib/github/run-poll.ts` (a run-age ladder that `waiting` runs ride
  like any active run, and a list rule congruent with `notifyPollInterval`),
  never a flat per-run interval; the branch badge's `useLatestRun` and the run
  notifier keep their own cadence. GitHub PR rollups watch runs through one
  head-sha list poll plus jobs reads only while the rollup is open
  (`useHeadRuns` / `useRunJobs`). While open, the bounded re-check in
  `src/features/pulls/check-recheck.ts` covers a check still pending over a
  finished row. Keyed on the check's attempt (the run's full job-id set),
  never the row, it reads the head list on first sight, re-reads it with the
  PR's checks at 15/30/60 s, then parks. A row seen executing pauses it and
  its next finish starts one fresh episode; collapsing the rollup or hiding
  its tab pauses it without resolving it.
- **Polls keep running while the window is unfocused** (owner ruling: the user
  works in an editor with GitDesktop on another screen): never pause a poll on
  blur, cut each poll's cost instead; a minimized-only pause is an open owner
  call.

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
`skip-changelog` in the PR title. A `fixed-` fragment needs the bug to be
OBSERVABLE in a released build: check ancestry
(`git merge-base --is-ancestor <bug-sha> <release-tag>`), then manifestation
(dep/lockfile defects can be dev-only; a stale-cache bug means tracing every
refresh path of the key). A bug minted and fixed inside one unreleased window
gets no fragment. `changed-` fragments likewise name only surfaces a release
has shipped.

**Skills ship in TWO trees — edit both.** `.claude/skills/<name>` (the Claude
store) and `.agents/skills/<name>` (the vendor-neutral store the codex and
opencode lanes read) are separate committed copies, and nothing propagates an
edit between them, so a lane resolving the copy you did not edit gets stale
text. `scripts/check-skill-mirrors.mjs` gates every skill present in both trees
and is a required `guards` step; the skips it declares (`EXEMPT` for per-harness
rewrites, `SINGLE_TREE` for one-tree skills) each carry their reason. Line
endings, the two trees' `.claude/`-vs-`.agents/` path references, the
`/cmd`-vs-`$cmd` sigil, and harness-only frontmatter keys are normalized away —
everything else must match. The path rewrite is symmetric, so byte-identical
copies always compare equal; the script header records what that costs.

**In a delegated package the spec's `Docs-sync:` field is authoritative:**
apply exactly what it lists (those files are thereby in scope); "orchestrator
handles" → skip docs; silent spec + user-facing change → flag the gap in your
report, don't exceed scope.

Help-content specifics: shortcuts are `{{kbd:action-id}}` / `{{key:…}}`
tokens, never literal keys — but an action with no default on this
platform (`defaultBindingOf(a) === null`, palette-only) gets **no token at
all** (it renders the literal word "palette" — the `PALETTE_ONLY` set in
`src/features/help/resolve-body.ts`); mention it as plain prose. AI-only content
gated with `ai: true` + `{{ai}}…{{/ai}}`. Verify every claim against code; sweep
stale "coming soon" mentions when a feature ships. A guide line never STARTS
with three backticks (or tildes) unless it opens a real fence that a later
line closes: an unclosed fence turns the rest of its section into one raw code
block (`src/test/help-guide-markdown.test.tsx` fails on one).

## Prevention standing rules (owner-adopted 2026-08-15)

- **Tripwire:** a fix that closes a CLASS of defect ships its mechanical guard
  in the same change — a biome `noRestrictedImports` entry, a `scripts/check-*`
  pattern or allowlist rule, or a pinning test. A swept class without a
  tripwire has re-opened before; the sweep alone is not the fix.
- **Class-grep at accept time:** when a review or session finding is accepted,
  grep its class immediately — fix every sibling in the same batch, or record
  the count with a named home. Never leave the Nth instance for a later PR.
- **Conventions-sync:** a change that builds a reusable primitive adds its line
  to THIS file in the same change (the docs-sync rule, applied to idioms). A
  change to a hard rule also updates every file that states that rule, wherever
  it is restated — the always-loaded excerpt `.claude/rules/repo-safety.md`, the
  repo `AGENTS.md`, and any carrier added later.
- **No inline gate predicates in CI YAML:** a check's logic never ships as an
  inline `node -e`/shell string in a workflow file — it is invisible to biome,
  to `node --test`, and to every static review lane (four independent defects
  once shipped in one such predicate). Extract to `scripts/check-*.mjs` with
  hit/miss fixtures in `scripts/checks.test.mjs` or the script's own
  `scripts/check-<name>.test.mjs`; the YAML step only invokes the script.
- **CI jobs are bounded and run Node from `.node-version`:** every job that
  runs steps carries a literal job-level `timeout-minutes` set from measured
  durations, and a job that runs Node or a Node package manager first sets
  Node up with `actions/setup-node` and `node-version-file: .node-version`,
  after checkout. A setup-node under `continue-on-error` covers a later step
  only if that step is `continue-on-error` too or its `if:` requires
  `steps.<id>.outcome == 'success'`. A job without a bound runs to GitHub's
  6-hour default on a hang, and the image's Node drifts from `.node-version`.
  `scripts/check-workflow-node-setup.mjs` gates both; its `EXEMPT` map waives
  only a container job or a composite action running Node, with a reason.
- **Guard scripts default CLOSED on inputs they cannot read:** every
  `scripts/check-*.mjs` validation guard enumerates its unreadable-input
  arms — unquoted or folded YAML scalars, binary bytes, deleted/missing
  files, empty corpora, non-string values, duplicate keys — and FAILS on
  them instead of skipping (not `scripts/check-rust-gate.mjs`: it selects the
  rust-tests matrix, skipping only on a valid exact identity a green run
  recorded whose head commit matches the identity's eight members,
  absences included, the tested `src-tauri` tree resting on the artifact
  name alone; a failed artifact lookup, or no verified match, runs the
  matrix; a candidate whose head listing cannot be read is rejected).
  Mining minted the fail-open-checker-arm class on 12+ records across 6 PRs,
  concentrated in the guard scripts the tripwire rule itself ships: a scanner
  that exits 0 on input it could not parse approves exactly what it cannot
  see. Each arm gets a miss fixture in `scripts/checks.test.mjs` or the
  script's own `scripts/check-<name>.test.mjs`, and an empty-corpus /
  zero-files-matched result is a FAIL or an explicit annotated skip, never a
  pass. **A PR that ships a scanner/guard is a parser-grade adversarial
  surface:** budget a dedicated adversarial loop over its input grammar
  (aliased/namespace imports, destructured params, catch bindings — the
  shapes reviewers actually threw) or ship the guard as its own PR — one
  cycle-3 PR (#425) paid 9+ consecutive reviewer rounds draining exactly those
  arms one at a time.

## Definition of done

Verification green (failures quoted verbatim, passes one line each), the full
suites run once through the wrapper (`pnpm test:rust:full`,
`pnpm test:vitest:full` or `pnpm test:all:full`); edge cases exercised
(first/last/empty, boundaries); keyboard nav + palette registration wired for
new UI; docs-sync per the spec's `Docs-sync:` field (gaps flagged, never
silently skipped); footprint sweep via
`git --no-pager status` accounting for YOUR files only (the tree may hold the
user's parallel WIP and sibling packages — don't touch or explain what isn't
yours).
