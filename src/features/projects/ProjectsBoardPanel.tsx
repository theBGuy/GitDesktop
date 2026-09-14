import { Popover } from "@base-ui/react/popover";
import { FadersHorizontalIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  projectScopeMissing,
  projectScopeReadOnly,
  ScopeGapBlock,
} from "@/features/conversations/ProjectsPopover";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import { clipTitleFromText } from "@/lib/clip-title";
import { suppressContextMenu } from "@/lib/context-menu";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost, useForgeGhHost } from "@/lib/git/host";
import {
  forgeReady,
  useAvailableProjects,
  useForgeStatus,
  useGhScopes,
  useMoveBoardCard,
  useProjectFields,
  useProjectItems,
  useProjectViews,
} from "@/lib/git/queries";
import {
  type BoardItem,
  type BoardItemContent,
  type ProjectFieldDef,
  type ProjectViewDef,
  providerLabel,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useRemoteSlug, useRepoLens } from "@/lib/repo-lens/queries";
import { type RepoTab, useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { BoardCardMenuItems, type BoardMenuTarget } from "./BoardCardMenu";
import { BoardColumn } from "./BoardColumn";
import {
  type BoardColumnModel,
  buildColumns,
  chipFieldDefs,
  firstCardPosition,
  groupableFields,
  optionIdFor,
  sortColumnItems,
  UNSET_COLUMN_ID,
} from "./board-model";

/** Where an issue or pull request on this board lands, per kind: the tab that
 *  owns it in-app, and the web path a CROSS-REPO card falls back to (GitHub's own
 *  spelling, which differs from the tab's). Drafts open their own popover on the
 *  card and a redacted item has nothing to open, so neither appears here. */
const FORGE_KIND: Record<
  "issue" | "pullRequest",
  { tab: RepoTab; webPath: "issues" | "pull" }
> = {
  issue: { tab: "issues", webPath: "issues" },
  pullRequest: { tab: "pulls", webPath: "pull" },
};

const NO_GROUP_FIELDS_REASON =
  "This project has no single-select fields to group its board by";
const LOADING_FIELDS_REASON = "Loading this project's fields…";
const FIELDS_ERROR_REASON = "Couldn't load this project's fields";
/** The next three mirror the field editor's own wording verbatim: each surface
 *  gates on the same flag as the row it mirrors, and the two must not say it
 *  differently (ProjectFieldsEditor.tsx). */
const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read project fields but not change them (needs the project scope)";
const NO_ACCESS_REASON = "You don't have write access to this project";
const ISSUE_FIELD_REASON =
  "Issue fields are edited on GitHub — board editing arrives later";
const LOADING_VIEWS_REASON = "Loading this project's views…";
/** The two holds the switcher takes on the SEED's input rather than on the views
 *  themselves: a pick seeds the grouping from the field definitions, so it waits
 *  for them and refuses while they are unreachable. The second names the read to
 *  retry rather than where its control is: that failure reaches the user as the
 *  strip's notice over a drawn board, and as the panel's error card without one. */
const VIEWS_AWAIT_FIELDS_REASON = "Waiting for this project's fields…";
const VIEWS_FIELDS_FAILED_REASON =
  "Couldn't load this project's fields, which saved views need. Retry that read and they're selectable again.";
const VIEWS_ERROR_REASON = "Couldn't load this project's views";
const NO_VIEWS_REASON = "This project has no saved views";
/** Said by every control that would otherwise speak for the board on screen: while
 *  a new lens loads, those cards are the PREVIOUS view's. */
const LENS_LOADING_REASON = "Loading this view of the board…";
const VIEWS_TRUNCATED_NOTE = "Showing the first 50 views.";
/** A view GitHub reports with no name. */
const UNTITLED_VIEW = "Untitled view";
/** Single-writer: two writes to one card's field settle in an order nothing
 *  promises, and an EARLIER move failing late puts the card back in a column a
 *  later write already moved it out of. */
const MOVING_REASON = "Moving your last card…";
/** Held rather than queued: a move cancels the board's reads, and query-core's
 *  cancel REVERTS an in-flight one. */
const LOADING_PAGE_REASON = "Finishing the board's next page…";
/** A view-option row. Mirrors the field editor's own option rows, which are the
 *  same shape on the same kind of choice. */
const GROUP_ROW_CLASS =
  "flex cursor-pointer items-center gap-2 px-1 py-1 text-xs hover:bg-muted/60";
/** The switcher's "no lens" row. Not a view id — it stands for the ABSENCE of
 *  one, the way the board's catch-all column stands for an unset field. */
const NO_VIEW_ROW_ID = "__no_view__";
/** One shared list for every render the definitions haven't arrived for. A fresh
 *  `[]` would re-mint the chip memo, and through it every mounted card. */
const NO_FIELD_DEFS: ProjectFieldDef[] = [];
/** What the board says about a view it is drawing in the only layout it has. A
 *  BOARD view needs no note, and an unrecognised layout names no shape it can't
 *  vouch for. */
const FLAT_FALLBACK_NOTE: Partial<Record<ProjectViewDef["layout"], string>> = {
  table: "Table view, shown as a board",
  roadmap: "Roadmap view, shown as a board",
  unknown: "Shown as a board",
};
/** The switcher row's muted qualifier, for the layouts that aren't this one. */
const VIEW_LAYOUT_WORD: Partial<Record<ProjectViewDef["layout"], string>> = {
  table: "table",
  roadmap: "roadmap",
};

/** A view's filter as the board's LENS. GitHub reports an unfiltered view as
 *  either null or an empty string, and sending `""` would key a second cache
 *  entry for the same unfiltered read; anything else rides VERBATIM, since the
 *  filter grammar is the server's to parse. */
function lensFilter(view: ProjectViewDef | null): string | null {
  const filter = view?.filter ?? null;
  return filter === null || filter.trim() === "" ? null : filter;
}

/** The one control that takes the board back to no lens, worded the same wherever
 *  it appears: the strip that announces the view, and the state its filter
 *  emptied. */
function ClearViewButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="cursor-pointer underline hover:text-foreground"
    >
      Clear view
    </button>
  );
}

/** Whether a card's issue or pull request opens IN-APP rather than in the browser.
 *  `selectIssue`/`selectPr` hand over a bare number the destination resolves under
 *  the repo's ACTIVE lens, so only a card from the repo that lens points at can be
 *  opened here. An unresolved slug (`null`) takes the browser branch deliberately:
 *  that is the SAFE direction, since an in-app open on an unconfirmed match would
 *  paint the wrong repository's detail view under this number. */
function opensInApp(
  content: Extract<BoardItemContent, { kind: "issue" | "pullRequest" }>,
  repoSlug: string | null,
): boolean {
  return (
    repoSlug !== null &&
    content.repoNameWithOwner.toLowerCase() === repoSlug.toLowerCase()
  );
}

