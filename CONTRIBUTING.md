# Contributing to GitDesktop

Thanks for your interest in improving GitDesktop — an AI-native, keyboard-first
Git desktop client built with Tauri 2 + React 19.

This guide covers how to set up the project, the conventions we follow, and what
makes a change easy to review and merge. By participating you agree to abide by
our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- For **bugs** and **feature ideas**, please open an issue first using the
  [issue templates](.github/ISSUE_TEMPLATE) so we can agree on the approach before
  you write code. Small, obvious fixes can skip straight to a PR.
- For **security vulnerabilities**, do **not** open a public issue — follow
  [SECURITY.md](SECURITY.md).
- For **usage questions**, see [SUPPORT.md](.github/SUPPORT.md).

GitDesktop has a clear product intent — calm, precise, dependable, with the repo
(not the chrome) as the focus. Skimming [PRODUCT.md](PRODUCT.md) before proposing
larger UI changes will save a round-trip; in particular, contributions are
expected to respect its Design Principles.

## Prerequisites

- **Rust** toolchain (stable) — <https://rustup.rs>
- **Node 20+**
- **pnpm** (`corepack enable` will use the version pinned in `package.json`)
- Tauri's platform build dependencies — see the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).
  On Linux the same packages the release workflow installs are required
  (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
  `patchelf`, `build-essential`, `libssl-dev`).

For running the app's GitHub and Actions features you'll also want **`git`** on
`PATH` and the **GitHub CLI (`gh`)** authenticated (`gh auth login`). GitDesktop
talks to GitHub exclusively through `gh` — there is no OAuth app and the app never
stores your tokens.

## Getting set up

```sh
pnpm install
pnpm tauri dev    # run the app with hot reload
```

Other useful commands:

```sh
pnpm build                                        # typecheck (tsc) + bundle the frontend
pnpm lint                                         # Biome — formats and lints ./src
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

We use **Biome** for both formatting and linting the frontend — there is no
separate Prettier/ESLint step. Run `pnpm lint` before committing.

## Project layout

A quick map of where things live (see the README's *Architecture* section for
more):

- `src-tauri/src/git/` — typed Tauri commands that shell out to system `git`
  (porcelain v2 parsing, per-repo mutation locks, timeouts).
- `src-tauri/src/github/` — `gh`-backed commands: pull requests (`pr.rs`) and
  GitHub Actions (`actions.rs`).
- `src-tauri/src/{hooks,secrets,instructions}.rs` — git-hook management, OS
  keychain storage, repo instruction/rule files.
- `src-tauri/src/agent.rs` — drives local coding-agent CLIs (Claude Code / Codex / GitHub Copilot / opencode).
- `src/lib/` — invoke bindings + TanStack Query hooks (`git/`, `github/`), the AI
  layer (`ai/`), settings, and the hotkey registry.
- `src/features/` — the screens: repository, changes/diff, commit, history,
  compare, pulls, actions, hooks, branch-rules, settings, and updates.
- `site/` — the Astro marketing site (separate pnpm workspace).

## Making changes

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/) with a
scope, matching the existing history:

```
feat(github,issues): add issue drafting
fix(diff,highlight): handle TSX grammars
chore(deps): bump tauri to 2.x
```

Common scopes mirror the feature areas: `repos`, `changes`, `branches`, `history`,
`pulls`, `actions`, `hooks`, `ai`, `github`, `diff`, `ui`, `settings`, `site`.

### Code comments

Write comments as constraint-statements: the decision plus one sentence of why —
three lines is plenty for almost anything. A comment earns its place by saying
something the code can't: an invariant, a deliberately non-obvious choice, a
cross-module contract, or hard-won external-API/platform behavior. Skip what the
git history already owns (what the code used to do, which PR changed it, how a
bug was found), don't narrate the next lines, and don't argue the change is
correct — that's for the PR description. Genuinely multi-constraint blocks may
run to ~6 lines, and measured figures a later reader would otherwise have to
re-measure (payload sizes, timed runs) may stay and cite their source (a PR or
run reference is fine there). When you touch a file, trimming its comments to
this standard in passing is welcome.

### Changelog

For any **user-facing** change, add a **changelog fragment** — a small Markdown
file under [`changelog.d/`](changelog.d/) named `<added|changed|fixed>-<slug>.md`
(e.g. `changelog.d/added-gitlab-time-tracking.md`). Its body is the finished
[Keep a Changelog](https://keepachangelog.com/)-style bullet, written **for
humans** — a clear sentence about what changed for the user, not a copy of your
commit subject. One file per change means parallel branches never conflict on the
changelog; see [`changelog.d/README.md`](changelog.d/README.md) for the format.

CI keys on paths, not user impact: `fragment` is a required status check on
`master`, so a PR that touches `src/` or `src-tauri/` without adding a fragment
can't merge. If a change genuinely doesn't need one, label the PR `no-changelog`
or put `skip-changelog` in the title.

Don't edit `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) directly — the
fragments are assembled there at release time. Preview the pending changelog with
`pnpm changelog:preview`; `pnpm changelog` still drafts starting-point bullets
from the git history.

