import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

// The Badge's own hover tints match only `[a]`, so the trigger restates them
// per variant, held while the popover is open like a ghost button's.
const TRIGGER_TINT: Record<BadgeVariant, string> = {
  default: "hover:bg-primary/80 aria-expanded:bg-primary/80",
  secondary: "hover:bg-secondary/80 aria-expanded:bg-secondary/80",
  destructive:
    "hover:bg-destructive/20 aria-expanded:bg-destructive/20 dark:hover:bg-destructive/30 dark:aria-expanded:bg-destructive/30",
  outline:
    "hover:bg-muted aria-expanded:bg-muted dark:hover:bg-muted/50 dark:aria-expanded:bg-muted/50",
  ghost: "aria-expanded:bg-muted dark:aria-expanded:bg-muted/50",
  link: "aria-expanded:underline",
};

/**
 * A status badge whose explanation opens in a click popover, so keyboard,
 * touch, and assistive tech reach it (a `title` reaches only a mouse). With no
 * detail it is the plain, unfocusable Badge: never an affordance that opens
 * onto nothing. The trigger is a real button, so it must not sit inside
 * another interactive element; place it as a sibling of a clickable row.
 */
export function StatusDetailChip({
  label,
  detail,
  icon,
  variant,
  className,
}: {
  /** The visible badge text; it also leads the trigger's accessible name. */
  label: string;
  /** The explanation; newlines render as line breaks. */
  detail?: string | null;
  /** A leading glyph, carrying `data-icon="inline-start"` like a Badge's. */
  icon?: ReactNode;
  variant?: BadgeVariant | null;
  className?: string;
}) {
  const v = variant ?? "default";
  if (!detail?.trim()) {
    return (
      <Badge variant={v} className={className}>
        {icon}
        {label}
      </Badge>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${label}, details`}
        className={cn(
          badgeVariants({ variant: v }),
          TRIGGER_TINT[v],
          "cursor-pointer outline-none",
          className,
        )}
      >
        {icon}
        {label}
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverTitle className="text-xs">{label}</PopoverTitle>
        <PopoverDescription className="whitespace-pre-line wrap-break-word">
          {detail}
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