/** The Open row's words, or null where the menu carries no Open row at all: a
 *  DRAFT opens its notes from the card's own popover trigger, and a redacted item
 *  has no destination. The two labels are the two branches {@link opensInApp}
 *  picks between, so the row can't promise a tab the open won't use. */
function openLabelFor(
  item: BoardItem | undefined,
  repoSlug: string | null,
): string | null {
  const content = item?.content;
  if (
    content === undefined ||
    (content.kind !== "issue" && content.kind !== "pullRequest")
  )
    return null;
  return opensInApp(content, repoSlug) ? "Open" : "Open on GitHub";
}

/** Where `itemId` sits in the freshly derived columns, or null when the board no
 *  longer draws it — which a move's own patch can never cause, but a refetch
 *  landing mid-chase can. */
function findCard(
  columns: BoardColumnModel[],
  itemId: string,
): { col: number; idx: number } | null {
  for (const [col, column] of columns.entries()) {
    const idx = column.items.findIndex((item) => item.itemId === itemId);
    if (idx !== -1) return { col, idx };
  }
  return null;
}

/**
 * Releases the board's menu latch when the menu's HOST leaves the tree — a fatal
 * read, a project switch, anything that swaps the board's body arm out from under
 * an open menu. Base UI's close-complete callback rides the popup's own unmount,
 * so a root that disappears with it never fires one, and a latched flag would hold
 * the focus chase armed (re-scanning the columns every render) until the next menu
 * close spent its stale claim.
 *
 * Mounted INSIDE the menu so the release keys on the real mount rather than on a
 * copy of the body-arm ladder, which would drift. Both setters are `useState`'s
 * own, so the effect runs once and only its cleanup does the work.
 */
function MenuLatchRelease({
  setMenuBusy,
  setChase,
}: {
  setMenuBusy: (busy: boolean) => void;
  setChase: (itemId: string | null) => void;
}) {
  useEffect(
    () => () => {
      setMenuBusy(false);
      setChase(null);
    },
    [setMenuBusy, setChase],
  );
  return null;
}

/** The board's first paint: three column shells rather than a spinner, so the
 *  real columns replace them without the surface shifting. */
