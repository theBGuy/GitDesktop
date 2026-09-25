import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  DotsThreeIcon,
  FadersHorizontalIcon,
  InfoIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { OptionValue } from "@/features/conversations/ProjectFieldValues";
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
  useBoardRereading,
  useBoardRereadStall,
  useBulkArchiveBoardItems,
  useBulkMoveBoardCards,
  useBulkRemoveBoardItems,
  useBulkRestoreBoardItems,
  useBulkSetItemFieldValues,
  useConvertDraftItem,
  useCreateProject,
  useCreateProjectView,
  useDeleteProject,
  useDeleteProjectView,
  useDuplicateProjectView,
  useForgeStatus,
  useGhScopes,
  useMoveBoardCard,
  usePendingBoardWrites,
  useProjectFields,
  useProjectItems,
  useProjectViews,
  useRefreshProjectViews,
  useRemoveBoardItem,
  useReorderBoardCard,
  useRestoreBoardItem,
  useShiftItemDates,
  useUpdateDraftItem,
  useUpdateProject,
  useUpdateProjectView,
} from "@/lib/git/queries";
import {
  type BoardCandidate,
  type BoardItem,
  type BoardItemContent,
  type BulkItemOutcomes,
  type ProjectFieldDef,
  type ProjectFieldValueUpdate,
  type ProjectPatch,
  type ProjectV2Ref,
  type ProjectViewDef,
  type ProjectViewLayout,
  type ProjectViewSort,
  providerLabel,
} from "@/lib/git/types";
import { eventToBinding, formatBinding, isMac } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useRemoteSlug, useRepoLens } from "@/lib/repo-lens/queries";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { type RepoTab, useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { AddExistingItemsDialog, NewDraftDialog } from "./BoardAddDialogs";
import { BoardBulkFieldsDialog } from "./BoardBulkFieldsDialog";
import {
  BoardCardMenuItems,
  type BoardMenuTarget,
  type BulkMenuState,
} from "./BoardCardMenu";
import { BoardColumn } from "./BoardColumn";
import { BoardDraftEditDialog } from "./BoardDraftEditDialog";
import {
  ARCHIVED_ITEM_REASON,
  ARCHIVED_SHOWN_REASON,
  type BoardColumnModel,
  bucketIdFor,
  buildColumns,
  chipFieldDefs,
  columnValue,
  firstCardPosition,
  GROUPED_ROWS_REASON,
  type GroupField,
  groupableFields,
  honouredSortKeys,
  ITEM_WRITE_REASON,
  type ItemNoun,
  itemAtRowSlot,
  itemRowKey,
  itemRowSlot,
  lensSorted,
  resolveTableCursor,
  SORTED_VIEW_REASON,
  sortColumnItems,
  stepTableCursor,
  type TableColumn,
  type TableCursor,
  type TableMove,
  TRUNCATED_ORDER_REASON,
  tableColumns,
  tableRows,
  UNSET_COLUMN_ID,
} from "./board-model";
import {
  planReorder,
  type ReorderDirection,
  type ReorderPlan,
} from "./board-positioning";
import {
  type BulkVerb,
  columnRange,
  isMacSecondaryClick,
  partitionEligible,
  pruneSelection,
  rowRange,
  selectionMods,
} from "./board-selection";
import {
  type FieldDraft,
  INVALID_DRAFT,
  ISSUE_FIELD_REASON,
  isWritable,
  valueKey,
} from "./ProjectFieldControls";
import {
  EditProjectDialog,
  NewProjectDialog,
  VIEW_LAYOUT_LABEL,
  VIEW_LAYOUTS,
  ViewFieldsDialog,
  ViewNameDialog,
} from "./ProjectLifecycleDialogs";
import {
  ProjectStatusSection,
  type StatusEditorState,
} from "./ProjectStatusStrip";
import { ProjectsRoadmapView } from "./ProjectsRoadmapView";
import { ProjectsTableView } from "./ProjectsTableView";
import {
  type DateSource,
  type DateSources,
  iterationCalendars,
  localDateISO,
  NO_DATE_SOURCES,
  planShift,
  resolveDateSources,
  seedDateSources,
  spanText,
  ZOOMS,
  type Zoom,
} from "./roadmap-model";
import { cellEditHeld } from "./TableCell";

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
/** Mirrors the field editor's own wording verbatim: each surface gates on the
 *  same flag as the row it mirrors, and the two must not say it differently
 *  (ProjectFieldsEditor.tsx). The issue-field hold is the controls module's own. */
const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read project fields but not change them (needs the project scope)";
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
/** The LABELLED sets of the board-write family, as the panel's gates read
 *  them: a card write can collide with another write to the same CARD (so the menu
 *  rows hold on each other), where an add touches no existing card and holds only
 *  pagination. The split lives here as a lookup over {@link BoardWriteKind}, which
 *  is all the mutation key carries. No set is exhaustive — a kind in none of them
 *  still counts as a board write for pagination, and says so generically. */
const CARD_WRITE_KINDS: ReadonlySet<BoardWriteKind> = new Set([
  "move",
  "reorder",
  "convert",
  "archive",
  "restore",
  "remove",
  "edit-draft",
  "shift-dates",
]);
const ADD_WRITE_KINDS: ReadonlySet<BoardWriteKind> = new Set([
  "add-existing",
  "add-draft",
]);
/** The BULK set of the board-write family, as the panel's gates read it: a verb
 *  fired over a selection, which every other verb waits on. Named apart from
 *  CARD_WRITE_KINDS above because the wait says something different to the user. */
const BULK_WRITE_KINDS: ReadonlySet<BoardWriteKind> = new Set([
  "bulk-move",
  "bulk-fields",
  "bulk-archive",
  "bulk-restore",
  "bulk-remove",
]);

/** The board's dialogs, one open at a time. Two put work ON the board; the third
 *  rewrites a draft already there, and is reached from that card's menu. */
type BoardDialog = "existing" | "draft" | "edit-draft";

/** A project or saved-view dialog, with what it was opened on recorded at the
 *  click: the dialogs stay mounted across open and close, so a seed they worked
 *  out for themselves would describe whatever they last saw. */
type LifecycleDialog =
  | { kind: "new-project" }
  | {
      kind: "edit-project";
      projectId: string;
      title: string;
      description: string;
    }
  | { kind: "new-view"; projectId: string }
  | { kind: "rename-view"; projectId: string; view: ProjectViewDef }
  | { kind: "view-fields"; projectId: string; view: ProjectViewDef };

/** The shared empty id list, for a fields dialog with no view behind it. */
const NO_FIELD_IDS: readonly string[] = [];

/** The project and view verbs that write without a dialog of their own, and so
 *  need their own single-flight guard. */
type InFlightVerb =
  | "close-reopen"
  | "delete-project"
  | "duplicate-view"
  | "delete-view"
  | "save-layout";

/** Why no project can be created: the catalog named no owner to create it under. */
const OWNER_UNKNOWN_REASON =
  "Couldn't read who owns this repository, and a new project is created under that account";

/** GitHub refuses to delete a project's last remaining view (probed live). */
const LAST_VIEW_REASON =
  "A project keeps its last view, so GitHub won't delete this one";
/** Held while the open-time re-read of the views is on its way, so a copy or a
 *  fields edit starts from what GitHub holds now. */
const VIEWS_REFRESHING_REASON = "Refreshing this project's views…";

const UNKNOWN_LAYOUT_REASON =
  "This view is saved in a layout GitDesktop can't show, so it can't be copied or saved over here";

/** Single-writer: two writes to one card's field settle in an order nothing
 *  promises, and an EARLIER move failing late puts the card back in a column a
 *  later write already moved it out of. */
const MOVING_REASON: Record<ItemNoun, string> = {
  card: "Moving your last card…",
  row: "Moving your last row…",
};
/** Which layout draws the board's items, and so what messages call the whole of
 *  it: the item leaves the board, the table, or the roadmap. */
type Surface = "board" | "table" | "roadmap";
/** An archive is reversible and a removal is not, so the two prompts say different
 *  things, and a removal says a third for a draft, which lives on this project alone
 *  and has nowhere to survive. Every one names where the card goes rather than asking
 *  the user to infer it — which is why this one is keyed on whether archived cards
 *  are SHOWN: with the toggle off the card leaves the columns, with it on it stays
 *  put under an Archived badge. "Show archived cards" is the TOGGLE's name, so it
 *  stays as it reads on screen whatever the item is called. */
const ARCHIVE_BODY: Record<
  "shown" | "hidden",
  (noun: ItemNoun, surface: Surface) => string
> = {
  hidden: (noun, surface) =>
    `The ${noun} leaves the ${surface}. Bring it back any time from View options → Show archived cards.`,
  shown: (noun, surface) =>
    `The ${noun} stays in place, marked Archived, and leaves the ${surface} when you turn Show archived cards off. Restore ${noun} brings it back.`,
};
const REMOVE_BODY: Record<
  BoardItemContent["kind"],
  (noun: ItemNoun) => string
> = {
  draft: () =>
    "This deletes the draft permanently — drafts live on this project and nowhere else.",
  issue: (noun) =>
    `The ${noun} leaves this project. The issue itself is untouched, and you can add it back later.`,
  pullRequest: (noun) =>
    `The ${noun} leaves this project. The pull request itself is untouched, and you can add it back later.`,
  redacted: (noun) =>
    `The ${noun} leaves this project. The item itself is untouched, and you can add it back later.`,
};
/** {@link ARCHIVE_BODY} for a SELECTION, keyed the same way and on the same fact:
 *  with the toggle off the cards leave the board, with it on they stay put under
 *  an Archived badge. An eligible set of one takes the single-card wording
 *  verbatim rather than a pluralized copy of it. */
const BULK_ARCHIVE_BODY: Record<
  "shown" | "hidden",
  (n: number, noun: ItemNoun, surface: Surface) => string
> = {
  hidden: (n, noun, surface) =>
    n === 1
      ? ARCHIVE_BODY.hidden(noun, surface)
      : `The ${n} ${noun}s leave the ${surface}. Bring them back any time from View options → Show archived cards.`,
  shown: (n, noun, surface) =>
    n === 1
      ? ARCHIVE_BODY.shown(noun, surface)
      : `The ${n} ${noun}s stay in place, marked Archived, and leave the ${surface} when you turn Show archived cards off. Restore ${noun} brings one back.`,
};

/** {@link REMOVE_BODY} for a SELECTION. Keyed on how many DRAFTS it holds, which
 *  is the one thing a removal destroys outright: everything else is an unlink the
 *  user can undo by adding the item back. */
function bulkRemoveBody(cards: BoardItem[], noun: ItemNoun): string {
  if (cards.length === 1) return REMOVE_BODY[cards[0].content.kind](noun);
  const drafts = cards.filter((card) => card.content.kind === "draft").length;
  const leaves = `The ${cards.length} ${noun}s leave this project.`;
  if (drafts === 0)
    return `${leaves} The items themselves are untouched, and you can add them back later.`;
  // Both arms built whole rather than stitched from shared fragments: "which
  // live(s)" has to agree with the subject the branch chose.
  return drafts === 1
    ? `${leaves} One of them is a draft, which lives on this project and nowhere else, so it is deleted permanently.`
    : `${leaves} ${drafts} of them are drafts, which live on this project and nowhere else, so those are deleted permanently.`;
}

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
/** The column list of a render with no table view, shared for the same reason. */
const NO_TABLE_COLUMNS: TableColumn[] = [];
/** The sort keys of a render with no table view. */
const NO_SORT_KEYS: ProjectViewSort[] = [];
/** What the board says about a view it draws in a layout the view wasn't saved
 *  in. Board, table and roadmap views draw as themselves and need no note, and an
 *  unrecognised layout names no shape it can't vouch for. */
const FLAT_FALLBACK_NOTE: Partial<Record<ProjectViewDef["layout"], string>> = {
  unknown: "Shown as a board",
};
/** Why View options' Group by holds under a table or roadmap view: the view's
 *  own saved grouping decides its sections, exactly as GitHub draws it. */
const ROWS_GROUPING_REASON: Record<Exclude<Surface, "board">, string> = {
  table: "Table views keep the grouping they were saved with on GitHub",
  roadmap: "Roadmap views keep the grouping they were saved with on GitHub",
};
/** Why a bulk move is held on rows drawn with no group sections: a move writes
 *  the grouping field, and rows drawn flat have no group to move into, even under
 *  a view that groups by a field that makes no sections here. */
const ROWS_UNGROUPED_MOVE_REASON: Record<Exclude<Surface, "board">, string> = {
  table:
    "This table isn't drawn in groups, so there's no group to move rows to",
  roadmap:
    "This roadmap isn't drawn in groups, so there's no group to move rows to",
};
/** The roadmap's scale, as its View options rows and announcements name it. */
const ZOOM_LABEL: Record<Zoom, string> = {
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};
/** The date-source rows' "no field" row. Not a field id — it stands for the
 *  ABSENCE of a source, the way the view switcher's No view row does. */
const NO_SOURCE_ROW_ID = "__none__";
/** Why the date-source rows hold. The zoom rows never do: they depend on no read. */
const NO_DATE_FIELDS_REASON =
  "This project has no date or iteration fields to place items with";
/** The in-flow notice on a roadmap with no date source to place anything by. */
const ROADMAP_NO_SOURCES_NOTE =
  "Pick date fields for this roadmap in View options.";
/** The zoom palette rows' answers at the scale's ends. */
const ZOOM_END_REASON: Record<"in" | "out", string> = {
  in: "Already zoomed in to months",
  out: "Already zoomed out to years",
};
/** The roadmap's date-shift chords, as CANONICAL bindings (`eventToBinding`'s own
 *  spelling). Alt+←/→ moves the whole span a day, Alt+Shift+←/→ moves its target
 *  alone — Alt meaning "act on the item", as the reposition chords do. Feature-local
 *  rather than registry bindings for their reason: only this grid knows focus is
 *  on a lane. */
const SHIFT_CHORDS: Partial<
  Record<string, { mode: "move" | "resize"; dir: -1 | 1 }>
> = {
  "alt+left": { mode: "move", dir: -1 },
  "alt+right": { mode: "move", dir: 1 },
  "alt+shift+left": { mode: "resize", dir: -1 },
  "alt+shift+right": { mode: "resize", dir: 1 },
};
/** One refusal toast for the shift chords at a time, the reorder chords' reason:
 *  key auto-repeat would otherwise mint one per repeat. */
const SHIFT_REFUSAL_TOAST_ID = "board-shift-refused";
/** What a shift chord says on the title cell, where it doesn't apply. */
const SHIFT_ON_TITLE_REASON = `Move to the timeline (${formatBinding("right")}) to shift this item's dates`;
/** The strip's word on a table view whose ENTIRE sort this build can't honour —
 *  a partly honoured sort stays quiet, since its rows do follow the view. Keyed on
 *  WHY: a key whose field the board's field read didn't return (a capped or failed
 *  read) is a different statement from a field this build has no order for. */
const TABLE_SORT_DROPPED_NOTE: Record<
  "unsortable" | "unloaded" | "both",
  string
> = {
  unsortable:
    "Sorted on GitHub by fields this view can't order by, so rows keep the project order",
  unloaded:
    "Sorted on GitHub by fields this board didn't load, so rows keep the project order",
  both: "Sorted on GitHub by fields this view can't order by or didn't load, so rows keep the project order",
};
/** The strip's word on a table grouped by a field that makes no sections here (a
 *  multi-select, a field GitHub owns on the issue): every row is still drawn. */
function tableUngroupedNote(fieldName: string | null): string {
  return fieldName === null
    ? "Grouped on GitHub by a field this board didn't load, shown here as one list"
    : `Grouped by ${fieldName} on GitHub, shown here as one list`;
}
/** The table's cursor keys, by the canonical binding `eventToBinding` spells:
 *  the bare arrows step, Home and End reach a row's ends, and `mod` with them
 *  reaches the table's. */
const TABLE_MOVES: Partial<Record<string, TableMove>> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "rowStart",
  end: "rowEnd",
  "mod+home": "first",
  "mod+end": "last",
  pageup: "pageUp",
  pagedown: "pageDown",
};
/** Which of {@link TABLE_MOVES} change the ROW, and so carry the selection with
 *  them the way the board's vertical keys do. Column moves leave it alone: the
 *  selection is row-scoped. */
const TABLE_ROW_MOVES: ReadonlySet<TableMove> = new Set([
  "up",
  "down",
  "first",
  "last",
  "pageUp",
  "pageDown",
]);
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
/** Every key the board, the table and the roadmap answer with Alt held. The
 *  chords that use them are matched first: {@link REORDER_CHORDS} everywhere, and
 *  {@link SHIFT_CHORDS} on any roadmap item row (shifting on its lane, saying why
 *  not on its title). Any other Alt press on these keys (Alt+Shift+↑ anywhere,
 *  Alt+← on a board card or a table cell) is swallowed rather than falling
 *  through to the cursor-and-selection arm, which would answer one keystroke with
 *  two unrelated actions. Alt means "act on the item", so it never degrades to
 *  plain navigation. */
const ALT_SWALLOWED_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
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
const CARD_GONE_REASON: Record<Surface, string> = {
  board: "This card is no longer on the board",
  table: "This row is no longer in the table",
  roadmap: "This row is no longer on the roadmap",
};
/** One shared id for every reorder-refusal toast: key auto-repeat drives the burst
 *  (no e.repeat gate), so a held direction would otherwise mint a fresh toast per
 *  repeat — sonner updates the one in place instead. Only one refusal is on screen
 *  at a time, so a single id is correct. */
const REORDER_REFUSAL_TOAST_ID = "board-reorder-refused";
/** The same one-toast-at-a-time id for a held cell editor asked for from the
 *  keyboard, where no greyed control is on screen to say why. */
const CELL_EDIT_REFUSAL_TOAST_ID = "board-cell-edit-refused";
/** What the keyboard route says when Enter closes a cell editor over an entry the
 *  field can't take (a half-typed number or date). */
const CELL_INVALID_ENTRY_NOTE =
  "Nothing saved: that entry isn't a complete value yet";

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

/** One shared empty selection: a board with nothing selected hands its columns the
 *  same Set identity every render, where a fresh one would defeat their memo and
 *  re-render every mounted card. */
const NO_SELECTION: ReadonlySet<string> = new Set<string>();
/** The empty card snapshot, shared for the reason {@link NO_SELECTION} is: the
 *  bulk fields dialog is memo-free but re-renders with the panel, and a fresh `[]`
 *  per render would re-mint every hint it draws. */
const NO_CARDS: BoardItem[] = [];
/** No table section collapsed — the state every project and view starts in. */
const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();
/** Why every bulk verb (and every table cell) is held while a batch write is
 *  still running. Single-writer for the same reason the single-card writes are: two
 *  writes to one card settle in an order nothing promises. Worded by what IS
 *  pending: a lone one-item field write is a cell edit, not a bulk change. */
const BULK_PENDING_REASON = "Applying the last bulk change…";
const FIELD_PENDING_REASON = "Still saving your last field change…";
/** Why a table cell holds while a write's re-read is on its way — the slot's own
 *  "Updating…" phase, said as a reason. */
const UPDATING_REASON: Record<Surface, string> = {
  board: "Updating the board with your last change…",
  table: "Updating the table with your last change…",
  roadmap: "Updating the roadmap with your last change…",
};
/** The strip's own line for that state, once the read's error has been cleared
 *  by a later patch and there is no error left to present. */
const REREAD_FAILED_NOTE =
  "Couldn't refresh after your last change, so some values may be out of date";
/** The same hold when that re-read failed: the strip above names the failure and
 *  carries the Retry that clears it. */
const REREAD_FAILED_REASON: Record<Surface, string> = {
  board:
    "The board didn't refresh after your last change. Retry above to edit again",
  table:
    "The table didn't refresh after your last change. Retry above to edit again",
  roadmap:
    "The roadmap didn't refresh after your last change. Retry above to edit again",
};
/** What the keyboard says when Shift is held across the board rather than down a
 *  column. A silent collapse under a held Shift is the outcome this refuses. */
const SELECTION_SIDEWAYS_REASON = "Selection extends within a column";
/** Each verb in the past tense, for the result a user reads back. */
const BULK_DONE_WORD: Record<BulkVerb, string> = {
  move: "Moved",
  fields: "Updated fields on",
  archive: "Archived",
  restore: "Restored",
  remove: "Removed",
};
/** The same five as the infinitive a partial failure names. */
const BULK_FAIL_WORD: Record<BulkVerb, string> = {
  move: "move",
  fields: "update",
  archive: "archive",
  restore: "restore",
  remove: "remove",
};
/** Why a verb has nothing to act on because the SELECTION is gone, which is a
 *  different statement from every card being on the wrong side of the verb. Only
 *  a surface that outlives the bar can reach it — the bar stops rendering below
 *  two cards, where the bulk fields dialog stays up. */
const BULK_NO_SELECTION_REASON: Record<ItemNoun, string> = {
  card: "No cards are selected",
  row: "No rows are selected",
};
/** Why a verb has nothing to do over THIS selection. Each names the state that
 *  put it there, since a mixed selection scopes a verb rather than blocking it —
 *  a held row here means every selected card is on the wrong side of it.
 *
 *  `remove` is a TOTALITY PLACEHOLDER, not a reachable string: a removal skips
 *  nothing, so its eligible set is the selection, and an empty one is already
 *  answered by {@link BULK_NO_SELECTION_REASON} upstream. Kept as a full
 *  `Record<BulkVerb, …>` rather than narrowed with `Exclude`, so a sixth verb
 *  added later has to state its own sentence here instead of type-checking its
 *  way past a lookup that would return `undefined` at runtime. */
