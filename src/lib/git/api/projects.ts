import { invoke } from "@/lib/tauri/invoke";
import type {
  AvailableProjects,
  BoardCandidates,
  BoardItem,
  BoardItemContent,
  BoardItems,
  BoardOrder,
  ConvertedDraft,
  ItemFieldValues,
  ItemProjects,
  ProjectFieldDefs,
  ProjectFieldValueUpdate,
  ProjectItemRemove,
  ProjectViews,
  RemoteLens,
} from "../types";

/** The GitHub Projects (v2) boards this repo's items can be added to — the repo's
 *  own plus its owner's. Needs the `project` (or `read:project`) token scope; a
 *  token without it fails with the scope hint rather than an empty list. */
export const ghProjectsAvailable = (repoPath: string, lens: RemoteLens) =>
  invoke<AvailableProjects>("gh_projects_available", { repoPath, lens });

/** The boards one issue/PR currently belongs to, with each membership's item id,
 *  and whether the item's capped memberships connection held more. */
export const ghItemProjects = (
  repoPath: string,
  kind: "issue" | "pr",
  number: number,
  lens: RemoteLens,
) =>
  invoke<ItemProjects>("gh_item_projects", {
    repoPath,
    kind,
    number,
    lens,
  });

/** One issue/PR's project field values, one entry per board it belongs to. Same
 *  scope need as the memberships read, and the same per-board shape, so the two
 *  line up membership-for-membership. */
export const ghItemFieldValues = (
  repoPath: string,
  kind: "issue" | "pr",
  number: number,
  lens: RemoteLens,
) =>
  invoke<ItemFieldValues>("gh_item_field_values", {
    repoPath,
    kind,
    number,
    lens,
  });

/** Links/unlinks an item's boards in one call. Adds address the project by id
 *  (`contentId` is the issue/PR node id); removes need the membership's item id,
 *  which only exists once the item is on that board. */
export const ghEditItemProjects = (
  repoPath: string,
  contentId: string,
  addProjectIds: string[],
  removes: ProjectItemRemove[],
) =>
  invoke<void>("gh_edit_item_projects", {
    repoPath,
    contentId,
    addProjectIds,
    removes,
  });

/** One board's field definitions — every field it defines, writable or not. Board
 *  state, not item state, so it takes no lens: a board is the same object whichever
 *  remote the item was read through. */
export const ghProjectFields = (repoPath: string, projectId: string) =>
  invoke<ProjectFieldDefs>("gh_project_fields", { repoPath, projectId });

/** One board's items, in the board's own position order. Auto-pages up to 500 per
 *  call; more than that comes back `truncated` with the `endCursor` the next call
 *  passes as `after`. Board state like the field definitions, so no lens. `query`
 *  is the board's own filter grammar, passed VERBATIM for the server to parse —
 *  a saved view's filter is what fills it, and null is the unfiltered board.
 *
 *  `includeArchived` false is the board's default read, which settles to the
 *  NOT_ARCHIVED items alone; true asks for both states, and GitHub interleaves the
 *  archived ones in POSITION order with their field values intact. `totalCount`
 *  follows the read's own filter either way, so the two answers count different
 *  sets (measured 2026-09-21). */
export const ghProjectItems = (
  repoPath: string,
  projectId: string,
  after: string | null,
  query: string | null,
  includeArchived: boolean,
) =>
  invoke<BoardItems>("gh_project_items", {
    repoPath,
    projectId,
    after,
    query,
    includeArchived,
  });

/** One board's saved views — the lenses its owner set up on GitHub, read-only
 *  here. Board state like the field definitions, so no lens; capped server-side,
 *  which is what `truncated` reports. */
export const ghProjectViews = (repoPath: string, projectId: string) =>
  invoke<ProjectViews>("gh_project_views", { repoPath, projectId });

/** Writes one board's field values for one item in a single call. `updates` sets or
 *  replaces; `clears` carries the field ids to UNSET, which no update shape can
 *  express. Both address the item by its membership `itemId` on `projectId`. */
export const ghSetItemFieldValues = (
  repoPath: string,
  projectId: string,
  itemId: string,
  updates: ProjectFieldValueUpdate[],
  clears: string[],
) =>
  invoke<void>("gh_set_item_field_values", {
    repoPath,
    projectId,
    itemId,
    updates,
    clears,
  });

/** Moves one card within the project's own item order, landing it directly after
 *  `afterId`. Null is the TOP of the board — the key rides EXPLICITLY, since the
 *  backend reads a dropped key and a null as the same `Option::None` only when the
 *  serializer is the one deciding. Answers with the board's new order rather than
 *  nothing, which is what lets the settle re-assert it without a read GitHub's
 *  replicas can lag. */
export const ghSetItemPosition = (
  repoPath: string,
  projectId: string,
  itemId: string,
  afterId: string | null,
) =>
  invoke<BoardOrder>("gh_set_item_position", {
    repoPath,
    projectId,
    itemId,
    afterId,
  });

