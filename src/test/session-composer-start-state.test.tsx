import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TabPanel } from "@/features/repository/TabPanel";
import { SessionActivation } from "@/features/sessions/SessionActivation";
import { SessionComposer } from "@/features/sessions/SessionComposer";
import {
  type AgentSession,
  type PendingTask,
  useSessionsStore,
} from "@/features/sessions/store";
import type { ContainerStatus } from "@/lib/ai/sandbox";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The container probe, so a test can show the isolation note's Settings jump.
const probe = vi.hoisted(() => ({
  data: undefined as ContainerStatus | undefined,
}));
vi.mock("@/lib/ai/sandbox-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/sandbox-queries")>()),
  useContainerStatus: () => ({ data: probe.data, isError: false }),
}));

// jsdom implements no scrollIntoView; the composer's `/` menu calls it on its marked row.
Element.prototype.scrollIntoView ??= () => undefined;

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";
const start = vi.fn(async (): Promise<string | null> => "s1");
const startEnsemble = vi.fn(async (): Promise<string[]> => []);

/** A full start state, as the jump or an earlier unmount would leave it. */
const PICKED: PendingTask = {
  repoPath: REPO,
  prompt: "Refactor the parser",
  isolation: "container",
  agent: "codex",
  model: "gpt-5.5",
  modelAgent: "codex",
  effort: "high",
  mode: "ensemble",
  mcpServers: ["docs"],
};

const SESSION = {
  id: "s1",
  repoPath: REPO,
  worktreePath: "C:/wt/s1",
  branch: "gd/session/s1",
  base: "abc",
  headHash: "abc",
  claudeSessionId: "c1",
  model: "",
  effort: "",
  isolation: "worktree",
  agent: "claude",
  running: false,
  kept: false,
  turns: [],
} as unknown as AgentSession;

const pending = () => useSessionsStore.getState().pendingTask;
const setPending = (task: PendingTask | null) =>
  act(() => useSessionsStore.getState().setPendingTask(task));
const textarea = () => {
  const el = document.querySelector("textarea");
  if (!el) throw new Error("no composer textarea");
  return el;
};

function Composer({
  show = true,
  repoPath = REPO,
  session = null,
}: {
  show?: boolean;
  repoPath?: string;
  session?: AgentSession | null;
}) {
  return show ? (
    <SessionComposer repoPath={repoPath} session={session} />
  ) : null;
}

function mount(
  props: Parameters<typeof Composer>[0] = {},
  wrap: (node: React.ReactNode) => React.ReactNode = (n) => n,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (p: Parameters<typeof Composer>[0]) => (
    <QueryClientProvider client={client}>
      {wrap(<Composer {...p} />)}
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return {
    ...view,
    update: (p: Parameters<typeof Composer>[0]) => view.rerender(tree(p)),
  };
}

/** Types a task into the empty composer and presses Send. */
async function typeAndSend(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(textarea(), text);
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
}

/** Makes the next `start` wait; the returned function settles it. */
function deferStart() {
  let resolve: (id: string | null) => void = () => undefined;
  start.mockImplementationOnce(
    () =>
      new Promise<string | null>((r) => {
        resolve = r;
      }),
  );
  return (id: string | null) =>
    act(async () => {
      resolve(id);
    });
}

/** Leave for an overlay view: App unmounts the whole repository view. */
function leaveForSettings(update: (p: Parameters<typeof Composer>[0]) => void) {
  act(() => useUiStore.setState({ view: "settings" }));
  update({ show: false });
}

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  start.mockClear();
  vi.mocked(toastError).mockClear();
  probe.data = undefined;
  startEnsemble.mockClear();
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ view: "repo", repoPath: REPO, repoTab: "agent" });
  useSessionsStore.setState(useSessionsStore.getInitialState(), true);
  useSessionsStore.setState({ start, startEnsemble });
});

afterAll(() => {
  if (unmockedCommands.length > 0)
    console.warn(`unmocked commands: ${unmockedCommands.join(", ")}`);
});

