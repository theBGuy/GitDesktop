// Shared internals of the disabled-reason contract. A natively-disabled control
// swallows its own `title` and leaves the tab order, so a reasoned disable trades
// it for `aria-disabled`: focus intact, the reason announced via an sr-only node
// joined into `aria-describedby`, hover text on a wrapper span. A reason-less
// disable stays native rather than becoming a mute tab stop. JSX stays per-caller
// (the vendored Button and a raw `<button>` differ); this owns the derivations.
import { type MouseEventHandler, useId } from "react";

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
     *  `focusableWhenDisabled={!!blockedReason}` and blocks activation itself. */
    nativeProps: {
      disabled: blockedReason ? undefined : disabled,
      "aria-disabled": blockedReason ? true : undefined,
      onClick: blockedReason ? undefined : onClick,
    },
  };
}
