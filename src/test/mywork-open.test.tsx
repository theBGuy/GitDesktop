import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import { forgePrHeadRef, repoOriginPath, validateRepo } from "@/lib/git/api";
import type { MyWorkItem, RepoInfo, RepoOrigin } from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { lensKey } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

/** The sources every case starts from; the beforeEach restores them. */
const DEFAULT_SOURCES = { github: true, gitlab: false, bitbucket: false };
const data = vi.hoisted(() => ({
  items: [] as MyWorkItem[],
  recents: [] as RecentRepo[],
  // Which sources are on, and which forge leg serves `items`.
  sources: { github: true, gitlab: false, bitbucket: false },
  leg: "github",
}));

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useMyWorkSources: () => ({
    data: data.sources,
    isPending: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useForgeMyWork: (provider: string) =>
    provider === data.leg
      ? {
          data: { items: data.items, truncated: false },
          isPending: false,
          isSuccess: true,
          isError: false,
          isPaused: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        }
      : {
          data: undefined,
          isPending: true,
          isSuccess: false,
          isError: false,
          isPaused: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        },
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: { recentRepos: data.recents } }),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
  repoOriginPath: vi.fn(),
  forgePrHeadRef: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
// Every click here claims and is checked by its own generation; the claim
// ordering itself is pinned by scripts/mywork-open-claim.test.mjs.
vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/repository/useOpenRepoByPath")
  >()),
  claimRepoOpen: () => () => true,
}));
// `isWindows` and `isMac` are read once at import, and jsdom's empty platform
// reads as neither: getters let a case pick the platform.
const platformIs = vi.hoisted(() => ({ windows: false, mac: false }));
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  get isWindows() {
    return platformIs.windows;
  },
  get isMac() {
    return platformIs.mac;
  },
}));
// The opener plugin calls Tauri directly, past the test transport.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const validate = vi.mocked(validateRepo);
const origin = vi.mocked(repoOriginPath);
const headRef = vi.mocked(forgePrHeadRef);
const worktrees = vi.mocked(listUserWorktrees);
const opened = vi.mocked(openUrl);
const openPr = vi.fn();
const openIssue = vi.fn();

const item = (
  repoName: string,
  number: number,
  isPullRequest: boolean,
  updatedAt: string,
): MyWorkItem => ({
  number,
  title: `${repoName} ${number}`,
  isPullRequest,
  isDraft: false,
  repoFullName: `acme/${repoName}`,
  repoOwner: "acme",
  repoName,
  host: "github.com",
  url: `https://github.com/acme/${repoName}/${isPullRequest ? "pull" : "issues"}/${number}`,
  updatedAt,
  provider: "github",
});

const recent = (repoName: string): RecentRepo => ({
  path: `C:/src/${repoName}`,
  name: repoName,
  lastOpenedAt: "2026-01-01T00:00:00Z",
  host: "github.com",
  owner: "acme",
  repoName,
  provider: "github",
});

const proven = (path: string): RepoOrigin => ({
  host: "github.com",
  authority: "github.com",
  path: `acme/${path.split("/").at(-1)}`,
  provider: "github",
});

const never = <T,>() => new Promise<T>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  data.sources = { ...DEFAULT_SOURCES };
  data.leg = "github";
  platformIs.windows = false;
  platformIs.mac = false;
  validate.mockReset().mockImplementation(
    async (p): Promise<RepoInfo> => ({
      root: p,
      name: p.split("/").at(-1) ?? p,
    }),
  );
  origin.mockReset().mockImplementation(async (p) => proven(p));
  headRef.mockReset();
  worktrees.mockReset().mockResolvedValue([]);
  opened.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.error).mockReset();
  vi.mocked(toastError).mockReset();
  openPr.mockReset();
  openIssue.mockReset();
  useUiStore.setState({ view: "mywork", openPr, openIssue });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderScreen(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  render(
    <QueryClientProvider client={client}>
      <MyWorkScreen />
    </QueryClientProvider>,
  );
  const input = screen.getByRole("combobox", { name: "Filter your work" });
  input.focus();
  return input;
}

/** The spoken wait: the screen's one sr-only status element. */
const spoken = () => {
  const el = document.querySelector('[role="status"].sr-only');
  if (!el) throw new Error("the wait's status element is not mounted");
  return el.textContent;
};