describe("SessionComposer start state across an unmount", () => {
  it("an unmount with a picked start state leaves it, and the next composer restores it", async () => {
    const user = userEvent.setup();
    setPending(PICKED);
    const { update } = mount();
    await waitFor(() => expect(pending()).toBeNull());
    await user.type(textarea(), " today");

    leaveForSettings(update);
    const expected = { ...PICKED, prompt: "Refactor the parser today" };
    expect(pending()).toEqual(expected);

    act(() => useUiStore.setState({ view: "repo" }));
    update({ show: true });
    await waitFor(() => expect(pending()).toBeNull());
    expect(textarea()).toHaveValue("Refactor the parser today");
    expect(screen.getByRole("button", { name: "Best-of-N…" })).toBeVisible();

    // The restored composer holds every field again: its own unmount leaves the
    // same record.
    leaveForSettings(update);
    expect(pending()).toEqual(expected);
  });

  it("an all-default composer with an empty draft leaves nothing", async () => {
    const { update } = mount();
    await screen.findByRole("button", { name: "Send" });
    leaveForSettings(update);
    expect(pending()).toBeNull();
  });

  it("a composer for an existing session leaves nothing", async () => {
    const user = userEvent.setup();
    const { update } = mount({ session: SESSION });
    await user.type(textarea(), "follow up");
    leaveForSettings(update);
    expect(pending()).toBeNull();
  });

  it("a handoff waiting for another repository is never overwritten", async () => {
    const user = userEvent.setup();
    const handoff: PendingTask = { repoPath: OTHER, prompt: "Implement #12" };
    const { update } = mount();
    await user.type(textarea(), "my own draft");
    setPending(handoff);
    leaveForSettings(update);
    expect(pending()).toBe(handoff);
  });

  it("an earlier composer's unconsumed stash for another repository is replaced", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ repoPath: OTHER });
    const first = mount({ repoPath: OTHER });
    await user.type(textarea(), "beta draft");
    leaveForSettings(first.update);
    expect(pending()?.repoPath).toBe(OTHER);
    first.unmount();

    useUiStore.setState({ view: "repo", repoPath: REPO });
    const second = mount();
    await user.type(textarea(), "alpha draft");
    leaveForSettings(second.update);
    expect(pending()).toMatchObject({ repoPath: REPO, prompt: "alpha draft" });
  });

  it("an unmount after Send started a session leaves nothing", async () => {
    const user = userEvent.setup();
    // Non-default picks that Send leaves in place (it clears only the draft).
    setPending({ ...PICKED, isolation: "worktree", mode: "single" });
    const { update } = mount();
    await waitFor(() => expect(pending()).toBeNull());
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(start).toHaveBeenCalledTimes(1);
    // The new session is selected and takes over the surface.
    act(() =>
      useSessionsStore.setState({ sessions: [SESSION], activeId: "s1" }),
    );
    update({ show: false });
    expect(pending()).toBeNull();
  });

  it("a SessionActivation mode switch (view and selection unchanged) leaves nothing", async () => {
    const user = userEvent.setup();
    const { update } = mount();
    await user.type(textarea(), "draft");
    update({ show: false });
    expect(pending()).toBeNull();
  });

  it("a hidden tab (an Activity hide) parks the start state and the re-show takes it back", async () => {
    const user = userEvent.setup();
    let hidden = false;
    const { update } = mount({}, (n) => (
      <TabPanel active={!hidden}>{n}</TabPanel>
    ));
    await user.type(textarea(), "keep me");
    hidden = true;
    update({});
    expect(pending()).toMatchObject({ repoPath: REPO, prompt: "keep me" });
    hidden = false;
    update({});
    await waitFor(() => expect(pending()).toBeNull());
    expect(textarea()).toHaveValue("keep me");
  });
});

