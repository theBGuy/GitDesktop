import { type ReactNode, useId } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** A caption that NAMES the controls under it: a bare `<Label>` with no `htmlFor`
 *  and no wrapped control names nothing for assistive tech, so the caption's id
 *  ties the group to it — as McpServersSection's role="group" scope groups do. */
export function LabeledGroup({
  label,
  children,
  className,
  actions,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Merged over the default spacing, so a caller adding only borders or padding
   *  keeps it and one passing its own `space-y-*` still wins (tailwind-merge). */
  className?: string;
  /** Rendered opposite the caption on its own row (e.g. an Add button). */
  actions?: ReactNode;
}) {
  const id = useId();
  const caption = <Label id={id}>{label}</Label>;
  return (
    <div
      role="group"
      aria-labelledby={id}
      className={cn("space-y-2", className)}
    >
      {actions ? (
        // `gap-2` is a collision floor under justify-between: invisible until a
        // narrow host would butt the caption against the actions.
        <div className="flex items-center justify-between gap-2">
          {caption}
          {actions}
        </div>
      ) : (
        caption
      )}
      {children}
    </div>
  );
}
