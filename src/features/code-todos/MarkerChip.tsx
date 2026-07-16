import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { markerTint } from "./markers";

/** A restrained chip for a TODO marker word (e.g. `TODO`, `FIXME`). The word is
 *  always shown — meaning never rides on color alone — with a semantic text
 *  tint. Shared by the list rows and the detail header. */
export function MarkerChip({
  marker,
  className,
}: {
  marker: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("font-mono", markerTint(marker), className)}
    >
      {marker}
    </Badge>
  );
}
