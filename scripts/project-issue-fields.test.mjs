// Pins how an org ISSUE field's writes are routed and gated, and how a board
// grouped by one draws. An org issue field lives on the issue and is only bridged
// onto a board: its write addresses the issue by the definition's `issueFieldId`,
// and sending the board's wrapper id down the board's own write path is refused by
// GitHub. Every rule here fails SILENTLY when wrong — a write that reads as saved
// but never left, a pull request row offering a field it can't take, every card
// bucketed under "No Risk" — so each is a case.
//
// The imports reach straight into `src/` and rely on Node's default type stripping
// (>= 23.6), which resolves no bundler aliases: every module imported below
// (board-model, roadmap-model, project-field-routing) must stay import-free apart
// from erased `import type`s. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildColumns,
  cardCount,
  columnValue,
  sortColumnItems,
  UNSET_COLUMN_ID,
  valueBelongsTo,
} from "../src/features/projects/board-model.ts";
import { datesAreIssueFields } from "../src/features/projects/roadmap-model.ts";
import {
  alignSeed,
  applyFieldDraft,
  canWriteIssueFields,
  ISSUE_FIELD_CONTENT_REASON,
  ISSUE_FIELD_PERMISSION_REASON,
  ISSUE_FIELD_UNREADABLE_REASON,
  issueFieldHeldReason,
  issueFieldHostOf,
  issueFieldHostReason,
  issueFieldNoneEligibleReason,
  issueFieldRoutes,
  issueFieldRowReason,
  issueFieldWritable,
  orphanedIssueOwners,
  partitionFieldWrites,
  planBulkFieldWrite,
  rescueIssueHalf,
  scopeToIssueFieldWritable,
  withoutRoutedFields,
} from "../src/lib/git/project-field-routing.ts";

const issue = (viewerCanSetFields, id = "I_issue") => ({
  kind: "issue",
  id,
  number: 1,
  title: "An issue",
  state: "OPEN",
  stateReason: null,
  repoNameWithOwner: "org/repo",
  assignees: [],
  createdAt: "",
  updatedAt: "",
  viewerCanSetFields,
});
const pullRequest = { kind: "pullRequest", id: "PR_pr", number: 2 };
const draft = { kind: "draft", id: "DI_draft", title: "A draft" };

const risk = {
  kind: "singleSelect",
  id: "PVTSSF_risk",
  name: "Risk",
  options: [
    { id: "IFSSO_low", name: "Low", color: "GREEN", description: "" },
    { id: "IFSSO_high", name: "High", color: "RED", description: "" },
  ],
  isIssueField: true,
  issueFieldId: "IFSS_risk",
};
const target = {
  kind: "date",
  id: "PVTF_target",
  name: "Target",
  isIssueField: true,
  issueFieldId: "IFD_target",
};
const status = {
  kind: "singleSelect",
  id: "PVTSSF_status",
  name: "Status",
  options: [{ id: "todo", name: "Todo", color: "GRAY", description: "" }],
  isIssueField: false,
};
const sprint = {
  kind: "iteration",
  id: "PVTIF_sprint",
  name: "Sprint",
  iterations: [],
  completedIterations: [],
};
// Flagged as an issue field, but GitHub served no IssueField id with it.
const lost = {
  kind: "text",
  id: "PVTF_lost",
  name: "Lost",
  isIssueField: true,
};

test("a board-defined field is never held by the issue-field arm", () => {
  for (const host of [null, issueFieldHostOf(issue(false))])
    for (const def of [status, sprint])
      assert.equal(issueFieldHeldReason(def, host), undefined);
});

test("an org issue field holds on anything but an issue the viewer may set", () => {
  assert.equal(
    issueFieldHeldReason(risk, issueFieldHostOf(pullRequest)),
    ISSUE_FIELD_CONTENT_REASON,
  );
  assert.equal(
    issueFieldHeldReason(risk, issueFieldHostOf(draft)),
    ISSUE_FIELD_CONTENT_REASON,
  );
  assert.equal(
    issueFieldHeldReason(risk, issueFieldHostOf(issue(false))),
    ISSUE_FIELD_PERMISSION_REASON,
  );
  // An issue read that carried no issue id has nothing to address.
  assert.equal(
    issueFieldHeldReason(risk, { issueId: undefined, canSetFields: true }),
    ISSUE_FIELD_UNREADABLE_REASON,
  );
  assert.equal(
    issueFieldHeldReason(risk, issueFieldHostOf(issue(true))),
    undefined,
  );
});

