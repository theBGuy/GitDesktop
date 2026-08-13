import { useId } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DisabledReasonButtonProps = React.ComponentProps<typeof Button> & {
  /** Why the button is disabled. Shown as tooltip + announced to AT while disabled. */
  reason?: string | null;
  /** Classes for the wrapping span (layout: ml-auto, flex-1, ...). */
  wrapperClassName?: string;
};

/**
 * Button that explains its own disabled state. A natively-disabled button
 * swallows its own `title` and leaves the tab order, so a button WITH a reason
 * takes Base UI's `focusableWhenDisabled` — `aria-disabled` instead of the
 * native attribute, focus intact, activation still blocked in its handler layer.
 * A reason-less disable stays native rather than becoming a mute tab stop.
 * Trigger sites keep the native attribute: wrap a titled span around
 * `<Trigger disabled render={<Button/>}/>`, or branch when the arms differ.
 */
export function DisabledReasonButton({
  reason,
  wrapperClassName,
  disabled,
  title,
  className,
  ...props
}: DisabledReasonButtonProps) {
  const id = useId();
  const blockedReason = disabled && reason ? reason : null;
  // `aria-describedby` outranks `title` as the accessible description, so a
  // caller's own description has to survive alongside the reason.
  const describedBy =
    [props["aria-describedby"], blockedReason ? id : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        blockedReason && "cursor-not-allowed",
        wrapperClassName,
      )}
      // Both disabled paths kill pointer events on the button, so the wrapper
      // owns the hover text whenever it is disabled — the reason when there is
      // one, otherwise the caller's ordinary hint.
      title={blockedReason ?? title}
    >
      <Button
        {...props}
        focusableWhenDisabled={!!blockedReason}
        disabled={disabled}
        title={title}
        // A reason trades the native attribute for `aria-disabled`, which the
        // vendored `disabled:` dim can't see; the dim lifts under focus so a
        // keyboard user isn't left tracking a half-opacity focus ring.
        className={cn(
          "aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100",
          className,
        )}
        aria-describedby={describedBy}
      />
      {blockedReason ? (
        <span id={id} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}
