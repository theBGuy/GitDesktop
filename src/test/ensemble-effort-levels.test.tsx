import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Isolation } from "@/features/sessions/AgentPickers";
import {
  type EnsembleArm,
  EnsembleRunDialog,
} from "@/features/sessions/EnsembleRunDialog";
import { type EffortSupport, listAgentEffortLevels } from "@/lib/ai/agent";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  listAgentEffortLevels: vi.fn(),
  listAgentModels: vi.fn(async () => []),
}));

const listMock = vi.mocked(listAgentEffortLevels);
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

function setup(isolation: Isolation | null, seed: EnsembleArm) {
  const onRun = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EnsembleRunDialog
        open
        onOpenChange={() => undefined}
        seed={seed}
        estimate={{ perSession: null, sampleSize: 0 }}
        isolation={isolation}
        onRun={onRun}
      />
    </QueryClientProvider>,
  );
  return { onRun, user: userEvent.setup() };
}

// `hidden`: an open model popup marks the rest of the dialog aria-hidden.
const pickers = () =>
  screen.getAllByRole("combobox", { name: "Reasoning effort", hidden: true });
const OPENCODE: EnsembleArm = {
  agent: "opencode",
  model: "m1",
  effort: "xhigh",
};

beforeEach(() => listMock.mockReset());

describe("Best-of-N per-arm effort", () => {
  it("identical arms share one call carrying the dialog's isolation", async () => {
    listMock.mockResolvedValue(maxBlocked);
    setup("container", OPENCODE);
    await waitFor(() =>
      expect(pickers()[0]).toHaveAttribute("aria-describedby"),
    );
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({
      kind: "opencode",
      binPath: null,
      model: "m1",
      isolation: "container",
    });
  });

  it("each arm's line renders under its row and describes its picker; Run keeps blocked efforts", async () => {
    listMock.mockResolvedValue(maxBlocked);
    const { onRun, user } = setup("worktree", OPENCODE);
    await waitFor(() =>
      expect(pickers()[1]).toHaveAttribute("aria-describedby"),
    );
    for (const picker of pickers()) {
      expect(picker).toHaveTextContent("Max (unavailable)");
      const row = picker.closest("[data-confirm-row]");
      const id = picker.getAttribute("aria-describedby") ?? "";
      expect(row?.querySelector(`[id="${id}"]`)).toHaveTextContent(
        `Max: ${REASON}`,
      );
    }
    await user.click(screen.getByRole("button", { name: "Run 2 agents" }));
    expect(onRun).toHaveBeenCalledWith([
      { agent: "opencode", model: "m1", effort: "xhigh" },
      { agent: "opencode", model: "m1", effort: "xhigh" },
    ]);
  });

  it("changing one arm's model asks for that model and leaves the other arm alone", async () => {
    listMock.mockImplementation((args) =>
      Promise.resolve(
        args?.model === "m1"
          ? maxBlocked
          : { perModel: false, levels: [], reason: null },
      ),
    );
    const { user } = setup("worktree", OPENCODE);
    await waitFor(() =>
      expect(pickers()[1]).toHaveAttribute("aria-describedby"),
    );
    const rows = screen.getAllByRole("combobox", { name: "Agent model" });
    await user.type(rows[1], "x");
    // Close the model popup (the dialog stays open: onOpenChange is a no-op).
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: "m1x" }),
      ),
    );
    await waitFor(() =>
      expect(pickers()[1]).not.toHaveAttribute("aria-describedby"),
    );
    expect(pickers()[0]).toHaveTextContent("Max (unavailable)");
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("removing an arm leaves the others' lines with their arms", async () => {
    const blockedFor = (model: string, level: string): EffortSupport => ({
      perModel: true,
      levels: LEVELS.map((l) =>
        l === level
          ? { level: l, variant: null, reason: `${model} lacks it.` }
          : { level: l, variant: l, reason: null },
      ),
      reason: null,
    });
    const answers: Partial<Record<string, EffortSupport>> = {
      m1a: blockedFor("m1a", "low"),
      m1b: blockedFor("m1b", "high"),
    };
    listMock.mockImplementation((args) =>
      Promise.resolve(answers[args?.model ?? ""] ?? maxBlocked),
    );
    const { user } = setup("worktree", OPENCODE);
    await user.click(screen.getByRole("button", { name: "Add arm" }));
    const models = () =>
      screen.getAllByRole("combobox", { name: "Agent model", hidden: true });
    for (const [i, suffix] of [
      [1, "a"],
      [2, "b"],
    ] as const) {
      await user.type(models()[i], suffix);
      await user.keyboard("{Escape}");
    }
    await waitFor(() =>
      expect(document.body).toHaveTextContent("High: m1b lacks it."),
    );
    await user.click(screen.getByRole("button", { name: "Remove arm 1" }));
    const expected = ["Low: m1a lacks it.", "High: m1b lacks it."];
    await waitFor(() => expect(pickers()).toHaveLength(2));
    for (const [i, picker] of pickers().entries()) {
      const row = picker.closest("[data-confirm-row]");
      const id = picker.getAttribute("aria-describedby") ?? "";
      expect(row?.querySelector(`[id="${id}"]`)).toHaveTextContent(expected[i]);
    }
    expect(screen.queryByText(`Max: ${REASON}`)).toBeNull();
  });

  it("an arm on Claude shows today's picker", async () => {
    listMock.mockResolvedValue({ perModel: false, levels: [], reason: null });
    setup("worktree", { agent: "claude", model: "", effort: "" });
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    for (const picker of pickers()) {
      expect(picker).not.toHaveAttribute("aria-describedby");
      expect(within(picker).queryByText(/unavailable/)).toBeNull();
    }
  });

  it("an isolation not known yet asks nothing", async () => {
    listMock.mockResolvedValue(maxBlocked);
    setup(null, OPENCODE);
    await new Promise((r) => setTimeout(r, 350));
    expect(listMock).not.toHaveBeenCalled();
    for (const picker of pickers()) {
      expect(picker).not.toHaveAttribute("aria-describedby");
    }
  });

  it("an agent switch never asks with the previous agent's model", async () => {
    listMock.mockResolvedValue({ perModel: false, levels: [], reason: null });
    const { user: realUser } = setup("worktree", {
      agent: "claude",
      model: "c1",
      effort: "",
    });

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
