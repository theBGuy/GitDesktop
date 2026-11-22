import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EffortPicker } from "@/features/sessions/AgentPickers";
import type { EffortControlState } from "@/lib/ai/effort-levels";

const REASON = "Not offered by m1 in opencode.";
const maxBlocked: EffortControlState = {
  allBlocked: false,
  blocked: { xhigh: REASON },
  line: { tone: "muted", text: `Max: ${REASON}` },
};
const allHeld: EffortControlState = {
  allBlocked: true,
  blocked: {
    "": REASON,
    low: REASON,
    medium: REASON,
    high: REASON,
    xhigh: REASON,
  },
  line: { tone: "muted", text: REASON },
};

function setup(
  value: string,
  control?: EffortControlState,
  describedBy?: string,
) {
  const onChange = vi.fn();
  render(
    <>
      <EffortPicker
        value={value}
        onChange={onChange}
        control={control}
        describedBy={describedBy}
      />
      {describedBy && <p id={describedBy}>line</p>}
    </>,
  );
  const trigger = screen.getByRole("combobox", { name: "Reasoning effort" });
  return { onChange, trigger, user: userEvent.setup() };
}

describe("EffortPicker with a control", () => {
  it("a blocked level is a disabled (unavailable) option that never commits", async () => {
    const { onChange, trigger, user } = setup("", maxBlocked, "note");
    await user.click(trigger);
    const max = await screen.findByRole("option", {
      name: "Max (unavailable)",
    });
    expect(max).toHaveAttribute("aria-disabled", "true");
    await user.hover(max);
    // The highlight rests on the blocked row before each commit attempt.
    expect(max).toHaveAttribute("data-highlighted");
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    await user.click(max);
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("option", { name: "Low" }));
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("a stored blocked level reads (unavailable) closed and is kept", () => {
    const { onChange, trigger } = setup("xhigh", maxBlocked, "note");
    expect(trigger).toHaveTextContent("Max (unavailable)");
    expect(trigger).toHaveAttribute("aria-describedby", "note");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closed-trigger typeahead reaches Max when nothing is blocked", async () => {
    const { onChange, trigger, user } = setup("medium");
    trigger.focus();
    await user.keyboard("m");
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  // Steers at the blocked level: from Medium, the next "m" match is Max. No
  // negative control for the guard itself: the vendored Select's typeahead
  // already skips disabled rows, so removing the guard stays green.
  it("closed-trigger typeahead never commits a blocked level", async () => {
    const { onChange, trigger, user } = setup("medium", maxBlocked, "note");
    trigger.focus();
    await user.keyboard("m");
    expect(onChange).not.toHaveBeenCalledWith("xhigh");
  });

  it("all blocked with the no-level value: held, reachable, unmarked", async () => {
    const { onChange, trigger, user } = setup("", allHeld, "note");
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).not.toHaveAttribute("title");
    expect(trigger).toHaveAttribute("aria-describedby", "note");
    // The trailing glyph is the Select icon.
    expect(trigger.textContent?.replace(/\W+$/, "")).toBe("Default");
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("all blocked with a level stored reads it as unavailable", () => {
    const { trigger } = setup("high", allHeld, "note");
    expect(trigger).toHaveTextContent("High (unavailable)");
  });

  it("without a control it is today's picker", async () => {
    const { trigger, user } = setup("");
    expect(trigger).not.toHaveAttribute("aria-describedby");
    await user.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
      "Max",
    ]);
    for (const o of options) expect(o).not.toHaveAttribute("aria-disabled");
  });
});
