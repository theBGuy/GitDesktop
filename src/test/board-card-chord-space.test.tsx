import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardCard } from "@/features/projects/BoardCard";
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

const DRAFT: BoardItem = {
  itemId: "PVTI_2",
  isArchived: false,
  content: {
    kind: "draft",
    id: "DI_2",
    title: "Draft one",
    body: "Some notes",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  fieldValues: [],
  addedAt: "2026-01-01T00:00:00Z",
};

const NO_FIELDS: never[] = [];

// What macOS reports for Option+Space: a non-breaking space on the Space key.
const OPTION_SPACE_KEY = String.fromCharCode(0xa0);

function renderCard(item: BoardItem = ITEM) {
  const onPeekChange = vi.fn();
  const onOpen = vi.fn();
  render(
    <BoardCard
      item={item}
      index={0}
      setSize={1}
      columnIndex={0}
      selected={false}
      checked={false}
      busy={false}
      peek={false}
      rovingTab={0}
      repoSlug="o/r"
      ghHost={null}
      chipFields={NO_FIELDS}
      onFocus={vi.fn()}
      onPeekChange={onPeekChange}
      onOpen={onOpen}
    />,
  );
  return { card: screen.getByRole("option"), onPeekChange, onOpen };
}

type Mods = { altKey?: boolean; key?: string; repeat?: boolean };

function space(
  card: HTMLElement,
  kind: "keyDown" | "keyUp",
  mods: Mods = {},
): Event {
  const event = createEvent[kind](card, { key: " ", code: "Space", ...mods });
  fireEvent(card, event);
  return event;
}

// jsdom fires no activation click on a button's Space keyup, so these pin the
// handlers' contract; the real click is a live-drive check.
describe.each([
  ["an issue card", ITEM],
  ["a draft card", DRAFT],
])("Space on %s", (_name, item) => {
  it("cancels an Alt+Space press's activation", () => {
    const { card } = renderCard(item);
    space(card, "keyDown", { altKey: true });
    expect(space(card, "keyUp", { altKey: true }).defaultPrevented).toBe(true);
  });

  it("cancels the keyup when Alt was released before Space", () => {
    const { card } = renderCard(item);
    space(card, "keyDown", { altKey: true });
    fireEvent.keyUp(card, { key: "Alt", code: "AltLeft" });
    expect(space(card, "keyUp").defaultPrevented).toBe(true);
  });

  it("keeps the chord's verdict through a bare auto-repeat", () => {
    const { card } = renderCard(item);
    space(card, "keyDown", { altKey: true });
    space(card, "keyDown", { repeat: true });
    // A draft opens only on the click this keyup would fire, so it is the pin.
    expect(space(card, "keyUp").defaultPrevented).toBe(true);
  });

  it("cancels a keyup reporting another character on the Space key", () => {
    const { card } = renderCard(item);
    space(card, "keyDown", { altKey: true, key: OPTION_SPACE_KEY });
    expect(
      space(card, "keyUp", { altKey: true, key: OPTION_SPACE_KEY })
        .defaultPrevented,
    ).toBe(true);
  });

  it("leaves a bare Space press's keyup alone, even after a chord", () => {
    const { card } = renderCard(item);
    space(card, "keyDown", { altKey: true });
    space(card, "keyUp", { altKey: true });
    space(card, "keyDown");
    expect(space(card, "keyUp").defaultPrevented).toBe(false);
  });
});

describe("Space on an issue card", () => {
  it("lets an Alt+Space keydown through for a bound chord, without a peek", () => {
    const { card, onPeekChange, onOpen } = renderCard();
    expect(space(card, "keyDown", { altKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(onPeekChange).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("neither peeks nor opens on a bare auto-repeat after the chord's modifier came up", () => {
    const { card, onPeekChange, onOpen } = renderCard();
    space(card, "keyDown", { altKey: true });
    expect(space(card, "keyDown", { repeat: true }).defaultPrevented).toBe(
      true,
    );
    expect(space(card, "keyUp").defaultPrevented).toBe(true);
    expect(onPeekChange).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("peeks on a bare Space keydown", () => {
    const { card, onPeekChange } = renderCard();
    expect(space(card, "keyDown").defaultPrevented).toBe(true);
    expect(onPeekChange).toHaveBeenCalledWith(ITEM.itemId);
  });
});
