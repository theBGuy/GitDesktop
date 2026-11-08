import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAddUpstreamOffer } from "@/features/pulls/AddUpstreamOffer";
import { RepositoryMenu } from "@/features/repository/RepositoryMenu";
import {
  forgeStatus,
  gitFetchRemote,
  gitRemoteAdd,
  gitRemotes,
} from "@/lib/git/api";
import { remoteBranchesOptions } from "@/lib/git/queries";
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
  gitFetchRemote: vi.fn(),
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

/** The offer as the hook last rendered it, for the hosts' failed/Retry arm. */
let offer!: ReturnType<typeof useAddUpstreamOffer>;
function OfferProbe() {
  offer = useAddUpstreamOffer(REPO);
  return null;
}

function renderMenu() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RepositoryMenu repoPath={REPO} />
      <OfferProbe />
    </QueryClientProvider>,
  );
  return client;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemoteAdd).mockResolvedValue(undefined);
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
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

  /** Re-reads the remote-branch list, clearing any earlier invalidation, so a
   *  later flag can only come from the palette's own post-fetch refresh. */
  async function reseedRemoteBranches(client: QueryClient) {
    await act(() =>
      client.prefetchQuery({
        ...remoteBranchesOptions(REPO),
        queryFn: async () => [],
      }),
    );
    expect(
      client.getQueryState(remoteBranchesOptions(REPO).queryKey)?.isInvalidated,
    ).toBe(false);
  }

  /** The Retry action of the newest fetch-failure toast. */
  function fetchRetry() {
    const call = vi
      .mocked(toast.error)
      .mock.calls.filter(
        ([title]) =>
          title === "Added the upstream remote, but couldn't fetch it",
      )
      .at(-1);
    const action = (
      call?.[1] as { action?: { label: string; onClick: () => void } }
    )?.action;
    expect(action?.label).toBe("Retry");
    return action as { label: string; onClick: () => void };
  }

  it("fetches the new remote once the add lands and refreshes remote branches", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    let finish!: () => void;
    vi.mocked(gitRemoteAdd).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let fetched!: () => void;
    vi.mocked(gitFetchRemote).mockReturnValue(
      new Promise<void>((resolve) => {
        fetched = resolve;
      }),
    );
    const client = renderMenu();
    const remoteBranchesKey = remoteBranchesOptions(REPO).queryKey;
    await reseedRemoteBranches(client);
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalled());
    await settle();
    expect(gitFetchRemote).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() =>
      expect(gitFetchRemote).toHaveBeenCalledWith(REPO, "upstream"),
    );
    // The add's own settle already flagged the list; re-read it while the
    // fetch is held, so only the post-fetch refresh can flag it again.
    await reseedRemoteBranches(client);
    await settle();
    expect(client.getQueryState(remoteBranchesKey)?.isInvalidated).toBe(false);
    await act(async () => fetched());
    await waitFor(() =>
      expect(client.getQueryState(remoteBranchesKey)?.isInvalidated).toBe(true),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports the add and a separate fetch failure", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(gitFetchRemote).mockRejectedValue({
      message: "could not resolve host",
    });
    renderMenu();
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Added the upstream remote, but couldn't fetch it",
        expect.anything(),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Upstream remote added");
  });

  it("retries a failed fetch from its toast until it lands", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(gitFetchRemote).mockRejectedValue({
      message: "could not resolve host",
    });
    const client = renderMenu();
    const remoteBranchesKey = remoteBranchesOptions(REPO).queryKey;
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // A retry that fails again offers Retry again.
    act(() => fetchRetry().onClick());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(gitFetchRemote).toHaveBeenCalledTimes(2);

    vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
    await reseedRemoteBranches(client);
    act(() => fetchRetry().onClick());
    await waitFor(() => expect(gitFetchRemote).toHaveBeenCalledTimes(3));
    expect(gitFetchRemote).toHaveBeenLastCalledWith(REPO, "upstream");
    await waitFor(() =>
      expect(client.getQueryState(remoteBranchesKey)?.isInvalidated).toBe(true),
    );
    await settle();
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it("never fetches after a failed add", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(gitRemoteAdd).mockRejectedValue({ message: "add failed" });
    renderMenu();
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await settle();
    expect(gitFetchRemote).not.toHaveBeenCalled();
  });

  it("withdraws the offer while the remotes refresh after an add runs", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    renderMenu();
    // Once offered, every remotes re-read is held.
    await waitFor(() => expect(offer.canOffer).toBe(true));
    let refresh!: (remotes: string[]) => void;
    vi.mocked(gitRemotes).mockReturnValue(
      new Promise((resolve) => {
        refresh = resolve;
      }),
    );
    expect(dispatchAction("add-upstream-remote")).toBe(true);
    await waitFor(() => expect(gitFetchRemote).toHaveBeenCalled());
    await settle();
    expect(dispatchAction("add-upstream-remote")).toBe(false);
    expect(gitRemoteAdd).toHaveBeenCalledTimes(1);
    await act(async () => refresh(["origin", "upstream"]));
  });

  it("withholds the offer over a failed forge refresh until a read succeeds", async () => {
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      host: "ghe.example.com",
    });
    const client = renderMenu();
    await waitFor(() => expect(offer.canOffer).toBe(true));
    vi.mocked(forgeStatus).mockRejectedValue(new Error("forge boom"));
    await act(() =>
      client
        .refetchQueries({ queryKey: ["repo", REPO, "forge-status"] })
        .catch(() => undefined),
    );
    await waitFor(() => expect(offer.failed).toBe(true));
    expect(offer.canOffer).toBe(false);
    expect(offer.failedOnForgeOnly).toBe(true);
    expect(dispatchAction("add-upstream-remote")).toBe(false);

    // Origin was re-pointed meanwhile: the add takes the recovered read's host.
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      host: "ghe2.example.com",
    });
    act(() => offer.retry());
    await waitFor(() =>
      expect(dispatchAction("add-upstream-remote")).toBe(true),
    );
    await waitFor(() =>
      expect(gitRemoteAdd).toHaveBeenCalledWith(
        REPO,
        "upstream",
        "https://ghe2.example.com/octo/project.git",
      ),
    );
  });
});
