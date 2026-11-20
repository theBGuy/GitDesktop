import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesPanel } from "@/features/issues/IssuesPanel";
import { forgeIssueListPage, forgeStatus, gitRemotes } from "@/lib/git/api";
import { repoKeys, useCloseIssue, useCreateIssue } from "@/lib/git/queries";
import {
  type ForgeImplemented,
  type ForgeStatus,
  type IssueInfo,
  type IssueListPage,
  type RemoteListFilter,
  remoteListFilterKey,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { invoke } from "@/lib/tauri/invoke";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueListPage: vi.fn(),
  // Pending unless a test answers it: an unanswered remotes read keeps today's copy.
  gitRemotes: vi.fn(() => new Promise(() => undefined)),
}));
// The issue state writes run through their real hooks and api functions and are
// answered at the wire, since a test may not name them (scripts/
// remote-row-state-wiring.test.mjs). Every other unmocked command rejects, as
// the setup transport does.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));

const REPO = "C:/repo";

const READY: ForgeStatus = {
  provider: "gitlab",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "gitlab.com",
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
  // Only the list read and the create gate: every side read stays gated off.
  implemented: { issues: true, issueCreate: true } as ForgeImplemented,
};

function rows(count: number, state = "OPEN"): IssueInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    url: `https://gitlab.com/owner/repo/-/issues/${i + 1}`,
    title: `Issue ${i + 1}`,
    state,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    author: null,
    labels: [],
  }));
}

function savedAs(provider: "github" | "gitlab") {
  return {
    ...DEFAULT_SETTINGS,
    recentRepos: [
      {
        path: REPO,
        name: "repo",
        lastOpenedAt: "2026-01-01T00:00:00Z",
        provider,
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    throw new Error(`unmocked command: ${cmd}`);
  });
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "issues",
    selectedIssue: null,
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(gitRemotes).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(forgeIssueListPage).mockReset();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <IssuesPanel repoPath={REPO} />
    </QueryClientProvider>,
  );
  return client;
}

const pageStates = () =>
  vi.mocked(forgeIssueListPage).mock.calls.map((c) => c[1]);

describe("Issues panel at the GitLab horizon", () => {
  it("says the list stopped at its horizon and drops Load more", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("gitlab"));
    vi.mocked(forgeStatus).mockResolvedValue(READY);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(forgeIssueListPage).mockResolvedValue({
      rows: rows(100),
      capped: true,
    });
    renderPanel();
    expect(await screen.findByText("Showing the newest 100")).toBeVisible();
    expect(
      screen.getByText("Use Filters to reach older issues"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load 100 more/ })).toBeNull();
  });

  it("offers Load more on a full page that did not reach the horizon", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("gitlab"));
    vi.mocked(forgeStatus).mockResolvedValue(READY);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(forgeIssueListPage).mockResolvedValue({
      rows: rows(100),
      capped: false,
    });
    renderPanel();
    expect(
      await screen.findByRole("button", { name: /Load 100 more/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Use Filters to reach older/)).toBeNull();
  });

  it("never reads the horizon off a placeholder page", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("gitlab"));
    vi.mocked(forgeStatus).mockResolvedValue(READY);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(forgeIssueListPage).mockImplementation(async (_repo, state) =>
      state === "open"
        ? { rows: rows(100), capped: true }
        : new Promise<IssueListPage>(() => undefined),
    );
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Showing the newest 100");
    const group = screen.getByRole("group", { name: "Issue state" });
    await user.click(within(group).getByRole("button", { name: "Closed" }));
    await waitFor(() => expect(pageStates()).toContain("closed"));
    await act(async () => undefined);
    // The open page's rows stay up as the closed tab's placeholder, its flag not.
    expect(screen.getByText("Issue 1")).toBeInTheDocument();
    expect(screen.queryByText(/Use Filters to reach older/)).toBeNull();
    expect(screen.queryByText("Showing the newest 100")).toBeNull();
  });
});

