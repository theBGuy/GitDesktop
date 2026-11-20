import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  BoardCardMenuItems,
  type BoardMenuActions,
  type BulkMenuState,
} from "@/features/projects/BoardCardMenu";
import type { BoardItem } from "@/lib/git/types";

const ITEM: BoardItem = {
  itemId: "PVTI_1",
  isArchived: false,
  content: {
    kind: "issue",
    id: "I_1",
    number: 7,
    title: "Card one",
    state: "OPEN",
    stateReason: null,
    repoNameWithOwner: "o/r",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    viewerCanSetFields: false,
  },
  fieldValues: [],
  addedAt: "2026-01-01T00:00:00Z",
};

const NOOP_PLANS = {
  up: { kind: "noop" },
  down: { kind: "noop" },
  top: { kind: "noop" },
  bottom: { kind: "noop" },
} as const;

function bulkState(): BulkMenuState {
  const row = { label: "Row", reason: undefined };
  return {
    move: row,
    fields: { label: "Set fields on 2 cards", reason: undefined },
    archive: { label: "Archive 2 cards", reason: undefined },
    restore: { label: "Restore 2 cards", reason: undefined },
    remove: { label: "Remove 2 cards", reason: undefined },
    actions: {
      move: vi.fn(),
      fields: vi.fn(),
      archive: vi.fn(),
      restore: vi.fn(),
      remove: vi.fn(),
    },
  };
}

function actionSpies(): BoardMenuActions {
  return {
    open: vi.fn(),
    openOnWeb: vi.fn(),
    showDetails: vi.fn(),
    move: vi.fn(),
    reorder: vi.fn(),
    editDraft: vi.fn(),
    convert: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn(),
  };
}

async function openMenu(
  openRows: { primary: string; secondary: string | null } | null,
  bulk: BulkMenuState | null = null,
) {
  const actions = actionSpies();
  const user = userEvent.setup();
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-testid="card">card</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <BoardCardMenuItems
          target={{ item: ITEM, valueColumnId: "c1" }}
          noun="card"
          bulk={bulk}
          columns={[]}
          openRows={openRows}
          heldReason={undefined}
          actionHeldReason={undefined}
          editHeldReason={undefined}
          reorderHeldReason={undefined}
          reorderPlans={NOOP_PLANS}
          canPeek
          actions={actions}
        />
      </ContextMenuContent>
    </ContextMenu>,
  );
  await user.pointer({
    keys: "[MouseRight]",
    target: screen.getByTestId("card"),
  });
  const menu = await screen.findByRole("menu");
  return { user, menu, actions };
}

function labels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.textContent ?? "");
}

/** The rows above the first separator, in DOM order. */
function rowsAboveSeparator(menu: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of menu.querySelectorAll(
    '[role="menuitem"], [role="separator"]',
  )) {
    if (el.getAttribute("role") === "separator") break;
    out.push(el.textContent ?? "");
  }
  return out;
}

describe("the card menu's Open rows", () => {
  it("draws the primary row, then the web row, above the separator", async () => {
    const { menu } = await openMenu({
      primary: "Open in harbor",
      secondary: "Open on GitHub",
    });
    expect(rowsAboveSeparator(menu)).toEqual([
      "Open in harbor",
      "Open on GitHub",
    ]);
    expect(labels(menu).slice(0, 2)).toEqual([
      "Open in harbor",
      "Open on GitHub",
    ]);
  });

  it("draws one row when the primary row already opens the web page", async () => {
    const { menu } = await openMenu({
      primary: "Open on GitHub",
      secondary: null,
    });
    expect(rowsAboveSeparator(menu)).toEqual(["Open on GitHub"]);
    expect(labels(menu).filter((l) => l.startsWith("Open"))).toEqual([
      "Open on GitHub",
    ]);
  });

  it("draws no Open row for a draft or a redacted card", async () => {
    const { menu } = await openMenu(null);
    expect(labels(menu).some((l) => l.startsWith("Open"))).toBe(false);
  });

  it("runs the primary row's action alone", async () => {
    const { user, menu, actions } = await openMenu({
      primary: "Open",
      secondary: "Open on GitHub",
    });
    await user.click(within(menu).getByRole("menuitem", { name: "Open" }));
    expect(actions.open).toHaveBeenCalledTimes(1);
    expect(actions.openOnWeb).not.toHaveBeenCalled();
  });

  it("runs the web row's action alone", async () => {
    const { user, menu, actions } = await openMenu({
      primary: "Open in Upstream",
      secondary: "Open on GitHub",
    });
    await user.click(
      within(menu).getByRole("menuitem", { name: "Open on GitHub" }),
    );
    expect(actions.openOnWeb).toHaveBeenCalledTimes(1);
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("reaches the two rows by arrow keys, in order", async () => {
    const { user, menu } = await openMenu({
      primary: "Open in Fork",
      secondary: "Open on GitHub",
    });
    const rows = within(menu).getAllByRole("menuitem");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1].textContent).toBe("Open on GitHub");
  });

  it("keeps both rows on the bulk menu, acting on the target card", async () => {
    const { user, menu, actions } = await openMenu(
      { primary: "Open in harbor", secondary: "Open on GitHub" },
      bulkState(),
    );
    expect(rowsAboveSeparator(menu)).toEqual([
      "Open in harbor",
      "Open on GitHub",
    ]);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Open on GitHub" }),
    );
    expect(actions.openOnWeb).toHaveBeenCalledTimes(1);
  });
});
