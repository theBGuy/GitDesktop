import type {
  BoardItemContent,
  IssueFieldValueUpdate,
  ProjectFieldDef,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
} from "@/lib/git/types";

/**
 * How a project field write splits between the board and the issue, and when an
 * org issue field can be written at all. An org issue field lives on the ISSUE and
 * is only bridged onto a board, so its write addresses the issue by the
 * definition's `issueFieldId` — the board's wrapper id is refused there.
 *
 * Pure and type-only on purpose: `scripts/project-issue-fields.test.mjs` imports
 * this file straight into Node, which resolves no bundler aliases.
 */

/** Why a pull request or draft can't take an org issue field. */
export const ISSUE_FIELD_CONTENT_REASON =
  "Issue fields are set on issues, so pull requests and drafts don't have them";
/** Why an issue's org fields are held when GitHub says the viewer can't set them. */
export const ISSUE_FIELD_PERMISSION_REASON =
  "Setting this issue's fields needs permission from its organization";
/** Why an org issue field is held when GitHub didn't send what its write needs. */
export const ISSUE_FIELD_UNREADABLE_REASON =
  "Set this issue field on GitHub — its details didn't load here";

/** Why a selection-wide org issue-field write has nothing to reach. */
export function issueFieldNoneEligibleReason(noun: "card" | "row"): string {
  return `None of the selected ${noun}s is an issue you can set this field on`;
}

/** Why a selection-wide write holds `def`'s row, given how many selected cards it
 *  can reach — undefined for a board-defined field, or while any card is left: the
 *  others are skipped, never a reason to hold the row. */
export function issueFieldRowReason(
  def: ProjectFieldDef,
  reachable: number,
  noun: "card" | "row",
): string | undefined {
  if (def.kind === "iteration" || def.kind === "system" || !def.isIssueField)
    return undefined;
  if (def.issueFieldId === undefined) return ISSUE_FIELD_UNREADABLE_REASON;
  return reachable === 0 ? issueFieldNoneEligibleReason(noun) : undefined;
}

/** The item an org issue-field write would land on: its issue id and GitHub's
 *  verdict on setting its fields, or null for content that isn't an issue. An
 *  `issueId` the read didn't carry reads as undefined, which holds the write. */
export type IssueFieldHost = {
  issueId: string | undefined;
  canSetFields: boolean;
} | null;

export function issueFieldHostOf(content: BoardItemContent): IssueFieldHost {
  return content.kind === "issue"
    ? { issueId: content.id, canSetFields: content.viewerCanSetFields === true }
    : null;
}

/** Whether `host` is an issue whose org fields the viewer may write. */
export function canWriteIssueFields(
  host: IssueFieldHost,
): host is { issueId: string; canSetFields: true } {
  return host !== null && host.issueId !== undefined && host.canSetFields;
}

/** An org issue field bridged onto a board. Iteration fields never are one. */
export function isIssueFieldDef(def: ProjectFieldDef): boolean {
  return def.kind !== "iteration" && def.kind !== "system" && def.isIssueField;
}

/** Why an org issue field can't be written for `host`, or undefined when it can —
 *  and always undefined for a board-defined field. Keyed on `isIssueField`, never
 *  on the id's presence: a flagged def with no `issueFieldId` holds rather than
 *  falling through to the board's write path, which GitHub refuses for it. */
export function issueFieldHeldReason(
  def: ProjectFieldDef,
  host: IssueFieldHost,
): string | undefined {
  if (def.kind === "iteration" || def.kind === "system" || !def.isIssueField)
    return undefined;
  if (def.issueFieldId === undefined) return ISSUE_FIELD_UNREADABLE_REASON;
  return issueFieldHostReason(host);
}

/** Why no org issue field can be written on `host`, whichever field it is, or
 *  undefined when any readable one can. */
export function issueFieldHostReason(host: IssueFieldHost): string | undefined {
  if (host === null) return ISSUE_FIELD_CONTENT_REASON;
  if (host.issueId === undefined) return ISSUE_FIELD_UNREADABLE_REASON;
  if (!host.canSetFields) return ISSUE_FIELD_PERMISSION_REASON;
  return undefined;
}

/** Where the ONE draft of an org issue field lives in a multi-board editor: the
 *  board section last edited, that board's wrapper id for the field, and a
 *  revision every draft of it bumps — the mirrors' remount key, so a section
 *  re-entering the mirror always redraws, whatever value it last showed. */
export type IssueDraftOwner = {
  projectId: string;
  fieldId: string;
  rev: number;
};

/** A multi-board editor's drafts: per board by wrapper field id, plus each org
 *  issue field's owner by issue field id. */
