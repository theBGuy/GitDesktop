---
paths:
  - "src/**/*.tsx"
  - "src/**/*.ts"
---

# Frontend quick rules (the most-violated subset)

> Excerpted from `.claude/skills/gd-conventions/SKILL.md` §Frontend — read that section
> in full before substantive frontend work; this file is the tripwire, not the playbook.

- Every new selectable list gets arrow-key navigation in the same change
  (`listKeyboardNav`, `src/lib/list-keyboard-nav.ts`) — invariant, not polish.
- Any new tab/surface/action needs an ACTIONS entry in `src/lib/hotkeys/registry.ts` +
  `useHotkeyAction` wiring in the same change (`defaultBinding: null` = palette-only).
- Shortcut hints render via `isMac` / `formatBinding` — never a literal ⌘ or "Ctrl+".
- Destructive paths confirm via the shared `useConfirm`/`ConfirmDialogHost` primitive;
  commit-level prompts share wording through `src/features/history/commit-confirms.ts`.
- Disabled actions explain why: `DisabledReasonButton`, or `useDisabledReason` +
  `ARIA_DISABLED_CLASS` on raw-button and form-wrapped-Button (`form.SubmitButton`)
  sites — never hide, never a bare `disabled`.
- Truncated user/repo content: `clipTitle`/`clipTitleFromText` only-when-clipped; Base UI
  Select rows via `SelectClipText` as the row's SOLE child.
- Semantic state tokens (`--success`, `--warning`, `--info`, `--merged`, `--destructive`)
  — no hardcoded green/amber/red classes; never meaning by color alone.
- Per-variant copy/labels/glyphs are `Record` lookups, never ternary chains.
- Loading: `ListRowSkeletons` for bordered row lists, `LazyPanelFallback` for Suspense —
  never `fallback={null}`, no spinner where skeletons exist.
- Queries with identity axes beyond the repo use `keepPreviousDataForKeyAxes`; callers
  gate derived UI on `!isPlaceholderData`.
- A mutation whose host can unmount mid-flight rides `await mutateAsync` continuations,
  never `.mutate(vars, { onSuccess })` — react-query drops per-call callbacks on unmount.
- Open-transition resets ride `useSeedOnOpen` — a bare `if (open)` effect re-fires when a
  hidden `<Activity>` tab re-mounts on show.
- Docs-sync rides the same change: README bullet → site capabilities → help
  `content.ts` → `changelog.d/` fragment (never hand-edit CHANGELOG.md's Unreleased).
- Typecheck = `pnpm exec tsc -b --noEmit` (or `pnpm build`) — plain `tsc --noEmit` is a
  NO-OP in this repo (project references) and passes without checking anything.
- Untrusted JSON in TS derivers (CLI output, forge payloads): `typeof`-guard every
  field and try/catch per item — one malformed record must never blank the list.
