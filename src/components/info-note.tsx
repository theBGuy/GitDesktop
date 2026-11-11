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
  reserve = false,
}: {
  children: ReactNode;
  /** Optional trailing control (e.g. a dismiss button); it styles itself. */
  action?: ReactNode;
  className?: string;
  /** Keeps the strip's box, border and wrapped height with every child
   *  invisible and the whole strip out of the a11y tree: a loading frame's
   *  reservation, so what sits below does not move when the real note lands. */
  reserve?: boolean;
}) {
  return (
    <div
      aria-hidden={reserve || undefined}
      className={cn(
        "flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <InfoIcon
        aria-hidden
        className={cn("size-3.5 shrink-0", reserve && "invisible")}
      />
      <span className={cn("flex-1 leading-snug", reserve && "invisible")}>
        {children}
      </span>
      {reserve ? <span className="invisible contents">{action}</span> : action}
    </div>
  );
}