export type EditorDrafts<Entry> = {
  boards: Record<string, Record<string, Entry>>;
  issueOwners: Record<string, IssueDraftOwner>;
};

/** `prev` with `entry` drafted on `projectId`'s `fieldId`. An org issue field
 *  (`issueFieldId` set) holds ONE draft: it moves to this board, the previous
 *  owner's copy goes, and the revision bumps on every draft, a Clear included. */
export function applyFieldDraft<Entry>(
  prev: EditorDrafts<Entry>,
  projectId: string,
  fieldId: string,
  issueFieldId: string | undefined,
  entry: Entry,
): EditorDrafts<Entry> {
  const boards = {
    ...prev.boards,
    [projectId]: { ...(prev.boards[projectId] ?? {}), [fieldId]: entry },
  };
  if (issueFieldId === undefined) return { ...prev, boards };
  const owner = prev.issueOwners[issueFieldId];
  if (owner !== undefined && owner.projectId !== projectId) {
    const { [owner.fieldId]: _moved, ...rest } = boards[owner.projectId] ?? {};
    boards[owner.projectId] = rest;
  }
  return {
    boards,
    issueOwners: {
      ...prev.issueOwners,
      [issueFieldId]: { projectId, fieldId, rev: (owner?.rev ?? 0) + 1 },
    },
  };
}

/** `seed` with each routed org field's value also filed under its definition's id
 *  (`routes`: definition id → issue field id). GitHub can serve a value under a
 *  different wrapper id than the definition, and an editor's drafts are keyed by
 *  the definition's — so the no-op test and a Clear both need the value found. */
export function alignSeed(
  seed: Record<string, ProjectFieldValue>,
  routes: ReadonlyMap<string, string>,
): Record<string, ProjectFieldValue> {
  const aligned = { ...seed };
  for (const [defId, issueFieldId] of routes) {
    if (aligned[defId] !== undefined) continue;
    const match = Object.values(seed).find(
      (value) => "issueFieldId" in value && value.issueFieldId === issueFieldId,
    );
    if (match !== undefined) aligned[defId] = match;
  }
  return aligned;
}

/** Wrapper field id → the org IssueField id its writes address, for every issue
 *  field in `defs`; null marks one GitHub didn't serve the id for. */
export function issueFieldRoutes(
  defs: readonly ProjectFieldDef[],
): Map<string, string | null> {
  const routes = new Map<string, string | null>();
  for (const def of defs) {
    if (def.kind === "iteration" || def.kind === "system" || !def.isIssueField)
      continue;
    routes.set(def.id, def.issueFieldId ?? null);
  }
  return routes;
}

/** The issue half of a write, by issue field id. */
export interface IssueFieldPart {
  updates: IssueFieldValueUpdate[];
  clears: string[];
}

export function hasIssueFieldWrites(part: IssueFieldPart): boolean {
  return part.updates.length > 0 || part.clears.length > 0;
}

/**
 * A drafted write — every field addressed by its board wrapper id — split into the
 * board half and the issue half, the latter re-addressed to each field's
 * `issueFieldId`. A clear in the issue half becomes a `delete` entry at the backend.
 *
 * THROWS on a routed field with no issue field id rather than sending it down the
 * board path: callers hold such fields, so reaching one here is a bug to surface.
 */
export function partitionFieldWrites(
  updates: readonly ProjectFieldValueUpdate[],
  clears: readonly string[],
  routes: ReadonlyMap<string, string | null>,
): {
  updates: ProjectFieldValueUpdate[];
  clears: string[];
  issue: IssueFieldPart;
} {
  const issueIdOf = (fieldId: string): string | undefined => {
    if (!routes.has(fieldId)) return undefined;
    const issueFieldId = routes.get(fieldId);
    if (issueFieldId === null || issueFieldId === undefined)
      throw new Error(ISSUE_FIELD_UNREADABLE_REASON);
    return issueFieldId;
  };
  const board: ProjectFieldValueUpdate[] = [];
  const boardClears: string[] = [];
  const issue: IssueFieldPart = { updates: [], clears: [] };
  for (const update of updates) {
    const issueFieldId =
      update.kind === "iteration" ? undefined : issueIdOf(update.fieldId);
    if (issueFieldId === undefined || update.kind === "iteration")
      board.push(update);
    else issue.updates.push({ ...update, fieldId: issueFieldId });
  }
  for (const fieldId of clears) {
    const issueFieldId = issueIdOf(fieldId);
    if (issueFieldId === undefined) boardClears.push(fieldId);
    else issue.clears.push(issueFieldId);
  }
  return { updates: board, clears: boardClears, issue };
}

