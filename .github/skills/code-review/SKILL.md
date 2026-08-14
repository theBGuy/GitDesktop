---
name: code-review
description: Review playbook for GitDesktop pull requests — evidence standards for findings, deliberate repo conventions that are not defects, and repo-specific checks (changelog fragments, docs-sync, accessibility, IPC contracts). Use when reviewing any pull request in this repository.
---

# GitDesktop pull-request review playbook

GitDesktop is a keyboard-first Git desktop client: Tauri 2 (Rust backend in
`src-tauri/`) + React 19/TypeScript (`src/`), with an Astro marketing site in
`site/`. Biome handles lint + format; CI runs the TypeScript build (`tsc -b`),
`biome ci`, and `cargo test` + `cargo clippy -- -D warnings` on Linux, macOS,
and Windows.

## Evidence standard for findings

- Report only findings you can support with evidence from the diff or the
  repository's code. If you cannot verify a claim, omit the finding entirely —
  do not report it hedged as "could not verify".
- Do not claim code fails to compile or type-check unless you can name the
  exact rule violated. CI builds every PR; these specific claims have recurred
  here and are false:
  - "Borrow of a temporary across `.await` is a compile error" — an
    argument-position temporary lives through the enclosing statement.
  - "`import type` plus `typeof` fails compilation" — `typeof` on a
    type-only-imported value is a valid type query (the standard
    `ComponentProps<typeof X>` pattern); only value-position use is illegal.
  - "`a?.b.c` throws when `b` is undefined" — optional chaining
    short-circuits the entire chain.
- Before reporting a possibly-undefined/nullability finding, check the actual
  TypeScript interface or Rust struct: a non-optional field that the
  serializer sets on every path is a non-issue.
- A finding that names a specific parameter, limit, or config value must trace
  the value into that parameter at a real call site — do not infer behavior
  from a same-named local, and do not reason from a library's defaults without
  checking this repo's configuration (for example, react-query is configured
  with global `retry: 1` in `src/lib/query-client.ts`).
- Do not assert git, GitHub API, or compiler specifics from memory (flags,
  porcelain headers, ID ranges, version floors). When suggesting a git flag,
  confirm its exact semantics and minimum git version; older gits hard-fail on
  unknown flags.
- Read the PR description and existing review threads first: if the author has
  recorded a deliberate decision or already dispositioned a topic, acknowledge
  it rather than re-flagging. Code comments near a flagged line often document
  the invariant that justifies it — read them before flagging the line.
- When suggesting a fix, verify the fix itself: confirm any API you name
  exists in this codebase (or in its installed dependencies), and check that
  the fix doesn't break an adjacent behavior the current code preserves.

## Deliberate conventions — not defects

- `src/components/ui/` is vendored (shadcn / Base UI primitives) and is never
  edited; issues route to feature-level call sites. The vendored Button is
  deliberately square (`rounded-none`).
- `gd/session/*` branches are filtered from every branch surface by design
  (agent sessions run on them); the filter is an invariant, not a bug.
- Snowflake/u64 IDs cross the Tauri IPC boundary as strings (JS number
  precision loss above 2^53) — string-typed ID fields are intentional.
- Help-guide content (`src/features/help/content.ts`) uses `{{kbd:action-id}}`
  / `{{key:…}}` tokens, never literal key names — a literal "Ctrl+P" there
  would be the bug, not the token.
- Code comments here are constraint-statements (roughly ≤3 lines: the decision
  plus why). Do not request narration comments, change-history notes, or
  PR/issue references in code.
- A few pre-existing hardcoded status colors are intentional (file-status
  lists). New code must use the semantic tokens (`--success`, `--warning`,
  `--info`, `--merged`, `--destructive`) — flag new hardcoded state colors,
  not the grandfathered ones.

## Repo-specific checks

- **Changelog fragment**: any change under `src/` or `src-tauri/` needs a
  `changelog.d/<added|changed|fixed>-<slug>.md` fragment whose body is the
  finished Keep a Changelog bullet (leading `- `), unless the PR carries the
  `no-changelog` label or `skip-changelog` in the title. Site-only changes get
  no fragment. Flag fragments written like commit subjects instead of
  user-facing sentences.
