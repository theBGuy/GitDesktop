// The Tags tab (a Status-hub drill-in). Read-only list of the repo's tags. Mirrors
// the Branches list anatomy — SkeletonRows / ErrorState / RepoGoneState / EmptyState /
// StaleBanner semantics, `<ul>` divide-y, roving keyboard nav — but here the rows ARE
// tappable: a tag points at a commit, so a tap drills into the EXISTING commit detail
// (`history/{sha}`), exactly like a History row. Order is server-served (newest-first);
// no client re-sort.

import { CaretRightIcon, TagIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import type { TagInfo } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useTags } from "../lib/queries";
import { navigate, repoHash } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

/** The tags list. `repoId` scopes the query; `active` gates polling. */
export function TagsBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const { data, isError, error, refetch } = useTags(repoId, active);
  const { register, onKeyDown } = useRovingList();
  // True roving tabindex: the tab stop follows the last-focused row so Tab-ing away
  // and back returns to it, not row 0. Keyed by tag NAME, not index — a poll can
  // reorder the list under a remembered position, and identity keeps the stop on the
  // same tag; an unknown/absent name falls back to row 0. (Mirrors Branches r6+r7.)
  const [focusName, setFocusName] = useState<string | null>(null);

  // Definitive gone WINS over stale data: a `noSuchRepo` 404 kicks to the teaching
  // state even when a cached list is on hand (see isRepoGoneError).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  // Prefer stale data: keep the last-known list on screen even on error, with a
  // StaleBanner above it. Full-screen ErrorState only when there's nothing to
  // show; skeleton only while the first fetch is pending.
  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  // Rendered as served — the server sorts newest-first; never re-sort client-side.
  // Hoisted membership check (once per render, not per row): the remembered focus
  // name is active only while its tag is still in the list; otherwise the tab stop
  // falls back to row 0.
  const activeName =
    focusName != null && data.some((t) => t.name === focusName)
      ? focusName
      : null;

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {data.length === 0 ? (
        <EmptyState
          title="No tags yet."
          hint="Tags on this repository will show up here."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data.map((tag, i) => (
            <li key={tag.name}>
              <button
                type="button"
                ref={register(i)}
                onKeyDown={onKeyDown}
                // A tag points at a commit, so the row opens the EXISTING commit
                // detail. `target` is the full dereferenced sha (annotated tags too),
                // which the router's SHA_RE accepts.
                onClick={() =>
                  navigate(repoHash(repoId, `history/${tag.target}`))
                }
                onFocus={() => setFocusName(tag.name)}
                tabIndex={
                  (activeName != null ? tag.name === activeName : i === 0)
                    ? 0
                    : -1
                }
                className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:bg-muted/40"
              >
                <TagRow tag={tag} />
                <CaretRightIcon
                  size={16}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TagRow({ tag }: { tag: TagInfo }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <TagIcon
          size={16}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {tag.name}
        </span>
        {tag.annotated ? <TagChip label="annotated" /> : null}
      </div>
      {tag.subject ? (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {tag.subject}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono tabular-nums">
          {tag.target.slice(0, 7)}
        </span>
        <span className="shrink-0 tabular-nums">{timeAgo(tag.date)}</span>
      </div>
    </div>
  );
}

/** A small neutral marker chip (annotated) — text-only, no color-coded meaning,
 *  matching the companion's restrained register (copy of Branches' TagChip; the
 *  screens inline their own presentational blocks). */
function TagChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}
