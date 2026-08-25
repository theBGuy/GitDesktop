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
 * Clears the panel container for a subtree. Used inside modal popups, which
 * portal to the body: their floating UI must not land in a panel the modal covers.
 */
export function PanelPortalReset({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <PanelPortalContext value={undefined}>{children}</PanelPortalContext>;
}
