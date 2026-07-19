import { CaretRightIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { ErrorState, SkeletonRows } from "../components/states";
import type { RepoSummary } from "../lib/api";
import { useRepos } from "../lib/queries";
import { isRepoId, navigate, repoHash, type Tab } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

// The repo picker (`#repos`). Lists the repositories the desktop is sharing so the
// phone can choose which one to browse — a first-class screen now that the
// companion is multi-repo. Read-only; tapping a repo scopes every tab to it.
//
// Reached two ways: the shell's bootstrap (multiple repos shared, none picked yet)
// and the TopBar title trigger (switching repos mid-session). When switching, the
// caller passes the current tab so the pick lands on the SAME tab rather than
// bouncing everyone back to Status.

/** Filter to safely-navigable repos, then sort: the active repo (open on the
 *  desktop) first, then alphabetical by name. `localeCompare` so names sort the
 *  way a human reads them. The server's order is unspecified, so we always sort
 *  client-side. A repo whose id fails the router grammar is dropped — tapping it
 *  would build a `#r/{bad}/…` hash that parses back to null and loops. */
function sortRepos(repos: RepoSummary[]): RepoSummary[] {
  return repos
    .filter((r) => isRepoId(r.id))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** A small "open on desktop" badge — icon + text so the state never rests on color
 *  alone (WCAG 1.4.1), using the same success token the rest of the app uses. */
function ActiveBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
      <CheckCircleIcon size={12} weight="fill" />
      Active
    </span>
  );
}

/** The repo picker body. `currentRepoId` marks the currently-selected repo (a
 *  check + `aria-current`); `currentTab` is preserved when navigating so switching
 *  repos keeps you on the same tab. Both are null when the picker is the bootstrap
 *  entry (no repo chosen yet) — then picks default to the Status tab. */
export function ReposBody({
  currentRepoId,
  currentTab,
}: {
  currentRepoId: string | null;
  currentTab: Tab | null;
}) {
  const { data, isError, error, refetch } = useRepos();
  const { register, onKeyDown } = useRovingList();

  const repos = useMemo(() => (data ? sortRepos(data) : []), [data]);

  // Preserve the tab the user came from (if any) so a switch keeps context; the
  // bootstrap entry (no current tab) lands on Status.
  const tail = currentTab ?? "status";

  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  if (repos.length === 0) {
    // Nothing shared yet — a calm teaching state (not an error). The desktop is the
    // only place to change what's shared, so we point there.
    return (
      <div
        className="flex flex-col items-center gap-3 px-8 py-16 text-center"
        role="status"
      >
        <p className="text-sm font-medium text-foreground">
          Nothing is shared yet.
        </p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Share a repository from GitDesktop on your desktop to browse it here.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {repos.map((repo, i) => {
        const selected = repo.id === currentRepoId;
        return (
          <li key={repo.id}>
            <button
              type="button"
              ref={register(i)}
              onKeyDown={onKeyDown}
              aria-current={selected ? "true" : undefined}
              onClick={() => navigate(repoHash(repo.id, tail))}
              className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
            >
              {/* A selection check reserves its slot whether or not it shows, so
                  rows stay aligned and the label doesn't jump. */}
              <CheckCircleIcon
                size={18}
                weight="fill"
                className={`shrink-0 ${selected ? "text-primary" : "text-transparent"}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {repo.name}
              </span>
              {repo.active ? <ActiveBadge /> : null}
              <CaretRightIcon
                size={16}
                className="shrink-0 text-muted-foreground"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
