import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  GitPullRequestIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
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
import { toast } from "sonner";
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
import { ghPrHeadRef, validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import { useForgeMyWork } from "@/lib/git/queries";
import type { MyWorkItem, PrHeadRef, RepoInfo } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage, isAppError } from "@/lib/tauri/invoke";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  filterMyWork,
  MY_WORK_LISTBOX_ID,
  type MyWorkTab,
  matchLocalRepo,
  myWorkOptionId,
  sortMyWork,
} from "./mywork-utils";

/** Stable empty default, so a settings read that hasn't landed doesn't hand a
 *  fresh array to every render. */
const NO_RECENTS: RecentRepo[] = [];

/** Total budget for resolving where to open a PR, spanning EVERY awaited leg of
 *  the resolution — the worktree list, the head-ref read, and the validate of
 *  whatever checkout they point at. Opening must stay a keypress-fast action,
 *  and any one leg can block for seconds (git's prune, a stalled network mount).
 *  Legs that consume the whole budget leave nothing for the ones after them,
 *  which fall back to the main checkout — the safe direction. */
const WORKTREE_RESOLVE_BUDGET_MS = 1500;

/** Grace period before a resolving open lights its row, so a resolution that
 *  answers quickly never flashes a spinner. */
const PENDING_AFFORDANCE_MS = 300;

/** Open generation. Module-scoped because MyWorkScreen unmounts on every view
 *  change: against a component ref, a continuation from a previous mount would
 *  compare with a fresh counter, pass its own supersede check, and navigate the
 *  app by itself. Read only from handlers and continuations, never in render. */
let openGen = 0;

/** Resolves `work` against what's left of `deadline`, answering `fallback` on
 *  both rejection and expiry — the caller treats slow and broken alike. */
