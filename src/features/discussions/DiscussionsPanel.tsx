import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { LoadMoreRow, PAGE_SIZE } from "@/features/conversations/LoadMoreRow";
import { LabelChip } from "@/features/conversations/Thread";
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
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { CreateDiscussionDialog } from "./CreateDiscussionDialog";

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
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // How many discussions to load; "Load more" bumps it by PAGE_SIZE. A category
  // switch resets it so a filtered view starts from the first page again.
  const [limit, setLimit] = useState(PAGE_SIZE);
  const list = useDiscussionList(repoPath, listEnabled, categoryId, limit);
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
  const hasMore = discussions.length === limit;
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <DropdownMenu>
          {/* A trigger can't take the disabled-reason primitive — a `render`
              target can't carry its wrapper — so the reason rides a span around
              the trigger, whose own `disabled` keeps the button inert. */}
          <span
            className={cn("inline-flex", !listEnabled && "cursor-not-allowed")}
            title={
              listEnabled
                ? undefined
                : "Sign in to GitHub to browse discussions"
            }
          >
            <DropdownMenuTrigger
              disabled={!listEnabled}
              render={<Button variant="outline" size="xs" />}
            >
              {categoryLabel}
              <CaretDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
          </span>
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
          reason="Sign in to GitHub to start a discussion"
          title="New discussion"
          onClick={() => setCreateOpen(true)}
        >
          <PlusIcon data-icon="inline-start" />
          New
        </DisabledReasonButton>
      </div>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Search by title, #, author, or category"
          className="h-7"
          autoComplete="off"
        />
      </div>
      {/* overflow-hidden: the vendored ScrollArea Root is upstream-faithful
          (`relative` only), so without containment the list's natural height
          leaks into the document once it exceeds the viewport (a window
          scrollbar over a black void). The Viewport still scrolls internally. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div onKeyDown={onListKeyDown}>
          {gh.isPending ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-9 w-full" />
            </div>
          ) : !ghReady ? (
            <ForgeNotReady repoPath={repoPath} feature="discussions" />
          ) : !forgeSupports(gh.data, "discussions") ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Discussions aren't available on this repository's host.
            </p>
          ) : meta.isPending ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-9 w-full" />
            </div>
          ) : meta.isError ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Couldn't load discussions for this repository.
            </p>
          ) : !enabled ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Discussions aren't enabled for this repository.
            </p>
          ) : list.isPending ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {discussions.length > 0
                ? "No discussions match the filter."
                : activeCat
                  ? "No discussions in this category yet."
                  : "No discussions yet."}
            </p>
          ) : (
            visible.map((d) => {
              const active = selectedDiscussion?.number === d.number;
              return (
                <button
                  type="button"
                  key={d.number}
                  data-row={String(d.number)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
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
                      {d.isAnswered && (
                        <Badge variant="secondary">answered</Badge>
                      )}
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
                      {d.commentCount}{" "}
                      {d.commentCount === 1 ? "comment" : "comments"} ·{" "}
                      {formatRelativeTime(d.createdAt)}
                      {d.upvoteCount > 0 && (
                        <>
                          {" · "}
                          <span aria-hidden>▲ {d.upvoteCount}</span>
                          <span className="sr-only">
                            {d.upvoteCount}{" "}
                            {d.upvoteCount === 1 ? "upvote" : "upvotes"}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                </button>
              );
            })
          )}
          {listEnabled && !list.isPending && hasMore && (
            <LoadMoreRow
              count={discussions.length}
              loading={list.isFetching}
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
