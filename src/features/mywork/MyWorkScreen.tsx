import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CircleDashedIcon,
  GitPullRequestIcon,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clipTitleFromText } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { useMyWork } from "@/lib/git/queries";
import type { MyWorkItem } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage, isAppError } from "@/lib/tauri/invoke";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  filterMyWork,
  MY_WORK_LIMIT,
  MY_WORK_LISTBOX_ID,
  type MyWorkTab,
  matchLocalRepo,
  myWorkOptionId,
  sortMyWork,
} from "./mywork-utils";

/** Stable empty default, so a settings read that hasn't landed doesn't hand a
 *  fresh array to every render. */
const NO_RECENTS: RecentRepo[] = [];

/**
 * The cross-repo work inbox — every open GitHub pull request and issue
 * involving you, newest first, without switching repositories to find them.
 * Read-only: Enter (or a click) navigates, to the repo when it's cloned locally
 * and to the browser when it isn't. Palette-reachable and launched from the
 * Welcome screen; Back / Esc return to the previous view.
 */
export function MyWorkScreen() {
  const closeMyWork = useUiStore((s) => s.closeMyWork);
  const openPr = useUiStore((s) => s.openPr);
  const openIssue = useUiStore((s) => s.openIssue);
  const [tab, setTab] = useState<MyWorkTab>("all");
  const [filter, setFilter] = useState("");
  // The active row is tracked by URL (unique per item) rather than by index, so
  // a filter change can't silently retarget the selection to a different item.
  const [activeUrl, setActiveUrl] = useState<string | null>(null);

  // GitHub-only in this slice: the backend refuses the other providers outright,
  // so there is no provider axis to offer.
  const work = useMyWork("github", true);
  const settings = useSettings();
  const recents = settings.data?.recentRepos ?? NO_RECENTS;

  const items = sortMyWork(work.data ?? []);
  const prCount = items.filter((i) => i.isPullRequest).length;
  const visible = filterMyWork(items, tab, filter);
  // Derived, never stored: a row the filter has hidden simply stops being
  // active, and arrow keys restart from the ends of the new visible set.
  const activeIndex = visible.findIndex((i) => i.url === activeUrl);
  const activeId =
    activeIndex >= 0 ? myWorkOptionId(visible[activeIndex].url) : undefined;

  // Esc closes the inbox. Guarded so Base UI popups (which mark the event
  // consumed) get first claim; an effect event reads the latest closeMyWork.
  const onEscape = useEffectEvent(() => closeMyWork());
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onEscape();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Every navigation goes through an atomic navigator: an openRepo followed by a
  // select would pair the new repo with the old selection, because the
  // view-transition callback that carries the selection is deferred.
  function openItem(item: MyWorkItem) {
    const match = matchLocalRepo(item, recents);
    if (!match) {
      openUrl(item.url);
      return;
    }
    if (item.isPullRequest) {
      openPr({
        kind: "remote",
        repoPath: match.path,
        repoName: match.name,
        ref: String(item.number),
        section: null,
      });
    } else {
      openIssue({
        repoPath: match.path,
        repoName: match.name,
        number: item.number,
      });
    }
  }

  // Arrow keys from the filter input move the selection through the visible
  // rows and Enter opens it, so a keyboard user goes type → arrows → Enter
  // without ever leaving the input.
  const onInputArrow = listKeyboardNav({
    items: visible,
    activeIndex,
    onActivate: (item) => setActiveUrl(item.url),
  });
  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const item = visible[activeIndex];
      if (!item) return;
      e.preventDefault();
      openItem(item);
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
          onClick={closeMyWork}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="text-sm font-medium">My work</span>
        {work.isSuccess && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {items.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh"
          title="Refresh"
          disabled={work.isFetching}
          onClick={() => work.refetch()}
        >
          {work.isFetching ? <Spinner /> : <ArrowsClockwiseIcon />}
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as MyWorkTab)}>
          <TabsList>
            <TabsTrigger value="all">
              All
              <Count n={items.length} />
            </TabsTrigger>
            <TabsTrigger value="prs">
              Pull requests
              <Count n={prCount} />
            </TabsTrigger>
            <TabsTrigger value="issues">
              Issues
              <Count n={items.length - prCount} />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Filter by title, repository, or number"
          aria-label="Filter your work"
          role="combobox"
          aria-expanded={visible.length > 0}
          aria-controls={MY_WORK_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          className="h-8 min-w-40 flex-1"
        />
      </div>

      <MyWorkBody
        work={work}
        items={items}
        visible={visible}
        activeIndex={activeIndex}
        recents={recents}
        onSelect={setActiveUrl}
        onOpen={openItem}
      />
    </div>
  );
}

/** The body's state machine: loading → error → empty → filtered-empty → list.
 *  Split from the shell so the virtualizer below only ever mounts with rows. */
function MyWorkBody({
  work,
  items,
  visible,
  activeIndex,
  recents,
  onSelect,
  onOpen,
}: {
  work: ReturnType<typeof useMyWork>;
  items: MyWorkItem[];
  visible: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  onSelect: (url: string) => void;
  onOpen: (item: MyWorkItem) => void;
}) {
  if (work.isPending) {
    return <ListRowSkeletons rows={8} lines={1} name="your work" />;
  }
  if (work.isError) {
    return <MyWorkError error={work.error} onRetry={() => work.refetch()} />;
  }
  if (items.length === 0) {
    return (
      <QuietLine>
        Nothing on GitHub involves you right now. This searches every repo
        you're involved in, not just local ones.
      </QuietLine>
    );
  }
  if (visible.length === 0) {
    return <QuietLine>No items match.</QuietLine>;
  }
  return (
    <MyWorkList
      items={visible}
      activeIndex={activeIndex}
      recents={recents}
      onSelect={onSelect}
      onOpen={onOpen}
      // A heuristic, not a count: the backend drops unaddressable hits, so a
      // truncated page that lost one arrives short and reads as uncapped. It
      // errs only toward staying quiet, which is why the note states the
      // constraint rather than a number.
      capped={items.length >= MY_WORK_LIMIT}
    />
  );
}