/** `touched` without the org fields `routes` names — a board's own drafts, the
 *  half that is addressed to its membership. */
export function withoutRoutedFields<Entry>(
  touched: Record<string, Entry>,
  routes: ReadonlyMap<string, unknown>,
): Record<string, Entry> {
  return Object.fromEntries(
    Object.entries(touched).filter(([fieldId]) => !routes.has(fieldId)),
  );
}

/** The org-field owners no board write will carry, grouped by owning board:
 *  those whose board is not in `writable` (it left the item, or can no longer
 *  be written). Each maps the drafted definition id → its issue field id. */
export function orphanedIssueOwners(
  issueOwners: Record<string, IssueDraftOwner>,
  writable: ReadonlySet<string>,
): Map<string, Map<string, string>> {
  const orphans = new Map<string, Map<string, string>>();
  for (const [issueFieldId, owner] of Object.entries(issueOwners)) {
    if (writable.has(owner.projectId)) continue;
    const routes = orphans.get(owner.projectId) ?? new Map<string, string>();
    routes.set(owner.fieldId, issueFieldId);
    orphans.set(owner.projectId, routes);
  }
  return orphans;
}

/**
 * The issue half of every org-field draft whose owning board won't be written —
 * still sendable, since it addresses the issue rather than any membership. `diff`
 * is the editor's own no-op-aware diff of one board's drafts against its seed.
 * One owner per issue field, so the result never names a field twice, nor one a
 * written board's own issue half already carries.
 */
export function rescueIssueHalf<Entry>(
  drafts: EditorDrafts<Entry>,
  writable: ReadonlySet<string>,
  diff: (
    projectId: string,
    touched: Record<string, Entry>,
    routes: ReadonlyMap<string, string>,
  ) => { updates: ProjectFieldValueUpdate[]; clears: string[] },
): IssueFieldPart {
  const rescued: IssueFieldPart = { updates: [], clears: [] };
  for (const [projectId, routes] of orphanedIssueOwners(
    drafts.issueOwners,
    writable,
  )) {
    const touched = Object.fromEntries(
      Object.entries(drafts.boards[projectId] ?? {}).filter(([fieldId]) =>
        routes.has(fieldId),
      ),
    );
    const { updates, clears } = diff(projectId, touched, routes);
    const { issue } = partitionFieldWrites(updates, clears, routes);
    rescued.updates.push(...issue.updates);
    rescued.clears.push(...issue.clears);
  }
  return rescued;
}

/** One batch card as the bulk write plan reads it. */
interface PlannedCard {
  itemId: string;
  content: BoardItemContent;
}

/**
 * Which cards a batch write addresses, and the issue each one's issue half lands on.
 * A card takes the board half whenever there is one; it takes the issue half only
 * when it is an issue the viewer may set fields on. A card left with NEITHER is
 * SKIPPED — dropped from the request, since the backend would answer an empty write
 * as landed — and reported apart from the failures.
 */
export function planBulkFieldWrite<Card extends PlannedCard>(
  cards: readonly Card[],
  boardWrites: boolean,
  issueWrites: boolean,
): { itemIds: string[]; issueIds: (string | null)[]; skipped: Card[] } {
  const itemIds: string[] = [];
  const issueIds: (string | null)[] = [];
  const skipped: Card[] = [];
  for (const card of cards) {
    const host = issueFieldHostOf(card.content);
    const issueId =
      issueWrites && canWriteIssueFields(host) ? host.issueId : null;
    if (!boardWrites && issueId === null) {
      skipped.push(card);
      continue;
    }
    itemIds.push(card.itemId);
    issueIds.push(issueId);
  }
  return { itemIds, issueIds, skipped };
}

/** A verb's live cards narrowed to the ones an org issue-field write reaches when
 *  `scoped`, with how many that narrowing alone dropped — the count a report
 *  words as issue-field skips, apart from whatever the verb skipped before it. */
export function scopeToIssueFieldWritable<Card extends PlannedCard>(
  live: readonly Card[],
  scoped: boolean,
): { cards: Card[]; issueSkipped: number } {
  const cards = scoped ? issueFieldWritable(live) : [...live];
  return { cards, issueSkipped: live.length - cards.length };
}

/** The cards an org issue field can be written on: issues the viewer may set. */
export function issueFieldWritable<Card extends PlannedCard>(
  cards: readonly Card[],
): Card[] {
  return cards.filter((card) =>
    canWriteIssueFields(issueFieldHostOf(card.content)),
  );
}
