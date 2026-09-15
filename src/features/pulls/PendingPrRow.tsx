import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ROW_CLASS } from "@/features/conversations/ConversationListPanel";
import { clipTitleFromText } from "@/lib/clip-title";
import type { PrCreate } from "@/lib/stores/pr-create";

/** The meta line, per lane phase — the only thing that distinguishes them, since
 *  a spinner alone carries no state under reduced motion. `creating` borrows the
 *  banner's verb so one screen never reads two words for one operation;
 *  `created` says what the spinner is still spinning for rather than claiming a
 *  completion the list can't show yet. */
const PHASE_META: {
  [P in PrCreate["phase"]]: (create: Extract<PrCreate, { phase: P }>) => string;
} = {
  creating: (create) => `Creating ${create.noun}…`,
  created: (create) => `#${create.number} · updating list…`,
};

/**
 * Holds a running create's place in the pull-request list, in the slot the real
 * row will take. Purely presentational: no `data-row`, no role, nothing
 * focusable or clickable — the caller's arrow-key registry and tab order must be
 * identical with and without it, and the repo view's create banner stays the
 * sole live region for this fact (a second one double-announces).
 */
export function PendingPrRow({ create }: { create: PrCreate }) {
  return (
    // The panel's own row box, minus every interactive affordance: same borders
    // and padding, so the hand-off to the real row is a slot-for-slot swap.
    <div className={ROW_CLASS}>
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Spinner aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={create.title}>
          {create.title}
        </span>
        {create.draft && <Badge variant="secondary">Draft</Badge>}
      </p>
      <p
        className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground"
        onMouseEnter={clipTitleFromText}
      >
        {create.phase === "created"
          ? PHASE_META.created(create)
          : PHASE_META.creating(create)}
      </p>
      <p
        className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground"
        onMouseEnter={clipTitleFromText}
      >
        {create.head} → {create.base}
      </p>
    </div>
  );
}