const BULK_NOTHING_REASON: Record<BulkVerb, (noun: ItemNoun) => string> = {
  move: (noun) => `Every selected ${noun} is archived`,
  fields: (noun) => `Every selected ${noun} is archived`,
  archive: (noun) => `Every selected ${noun} is already archived`,
  restore: (noun) => `No selected ${noun} is archived`,
  remove: (noun) => `Select ${noun}s to remove`,
};

/** `n` cards (or rows), with the singular the eligible count really can land on:
 *  a mixed selection leaves one verb with a single card to act on. */
function cardCount(n: number, noun: ItemNoun): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** A view's filter as the board's LENS. GitHub reports an unfiltered view as
 *  either null or an empty string, and sending `""` would key a second cache
 *  entry for the same unfiltered read; anything else rides VERBATIM, since the
 *  filter grammar is the server's to parse. */
function lensFilter(view: ProjectViewDef | null): string | null {
  const filter = view?.filter ?? null;
  return filter === null || filter.trim() === "" ? null : filter;
}

/** The layout `view` draws in: a table or roadmap view as itself, and no view — or
 *  one in a layout this build doesn't know — as the board. */
function surfaceOf(view: ProjectViewDef | null): Surface {
  return view?.layout === "table" || view?.layout === "roadmap"
    ? view.layout
    : "board";
}

/** The one control that takes the board back to no lens, worded the same wherever
 *  it appears: the strip that announces the view, and the state its filter
 *  emptied. `landing` marks the notice's copy for {@link focusBodyLanding}. */
function ClearViewButton({
  onClear,
  landing = false,
}: {
  onClear: () => void;
  landing?: boolean;
}) {
  return (
    <button
      type="button"
      data-body-landing={landing ? "" : undefined}
      onClick={onClear}
      className="cursor-pointer underline hover:text-foreground"
    >
      Clear view
    </button>
  );
}

/** What a `[data-body-landing]` wrapper hands focus to: its first live control. */
const BODY_LANDING_CONTROL = "button:not(:disabled), a[href]";

/** THE focus landing, for every route that has nothing left to stand on — an
 *  emptied board, an emptied table, a body arm swapped in under the table, board
 *  or table alike. In order: the drawn body's own control (`[data-body-landing]`,
 *  on the control itself or on a wrapper around a shared component whose first
 *  live control it means), else the toolbar's Add item, where the board's own
 *  recovery starts, else the panel root: a named region, so the landing is
 *  announced rather than dropped silently to <body>. */
