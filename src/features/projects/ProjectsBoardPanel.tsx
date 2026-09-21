import { Popover } from "@base-ui/react/popover";
import { FadersHorizontalIcon, PlusIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
// The read-only sentence arrives ALIASED: this panel says it about the BOARD, and
// its own `READ_ONLY_SCOPE_REASON` below says a different thing about a card's
// FIELDS. Two claims that happen to share a scope, so only the first is shared.
import {
  READ_ONLY_SCOPE_REASON as BOARD_READ_ONLY_SCOPE_REASON,
  NO_ACCESS_REASON,
  projectScopeMissing,
  projectScopeReadOnly,
  ScopeGapBlock,
} from "@/features/conversations/ProjectsPopover";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import { clipTitleFromText } from "@/lib/clip-title";
import { suppressContextMenu } from "@/lib/context-menu";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost, useForgeGhHost } from "@/lib/git/host";
import type { BoardMoveBucket, BoardWriteKind } from "@/lib/git/queries";
import {
  forgeReady,
  useAddDraftItem,
  useAddExistingToBoard,
  useArchiveBoardItem,
  useAvailableProjects,
  useConvertDraftItem,
  useForgeStatus,
  useGhScopes,
  useMoveBoardCard,
  usePendingBoardWrites,
  useProjectFields,
  useProjectItems,
  useProjectViews,
  useRemoveBoardItem,
  useReorderBoardCard,
  useRestoreBoardItem,
  useUpdateDraftItem,
} from "@/lib/git/queries";
import {
  type BoardCandidate,
  type BoardItem,
  type BoardItemContent,
  type ProjectFieldDef,
  type ProjectViewDef,
  providerLabel,
} from "@/lib/git/types";
import { eventToBinding } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useRemoteSlug, useRepoLens } from "@/lib/repo-lens/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { type RepoTab, useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { AddExistingItemsDialog, NewDraftDialog } from "./BoardAddDialogs";
import { BoardCardMenuItems, type BoardMenuTarget } from "./BoardCardMenu";
import { BoardColumn } from "./BoardColumn";
import { BoardDraftEditDialog } from "./BoardDraftEditDialog";
import {
  ARCHIVED_CARD_REASON,
  ARCHIVED_SHOWN_REASON,
  type BoardColumnModel,
  bucketIdFor,
  buildColumns,
  CARD_WRITE_REASON,
  chipFieldDefs,
  firstCardPosition,
  type GroupField,
  groupableFields,
  lensSorted,
  SORTED_VIEW_REASON,
  sortColumnItems,
  TRUNCATED_ORDER_REASON,
  UNSET_COLUMN_ID,
} from "./board-model";
import {
  planReorder,
  type ReorderDirection,
  type ReorderPlan,
} from "./board-positioning";

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
  "This project has no single-select or iteration fields to group its board by";
const LOADING_FIELDS_REASON = "Loading this project's fields…";
const FIELDS_ERROR_REASON = "Couldn't load this project's fields";
/** The next three mirror the field editor's own wording verbatim: each surface
 *  gates on the same flag as the row it mirrors, and the two must not say it
 *  differently (ProjectFieldsEditor.tsx). */
const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read project fields but not change them (needs the project scope)";
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
/** The number here is the BACKEND's cap, not this file's choice: `project_views.rs`
 *  asks GitHub for `views(first: 50)` and reports the overflow as `truncated`.
 *  Neither side may change alone — a wider query with this sentence left behind
 *  would state a limit the read no longer has. */
const VIEWS_TRUNCATED_NOTE = "Showing the first 50 views.";
/** A view GitHub reports with no name. */
const UNTITLED_VIEW = "Untitled view";
/** The two LABELLED halves of the board-write family, as the panel's gates read
 *  them: a card write can collide with another write to the same CARD (so the menu
 *  rows hold on each other), where an add touches no existing card and holds only
 *  pagination. The split lives here as a lookup over {@link BoardWriteKind}, which
 *  is all the mutation key carries. Neither set is exhaustive — a kind in neither
 *  still counts as a board write for pagination, and says so generically. */
const CARD_WRITE_KINDS: ReadonlySet<BoardWriteKind> = new Set([
  "move",
  "reorder",
  "convert",
  "archive",
  "restore",
  "remove",
  "edit-draft",
]);
const ADD_WRITE_KINDS: ReadonlySet<BoardWriteKind> = new Set([
  "add-existing",
  "add-draft",
]);

/** The board's dialogs, one open at a time. Two put work ON the board; the third
 *  rewrites a draft already there, and is reached from that card's menu. */
type BoardDialog = "existing" | "draft" | "edit-draft";

/** Single-writer: two writes to one card's field settle in an order nothing
 *  promises, and an EARLIER move failing late puts the card back in a column a
 *  later write already moved it out of. */
const MOVING_REASON = "Moving your last card…";
/** An archive is reversible and a removal is not, so the two prompts say different
 *  things, and a removal says a third for a draft, which lives on this project alone
 *  and has nowhere to survive. Every one names where the card goes rather than asking
 *  the user to infer it — which is why this one is keyed on whether archived cards
 *  are SHOWN: with the toggle off the card leaves the columns, with it on it stays
 *  put under an Archived badge. */
const ARCHIVE_BODY: Record<"shown" | "hidden", string> = {
  hidden:
    "The card leaves the board. Bring it back any time from View options → Show archived cards.",
  shown:
    "The card stays in place, marked Archived, and leaves the board when you turn Show archived cards off. Restore card brings it back.",
};
const REMOVE_BODY: Record<BoardItemContent["kind"], string> = {
  draft:
    "This deletes the draft permanently — drafts live on this project and nowhere else.",
  issue:
    "The card leaves this project. The issue itself is untouched, and you can add it back later.",
  pullRequest:
    "The card leaves this project. The pull request itself is untouched, and you can add it back later.",
  redacted:
    "The card leaves this project. The item itself is untouched, and you can add it back later.",
};
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
/** Zero-width space, built from its code point rather than written literally so no
 *  invisible byte sits in source. Toggled into the live region to force a
 *  textContent change when an announcement repeats. */
const ZWSP = String.fromCharCode(0x200b);
/** The switcher row's muted qualifier, for the layouts that aren't this one. */
const VIEW_LAYOUT_WORD: Partial<Record<ProjectViewDef["layout"], string>> = {
  table: "table",
  roadmap: "roadmap",
};
/** The board's reposition chords, as CANONICAL bindings (`eventToBinding`'s own
 *  spelling). Alt+Arrow moves the CARD where the bare arrow moves the cursor, and
 *  Alt+Home/End are that column's ends — the same pairing the bare keys already
 *  keep. Feature-local rather than registry bindings: what makes these safe is
 *  that focus is on a card, which is a DOM question only this handler can ask. */
const REORDER_CHORDS: Partial<Record<string, ReorderDirection>> = {
  "alt+up": "up",
  "alt+down": "down",
  "alt+home": "top",
  "alt+end": "bottom",
};
/** Where the optimistic splice leaves the card, as an index in its own column: the
 *  grouping field is untouched by a reposition, so the card never changes column
 *  and the landing is arithmetic rather than a search. */
const REORDER_LANDING: Record<
  ReorderDirection,
  (index: number, count: number) => number
> = {
  up: (index) => index - 1,
  down: (index) => index + 1,
  top: () => 0,
  bottom: (_index, count) => count - 1,
};
/** Placeholder plans for a menu whose card the board no longer draws — never
 *  rendered, since that case shows the single {@link CARD_GONE_REASON} held row
 *  instead of the per-direction rows, but the prop is a total Record. */
