import { type ReactNode, type Ref, useState } from "react";
import {
  SWAP_NODE_ATTR,
  successorCandidates,
  swapStopsOf,
} from "@/components/confirm-successors";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { cn } from "@/lib/utils";

export type SwapFocusRef = (
  node: HTMLElement | null,
) => (() => void) | undefined;

/** Form-swap keys skip the successor marker: a row's Edit or Deliveries control
 *  must not outrank its Delete as where focus lands after a neighbor's delete. */
const FORM_SWAP_PREFIX = "form:";

/** The swap key a section's Add control shares with its create form's exits. */
export const NEW_FORM_SWAP_KEY = `${FORM_SWAP_PREFIX}new`;

/** The swap key a row's form opener shares with the exits of the view it
 *  opens; distinct from the row's own confirm key. */
export function rowFormSwapKey(
  kind: "edit" | "deliveries",
  id: string | number,
): string {
  return `${FORM_SWAP_PREFIX}${kind}:${id}`;
}

/** The swap key an inline form or detail view's exits leave under: the row
 *  control that opened it while that row is still listed, else the section's
 *  Add control, since a row deleted meanwhile leaves no claimant. */
export function formExitSwapKey(rowKey: string, listed: boolean): string {
  return listed ? rowKey : NEW_FORM_SWAP_KEY;
}

function onBody(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

const FALLBACK_SELECTOR = "[data-confirm-fallback]";

/**
 * Marks the first descendant matching `selector` as a confirm-swap stop, for
 * triggers rendered by components that take no DOM props. Attach to the ROW;
 * it marks at attach time, so the trigger must render with the row.
 */
export function markSwapStop(selector: string) {
  return (node: HTMLElement | null) => {
    node?.querySelector(selector)?.setAttribute(SWAP_NODE_ATTR, "");
  };
}

/** Where focus goes when a leaving node took its row or container with it,
 *  captured at ref cleanup while the DOM still holds that node. */
interface Successors {
  row: Element | null;
  /** The rows before `row` in its section, nearest first. */
  before: Element[];
  section: Element | null;
  host: Element | null;
}

function successorsOf(node: HTMLElement): Successors {
  const row = node.closest("[data-confirm-row]");
  const section =
    node.closest("[data-confirm-section]") ?? row?.parentElement ?? null;
  const rows =
    row === null || section === null
      ? []
      : Array.from(section.querySelectorAll("[data-confirm-row]"));
  const at = row === null ? -1 : rows.indexOf(row);
  return {
    row,
    before: at > 0 ? rows.slice(0, at).reverse() : [],
    section,
    host: node.closest("[data-confirm-host]"),
  };
}

/** Focuses `el` if it can take focus now: connected, rendered, not disabled. */
function focusLanded(el: Element | null | undefined): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  el.focus();
  return document.activeElement === el;
}

function focusSuccessor({ row, before, section, host }: Successors) {
  const sectionConnected = section?.isConnected ?? false;
  successorCandidates<Element>({
    rows:
      row === null || section === null
        ? []
        : Array.from(section.querySelectorAll("[data-confirm-row]")),
    before,
    connected: (el) => el.isConnected,
    stopsOf: (row) => swapStopsOf<Element>(row),
    sectionConnected,
    sectionFallbacks:
      section === null
        ? []
        : Array.from(section.querySelectorAll(FALLBACK_SELECTOR)),
    // A section that left with the node can't hold the landing, so the host's
    // own fallbacks stand in for it before the host itself.
    hostFallbacks:
      sectionConnected || host === null
        ? []
        : Array.from(host.querySelectorAll(FALLBACK_SELECTOR)),
    host,
  }).some(focusLanded);
}

function createConfirmSwapFocus() {
  let armed: string | number | null = null;
  // A node whose focus went nowhere (natively disabled under focus) dropped it
  // to <body> with no landing, and still owns it until it leaves.
  let stranded: HTMLElement | null = null;
  const refs = new Map<string | number, SwapFocusRef>();
  return (key: string | number = ""): SwapFocusRef => {
    let ref = refs.get(key);
    if (ref === undefined) {
      const marked = !String(key).startsWith(FORM_SWAP_PREFIX);
      ref = (node) => {
        if (node === null) return;
        if (marked) node.setAttribute(SWAP_NODE_ATTR, "");
        if (armed === key) {
          armed = null;
          if (onBody()) node.focus({ preventScroll: true });
        }
        const onFocusOut = (e: FocusEvent) => {
          if (e.relatedTarget === null) stranded = node;
        };
        // A window blur also leaves with no target, but focus comes back here.
        const onFocusIn = () => {
          if (stranded === node) stranded = null;
        };
        node.addEventListener("focusout", onFocusOut);
        node.addEventListener("focusin", onFocusIn);
        // Ref cleanup runs before React removes the node, while focus and the
        // node's neighbors are still readable. A swap claims within its own
        // commit, so a leave still unclaimed at the microtask took its row or
        // container along. A microtask, not an rAF: it runs ahead of Base UI's
        // focusout fallback to the popup, which an rAF loses to.
        return () => {
          node.removeEventListener("focusout", onFocusOut);
          node.removeEventListener("focusin", onFocusIn);
          if (marked) node.removeAttribute(SWAP_NODE_ATTR);
          const owned =
            node.contains(document.activeElement) ||
            (stranded === node && onBody());
          if (stranded === node) stranded = null;
          if (!owned) return;
          armed = key;
          const successors = successorsOf(node);
          queueMicrotask(() => {
            if (armed !== key) return;
            armed = null;
            if (onBody()) focusSuccessor(successors);
          });
        };
      };
      refs.set(key, ref);
    }
    return ref;
  };
}