function focusBodyLanding(root: HTMLElement | null) {
  const marked = root?.querySelector<HTMLElement>("[data-body-landing]");
  const control = marked?.matches(BODY_LANDING_CONTROL)
    ? marked
    : marked?.querySelector<HTMLElement>(BODY_LANDING_CONTROL);
  (
    control ??
    root?.querySelector<HTMLElement>("[data-board-add-trigger]") ??
    root
  )?.focus();
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
      <Button
        variant="outline"
        size="xs"
        className="mt-2"
        data-body-landing=""
        onClick={onRetry}
      >
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

/** One end's date-source rows in View options: every date and iteration field,
 *  then None. Radio rows, never a nested Select — the popover's documented shape.
 *  Held with its reason in place of the rows, the Group-by section's shape. */
function DateSourceRows({
  labelId,
  label,
  heldReason,
  fields,
  value,
  onPick,
}: {
  labelId: string;
  label: string;
  heldReason: string | undefined;
  fields: Extract<ProjectFieldDef, { kind: "date" | "iteration" }>[];
  value: DateSource | null;
  onPick: (rowId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p id={labelId} className="px-1 text-xs text-muted-foreground">
        {label}
      </p>
      {heldReason !== undefined ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">{heldReason}</p>
      ) : (
        <RadioGroup
          className="gap-0"
          aria-labelledby={labelId}
          value={value?.fieldId ?? NO_SOURCE_ROW_ID}
          onValueChange={(next) => {
            // Base UI types the group's value as `any`.
            if (typeof next === "string") onPick(next);
          }}
        >
          {fields.map((f) => (
            <label key={f.id} className={GROUP_ROW_CLASS}>
              <Radio value={f.id} />
              <span
                className="min-w-0 truncate"
                onMouseEnter={clipTitleFromText}
              >
                {f.name}
              </span>
              {/* The field's kind in words: an iteration spans each item across
                  its iteration rather than naming one day. */}
              {f.kind === "iteration" && (
                <span className="shrink-0 text-muted-foreground">
                  iteration
                </span>
              )}
            </label>
          ))}
          <label className={GROUP_ROW_CLASS}>
            <Radio value={NO_SOURCE_ROW_ID} />
            <span className="min-w-0 truncate">None</span>
          </label>
        </RadioGroup>
      )}
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
  // The selection hint's own dismissal, which is the only stored preference this
  // panel has: everything else here is for the visit.
  const settings = useSettings();
  const saveSettings = useSaveSettings();

  const projects = useAvailableProjects(repoPath, canRead, lens);
  // Open boards first, then the closed ones as their own group: a closed board
  // still holds its items and stays fully workable, but a board nobody is working
  // shouldn't stand between the user and the one they came for.
  const catalog = projects.data?.projects ?? [];
  const openProjects = catalog.filter((p) => !p.closed);
  const closedProjects = catalog.filter((p) => p.closed);
  const listedProjects = [...openProjects, ...closedProjects];
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  // Derived, not stored: the catalog arrives after the first render and can
  // change under the user, and a chosen board that has since gone must fall back
  // rather than leave the board reading an id nothing serves. The catalog's own
  // order puts the repo's boards ahead of the owner's, so the fallback IS "first
  // open repo-linked, else first open owner", and a closed one only when that is
  // all there is.
  const projectId =
    listedProjects.find((p) => p.id === pickedProjectId)?.id ??
    listedProjects[0]?.id ??
    null;
  const project = listedProjects.find((p) => p.id === projectId) ?? null;

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
  const savedView = viewList.find((v) => v.id === activeViewId) ?? null;
  // Bumped by every deliberate board or view pick (`pickView`, `clearView`,
  // `switchProject`). A write's continuation captures it when it fires and only
  // picks for itself if nothing was picked since, so a late answer never
  // overrides a choice the user made while it was out.
  const pickGenerationRef = useRef(0);
  // A layout picked in View options for the view on screen, transient until
  // "Save layout to view" writes it. Keyed on the view it was picked for, and
  // cleared by every view pick, so it never follows the user to another view.
  const [layoutPick, setLayoutPick] = useState<{
    viewId: string;
    layout: ProjectViewLayout;
  } | null>(null);
  // The view AS DRAWN: the saved one, with a transient layout laid over it. One
  // injection point, so every layout rule below (and the same-view flip handoff)
  // reads the pick exactly as it would a layout GitHub changed. Memoized for the
  // chips' memo, which keys on this object's identity.
  const view = useMemo(
    () =>
      savedView !== null &&
      layoutPick !== null &&
      layoutPick.viewId === savedView.id &&
      layoutPick.layout !== surfaceOf(savedView)
        ? { ...savedView, layout: layoutPick.layout }
        : savedView,
    [savedView, layoutPick],
  );
  const layoutUnsaved = view !== savedView;
  const lensQuery = lensFilter(view);
  // Imperative, because no render-derivable signal tells "this view is GONE" from
  // "this read hasn't carried it yet": the lens above degrades either way, but a
  // lingering id is re-adopted by the next list that happens to contain it —
  // filter, sort and chips back on with no pick behind them and no grouping seed.
  // A SETTLED list is the only thing that may retire it, so a pending or failed
  // read touches nothing.
  // A view the settled list no longer carries degrades to no lens the moment it
  // arrives — for a TABLE or ROADMAP view, the grid unmounts under the user in
  // that same render, a route no picker covers. So the retirement takes the
  // picker's handoff (`handOffLayoutFlip`); a board view keeps its bare retirement.
  // `drawnLayoutRef` is the render BEFORE this one: its writer runs after this.
  const drawnLayoutRef = useRef<{
    viewId: string | null;
    layout: Surface;
    cardId: string | null;
  }>({ viewId: null, layout: "board", cardId: null });
  const retireStaleView = useEffectEvent(() => {
    if (drawnLayoutRef.current.layout !== "board") {
      handOffLayoutFlip(false, drawnLayoutRef.current.cardId);
      clearSelection();
    }
    setActiveViewId(null);
    setLayoutPick(null);
  });
  useEffect(() => {
    if (activeViewId === null || views.data === undefined) return;
    if (!views.data.views.some((v) => v.id === activeViewId)) retireStaleView();
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
    // The RICH read (assignees, labels, reviewers, linked pull requests as field
    // values) only where a table draws them: each costs rate limit per item, and a
    // board renders none. The placeholder keeps the other read's cards up across
    // a board↔table switch while this one lands.
    view?.layout === "table",
  );
  // The tail after a write settles and before the board shows what GitHub now
  // holds: a re-read one of this repo's writes asked for, still running.
  const refreshingAfterWrite = useBoardRereading(repoPath);
  // Whether the on-screen lens has reconciled since the repo's last write: owed
  // (the same "Updating…" hold, offline included) or failed.
  const rereadStall = useBoardRereadStall(
    repoPath,
    projectId ?? "",
    lensQuery,
    showArchived,
    view?.layout === "table",
  );
  const rereadFailed = rereadStall === "failed";
  // The cards on screen belong to the PREVIOUS lens until this clears, so every
  // claim derived from them waits: the count, Load more, and the move rows.
  const lensLoading = items.isPlaceholderData;
  const loaded = oneCardPerItem(
    items.data?.pages.flatMap((page) => page.items) ?? [],
  );
  // A TABLE or ROADMAP view draws its rows in sections of the view's own row
  // grouping, where a board draws columns of the Group-by pick. A grouping outside
  // the groupable set makes no sections: the rows draw flat and the strip says so.
  // `rowView` is either — every row-shaped rule (sections, the row cursor, a
  // row range) reads it; what only a table has (field columns, cell editing, the
  // rich read) keeps reading `tableView`.
  const tableView = view?.layout === "table" ? view : null;
  const roadmapView = view?.layout === "roadmap" ? view : null;
  const rowView = tableView ?? roadmapView;
  const surface = surfaceOf(view);
  const rowGroupId = rowView?.groupFieldIds[0];
  const rowGroupField =
    rowGroupId === undefined
      ? null
      : (groupFields.find((f) => f.id === rowGroupId) ?? null);
  // The field whose buckets the drawn columns or row sections are — what a move
  // writes, what the menu's Move to lists, and what a card's value is read
  // against. On a board it is the Group-by pick, exactly as before.
  const bucketField = rowView === null ? groupField : rowGroupField;
  // What every message names an item: the words of the surface drawing it.
  const noun: ItemNoun = rowView === null ? "card" : "row";
  // The view's sort orders cards WITHIN a column, so it applies after bucketing —
  // which column a card lands in is the grouping's answer alone. With no sort the
  // columns are untouched, board POSITION order and all.
  const grouped = buildColumns(loaded, bucketField, showArchived);
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
  // The table's own cursor, by IDENTITY — a row key and the column being walked —
  // since a table re-sorts and re-sections under it. Retired on a project switch;
  // re-anchored (row kept, column reset) on a view switch, so it maps by item id
  // where the item survives; never retired on a refetch that drops its row,
  // because the resolution below already falls back each render.
  const [tableCursor, setTableCursor] = useState<TableCursor | null>(null);
  // The card a table→board switch carries to the board's cursor, held until the
  // board's own columns SETTLE (the lens may be loading) and then spent: found, it
  // becomes the cursor; gone, the board keeps its first-card fallback.
  const [boardCursorSeed, setBoardCursorSeed] = useState<{
    /** Null when the cursor sat on a group header: no card to carry. */
    itemId: string | null;
    /** The table held focus at the switch, so the board takes it on arrival. */
    claim: boolean;
  } | null>(null);
  // A board→table switch made while a board card held focus: the table claims its
  // cursor cell once it has mounted. A nonce bumped in the switch itself would be
  // the one the table MOUNTS with, which a claim never fires on.
  const [tableFocusClaim, setTableFocusClaim] = useState(false);
  // The one table cell whose editor is open, and which RUN of the editor it is.
  // Retired — state cleared and token bumped, so a close arriving from a retired
  // run can't write — at: a project switch (the picker, and the catalog's silent
  // re-point), a view switch (`reanchorTable`), and refetch-absence of its row or
  // its column (`cellEditGone` below). Nothing else closes it but the editor.
  const [editingCell, setEditingCell] = useState<{
    itemId: string;
    fieldId: string;
    session: number;
  } | null>(null);
  const cellEditSessionRef = useRef(0);
  // The table's collapsed sections, by bucket id: transient like every layout
  // choice here. Cleared on a project switch and a view switch (a different
  // grouping's ids mean nothing); a refetch that empties a section just stops
  // drawing its header, and the id waits harmlessly for the section to return.
  const [collapsedGroups, setCollapsedGroups] =
    useState<ReadonlySet<string>>(NO_COLLAPSED);
  // The roadmap's own layout choices, transient like Group by: the fields that
  // place an item, and the scale. Seeded (zoom reset to Month) at two sites only:
  // `pickView` on every view pick, and `flipLayout` when the view on screen turns
  // into a roadmap in place. A picked field the definitions stop carrying reads as
  // no source (`resolveDateSources`) rather than re-seeding behind the user.
  const [datePicks, setDatePicks] = useState<DateSources>(NO_DATE_SOURCES);
  // Whether the view on screen has had its roadmap seed since it was picked. A
  // flag rather than a test on `datePicks`: a project with no date or iteration
  // fields seeds to NO_DATE_SOURCES itself, so the object can't tell "never
  // seeded" from "seeded to nothing". Set by the seeding sites, reset by picks.
  const datesSeededRef = useRef(false);
  const [zoom, setZoom] = useState<Zoom>("month");
  // Bumped by the palette's jump to today; the roadmap scrolls on the bump.
  const [todayNonce, setTodayNonce] = useState(0);
  const dateSources = resolveDateSources(datePicks, fieldDefs);
  const calendars = iterationCalendars(fieldDefs);
  // What the roadmap's range spans: every drawn item, folded sections included.
  const roadmapItems =
    roadmapView === null ? NO_CARDS : columns.flatMap((column) => column.items);
  // Controlled so the roadmap's "Pick date fields" notice can open it.
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  // Every open of View options re-reads the project's views, on the open
  // transition alone: it is the one place a view edited on GitHub would be
  // looked for, and Duplicate copies from what it lists.
  const refreshProjectViews = useRefreshProjectViews();
  useSeedOnOpen(viewOptionsOpen, () => {
    if (canRead && projectId !== null) refreshProjectViews(repoPath, projectId);
  });
  const tableCols =
    tableView === null ? NO_TABLE_COLUMNS : tableColumns(tableView, fieldDefs);
  // How many cells the row cursor walks: a table's field columns, a roadmap's
  // rail and lane.
  const rowColCount = tableView !== null ? tableCols.length : 2;
  // The sort keys the rows really follow — a header claims no key the sort
  // dropped — and whether the view's whole sort was dropped, which the strip says.
  const rowSortKeys =
    rowView === null
      ? NO_SORT_KEYS
      : honouredSortKeys(rowView.sortBy, fieldDefs);
  const rowSortDropped = (() => {
    if (
      rowView === null ||
      rowView.sortBy.length === 0 ||
      rowSortKeys.length > 0
    )
      return null;
    const defined = rowView.sortBy.map((sort) =>
      fieldDefs.some((f) => f.id === sort.fieldId),
    );
    if (defined.every(Boolean)) return TABLE_SORT_DROPPED_NOTE.unsortable;
    if (!defined.some(Boolean)) return TABLE_SORT_DROPPED_NOTE.unloaded;
    return TABLE_SORT_DROPPED_NOTE.both;
  })();
  // The honest note for a table grouped by a field that makes no sections here.
  // Only a SETTLED fields read may name the field as missing: while it loads,
  // the panel draws its skeleton instead of any table.
  const tableUngrouped =
    rowGroupId !== undefined && rowGroupField === null
      ? tableUngroupedNote(
          fieldDefs.find((f) => f.id === rowGroupId)?.name ?? null,
        )
      : null;
  const tableEntries =
    rowView === null
      ? []
      : tableRows(columns, rowGroupField !== null, collapsedGroups);
  const tablePos = resolveTableCursor(
    tableEntries,
    columns,
    tableCursor,
    rowColCount,
  );
  const tablePosEntry =
    tablePos === null ? undefined : tableEntries[tablePos.rowIndex];
  // A cursor left over from another grouping (or a refetch that emptied its
  // column) can't address a card, so the tab stop falls back to the first one. On
  // a table the card is wherever the cursor's ROW is now, and a group header is
  // no card at all.
  const liveCursor =
    rowView !== null
      ? tablePosEntry?.kind === "item"
        ? findCard(columns, tablePosEntry.item.itemId)
        : null
      : cursor !== null && cursor.idx < (columns[cursor.col]?.items.length ?? 0)
        ? cursor
        : null;
  const tabStop = liveCursor ?? firstCardPosition(columns);
  /**
   * The layout swapped under the user with no picker in the route — the active view
   * retired, or the SAME view's layout changed on a refetch. The grid or the board
   * unmounted in the render that brought the change, so the picker's handoff runs
   * off the previous render's record: its cursor card seeds the new layout's
   * cursor, and focus that fell with it (to <body>) is claimed there.
   */
  function handOffLayoutFlip(toRows: boolean, cardId: string | null) {
    // A peek anchored in the layout being left would reopen in the other unasked.
    setPeekItemId(null);
    const active = document.activeElement;
    const held = active === null || active === document.body;
    if (toRows) {
      if (cardId !== null)
        setTableCursor({ rowKey: itemRowKey(cardId), colIndex: 0 });
      setTableFocusClaim(held);
      return;
    }
    if (cardId !== null || held)
      setBoardCursorSeed({ itemId: cardId, claim: held });
    setCursor(null);
  }
  // A flip INTO a roadmap is a view nobody re-picked, so it seeds the roadmap's
  // date sources and zoom the way `pickView` would. Only here: `pickView` seeds
  // every picked view itself, and a pick changes the view id, which this path
  // never fires on.
  const flipLayout = useEffectEvent((to: Surface, cardId: string | null) => {
    // Seeded only on the FIRST roadmap arrival since the view was picked: after
    // that, the date picks and zoom are this visit's own, and a flip back must
    // not discard them.
    if (to === "roadmap" && view !== null && !datesSeededRef.current) {
      datesSeededRef.current = true;
      setDatePicks(seedDateSources(view, fieldDefs));
      setZoom("month");
    }
    handOffLayoutFlip(to !== "board", cardId);
  });
  // Records the drawn layout for the next render, and hands off when the SAME view
  // changed layout in place. Declared after the retirement's effect, so that one
  // reads the previous render's record; a retired view resolves to no view here
  // and is the retirement's to hand off.
  const drawnCardId =
    liveCursor === null
      ? null
      : (columns[liveCursor.col]?.items[liveCursor.idx]?.itemId ?? null);
  // Read the previous record, hand off from IT, and only then record this render:
  // the card to carry is the one the old layout drew.
  useEffect(() => {
    const prev = drawnLayoutRef.current;
    if (view !== null && prev.viewId === view.id && prev.layout !== surface)
      flipLayout(surface, prev.cardId);
    drawnLayoutRef.current = {
      viewId: view?.id ?? null,
      layout: surface,
      cardId: drawnCardId,
    };
  });

  // The board's selection, and the card a Shift range extends FROM. Beside the
  // cursor rather than derived from it: the two move together for every plain
  // gesture and apart for every modified one, which is the whole grammar.
  const [selectedIds, setSelectedIds] =
    useState<ReadonlySet<string>>(NO_SELECTION);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(
    null,
  );
  // PRUNED at the same place the cursor clamps, and for the same reason: the
  // columns change under a selection from several directions at once (the
  // archived toggle, a view's filter, a refetch, another write's patch), and a
  // card the board has stopped drawing must never be acted on by a verb that
  // counted it. Derived, never an effect chasing the writers.
  const liveSelection = pruneSelection(selectedIds, columns);
  const selectionSize = liveSelection.size;
  /**
   * The THIRD piece of the lens-resurrection closure, beside the derived
   * `liveSelection` above and the switch-time clears below. The derived view keeps
   * a departed card out of every verb, but `selectedIds` still HOLDS its id — so a
   * card that comes BACK (another client's archive-then-restore, any refetch round
   * trip) silently rejoins the selection and the next bulk write, having never
   * been re-picked.
   *
   * Only a SETTLED read may retire an id, the discipline the menu latch and the
   * stale-view-id effect both keep: the cards on screen while a lens loads are the
   * PREVIOUS view's, and a refetch in flight has not said anything yet, so absence
   * in either is transient rather than departure.
   *
   * DELIBERATE CONSEQUENCE: turning **Show archived cards** off retires the
   * archived cards from the selection, because the board has genuinely stopped
   * drawing them. Hiding deselects; turning it back on does not re-select. That is
   * prune-to-visible's own rule, made durable rather than derived-only.
   *
   * The invariant it buys: on a settled board `selectedIds` IS its own live
   * subset, so the modifier gestures extend from the same set the verbs act on.
   */
  const boardSettled =
    items.data !== undefined && !items.isFetching && !lensLoading;
  // Spend a table→board seed once the board's columns have settled. Keyed on the
  // primitives that decide it, not on the columns array.
  const onBoard = rowView === null;
  const seedPos =
    boardCursorSeed === null || !onBoard
      ? null
      : boardCursorSeed.itemId === null
        ? null
        : findCard(columns, boardCursorSeed.itemId);
  const seedCol = seedPos?.col ?? null;
  const seedIdx = seedPos?.idx ?? null;
  // The fallback landing when the seed's card isn't there (or there was none): the
  // board's first card, the tab stop's own fallback.
  const firstPos = firstCardPosition(columns);
  const firstCol = firstPos?.col ?? null;
  const firstIdx = firstPos?.idx ?? null;
  const firstItemId =
    firstPos === null
      ? null
      : (columns[firstPos.col]?.items[firstPos.idx]?.itemId ?? null);
  useEffect(() => {
    if (boardCursorSeed === null || !onBoard || !boardSettled) return;
    const { itemId, claim } = boardCursorSeed;
    setBoardCursorSeed(null);
    if (seedCol !== null && seedIdx !== null) {
      setCursor({ col: seedCol, idx: seedIdx });
      if (!claim) return;
      // The mounted columns claim on this bump, by index and by the card's id.
      setFocusItemId(itemId);
      setFocusNonce((n) => n + 1);
      return;
    }
    if (!claim) return;
    // No card to carry (a header held focus, or the card didn't survive): the
    // board's first card, else the shared landing.
    if (firstCol !== null && firstIdx !== null) {
      setCursor({ col: firstCol, idx: firstIdx });
      setFocusItemId(firstItemId);
      setFocusNonce((n) => n + 1);
      return;
    }
    focusBodyLanding(rootRef.current);
  }, [
    boardCursorSeed,
    onBoard,
    boardSettled,
    seedCol,
    seedIdx,
    firstCol,
    firstIdx,
    firstItemId,
  ]);
  // Spent once the table is drawn; its nonce effect claims the cursor cell.
  useEffect(() => {
    if (!tableFocusClaim || onBoard) return;
    setTableFocusClaim(false);
    setFocusNonce((n) => n + 1);
  }, [tableFocusClaim, onBoard]);
  const selectionDrifted =
    boardSettled && liveSelection.size !== selectedIds.size;
  const anchorGone =
    boardSettled &&
    selectionAnchorId !== null &&
    findCard(columns, selectionAnchorId) === null;
  // Rides a `useEffectEvent` so the effect's deps stay the two primitive verdicts
  // above: `liveSelection` and `columns` are re-derived every render, and listing
  // either would re-run this on every one of them.
  const retireLostSelection = useEffectEvent(() => {
    // Size alone decides: `liveSelection` is a subset of `selectedIds` by
    // construction, so an equal size means nothing was lost and a fresh Set would
    // only re-render every mounted card through the columns' memo.
    if (liveSelection.size !== selectedIds.size) setSelectedIds(liveSelection);
    if (
      selectionAnchorId !== null &&
      findCard(columns, selectionAnchorId) === null
    )
      setSelectionAnchorId(null);
  });
  useEffect(() => {
    if (selectionDrifted || anchorGone) retireLostSelection();
  }, [selectionDrifted, anchorGone]);
  // How big the selection was when it was last spoken. A held Shift+Arrow grows it
  // one card per repeat, so the announcement waits for the burst to stop rather
  // than reading every step out — the TRAILING edge is the only size the user is
  // actually asking about. Sizes below two say nothing here: a singleton is the
  // cursor, and Esc's own "Selection cleared" covers the way down to none.
  const announcedSizeRef = useRef(0);
  useEffect(() => {
    if (announcedSizeRef.current === selectionSize) return;
    const timer = setTimeout(() => {
      announcedSizeRef.current = selectionSize;
      if (selectionSize >= 2) announce(`${selectionSize} ${noun}s selected`);
    }, 250);
    return () => clearTimeout(timer);
  }, [selectionSize, announce, noun]);

  /** The selected cards themselves, in the board's own draw order — what every
   *  bulk verb partitions, read at FIRE time. */
  function selectedCards(): BoardItem[] {
    if (selectionSize === 0) return [];
    return columns.flatMap((column) =>
      column.items.filter((item) => liveSelection.has(item.itemId)),
    );
  }

  /** Back to no selection at all. Fired everywhere the cursor resets today (the
   *  columns are about to hold a different set of cards), by Esc, and by every
   *  bulk verb as it goes out. */
  function clearSelection() {
    setSelectedIds(NO_SELECTION);
    setSelectionAnchorId(null);
  }

  /** Collapse to one card and re-anchor there — what a plain click and a plain
   *  arrow both do, and the fallback for a Shift gesture whose anchor the board
   *  has stopped drawing. */
  function selectOnly(itemId: string) {
    // Already exactly this card: a fresh Set would be a new identity for the same
    // selection, re-rendering every mounted card through the columns' memo on a
    // click that changed nothing.
    if (
      selectedIds.size === 1 &&
      selectedIds.has(itemId) &&
      selectionAnchorId === itemId
    )
      return;
    setSelectedIds(new Set([itemId]));
    setSelectionAnchorId(itemId);
  }

  /** Add or drop one card. `reanchor` is false for the cross-column Shift alone,
   *  which adds the card without moving the anchor the user set. */
  function selectToggle(itemId: string, reanchor = true) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
    if (reanchor) setSelectionAnchorId(itemId);
  }

  /**
   * Extend from the anchor to `itemId`, COLUMN-SCOPED. A range REPLACES the
   * selection rather than adding to it, which is what lets a user walk one back
   * down with Shift held; the anchor stays put so every extension is measured from
   * the same card.
   *
   * `seedAnchorId` is where the gesture STARTED, used only when there is no anchor
   * yet. Nothing seeds one on its own — a Tab into the board moves the cursor
   * without touching the selection, and Esc drops the anchor with it — so without
   * this the first Shift+Arrow (or Shift+click) of a run would range from the card
   * it landed ON and select that alone, losing the card the user started from.
   * That is a NEVER-SET anchor, which is a different thing from the PRUNED one
   * {@link columnRange}'s own null covers.
   */
  function selectRange(itemId: string, seedAnchorId: string | null = null) {
    const anchorId = selectionAnchorId ?? seedAnchorId;
    // A table's range runs over its VISIBLE rows, sections included; a board's
    // stays inside one column.
    const ids =
      anchorId === null
        ? null
        : rowView !== null
          ? rowRange(
              tableEntries.flatMap((entry) =>
                entry.kind === "item" ? [entry.item] : [],
              ),
              anchorId,
              itemId,
            )
          : columnRange(columns, anchorId, itemId);
    if (ids !== null) {
      setSelectedIds(new Set(ids));
      // A seeded anchor has to be RECORDED, or the next extension seeds again from
      // wherever the cursor has since got to and the range walks its own start.
      if (selectionAnchorId === null) setSelectionAnchorId(anchorId);
      return;
    }
    // No anchor, or one the board no longer draws: nothing to extend from, so the
    // landed card becomes the selection and the new anchor (ChangesPanel's
    // hidden-anchor rule). A live anchor in ANOTHER column is the other null, and
    // it toggle-adds — a kanban has no honest two-dimensional range. On a table
    // that null is an anchor inside a COLLAPSED section, which a range may not
    // select through.
    if (anchorId !== null && findCard(columns, anchorId) !== null)
      selectToggle(itemId, false);
    else selectOnly(itemId);
  }

  /** Take the board back to no lens: its whole item set, its own POSITION order,
   *  no chips. The GROUPING stays where it is — a view seeds it once, and what
   *  the user has in front of them is their own pick from then on. */
  function clearView() {
    pickGenerationRef.current += 1;
    setActiveViewId(null);
    setLayoutPick(null);
    setCursor(null);
    seedBoardCursor("board");
    reanchorTable();
    clearSelection();
  }

  /** Leaving ROWS (a table or a roadmap) for a board keeps the cursor's card, the
   *  way arriving at rows does: the board's cursor is index-shaped and the columns
   *  it will index aren't drawn yet, so the card id is held until they are (see
   *  `boardCursorSeed`). A board-to-board switch keeps its own reset. Every
   *  direction that swaps the layout also carries DOM focus across when the layout
   *  being left held it. */
  function seedBoardCursor(to: Surface) {
    // Whether the layout being left holds DOM focus — the palette route, where the
    // focused card or cell unmounts under it. The popover route holds focus in its
    // own popup and hands nothing across.
    const active = document.activeElement;
    const held =
      active instanceof Element &&
      (rootRef.current?.contains(active) ?? false) &&
      active.closest("[data-table-cell], [data-card-index]") !== null;
    // A layout change retires the peek, as the flip handoff does.
    if (surface !== to) setPeekItemId(null);
    if (rowView === null) {
      setTableFocusClaim(held && to !== "board");
      return;
    }
    // Rows to rows re-anchors through `reanchorTable` alone; only a board arrival
    // spends a seed. A table↔roadmap switch swaps the grid itself, so the next one
    // claims the focus the last one held.
    if (to !== "board") {
      setBoardCursorSeed(null);
      setTableFocusClaim(held && to !== surface);
      return;
    }
    const itemId =
      liveCursor === null
        ? undefined
        : columns[liveCursor.col]?.items[liveCursor.idx]?.itemId;
    setBoardCursorSeed(
      itemId === undefined && !held
        ? null
        : { itemId: itemId ?? null, claim: held },
    );
  }

  /** Close whatever cell editor is open without writing, retiring its run. */
  function retireCellEditor() {
    cellEditSessionRef.current += 1;
    setEditingCell(null);
  }

  /** A view switch's retirement for the table's transient state: sections of the
   *  previous grouping mean nothing under the next, and the table cursor re-anchors
   *  on the CARD the cursor is on now, board or table, so it maps by item id
   *  wherever that item survives the switch. Not its column: the next view lists
   *  different ones. */
  function reanchorTable() {
    retireCellEditor();
    setCollapsedGroups(NO_COLLAPSED);
    const itemId =
      liveCursor === null
        ? undefined
        : columns[liveCursor.col]?.items[liveCursor.idx]?.itemId;
    setTableCursor(
      itemId === undefined ? null : { rowKey: itemRowKey(itemId), colIndex: 0 },
    );
  }

  /** Selecting a view is an EVENT, never an effect: the grouping seed fires once,
   *  here, so a Group-by change made UNDER an active view stands rather than being
   *  re-seeded on the next render. `known` is a view this render's list can't hold
   *  yet — one a write just created, picked from that write's continuation. */
  function pickView(nextId: string | null, known?: ProjectViewDef) {
    pickGenerationRef.current += 1;
    setActiveViewId(nextId);
    setLayoutPick(null);
    const picked =
      nextId === null
        ? null
        : (viewList.find((v) => v.id === nextId) ?? known ?? null);
    // Seeded only from a grouping this board can actually draw, off the same
    // `groupableFields` set the Group-by rows offer — which is the board's
    // single-selects AND its iteration fields, so a view grouped either way seeds.
    // A table view groups by nothing, and a view grouped by anything else (a
    // multi-select, an issue field) leaves the current grouping alone.
    const vgroup = picked?.verticalGroupFieldIds[0];
    if (vgroup !== undefined && groupFields.some((f) => f.id === vgroup))
      setPickedFieldId(vgroup);
    // A roadmap's date sources seed here for the grouping's reason, off the
    // definitions as they are at the pick — the switcher holds its rows until
    // they have arrived — and every pick starts again at Month.
    datesSeededRef.current = picked?.layout === "roadmap";
    setDatePicks(
      picked?.layout === "roadmap"
        ? seedDateSources(picked, fieldDefs)
        : NO_DATE_SOURCES,
    );
    setZoom("month");
    // The columns are about to hold a different set of cards.
    setCursor(null);
    seedBoardCursor(surfaceOf(picked));
    reanchorTable();
    clearSelection();
  }

  /** Show or hide the board's archived cards. A different set of cards either way,
   *  so the cursor can't address what it was on. Takes the state it is going TO
   *  rather than flipping what it finds: the checkbox row reports the value it now
   *  holds, and an idempotent setter can't be double-applied by one click. */
  function setArchivedShown(next: boolean) {
    setShowArchived(next);
    setCursor(null);
    clearSelection();
  }

  /** Put a different board on screen — the picker's pick, a project just
   *  created, or null for the catalog's own fallback after a delete. */
  function switchProject(nextId: string | null) {
    pickGenerationRef.current += 1;
    setPickedProjectId(nextId);
    // The new board defines its own fields, and the cursor addresses columns that
    // are about to be replaced.
    setPickedFieldId(null);
    // A lens belongs to the board it was picked on. Leaving the id set reads as
    // "no view" on any other board, but returning to this one would find it again
    // and re-apply its filter, sort and chips WITHOUT the grouping seed, which
    // only `pickView` performs.
    setActiveViewId(null);
    setLayoutPick(null);
    setCursor(null);
    // The table's transient state belongs to the board it was built on: no row or
    // section of it exists on the next one.
    setTableCursor(null);
    setCollapsedGroups(NO_COLLAPSED);
    retireCellEditor();
    clearSelection();
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

  /** The card a TABLE row stands for, resolved off the row's `data-item-id` into
   *  the same {col, idx} the shared machinery addresses — the row arm beside
   *  {@link cardAt}. Null for a group header, which is no card. */
  function rowAt(el: Element): { col: number; idx: number } | null {
    const itemId = el.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
    return itemId === undefined ? null : findCard(columns, itemId);
  }

  /** Where `el` sits in whichever layout is drawn. */
  function positionAt(el: Element): { col: number; idx: number } | null {
    return rowView !== null ? rowAt(el) : cardAt(el);
  }

  /** The node a press or a hand-off focuses in whichever layout is drawn: a card
   *  on the board, a cell in the table. */
  const focusableSelector =
    rowView !== null ? "[data-table-cell]" : "[data-card-index]";

  /** A table cell took focus: the cursor follows it. A group header reports no
   *  column of its own, so a walk passing through it keeps the one it was on. */
  const onTableCellFocus = useCallback(
    (rowKey: string, colIndex: number | null) =>
      setTableCursor((prev) => {
        const col = colIndex ?? prev?.colIndex ?? 0;
        return prev?.rowKey === rowKey && prev.colIndex === col
          ? prev
          : { rowKey, colIndex: col };
      }),
    [],
  );

  /** Collapse or expand one table section. A cursor inside it re-lands on its
   *  header by resolution, so nothing here has to chase it. */
  const toggleGroup = useCallback(
    (bucketId: string) =>
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (!next.delete(bucketId)) next.add(bucketId);
        return next;
      }),
    [],
  );

  /**
   * The table's keyboard: the grid pattern's 2D walk, the board's reposition
   * chords on an item row, and Enter/Space on the cell. Scoped by DOM containment
   * like the board's handler, for the same portalled-popup reason. A ROW move
   * carries the selection the way the board's vertical keys do — plain collapses
   * to the landed row, Shift extends the range over the visible rows — while a
   * column move leaves it alone, since the selection is row-scoped.
   */
  function onTableKeyDown(e: KeyboardEvent<HTMLDivElement>, pageSize: number) {
    // A key typed inside a cell editor or a peek reaches here through React's
    // component tree; its TARGET is the portalled popup, which the grid does not
    // contain, and those keys are the popup's own.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))
      return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !e.currentTarget.contains(focused))
      return;
    // The board's own Esc, gated at two for the board's reason.
    if (e.key === "Escape") {
      if (selectionSize < 2) return;
      e.preventDefault();
      clearSelection();
      announce("Selection cleared");
      return;
    }
    // Where the user IS: the focused cell, else the cursor — a bare Tab into the
    // grid moves focus without a key the cursor heard.
    const rowKey =
      focused.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    const at = tableEntries.findIndex((entry) => entry.key === rowKey);
    const cellCol = Number(
      focused.closest<HTMLElement>("[data-col-index]")?.dataset.colIndex,
    );
    const from =
      at === -1
        ? tablePos
        : {
            rowIndex: at,
            colIndex:
              tableEntries[at].kind === "item" && Number.isInteger(cellCol)
                ? cellCol
                : (tablePos?.colIndex ?? 0),
          };
    const entry = from === null ? undefined : tableEntries[from.rowIndex];
    if (from === null || entry === undefined) return;
    // The board's reposition chords, ahead of the plain keys they share, and on
    // an item row only — a header is no card.
    const chord = eventToBinding(e);
    const direction = chord === null ? undefined : REORDER_CHORDS[chord];
    if (direction !== undefined) {
      e.preventDefault();
      const card =
        entry.kind === "item" ? findCard(columns, entry.item.itemId) : null;
      if (card !== null) reorderCard(card, direction);
      return;
    }
    // The roadmap's date-shift chords, on a lane cell alone; on the title cell
    // they say where they work rather than being swallowed silently. Matched on
    // the canonical binding, so AltGraph (character input) never reaches here.
    const shift =
      chord === null || roadmapView === null ? undefined : SHIFT_CHORDS[chord];
    if (shift !== undefined && entry.kind === "item") {
      e.preventDefault();
      if (from.colIndex === 1)
        shiftItemDates(entry.item, shift.mode, shift.dir);
      else {
        announce(SHIFT_ON_TITLE_REASON);
        toast(SHIFT_ON_TITLE_REASON, { id: SHIFT_REFUSAL_TOAST_ID });
      }
      return;
    }
    if (e.altKey && ALT_SWALLOWED_KEYS.has(e.key)) {
      e.preventDefault();
      return;
    }
    // Enter and Space act on the cell: a header toggles its section, a board
    // field's cell opens its editor (or says why it can't), and every other cell
    // opens the item (Enter) or peeks at it (Space), as a board card does.
    if (chord === "enter" || chord === "space") {
      e.preventDefault();
      const def = tableCols[from.colIndex]?.def;
      if (entry.kind === "group") toggleGroup(entry.bucketId);
      else if (def !== undefined && isWritable(def))
        requestCellEdit(entry.item, def.id);
      else if (chord === "space") peekRow(entry.item);
      else activateRow(entry.item);
      return;
    }
    // Shift rides the same keys to extend rather than move alone, so the move is
    // read off the chord without it.
    const move =
      chord === null ? undefined : TABLE_MOVES[chord.replace("shift+", "")];
    if (move === undefined) return;
    // Swallowed whether or not anything moved: a focused grid must never scroll
    // under a key it owns.
    e.preventDefault();
    const next = stepTableCursor(
      tableEntries,
      from,
      move,
      rowColCount,
      pageSize,
    );
    const landed = tableEntries[next.rowIndex];
    if (landed === undefined) return;
    if (next.rowIndex === from.rowIndex && next.colIndex === from.colIndex) {
      // A clamped move on a roadmap lane still re-claims it: the claim scrolls
      // the item's mark into view, which is the way back to a bar left off
      // screen by a jump or a Tab in.
      if (
        roadmapView !== null &&
        entry.kind === "item" &&
        from.colIndex === 1
      ) {
        setTableCursor({ rowKey: landed.key, colIndex: 1 });
        setFocusNonce((n) => n + 1);
      }
      return;
    }
    setTableCursor({ rowKey: landed.key, colIndex: next.colIndex });
    setFocusNonce((n) => n + 1);
    if (!TABLE_ROW_MOVES.has(move) || next.rowIndex === from.rowIndex) return;
    // A header is no card: a plain move onto one leaves nothing selected, and a
    // Shift-held one keeps the range until the next row it reaches.
    if (landed.kind === "group") {
      if (!e.shiftKey) clearSelection();
      // A Shift-walk crossing a header keeps the row it started from: seed the
      // anchor there now, or the next Shift-move would seed from the header and
      // lose it. An existing anchor already holds the origin and is left alone.
      else if (entry.kind === "item" && selectionAnchorId === null)
        selectRange(entry.item.itemId, entry.item.itemId);
      return;
    }
    // THE SEEDING SITE for a keyboard range on the table, the twin of the board's:
    // the row the press started on is the anchor a first Shift+move means.
    if (e.shiftKey)
      selectRange(
        landed.item.itemId,
        entry.kind === "item" ? entry.item.itemId : null,
      );
    else selectOnly(landed.item.itemId);
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
    // Esc ahead of the cursor resolution: clearing a selection is an answer the
    // board owes even when the cursor is addressing nothing. Gated at TWO, not at
    // one: a plain click or arrow leaves a singleton behind, so a one-card gate
    // would have Esc announce "Selection cleared" and swallow the key on an
    // ordinary board where nothing visibly changed. A singleton IS the cursor, and
    // Esc goes on doing there whatever it did before selections existed.
    // The containment test above is what scopes this to the board: a keystroke
    // typed inside an open popover or menu is a DOM descendant of neither, so it
    // has already returned.
    if (e.key === "Escape") {
      if (selectionSize < 2) return;
      e.preventDefault();
      clearSelection();
      announce("Selection cleared");
      return;
    }
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
    // Alt belongs to the REPOSITION chords, so any other Alt-modified key the board
    // owns is swallowed rather than let through: Alt+Shift+Arrow would otherwise
    // fall to the bare-key switch below and do BOTH things at once — move the
    // cursor and extend the range — off a chord that means neither.
    if (e.altKey && ALT_SWALLOWED_KEYS.has(e.key)) {
      e.preventDefault();
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
        // A HELD Shift here means the user is extending and has run out of
        // column, so the board says so rather than collapsing the selection to
        // the neighbour it would otherwise step to — a silent collapse under a
        // held modifier is the one outcome this refuses.
        if (e.shiftKey) {
          e.preventDefault();
          announce(SELECTION_SIDEWAYS_REASON);
          return;
        }
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
    const landed = columns[next.col].items[next.idx];
    setFocusItemId(landed?.itemId ?? null);
    setFocusNonce((n) => n + 1);
    // The selection follows the cursor: a plain move collapses to the card it
    // landed on, a Shift-held one extends the range from the anchor. Same split
    // the pointer keeps, so the two routes can't drift.
    if (landed === undefined) return;
    // THE SEEDING SITE for a keyboard range. `from` is the card the press started
    // on, which is the anchor a first Shift+Arrow means — the pure helper can't
    // supply it, since "there is no anchor yet" is panel state rather than a
    // property of the columns.
    if (e.shiftKey)
      selectRange(landed.itemId, column.items[from.idx]?.itemId ?? null);
    else selectOnly(landed.itemId);
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
  // The roadmap's date shifts, which coalesce per card the same way.
  const shiftWrite = useShiftItemDates();
  const convertDraft = useConvertDraftItem();
  const updateDraft = useUpdateDraftItem();
  const archiveItem = useArchiveBoardItem();
  const restoreItem = useRestoreBoardItem();
  const removeItem = useRemoveBoardItem();
  // The same four verbs over a SELECTION. One instance each, like the single-card
  // writes, and single-flight by the same contract — every bulk control is held
  // while any board write runs.
  const bulkMove = useBulkMoveBoardCards();
  const bulkArchive = useBulkArchiveBoardItems();
  const bulkRestore = useBulkRestoreBoardItems();
  const bulkRemove = useBulkRemoveBoardItems();
  const bulkFields = useBulkSetItemFieldValues();
  /** Whether the bulk fields editor is open, and the cards it was opened over —
   *  its hints' source, recorded at the click for the reason {@link openBulkFields}
   *  states. */
  const [bulkFieldsOpen, setBulkFieldsOpen] = useState(false);
  const [bulkFieldCards, setBulkFieldCards] = useState<BoardItem[]>(NO_CARDS);
  /** Which RUN of the bulk fields editor is current. An Apply's continuation
   *  outlives the editor that fired it — Cancel stays live through the write, and
   *  closing doesn't unmount this dialog — while the close it performs is a panel
   *  setter every run shares. Without the token, a resolution from a cancelled run
   *  shuts whichever editor is open by then and discards the draft in it. The
   *  discipline {@link dialogSessionRef} keeps for the add dialogs, and it is a ref
   *  for the same reason: a write that settles while the tab is hidden must not
   *  have needed a render to be seen. */
  const bulkFieldsSessionRef = useRef(0);
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
  // Apart from `cardWritePending` rather than folded into it: the bulk kinds carry
  // a LIST where that set's members carry an `itemId`, so the per-card gates can't
  // read them, and what the user is waiting on says something different.
  const bulkWritePending = pendingWrites.some(
    (w) => w.kind !== null && BULK_WRITE_KINDS.has(w.kind),
  );
  // The one derivation every surface reads for that hold: a single field write
  // over one item says so, anything wider keeps the bulk wording.
  const bulkPendingWrites = pendingWrites.filter(
    (w) => w.kind !== null && BULK_WRITE_KINDS.has(w.kind),
  );
  const bulkPendingReason =
    bulkPendingWrites.length === 1 &&
    bulkPendingWrites[0].kind === "bulk-fields" &&
    bulkPendingWrites[0].count === 1
      ? FIELD_PENDING_REASON
      : BULK_PENDING_REASON;
  // The one bulk kind the CURSOR has to follow, and so the only one the chase
  // waits on: a bulk move re-buckets its cards into another column, where the
  // other three either leave them in place or take them off the board entirely.
  const bulkMovePending = pendingWrites.some((w) => w.kind === "bulk-move");
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
   *  card's own Space key, and the menu row the panel owns. Retired with its anchor
   *  (`peekGone` below), like the cell editor's session. */
  const [peekItemId, setPeekItemId] = useState<string | null>(null);

  /** Whether a peek has anywhere to draw: a table's peek anchors to the Title cell,
   *  so a view without that column has none. A roadmap's rail always is one. */
  const canPeek =
    tableView === null || tableCols.some((column) => column.title);

  /** A table row's peek: an issue or pull request's details, or a draft's notes,
   *  which the board shows from the card itself. A redacted row has none. */
  function peekRow(item: BoardItem) {
    if (canPeek && item.content.kind !== "redacted") setPeekItemId(item.itemId);
  }

  /** What Enter or a click on the title does to a table row: open an issue or
   *  pull request, and show a draft's notes — which is what its board card's click
   *  does. */
  const activateRow = useCallback(
    (item: BoardItem) => {
      if (item.content.kind === "draft") setPeekItemId(item.itemId);
      else openItem(item);
    },
    [openItem],
  );
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
  /** The status update editor: a new post, an edit, or closed. Apart from
   *  `addDialog` because it writes to the PROJECT rather than the board, so no
   *  board dialog is its alternative, and its run is marked by the state object
   *  itself rather than the session token above. */
  const [statusEditor, setStatusEditor] = useState<StatusEditorState>(null);
  /** Open a new post — only over a CLOSED editor. The dialog seeds on its open
   *  transition alone, so replacing an open run in place would post with that
   *  run's draft rather than a fresh one. */
  function openStatusPost() {
    setStatusEditor((current) => current ?? { mode: "create" });
  }

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
  // The selection bar, so a control inside it can hand focus back to the board
  // before the bar unmounts under it.
  const selectionBarRef = useRef<HTMLDivElement>(null);
  /** The card the cursor sat on before the current pointer press moved it — the
   *  anchor a Shift+click seeds from when the selection has none yet. A ref
   *  because pointerdown and mousedown are separate dispatches with a render
   *  between them, so state written by the first is already visible to the
   *  second. */
  const prePressCardRef = useRef<string | null>(null);
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
    // A BULK move counts as unsettled here exactly as a single move does. Without
    // it the chase would read the card at its PRE-patch place — the optimistic
    // re-bucketing lands a cancel and a notify-batch later — stamp that, and
    // disarm before the card ever moved, parking the cursor in the column the
    // cards just left.
    const settled = !movePending && !bulkMovePending;
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
      // The table's cursor follows the same card by identity, into whatever
      // section it landed in.
      setTableCursor((prev) => ({
        rowKey: itemRowKey(chase),
        colIndex: prev?.colIndex ?? 0,
      }));
      setFocusNonce((n) => n + 1);
      if (settled) setChase(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [chase, chaseCol, chaseIdx, menuBusy, movePending, bulkMovePending]);

  // The card an archive or a removal took off the board, and where it sat. The
  // ABSENCE of it from the columns is the arming edge, not the write settling: the
  // write settles, THEN the invalidation's refetch lands, and only that redraw says
  // the board agrees. A failed refetch leaves the card drawn and this latched, so
  // the dead arm below disarms it rather than re-scanning the columns every render.
  const [retired, setRetired] = useState<{
    itemId: string;
    col: number;
    idx: number;
    /** The row's FLAT slot among the table's drawn item rows; null on the board. */
    slot: number | null;
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
  // Where focus goes once the card is gone: on the board, its own slot in the
  // column it left, clamped to whatever still stands there, and the board's first
  // card when that column emptied. In the table, its FLAT slot among the drawn rows
  // (`itemAtRowSlot`), since a section is a column and emptying one must hand on
  // to the next section rather than jump to the top; with no item row drawn at all
  // (every section left folded), the first card, whose cursor re-lands on its
  // folded header. Derived here so the effect's deps are the primitives that
  // actually decide the landing, not a fresh array.
  const landing = (() => {
    if (!retiredGone || retired === null) return null;
    if (retired.slot !== null) {
      const itemId = itemAtRowSlot(tableEntries, retired.slot);
      return itemId === null
        ? firstCardPosition(columns)
        : findCard(columns, itemId);
    }
    const left = columns[retired.col]?.items.length ?? 0;
    return left > 0
      ? { col: retired.col, idx: Math.min(retired.idx, left - 1) }
      : firstCardPosition(columns);
  })();
  const landingCol = landing?.col ?? null;
  const landingIdx = landing?.idx ?? null;
  // The card standing in the landing slot, which is what the TABLE cursor keys on.
  const landingItemId =
    landing === null
      ? null
      : (columns[landing.col]?.items[landing.idx]?.itemId ?? null);
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
      // with the card, so leaving it alone drops a keyboard user to <body>. It
      // takes the shared landing ({@link focusBodyLanding}: the filter-emptied
      // notice's Clear view, else Add item), a frame past the dialog's restore.
      //
      // The latch is released INSIDE the frame, never beside it: `setRetired`
      // flips `retiredGone`, which is one of this effect's deps, so clearing it
      // here would re-run the effect and fire the cleanup below — cancelling the
      // very frame that does the work. The move's chase keeps its own release in
      // its callback for the same reason. That leaves the cleanup owning the
      // cancel for the cases it should: an unmount, an `<Activity>` hide, or a
      // card arriving that gives the cursor a real landing after all.
      setCursor(null);
      setTableCursor(null);
      const frame = requestAnimationFrame(() => {
        focusBodyLanding(rootRef.current);
        setRetired(null);
      });
      return () => cancelAnimationFrame(frame);
    }
    setRetired(null);
    setCursor({ col: landingCol, idx: landingIdx });
    // A SLOT, not a card: the landing is wherever the departed card's place fell
    // to, so the claim is index-only by design. The table's slot is the flat one
    // above, and its cursor keys on whichever row now fills it.
    setFocusItemId(null);
    if (landingItemId !== null)
      setTableCursor((prev) => ({
        rowKey: itemRowKey(landingItemId),
        colIndex: prev?.colIndex ?? 0,
      }));
    setFocusNonce((n) => n + 1);
  }, [retiredGone, retiredDead, landingCol, landingIdx, landingItemId]);

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
  const retireBoardDialogs = useEffectEvent(() => {
    switchAddDialog(null);
    // The bulk fields editor retires on the same edge and for a sharper version of
    // the same reason: its rows are THIS board's field definitions and its draft
    // addresses this board's memberships, so a silent re-point would leave a draft
    // aimed at fields the new board may not even define. Its card snapshot goes
    // with it — the selection behind it belonged to the previous board.
    //
    // The token is retired as well as the state: a write still in flight against
    // the OLD board must not be allowed to decide anything about the editor once
    // this board's own run opens.
    bulkFieldsSessionRef.current += 1;
    setBulkFieldsOpen(false);
    setBulkFieldCards(NO_CARDS);
    // A cell editor is the same draft against the same board, retired the same way.
    retireCellEditor();
    // A status post would land on the re-pointed project under the old one's
    // title, and an edit names an entry the new project doesn't hold.
    setStatusEditor(null);
    // The project and view dialogs address the board they opened on. A new
    // project addresses none, and its own success is one of the re-points.
    if (lifecycleOpen && lifecycle?.kind !== "new-project") closeLifecycle();
  });
  useEffect(() => {
    if (dialogProjectRef.current === projectId) return;
    dialogProjectRef.current = projectId;
    retireBoardDialogs();
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
      case bucketField?.kind === "singleSelect" && bucketField.isIssueField:
        return ISSUE_FIELD_REASON;
      // Under the three arms above, which say a move is impossible HERE whatever the
      // card is: an archived card sits in no column, so a column pick has nothing to
      // write — and the restore row is what clears this one.
      case item.isArchived:
        return ARCHIVED_ITEM_REASON[noun];
      // Above the two that clear on their own: the cards drawn while a lens loads
      // are the PREVIOUS view's, so the column a pick names isn't the one the board
      // is about to have.
      case lensLoading:
        return LENS_LOADING_REASON;
      case bulkWritePending:
        return bulkPendingReason;
      case movePending:
        return MOVING_REASON[noun];
      case cardWritePending:
        return ITEM_WRITE_REASON[noun];
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
      case bulkWritePending:
        return bulkPendingReason;
      case movePending:
        return MOVING_REASON[noun];
      case cardWritePending:
        return ITEM_WRITE_REASON[noun];
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
        return ARCHIVED_ITEM_REASON[noun];
      case bulkWritePending:
        return bulkPendingReason;
      case movePending:
        return MOVING_REASON[noun];
      case cardWritePending:
        return ITEM_WRITE_REASON[noun];
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
   *  No selection-size arm, deliberately: chords and palette rows reposition the
   *  CURSOR card with the selection intact (Alt means "act on the card"); only the
   *  menu holds its Position rows, because a menu opened on a selection reads as
   *  acting on all of it.
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
        return ARCHIVED_ITEM_REASON[noun];
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
        return SORTED_VIEW_REASON[noun];
      // A table drawn in sections: each section is a slice of the project order
      // rather than the order itself, so a row's drawn neighbour needn't be the
      // one a position write would land it beside.
      case rowView !== null && rowGroupField !== null:
        return GROUPED_ROWS_REASON;
      case lensLoading:
        return LENS_LOADING_REASON;
      // Board-wide rather than per card, unlike the arm below it: a bulk write
      // addresses a LIST no `itemId` names, and its settle re-reads the order this
      // position write is computed against.
      case bulkWritePending:
        return bulkPendingReason;
      case pendingWrites.some(
        (w) =>
          w.itemId === itemId &&
          w.kind !== null &&
          w.kind !== "reorder" &&
          CARD_WRITE_KINDS.has(w.kind),
      ):
        return ITEM_WRITE_REASON[noun];
      // A reposition settles through the same cancel every board write does, and
      // query-core's cancel REVERTS an in-flight fetch — so starting one now would
      // silently undo the page the user just asked for.
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  }

  /** Why EVERY bulk verb is held, or undefined when they're live. Ranked like the
   *  card actions and on the same flags, plus the two that clear on their own: a
   *  selection built under one lens names cards the next one may not draw, and a
   *  page fetch is cancel-reverted by any write's settle. Re-checked inside every
   *  fired handler, never trusted from the render that disabled a button. */
  const bulkHeldReason = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return BOARD_READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      case lensLoading:
        return LENS_LOADING_REASON;
      case bulkWritePending:
        return bulkPendingReason;
      case boardWritePending:
        return ITEM_WRITE_REASON[noun];
      case items.isFetchingNextPage:
        return LOADING_PAGE_REASON;
      default:
        return undefined;
    }
  })();
  /** Open a table cell's editor, or say why it can't open. The hold is re-derived
   *  here rather than trusted from the render that drew the cell, and it is the
   *  SAME derivation the cell draws its reason from. */
  function requestCellEdit(item: BoardItem, fieldId: string) {
    const def = tableCols.find((column) => column.def.id === fieldId)?.def;
    if (def === undefined || !isWritable(def)) return;
    const held = cellEditHeld(cellBoardHeld, item, def);
    if (held !== undefined) {
      announce(held);
      toast(held, { id: CELL_EDIT_REFUSAL_TOAST_ID });
      return;
    }
    cellEditSessionRef.current += 1;
    setEditingCell({
      itemId: item.itemId,
      fieldId,
      session: cellEditSessionRef.current,
    });
  }

  /**
   * Write one cell's committed draft: the bulk fields write with a single item,
   * so its pending line, its hold on every other cell and bulk verb, its settle
   * re-read and its failure report are all the bulk family's own — no second kind.
   * NO optimistic patch, for that family's reason: a field write can move the row
   * between groups and through the sort, which only the server's re-read can say.
   *
   * Every read happens before the await. Nothing after it closes or re-points
   * anything, so there is no stale-run hazard past the write itself.
   */
  async function commitCellEdit(
    itemId: string,
    fieldId: string,
    entry: FieldDraft,
  ) {
    const run = editingCell;
    // A close from a run that has since been retired (a project or view switch in
    // the same tick) belongs to a draft nobody is looking at any more.
    if (run === null || run.session !== cellEditSessionRef.current) return;
    // Consuming the run SPENDS it: a second commit reaching this same render's
    // closure finds a token that no longer matches, whatever the timing.
    cellEditSessionRef.current += 1;
    setEditingCell(null);
    if (run.itemId !== itemId || run.fieldId !== fieldId) return;
    // Enter on an entry the field can't take yet closes the editor having written
    // nothing, which a keyboard user can't see from the unchanged cell.
    if (entry === INVALID_DRAFT) {
      announce(CELL_INVALID_ENTRY_NOTE);
      return;
    }
    if (projectId === null) return;
    const at = findCard(columns, itemId);
    const item = at === null ? undefined : columns[at.col]?.items[at.idx];
    const def = tableCols.find((column) => column.def.id === fieldId)?.def;
    if (item === undefined || def === undefined || !isWritable(def)) return;
    // The single-item editor's defensive twin: a number that can't be written is
    // not a clear, and not a value either.
    if (
      entry !== null &&
      entry.value.kind === "number" &&
      !Number.isFinite(entry.value.number)
    )
      return;
    // Unchanged is not sent: the same identity test the item editor's diff runs.
    if (
      valueKey(columnValue(item, def) ?? null) ===
      valueKey(entry?.value ?? null)
    )
      return;
    const held = cellEditHeld(cellBoardHeld, item, def);
    if (held !== undefined) {
      announce(held);
      toast(held, { id: CELL_EDIT_REFUSAL_TOAST_ID });
      return;
    }
    try {
      const result = await bulkFields.mutateAsync({
        repo: repoPath,
        projectId,
        itemIds: [itemId],
        updates: entry === null ? [] : [entry.update],
        clears: entry === null ? [def.id] : [],
      });
      // One cell, so its own words rather than the bulk count's: the field it
      // saved, or why it didn't.
      const error =
        result.outcomes.find((outcome) => outcome.error !== null)?.error ??
        null;
      if (error === null) {
        announce(`Saved ${def.name}`);
      } else {
        announce(`Couldn't save ${def.name}`);
        toast.error(
          `Couldn't save ${def.name} — ${presentError(error).summary}`,
        );
      }
    } catch {
      // The mutation reported it. Nothing was patched, so the cell already shows
      // what the board really holds.
    }
  }

  // The cell handlers the memoized rows hold, identity-stable across renders: they
  // call through a ref refreshed after every commit, so a row never re-renders
  // for a handler change and never calls a stale one.
  const cellHandlersRef = useRef({
    request: requestCellEdit,
    commit: commitCellEdit,
  });
  useEffect(() => {
    cellHandlersRef.current = {
      request: requestCellEdit,
      commit: commitCellEdit,
    };
  });
  const onEditCell = useCallback(
    (item: BoardItem, fieldId: string) =>
      cellHandlersRef.current.request(item, fieldId),
    [],
  );
  const onCellCommit = useCallback(
    (itemId: string, fieldId: string, entry: FieldDraft) =>
      void cellHandlersRef.current.commit(itemId, fieldId, entry),
    [],
  );
  // Spends the run like a commit does; a close from a run already retired or
  // replaced is ignored, so it can't shut the editor open now.
  const onCellCancel = useCallback((session: number) => {
    if (session !== cellEditSessionRef.current) return;
    cellEditSessionRef.current += 1;
    setEditingCell(null);
  }, []);
  /** The emptied table's landing, identity-stable for the grid's prop. */
  const focusLanding = useCallback(() => focusBodyLanding(rootRef.current), []);
  // The editor's session retires the moment its cell stops being drawn — the row
  // gone from the RENDERED rows (dropped by a read, or folded into a collapsed
  // section, which unmounts the editor and its draft while the board still holds
  // the item) or its column gone — so no editor reopens later that nobody asked for.
  const cellEditGone =
    editingCell !== null &&
    (!tableEntries.some(
      (entry) =>
        entry.kind === "item" && entry.item.itemId === editingCell.itemId,
    ) ||
      !tableCols.some((column) => column.def.id === editingCell.fieldId));
  useEffect(() => {
    if (!cellEditGone) return;
    cellEditSessionRef.current += 1;
    setEditingCell(null);
  }, [cellEditGone]);
  // The peek retires the same way once its anchor stops being drawn: on the board
  // the card gone from the columns, in the table its row gone from the rendered
  // rows (a read, a collapsed section) or the view drawing no Title column. Left
  // standing, the id would reopen the peek unasked when the row came back.
  const peekGone =
    peekItemId !== null &&
    (onBoard
      ? findCard(columns, peekItemId) === null
      : !tableEntries.some(
          (entry) => entry.kind === "item" && entry.item.itemId === peekItemId,
        ) || !canPeek);
  useEffect(() => {
    if (peekGone) setPeekItemId(null);
  }, [peekGone]);

  // The same gate as of the last COMMIT, readable after an await. A handler's own
  // `bulkHeldReason` is the closure from the render that started it, so a verb the
  // user sat on a confirm prompt for would re-check an answer that predates the
  // prompt. Written from an effect rather than during render, which is the ref
  // write the React Compiler forbids.
  // A table cell's board-wide hold: every bulk hold, plus the re-read a write
  // asked for. Until that read lands the cells still show the values from BEFORE
  // the write, and an editor opened on one would seed from them — a multi-select's
  // commit replaces the whole set, silently undoing the edit that just landed.
  //
  // A re-read that FAILED leaves those same stale values up, so the hold stays,
  // pointing at the strip's Retry, until a read of the board succeeds.
  const cellBoardHeld = (() => {
    switch (true) {
      case bulkHeldReason !== undefined:
        return bulkHeldReason;
      case refreshingAfterWrite || rereadStall === "owed":
        return UPDATING_REASON[surface];
      case rereadFailed:
        return REREAD_FAILED_REASON[surface];
      default:
        return undefined;
    }
  })();
  const bulkHeldRef = useRef(bulkHeldReason);
  useEffect(() => {
    bulkHeldRef.current = bulkHeldReason;
  }, [bulkHeldReason]);

  /** What one bulk verb can do over the CURRENT selection: its eligible cards, the
   *  count-worded label, and why it can't run. The count is always the ELIGIBLE
   *  one — a mixed selection scopes a verb rather than blocking it, so a label that
   *  counted the whole selection would promise cards the write will skip. */
  function bulkState(verb: BulkVerb): {
    cards: BoardItem[];
    label: string;
    reason: string | undefined;
  } {
    const selected = selectedCards();
    const cards = partitionEligible(verb, selected).eligible;
    const n = cards.length;
    const label = {
      move: `Move ${cardCount(n, noun)} to`,
      fields: `Edit fields of ${cardCount(n, noun)}…`,
      archive: `Archive ${cardCount(n, noun)}…`,
      restore: `Restore ${cardCount(n, noun)}`,
      remove: `Remove ${cardCount(n, noun)} from project…`,
    }[verb];
    // The board-wide hold first, then the one this verb has over this selection:
    // "every selected card is already archived" is a statement about the set, and
    // it would be misleading under a sign-in that can't write at all.
    const reason = (() => {
      switch (true) {
        case bulkHeldReason !== undefined:
          return bulkHeldReason;
        // A move needs a column to write, which two of the board's states don't
        // offer — the same pair `moveHeldFor` refuses a single card for. Rows say
        // so in their own terms: the project may well have a field to group by,
        // and it is the VIEW that draws no sections.
        case verb === "move" && bucketField === null:
          return surface === "board"
            ? NO_GROUP_FIELDS_REASON
            : ROWS_UNGROUPED_MOVE_REASON[surface];
        case verb === "move" &&
          bucketField?.kind === "singleSelect" &&
          bucketField.isIssueField:
          return ISSUE_FIELD_REASON;
        case selected.length === 0:
          return BULK_NO_SELECTION_REASON[noun];
        case n === 0:
          return BULK_NOTHING_REASON[verb](noun);
        default:
          return undefined;
      }
    })();
    return { cards, label, reason };
  }

  // The four verbs resolved ONCE, shared by the selection bar and the card menu:
  // both speak for the same selection, and a second derivation is a second thing
  // to keep in step. Null below two cards, which is also what keeps the partition
  // off every render of an ordinary board.
  const bulkRows =
    selectionSize < 2
      ? null
      : {
          move: bulkState("move"),
          fields: bulkState("fields"),
          archive: bulkState("archive"),
          restore: bulkState("restore"),
          remove: bulkState("remove"),
        };
  // The bulk fields dialog OUTLIVES the bar that opened it — the bar stops
  // rendering below two cards, and a refetch can prune the selection under an open
  // dialog — so Apply reads its own live hold rather than the bar's snapshot.
  // Costs nothing while the dialog is closed, which is nearly always.
  // One derivation for both, so the dialog's title and its Apply hold can't
  // disagree about the same selection.
  const bulkFieldsLive = bulkFieldsOpen ? bulkState("fields") : null;
  const bulkFieldsHeld = bulkFieldsLive?.reason;
  const bulkFieldsEligible = bulkFieldsLive?.cards.length ?? 0;

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
  /** Why a status update write is held: the permission arms alone. A status
   *  update is PROJECT state, so no board read or card write can collide with it.
   *  Worded as the short parenthetical a held menu row carries beside its label —
   *  the same two claims as {@link addHeldReason}'s first arms, cut to fit. */
  const statusWriteHeld = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return "needs the project scope";
      case project !== null && !project.viewerCanUpdate:
        return "no write access";
      default:
        return undefined;
    }
  })();
  /** The same two holds as full sentences, for the view buttons in View options,
   *  which carry theirs as a tooltip rather than beside a label. */
  const projectWriteReason = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return BOARD_READ_ONLY_SCOPE_REASON;
      case project !== null && !project.viewerCanUpdate:
        return NO_ACCESS_REASON;
      default:
        return undefined;
    }
  })();
  /** Why a new project can't be created: the scope, or a catalog that never
   *  named the owner a project is created under. Short for the menu row, full
   *  for the empty state's button. */
  const newProjectHeld = (() => {
    switch (true) {
      case projectScopeReadOnly(scopes.data):
        return {
          short: "needs the project scope",
          full: BOARD_READ_ONLY_SCOPE_REASON,
        };
      case !projects.data?.ownerId:
        return {
          short: "owner unknown",
          full: OWNER_UNKNOWN_REASON,
        };
      default:
        return undefined;
    }
  })();
  // Both no-board arms offer it: an empty catalog and a cut-short one alike.
  const newProjectButton = (
    <DisabledReasonButton
      variant="outline"
      size="xs"
      disabled={newProjectHeld !== undefined}
      reason={newProjectHeld?.full}
      onClick={openNewProject}
    >
      <PlusIcon data-icon="inline-start" />
      New project…
    </DisabledReasonButton>
  );

  // One mutation instance per VERB, never shared: each surface's pending state
  // (a dialog's "Saving…", a row's hold) must describe its own write alone.
  const createProject = useCreateProject();
  const editProjectDetails = useUpdateProject();
  const closeProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const createView = useCreateProjectView();
  const renameView = useUpdateProjectView();
  const setViewFields = useUpdateProjectView();
  const saveViewLayout = useUpdateProjectView();
  const deleteView = useDeleteProjectView();
  const duplicateView = useDuplicateProjectView();
  /** The project or view dialog on screen. Kept through the close — only
   *  `lifecycleOpen` drops — so a dialog's title and seeds hold still while it
   *  animates out. */
  const [lifecycle, setLifecycle] = useState<LifecycleDialog | null>(null);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  /** Which run of a lifecycle dialog is current, the contract
   *  {@link dialogSessionRef} keeps for the board's own dialogs: a write that
   *  outlives its dialog may close only the run that fired it. */
  const lifecycleSessionRef = useRef(0);
  function openLifecycle(next: LifecycleDialog) {
    lifecycleSessionRef.current += 1;
    setLifecycle(next);
    setLifecycleOpen(true);
    // Its popover closes first: the dialog is modal, and the popover's rows
    // would otherwise sit under its backdrop.
    setViewOptionsOpen(false);
  }
  function closeLifecycle() {
    lifecycleSessionRef.current += 1;
    setLifecycleOpen(false);
  }
  // A repo switch closes every one of them, New project included: that dialog
  // creates under the catalog's owner, which the switch just replaced. The board
  // re-point retirement (`retireBoardDialogs`) keeps New project open, since a
  // re-point inside one repo changes nothing it writes to. Ref-compared, so an
  // `<Activity>` replay with the same repo does nothing.
  const lifecycleRepoRef = useRef(repoPath);
  const retireLifecycleOnRepoSwitch = useEffectEvent(() => {
    if (lifecycleOpen) closeLifecycle();
  });
  useEffect(() => {
    if (lifecycleRepoRef.current === repoPath) return;
    lifecycleRepoRef.current = repoPath;
    retireLifecycleOnRepoSwitch();
  }, [repoPath]);
  /** Whether a write's continuation still speaks for the screen: the same repo
   *  (the panel outlives a repo switch) and, when given, the same board. */
  function stillShowing(repo: string, boardId: string | null): boolean {
    if (useUiStore.getState().repoPath !== repo) return false;
    return boardId === null || dialogProjectRef.current === boardId;
  }
  // A view a write just created, picked once the render that holds it runs:
  // `pickView` reads this render's lists, which the continuation's closure can't.
  const [pendingViewPick, setPendingViewPick] = useState<ProjectViewDef | null>(
    null,
  );
  const consumeViewPick = useEffectEvent((def: ProjectViewDef) =>
    pickView(def.id, def),
  );
  useEffect(() => {
    if (pendingViewPick === null) return;
    setPendingViewPick(null);
    consumeViewPick(pendingViewPick);
  }, [pendingViewPick]);

  function openNewProject() {
    if (newProjectHeld !== undefined) return;
    openLifecycle({ kind: "new-project" });
  }

  async function submitNewProject(title: string): Promise<void> {
    const ownerId = projects.data?.ownerId;
    // Belt-and-braces: the dialog's Create is held with OWNER_UNKNOWN_REASON then.
    if (!ownerId) return;
    const session = lifecycleSessionRef.current;
    const generation = pickGenerationRef.current;
    const repo = repoPath;
    // Pinned while the create is out: the answer joins the catalog FIRST, and a
    // board shown only as the fallback would otherwise re-point to it (and retire
    // the view on screen) even when this continuation is voided below. The
    // settle's re-read can't reorder a pinned board away either.
    if (pickedProjectId === null && projectId !== null)
      setPickedProjectId(projectId);
    let created: ProjectV2Ref;
    try {
      created = await createProject.mutateAsync({
        repo,
        lens,
        ownerId,
        repositoryId: projects.data?.repositoryId ?? null,
        title,
      });
    } catch {
      // Reported by the hook; the dialog stays open with the title in it.
      return;
    }
    toast.success(`Created ${created.title}`);
    if (session === lifecycleSessionRef.current) closeLifecycle();
    if (stillShowing(repo, null) && generation === pickGenerationRef.current)
      switchProject(created.id);
  }

  function openEditProject() {
    if (project === null || statusWriteHeld !== undefined) return;
    openLifecycle({
      kind: "edit-project",
      projectId: project.id,
      title: project.title,
      description: project.shortDescription ?? "",
    });
  }

  async function saveProjectDetails(patch: ProjectPatch): Promise<void> {
    const run = lifecycle;
    if (run?.kind !== "edit-project") return;
    const session = lifecycleSessionRef.current;
    try {
      await editProjectDetails.mutateAsync({
        repo: repoPath,
        lens,
        projectId: run.projectId,
        patch,
      });
    } catch {
      return;
    }
    if (session === lifecycleSessionRef.current) closeLifecycle();
  }

  /** The no-dialog verbs in flight, from the click (confirm included) until the
   *  write settles. Read at FIRE time: a render's `isPending` is a snapshot, and
   *  a second click or palette run queued behind the first would otherwise fire
   *  the write twice (two "Copy of" views, a second delete). */
  const verbsInFlightRef = useRef(new Set<InFlightVerb>());
  async function runVerbOnce(
    verb: InFlightVerb,
    run: () => Promise<void>,
  ): Promise<void> {
    const inFlight = verbsInFlightRef.current;
    if (inFlight.has(verb)) return;
    inFlight.add(verb);
    try {
      await run();
    } finally {
      inFlight.delete(verb);
    }
  }
  // The render-time half of the same guard, as the held rows' parentheticals.
  // Close and reopen gate on GitHub's own per-verb verdicts rather than on
  // `viewerCanUpdate`, which Edit details and Delete keep (no finer flag exists).
  // Pending ranks first: mid-write the optimistic patch has already flipped
  // `closed`, so a permission arm would describe the verb the row is about to
  // offer rather than the write still going.
  const closeReopenHeld = (() => {
    switch (true) {
      case closeProject.isPending:
        return "saving…";
      case projectScopeReadOnly(scopes.data):
        return "needs the project scope";
      case project?.closed === true && !project.viewerCanReopen:
        return "no permission to reopen";
      case project?.closed === false && !project.viewerCanClose:
        return "no permission to close";
      default:
        return undefined;
    }
  })();
  const deleteProjectHeld =
    statusWriteHeld ?? (deleteProject.isPending ? "deleting…" : undefined);
  // Close asks first, so it carries the ellipsis; a held row drops it for the
  // reason, the grammar the other held rows keep.
  const closeReopenLabel = project?.closed
    ? "Reopen project"
    : closeReopenHeld === undefined
      ? "Close project…"
      : "Close project";
  /** Close asks first (reversible, but it changes the whole project for everyone);
   *  reopen doesn't. The board stays on screen either way: a closed project is
   *  still fully workable, and the picker files it under Closed. */
  function toggleProjectClosed(): Promise<void> {
    return runVerbOnce("close-reopen", async () => {
      if (project === null || closeReopenHeld !== undefined) return;
      const target = project;
      const repo = repoPath;
      if (!target.closed) {
        const ok = await useConfirm.getState().ask({
          title: `Close ${target.title}?`,
          body: "It keeps its items, views and fields, and you can still work on it here. It moves to the Closed group of the project list until you reopen it.",
          confirmLabel: "Close project",
        });
        if (!ok) return;
      }
      // Pinned BEFORE the optimistic patch: the catalog files a closed project
      // under Closed, and a board shown only as the fallback would otherwise jump
      // to whichever project leads the reordered list.
      if (stillShowing(repo, target.id)) setPickedProjectId(target.id);
      try {
        await closeProject.mutateAsync({
          repo,
          lens,
          projectId: target.id,
          patch: { closed: !target.closed },
        });
      } catch {
        // Reported by the hook, which also puts the project back as it was.
        return;
      }
      toast.success(
        target.closed ? `Reopened ${target.title}` : `Closed ${target.title}`,
      );
    });
  }

  function removeProject(): Promise<void> {
    return runVerbOnce("delete-project", async () => {
      if (project === null || deleteProjectHeld !== undefined) return;
      const target = project;
      const repo = repoPath;
      const ok = await useConfirm.getState().ask({
        title: "Delete project?",
        body: `${target.title} is deleted for everyone, with its items, views, fields and status updates. Draft items live only in the project and are deleted with it; its issues and pull requests stay in their repositories. This can't be undone.`,
        confirmLabel: "Delete project",
        confirmVariant: "destructive",
      });
      if (!ok) return;
      const generation = pickGenerationRef.current;
      try {
        await deleteProject.mutateAsync({ repo, lens, projectId: target.id });
      } catch {
        return;
      }
      toast.success(`Deleted ${target.title}`);
      if (
        stillShowing(repo, target.id) &&
        generation === pickGenerationRef.current
      )
        switchProject(null);
    });
  }

  /** Why a view action is held, as a tooltip: the project's write holds, then
   *  (for the actions on the view on screen) having no view picked. */
  function viewActionReason(needsView: boolean): string | undefined {
    if (projectWriteReason !== undefined) return projectWriteReason;
    if (needsView && savedView === null) return "Pick a view above first";
    return undefined;
  }
  // A layout this build reads as `unknown` can't be written back: a copy would
  // need it, and saving over it would replace a layout nobody here can see.
  const unknownLayoutHeld =
    savedView?.layout === "unknown" ? UNKNOWN_LAYOUT_REASON : undefined;
  const viewsRefreshing = views.isFetching
    ? VIEWS_REFRESHING_REASON
    : undefined;
  // Any update to the SOURCE view in flight (layout, fields or name) has patched
  // it optimistically, and a copy taken now would keep those values even if the
  // write then failed. Scoped to the source: a write to another view holds nothing.
  const sourceWriteOut =
    savedView !== null &&
    [saveViewLayout, setViewFields, renameView].some(
      (m) => m.isPending && m.variables?.viewId === savedView.id,
    );
  const duplicateViewReason =
    viewActionReason(true) ??
    unknownLayoutHeld ??
    viewsRefreshing ??
    (sourceWriteOut ? "Saving this view…" : undefined) ??
    (duplicateView.isPending ? "Duplicating a view…" : undefined);
  const viewFieldsReason = viewActionReason(true) ?? viewsRefreshing;
  const lastView =
    views.data !== undefined &&
    !views.data.truncated &&
    views.data.views.length === 1;
  const deleteViewReason =
    viewActionReason(true) ??
    (lastView ? LAST_VIEW_REASON : undefined) ??
    (deleteView.isPending ? "Deleting a view…" : undefined);
  const saveLayoutReason =
    viewActionReason(true) ??
    unknownLayoutHeld ??
    (saveViewLayout.isPending ? "Saving the layout…" : undefined);

  function openNewView() {
    if (projectId === null || viewActionReason(false) !== undefined) return;
    openLifecycle({ kind: "new-view", projectId });
  }

  function openRenameView() {
    if (projectId === null || savedView === null) return;
    if (viewActionReason(true) !== undefined) return;
    openLifecycle({ kind: "rename-view", projectId, view: savedView });
  }

  function openViewFields() {
    if (projectId === null || savedView === null) return;
    if (viewFieldsReason !== undefined) return;
    openLifecycle({ kind: "view-fields", projectId, view: savedView });
  }

  async function submitViewName(
    name: string,
    layout: ProjectViewLayout,
  ): Promise<void> {
    const run = lifecycle;
    const session = lifecycleSessionRef.current;
    const generation = pickGenerationRef.current;
    const repo = repoPath;
    if (run?.kind === "new-view") {
      let created: ProjectViewDef;
      try {
        created = await createView.mutateAsync({
          repo,
          projectId: run.projectId,
          name,
          layout,
        });
      } catch {
        return;
      }
      if (session === lifecycleSessionRef.current) closeLifecycle();
      if (
        stillShowing(repo, run.projectId) &&
        generation === pickGenerationRef.current
      )
        setPendingViewPick(created);
      return;
    }
    if (run?.kind !== "rename-view") return;
    try {
      await renameView.mutateAsync({
        repo,
        projectId: run.projectId,
        viewId: run.view.id,
        patch: { name },
      });
    } catch {
      return;
    }
    if (session === lifecycleSessionRef.current) closeLifecycle();
  }

  async function saveViewFields(visibleFieldIds: string[]): Promise<void> {
    const run = lifecycle;
    if (run?.kind !== "view-fields") return;
    const session = lifecycleSessionRef.current;
    try {
      await setViewFields.mutateAsync({
        repo: repoPath,
        projectId: run.projectId,
        viewId: run.view.id,
        patch: { visibleFieldIds },
      });
    } catch {
      return;
    }
    if (session === lifecycleSessionRef.current) closeLifecycle();
  }

  /** Copies the view on screen as it is SAVED — a transient layout pick isn't
   *  part of it — and picks the copy. No confirm: it adds, and changes nothing. */
  function duplicateCurrentView(): Promise<void> {
    return runVerbOnce("duplicate-view", async () => {
      if (projectId === null || savedView === null) return;
      if (duplicateViewReason !== undefined) return;
      const source = savedView;
      // `unknown` is already held above; the narrowing makes it a type fact.
      const layout = VIEW_LAYOUTS.find((l) => l === source.layout);
      if (layout === undefined) return;
      const board = projectId;
      const repo = repoPath;
      const generation = pickGenerationRef.current;
      let created: ProjectViewDef;
      try {
        created = await duplicateView.mutateAsync({
          repo,
          projectId: board,
          source: {
            name: source.name,
            layout,
            filter: source.filter,
            visibleFieldIds: source.visibleFieldIds,
          },
        });
      } catch {
        return;
      }
      if (stillShowing(repo, board) && generation === pickGenerationRef.current)
        setPendingViewPick(created);
    });
  }

  function removeCurrentView(): Promise<void> {
    return runVerbOnce("delete-view", async () => {
      if (projectId === null || savedView === null) return;
      if (deleteViewReason !== undefined) return;
      const target = savedView;
      const board = projectId;
      setViewOptionsOpen(false);
      const ok = await useConfirm.getState().ask({
        title: "Delete view?",
        body: `${target.name || UNTITLED_VIEW} is deleted for everyone on the project. GitHub can't bring a deleted view back, so this can't be undone.`,
        confirmLabel: "Delete view",
        confirmVariant: "destructive",
      });
      if (!ok) return;
      // A board drawn under it falls back to no view once the switcher stops
      // listing it, the way any vanished view does.
      try {
        await deleteView.mutateAsync({
          repo: repoPath,
          projectId: board,
          viewId: target.id,
        });
      } catch {
        // Reported by the hook.
        return;
      }
      toast.success(`Deleted ${target.name || UNTITLED_VIEW}`);
    });
  }

  /** Writes the transient layout onto the view on screen. The optimistic patch
   *  makes the saved layout equal the pick at once, which already stops the
   *  override; the pick itself is cleared once GitHub confirms, and only if it is
   *  still the exact pick that was saved (a later pick survives). A failure rolls
   *  the saved layout back, so the kept pick shows as unsaved again. */
  function saveLayout(): Promise<void> {
    return runVerbOnce("save-layout", async () => {
      if (projectId === null || savedView === null || view === null) return;
      if (!layoutUnsaved || saveLayoutReason !== undefined) return;
      const layout = VIEW_LAYOUTS.find((l) => l === view.layout);
      if (layout === undefined) return;
      const viewId = savedView.id;
      try {
        await saveViewLayout.mutateAsync({
          repo: repoPath,
          projectId,
          viewId,
          patch: { layout },
        });
      } catch {
        return;
      }
      setLayoutPick((current) =>
        current !== null &&
        current.viewId === viewId &&
        current.layout === layout
          ? null
          : current,
      );
    });
  }

  /** Record what a menu opened over `el` would act on, and report whether that is
   *  anything at all. Null — and so no menu — for board chrome and empty column
   *  space alone: every CARD now carries rows of its own. A redacted item and a
   *  draft on an ungrouped board used to have an empty menu and so no menu; archive
   *  and remove reach both off the membership's item id, which is a thing the
   *  viewer can do about a card whose content they may not even read. */
  function recordMenuTarget(el: Element | null): boolean {
    const at = el === null ? null : positionAt(el);
    const item = at === null ? undefined : columns[at.col]?.items[at.idx];
    // The cursor moves to whatever was pressed, a suppressed menu included, so the
    // board's selection and the menu describe the same card (the Actions and
    // History lists select their pressed row the same way). The nonce stays put:
    // this sets where the arrows resume, never where focus goes.
    if (at !== null && item !== undefined) {
      setCursor(at);
      if (rowView !== null) {
        const cellCol = Number(
          el?.closest<HTMLElement>("[data-col-index]")?.dataset.colIndex,
        );
        onTableCellFocus(
          itemRowKey(item.itemId),
          Number.isInteger(cellCol) ? cellCol : null,
        );
      }
    }
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
              bucketField === null
                ? UNSET_COLUMN_ID
                : (bucketIdFor(item, bucketField) ?? UNSET_COLUMN_ID),
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
    // The card the cursor sat on BEFORE this press, recorded ahead of
    // `recordMenuTarget` because that moves the cursor onto whatever was pressed.
    // A Shift+click with no anchor yet seeds from it: mousedown runs in a later
    // dispatch than pointerdown, by which time the cursor is already the clicked
    // card, and seeding from THAT would range a card to itself.
    //
    // Skipped for a mac Ctrl-click, which writes no selection state.
    if (!isMacSecondaryClick(e, isMac))
      prePressCardRef.current =
        liveCursor === null
          ? null
          : (columns[liveCursor.col]?.items[liveCursor.idx]?.itemId ?? null);
    // ALWAYS recorded: this is the menu's own target, and a mac Ctrl-click is a
    // menu gesture. The collapse-if-outside-the-selection decision belongs to the
    // context menu's open gate, exactly as it does for a right-click.
    recordMenuTarget(e.target instanceof Element ? e.target : null);
  }

  /**
   * Every LEFT-button press on a card, and the one place the pointer's selection
   * grammar lives: plain collapses to that card, `mod` toggles it, Shift extends
   * the column range from the anchor.
   *
   * MOUSEDOWN rather than click, for the two things only a mousedown can do:
   * `preventDefault` here is what stops the browser extending a text range under
   * Shift and moving focus, which is then handed to the card by hand so the arrows
   * resume from where the pointer landed. Stopping the card from OPENING is the
   * click-capture's job — Base UI's `useClick` defaults to `event: 'click'`
   * (@base-ui/react 1.8.0), so a card's opener and a draft's notes both fire on
   * the click, and this handler is too early to swallow either.
   */
  function handleCardMouseDown(e: MouseEvent) {
    // Ahead of the button test, which a mac Ctrl-click can pass: WebKit may report
    // it as the PRIMARY button. Nothing below may touch the selection for it.
    if (isMacSecondaryClick(e, isMac)) return;
    if (e.button !== 0) return;
    const mods = selectionMods(e, isMac);
    const el = e.target instanceof Element ? e.target : null;
    const at = el === null ? null : positionAt(el);
    const item = at === null ? undefined : columns[at.col]?.items[at.idx];
    // Board chrome and empty column space make no selection, but a Shift press on
    // them (a column or section header, the gap between rows) would still extend
    // the browser's own text range across the page. DOM-contained only: a press in
    // a portalled popup (a cell editor's input) reaches here through React's tree
    // and keeps its native behaviour.
    if (item === undefined) {
      if (
        mods.range &&
        e.target instanceof Node &&
        e.currentTarget.contains(e.target)
      )
        e.preventDefault();
      return;
    }
    if (!mods.toggle && !mods.range) {
      // A REDACTED card carries no handlers precisely so it can't be picked, so a
      // plain press on one leaves the selection exactly where it was.
      if (item.content.kind !== "redacted") selectOnly(item.itemId);
      return;
    }
    // Swallowed even on a redacted card, which takes no part in a selection: the
    // press still has to stop the browser extending a text range across the board
    // under the held Shift.
    e.preventDefault();
    e.stopPropagation();
    if (item.content.kind === "redacted") return;
    // THE SEEDING SITE for a pointer range — the keyboard's twin sits in
    // `onBoardKeyDown`. Both hand `selectRange` the card the gesture started on so
    // a first Shift+click covers start AND destination.
    if (mods.range) selectRange(item.itemId, prePressCardRef.current);
    else selectToggle(item.itemId);
    el?.closest<HTMLElement>(focusableSelector)?.focus();
  }

  /** The other half of the modified-press intercept. Stopping mousedown leaves the
   *  click that follows it untouched, and that click is what would open the card —
   *  so a selection gesture swallows both. */
  function handleCardClickCapture(e: MouseEvent) {
    const mods = selectionMods(e, isMac);
    // A mac Ctrl-click is swallowed here too, not ignored: it carries no modifier
    // this panel reads, so without naming it the click would reach the card's own
    // opener and activate it alongside the menu — which a right-click never does.
    if (!isMacSecondaryClick(e, isMac) && !mods.toggle && !mods.range) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el === null || positionAt(el) === null) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** The mouse and keyboard route. Re-records because Shift+F10 and the Menu key
   *  reach here with no pointerdown ahead of them. */
  function handleCardContextMenu(e: MouseEvent) {
    // DOM-contained only: a portalled popup's content (a cell editor's input, a
    // draft's notes peek) reaches here through React's tree and keeps its native
    // menu. Propagation still stops, since Base UI's trigger handler prevents the
    // default on every contextmenu that reaches it, which would swallow that menu.
    if (!(e.target instanceof Node && e.currentTarget.contains(e.target))) {
      e.stopPropagation();
      return;
    }
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
    if (bucketField === null || projectId === null || column === undefined)
      return;
    // Belt-and-braces with the rows' own `disabled`: the hold is derived at render,
    // and a pick racing the render that sets it must not get through either.
    if (moveHeldFor(item) !== undefined) return;
    const bucket = moveBucketFor(bucketField, column.id);
    setChase(item.itemId);
    // The board AND the lens this move belongs to travel WITH it: an offline move
    // parks before the write and resumes on whatever render is current by then,
    // and `onMutate` pins this lens's key into the context its rollback and its
    // settle read — so switching views mid-flight needs no hold of its own.
    move.mutate({
      repo: repoPath,
      projectId,
      itemId: item.itemId,
      field: bucketField,
      bucket,
      query: lensQuery,
      archived: showArchived,
      rich: tableView !== null,
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
      announce(TRUNCATED_ORDER_REASON[noun]);
      toast(TRUNCATED_ORDER_REASON[noun], { id: REORDER_REFUSAL_TOAST_ID });
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
      rich: tableView !== null,
    });
    // The cursor rides the card to where the optimistic splice puts it; the
    // column's own focus machinery does the rest off the nonce. The moved card's
    // id travels with it — that splice lands a frame or two later, so until it
    // does the new index still resolves to the neighbour being swapped past.
    const idx = REORDER_LANDING[direction](from.idx, column.items.length);
    setCursor({ col: from.col, idx });
    setFocusItemId(item.itemId);
    setTableCursor((prev) => ({
      rowKey: itemRowKey(item.itemId),
      colIndex: prev?.colIndex ?? 0,
    }));
    setFocusNonce((n) => n + 1);
    announce(
      `Moved to ${idx + 1} of ${column.items.length} in ${column.label}`,
    );
  }

  /**
   * Why a date shift can't write for `item` in `mode`, or undefined when it can.
   * The in-cell editor's own derivation (`cellEditHeld`) over the fields this mode
   * WRITES, under a board hold that skips this card's own shift in flight: the
   * hook coalesces those, which is what lets a held key's burst land.
   *
   * The re-read arms are `cellBoardHeld`'s and for its reason: a shift is seeded
   * from the cached dates, and until a write's re-read lands those can predate it
   * (a bulk field edit patches nothing), so a shift would silently undo it. The
   * reconciliation ledger doesn't say WHOSE write a lens owes, so a burst's own
   * settle holds too: a key still held past it pauses until that re-read lands.
   */
  function shiftHeldFor(
    item: BoardItem,
    mode: "move" | "resize",
  ): string | undefined {
    const boardHeld = (() => {
      switch (true) {
        case projectScopeReadOnly(scopes.data):
          return BOARD_READ_ONLY_SCOPE_REASON;
        case project !== null && !project.viewerCanUpdate:
          return NO_ACCESS_REASON;
        case lensLoading:
          return LENS_LOADING_REASON;
        case bulkWritePending:
          return bulkPendingReason;
        case movePending:
          return MOVING_REASON[noun];
        case pendingWrites.some(
          (w) =>
            w.itemId === item.itemId &&
            w.kind !== null &&
            w.kind !== "shift-dates" &&
            CARD_WRITE_KINDS.has(w.kind),
        ):
          return ITEM_WRITE_REASON[noun];
        case items.isFetchingNextPage:
          return LOADING_PAGE_REASON;
        case refreshingAfterWrite || rereadStall === "owed":
          return UPDATING_REASON[surface];
        case rereadFailed:
          return REREAD_FAILED_REASON[surface];
        default:
          return undefined;
      }
    })();
    const written =
      mode === "resize"
        ? [dateSources.target]
        : [dateSources.start, dateSources.target];
    for (const source of written) {
      const def =
        source === null
          ? undefined
          : fieldDefs.find((f) => f.id === source.fieldId);
      if (def === undefined || !isWritable(def)) continue;
      const held = cellEditHeld(boardHeld, item, def);
      if (held !== undefined) return held;
    }
    return boardHeld;
  }

  /**
   * One date-shift chord on a roadmap lane: the item's span a day (or an
   * iteration) either way, or its target alone. A refusal is announced AND
   * toasted, the reorder chords' pair, since no greyed control is on screen to
   * say why. The cursor rides the row by identity and re-claims its lane, since a
   * view sorted by the shifted field moves the row.
   */
  function shiftItemDates(
    item: BoardItem,
    mode: "move" | "resize",
    dir: -1 | 1,
  ) {
    if (projectId === null) return;
    const held = shiftHeldFor(item, mode);
    const plan =
      held === undefined
        ? planShift(item, dateSources, fieldDefs, calendars, mode, dir)
        : ({ kind: "held", reason: held } as const);
    if (plan.kind === "held") {
      announce(plan.reason);
      toast(plan.reason, { id: SHIFT_REFUSAL_TOAST_ID });
      return;
    }
    const title =
      item.content.kind === "redacted"
        ? "Redacted item"
        : item.content.title || "Draft item";
    announce(`${title} — ${spanText(plan.span, localDateISO(Date.now()))}`);
    setTableCursor({ rowKey: itemRowKey(item.itemId), colIndex: 1 });
    setFocusNonce((n) => n + 1);
    // The lens this write belongs to travels WITH it, the rule `moveCard` states.
    void shiftWrite
      .mutateAsync({
        repo: repoPath,
        projectId,
        itemId: item.itemId,
        values: plan.values,
        query: lensQuery,
        archived: showArchived,
        rich: tableView !== null,
      })
      .then(
        (outcome) => {
          if (outcome.kind !== "exhausted") return;
          // Out of chase rounds with no failure: the press outran the writes, and
          // the settle's re-read now shows the dates GitHub did save.
          announce(
            outcome.error === undefined
              ? `Stopped saving ${title}'s dates partway; refreshing to show what GitHub saved`
              : `Couldn't save all of ${title}'s dates`,
          );
        },
        // The hook rolled the dates back and toasted why; this says so aloud.
        () => announce(`Couldn't move ${title}, its dates are back`),
      );
  }

  /** Put one searched issue or pull request on the board. Owned here rather than in
   *  the dialog so the toolbar's write indicator can see it, and so the toast
   *  names the board from the same place every other message about it does.
   *  Reports whether it landed: the dialog flips its row on `true` and leaves it
   *  pickable on `false`.
   *
   *  Never optimistic, and never fabricated: the card the board draws is the one
   *  GitHub answered the write with, patched in at the settle, so the ids the menu
   *  and the move path target are server-minted. The toolbar's write indicator
   *  covers the window before that answer arrives. */
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
      body: `Creates a real issue in ${target} from the draft's title and notes, and swaps the ${noun} over to it. The draft itself is gone once it lands.`,
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
        title: `Archive this ${noun}?`,
        body: ARCHIVE_BODY[showArchived ? "shown" : "hidden"](noun, surface),
        confirmLabel: "Archive",
      },
      remove: {
        title: `Remove this ${noun} from the project?`,
        body: REMOVE_BODY[item.content.kind](noun),
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
    setRetired(
      at === null || !leaves
        ? null
        : {
            itemId: item.itemId,
            ...at,
            slot:
              rowView === null ? null : itemRowSlot(tableEntries, item.itemId),
          },
    );
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

  /**
   * What a bulk write did, said once. A FULL success is announced and nothing
   * more — the cards changing IS the feedback — where a partial one also toasts:
   * a count of what didn't land is a short terminal result, and a live region
   * alone would lose it to the next announcement.
   *
   * The toast carries WHY, not just how many. Every single-card path surfaces
   * GitHub's own message through its hook's `onError`, and a batch that answered
   * with a bare count would be the one place in this panel that knows the reason
   * and throws it away — a missing `project` scope, a dead connection and a
   * rejected field value would all read identically.
   *
   * DISPOSITION (settled): the per-item reasons are summarized, not enumerated.
   * A bulk failure is homogeneous in practice — one scope error across every
   * card, one transport error across a chunk — so the first distinct reason is
   * the actionable one and the rest are a count. The reversal, if a per-card
   * breakdown is ever wanted, is a results section inside the bulk dialog fed by
   * these same outcomes; it is deliberately not built here, where a toast has to
   * stay terminal.
   */
  function reportBulk(verb: BulkVerb, result: BulkItemOutcomes, sent: number) {
    const errors = result.outcomes.flatMap((outcome) =>
      outcome.error === null ? [] : [outcome.error],
    );
    const failed = errors.length;
    if (failed === 0) {
      announce(`${BULK_DONE_WORD[verb]} ${cardCount(sent, noun)}`);
      return;
    }
    // COUNT-ONLY on purpose: the live region is terse by design, and the toast
    // beside it carries the diagnosis. The reason lives in one place, not two.
    announce(
      `${BULK_DONE_WORD[verb]} ${sent - failed} of ${cardCount(sent, noun)} — ${failed} failed`,
    );
    // Distinct, in the order GitHub gave them (`Set` keeps insertion order), each
    // through the house presenter so a multi-line dump reads as its one
    // meaningful line and an empty string still says something.
    const reasons = [
      ...new Set(errors.map((error) => presentError(error).summary)),
    ];
    const more = reasons.length - 1;
    toast.error(
      `${failed} of ${cardCount(sent, noun)} failed to ${BULK_FAIL_WORD[verb]} — ${reasons[0]}${
        more > 0 ? ` (+${more} more ${more === 1 ? "reason" : "reasons"})` : ""
      }`,
    );
  }

  /** Hand focus out of the selection bar before the bar leaves the tree. The card
   *  the cursor is on is the board's own tab stop, and it is mounted by the
   *  column's range extractor whatever the scroll position. SYNCHRONOUS: a rAF
   *  handoff loses to Base UI's own focus recapture, and a bar that unmounts under
   *  the focused button drops a keyboard user to the document body. */
  function handOffBarFocus() {
    const focused = document.activeElement;
    const bar = selectionBarRef.current;
    if (!(focused instanceof HTMLElement) || bar === null) return;
    if (!bar.contains(focused)) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`${focusableSelector}[tabindex="0"]`)
      ?.focus();
  }

  /** Move every eligible selected card into `columns[columnIndex]`. No prompt: a
   *  move is as reversible as the one the card menu offers, and the cards landing
   *  in their new column is its own feedback. */
  async function bulkMoveCards(columnIndex: number) {
    // Every read happens BEFORE the first await, and the gates are re-checked here
    // rather than trusted from the render that disabled the control.
    const column = columns[columnIndex];
    const { cards, reason } = bulkState("move");
    if (bucketField === null || projectId === null || column === undefined)
      return;
    if (reason !== undefined || cards.length === 0) return;
    const itemIds = cards.map((card) => card.itemId);
    const bucket = moveBucketFor(bucketField, column.id);
    // The cursor rides one of the moved cards into the destination column, the way
    // the single-card `moveCard` does. Without it the keyboard is left on a card
    // the optimistic re-bucketing is about to unmount from the column it is
    // looking at, with no nonce advancing to move it anywhere: `handOffBarFocus`
    // below only gets focus OUT of the bar, and the bar's own control is gone
    // either way. The representative is the cursor's card when the write takes it,
    // else the first moved card — the same rule the removal landing follows.
    const cursorCard =
      liveCursor === null
        ? undefined
        : columns[liveCursor.col]?.items[liveCursor.idx];
    const movedIds = new Set(itemIds);
    setChase(
      cursorCard !== undefined && movedIds.has(cursorCard.itemId)
        ? cursorCard.itemId
        : itemIds[0],
    );
    handOffBarFocus();
    clearSelection();
    try {
      // The board and the lens this write belongs to travel WITH it, the rule
      // `moveCard` states: `onMutate` pins this lens's key into the context its
      // rollback and its settle read.
      const result = await bulkMove.mutateAsync({
        repo: repoPath,
        projectId,
        itemIds,
        field: bucketField,
        bucket,
        query: lensQuery,
        archived: showArchived,
        rich: tableView !== null,
      });
      reportBulk("move", result, itemIds.length);
    } catch {
      // The mutation reported it and rolled every card back to its old column.
    }
  }

  /** Archive or remove every eligible selected card, after the prompt each one
   *  owes. The prompts say where the cards GO, the same claim the single-card ones
   *  make and keyed on the same two facts: whether archived cards are shown, and
   *  whether the set holds a draft. */
  async function bulkRetireCards(action: "archive" | "remove") {
    const { cards, reason } = bulkState(action);
    if (projectId === null || reason !== undefined || cards.length === 0)
      return;
    const n = cards.length;
    const prompt =
      action === "archive"
        ? {
            title: `Archive ${cardCount(n, noun)}?`,
            body: BULK_ARCHIVE_BODY[showArchived ? "shown" : "hidden"](
              n,
              noun,
              surface,
            ),
            confirmLabel: "Archive",
          }
        : {
            title: `Remove ${cardCount(n, noun)} from the project?`,
            body: bulkRemoveBody(cards, noun),
            confirmLabel: "Remove",
            confirmVariant: "destructive" as const,
          };
    // BEFORE the prompt, never after it. The confirm dialog takes focus as it
    // opens and restores it to whatever held focus beforehand — which is the bar
    // button that fired this, and the bar unmounts the moment the selection
    // clears. Handing focus to the cursor card first makes the CARD the confirm's
    // restore target, and that card outlives the bar. A handoff after the await
    // would find focus inside the confirm, skip its own bar-contains guard, and
    // drop a keyboard user on <body> as the dialog closed onto a dead button.
    handOffBarFocus();
    const ok = await useConfirm.getState().ask(prompt);
    if (!ok) return;
    // Re-read the GATE after the prompt, not the card set: the user confirmed
    // those N cards, and re-deriving the set would silently write a different one.
    // The board can go held under an open prompt (another write starts, a page
    // fetch begins), and a write fired into that is the race the render-time
    // `disabled` can't catch. Announced rather than toasted — this route already
    // has the user's attention.
    const heldNow = bulkHeldRef.current;
    if (heldNow !== undefined) {
      announce(heldNow);
      return;
    }
    // Where the keyboard lands once the cards go, armed BEFORE the write for the
    // reason `retireCard` states: the patch takes them off the board within a
    // microtask, so the latch has to be watching by then. Only where they really
    // LEAVE — an archive under a shown-archived toggle keeps every card in its
    // slot, so there is nothing to follow and a latch that could never land would
    // re-scan the columns on every render.
    //
    // ONE representative card carries the whole set: a bulk patch takes every card
    // out of a lens in a single write, so the first one's absence is the group's.
    // The CURSOR's card is preferred as that representative whenever the write
    // takes it, which is what measures the landing from where the user actually
    // is; the landing itself is a SLOT, so whatever survivor slid into it is who
    // gets focus — the eligible set never has to be re-consulted.
    const leaves = action === "remove" || !showArchived;
    const goneIds = new Set(cards.map((card) => card.itemId));
    const cursorCard =
      liveCursor === null
        ? undefined
        : columns[liveCursor.col]?.items[liveCursor.idx];
    const anchor =
      cursorCard !== undefined && goneIds.has(cursorCard.itemId)
        ? cursorCard
        : cards[0];
    const anchorAt = findCard(columns, anchor.itemId);
    setRetired(
      anchorAt === null || !leaves
        ? null
        : {
            itemId: anchor.itemId,
            ...anchorAt,
            slot:
              rowView === null
                ? null
                : itemRowSlot(tableEntries, anchor.itemId),
          },
    );
    // `wasArchived` rides each item for the reason the single-card write carries
    // it: it is a COUNT axis no cache key supplies, and a mixed selection holds
    // both values at once.
    const items = cards.map((card) => ({
      itemId: card.itemId,
      wasArchived: card.isArchived,
    }));
    clearSelection();
    try {
      const write = action === "archive" ? bulkArchive : bulkRemove;
      const result = await write.mutateAsync({
        repo: repoPath,
        projectId,
        items,
      });
      reportBulk(action, result, items.length);
    } catch {
      // The mutation reported it and its rollback put every card back.
    }
  }

  /** Put every archived card in the selection back on the board. No prompt, for
   *  the reason the single-card restore has none: the archive is the step that
   *  asked, and this is the reversal it promised. */
  async function bulkRestoreCards() {
    const { cards, reason } = bulkState("restore");
    if (projectId === null || reason !== undefined || cards.length === 0)
      return;
    const itemIds = cards.map((card) => card.itemId);
    handOffBarFocus();
    clearSelection();
    try {
      const result = await bulkRestore.mutateAsync({
        repo: repoPath,
        projectId,
        itemIds,
      });
      reportBulk("restore", result, itemIds.length);
    } catch {
      // The mutation reported it, and its rollback put the cards back under the
      // Archived badges they came in with.
    }
  }

  /** Open the bulk fields editor over the cards eligible for it RIGHT NOW, recording
   *  them here at the click. The dialog holds none of this: it stays mounted across
   *  open and close and `<Activity>` replays its effects on show, so a set it derived
   *  for itself would describe whatever selection it last saw. The snapshot feeds the
   *  dialog's hints ALONE — what a write addresses is re-derived when Apply fires. */
  function openBulkFields() {
    const { cards, reason } = bulkState("fields");
    if (projectId === null || reason !== undefined || cards.length === 0)
      return;
    // Mints the run this editor's Apply will belong to. Read the token's own note:
    // a resolution from a PREVIOUS run may still be on its way.
    bulkFieldsSessionRef.current += 1;
    setBulkFieldCards(cards);
    setBulkFieldsOpen(true);
  }

  /**
   * Write one drafted set of field values across every card still eligible for it.
   *
   * Answers whether the dialog may CLOSE, which is a narrower claim than "the
   * mutation resolved". The batch command resolves with its refusals INSIDE it, so
   * a write every card rejected still settles successfully — the verdict is
   * therefore derived from the per-item outcomes, and any refusal at all keeps the
   * editor open over the draft that produced it. Re-applying the same absolute
   * values is idempotent for the cards that did land, so a retry from that draft
   * costs nothing and loses nothing.
   *
   * A STALE run answers `false` whatever it wrote: see the session token.
   */
  async function applyBulkFields(
    updates: ProjectFieldValueUpdate[],
    clears: string[],
  ): Promise<boolean> {
    // Read before the round trip, like every other target here.
    const session = bulkFieldsSessionRef.current;
    // Re-derived at FIRE time rather than taken from the open-time snapshot: a card
    // that left the board while the dialog was up must not be written to, which is
    // the same rule every other bulk verb keeps. The gates are re-checked here too.
    const { cards, reason } = bulkState("fields");
    if (projectId === null || reason !== undefined || cards.length === 0)
      return false;
    if (updates.length === 0 && clears.length === 0) return false;
    const itemIds = cards.map((card) => card.itemId);
    try {
      const result = await bulkFields.mutateAsync({
        repo: repoPath,
        projectId,
        itemIds,
        updates,
        clears,
      });
      // Reported whatever run this was: the message describes a write the user
      // really fired, and is true wherever they have since got to.
      reportBulk("fields", result, itemIds.length);
      // Only the run still on screen may close anything. A stale token means the
      // user cancelled over this write and opened the editor again (or switched
      // board), and the close below is a PANEL setter every run shares — so a
      // stale `true` would shut the editor now open and discard the draft in it.
      if (session !== bulkFieldsSessionRef.current) return false;
      return result.outcomes.every((outcome) => outcome.error === null);
    } catch {
      // The mutation reported it. Nothing was patched optimistically, so the board
      // is already showing the truth and the draft stays where the user left it.
      return false;
    }
  }

  /** Drop the selection from the keyboard or the bar's own Clear. Focus leaves the
   *  bar first: the control that fired this is about to unmount with it. */
  function dismissSelection() {
    if (selectionSize === 0) return;
    handOffBarFocus();
    clearSelection();
    announce("Selection cleared");
  }

  // Ranked, because the popup can be opened before the fields read settles and
  // an UNSETTLED read is not the same claim as a settled empty one. Claiming the
  // board defines no groupable field while the read is still in flight is a false
  // statement, not a placeholder.
  const fieldsPending = canRead && projectId !== null && fields.isPending;
  const groupHeldReason = (() => {
    switch (true) {
      case surface !== "board":
        return ROWS_GROUPING_REASON[surface];
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
  // The roadmap's date-source rows, ranked like Group by's: an unsettled or failed
  // read is not the settled claim that the project defines no such field.
  const sourceFields = fieldDefs.filter(
    (def): def is Extract<ProjectFieldDef, { kind: "date" | "iteration" }> =>
      def.kind === "date" || def.kind === "iteration",
  );
  const dateSourceHeldReason = (() => {
    switch (true) {
      case fieldsPending:
        return LOADING_FIELDS_REASON;
      case fields.error !== null && sourceFields.length === 0:
        return FIELDS_ERROR_REASON;
      case sourceFields.length === 0:
        return NO_DATE_FIELDS_REASON;
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
  const layoutLabelId = useId();
  const startLabelId = useId();
  const targetLabelId = useId();
  const zoomLabelId = useId();

  /** Pick one end's date source from View options. Built over the EFFECTIVE
   *  sources, so a pick the definitions dropped isn't revived beside the new one. */
  function pickDateSource(end: keyof DateSources, rowId: string) {
    const def = sourceFields.find((f) => f.id === rowId);
    const source: DateSource | null =
      def === undefined ? null : { kind: def.kind, fieldId: def.id };
    setDatePicks({ ...dateSources, [end]: source });
  }

  /** One step along Month ↔ Quarter ↔ Year; the ends say so rather than wrap. */
  function stepZoom(dir: "in" | "out") {
    const next = ZOOMS[ZOOMS.indexOf(zoom) + (dir === "in" ? -1 : 1)];
    if (next === undefined) {
      announce(ZOOM_END_REASON[dir]);
      return;
    }
    setZoom(next);
    announce(`Zoom: ${ZOOM_LABEL[next]}`);
  }
  // Palette-only, like every View options row: live wherever a roadmap view is
  // on, each answering its own end.
  const roadmapOn = active && roadmapView !== null;
  useHotkeyAction("roadmap-zoom-in", () => stepZoom("in"), roadmapOn);
  useHotkeyAction("roadmap-zoom-out", () => stepZoom("out"), roadmapOn);
  useHotkeyAction(
    "roadmap-jump-to-today",
    () => setTodayNonce((n) => n + 1),
    roadmapOn,
  );
  const portalContainer = usePanelPortalContainer();
  const projectTitles: Record<string, string> = {};
  // The trigger's label is the bare title: its "(closed)" marker is a sibling
  // that survives the title's truncation. The popup rows spell it into the text.
  for (const p of listedProjects) projectTitles[p.id] = p.title;

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
      // Also for a lens still owed its re-read since the last write: a page
      // appended now would extend pages that don't show that write, and its success
      // would stamp them fresh. The refresh comes first (a FAILED one is below).
      case items.isFetching || rereadStall === "owed":
        return `Refreshing the ${surface}…`;
      // The mirror of the menu's own page-fetch hold, and the same mechanism read
      // from the other side: EVERY write here settles by cancelling this query's
      // family to force the reconciliation, and query-core's cancel REVERTS
      // whatever is in flight — so a continuation started during any write's window
      // would be thrown away between its request and the pages it was meant to
      // extend. One arm per kind rather than one shared sentence: the wait is the
      // same, but what the user is waiting ON is not.
      case bulkWritePending:
        return bulkPendingReason;
      case movePending:
        return `Finishing your last ${noun} move…`;
      case cardWritePending:
        return ITEM_WRITE_REASON[noun];
      case addPending:
        return "Finishing your last add…";
      // The catch-all for the family, and the reason the sets above don't have
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
      case (items.isError && !items.isFetchNextPageError) ||
        rereadStall === "failed":
        return `The ${surface}'s last refresh failed. Retry the refresh before loading more.`;
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
    // Also while a write's failed re-read still holds the table's cells, whose
    // reason points here: a later optimistic patch can clear the read's error while
    // the lens still shows the values from before that write.
    if ((items.error !== null && !items.isFetchNextPageError) || rereadFailed)
      liveNotices.push({
        key: "items",
        what: "this board's items",
        message:
          items.error === null
            ? REREAD_FAILED_NOTE
            : presentError(items.error).summary,
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
        ? CARD_GONE_REASON[surface]
        : reorderHeldFor(menuTarget.item);
  // The menu's BULK arm, or null for the single-card one. Present exactly when the
  // card the menu opened on is one of SEVERAL selected — the open gate collapses
  // the selection onto a card outside it, so this can never describe a set the
  // menu isn't about.
  const menuBulk: BulkMenuState | null =
    menuTarget === null ||
    bulkRows === null ||
    !liveSelection.has(menuTarget.item.itemId)
      ? null
      : {
          move: bulkRows.move,
          fields: bulkRows.fields,
          archive: bulkRows.archive,
          restore: bulkRows.restore,
          remove: bulkRows.remove,
          actions: {
            move: (columnIndex) => void bulkMoveCards(columnIndex),
            fields: openBulkFields,
            archive: () => void bulkRetireCards("archive"),
            restore: () => void bulkRestoreCards(),
            remove: () => void bulkRetireCards("remove"),
          },
        };

  /**
   * The board's ONE context menu, around whichever layout is drawn — one menu
   * rather than a portal per card or row: a virtualized row that scrolls out
   * would otherwise leave a popup anchored to a detached node. The capture
   * handlers on `trigger` run before Base UI's own, so the target is recorded —
   * or the menu suppressed — before it opens. Keyed by layout, so a board↔table
   * swap remounts it and {@link MenuLatchRelease} releases the latch the old
   * subtree held.
   */
  function boardMenu(
    layout: Surface,
    trigger: ReactElement,
    content: ReactNode,
  ) {
    return (
      <ContextMenu
        key={layout}
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
          if (open) {
            // The one gate both menu routes share, which is why the
            // collapse lives here rather than on a pointer handler: a touch
            // long press dispatches no `contextmenu` at all. A menu opened
            // OUTSIDE the selection is a statement about that card, so the
            // selection collapses onto it first (HistoryPanel's own rule);
            // one opened inside it keeps the set the menu is about to act on.
            const itemId = menuTargetRef.current?.item.itemId;
            if (itemId !== undefined && !liveSelection.has(itemId))
              selectOnly(itemId);
            setMenuBusy(true);
          }
        }}
        onOpenChangeComplete={setMenuBusy}
      >
        <MenuLatchRelease setMenuBusy={setMenuBusy} setChase={setChase} />
        <ContextMenuTrigger render={trigger}>{content}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-56">
          <BoardCardMenuItems
            target={menuTarget}
            noun={noun}
            canPeek={canPeek}
            bulk={menuBulk}
            // An ungrouped board has one column standing for the whole
            // board, which is no move target at all. A REDACTED card has none
            // either: its rows reach it by its place on the board, and a
            // column pick is a claim about an item whose contents this viewer
            // may not read.
            columns={
              bucketField === null ||
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
              menuTarget === null ? undefined : cardEditHeldFor(menuTarget.item)
            }
            reorderHeldReason={reorderHeldReason}
            reorderPlans={reorderPlans}
            actions={{
              open: () => {
                if (menuTarget !== null) openItem(menuTarget.item);
              },
              showDetails: () => {
                if (menuTarget !== null) setPeekItemId(menuTarget.item.itemId);
              },
              move: (columnIndex) => {
                if (menuTarget !== null) moveCard(menuTarget.item, columnIndex);
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

  // A filter that matched nothing, which the body answers with its own notice.
  const filterEmpty =
    view !== null &&
    lensQuery !== null &&
    !lensLoading &&
    hasPages &&
    loaded.length === 0;
  // The TABLE-EXIT handoff: the body stops drawing the table (or the roadmap, the
  // other row grid) while a cell held focus, and the grid's own recovery can't
  // land it, having unmounted too. Read off the DOM the body really drew, never a
  // copy of its arm ladder. Each arm lands per {@link focusBodyLanding}; the
  // toolbar (Add item) is drawn only under `showBoardChrome`, GitHub with the
  // scope and a project:
  // - forge probe failed: Retry (marked).
  // - forge detecting: skeleton, no chrome, no control: the panel root.
  // - another provider: notice, no chrome, no control: the panel root.
  // - forge not ready: the ladder's first live button (wrapper marked); its
  //   "couldn't connect" arms have none, and no chrome: the panel root.
  // - scope gap: Reconnect GitHub (wrapper marked); no chrome.
  // - fatal read: Retry (marked).
  // - loading: skeleton, chrome drawn with a project: Add item.
  // - empty catalog (either wording): no project, so no chrome and no control —
  //   unreachable here, since losing the project is a re-point, excluded below.
  // - filter-empty: Clear view (marked).
  // Excluded: a layout switch (the board drawn, or its cursor seed still waiting to
  // claim), which has its own handoff, and a project or repository re-point, which
  // hands focus nowhere by design. Only where focus fell to <body> (or to the panel
  // root, where a press on empty space parks it), so focus the user put elsewhere
  // is never taken.
  const drewTableRef = useRef(false);
  const bodyIdentityRef = useRef("");
  useEffect(() => {
    const root = rootRef.current;
    const layout = root?.querySelector<HTMLElement>("[data-board-layout]")
      ?.dataset.boardLayout;
    const identity = JSON.stringify([repoPath, projectId]);
    const wasTable = drewTableRef.current;
    const repointed = bodyIdentityRef.current !== identity;
    drewTableRef.current = layout === "table" || layout === "roadmap";
    bodyIdentityRef.current = identity;
    if (!wasTable || layout !== undefined || repointed) return;
    if (boardCursorSeed !== null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== root) return;
    focusBodyLanding(root);
  });
  // An <Activity> hide runs effect cleanups, so a tab shown again claims nothing
  // for a table it drew before the hide.
  useEffect(
    () => () => {
      drewTableRef.current = false;
    },
    [],
  );

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
        return (
          <div data-body-landing="">
            <ForgeNotReady repoPath={repoPath} feature="project boards" />
          </div>
        );
      case scopeGap:
        return (
          // ScopeGapBlock carries POPUP padding (px-1 py-1) — it was written for
          // the Projects picker's popover. This is a full-pane state, so the call
          // site makes up the difference: px-2 py-3 here lands it on the px-3 py-4
          // the sibling arms use, without touching a component two other surfaces
          // share.
          <div className="px-2 py-3" data-body-landing="">
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
              No project came back for this repository or its owner, but the
              list was cut short, so there may be more.
            </p>
            <p>Open the owner's Projects page on GitHub to see all of them.</p>
            <p data-body-landing="">{newProjectButton}</p>
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
              Neither this repository nor its owner has one yet. Start one here.
            </p>
            <p data-body-landing="">{newProjectButton}</p>
          </BoardNotice>
        );
      // A filter that matched nothing is a different statement from an empty
      // board, and only the settled read may make it — the cards standing while
      // a lens loads are the previous view's. An unfiltered view can't reach
      // here: its empty board is the board's own, and the columns say so.
      case filterEmpty:
        return (
          <BoardNotice>
            <p>No items match this view's filter.</p>
            <p className="font-mono break-all">{lensQuery}</p>
            <p>
              <ClearViewButton onClear={clearView} landing />
            </p>
          </BoardNotice>
        );
      // A saved TABLE view draws as a table, as GitHub draws it, under the same
      // menu, selection and verbs as the board — after every arm above, so an
      // empty catalog or a filter that matched nothing still says so.
      case tableView !== null:
        return boardMenu(
          "table",
          <div
            data-board-layout="table"
            className="flex min-h-0 flex-1 flex-col"
            onPointerDownCapture={handleCardPointerDown}
            onMouseDownCapture={handleCardMouseDown}
            onClickCapture={handleCardClickCapture}
            onContextMenuCapture={handleCardContextMenu}
          />,
          <ProjectsTableView
            label={view?.name || UNTITLED_VIEW}
            columns={tableCols}
            rows={tableEntries}
            sortKeys={rowSortKeys}
            cursor={tablePos}
            focusNonce={focusNonce}
            selectedIds={selectedIds}
            selectionSize={selectionSize}
            busyItemId={busyItemId}
            peekItemId={peekItemId}
            onCellFocus={onTableCellFocus}
            onToggleGroup={toggleGroup}
            onActivate={activateRow}
            onPeekChange={setPeekItemId}
            editHeld={cellBoardHeld}
            editingCell={editingCell}
            onEditCell={onEditCell}
            onCellCommit={onCellCommit}
            onCellCancel={onCellCancel}
            onFocusLost={focusLanding}
            onKeyDown={onTableKeyDown}
          />,
        );
      // A saved ROADMAP view draws as a timeline, under the table's own row
      // grammar — the same menu, selection, verbs and keyboard walk, with a lane
      // in place of the field columns.
      case roadmapView !== null:
        return boardMenu(
          "roadmap",
          <div
            data-board-layout="roadmap"
            className="flex min-h-0 flex-1 flex-col"
            onPointerDownCapture={handleCardPointerDown}
            onMouseDownCapture={handleCardMouseDown}
            onClickCapture={handleCardClickCapture}
            onContextMenuCapture={handleCardContextMenu}
          />,
          <>
            {/* In the flow above the grid, never over it: with nothing to place
                items by, every lane reads "No dates" and this says what to do. */}
            {dateSources.start === null && dateSources.target === null && (
              <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{ROADMAP_NO_SOURCES_NOTE}</span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setViewOptionsOpen(true)}
                >
                  View options
                </Button>
              </div>
            )}
            <ProjectsRoadmapView
              label={view?.name || UNTITLED_VIEW}
              rows={tableEntries}
              cursor={tablePos}
              focusNonce={focusNonce}
              todayNonce={todayNonce}
              selectedIds={selectedIds}
              selectionSize={selectionSize}
              busyItemId={busyItemId}
              peekItemId={peekItemId}
              items={roadmapItems}
              sources={dateSources}
              calendars={calendars}
              zoom={zoom}
              onCellFocus={onTableCellFocus}
              onToggleGroup={toggleGroup}
              onActivate={activateRow}
              onPeekChange={setPeekItemId}
              onFocusLost={focusLanding}
              onKeyDown={onTableKeyDown}
            />
          </>,
        );
      default:
        return boardMenu(
          "board",
          // One horizontal scroll region for the whole board; each column
          // owns its own vertical one.
          <div
            data-board-layout="board"
            className="flex min-h-0 flex-1 gap-2 overflow-x-auto"
            onKeyDown={onBoardKeyDown}
            onPointerDownCapture={handleCardPointerDown}
            onMouseDownCapture={handleCardMouseDown}
            onClickCapture={handleCardClickCapture}
            onContextMenuCapture={handleCardContextMenu}
          />,
          columns.map((column, i) => (
            <BoardColumn
              key={column.id}
              column={column}
              columnIndex={i}
              activeIndex={liveCursor?.col === i ? liveCursor.idx : null}
              activeItemId={liveCursor?.col === i ? focusItemId : null}
              selectedIds={selectedIds}
              selectionSize={selectionSize}
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
          )),
        );
    }
  })();

  // What the board is waiting on, one label per in-flight write, read off each
  // write's own variables so the copy names the thing rather than the operation.
  // Only the kinds whose result lands LATER get one: an archive and a removal patch
  // the card out on the spot, so the card's absence is already their feedback. Per
  // INVOCATION rather than per kind — two drafts really can be in flight at once —
  // which is what the slot below counts when there is more than one.
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
    } else if (write.kind === "bulk-fields") {
      // The ONE bulk kind that earns a line. The other four patch their cards
      // optimistically, so the cards changing on the spot is already their
      // feedback; this one writes several fields at once (the grouping field
      // included), which makes no local patch honest — so without a line it is the
      // only board write with no visible progress at all, and Cancel closing over
      // it would leave nothing on screen saying it was still going.
      pendingLines.push({
        key: write.mutationId,
        label:
          write.count === null
            ? "Setting fields…"
            : `Setting fields on ${cardCount(write.count, noun)}…`,
      });
    } else if (write.kind === "reorder") {
      // A line despite the splice already being on screen, unlike a move: a burst
      // of presses converges through several round trips, so this write can still
      // be reaching GitHub long after the card settled where the user left it.
      pendingLines.push({
        key: write.mutationId,
        label: `Repositioning a ${noun}…`,
      });
    } else if (write.kind === "shift-dates") {
      // The reposition's reason: a held key's burst can still be reaching GitHub
      // after the bar settled where the user left it.
      pendingLines.push({
        key: write.mutationId,
        label: `Saving a ${noun}'s dates…`,
      });
    }
  }

  // The toolbar slot's words: a lone write names itself, several are counted, and
  // once every write has settled the slot stays up through the re-read that
  // repaints the board, since until it lands the cards still show the old values.
  const writeIndicator = (() => {
    switch (true) {
      case pendingLines.length === 1:
        return pendingLines[0].label;
      case pendingLines.length > 1:
        return `${pendingLines.length} changes on their way…`;
      // An owed lens (offline included) is still waiting on its read, so the slot
      // agrees with the cells' hold rather than going quiet.
      case refreshingAfterWrite || rereadStall === "owed":
        return `Updating the ${surface}…`;
      default:
        return null;
    }
  })();

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
  // Gated on the project's write permission alone, where the menu row it mirrors
  // also waits out a page fetch: a post touches no board read. Dead while the
  // editor is open — the palette reaches over its modal, and swapping an open edit
  // for a post would carry the edit's draft into it.
  useHotkeyAction(
    "post-project-status-update",
    openStatusPost,
    active &&
      showBoardChrome &&
      statusWriteHeld === undefined &&
      statusEditor === null,
  );
  // The project verbs, palette-only like the menu rows they mirror, and under the
  // same holds. New project is live without a board too (the empty state offers
  // it); every one is dead while a project or view dialog is open, since the
  // palette reaches over its modal and swapping the run would carry its draft.
  const lifecycleIdle = active && !lifecycleOpen;
  useHotkeyAction(
    "new-project",
    openNewProject,
    lifecycleIdle && isGitHub && !scopeGap && newProjectHeld === undefined,
  );
  const projectVerbsLive =
    lifecycleIdle && showBoardChrome && statusWriteHeld === undefined;
  useHotkeyAction("edit-project-details", openEditProject, projectVerbsLive);
  useHotkeyAction(
    "close-reopen-project",
    () => void toggleProjectClosed(),
    lifecycleIdle && showBoardChrome && closeReopenHeld === undefined,
  );
  useHotkeyAction(
    "delete-project",
    () => void removeProject(),
    lifecycleIdle && showBoardChrome && deleteProjectHeld === undefined,
  );
  useHotkeyAction("new-project-view", openNewView, projectVerbsLive);
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
  // The bulk verbs, live only where they mean something: a board on screen with a
  // real selection on it. Each handler re-derives its own eligibility and holds, so
  // the palette answers a held board the same way the bar does. No bulk MOVE row —
  // picking a column needs a menu the palette can't put up, which is the same
  // reason the single-card move is menu-only.
  const hasSelection = active && selectionSize >= 2;
  // `openBulkFields` re-derives its own eligibility and holds off `bulkState`, so
  // the palette answers a held board exactly as the bar's button does.
  useHotkeyAction("edit-selected-card-fields", openBulkFields, hasSelection);
  useHotkeyAction(
    "archive-selected-cards",
    () => void bulkRetireCards("archive"),
    hasSelection,
  );
  useHotkeyAction(
    "restore-selected-cards",
    () => void bulkRestoreCards(),
    hasSelection,
  );
  useHotkeyAction(
    "remove-selected-cards",
    () => void bulkRetireCards("remove"),
    hasSelection,
  );
  useHotkeyAction("clear-card-selection", dismissSelection, hasSelection);
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
    <div
      ref={rootRef}
      // The last-resort focus landing ({@link focusBodyLanding}): named, so focus
      // parked here announces where it is.
      role="region"
      aria-label="Project board"
      tabIndex={-1}
      className="flex h-full flex-col p-2 outline-none"
    >
      {project !== null && (
        <h2 className="sr-only">{project.title} project board</h2>
      )}
      {showBoardChrome && (
        <div className="@container/toolbar mb-2 flex shrink-0 flex-wrap items-center gap-2">
          <Select
            items={projectTitles}
            value={projectId}
            onValueChange={(v) => {
              if (typeof v === "string") switchProject(v);
            }}
          >
            <SelectTrigger size="sm" aria-label="Project" className="max-w-64">
              {/* An ellipsis where the title is cut, so a cut on a word boundary
                  never reads as the whole title. `block!` because the trigger
                  styles its value as a flex line-clamp, which clips without one. */}
              <SelectValue
                className="block! min-w-0 truncate"
                onMouseEnter={clipTitleFromText}
              />
              {project?.closed === true && (
                <span className="shrink-0 text-muted-foreground">(closed)</span>
              )}
            </SelectTrigger>
            <SelectContent>
              {openProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <SelectClipText>{p.title}</SelectClipText>
                </SelectItem>
              ))}
              {/* Closed boards as their own group, after the open ones. Each row
                  says "closed" in words as well, so the state never rides the
                  grouping alone, and the trigger names it once one is picked. */}
              {closedProjects.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Closed</SelectLabel>
                  {closedProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <SelectClipText>{`${p.title} (closed)`}</SelectClipText>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Project actions"
                  title="Project actions"
                />
              }
            >
              <DotsThreeIcon weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              <DropdownMenuItem
                disabled={newProjectHeld !== undefined}
                onClick={openNewProject}
              >
                {newProjectHeld === undefined
                  ? "New project…"
                  : `New project (${newProjectHeld.short})`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={statusWriteHeld !== undefined}
                onClick={openEditProject}
              >
                {statusWriteHeld === undefined
                  ? "Edit details…"
                  : `Edit details (${statusWriteHeld})`}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={closeReopenHeld !== undefined}
                onClick={() => void toggleProjectClosed()}
              >
                {closeReopenHeld === undefined
                  ? closeReopenLabel
                  : `${closeReopenLabel} (${closeReopenHeld})`}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={deleteProjectHeld !== undefined}
                onClick={() => void removeProject()}
              >
                {deleteProjectHeld === undefined
                  ? "Delete project…"
                  : `Delete project (${deleteProjectHeld})`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              {/* Here even with no strip on screen: a project with no updates
                  draws none, so this row is how its first one gets posted. Its
                  permission holds are already the trigger's, which says why. */}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openStatusPost}>
                Post status update…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* What the board is waiting on, as ONE slot in the toolbar rather than a
              row of its own. In-flow rows govern PERSISTENT claims (the notices and
              the lens strip below); a TRANSIENT, high-frequency indicator lives in
              chrome that is always there instead, because a row mounting and
              unmounting with every write is itself a disturbance about the thing it
              narrates. The slot IS the row's slack: it grows into the space between
              the left group and View options (`flex-1` on a zero basis, so it never
              adds width that could re-wrap the row) and right-aligns its content, so
              View options and the count stay flush right and a write starting,
              growing or settling moves nothing. Out of room, the label truncates.
              Below the container threshold only the spinner shows; the label stays
              in the DOM (sr-only) as the status's words and rides the hover title. */}
          <div
            role="status"
            title={writeIndicator ?? undefined}
            className="flex h-5 min-w-3 flex-1 basis-0 items-center justify-end gap-1.5 text-[11px] text-muted-foreground"
          >
            {writeIndicator !== null && (
              <>
                <Spinner aria-hidden className="size-3 shrink-0" />
                <span className="sr-only @3xl/toolbar:not-sr-only @3xl/toolbar:min-w-0 @3xl/toolbar:truncate">
                  {writeIndicator}
                </span>
              </>
            )}
          </div>
          {/* Every control that shapes HOW the board is laid out lives behind
              this one trigger, so later slices add rows here rather than more
              toolbar chrome. The project switcher stays outside it: a project
              title already says what it is. */}
          <Popover.Root
            open={viewOptionsOpen}
            onOpenChange={setViewOptionsOpen}
          >
            <Popover.Trigger render={<Button variant="outline" size="sm" />}>
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
                                    isn't a board — the row says up front what
                                    a pick is about to draw. */}
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
                      {/* The views' own verbs, under the list they act on and
                          outside its held branch: a project with no views yet is
                          exactly where New view is wanted. Two even rows on a
                          six-column grid: the verbs that ADD a view, then the
                          three that change the view the radio has picked. */}
                      <div className="grid grid-cols-6 gap-1 px-0.5 pt-1">
                        <DisabledReasonButton
                          variant="ghost"
                          size="xs"
                          wrapperClassName="col-span-3"
                          className="w-full"
                          disabled={viewActionReason(false) !== undefined}
                          reason={viewActionReason(false)}
                          onClick={openNewView}
                        >
                          New view…
                        </DisabledReasonButton>
                        <DisabledReasonButton
                          variant="ghost"
                          size="xs"
                          wrapperClassName="col-span-3"
                          className="w-full"
                          disabled={duplicateViewReason !== undefined}
                          reason={duplicateViewReason}
                          onClick={() => void duplicateCurrentView()}
                        >
                          Duplicate
                        </DisabledReasonButton>
                        <DisabledReasonButton
                          variant="ghost"
                          size="xs"
                          wrapperClassName="col-span-2"
                          className="w-full"
                          disabled={viewActionReason(true) !== undefined}
                          reason={viewActionReason(true)}
                          onClick={openRenameView}
                        >
                          Rename…
                        </DisabledReasonButton>
                        <DisabledReasonButton
                          variant="ghost"
                          size="xs"
                          wrapperClassName="col-span-2"
                          className="w-full"
                          disabled={viewFieldsReason !== undefined}
                          reason={viewFieldsReason}
                          onClick={openViewFields}
                        >
                          Fields…
                        </DisabledReasonButton>
                        <DisabledReasonButton
                          variant="ghost"
                          size="xs"
                          wrapperClassName="col-span-2"
                          className="w-full text-destructive hover:text-destructive"
                          disabled={deleteViewReason !== undefined}
                          reason={deleteViewReason}
                          onClick={() => void removeCurrentView()}
                        >
                          Delete…
                        </DisabledReasonButton>
                      </div>
                    </div>
                    {/* The layout the view on screen draws in, changeable for the
                        visit and saved onto the view only when asked. Present only
                        with a view on: no view is always the board. */}
                    {savedView !== null && (
                      <div className="space-y-1">
                        <p
                          id={layoutLabelId}
                          className="px-1 text-xs text-muted-foreground"
                        >
                          Layout
                        </p>
                        <RadioGroup
                          className="gap-0"
                          aria-labelledby={layoutLabelId}
                          value={surface}
                          onValueChange={(next) => {
                            const picked = VIEW_LAYOUTS.find((l) => l === next);
                            if (picked === undefined) return;
                            // Back to the saved layout clears the pick: a stored
                            // equal pick would re-activate on a later remote
                            // layout change.
                            setLayoutPick(
                              picked === surfaceOf(savedView)
                                ? null
                                : { viewId: savedView.id, layout: picked },
                            );
                          }}
                        >
                          {VIEW_LAYOUTS.map((l) => (
                            <label key={l} className={GROUP_ROW_CLASS}>
                              <Radio value={l} />
                              <span className="min-w-0 truncate">
                                {VIEW_LAYOUT_LABEL[l]}
                              </span>
                            </label>
                          ))}
                        </RadioGroup>
                        {layoutUnsaved && (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1">
                            <span className="text-[11px] text-muted-foreground">
                              For this visit only.
                            </span>
                            <DisabledReasonButton
                              variant="outline"
                              size="xs"
                              disabled={saveLayoutReason !== undefined}
                              reason={saveLayoutReason}
                              onClick={() => void saveLayout()}
                            >
                              Save layout to view
                            </DisabledReasonButton>
                          </div>
                        )}
                      </div>
                    )}
                    {/* A roadmap's own rows, present only while one is on: GitHub
                        serves no date mapping for a roadmap view, so which fields
                        place an item is picked here, seeded when the view is. */}
                    {roadmapView !== null && (
                      <>
                        <DateSourceRows
                          labelId={startLabelId}
                          label="Start field"
                          heldReason={dateSourceHeldReason}
                          fields={sourceFields}
                          value={dateSources.start}
                          onPick={(rowId) => pickDateSource("start", rowId)}
                        />
                        <DateSourceRows
                          labelId={targetLabelId}
                          label="Target field"
                          heldReason={dateSourceHeldReason}
                          fields={sourceFields}
                          value={dateSources.target}
                          onPick={(rowId) => pickDateSource("target", rowId)}
                        />
                        <div className="space-y-1">
                          <p
                            id={zoomLabelId}
                            className="px-1 text-xs text-muted-foreground"
                          >
                            Zoom
                          </p>
                          <RadioGroup
                            className="gap-0"
                            aria-labelledby={zoomLabelId}
                            value={zoom}
                            onValueChange={(next) => {
                              const picked = ZOOMS.find((z) => z === next);
                              if (picked !== undefined) setZoom(picked);
                            }}
                          >
                            {ZOOMS.map((z) => (
                              <label key={z} className={GROUP_ROW_CLASS}>
                                <Radio value={z} />
                                <span className="min-w-0 truncate">
                                  {ZOOM_LABEL[z]}
                                </span>
                              </label>
                            ))}
                          </RadioGroup>
                        </div>
                      </>
                    )}
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
                            clearSelection();
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
                  if (
                    items.isFetching ||
                    boardWritePending ||
                    lensLoading ||
                    rereadStall !== null
                  )
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
      {/* The PROJECT's own status, in the layout flow like the notices below and
          above them: it describes the whole project rather than this read of the
          board. Draws nothing until the project has an update; the editor behind
          it is mounted regardless, since the toolbar's Add item opens it too. */}
      {showBoardChrome && (
        <ProjectStatusSection
          repoPath={repoPath}
          projectId={projectId}
          enabled={canRead}
          viewer={
            gh.data?.login ? { login: gh.data.login, avatarUrl: "" } : null
          }
          ghHost={ghHost}
          writeHeldNote={statusWriteHeld}
          editor={statusEditor}
          setEditor={setStatusEditor}
          onFocusLost={() => focusBodyLanding(rootRef.current)}
        />
      )}
      {/* In the layout FLOW, pushing the board down — a persistent claim about
          what this surface is showing must never float over its chrome (the
          transient write indicator is the one exception, and lives in the toolbar
          above for the reason given there). Failed reads come first (they are
          actionable), then the caps; both caps can be on at once and each names a
          different list, so they are joined rather than ranked. */}
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
          {tableUngrouped !== null && <span>{tableUngrouped}</span>}
          {rowSortDropped !== null && <span>{rowSortDropped}</span>}
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
      {/* How to build a selection at all, until the user says they know. Gated on
          `settings.data` being loaded so "Don't show again" — which merges into it —
          can't silently no-op during the cold load, and hidden the moment a real
          selection exists: the bar below is the better teacher by then.
          ChangesPanel's own hint, worded for cards and keyed on its own setting. */}
      {showBoardChrome &&
        settings.data &&
        settings.data.showBoardSelectionHint !== false &&
        shown >= 2 &&
        selectionSize <= 1 && (
          <div className="mb-2 flex shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <InfoIcon className="size-3.5 shrink-0" />
            <span className="flex-1 leading-snug">
              {formatBinding("mod")}-click to select {noun}s individually,
              Shift-click for a range.
            </span>
            <button
              type="button"
              onClick={() => {
                if (!settings.data) return;
                void saveSettings
                  .mutateAsync({
                    ...settings.data,
                    showBoardSelectionHint: false,
                  })
                  .catch(() => undefined);
              }}
              className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2 hover:no-underline"
            >
              Don't show again
            </button>
          </div>
        )}
      {/* What the selection can do, in the layout FLOW like every strip above it —
          a bar that floated over the board would cover the cards it is about. Two
          cards in, since a singleton IS the keyboard cursor and has the card menu
          already. */}
      {showBoardChrome && bulkRows !== null && (
        <div
          ref={selectionBarRef}
          // Esc works from inside the bar too. The board's own handler is on the
          // COLUMNS container, which this strip is a sibling of — so a user who
          // tabbed into the bar could otherwise only leave the selection by
          // clicking Clear. Same pair Clear takes: the synchronous handoff first,
          // since the control holding focus is about to unmount with the bar.
          //
          // DOM containment first, the guard `onBoardKeyDown` carries and for the
          // same reason: the Move dropdown's popup is PORTALLED, so it is a React
          // child of this strip without being a DOM descendant, and React routes
          // synthetic events through the COMPONENT tree. Without this, the Esc that
          // closes that menu also drops the very selection the user opened it to
          // move.
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            if (
              !(e.target instanceof Node) ||
              !e.currentTarget.contains(e.target)
            )
              return;
            e.preventDefault();
            dismissSelection();
          }}
          className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1.5 text-[11px]"
        >
          <span className="mr-1 tabular-nums text-muted-foreground">
            {cardCount(selectionSize, noun)} selected
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <DisabledReasonButton
                  variant="ghost"
                  size="sm"
                  disabled={bulkRows.move.reason !== undefined}
                  reason={bulkRows.move.reason}
                />
              }
            >
              {bulkRows.move.label}
              <CaretDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            {/* The board's own columns, as rows — never a nested Select inside a
                popup, which is the shape the View options popover documents. */}
            <DropdownMenuContent className="min-w-56">
              {columns.map((column, i) => (
                <DropdownMenuItem
                  key={column.id}
                  onClick={() => void bulkMoveCards(i)}
                >
                  {column.color === null ? (
                    <span
                      className="min-w-0 truncate"
                      onMouseEnter={clipTitleFromText}
                    >
                      {column.label}
                    </span>
                  ) : (
                    <OptionValue name={column.label} color={column.color} />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            disabled={bulkRows.fields.reason !== undefined}
            reason={bulkRows.fields.reason}
            onClick={openBulkFields}
          >
            {bulkRows.fields.label}
          </DisabledReasonButton>
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            disabled={bulkRows.archive.reason !== undefined}
            reason={bulkRows.archive.reason}
            onClick={() => void bulkRetireCards("archive")}
          >
            {bulkRows.archive.label}
          </DisabledReasonButton>
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            disabled={bulkRows.restore.reason !== undefined}
            reason={bulkRows.restore.reason}
            onClick={() => void bulkRestoreCards()}
          >
            {bulkRows.restore.label}
          </DisabledReasonButton>
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={bulkRows.remove.reason !== undefined}
            reason={bulkRows.remove.reason}
            onClick={() => void bulkRetireCards("remove")}
          >
            {bulkRows.remove.label}
          </DisabledReasonButton>
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <Button variant="ghost" size="sm" onClick={dismissSelection}>
            Clear
          </Button>
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
            noun={noun}
            open={addDialog === "existing"}
            onOpenChange={(o) => switchAddDialog(o ? "existing" : null)}
            onBoardContentIds={loadedContentIds}
            onAdd={addExistingToBoard}
          />
          <NewDraftDialog
            key={`draft-${projectId}`}
            projectTitle={project.title}
            noun={noun}
            open={addDialog === "draft"}
            pending={draftWritePending}
            onOpenChange={(o) => switchAddDialog(o ? "draft" : null)}
            onCreate={createDraft}
          />
          {/* The bulk fields editor, keyed like its siblings so a board change
              drops the draft rather than handing it to another board's fields.
              Every definition comes from the panel's own cached read, so opening
              this costs no fetch of its own. */}
          <BoardBulkFieldsDialog
            key={`bulk-fields-${projectId}`}
            open={bulkFieldsOpen}
            cards={bulkFieldCards}
            eligibleCount={bulkFieldsEligible}
            fieldDefs={fieldDefs}
            defsTruncated={fields.data?.truncated === true}
            defsPending={fieldsPending}
            defsError={fields.error}
            onRetryDefs={() => void fields.refetch()}
            pending={bulkWritePending}
            heldReason={bulkFieldsHeld}
            noun={noun}
            onOpenChange={setBulkFieldsOpen}
            onApply={applyBulkFields}
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
              noun={noun}
              onOpenChange={(o) => switchAddDialog(o ? "edit-draft" : null)}
              onSave={saveDraftEdit}
            />
          )}
        </>
      )}
      {/* The project and view dialogs. Mounted with or without a board: New
          project is how an empty catalog gets its first one. Each reads what it
          was opened on from `lifecycle`, which outlives the close. */}
      <NewProjectDialog
        open={lifecycleOpen && lifecycle?.kind === "new-project"}
        pending={createProject.isPending}
        target={{
          repository: projects.data?.repositoryId
            ? (projects.data.repositoryNameWithOwner ?? null)
            : null,
          owner: projects.data?.ownerLogin ?? null,
        }}
        ownerHeldReason={
          projects.data?.ownerId ? undefined : OWNER_UNKNOWN_REASON
        }
        onOpenChange={(o) => {
          if (!o) closeLifecycle();
        }}
        onCreate={submitNewProject}
      />
      <EditProjectDialog
        open={lifecycleOpen && lifecycle?.kind === "edit-project"}
        pending={editProjectDetails.isPending}
        seedTitle={lifecycle?.kind === "edit-project" ? lifecycle.title : ""}
        seedDescription={
          lifecycle?.kind === "edit-project" ? lifecycle.description : ""
        }
        onOpenChange={(o) => {
          if (!o) closeLifecycle();
        }}
        onSave={saveProjectDetails}
      />
      <ViewNameDialog
        mode={lifecycle?.kind === "rename-view" ? "rename" : "create"}
        open={
          lifecycleOpen &&
          (lifecycle?.kind === "new-view" || lifecycle?.kind === "rename-view")
        }
        pending={
          lifecycle?.kind === "rename-view"
            ? renameView.isPending
            : createView.isPending
        }
        seedName={lifecycle?.kind === "rename-view" ? lifecycle.view.name : ""}
        onOpenChange={(o) => {
          if (!o) closeLifecycle();
        }}
        onSubmit={submitViewName}
      />
      <ViewFieldsDialog
        open={lifecycleOpen && lifecycle?.kind === "view-fields"}
        pending={setViewFields.isPending}
        viewName={
          lifecycle?.kind === "view-fields"
            ? lifecycle.view.name || UNTITLED_VIEW
            : UNTITLED_VIEW
        }
        currentIds={
          lifecycle?.kind === "view-fields"
            ? lifecycle.view.visibleFieldIds
            : NO_FIELD_IDS
        }
        defs={fieldDefs}
        defsHeldReason={
          fieldsPending
            ? LOADING_FIELDS_REASON
            : fields.data === undefined
              ? FIELDS_ERROR_REASON
              : undefined
        }
        onOpenChange={(o) => {
          if (!o) closeLifecycle();
        }}
        onSave={saveViewFields}
      />
    </div>
  );
}