test("a flagged def with no issue field id holds, whatever the item", () => {
  for (const host of [
    null,
    issueFieldHostOf(issue(false)),
    issueFieldHostOf(issue(true)),
  ])
    assert.equal(
      issueFieldHeldReason(lost, host),
      ISSUE_FIELD_UNREADABLE_REASON,
    );
});

test("GitHub's nullable verdict reads as no, never as yes", () => {
  for (const verdict of [false, null, undefined])
    assert.equal(canWriteIssueFields(issueFieldHostOf(issue(verdict))), false);
  assert.equal(canWriteIssueFields(issueFieldHostOf(issue(true))), true);
  for (const content of [pullRequest, draft, { kind: "redacted" }])
    assert.equal(issueFieldHostOf(content), null);
});

test("routes map each issue field's wrapper id to its issue field id", () => {
  const routes = issueFieldRoutes([risk, target, status, sprint, lost]);
  assert.deepEqual(
    [...routes],
    [
      ["PVTSSF_risk", "IFSS_risk"],
      ["PVTF_target", "IFD_target"],
      ["PVTF_lost", null],
    ],
  );
});

test("a mixed write splits into a board half and a re-addressed issue half", () => {
  const routes = issueFieldRoutes([risk, target, status]);
  const parts = partitionFieldWrites(
    [
      { kind: "singleSelect", fieldId: "PVTSSF_status", optionId: "todo" },
      { kind: "singleSelect", fieldId: "PVTSSF_risk", optionId: "IFSSO_high" },
    ],
    ["PVTF_target", "PVTF_board_date"],
    routes,
  );
  assert.deepEqual(parts.updates, [
    { kind: "singleSelect", fieldId: "PVTSSF_status", optionId: "todo" },
  ]);
  assert.deepEqual(parts.clears, ["PVTF_board_date"]);
  assert.deepEqual(parts.issue, {
    updates: [
      { kind: "singleSelect", fieldId: "IFSS_risk", optionId: "IFSSO_high" },
    ],
    clears: ["IFD_target"],
  });
});

test("an issue-only write keeps its whole payload in the issue half", () => {
  const parts = partitionFieldWrites(
    [{ kind: "date", fieldId: "PVTF_target", date: "2027-01-01" }],
    [],
    issueFieldRoutes([target]),
  );
  assert.deepEqual(parts.updates, []);
  assert.deepEqual(parts.clears, []);
  assert.deepEqual(parts.issue.updates, [
    { kind: "date", fieldId: "IFD_target", date: "2027-01-01" },
  ]);
});

test("a routed field with no issue field id refuses instead of reaching the board path", () => {
  const routes = issueFieldRoutes([lost]);
  assert.throws(
    () =>
      partitionFieldWrites(
        [{ kind: "text", fieldId: "PVTF_lost", text: "x" }],
        [],
        routes,
      ),
    { message: ISSUE_FIELD_UNREADABLE_REASON },
  );
  assert.throws(() => partitionFieldWrites([], ["PVTF_lost"], routes), {
    message: ISSUE_FIELD_UNREADABLE_REASON,
  });
});

test("a batch plan gives the issue half only to issues the viewer may set", () => {
  const cards = [
    { itemId: "a", content: issue(true, "I_a") },
    { itemId: "b", content: issue(false, "I_b") },
    { itemId: "pr", content: pullRequest },
    { itemId: "d", content: draft },
  ];
  // Board and issue rows drafted: every card takes the board half.
  const mixed = planBulkFieldWrite(cards, true, true);
  assert.deepEqual(mixed.itemIds, ["a", "b", "pr", "d"]);
  assert.deepEqual(mixed.issueIds, ["I_a", null, null, null]);
  assert.deepEqual(mixed.skipped, []);
  // Issue rows alone: a card left with nothing to write is dropped, never sent.
  const issueOnly = planBulkFieldWrite(cards, false, true);
  assert.deepEqual(issueOnly.itemIds, ["a"]);
  assert.deepEqual(issueOnly.issueIds, ["I_a"]);
  assert.deepEqual(
    issueOnly.skipped.map((card) => card.itemId),
    ["b", "pr", "d"],
  );
  // Board rows alone: no issue ids at all.
  const boardOnly = planBulkFieldWrite(cards, true, false);
  assert.deepEqual(boardOnly.issueIds, [null, null, null, null]);
  assert.deepEqual(
    issueFieldWritable(cards).map((card) => card.itemId),
    ["a"],
  );
});

