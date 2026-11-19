import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, type ReactElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationListPanel } from "@/features/conversations/ConversationListPanel";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import {
  forgeGlMrMergeState,
  forgePrListPage,
  forgePrView,
  forgeStatus,
  gitRemotes,
  type PrStateFilter,
} from "@/lib/git/api";
import { glMrMergeStateOptions, prDetailsOptions } from "@/lib/git/queries";
import type {
  ForgeImplemented,
  ForgeStatus,
  GitLabMrMergeState,
  PrDetails,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { type LocalPr, listLocalPrs } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The forge probe never answers, so the panel stays in its pending window.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgePrListPage: vi.fn(),
  forgePrView: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  // Pending unless a test answers it: an unanswered remotes read keeps today's copy.
  gitRemotes: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
}));

type Local = { id: string; title: string };
type Remote = { number: number; title: string };
type PanelProps = ComponentProps<
  typeof ConversationListPanel<Local, Remote, string>
>;

const PR_TABS: readonly PrStateFilter[] = ["open", "merged", "unmerged"];
const PR_LABELS: Record<PrStateFilter, string> = {
  open: "Open",
  merged: "Merged",
  unmerged: "Closed",
  closed: "Closed",
};

const noop = () => undefined;

/** A settled, ready, empty list: both sections draw their empty copy. The
 *  state props stay out, so each harness's S infers from its own state. */
function baseProps(): Omit<
  PanelProps,
  "stateFilter" | "onStateFilter" | "stateOptions"
> {
  return {
    repoPath: "C:/repo",
    feature: "pull requests",
    newMenu: {
      ghLabel: "Pull request…",
      ghDisabled: false,
      onGh: noop,
      localLabel: "Local pull request…",
      onLocal: noop,
    },
    filterSlot: null,
    filterRef: { current: null },
    filterText: "",
    onFilterText: noop,
    onListKeyDown: noop,
    stateLocal: [],
    visibleLocal: [],
    localKey: (l) => l.id,
    isLocalActive: () => false,
    onSelectLocal: noop,
    renderLocalRow: (l) => l.title,
    archivedLocalCount: 0,
    showArchived: false,
    onToggleArchived: noop,
    localCollapsed: false,
    remoteCollapsed: false,
    onToggleLocal: noop,
    onToggleRemote: noop,
    ghPending: false,
    ghProbeFailed: false,
    ghReady: true,
    listPending: false,
    stateRemote: [],
    visibleRemote: [],
    remoteKey: (r) => String(r.number),
    isRemoteActive: () => false,
    onSelectRemote: noop,
    onRemoteHover: noop,
    renderRemoteRow: (r) => r.title,
    remoteSkeletonRows: 2,
    remoteFetching: false,
    localNoun: "pull requests",
    remoteNoun: "pull requests",
  };
}

/** The PR panel's shape, with the tab held in real state so aria-pressed
 *  follows a click; `picks` records every onStateFilter call. */
function PrHarness({ picks }: { picks: PrStateFilter[] }) {
  const [state, setState] = useState<PrStateFilter>("open");
  return (
    <ConversationListPanel
      {...baseProps()}
      stateFilter={state}
      onStateFilter={(s) => {
        picks.push(s);
        setState(s);
      }}
      stateOptions={{
        values: PR_TABS,
        labels: PR_LABELS,
        groupLabel: "Pull request state",
      }}
    />
  );
}

function IssueHarness() {
  const [state, setState] = useState<"open" | "closed">("open");
  return (
    <ConversationListPanel
      {...baseProps()}
      feature="issues"
      localNoun="issues"
      remoteNoun="issues"
      stateFilter={state}
      onStateFilter={setState}
    />
  );
}

afterEach(cleanup);

/** Renders, then flushes the update Base UI's ScrollArea schedules after mount,
 *  so it lands inside act() rather than warning. */
async function renderSettled(ui: ReactElement) {
  const result = render(ui);
  await act(async () => undefined);
  return result;
}

