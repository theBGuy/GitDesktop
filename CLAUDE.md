# GitDesktop — agent guide

An AI-native, keyboard-first Git desktop client (Tauri 2 + React 19), with an Astro
marketing site in `site/`. This file is the standing brief for Claude/agents; the
full human conventions live in [CONTRIBUTING.md](CONTRIBUTING.md), product intent in
[PRODUCT.md](PRODUCT.md), and ongoing project state in `memory/` (auto-loaded).

## Keep docs in sync with features — every time, unprompted

**When you add or ship a user-facing feature, update its docs in the SAME change —
don't wait to be asked:**

1. **`README.md`** — add/extend the relevant bullet under *Highlights* and/or *Features*.
2. **Marketing site** (`site/src/pages/index.astro`) — add the feature to the
   `capabilities` list (set `ai: true` only for AI features), and add or extend a
   `FeatureRow` when it warrants a section. The page has two synced views,
   **AI-native** and **Just Git** — put non-AI features in both, AI features in the
   AI view only. Then `cd site && pnpm build` to verify.
3. **In-app user guide** (`src/features/help/content.ts`) — when a change adds or
   meaningfully alters a user-facing surface, update the matching guide section (or add a
   new one for a whole new surface), and keep it accurate (verify claims against the
   code, not memory). Shortcuts are `{{kbd:action-id}}` / `{{key:…}}` tokens, **never
   literal keys** (they resolve per-platform and reflect rebindings); gate AI content with
   the `ai: true` section flag + `{{ai}}…{{/ai}}` inline markers so *Hide AI* hides it.
   (Conventions + gotchas: `memory/help-guide-content-conventions.md`.)
4. **Changelog fragment** — for any user-facing change, add a
   `changelog.d/<added|changed|fixed>-<slug>.md` file whose body is the finished
   Keep a Changelog bullet (written for humans). **Never edit `## [Unreleased]` in
   `CHANGELOG.md` directly** — fragments are assembled there at release time, and
   one file per change keeps parallel branches conflict-free. Preview with
   `pnpm changelog:preview`; conventions live in `changelog.d/README.md`.

When a change alters **existing** behavior, grep README / site / help for the old
wording (e.g. the feature's old phrase) rather than updating spots from memory — stale
copies of the same claim hide across all three surfaces.

If a feature is too minor for the README / site / guide, it's fine to add only the
capability line + changelog fragment — but make the call deliberately, don't skip silently.

**Screenshots:** marketing-site screenshots for the **Just Git** view must be
captured with the app's *Settings → General → Hide AI features* ON, so they match
the AI-hidden experience. (See `memory/site-just-git-screenshots.md`.)

## Everyday commands

```sh
pnpm build      # typecheck (tsc) + bundle the frontend
pnpm lint       # Biome (format + lint) — run before committing
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
cd site && pnpm build   # build the marketing site
pnpm changelog:preview  # preview pending changelog.d/ fragments
```

## A few house rules (see CONTRIBUTING.md for the rest)

- **Conventional Commits** with a scope: `feat(github,issues): …`, `fix(diff): …`.
- **Don't edit `src/components/ui/`** — those are vendored shadcn/Base UI primitives;
  fix at the feature/call-site level.
- **Keyboard-first, WCAG AA** — wire arrow-key nav for any new selectable list in the
  same change; never convey meaning by color alone; keep destructive paths confirmed.
- **React best practices** — before writing or refactoring any React component or hook,
  load the `vercel-react-best-practices` skill and apply it as you write (it doesn't
  auto-load — pull it in yourself). Vercel's 70-rule playbook: waterfalls, bundle size,
  data fetching, re-renders, memoization.
- **macOS Edit menu** — we rely on Tauri's `Menu::default()` (it ships the Edit submenu
  that powers undo/redo/cut/copy/paste in inputs on macOS). If you add a custom app menu,
  derive it from `Menu::default()` or include the Edit `PredefinedMenuItem`s, or macOS
  text editing breaks.
- The site deploys to Cloudflare Pages at `gitdesktop.app` (`base: "/"`).

## Delegated implementation (orchestrator ⇄ subagents)

For multi-file implementation work, prefer the `/delegate` workflow
(`.claude/skills/delegate/SKILL.md`): the main conversation architects and
writes work-package specs; the `implementer` agent (Opus,
`.claude/agents/implementer.md`) executes them; the read-only `spec-reviewer`
agent verifies. **/delegate requires Fable as the main conversation model**
(the agents themselves are pinned to Opus regardless) — non-Fable sessions
work inline instead. Both agents preload the `gd-conventions` skill — the repo
playbook of hard rules and gotchas (`.claude/skills/gd-conventions/SKILL.md`).
Only `implementer` may write files in this repo — plus the orchestrator for
trivial ≤ ~3-line reviewer/live-confirmed fixes during a /delegate run (see
the skill's Phase 4); every other spawned agent is strictly read-only, and
**no agent ever commits or mutates git state — the user commits their own
work.** (This section addresses the main conversation:
if you are a dispatched subagent working a package, do your package — never
re-delegate or spawn further agents.)
