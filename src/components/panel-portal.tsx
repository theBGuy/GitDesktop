import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

/**
 * Portal target for floating UI (popovers, menus, selects, comboboxes) rendered
 * inside an `<Activity>` tab panel. Hiding a panel sets `display: none` on its
 * host children, so a popup portalled into the panel's own subtree is concealed
 * by CSS alone — no React work that the hidden subtree would defer.
 *
 * `undefined` means "no panel boundary above"; Base UI then falls back to
 * `document.body`. The value must never be `null`: Base UI's portal reads an
 * explicit `null` as "a container is coming" and renders nothing at all.
 */
const PanelPortalContext = createContext<HTMLElement | undefined>(undefined);

/** Container for floating UI in the surrounding panel, or `undefined` at body level. */
export function usePanelPortalContainer(): HTMLElement | undefined {
  return useContext(PanelPortalContext);
}

/**
 * Whether the surrounding panel is the visible one. Defense in depth: hiding a
 * panel does tear down its subtree's effects, taking a modal's scroll lock,
 * `aria-hidden` marking and dismissal listeners with them — but that teardown is
 * deferred, so the modal state has to stand down on its own for the window
 * between the tab switch and it. Escape must never reach a concealed dialog.
 * `true` outside any panel.
 */
const PanelActivityContext = createContext(true);

/** `false` while the surrounding panel is concealed; `true` at body level. */
export function usePanelActive(): boolean {
  return useContext(PanelActivityContext);
}

// Base UI close reasons where the user acted on the document rather than on the
// popup itself. While a panel is concealed these belong to the tab the user can
// actually see, so a hidden popup must neither take them nor swallow the key.
const USER_DISMISSAL_REASONS = ["escape-key", "outside-press", "focus-out"];

/** Whether a Base UI close request came from the user acting outside the popup. */
export function isUserDismissal(reason: string): boolean {
  return USER_DISMISSAL_REASONS.includes(reason);
}

/** Publishes the surrounding panel's visibility to the popups inside it. */
export function PanelActivityBoundary({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactNode {
  return <PanelActivityContext value={active}>{children}</PanelActivityContext>;
}

/**
 * Wraps one `<Activity>` panel's content and publishes a portal target that
 * lives inside it.
 */
export function PanelPortalBoundary({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  // State, not a ref: Base UI resolves the container from the prop's identity,
  // so a ref that is still empty on first render would stay pinned to the body.
  // Detaches (null) are ignored: <Activity> detaches refs on hide, and adopting
  // that null would re-point a still-open popup at the body mid-hide. On real
  // unmount the provider dies with the subtree, so no stale element is readable.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const attach = useCallback((el: HTMLElement | null) => {
    if (el) setContainer(el);
  }, []);
  return (
    <PanelPortalContext value={container ?? undefined}>
      {children}
      <div data-panel-portal ref={attach} />
    </PanelPortalContext>
  );
}

/**
 * Clears the panel container for a subtree. Used inside modal popups: their
 * floating UI must not land in a panel the modal covers. Base UI chains it onto
 * the popup's own portal node instead, so pickers still stack above the modal.
 */
export function PanelPortalReset({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <PanelPortalContext value={undefined}>{children}</PanelPortalContext>;
}