test("a bulk row holds only when it reaches no card, or can't be written at all", () => {
  assert.equal(issueFieldRowReason(status, 0, "card"), undefined);
  assert.equal(issueFieldRowReason(risk, 2, "card"), undefined);
  assert.equal(
    issueFieldRowReason(risk, 0, "row"),
    issueFieldNoneEligibleReason("row"),
  );
  assert.equal(
    issueFieldRowReason(lost, 3, "card"),
    ISSUE_FIELD_UNREADABLE_REASON,
  );
});

const card = (itemId, optionId) => ({
  itemId,
  isArchived: false,
  content: issue(true, `I_${itemId}`),
  addedAt: "2026-01-01T00:00:00Z",
  fieldValues:
    optionId === null
      ? []
      : [
          {
            kind: "singleSelect",
            fieldId: "PVTSSF_risk",
            fieldName: "Risk",
            optionId,
            name: optionId,
            color: "GRAY",
            isIssueField: true,
          },
        ],
});

test("a board grouped by an org single-select buckets cards by their IFSSO_ options", () => {
  const columns = buildColumns(
    [card("one", "IFSSO_high"), card("two", "IFSSO_low"), card("three", null)],
    risk,
    false,
  );
  assert.deepEqual(
    columns.map((column) => [column.id, column.items.map((i) => i.itemId)]),
    [
      ["IFSSO_low", ["two"]],
      ["IFSSO_high", ["one"]],
      [UNSET_COLUMN_ID, ["three"]],
    ],
  );
});

test("an org single-select sorts by its own option order", () => {
  const sorted = sortColumnItems(
    [card("one", "IFSSO_high"), card("two", "IFSSO_low"), card("three", null)],
    [{ fieldId: "PVTSSF_risk", direction: "asc" }],
    [risk],
  );
  assert.deepEqual(
    sorted.map((item) => item.itemId),
    ["two", "one", "three"],
  );
});

test("an issue-field move counts only its own narrowing as skipped", () => {
  // `live` is what the verb already kept (archived cards are gone by then), so
  // only the pull request, the draft and the issue the viewer can't set count.
  const live = [
    { itemId: "a", content: issue(true, "I_a") },
    { itemId: "b", content: issue(false, "I_b") },
    { itemId: "pr", content: pullRequest },
    { itemId: "d", content: draft },
  ];
  const scoped = scopeToIssueFieldWritable(live, true);
  assert.deepEqual(
    scoped.cards.map((card) => card.itemId),
    ["a"],
  );
  assert.equal(scoped.issueSkipped, 3);
  const unscoped = scopeToIssueFieldWritable(live, false);
  assert.equal(unscoped.cards.length, 4);
  assert.equal(unscoped.issueSkipped, 0);
});

test("a commit-time drop names the host's own reason", () => {
  assert.equal(issueFieldHostReason(null), ISSUE_FIELD_CONTENT_REASON);
  assert.equal(
    issueFieldHostReason(issueFieldHostOf(issue(false))),
    ISSUE_FIELD_PERMISSION_REASON,
  );
  assert.equal(
    issueFieldHostReason({ issueId: undefined, canSetFields: true }),
    ISSUE_FIELD_UNREADABLE_REASON,
  );
  assert.equal(issueFieldHostReason(issueFieldHostOf(issue(true))), undefined);
});

