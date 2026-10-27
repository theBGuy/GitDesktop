import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  CheckIcon,
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  refreshFailed,
  splitInfiniteFailure,
} from "@/features/conversations/remote-section-state";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { isAuthError, rateLimitClause } from "@/lib/forge-backoff";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { McpServer } from "@/lib/settings/api";
import {
  entriesFor,
  mcpHostAllowFixable,
  mcpHostGateReason,
} from "@/lib/settings/mcp";
import {
  ghRepoStats,
  npmWeeklyDownloadsBatch,
  type RegistryCandidate,
  type RepoStat,
  repoKey,
  searchGithub,
  searchRegistry,
  uniqueServerName,
} from "@/lib/settings/mcp-registry";
import { formatRelativeTime, parseableDate } from "@/lib/time";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { ARIA_DISABLED_CLASS } from "@/lib/use-disabled-reason";
import { useLatestRef } from "@/lib/use-latest-ref";
import { HostAllowNote } from "../HostAllowNote";

/** Compact number for stars/installs (87729 → "87.7K"). */
const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** A one-line summary of what a server will run (stdio) or connect to (http) —
 *  the honest "what can this do" view shown in a result's expanded detail. */
function runSummary(server: McpServer): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].join(" ").trim()
    : server.url;
}

/**
 * Browse and add servers from the public MCP registry
 * (registry.modelcontextprotocol.io). Search is debounced; a chosen server is
 * appended to the managed registry **disabled** (the dialog stays open so you
 * can add several), so you review what it runs, fill any secret, and enable it
 * deliberately. Nothing is fetched-and-run automatically — this is discovery.
 */