describe("PR list state tabs", () => {
  it("renders Open | Merged | Closed in a named group, Open pressed", async () => {
    await renderSettled(<PrHarness picks={[]} />);
    const group = screen.getByRole("group", { name: "Pull request state" });
    const tabs = within(group).getAllByRole("button");
    expect(tabs.map((b) => b.textContent)).toEqual([
      "Open",
      "Merged",
      "Closed",
    ]);
    expect(tabs.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("sends the wire value on click and moves aria-pressed with the tab", async () => {
    const user = userEvent.setup();
    const picks: PrStateFilter[] = [];
    render(<PrHarness picks={picks} />);
    const group = screen.getByRole("group", { name: "Pull request state" });

    await user.click(within(group).getByRole("button", { name: "Merged" }));
    expect(picks).toEqual(["merged"]);
    expect(
      within(group).getByRole("button", { name: "Merged" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Open" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(within(group).getByRole("button", { name: "Closed" }));
    expect(picks).toEqual(["merged", "unmerged"]);
    expect(
      within(group).getByRole("button", { name: "Closed" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("names the tab's label in the empty copy, never the wire value", async () => {
    const user = userEvent.setup();
    render(<PrHarness picks={[]} />);
    const group = screen.getByRole("group", { name: "Pull request state" });
    expect(screen.getByText("No open pull requests.")).toBeInTheDocument();
    expect(
      screen.getByText("No open local pull requests."),
    ).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "Merged" }));
    expect(screen.getByText("No merged pull requests.")).toBeInTheDocument();
    expect(
      screen.getByText("No merged local pull requests."),
    ).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "Closed" }));
    expect(screen.getByText("No closed pull requests.")).toBeInTheDocument();
    expect(
      screen.getByText("No closed local pull requests."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unmerged/i)).toBeNull();
  });

  it("compacts New on a narrow header, keeping its accessible name", async () => {
    const { container } = await renderSettled(<PrHarness picks={[]} />);
    const newButton = screen.getByRole("button", { name: "New" });
    expect(newButton).toHaveAttribute("aria-label", "New");
    expect(newButton).toHaveAttribute("title", "New");
    expect(newButton).toHaveClass(
      "@max-[277px]/gd-prhead:*:data-[slot=new-label]:hidden",
    );
    const label = newButton.querySelector('[data-slot="new-label"]');
    expect(label?.textContent).toBe("New");
    // The container query reads the header box, never the row it styles.
    expect(
      container.querySelector(".\\@container\\/gd-prhead"),
    ).toContainElement(newButton);
  });
});

describe("issue list state tabs (no stateOptions)", () => {
  it("keeps the Open | Closed pair in an Issue state group", async () => {
    await renderSettled(<IssueHarness />);
    const group = screen.getByRole("group", { name: "Issue state" });
    const tabs = within(group).getAllByRole("button");
    expect(tabs.map((b) => b.textContent)).toEqual(["Open", "Closed"]);
    expect(screen.getByText("No open issues.")).toBeInTheDocument();
    expect(screen.getByText("No open local issues.")).toBeInTheDocument();
  });

  it("renders New unchanged, with no compact markup", async () => {
    const { container } = await renderSettled(<IssueHarness />);
    const newButton = screen.getByRole("button", { name: "New" });
    expect(newButton).not.toHaveAttribute("aria-label");
    expect(newButton).not.toHaveAttribute("title");
    expect(newButton.querySelector("[data-slot=new-label]")).toBeNull();
    expect(newButton.className).not.toContain("gd-prhead");
    expect(container.querySelector(".\\@container\\/gd-prhead")).toBeNull();
  });

  it("switches to Closed and says so in the empty copy", async () => {
    const user = userEvent.setup();
    render(<IssueHarness />);
    const group = screen.getByRole("group", { name: "Issue state" });
    await user.click(within(group).getByRole("button", { name: "Closed" }));
    expect(
      within(group).getByRole("button", { name: "Closed" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("No closed issues.")).toBeInTheDocument();
  });
});

const READY_GITHUB: ForgeStatus = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "github.com",
  login: "me",
  capabilities: {
    pullRequests: true,
    draftPrs: true,
    issues: true,
    labels: true,
    milestones: true,
    reactions: true,
    discussions: true,
    stars: true,
    ci: true,
    webhooks: true,
    approvals: true,
    securityFindings: true,
  },
  // Only the list read is built: every side read (CI, mergeability, review
  // state, scope filters) stays gated off, so the list call is the one to watch.
  implemented: { pullRequests: true } as ForgeImplemented,
};

function localPr(id: string, title: string, status: LocalPr["status"]) {
  return {
    id,
    title,
    body: "",
    base: "main",
    head: id,
    status,
    approved: false,
    labels: [],
    comments: [],
    createdAt: "2026-01-01T00:00:00Z",
  } satisfies LocalPr;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PullRequestsPanel repoPath="C:/repo" />
    </QueryClientProvider>,
  );
}

describe("PullRequestsPanel (real panel)", () => {
  afterEach(() => {
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
  });

  it("files local rows per tab and sends unmerged for Closed", async () => {
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(READY_GITHUB);
    vi.mocked(forgePrListPage).mockResolvedValue({ rows: [], capped: false });
    vi.mocked(listLocalPrs).mockResolvedValue([
      localPr("l1", "Local open one", "open"),
      localPr("l2", "Local merged one", "merged"),
      localPr("l3", "Local closed one", "closed"),
    ]);
    const user = userEvent.setup();
    renderPanel();
    const states = () => vi.mocked(forgePrListPage).mock.calls.map((c) => c[1]);
    const shown = () =>
      ["Local open one", "Local merged one", "Local closed one"].filter(
        (t) => screen.queryByText(t) !== null,
      );

    await waitFor(() => expect(states()).toContain("open"));
    await waitFor(() => expect(shown()).toEqual(["Local open one"]));
    const group = screen.getByRole("group", { name: "Pull request state" });

    await user.click(within(group).getByRole("button", { name: "Merged" }));
    await waitFor(() => expect(states()).toContain("merged"));
    await waitFor(() => expect(shown()).toEqual(["Local merged one"]));

    await user.click(within(group).getByRole("button", { name: "Closed" }));
    await waitFor(() => expect(states()).toContain("unmerged"));
    await waitFor(() => expect(shown()).toEqual(["Local closed one"]));
    expect(states()).not.toContain("closed");
    expect([...new Set(states())]).toEqual(["open", "merged", "unmerged"]);
  });

  it("says merge requests for a repo saved as GitLab while the probe is pending", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentRepos: [
        {
          path: "C:/repo",
          name: "repo",
          lastOpenedAt: "2026-01-01T00:00:00Z",
          provider: "gitlab",
        },
      ],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PullRequestsPanel repoPath="C:/repo" />
      </QueryClientProvider>,
    );
    expect(
      (await screen.findAllByText(/Loading merge requests/)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading pull requests/)).toBeNull();
  });
});

const READY_GITLAB: ForgeStatus = {
  ...READY_GITHUB,
  provider: "gitlab",
  host: "gitlab.com",
};

/** Settings that remember `C:/repo` as a repository on `provider`. */
function savedAs(provider: "github" | "gitlab") {
  return {
    ...DEFAULT_SETTINGS,
    recentRepos: [
      {
        path: "C:/repo",
        name: "repo",
        lastOpenedAt: "2026-01-01T00:00:00Z",
        provider,
      },
    ],
  };
}

/** A menu item name that starts with `label`: a disabled item carries its
 *  reason after it. */
const startsWith = (label: string) => (name: string) => name.startsWith(label);

/** Opens the New menu and returns its forge item. */
async function newMenuForgeItem(
  user: ReturnType<typeof userEvent.setup>,
  name: string | ((name: string) => boolean),
) {
  await user.click(screen.getByRole("button", { name: "New" }));
  return screen.findByRole("menuitem", { name });
}

describe("PullRequestsPanel on GitLab says merge request", () => {
  afterEach(() => {
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.mocked(gitRemotes).mockImplementation(
      () => new Promise(() => undefined),
    );
  });

  it("names the state group and the refresh button for merge requests", async () => {
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(READY_GITLAB);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(forgePrListPage).mockResolvedValue({ rows: [], capped: false });
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    renderPanel();
    expect(
      await screen.findByRole("group", { name: "Merge request state" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Pull request state" }),
    ).toBeNull();
    const refresh = screen.getByRole("button", {
      name: "Refresh merge requests",
    });
    expect(refresh).toHaveAttribute("title", "Refresh merge requests");
  });

  it("titles the All scope for merge requests while the probe is pending", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("gitlab"));
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPanel();
    // The saved provider lands with the settings read, after the first paint.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
        "title",
        "Show every merge request",
      ),
    );
    const item = await newMenuForgeItem(
      user,
      startsWith("Merge request on GitLab…"),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  // A pending probe's reason names no action ("Checking this repository's
  // host…"); a probe that couldn't reach the host is the arm that phrases it.
  it("phrases the unreachable-probe reason for merge requests on a saved GitLab repo", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("gitlab"));
    vi.mocked(forgeStatus).mockRejectedValue(new Error("offline"));
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
    await act(async () => undefined);
    const item = await newMenuForgeItem(
      user,
      startsWith("Merge request on GitLab…"),
    );
    // The row shows the reason itself, and only there: a disabled row never
    // shows its title, and a title repeating the reason is announced twice.
    await waitFor(() =>
      expect(item).toHaveAccessibleName(
        /^Merge request on GitLab… — .*open a merge request/,
      ),
    );
    expect(item.textContent).not.toContain("pull request");
    expect(item).not.toHaveAttribute("title");
  });
});

describe("PullRequestsPanel in a repository with no remote", () => {
  const CAN_CREATE: ForgeStatus = {
    ...READY_GITHUB,
    implemented: { pullRequests: true, mrCreate: true } as ForgeImplemented,
  };
  const NO_REMOTE_REASON =
    "Add a GitHub, GitLab, or Bitbucket remote to open a pull request here.";

  afterEach(() => {
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.mocked(gitRemotes).mockImplementation(
      () => new Promise(() => undefined),
    );
  });

  it("offers a neutral, disabled item that says which remote to add, and refuses the hotkey", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("github"));
    vi.mocked(forgeStatus).mockResolvedValue(CAN_CREATE);
    vi.mocked(gitRemotes).mockClear().mockResolvedValue([]);
    vi.mocked(forgePrListPage)
      .mockClear()
      .mockResolvedValue({ rows: [], capped: false });
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    // The list is read only once the forge is ready, so the create gate is
    // open on the forge's side and only the missing remote can close it.
    await waitFor(() => expect(forgePrListPage).toHaveBeenCalled());
    await act(async () => undefined);
    expect(dispatchAction("create-pr")).toBe(false);
    const item = await newMenuForgeItem(
      user,
      startsWith("Remote pull request…"),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toHaveAttribute("title");
    expect(item).toHaveTextContent(NO_REMOTE_REASON);
    expect(item).toHaveAccessibleName(
      `Remote pull request… — ${NO_REMOTE_REASON}`,
    );
    expect(
      screen.queryByRole("menuitem", {
        name: startsWith("Pull request on GitHub…"),
      }),
    ).toBeNull();
  });

  it("refuses a create request handed over from elsewhere", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("github"));
    vi.mocked(forgeStatus).mockResolvedValue(CAN_CREATE);
    vi.mocked(gitRemotes).mockClear().mockResolvedValue([]);
    vi.mocked(forgePrListPage)
      .mockClear()
      .mockResolvedValue({ rows: [], capped: false });
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await waitFor(() => expect(forgePrListPage).toHaveBeenCalled());
    await act(async () => undefined);
    try {
      await act(async () => {
        useUiStore.setState({ pendingCreate: "pr" });
      });
      await waitFor(() =>
        expect(useUiStore.getState().pendingCreate).toBe(null),
      );
      await act(async () => undefined);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      useUiStore.setState({ pendingCreate: null });
    }
  });

  it("keeps today's item while the remotes read is pending", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("github"));
    vi.mocked(forgeStatus).mockResolvedValue(CAN_CREATE);
    vi.mocked(forgePrListPage).mockResolvedValue({ rows: [], capped: false });
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("group", { name: "Pull request state" });
    const item = await newMenuForgeItem(user, "Pull request on GitHub…");
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    expect(item.getAttribute("title") ?? "").not.toContain("remote");
  });
});