- **Docs-sync (same PR)**: a user-facing feature updates the README
  Highlights/Features bullets, `site/src/data/capabilities.ts`, and the in-app
  guide (`src/features/help/content.ts`). When existing behavior changes,
  search README, `site/`, and the help content for the feature's old phrasing
  — stale copies of the same claim hide across all three surfaces.
- **PR hygiene**: the title is a Conventional Commit with scope
  (`feat(pulls): …`). Compare the PR description against the diff and flag
  overclaims — a described cache, guard, or behavior that the code doesn't
  implement.
- **Keyboard + command palette**: every new selectable list ships arrow-key
  navigation in the same PR; every new action or surface registers in
  `src/lib/hotkeys/registry.ts`. Never hardcode a platform modifier key —
  shortcut hints derive from the `isMac` / `formatBinding` helpers.
- **Accessibility (WCAG AA)**: meaning never conveyed by color alone;
  destructive paths behind confirmation; disabled controls explain why they
  are disabled; icon-only status elements need `role="img"` with a
  self-contained `aria-label` (the label cannot rely on visible descendant
  text, which `role="img"` hides from assistive tech).
- **Live times**: relative/elapsed times ride the shared 30-second ticker
  (`<RelativeTime>`, `<ElapsedTime>`, `useRelativeNow` in
  `src/components/relative-time.tsx` and `src/components/elapsed-time.tsx`) —
  flag render-time `Date.now()` reads and per-component interval timers.
- **Rust / IPC contracts**: serde tagged enums using `rename_all` also need
  `rename_all_fields`, or field names silently miss their TypeScript mirrors
  (reads become `undefined`). GraphQL fields without `!` deserialize as
  `Option<T>`. Untrusted JSON (CLI output, forge APIs) is shape-guarded per
  field on the TS side and parsed with tolerant serde on the Rust side.
  Third-party timestamps go through `parseableDate` / `validEpochMs`
  (`src/lib/time.ts`) before formatting — flag raw `new Date(x)` on forge or
  CLI data.
- **Security hot spots**: user-controlled values reaching git refspecs or
  argv (refspecs must be fully qualified; reject `*?[:` in ref names) — ref
  and tag names route through the existing `validate_ref_name` /
  `validate_tag_name` chokepoints and pushes through `build_push_args`; flag
  any new inline refspec construction. Untrusted values passed to `gh api -F`
  (a leading `@` reads a local file — use `-f` for raw strings); secrets or
  token-shaped strings in fixtures.

## Scoping & state discipline

- Cached or store state keyed by a repo, PR, issue, or session carries the
  FULL identity — `repoPath` plus entity id plus lens (fork/upstream), not a
  bare id. Check new query keys and zustand stores for the missing axis; a
  per-repo zustand store outside the UI store must self-clear on `repoPath`
  change or it leaks across repo switch.
- A surface deciding "is the user looking at this" compares `repoPath`, not
  just a tab or entity id.
- Streams and async writers capture their destination key at start (or abort
  on entity/repo switch) — a late result must not land in the newly selected
  entity's state.
- Every remote mutation ships its optimistic cache patch: keys derived at
  mutate time, snapshot/rollback, and `cancelQueries` on every patched key.
- Hydrate-from-disk paths MERGE into live state, never replace it.

## Signal standards

- Biome enforces formatting and import order — do not flag style it already
  handles, and treat line-ending (CRLF) noise in Windows checkouts as
  environmental, not a defect.
- Flag a repeated issue once, as a class with one example, not once per file.
- Do not request tests for changes with no new behavior (renames, reformats,
  reorganizations). There is no frontend test runner in this repo — do not
  request frontend unit tests; Rust logic tests live under `src-tauri/`.
- New Rust tests touching settings use the `TEST_STORE_DIR` seam in
  `src-tauri/src/app_store.rs` — a test must never read the developer's real
  settings store.