/** The virtualized row list, plus one shared context menu for the whole list
 *  (capture phase records the row before the menu opens). */
function MyWorkList({
  items,
  activeIndex,
  recents,
  onSelect,
  onOpen,
  capped,
}: {
  items: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  onSelect: (url: string) => void;
  onOpen: (item: MyWorkItem) => void;
  capped: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [menuItem, setMenuItem] = useState<MyWorkItem | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 33,
    overscan: 12,
  });

  // Keep the keyboard-selected row in view. Keyed on the selection alone: a
  // re-scroll on any list change would fight the user's own scrolling on every
  // unrelated re-render (the shared clock ticks these rows every 30s).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection moves
  useEffect(() => {
    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    }
  }, [activeIndex]);

  // A right-click on blank space hits no row — suppress the menu rather than
  // show an empty popup.
  function onContextMenu(e: ReactMouseEvent) {
    const url = (e.target as HTMLElement)
      .closest("[data-my-work-url]")
      ?.getAttribute("data-my-work-url");
    const item = url ? items.find((i) => i.url === url) : undefined;
    if (item) {
      setMenuItem(item);
    } else {
      setMenuItem(null);
      suppressContextMenu(e);
    }
  }

  const activeUrl = activeIndex >= 0 ? items[activeIndex].url : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContextMenu>
        {/* The scroll element keeps its own ref rather than riding the Trigger's
            render prop — the virtualizer needs that node, and a merged-ref miss
            would leave the list unmeasured and blank. */}
        <ContextMenuTrigger
          render={
            <div
              onContextMenuCapture={onContextMenu}
              className="flex min-h-0 flex-1 flex-col"
            />
          }
        >
          {/* Arrow-key navigation lives on the filter Input (combobox pattern),
              so the listbox itself is not a Tab stop — a pure a11y container. */}
          <div
            ref={parentRef}
            className="min-h-0 flex-1 overflow-y-auto"
            role="listbox"
            id={MY_WORK_LISTBOX_ID}
            aria-label="Your work"
            aria-activedescendant={
              activeUrl ? myWorkOptionId(activeUrl) : undefined
            }
          >
            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((v) => {
                const item = items[v.index];
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    // Presentation wrapper so the virtualizer's positioning div
                    // doesn't sit between the listbox and its options.
                    role="presentation"
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <MyWorkRow
                      item={item}
                      local={matchLocalRepo(item, recents) !== null}
                      active={v.index === activeIndex}
                      onSelect={onSelect}
                      onOpen={onOpen}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          {menuItem && (
            <>
              <ContextMenuItem onClick={() => openUrl(menuItem.url)}>
                Open on GitHub
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => copyText(menuItem.url, "Link copied")}
              >
                Copy link
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {capped && (
        <p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
          This view fetches one page of results. Filter to narrow the list.
        </p>
      )}
    </div>
  );
}

/** One inbox row — a `role="option"` in the listbox. Single line: type glyph,
 *  number, title, repository, and when it last moved. */
function MyWorkRow({
  item,
  local,
  active,
  onSelect,
  onOpen,
}: {
  item: MyWorkItem;
  local: boolean;
  active: boolean;
  onSelect: (url: string) => void;
  onOpen: (item: MyWorkItem) => void;
}) {
  const Icon = item.isPullRequest ? GitPullRequestIcon : CircleDashedIcon;
  const typeLabel = item.isPullRequest ? "Pull request" : "Issue";
  const browserLabel = `Opens on ${item.host || "GitHub"} — not a local repository`;
  return (
    <button
      type="button"
      id={myWorkOptionId(item.url)}
      data-my-work-url={item.url}
      role="option"
      aria-selected={active}
      onClick={() => {
        onSelect(item.url);
        onOpen(item);
      }}
      className={cn(
        "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      {/* role="img" prunes the glyph's own markup, so the label is what carries
          the PR-vs-issue distinction to readers — never the shape alone. */}
      <span
        role="img"
        aria-label={typeLabel}
        title={typeLabel}
        className="flex shrink-0 items-center text-muted-foreground"
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        #{item.number}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        onMouseEnter={clipTitleFromText}
      >
        {item.title}
      </span>
      <span
        className="max-w-56 shrink-0 truncate text-muted-foreground"
        onMouseEnter={clipTitleFromText}
      >
        {item.repoFullName}
      </span>
      {!local && (
        <span
          role="img"
          aria-label={browserLabel}
          title={browserLabel}
          className="flex shrink-0 items-center text-muted-foreground"
        >
          <ArrowSquareOutIcon className="size-3" aria-hidden />
        </span>
      )}
      {parseableDate(item.updatedAt) && (
        <span className="shrink-0 text-muted-foreground">
          <RelativeTime date={item.updatedAt} />
        </span>
      )}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      <span className="max-w-sm">{children}</span>
    </p>
  );
}

/** The two failure branches: gh missing (the fixable one, named) or anything
 *  else, both offering a retry. */
function MyWorkError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const cliMissing = isAppError(error) && error.kind === "ghNotFound";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-xs font-medium">
        {cliMissing ? "GitHub CLI (gh) not found" : "Couldn't load your work"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {cliMissing
          ? "Install the GitHub CLI (gh) and run gh auth login to see your pull requests and issues here."
          : errorMessage(error)}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
