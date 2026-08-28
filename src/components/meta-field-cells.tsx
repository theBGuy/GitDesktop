import type { ReactNode } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { clipTitleFromText } from "@/lib/clip-title";
import type { ForgeUserRef } from "@/lib/git/types";

/** A blank grid cell reads as a broken render, so an empty field says it has
 *  nothing instead. The dash is decorative; the word beside it is what a screen
 *  reader hears, the cell's own label having already named the field. */
const EMPTY_CELL = (
  <>
    <span aria-hidden className="text-muted-foreground">
      —
    </span>
    <span className="sr-only">None</span>
  </>
);

/**
 * The value half of a header meta field (labels, assignees, projects,
 * reviewers), paired in the grid with either its picker's trigger or a
 * `MetaFieldLabel`. role="group" plus the field name is what ties a value to
 * its field for assistive tech, the label column being a separate cell.
 * `min-h-6` matches the ghost xs trigger's box so short content shares the
 * row's centerline under the grid's `items-start`.
 */
export function MetaValueCell({
  label,
  empty = false,
  busy = false,
  children,
}: {
  label: string;
  /** The field holds nothing — render the placeholder rather than `children`. */
  empty?: boolean;
  /** The value is still being read, so `children` is a placeholder rather than
   *  the value — set it only when nothing real is on screen, since a refetch
   *  over visible content isn't a busy region. */
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5"
    >
      {/* aria-busy alone has no text; role="status" gives the busy region words
          for readers that announce it. */}
      {busy ? (
        <span role="status" className="sr-only">
          Loading {label.toLowerCase()}…
        </span>
      ) : null}
      {empty ? EMPTY_CELL : children}
    </div>
  );
}

/** The chip box shared by every chip that can sit in one meta value cell — a
 *  user, a bot request, a completed review — so adjacent chips can't drift. */
export const USER_CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 border py-0.5 pr-1.5 pl-0.5 text-[11px] text-muted-foreground";

/**
 * A forge user as a chip — the shared shape behind assignee and reviewer values,
 * editable and read-only alike. Bounded by its container so one long name can't
 * set a narrow column's min-content width; the clip tooltip removes its own
 * title when nothing is cut, leaving a caller's `title` to show through.
 */
export function UserChip({
  user,
  ghHost,
  hint,
  title,
}: {
  user: ForgeUserRef;
  /** GitHub host for login-derived avatars; `null` off GitHub. */
  ghHost: string | null;
  /** Disambiguator for a label another account shares (`userRefHint`). */
  hint?: string | null;
  /** Chip-level tooltip for callers that want one whether or not the name is
   *  cut — the disambiguated full label, say. */
  title?: string;
}) {
  return (
    <span title={title} className={USER_CHIP_CLASS}>
      {/* Decorative: the label beside it is the name, so an announced fallback
          letter would just precede it. */}
      <ForgeUserAvatar user={user} ghHost={ghHost} decorative />
      <span className="truncate" onMouseEnter={clipTitleFromText}>
        {user.label}
        {hint && <span className="text-muted-foreground"> · {hint}</span>}
      </span>
    </span>
  );
}

/** The label half of a meta field with no picker — a closed PR, or a provider
 *  that lacks it. The inset matches a ghost xs trigger's own text (a 1px
 *  transparent border + pl-1.5 + a size-3 icon + gap-1), so a column mixing
 *  static labels with triggers shares one text edge. */
export function MetaFieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-h-6 items-center pl-[23px] text-xs text-muted-foreground">
      {children}
    </span>
  );
}
