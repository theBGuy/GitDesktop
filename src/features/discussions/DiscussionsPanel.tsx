import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import { LoadMoreRow, PAGE_SIZE } from "@/features/conversations/LoadMoreRow";
import {
  type ListNoticeCause,
  listNotice,
  offlinePendingMessage,
  refreshFailed,
  resolveRemoteSection,
} from "@/features/conversations/remote-section-state";
import { LabelChip } from "@/features/conversations/Thread";
import { useLoadMoreGuard } from "@/features/conversations/useLoadMoreGuard";
import { ScopeRefreshHint } from "@/features/repo-settings/ScopeRefreshHint";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import {
  forgeReady,
  forgeSupports,
  useDiscussionList,
  useDiscussionMeta,
  useForgeStatus,
  useHoverPrefetch,
  usePrefetchDiscussion,
} from "@/lib/git/queries";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { CreateDiscussionDialog } from "./CreateDiscussionDialog";

/** What the forge and meta probes draw in place of the list, ahead of it. */
type ProbeArm =
  | "skeleton"
  | "not-ready"
  | "unsupported"
  | "offline"
  | "error"
  | "disabled";

export function DiscussionsPanel({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  const ghReady = forgeReady(gh.data);
  // Discussions are a GitHub-only capability (GitLab has none) — gate the query on
  // it so a ready GitLab repo never fires the gh discussion calls, while the render
  // still shows the accurate "not available on this host" message below.
  const supportsDiscussions = forgeSupports(gh.data, "discussions");
  // Avatars resolve on the repo's host (github.com or an Enterprise server).
  const host = gh.data?.host ?? "github.com";
  const meta = useDiscussionMeta(repoPath, ghReady && supportsDiscussions);
  const enabled = meta.data?.hasDiscussionsEnabled ?? false;
  const listEnabled = ghReady && supportsDiscussions && enabled;
  // `listEnabled` folds four distinct states into one boolean; each control's
  // reason has to name the one that's actually true, in the same order the
  // body below checks them, or it reads as a permanent "sign in" hint even
  // for a GitLab host, a discussions-off repo, or a still-loading probe.
  // `meta` is gated on `ghReady && supportsDiscussions`, so its query stays
  // permanently "pending" while disabled — checking it before those two would
  // read every not-ready/unsupported state as "loading" instead. The sign-in
  // sentence is the only part that differs between callers (each names its
  // own action), so it's the one parameter.
  const discussionsDisabledReason = (signedOutReason: string) => {
    switch (true) {
      case gh.isPending:
        return "Loading discussions…";
      // A status probe that couldn't reach the host knows nothing about the
      // sign-in, so it must not read as a sign-in instruction.
      case gh.isError && gh.data === undefined:
        return "Couldn't reach this repository's host";
      case !ghReady:
        return signedOutReason;
      case !supportsDiscussions:
        return "Discussions aren't available on this repository's host";
      // A park outranks the failure it follows; a failure being refetched
      // still loads.
      case meta.isPaused && (meta.isPending || meta.isError):
        return offlinePendingMessage("discussions");
      case meta.isPending || (meta.isError && meta.isFetching):
        return "Loading discussions…";
      case meta.isError:
        return "Couldn't load discussions for this repository";
      default:
        return "Discussions aren't enabled for this repository";
    }
  };
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // How many discussions to load; "Load more" bumps it by PAGE_SIZE. A category
  // switch resets it so a filtered view starts from the first page again.
  const [requestedLimit, setLimit] = useState(PAGE_SIZE);
  // A failed "Load more" rolls the list back to the rows it had; `limit` is
  // the guarded one, so every reader below keys on what the list really shows.
  const more = useLoadMoreGuard({
    identity: `${repoPath}\n${categoryId ?? ""}`,
    limit: requestedLimit,
    setLimit,
  });
  const limit = more.limit;
  const list = useDiscussionList(repoPath, listEnabled, categoryId, limit);
  const loadMore = more.observe(list);
  const selectedDiscussion = useUiStore((s) => s.selectedDiscussion);
  const selectDiscussion = useUiStore((s) => s.selectDiscussion);
  const prefetch = usePrefetchDiscussion(repoPath);
  const hoverPrefetch = useHoverPrefetch();
  const [filterText, setFilterText] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const pendingCreate = useUiStore((s) => s.pendingCreate);
  const clearPendingCreate = useUiStore((s) => s.clearPendingCreate);

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());

  // Opened from the command palette / New menu via requestCreate (any tab).
  useEffect(() => {
    if (pendingCreate === "discussion") {
      setCreateOpen(true);
      clearPendingCreate();
    }
  }, [pendingCreate, clearPendingCreate]);

  // Switching category resets to the first page (a filtered view shouldn't
  // inherit an inflated limit from another category).
  const chooseCategory = (id: string | null) => {
    setCategoryId(id);
    setLimit(PAGE_SIZE);
  };

  const categories = meta.data?.categories ?? [];
  const activeCat = categories.find((c) => c.id === categoryId);
  const discussions = list.data ?? [];
  // More may exist server-side exactly when this page filled the requested
  // limit; compared against the raw loaded count, not the search-filtered view.
  // A grow in flight serves the previous page, shorter than the new limit, so
  // the row stays mounted and busy then, even while the read is parked.
  const hasMore = loadMore.growing || discussions.length === limit;
  const query = filterText.trim().toLowerCase();

  const visible = discussions.filter(
    (d) =>
      !query ||
      d.title.toLowerCase().includes(query) ||
      `#${d.number}`.includes(query) ||
      d.author.toLowerCase().includes(query) ||
      d.categoryName.toLowerCase().includes(query),
  );

  const categoryLabel = activeCat
    ? `${activeCat.emoji ? `${activeCat.emoji} ` : ""}${activeCat.name}`
    : "All categories";

  const navTargets = visible.map((d) => ({ number: d.number }));
  const onListKeyDown = listKeyboardNav({
    items: navTargets,
    activeIndex: navTargets.findIndex(
      (t) => t.number === selectedDiscussion?.number,
    ),
    onActivate: (t) => selectDiscussion(t),
    rowKey: (t) => String(t.number),
  });

  // The forge-status and discussions-meta probes both precede any list data, so
  // both render the same single-row placeholder.
  const probeSkeleton = (
    <ListRowSkeletons rows={1} lines={3} indent={false} name="discussions" />
  );

  // Refetching a disabled list would fire a read the meta probe hasn't cleared;
  // a recovered probe enables it on its own.
  const retry = () => {
    void meta.refetch();
    if (listEnabled) void list.refetch();
  };
  const offlineState = (
    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
      {offlinePendingMessage("discussions")}
    </p>
  );
  const emptyCopy = (() => {
    if (discussions.length > 0) return "No discussions match the filter.";
    if (activeCat) return "No discussions in this category yet.";
    return "No discussions yet.";
  })();

  const discussionRow = (d: (typeof visible)[number]) => {
    const active = selectedDiscussion?.number === d.number;
    return (
      <button
        type="button"
        key={d.number}
        data-row={String(d.number)}
        className={cn(
          "flex w-full items-start gap-2 border-b px-3 py-2 text-left",
          active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
        )}
        onClick={() => selectDiscussion({ number: d.number })}
        onMouseEnter={() => hoverPrefetch(() => prefetch(d.number))}
      >
        <Avatar size="sm" className="mt-0.5 shrink-0">
          <AvatarImage
            src={`https://${host}/${d.author}.png?size=48`}
            alt={d.author}
          />
          <AvatarFallback>
            {(d.author || "?").charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden className="shrink-0">
              {d.categoryEmoji || "💬"}
            </span>
            <span className="truncate" title={d.title}>
              {d.title}
            </span>
            {d.isAnswered && <Badge variant="secondary">answered</Badge>}
          </p>
          {d.labels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {d.labels.map((l) => (
                <LabelChip key={l.name} label={l} />
              ))}
            </div>
          )}
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            #{d.number} · {d.author || "unknown"} · {d.categoryName}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {d.commentCount} {d.commentCount === 1 ? "comment" : "comments"}
            {parseableDate(d.createdAt) && (
              <>
                {" · "}
                <RelativeTime date={d.createdAt} />
              </>
            )}
            {d.upvoteCount > 0 && (
              <>
                {" · "}
                <span aria-hidden>▲ {d.upvoteCount}</span>
                <span className="sr-only">
                  {d.upvoteCount} {d.upvoteCount === 1 ? "upvote" : "upvotes"}
                </span>
              </>
            )}
          </p>
        </div>
      </button>
    );
  };

  // A failed meta or list read replaces the list only when no rows are drawn:
  // react-query keeps the last good data beside `isError`, and those rows stay
  // on screen under the degraded notice instead. Past a failed probe, `enabled`
  // is the last KNOWN answer, so it can't stand in for "turned off". A probe
  // failure being refetched has settled nothing, so it falls to the list
  // ladder, which loads.
  const probeArm = ((): ProbeArm | null => {
    switch (true) {
      case gh.isPending:
        return "skeleton";
      case !ghReady:
        return "not-ready";
      case !supportsDiscussions:
        return "unsupported";
      case meta.isPending:
        return meta.isPaused ? "offline" : "skeleton";
      // A parked probe outranks its earlier failure, as in the list ladder:
      // the Retry would only park again.
      case meta.isError && meta.isPaused && visible.length === 0:
        return "offline";
      case refreshFailed(meta) && visible.length === 0:
        return "error";
      case !meta.isError && !enabled:
        return "disabled";
      default:
        return null;
    }
  })();
  const listState =
    probeArm === null
      ? resolveRemoteSection({
          ghPending: false,
          ghReady: true,
          listPending: list.isPending,
          error: meta.isError || list.isError,
          rowCount: visible.length,
          // The meta probe's error feeds `error`, so its park must count too.
          paused: meta.isPaused || list.isPaused,
          // Unsettled only while EVERY errored read is refetching: one still
          // settled on its failure keeps the notice.
          fetching:
            (!meta.isError || meta.isFetching) &&
            (!list.isError || list.isFetching),
        })
      : null;
  // Every Retry here (ForgeNotReady's, the probe's and the list's error card)
  // resets a never-loaded read to pending, swapping its card for skeletons.
  // Keyed on the card being mounted, a superset of ForgeNotReady's Retry.
  const rescue = useRetryFocusRescue(
    probeArm === "not-ready" || probeArm === "error" || listState === "error",
  );
  const errorState = (copy: string) => (
    <div className="space-y-2 px-3 py-6 text-center text-xs text-muted-foreground">
      <p>{copy}</p>
      <Button
        ref={rescue.retryRef}
        variant="outline"
        size="sm"
        className="cursor-pointer"
        onClick={retry}
      >
        Retry
      </Button>
    </div>
  );
  const probeContent = ((): ReactElement | undefined => {
    switch (probeArm) {
      case "skeleton":
        return probeSkeleton;
      case "not-ready":
        return (
          <ForgeNotReady
            repoPath={repoPath}
            feature="discussions"
            retryRef={rescue.retryRef}
          />
        );
      case "unsupported":
        return (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Discussions aren't available on this repository's host.
          </p>
        );
      case "offline":
        return offlineState;
      case "error":
        return errorState("Couldn't load discussions for this repository.");
      case "disabled":
        return (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Discussions aren't enabled for this repository.
          </p>
        );
      case null:
        return undefined;
    }
  })();
  const listContent = ((): ReactNode => {
    if (probeContent !== undefined) return probeContent;
    switch (listState) {
      case "offline":
        return offlineState;
      case "error":
        return errorState("Couldn't load discussions.");
      case "empty":
        return (
          <p className="px-3 py-4 text-xs text-muted-foreground">{emptyCopy}</p>
        );
      case "rows":
      case "rows-degraded":
      case "rows-offline":
        return visible.map(discussionRow);
      default:
        return (
          <ListRowSkeletons
            rows={3}
            lines={3}
            indent={false}
            name="discussions"
          />
        );
    }
  })();

  const notice = listNotice({
    noun: "discussions",
    failed: listState === "rows-degraded",
    offline: listState === "rows-offline",
    // A category switch shows the previous category's rows as placeholder.
    placeholder: list.isPlaceholderData && !loadMore.growing,
    hasRows: true,
    loadMoreFailed: loadMore.loadMoreFailed,
  });
  // Offline mounts no Retry: a retry while offline parks again at once, and
  // reconnecting resumes the read by itself.
  const noticeRetry: Record<ListNoticeCause, (() => void) | undefined> = {
    refresh: retry,
    "load-more": loadMore.retryLoadMore,
    offline: undefined,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <DisabledReasonButton
                variant="outline"
                size="xs"
                disabled={!listEnabled}
                reason={
                  listEnabled
                    ? undefined
                    : discussionsDisabledReason(
                        "Sign in to GitHub to browse discussions",
                      )
                }
              />
            }
          >
            {categoryLabel}
            <CaretDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuItem
              onClick={() => chooseCategory(null)}
              className={cn(
                categoryId === null && "bg-accent text-accent-foreground",
              )}
            >
              All categories
            </DropdownMenuItem>
            {categories.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onClick={() => chooseCategory(c.id)}
                className={cn(
                  categoryId === c.id && "bg-accent text-accent-foreground",
                )}
              >
                {c.emoji ? `${c.emoji} ` : ""}
                {c.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DisabledReasonButton
          variant="ghost"
          size="xs"
          wrapperClassName="ml-auto"
          disabled={!listEnabled}
          reason={
            listEnabled
              ? undefined
              : discussionsDisabledReason(
                  "Sign in to GitHub to start a discussion",
                )
          }
          title="New discussion"
          onClick={() => setCreateOpen(true)}
        >
          <PlusIcon data-icon="inline-start" />
          New
        </DisabledReasonButton>
      </div>
      <div className="space-y-2 border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Search by title, #, author, or category"
          className="h-7"
          autoComplete="off"
        />
        {listEnabled && (
          <ScopeRefreshHint
            scope="write:discussion"
            action="Writing in discussions"
            coveredBy={["repo"]}
          />
        )}
      </div>
      {/* overflow-hidden: the vendored ScrollArea Root is upstream-faithful
          (`relative` only), so without containment the list's natural height
          leaks into the document once it exceeds the viewport (a window
          scrollbar over a black void). The Viewport still scrolls internally. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div
          // The host every arm below swaps inside, so a Retry's focus lands
          // here, where the arrow keys still reach the list's nav.
          ref={rescue.hostRef}
          tabIndex={-1}
          className="outline-none"
          onKeyDown={onListKeyDown}
        >
          <DegradedListNotice
            noun="discussions"
            degraded={notice !== null}
            message={notice?.message}
            retryLabel={notice?.retryLabel}
            onRetry={notice ? noticeRetry[notice.cause] : undefined}
            className="pt-2"
          />
          {listContent}
          {listEnabled && !list.isPending && hasMore && (
            <LoadMoreRow
              count={discussions.length}
              loading={list.isFetching || loadMore.growing}
              onLoadMore={() => setLimit((n) => n + PAGE_SIZE)}
            />
          )}
        </div>
      </ScrollArea>

      <CreateDiscussionDialog
        repoPath={repoPath}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
