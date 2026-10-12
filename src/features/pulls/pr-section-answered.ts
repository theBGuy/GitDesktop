// When a PR view section can land in one step. Import-free (a type-only import
// is erased) so scripts/pr-section-answered.test.mjs loads it under Node's type
// stripping.
import type { PrSection } from "@/lib/pulls/pr-section";

/** One read as a section's readiness sees it. */
export interface SectionRead {
  data: unknown;
  isError: boolean;
  isPaused: boolean;
  isPlaceholderData: boolean;
}

/** Whether a read has answered for its key: its own data (never another key's
 *  placeholder), a final error, or a park offline, which renders its own notice
 *  rather than waiting. */
export function readAnswered(q: SectionRead): boolean {
  return (
    (q.data !== undefined && !q.isPlaceholderData) || q.isError || q.isPaused
  );
}

/**
 * Whether the reads a PR section paints beyond the details have all answered for
 * ONE pull request, so the section lands in one step. The single rule for the
 * switch hold's settle (over the selected PR's reads), the Conversation feed's
 * mount, and the review-notification handoff that scrolls inside it (over the
 * shown PR's). `null` marks a read the section doesn't take: a capability the
 * provider lacks, or, for the timeline, no provider resolved yet, where a settled
 * forge probe stands in. Conversation takes threads, timeline, reactions and
 * Bitbucket tasks; Files the diff; Commits and Review nothing beyond the details,
 * which carry the commit list (the review panel owns its own reads).
 */
export function prSectionAnswered(
  section: PrSection,
  reads: {
    threads: SectionRead;
    timeline: SectionRead | null;
    forgeSettled: boolean;
    reactions: SectionRead | null;
    tasks: SectionRead | null;
    diff: SectionRead;
  },
): boolean {
  switch (section) {
    case "conversation":
      return (
        readAnswered(reads.threads) &&
        (reads.timeline ? readAnswered(reads.timeline) : reads.forgeSettled) &&
        (!reads.reactions || readAnswered(reads.reactions)) &&
        (!reads.tasks || readAnswered(reads.tasks))
      );
    case "files":
      return readAnswered(reads.diff);
    case "commits":
    case "review":
      return true;
  }
}
