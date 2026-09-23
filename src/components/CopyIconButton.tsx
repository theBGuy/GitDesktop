import { CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * The one icon-only copy control: the vendored ghost Button (focus ring
 * included) with `label` as both its accessible name and its tooltip.
 * Controls that show visible "Copy" text don't use it.
 *
 * Contract: a click never propagates, so a copy inside a clickable row or
 * header never also activates its parent.
 */
export function CopyIconButton({
  text,
  label,
  toast,
  className,
}: {
  /** What to copy; a getter defers building an expensive string to click time. */
  text: string | (() => string);
  /** Names the control for assistive tech and the hover tooltip alike. */
  label: string;
  /** Success toast shown once the copy lands. */
  toast: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground", className)}
      onClick={(e) => {
        e.stopPropagation();
        copyText(typeof text === "function" ? text() : text, toast);
      }}
    >
      {/* aria-hidden: the button's aria-label names the control; the SVG is
          decoration and Phosphor doesn't hide it by default. */}
      <CopyIcon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
