import {
  CheckCircleIcon,
  CircleIcon,
  MinusCircleIcon,
  ProhibitIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeProvider, PrCheckOut } from "@/lib/git/types";

/** Tone + glyph for a CI check, so pass/fail is never conveyed by color alone.
 *  `provider` only distinguishes ACTION_REQUIRED — the one state whose meaning
 *  differs per forge. This module holds the pure presentation plus the shared
 *  `isOutstanding` predicate below, so the rollup component and the required-checks
 *  hook read one marker set without either importing the other. */
export function checkPresentation(
  status: string,
  provider: ForgeProvider,
): {
  tone: string;
  Icon: typeof CheckCircleIcon;
  label: string;
  /** Coarse bucket for the rollup summary + failures-first sort. */
  bucket: "passed" | "failed" | "pending" | "skipped";
} {
  const s = status.toUpperCase();
  if (s === "SUCCESS") {
    return {
      tone: "text-success",
      Icon: CheckCircleIcon,
      label: "passed",
      bucket: "passed",
    };
  }
  if (["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"].includes(s)) {
    return {
      tone: "text-destructive",
      Icon: XCircleIcon,
      label: "failed",
      bucket: "failed",
    };
  }
  if (s === "CANCELLED") {
    // Finished without a result, not a failure — a run superseded by a
    // concurrency group is routine, and every forge normalizes its cancel state
    // to this word. The glyph matches the Actions tab's StatusIcon so the two
    // surfaces agree; the required-checks join gates a cancelled required
    // context explicitly rather than through this bucket.
    return {
      tone: "text-muted-foreground",
      Icon: ProhibitIcon,
      label: "cancelled",
      bucket: "skipped",
    };
  }
  if (["SKIPPED", "NEUTRAL", "STALE"].includes(s)) {
    return {
      tone: "text-muted-foreground",
      Icon: MinusCircleIcon,
      // The three share a bucket/icon/tone, but the accessible label is each
      // status's own word ("skipped" / "neutral" / "stale") so a screen reader
      // announces the actual result. The summary segment still says "skipped".
      label: s.toLowerCase(),
      bucket: "skipped",
    };
  }
  if (s === "ACTION_REQUIRED" && provider === "github") {
    // GitHub's is the one ACTION_REQUIRED a maintainer can act on from here (a
    // fork PR's run held for approval), so it names the wait instead of reading
    // as generic pending. It keeps the pending bucket: nothing has run yet.
    return {
      tone: "text-warning",
      Icon: WarningIcon,
      label: "awaiting approval",
      bucket: "pending",
    };
  }
  // Everything still in flight — IN_PROGRESS/QUEUED/PENDING — plus non-GitHub
  // ACTION_REQUIRED (deliberately here: it awaits a human, so the amber warning
  // tone fits) falls through to the pending bucket.
  return {
    tone: "text-warning",
    Icon: CircleIcon,
    label: "pending",
    bucket: "pending",
  };
}

/** Whether one run leaves its context still to come. STALE and CANCELLED count
 *  here but not in the presentation above: GitHub's passing set is success,
 *  skipped or neutral, so either holds the merge until it re-runs even though both
 *  read as finished, neutral results. `unmetRequiredChecks` decides the join with
 *  it and `ChecksRollup` flags the rows, so the two share one marker set. */
export function isOutstanding(
  check: PrCheckOut,
  provider: ForgeProvider,
): boolean {
  const s = check.status.toUpperCase();
  if (s === "STALE" || s === "CANCELLED") return true;
  const { bucket } = checkPresentation(check.status, provider);
  return bucket === "failed" || bucket === "pending";
}
