import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { type PlanSeed, usePlanStore } from "@/features/plan/store";
import { ResearchView } from "@/features/research/ResearchView";
import {
  assembleSessionReport,
  type ResearchRun,
  useResearchStore,
} from "@/features/research/store";
import {
  type AgentSessionArgs,
  cancelAgentSession,
  type ReviewEvent,
  runAgentSession,
} from "@/lib/ai/agent";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: vi.fn(),
  cancelAgentSession: vi.fn(async () => undefined),
}));
vi.mock("@/features/research/persistence", () => ({
  loadPersistedResearch: vi.fn(async () => []),
  savePersistedResearch: vi.fn(async () => undefined),
}));
vi.mock("@/features/plan/persistence", () => ({
  loadPersistedPlans: vi.fn(async () => []),
  savePersistedPlans: vi.fn(async () => undefined),
}));
vi.mock("@/features/sessions/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/persistence")>()),
  loadPersistedSessions: vi.fn(async () => []),
}));
vi.mock("@/features/sessions/AgentPickers", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/sessions/AgentPickers")
  >()),
  ModelPicker: () => null,
}));

interface Run {
  args: AgentSessionArgs;
  settle: (v?: ReviewEvent | null) => void;
}

let runs: Run[] = [];

const RUN: ResearchRun = {
  id: "a",
  repoPath: "C:/repo",
  agent: "claude",
  model: "",
  effort: "",
  depth: "deep",
  sessionId: "sid-a",
  nativeSessionId: "native-a",
  origin: { topic: "Topic", depth: "deep" },
  seed: null,
  generating: false,
  stopped: false,
  text: "# Findings",
  status: "",
  segments: [],
  report: { title: "T", report: "# Findings\n\nThe cache is per repo." },
  costUsd: null,
  reportPath: null,
  error: null,
};

const find = () => useResearchStore.getState().runs.find((r) => r.id === "a");
const button = (name: string) => screen.getByRole("button", { name });

let seed: Mock<(s: PlanSeed | null) => void>;

function renderView() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ResearchView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  runs = [];
  unmockedCommands.length = 0;
  vi.mocked(cancelAgentSession).mockClear();
  vi.mocked(runAgentSession).mockImplementation(
    (args) =>
      new Promise<ReviewEvent | null>((resolve) => {
        runs.push({
          args,
          settle: (v: ReviewEvent | null = null) => resolve(v),
        });
      }),
  );
  seed = vi.fn<(s: PlanSeed | null) => void>();
  usePlanStore.setState({ setPendingPlanSeed: seed });
  useResearchStore.setState({ runs: [RUN], activeResearchId: "a" });
});

afterEach(async () => {
  // Settle any distill still running, so no test leaves a pending command.
  for (const r of runs) r.settle();
  await waitFor(() => expect(find()?.distilling ?? false).toBe(false));
  expect(unmockedCommands).toEqual([]);
});

describe("research canvas: the distill's stopping state", () => {
  it("(D7) Enter in the follow-up box while distilling keeps the text and sends nothing", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(button("Turn into a Plan"));
    expect(find()?.distilling).toBe(true);
    const box = screen.getByRole("textbox", { name: "Continue the research" });
    await user.type(box, "more");
    await user.keyboard("{Enter}");
    expect(box).toHaveValue("more");
    expect(runs.length).toBe(1);
    const send = button("Send");
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription(
      "Wait for the plan brief to finish",
    );
    await user.click(button("Stop"));
    expect(find()?.distillStopping).toBe(true);
    expect(button("Send")).toHaveAccessibleDescription(
      "Wait for the plan brief to stop",
    );
    expect(box).toHaveValue("more");
  });

  it("(D8a) the plan button stays focusable and explains itself while busy", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(button("Turn into a Plan"));
    const distilling = button("Distilling…");
    expect(distilling).toHaveAttribute("aria-disabled", "true");
    expect(distilling).toHaveAccessibleDescription(
      "Writing the plan brief from this research",
    );
    act(() => useResearchStore.getState().cancel("a"));
    const opening = button("Opening Plan…");
    expect(opening).toHaveAttribute("aria-disabled", "true");
    expect(opening).toHaveAccessibleDescription(
      "Plan gets the full report once the brief stops",
    );
  });

  it("(D8) Stop reads Stopping…, keeps focus, and hands focus to the plan button at settle", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(button("Turn into a Plan"));
    // The view keeps showing this run, but the selection now reads changed.
    act(() => useResearchStore.getState().setActiveResearch("a"));
    const stop = button("Stop");
    act(() => stop.focus());
    await user.keyboard("{Enter}");
    const stopping = button("Stopping…");
    expect(stopping).toBe(stop);
    expect(stopping).toHaveAttribute("aria-disabled", "true");
    expect(stopping).toHaveAccessibleDescription(
      "Stopping the plan brief; Plan gets the full report",
    );
    expect(document.activeElement).toBe(stopping);
    expect(button("Opening Plan…")).toBeInTheDocument();

    await act(async () => runs[0].settle());
    await waitFor(() => expect(find()?.distilling).toBe(false));
    expect(find()?.distillStopping).toBe(false);
    const plan = button("Turn into a Plan");
    expect(plan).not.toHaveAttribute("aria-disabled");
    expect(plan).toBeEnabled();
    expect(document.activeElement).toBe(plan);
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    const cur = find();
    if (!cur) throw new Error("run gone");
    expect(seed.mock.calls[0][0]?.issueBody).toBe(assembleSessionReport(cur));
    expect(useResearchStore.getState().activeResearchId).toBe("a");
  });
});
