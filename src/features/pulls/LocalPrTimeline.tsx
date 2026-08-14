import {
  ArrowCounterClockwiseIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { RelativeTime } from "@/components/relative-time";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";

/** The lifecycle events a local PR emits — no CI/remote activity, just the
 *  local create/merge/close/reopen milestones. */
export type LocalLifecycleKind = "created" | "merged" | "closed" | "reopened";

/** Presentation (icon, tone, verb) for a local lifecycle event. Icon + word,
 *  never color-alone; tones use the shared semantic tokens. */
function lifecyclePresentation(kind: LocalLifecycleKind): {
  Icon: typeof GitCommitIcon;
  tone?: string;
  label: string;
} {
  switch (kind) {
    case "created":
      return { Icon: GitBranchIcon, label: "created this local PR" };
    case "merged":
      return {
        Icon: GitMergeIcon,
        tone: "text-merged",
        label: "merged this",
      };
    case "closed":
      return {
        Icon: XCircleIcon,
        tone: "text-destructive",
        label: "closed this",
      };
    case "reopened":
      return {
        Icon: ArrowCounterClockwiseIcon,
        tone: "text-success",
        label: "reopened this",
      };
  }
}

/** A calm lifecycle row for a local PR's activity feed: the thin neutral rail +
 *  centered icon + muted verb + relative time. Mirrors the density of the
 *  remote PrTimeline's event rows. The rail is a 1px structural connective line
 *  (NOT a colored side-stripe) — the icon carries any semantic tone.
 *
 *  `date` is optional so an older record that closed before `closedAt` existed
 *  still renders a "closed this" marker, just without a timestamp. */
export function LocalPrLifecycleRow({
  kind,
  date,
}: {
  kind: LocalLifecycleKind;
  date?: string;
}) {
  const { Icon, tone, label } = lifecyclePresentation(kind);
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="relative flex w-5 shrink-0 justify-center">
        {/* The vertical connective rail: 1px, neutral (border token). */}
        <div
          aria-hidden
          className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border"
        />
        <div className="relative mt-0.5 bg-background py-0.5">
          <Icon className={cn("size-3.5", tone)} aria-label={label} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 py-0.5 text-muted-foreground">
        <span className="min-w-0">{label}</span>
        {date && parseableDate(date) && (
          <span className="shrink-0 text-muted-foreground/80">
            · <RelativeTime date={date} />
          </span>
        )}
      </div>
    </div>
  );
}
