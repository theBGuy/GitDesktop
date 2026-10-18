import { InfoIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One-line informational strip above a pane body: a hint, a disclosure, a
 *  capability note. A plain div, not a live region: it mounts with the content
 *  it describes. */
export function InfoNote({
  children,
  action,
  className,
}: {
  children: ReactNode;
  /** Optional trailing control (e.g. a dismiss button); it styles itself. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <InfoIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="flex-1 leading-snug">{children}</span>
      {action}
    </div>
  );
}
