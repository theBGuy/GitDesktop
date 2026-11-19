import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { remoteCompareRows } from "@/features/compare/compare-remote-ref";
import { BaseBranchCombobox } from "@/features/repository/BaseBranchCombobox";
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
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
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
  gitBranchDivergence: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "C:/repo";

/** The EARLIER instant, though it sorts later as text. */
const EARLIER = "2026-01-01T10:00:00+05:00";
/** The later instant. */
const LATER = "2026-01-01T06:00:00+00:00";
const OLD = "2025-06-01T00:00:00+00:00";
const UNPARSEABLE = "not-a-date";

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

const branch = (name: string, date: string, isCurrent = false) =>
  ({ name, isCurrent, archived: false, lastCommitDate: date }) as Branch;

const remote = (r: string, name: string, date: string): RemoteBranch => ({
  remote: r,
  name,
  lastCommitDate: date,
});

const statusOf = (name: string) =>
  ({
    branch: {
      name,
      detached: false,
      upstreamRemote: null,
      upstreamBranch: null,
    },
    files: [],
  }) as unknown as RepoStatus;

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** A row's label: the first text of its first span (the chips, separators and
 *  date follow it). */
const label = (option: HTMLElement) =>
  option.querySelector("span")?.firstChild?.textContent ?? "";

const groupLabels = (list: HTMLElement, group: "Local" | "Remote") =>
  within(within(list).getByRole("group", { name: group }))
    .getAllByRole("option")
    .map(label);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO, compareBranch: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockResolvedValue(statusOf("feat"));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", LATER, true),
    branch("main", OLD),
    branch("bad-date", UNPARSEABLE),
    branch("no-date", ""),
    branch("plus-five", EARLIER),
    branch("utc-six", LATER),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("origin", "bad-date", UNPARSEABLE),
    remote("origin", "no-date", ""),
    remote("origin", "plus-five", EARLIER),
    remote("origin", "utc-six", LATER),
  ]);
  vi.mocked(gitCompareBranches).mockResolvedValue({ ahead: [], behind: [] });
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
});

describe("Compare picker recency", () => {
  async function openComparePicker() {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client()}>
        <ComparePanel repoPath={REPO} />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole("combobox", {
      name: "Compare with branch",
    });
    await waitFor(() => expect(trigger).toHaveTextContent("main"));
    await user.click(trigger);
    return screen.findByRole("listbox", { name: "Branches to compare with" });
  }

  it("orders local rows by instant, undated rows last", async () => {
    const list = await openComparePicker();
    await within(list).findByRole("option", { name: /^utc-six/ });
    const rows = groupLabels(list, "Local");
    expect(rows.slice(0, 3)).toEqual(["main", "utc-six", "plus-five"]);
    expect(rows.slice(3).sort()).toEqual(["bad-date", "no-date"]);
  });

  it("orders one remote's rows by instant, undated rows last", async () => {
    const list = await openComparePicker();
    await within(list).findByRole("option", { name: /^origin\/utc-six/ });
    const rows = groupLabels(list, "Remote");
    expect(rows.slice(0, 2)).toEqual(["origin/utc-six", "origin/plus-five"]);
    expect(rows.slice(2).sort()).toEqual(["origin/bad-date", "origin/no-date"]);
  });

  it("auto-picks the newer instant when the default branch is not offered", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("feat", LATER, true),
      branch("bad-date", UNPARSEABLE),
      branch("plus-five", EARLIER),
      branch("utc-six", LATER),
    ]);
    render(
      <QueryClientProvider client={client()}>
        <ComparePanel repoPath={REPO} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(useUiStore.getState().compareBranch).toBe("utc-six"),
    );
  });

  // Git order puts the `-b` branch first, so the name can't decide the tie, and
  // tie-b's spelling of LATER sorts below tie-a's as text, so a newest-first
  // text tiebreak would pick tie-a.
  it.each([
    {
      tie: "equal instants",
      others: [
        branch("tie-b", "2026-01-01T01:00:00-05:00"),
        branch("tie-a", LATER),
        branch("older", OLD),
      ],
      picked: "tie-b",
      listed: ["tie-b", "tie-a", "older"],
    },
    {
      tie: "two undated branches",
      others: [branch("undated-b", ""), branch("undated-a", UNPARSEABLE)],
      picked: "undated-b",
      listed: ["undated-b", "undated-a"],
    },
  ])(
    "breaks a tie of $tie by git order, as the picker lists them",
    async ({ others, picked, listed }) => {
      vi.mocked(gitBranches).mockResolvedValue([
        branch("feat", LATER, true),
        ...others,
      ]);
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={client()}>
          <ComparePanel repoPath={REPO} />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(useUiStore.getState().compareBranch).toBe(picked),
      );
      await user.click(
        screen.getByRole("combobox", { name: "Compare with branch" }),
      );
      const list = await screen.findByRole("listbox", {
        name: "Branches to compare with",
      });
      expect(groupLabels(list, "Local")).toEqual(listed);
    },
  );
});

describe("remoteCompareRows recency", () => {
  it("orders by instant within a remote, undated rows last", () => {
    const rows = remoteCompareRows(
      [
        remote("origin", "bad-date", UNPARSEABLE),
        remote("origin", "no-date", ""),
        remote("origin", "plus-five", EARLIER),
        remote("origin", "utc-six", LATER),
      ],
      ["origin"],
    ).map((r) => r.display);
    expect(rows.slice(0, 2)).toEqual(["origin/utc-six", "origin/plus-five"]);
    expect(rows.slice(2).sort()).toEqual(["origin/bad-date", "origin/no-date"]);
  });
});

describe("Base branch picker recency", () => {
  async function openBasePicker() {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client()}>
        <label htmlFor="base-trigger">Base</label>
        <BaseBranchCombobox
          repoPath={REPO}
          open
          currentName="feat"
          defaultName="main"
          value="feat"
          onValueChange={() => undefined}
          triggerId="base-trigger"
        />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "Base" }));
    return screen.findByRole("listbox", { name: "Base branches" });
  }

  it("orders local rows by instant after current and default, undated rows last", async () => {
    const list = await openBasePicker();
    await within(list).findByRole("option", { name: /^utc-six/ });
    const rows = groupLabels(list, "Local");
    expect(rows.slice(0, 4)).toEqual(["feat", "main", "utc-six", "plus-five"]);
    expect(rows.slice(4).sort()).toEqual(["bad-date", "no-date"]);
  });

  it("orders remote rows by instant, undated rows last", async () => {
    const list = await openBasePicker();
    await within(list).findByRole("option", { name: /^origin\/utc-six/ });
    const rows = groupLabels(list, "Remote");
    expect(rows.slice(0, 2)).toEqual(["origin/utc-six", "origin/plus-five"]);
    expect(rows.slice(2).sort()).toEqual(["origin/bad-date", "origin/no-date"]);
  });
});
