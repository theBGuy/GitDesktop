import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ActivityDock } from "@/features/activity/ActivityDock";
import { openAutomationResult } from "@/lib/automations/results";
import { validateRepo } from "@/lib/git/api";
import type { RepoInfo } from "@/lib/git/types";
import { emitNotification } from "@/lib/notifications/emit";
import {
  loadSettings,
  type NotificationOutcome,
  type NotificationSource,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { __resetNavHistoryForTests, canGoBack } from "@/lib/stores/nav-history";
import {
  clearAllNotifications,
  type NotificationKind,
  type NotificationTarget,
} from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The dock's resolve ladder validates the captured checkout first; a row with no
// identity stamp lands there, so validateRepo is the only git read a click makes.
// pathIsDir answering false keeps emit from stamping an identity on the row.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  pathIsDir: vi.fn(async () => false),
  validateRepo: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The notification and review stores open plugin stores at module load.
vi.mock("@/lib/plugin-store", async (importOriginal) => {
  const store = {
    get: async () => undefined,
    set: async () => undefined,
    save: async () => undefined,
  };
  return {
    ...(await importOriginal<typeof import("@/lib/plugin-store")>()),
    memoizedStoreLoader: () => async () => store,
  };
});
vi.mock("@/lib/automations/results", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/results")>()),
  openAutomationResult: vi.fn(),
}));
// The real module registers the app's repo-shell warm-up on import, which would
// hold every cross-repo landing on prefetches; the dock needs only its claim.
vi.mock("@/features/repository/useOpenRepoByPath", async () => {
  const { createOpenClaims } = await import(
    "@/features/repository/open-claims"
  );
  const { useUiStore: store } = await import("@/lib/stores/ui");
  return {
    claimRepoOpen: createOpenClaims(() => store.getState().interactionEpoch)
      .claim,
  };
});

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";
const st = () => useUiStore.getState();

function resetStore() {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
}

beforeEach(() => {
  resetStore();
  clearAllNotifications();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(validateRepo).mockReset();
  vi.mocked(validateRepo).mockImplementation(
    async (path: string) =>
      ({ root: path, name: path.split("/").pop() }) as RepoInfo,
  );
  vi.mocked(openAutomationResult).mockReset();
});

afterEach(() => {
  act(() => {
    resetStore();
    clearAllNotifications();
  });
});

afterAll(() => expect(unmockedCommands).toEqual([]));

// The source that delivers each kind; DEFAULT_SETTINGS has every source on in-app,
// and both outcome filters at "all".
const ROUTE: Partial<
  Record<
    NotificationKind,
    { source: NotificationSource; outcome?: NotificationOutcome }
  >
> = {
  "pr-opened": { source: "prActivity" },
  "ci-run": { source: "actionRuns", outcome: "success" },
  "agent-done": { source: "agents" },
  "checks-passed": { source: "prChecks", outcome: "success" },
  "checks-failed": { source: "prChecks", outcome: "failure" },
  "review-posted": { source: "reviews" },
};

/** Alpha open on History, the dock open over one row for beta. */
async function mountWithRow(
  kind: NotificationKind,
  target?: NotificationTarget,
) {
  const route = ROUTE[kind];
  if (!route) throw new Error(`no source routed for ${kind}`);
  await act(async () => {
    st().openRepo({ root: REPO, name: "alpha" });
    st().setRepoTab("history");
    emitNotification({
      ...route,
      row: {
        kind,
        tone: "info",
        title: "the beta event",
        repoPath: OTHER,
        repoName: "beta",
        target,
      },
    } as Parameters<typeof emitNotification>[0]);
    st().setActivityOpen(true);
    // emit delivers after its settings and override reads settle.
    await new Promise((r) => setTimeout(r, 0));
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ActivityDock />
    </QueryClientProvider>,
  );
  return screen.findByRole("button", { name: /^the beta event/ });
}

describe("a notification click into another repository keeps the history", () => {
  const NONE = { selectedPr: null, selectedRunId: null };
  it.each<[string, NotificationKind, NotificationTarget, string, object]>([
    [
      "pr (openPr)",
      "pr-opened",
      { type: "pr", kind: "remote", ref: "7" },
      "pulls",
      { selectedPr: { kind: "remote", id: "7" } },
    ],
    [
      "run (openRun)",
      "ci-run",
      { type: "run", runId: 42 },
      "actions",
      { selectedRunId: 42 },
    ],
    ["agent (openAgentTab)", "agent-done", { type: "agent" }, "agent", NONE],
    [
      "repo (openRepoView)",
      "checks-passed",
      { type: "repo", tab: "issues" },
      "issues",
      NONE,
    ],
  ])(
    "%s lands in beta with alpha behind it, and Back returns",
    async (_n, kind, target, tab, selection) => {
      fireEvent.click(await mountWithRow(kind, target));
      await waitFor(() => expect(st().repoPath).toBe(OTHER));
      expect(validateRepo).toHaveBeenCalledWith(OTHER);
      expect(st().repoTab).toBe(tab);
      expect(st()).toMatchObject(selection);
      expect(st().navHistory.segments.map((s) => s.repoPath)).toEqual([
        REPO,
        OTHER,
      ]);
      expect(canGoBack(st())).toBe(true);
      act(() => st().goBack());
      await waitFor(() => expect(st().repoPath).toBe(REPO));
      expect(st().repoTab).toBe("history");
    },
  );
});

describe("dock clicks that open nothing leave the history alone", () => {
  it.each<
    [string, NotificationKind, NotificationTarget | undefined, unknown[][]]
  >([
    [
      "an automation result",
      "review-posted",
      { type: "automation-result", id: "r1" },
      // The row carries no identity stamp (pathIsDir answers false).
      [[OTHER, "r1", undefined]],
    ],
    ["a row with no route", "checks-failed", undefined, []],
  ])("%s", async (_n, kind, target, resultOpens) => {
    const row = await mountWithRow(kind, target);
    const before = st().navHistory;
    fireEvent.click(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(st().repoPath).toBe(REPO);
    expect(st().navHistory).toBe(before);
    expect(validateRepo).not.toHaveBeenCalled();
    expect(vi.mocked(openAutomationResult).mock.calls).toEqual(resultOpens);
  });
});