test("an org field holds one draft whose revision bumps on every edit, a Clear included", () => {
  const empty = { boards: {}, issueOwners: {} };
  const typed = applyFieldDraft(empty, "X", "PVTF_x", "IFT_notes", "abc");
  assert.deepEqual(typed.issueOwners.IFT_notes, {
    projectId: "X",
    fieldId: "PVTF_x",
    rev: 1,
  });
  // Another board's Clear takes the draft over: the old owner's copy goes, and the
  // revision moves on so the section that typed "abc" remounts onto the clear.
  const cleared = applyFieldDraft(typed, "Y", "PVTF_y", "IFT_notes", null);
  assert.deepEqual(cleared.boards.X, {});
  assert.deepEqual(cleared.boards.Y, { PVTF_y: null });
  assert.equal(cleared.issueOwners.IFT_notes.rev, 2);
  assert.equal(cleared.issueOwners.IFT_notes.projectId, "Y");
  // Same-board edits keep the owner and still bump.
  const again = applyFieldDraft(cleared, "Y", "PVTF_y", "IFT_notes", "d");
  assert.equal(again.issueOwners.IFT_notes.rev, 3);
  assert.deepEqual(again.boards.Y, { PVTF_y: "d" });
  // A board-defined field touches no owner.
  const board = applyFieldDraft(again, "X", "status", undefined, "todo");
  assert.deepEqual(board.issueOwners, again.issueOwners);
  assert.deepEqual(board.boards.X, { status: "todo" });
});

// Measured on the org fixture: an org multi-select's VALUE ref reads as
// ProjectV2Field/PVTF_, its DEFINITION as ProjectV2MultiSelectField/PVTMSF_. Only
// the IssueField id is common to both, so that is what the fallback joins on.
const areas = {
  kind: "multiSelect",
  id: "PVTMSF_areas",
  name: "Areas",
  options: [
    { id: "IFSSO_web", name: "Web", color: "BLUE", description: "" },
    { id: "IFSSO_docs", name: "Docs", color: "GRAY", description: "" },
  ],
  isIssueField: true,
  issueFieldId: "IFMS_areas",
};
const areasValue = (issueFieldId) => ({
  kind: "multiSelect",
  fieldId: "PVTF_areas",
  fieldName: "Areas",
  options: [
    { id: "IFSSO_web", name: "Web", color: "BLUE" },
    { id: "IFSSO_docs", name: "Docs", color: "GRAY" },
  ],
  isIssueField: true,
  ...(issueFieldId === undefined ? {} : { issueFieldId }),
});

test("an org value served under another wrapper id still belongs to its definition", () => {
  assert.equal(valueBelongsTo(areasValue("IFMS_areas"), areas), true);
  const item = {
    itemId: "one",
    isArchived: false,
    content: issue(true),
    addedAt: "",
    fieldValues: [areasValue("IFMS_areas")],
  };
  assert.deepEqual(columnValue(item, areas), areasValue("IFMS_areas"));
});

test("without the IssueField id, or on a board-defined field, only the wrapper id joins", () => {
  assert.equal(valueBelongsTo(areasValue(undefined), areas), false);
  assert.equal(valueBelongsTo(areasValue("IFMS_other"), areas), false);
  assert.equal(
    valueBelongsTo(areasValue("IFMS_areas"), { ...areas, isIssueField: false }),
    false,
  );
  // A definition GitHub served no issue field id for never matches by fallback.
  const { issueFieldId: _dropped, ...unread } = areas;
  assert.equal(valueBelongsTo(areasValue("IFMS_areas"), unread), false);
  assert.equal(
    valueBelongsTo({ kind: "unknown", fieldName: "Areas" }, areas),
    false,
  );
  // The wrapper id still joins first, with or without the IssueField id.
  assert.equal(
    valueBelongsTo(
      { ...areasValue(undefined), fieldId: "PVTMSF_areas" },
      areas,
    ),
    true,
  );
});

test("the editor's seed finds a mismatched org value under its definition's id", () => {
  // The seed is keyed by the value's own wrapper id; drafts by the definition's.
  // Unfound, a Clear diffs as a no-op and a pick replaces a set it never saw.
  const seed = { PVTF_areas: areasValue("IFMS_areas") };
  const aligned = alignSeed(seed, new Map([["PVTMSF_areas", "IFMS_areas"]]));
  assert.deepEqual(aligned.PVTMSF_areas, areasValue("IFMS_areas"));
  assert.deepEqual(aligned.PVTF_areas, areasValue("IFMS_areas"));
  // No IssueField id on the value: nothing to join on, and nothing invented.
  const bare = alignSeed(
    { PVTF_areas: areasValue(undefined) },
    new Map([["PVTMSF_areas", "IFMS_areas"]]),
  );
  assert.equal(bare.PVTMSF_areas, undefined);
});

