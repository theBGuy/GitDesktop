# Vendored primitives: local modifications

These are shadcn / Base UI primitives, normally regenerated rather than
edited. Nine of them carry a sanctioned local delta for one cross-file
contract: **panel-scoped portals plus activity-aware modality**. Repo tabs
render inside `<Activity>` (`TabPanel` in `RepositoryView.tsx`), which
conceals a hidden tab with CSS and keeps its subtree mounted. A popup that
portals to `<body>` is not covered by that conceal, so it stays on screen
over whichever tab the user switched to. The files below portal into the
surrounding panel instead, and the two dialog-shaped ones also stand their
modal state down while concealed.

## Detecting a lost customization

Regenerating any file here (`shadcn add`, a registry refresh) silently
reverts its delta. After regenerating, grep the file:

```sh
grep -l "@/components/panel-portal" src/components/ui/<file>.tsx
```

No match means the customization is gone. Restore it from git history
rather than rewriting it from scratch. The marker imports are
`usePanelPortalContainer`, `usePanelActive`, `isUserDismissal`, and
`PanelPortalReset`.

Coverage is partial and indirect. `pnpm run checks` runs
`lone-activity-boundary`, which pins the `<Activity>` side of the contract
(exactly one JSX `<Activity`, in `RepositoryView.tsx`) but cannot see a
missing `container` prop here. Nothing else guards this folder, so the
live smoke is the real proof: open a dialog from a repo tab, switch tabs
and switch back. It must conceal with its tab and come back intact, never
float over the new tab.

## The modifications

- **`popover.tsx`**, **`select.tsx`**, **`combobox.tsx`**,
  **`hover-card.tsx`** — the `*Content` component reads
  `usePanelPortalContainer()` and passes it to its `Portal` as `container`.
  Without it the popup renders at `<body>` and survives its tab's conceal.
- **`tooltip.tsx`** — same container read on `TooltipContent`'s inline
  portal. This one has no exported portal wrapper.
- **`dropdown-menu.tsx`**, **`context-menu.tsx`** — the same container read
  on `*Content`, plus the exported `*Portal` wrapper defaulting `container`
  to the panel when the caller passes none. The default tests
  `container === undefined`, never `??`: Base UI reads an explicit `null` as
  "a container is coming" and renders nothing, so `null` has to survive.
- **`sheet.tsx`** — portal wrapper container default as above;
  `SheetContent` wraps children in `PanelPortalReset` so floating UI inside
  the sheet does not portal into a panel the sheet covers; the root `Sheet`
  derives `modal` from panel visibility and cancels user-initiated
  dismissals while concealed. A concealed modal would otherwise keep the
  document scroll-locked, keep everything outside it `aria-hidden`, and take
  the Escape key from the tab the user can see.
- **`dialog.tsx`** — every delta `sheet.tsx` carries (both are Base UI
  `Dialog.Root` underneath), plus `DialogContent` re-homing focus into the
  popup when its panel returns to view, and composing the caller's `ref`
  with its own rather than replacing it. It also takes an `overlayClassName`
  prop forwarded to the backdrop it renders internally, so a caller can style
  a backdrop it has no other handle on. That one carries no panel-portal
  marker, so the grep above misses it — check it separately with
  `grep -n overlayClassName src/components/ui/dialog.tsx`, which must show
  the prop, its type, and its forward to `<DialogOverlay/>`.

Deliberately unmodified: `menubar.tsx` inherits the container default by
delegating to `DropdownMenuPortal`, so regenerating it into a direct
`Menu.Portal` call would break it silently. `drawer.tsx` is vaul and has no
container prop, so its popups are not panel-scoped.

## Check before re-applying

If one of these has to be re-created, confirm it is still needed. Verify
first, then decide. Suspicion alone is not grounds for dropping one.

1. **React's Activity visibility walk.** It styles only the topmost host
   element per fiber path (react-dom latches on the first host it finds and
   skips deeper ones), and a portal's DOM sits outside that element, so the
   style never reaches it. If react-dom starts styling portal hosts too,
   body-level portals would conceal on their own. Containment would still
   carry draft preservation and stacking, so that weakens the argument
   rather than ending it.
2. **Base UI gaining container-scoped modality**, or a modal that tracks
   visibility. That would subsume the `modal` flip and the dismissal
   suppression in `dialog.tsx` and `sheet.tsx`, though not the container
   reads.
3. **The app no longer rendering tabs through `<Activity>` / `TabPanel`.**
   That removes the premise for all of it.
