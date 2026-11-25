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
  onTestFinished,
  vi,
} from "vitest";
import { type PlanSeed, usePlanStore } from "@/features/plan/store";
import { ResearchView } from "@/features/research/ResearchView";
import {
  assembleSessionReport,
  clearResearchFollowUpDraft,
  type ResearchDepth,
  type ResearchRun,
  researchFollowUpDraft,
  setResearchFollowUpDraft,
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
  // A stand-in that shows its value and picks "sonnet" on press.
  ModelPicker: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (model: string) => void;
  }) => (
    <button type="button" aria-label="Model" onClick={() => onChange("sonnet")}>
      {value || "default"}
    </button>
  ),
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
  clearResearchFollowUpDraft("a");
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
    // Held, never taken out of the tab order.
    expect(distilling.tabIndex).toBe(0);
    expect(opening.tabIndex).toBe(0);
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

describe("research canvas: the follow-up draft", () => {
  const box = () =>
    screen.getByRole("textbox", { name: "Continue the research" });

  it("(B1) survives the composer unmounting and comes back on remount", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await user.type(box(), "keep me");
    view.unmount();
    renderView();
    expect(box()).toHaveValue("keep me");
  });

  it("(B2) a sent follow-up clears the box and the stored draft", async () => {
    const sent = vi.fn();
    const { sendFollowUp } = useResearchStore.getState();
    useResearchStore.setState({ sendFollowUp: sent });
    onTestFinished(() => useResearchStore.setState({ sendFollowUp }));
    const user = userEvent.setup();
    const view = renderView();
    await user.type(box(), "dig deeper");
    await user.keyboard("{Enter}");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(box()).toHaveValue("");
    expect(researchFollowUpDraft("a")).toBeUndefined();
    view.unmount();
    renderView();
    expect(box()).toHaveValue("");
  });

  it("(B3) Dismiss drops the run's draft", async () => {
    setResearchFollowUpDraft("a", { text: "left over", depth: "brainstorm" });
    act(() => useResearchStore.getState().remove("a"));
    expect(researchFollowUpDraft("a")).toBeUndefined();
  });

  it("(B4) a follow-up held by the distill is back after the handoff", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await user.click(button("Turn into a Plan"));
    await user.type(box(), "after the plan");
    await user.keyboard("{Enter}");
    expect(box()).toHaveValue("after the plan");
    await act(async () => runs[0].settle());
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    // The handoff left the run; coming back to it mounts a new composer.
    view.unmount();
    act(() => useResearchStore.getState().setActiveResearch("a"));
    renderView();
    expect(box()).toHaveValue("after the plan");
    expect(runs).toHaveLength(1);
  });

  const persona = () =>
    screen.getByRole("combobox", { name: "Research intent" });

  async function pickBrainstormAndSonnet(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.click(persona());
    await user.click(await screen.findByRole("option", { name: "Brainstorm" }));
    await waitFor(() => expect(persona()).toHaveTextContent("Brainstorm"));
    await user.click(button("Model"));
    expect(button("Model")).toHaveTextContent("sonnet");
  }

  it("(B5) the persona and model picks come back with the text", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await pickBrainstormAndSonnet(user);
    await user.type(box(), "with picks");
    view.unmount();
    renderView();
    expect(box()).toHaveValue("with picks");
    expect(persona()).toHaveTextContent("Brainstorm");
    expect(button("Model")).toHaveTextContent("sonnet");
  });

  it("(B6) Send drops the draft and the run carries the picks", async () => {
    // Mirrors the real action's run update (it stores this turn's depth and model)
    // without starting a turn.
    const sent = vi.fn(
      (id: string, _text: string, depth: ResearchDepth, model: string) =>
        useResearchStore.setState((s) => ({
          runs: s.runs.map((r) => (r.id === id ? { ...r, depth, model } : r)),
        })),
    );
    const { sendFollowUp } = useResearchStore.getState();
    useResearchStore.setState({ sendFollowUp: sent });
    onTestFinished(() => useResearchStore.setState({ sendFollowUp }));
    const user = userEvent.setup();
    const view = renderView();
    await pickBrainstormAndSonnet(user);
    await user.type(box(), "go");
    await user.keyboard("{Enter}");
    expect(sent).toHaveBeenCalledWith("a", "go", "brainstorm", "sonnet");
    expect(researchFollowUpDraft("a")).toBeUndefined();
    view.unmount();
    renderView();
    // No draft is left, so the pickers seed from the run's new values.
    expect(box()).toHaveValue("");
    expect(persona()).toHaveTextContent("Brainstorm");
    expect(button("Model")).toHaveTextContent("sonnet");
  });
});