describe("Issues panel in a repository with no remote", () => {
  const CAN_CREATE_GITHUB: ForgeStatus = {
    ...READY,
    provider: "github",
    host: "github.com",
  };
  const NO_REMOTE_REASON =
    "Add a GitHub or GitLab remote to open an issue here.";

  /** A menu item name that starts with `label`: a disabled item carries its
   *  reason after it. */
  const startsWith = (label: string) => (name: string) =>
    name.startsWith(label);

  async function newMenuForgeItem(
    user: ReturnType<typeof userEvent.setup>,
    name: string | ((name: string) => boolean),
  ) {
    await user.click(screen.getByRole("button", { name: "New" }));
    return screen.findByRole("menuitem", { name });
  }

  it("offers a neutral, disabled item that says which remote to add, and refuses the hotkey", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("github"));
    vi.mocked(forgeStatus).mockResolvedValue(CAN_CREATE_GITHUB);
    vi.mocked(gitRemotes).mockResolvedValue([]);
    vi.mocked(forgeIssueListPage).mockResolvedValue({
      rows: [],
      capped: false,
    });
    vi.mocked(gitRemotes).mockClear();
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    // The list is read only once the forge is ready, so the create gate is
    // open on the forge's side and only the missing remote can close it.
    await waitFor(() => expect(pageStates()).toContain("open"));
    await act(async () => undefined);
    expect(dispatchAction("create-issue")).toBe(false);
    const item = await newMenuForgeItem(user, startsWith("Remote issue…"));
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toHaveAttribute("title");
    expect(item).toHaveTextContent(NO_REMOTE_REASON);
    expect(item).toHaveAccessibleName(`Remote issue… — ${NO_REMOTE_REASON}`);
    expect(
      screen.queryByRole("menuitem", { name: startsWith("Issue on GitHub…") }),
    ).toBeNull();
  });

  it("refuses a create request handed over from elsewhere", async () => {
    vi.mocked(loadSettings).mockResolvedValue(savedAs("github"));
    vi.mocked(forgeStatus).mockResolvedValue(CAN_CREATE_GITHUB);
    vi.mocked(gitRemotes).mockClear().mockResolvedValue([]);
    vi.mocked(forgeIssueListPage).mockResolvedValue({
      rows: [],
      capped: false,
    });
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await waitFor(() => expect(pageStates()).toContain("open"));
    await act(async () => undefined);
    try {
      await act(async () => {
        useUiStore.setState({ pendingCreate: "issue" });
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
    vi.mocked(forgeStatus).mockResolvedValue(CAN_CREATE_GITHUB);
    vi.mocked(forgeIssueListPage).mockResolvedValue({
      rows: [],
      capped: false,
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(pageStates()).toContain("open"));
    await act(async () => undefined);
    const item = await newMenuForgeItem(user, "Issue on GitHub…");
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    expect(item.getAttribute("title") ?? "").not.toContain("remote");
  });

  it("keeps today's GitHub line with a remote on a host no forge claims", async () => {
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    // A settled answer that names no forge implements nothing.
    vi.mocked(forgeStatus).mockResolvedValue({
      ...CAN_CREATE_GITHUB,
      provider: null,
      implemented: {} as ForgeImplemented,
    } as unknown as ForgeStatus);
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
    await act(async () => undefined);
    const item = await newMenuForgeItem(user, startsWith("Issue on GitHub…"));
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toHaveAttribute("title");
    expect(item).toHaveAccessibleName(
      "Issue on GitHub… — Connect this repository to GitHub to open an issue.",
    );
  });
});

describe("issue writes over struct pages", () => {
  let seq = 0;
  let repo = "";
  let client: QueryClient;
  const pageKey = (state: string, filter: RemoteListFilter | null = null) => [
    ...repoKeys.issueList(repo),
    "origin",
    state,
    100,
    remoteListFilterKey(filter),
    "page",
  ];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    seq += 1;
    repo = `C:/repos/issue-cap-${seq}`;
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });
  afterEach(() => client.clear());

  it("re-files a closed row inside a struct page, keeping its flag", async () => {
    const page: IssueListPage = { rows: rows(3), capped: true };
    client.setQueryData(pageKey("open"), page);
    vi.mocked(invoke).mockImplementation(async () => null);
    const { result } = renderHook(() => useCloseIssue(repo, "origin"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ number: 2, reason: "completed" });
    });
    expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
    const after = client.getQueryData<IssueListPage>(pageKey("open"));
    expect(after?.capped).toBe(true);
    expect(after?.rows.map((r) => r.state)).toEqual(["OPEN", "CLOSED", "OPEN"]);
  });

  it("prepends a created issue into an open unfiltered struct page only", async () => {
    const open: IssueListPage = { rows: rows(100), capped: true };
    const filtered: IssueListPage = { rows: rows(2), capped: false };
    const closed: IssueListPage = { rows: rows(2, "CLOSED"), capped: false };
    const filter: RemoteListFilter = { assignedToMe: true };
    client.setQueryData(pageKey("open"), open);
    client.setQueryData(pageKey("open", filter), filtered);
    client.setQueryData(pageKey("closed"), closed);
    vi.mocked(invoke).mockImplementation(async () => ({
      number: 4242,
      url: "https://gitlab.com/owner/repo/-/issues/4242",
    }));
    const { result } = renderHook(() => useCreateIssue(repo, "origin"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        title: "New one",
        body: "",
        labels: [],
        assignees: [],
        milestone: null,
        type: null,
      });
    });
    expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
    const after = client.getQueryData<IssueListPage>(pageKey("open"));
    expect(after?.capped).toBe(true);
    expect(after?.rows).toHaveLength(100);
    expect(after?.rows[0]).toMatchObject({ number: 4242, state: "OPEN" });
    expect(after?.rows[99]?.number).toBe(99);
    expect(client.getQueryData(pageKey("open", filter))).toBe(filtered);
    expect(client.getQueryData(pageKey("closed"))).toBe(closed);
  });
});
