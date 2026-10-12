import { DisabledReasonButton } from "@/components/disabled-reason-button";
import type { ConversationFeature } from "./useCollapsedSections";
import type { ConversationPreset } from "./useRemoteListFilter";

/** The segments each panel offers, with the semantics on the `title` so the
 *  one-word labels never have to carry them alone. */
const SEGMENTS: Record<
  ConversationFeature,
  { value: ConversationPreset; label: string; title: string }[]
> = {
  pulls: [
    { value: "all", label: "All", title: "Show every pull request" },
    {
      value: "mine",
      label: "Mine",
      title: "Assigned to you, or your review requested",
    },
    {
      value: "needs-review",
      label: "Needs review",
      title: "Assigned or review-requested, grouped by your review",
    },
  ],
  issues: [
    { value: "all", label: "All", title: "Show every issue" },
    { value: "mine", label: "Mine", title: "Assigned to you" },
  ],
};

/**
 * The one-click scope switch in the conversation toolbar — a segmented pair or
 * triple of `aria-pressed` buttons mirroring the Open/Closed state filter and the
 * Fork/Upstream lens.
 *
 * Nothing renders once the forge check settles on a provider that can't express
 * the "mine" axes server-side: the popover's disabled rows carry that
 * explanation, so the toolbar stays calm. While that check runs, the feature's
 * whole segment set holds with `probeReason`, so the row is in place from the
 * first frame and only trims or drops segments once, at settle.
 * `preset` is null when the user has hand-picked axes matching no segment — every
 * button then reads unpressed, and the funnel badge carries the detail.
 */
export function ConversationPresetSwitcher({
  feature,
  preset,
  onPreset,
  canFilterMine,
  canGroupByReview,
  disabledReason,
  probeReason,
}: {
  feature: ConversationFeature;
  preset: ConversationPreset | null;
  onPreset: (next: ConversationPreset) => void;
  canFilterMine: boolean;
  /** Gates the "Needs review" segment: without the review timestamps the
   *  grouping can't happen, so the segment could never light up. */
  canGroupByReview: boolean;
  /** Why the scope can't be switched right now — the stored prefs aren't read
   *  yet, so `onPreset` has nothing to compose its write from. Held with the
   *  reason rather than hidden: the segments are the panel's scope readout, and a
   *  toolbar that empties on every repo switch is worse than one that waits. */
  disabledReason?: string | null;
  /** Non-null while the forge check has no answer yet: which segments exist is
   *  still unknown, so every one holds with this reason, ahead of
   *  `disabledReason`. Required, so no caller can skip the waiting arm. */
  probeReason: string | null;
}) {
  if (!canFilterMine && probeReason === null) return null;

  const waiting = !canFilterMine;
  // Waiting paints the full set: GitHub, the usual answer, keeps every segment.
  const segments = waiting
    ? SEGMENTS[feature]
    : SEGMENTS[feature].filter(
        (s) => s.value !== "needs-review" || canGroupByReview,
      );
  const heldReason = waiting ? probeReason : disabledReason;

  return (
    <div className="flex items-center gap-1">
      {segments.map((s) => (
        <DisabledReasonButton
          key={s.value}
          variant={preset === s.value ? "secondary" : "ghost"}
          size="xs"
          className="px-1.5"
          aria-pressed={preset === s.value}
          title={s.title}
          disabled={!!heldReason}
          reason={heldReason}
          onClick={() => onPreset(s.value)}
        >
          {s.label}
        </DisabledReasonButton>
      ))}
    </div>
  );
}