/** Issues and pull requests in THIS repository a board could take, matching
 *  `search`. Repo-scoped by design: an owner-wide search would offer items from
 *  repositories this window isn't showing. The lens picks which repo "this" is. */
export const ghSearchBoardCandidates = (
  repoPath: string,
  search: string,
  lens: RemoteLens,
) =>
  invoke<BoardCandidates>("gh_search_board_candidates", {
    repoPath,
    search,
    lens,
  });

/** Adds a DRAFT item — a note that lives only on this board — and returns the CARD
 *  the board now holds. `body` rides verbatim as Markdown; the card's popover
 *  renders it. The card comes back rather than a bare id because GitHub's read
 *  replicas lag their own writes by seconds: the answer to the write is the only
 *  reading of the new item that is guaranteed to exist. */
export const ghAddDraftItem = (
  repoPath: string,
  projectId: string,
  title: string,
  body: string,
) =>
  invoke<BoardItem>("gh_add_draft_item", { repoPath, projectId, title, body });

/** Puts one existing issue or pull request on a board and returns the card it
 *  became. `contentId` is the issue/PR node id — a board item id addresses nothing
 *  here. The card comes back for the reason {@link ghAddDraftItem} states. */
export const ghAddBoardItem = (
  repoPath: string,
  projectId: string,
  contentId: string,
) => invoke<BoardItem>("gh_add_board_item", { repoPath, projectId, contentId });

/** Rewrites one draft's title, notes and assignees, answering with the card's new
 *  content — the DRAFT arm of {@link BoardItemContent}, tag included, which is why
 *  this is typed as the whole union and narrowed at the patch site. `draftId` is the
 *  DRAFT's own CONTENT id (the card's `content.id`), never the membership's item id.
 *
 *  `assigneeLogins` is TRI-STATE, and the distinction is what keeps a title-only edit
 *  from deleting people: a list REPLACES the set, `[]` clears it, and `undefined`
 *  omits the field from the mutation so the draft's assignees are not touched at all.
 *  The board reads a draft's assignees through a CAPPED selection, so a seeded list
 *  that round-tripped as a replacement would drop everyone past the cap. */
export const ghUpdateDraftItem = (
  repoPath: string,
  draftId: string,
  title: string,
  body: string,
  assigneeLogins: string[] | undefined,
) =>
  invoke<BoardItemContent>("gh_update_draft_item", {
    repoPath,
    draftId,
    title,
    body,
    // Explicit null rather than a dropped key: both reach the backend's `Option` as
    // `None`, and this one doesn't depend on the serializer omitting `undefined`.
    assigneeLogins: assigneeLogins ?? null,
  });

/** Turns a draft into a real issue in the repo the lens names, keeping the card's
 *  place on the board. Addressed by the membership's `itemId` — a draft's own
 *  content id is a different thing and the backend rejects it. Answers with the
 *  swapped card as well as the issue, for the reason {@link ghAddDraftItem} states. */
export const ghConvertDraftItem = (
  repoPath: string,
  itemId: string,
  lens: RemoteLens,
) =>
  invoke<ConvertedDraft>("gh_convert_draft_item", { repoPath, itemId, lens });

/** Archives one card: it leaves the board's default read but stays on the project,
 *  reachable again through {@link ghUnarchiveBoardItem}. Takes the membership's
 *  `itemId`. */
export const ghArchiveBoardItem = (
  repoPath: string,
  projectId: string,
  itemId: string,
) => invoke<void>("gh_archive_board_item", { repoPath, projectId, itemId });

/** Puts an archived card back on the board — {@link ghArchiveBoardItem}'s reversal,
 *  addressed the same way. GitHub's read replicas lag the write by seconds, so for a
 *  moment afterwards the restored item can still answer the archived-filtered read
 *  and be missing from the default one (measured ≤6s, 2026-09-21); the mutation's own
 *  success is the transactional truth. */
export const ghUnarchiveBoardItem = (
  repoPath: string,
  projectId: string,
  itemId: string,
) => invoke<void>("gh_unarchive_board_item", { repoPath, projectId, itemId });

/** Removes one card from the project. For an issue or pull request that unlinks
 *  the membership alone; for a DRAFT it destroys the note, which exists nowhere
 *  else. Takes the membership's `itemId`. */
export const ghRemoveBoardItem = (
  repoPath: string,
  projectId: string,
  itemId: string,
) => invoke<void>("gh_remove_board_item", { repoPath, projectId, itemId });

/** Adds one issue to boards by project id, addressed by issue NUMBER rather than
 *  node id — the create flow has the number before it has anything else. */
export const ghAddIssueToProjects = (
  repoPath: string,
  number: number,
  addProjectIds: string[],
  lens: RemoteLens,
) =>
  invoke<void>("gh_add_issue_to_projects", {
    repoPath,
    number,
    addProjectIds,
    lens,
  });