function withDeadline<T>(
  work: Promise<T>,
  deadline: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(
        () => resolve(fallback),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A checkout's navigation target, or null when it can't be validated in time.
 * `root` rather than the caller's path: git prints worktree paths with forward
 * slashes while validate_repo answers the canonical spelling, and every
 * repo-identity consumer (query keys, per-repo stores, the session lists'
 * `s.repoPath === repoPath` filters) compares that form as a plain string — two
 * spellings of one checkout would read as two different repos.
 */
async function resolveTarget(
  path: string,
  deadline: number,
): Promise<{ path: string; name: string } | null> {
  // A spent budget would race git against a zero-length timeout and discard the
  // result — don't spawn the process at all.
  if (Date.now() >= deadline) return null;
  const info = await withDeadline<RepoInfo | null>(
    validateRepo(path),
    deadline,
    null,
  );
  return info ? { path: info.root, name: info.name } : null;
}

/**
 * The repo's main worktree when `repoPath` is itself a linked one, else null.
 * A worktree opened through the folder picker lands in recents like any other
 * checkout, so a matched row can't be assumed to be the main workspace.
 */
function mainWorktreeOf(
  worktrees: UserWorktree[],
  repoPath: string,
): string | null {
  const main = worktrees.find((w) => w.isMain);
  // normPath for comparison only — git spells worktree paths with forward
  // slashes where validate_repo hands back Windows separators.
  if (!main || normPath(main.path) === normPath(repoPath)) return null;
  return main.path;
}

/**
 * The worktree whose checked-out branch is provably this PR's head, else null.
 * Every unknown — a slow or failed head-ref read, an unproven head, no branch
 * match — is a null, and the caller's deadline bounds the read. Candidates are
 * not filtered against `repoPath`: a head branch checked out in the matched
 * checkout itself is still the proven answer, and returning it is what keeps
 * the main-workspace preference from pulling the user off their own branch.
 */
async function branchWorktreeOf(
  item: MyWorkItem,
  worktrees: UserWorktree[],
  repoPath: string,
  deadline: number,
): Promise<string | null> {
  const candidates = worktrees.filter((w) => w.branch !== "");
  if (candidates.length === 0) return null;
  // A spent budget would race gh against a zero-length timeout and discard the
  // result — don't spawn the process at all.
  if (Date.now() >= deadline) return null;
  const head = await withDeadline<PrHeadRef | null>(
    ghPrHeadRef(repoPath, item.number),
    deadline,
    null,
  );
  // A fork PR's head branch lives in a different repository, where that branch
  // name routinely also exists locally — only a head slug matching this item's
  // repo proves a local branch IS the PR's, so an empty or foreign slug falls
  // back to whatever the caller had chosen.
  if (
    !head ||
    head.headRefName === "" ||
    head.headRepoFullName.toLowerCase() !== item.repoFullName.toLowerCase()
  ) {
    return null;
  }
  // Exact compare: git branch names are case-sensitive.
  return candidates.find((w) => w.branch === head.headRefName)?.path ?? null;
}

/** Inset from the row's leading edge for a keyboard-opened menu's anchor, so the
 *  popup hangs beside the row rather than off the viewport edge. */
const MENU_KEY_ANCHOR_INSET_PX = 12;

/**
 * Opens a row's context menu from the keyboard, reporting whether it could.
 *
 * A real `contextmenu` event on the row is the only route: Base UI takes the
 * popup's anchor solely from such an event's coordinates (its trigger's handler
 * is what calls `setAnchor`, and the public actions ref exposes only
 * close/unmount), and the list's own capture handler reads the row out of the
 * event target. Dispatching one drives both, exactly as a right-click does.
 */
function openRowContextMenu(url: string): boolean {
  const row = document.getElementById(myWorkOptionId(url));
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.round(rect.left + MENU_KEY_ANCHOR_INSET_PX),
      clientY: Math.round(rect.top + rect.height / 2),
    }),
  );
  return true;
}

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
  // The row whose open is still resolving where to land, or null.
  const [pendingOpenUrl, setPendingOpenUrl] = useState<string | null>(null);

  // GitHub-only in this slice: the backend refuses the other providers outright,
  // so there is no provider axis to offer.
  const work = useForgeMyWork("github", true);
  const settings = useSettings();
  const recents = settings.data?.recentRepos ?? NO_RECENTS;
  const queryClient = useQueryClient();
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which open generation lit the pending row, so an older open finishing late
  // can't darken an affordance a newer one owns.
  const pendingGenRef = useRef(0);

  const items = sortMyWork(work.data?.items ?? []);
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

  // openItem clears its own timer on every exit path; this catches an unmount
  // while one is still armed — and retires the mount's continuations: a quick
  // reopen restores view === "mywork", so the view guard alone can't see it.
  useEffect(() => {
    return () => {
      openGen += 1;
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
      }
    };
  }, []);

  // Every navigation goes through an atomic navigator: an openRepo followed by a
  // select would pair the new repo with the old selection, because the
  // view-transition callback that carries the selection is deferred.
  // `preferWorktree: false` is the escape hatch back to the main workspace
  // (Shift+Enter, shift-click, or the context menu); everything else lands where
  // the branch actually is.
  async function openItem(
    item: MyWorkItem,
    opts?: { preferWorktree?: boolean },
  ) {
    // Claim the generation before any early return, so EVERY open — including
    // the browser arm, which never awaits — supersedes a pending one; a stale
    // continuation must strand rather than stomp the newer action or yank the
    // user back. The counter outlives the screen (this one unmounts on every
    // view change), so a continuation from a previous mount stays superseded;
    // the view is read live because the screen can be gone entirely.
    const gen = ++openGen;
    const superseded = () =>
      gen !== openGen || useUiStore.getState().view !== "mywork";
    const match = matchLocalRepo(item, recents);
    if (!match) {
      openUrl(item.url);
      return;
    }
    // Recents rows outlive deleted and moved clones, so prove the path is still
    // a repo before navigating; the browser fallback keeps the row a working
    // link while the toast names the stale path (repair lives in the repo list).
    try {
      await validateRepo(match.path);
    } catch (e) {
      if (superseded()) return;
      openUrl(item.url);
      // Only a real notARepo earns the stale-path sentence — a missing CLI or an
      // IPC failure would be misdescribed by it, so it takes the generic toast.
      if (isAppError(e) && e.kind === "notARepo") {
        toast.error(`${match.path} is no longer a git repository.`);
      } else {
        toastError(e);
      }
      return;
    }
    if (superseded()) return;
    // Where a local landing goes, in one rule: a matched row that is itself a
    // linked worktree prefers its repo's main workspace, and a PROVEN PR head
    // branch outranks that toward the worktree holding it. Every unknown stays
    // on match.path, silently — nothing broke for the user.
    let targetPath = match.path;
    let targetName = match.name;
    {
      // Armed before the first await, not before the network leg: listing
      // worktrees runs a prune that can block for seconds, and a freeze the row
      // doesn't acknowledge reads as a dropped keypress. Held locally as well as
      // on the ref — the ref is what an unmount can reach, but only this
      // generation may clear its own timer out of it.
      const timer = setTimeout(() => {
        if (superseded()) return;
        setPendingOpenUrl(item.url);
      }, PENDING_AFFORDANCE_MS);
      pendingTimerRef.current = timer;
      // Ownership is claimed at ARM time, not fire time: a successor open must
      // own the affordance from its first instant, or the superseded open's
      // cleanup darkens a row the successor is still resolving.
      pendingGenRef.current = gen;
      // One budget for the whole resolution, however many legs it takes.
      const deadline = Date.now() + WORKTREE_RESOLVE_BUDGET_MS;
      try {
        // Listed once and shared: both preferences read the same snapshot, and
        // this is the leg that can block.
        const worktrees = await withDeadline(
          listUserWorktrees(match.path),
          deadline,
          [],
        );
        if (superseded()) return;
        // The fallback is resolved AND validated first, before the optional
        // network leg can spend the budget on it: the semantics promise the main
        // workspace whenever the branch is unconfirmed, so that promise must not
        // depend on how slow the head-ref read turns out to be. Costs one local
        // git call even when the branch goes on to win.
        // Null when the matched row already IS the main workspace, so the
        // ordinary main-clone open never re-validates or re-spells its path.
        const mainPath = mainWorktreeOf(worktrees, match.path);
        // Where the open lands if the branch is never looked up. Proving a head
        // can only matter when some branch-bearing checkout sits somewhere ELSE
        // than that: a single-checkout clone has nowhere to be redirected to, and
        // the common open must stay keypress-instant rather than wait on a forge
        // call whose every outcome is the path it already has.
        const fallbackPath = mainPath ?? match.path;
        const lookupCanMove = worktrees.some(
          (w) => w.branch !== "" && normPath(w.path) !== normPath(fallbackPath),
        );
        let landing: { path: string; name: string } | null = null;
        if (mainPath) {
          // git skips its prune while another process holds the worktree-admin
          // lock, so a checkout deleted out-of-band can still be listed.
          landing = await resolveTarget(mainPath, deadline);
          if (superseded()) return;
        }
        if (
          lookupCanMove &&
          item.isPullRequest &&
          (opts?.preferWorktree ?? true)
        ) {
          const branch = await branchWorktreeOf(
            item,
            worktrees,
            match.path,
            deadline,
          );
          if (superseded()) return;
          if (branch && normPath(branch) === normPath(match.path)) {
            // The proven head is the matched checkout itself — stay on the
            // user's own branch rather than moving them to the main workspace.
            landing = null;
          } else if (branch) {
            const branchTarget = await resolveTarget(branch, deadline);
            if (superseded()) return;
            // A branch that won't validate keeps the main-workspace fallback
            // rather than dropping back to the matched worktree.
            if (branchTarget) landing = branchTarget;
          }
        }
        if (landing) {
          targetPath = landing.path;
          targetName = landing.name;
        }
      } finally {
        clearTimeout(timer);
        if (pendingTimerRef.current === timer) pendingTimerRef.current = null;
        // Only the generation that owns the affordance may darken it.
        if (pendingGenRef.current === gen) {
          pendingGenRef.current = 0;
          setPendingOpenUrl(null);
        }
      }
      if (superseded()) return;
    }
    // Land under the origin lens (matchLocalRepo matched the ORIGIN slug): a fork
    // sitting on "upstream" resolves this number against the parent repo. Keyed on
    // the path actually navigated to, since a worktree carries its own lens. The
    // lens write is session-only. Clears are safe: an unchanged lens short-circuits
    // before them, and a real flip drops old-lens siblings before the landing set.
    const applyLens = () =>
      applyRepoLens(queryClient, targetPath, "origin", {
        clearSelections: true,
        persist: false,
      });
    if (item.isPullRequest) {
      openPr({
        kind: "remote",
        repoPath: targetPath,
        repoName: targetName,
        ref: String(item.number),
        section: null,
        // Inside the navigator's view-transition callback, so the lens and the
        // selection reach the same commit; applied here it would land a render
        // early and fetch the new lens against the OLD number.
        beforeSelect: applyLens,
      });
    } else {
      openIssue({
        repoPath: targetPath,
        repoName: targetName,
        number: item.number,
        beforeSelect: applyLens,
      });
    }
  }

  // Arrow keys from the filter input move the selection through the visible
  // rows and Enter opens it, so a keyboard user goes type → arrows → Enter
  // without ever leaving the input. Shift+Enter is the keyboard route to the
  // main workspace.
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
      void openItem(item, { preferWorktree: !e.shiftKey });
      return;
    }
    // The menu keys reach the row's context menu from here because focus never
    // leaves this input: pressed on the input they would target it instead, and
    // it sits outside the list's menu trigger, so the rows' only menu route is
    // this one. Targets the active row, which the menu already acts on.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const item = visible[activeIndex];
      // Swallowed whenever a row is active, even if it scrolled out of the
      // virtualizer and couldn't be found: the input's own edit menu is the
      // wrong answer to a row-menu request. With no active row there is no row
      // menu to ask for, so that menu stays reachable.
      if (item) {
        e.preventDefault();
        openRowContextMenu(item.url);
      }
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
          // Same predicate as aria-expanded: the listbox only mounts in the list
          // branch, so pointing at its id from any other state would reference a
          // node that isn't there.
          aria-controls={visible.length > 0 ? MY_WORK_LISTBOX_ID : undefined}
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
        pendingOpenUrl={pendingOpenUrl}
        onSelect={setActiveUrl}
        onOpen={(item, opts) => void openItem(item, opts)}
      />
    </div>
  );
}

