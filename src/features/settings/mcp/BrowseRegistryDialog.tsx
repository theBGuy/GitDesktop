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
import { normalizeHost } from "@/lib/ai/allowed-hosts";
import { clipTitleFromText } from "@/lib/clip-title";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { McpServer } from "@/lib/settings/api";
import { entriesFor, mcpHostGateReason } from "@/lib/settings/mcp";
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
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
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

  const { data: ghStats } = useQuery({
    queryKey: ["gh-repo-stats", repoRefs],
    queryFn: () => ghRepoStats(repoRefs),
    enabled: repoRefs.length > 0,
    staleTime: 5 * 60_000,
  });
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

  const errorMessage = isError
    ? error instanceof Error
      ? error.message
      : source === "github"
        ? "Couldn't search GitHub. Is the GitHub CLI signed in?"
        : "Couldn't reach the MCP registry."
    : null;

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
          onKeyDown={onListKeyDown}
          className="max-h-[55vh] min-h-40 space-y-2 overflow-y-auto px-1"
        >
          {isLoading ? (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner />{" "}
              {source === "github"
                ? "Searching GitHub…"
                : "Searching the registry…"}
            </p>
          ) : errorMessage ? (
            <div className="space-y-2 py-6 text-xs">
              <p className="text-muted-foreground">{errorMessage}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
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
                const gateReason = mcpHostGateReason(c.server, allowedHosts);
                // "Allow host" only fixes a gate that HAS a host to add: an
                // unparseable URL (the gate's fail-closed arm) has none, so it
                // gets no note and no pointer at one.
                const allowFixable =
                  gateReason !== null && normalizeHost(c.server.url) !== null;
                // Why Add is held, plus where the one-click fix lives.
                const addReason = !gateReason
                  ? null
                  : allowFixable
                    ? `${gateReason} Expand the row to allow it.`
                    : gateReason;
                return (
                  <div
                    key={c.registryName}
                    data-registry-row={c.registryName}
                    aria-label={`${c.title}, ${c.server.transport}${
                      disabled
                        ? isAdded
                          ? ", added"
                          : ", already in your registry"
                        : addReason
                          ? `. ${addReason}`
                          : ". Press Enter to add."
                    }`}
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
                    variant="ghost"
                    size="sm"
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                  >
                    {isFetchingNextPage && <Spinner data-icon="inline-start" />}
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
