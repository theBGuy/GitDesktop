import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import {
  forgeStatus,
  gitBranchDivergence,
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
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

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
  gitRemoteAdd: vi.fn(),
  gitFetchRemote: vi.fn(),
  gitCompareBranches: vi.fn(),
  forgeStatus: vi.fn(),
  forgePrsForBranch: vi.fn(async () => []),
  gitBranchDivergence: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
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

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();

const branch = (name: string, date: string, isCurrent = false) =>
  ({ name, isCurrent, archived: false, lastCommitDate: date }) as Branch;

const remote = (r: string, name: string, date: string): RemoteBranch => ({
  remote: r,
  name,
  lastCommitDate: date,
});

const worktree = (path: string, name: string, isMain: boolean) =>
  ({
    path,
    branch: name,
    head: "c".repeat(40),
    isMain,
    isDetached: false,
    isLocked: false,
    lockReason: "",
  }) as UserWorktree;

function statusOf(name: string): RepoStatus {
  return {
    branch: {
      name,
      detached: false,
      upstreamRemote: null,
      upstreamBranch: null,
    },
    files: [],
  } as unknown as RepoStatus;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ComparePanel repoPath={REPO} />
    </QueryClientProvider>,
  );
}

const trigger = () =>
  screen.getByRole("combobox", { name: "Compare with branch" });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(trigger()).toHaveTextContent("main"));
  await user.click(trigger());
  return screen.findByRole("listbox", { name: "Branches to compare with" });
}

/** The row's own relative time: the fixtures' dates drift against the clock. */
function timeOf(option: HTMLElement): string {
  const text = option.querySelector("time")?.textContent ?? "";
  expect(text).not.toBe("");
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO, compareBranch: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockResolvedValue(statusOf("feat"));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", day(9), true),
    branch("main", day(8)),
    branch("ahead-one", day(7)),
    branch("behind-only", day(6)),
    branch("in-main-workspace", day(5)),
    branch("no-date", ""),
    branch("bad-date", "not-a-date"),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("origin", "feature-x", day(4)),
    remote("origin", "bad-remote-date", "not-a-date"),
  ]);
  vi.mocked(gitBranchDivergence).mockResolvedValue([
    { name: "main", ahead: 2, behind: 1 },
    { name: "ahead-one", ahead: 1, behind: 0 },
    { name: "behind-only", ahead: 0, behind: 3 },
    { name: "in-main-workspace", ahead: 0, behind: 0 },
  ]);
  vi.mocked(listUserWorktrees).mockResolvedValue([
    worktree("C:/main-checkout", "in-main-workspace", true),
    worktree(REPO, "feat", false),
    worktree("C:/wt/main", "main", false),
  ]);
  vi.mocked(gitCompareBranches).mockResolvedValue({ ahead: [], behind: [] });
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
});

describe("Compare picker row names", () => {
  it("names the list", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(await openPicker(user)).toBeInTheDocument();
  });

  it("joins every part of a default row held in a worktree with a divergence", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^main, default/,
    });
    const badge = "2 commits ahead of feat, 1 commit behind";
    await waitFor(() =>
      expect(row).toHaveAccessibleName(
        `main, default, worktree, ${badge}, ${timeOf(row)}`,
      ),
    );
    const img = within(row).getByRole("img", { name: badge });
    expect(img).toHaveAttribute("aria-label", badge);
    expect(img).toHaveAttribute("title", badge);
  });

  it("keeps the visible default chip in the name span and its copy on the row", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^main, default/,
    });
    const nameSpan = row.firstElementChild;
    const chips = [...row.querySelectorAll('[aria-hidden="true"]')].filter(
      (el) => el.textContent === "default",
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].parentElement).toBe(nameSpan);
    const copies = [...row.querySelectorAll(".sr-only")].filter(
      (el) => el.textContent === ", default",
    );
    expect(copies).toHaveLength(1);
    expect(copies[0].parentElement).toBe(row);
    expect(nameSpan?.nextElementSibling).toBe(copies[0]);

    const plain = within(list).getByRole("option", { name: /^ahead-one/ });
    expect(plain.textContent).not.toContain("default");
  });

  it("names an ahead-only row in the singular", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^ahead-one/,
    });
    const badge = "1 commit ahead of feat";
    await waitFor(() =>
      expect(row).toHaveAccessibleName(`ahead-one, ${badge}, ${timeOf(row)}`),
    );
    const img = within(row).getByRole("img", { name: badge });
    expect(img).toHaveAttribute("aria-label", badge);
    expect(img).toHaveAttribute("title", badge);
  });

  it("names the base on a behind-only row", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^behind-only/,
    });
    const badge = "3 commits behind feat";
    await waitFor(() =>
      expect(row).toHaveAccessibleName(`behind-only, ${badge}, ${timeOf(row)}`),
    );
    const img = within(row).getByRole("img", { name: badge });
    expect(img).toHaveAttribute("aria-label", badge);
    expect(img).toHaveAttribute("title", badge);
  });

  it("names a main-workspace row and shows no badge when even", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^in-main-workspace/,
    });
    await waitFor(() =>
      expect(row).toHaveAccessibleName(
        `in-main-workspace, main workspace, ${timeOf(row)}`,
      ),
    );
    expect(within(row).queryByRole("img")).toBeNull();
  });

  it("leaves no separator behind an empty or unparseable date", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    expect(
      await within(list).findByRole("option", { name: "no-date" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("option", { name: "bad-date" }),
    ).toBeInTheDocument();
    expect(
      await within(list).findByRole("option", {
        name: "origin/bad-remote-date",
      }),
    ).toBeInTheDocument();
  });

  it("names a remote row by its remote and branch, then its time", async () => {
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    const row = await within(list).findByRole("option", {
      name: /^origin\/feature-x/,
    });
    expect(row).toHaveAccessibleName(`origin/feature-x, ${timeOf(row)}`);
  });

  it("names the add-upstream row with the fork it would add", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentRepos: [{ path: REPO, isFork: true, forkParent: "octo/project" }],
    } as unknown as typeof DEFAULT_SETTINGS);
    const user = userEvent.setup();
    renderPanel();
    const list = await openPicker(user);
    expect(
      await within(list).findByRole("option", {
        name: "Add upstream remote, fork of octo/project",
      }),
    ).toBeInTheDocument();
  });
});