/** Opens an item, optionally overriding the worktree preference. */
type OpenItem = (item: MyWorkItem, opts?: { preferWorktree?: boolean }) => void;

/** The body's state machine: loading → error → empty → filtered-empty → list.
 *  Split from the shell so the virtualizer below only ever mounts with rows. */
function MyWorkBody({
  work,
  items,
  visible,
  activeIndex,
  recents,
  pendingOpenUrl,
  onSelect,
  onOpen,
}: {
  work: ReturnType<typeof useForgeMyWork>;
  items: MyWorkItem[];
  visible: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  pendingOpenUrl: string | null;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
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
  // Set server-side when a search leg hit its cap or the merged union overshot
  // the page — leg caps count raw hits before unaddressable ones drop, so it
  // stays true on a page that arrives short. Shown under the filtered-empty
  // branch too: filtering to nothing is when an off-page item matters most.
  const capped = work.data?.truncated ?? false;
  if (visible.length === 0) {
    return (
      <>
        <QuietLine>No items match.</QuietLine>
        {capped && <CapNote />}
      </>
    );
  }
  return (
    <>
      <MyWorkList
        items={visible}
        activeIndex={activeIndex}
        recents={recents}
        pendingOpenUrl={pendingOpenUrl}
        onSelect={onSelect}
        onOpen={onOpen}
      />
      {capped && <CapNote />}
    </>
  );
}

/** The virtualized row list, plus one shared context menu for the whole list
 *  (capture phase records the row before the menu opens). */
function MyWorkList({
  items,
  activeIndex,
  recents,
  pendingOpenUrl,
  onSelect,
  onOpen,
}: {
  items: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  pendingOpenUrl: string | null;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [menuItem, setMenuItem] = useState<MyWorkItem | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 33,
    overscan: 12,
  });

  // Armed by a right-click, consumed by the very next run of the align effect:
  // the menu opens anchored to the cursor, so aligning the row it selected would
  // slide the list out from under it.
  const skipAlignRef = useRef(false);

  // Keep the keyboard-selected row in view. Keyed on the selection alone: a
  // re-scroll on any list change would fight the user's own scrolling on every
  // unrelated re-render (the shared clock ticks these rows every 30s).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection moves
  useEffect(() => {
    if (skipAlignRef.current) {
      skipAlignRef.current = false;
      return;
    }
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
      // Move the highlight with the menu, so it can't act on a row other than
      // the one aria-activedescendant is pointing at — but arm the skip only
      // when the index will actually change, or the flag would outlive this
      // click and swallow the next keyboard scroll.
      if (item.url !== items[activeIndex]?.url) skipAlignRef.current = true;
      onSelect(item.url);
    } else {
      setMenuItem(null);
      suppressContextMenu(e);
    }
  }

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
              so the listbox itself is neither a Tab stop nor the owner of
              aria-activedescendant — focus never leaves the input, and a second
              copy here would be inert. A pure a11y container. */}
          <div
            ref={parentRef}
            className="min-h-0 flex-1 overflow-y-auto"
            role="listbox"
            id={MY_WORK_LISTBOX_ID}
            aria-label="Your work"
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
                      pending={item.url === pendingOpenUrl}
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
              {/* The escape hatch from the worktree-aware default: only ever
                  offered for a PR that resolves to a local repo at all. */}
              {menuItem.isPullRequest &&
                matchLocalRepo(menuItem, recents) !== null && (
                  <ContextMenuItem
                    onClick={() => onOpen(menuItem, { preferWorktree: false })}
                  >
                    Open in main workspace
                  </ContextMenuItem>
                )}
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
    </div>
  );
}

