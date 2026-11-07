import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  forgeStatus,
  gitBranches,
  gitCompareBranches,
  gitDefaultBranch,
  gitFetchRemote,
  gitRemoteBranches,
  gitRemotes,
  gitStatus,
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

  it("is refused while the pick was deleted on its remote", async () => {
    useUiStore.setState({ compareBranch: "refs/remotes/upstream/gone" });
    renderPanel();
    await waitFor(async () =>
      expect(await parentButton()).toHaveAccessibleDescription(
        "upstream/gone was deleted on upstream.",
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
