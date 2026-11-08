import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fmt } from "@/features/repository/insights/primitives";
import {
  StarHistoryCard,
  StarTooltipRow,
} from "@/features/repository/insights/StarHistoryCard";
import { starCardState } from "@/features/repository/insights/star-history";
import { unmockedCommands } from "./setup";

afterAll(() => expect(unmockedCommands).toEqual([]));

const WEEK = 7 * 86_400;
/** Sunday 1 November 2026, 00:00 UTC. */
const NEWEST = Date.UTC(2026, 10, 1) / 1000;

/** Page 1 of 5 loaded and the read in error: the window draws its 30 weeks
 *  under the partial line and its Retry. */
function partialState(isFetching: boolean) {
  const weeks = Array.from({ length: 30 }, (_, i) => ({
    week: NEWEST - i * WEEK,
    total: 1,
  }));
  return starCardState(
    {
      data: {
        pages: [
          {
            available: true,
            weeks,
            nextPage: 2,
            lastPage: 5,
            stargazersCount: 140,
          },
        ],
      },
      hasNextPage: true,
      isError: true,
      isPaused: false,
      isFetching,
    },
    false,
    false,
    false,
  );
}

function renderCard(isFetching: boolean) {
  const onRetry = vi.fn();
  const state = partialState(isFetching);
  render(<StarHistoryCard state={state} onRetry={onRetry} retryRef={null} />);
  const retry = screen.getByRole("button", {
    name: "Retry loading older weeks",
  });
  return { onRetry, retry, state };
}

describe("StarHistoryCard's partial-line Retry", () => {
  it("a held Retry takes no press, by key or click", async () => {
    const user = userEvent.setup();
    const { onRetry, retry, state } = renderCard(true);
    expect(state.retryHeld).toBe(true);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    retry.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    retry.click();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("control: an unheld Retry runs once per press", async () => {
    const user = userEvent.setup();
    const { onRetry, retry, state } = renderCard(false);
    expect(state.retryHeld).toBe(false);
    expect(retry.hasAttribute("aria-disabled")).toBe(false);
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("StarTooltipRow", () => {
  const point = { week: NEWEST, total: 160, stars: 1234 };

  it("spaces its words in the text, in both modes", () => {
    const { container, rerender } = render(
      <StarTooltipRow mode="gains" point={point} />,
    );
    expect(container.textContent).toBe("New stars: +160 that week");
    rerender(<StarTooltipRow mode="cumulative" point={point} />);
    expect(container.textContent).toBe(`Stars: ${fmt(1234)} · +160 that week`);
  });
});
