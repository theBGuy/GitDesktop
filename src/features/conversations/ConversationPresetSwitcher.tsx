import { Button } from "@/components/ui/button";
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
 * Nothing renders when the provider can't express the "mine" axes server-side:
 * the popover's disabled rows carry that explanation, so the toolbar stays calm.
 * `preset` is null when the user has hand-picked axes matching no segment — every
 * button then reads unpressed, and the funnel badge carries the detail.
 */
export function ConversationPresetSwitcher({
  feature,
  preset,
  onPreset,
  canFilterMine,
  canGroupByReview,
}: {
  feature: ConversationFeature;
  preset: ConversationPreset | null;
  onPreset: (next: ConversationPreset) => void;
  canFilterMine: boolean;
  /** Gates the "Needs review" segment: without the review timestamps the
   *  grouping can't happen, so the segment could never light up. */
  canGroupByReview: boolean;
}) {
  if (!canFilterMine) return null;

  const segments = SEGMENTS[feature].filter(
    (s) => s.value !== "needs-review" || canGroupByReview,
  );

  return (
    <div className="flex items-center gap-1">
      {segments.map((s) => (
        <Button
          key={s.value}
          variant={preset === s.value ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={preset === s.value}
          title={s.title}
          onClick={() => onPreset(s.value)}
        >
          {s.label}
        </Button>
      ))}
    </div>
  );
}
