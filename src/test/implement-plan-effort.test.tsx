import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImplementPlanButton } from "@/features/plan/ImplementPlanButton";
import type { PlanRun } from "@/features/plan/store";
import { useSessionsStore } from "@/features/sessions/store";
import { type EffortSupport, listAgentEffortLevels } from "@/lib/ai/agent";
import { useSettings } from "@/lib/settings/queries";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  listAgentEffortLevels: vi.fn(),
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: vi.fn(),
}));

const listMock = vi.mocked(listAgentEffortLevels);
const settingsMock = vi.mocked(useSettings);
const LEVELS = ["low", "medium", "high", "xhigh"] as const;
const REASON = "Not offered by m1 in opencode.";
const maxBlocked: EffortSupport = {
  perModel: true,
  levels: LEVELS.map((level) =>
    level === "xhigh"
      ? { level, variant: null, reason: REASON }
      : { level, variant: level, reason: null },
  ),
  reason: null,
};

const run = {
  id: "plan-1",
  repoPath: "C:/repos/demo",
  agent: "opencode",
  model: "m1",
  effort: "xhigh",
  draft: { title: "Do it", body: "Steps" },
  segments: [],
} as unknown as PlanRun;

function setup(data: unknown, planRun: PlanRun = run) {
  settingsMock.mockReturnValue({ data } as ReturnType<typeof useSettings>);
  const start = vi.fn(async () => null);
  useSessionsStore.setState({ start } as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImplementPlanButton run={planRun} />
    </QueryClientProvider>,
  );
  return { start, user: userEvent.setup() };
}

const open = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Implement" }));

beforeEach(() => listMock.mockReset());

describe("Implement popover effort", () => {
  it("asks nothing while closed, nor before settings resolve", async () => {
    listMock.mockResolvedValue(maxBlocked);
    const { user } = setup(undefined);
    await new Promise((r) => setTimeout(r, 350));
    expect(listMock).not.toHaveBeenCalled();
    await open(user);
    await new Promise((r) => setTimeout(r, 350));
    expect(listMock).not.toHaveBeenCalled();
  });

  it("asks nothing while closed with settings resolved, then asks on open", async () => {
    listMock.mockResolvedValue(maxBlocked);
    const { user } = setup({ agentIsolation: "worktree" });
    await new Promise((r) => setTimeout(r, 350));
    expect(listMock).not.toHaveBeenCalled();
    await open(user);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
  });

  it("an answer with no line leaves the picker undescribed", async () => {
    listMock.mockResolvedValue({ perModel: false, levels: [], reason: null });
    const { user } = setup({ agentIsolation: "worktree" });
    await open(user);
    const picker = await screen.findByRole("combobox", {
      name: "Reasoning effort",
    });
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    // Let the answer land before reading the attribute.
    await new Promise((r) => setTimeout(r, 50));
    expect(picker).not.toHaveAttribute("aria-describedby");
  });

  it("asks with the Settings isolation; the line describes the picker; Start keeps the effort", async () => {
    listMock.mockResolvedValue(maxBlocked);
    const { start, user } = setup({ agentIsolation: "container" });
    await open(user);
    const picker = await screen.findByRole("combobox", {
      name: "Reasoning effort",
    });
    await waitFor(() => expect(picker).toHaveTextContent("Max (unavailable)"));
    expect(listMock).toHaveBeenCalledWith({
      kind: "opencode",
      binPath: null,
      model: "m1",
      isolation: "container",
    });
    const line = document.getElementById(
      picker.getAttribute("aria-describedby") ?? "",
    );
    expect(line).toHaveTextContent(`Max: ${REASON}`);
    const startButton = screen.getByRole("button", { name: "Start session" });
    // The line sits between the pickers and Start session.
    expect(
      picker.compareDocumentPosition(line as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (line as Node).compareDocumentPosition(startButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(startButton);
    expect(start).toHaveBeenCalledWith(
      "C:/repos/demo",
      expect.any(String),
      "m1",
      "opencode",
      "xhigh",
    );
  });

  it("an agent switch never asks with the previous agent's model", async () => {
    listMock.mockResolvedValue({ perModel: false, levels: [], reason: null });
    const { user: realUser } = setup({ agentIsolation: "worktree" }, {
      ...run,
      agent: "claude",
      model: "c1",
    } as PlanRun);
    await open(realUser);
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "claude", model: "c1" }),
      ),
    );
    await realUser.click(screen.getAllByRole("combobox", { name: "Agent" })[0]);
    const option = await screen.findByRole("option", { name: "opencode" });
    // The switch sets the kind and clears the model in one render. Real timers:
    // user-event and the Select popup stall under fake ones, and a mixed-key
    // call would be issued at the switch render itself, before any settle.
    await realUser.click(option);
    const mixed = () =>
      listMock.mock.calls.filter(
        ([args]) => args?.kind === "opencode" && args.model === "c1",
      );
    expect(mixed()).toEqual([]);
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "opencode", model: "" }),
      ),
    );
    expect(mixed()).toEqual([]);
  });
});
