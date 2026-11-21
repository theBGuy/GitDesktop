import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewEffortField } from "@/features/settings/ReviewEffortField";
import { type EffortSupport, listAgentEffortLevels } from "@/lib/ai/agent";
import {
  EFFORT_DEFAULT_USED,
  type ReviewEffortTarget,
} from "@/lib/ai/effort-levels";
import type { ReviewEffort } from "@/lib/ai/review-effort";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  listAgentEffortLevels: vi.fn(),
}));

const listMock = vi.mocked(listAgentEffortLevels);
const LEVELS = ["low", "medium", "high", "xhigh"] as const;
const REASON = "Not offered by m1 in opencode.";
const NONE = "m1 has no effort settings in opencode.";

function answer(blocked: readonly string[], reason: string): EffortSupport {
  return {
    perModel: true,
    levels: LEVELS.map((level) =>
      blocked.includes(level)
        ? { level, variant: null, reason }
        : { level, variant: level, reason: null },
    ),
    reason: blocked.length === LEVELS.length ? reason : null,
  };
}

const target = (
  label: ReviewEffortTarget["label"],
  model: string,
): ReviewEffortTarget => ({
  label,
  inputs: { kind: "opencode", binPath: "/opt/oc", model, isolation: null },
});

function setup(value: ReviewEffort, targets: ReviewEffortTarget[]) {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReviewEffortField value={value} onChange={onChange} targets={targets} />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole("combobox", { name: "Review effort" });
  return { onChange, trigger, user: userEvent.setup() };
}

const describedText = (el: HTMLElement) =>
  document.getElementById(el.getAttribute("aria-describedby") ?? "")
    ?.textContent ?? null;

beforeEach(() => listMock.mockReset());

describe("ReviewEffortField", () => {
  it("one target asks once with its inputs as given; no line, no description", async () => {
    listMock.mockResolvedValue(answer([], REASON));
    const { trigger } = setup("auto", [target("Reviews", "m1")]);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(listMock).toHaveBeenCalledWith({
      kind: "opencode",
      binPath: "/opt/oc",
      model: "m1",
      isolation: null,
    });
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });

  it("a blocked stored level is kept, marked, and the line says it isn't sent", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], REASON));
    const { trigger, onChange } = setup("xhigh", [target("Reviews", "m1")]);
    await waitFor(() => expect(trigger).toHaveTextContent("Max (unavailable)"));
    expect(describedText(trigger)).toBe(
      `Max: ${REASON} ${EFFORT_DEFAULT_USED}`,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a blocked option cannot be committed from the open popup", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], REASON));
    const { trigger, onChange, user } = setup("auto", [
      target("Reviews", "m1"),
    ]);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-describedby"));
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
  });

  it("all blocked: held, reachable, described, the no-level label unmarked", async () => {
    listMock.mockResolvedValue(answer(LEVELS, NONE));
    const { trigger, onChange, user } = setup("auto", [
      target("Reviews", "m1"),
    ]);
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-disabled", "true"),
    );
    expect(trigger).not.toHaveAttribute("title");
    expect(describedText(trigger)).toBe(NONE);
    // The trailing glyph is the Select icon.
    expect(trigger.textContent?.replace(/\W+$/, "")).toBe(
      "Default — the CLI's own setting",
    );
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("two targets ask twice and combine: labelled line, one-sided block stays selectable", async () => {
    listMock.mockImplementation((args) =>
      Promise.resolve(
        args?.model === "m2" ? answer(["xhigh"], REASON) : answer([], REASON),
      ),
    );
    const { trigger, user } = setup("auto", [
      target("Reviews", "m1"),
      target("Security audits", "m2"),
    ]);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock.mock.calls.map((c) => c[0]?.model).sort()).toEqual([
      "m1",
      "m2",
    ]);
    await waitFor(() =>
      expect(describedText(trigger)).toBe(`Security audits: Max: ${REASON}`),
    );
    await user.click(trigger);
    const max = await screen.findByRole("option", { name: "Max" });
    expect(max).not.toHaveAttribute("aria-disabled");
  });

  it("no target is today's control and asks nothing", async () => {
    setup("auto", []);
    await new Promise((r) => setTimeout(r, 350));
    expect(listMock).not.toHaveBeenCalled();
  });
});