/** One answer of the merge-state read: a value, a rejection, or a promise. */
type ProbeAnswer = Partial<GitLabMrMergeState> | Error | Promise<unknown>;

function mergeState(fields: Partial<GitLabMrMergeState>): GitLabMrMergeState {
  return {
    autoMergeEnabled: false,
    detailedMergeStatus: "",
    pipelineStatus: "",
    pipelineUrl: "",
    ...fields,
  };
}

const LOCKED = { locked: true, state: "CLOSED" };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("PullRequestsPanel align of a GitLab MR mid-merge", () => {
  const POLL_MS = 2_000;
  /** Per-PR answer queues; the last answer repeats once a queue runs dry. */
  let answers: Record<number, ProbeAnswer[]> = {};

  /** Mounted beside the panel, as the detail view's own details read would be. */
  function DetailsWatcher({ number }: { number: number }) {
    useQuery(prDetailsOptions("C:/repo", number, "origin"));
    return null;
  }

  /** Mounts the panel on PR `number`, armed unless `arm` is false; `seed`
   *  writes the client's cache before the first render. */
  function renderArmed(
    number: number,
    {
      forge = READY_GITLAB,
      arm = true,
      detailsState = "CLOSED",
      seed,
    }: {
      forge?: ForgeStatus;
      arm?: boolean;
      detailsState?: string;
      seed?: (client: QueryClient) => void;
    } = {},
  ) {
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(forge);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(forgePrListPage).mockResolvedValue({ rows: [], capped: false });
    vi.mocked(listLocalPrs).mockResolvedValue([]);
    vi.mocked(forgePrView).mockImplementation(
      async (_repo, n) => ({ number: n, state: detailsState }) as PrDetails,
    );
    vi.mocked(forgeGlMrMergeState).mockImplementation(async (_repo, n) => {
      const queue = answers[n] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      if (next instanceof Promise) return next as Promise<GitLabMrMergeState>;
      return mergeState(next ?? {});
    });
    useUiStore.setState({
      repoPath: "C:/repo",
      repoTab: "pulls",
      selectedPr: arm ? { kind: "remote", id: String(number) } : null,
      pendingPrAlign: arm,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seed?.(client);
    render(
      <QueryClientProvider client={client}>
        <PullRequestsPanel repoPath="C:/repo" />
        <DetailsWatcher number={number} />
      </QueryClientProvider>,
    );
    return client;
  }

  /** Waits on real time, which the faked intervals leave alone. */
  async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async function ticks(n = 10) {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
  }
  async function poll() {
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
  }
  const probeCalls = (number?: number) =>
    vi
      .mocked(forgeGlMrMergeState)
      .mock.calls.filter((c) => number === undefined || c[1] === number).length;
  const listCalls = (state: PrStateFilter) =>
    vi.mocked(forgePrListPage).mock.calls.filter((c) => c[1] === state).length;
  const armed = () => useUiStore.getState().pendingPrAlign;
  const pressedTab = (group = "Merge request state") =>
    within(screen.getByRole("group", { name: group }))
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;

  beforeEach(() => {
    // Only the poll's interval is faked, so React Query's timeouts and the
    // waits below run on real time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.mocked(forgeGlMrMergeState).mockClear();
    vi.mocked(forgePrView).mockClear();
    vi.mocked(forgePrListPage).mockClear();
    answers = {};
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.mocked(gitRemotes).mockImplementation(
      () => new Promise(() => undefined),
    );
    useUiStore.setState({ selectedPr: null, pendingPrAlign: false });
  });

  /** Presses one of the state tabs, as the user would. */
  async function pickTab(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ) {
    const group = screen.getByRole("group", { name: "Merge request state" });
    await user.click(within(group).getByRole("button", { name }));
  }
  const arm = (number: number) =>
    act(async () => {
      useUiStore
        .getState()
        .selectPrWithAlign({ kind: "remote", id: String(number) });
    });

  it("holds while locked, then lands on Merged and refreshes the stale reads", async () => {
    answers[7] = [LOCKED, { locked: false, state: "MERGED" }];
    renderArmed(7, { arm: false });
    const user = userEvent.setup();
    await until(() => listCalls("open") === 1, "the Open page");
    // The landing tab's page is cached and fresh before the align arms.
    await pickTab(user, "Merged");
    await until(() => listCalls("merged") === 1, "the Merged page");
    await pickTab(user, "Open");
    await ticks();
    await arm(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    await ticks();
    expect(armed()).toBe(true);
    expect(pressedTab()).toBe("Open");
    const detailsBefore = vi.mocked(forgePrView).mock.calls.length;
    const openListBefore = listCalls("open");
    const mergedListBefore = listCalls("merged");
    await poll();
    await until(() => !armed(), "the align to settle");
    expect(probeCalls(7)).toBe(2);
    expect(pressedTab()).toBe("Merged");
    await until(
      () => vi.mocked(forgePrView).mock.calls.length > detailsBefore,
      "the details re-read",
    );
    await until(
      () => listCalls("merged") > mergedListBefore,
      "the landing page's re-read",
    );
    await ticks();
    expect(vi.mocked(forgePrView).mock.calls.length).toBe(detailsBefore + 1);
    expect(listCalls("merged")).toBe(mergedListBefore + 1);
    // The page the align left is not re-read.
    expect(listCalls("open")).toBe(openListBefore);
  });

  it("re-reads the landing page when the user already sits on that tab", async () => {
    answers[7] = [LOCKED, { locked: false, state: "MERGED" }];
    renderArmed(7, { arm: false });
    const user = userEvent.setup();
    await until(() => listCalls("open") === 1, "the Open page");
    await pickTab(user, "Merged");
    await until(() => listCalls("merged") === 1, "the Merged page");
    await ticks();
    await arm(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    await ticks();
    expect(armed()).toBe(true);
    const mergedListBefore = listCalls("merged");
    await poll();
    await until(() => !armed(), "the align to settle");
    expect(pressedTab()).toBe("Merged");
    await until(
      () => listCalls("merged") > mergedListBefore,
      "the landing page's re-read",
    );
    await ticks();
    expect(listCalls("merged")).toBe(mergedListBefore + 1);
  });

  it("keeps off the view's merge-state entry: its cached open answer settles nothing and keeps its own data", async () => {
    answers[7] = [LOCKED, { locked: false, state: "MERGED" }];
    const shared = glMrMergeStateOptions("C:/repo", 7).queryKey;
    const cached = mergeState({ locked: false, state: "OPEN" });
    // A pre-merge answer, fresh by the shared options' own staleTime.
    const client = renderArmed(7, {
      seed: (c) => c.setQueryData(shared, cached),
    });
    const cachedAt = client.getQueryState(shared)?.dataUpdatedAt;
    await until(() => probeCalls(7) === 1, "the probe's first read");
    await ticks();
    expect(armed()).toBe(true);
    expect(pressedTab()).toBe("Open");
    await poll();
    await until(() => !armed(), "the align to settle");
    expect(pressedTab()).toBe("Merged");
    // The probe's reads land in its own entry, never the view's.
    expect(client.getQueryData(shared)).toEqual(cached);
    expect(client.getQueryState(shared)?.dataUpdatedAt).toBe(cachedAt);
  });

  it("re-reads two seconds after a locked answer, not sooner", async () => {
    answers[7] = [LOCKED];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    await ticks();
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS - 1);
    });
    await ticks();
    expect(probeCalls(7)).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await until(() => probeCalls(7) === 2, "the first re-read");
    await ticks();
    expect(probeCalls(7)).toBe(2);
  });

  it("settles nothing while the probe waits offline for its first answer", async () => {
    answers[7] = [{ locked: false, state: "MERGED" }];
    renderArmed(7, { arm: false });
    await until(() => listCalls("open") === 1, "the Open page");
    await until(
      () => vi.mocked(forgePrView).mock.calls.length === 1,
      "the details read",
    );
    await ticks();
    // The align's details read is held in flight across the disconnect: a
    // fetch already running is not paused, so the details settle while the
    // probe's first read parks with nothing to answer from.
    const details = deferred<PrDetails>();
    vi.mocked(forgePrView).mockImplementation(() => details.promise);
    try {
      await arm(7);
      await until(
        () => vi.mocked(forgePrView).mock.calls.length === 2,
        "the align's details read",
      );
      await act(async () => {
        onlineManager.setOnline(false);
      });
      await act(async () => {
        details.resolve({ number: 7, state: "CLOSED" } as PrDetails);
      });
      await ticks(20);
      expect(probeCalls(7)).toBe(0);
      expect(armed()).toBe(true);
      expect(pressedTab()).toBe("Open");
      await act(async () => {
        onlineManager.setOnline(true);
      });
      await until(() => !armed(), "the align to settle once online");
      expect(pressedTab()).toBe("Merged");
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("settles nothing from cached details while their read is paused offline", async () => {
    renderArmed(7, { arm: false, detailsState: "OPEN" });
    await until(() => listCalls("open") === 1, "the Open page");
    await until(
      () => vi.mocked(forgePrView).mock.calls.length === 1,
      "the details read",
    );
    await ticks();
    try {
      await act(async () => {
        onlineManager.setOnline(false);
      });
      await arm(7);
      await ticks(20);
      expect(vi.mocked(forgePrView).mock.calls.length).toBe(1);
      expect(armed()).toBe(true);
      await act(async () => {
        onlineManager.setOnline(true);
      });
      await until(() => !armed(), "the align to settle once online");
      expect(vi.mocked(forgePrView).mock.calls.length).toBe(2);
      expect(pressedTab()).toBe("Open");
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("refreshes nothing when the probe agrees with the details on the tab it sits on", async () => {
    const answer = deferred<GitLabMrMergeState>();
    answers[7] = [answer.promise];
    renderArmed(7, { arm: false });
    const user = userEvent.setup();
    await until(() => listCalls("open") === 1, "the Open page");
    // The landing tab's page is cached and fresh before the align arms.
    await pickTab(user, "Closed");
    await until(() => listCalls("unmerged") === 1, "the Closed page");
    await ticks();
    await arm(7);
    await until(() => probeCalls(7) === 1, "the merge-state read");
    await ticks();
    const detailsBefore = vi.mocked(forgePrView).mock.calls.length;
    const openListBefore = listCalls("open");
    await act(async () => {
      answer.resolve(mergeState({ locked: false, state: "CLOSED" }));
    });
    await until(() => !armed(), "the align to settle");
    await ticks();
    expect(pressedTab()).toBe("Closed");
    expect(vi.mocked(forgePrView).mock.calls.length).toBe(detailsBefore);
    expect(listCalls("unmerged")).toBe(1);
    expect(listCalls("open")).toBe(openListBefore);
  });

  it("re-reads the landing page when the details alone move the tab", async () => {
    answers[7] = [LOCKED];
    const client = renderArmed(7, { arm: false });
    const user = userEvent.setup();
    await until(() => listCalls("open") === 1, "the Open page");
    // The landing tab's page is cached and fresh before the align arms.
    await pickTab(user, "Merged");
    await until(() => listCalls("merged") === 1, "the Merged page");
    await pickTab(user, "Open");
    await ticks();
    await arm(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    await ticks();
    expect(armed()).toBe(true);
    const mergedListBefore = listCalls("merged");
    vi.mocked(forgePrView).mockImplementation(
      async (_repo, n) => ({ number: n, state: "MERGED" }) as PrDetails,
    );
    await act(() =>
      client.invalidateQueries({
        queryKey: prDetailsOptions("C:/repo", 7, "origin").queryKey,
        exact: true,
      }),
    );
    await until(() => !armed(), "the align to settle");
    expect(pressedTab()).toBe("Merged");
    await until(
      () => listCalls("merged") > mergedListBefore,
      "the landing page's re-read",
    );
    await ticks();
    expect(listCalls("merged")).toBe(mergedListBefore + 1);
  });

  it("re-reads no details when their own state chose the tab it moved to", async () => {
    renderArmed(7, { arm: false, detailsState: "MERGED" });
    const user = userEvent.setup();
    await until(() => listCalls("open") === 1, "the Open page");
    // The landing tab's page is cached and fresh before the align arms.
    await pickTab(user, "Merged");
    await until(() => listCalls("merged") === 1, "the Merged page");
    await pickTab(user, "Open");
    await ticks();
    const detailsBefore = vi.mocked(forgePrView).mock.calls.length;
    const mergedListBefore = listCalls("merged");
    await arm(7);
    await until(() => !armed(), "the align to settle");
    expect(pressedTab()).toBe("Merged");
    await until(
      () => listCalls("merged") > mergedListBefore,
      "the landing page's re-read",
    );
    await ticks(20);
    expect(listCalls("merged")).toBe(mergedListBefore + 1);
    // Only the arm's own details read: the settle adds none.
    expect(vi.mocked(forgePrView).mock.calls.length).toBe(detailsBefore + 1);
    expect(probeCalls()).toBe(0);
  });

  it("is answered by no read requested before the arm", async () => {
    const held = deferred<GitLabMrMergeState>();
    answers[7] = [held.promise, LOCKED, { locked: false, state: "MERGED" }];
    const client = renderArmed(7, { arm: false });
    await until(() => listCalls("open") === 1, "the Open page");
    await ticks();
    // A first load of the shared entry still in flight, as a hover prefetch leaves.
    void client.prefetchQuery(glMrMergeStateOptions("C:/repo", 7));
    await until(() => probeCalls(7) === 1, "the prefetch");
    await arm(7);
    await until(() => probeCalls(7) === 2, "the probe's own read");
    await act(async () => {
      held.resolve(mergeState({ locked: false, state: "OPEN" }));
    });
    await ticks();
    expect(armed()).toBe(true);
    expect(pressedTab()).toBe("Open");
    await poll();
    await until(() => !armed(), "the align to settle");
    expect(pressedTab()).toBe("Merged");
  });

  it("gives a remounted panel its own read, never the earlier mount's", async () => {
    const held = deferred<GitLabMrMergeState>();
    answers[7] = [held.promise, LOCKED];
    const client = renderArmed(7);
    await until(() => probeCalls(7) === 1, "the first mount's read");
    cleanup();
    act(() => {
      useUiStore.setState({
        selectedPr: { kind: "remote", id: "7" },
        pendingPrAlign: true,
      });
    });
    render(
      <QueryClientProvider client={client}>
        <PullRequestsPanel repoPath="C:/repo" />
        <DetailsWatcher number={7} />
      </QueryClientProvider>,
    );
    await until(() => probeCalls(7) === 2, "the remounted panel's own read");
    await act(async () => {
      held.resolve(mergeState({ locked: false, state: "OPEN" }));
    });
    await ticks();
    expect(armed()).toBe(true);
  });

  it("a second arm of the same merge request in one mount issues its own read", async () => {
    const held = deferred<GitLabMrMergeState>();
    answers[7] = [held.promise, LOCKED];
    // Mounted unarmed, so both arms mint their number from a render-time re-arm.
    renderArmed(7, { arm: false });
    await until(() => listCalls("open") === 1, "the Open page");
    await ticks();
    await arm(7);
    await until(() => probeCalls(7) === 1, "the first arm's read");
    await act(async () => {
      useUiStore.getState().clearPendingPrAlign();
    });
    await ticks();
    await arm(7);
    await until(() => probeCalls(7) === 2, "the second arm's own read");
    await act(async () => {
      held.resolve(mergeState({ locked: false, state: "OPEN" }));
    });
    await ticks();
    expect(armed()).toBe(true);
  });

  it("disarms with the tab untouched after five locked re-reads", async () => {
    answers[7] = [LOCKED];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    for (let rung = 1; rung <= 5; rung++) {
      await ticks();
      expect(armed()).toBe(true);
      await poll();
      await until(() => probeCalls(7) === 1 + rung, `re-read ${rung}`);
    }
    await until(() => !armed(), "the align to disarm");
    expect(pressedTab()).toBe("Open");
    await poll();
    await poll();
    await ticks();
    expect(probeCalls(7)).toBe(6);
  });

  it("settles Closed when the probe fails before any locked answer", async () => {
    answers[7] = [new Error("glab failed")];
    renderArmed(7);
    await until(() => !armed(), "the align to settle");
    expect(probeCalls(7)).toBe(1);
    expect(pressedTab()).toBe("Closed");
  });

  it("never settles Closed on a failure after a locked answer", async () => {
    answers[7] = [LOCKED, new Error("glab failed")];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    for (let rung = 1; rung <= 5; rung++) {
      await ticks();
      expect(pressedTab()).toBe("Open");
      expect(armed()).toBe(true);
      await poll();
      await until(() => probeCalls(7) === 1 + rung, `re-read ${rung}`);
    }
    await until(() => !armed(), "the align to disarm");
    expect(pressedTab()).toBe("Open");
  });

  it("rides a failure between locked answers on to the merge", async () => {
    answers[7] = [
      LOCKED,
      new Error("glab failed"),
      LOCKED,
      { locked: false, state: "MERGED" },
    ];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    for (let rung = 1; rung <= 3; rung++) {
      await ticks();
      expect(pressedTab()).toBe("Open");
      await poll();
      await until(() => probeCalls(7) === 1 + rung, `re-read ${rung}`);
    }
    await until(() => !armed(), "the align to settle");
    expect(pressedTab()).toBe("Merged");
  });

  it("issues no merge-state read on GitHub", async () => {
    renderArmed(7, { forge: READY_GITHUB });
    await until(() => !armed(), "the align to settle");
    expect(pressedTab("Pull request state")).toBe("Closed");
    await ticks();
    expect(probeCalls()).toBe(0);
  });

  it.each([
    ["OPEN", "Open"],
    ["MERGED", "Merged"],
  ])(
    "issues no merge-state read on GitLab for %s details",
    async (state, tab) => {
      renderArmed(7, { detailsState: state });
      await until(() => !armed(), "the align to settle");
      expect(pressedTab()).toBe(tab);
      await ticks();
      expect(probeCalls()).toBe(0);
    },
  );

  it("gives the same PR a full budget when it is armed again after a disarm", async () => {
    answers[7] = [LOCKED];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "the first merge-state read");
    for (let rung = 1; rung <= 5; rung++) {
      await ticks();
      await poll();
      await until(() => probeCalls(7) === 1 + rung, `re-read ${rung}`);
    }
    await until(() => !armed(), "the first align to disarm");
    await arm(7);
    await until(() => probeCalls(7) === 7, "the re-armed first read");
    for (let rung = 1; rung <= 5; rung++) {
      await ticks();
      expect(armed()).toBe(true);
      await poll();
      await until(() => probeCalls(7) === 7 + rung, `re-armed re-read ${rung}`);
    }
    await until(() => !armed(), "the second align to disarm");
    expect(pressedTab()).toBe("Open");
  });

  it("gives the next armed PR a full budget", async () => {
    answers[7] = [LOCKED];
    answers[8] = [LOCKED];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "A's first merge-state read");
    for (let rung = 1; rung <= 3; rung++) {
      await ticks();
      await poll();
      await until(() => probeCalls(7) === 1 + rung, `A's re-read ${rung}`);
    }
    await act(async () => {
      useUiStore.getState().selectPrWithAlign({ kind: "remote", id: "8" });
    });
    await until(() => probeCalls(8) === 1, "B's first merge-state read");
    for (let rung = 1; rung <= 5; rung++) {
      await ticks();
      expect(armed()).toBe(true);
      await poll();
      await until(() => probeCalls(8) === 1 + rung, `B's re-read ${rung}`);
    }
    await until(() => !armed(), "B's align to disarm");
    expect(probeCalls(8)).toBe(6);
    expect(probeCalls(7)).toBe(4);
  });

  it("lets a late answer for the PR the user left settle nothing", async () => {
    const lateA = deferred<GitLabMrMergeState>();
    const answerB = deferred<GitLabMrMergeState>();
    answers[7] = [lateA.promise];
    answers[8] = [answerB.promise];
    renderArmed(7);
    await until(() => probeCalls(7) === 1, "A's merge-state read");
    await act(async () => {
      useUiStore.getState().selectPrWithAlign({ kind: "remote", id: "8" });
    });
    await until(() => probeCalls(8) === 1, "B's merge-state read");
    await act(async () => {
      lateA.resolve(mergeState({ locked: false, state: "MERGED" }));
    });
    await ticks();
    expect(armed()).toBe(true);
    expect(pressedTab()).toBe("Open");
    await act(async () => {
      answerB.resolve(mergeState({ locked: false, state: "CLOSED" }));
    });
    await until(() => !armed(), "B's align to settle");
    expect(pressedTab()).toBe("Closed");
  });
});
