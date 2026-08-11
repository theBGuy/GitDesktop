import {
  CircleIcon,
  DotOutlineIcon,
  InfoIcon,
  QuestionIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** GitHub's advisory severity ladder plus GitLab's `Info` rung, and the bucket a
 *  missing or unrecognized value falls into (repo advisories may carry no
 *  severity at all). No GitHub surface reports `info`. */
export type SeverityLevel =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | "unknown";

/** Severity tone, via the app's semantic tokens. Critical and high share the
 *  destructive tone and are told apart by icon weight + label, never by color;
 *  everything at or below `low` is muted so the ladder never inverts. */
export const SEVERITY_TONE: Record<SeverityLevel, string> = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
  info: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** Worst-first sort order. The alerts endpoint orders by creation date, so the
 *  UI applies this ladder itself to float the worst findings to the top. */
export const SEVERITY_RANK: Record<SeverityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  unknown: 5,
};

export const SEVERITY_LABEL: Record<SeverityLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
  unknown: "Unspecified",
};

/** One glyph per rung: `info` sits below `low`, so it takes the lightest mark
 *  rather than repeating low's — adjacent rungs must not differ by label alone. */
const SEVERITY_ICON: Record<SeverityLevel, typeof WarningIcon> = {
  critical: WarningIcon,
  high: WarningIcon,
  medium: WarningCircleIcon,
  low: InfoIcon,
  info: DotOutlineIcon,
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
    case "info":
      return "info";
    default:
      return "unknown";
  }
}

/**
 * A compact severity chip — **Critical** / **High** / **Medium** / **Low** /
 * **Info** / **Unspecified**. Icon + text carry the meaning (never color alone,
 * per the WCAG-AA rule); critical additionally fills its icon so it stays
 * distinct from high, which shares its tone.
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

// ── Code scanning ────────────────────────────────────────────────────────────

/** A code scanning alert's SARIF level. A ladder of its own: an `error` is the
 *  analysis tool's confidence, not an advisory severity, so it is never relabeled
 *  "Critical" or "High" — only *ranked* alongside them. */
export type SarifLevel = "error" | "warning" | "note" | "unknown";

const SARIF_LABEL: Record<SarifLevel, string> = {
  error: "Error",
  warning: "Warning",
  note: "Note",
  unknown: "Unspecified",
};

/** The severity rung a SARIF level shares for ordering and visual weight. Sort
 *  and tone only — `SARIF_LABEL` is what names the level to the user. */
const SARIF_AS_SEVERITY: Record<SarifLevel, SeverityLevel> = {
  error: "high",
  warning: "medium",
  note: "low",
  unknown: "unknown",
};

export function sarifLevel(level: string | null): SarifLevel {
  switch (level?.toLowerCase()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
      return "note";
    default:
      return "unknown";
  }
}

/** Fields of a code scanning alert that decide its chip and its rank. */
interface CodeScanningLevels {
  securitySeverity: string | null;
  severity: string | null;
}

/** Worst-first rank for a code scanning alert: its security severity when the
 *  rule carries one, else its SARIF level on the shared ladder. Presence of
 *  `securitySeverity` is the switch, matching `CodeScanningChip`. */
export function codeScanningRank(a: CodeScanningLevels): number {
  return SEVERITY_RANK[
    a.securitySeverity
      ? severityLevel(a.securitySeverity)
      : SARIF_AS_SEVERITY[sarifLevel(a.severity)]
  ];
}

/**
 * The chip for a code scanning alert. A rule with a security severity gets the
 * ordinary severity chip; anything else is labeled with its SARIF level in that
 * ladder's own words, so nothing is promoted to a severity GitHub never assigned.
 */
export function CodeScanningChip({
  securitySeverity,
  severity,
}: CodeScanningLevels) {
  if (securitySeverity) return <SeverityChip severity={securitySeverity} />;
  const level = sarifLevel(severity);
  const rung = SARIF_AS_SEVERITY[level];
  const Icon = SEVERITY_ICON[rung];
  return (
    <Badge variant="outline" className={cn("gap-1", SEVERITY_TONE[rung])}>
      <Icon />
      {SARIF_LABEL[level]}
    </Badge>
  );
}

