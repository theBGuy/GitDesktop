/** A GitHub Projects (v2) board an issue/PR can belong to. */
export interface ProjectV2Ref {
  id: string;
  title: string;
  number: number;
  closed: boolean;
  /** Whether the viewer may add/remove items — false rows stay visible but held. */
  viewerCanUpdate: boolean;
}

/** One membership: the item's own node id on that board, plus the board. The
 *  `itemId` is what an unlink addresses, so it can't be derived from the project. */
export interface ProjectItemRef {
  itemId: string;
  project: ProjectV2Ref;
}

/** One item's board memberships. `truncated` reports that the item's
 *  `projectItems` connection had more pages than the read asked for, so the
 *  picker says the list is partial rather than implying it is the whole set —
 *  the same claim {@link AvailableProjects} makes about the catalog. */
export interface ItemProjects {
  items: ProjectItemRef[];
  truncated: boolean;
}

/** The projects an item could be added to — the repo's plus its owner's. */
export interface AvailableProjects {
  projects: ProjectV2Ref[];
  /** The server capped the list, or one catalog arm didn't answer (denied);
   *  the UI says so rather than implying completeness. */
  truncated: boolean;
}

/** An unlink target. Both ids are required: the mutation removes `itemId` from
 *  `projectId`'s board. */
export interface ProjectItemRemove {
  projectId: string;
  itemId: string;
}

/** One project field's value on an item, tagged by the field's kind. `isIssueField`
 *  marks a value GitHub owns on the issue/PR itself (assignees, labels, milestone,
 *  …) rather than a board-defined field — it rides the wire for the editor, which
 *  can't write those here. A kind this build doesn't know arrives as `unknown`,
 *  carrying only the name it was given. */
export type ProjectFieldValue =
  | {
      kind: "singleSelect";
      fieldId: string;
      fieldName: string;
      optionId: string;
      name: string;
      /** GitHub color NAME (GRAY/BLUE/GREEN/YELLOW/ORANGE/RED/PINK/PURPLE). */
      color: string;
      isIssueField: boolean;
    }
  | {
      kind: "multiSelect";
      fieldId: string;
      fieldName: string;
      options: { id: string; name: string; color: string }[];
      isIssueField: boolean;
    }
  | {
      kind: "text";
      fieldId: string;
      fieldName: string;
      text: string;
      isIssueField: boolean;
    }
  | {
      kind: "number";
      fieldId: string;
      fieldName: string;
      number: number;
      isIssueField: boolean;
    }
  | {
      kind: "date";
      fieldId: string;
      fieldName: string;
      /** A bare `YYYY-MM-DD` as GitHub's Date scalar sends it — no zone. */
      date: string;
      isIssueField: boolean;
    }
  | {
      kind: "iteration";
      fieldId: string;
      fieldName: string;
      /** Which iteration of the field's configured set this is — the id a write
       *  addresses it by, and the only stable identity it has: title and dates are
       *  editable on the board. */
      iterationId: string;
      title: string;
      startDate: string;
      /** Length in DAYS, so the last day is `startDate + duration - 1`. */
      duration: number;
      isIssueField: boolean;
    }
  | { kind: "unknown"; fieldName: string };

/** One board's field values for an item. `itemId` addresses the membership the
 *  values hang off, which is what a write would target. */
export interface ItemProjectFieldValues {
  itemId: string;
  project: ProjectV2Ref;
  values: ProjectFieldValue[];
}

/** One item's per-board field values. `truncated` is the same claim
 *  {@link ItemProjects} makes, off the same capped `projectItems` connection:
 *  both reads page it identically, so a truncated membership list means a
 *  truncated value list too. */
export interface ItemFieldValues {
  items: ItemProjectFieldValues[];
  truncated: boolean;
}

/** One option a board's single/multi-select field offers. */
export interface ProjectFieldOptionDef {
  id: string;
  name: string;
  /** GitHub color NAME (GRAY/BLUE/GREEN/YELLOW/ORANGE/RED/PINK/PURPLE). */
  color: string;
  description: string;
}

/** One iteration a board's iteration field offers. `duration` is a DAY count, so
 *  the last day is `startDate + duration - 1` — the same shape the iteration VALUE
 *  arm carries, plus the `id` a write addresses it by. */
export interface ProjectIterationDef {
  id: string;
  title: string;
  /** A bare `YYYY-MM-DD` as GitHub's Date scalar sends it — no zone. */
  startDate: string;
  duration: number;
}