/** ArrowDown to the next row, then Enter on it, as a keyboard user opens one. */
function openNext(input: HTMLElement) {
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("My work open", () => {
  it("S1: a PR whose folder check never settles speaks its wait, then opens the browser at the budget", async () => {
    const pr = item("widgets", 12, true, "2026-01-02T00:00:00Z");
    data.items = [pr];
    data.recents = [recent("widgets")];
    validate.mockImplementation(() => never());
    const input = renderScreen();
    expect(spoken()).toBe("");
    openNext(input);
    await advance(299);
    expect(spoken()).toBe("");
    await advance(1);
    expect(spoken()).toBe("Opening widgets pull request 12\u2026");
    expect(input).toHaveFocus();
    await advance(1200);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(pr.url);
    expect(openPr).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(origin).not.toHaveBeenCalled();
    expect(spoken()).toBe("");
  });

  it("S2: an issue's wait names the issue", async () => {
    data.items = [item("widgets", 7, false, "2026-01-02T00:00:00Z")];
    data.recents = [recent("widgets")];
    validate.mockImplementation(() => never());
    const input = renderScreen();
    openNext(input);
    await advance(300);
    expect(spoken()).toBe("Opening widgets issue 7\u2026");
    await advance(1200);
    expect(openIssue).not.toHaveBeenCalled();
    expect(spoken()).toBe("");
  });

  it("S3: a newer open clears the older wait at once and the older settle never touches it", async () => {
    const a = item("alpha", 1, true, "2026-01-03T00:00:00Z");
    const b = item("beta", 2, true, "2026-01-02T00:00:00Z");
    data.items = [a, b];
    data.recents = [recent("alpha"), recent("beta")];
    let settleA: (info: RepoInfo) => void = () => undefined;
    validate.mockImplementation((p) =>
      p === "C:/src/alpha"
        ? new Promise<RepoInfo>((resolve) => {
            settleA = resolve;
          })
        : never(),
    );
    const input = renderScreen();
    openNext(input);
    await advance(300);
    expect(spoken()).toBe("Opening alpha pull request 1\u2026");
    openNext(input);
    expect(spoken()).toBe("");
    await advance(299);
    expect(spoken()).toBe("");
    await advance(1);
    expect(spoken()).toBe("Opening beta pull request 2\u2026");
    await act(async () => {
      settleA({ root: "C:/src/alpha", name: "alpha" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(spoken()).toBe("Opening beta pull request 2\u2026");
    expect(origin).not.toHaveBeenCalled();
    expect(openPr).not.toHaveBeenCalled();
    await advance(1200);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(b.url);
    expect(spoken()).toBe("");
  });

  it("S4: a fast resolve lands in the proven clone and never speaks a wait", async () => {
    data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
    data.recents = [recent("widgets")];
    const input = renderScreen();
    openNext(input);
    await advance(0);
    expect(openPr).toHaveBeenCalledTimes(1);
    expect(openPr).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "remote",
        repoPath: "C:/src/widgets",
        repoName: "widgets",
        ref: "12",
      }),
    );
    expect(worktrees).toHaveBeenCalledWith("C:/src/widgets", { prune: false });
    expect(spoken()).toBe("");
    await advance(1500);
    expect(spoken()).toBe("");
    expect(opened).not.toHaveBeenCalled();
  });

  it("S4b: a GitLab subgroup row proves its clone against the full project path", async () => {
    // The fields forge/gitlab.rs stores for a subgroup project: the owner is
    // only the segment before the name, the full name keeps every group. The
    // GitLab source alone is on, and its leg serves the row.
    data.sources = { github: false, gitlab: true, bitbucket: false };
    data.leg = "gitlab";
    data.items = [
      {
        ...item("widgets", 12, true, "2026-01-02T00:00:00Z"),
        repoFullName: "group/sub/widgets",
        repoOwner: "sub",
        host: "gitlab.com",
        provider: "gitlab",
        url: "https://gitlab.com/group/sub/widgets/-/merge_requests/12",
      },
    ];
    data.recents = [
      {
        ...recent("widgets"),
        host: "gitlab.com",
        owner: "sub",
        provider: "gitlab",
      },
    ];
    origin.mockImplementation(async () => ({
      host: "gitlab.com",
      authority: "gitlab.com",
      path: "group/sub/widgets",
      provider: "gitlab",
    }));
    const input = renderScreen();
    openNext(input);
    await advance(0);
    expect(openPr).toHaveBeenCalledTimes(1);
    expect(openPr).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "remote", repoPath: "C:/src/widgets" }),
    );
    expect(opened).not.toHaveBeenCalled();
  });

  it("S5: one stale candidate opens the browser and names the path", async () => {
    const pr = item("widgets", 12, true, "2026-01-02T00:00:00Z");
    data.items = [pr];
    data.recents = [recent("widgets")];
    validate.mockRejectedValue({ kind: "notARepo", message: "not a repo" });
    const input = renderScreen();
    openNext(input);
    await advance(0);
    expect(opened).toHaveBeenCalledWith(pr.url);
    expect(toast.error).toHaveBeenCalledWith(
      "C:/src/widgets is no longer a git repository.",
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(openPr).not.toHaveBeenCalled();
  });

  it("F5: a stale candidate failing any other way takes the generic toast", async () => {
    const pr = item("widgets", 12, true, "2026-01-02T00:00:00Z");
    data.items = [pr];
    data.recents = [recent("widgets")];
    const error = { kind: "ghNotFound", message: "gh is not installed" };
    validate.mockRejectedValue(error);
    const input = renderScreen();
    openNext(input);
    await advance(0);
    expect(opened).toHaveBeenCalledWith(pr.url);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(error);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("F2: an open superseded before its timer fires never speaks", async () => {
    const a = item("alpha", 1, true, "2026-01-03T00:00:00Z");
    const b = item("beta", 2, true, "2026-01-02T00:00:00Z");
    data.items = [a, b];
    data.recents = [recent("alpha"), recent("beta")];
    validate.mockImplementation(() => never());
    const input = renderScreen();
    openNext(input);
    await advance(100);
    openNext(input);
    await advance(200);
    expect(spoken()).toBe("");
    await advance(100);
    expect(spoken()).toBe("Opening beta pull request 2\u2026");
  });

  it("F6: a held Enter's repeats open nothing, on a local row or a browser-bound one", async () => {
    const local = item("alpha", 1, true, "2026-01-03T00:00:00Z");
    const remote = item("beta", 2, false, "2026-01-02T00:00:00Z");
    data.items = [local, remote];
    data.recents = [recent("alpha")];
    const heldEnter = { key: "Enter", repeat: true };
    const input = renderScreen();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(fireEvent.keyDown(input, heldEnter)).toBe(false);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(fireEvent.keyDown(input, heldEnter)).toBe(false);
    await advance(1500);
    expect(validate).not.toHaveBeenCalled();
    expect(openPr).not.toHaveBeenCalled();
    expect(openIssue).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    // The same row opens on a fresh press, so the repeats above were refused
    // rather than the row being unopenable.
    fireEvent.keyDown(input, { key: "Enter" });
    await advance(0);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(remote.url);
  });

  describe("F7: a browser open the OS refuses takes the generic toast once", () => {
    const refusal = new Error("the opener refused");

    it("when no clone is among the recents", async () => {
      const pr = item("widgets", 12, true, "2026-01-02T00:00:00Z");
      data.items = [pr];
      data.recents = [];
      opened.mockRejectedValueOnce(refusal);
      const input = renderScreen();
      openNext(input);
      await advance(0);
      expect(opened).toHaveBeenCalledWith(pr.url);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(refusal);
    });

    it("when the folder check runs out its budget", async () => {
      const pr = item("widgets", 12, true, "2026-01-02T00:00:00Z");
      data.items = [pr];
      data.recents = [recent("widgets")];
      validate.mockImplementation(() => never());
      opened.mockRejectedValueOnce(refusal);
      const input = renderScreen();
      openNext(input);
      await advance(1500);
      expect(opened).toHaveBeenCalledWith(pr.url);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(refusal);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe("F3: a resolve that outlives the screen navigates nowhere", () => {
    let settle: (info: RepoInfo) => void = () => undefined;
    beforeEach(() => {
      validate.mockImplementation(
        (p) =>
          new Promise<RepoInfo>((resolve) => {
            settle = () => resolve({ root: p, name: "widgets" });
          }),
      );
    });

    const expectNothingOpened = () => {
      expect(openPr).not.toHaveBeenCalled();
      expect(openIssue).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
    };

    it("after the screen unmounts", async () => {
      data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
      data.recents = [recent("widgets")];
      const input = renderScreen();
      openNext(input);
      await advance(300);
      cleanup();
      await act(async () => {
        settle({ root: "C:/src/widgets", name: "widgets" });
        await vi.advanceTimersByTimeAsync(1500);
      });
      expectNothingOpened();
      expect(origin).not.toHaveBeenCalled();
    });

    it("after the view leaves My work", async () => {
      data.items = [item("widgets", 7, false, "2026-01-02T00:00:00Z")];
      data.recents = [recent("widgets")];
      const input = renderScreen();
      openNext(input);
      await advance(300);
      act(() => useUiStore.setState({ view: "repo" }));
      await act(async () => {
        settle({ root: "C:/src/widgets", name: "widgets" });
        await vi.advanceTimersByTimeAsync(1500);
      });
      expectNothingOpened();
      expect(origin).not.toHaveBeenCalled();
    });
  });

  it("F4: Shift+Enter lands on the main workspace while a worktree holds the PR's head", async () => {
    data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
    data.recents = [recent("widgets")];
    worktrees.mockResolvedValue([
      {
        path: "C:/src/widgets",
        branch: "main",
        head: "",
        isMain: true,
        isDetached: false,
        isLocked: false,
        lockReason: "",
        lastActivityMs: null,
      },
      {
        path: "C:/src/widgets-feat",
        branch: "feat",
        head: "",
        isMain: false,
        isDetached: false,
        isLocked: false,
        lockReason: "",
        lastActivityMs: null,
      },
    ]);
    headRef.mockResolvedValue({
      headRefName: "feat",
      headRepoFullName: "acme/widgets",
    });
    const input = renderScreen();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await advance(0);
    expect(openPr).toHaveBeenCalledTimes(1);
    expect(openPr).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoPath: "C:/src/widgets" }),
    );
    expect(headRef).not.toHaveBeenCalled();
    // The same row without Shift reaches the head's worktree, so the case above
    // is the preference at work rather than a lookup that never moves.
    fireEvent.keyDown(input, { key: "Enter" });
    await advance(0);
    expect(openPr).toHaveBeenCalledTimes(2);
    expect(openPr).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoPath: "C:/src/widgets-feat" }),
    );
  });

  describe("M1: a recents entry spelling the open checkout differently", () => {
    // Each case picks its platform (the file's beforeEach clears both flags):
    // Windows folds separators and letter case; a Mac and the rest fold neither
    // here, so another letter case or a backslash is another folder.
    const OPEN = "C:\\src\\widgets";
    let saved: { repoPath: string | null; repoName: string | null };
    beforeEach(() => {
      const { repoPath, repoName } = useUiStore.getState();
      saved = { repoPath, repoName };
    });
    afterEach(() => {
      useUiStore.setState(saved);
    });

    it.each([
      ["a pull request", true, openPr],
      ["an issue", false, openIssue],
    ] as const)(
      "opens %s under the store's own path and name",
      async (_name, isPullRequest, navigate) => {
        platformIs.windows = true;
        useUiStore.setState({ repoPath: OPEN, repoName: "widgets (open)" });
        data.items = [
          item("widgets", 12, isPullRequest, "2026-01-02T00:00:00Z"),
        ];
        data.recents = [recent("widgets")];
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const input = renderScreen(client);
        openNext(input);
        await advance(0);
        expect(navigate).toHaveBeenCalledTimes(1);
        const request = navigate.mock.calls[0][0];
        expect(request).toEqual(
          expect.objectContaining({
            repoPath: OPEN,
            repoName: "widgets (open)",
          }),
        );
        act(() => request.beforeSelect());
        expect(client.getQueryData(lensKey(OPEN))).toBe("origin");
        expect(client.getQueryData(lensKey("C:/src/widgets"))).toBeUndefined();
      },
    );

    it("off Windows, a backslash spelling of the open checkout keeps the recents' spelling and name", async () => {
      useUiStore.setState({ repoPath: OPEN, repoName: "widgets (open)" });
      data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
      data.recents = [recent("widgets")];
      const input = renderScreen();
      openNext(input);
      await advance(0);
      expect(openPr).toHaveBeenCalledTimes(1);
      expect(openPr).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "C:/src/widgets",
          repoName: "widgets",
        }),
      );
    });

    it.each([
      [
        "on a Mac",
        "keeps the recents' spelling and name",
        "mac",
        "C:/src/widgets",
        "widgets",
      ],
      [
        "on Windows",
        "opens under the store's own path and name",
        "windows",
        "C:/src/Widgets",
        "Widgets (open)",
      ],
    ] as const)(
      "%s, a letter-case spelling of the open checkout %s",
      async (_label, _outcome, platform, repoPath, repoName) => {
        platformIs[platform] = true;
        useUiStore.setState({
          repoPath: "C:/src/Widgets",
          repoName: "Widgets (open)",
        });
        data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
        data.recents = [recent("widgets")];
        const input = renderScreen();
        openNext(input);
        await advance(0);
        expect(openPr).toHaveBeenCalledTimes(1);
        expect(openPr).toHaveBeenCalledWith(
          expect.objectContaining({ repoPath, repoName }),
        );
      },
    );

    it("another repository open keeps the recents' spelling and name", async () => {
      useUiStore.setState({
        repoPath: "C:\\src\\gadgets",
        repoName: "gadgets",
      });
      data.items = [item("widgets", 12, true, "2026-01-02T00:00:00Z")];
      data.recents = [recent("widgets")];
      const input = renderScreen();
      openNext(input);
      await advance(0);
      expect(openPr).toHaveBeenCalledTimes(1);
      expect(openPr).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "C:/src/widgets",
          repoName: "widgets",
        }),
      );
    });
  });
});