export function BrowseRegistryDialog({
  existing,
  allowedHosts,
  onAllowHost,
  onAdd,
  onClose,
}: {
  existing: McpServer[];
  /** The draft AI allow list. An http candidate whose host isn't on it can't be
   *  added until the host is allowed (the registration gate). */
  allowedHosts: string[];
  /** Add a URL's host to the draft allow list — the one-click fix in a gated
   *  row's expanded detail. Mutates the draft settings, not persisted ones. */
  onAllowHost: (url: string) => void;
  onAdd: (server: McpServer) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"registry" | "github">("registry");
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 300);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The meta line is assembled as one joined string, so the shared clock has to
  // be threaded in by hand — `<RelativeTime>` can't render inside it.
  const now = useRelativeNow();
  // Registry names added this session — flips their row to "Added".
  const [added, setAdded] = useState<Set<string>>(new Set());
  // Server names already in the managed registry when the dialog opened, shown
  // as "In registry". A snapshot, so adding here doesn't reclassify other rows.
  const [initialNames] = useState(
    () => new Set(existing.map((s) => s.name.trim().toLowerCase())),
  );
  // Read the live list through a ref for name-uniqueness on add, without making
  // anything else depend on it (which would re-render the search results).
  const existingRef = useLatestRef(existing);

  // Cursor-paginated registry search. TanStack Query owns abort (via signal),
  // caching, retry, and next-page fetching, keyed on the debounced query.
  const search = useInfiniteQuery({
    queryKey: ["mcp-browse", source, debounced],
    queryFn: ({ pageParam, signal }) =>
      source === "github"
        ? searchGithub({ search: debounced, cursor: pageParam ?? undefined })
        : searchRegistry({
            search: debounced,
            cursor: pageParam ?? undefined,
            limit: 30,
            signal,
          }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const {
    data,
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = search;

  // Flatten pages and de-dupe by registry name (different versions can recur).
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: RegistryCandidate[] = [];
    for (const page of data?.pages ?? [])
      for (const c of page.candidates)
        if (!seen.has(c.registryName)) {
          seen.add(c.registryName);
          out.push(c);
        }
    return out;
  }, [data]);

  // Validation signals fetched alongside the results, each best-effort so the
  // list never blocks on (or breaks from) them. GitHub stars/activity come from
  // one batched gh call; npm installs from the downloads API. Keys are the value
  // lists, so they re-fetch only when a new page adds repos/packages.
  const repoRefs = useMemo(() => {
    const set = new Set<string>();
    for (const c of candidates)
      if (c.repo) set.add(`${c.repo.owner}/${c.repo.name}`);
    return [...set];
  }, [candidates]);
  const npmPkgs = useMemo(() => {
    const set = new Set<string>();
    for (const c of candidates) if (c.npmPackage) set.add(c.npmPackage);
    return [...set];
  }, [candidates]);

  const stats = useQuery({
    queryKey: ["gh-repo-stats", repoRefs],
    queryFn: () => ghRepoStats(repoRefs),
    enabled: repoRefs.length > 0,
    staleTime: 5 * 60_000,
  });
  const ghStats = stats.data;
  // Rows stay addable without their details, so the failure is one line under
  // the results rather than a mark on every row.
  const statsFailed = stats.data === undefined && refreshFailed(stats);
  const statsLimitClause = rateLimitClause(stats.error);
  const { data: npmInstalls } = useQuery({
    queryKey: ["npm-installs", npmPkgs],
    queryFn: () => npmWeeklyDownloadsBatch(npmPkgs),
    enabled: npmPkgs.length > 0,
    staleTime: 5 * 60_000,
  });
  const statByRepo = useMemo(() => {
    const map = new Map<string, RepoStat>();
    for (const s of ghStats ?? []) map.set(s.nameWithOwner.toLowerCase(), s);
    return map;
  }, [ghStats]);

  // Which rows have their validation detail expanded (by registry name).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Reset roving focus when the query/source changes the result set under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on new search
  useEffect(() => setActiveIndex(-1), [debounced, source]);

  function add(c: RegistryCandidate) {
    // Fire-time re-check of the registration gate — the row's Add is already
    // held, and Enter on the row routes here too.
    if (mcpHostGateReason(c.server, allowedHosts)) return;
    const taken = new Set(
      existingRef.current.map((s) => s.name.trim().toLowerCase()),
    );
    const name = uniqueServerName(c.server.name, taken);
    onAdd({ ...c.server, id: crypto.randomUUID(), name });
    setAdded((prev) => new Set(prev).add(c.registryName));
    toast.success(`Added "${name}" — review and enable it`);
  }

  // Only a search with nothing loaded swaps the results for its error; a failed
  // Load more or refresh keeps the rows under the notice below them.
  const searchFailed = search.isError && data === undefined;
  const searchError = (() => {
    if (!searchFailed) return null;
    if (source === "registry")
      return {
        title: null,
        detail:
          error instanceof Error
            ? error.message
            : "Couldn't reach the MCP registry.",
        retryLabel: "Retry searching the MCP registry",
      };
    const summary = presentError(error).summary;
    return {
      title: "Couldn't search GitHub.",
      detail: isAuthError(error)
        ? `${summary} Is the GitHub CLI signed in?`
        : summary,
      retryLabel: "Retry searching GitHub",
    };
  })();
  const searchAnnouncement =
    searchError === null
      ? ""
      : [searchError.title, searchError.detail].filter(Boolean).join(" ");
  const listFailure = splitInfiniteFailure(search);
  const listNoticeMessage = (() => {
    if (data === undefined) return undefined;
    if (listFailure.loadMoreFailed)
      return `Couldn't load more results. ${presentError(error).summary}`;
    if (listFailure.failed)
      return `Couldn't refresh the results — showing the last loaded ones. ${presentError(error).summary}`;
    return undefined;
  })();
  const rowsShown = !isLoading && !searchFailed && candidates.length > 0;
  // Each button unmounts under its own press (a refetch from nothing loads; a
  // Load more of the last page ends the list), so focus lands on the box.
  const searchRescue = useRetryFocusRescue(searchError !== null);
  const loadMoreRescue = useRetryFocusRescue(rowsShown && hasNextPage);

  // Clamp a stale active index after the result set shrinks (search/retry).
  const safeActive =
    activeIndex >= candidates.length ? candidates.length - 1 : activeIndex;
  const onListKeyDown = listKeyboardNav<RegistryCandidate>({
    items: candidates,
    activeIndex: safeActive,
    onActivate: (_c, to) => setActiveIndex(to),
    rowKey: (c) => c.registryName,
    rowAttr: "data-registry-row",
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Browse MCP servers</DialogTitle>
          <DialogDescription>
            {source === "github" ? (
              <>
                MCP-server repositories on GitHub, ranked by stars. Rougher than
                the registry — some need manual setup after adding.
              </>
            ) : (
              <>
                Public servers from the official Model Context Protocol
                registry.
              </>
            )}{" "}
            Added servers start{" "}
            <strong className="font-medium">disabled</strong> — review what each
            one runs, add any secret, then enable it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1">
          {(
            [
              ["registry", "Official registry"],
              ["github", "GitHub"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={source === value ? "default" : "outline"}
              aria-pressed={source === value}
              className="flex-1"
              onClick={() => setSource(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              source === "github"
                ? "Search GitHub MCP repos…"
                : "Search servers…"
            }
            className="pl-8"
            spellCheck={false}
          />
        </div>

        <div
          ref={(node) => {
            searchRescue.hostRef(node);
            loadMoreRescue.hostRef(node);
          }}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          className="max-h-[55vh] min-h-40 space-y-2 overflow-y-auto px-1 outline-none"
        >
          {/* First, so space-y's end margins skip it. Pre-mounted: a live
              region created together with its text announces unreliably. */}
          <div role="status" className="sr-only">
            {searchAnnouncement}
          </div>
          {isLoading ? (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner />{" "}
              {source === "github"
                ? "Searching GitHub…"
                : "Searching the registry…"}
            </p>
          ) : searchError ? (
            <div className="space-y-2 py-6 text-xs">
              <div className="space-y-0.5">
                {searchError.title && (
                  <p className="font-medium">{searchError.title}</p>
                )}
                <p className="text-muted-foreground">{searchError.detail}</p>
              </div>
              <Button
                ref={searchRescue.retryRef}
                variant="outline"
                size="sm"
                aria-label={searchError.retryLabel}
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-xs text-muted-foreground">
              {debounced
                ? `No ${source === "github" ? "repositories" : "servers"} match “${debounced}”.`
                : "No results found."}
            </p>
          ) : (
            <>
              {candidates.map((c, i) => {
                const isAdded = added.has(c.registryName);
                const inRegistry = initialNames.has(
                  c.server.name.toLowerCase(),
                );
                const disabled = isAdded || inRegistry;
                const repo = c.repo;
                const stat = repo
                  ? statByRepo.get(repoKey(repo.owner, repo.name))
                  : undefined;
                const installs = c.npmPackage
                  ? npmInstalls?.[c.npmPackage]
                  : undefined;
                const deprecated = c.status !== "active";
                const isOpen = expanded.has(c.registryName);
                const entries = entriesFor(c.server);
                const secretSet = new Set(c.server.secretKeys);
                // Gate UI belongs only to rows still offering Add: an added or
                // already-registered row has no action to hold, and the registry
                // list's own warn-only badge is what covers those.
                const gateReason = disabled
                  ? null
                  : mcpHostGateReason(c.server, allowedHosts);
                const allowFixable =
                  !disabled && mcpHostAllowFixable(c.server, allowedHosts);
                // Why Add is held, plus where the one-click fix lives — pointed
                // at the row's detail only when a fix actually waits there.
                const addReason = ((): string | null => {
                  switch (true) {
                    case !gateReason:
                      return null;
                    case allowFixable:
                      return `${gateReason} Expand the row to allow it.`;
                    default:
                      return gateReason;
                  }
                })();
                // What the row announces after its title and transport, ranked:
                // what it already is, then why Add is held, then the affordance.
                const rowStatus = ((): string => {
                  switch (true) {
                    case isAdded:
                      return ", added";
                    case inRegistry:
                      return ", already in your registry";
                    case !!addReason:
                      return `. ${addReason}`;
                    default:
                      return ". Press Enter to add.";
                  }
                })();
                return (
                  <div
                    key={c.registryName}
                    data-registry-row={c.registryName}
                    aria-label={`${c.title}, ${c.server.transport}${rowStatus}`}
                    tabIndex={
                      i === safeActive || (safeActive === -1 && i === 0)
                        ? 0
                        : -1
                    }
                    onFocus={() => setActiveIndex(i)}
                    onKeyDown={(e) => {
                      // Only the row itself adds on Enter — not its child controls.
                      if (
                        e.key === "Enter" &&
                        e.target === e.currentTarget &&
                        !disabled &&
                        !addReason
                      ) {
                        e.preventDefault();
                        add(c);
                      }
                    }}
                    className="flex items-start gap-1.5 rounded-md border p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mt-0.5 shrink-0"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "Hide details" : "Show details"}
                      onClick={() => toggleExpanded(c.registryName)}
                    >
                      <CaretRightIcon
                        className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                    </Button>

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="truncate font-medium"
                          onMouseEnter={clipTitleFromText}
                        >
                          {c.title}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground uppercase">
                          {c.server.transport}
                        </span>
                        {deprecated && (
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-warning uppercase">
                            {c.status}
                          </span>
                        )}
                        {c.needsSetup && (
                          <span className="shrink-0 text-[10px] text-warning">
                            needs setup
                          </span>
                        )}
                        {(stat || installs != null) && (
                          <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                            {stat && (
                              <span
                                className="flex items-center gap-0.5"
                                title={`${stat.stars.toLocaleString()} stars`}
                              >
                                <StarIcon weight="fill" />
                                {compactNumber.format(stat.stars)}
                              </span>
                            )}
                            {installs != null && (
                              <span
                                className="flex items-center gap-0.5"
                                title={`${installs.toLocaleString()} npm downloads last week`}
                              >
                                <DownloadSimpleIcon />
                                {compactNumber.format(installs)}/wk
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <p
                        className="truncate font-mono text-[10px] text-muted-foreground"
                        onMouseEnter={clipTitleFromText}
                      >
                        {c.registryName}
                      </p>
                      {c.server.description && (
                        <p
                          className="line-clamp-2 text-muted-foreground"
                          onMouseEnter={clipTitleFromText}
                        >
                          {c.server.description}
                        </p>
                      )}

                      {isOpen && (
                        <div className="mt-1.5 space-y-1 rounded bg-muted/40 p-2 text-[10px] leading-relaxed">
                          {c.server.transport === "stdio" &&
                          !c.server.command ? (
                            <div className="text-muted-foreground">
                              No manifest found — you'll set the command after
                              adding.
                            </div>
                          ) : (
                            <div>
                              <span className="font-medium">
                                {c.server.transport === "stdio"
                                  ? "Runs locally"
                                  : "Connects to"}
                                :{" "}
                              </span>
                              <span className="font-mono break-all">
                                {runSummary(c.server)}
                              </span>
                            </div>
                          )}
                          {entries.length > 0 && (
                            <div>
                              <span className="font-medium">
                                {c.server.transport === "stdio"
                                  ? "Environment"
                                  : "Headers"}
                                :{" "}
                              </span>
                              {entries.map((e, idx) => (
                                <span key={e.key}>
                                  {idx > 0 && ", "}
                                  <span className="font-mono">{e.key}</span>
                                  {secretSet.has(e.key) && (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      (secret)
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                          {(stat || c.publishedAt) && (
                            <div className="text-muted-foreground">
                              {[
                                stat?.license,
                                stat
                                  ? `${compactNumber.format(stat.forks)} forks`
                                  : null,
                                stat?.pushedAt && parseableDate(stat.pushedAt)
                                  ? `updated ${formatRelativeTime(stat.pushedAt, now)}`
                                  : c.publishedAt &&
                                      parseableDate(c.publishedAt)
                                    ? `published ${formatRelativeTime(c.publishedAt, now)}`
                                    : null,
                                stat?.archived ? "archived" : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          )}
                          {repo && (
                            <button
                              type="button"
                              onClick={() => openUrl(repo.url)}
                              className="inline-flex cursor-pointer items-center gap-1 text-primary hover:underline"
                            >
                              View on GitHub
                              <ArrowSquareOutIcon />
                            </button>
                          )}
                          {allowFixable ? (
                            <HostAllowNote
                              url={c.server.url}
                              allowedHosts={allowedHosts}
                              onAllowHost={onAllowHost}
                              defaultNote={null}
                              consequence="the agent CLI connects outside GitDesktop's AI allowlist, so allow it before adding."
                            />
                          ) : null}
                        </div>
                      )}
                    </div>

                    {isAdded ? (
                      <span className="flex shrink-0 items-center gap-1 self-start text-[11px] text-success">
                        <CheckIcon weight="bold" /> Added
                      </span>
                    ) : inRegistry ? (
                      <span className="shrink-0 self-start text-[10px] text-muted-foreground">
                        In registry
                      </span>
                    ) : (
                      <DisabledReasonButton
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={!!addReason}
                        reason={addReason}
                        onClick={() => add(c)}
                      >
                        <PlusIcon data-icon="inline-start" /> Add
                      </DisabledReasonButton>
                    )}
                  </div>
                );
              })}
              {hasNextPage && (
                <div className="flex justify-center py-1">
                  <Button
                    ref={loadMoreRescue.retryRef}
                    variant="ghost"
                    size="sm"
                    className={ARIA_DISABLED_CLASS}
                    onClick={() => fetchNextPage()}
                    // Focusable while busy, so a press never drops focus to
                    // <body>.
                    disabled={isFetchingNextPage}
                    focusableWhenDisabled
                  >
                    {isFetchingNextPage && <Spinner data-icon="inline-start" />}
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Outside the results box, so it covers a loaded empty result too and
            its healthy sr-only wrapper adds no end margin to the list. */}
        <DegradedListNotice
          noun="more results"
          degraded={listNoticeMessage !== undefined}
          message={listNoticeMessage}
          retryLabel={
            listFailure.loadMoreFailed
              ? "Retry loading more results"
              : "Retry loading the results"
          }
          onRetry={
            listFailure.loadMoreFailed
              ? () => void fetchNextPage()
              : () => void refetch()
          }
          className="px-0 pb-0"
        />

        <DegradedListNotice
          noun="repository details"
          degraded={statsFailed}
          message={
            statsLimitClause === ""
              ? "Couldn't load star counts, licenses and archived status."
              : `Star counts, licenses and archived status aren't shown${statsLimitClause}.`
          }
          onRetry={() => void stats.refetch()}
          className="px-0 pb-0"
        />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
