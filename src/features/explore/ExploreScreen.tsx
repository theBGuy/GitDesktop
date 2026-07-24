import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useForgeProviderFeatures,
  useForgeRepos,
  useForgeSearchRepos,
} from "@/lib/git/queries";
import type { ForgeProvider, ForgeSearchRepo } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage, isAppError } from "@/lib/tauri/invoke";
import {
  ExploreCloneDialog,
  type ExploreCloneTarget,
} from "./ExploreCloneDialog";
import { ExploreDetail } from "./ExploreDetail";
import { ExploreResultRow } from "./ExploreResultRow";
import {
  EXPLORE_LISTBOX_ID,
  type ExploreRow,
  exploreOptionId,
  forgeRepoToSearchRepo,
  groupReposByOwner,
  useDebouncedValue,
} from "./explore-utils";

type SortOption = "best" | "stars" | "updated";
type ZeroMode = "yours" | "popular";

const SORT_ITEMS: Record<SortOption, string> = {
  best: "Best match",
  stars: "Most stars",
  updated: "Recently updated",
};

/**
 * The Explore repositories surface — a full-page master/detail view for
 * searching, browsing, cloning, forking, and starring repositories on a provider
 * without leaving the app. Palette-reachable and launched from the Welcome
 * screen; Back / Esc return to the previous view.
 */
