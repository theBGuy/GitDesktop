import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PunchCard } from "@/features/repository/insights/PunchCard";
import { ComposerOptions } from "@/features/sessions/AgentPickers";
import { unmockedCommands } from "./setup";

// Go back and Go forward default to Alt+Left / Alt+Right, and the window
// listener skips an event a component already consumed, so a bare-arrow handler
// outside a modal must leave chorded arrows alone. Consumption is read where
// the window listener would read it: `defaultPrevented` after the component's
// handlers ran, or `fireEvent`'s return value (false once a handler prevented).

const CHORD_MODIFIERS = ["Alt", "Control", "Meta"];
const HORIZONTAL = ["ArrowLeft", "ArrowRight"];

/** Presses every chord modifier with each horizontal arrow on the focused
 *  element and returns whether any press arrived default-prevented. */
async function anyChordConsumed(): Promise<boolean> {
  const consumed: boolean[] = [];
  const record = (e: KeyboardEvent) => {
    if (HORIZONTAL.includes(e.key)) consumed.push(e.defaultPrevented);
  };
  document.addEventListener("keydown", record);
  try {
    for (const key of HORIZONTAL) {
      for (const mod of CHORD_MODIFIERS) {
        await userEvent.keyboard(`{${mod}>}{${key}}{/${mod}}`);
      }
    }
  } finally {
    document.removeEventListener("keydown", record);
  }
  expect(consumed).toHaveLength(HORIZONTAL.length * CHORD_MODIFIERS.length);
  return consumed.some(Boolean);
}

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("PunchCard", () => {
  function renderCard() {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    grid[3][9] = 4;
    render(<PunchCard grid={grid} />);
    return screen.getByRole("gridcell", { name: /^Sun 12am/ });
  }

  it("passes a chorded horizontal arrow through", async () => {
    const cell = renderCard();
    cell.focus();
    expect(await anyChordConsumed()).toBe(false);
    expect(document.activeElement).toBe(cell);
    // The live caption still names the focused cell: nothing stepped.
    expect(document.querySelector("figcaption")?.textContent).toMatch(
      /^Sun 12am/,
    );
  });

  it("still steps on a bare arrow", () => {
    const cell = renderCard();
    cell.focus();
    expect(fireEvent.keyDown(cell, { key: "ArrowRight" })).toBe(false);
    expect(document.activeElement?.getAttribute("data-cell")).toBe("0-1");
  });
});

describe("the composer's segmented control", () => {
  async function renderOptions() {
    const onMode = vi.fn();
    render(<ComposerOptions mode="single" onMode={onMode} />);
    await userEvent.click(screen.getByRole("button", { name: "Run options" }));
    const radio = await screen.findByRole("radio", { name: "Single" });
    return { onMode, radio };
  }

  it("passes a chorded horizontal arrow through", async () => {
    const { onMode, radio } = await renderOptions();
    radio.focus();
    expect(await anyChordConsumed()).toBe(false);
    expect(onMode).not.toHaveBeenCalled();
  });

  it("still moves the selection on a bare arrow", async () => {
    const { onMode, radio } = await renderOptions();
    expect(fireEvent.keyDown(radio, { key: "ArrowRight" })).toBe(false);
    expect(onMode).toHaveBeenCalledWith("ensemble");
  });
});
