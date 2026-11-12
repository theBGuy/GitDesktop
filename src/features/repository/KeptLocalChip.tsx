import { LockIcon } from "@phosphor-icons/react";
import { KEPT_LOCAL_CHIP_LABEL, KEPT_LOCAL_CHIP_TEXT } from "./keep-local-copy";

/** A branch marked Keep local. Lives inside row buttons, so its label joins the
 *  row's accessible name rather than opening a detail popover. */
export function KeptLocalChip() {
  return (
    <span
      role="img"
      aria-label={KEPT_LOCAL_CHIP_LABEL}
      title={KEPT_LOCAL_CHIP_LABEL}
      className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
    >
      <LockIcon className="size-3" weight="bold" />
      {KEPT_LOCAL_CHIP_TEXT}
    </span>
  );
}