test("a roadmap placed only by org issue dates tells undated PRs and drafts why", () => {
  const boardDate = {
    kind: "date",
    id: "PVTF_due",
    name: "Due",
    isIssueField: false,
  };
  const defs = [target, boardDate, sprint];
  const date = (fieldId) => ({ kind: "date", fieldId });
  assert.equal(
    datesAreIssueFields({ start: null, target: date("PVTF_target") }, defs),
    true,
  );
  // A board date a pull request CAN take keeps the ordinary instruction.
  assert.equal(
    datesAreIssueFields(
      { start: date("PVTF_due"), target: date("PVTF_target") },
      defs,
    ),
    false,
  );
  assert.equal(
    datesAreIssueFields(
      { start: { kind: "iteration", fieldId: "PVTIF_sprint" }, target: null },
      defs,
    ),
    false,
  );
  assert.equal(datesAreIssueFields({ start: null, target: null }, defs), false);
});

// The editor's drafts as the rescue reads them: board X owns the Risk draft (an
// org field, routed) beside its own Status draft; board Y mirrors Risk.
const editorDrafts = {
  boards: {
    X: { PVTSSF_risk: "IFSSO_high", PVTSSF_status: "todo" },
    Y: {},
  },
  issueOwners: {
    IFSS_risk: { projectId: "X", fieldId: "PVTSSF_risk", rev: 1 },
  },
};
/** A diff that treats every touched entry as a change: a string is a set, null a
 *  clear. The editor passes its own no-op-aware diff here. */
const everyEntry = (_projectId, touched) => {
  const updates = [];
  const clears = [];
  for (const [fieldId, entry] of Object.entries(touched)) {
    if (entry === null) clears.push(fieldId);
    else updates.push({ kind: "singleSelect", fieldId, optionId: entry });
  }
  return { updates, clears };
};

test("an org draft whose owning board left mid-open still reaches the issue", () => {
  // Case 1: X is gone from the item; only Y is live and writable.
  assert.deepEqual(rescueIssueHalf(editorDrafts, new Set(["Y"]), everyEntry), {
    updates: [
      { kind: "singleSelect", fieldId: "IFSS_risk", optionId: "IFSSO_high" },
    ],
    clears: [],
  });
});

test("an org draft whose owning board can no longer be written still reaches the issue", () => {
  // Case 2: X is live but lost write access, so it is not in the writable set.
  // Its own Status draft is NOT rescued: that half is addressed to X's membership.
  const rescued = rescueIssueHalf(
    {
      ...editorDrafts,
      boards: {
        ...editorDrafts.boards,
        X: { PVTSSF_risk: null, PVTSSF_status: "todo" },
      },
    },
    new Set(["Y"]),
    everyEntry,
  );
  assert.deepEqual(rescued, { updates: [], clears: ["IFSS_risk"] });
});

test("a draft owned by a written board is left to that board's own write", () => {
  assert.deepEqual(
    rescueIssueHalf(editorDrafts, new Set(["X", "Y"]), everyEntry),
    {
      updates: [],
      clears: [],
    },
  );
  assert.equal(
    orphanedIssueOwners(editorDrafts.issueOwners, new Set(["X"])).size,
    0,
  );
});

test("with no board left, the rescue finds the drafts but invents no write", () => {
  // Every board gone: the issue half is still found (so the editor can say it
  // wasn't applied); carrying it needs a live board, which the editor checks.
  const rescued = rescueIssueHalf(editorDrafts, new Set(), everyEntry);
  assert.equal(rescued.updates.length, 1);
  assert.deepEqual(
    [...orphanedIssueOwners(editorDrafts.issueOwners, new Set())],
    [["X", new Map([["PVTSSF_risk", "IFSS_risk"]])]],
  );
});

test("the stranded-board count reads only a board's own drafts", () => {
  assert.deepEqual(
    withoutRoutedFields(
      editorDrafts.boards.X,
      new Map([["PVTSSF_risk", "IFSS_risk"]]),
    ),
    { PVTSSF_status: "todo" },
  );
});

test("a bulk row's reach counts its cards in the board's own grammar", () => {
  assert.equal(cardCount(1, "card"), "1 card");
  assert.equal(cardCount(5, "card"), "5 cards");
  assert.equal(cardCount(1, "row"), "1 row");
  assert.equal(cardCount(0, "row"), "0 rows");
});
