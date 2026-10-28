// Shared internals of the disabled-reason contract. A natively-disabled control
// swallows its own `title` and leaves the tab order, so a reasoned disable trades
// it for `aria-disabled`: focus intact, the reason announced via an sr-only node
// joined into `aria-describedby`, hover text on a wrapper span. A reason-less
// disable stays native rather than becoming a mute tab stop. JSX stays per-caller
// (the vendored Button and a raw `<button>` differ); this owns the derivations,
// plus the one `render` element a held focusable Button takes.
import type { BaseUIEvent } from "@base-ui/react/types";
import {
  createElement,
  type MouseEventHandler,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useId,
} from "react";

type KeyChord = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/** A button's own activation gesture: a bare Enter or Space. Any modifier,
 *  Shift included, makes it a chord the app may bind (mod+Enter commits) —
 *  and a click the browser still synthesizes from one is refused by useButton's
 *  onClick while disabled, so letting it through can't activate the button. */
export function isActivationKey(e: KeyChord): boolean {
  return (
    (e.key === "Enter" || e.key === " ") &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  );
}

/** keydown for the `render` element of a Base UI button that is disabled and
 *  `focusableWhenDisabled`. Base UI preventDefaults every key but Tab there, and
 *  the window hotkey and Escape listeners skip prevented events — so every key
 *  but activation skips its handler, leaving activation the only swallow. */
export function passThroughNonActivationKeys(
  e: BaseUIEvent<ReactKeyboardEvent<HTMLButtonElement>>,
) {
  if (!isActivationKey(e)) e.preventBaseUIHandler();
}

const stopClickPropagation = (e: ReactMouseEvent) => e.stopPropagation();

/** The `render` of a vendored Button that can sit disabled AND
 *  `focusableWhenDisabled`: while `held` (exactly that state), a native
 *  `<button>` taking {@link passThroughNonActivationKeys}, so Escape and app
 *  hotkeys still work with focus on it; otherwise the caller's own `render`.
 *  The element carries no `type`: render props merge last, so one would
 *  override a caller's type="submit". Callers pair it with
 *  {@link ARIA_DISABLED_CLASS}, whose aria-disabled:pointer-events-none keeps
 *  pointer clicks off it; any click that still lands (a let-through modified
 *  Enter/Space, an AT activation, a programmatic click) only has its
 *  propagation stopped here, and useButton's disabled onClick refuses it, so
 *  it never reaches the caller's onClick. The `focusable-held-button-render`
 *  guard in check-banned-patterns.mjs requires it on every JSX tag that
 *  writes `focusableWhenDisabled` as a literal attribute, except a
 *  `<form.SubmitButton>` tag, which the helper on SubmitButton's own
 *  `<Button>` covers. */
export function heldButtonRender<R = undefined>(
  held: boolean,
  render?: R,
): R | ReactElement | undefined {
  return held
    ? createElement("button", {
        onKeyDown: passThroughNonActivationKeys,
        onClick: stopClickPropagation,
      })
    : render;
}

/** The dim `aria-disabled` needs: the vendored `disabled:` variants can't see
 *  it, and it lifts under focus so a keyboard user isn't left tracking a
 *  half-opacity focus ring. */
export const ARIA_DISABLED_CLASS =
  "aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100";

export function useDisabledReason({
  disabled,
  reason,
  title,
  describedBy,
  onClick,
}: {
  disabled?: boolean;
  /** Why the control is held. Absent leaves an ordinary native disable. */
  reason?: string | null;
  /** The caller's ordinary hover hint, shown while nothing blocks. */
  title?: string;
  /** The caller's own `aria-describedby`, which has to survive alongside the
   *  reason — it outranks `title` as the accessible description. */
  describedBy?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const reasonId = useId();
  const blockedReason = disabled && reason ? reason : null;

  return {
    /** The reason while it actually blocks, else null. Callers render the
     *  sr-only node under `reasonId` (and the not-allowed cursor) only for it. */
    blockedReason,
    reasonId,
    /** The wrapper span's hover text: the reason when there is one, otherwise
     *  the caller's ordinary hint. */
    wrapperTitle: blockedReason ?? title,
    describedBy:
      [describedBy, blockedReason ? reasonId : null]
        .filter(Boolean)
        .join(" ") || undefined,
    /** For a RAW `<button>` only. `aria-disabled` is advisory, so activation is
     *  withheld here too. The vendored Button instead takes
     *  `focusableWhenDisabled={!!blockedReason}` with its `render` from
     *  {@link heldButtonRender} (the guard requires it; form.SubmitButton
     *  applies it for you), and blocks activation itself. */
    nativeProps: {
      disabled: blockedReason ? undefined : disabled,
      "aria-disabled": blockedReason ? true : undefined,
      onClick: blockedReason ? undefined : onClick,
    },
  };
}
