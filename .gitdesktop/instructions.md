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