export function ExploreScreen() {
  const closeExplore = useUiStore((s) => s.closeExplore);
  const [provider, setProvider] = useState<ForgeProvider>("github");
  const [rawQuery, setRawQuery] = useState("");
  const [sort, setSort] = useState<SortOption>("best");
  const [zeroMode, setZeroMode] = useState<ZeroMode>("yours");
  const [selected, setSelected] = useState<ForgeSearchRepo | null>(null);
  const [cloneTarget, setCloneTarget] = useState<ExploreCloneTarget | null>(
    null,
  );
  // The flattened repo rows of whichever list (Yours / Popular / Search) is
  // mounted, lifted here so the search Input can drive arrow-key navigation over
  // them regardless of which mode is on screen.
  const [flatRepos, setFlatRepos] = useState<ForgeSearchRepo[]>([]);
  const detailRef = useRef<HTMLDivElement>(null);

  const query = useDebouncedValue(rawQuery.trim(), 400);
  const isBitbucket = provider === "bitbucket";
  // Bitbucket retired its global search: no Popular feed, and an empty query has
  // no meaning there — its zero state is always "Yours".
  const effectiveZeroMode: ZeroMode = isBitbucket ? "yours" : zeroMode;
  const searching = query.length > 0;
  // "Popular" is the star-sorted empty-query feed (GitHub/GitLab only).
  const showingPopular = !searching && effectiveZeroMode === "popular";
  const showingYours = !searching && effectiveZeroMode === "yours";

  const features = useForgeProviderFeatures(provider);

  // Esc closes Explore. Guarded so Base UI popups (which mark the event consumed)
  // get first claim; an effect event reads the latest closeExplore.
  const onEscape = useEffectEvent(() => closeExplore());
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onEscape();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Clear the lifted rows whenever the visible list changes (provider / query /
  // mode / sort — sort re-keys the search query, so its refetch window counts
  // too). The mounted list republishes its real rows via onRowsChange; this
  // reset covers the non-ready states (loading / error / empty) that don't
  // render a list at all, so stale rows can't drive the input's arrow nav.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are change-triggers, not values the body reads
  useEffect(() => {
    setFlatRepos([]);
  }, [provider, query, effectiveZeroMode, sort]);

  // Arrow keys from the search input move the selection through the flat rows
  // (mirroring CloneRepoDialog); Enter jumps focus to the detail pane's first
  // action (Clone) so a keyboard user goes type → arrows → Enter → activate
  // without Tab-hunting.
  const onInputArrow = listKeyboardNav({
    items: flatRepos,
    activeIndex: flatRepos.findIndex((r) => r.fullName === selected?.fullName),
    onActivate: (r) => setSelected(r),
  });
  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (!selected) return;
      e.preventDefault();
      // Focus the first enabled action button in the detail pane (Clone).
      detailRef.current
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus();
      return;
    }
    onInputArrow(e);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={closeExplore}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="text-sm font-medium">Explore repositories</span>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs
          value={provider}
          onValueChange={(v) => {
            setProvider(v as ForgeProvider);
            setSelected(null);
          }}
        >
          <TabsList>
            <TabsTrigger value="github">GitHub</TabsTrigger>
            <TabsTrigger value="gitlab">GitLab</TabsTrigger>
            <TabsTrigger value="bitbucket">Bitbucket</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search repositories"
          aria-label="Search repositories"
          role="combobox"
          aria-expanded={flatRepos.length > 0}
          aria-controls={EXPLORE_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            selected ? exploreOptionId(selected.fullName) : undefined
          }
          className="h-8 min-w-40 flex-1"
        />
        {/* Bitbucket results are always recency-ordered — a disabled sort would
            need more explanation than its absence, so hide it there. */}
        {!isBitbucket && searching && (
          <Select
            items={SORT_ITEMS}
            value={sort}
            onValueChange={(v) => v && setSort(v as SortOption)}
          >
            <SelectTrigger size="sm" aria-label="Sort results">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_ITEMS).map(([value, display]) => (
                <SelectItem key={value} value={value}>
                  {display}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {isBitbucket && (
        <p className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          Search covers your Bitbucket workspaces.
        </p>
      )}

      {!searching && !isBitbucket && (
        <div className="border-b px-3 py-2">
          <Tabs
            value={effectiveZeroMode}
            onValueChange={(v) => setZeroMode(v as ZeroMode)}
          >
            <TabsList variant="line">
              <TabsTrigger value="yours">Your repositories</TabsTrigger>
              <TabsTrigger value="popular">Popular</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-2/5 min-w-0 flex-col border-r">
          {showingYours ? (
            <YoursResults
              provider={provider}
              selected={selected}
              onSelect={setSelected}
              onRowsChange={setFlatRepos}
            />
          ) : (
            <SearchResults
              provider={provider}
              query={showingPopular ? "" : query}
              sort={showingPopular ? "stars" : sort}
              selected={selected}
              onSelect={setSelected}
              onRowsChange={setFlatRepos}
            />
          )}
        </div>
        {/* overflow-hidden contains the content's natural height (vendored Root
            is `relative`-only), so a long README can't leak a window scrollbar. */}
        <ScrollArea className="min-w-0 flex-1 overflow-hidden">
          <div ref={detailRef}>
            <ExploreDetail
              provider={provider}
              repo={selected}
              features={features.data}
              onClone={setCloneTarget}
            />
          </div>
        </ScrollArea>
      </div>

      <ExploreCloneDialog
        target={cloneTarget}
        onOpenChange={(open) => {
          if (!open) setCloneTarget(null);
        }}
      />
    </div>
  );
}

/** The "Your repositories" zero-state list — reuses the clone browser's own-repos
 *  hook, mapped into the shared result-row shape and owner-grouped. */
function YoursResults({
  provider,
  selected,
  onSelect,
  onRowsChange,
}: {
  provider: ForgeProvider;
  selected: ForgeSearchRepo | null;
  onSelect: (repo: ForgeSearchRepo | null) => void;
  onRowsChange: (repos: ForgeSearchRepo[]) => void;
}) {
  const repos = useForgeRepos(provider, true);

  const rows = useMemo<ExploreRow[]>(() => {
    const data = repos.data;
    if (!data) return [];
    return groupReposByOwner(
      data.repos.map(forgeRepoToSearchRepo),
      data.viewer,
    );
  }, [repos.data]);

  if (repos.isPending) return <SkeletonRows />;
  if (repos.isError) {
    return <ResultsError provider={provider} error={repos.error} />;
  }
  if (rows.length === 0) {
    return <QuietLine>No repositories yet.</QuietLine>;
  }
  return (
    <ResultsList
      rows={rows}
      selected={selected}
      onSelect={onSelect}
      onRowsChange={onRowsChange}
    />
  );
}

/** The search / Popular results list — an infinite query with a load-more row
 *  and GitHub's 1000-result cap note. */
function SearchResults({
  provider,
  query,
  sort,
  selected,
  onSelect,
  onRowsChange,
}: {
  provider: ForgeProvider;
  query: string;
  sort: SortOption;
  selected: ForgeSearchRepo | null;
  onSelect: (repo: ForgeSearchRepo | null) => void;
  onRowsChange: (repos: ForgeSearchRepo[]) => void;
}) {
  const search = useForgeSearchRepos(provider, query, sort, true);

  const repos = useMemo<ForgeSearchRepo[]>(
    () => search.data?.pages.flatMap((p) => p.repos) ?? [],
    [search.data],
  );
  // Search results are already provider-ranked (best/stars/updated), so present
  // them flat — no owner grouping, which would fight the ranking.
  const rows = useMemo<ExploreRow[]>(
    () => repos.map((repo) => ({ kind: "repo" as const, repo })),
    [repos],
  );

  const total = search.data?.pages[0]?.total ?? null;
  // GitHub caps search at 1000 reachable results; when the reported total exceeds
  // what paging can reach, say so instead of implying more pages.
  const capped = total !== null && total > repos.length && !search.hasNextPage;

  if (search.isPending) return <SkeletonRows />;
  if (search.isError) {
    return <ResultsError provider={provider} error={search.error} />;
  }
  if (rows.length === 0) {
    return <QuietLine>No repositories match.</QuietLine>;
  }
  return (
    <ResultsList
      rows={rows}
      selected={selected}
      onSelect={onSelect}
      onRowsChange={onRowsChange}
      footer={
        <>
          {search.hasNextPage && (
            <button
              type="button"
              onClick={() => search.fetchNextPage()}
              disabled={search.isFetchingNextPage}
              className="flex w-full items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:bg-muted/60 disabled:opacity-60"
            >
              {search.isFetchingNextPage ? (
                <>
                  <Spinner />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </button>
          )}
          {capped && (
            <p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
              GitHub returns at most 1,000 search results — refine your search.
            </p>
          )}
        </>
      }
    />
  );
}

/** The shared virtualized result list (headers + rows), with keyboard nav wired
 *  to a top-level keydown so arrows move the selection and scroll it into view. */
function ResultsList({
  rows,
  selected,
  onSelect,
  onRowsChange,
  footer,
}: {
  rows: ExploreRow[];
  selected: ForgeSearchRepo | null;
  onSelect: (repo: ForgeSearchRepo | null) => void;
  onRowsChange: (repos: ForgeSearchRepo[]) => void;
  footer?: React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].kind === "header" ? 26 : 46),
    overscan: 12,
  });

  const repoRows = useMemo(
    () => rows.flatMap((r) => (r.kind === "repo" ? [r.repo] : [])),
    [rows],
  );

  // Publish the flat rows up so the search Input can drive arrow-key navigation.
  useEffect(() => {
    onRowsChange(repoRows);
  }, [repoRows, onRowsChange]);

  // Drop a selection that a provider/mode switch has hidden.
  useEffect(() => {
    if (selected && !repoRows.some((r) => r.fullName === selected.fullName)) {
      onSelect(null);
    }
  }, [repoRows, selected, onSelect]);

  // Keep the keyboard-selected repo scrolled into view.
  const selectedKey = selected?.fullName;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection or list changes
  useEffect(() => {
    if (!selectedKey) return;
    const idx = rows.findIndex(
      (r) => r.kind === "repo" && r.repo.fullName === selectedKey,
    );
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedKey, rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Arrow-key navigation lives on the search Input (combobox pattern), so
          the listbox itself is not a Tab stop — it stays a pure a11y container. */}
      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-y-auto"
        role="listbox"
        id={EXPLORE_LISTBOX_ID}
        aria-label="Search results"
        aria-activedescendant={
          selected ? exploreOptionId(selected.fullName) : undefined
        }
      >
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                // Presentation wrapper so the virtualizer's positioning div doesn't
                // sit between the listbox and its options in the a11y tree.
                role="presentation"
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                {row.kind === "header" ? (
                  <p className="bg-muted/50 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {row.owner}
                  </p>
                ) : (
                  <ExploreResultRow
                    repo={row.repo}
                    active={selected?.fullName === row.repo.fullName}
                    onSelect={onSelect}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {footer}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2 p-3">
      {["a", "b", "c", "d", "e", "f"].map((k) => (
        <Skeleton key={k} className="h-10 w-full" />
      ))}
    </div>
  );
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** The three not-connected / error branches, adapted from RepoBrowser: Bitbucket
 *  not configured, a missing CLI, or a generic (incl. rate-limit) failure. */
function ResultsError({
  provider,
  error,
}: {
  provider: ForgeProvider;
  error: unknown;
}) {
  const openSettings = useUiStore((s) => s.openSettings);
  const kind = isAppError(error) ? error.kind : "";
  const cliMissing = kind === "ghNotFound" || kind === "glabNotFound";
  const bbUnconfigured = kind === "bitbucketNotConfigured";
  const cli = provider === "gitlab" ? "GitLab CLI (glab)" : "GitHub CLI (gh)";
  const authCmd = provider === "gitlab" ? "glab auth login" : "gh auth login";

  if (bbUnconfigured) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-xs font-medium">Connect your Bitbucket account</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Add an Atlassian API token in Settings → Accounts to search your
          Bitbucket workspaces.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openSettings("accounts")}
        >
          Open Settings → Accounts
        </Button>
      </div>
    );
  }
  if (cliMissing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-xs font-medium">{cli} not found</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Install the {cli} and run {authCmd} to search repositories.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-xs font-medium">Couldn't load repositories</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {errorMessage(error)}
      </p>
    </div>
  );
}