/** One project field's DEFINITION, tagged by kind — what the editor offers, where
 *  {@link ProjectFieldValue} is what an item currently holds. `system` is both the
 *  built-ins bucket (title, assignees, labels, milestone, repository, reviewers,
 *  tracking — GitHub owns those on the issue/PR itself) and the tolerant fallback
 *  for a `dataType` this build doesn't know, which is how the editor excludes them:
 *  by kind, never by name. */
export type ProjectFieldDef =
  | {
      kind: "singleSelect";
      id: string;
      name: string;
      options: ProjectFieldOptionDef[];
      isIssueField: boolean;
    }
  | {
      kind: "multiSelect";
      id: string;
      name: string;
      options: ProjectFieldOptionDef[];
      isIssueField: boolean;
    }
  | {
      kind: "iteration";
      id: string;
      name: string;
      iterations: ProjectIterationDef[];
      /** Past iterations, offered apart: still assignable, but not what a board
       *  means by "the current one". */
      completedIterations: ProjectIterationDef[];
    }
  | { kind: "text"; id: string; name: string; isIssueField: boolean }
  | { kind: "number"; id: string; name: string; isIssueField: boolean }
  | { kind: "date"; id: string; name: string; isIssueField: boolean }
  | { kind: "system"; id: string; name: string; dataType: string };

/** One board's field definitions. `truncated` reports that the server capped the
 *  list, which the editor says rather than implying it offers every field — the
 *  same claim {@link AvailableProjects} makes about the catalog. */
export interface ProjectFieldDefs {
  fields: ProjectFieldDef[];
  truncated: boolean;
}

/** One sort key of a saved view: the field it orders by, and the direction the
 *  backend has already mapped off GitHub's own enum. */
export interface ProjectViewSort {
  fieldId: string;
  direction: "asc" | "desc";
}

/** One of a board's SAVED VIEWS, as this build can honour it. `layout` is mapped
 *  to the shapes the board knows plus `unknown` for one GitHub adds later, and
 *  every id list is a plain field-id sequence in the view's own order. `filter`
 *  is the board's own filter grammar for the server to parse — GitHub reports an
 *  unfiltered view as either null or the empty string, so a caller testing "has a
 *  filter" has to test both. */
export interface ProjectViewDef {
  id: string;
  name: string;
  layout: "board" | "table" | "roadmap" | "unknown";
  filter: string | null;
  verticalGroupFieldIds: string[];
  sortBy: ProjectViewSort[];
  visibleFieldIds: string[];
}

/** One board's saved views. `truncated` reports that the server capped the list,
 *  the same claim {@link ProjectFieldDefs} makes about the fields. */
export interface ProjectViews {
  views: ProjectViewDef[];
  truncated: boolean;
}

/** One field to SET on an item, tagged by the field's kind. These field names are
 *  the wire the backend deserializes by — a renamed one reads as absent there.
 *  Unsetting is not expressed here: a clear rides the write's separate id list. */
export type ProjectFieldValueUpdate =
  | { kind: "text"; fieldId: string; text: string }
  | { kind: "number"; fieldId: string; number: number }
  | { kind: "date"; fieldId: string; date: string }
  | { kind: "singleSelect"; fieldId: string; optionId: string }
  | { kind: "multiSelect"; fieldId: string; optionIds: string[] }
  | { kind: "iteration"; fieldId: string; iterationId: string };

/** One item's result in a BATCH board write: the membership it addressed, and the
 *  failure GitHub gave for it, or null when it landed. The message is already
 *  presentable — the backend maps its own error there. */
export interface BulkItemOutcome {
  itemId: string;
  error: string | null;
}

/** A batch board write's per-item results, in the order the request listed the
 *  items. A batch PARTIALLY APPLIES — every item is attempted whatever the ones
 *  before it did — so a caller rolls back the failures alone and leaves the rest
 *  of its optimistic patch standing. An empty item list is refused by the backend
 *  rather than answered with an empty list, so callers never send one. */
export interface BulkItemOutcomes {
  outcomes: BulkItemOutcome[];
}

/** One assignee on a board card — the login plus whatever avatar the forge gave
 *  us. Deliberately narrower than `ForgeUserRef` (forge.ts): a board page carries
 *  hundreds of these, and the card renders nothing else about a person. */
export interface AssigneeRef {
  login: string;
  avatarUrl: string;
}

