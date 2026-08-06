import {
  CircleIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** GitHub's advisory severity ladder, plus the bucket a missing or unrecognized
 *  value falls into (repo advisories may carry no severity at all). */
export type SeverityLevel = "critical" | "high" | "medium" | "low" | "unknown";

/** Severity tone, via the app's semantic tokens. Critical and high share the
 *  destructive tone and are told apart by icon weight + label, never by color. */
export const SEVERITY_TONE: Record<SeverityLevel, string> = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** Worst-first sort order. The alerts endpoint orders by creation date, so the
 *  UI applies this ladder itself to float the worst findings to the top. */
export const SEVERITY_RANK: Record<SeverityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

export const SEVERITY_LABEL: Record<SeverityLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unspecified",
};

const SEVERITY_ICON: Record<SeverityLevel, typeof WarningIcon> = {
  critical: WarningIcon,
  high: WarningIcon,
  medium: WarningCircleIcon,
  low: InfoIcon,
  unknown: CircleIcon,
};

/** Normalize a server severity string; anything unrecognized (including null)
 *  reads as "unknown" rather than being silently downgraded to "low". */
export function severityLevel(severity: string | null): SeverityLevel {
  switch (severity?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}

/**
 * A compact severity chip — **Critical** / **High** / **Medium** / **Low** /
 * **Unspecified**. Icon + text carry the meaning (never color alone, per the
 * WCAG-AA rule); critical additionally fills its icon so it stays distinct from
 * high, which shares its tone.
 */
export function SeverityChip({ severity }: { severity: string | null }) {
  const level = severityLevel(severity);
  const Icon = SEVERITY_ICON[level];
  return (
    <Badge variant="outline" className={cn("gap-1", SEVERITY_TONE[level])}>
      <Icon weight={level === "critical" ? "fill" : "regular"} />
      {SEVERITY_LABEL[level]}
    </Badge>
  );
}