const NO_REORDER: Record<ReorderDirection, ReorderPlan> = {
  up: { kind: "noop" },
  down: { kind: "noop" },
  top: { kind: "noop" },
  bottom: { kind: "noop" },
};
/** Why the Position section is held when the menu's card has left the board (a
 *  refetch dropped it while the menu was open). One held row, not four "already
 *  first"/"already last" rows that would contradict each other. */
const CARD_GONE_REASON = "This card is no longer on the board";
/** One shared id for every reorder-refusal toast: key auto-repeat drives the burst
 *  (no e.repeat gate), so a held direction would otherwise mint a fresh toast per
 *  repeat — sonner updates the one in place instead. Only one refusal is on screen
 *  at a time, so a single id is correct. */
const REORDER_REFUSAL_TOAST_ID = "board-reorder-refused";

/**
 * One card per membership, LAST occurrence winning, applied where the pages flatten
 * into the board. Every insert path inherits it by sitting here rather than in one
 * writer.
 *
 * A write-through insert appends the minted card to the last LOADED page of a board
 * whose server tail isn't loaded yet; `Load more` then fetches a tail that carries
 * the same membership. Two copies of one `itemId` would mean duplicate React keys
 * and two menu and move targets for one card.
 *
 * LAST wins because the later copy is the SERVER's: fresher, and at the board
 * position the server puts it in, where the appended one sits wherever the insert
 * could safely put it. Keeping the last occurrence's own slot is what moves the card
 * to its real place the moment a real page supersedes the optimistic copy.
 */
function oneCardPerItem(items: BoardItem[]): BoardItem[] {
  const lastAt = new Map<string, number>();
  items.forEach((item, i) => lastAt.set(item.itemId, i));
  return items.filter((item, i) => lastAt.get(item.itemId) === i);
}

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
 *  `selectIssue`/`openPr` hand over a bare number the destination resolves under
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

/** The move target a column id names under `field`: that field's own option or
 *  iteration. Null for the catch-all — and for any id the field no longer defines,
 *  which is the same statement, since the catch-all is where such a card is drawn. */