/** A DRAFT card's own content — the note that lives on this board and nowhere
 *  else. Named apart from the union arm below because the draft EDIT command
 *  answers with exactly these fields: the `kind` tag is the union's, not the
 *  payload's. */
export interface BoardDraftContent {
  id: string;
  title: string;
  body: string;
  assignees: AssigneeRef[];
  /** When the draft was written, and when it last changed. ISO-8601 from the
   *  forge, so a reader validates before formatting. */
  createdAt: string;
  updatedAt: string;
}

/** What a board item IS. `draft` is a project-only note with no issue behind it,
 *  and `redacted` is an item whose content the viewer may not see — a private
 *  repo on a public board — which arrives with no fields at all rather than
 *  being dropped, so the board's counts stay honest.
 *
 *  Every arm but `redacted` carries `createdAt`/`updatedAt` — the CONTENT's own
 *  dates, which is a different claim from the membership's {@link BoardItem.addedAt}. */
export type BoardItemContent =
  | {
      kind: "issue";
      id: string;
      number: number;
      title: string;
      state: string;
      /** GitHub's issue state reason, or null when it carries none. COMPLETED /
       *  NOT_PLANNED / DUPLICATE ride a CLOSED issue, but REOPENED rides an OPEN
       *  one — so this is not a closed-only field, and a reader must not treat a
       *  present reason as proof the issue is closed. */
      stateReason: string | null;
      repoNameWithOwner: string;
      assignees: AssigneeRef[];
      createdAt: string;
      updatedAt: string;
    }
  | {
      kind: "pullRequest";
      id: string;
      number: number;
      title: string;
      state: string;
      isDraft: boolean;
      repoNameWithOwner: string;
      assignees: AssigneeRef[];
      createdAt: string;
      updatedAt: string;
    }
  | ({ kind: "draft" } & BoardDraftContent)
  | { kind: "redacted" };

/** One card on a board: the membership's own id, whether the board has archived
 *  it, what it holds, and its field values — the same per-item shape
 *  {@link ItemProjectFieldValues} carries, which is what groups it into a
 *  column. */
export interface BoardItem {
  itemId: string;
  isArchived: boolean;
  content: BoardItemContent;
  fieldValues: ProjectFieldValue[];
  /** When this item JOINED the board — the membership's own date, which for an
   *  issue or pull request is nothing like the content's `createdAt`. ISO-8601
   *  from the forge, so a reader validates before formatting. */
  addedAt: string;
}

/** One page of a board's items, in the board's own POSITION order. `totalCount`
 *  is the server's figure for THIS read's archived-state filter (measured: the
 *  default read settles to live items only), so it can exceed what a partly
 *  loaded board draws; `truncated` with `endCursor` is how the next page is
 *  asked for. */
export interface BoardItems {
  items: BoardItem[];
  totalCount: number;
  truncated: boolean;
  endCursor: string | null;
}

/** The board's own item order as a reposition answers with it: the project's
 *  items in their NEW global order, capped at the first 100 with `truncated`
 *  saying the rest weren't reached. The mutation's payload rather than a re-read
 *  because GitHub answers item READS off replicas that lag their own writes by
 *  seconds, where the payload is transactionally fresh. */
export interface BoardOrder {
  itemIds: string[];
  truncated: boolean;
}

/** One issue or pull request the board could take, as the add-existing search
 *  reports it. `id` is the CONTENT node id an add addresses — never a
 *  {@link BoardItem}'s `itemId`, which only exists once the item is on a board.
 *  `state`/`isDraft`/`stateReason` carry the same wire spellings
 *  {@link BoardItemContent} does, so one presentation table serves both. */
export interface BoardCandidate {
  id: string;
  kind: "issue" | "pr";
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  stateReason: string | null;
}

/** One page of add-existing candidates. `truncated` reports that the search was
 *  capped, the same claim {@link ProjectFieldDefs} and {@link ProjectViews} make
 *  about their lists. */
export interface BoardCandidates {
  candidates: BoardCandidate[];
  truncated: boolean;
}

/** What a converted draft became: the real issue's number, its web URL, and the
 *  card as the board now holds it. The draft's card keeps its item id across the
 *  conversion — only its content changes — so `item` is the board's own answer for
 *  that same id, which is what lets the card flip without a re-read. */
export interface ConvertedDraft {
  number: number;
  url: string;
  item: BoardItem;
}
