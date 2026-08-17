import { Button } from "@/components/ui/button";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";

type DisabledReasonButtonProps = React.ComponentProps<typeof Button> & {
  /** Why the button is disabled. Shown as tooltip + announced to AT while disabled. */
  reason?: string | null;
  /** Classes for the wrapping span (layout: ml-auto, flex-1, ...). */
  wrapperClassName?: string;
};

/**
 * Button that explains its own disabled state — the vendored-Button arm of the
 * `useDisabledReason` contract, where a reason takes Base UI's
 * `focusableWhenDisabled` (activation still blocked in its own handler layer).
 * Trigger sites pick an arm by who needs the reason: a titled span around
 * `<Trigger disabled render={<Button/>}/>` is hover-only, so keyboard/AT reach
 * takes `<Trigger render={<DisabledReasonButton disabled reason/>}/>` instead —
 * disabled on the button, never the trigger, whose open handler the inner
 * `useButton` then swallows.
 */
export function DisabledReasonButton({
  reason,
  wrapperClassName,
  disabled,
  title,
  className,
  ...props
}: DisabledReasonButtonProps) {
  const { blockedReason, reasonId, wrapperTitle, describedBy } =
    useDisabledReason({
      disabled,
      reason,
      title,
      describedBy: props["aria-describedby"],
    });

  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        blockedReason && "cursor-not-allowed",
        wrapperClassName,
      )}
      title={wrapperTitle}
    >
      <Button
        {...props}
        focusableWhenDisabled={!!blockedReason}
        disabled={disabled}
        title={title}
        className={cn(ARIA_DISABLED_CLASS, className)}
        aria-describedby={describedBy}
      />
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}
