import type { ComponentProps } from "react";
import { Switch } from "@/components/ui/switch";
import { SAVING_LAST_CHANGE_REASON } from "@/lib/offline-writes";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";

/** Why a {@link HeldSwitch} is held. The site reason (offline, inherited, a
 *  dependency, a pending certificate) outranks `saving`, as the row pickers'
 *  `offlineReason ?? SAVING_LAST_CHANGE_REASON` does: a toggle pressed offline
 *  is refused or held at the site, so that reason is the one that applies. */
export function heldSwitchReason(
  heldReason: string | undefined,
  saving: boolean,
): string | undefined {
  return heldReason ?? (saving ? SAVING_LAST_CHANGE_REASON : undefined);
}

/**
 * A switch held with a reason ({@link heldSwitchReason}). Held by `readOnly`,
 * never Base UI's `disabled`, which sets tabIndex -1: the switch stays one
 * mounted, focusable node across every hold edge, Space and Enter flip
 * nothing, and the reason reaches hover, keyboard, and AT alike.
 */
export function HeldSwitch({
  heldReason,
  saving = false,
  inLabel = false,
  className,
  ...props
}: Omit<ComponentProps<typeof Switch>, "disabled" | "readOnly"> & {
  heldReason?: string;
  /** The switch's own change is still saving. */
  saving?: boolean;
  /** Named by a wrapping `<label>`, which then carries the hover title itself:
   *  Chromium reads a titled descendant's title into the label's text, and so
   *  into the switch's name. */
  inLabel?: boolean;
}) {
  const reason = heldSwitchReason(heldReason, saving);
  const held = reason !== undefined;
  const hold = useDisabledReason({
    disabled: held,
    reason,
    describedBy: props["aria-describedby"],
  });
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        hold.blockedReason !== null && "cursor-not-allowed",
      )}
      title={inLabel ? undefined : hold.wrapperTitle}
    >
      {/* `hidden`, as in HeldRoleSelect: a wrapping <label> names the switch
          from its content, which skips hidden text but would read sr-only. */}
      {hold.blockedReason !== null && (
        <span id={hold.reasonId} hidden>
          {hold.blockedReason}
        </span>
      )}
      <Switch
        {...props}
        readOnly={held}
        aria-disabled={held || undefined}
        aria-describedby={hold.describedBy}
        className={cn(ARIA_DISABLED_CLASS, className)}
      />
    </span>
  );
}
