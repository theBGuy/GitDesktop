import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { AppCreateHotkeys } from "@/features/repository/AppCreateHotkeys";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  forgeStatus,
  gitBranches,
  gitCompareBranches,
  gitCreateBranch,
  gitDefaultBranch,
  gitFetchRemote,
  gitRemoteBranches,
  gitRemotes,
  gitStatus,
  gitTag,
} from "@/lib/git/api";
import type {
  Branch,
  CommitSummary,
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import type { ActionId } from "@/lib/hotkeys/registry";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

// The dialog's own props are what these tests pin, so a stub reports them.
vi.mock("@/features/pulls/CreatePrDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/pulls/CreatePrDialog")>()),
  CreatePrDialog: (p: {
    open: boolean;
    defaultBase?: string;
    preset?: { target: string };
    onOpenChange: (open: boolean) => void;
  }) => (
    <div
      data-testid="pr-dialog"
      data-open={String(p.open)}
      data-base={p.defaultBase ?? ""}
      data-target={p.preset?.target ?? ""}
    >
      {p.open && (
        <button type="button" onClick={() => p.onOpenChange(false)}>
          Close stub
        </button>
      )}
    </div>
  ),
}));
vi.mock("@/features/history/HistoryDialogs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/history/HistoryDialogs")
  >()),
  MergeParentDialog: (p: { target: { hash: string } | null }) => (
    <div data-testid="merge-parent-dialog" data-target={p.target?.hash ?? ""} />
  ),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitCompareBranches: vi.fn(),
  forgeStatus: vi.fn(),
  forgePrsForBranch: vi.fn(async () => []),
  gitFetchRemote: vi.fn(async () => undefined),
  gitCreateBranch: vi.fn(async () => undefined),
  gitTag: vi.fn(async () => undefined),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "C:/repo";

const GITHUB = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "me/project",
  host: "github.com",
  login: "me",
  capabilities: {},
  implemented: { mrCreate: true, pullRequests: true },
} as unknown as ForgeStatus;

const COMMIT = {
  hash: "b".repeat(40),
  shortHash: "bbbbbbb",
  subject: "ahead work",
  author: "me",
  date: new Date(Date.UTC(2026, 9, 1)).toISOString(),
  tags: [],
  isMerge: false,
} as unknown as CommitSummary;

const branch = (name: string, isCurrent = false) =>
  ({ name, isCurrent, archived: false, lastCommitDate: "" }) as Branch;

const remote = (r: string, name: string): RemoteBranch => ({
  remote: r,
  name,
  lastCommitDate: "",
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TabPanel active>
        <ComparePanel repoPath={REPO} />
      </TabPanel>
    </QueryClientProvider>,
  );
  return client;
}

const parentButton = () =>
  screen.findByRole("button", { name: /Create pull request in parent…/ });
const dialog = () => screen.getByTestId("pr-dialog");

const headOn = (name: string, detached: boolean) =>
  ({
    branch: { name, detached, upstreamRemote: null, upstreamBranch: null },
    files: [],
  }) as unknown as RepoStatus;

// Detaching HEAD swaps the main arm out; checking `feat` out again brings it
// back. `whileOut` runs in between.
async function swapArmOutAndBack(
  client: QueryClient,
  whileOut: () => void = () => undefined,
) {
  vi.mocked(gitStatus).mockResolvedValue(headOn("feat", true));
  await act(() =>
    client.refetchQueries({ queryKey: ["repo", REPO, "status"] }),
  );
  await screen.findByText("You're on a detached HEAD");
  act(whileOut);
  vi.mocked(gitStatus).mockResolvedValue(headOn("feat", false));
  await act(() =>
    client.refetchQueries({ queryKey: ["repo", REPO, "status"] }),
  );
}

// Read by selector: an open modal hides the rows from role queries.
const rowOf = (hash: string) => document.querySelector(`[data-row="${hash}"]`);
const aheadRow = (hash = COMMIT.hash) =>
  waitFor(() => {
    const found = rowOf(hash);
    if (!found) throw new Error("no ahead row");
    return found;
  });

// Each row: the menu item, the dialog's title, its field's label, its submit
// button, the command the submit runs and the toast that reports it.
const CREATE_REFS: [
  string,
  string,
  string,
  string,
  (...args: never[]) => Promise<void>,
  string,
][] = [
  [
    "Create branch from commit…",
    "Create branch from commit",
    "Branch name",
    "Create branch",
    gitCreateBranch,
    "Created branch",
  ],
  [
    "Create tag…",
    "Create tag",
    "Tag name",
    "Create tag",
    gitTag,
    "Created tag",
  ],
];

