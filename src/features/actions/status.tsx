import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleNotchIcon,
  MinusCircleIcon,
  ProhibitIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeProvider } from "@/lib/git/types";
import { isRunActive } from "@/lib/github/actions";
import { cn } from "@/lib/utils";

/** Whether a completed conclusion counts as a failure (drives "Re-run failed"). */
export function isFailureConclusion(conclusion: string): boolean {
  return (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "startup_failure"
  );
}

/** Whether the provider calls its CI unit a pipeline rather than a workflow
 *  run. An unrecognized host routes through `gh`, so it reads as GitHub. */
export function isPipelineProvider(
  provider: ForgeProvider | null | undefined,
): boolean {
  return provider === "gitlab" || provider === "bitbucket";
}

/** What this provider calls one CI unit. Every run-facing label and toast is
 *  built from this, so one surface can never say "run" beside another's
 *  "pipeline". */
export type CiRunNoun = "run" | "pipeline";
export function ciRunNoun(
  provider: ForgeProvider | null | undefined,
): CiRunNoun {
  return isPipelineProvider(provider) ? "pipeline" : "run";
}

/** One re-run the provider offers for a run: the label users read, plus the
 *  kind the caller dispatches. */
export type RerunOffer = {
  kind: "all" | "failed" | "retry" | "bb-rerun";
  label: string;
};

/**
 * The re-run offers for a run, in render order. Shared by the run detail view
 * and the runs-list context menu so the two can't drift on which offers a
 * provider makes or what they're called. An in-flight run offers none of them:
 * Cancel is its only action.
 */
export function rerunOffers(
  provider: ForgeProvider | null | undefined,
  status: string,
  conclusion: string,
): RerunOffer[] {
  // GitLab's retry restarts a pipeline's failed AND canceled jobs, so it covers
  // both conclusions and has no "all jobs" analogue.
  if (provider === "gitlab") {
    return isFailureConclusion(conclusion) || conclusion === "cancelled"
      ? [{ kind: "retry", label: "Retry pipeline" }]
      : [];
  }
  // Bitbucket has no rerun endpoint — its "rerun" re-triggers the branch
  // pipeline, which makes sense on any finished run (success included).
  if (provider === "bitbucket") {
    return !isRunActive(status) && conclusion !== ""
      ? [{ kind: "bb-rerun", label: "Rerun pipeline" }]
      : [];
  }
  if (isRunActive(status)) return [];
  const offers: RerunOffer[] = [{ kind: "all", label: "Re-run all jobs" }];
  if (isFailureConclusion(conclusion)) {
    offers.push({ kind: "failed", label: "Re-run failed jobs" });
  }
  return offers;
}

/** Hover copy per re-run offer, for the two whose label doesn't say what the
 *  provider actually restarts. Shared with the offers themselves so a surface
 *  can't show one without the other. */
export const RERUN_TITLES: Record<RerunOffer["kind"], string | undefined> = {
  all: undefined,
  failed: undefined,
  retry: "Restart this pipeline's failed and canceled jobs",
  "bb-rerun": "Trigger this pipeline's branch again",
};

/** The toast a started re-run shows, in the words of the provider's own
 *  operation. */
export function rerunSuccessMessage(
  provider: ForgeProvider | null | undefined,
  failedOnly: boolean,
): string {
  switch (true) {
    case provider === "gitlab":
      return "Retrying pipeline";
    case provider === "bitbucket":
      return "Triggering a new pipeline";
    case failedOnly:
      return "Re-running failed jobs";
    default:
      return "Re-running workflow";
  }
}

/** Whether Cancel applies to a run. A manual/blocked GitLab pipeline reports
 *  completed + action_required, but GitLab's cancel endpoint does cancel it. */
export function cancelOffered(
  provider: ForgeProvider | null | undefined,
  status: string,
  conclusion: string,
): boolean {
  return (
    isRunActive(status) ||
    (provider === "gitlab" && conclusion === "action_required")
  );
}

/** What Cancel is called, in the provider's own noun. */
export function cancelLabel(
  provider: ForgeProvider | null | undefined,
): "Cancel run" | "Cancel pipeline" {
  return `Cancel ${ciRunNoun(provider)}`;
}

/** The toast an accepted cancel shows — same noun as the control the user
 *  clicked. */
export function cancelStartedMessage(
  provider: ForgeProvider | null | undefined,
): string {
  return `Cancelling ${ciRunNoun(provider)}…`;
}

/** Human label for a run/job/step's combined status + conclusion. */
export function statusLabel(status: string, conclusion: string): string {
  if (status !== "completed") {
    if (status === "in_progress") return "In progress";
    if (status === "waiting") return "Waiting";
    return "Queued";
  }
  switch (conclusion) {
    case "success":
      return "Succeeded";
    case "failure":
      return "Failed";
    case "timed_out":
      return "Timed out";
    case "startup_failure":
      return "Startup failure";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
    case "action_required":
      return "Action required";
    case "neutral":
      return "Neutral";
    case "stale":
      return "Stale";
    default:
      return conclusion || "Completed";
  }
}

/**
 * Status glyph for a run, job, or step. Active items spin; completed ones show
 * a coloured pass/fail/neutral mark. `weight="bold"` keeps the dashed/notch
 * outlines legible.
 */
export function StatusIcon({
  status,
  conclusion,
  className,
}: {
  status: string;
  conclusion: string;
  className?: string;
}) {
  const base = cn("size-4 shrink-0", className);

  if (status !== "completed") {
    if (status === "in_progress") {
      return (
        <CircleNotchIcon
          weight="bold"
          className={cn(base, "animate-spin text-warning")}
        />
      );
    }
    return (
      <CircleDashedIcon
        weight="bold"
        className={cn(base, "text-muted-foreground")}
      />
    );
  }

  switch (conclusion) {
    case "success":
      return (
        <CheckCircleIcon weight="fill" className={cn(base, "text-success")} />
      );
    case "failure":
    case "timed_out":
    case "startup_failure":
      return (
        <XCircleIcon weight="fill" className={cn(base, "text-destructive")} />
      );
    case "action_required":
      return <WarningIcon weight="fill" className={cn(base, "text-warning")} />;
    case "cancelled":
      return (
        <ProhibitIcon
          weight="bold"
          className={cn(base, "text-muted-foreground")}
        />
      );
    case "skipped":
      return (
        <MinusCircleIcon
          weight="bold"
          className={cn(base, "text-muted-foreground")}
        />
      );
    default:
      return (
        <CircleIcon
          weight="bold"
          className={cn(base, "text-muted-foreground")}
        />
      );
  }
}

export { isRunActive };
