// The [ Issues | Discussions ] segmented control that lives at the top of both the
// Issues and Discussions screens (Discussions is a segmented sibling UNDER the Issues
// tab, not a tab of its own — the bottom nav highlights Issues on both routes).
//
// VISIBILITY CONTRACT — the segment OWNS its own availability logic so neither screen
// has to. It renders ONLY when the loaded meta says `hasDiscussionsEnabled === true`.
// Gating is DATA-driven, not status-driven, with definitive-error precedence:
//   • A `discussionsUnavailable` error (the 400 the server's forge gate mints for a
//     GitLab/Bitbucket repo) is DEFINITIVE — it wins over any stale cached data and
//     hides the segment, exactly the way `noSuchRepo`/RepoGone wins over stale data
//     elsewhere.
//   • Otherwise the segment tracks `meta.data.hasDiscussionsEnabled`. Reading the DATA
//     rather than `isSuccess` is deliberate: on a transient background-refetch failure
//     react-query v5 RETAINS the last good `data` while flipping `status` to 'error'
//     (after retries) — so an `isSuccess` gate would make the segment VANISH and
//     REAPPEAR on a wifi blip, contradicting its own no-flash promise. `data` stays
//     `undefined` only until the FIRST load resolves, so a loading meta still yields
//     null (no flash on first paint either).
// Consequence: on a repo without Discussions the Issues screen is pixel-identical to a
// build with no segment at all (zero extra layout), and a direct discussions URL on
// such a repo shows the screen's calm teaching state with no segment (there's nothing
// to switch to — the user reaches Issues via the bottom tab, which stays highlighted).

import { asApiError, useDiscussionMeta } from "../lib/queries";
import { navigate, repoHash } from "../lib/router";

export function IssuesDiscussionsSegment({
  repoId,
  current,
}: {
  repoId: string;
  current: "issues" | "discussions";
}) {
  const meta = useDiscussionMeta(repoId);

  // Definitive unavailable wins over stale data; otherwise gate on the DATA value
  // (see the data-driven, definitive-wins reasoning in the visibility contract above).
  if (asApiError(meta.error)?.isDiscussionsUnavailable) return null;
  if (meta.data?.hasDiscussionsEnabled !== true) return null;

  return (
    <div className="sticky top-0 z-10 flex items-stretch gap-1 border-b border-border bg-background/95 p-1 backdrop-blur">
      <SegmentButton
        repoId={repoId}
        tab="issues"
        label="Issues"
        current={current}
      />
      <SegmentButton
        repoId={repoId}
        tab="discussions"
        label="Discussions"
        current={current}
      />
    </div>
  );
}

/** One half of the segmented control. The selected half carries `aria-current="page"`
 *  plus the accent fill AND `font-medium` — selection is never conveyed by color alone
 *  (WCAG 1.4.1); the weight change and the aria semantics both survive a monochrome
 *  render. */
function SegmentButton({
  repoId,
  tab,
  label,
  current,
}: {
  repoId: string;
  tab: "issues" | "discussions";
  label: string;
  current: "issues" | "discussions";
}) {
  const selected = current === tab;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => navigate(repoHash(repoId, tab))}
      className={`min-h-11 flex-1 rounded text-sm ${
        selected
          ? "bg-primary font-medium text-primary-foreground"
          : "font-normal text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}