async function openCreateRef(item: string, title: string, hash: string) {
  const user = userEvent.setup();
  fireEvent.contextMenu(await aheadRow(hash));
  await user.click(await screen.findByRole("menuitem", { name: item }));
  expect(await screen.findByRole("dialog", { name: title })).toBeVisible();
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    repoPath: REPO,
    compareBranch: "refs/remotes/upstream/main",
    localPrCreate: null,
  });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: {
      name: "feat",
      detached: false,
      upstreamRemote: null,
      upstreamBranch: null,
    },
    files: [],
  } as unknown as RepoStatus);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", true),
    branch("main"),
    branch("dev"),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([remote("upstream", "main")]);
  vi.mocked(gitCompareBranches).mockResolvedValue({
    ahead: [COMMIT],
    behind: [],
  });
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
});

describe("Compare Create PR dialog latch", () => {
  it("keeps the target it opened with when the pick changes underneath", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await parentButton());
    expect(dialog()).toHaveAttribute("data-open", "true");
    expect(dialog()).toHaveAttribute("data-target", "upstream");
    act(() => useUiStore.setState({ compareBranch: "dev" }));
    await screen.findByRole("button", { name: /^Create pull request…/ });
    expect(dialog()).toHaveAttribute("data-target", "upstream");
    expect(dialog()).toHaveAttribute("data-base", "");
  });

  it("stays mounted after closing once its own button is gone", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await user.click(await parentButton());
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /Create pull request in parent…/,
          hidden: true,
        }),
      ).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "Close stub" }));
    expect(dialog()).toHaveAttribute("data-open", "false");
    expect(dialog()).toHaveAttribute("data-target", "upstream");
  });

  it("closes when the main arm swaps out and stays closed when it returns", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await user.click(await parentButton());
    expect(dialog()).toHaveAttribute("data-open", "true");
    vi.mocked(gitStatus).mockResolvedValue(headOn("feat", true));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "status"] }),
    );
    await screen.findByText("You're on a detached HEAD");
    vi.mocked(gitStatus).mockResolvedValue(headOn("dev", false));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "status"] }),
    );
    await parentButton();
    expect(screen.queryByRole("button", { name: "Close stub" })).toBeNull();
    expect(dialog()).toHaveAttribute("data-open", "false");
  });

  it("drops the latched target when the arm swaps out and the pick moves", async () => {
    const user = userEvent.setup();
    const client = renderPanel();
    await user.click(await parentButton());
    expect(dialog()).toHaveAttribute("data-target", "upstream");
    await swapArmOutAndBack(client, () =>
      useUiStore.setState({ compareBranch: "dev" }),
    );
    await screen.findByRole("button", { name: /^Create pull request…/ });
    expect(dialog()).toHaveAttribute("data-open", "false");
    expect(dialog()).toHaveAttribute("data-target", "");
  });

  it("closes the mainline-parent dialog when the arm swaps out", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue({
      ahead: [{ ...COMMIT, isMerge: true }],
      behind: [],
    });
    const user = userEvent.setup();
    const client = renderPanel();
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-row="${COMMIT.hash}"]`);
      if (!found) throw new Error("no ahead row");
      return found;
    });
    fireEvent.contextMenu(row);
    await user.click(
      await screen.findByRole("menuitem", { name: "Revert changes in commit" }),
    );
    const mergeDialog = () => screen.getByTestId("merge-parent-dialog");
    expect(mergeDialog()).toHaveAttribute("data-target", COMMIT.hash);
    await swapArmOutAndBack(client);
    await parentButton();
    expect(mergeDialog()).toHaveAttribute("data-target", "");
  });
});

describe("Compare create hotkeys", () => {
  // A local pick shows both create buttons, so both hotkeys are live.
  const localButton = () =>
    screen.findByRole("button", { name: /^Create pull request…/ });

  async function expectRefused(ids: ActionId[]) {
    // Lets the layout-effect registration settle on the held state.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    for (const id of ids) expect(dispatchAction(id)).toBe(false);
    expect(screen.queryByTestId("pr-dialog")?.dataset.open ?? "false").toBe(
      "false",
    );
    expect(useUiStore.getState().localPrCreate).toBeNull();
  }

  it("are refused while the comparison runs", async () => {
    vi.mocked(gitCompareBranches).mockReturnValue(new Promise(() => undefined));
    useUiStore.setState({ compareBranch: "main" });
    renderPanel();
    await waitFor(async () =>
      expect(await localButton()).toHaveAccessibleDescription("Comparing…"),
    );
    await expectRefused(["create-pr", "create-local-pr"]);
  });

  it("are refused while the comparison failed", async () => {
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("boom"));
    useUiStore.setState({ compareBranch: "main" });
    renderPanel();
    await waitFor(async () =>
      expect(await localButton()).toHaveAccessibleDescription(
        "Couldn't compare with main",
      ),
    );
    await expectRefused(["create-pr", "create-local-pr"]);
  });

  it("is refused while the pick's fetch runs", async () => {
    let finish!: () => void;
    vi.mocked(gitFetchRemote).mockReturnValue(
      new Promise<void>((r) => {
        finish = r;
      }),
    );
    useUiStore.setState({ compareBranch: "main" });
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole("combobox", { name: "Compare with branch" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /^upstream\/main/ }),
    );
    await waitFor(async () =>
      expect(await parentButton()).toHaveAccessibleDescription(
        "Fetching upstream…",
      ),
    );
    await expectRefused(["create-pr"]);
    // The single-flight map is module state.
    await act(async () => finish());
  });

  it("is refused while the pick is no longer in the remote branches", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/gone" });
    renderPanel();
    await waitFor(async () =>
      expect(await parentButton()).toHaveAccessibleDescription(
        "upstream/gone is no longer in your remote branches.",
      ),
    );
    await expectRefused(["create-pr"]);
  });

  it("is refused while the pick's remote is gone", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["upstream"]);
    useUiStore.setState({ compareBranch: "refs/remotes/origin/x" });
    renderPanel();
    await waitFor(async () =>
      expect(
        await screen.findByRole("button", { name: /^Create pull request/ }),
      ).toHaveAccessibleDescription("origin is no longer a remote."),
    );
    await expectRefused(["create-pr"]);
  });

  it("run once the comparison answers", async () => {
    useUiStore.setState({ compareBranch: "main" });
    renderPanel();
    await waitFor(async () =>
      expect(await localButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    act(() => {
      expect(dispatchAction("create-local-pr")).toBe(true);
    });
    expect(useUiStore.getState().localPrCreate).not.toBeNull();
    act(() => {
      expect(dispatchAction("create-pr")).toBe(true);
    });
    expect(dialog()).toHaveAttribute("data-open", "true");
  });
});

describe("Compare create hotkeys while Create is held (contract)", () => {
  beforeEach(() => {
    useUiStore.setState({
      compareBranch: "main",
      repoTab: "compare",
      pendingCreate: null,
    });
  });

  // The app entries mount before the panel, as in RepositoryView; `appAfter`
  // mounts them after it, so in a shared commit they register last. Either way
  // their fallback tier leaves the action to the panel's enabled entry.
  function renderWithApp(
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    appAfter = false,
  ) {
    const app = <AppCreateHotkeys repoPath={REPO} />;
    render(
      <QueryClientProvider client={client}>
        {appAfter ? null : app}
        <TabPanel active>
          <ComparePanel repoPath={REPO} />
        </TabPanel>
        {appAfter ? app : null}
      </QueryClientProvider>,
    );
    return client;
  }

  const MOUNT_ORDERS = [
    ["the app entries mounted first", false],
    ["the app entries mounted last", true],
  ] as const;

  const forgeKey = ["repo", REPO, "forge-status"];
  const forgeAnswered = (client: QueryClient) =>
    waitFor(() =>
      expect(client.getQueryState(forgeKey)?.status).toBe("success"),
    );

  // Without a forge that creates pull requests it reads "Create local PR…".
  const localButton = (name = /^Create pull request…/) =>
    screen.findByRole("button", { name });

  // Waits for the forge read too, so the app gate is settled when it acts.
  async function heldOnComparing(client: QueryClient, name?: RegExp) {
    await forgeAnswered(client);
    await waitFor(async () =>
      expect(await localButton(name)).toHaveAccessibleDescription("Comparing…"),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }

  const dialogOpen = () =>
    screen.queryByTestId("pr-dialog")?.dataset.open ?? "false";

  it("hands create-pr to the app entry while the forge can create one", async () => {
    vi.mocked(gitCompareBranches).mockReturnValue(new Promise(() => undefined));
    const client = renderWithApp();
    await heldOnComparing(client);
    act(() => {
      expect(dispatchAction("create-pr")).toBe(true);
    });
    expect(useUiStore.getState().repoTab).toBe("pulls");
    expect(useUiStore.getState().pendingCreate).toBe("pr");
    expect(dialogOpen()).toBe("false");
  });

  it("hands create-local-pr to the app entry", async () => {
    vi.mocked(gitCompareBranches).mockReturnValue(new Promise(() => undefined));
    const client = renderWithApp();
    await heldOnComparing(client);
    act(() => {
      expect(dispatchAction("create-local-pr")).toBe(true);
    });
    expect(useUiStore.getState().repoTab).toBe("pulls");
    expect(useUiStore.getState().pendingCreate).toBe("local-pr");
    expect(useUiStore.getState().localPrCreate).toBeNull();
  });

  it("runs nothing for create-pr when no entry is enabled", async () => {
    vi.mocked(gitCompareBranches).mockReturnValue(new Promise(() => undefined));
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      implemented: { pullRequests: true },
    } as ForgeStatus);
    const client = renderWithApp();
    await heldOnComparing(client, /^Create local PR…/);
    act(() => {
      expect(dispatchAction("create-pr")).toBe(false);
    });
    expect(useUiStore.getState().repoTab).toBe("compare");
    expect(useUiStore.getState().pendingCreate).toBeNull();
    expect(dialogOpen()).toBe("false");
    act(() => {
      expect(dispatchAction("create-local-pr")).toBe(true);
    });
    expect(useUiStore.getState().repoTab).toBe("pulls");
    expect(useUiStore.getState().pendingCreate).toBe("local-pr");
  });

  it("keeps both on Compare once the comparison answers", async () => {
    const client = renderWithApp();
    await forgeAnswered(client);
    await waitFor(async () =>
      expect(await localButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    act(() => {
      expect(dispatchAction("create-local-pr")).toBe(true);
    });
    expect(useUiStore.getState().localPrCreate).not.toBeNull();
    act(() => {
      expect(dispatchAction("create-pr")).toBe(true);
    });
    expect(dialogOpen()).toBe("true");
    expect(useUiStore.getState().repoTab).toBe("compare");
    expect(useUiStore.getState().pendingCreate).toBeNull();
  });

  it("hands both to the app entries while the main arm is swapped out", async () => {
    const client = renderWithApp();
    await forgeAnswered(client);
    await waitFor(async () =>
      expect(await localButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
    // The pick is archived and was the last alternative: the empty arm shows
    // while the pick and its cached comparison survive.
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", true),
      { ...branch("main"), archived: true },
    ]);
    vi.mocked(gitRemoteBranches).mockResolvedValue([]);
    // The remote read is off while a local branch is offered: marked stale
    // now, it re-reads when the archive turns it on.
    await act(() =>
      client.invalidateQueries({ queryKey: ["repo", REPO, "remote-branches"] }),
    );
    await act(() => client.refetchQueries({ queryKey: ["repo", REPO] }));
    await screen.findByText("No other branches");
    expect(useUiStore.getState().compareBranch).toBe("main");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    act(() => {
      expect(dispatchAction("create-local-pr")).toBe(true);
    });
    expect(useUiStore.getState().pendingCreate).toBe("local-pr");
    expect(useUiStore.getState().localPrCreate).toBeNull();
    act(() => useUiStore.setState({ pendingCreate: null, repoTab: "compare" }));
    act(() => {
      expect(dispatchAction("create-pr")).toBe(true);
    });
    expect(useUiStore.getState().pendingCreate).toBe("pr");
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", true),
      branch("main"),
    ]);
    await act(() => client.refetchQueries({ queryKey: ["repo", REPO] }));
    await localButton();
    expect(dialogOpen()).toBe("false");
  });

  it.each(MOUNT_ORDERS)(
    "keeps create-pr on Compare when the forge answers after the comparison, %s",
    async (_, appAfter) => {
      let answerForge!: (status: ForgeStatus) => void;
      vi.mocked(forgeStatus).mockReturnValueOnce(
        new Promise((resolve) => {
          answerForge = resolve;
        }),
      );
      const client = renderWithApp(undefined, appAfter);
      // The comparison has landed (its ahead row shows) while the forge is held.
      await aheadRow();
      expect(client.getQueryState(forgeKey)?.status).toBe("pending");
      // Both gates read the forge status, so they flip in this one commit.
      await act(async () => answerForge(GITHUB));
      // Lets react-query's batched notify timer flush that commit.
      await act(() => new Promise((r) => setTimeout(r, 20)));
      act(() => {
        expect(dispatchAction("create-pr")).toBe(true);
      });
      expect(dialogOpen()).toBe("true");
      expect(useUiStore.getState().repoTab).toBe("compare");
      expect(useUiStore.getState().pendingCreate).toBeNull();
    },
  );

  it.each(MOUNT_ORDERS)(
    "keeps both on Compare when both are enabled in the mount commit, %s",
    async (_, appAfter) => {
      const warm = renderWithApp(undefined, appAfter);
      await forgeAnswered(warm);
      await waitFor(async () =>
        expect(await localButton()).not.toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
      cleanup();
      renderWithApp(warm, appAfter);
      act(() => {
        expect(dispatchAction("create-local-pr")).toBe(true);
      });
      expect(useUiStore.getState().localPrCreate).not.toBeNull();
      act(() => {
        expect(dispatchAction("create-pr")).toBe(true);
      });
      expect(dialogOpen()).toBe("true");
      expect(useUiStore.getState().repoTab).toBe("compare");
      expect(useUiStore.getState().pendingCreate).toBeNull();
      // The remount's ScrollArea timer lands after the assertions.
      await act(() => new Promise((r) => setTimeout(r, 20)));
    },
  );

  it.each(MOUNT_ORDERS)(
    "keeps create-pr on Compare across a forge readiness flip, %s",
    async (_, appAfter) => {
      const client = renderWithApp(undefined, appAfter);
      await forgeAnswered(client);
      await waitFor(async () =>
        expect(await localButton()).not.toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
      await act(() => new Promise((r) => setTimeout(r, 20)));
      // Both gates read this one forge status, so each flip re-registers both.
      const notReady = { ...GITHUB, implemented: { pullRequests: true } };
      act(() => client.setQueryData(forgeKey, notReady as ForgeStatus));
      await localButton(/^Create local PR…/);
      await act(() => new Promise((r) => setTimeout(r, 20)));
      act(() => client.setQueryData(forgeKey, GITHUB));
      await localButton();
      await act(() => new Promise((r) => setTimeout(r, 20)));
      act(() => {
        expect(dispatchAction("create-pr")).toBe(true);
      });
      expect(dialogOpen()).toBe("true");
      expect(useUiStore.getState().repoTab).toBe("compare");
      expect(useUiStore.getState().pendingCreate).toBeNull();
    },
  );
});

describe("Compare create-ref dialogs across a repository switch", () => {
  const OTHER = "C:/other";

  function mount(repo: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (shown: string) => (
      <QueryClientProvider client={client}>
        <TabPanel active>
          <ComparePanel repoPath={shown} />
        </TabPanel>
      </QueryClientProvider>
    );
    const view = render(ui(repo));
    return { client, show: (shown: string) => view.rerender(ui(shown)) };
  }

  // A switch remounts the keyed commit menu's list, whose scroll area settles
  // on a timer; let it land inside act before the test ends.
  const flushRemount = () => act(() => new Promise((r) => setTimeout(r, 20)));

  // OTHER is read first (the git mocks ignore the repository), so a later
  // switch to it serves every read from the cache and the main arm never
  // leaves: only the repository guard can close a dialog there.
  async function mountWarm() {
    const app = mount(OTHER);
    await aheadRow();
    app.show(REPO);
    await aheadRow();
    return app;
  }

  it.each(CREATE_REFS)(
    "%s closes on a repo switch and stays closed",
    async (item, title) => {
      const app = mount(REPO);
      await openCreateRef(item, title, COMMIT.hash);
      for (const repo of [OTHER, REPO]) {
        app.show(repo);
        await aheadRow();
        await waitFor(() =>
          expect(screen.queryByRole("dialog", { name: title })).toBeNull(),
        );
      }
    },
  );

  it.each(CREATE_REFS)(
    "%s closes on a switch to a cached repo",
    async (item, title) => {
      const app = await mountWarm();
      await openCreateRef(item, title, COMMIT.hash);
      act(() => app.show(OTHER));
      expect(rowOf(COMMIT.hash)).not.toBeNull();
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: title })).toBeNull(),
      );
    },
  );

  it.each(CREATE_REFS)(
    "%s keeps its typed name across an arm swap in one repo",
    async (item, title, field) => {
      const app = mount(REPO);
      await openCreateRef(item, title, COMMIT.hash);
      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox", { name: field }), "topic");
      await swapArmOutAndBack(app.client);
      expect(await screen.findByRole("dialog", { name: title })).toBeVisible();
      expect(screen.getByRole("textbox", { name: field })).toHaveValue("topic");
    },
  );

  it("closes the mainline-parent dialog on a switch to a cached repo", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue({
      ahead: [{ ...COMMIT, isMerge: true }],
      behind: [],
    });
    const app = await mountWarm();
    const user = userEvent.setup();
    fireEvent.contextMenu(await aheadRow());
    await user.click(
      await screen.findByRole("menuitem", { name: "Revert changes in commit" }),
    );
    const mergeDialog = () => screen.getByTestId("merge-parent-dialog");
    expect(mergeDialog()).toHaveAttribute("data-target", COMMIT.hash);
    act(() => app.show(OTHER));
    expect(rowOf(COMMIT.hash)).not.toBeNull();
    expect(mergeDialog()).toHaveAttribute("data-target", "");
    await flushRemount();
  });

  it("closes an open commit menu on a switch to a cached repo", async () => {
    const app = await mountWarm();
    fireEvent.contextMenu(await aheadRow());
    expect(
      await screen.findByRole("menuitem", { name: "Create tag…" }),
    ).toBeInTheDocument();
    act(() => app.show(OTHER));
    expect(rowOf(COMMIT.hash)).not.toBeNull();
    expect(screen.queryAllByRole("menuitem", { hidden: true })).toEqual([]);
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    await flushRemount();
  });
});

describe("Compare create-ref dialogs when a create settles", () => {
  const SECOND = {
    ...COMMIT,
    hash: "c".repeat(40),
    subject: "more ahead work",
  } as CommitSummary;

  beforeEach(() => {
    vi.mocked(gitCompareBranches).mockResolvedValue({
      ahead: [COMMIT, SECOND],
      behind: [],
    });
    vi.spyOn(toast, "success");
  });

  // The next submit's command stays pending until the returned settle runs.
  function holdNext(command: (...args: never[]) => Promise<void>) {
    let settle!: () => void;
    vi.mocked(command).mockReturnValueOnce(
      new Promise<void>((r) => {
        settle = r;
      }),
    );
    return settle;
  }

  async function submitHeld(
    item: string,
    title: string,
    field: string,
    submit: string,
    command: (...args: never[]) => Promise<void>,
  ) {
    const settle = holdNext(command);
    renderPanel();
    await openCreateRef(item, title, COMMIT.hash);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: field }), "first");
    await user.click(screen.getByRole("button", { name: submit }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    return { user, settle };
  }

  // Waits past the settle's toast, so a close it ran has had time to land.
  async function settleAndReport(settle: () => void, toastLine: string) {
    await act(async () => settle());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`${toastLine} first`),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }

  it.each(CREATE_REFS)(
    "%s closes when its own create settles",
    async (item, title, field, submit, command, toastLine) => {
      const { settle } = await submitHeld(item, title, field, submit, command);
      await settleAndReport(settle, toastLine);
      expect(screen.queryByRole("dialog", { name: title })).toBeNull();
    },
  );

  // Submits "first" on the first commit, cancels, reopens on `reopenOn` and
  // types "second" before the held create settles.
  async function reopenThenSettle(
    [item, title, field, submit, command, toastLine]: (typeof CREATE_REFS)[0],
    reopenOn: string,
  ) {
    const { user, settle } = await submitHeld(
      item,
      title,
      field,
      submit,
      command,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: title })).toBeNull(),
    );
    await openCreateRef(item, title, reopenOn);
    await user.type(screen.getByRole("textbox", { name: field }), "second");
    await settleAndReport(settle, toastLine);
    expect(screen.getByRole("dialog", { name: title })).toHaveTextContent(
      reopenOn.slice(0, 7),
    );
    expect(screen.getByRole("textbox", { name: field })).toHaveValue("second");
  }

  it.each(CREATE_REFS)(
    "%s settling late leaves a dialog reopened on another commit open",
    (...row) => reopenThenSettle(row, SECOND.hash),
  );

  it.each(CREATE_REFS)(
    "%s settling late leaves a dialog reopened on the same commit open",
    (...row) => reopenThenSettle(row, COMMIT.hash),
  );
});