/** The one-page-of-results note. Rendered by the body, not the list, so it
 *  survives a filter that matches nothing. */
function CapNote() {
  return (
    <p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
      This view fetches one page of results. Filter to narrow the list.
    </p>
  );
}

/** One inbox row — a `role="option"` in the listbox. Single line: type glyph,
 *  number, title, repository, and when it last moved. */
function MyWorkRow({
  item,
  local,
  active,
  pending,
  onSelect,
  onOpen,
}: {
  item: MyWorkItem;
  local: boolean;
  active: boolean;
  pending: boolean;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
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
      aria-busy={pending}
      // The combobox input owns focus and drives the selection, so an option
      // must not also be a Tab stop.
      tabIndex={-1}
      // tabIndex alone doesn't stop a CLICK from focusing the button, which
      // would move focus off the combobox input and kill arrow/Enter nav;
      // suppressing mousedown's default keeps focus without affecting activation.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        onSelect(item.url);
        // Shift-click mirrors Shift+Enter: open the main workspace instead of
        // the worktree holding the head branch.
        onOpen(item, { preferWorktree: !e.shiftKey });
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
      {pending && (
        <span
          className="flex shrink-0 items-center text-muted-foreground"
          aria-hidden
        >
          <CircleNotchIcon className="size-3.5 animate-spin" />
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
