import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerOptions,
  type Isolation,
} from "@/features/sessions/AgentPickers";
import { type EffortSupport, listAgentEffortLevels } from "@/lib/ai/agent";
import { EFFORT_DEFAULT_USED } from "@/lib/ai/effort-levels";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  listAgentEffortLevels: vi.fn(),
}));

const listMock = vi.mocked(listAgentEffortLevels);
const LEVELS = ["low", "medium", "high", "xhigh"] as const;
const LEVEL_REASON = "Not offered by m1 in opencode.";
const NONE_REASON =
  "openrouter/some-provider/an-extremely-long-model-identifier-v2 has no effort settings in opencode.";
const NOT_FOUND =
  "opencode CLI not found. Install it or set its path in Settings.";

function answer(blocked: readonly string[], reason: string): EffortSupport {
  const none = blocked.length === LEVELS.length;
  return {
    perModel: true,
    levels: LEVELS.map((level) =>
      blocked.includes(level)
        ? { level, variant: null, reason }
        : { level, variant: level, reason: null },
    ),
    reason: none ? reason : null,
  };
}

type Props = {
  effort: string;
  model?: string;
  withEffortFor?: boolean;
  isolation?: Isolation | null;
};

function setup(initial: Props) {
  const client = new QueryClient();
  const onEffort = vi.fn();
  const ui = ({
    effort,
    model = "m1",
    withEffortFor = true,
    isolation = "worktree",
  }: Props) => (
    <QueryClientProvider client={client}>
      <ComposerOptions
        effort={effort}
        onEffort={onEffort}
        effortFor={
          withEffortFor ? { agent: "opencode", model, isolation } : undefined
        }
      />
    </QueryClientProvider>
  );
  const view = render(ui(initial));
  return { onEffort, rerender: (p: Props) => view.rerender(ui(p)) };
}

const radio = (name: string) => screen.getByRole("radio", { name });
const radios = () => screen.getAllByRole("radio");
const group = () =>
  screen.getByRole("radiogroup", { name: "Reasoning effort" });
const lineFor = (text: string) => {
  const p = screen.getByText(text).closest("p");
  if (!p) throw new Error("no line");
  return p;
};

async function openOptions(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Run options" }));
  return user;
}

beforeEach(() => {
  listMock.mockReset();
  unmockedCommands.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  expect(unmockedCommands).toEqual([]);
});