function BoardSkeleton() {
  return (
    <>
      <span role="status" className="sr-only">
        Loading the project board…
      </span>
      <div aria-busy className="flex min-h-0 flex-1 gap-2">
        {["a", "b", "c"].map((key) => (
          <div
            key={key}
            className="flex w-76 shrink-0 flex-col gap-1.5 border bg-muted/20 p-1.5"
          >
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    </>
  );
}

/** The panel's error card: the failure's own summary plus the one control that
 *  can clear it. `presentError(...).summary` alone is the house error-card
 *  shape — the Issues and Pull Requests panels render exactly this. */
function ErrorCard({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="px-3 py-4 text-xs">
      <p className="text-muted-foreground">{presentError(error).summary}</p>
      <Button variant="outline" size="xs" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A state that fills the panel with one short explanation, centred nowhere —
 *  top-left, where the board's own content starts. */
function BoardNotice({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-prose space-y-2 px-3 py-4 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * The Projects tab: a kanban of one GitHub Project, grouped by one of the board's
 * single-select fields, with one write — a card's context menu moves it between
 * the columns of that grouping.
 *
 * Every read gates on `active` as well as the provider — `<Activity>` defers a
 * hidden panel's effects but NOT its queries, so a board left on another tab
 * would otherwise keep paying for owner-wide project reads. The layout choices
 * stay unwritten: the switcher and the group-by are transient component state on
 * purpose, so a board the user looked at once doesn't become a stored preference.
 */
export function ProjectsBoardPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  /** The Projects tab is the visible one. Gates every read in this subtree. */
  active: boolean;
}) {
  const gh = useForgeStatus(repoPath);
  const provider = gh.data?.provider;
  const isGitHub = provider === "github";
  const host = useActiveGhHost();
  const ghHost = useForgeGhHost(repoPath);
  const scopes = useGhScopes(host);
  // The same gate every other Projects surface reads, so none can fire a read
  // another one withholds.
  const scopeGap = projectScopeMissing(scopes.data);
  const canRead = active && isGitHub && !scopeGap;
  // The fork/upstream lens picks which repo's project catalog this is, and which
  // slug counts as "this repo" when a card opens — the same lens the Issues and
  // Pulls surfaces resolve, wired once at the view level.
  const lens = useRepoLens(repoPath);
  const repoSlug = useRemoteSlug(repoPath, lens, canRead);
  const openReconnect = useUiStore((s) => s.openReconnect);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const selectPr = useUiStore((s) => s.selectPr);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  const projects = useAvailableProjects(repoPath, canRead, lens);
  // Closed boards are out in v1: they still hold items, but a board nobody is
  // working stands between the user and the one they came for.
  const openProjects = (projects.data?.projects ?? []).filter((p) => !p.closed);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  // Derived, not stored: the catalog arrives after the first render and can
  // change under the user, and a chosen board that has since closed or gone must
  // fall back rather than leave the board reading an id nothing serves. The
  // catalog's own order puts the repo's boards ahead of the owner's, so the
  // fallback IS "first repo-linked, else first owner".
  const projectId =
    openProjects.find((p) => p.id === pickedProjectId)?.id ??
    openProjects[0]?.id ??
    null;
  const project = openProjects.find((p) => p.id === projectId) ?? null;

  const fields = useProjectFields(
    repoPath,
    projectId ?? "",
    canRead && projectId !== null,
  );
  const fieldDefs = fields.data?.fields ?? NO_FIELD_DEFS;
  const groupFields = groupableFields(fieldDefs);
  const [pickedFieldId, setPickedFieldId] = useState<string | null>(null);
  // "Status" by name is what a GitHub board means by its columns; anything else
  // is a board that renamed or dropped it, where the first single-select is the
  // closest thing to the same promise.
  const defaultField =
    groupFields.find((f) => f.name === "Status") ?? groupFields[0] ?? null;
  const groupField =
    groupFields.find((f) => f.id === pickedFieldId) ?? defaultField;

  const views = useProjectViews(
    repoPath,
    projectId ?? "",
    canRead && projectId !== null,
  );
  const viewList = views.data?.views ?? [];
  // Transient like the grouping above, and DERIVED like the project pick: a view
  // that has since been deleted (or fell past the server's cap) degrades to no
  // lens, where a stored snapshot would keep filtering by something nothing
  // serves.
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const view = viewList.find((v) => v.id === activeViewId) ?? null;
  const lensQuery = lensFilter(view);
  // Imperative, because no render-derivable signal tells "this view is GONE" from
  // "this read hasn't carried it yet": the lens above degrades either way, but a
  // lingering id is re-adopted by the next list that happens to contain it —
  // filter, sort and chips back on with no pick behind them and no grouping seed.
  // A SETTLED list is the only thing that may retire it, so a pending or failed
  // read touches nothing.
  useEffect(() => {
    if (activeViewId === null || views.data === undefined) return;
    if (!views.data.views.some((v) => v.id === activeViewId))
      setActiveViewId(null);
  }, [activeViewId, views.data]);

  const items = useProjectItems(
    repoPath,
    projectId ?? "",
    lensQuery,
    canRead && projectId !== null,
  );
  // The cards on screen belong to the PREVIOUS lens until this clears, so every
  // claim derived from them waits: the count, Load more, and the move rows.
  const lensLoading = items.isPlaceholderData;
  const loaded = items.data?.pages.flatMap((page) => page.items) ?? [];
  // The view's sort orders cards WITHIN a column, so it applies after bucketing —
  // which column a card lands in is the grouping's answer alone. With no sort the
  // columns are untouched, board POSITION order and all.
  const grouped = buildColumns(loaded, groupField);
  const columns =
    view === null || view.sortBy.length === 0
      ? grouped
      : grouped.map((column) => ({
          ...column,
          items: sortColumnItems(column.items, view.sortBy, fieldDefs),
        }));
  // Identity-stable for the memoized cards: a fresh array per render would
  // re-render every mounted card whenever the keyboard cursor moves. Every input
  // is stable in its own right — the query's own array or the shared empty, and
  // two values derived off it — so the dep list is the real one.
  const chipFields = useMemo(
    () => chipFieldDefs(view, fieldDefs, groupField),
    [view, fieldDefs, groupField],
  );
  // Counts the cards the board DRAWS, so it agrees with the column headers;
  // `totalCount` is the board's own figure and includes archived items, which is
  // why it only ever appears as the "of M" of a partly-loaded board.
  const shown = columns.reduce((n, column) => n + column.items.length, 0);
  const totalCount = items.data?.pages.at(-1)?.totalCount ?? shown;

  // The keyboard cursor, plus a nonce that bumps ONLY on an arrow press — the
  // columns move DOM focus off the nonce, never off the cursor, so a click or a
  // tab into the board can set the cursor without yanking focus around.
  const [cursor, setCursor] = useState<{ col: number; idx: number } | null>(
    null,
  );
  const [focusNonce, setFocusNonce] = useState(0);
  const onCardFocus = useCallback(
    (col: number, idx: number) => setCursor({ col, idx }),
    [],
  );
  // A cursor left over from another grouping (or a refetch that emptied its
  // column) can't address a card, so the tab stop falls back to the first one.
  const liveCursor =
    cursor !== null && cursor.idx < (columns[cursor.col]?.items.length ?? 0)
      ? cursor
      : null;
  const tabStop = liveCursor ?? firstCardPosition(columns);

  /** Take the board back to no lens: its whole item set, its own POSITION order,
   *  no chips. The GROUPING stays where it is — a view seeds it once, and what
   *  the user has in front of them is their own pick from then on. */
  function clearView() {
    setActiveViewId(null);
    setCursor(null);
  }

  /** Selecting a view is an EVENT, never an effect: the grouping seed fires once,
   *  here, so a Group-by change made UNDER an active view stands rather than being
   *  re-seeded on the next render. */
  function pickView(nextId: string | null) {
    setActiveViewId(nextId);
    const picked =
      nextId === null ? null : (viewList.find((v) => v.id === nextId) ?? null);
    // Seeded only from a grouping this board can actually draw, off the same
    // `groupableFields` set the Group-by rows offer: a table view groups by
    // nothing, and a view grouped by an iteration field makes no columns here.
    const vgroup = picked?.verticalGroupFieldIds[0];
    if (vgroup !== undefined && groupFields.some((f) => f.id === vgroup))
      setPickedFieldId(vgroup);
    // The columns are about to hold a different set of cards.
    setCursor(null);
  }

  // Palette-only, and live only where it can do something: a board on screen
  // with a view on it.
  useHotkeyAction("clear-project-view", clearView, active && view !== null);

  const openItem = useCallback(
    (item: BoardItem) => {
      const content = item.content;
      if (content.kind !== "issue" && content.kind !== "pullRequest") return;
      const target = FORGE_KIND[content.kind];
      // Everything the predicate refuses — another repo, or the same repo under
      // the other lens — leaves the app, which is the same rule the Markdown
      // reference links follow.
      if (opensInApp(content, repoSlug)) {
        const id = String(content.number);
        if (content.kind === "issue") selectIssue({ kind: "remote", id });
        else selectPr({ kind: "remote", id });
        setRepoTab(target.tab);
        return;
      }
      void openUrl(
        `https://${host}/${content.repoNameWithOwner}/${target.webPath}/${content.number}`,
      ).catch(toastError);
    },
    [host, repoSlug, selectIssue, selectPr, setRepoTab],
  );

  /** The card `el` sits in, resolved from the DOM rather than from state: a bare
   *  Tab into the board moves focus without touching the cursor, and the arrows
   *  must act on where the user actually is. */
  function cardAt(el: Element): { col: number; idx: number } | null {
    const card = el.closest<HTMLElement>("[data-card-index]");
    const column = card?.closest<HTMLElement>("[data-column-index]");
    if (!card || !column) return null;
    const idx = Number(card.dataset.cardIndex);
    const col = Number(column.dataset.columnIndex);
    return Number.isInteger(idx) && Number.isInteger(col) ? { col, idx } : null;
  }

  /** The nearest column with a card in `step`'s direction, or -1. Empty columns
   *  are stepped OVER rather than landed on: there is nothing there to focus. */
  function nextColumn(from: number, step: number): number {
    for (let i = from + step; i >= 0 && i < columns.length; i += step) {
      if (columns[i].items.length > 0) return i;
    }
    return -1;
  }

  function onBoardKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // DOM containment first, and it gates the cursor fallback too. React routes
    // synthetic events through the COMPONENT tree, so a keystroke typed inside a
    // draft card's PORTALLED popup arrives here even though the popup is not a
    // DOM descendant of the board — and the old `?? liveCursor` fallback then
    // moved the board under someone reading a draft. Focus outside this
    // container is not ours to act on, whatever the cursor still remembers.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !e.currentTarget.contains(focused))
      return;
    const from = cardAt(focused) ?? liveCursor;
    if (from === null) return;
    const column = columns[from.col];
    if (column === undefined || column.items.length === 0) return;
    const last = column.items.length - 1;
    let next = from;
    switch (e.key) {
      case "ArrowDown":
        next = { col: from.col, idx: Math.min(from.idx + 1, last) };
        break;
      case "ArrowUp":
        next = { col: from.col, idx: Math.max(from.idx - 1, 0) };
        break;
      case "Home":
        next = { col: from.col, idx: 0 };
        break;
      case "End":
        next = { col: from.col, idx: last };
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const col = nextColumn(from.col, e.key === "ArrowRight" ? 1 : -1);
        // Same visual row in the neighbour, clamped to its last card.
        if (col !== -1)
          next = {
            col,
            idx: Math.min(from.idx, columns[col].items.length - 1),
          };
        break;
      }
      default:
        return;
    }
    // Swallowed whether or not anything moved: a focused board must never scroll
    // sideways or jump to the page's end under a key it owns.
    e.preventDefault();
    if (next.col === from.col && next.idx === from.idx) return;
    setCursor(next);
    setFocusNonce((n) => n + 1);
  }

  // The board's one write. ONE instance, which is what makes `isPending` a real
  // single-flight gate — the menu's stated contract, and what keeps two writes to
  // one card's field from settling in an order that leaves it in the wrong column.
  const move = useMoveBoardCard();
  const [menuTarget, setMenuTarget] = useState<BoardMenuTarget>(null);
  // The same target, readable SYNCHRONOUSLY. Base UI decides whether to open from
  // inside the very dispatch the keyboard route records in, so the open gate below
  // can't wait for this render's state to commit.
  const menuTargetRef = useRef<BoardMenuTarget>(null);
  // True from the moment the menu opens until its close has fully SETTLED, which
  // is why the completion callback owns the falling edge: Base UI returns focus to
  // the trigger from the popup's unmount cleanup, and that unmount is what fires
  // `onOpenChangeComplete(false)` — a focus claim raised any earlier is undone by
  // the return.
  const [menuBusy, setMenuBusy] = useState(false);
  // The itemId the cursor is chasing through a move, and the last place it was
  // chased to. Two landings per move at most — the optimistic patch, then a
  // rollback if the write fails — and the stamp is what keeps a settle from
  // re-claiming focus on a card the cursor already sits on.
  const [chase, setChase] = useState<string | null>(null);
  const chasedRef = useRef("");
  const chasePos = chase === null ? null : findCard(columns, chase);
  const chaseCol = chasePos?.col ?? null;
  const chaseIdx = chasePos?.idx ?? null;
  const movePending = move.isPending;
  useEffect(() => {
    if (chase === null || menuBusy) return;
    const settled = !movePending;
    if (chaseCol === null || chaseIdx === null) {
      // The board stopped drawing the card — a regroup, a project switch, or a
      // refetch that dropped it. Disarming on settle is what keeps a chase that
      // can never land from re-scanning the columns on every render.
      if (settled) setChase(null);
      return;
    }
    const stamp = `${chase}@${chaseCol}:${chaseIdx}`;
    if (chasedRef.current === stamp) {
      if (settled) setChase(null);
      return;
    }
    // A frame past the unmount that released `menuBusy`, so the claim lands after
    // the focus return rather than under it.
    const frame = requestAnimationFrame(() => {
      chasedRef.current = stamp;
      setCursor({ col: chaseCol, idx: chaseIdx });
      setFocusNonce((n) => n + 1);
      if (settled) setChase(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [chase, chaseCol, chaseIdx, menuBusy, movePending]);

  // Ranked like the field editor's own holds, and for the same reasons — the two
  // surfaces gate on the same flags, so they say it the same way. The last two arms
  // rank at the tail because they are the only ones that clear on their own.
  const moveHeldReason = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      case groupField !== null && groupField.isIssueField:
        return ISSUE_FIELD_REASON;
      // Below the three permission arms, which are true whatever is on screen,
      // and above the two that clear on their own: the cards drawn while a lens
      // loads are the PREVIOUS view's, so the column a pick names isn't the one
      // the board is about to have.
      case lensLoading:
        return LENS_LOADING_REASON;
      case movePending:
        return MOVING_REASON;
      // A move's own `cancelQueries` REVERTS an in-flight fetch (query-core cancels
      // with `revert: true` by default), so starting one now would silently undo
      // the page the user just asked for.
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  })();

  /** Record what a menu opened over `el` would act on, and report whether that is
   *  anything at all. Null — and so no menu — for board chrome and empty column
   *  space, for a redacted card (nothing to open, nothing to move), and for a draft
   *  on an UNGROUPED board, whose Open row and Move section are both absent. */
  function recordMenuTarget(el: Element | null): boolean {
    const at = el === null ? null : cardAt(el);
    const item = at === null ? undefined : columns[at.col]?.items[at.idx];
    // The cursor moves to whatever was pressed, a suppressed menu included, so the
    // board's selection and the menu describe the same card (the Actions and
    // History lists select their pressed row the same way). The nonce stays put:
    // this sets where the arrows resume, never where focus goes.
    if (at !== null && item !== undefined) setCursor(at);
    const kind = item?.content.kind;
    const next: BoardMenuTarget =
      at === null ||
      item === undefined ||
      kind === "redacted" ||
      (kind === "draft" && groupField === null)
        ? null
        : {
            item,
            // The card's VALUE, read the way the bucketing reads it. An unset field
            // names the catch-all; a stored option the field no longer defines
            // names a column that isn't drawn, which is what leaves the clear row
            // live for the one card that needs it.
            valueColumnId:
              groupField === null
                ? UNSET_COLUMN_ID
                : (optionIdFor(item, groupField) ?? UNSET_COLUMN_ID),
          };
    menuTargetRef.current = next;
    setMenuTarget(next);
    return next !== null;
  }

  /** Every pointer route into the menu passes here first. Base UI opens a TOUCH
   *  menu from its own long-press timer without ever dispatching `contextmenu`, so
   *  pointerdown is the one gesture both routes share — recording anywhere else
   *  leaves a long press showing the previously right-clicked card's menu. */
  function handleCardPointerDown(e: PointerEvent) {
    recordMenuTarget(e.target instanceof Element ? e.target : null);
  }

  /** The mouse and keyboard route. Re-records because Shift+F10 and the Menu key
   *  reach here with no pointerdown ahead of them. */
  function handleCardContextMenu(e: MouseEvent) {
    // Element-wide, not HTMLElement: a card's state/draft/lock glyphs are SVG, and
    // a right-click landing on one is a right-click on the card — narrowing here
    // reads those hits as empty space and suppresses the menu over a real card.
    if (!recordMenuTarget(e.target instanceof Element ? e.target : null))
      suppressContextMenu(e);
  }

  /** Write the grouped field so `item` lands in `columns[columnIndex]`. The
   *  catch-all column stands for the ABSENCE of a value, so it clears the field
   *  rather than setting an option. */
  function moveCard(item: BoardItem, columnIndex: number) {
    const column = columns[columnIndex];
    if (groupField === null || projectId === null || column === undefined)
      return;
    // Belt-and-braces with the rows' own `disabled`: the hold is derived at render,
    // and a pick racing the render that sets it must not get through either.
    if (moveHeldReason !== undefined) return;
    const option = groupField.options.find((o) => o.id === column.id) ?? null;
    setChase(item.itemId);
    // The board AND the lens this move belongs to travel WITH it: an offline move
    // parks before the write and resumes on whatever render is current by then,
    // and `onMutate` pins this lens's key into the context its rollback and its
    // settle read — so switching views mid-flight needs no hold of its own.
    move.mutate({
      repo: repoPath,
      projectId,
      itemId: item.itemId,
      field: groupField,
      option,
      query: lensQuery,
    });
  }

  // Ranked, because the popup can be opened before the fields read settles and
  // an UNSETTLED read is not the same claim as a settled empty one. Claiming "no
  // single-select fields" while the read is still in flight is a false
  // statement, not a placeholder.
  const fieldsPending = canRead && projectId !== null && fields.isPending;
  const groupHeldReason = (() => {
    switch (true) {
      case fieldsPending:
        return LOADING_FIELDS_REASON;
      // Ahead of the settled-empty claim: a FAILED read is neither pending nor
      // holding data, so without this arm a board whose fields call errored
      // would announce that it defines none. Gated on having NOTHING to offer,
      // because a background refetch failure leaves the cached definitions in
      // place — and those are the definitions drawing the board behind this
      // popup, so replacing the rows with a failure would be false.
      case fields.error !== null && groupFields.length === 0:
        return FIELDS_ERROR_REASON;
      case groupFields.length === 0:
        return NO_GROUP_FIELDS_REASON;
      default:
        return undefined;
    }
  })();
  // Ranked like the Group-by section's reason: unsettled reads first, the
  // ABSENCE claim last and only from a settled board. Two reads rank here, not
  // one — the seed-input arms below say why the FIELDS read holds these rows.
  // A refetch that failed over a list already on screen takes none of these
  // arms, since those views loaded fine and the switcher is the only way back
  // to No view from inside this popup.
  const viewsPending = canRead && projectId !== null && views.isPending;
  const viewsHeldReason = (() => {
    switch (true) {
      case viewsPending:
        return LOADING_VIEWS_REASON;
      // The next two arms hold on the SEED'S INPUT, not on the views: `pickView`
      // reads `groupFields` at pick time, once, with no later retry. Views and
      // fields are independent `gh` calls that settle in either order, so a pick
      // made while the definitions are still absent finds none, skips the seed
      // silently, and leaves the view's own grouping unapplied when they land —
      // whether they land from the first read or from the notice's Retry after it
      // failed. Holding the rows is what keeps the one-shot event safe without
      // deferring it into effect machinery. Both arms test the ABSENCE of
      // definitions, never a stale flag: cached ones can seed, so neither a
      // background refetch nor a failure over them may take the rows away.
      case fieldsPending:
        return VIEWS_AWAIT_FIELDS_REASON;
      case fields.error !== null && fields.data === undefined:
        return VIEWS_FIELDS_FAILED_REASON;
      case views.error !== null && viewList.length === 0:
        return VIEWS_ERROR_REASON;
      case viewList.length === 0:
        return NO_VIEWS_REASON;
      default:
        return undefined;
    }
  })();
  // Names the radio group; its checked row supplies the value half of the
  // reading, so no id on the control itself.
  const groupLabelId = useId();
  const viewLabelId = useId();
  const portalContainer = usePanelPortalContainer();
  const projectTitles: Record<string, string> = {};
  for (const p of openProjects) projectTitles[p.id] = p.title;

  // Cards already on screen outlive a failed read. A next-page failure, a failed
  // refetch, or a fields read that died after the board painted all leave the
  // items that DID arrive in place and say what went wrong beside them — the
  // error card is for having nothing to show, not for having stale-but-real
  // cards.
  const hasPages = (items.data?.pages.length ?? 0) > 0;
  const fatalError = hasPages
    ? null
    : (projects.error ?? fields.error ?? items.error);
  // ONE name for "the items read hasn't settled", shared by the skeleton gate
  // and the count beside it. Two expressions of the same condition would drift,
  // and this is the pair that must not: a count is an ASSERTION about the board,
  // so it may never state a number the read hasn't produced.
  const itemsPending = canRead && projectId !== null && items.isPending;
  // A DISABLED query is permanently "pending", so every loading test is gated on
  // the read actually being live — otherwise a GitLab repo would load forever.
  // The FIELDS leg matters as much as the items one: without it the board paints
  // ungrouped for a frame and then re-lays out into columns as the definitions
  // land.
  const loading =
    (canRead && projects.isPending) || fieldsPending || itemsPending;
  // An empty catalog is only an ABSENCE claim when the read was complete: a
  // capped catalog (or one whose owner arm was denied) can come back empty while
  // boards exist, and "there are none" would be a lie about a set we didn't
  // finish searching.
  const catalogTruncated = projects.data?.truncated === true;
  // `isFetchNextPageError` is query-core's own discrimination (`isError &&
  // fetchMeta.fetchMore.direction === "forward"`), which is what tells a dead
  // CONTINUATION apart from a dead initial load. Paired with `hasPages` so a
  // failure that left cards on screen never blanks them.
  const pageError = hasPages && items.isFetchNextPageError && items.error;
  // What keeps Load more MOUNTED through a lens switch. `hasNextPage` is computed
  // from the query's own `state.data`, which a placeholder never fills — the
  // substitution writes the result's local `data` alone — so it reads false for
  // the whole switch however many pages are on screen (query-core 5.102.8:
  // `hasNextPage(options, state.data)`, and `if (!data) return false`). Those
  // cards ARE the previous lens's pages, so its last page is what says whether
  // there is more under them, tested exactly as `getNextPageParam` does.
  const placeholderPage = lensLoading ? items.data?.pages.at(-1) : undefined;
  const heldNextPage =
    placeholderPage?.truncated === true && placeholderPage.endCursor !== null;
  // Load more is held for ANY in-flight items fetch, not just a continuation.
  // `fetchNextPage` defaults to query-core's `cancelRefetch: true`, so clicking
  // during the reconciliation refetch that an in-app edit triggered CANCELS that
  // refetch and appends a fresh page onto the stale ones — and the append's own
  // success then clears `isInvalidated`, stamping the stale cards provably fresh
  // for the rest of the staleTime window. Measured against query-core 5.102.8.
  // Each reason is its own wait, because they mean different things to the user.
  const loadMoreHeld = (() => {
    switch (true) {
      // Ahead of every fetch arm: the pages on screen are the previous lens's, so
      // a continuation now would extend a board this view is about to replace.
      // `heldNextPage` above is what leaves the control mounted to say so.
      case lensLoading:
        return LENS_LOADING_REASON;
      case items.isFetchingNextPage:
        return "Loading more items…";
      case items.isFetching:
        return "Refreshing the board…";
      // The mirror of the menu's own page-fetch hold, and the same mechanism read
      // from the other side: a move's settle cancels this query's family to force
      // the reconciliation, and query-core's cancel REVERTS whatever is in flight —
      // so a continuation started during the write window would be thrown away
      // between its request and the pages it was meant to extend.
      case movePending:
        return "Finishing your last card move…";
      // The post-failure half of the same hazard. A REFRESH that failed leaves
      // the pre-edit pages on screen with the invalidation still owed, and both
      // fetching guards above have released. Appending a continuation onto those
      // pages would succeed, and that success clears the error AND the
      // invalidation — stamping a stale board provably fresh for the rest of the
      // staleTime window. Only the full refetch behind the strip's Retry can
      // clear it, which is why this points there. A failed CONTINUATION is
      // excluded: those pages were never invalidated, so retrying the page is
      // exactly the right move.
      case items.isError && !items.isFetchNextPageError:
        return "The board's last refresh failed. Retry the refresh before loading more.";
      default:
        return undefined;
    }
  })();
  // Once cards are on screen, EVERY failed read is non-fatal: it earns a line in
  // the in-flow strip with its own retry wired to its own refetch, rather than
  // vanishing behind a board that silently renders ungrouped or stale. Exactly
  // one visible recovery path per failed read, which is why the items arm
  // excludes a CONTINUATION failure — that one is recovered at Load more.
  const liveNotices: {
    key: string;
    what: string;
    message: string;
    retry: () => void;
  }[] = [];
  if (hasPages) {
    if (projects.error !== null)
      liveNotices.push({
        key: "projects",
        what: "the project list",
        message: presentError(projects.error).summary,
        retry: () => void projects.refetch(),
      });
    if (fields.error !== null)
      liveNotices.push({
        key: "fields",
        what: "this board's fields",
        message: presentError(fields.error).summary,
        retry: () => void fields.refetch(),
      });
    // Beside the fields read, which is the other board-level one and the read the
    // switcher's own hold points at. The popover names the failure where the rows
    // would be; the recovery control is here, like every other failed read's.
    if (views.error !== null)
      liveNotices.push({
        key: "views",
        what: "this board's saved views",
        message: presentError(views.error).summary,
        retry: () => void views.refetch(),
      });
    if (items.error !== null && !items.isFetchNextPageError)
      liveNotices.push({
        key: "items",
        what: "this board's items",
        message: presentError(items.error).summary,
        retry: () => void items.refetch(),
      });
  }

  const body = (() => {
    switch (true) {
      // A failed forge probe is not "still detecting": without this arm the
      // panel sits on a skeleton forever and nothing on screen can refetch it.
      case gh.error !== null:
        return <ErrorCard error={gh.error} onRetry={() => void gh.refetch()} />;
      // Still detecting: `gh.data` undefined is not yet "not GitHub".
      case gh.data === undefined:
        return <BoardSkeleton />;
      // A KNOWN other provider is the one thing this tab can name precisely, so
      // it is checked ahead of the not-ready ladder: telling a GitLab user to
      // install `glab` would walk them toward a feature GitLab doesn't have.
      case provider !== null && !isGitHub:
        return (
          <BoardNotice>
            <p>
              This repository is on {providerLabel(provider)} — Projects boards
              are a GitHub feature.
            </p>
          </BoardNotice>
        );
      // provider `null` ALSO means gh isn't installed, isn't signed in, or can't
      // resolve this remote — "no GitHub remote" misdiagnosed all three and
      // offered no way out. The shared ladder names the real blocker and pairs
      // it with the action that clears it, exactly as the Issues / Discussions /
      // Actions tabs do.
      case !forgeReady(gh.data):
        return <ForgeNotReady repoPath={repoPath} feature="project boards" />;
      case scopeGap:
        return (
          // ScopeGapBlock carries POPUP padding (px-1 py-1) — it was written for
          // the Projects picker's popover. This is a full-pane state, so the call
          // site makes up the difference: px-2 py-3 here lands it on the px-3 py-4
          // the sibling arms use, without touching a component two other surfaces
          // share.
          <div className="px-2 py-3">
            <ScopeGapBlock
              host={host}
              onReconnect={() =>
                openReconnect({
                  provider: "github",
                  host,
                  mode: "refresh",
                  scopes: ["project"],
                })
              }
            >
              {/* Names BOTH scopes the read accepts, matching the detector:
                  `projectScopeMissing` only fires when a classic token has
                  neither. The reconnect below asks for `project`, which is the
                  one that also permits the writes the pickers offer. */}
              Reading project boards needs the{" "}
              <span className="font-mono">project</span> or{" "}
              <span className="font-mono">read:project</span> scope, and your
              GitHub sign-in has neither.
            </ScopeGapBlock>
          </div>
        );
      case fatalError !== null:
        return (
          <ErrorCard
            error={fatalError}
            onRetry={() => {
              if (projects.error !== null) void projects.refetch();
              if (fields.error !== null) void fields.refetch();
              if (items.error !== null) void items.refetch();
            }}
          />
        );
      case loading:
        return <BoardSkeleton />;
      // A capped or half-answered catalog can be empty while boards exist, so
      // the definitive "there are none" is held back for a complete read and the
      // hedged wording names what wasn't searched.
      case projectId === null && catalogTruncated:
        return (
          <BoardNotice>
            <p>
              No open project came back for this repository or its owner, but
              the list was cut short, so there may be more.
            </p>
            <p>Open the owner's Projects page on GitHub to see all of them.</p>
          </BoardNotice>
        );
      case projectId === null:
        return (
          <BoardNotice>
            <p>
              A GitHub Project is a board that gathers issues and pull requests
              (from this repository and others) into columns you define.
            </p>
            <p>
              Neither this repository nor its owner has an open one yet. Start
              one on GitHub and it appears here.
            </p>
          </BoardNotice>
        );
      // A filter that matched nothing is a different statement from an empty
      // board, and only the settled read may make it — the cards standing while
      // a lens loads are the previous view's. An unfiltered view can't reach
      // here: its empty board is the board's own, and the columns say so.
      case view !== null &&
        lensQuery !== null &&
        !lensLoading &&
        hasPages &&
        loaded.length === 0:
        return (
          <BoardNotice>
            <p>No items match this view's filter.</p>
            <p className="font-mono break-all">{lensQuery}</p>
            <p>
              <ClearViewButton onClear={clearView} />
            </p>
          </BoardNotice>
        );
      default:
        return (
          // ONE menu for the whole board rather than a portal per card: a
          // virtualized row that scrolls out would otherwise leave a popup
          // anchored to a detached node. The capture handler runs before Base
          // UI's own trigger handler, so the target is recorded — or the menu
          // suppressed — before it opens.
          <ContextMenu
            onOpenChange={(open, details) => {
              // The one gate BOTH routes pass. A long press opens from the
              // trigger's own timer and dispatches no `contextmenu`, so the
              // capture-phase suppression can't reach it; `cancel()` refuses the
              // change before Base UI mounts the popup, which is what keeps an
              // empty one off the screen rather than flashing it closed. The mouse
              // route never gets here — its suppression already stopped the event.
              if (open && menuTargetRef.current === null) {
                details.cancel();
                return;
              }
              if (open) setMenuBusy(true);
            }}
            onOpenChangeComplete={setMenuBusy}
          >
            <MenuLatchRelease setMenuBusy={setMenuBusy} setChase={setChase} />
            <ContextMenuTrigger
              render={
                // One horizontal scroll region for the whole board; each column
                // owns its own vertical one.
                <div
                  className="flex min-h-0 flex-1 gap-2 overflow-x-auto"
                  onKeyDown={onBoardKeyDown}
                  onPointerDownCapture={handleCardPointerDown}
                  onContextMenuCapture={handleCardContextMenu}
                />
              }
            >
              {columns.map((column, i) => (
                <BoardColumn
                  key={column.id}
                  column={column}
                  columnIndex={i}
                  activeIndex={liveCursor?.col === i ? liveCursor.idx : null}
                  tabStopIndex={tabStop?.col === i ? tabStop.idx : null}
                  focusNonce={focusNonce}
                  repoSlug={repoSlug}
                  ghHost={ghHost}
                  chipFields={chipFields}
                  onCardFocus={onCardFocus}
                  onOpen={openItem}
                />
              ))}
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-56">
              <BoardCardMenuItems
                target={menuTarget}
                // An ungrouped board has one column standing for the whole
                // board, which is no move target at all.
                columns={groupField === null ? [] : columns}
                openLabel={openLabelFor(menuTarget?.item, repoSlug)}
                heldReason={moveHeldReason}
                actions={{
                  open: () => {
                    if (menuTarget !== null) openItem(menuTarget.item);
                  },
                  move: (columnIndex) => {
                    if (menuTarget !== null)
                      moveCard(menuTarget.item, columnIndex);
                  },
                }}
              />
            </ContextMenuContent>
          </ContextMenu>
        );
    }
  })();

  const showBoardChrome = isGitHub && !scopeGap && projectId !== null;
  const cappedNotes: string[] = [];
  if (catalogTruncated)
    cappedNotes.push("Some of this owner's projects aren't listed above.");
  if (fields.data?.truncated === true)
    cappedNotes.push("Some of this board's fields aren't offered above.");
  return (
    // `h-full`, not `min-h-0 flex-1`: the content pane (<main>) is a BLOCK box,
    // so a flex-item sizing chain never engages there and this root would take
    // its content's height — unbounding every column's scroller and leaving the
    // virtualizers rendering every row. `min-h-0 flex-1` is the SIDEBAR idiom
    // (that aside really is a flex column); the content-pane idiom is this one
    // (RemoteIssueView, RemotePrView, DiffViewer).
    <div className="flex h-full flex-col p-2">
      {project !== null && (
        <h2 className="sr-only">{project.title} project board</h2>
      )}
      {showBoardChrome && (
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
          <Select
            items={projectTitles}
            value={projectId}
            onValueChange={(v) => {
              setPickedProjectId(v);
              // The new board defines its own fields, and the cursor addresses
              // columns that are about to be replaced.
              setPickedFieldId(null);
              // A lens belongs to the board it was picked on. Leaving the id set
              // reads as "no view" on any other board, but returning to this one
              // would find it again and re-apply its filter, sort and chips
              // WITHOUT the grouping seed, which only `pickView` performs.
              setActiveViewId(null);
              setCursor(null);
            }}
          >
            <SelectTrigger size="sm" aria-label="Project" className="max-w-64">
              <SelectValue onMouseEnter={clipTitleFromText} />
            </SelectTrigger>
            <SelectContent>
              {openProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <SelectClipText>{p.title}</SelectClipText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Every control that shapes HOW the board is laid out lives behind
              this one trigger, so later slices add rows here rather than more
              toolbar chrome. The project switcher stays outside it: a project
              title already says what it is. */}
          <Popover.Root>
            <Popover.Trigger
              render={
                <Button variant="outline" size="sm" className="ml-auto" />
              }
            >
              <FadersHorizontalIcon data-icon="inline-start" />
              View options
            </Popover.Trigger>
            <Popover.Portal container={portalContainer}>
              <Popover.Positioner
                align="end"
                sideOffset={4}
                className="isolate z-50"
              >
                <Popover.Popup className="w-72 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                  {/* The caption IS the popup's accessible name: Popup takes its
                      `aria-labelledby` from whatever Title registers, and a bare
                      element leaves the dialog unnamed. `render` keeps it a <p> —
                      Title's own default element is an <h2>. */}
                  <Popover.Title
                    render={<p />}
                    className="px-1 pb-1.5 text-xs font-medium"
                  >
                    View options
                  </Popover.Title>
                  {/* One section per view control; later slices add their own
                      beside this one, so the section shape is the contract.
                      INLINE rows, never a nested popup: a Select in here
                      portalled out to the panel container, and floating-ui's
                      `absolute` strategy then measured against one offset parent
                      and resolved against another — the popup landed ~750px
                      right of its trigger and horizontally scrolled the whole app
                      shell to reach it (measured live). A radio group has no
                      positioning machinery to get wrong, and it is what a
                      one-of-many choice already is. */}
                  <div className="space-y-2">
                    <div className="space-y-1">
                      {/* Names the GROUP the same way the section below does: the
                          label plus the checked row reads as "View …, No view,
                          selected". */}
                      <p
                        id={viewLabelId}
                        className="px-1 text-xs text-muted-foreground"
                      >
                        View
                      </p>
                      {viewsHeldReason !== undefined ? (
                        <p className="px-1 py-1 text-xs text-muted-foreground">
                          {viewsHeldReason}
                        </p>
                      ) : (
                        <>
                          <RadioGroup
                            // Scrolls at its own edge: the server offers up to 50
                            // views, and a popup that tall would run off screen.
                            className="max-h-56 gap-0 overflow-y-auto"
                            aria-labelledby={viewLabelId}
                            value={view?.id ?? NO_VIEW_ROW_ID}
                            onValueChange={(next) => {
                              // Base UI types the group's value as `any`; the
                              // guard narrows it back to the row ids these rows
                              // carry.
                              if (typeof next !== "string") return;
                              pickView(next === NO_VIEW_ROW_ID ? null : next);
                            }}
                          >
                            <label className={GROUP_ROW_CLASS}>
                              <Radio value={NO_VIEW_ROW_ID} />
                              <span className="min-w-0 truncate">No view</span>
                            </label>
                            {viewList.map((v) => (
                              <label key={v.id} className={GROUP_ROW_CLASS}>
                                <Radio value={v.id} />
                                <span
                                  className="min-w-0 truncate"
                                  onMouseEnter={clipTitleFromText}
                                >
                                  {v.name === "" ? UNTITLED_VIEW : v.name}
                                </span>
                                {/* The layout the view was saved in, where it
                                    isn't the one this board draws — the row says
                                    so up front rather than leaving the strip to
                                    explain it after the pick. */}
                                {VIEW_LAYOUT_WORD[v.layout] !== undefined && (
                                  <span className="shrink-0 text-muted-foreground">
                                    {VIEW_LAYOUT_WORD[v.layout]}
                                  </span>
                                )}
                              </label>
                            ))}
                          </RadioGroup>
                          {/* Inside the rows' own branch: the note captions the
                              LIST, so a held section has nothing for it to
                              caption. */}
                          {views.data?.truncated === true && (
                            <p className="px-1 text-[11px] text-muted-foreground">
                              {VIEWS_TRUNCATED_NOTE}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <div className="space-y-1">
                      {/* Names the GROUP, which is what carries the meaning here:
                          the label plus the checked row reads as "Group by …,
                          Status, selected". */}
                      <p
                        id={groupLabelId}
                        className="px-1 text-xs text-muted-foreground"
                      >
                        Group by
                      </p>
                      {groupHeldReason !== undefined || groupField === null ? (
                        // Nothing to choose from, so the reason IS the content
                        // rather than a hidden note on an empty control — the
                        // field editor's own empty-option-set shape, and it keeps
                        // the ranked wording (an unsettled read is not the same
                        // claim as a settled empty one).
                        <p className="px-1 py-1 text-xs text-muted-foreground">
                          {groupHeldReason ?? NO_GROUP_FIELDS_REASON}
                        </p>
                      ) : (
                        // Applies on change — no draft, no commit-on-close; the
                        // popup stays open so the board can be re-grouped without
                        // reopening it. `gap-0` only: the rows carry their own
                        // padding.
                        <RadioGroup
                          className="gap-0"
                          aria-labelledby={groupLabelId}
                          value={groupField.id}
                          onValueChange={(next) => {
                            // Base UI types the group's value as `any`; the
                            // guard is what narrows it back to the field id
                            // these rows actually carry.
                            if (typeof next !== "string") return;
                            setPickedFieldId(next);
                            setCursor(null);
                          }}
                        >
                          {groupFields.map((f) => (
                            <label key={f.id} className={GROUP_ROW_CLASS}>
                              <Radio value={f.id} />
                              <span
                                className="min-w-0 truncate"
                                onMouseEnter={clipTitleFromText}
                              >
                                {f.name}
                              </span>
                            </label>
                          ))}
                        </RadioGroup>
                      )}
                    </div>
                  </div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {/* No number until the read has produced one. "0 items" is a CLAIM
                about the board, and neither unsettled state has earned it: still
                loading gets the skeleton, and failed-with-nothing-loaded gets
                nothing at all, because the error card below already says what
                happened and a zero beside it would read as the answer. A count
                taken off another lens's cards is the same false claim, so a lens
                still loading takes the skeleton too. */}
            {(() => {
              switch (true) {
                case itemsPending || lensLoading:
                  return <Skeleton className="h-4 w-20" aria-hidden />;
                case !hasPages:
                  return null;
                default:
                  return (
                    <span className="tabular-nums">
                      {items.hasNextPage
                        ? `${shown} of ${totalCount} items`
                        : `${shown} ${shown === 1 ? "item" : "items"}`}
                    </span>
                  );
              }
            })()}
            {/* A failed CONTINUATION says so HERE, beside the control that
                caused it, and leaves the loaded board alone. `refetch()` would
                replay every page already on screen; `fetchNextPage()` retries
                only the one that failed. */}
            {pageError && (
              <span className="text-destructive">
                {presentError(items.error).summary}
              </span>
            )}
            {(items.hasNextPage || pageError || heldNextPage) && (
              <DisabledReasonButton
                variant="outline"
                size="xs"
                disabled={loadMoreHeld !== undefined}
                reason={loadMoreHeld}
                onClick={() => {
                  // Belt-and-braces with the `disabled` above: the held state is
                  // derived at render, and a click racing the render that sets it
                  // must not get through either.
                  if (items.isFetching || movePending || lensLoading) return;
                  void items.fetchNextPage();
                }}
              >
                {pageError ? "Try again" : "Load more"}
              </DisabledReasonButton>
            )}
          </div>
        </div>
      )}
      {/* In the layout FLOW, pushing the board down — a persistent claim about
          what this surface is showing must never float over its chrome. Failed
          reads come first (they are actionable), then the caps; both caps can be
          on at once and each names a different list, so they are joined rather
          than ranked. */}
      {showBoardChrome &&
        (liveNotices.length > 0 || cappedNotes.length > 0) && (
          <div className="mb-2 shrink-0 space-y-1 border-b pb-1.5 text-[11px]">
            {liveNotices.map((notice) => (
              <p
                key={notice.key}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="text-destructive">{notice.message}</span>
                <button
                  type="button"
                  aria-label={`Retry loading ${notice.what}`}
                  onClick={notice.retry}
                  className="cursor-pointer text-muted-foreground underline hover:text-foreground"
                >
                  Retry
                </button>
              </p>
            ))}
            {cappedNotes.length > 0 && (
              <p className="text-muted-foreground">{cappedNotes.join(" ")}</p>
            )}
          </div>
        )}
      {/* The lens the board is under, in the layout FLOW like the notices above
          it — a persistent claim about what this surface is showing may never
          float over its chrome. Below them on purpose: a failed read is
          actionable, this is a statement. */}
      {showBoardChrome && view !== null && (
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b pb-1.5 text-[11px] text-muted-foreground">
          <span
            className="min-w-0 max-w-64 truncate font-medium text-foreground"
            onMouseEnter={clipTitleFromText}
          >
            {view.name === "" ? UNTITLED_VIEW : view.name}
          </span>
          {FLAT_FALLBACK_NOTE[view.layout] !== undefined && (
            <span>{FLAT_FALLBACK_NOTE[view.layout]}</span>
          )}
          {lensQuery !== null && (
            <span className="flex min-w-0 items-center gap-1">
              Filter:
              <span
                className="min-w-0 truncate font-mono"
                onMouseEnter={clipTitleFromText}
              >
                {lensQuery}
              </span>
            </span>
          )}
          <ClearViewButton onClear={clearView} />
        </div>
      )}
      {body}
    </div>
  );
}
