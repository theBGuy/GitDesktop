# Commit Messages & PR Titles: Conventional Commits

All commit messages and PR titles must follow **Conventional Commits** format.

## Format

```
<type>(<scope>): <description>
```

- **type**: One of `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `ci`
- **scope**: One or more hyphenated feature areas (comma-separated if multiple)
- **description**: Short, imperative message (no period at the end)

## Examples

✅ **Good**
- `feat(ai): add Claude API model selector`
- `fix(diff): handle binary files correctly`
- `feat(github,issues): support issue templates`
- `docs(help): update keyboard shortcuts section`
- `refactor(ui): simplify commit message generation`

❌ **Avoid**
- `add AI features` (missing type and scope)
- `feat(ai-provider-selector)` (missing description)
- `Fix: the diff thing` (capitalized, vague scope)
- `feat: update various UI components` (missing scope)

## Tips

- **Scope should name the feature area**, not the component (use `ai`, not `AiProviderSection`)
- **Multiple scopes** for cross-cutting changes: `feat(github,settings): add auth flow`
- **Type guides later tooling** — `feat` and `fix` trigger changelog entries automatically
- Use **lowercase** and **no period** in the description

# Documentation: four surfaces, one change

A **user-facing** change updates its documentation in the SAME change — never in a
follow-up. This project keeps four documentation surfaces, and they are ONE concern:
a change that leaves any of them stale is one gap with several locations, not one
gap per file.

1. **`README.md`** — add or extend the relevant bullet under *Highlights* and/or
   *Features*.
2. **Marketing site** — add the capability to `site/src/data/capabilities.ts`, the
   single source of truth for the catalog (`ai: true` only for AI features;
   `highlight: true` to surface it on the home page). Then add or extend a
   `FeatureRow` in `site/src/pages/index.astro` when it warrants its own section.
   That page has two synced views, **AI-native** and **Just Git** — non-AI features
   belong in both, AI features in the AI view only.
3. **In-app user guide** — `src/features/help/content.ts`: update the matching
   guide section (or add one for a whole new surface) and keep every claim true
   against the code. Shortcuts are `{{kbd:action-id}}` / `{{key:…}}` tokens, never
   literal keys; AI content is gated with the section's `ai: true` flag plus
   `{{ai}}…{{/ai}}` inline markers.
4. **Changelog fragment** — `changelog.d/<added|changed|fixed>-<slug>.md`, whose
   body is the finished Keep a Changelog bullet, written for humans. Never edit
   `## [Unreleased]` in `CHANGELOG.md` directly; fragments are assembled there at
   release time. The `fragment` check is required on master and keys on paths:
   any `src/` or `src-tauri/` change needs a fragment, the `no-changelog` label,
   or `skip-changelog` in the PR title.

When a change alters **existing** behavior, grep all four surfaces for the old
wording rather than updating the spots you remember — stale copies of the same
claim hide across surfaces. A change too minor for the README, site, and guide may
carry only the capability line and the changelog fragment, but that is a deliberate
call to state, not a step to skip silently. A change with no user-facing effect
(pure refactor, internal rename, test-only) needs none of them.
