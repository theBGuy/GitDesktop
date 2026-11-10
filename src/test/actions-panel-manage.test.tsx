import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ActionsPanel } from "@/features/actions/ActionsPanel";
import {
  forgeRepoUrl,
  forgeRepoWriteAccess,
  forgeStatus,
  gitStatus,
} from "@/lib/git/api";
import type { ForgeStatus, RepoStatus } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { unmockedCommands } from "./setup";

const empty = vi.hoisted(() => ({
  data: {
    pages: [{ runs: [], totalCount: 0, hasMore: false }],
    pageParams: [1],
  },
  isPending: false,
  isSuccess: true,
  isError: false,
  isPaused: false,
  isFetching: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  isPlaceholderData: false,
  hasNextPage: false,
  refetch: () => Promise.resolve(),
  fetchNextPage: () => Promise.resolve(),
}));

vi.mock("@/lib/github/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/actions")>()),
  useWorkflowRunPages: () => empty,
  useWorkflows: () => ({
    data: [],
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  gitStatus: vi.fn(),
  forgeRepoWriteAccess: vi.fn(),
  forgeRepoUrl: vi.fn(),
}));

// The opener plugin calls Tauri directly, past the test transport.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterAll(() => expect(unmockedCommands).toEqual([]));

function forge(provider: "github" | "gitlab" | "bitbucket"): ForgeStatus {
  return {
    provider,
    installed: true,
    authenticated: true,
    repo: "o/r",
    host: `${provider}.com`,
    login: "me",
    capabilities: {},
    implemented: { ci: true, ciDispatch: true, ciRerun: true, ciCancel: true },
  } as unknown as ForgeStatus;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ActionsPanel repoPath="C:/a" active />
    </QueryClientProvider>,
  );
}

async function openManage(label: string) {
  const user = userEvent.setup();
  renderPanel();
  await user.click(await screen.findByRole("button", { name: label }));
  return { user, menu: await screen.findByRole("menu") };
}

beforeEach(() => {
  vi.mocked(forgeStatus).mockResolvedValue(forge("github"));
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "main" },
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(forgeRepoWriteAccess).mockResolvedValue({
    canPush: true,
  } as never);
  vi.mocked(forgeRepoUrl).mockResolvedValue("https://github.com/o/r");
  vi.mocked(openUrl).mockReset();
});

afterEach(() => cleanup());

describe("Manage menu", () => {
  it("GitHub: six provider-named link-outs, Runners marked for admins", async () => {
    const { menu } = await openManage("Open on GitHub");
    expect(screen.getByRole("group", { name: "Open on GitHub" })).toBe(
      menu.querySelector('[role="group"]'),
    );
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual([
      "Caches",
      "Deployments",
      "Attestations",
      "RunnersAdmins",
      "Actions usage",
      "Actions performance",
    ]);
  });

  it("GitLab: four rows under Open on GitLab", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    await openManage("Open on GitLab");
    expect(
      screen.getByRole("group", { name: "Open on GitLab" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("Bitbucket: two rows under Open on Bitbucket", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("bitbucket"));
    await openManage("Open on Bitbucket");
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("an unknown provider renders no Manage trigger", async () => {
    vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await screen.findByRole("button", { name: "Refresh runs" });
    expect(
      screen.queryByRole("button", { name: /^Open on/ }),
    ).not.toBeInTheDocument();
  });

  it("a row opens the repo's page on the forge", async () => {
    const { user } = await openManage("Open on GitHub");
    await user.click(screen.getByRole("menuitem", { name: "Caches" }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://github.com/o/r/actions/caches",
      ),
    );
  });

  it("the palette opens a link of the detected provider only", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Open on GitHub" });
    expect(dispatchAction("open-actions-gitlab-pipelines")).toBe(false);
    act(() => {
      expect(dispatchAction("open-actions-github-runners")).toBe(true);
    });
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://github.com/o/r/settings/actions/runners",
      ),
    );
  });

  it("the Run button keeps its name for when its label hides", async () => {
    renderPanel();
    const runButton = await screen.findByRole("button", {
      name: "Run workflow…",
    });
    expect(runButton.className).toContain(
      "@max-[292px]/actions-toolbar:*:data-[slot=run-label]:hidden",
    );
    expect(
      runButton.querySelector('[data-slot="run-label"]'),
    ).toHaveTextContent("Run workflow…");
  });
});