function moveBucketFor(field: GroupField, columnId: string): BoardMoveBucket {
  if (field.kind === "singleSelect") {
    const option = field.options.find((o) => o.id === columnId);
    return option === undefined ? null : { kind: "option", option };
  }
  const iteration = [...field.iterations, ...field.completedIterations].find(
    (i) => i.id === columnId,
  );
  return iteration === undefined ? null : { kind: "iteration", iteration };
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
 * single-select or iteration fields, with one write — a card's context menu moves it
 * between the columns of that grouping.
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
  const openPr = useUiStore((s) => s.openPr);
  const repoName = useUiStore((s) => s.repoName);
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
  // closest thing to the same promise. Single-selects are preferred over an
  // iteration field declared ahead of them for exactly that reason: a board opened
  // for the first time should show the columns it is usually read in, and grouping
  // by iteration is a thing to ask for rather than to land on.
  const defaultField =
    groupFields.find((f) => f.name === "Status") ??
    groupFields.find((f) => f.kind === "singleSelect") ??
    groupFields[0] ??
    null;
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

  // Transient like the grouping and the view above it: what a user looked at once
  // doesn't become a stored preference. An identity axis on the read, so the board
  // on screen stays put while the both-states read lands.
  const [showArchived, setShowArchived] = useState(false);
  const items = useProjectItems(
    repoPath,
    projectId ?? "",
    lensQuery,
    canRead && projectId !== null,
    showArchived,
  );
  // The cards on screen belong to the PREVIOUS lens until this clears, so every
  // claim derived from them waits: the count, Load more, and the move rows.
  const lensLoading = items.isPlaceholderData;
  const loaded = oneCardPerItem(
    items.data?.pages.flatMap((page) => page.items) ?? [],
  );
  // The view's sort orders cards WITHIN a column, so it applies after bucketing —
  // which column a card lands in is the grouping's answer alone. With no sort the
  // columns are untouched, board POSITION order and all.
  const grouped = buildColumns(loaded, groupField, showArchived);
  const columns = lensSorted(view)
    ? grouped.map((column) => ({
        ...column,
        items: sortColumnItems(column.items, view.sortBy, fieldDefs),
      }))
    : grouped;
  // Identity-stable for the memoized cards: a fresh array per render would
  // re-render every mounted card whenever the keyboard cursor moves. Every input
  // is stable in its own right — the query's own array or the shared empty, and
  // two values derived off it — so the dep list is the real one.
  const chipFields = useMemo(
    () => chipFieldDefs(view, fieldDefs, groupField),
    [view, fieldDefs, groupField],
  );
  // Counts the cards the board DRAWS, so it agrees with the column headers;
  // `totalCount` is the READ's own figure and matches that read's filter, archived
  // state included (measured 2026-09-21), which is why it only ever appears as the
  // "of M" of a partly-loaded board.
  const shown = columns.reduce((n, column) => n + column.items.length, 0);
  const totalCount = items.data?.pages.at(-1)?.totalCount ?? shown;

  // The keyboard cursor, plus a nonce that bumps ONLY on an arrow press — the
  // columns move DOM focus off the nonce, never off the cursor, so a click or a
  // tab into the board can set the cursor without yanking focus around.
  const [cursor, setCursor] = useState<{ col: number; idx: number } | null>(
    null,
  );
  const [focusNonce, setFocusNonce] = useState(0);
  // WHICH card the current nonce means, or null where the claim is about a SLOT
  // rather than a card (the landing after a card leaves the board). Set at every
  // nonce bump and nowhere else — the columns resolve a focus claim by index, and
  // an index alone can resolve to the neighbour while an optimistic reorder is
  // still a frame from the DOM.
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  // What the KEYBOARD route just did, or why it refused. Only that route needs a
  // voice: the menu's rows carry their reasons on themselves, and a card moving
  // under the pointer is its own feedback. The seq bumps on every announce so an
  // identical message (the same held reason twice, or the same "N of M") still
  // changes the live region's textContent and re-announces — a plain equal set
  // would be a no-op the screen reader never hears.
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  const announce = useCallback(
    (text: string) => setAnnouncement((prev) => ({ text, seq: prev.seq + 1 })),
    [],
  );
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
    // `groupableFields` set the Group-by rows offer — which is the board's
    // single-selects AND its iteration fields, so a view grouped either way seeds.
    // A table view groups by nothing, and a view grouped by anything else (a
    // multi-select, an issue field) leaves the current grouping alone.
    const vgroup = picked?.verticalGroupFieldIds[0];
    if (vgroup !== undefined && groupFields.some((f) => f.id === vgroup))
      setPickedFieldId(vgroup);
    // The columns are about to hold a different set of cards.
    setCursor(null);
  }

  /** Show or hide the board's archived cards. A different set of cards either way,
   *  so the cursor can't address what it was on. Takes the state it is going TO
   *  rather than flipping what it finds: the checkbox row reports the value it now
   *  holds, and an idempotent setter can't be double-applied by one click. */
  function setArchivedShown(next: boolean) {
    setShowArchived(next);
    setCursor(null);
  }

  // Palette-only, and live only where it can do something: a board on screen
  // with a view on it.
  useHotkeyAction("clear-project-view", clearView, active && view !== null);
  // Palette-only for the same reason — its checkbox sits in the same popover — and
  // live wherever there is a board to toggle it on.
  useHotkeyAction(
    "toggle-archived-cards",
    () => setArchivedShown(!showArchived),
    canRead && projectId !== null,
  );

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
        if (content.kind === "issue") {
          selectIssue({ kind: "remote", id });
          setRepoTab(target.tab);
          return;
        }
        // The PR arm takes the store's navigator, which lands the tab itself and
        // arms the align the Pulls list needs — a board carries merged and closed
        // cards, and those can't show on the Open tab. `opensInApp` already pinned
        // the card to the repo the ACTIVE lens points at, so no lens write.
        openPr({
          kind: "remote",
          repoPath,
          repoName: repoName ?? repoNameFromPath(repoPath),
          ref: id,
          section: null,
        });
        return;
      }
      void openUrl(
        `https://${host}/${content.repoNameWithOwner}/${target.webPath}/${content.number}`,
      ).catch(toastError);
    },
    [host, openPr, repoName, repoPath, repoSlug, selectIssue, setRepoTab],
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
    // The reposition chords BEFORE the bare-key switch below, which tests `e.key`
    // alone: the same four keys move the CURSOR unmodified and the CARD with Alt
    // held, so a chord must never fall through to the plain key's arm. Matched on
    // the canonical binding rather than the raw flags, which is what makes Ctrl,
    // Cmd and Shift exclude themselves and AltGraph read as the character input it
    // is (`eventToBinding` answers null there). Everything else falls through
    // untouched.
    const chord = eventToBinding(e);
    const direction = chord === null ? undefined : REORDER_CHORDS[chord];
    if (direction !== undefined) {
      e.preventDefault();
      reorderCard(from, direction);
      return;
    }
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
    setFocusItemId(columns[next.col].items[next.idx]?.itemId ?? null);
    setFocusNonce((n) => n + 1);
  }

  // The board's writes. ONE instance each — the single-flight contract the menu
  // rows state — but their `isPending` flags are NOT what gates anything here: a
  // mutation observer tracks only its LATEST invocation, and these flows
  // deliberately allow a second over a first (an Esc'd draft whose write continues
  // while the reopened dialog submits another, consecutive add-existing picks). A
  // newer invocation settling first would drop the older one's flag and un-hold
  // everything while it was still in flight.
  const move = useMoveBoardCard();
  // The one exception to the single-flight contract above, and it owns its own:
  // repeated presses are the point, so the hook coalesces them per card rather
  // than the panel holding the route.
  const reorder = useReorderBoardCard();
  const convertDraft = useConvertDraftItem();
  const updateDraft = useUpdateDraftItem();
  const archiveItem = useArchiveBoardItem();
  const restoreItem = useRestoreBoardItem();
  const removeItem = useRemoveBoardItem();
  // The add writes live HERE rather than inside the dialogs that fire them, so the
  // board can say what is in flight: a dialog closed mid-write would otherwise take
  // the only record of it with it.
  const addExisting = useAddExistingToBoard();
  const addDraft = useAddDraftItem();
  // So every gate, label and busy mark below derives from a snapshot COMPUTED off
  // the mutation cache on each render, which holds every in-flight invocation
  // whatever any observer is tracking, and matches this board by each write's own
  // call-time `variables.repo` — this panel is ONE instance across repo switches,
  // and it goes away under `<Activity>` without unmounting, so neither the repo nor
  // a write that settled while the tab was hidden may reach the UI through anything
  // a subscription had to be alive to record. One read feeds all of them; the
  // counts are just this list, filtered.
  const pendingWrites = usePendingBoardWrites(repoPath);
  const movePending = pendingWrites.some((w) => w.kind === "move");
  const cardWritePending = pendingWrites.some(
    (w) => w.kind !== null && CARD_WRITE_KINDS.has(w.kind),
  );
  // The draft dialog's single-flight gate. Its own form can't provide one: the
  // component persists across close/reopen, so an Esc'd submit and a later one share
  // a form instance whose `isSubmitting` the FIRST settle clears unconditionally —
  // re-enabling Create over a write still in flight. The cache knows about every
  // invocation, so the hold is derived from that instead.
  const draftWritePending = pendingWrites.some((w) => w.kind === "add-draft");
  const addPending = pendingWrites.some(
    (w) => w.kind !== null && ADD_WRITE_KINDS.has(w.kind),
  );
  // The one card a write changes IN PLACE. An archive and a removal take their card
  // off the board outright, so the card's absence is already their feedback and
  // there is nothing left to mark; a convert and a draft edit both rewrite the
  // content under a card that stays put, which is the case that needs saying. The
  // FIRST such write: the menu holds every card row while one runs, so a second is
  // unreachable in practice, and the column prop stays the primitive its memo
  // compares.
  const busyItemId =
    pendingWrites.find((w) => w.kind === "convert" || w.kind === "edit-draft")
      ?.itemId ?? null;
  /** The card whose details peek is open, or null. Board-wide rather than per-card
   *  so only one is ever open, and held HERE because both routes into it are — the
   *  card's own Space key, and the menu row the panel owns. A card that leaves the
   *  board takes its popup with it (the popover renders inside the card), so a stale
   *  id here draws nothing and the next peek replaces it. */
  const [peekItemId, setPeekItemId] = useState<string | null>(null);
  /** Which of the board's dialogs is open, or null for none. One at a time: they
   *  all write to the same board, and the toolbar and the card menu offer them as
   *  alternatives. */
  const [addDialog, setAddDialog] = useState<BoardDialog | null>(null);
  /** What the edit dialog is editing, recorded at the MENU CLICK. Held by the panel
   *  for the reason the session token below is: the dialog stays mounted across
   *  open and close and replays its effects on an `<Activity>` show, so a starting
   *  value it worked out for itself would describe whatever card it last saw. */
  const [editing, setEditing] = useState<{
    itemId: string;
    /** The DRAFT's own content id — what the write addresses. */
    draftId: string;
    title: string;
    body: string;
    assigneeLogins: string[];
  } | null>(null);
  /** Which run of an add dialog is current. A write can outlive the dialog that
   *  fired it (the panel owns the mutation, so Esc leaves it going), and this is
   *  what tells a resolution whether the dialog it was started from is still the
   *  one on screen — without it, a stale success closes whichever dialog the user
   *  opened next and the reopen-reset discards what was typed into it.
   *
   *  Bumped only from the EVENT that actually moves `addDialog`, never from an
   *  effect keyed on the dialog's own props: `<Activity>` replays effect setups on
   *  show and runs their cleanups on hide, so a token maintained that way churns on
   *  tab switches and retires sessions no user action ended. (The one effect that
   *  bumps it is a real retirement and guards on the value having changed.) */
  const dialogSessionRef = useRef(0);

  /** Open or close one of the board's dialogs, retiring whatever session was
   *  running. Every transition goes through here so the token can't drift from the
   *  state. */
  function switchAddDialog(next: BoardDialog | null) {
    dialogSessionRef.current += 1;
    setAddDialog(next);
  }
  const [menuTarget, setMenuTarget] = useState<BoardMenuTarget>(null);
  // The same target, readable SYNCHRONOUSLY. Base UI decides whether to open from
  // inside the very dispatch the keyboard route records in, so the open gate below
  // can't wait for this render's state to commit.
  const menuTargetRef = useRef<BoardMenuTarget>(null);
  // Scopes the one DOM lookup this panel makes for focus (the emptied-board
  // landing) to THIS board: several repo tabs mount their own panel, and a
  // document-wide query would hand focus to another one's toolbar.
  const rootRef = useRef<HTMLDivElement>(null);
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
  // EVERY write this board can fire, which is the set whose settle
  // cancel-invalidates its reads. Named apart from `cardWritePending` because the
  // two answer different questions: that one asks whether a write could collide
  // with another write to the same CARD, this one whether a page fetch started now
  // would be thrown away at settle. An add collides with no existing card, but its
  // settle cancels the same reads, so pagination has to wait on it too.
  const boardWritePending = pendingWrites.length > 0;
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
      // The chased card itself: the index came from finding it in these columns.
      setFocusItemId(chase);
      setFocusNonce((n) => n + 1);
      if (settled) setChase(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [chase, chaseCol, chaseIdx, menuBusy, movePending]);

  // The card an archive or a removal took off the board, and where it sat. The
  // ABSENCE of it from the columns is the arming edge, not the write settling: the
  // write settles, THEN the invalidation's refetch lands, and only that redraw says
  // the board agrees. A failed refetch leaves the card drawn and this latched, so
  // the dead arm below disarms it rather than re-scanning the columns every render.
  const [retired, setRetired] = useState<{
    itemId: string;
    col: number;
    idx: number;
  } | null>(null);
  const retiredGone =
    retired !== null && findCard(columns, retired.itemId) === null;
  const retiredDead = retired !== null && items.isError && !items.isFetching;
  // The third way a retirement never lands: the tab goes away before the settle
  // refetch, which takes the board's reads `enabled` false and parks them. That
  // one can't be an arm beside `retiredDead` — `<Activity>` DEFERS this panel's
  // effects while hidden, so a dep-driven arm wouldn't run until the show replay,
  // by which time `active` is true again and the latch reads live. The cleanup is
  // what actually fires on hide, and a retirement belongs to the visit that caused
  // it: focus landing on a board the user came back to minutes later is a steal,
  // and a null latch is what stops the scan below running behind a hidden panel.
  // `setRetired` is useState's own, so the effect runs once and only its cleanup
  // does the work — the shape {@link MenuLatchRelease} uses for the menu's latches.
  useEffect(() => () => setRetired(null), []);
  // Where focus goes once the card is gone: its own slot in the column it left,
  // clamped to whatever still stands there, and the board's first card when that
  // column emptied. Derived here so the effect's deps are the primitives that
  // actually decide the landing, not a freshly built columns array.
  const landing = (() => {
    if (!retiredGone || retired === null) return null;
    const left = columns[retired.col]?.items.length ?? 0;
    return left > 0
      ? { col: retired.col, idx: Math.min(retired.idx, left - 1) }
      : firstCardPosition(columns);
  })();
  const landingCol = landing?.col ?? null;
  const landingIdx = landing?.idx ?? null;
  useEffect(() => {
    if (!retiredGone && !retiredDead) return;
    if (!retiredGone) {
      setRetired(null);
      return;
    }
    if (landingCol === null || landingIdx === null) {
      // No card left anywhere to stand on — the removal emptied the board, or
      // emptied what this view's filter draws of it. The cursor has nothing to
      // address, and DOM focus has to be MOVED rather than merely released: the
      // confirm dialog restores focus to the row that fired it, which unmounted
      // with the card, so leaving it alone drops a keyboard user to <body>. The
      // toolbar's Add item is where the board's own recovery starts and is the
      // nearest thing still standing, so focus lands there, a frame past the
      // dialog's own restore.
      //
      // The latch is released INSIDE the frame, never beside it: `setRetired`
      // flips `retiredGone`, which is one of this effect's deps, so clearing it
      // here would re-run the effect and fire the cleanup below — cancelling the
      // very frame that does the work. The move's chase keeps its own release in
      // its callback for the same reason. That leaves the cleanup owning the
      // cancel for the cases it should: an unmount, an `<Activity>` hide, or a
      // card arriving that gives the cursor a real landing after all.
      setCursor(null);
      const frame = requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector<HTMLElement>("[data-board-add-trigger]")
          ?.focus();
        setRetired(null);
      });
      return () => cancelAnimationFrame(frame);
    }
    setRetired(null);
    setCursor({ col: landingCol, idx: landingIdx });
    // A SLOT, not a card: the landing is wherever the departed card's place fell
    // to, so the claim is index-only by design.
    setFocusItemId(null);
    setFocusNonce((n) => n + 1);
  }, [retiredGone, retiredDead, landingCol, landingIdx]);

  // The menu's own retirement site, the discipline the stale-view-id effect keeps:
  // a SETTLED list that no longer draws the recorded card is the only thing that
  // may retire it, so a pending or failed read touches nothing. Without it the
  // latch holds a card that has left the board, and the next menu opened from the
  // keyboard would act on a dead reference.
  const menuItemId = menuTarget?.item.itemId ?? null;
  const menuItemGone =
    menuItemId !== null &&
    items.data !== undefined &&
    !items.isFetching &&
    findCard(columns, menuItemId) === null;
  useEffect(() => {
    if (!menuItemGone) return;
    menuTargetRef.current = null;
    setMenuTarget(null);
  }, [menuItemGone]);

  // The add dialogs' retirement site. `projectId` is DERIVED, not stored — a
  // catalog refetch that drops the picked board re-points it to the first one
  // going, with nothing on screen saying so — and an open dialog would go on
  // adding under the previous board's title, against the new board's id. A
  // deliberate switch can't reach here (the Select sits behind the dialog's own
  // backdrop), so a change while one is open is always that silent re-point, and
  // closing is the only honest answer: the pick behind the dialog is gone.
  //
  //  The one effect allowed to retire a session, because the ref-compare below
  //  means it acts ONLY on a real change of `projectId` — an `<Activity>` show
  //  replays this setup with the same value and it returns before touching
  //  anything.
  const dialogProjectRef = useRef(projectId);
  // `switchAddDialog` is re-made every render, so it rides a `useEffectEvent`
  // rather than the dep list: listing it would re-run this on every render (the
  // ref-compare would refuse, but the effect is meant to fire on a board change
  // alone), and a dep-suppression is the thing this repo replaced with this hook.
  const retireAddDialog = useEffectEvent(() => switchAddDialog(null));
  useEffect(() => {
    if (dialogProjectRef.current === projectId) return;
    dialogProjectRef.current = projectId;
    retireAddDialog();
  }, [projectId]);

  /** Why `item` can't be moved between columns, or undefined when it can. Ranked
   *  like the field editor's own holds, and for the same reasons — the two surfaces
   *  gate on the same flags, so they say it the same way. The last two arms rank at
   *  the tail because they are the only ones that clear on their own. */
  function moveHeldFor(item: BoardItem): string | undefined {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      // Iteration fields have no issue-field arm at all — GitHub defines none at
      // the org level — so this asks only of the kind that can carry one.
      case groupField?.kind === "singleSelect" && groupField.isIssueField:
        return ISSUE_FIELD_REASON;
      // Under the three arms above, which say a move is impossible HERE whatever the
      // card is: an archived card sits in no column, so a column pick has nothing to
      // write — and the restore row is what clears this one.
      case item.isArchived:
        return ARCHIVED_CARD_REASON;
      // Above the two that clear on their own: the cards drawn while a lens loads
      // are the PREVIOUS view's, so the column a pick names isn't the one the board
      // is about to have.
      case lensLoading:
        return LENS_LOADING_REASON;
      case movePending:
        return MOVING_REASON;
      case cardWritePending:
        return CARD_WRITE_REASON;
      // A move's own `cancelQueries` REVERTS an in-flight fetch (query-core cancels
      // with `revert: true` by default), so starting one now would silently undo
      // the page the user just asked for.
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  }
  /** Why the menu's whole write block is held — the draft rows as well as
   *  archive-or-restore and remove. Ranked like the move rows, and the first two arms
   *  are the SAME permission flags — but the grouping arms are absent: these address
   *  the membership's item id alone, so an ungrouped board and a GitHub-owned
   *  grouping field hold neither of them. So does a lens still loading: the card
   *  under the pointer was recorded off the cards on screen, and its item id is its
   *  item id whichever view drew it. The ARCHIVED arm is absent too, and lives in
   *  {@link cardEditHeldFor} instead: it must hold the draft rows while leaving the
   *  restore live, which is the one thing an archived card's menu is opened for. */
  const cardActionHeldReason = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return BOARD_READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      case movePending:
        return MOVING_REASON;
      case cardWritePending:
        return CARD_WRITE_REASON;
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  })();
  /** Why a DRAFT's edit and convert rows are held for this card. The card-action
   *  ranking plus the archived arm the two removals deliberately skip: both of these
   *  rewrite what the card IS, which an archived card is in no state to accept, and
   *  the restore row beside them is the way to that state. */
  function cardEditHeldFor(item: BoardItem): string | undefined {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return BOARD_READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      case item.isArchived:
        return ARCHIVED_CARD_REASON;
      case movePending:
        return MOVING_REASON;
      case cardWritePending:
        return CARD_WRITE_REASON;
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  }
  /** Why `item` can't be repositioned, or undefined when it can. Per CARD rather
   *  than board-wide, and it deliberately ignores a reposition already in flight on
   *  that card: the mutation coalesces those itself, which is what makes a burst of
   *  presses land. Any OTHER write to the same card does hold — a convert or a
   *  draft edit rewrites the very card a position would address.
   *
   *  Ranked like the card actions: the permission arms first (true whatever is on
   *  screen), then the three ways the drawn column isn't the board's own order, then
   *  the two that clear on their own. */
  function reorderHeldFor(item: BoardItem): string | undefined {
    const itemId = item.itemId;
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return BOARD_READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      // An archived card holds no place in the project's order, so there is no slot
      // for a position write to move it between.
      case item.isArchived:
        return ARCHIVED_CARD_REASON;
      // Every OTHER card is held too while archived ones are drawn: GitHub refuses
      // an archived item as a position anchor, so a card's drawn neighbour is not
      // necessarily one a write may land it after, and the plan the menu shows would
      // be computed against a column the board can't address.
      case showArchived:
        return ARCHIVED_SHOWN_REASON;
      // A sorted view draws the columns in the SORT's order, so the board's own
      // position sequence — the only thing a position write addresses — isn't what
      // is on screen, and a card would land somewhere the user never saw.
      case lensSorted(view):
        return SORTED_VIEW_REASON;
      case lensLoading:
        return LENS_LOADING_REASON;
      case pendingWrites.some(
        (w) =>
          w.itemId === itemId &&
          w.kind !== null &&
          w.kind !== "reorder" &&
          CARD_WRITE_KINDS.has(w.kind),
      ):
        return CARD_WRITE_REASON;
      // A reposition settles through the same cancel every board write does, and
      // query-core's cancel REVERTS an in-flight fetch — so starting one now would
      // silently undo the page the user just asked for.
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  }

  /** Why the toolbar's Add item is held. The same two permission arms the card
   *  actions take, plus the page-fetch one for the same reason a move takes it —
   *  an add's settle cancels this board's reads, and query-core's cancel REVERTS
   *  an in-flight one. A card write already running holds nothing here: the two
   *  address different items, and the dialogs are their own surface. */
  const addHeldReason = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return BOARD_READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  })();

  /** Record what a menu opened over `el` would act on, and report whether that is
   *  anything at all. Null — and so no menu — for board chrome and empty column
   *  space alone: every CARD now carries rows of its own. A redacted item and a
   *  draft on an ungrouped board used to have an empty menu and so no menu; archive
   *  and remove reach both off the membership's item id, which is a thing the
   *  viewer can do about a card whose content they may not even read. */
  function recordMenuTarget(el: Element | null): boolean {
    const at = el === null ? null : cardAt(el);
    const item = at === null ? undefined : columns[at.col]?.items[at.idx];
    // The cursor moves to whatever was pressed, a suppressed menu included, so the
    // board's selection and the menu describe the same card (the Actions and
    // History lists select their pressed row the same way). The nonce stays put:
    // this sets where the arrows resume, never where focus goes.
    if (at !== null && item !== undefined) setCursor(at);
    const next: BoardMenuTarget =
      at === null || item === undefined
        ? null
        : {
            item,
            // The card's VALUE, read the way the bucketing reads it. An unset field
            // names the catch-all; a stored option or iteration the field no longer
            // defines names a column that isn't drawn, which is what leaves the
            // clear row live for the one card that needs it.
            valueColumnId:
              groupField === null
                ? UNSET_COLUMN_ID
                : (bucketIdFor(item, groupField) ?? UNSET_COLUMN_ID),
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
    if (moveHeldFor(item) !== undefined) return;
    const bucket = moveBucketFor(groupField, column.id);
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
      bucket,
      query: lensQuery,
      archived: showArchived,
    });
  }

  /** The ids the position math reads: the project's own global order as the board
   *  has loaded it, minus the ARCHIVED cards. GitHub refuses an archived item as a
   *  position anchor ("The item to be positioned after is archived and cannot be
   *  used to update the position of this item", VALIDATION, measured 2026-09-19),
   *  and archived cards interleave freely on a real board — so filtering here is
   *  what makes every anchor the plan can emit positionable by construction. The
   *  landing then walks back to the nearest non-archived predecessor, which is the
   *  same slot the board and github.com both draw. */
  function loadedOrder(): string[] {
    return loaded.filter((card) => !card.isArchived).map((card) => card.itemId);
  }

  /** The last loaded page's own flag: with more pages behind it, the column's real
   *  tail may not be on screen. */
  function pagesTruncated(): boolean {
    return items.data?.pages.at(-1)?.truncated ?? false;
  }

  /** What each direction would do to the card at `from`, for the menu's rows. */
  function reorderPlansFor(from: {
    col: number;
    idx: number;
  }): Record<ReorderDirection, ReorderPlan> {
    const shared = {
      order: loadedOrder(),
      column: columns[from.col]?.items.map((card) => card.itemId) ?? [],
      index: from.idx,
      truncated: pagesTruncated(),
    };
    return {
      up: planReorder({ ...shared, direction: "up" }),
      down: planReorder({ ...shared, direction: "down" }),
      top: planReorder({ ...shared, direction: "top" }),
      bottom: planReorder({ ...shared, direction: "bottom" }),
    };
  }

  /** Move the card at `from` inside its own column, writing the project's global
   *  order. The gates are re-checked here rather than trusted from whatever fired:
   *  the chord and the palette both reach this with no row to disable, and a press
   *  racing the render that derived a hold must not get through either. */
  function reorderCard(
    from: { col: number; idx: number },
    direction: ReorderDirection,
  ) {
    const column = columns[from.col];
    const item = column?.items[from.idx];
    if (column === undefined || item === undefined || projectId === null)
      return;
    // A held reason is surprising on a keyboard/palette route with no row to grey
    // out, so it both announces (SR) and toasts (sighted). The truncated-loaded-end
    // hold below is the same class and gets the same pair.
    const held = reorderHeldFor(item);
    if (held !== undefined) {
      announce(held);
      toast(held, { id: REORDER_REFUSAL_TOAST_ID });
      return;
    }
    const plan = planReorder({
      order: loadedOrder(),
      column: column.items.map((card) => card.itemId),
      index: from.idx,
      direction,
      truncated: pagesTruncated(),
    });
    // A boundary no-op announces (SR) but does NOT toast: the card visibly not
    // moving is feedback enough for a sighted user, and a toast per blocked arrow
    // would be noise. Up/top hit the column's first card, down/bottom its last.
    if (plan.kind === "noop") {
      announce(
        direction === "up" || direction === "top"
          ? "Already first"
          : "Already last",
      );
      return;
    }
    if (plan.kind === "held") {
      announce(TRUNCATED_ORDER_REASON);
      toast(TRUNCATED_ORDER_REASON, { id: REORDER_REFUSAL_TOAST_ID });
      return;
    }
    // The board and the lens this write belongs to travel WITH it, the rule
    // `moveCard` states: `onMutate` pins this lens's key into the context its
    // rollback and its settle read.
    reorder.mutate({
      repo: repoPath,
      projectId,
      itemId: item.itemId,
      afterId: plan.afterId,
      query: lensQuery,
      archived: showArchived,
    });
    // The cursor rides the card to where the optimistic splice puts it; the
    // column's own focus machinery does the rest off the nonce. The moved card's
    // id travels with it — that splice lands a frame or two later, so until it
    // does the new index still resolves to the neighbour being swapped past.
    const idx = REORDER_LANDING[direction](from.idx, column.items.length);
    setCursor({ col: from.col, idx });
    setFocusItemId(item.itemId);
    setFocusNonce((n) => n + 1);
    announce(
      `Moved to ${idx + 1} of ${column.items.length} in ${column.label}`,
    );
  }

  /** Put one searched issue or pull request on the board. Owned here rather than in
   *  the dialog so the pending strip can see it, and so the toast names the board
   *  from the same place every other message about it does. Reports whether it
   *  landed: the dialog flips its row on `true` and leaves it pickable on `false`.
   *
   *  Never optimistic, and never fabricated: the card the board draws is the one
   *  GitHub answered the write with, patched in at the settle, so the ids the menu
   *  and the move path target are server-minted. The strip covers the window before
   *  that answer arrives. */
  async function addExistingToBoard(
    candidate: BoardCandidate,
  ): Promise<boolean> {
    if (projectId === null || project === null) return false;
    try {
      await addExisting.mutateAsync({
        repo: repoPath,
        projectId,
        contentId: candidate.id,
        number: candidate.number,
      });
    } catch {
      // The mutation reported it; the row stays pickable so a retry is one Enter
      // away.
      return false;
    }
    // Neutral on purpose: under a filtered view the item may not appear in the
    // columns at all, so this says what happened rather than where to look for it.
    // The card itself lands with the write's own answer, so nothing here has to
    // account for a read lagging behind it.
    toast.success(`Added to ${project.title}`);
    return true;
  }

  /** Add a draft note to the board. Owned here for the same reasons as the add
   *  above; the dialog keeps the form and closes itself on `true`. */
  async function createDraft(title: string, body: string): Promise<void> {
    if (projectId === null || project === null) return;
    // The session this write belongs to, read before the round trip. The CLOSE is
    // performed here rather than by the dialog because only this side outlives the
    // dialog: the write keeps going through an Esc, a board re-point that remounts
    // the dialogs, and an `<Activity>` hide, and in every one of those the question
    // "is the run that started this still on screen?" is answered by state the
    // panel holds.
    const session = dialogSessionRef.current;
    try {
      await addDraft.mutateAsync({ repo: repoPath, projectId, title, body });
    } catch {
      // The mutation reported it. Nothing closes, so the dialog stays open over the
      // draft and the text isn't lost to a failed write.
      return;
    }
    toast.success(`Draft added to ${project.title}`);
    // Only the run that fired this may be closed by it. A stale token means the
    // user has since closed, reopened, or been moved to another dialog — closing
    // then would shut whatever is open now and discard what was typed into it.
    if (session === dialogSessionRef.current) switchAddDialog(null);
  }

  /** Open the edit dialog on a draft card, recording what it starts from HERE, at
   *  the click. The dialog holds none of this: it stays mounted across open and
   *  close, and an `<Activity>` show replays its effects, so a value it derived for
   *  itself would outlive the card it came from. */
  function openDraftEdit(item: BoardItem) {
    // Belt-and-braces with the row's own hold, which is derived at render.
    if (cardEditHeldFor(item) !== undefined) return;
    if (item.content.kind !== "draft") return;
    setEditing({
      itemId: item.itemId,
      draftId: item.content.id,
      title: item.content.title,
      body: item.content.body,
      assigneeLogins: item.content.assignees.map((a) => a.login),
    });
    switchAddDialog("edit-draft");
  }

  /** Write a draft's edit. Owned here for the same reasons the adds are: the write
   *  outlives the dialog, and only this side can say whether the run that fired it
   *  is still the one on screen. `assigneeLogins` arrives `undefined` when the dialog
   *  saw no change to the picker, which leaves the draft's assignees untouched rather
   *  than replacing them with what the capped board read seeded. */
  async function saveDraftEdit(
    title: string,
    body: string,
    assigneeLogins: string[] | undefined,
  ): Promise<void> {
    // Read before the round trip, like every other target here: a render landing
    // mid-flight must not change what the write addressed.
    const target = editing;
    if (target === null) return;
    const session = dialogSessionRef.current;
    try {
      await updateDraft.mutateAsync({
        repo: repoPath,
        itemId: target.itemId,
        draftId: target.draftId,
        title,
        body,
        assigneeLogins,
      });
    } catch {
      // The mutation reported it. Nothing closes, so the dialog stays open over the
      // edit and the text isn't lost to a failed write.
      return;
    }
    // The card behind the dialog may be scrolled out of its column, so the write
    // says so itself rather than leaving the patched card to be the only word.
    toast.success("Draft updated");
    // Only the run that fired this may be closed by it. A stale token means the user
    // has since closed, reopened, or been moved to another dialog.
    if (session === dialogSessionRef.current) switchAddDialog(null);
  }

  /** Turn a draft card into a real issue in the repo this lens points at. The card
   *  keeps its item id and its place; only its content changes, so nothing here
   *  retires a cursor. */
  async function convertCard(item: BoardItem) {
    // Every read this needs happens BEFORE the first await, so a render landing
    // under the prompt can't change what the write addresses. Belt-and-braces with
    // the row's own hold, which is derived at render.
    if (cardEditHeldFor(item) !== undefined) return;
    if (item.content.kind !== "draft") return;
    const target = repoSlug ?? "this repository";
    const ok = await useConfirm.getState().ask({
      title: "Convert this draft to an issue?",
      body: `Creates a real issue in ${target} from the draft's title and notes, and swaps the card over to it. The draft itself is gone once it lands.`,
      confirmLabel: "Convert",
    });
    if (!ok) return;
    try {
      const { number, url } = await convertDraft.mutateAsync({
        repo: repoPath,
        itemId: item.itemId,
        lens,
      });
      toast.success(`Converted to issue #${number}`, {
        description: url,
        action: { label: "View", onClick: () => openUrl(url) },
      });
    } catch {
      // The mutation reported it; the card is untouched and the row is live again.
    }
  }

  /** Archive or remove a card, and hand the keyboard somewhere it can still stand.
   *  Both writes address the membership's item id alone, which is what lets them
   *  reach a redacted card the viewer can't otherwise act on. */
  async function retireCard(item: BoardItem, action: "archive" | "remove") {
    if (cardActionHeldReason !== undefined || projectId === null) return;
    // Read before the prompt: where the card sits is what the cursor lands beside
    // once the refetch drops it, and the board can re-draw while the prompt is up.
    const at = findCard(columns, item.itemId);
    // Reversible and irreversible read differently, so each names where the card
    // goes; the removal's own body then differs again by what the card HOLDS,
    // since a draft has nowhere else to survive.
    const prompt = {
      archive: {
        title: "Archive this card?",
        body: ARCHIVE_BODY[showArchived ? "shown" : "hidden"],
        confirmLabel: "Archive",
      },
      remove: {
        title: "Remove this card from the project?",
        body: REMOVE_BODY[item.content.kind],
        confirmLabel: "Remove",
        confirmVariant: "destructive" as const,
      },
    }[action];
    const ok = await useConfirm.getState().ask(prompt);
    if (!ok) return;
    // Armed BEFORE the write, not after it. The write's own `onMutate` patches the
    // card out within a microtask, so the cursor has to follow it THERE — waiting
    // for the round trip would leave the keyboard parked on a card that is already
    // off the board for seconds. The latch still only lands when the columns stop
    // drawing the card, which is the effect's own gate.
    //
    // And only where the card really LEAVES them: with archived cards shown, an
    // archive keeps it in its slot under an Archived badge, so the cursor has
    // nothing to follow and a latch that can never land would re-scan the columns
    // on every render until the tab went away.
    const leaves = action === "remove" || !showArchived;
    setRetired(at === null || !leaves ? null : { itemId: item.itemId, ...at });
    // `wasArchived` rides the write because it is a COUNT axis the cache key can't
    // supply: a removal takes nothing from a live-only lens's total when the card had
    // already left that count at archive time. Read off the card the menu recorded,
    // like every other value here.
    const vars = {
      repo: repoPath,
      projectId,
      itemId: item.itemId,
      wasArchived: item.isArchived,
    };
    try {
      if (action === "archive") await archiveItem.mutateAsync(vars);
      else await removeItem.mutateAsync(vars);
    } catch {
      // The mutation reported it and its rollback put the card back. The cursor
      // has already moved to the neighbour by then — a restored card doesn't pull
      // focus back, since the user's attention is on the message saying why.
    }
  }

  /** Put an archived card back on the board. No prompt: the ARCHIVE is the step that
   *  asked, and this is the reversal it promised. Nothing retires a cursor either —
   *  the card keeps its slot and only stops being archived, which the toggle that
   *  drew it goes on showing.
   *
   *  GitHub's single-state reads lag this write by seconds either way, so the write
   *  settles by re-asserting its own answer rather than re-reading — the card stops
   *  being archived on the spot and stays that way. */
  async function restoreCard(item: BoardItem) {
    if (cardActionHeldReason !== undefined || projectId === null) return;
    try {
      await restoreItem.mutateAsync({
        repo: repoPath,
        projectId,
        itemId: item.itemId,
      });
    } catch {
      // The mutation reported it, and its rollback put the card back under the
      // Archived badge it came in with.
    }
  }

  // Ranked, because the popup can be opened before the fields read settles and
  // an UNSETTLED read is not the same claim as a settled empty one. Claiming the
  // board defines no groupable field while the read is still in flight is a false
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
      // from the other side: EVERY write here settles by cancelling this query's
      // family to force the reconciliation, and query-core's cancel REVERTS
      // whatever is in flight — so a continuation started during any write's window
      // would be thrown away between its request and the pages it was meant to
      // extend. One arm per kind rather than one shared sentence: the wait is the
      // same, but what the user is waiting ON is not.
      case movePending:
        return "Finishing your last card move…";
      case cardWritePending:
        return "Finishing your last card change…";
      case addPending:
        return "Finishing your last add…";
      // The catch-all for the family, and the reason the two sets above don't have
      // to be exhaustive: a board write the panel has no label for still holds
      // pagination, because the click gate below refuses on `boardWritePending`
      // whatever kind it is. Without this the button would render UNHELD and then
      // silently do nothing — the one outcome the explain-disabled rule forbids.
      case boardWritePending:
        return "Finishing a board write…";
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

  // Where the menu's card sits RIGHT NOW, re-derived with the columns rather than
  // recorded at open: the board can re-draw under an open menu, and the rows have
  // to describe the place the card is in when one is clicked.
  const menuPos =
    menuTarget === null ? null : findCard(columns, menuTarget.item.itemId);
  const reorderPlans = menuPos === null ? NO_REORDER : reorderPlansFor(menuPos);
  // A card the board no longer draws holds the whole section with one reason, ahead
  // of the per-direction plans; otherwise the usual gate.
  const reorderHeldReason =
    menuTarget === null
      ? undefined
      : menuPos === null
        ? CARD_GONE_REASON
        : reorderHeldFor(menuTarget.item);

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
                  activeItemId={liveCursor?.col === i ? focusItemId : null}
                  busyItemId={busyItemId}
                  peekItemId={peekItemId}
                  tabStopIndex={tabStop?.col === i ? tabStop.idx : null}
                  focusNonce={focusNonce}
                  repoSlug={repoSlug}
                  ghHost={ghHost}
                  chipFields={chipFields}
                  onCardFocus={onCardFocus}
                  onPeekChange={setPeekItemId}
                  onOpen={openItem}
                />
              ))}
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-56">
              <BoardCardMenuItems
                target={menuTarget}
                // An ungrouped board has one column standing for the whole
                // board, which is no move target at all. A REDACTED card has none
                // either: its rows reach it by its place on the board, and a
                // column pick is a claim about an item whose contents this viewer
                // may not read.
                columns={
                  groupField === null ||
                  menuTarget?.item.content.kind === "redacted"
                    ? []
                    : columns
                }
                openLabel={openLabelFor(menuTarget?.item, repoSlug)}
                heldReason={
                  menuTarget === null ? undefined : moveHeldFor(menuTarget.item)
                }
                actionHeldReason={cardActionHeldReason}
                editHeldReason={
                  menuTarget === null
                    ? undefined
                    : cardEditHeldFor(menuTarget.item)
                }
                reorderHeldReason={reorderHeldReason}
                reorderPlans={reorderPlans}
                actions={{
                  open: () => {
                    if (menuTarget !== null) openItem(menuTarget.item);
                  },
                  showDetails: () => {
                    if (menuTarget !== null)
                      setPeekItemId(menuTarget.item.itemId);
                  },
                  move: (columnIndex) => {
                    if (menuTarget !== null)
                      moveCard(menuTarget.item, columnIndex);
                  },
                  // By POSITION, not by item: the reposition math addresses the
                  // card's slot in its column, which `menuPos` re-derives from the
                  // columns this render drew.
                  reorder: (direction) => {
                    if (menuPos !== null) reorderCard(menuPos, direction);
                  },
                  // Each reads `menuTarget` at CLICK time and hands the item down
                  // by value: the menu closes as it fires, and the prompt or dialog
                  // each of these raises outlives the target the latch is about to
                  // drop.
                  editDraft: () => {
                    if (menuTarget !== null) openDraftEdit(menuTarget.item);
                  },
                  convert: () => {
                    if (menuTarget !== null) void convertCard(menuTarget.item);
                  },
                  archive: () => {
                    if (menuTarget !== null)
                      void retireCard(menuTarget.item, "archive");
                  },
                  restore: () => {
                    if (menuTarget !== null) void restoreCard(menuTarget.item);
                  },
                  remove: () => {
                    if (menuTarget !== null)
                      void retireCard(menuTarget.item, "remove");
                  },
                }}
              />
            </ContextMenuContent>
          </ContextMenu>
        );
    }
  })();

  // What the board is waiting on, ONE LINE PER IN-FLIGHT WRITE, read off each
  // write's own variables so the copy names the thing rather than the operation.
  // Only the kinds whose result lands LATER get a line: an archive and a removal
  // patch the card out on the spot, so the card's absence is already their feedback.
  //
  // STACKED rather than pluralized, and per INVOCATION rather than per kind — two
  // drafts really can be in flight at once (Esc over one, submit another), and two
  // lines each naming their own item beat one that names neither. The mutation id
  // keys them, since the labels themselves can be identical.
  const pendingLines: { key: number; label: string }[] = [];
  for (const write of pendingWrites) {
    if (write.kind === "add-existing") {
      pendingLines.push({
        key: write.mutationId,
        label:
          write.number === null
            ? "Adding an item…"
            : `Adding #${write.number} to the board…`,
      });
    } else if (write.kind === "add-draft") {
      pendingLines.push({ key: write.mutationId, label: "Adding a draft…" });
    } else if (write.kind === "convert") {
      pendingLines.push({
        key: write.mutationId,
        label: "Converting a draft to an issue…",
      });
    } else if (write.kind === "edit-draft") {
      pendingLines.push({ key: write.mutationId, label: "Saving a draft…" });
    } else if (write.kind === "reorder") {
      // A line despite the splice already being on screen, unlike a move: a burst
      // of presses converges through several round trips, so this write can still
      // be reaching GitHub long after the card settled where the user left it.
      pendingLines.push({
        key: write.mutationId,
        label: "Repositioning a card…",
      });
    }
  }

  const showBoardChrome = isGitHub && !scopeGap && projectId !== null;
  const cappedNotes: string[] = [];
  if (catalogTruncated)
    cappedNotes.push("Some of this owner's projects aren't listed above.");
  if (fields.data?.truncated === true)
    cappedNotes.push("Some of this board's fields aren't offered above.");

  // Both palette rows land exactly where the toolbar button does — one action, two
  // entry points, one gate. Palette-only, like the view switcher's own row: the add
  // menu is one Tab from the project name and a chord would cost more than it saves.
  const canAdd = showBoardChrome && addHeldReason === undefined;
  useHotkeyAction(
    "add-board-item",
    () => switchAddDialog("existing"),
    active && canAdd,
  );
  useHotkeyAction(
    "new-board-draft",
    () => switchAddDialog("draft"),
    active && canAdd,
  );
  // The four reposition rows, from the palette. Palette-ONLY on purpose: the chord
  // that drives these lives on the board itself, because "focus is on a card" is a
  // DOM question the global binding layer can't ask. Live wherever the keyboard
  // cursor is on a real card; the routine re-checks every gate and says what it
  // did, so a held board answers the palette the same way it answers the chord.
  useHotkeyAction(
    "move-card-up",
    () => {
      if (liveCursor !== null) reorderCard(liveCursor, "up");
    },
    active && liveCursor !== null,
  );
  useHotkeyAction(
    "move-card-down",
    () => {
      if (liveCursor !== null) reorderCard(liveCursor, "down");
    },
    active && liveCursor !== null,
  );
  useHotkeyAction(
    "move-card-top",
    () => {
      if (liveCursor !== null) reorderCard(liveCursor, "top");
    },
    active && liveCursor !== null,
  );
  useHotkeyAction(
    "move-card-bottom",
    () => {
      if (liveCursor !== null) reorderCard(liveCursor, "bottom");
    },
    active && liveCursor !== null,
  );
  // The content node ids of every card LOADED so far, for the add dialog's
  // already-on-this-board rows. Off `items.data` rather than the derived `loaded`
  // array, which is re-minted each render and would defeat the memo.
  const loadedContentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const page of items.data?.pages ?? [])
      for (const item of page.items)
        if ("id" in item.content) ids.add(item.content.id);
    return ids;
  }, [items.data]);

  return (
    // `h-full`, not `min-h-0 flex-1`: the content pane (<main>) is a BLOCK box,
    // so a flex-item sizing chain never engages there and this root would take
    // its content's height — unbounding every column's scroller and leaving the
    // virtualizers rendering every row. `min-h-0 flex-1` is the SIDEBAR idiom
    // (that aside really is a flex column); the content-pane idiom is this one
    // (RemoteIssueView, RemotePrView, DiffViewer).
    <div ref={rootRef} className="flex h-full flex-col p-2">
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
          {/* Two ways in rather than a per-column add: what a card joins is the
              BOARD, and which column it lands in is the grouping's answer — the
              same answer a move writes. Held with its reason rather than hidden,
              so a read-only sign-in learns why instead of missing the control. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                // The landing the emptied-board retirement focuses. Marked rather
                // than ref'd, and ON the render element rather than the trigger:
                // this button renders inside `DisabledReasonButton`'s wrapper span,
                // so the attribute is what names the focusable node itself, and it
                // rides the same prop path as the `variant` beside it. Always
                // focusable — a held Add item carries a reason, which takes
                // `focusableWhenDisabled` rather than leaving the tab order.
                <DisabledReasonButton
                  data-board-add-trigger=""
                  variant="outline"
                  size="sm"
                  disabled={addHeldReason !== undefined}
                  reason={addHeldReason}
                />
              }
            >
              <PlusIcon data-icon="inline-start" />
              Add item
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-56">
              <DropdownMenuItem onClick={() => switchAddDialog("existing")}>
                Add issue or pull request…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => switchAddDialog("draft")}>
                New draft…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                    <div className="space-y-1">
                      {/* One checkbox rather than a two-row radio group: this is a
                          yes-or-no about the same board, where View and Group by
                          each pick one of several. The caption keeps the section
                          shape its siblings set. */}
                      <p className="px-1 text-xs text-muted-foreground">
                        Archived cards
                      </p>
                      {/* Applies on change, like the rows above — the popup stays
                          open so the board can be looked at both ways without
                          reopening it. */}
                      <label className={GROUP_ROW_CLASS}>
                        <Checkbox
                          checked={showArchived}
                          onCheckedChange={(c) => setArchivedShown(c === true)}
                        />
                        <span className="min-w-0 truncate">
                          Show archived cards
                        </span>
                      </label>
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
                  if (items.isFetching || boardWritePending || lensLoading)
                    return;
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
      {/* What the board is waiting on, in the layout FLOW like every other strip
          here — a status that floated over the chrome would cover the controls it
          is about. Last of the three, against the columns it describes: a failed
          read is actionable and the lens is a standing claim, where this is a
          statement about right now. `role="status"` so it is announced without
          taking focus; `aria-live` is polite by default there, which is what a
          write the user just fired should be. */}
      {showBoardChrome && pendingLines.length > 0 && (
        <div
          role="status"
          className="mb-2 shrink-0 space-y-1 border-b pb-1.5 text-[11px] text-muted-foreground"
        >
          {pendingLines.map((pending) => (
            <p key={pending.key} className="flex items-center gap-1.5">
              <Spinner className="size-3 shrink-0" />
              {pending.label}
            </p>
          ))}
        </div>
      )}
      {/* What the keyboard route just did, or why it refused. Mounted
          unconditionally so each result announces as a live update, and sr-only
          because the board itself is the visual answer: the card is already in its
          new slot with focus on it. A zero-width space toggled by the announce seq
          keeps the textContent changing when the message repeats, so a screen
          reader re-announces an identical held reason or "N of M". */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement.text}
        {ZWSP.repeat(announcement.seq % 2)}
      </span>
      {body}
      {/* Mounted only with a board to add to — both dialogs address one by id, and
          `projectId` is what the whole toolbar is gated on anyway. KEYED on it as
          well: the condition alone reconciles in place, so a board change would
          hand the same instances a new id while they still held the previous
          board's search and "Added" flags. The key is what drops that state; the
          effect above is what closes a dialog the change happened under. Each key
          carries its dialog's own prefix: keys have to be unique among SIBLINGS
          whatever their component type, and a bare `projectId` on both made a
          duplicate pair — a dev warning, and keyed reconciliation this design
          leans on to remount rather than retain. */}
      {projectId !== null && project !== null && (
        <>
          <AddExistingItemsDialog
            key={`existing-${projectId}`}
            repoPath={repoPath}
            projectTitle={project.title}
            lens={lens}
            open={addDialog === "existing"}
            onOpenChange={(o) => switchAddDialog(o ? "existing" : null)}
            onBoardContentIds={loadedContentIds}
            onAdd={addExistingToBoard}
          />
          <NewDraftDialog
            key={`draft-${projectId}`}
            projectTitle={project.title}
            open={addDialog === "draft"}
            pending={draftWritePending}
            onOpenChange={(o) => switchAddDialog(o ? "draft" : null)}
            onCreate={createDraft}
          />
          {/* Mounted with a card to edit, which the menu records before it opens
              this. The seed values ride props for the reason `editing` is panel
              state: a dialog that stays mounted across close can't be the thing
              that remembers which card it was opened on. */}
          {editing !== null && (
            <BoardDraftEditDialog
              key={`edit-draft-${projectId}`}
              repoPath={repoPath}
              lens={lens}
              open={addDialog === "edit-draft"}
              pending={cardWritePending}
              seedTitle={editing.title}
              seedBody={editing.body}
              seedAssigneeLogins={editing.assigneeLogins}
              onOpenChange={(o) => switchAddDialog(o ? "edit-draft" : null)}
              onSave={saveDraftEdit}
            />
          )}
        </>
      )}
    </div>
  );
}