describe("ComposerOptions per-model effort", () => {
  it("asks only once the popover opens, with what the run passes", async () => {
    listMock.mockResolvedValue({ perModel: false, levels: [], reason: null });
    setup({ effort: "" });
    expect(listMock).not.toHaveBeenCalled();
    await openOptions();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(listMock).toHaveBeenCalledWith({
      kind: "opencode",
      binPath: null,
      model: "m1",
      isolation: "worktree",
    });
    expect(radios()).toHaveLength(5);
    for (const r of radios()) expect(r).not.toHaveAttribute("aria-disabled");
    expect(group()).not.toHaveAttribute("aria-describedby");
  });

  it("never asks without effortFor", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], LEVEL_REASON));
    setup({ effort: "", withEffortFor: false });
    await openOptions();
    expect(radios()).toHaveLength(5);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("an isolation resolving under the open popover keeps the same radiogroup and its focus", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], LEVEL_REASON));
    const { rerender } = setup({ effort: "high", isolation: null });
    await openOptions();
    const before = group();
    radio("High").focus();
    await new Promise((r) => setTimeout(r, 350));
    expect(listMock).not.toHaveBeenCalled();
    rerender({ effort: "high", isolation: "worktree" });
    await screen.findByRole("radio", { name: "Max (unavailable)" });
    expect(group()).toBe(before);
    expect(radio("High")).toHaveFocus();
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ isolation: "worktree" }),
    );
  });

  it("a blocked level is marked, inert, described by a hidden reason, and skipped by arrows", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], LEVEL_REASON));
    const { onEffort, rerender } = setup({ effort: "high" });
    const user = await openOptions();
    const max = await screen.findByRole("radio", { name: "Max (unavailable)" });
    expect(max).toHaveAttribute("aria-disabled", "true");
    await user.click(max);
    max.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onEffort).not.toHaveBeenCalled();
    const reasonNode = document.getElementById(
      max.getAttribute("aria-describedby") ?? "",
    );
    expect(reasonNode).toHaveAttribute("hidden");
    expect(reasonNode).toHaveTextContent(LEVEL_REASON);
    const line = lineFor(`Max: ${LEVEL_REASON}`);
    expect(group()).toHaveAttribute("aria-describedby", line.id);

    radio("High").focus();
    await user.keyboard("{ArrowRight}");
    expect(onEffort).toHaveBeenLastCalledWith("");
    expect(radio("Auto")).toHaveFocus();
    rerender({ effort: "" });
    await user.keyboard("{ArrowLeft}");
    expect(onEffort).toHaveBeenLastCalledWith("high");
    expect(radio("High")).toHaveFocus();
  });

  it("a blocked stored level stays checked and the tab stop; the line says it isn't sent", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], LEVEL_REASON));
    const { onEffort } = setup({ effort: "xhigh" });
    const user = await openOptions();
    const max = await screen.findByRole("radio", { name: "Max (unavailable)" });
    expect(max).toHaveAttribute("aria-checked", "true");
    expect(max).toHaveAttribute("tabindex", "0");
    // A real Tab press lands on it: the group's one tab stop.
    for (let i = 0; i < 4 && !max.matches(":focus"); i++) await user.tab();
    expect(max).toHaveFocus();
    expect(
      screen.getByText(`Max: ${LEVEL_REASON} ${EFFORT_DEFAULT_USED}`),
    ).toBeInTheDocument();
    expect(onEffort).not.toHaveBeenCalled();
  });

  it("none selectable holds the group; only the four levels are marked", async () => {
    listMock.mockResolvedValue(answer(LEVELS, NONE_REASON));
    const { onEffort } = setup({ effort: "" });
    const user = await openOptions();
    await screen.findByRole("radio", { name: "Low (unavailable)" });
    for (const r of radios()) {
      expect(r).toHaveAttribute("aria-disabled", "true");
      expect(r).not.toHaveAttribute("aria-describedby");
    }
    for (const name of ["Low", "Medium", "High", "Max"]) {
      expect(radio(`${name} (unavailable)`)).toBeInTheDocument();
    }
    expect(radio("Auto")).toHaveAccessibleName("Auto");
    expect(group()).toHaveAttribute("aria-disabled", "true");
    expect(group()).toHaveAttribute(
      "aria-describedby",
      lineFor(NONE_REASON).id,
    );
    radio("Auto").focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}");
    expect(onEffort).not.toHaveBeenCalled();
  });

  it("a call that never settles leaves today's control", async () => {
    listMock.mockReturnValue(new Promise(() => undefined));
    setup({ effort: "high" });
    await openOptions();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    for (const r of radios()) expect(r).not.toHaveAttribute("aria-disabled");
    expect(group()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("a rejection holds all, its summary is the line, with no suffix", async () => {
    listMock.mockRejectedValue({ kind: "command", message: NOT_FOUND });
    setup({ effort: "high" });
    await openOptions();
    await screen.findByRole("radio", { name: "Max (unavailable)" });
    for (const r of radios())
      expect(r).toHaveAttribute("aria-disabled", "true");
    expect(radio("Auto")).toHaveAccessibleName("Auto");
    const line = group().getAttribute("aria-describedby");
    const text = document.getElementById(line ?? "")?.textContent ?? "";
    expect(text).toContain(NOT_FOUND);
    expect(text).not.toContain(EFFORT_DEFAULT_USED);
  });

  it("an answer for another model never renders", async () => {
    listMock.mockImplementation(({ model }) =>
      model === "m1"
        ? Promise.resolve(answer(["xhigh"], LEVEL_REASON))
        : new Promise(() => undefined),
    );
    const { rerender } = setup({ effort: "" });
    await openOptions();
    await screen.findByRole("radio", { name: "Max (unavailable)" });
    rerender({ effort: "", model: "m2" });
    expect(radio("Max")).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(`Max: ${LEVEL_REASON}`)).toBeNull();
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: "m2" }),
      ),
    );
    expect(radio("Max")).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(`Max: ${LEVEL_REASON}`)).toBeNull();
  });

  it("three quick model edits make one call, for the last model", async () => {
    listMock.mockResolvedValue(answer(["xhigh"], LEVEL_REASON));
    const { rerender } = setup({ effort: "" });
    await openOptions();
    await screen.findByRole("radio", { name: "Max (unavailable)" });
    expect(listMock).toHaveBeenCalledTimes(1);
    // The debounce timers start after the switch, so they run on fake time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const model of ["a", "ab", "abc"]) {
      rerender({ effort: "", model });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      // Unsettled: today's control.
      expect(radio("Max")).not.toHaveAttribute("aria-disabled");
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "abc" }),
    );
  });
});
