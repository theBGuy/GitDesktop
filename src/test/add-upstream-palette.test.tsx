import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryMenu } from "@/features/repository/RepositoryMenu";
import { forgeStatus, gitRemoteAdd, gitRemotes } from "@/lib/git/api";
import type { ForgeStatus } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { toastError, toastErrorWithNote } from "@/lib/toast";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
  toastErrorWithNote: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteAdd: vi.fn(),
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
  implemented: {},
} as unknown as ForgeStatus;

const FORK_SETTINGS = {
  ...DEFAULT_SETTINGS,
  recentRepos: [{ path: REPO, isFork: true, forkParent: "octo/project" }],
} as unknown as typeof DEFAULT_SETTINGS;

function renderMenu() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RepositoryMenu repoPath={REPO} />
    </QueryClientProvider>,
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemoteAdd).mockResolvedValue(undefined);
});

describe("Add upstream remote palette command", () => {
  it("adds the parent as upstream on a fork without it", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    renderMenu();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() =>
      expect(gitRemoteAdd).toHaveBeenCalledWith(
        REPO,
        "upstream",
        "https://github.com/octo/project.git",
      ),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Upstream remote added"),
    );
  });

  it("names the repo the add landed in once the user switched away", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    let finish!: () => void;
    vi.mocked(gitRemoteAdd).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    renderMenu();
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalled());
    useUiStore.setState({ repoPath: "C:/other" });
    await act(async () => finish());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Upstream remote added in repo",
      ),
    );
  });

  it("names the repo a failed add was for once the user switched away", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    let fail!: (e: unknown) => void;
    vi.mocked(gitRemoteAdd).mockReturnValue(
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
    );
    renderMenu();
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalled());
    useUiStore.setState({ repoPath: "C:/other" });
    const error = { message: "remote upstream already exists" };
    await act(async () => fail(error));
    await waitFor(() =>
      expect(toastErrorWithNote).toHaveBeenCalledWith(error, "In repo"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("refuses a second run while the first add is pending", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    let finish!: () => void;
    vi.mocked(gitRemoteAdd).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    renderMenu();
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(1));
    await settle();
    dispatchAction("add-upstream-remote");
    await settle();
    expect(gitRemoteAdd).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    await settle();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("stays unavailable once the remote exists", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    renderMenu();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    await settle();
    expect(dispatchAction("add-upstream-remote")).toBe(false);
    expect(gitRemoteAdd).not.toHaveBeenCalled();
  });
});