describe("SessionComposer start state: jump, failed start, repo switch", () => {
  it("the Set up in Settings… jump leaves the whole start state and round-trips", async () => {
    probe.data = {
      runtime: null,
      ready: false,
      imagePresent: false,
      imageMatches: false,
      opencodeOutdated: false,
    } as ContainerStatus;
    const user = userEvent.setup();
    const picked = { ...PICKED, mode: "single" as const };
    setPending(picked);
    const { update } = mount();
    await waitFor(() => expect(pending()).toBeNull());
    await user.click(
      await screen.findByRole("button", { name: "Set up in Settings…" }),
    );
    const jumped = pending();
    expect(jumped).toEqual(picked);
    expect(useUiStore.getState()).toMatchObject({
      view: "settings",
      settingsTarget: "ai",
      settingsAnchor: "agent-sandbox",
    });
    // The unmount that follows keeps the jump's own record.
    update({ show: false });
    expect(pending()).toBe(jumped);

    act(() => useUiStore.setState({ view: "repo" }));
    update({ show: true });
    await waitFor(() => expect(pending()).toBeNull());
    expect(textarea()).toHaveValue(PICKED.prompt);
    leaveForSettings(update);
    expect(pending()).toEqual(picked);
  });

  it("a Send whose start made no session keeps the task and the picks", async () => {
    start.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    setPending({ ...PICKED, isolation: "worktree", mode: "single" });
    const { update } = mount();
    await waitFor(() => expect(pending()).toBeNull());
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    // Lets the start's settle (its release of the submit mark) run.
    await act(() => Promise.resolve());
    expect(start).toHaveBeenCalledTimes(1);
    expect(textarea()).toHaveValue(PICKED.prompt);
    leaveForSettings(update);
    expect(pending()).toMatchObject({
      repoPath: REPO,
      prompt: PICKED.prompt,
      agent: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
  });

  it("a failed start leaves a draft typed meanwhile alone", async () => {
    const settle = deferStart();
    const user = userEvent.setup();
    const { update } = mount();
    await typeAndSend(user, "Fix the cache");
    expect(textarea()).toHaveValue("");
    await user.type(textarea(), "something else");
    await settle(null);
    expect(textarea()).toHaveValue("something else");
    leaveForSettings(update);
    expect(pending()).toMatchObject({ prompt: "something else" });
  });

  it("a failed start gives back the typed command, not its expansion", async () => {
    start.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    mount();
    await typeAndSend(user, "/fix the parser");
    await act(() => Promise.resolve());
    expect(start).toHaveBeenCalledTimes(1);
    // The mock takes no parameters, so its recorded call is read untyped.
    const sent = (start.mock.calls[0] as unknown[] | undefined)?.[1];
    expect(sent).toEqual(expect.any(String));
    expect(sent).not.toBe("/fix the parser");
    expect(textarea()).toHaveValue("/fix the parser");
  });

  it("a start that throws keeps the task", async () => {
    const boom = new Error("boom");
    start.mockRejectedValueOnce(boom);
    const user = userEvent.setup();
    const { update } = mount();
    await typeAndSend(user, "Fix the cache");
    await act(() => Promise.resolve());
    expect(textarea()).toHaveValue("Fix the cache");
    expect(vi.mocked(toastError).mock.calls).toEqual([[boom]]);
    // The submit mark was released: a leave stashes the restored task.
    leaveForSettings(update);
    expect(pending()).toMatchObject({
      repoPath: REPO,
      prompt: "Fix the cache",
    });
  });

  it("a failed start that settles after a repository switch on a hidden tab leaves the draft alone", async () => {
    const settle = deferStart();
    const user = userEvent.setup();
    let hidden = false;
    const { update } = mount({}, (n) => (
      <TabPanel active={!hidden}>{n}</TabPanel>
    ));
    await typeAndSend(user, "alpha task");
    hidden = true;
    update({});
    act(() => useUiStore.setState({ repoPath: OTHER }));
    update({ repoPath: OTHER });
    await settle(null);
    expect(textarea()).toHaveValue("");
    hidden = false;
    update({ repoPath: OTHER });
    expect(textarea()).toHaveValue("");
  });

  it("a failed start that settles after a repository switch leaves the other repository's draft alone", async () => {
    const settle = deferStart();
    const user = userEvent.setup();
    const { update } = mount();
    await typeAndSend(user, "alpha task");
    act(() => useUiStore.setState({ repoPath: OTHER }));
    update({ repoPath: OTHER });
    await settle(null);
    expect(textarea()).toHaveValue("");
  });

  it("a repository switch on a mounted composer consumes that repository's record over the live draft", async () => {
    // Pins today's behaviour: the composer is unkeyed, so the prop change re-runs
    // the consume effect and the draft typed before the switch is not stashed.
    const user = userEvent.setup();
    const { update } = mount();
    await user.type(textarea(), "bar");
    setPending({ ...PICKED, repoPath: OTHER, mode: "single" });
    act(() => useUiStore.setState({ repoPath: OTHER }));
    update({ repoPath: OTHER });
    await waitFor(() => expect(pending()).toBeNull());
    expect(textarea()).toHaveValue(PICKED.prompt);
  });
});

describe("SessionActivation with another repository's record", () => {
  it("never forces Delegate over a Plan draft, on a tab re-show either", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (active: boolean) => (
      <QueryClientProvider client={client}>
        <TabPanel active={active}>
          <SessionActivation repoPath={REPO} />
        </TabPanel>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    await user.click(screen.getByRole("tab", { name: "Plan a task" }));
    const goal = await screen.findByRole("textbox", {
      name: "Describe a task to plan",
    });
    await user.type(goal, "Plan the cache");
    setPending({ ...PICKED, repoPath: OTHER });
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(screen.getByRole("tab", { name: "Plan a task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("textbox", { name: "Describe a task to plan" }),
    ).toHaveValue("Plan the cache");
    expect(pending()?.repoPath).toBe(OTHER);
  });
});

describe("Best-of-N round trip (live-drive observation)", () => {
  it("cancelling the Best-of-N dialog keeps the model picked in single mode", async () => {
    const user = userEvent.setup();
    mount();
    const model = await screen.findByRole("combobox", { name: "Agent model" });
    await user.type(model, "gpt-5.5");
    await user.keyboard("{Escape}");
    expect(model).toHaveValue("gpt-5.5");
    await user.type(textarea(), "Try it several ways");

    await user.click(screen.getByRole("button", { name: "Run options" }));
    await user.click(await screen.findByRole("radio", { name: "Best-of-N" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Best-of-N…" }));
    await screen.findByRole("dialog", { name: "Run this task several ways" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Run this task several ways" }),
      ).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "Run options" }));
    await user.click(await screen.findByRole("radio", { name: "Single" }));
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("combobox", { name: "Agent model" }),
    ).toHaveValue("gpt-5.5");
    expect(startEnsemble).not.toHaveBeenCalled();
  });
});

describe("SessionComposer while the session is busy", () => {
  it("Enter during a Keep, Discard or Resume sends nothing and keeps the draft", async () => {
    const send = vi.fn(async () => undefined);
    useSessionsStore.setState({ sessions: [SESSION], busyId: "s1", send });
    const user = userEvent.setup();
    mount({ session: SESSION });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument(),
    );
    await user.type(textarea(), "next step");
    await user.keyboard("{Enter}");
    expect(send).not.toHaveBeenCalled();
    expect(textarea()).toHaveValue("next step");
  });

  it("Send is held with its reason while Keep or Discard runs", async () => {
    const reason = "Wait for Keep or Discard to finish.";
    useSessionsStore.setState({ sessions: [SESSION], busyId: "s1" });
    const user = userEvent.setup();
    mount({ session: SESSION });
    await user.type(textarea(), "next step");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    const line = screen.getByText(reason);
    expect(line.closest('[role="status"]')).not.toHaveClass("sr-only");
    expect(send).toHaveAccessibleDescription(reason);
    expect(send.parentElement).toHaveAttribute("title", reason);

    act(() => useSessionsStore.setState({ busyId: null }));
    await waitFor(() => expect(send).toBeEnabled());
    expect(screen.queryByText(reason)).toBeNull();
    expect(send).not.toHaveAccessibleDescription();
    expect(send.parentElement).not.toHaveAttribute("title");
  });
});