// ── Secret scanning ──────────────────────────────────────────────────────────

/** Whether a leaked secret still works. GitHub only checks providers it has a
 *  validator for, so "unknown" is the honest reading of a missing validity —
 *  never "inactive". */
export type ValidityLevel = "active" | "inactive" | "unknown";

const VALIDITY_LABEL: Record<ValidityLevel, string> = {
  active: "Active",
  inactive: "Inactive",
  unknown: "Unknown",
};

/** A still-working credential is the emergency, so it takes the destructive
 *  tone; the label carries the meaning on its own for the color-blind path. */
const VALIDITY_TONE: Record<ValidityLevel, string> = {
  active: "text-destructive",
  inactive: "text-muted-foreground",
  unknown: "text-foreground",
};

/** Active secrets float to the top of the list. */
export const VALIDITY_RANK: Record<ValidityLevel, number> = {
  active: 0,
  unknown: 1,
  inactive: 2,
};

const VALIDITY_ICON: Record<ValidityLevel, typeof WarningIcon> = {
  active: WarningIcon,
  inactive: CircleIcon,
  unknown: QuestionIcon,
};

export function validityLevel(validity: string | null): ValidityLevel {
  switch (validity?.toLowerCase()) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    default:
      return "unknown";
  }
}

/** The user-facing name for a validity, normalized exactly as the chip does. */
export const validityLabel = (validity: string | null): string =>
  VALIDITY_LABEL[validityLevel(validity)];

/** A secret's validity chip — **Active** / **Inactive** / **Unknown**. */
export function ValidityChip({ validity }: { validity: string | null }) {
  const level = validityLevel(validity);
  const Icon = VALIDITY_ICON[level];
  return (
    <Badge variant="outline" className={cn("gap-1", VALIDITY_TONE[level])}>
      <Icon weight={level === "active" ? "fill" : "regular"} />
      {VALIDITY_LABEL[level]}
    </Badge>
  );
}

// ── Code quality ─────────────────────────────────────────────────────────────

/** A CodeClimate report's severity. Its own ladder, like SARIF: a `blocker` is a
 *  maintainability call by a linter, not a security severity, so it is never
 *  relabeled "Critical" — only *ranked* alongside them. */
export type CqLevel =
  | "blocker"
  | "critical"
  | "major"
  | "minor"
  | "info"
  | "unknown";

const CQ_LABEL: Record<CqLevel, string> = {
  blocker: "Blocker",
  critical: "Critical",
  major: "Major",
  minor: "Minor",
  info: "Info",
  unknown: "Unspecified",
};

/** The severity rung a CodeClimate level shares for ordering and visual weight.
 *  Sort and tone only — `CQ_LABEL` is what names the level to the user. */
const CQ_AS_SEVERITY: Record<CqLevel, SeverityLevel> = {
  blocker: "critical",
  critical: "high",
  major: "medium",
  minor: "low",
  info: "info",
  unknown: "unknown",
};

export function cqLevel(severity: string | null): CqLevel {
  switch (severity?.toLowerCase()) {
    case "blocker":
      return "blocker";
    case "critical":
      return "critical";
    case "major":
      return "major";
    case "minor":
      return "minor";
    case "info":
      return "info";
    default:
      return "unknown";
  }
}

/** Worst-first rank for a code quality finding, on the shared severity ladder. */
export const cqRank = (severity: string | null): number =>
  SEVERITY_RANK[CQ_AS_SEVERITY[cqLevel(severity)]];

/** The chip for a code quality finding, labeled in CodeClimate's own words so
 *  nothing is promoted to a severity the report never assigned. */
export function CqChip({ severity }: { severity: string | null }) {
  const level = cqLevel(severity);
  const rung = CQ_AS_SEVERITY[level];
  const Icon = SEVERITY_ICON[rung];
  return (
    <Badge variant="outline" className={cn("gap-1", SEVERITY_TONE[rung])}>
      <Icon weight={rung === "critical" ? "fill" : "regular"} />
      {CQ_LABEL[level]}
    </Badge>
  );
}
