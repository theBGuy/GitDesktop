import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TableColumn, TableEntry } from "@/features/projects/board-model";
import { ProjectsTableView } from "@/features/projects/ProjectsTableView";
import type { BoardItem } from "@/lib/git/types";

const ITEM: BoardItem = {
  itemId: "PVTI_1",
  isArchived: false,
  content: {
    kind: "issue",
    id: "I_1",
    number: 7,
    title: "Row one",
    state: "OPEN",
    stateReason: null,
    repoNameWithOwner: "o/r",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    viewerCanSetFields: true,
  },
  fieldValues: [],
  addedAt: "2026-01-01T00:00:00Z",
};

const COLUMNS: TableColumn[] = [
  {
    def: { kind: "system", id: "F_TITLE", name: "Title", dataType: "TITLE" },
    title: true,
  },
  {
    def: { kind: "text", id: "F_NOTE", name: "Note", isIssueField: false },
    title: false,
  },
];

const ROWS: TableEntry[] = [
  {
    kind: "group",
    key: "group:B_1",
    bucketId: "B_1",
    label: "Todo",
    color: null,
    count: 1,
    expanded: true,
  },
  { kind: "item", key: "item:PVTI_1", item: ITEM },
];

const NO_SORT: never[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

function renderTable() {
  const onActivate = vi.fn();
  const onToggleGroup = vi.fn();
  const onEditCell = vi.fn();
  const { container } = render(
    <ProjectsTableView
      label="Table"
      columns={COLUMNS}
      rows={ROWS}
      sortKeys={NO_SORT}
      cursor={null}
      focusNonce={0}
      selectedIds={NO_IDS}
      selectionSize={0}
      busyItemId={null}
      openingItemId={null}
      peekItemId={null}
      editHeld={undefined}
      editingCell={null}
      onCellFocus={vi.fn()}
      onToggleGroup={onToggleGroup}
      onActivate={onActivate}
      onPeekChange={vi.fn()}
      onEditCell={onEditCell}
      onCellCommit={vi.fn()}
      onCellCancel={vi.fn()}
      onFocusLost={vi.fn()}
      onKeyDown={vi.fn()}
    />,
  );
  const find = (selector: string) => {
    const el = container.querySelector<HTMLElement>(selector);
    if (el === null) throw new Error(`no ${selector} rendered`);
    return el;
  };
  return {
    title: find("[data-title-open]"),
    toggle: find("[data-group-toggle]"),
    editCell: find('[data-edit-field="F_NOTE"]'),
    onActivate,
    onToggleGroup,
    onEditCell,
  };
}

// jsdom lays nothing out, so the virtualizer (sized from the scroll element's
// clientWidth/clientHeight) paints no row; a fixed client size gives it one.
// RTL's click defaults `detail` to 0, a keyboard click's count, so every mouse
// click here passes its count.
describe("Clicking in the projects table", () => {
  const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
  beforeAll(() => {
    for (const [k, v] of Object.entries(CLIENT_SIZE)) {
      Object.defineProperty(HTMLElement.prototype, k, {
        configurable: true,
        get: () => v,
      });
    }
  });
  afterAll(() => {
    for (const k of Object.keys(CLIENT_SIZE)) {
      Reflect.deleteProperty(HTMLElement.prototype, k);
    }
  });

  it("opens a row's title once on a single click", () => {
    const { title, onActivate } = renderTable();
    fireEvent.click(title, { detail: 1 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(ITEM);
  });

  it("opens a row's title once on a double click", () => {
    const { title, onActivate } = renderTable();
    fireEvent.click(title, { detail: 1 });
    fireEvent.click(title, { detail: 2 });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("opens a row's title once on a triple click", () => {
    const { title, onActivate } = renderTable();
    fireEvent.click(title, { detail: 1 });
    fireEvent.click(title, { detail: 2 });
    fireEvent.click(title, { detail: 3 });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("opens a row's title on a keyboard-synthesized click", () => {
    const { title, onActivate } = renderTable();
    fireEvent.click(title, { detail: 0 });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("toggles a group header on every click of a double click", () => {
    const { toggle, onToggleGroup, onActivate } = renderTable();
    fireEvent.click(toggle, { detail: 1 });
    fireEvent.click(toggle, { detail: 2 });
    expect(onToggleGroup).toHaveBeenCalledTimes(2);
    expect(onToggleGroup).toHaveBeenCalledWith("B_1");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("opens an editable cell's editor on a later click of a gesture", () => {
    const { editCell, onEditCell, onActivate } = renderTable();
    fireEvent.click(editCell, { detail: 2 });
    expect(onEditCell).toHaveBeenCalledWith(ITEM, "F_NOTE");
    expect(onActivate).not.toHaveBeenCalled();
  });
});
