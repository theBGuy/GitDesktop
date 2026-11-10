import { XIcon } from "@phosphor-icons/react";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import { clipTitle } from "@/lib/clip-title";
import type { ForgeProvider } from "@/lib/git/types";
import {
  chipFacets,
  chipLabel,
  type FacetKind,
  type Facets,
} from "./run-filters";
import { statusLabel } from "./status";

const GITHUB_STATUS_KINDS = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
  "completed",
]);

/** statusLabel folds both into "Queued"; as filter values they differ. */
const GITHUB_STATUS_OVERRIDES: Record<string, string> = {
  requested: "Requested",
  pending: "Pending",
};

/** GitLab's finished statuses as the run rows carry them (`map_ci_status` in
 *  forge/gitlab.rs), so their options read exactly as the rows they return. */
const GITLAB_FINISHED_CONCLUSIONS: Record<string, string> = {
  success: "success",
  failed: "failure",
  canceled: "cancelled",
  skipped: "skipped",
  manual: "action_required",
};

/** In-flight statuses the rows fold together keep their own names, as GitHub's
 *  requested and pending do. */
const GITLAB_STATUS_LABELS: Record<string, string> = {
  created: "Created",
  waiting_for_resource: "Waiting for resource",
  preparing: "Preparing",
  waiting_for_callback: "Waiting for callback",
  pending: "Pending",
  running: "Running",
  canceling: "Canceling",
  scheduled: "Scheduled",
};

const BITBUCKET_STATUS_LABELS: Record<string, string> = {
  PARSING: "Parsing",
  PENDING: "Pending",
  PAUSED: "Paused",
  HALTED: "Halted",
  BUILDING: "Building",
  ERROR: "Error",
  PASSED: "Passed",
  FAILED: "Failed",
  STOPPED: "Stopped",
  UNKNOWN: "Unknown",
};

const STATUS_LABELERS: Record<ForgeProvider, (value: string) => string> = {
  // Through statusLabel, so a chip and the run rows name a status alike.
  github: (v) =>
    GITHUB_STATUS_OVERRIDES[v] ??
    (GITHUB_STATUS_KINDS.has(v)
      ? statusLabel(v, "")
      : statusLabel("completed", v)),
  gitlab: (v) => {
    const conclusion = GITLAB_FINISHED_CONCLUSIONS[v];
    return conclusion
      ? statusLabel("completed", conclusion)
      : (GITLAB_STATUS_LABELS[v] ?? v);
  },
  bitbucket: (v) => BITBUCKET_STATUS_LABELS[v] ?? v,
};

/** A status filter value's label; an unrecognized host routes through gh. */
export function statusFacetLabel(
  provider: ForgeProvider | null | undefined,
  value: string,
): string {
  return STATUS_LABELERS[provider ?? "github"](value);
}

/** A chip's facet word and its shown value (statuses labelled). */
export function shownChip(
  kind: FacetKind,
  facets: Facets,
  provider: ForgeProvider | null | undefined,
): { facet: string; value: string } {
  const { facet, value } = chipLabel(kind, facets);
  return {
    facet,
    value: kind === "status" ? statusFacetLabel(provider, value) : value,
  };
}

/** The set facets as removable chips. Each chip's text isn't a stop of its
 *  own: its remove button names the full value, even when the text truncates. */
export function RunFilterChips({
  facets,
  provider,
  onRemove,
  onClearAll,
  rowRef,
}: {
  facets: Facets;
  provider: ForgeProvider | null | undefined;
  onRemove: (kind: FacetKind) => void;
  onClearAll: () => void;
  /** On the row itself, so a focus rescue sees focus inside it as it leaves. */
  rowRef?: Ref<HTMLDivElement>;
}) {
  const kinds = chipFacets(facets);
  if (kinds.length === 0) return null;
  return (
    <div
      ref={rowRef}
      role="group"
      aria-label="Active run filters"
      className="flex flex-wrap gap-1"
    >
      {kinds.map((kind) => {
        const { facet, value } = shownChip(kind, facets, provider);
        const text = `${facet}: ${value}`;
        return (
          <span
            key={kind}
            className="inline-flex h-6 max-w-full min-w-0 items-center border bg-muted/40 pl-2 text-[11px]"
          >
            <span className="min-w-0 truncate" onMouseEnter={clipTitle(text)}>
              {text}
            </span>
            <button
              type="button"
              data-chip-remove={kind}
              aria-label={`Remove filter ${text}`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onRemove(kind)}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </span>
        );
      })}
      {kinds.length >= 2 && (
        <Button variant="ghost" size="xs" onClick={onClearAll}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
