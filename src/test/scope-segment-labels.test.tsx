import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationPresetSwitcher } from "@/features/conversations/ConversationPresetSwitcher";

afterEach(cleanup);

const noop = () => undefined;

/** The Needs review segment, found by the accessible name it must keep in both
 *  arms of the scope row's compact layout; null when no button has that name. */
function needsReviewButton(container: HTMLElement): HTMLElement | null {
  return within(container).queryByRole("button", { name: "Needs review" });
}

function shortSpan(button: HTMLElement): Element | undefined {
  return [...button.querySelectorAll("span")].find(
    (s) => s.textContent === "Review",
  );
}

describe("scope segment labels", () => {
  it("keeps the Needs review name with an aria-hidden short label", () => {
    const { container } = render(
      <ConversationPresetSwitcher
        feature="pulls"
        preset="all"
        storedPreset="all"
        onPreset={noop}
        canFilterMine
        canGroupByReview
        probeReason={null}
      />,
    );
    const button = needsReviewButton(container);
    expect(button).not.toBeNull();
    const span = shortSpan(button as HTMLElement);
    expect(span?.getAttribute("aria-hidden")).toBe("true");
  });

  it("adds no short label to the issue segments", () => {
    const { container } = render(
      <ConversationPresetSwitcher
        feature="issues"
        preset="all"
        storedPreset="all"
        onPreset={noop}
        canFilterMine
        canGroupByReview
        probeReason={null}
      />,
    );
    expect(container.textContent).not.toContain("Review");
    expect(within(container).getAllByRole("button")).toHaveLength(2);
  });

  it("keeps the name while the forge check is waiting", () => {
    const { container } = render(
      <ConversationPresetSwitcher
        feature="pulls"
        preset="all"
        storedPreset="needs-review"
        onPreset={noop}
        canFilterMine={false}
        canGroupByReview={false}
        probeReason="Checking the forge"
      />,
    );
    const button = needsReviewButton(container);
    expect(button).not.toBeNull();
    expect(shortSpan(button as HTMLElement)?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("negative control: an exposed short label changes the name", () => {
    const { container } = render(
      <button type="button">
        <span>Needs review</span>
        <span>Review</span>
      </button>,
    );
    expect(needsReviewButton(container)).toBeNull();
  });
});