### Docs and the marketing site

For any **user-facing feature**, keep the docs in step in the same change:

- **README.md** — add or extend the relevant bullet under *Highlights* / *Features*.
- **`site/`** — add the feature to the `capabilities` list in
  `site/src/pages/index.astro` (and a feature section when it warrants one), in both
  the **AI-native** and **Just Git** views as applicable; non-AI features belong in
  both, AI features in the AI view only. `cd site && pnpm build` to verify.
- Marketing-site screenshots for the **Just Git** view should be captured with the
  app's *Hide AI features* setting on, so they match the AI-hidden experience.

A truly minor feature can settle for just the capability line + changelog — but make
that call on purpose.

Writing a **blog post**? Post copy follows the anti-AI-tell rules in
[CLAUDE.md](CLAUDE.md#blog-post-copy--anti-ai-tell-rules-sitesrccontentblog) —
phrasing, wrap band, and voice; spelling and personal voice follow the post's
byline author. To schedule a post, give it a future `pubDate` (bare date =
midnight UTC): it stays out of production builds — while remaining visible in
dev and Pages previews — until the daily `site-scheduled-publish` cron
rebuilds the site shortly after 00:00 UTC on its date.

### UI changes

GitDesktop is keyboard-first and aims for WCAG AA. When you add or change UI:

- Wire up **arrow-key navigation** for any new selectable list, in the same change.
- Keep **destructive paths safe** — anything that can lose work (discard, reset,
  force-push, merge) must confirm clearly and give feedback (Design Principle #2).
- Don't convey meaning by color alone; keep focus indicators visible.
- The shadcn / Base UI primitives under `src/components/ui/` are vendored — fix
  things at the feature/call-site level rather than editing those files.

### AI-assisted contributions

Using AI tools to help write your change is fine — but **you own the diff**.
Review everything you submit, make sure it actually works, and never paste
secrets, tokens, or proprietary code into a prompt.

If you relied on AI assistance to make a pull request, you **must disclose it in
the pull request**, together with the extent of the usage. For example, if you
used AI to generate docs or tests, you must say so. An example disclosure:

> This PR was written primarily by Claude Code.

> I consulted ChatGPT to understand the codebase but the solution was fully
> authored manually by myself.

Providing this information helps reviewers understand the context of the pull
request and apply the right level of scrutiny, ensuring a smoother and more
efficient review process. AI assistance isn't always perfect, even when used with
the utmost care.

## Opening a pull request

1. Branch off `master`.
2. Keep PRs small and focused; one logical change per PR is easiest to review.
3. Link the issue it addresses (`Closes #123`).
4. Run `pnpm lint` and, if you touched Rust, `cargo test --manifest-path src-tauri/Cargo.toml`.
5. Add a `changelog.d/` fragment if the change is user-facing — the required
   `fragment` check blocks merge on `src/` or `src-tauri/` changes without one
   (see the Changelog section for the escape hatches).
6. Fill out the PR template — including screenshots or a short screen recording
   for UI changes.

A maintainer will review and may suggest changes. Thanks for contributing!

## License

By contributing, you agree that your contributions will be licensed under the
project's [Apache License 2.0](LICENSE).
