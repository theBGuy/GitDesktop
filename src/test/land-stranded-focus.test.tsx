import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { useLandStrandedFocus } from "@/features/pulls/use-land-stranded-focus";

// A popup shaped like Base UI's open Dialog (role="dialog" + data-open) holding
// the landing target, with a control beside it outside the popup.
function Host({
  open = true,
  besideDisabled = false,
  insideDisabled = false,
}: {
  open?: boolean;
  besideDisabled?: boolean;
  insideDisabled?: boolean;
}) {
  useLandStrandedFocus("land");
  return (
    <>
      <button type="button" disabled={besideDisabled}>
        Beside
      </button>
      <div role="dialog" data-open={open ? "" : undefined}>
        <input id="land" aria-label="Title" />
        <button type="button" disabled={insideDisabled}>
          Inside
        </button>
      </div>
    </>
  );
}

const title = () => screen.getByLabelText("Title");
const button = (name: string) => screen.getByRole("button", { name });

/** Applies the update and lets the observer's callback run. */
async function update(rerender: (ui: ReactElement) => void, ui: ReactElement) {
  await act(async () => rerender(ui));
}

describe("useLandStrandedFocus", () => {
  it("lands on the target when a focused control in the open popup goes disabled", async () => {
    const { rerender } = render(<Host />);
    button("Inside").focus();
    await update(rerender, <Host insideDisabled />);
    expect(document.activeElement).toBe(title());
  });

  it("leaves a control outside the popup alone when it goes disabled", async () => {
    const { rerender } = render(<Host />);
    button("Beside").focus();
    await update(rerender, <Host besideDisabled />);
    expect(document.activeElement).toBe(button("Beside"));
  });

  it("leaves focus alone when the same update closes the popup", async () => {
    const { rerender } = render(<Host />);
    button("Inside").focus();
    await update(rerender, <Host open={false} insideDisabled />);
    expect(document.activeElement).not.toBe(title());
  });
});
