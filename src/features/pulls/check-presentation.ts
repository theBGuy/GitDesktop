import {
  CheckCircleIcon,
  CircleIcon,
  MinusCircleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeProvider } from "@/lib/git/types";

/** Tone + glyph for a CI check, so pass/fail is never conveyed by color alone.
 *  `provider` only distinguishes ACTION_REQUIRED — the one state whose meaning
 *  differs per forge. Its own module rather than the rollup's: the required-checks
 *  join reads `bucket` too, and importing it from the component would drag that
 *  component's log/query/opener graph into a hook that needs none of it. */
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
  if (
    ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"].includes(
      s,
    )
  ) {
    return {
      tone: "text-destructive",
      Icon: XCircleIcon,
      label: "failed",
      bucket: "failed",
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