/**
 * Keeps focus across a `confirming ? <InlineConfirm/> : <trigger/>` swap: pass
 * the same `swapFocus(key)` as the trigger's `ref` and InlineConfirm's
 * `swapFocusRef`, keyed per row when one hook serves a list. Moves focus only
 * when the leaving side held it (or had dropped it to `<body>`, unclaimed) and
 * focus still sits on `<body>`, inside the swap's own commit — ahead of Base
 * UI's dialog fallback — so a pointer user who clicked elsewhere is never
 * pulled back.
 *
 * A leave nothing claims (its row or container left too) lands on a successor,
 * found from DOM markers: the next `data-confirm-row`'s swap control (the row
 * itself first when it carries `data-confirm-swap`), else the previous one's
 * (rows without one are skipped), else the first focusable
 * `data-confirm-fallback` in the `data-confirm-section`, else, when that
 * section left too, one in the `data-confirm-host`, else the list or form
 * host. Mark the row root, the section root, and its fallback controls.
 *
 * An inline form that renders INSTEAD of its list has no successor to find, so
 * it hands off by key: the hook lives in the component owning the swap, and the
 * opening control (Add under {@link NEW_FORM_SWAP_KEY}, a row's Edit under
 * {@link rowFormSwapKey}) shares one `swapFocus(key)` with every exit of the
 * view it opens, which leave under {@link formExitSwapKey}.
 */
export function useConfirmSwapFocus() {
  const [swapFocus] = useState(createConfirmSwapFocus);
  return swapFocus;
}

/**
 * The confirm half of an inline confirm-delete affordance: a `Cancel` button and
 * a (usually destructive) action button with a pending spinner, optionally
 * preceded by a prompt. The parent owns the `confirming` state and renders this in
 * the confirming branch in place of its normal trigger — so the reset-on-cancel /
 * on-success and the row layout stay with the parent, but the repeated button
 * markup lives in one place.
 */
export function InlineConfirm({
  prompt,
  promptClassName,
  cancelLabel = "Cancel",
  cancelVariant = "ghost",
  actLabel,
  actVariant = "destructive",
  size = "sm",
  pending = false,
  heldReason,
  swapFocusRef,
  onCancel,
  onAct,
}: {
  prompt?: ReactNode;
  /** e.g. `mr-auto` to push the buttons to the right in a footer layout. */
  promptClassName?: string;
  cancelLabel?: ReactNode;
  cancelVariant?: "ghost" | "outline";
  actLabel: ReactNode;
  actVariant?: "destructive" | "default";
  /** Both buttons' size. */
  size?: "sm" | "xs";
  pending?: boolean;
  /** Why the act button is held, as its hover text and accessible description.
   *  Unset leaves it held only while `pending`. */
  heldReason?: string;
  /** The `useConfirmSwapFocus` ref this confirm swaps with its trigger under. */
  swapFocusRef?: Ref<HTMLButtonElement>;
  onCancel: () => void;
  onAct: () => void;
}) {
  return (
    <>
      {prompt != null && (
        <span className={cn("text-muted-foreground", promptClassName)}>
          {prompt}
        </span>
      )}
      {/* Both buttons report a leave; Cancel attaches first in tree order, so
          it is the one that claims an incoming hand-off. */}
      <Button
        ref={swapFocusRef}
        size={size}
        variant={cancelVariant}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      {/* One node whether or not a reason holds it, so a focused act button
          survives the reason coming and going. Pending holds by reason too,
          so the press keeps focus through the write instead of dropping it. */}
      <DisabledReasonButton
        ref={swapFocusRef}
        size={size}
        variant={actVariant}
        disabled={pending || heldReason !== undefined}
        reason={heldReason ?? (pending ? ACT_PENDING_REASON : undefined)}
        onClick={onAct}
      >
        {pending && <Spinner data-icon="inline-start" />}
        {actLabel}
      </DisabledReasonButton>
    </>
  );
}
