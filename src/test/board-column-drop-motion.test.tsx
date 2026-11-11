import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardColumn } from "@/features/projects/BoardColumn";
import type { BoardColumnModel } from "@/features/projects/board-model";
import { TINT_FADE_MS } from "@/features/projects/drag/drag-model";

const EMPTY: BoardColumnModel = {
  id: "todo",
  label: "To do",
  color: null,
  items: [],
};

const NO_SELECTION: ReadonlySet<string> = new Set();

describe("the board column's drop-target tint", () => {
  it("transitions the background only, for TINT_FADE_MS, and not under reduced motion", () => {
    const { container } = render(
      <BoardColumn
        column={EMPTY}
        columnIndex={0}
        activeIndex={null}
        activeItemId={null}
        cursorItemId={null}
        selectedIds={NO_SELECTION}
        selectionSize={0}
        busyItemId={null}
        peekItemId={null}
        tabStopIndex={null}
        focusNonce={0}
        repoSlug="o/r"
        ghHost={null}
        chipFields={[]}
        onCardFocus={vi.fn()}
        onPeekChange={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const section = container.querySelector("section");
    if (section === null) throw new Error("no column section");
    expect(
      [...section.classList].filter((t) => /(^|:)transition/.test(t)),
    ).toEqual([
      "transition-[background-color]",
      "motion-reduce:transition-none",
    ]);
    expect(section.style.transitionDuration).toBe(`${TINT_FADE_MS}ms`);
  });
});
