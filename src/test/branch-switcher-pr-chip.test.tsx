import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BranchSwitcher } from "@/features/repository/BranchSwitcher";
import {
  forgePrList,
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitBranchRewriteStatus,
  gitDefaultBranch,
  gitRemoteBranches,
  gitRemotes,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type { Branch, BranchHead, ForgeStatus, PrInfo } from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { type LocalPr, listLocalPrs } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The harness of branch-switcher-start-point.test.tsx, plus the forge's PR
// lists. The Clean up dialog is replaced by a probe of the maps it is handed.
const cleanupProps = vi.hoisted(() => ({
  merged: new Map<string, { label: string; headSha: string | null }>(),
  closed: new Map<string, string>(),
}));
vi.mock("@/features/repository/CleanupBranchesDialog", async (orig) => ({
  ...(await orig<
    typeof import("@/features/repository/CleanupBranchesDialog")
  >()),
  CleanupBranchesDialog: (p: {
    prMergedByBranch: typeof cleanupProps.merged;
    prClosedByBranch: typeof cleanupProps.closed;
  }) => {
    cleanupProps.merged = p.prMergedByBranch;
    cleanupProps.closed = p.prClosedByBranch;
    return null;
  },
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitBranchDivergence: vi.fn(),
  gitBranchRewriteStatus: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitStashCount: vi.fn(),
  readRepoBranchRules: vi.fn(),
  forgeStatus: vi.fn(),
  forgePrList: vi.fn(),
  getSecret: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => `${path}/.git`,
  repoIdentityStrict: (path: string) => Promise.resolve(`${path}/.git`),
}));

const REPO = "C:/repos/chip";

Element.prototype.scrollIntoView ??= () => undefined;
const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
beforeAll(() => {
  for (const [k, v] of Object.entries(CLIENT_SIZE)) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get: () => v,
    });
  }
});
afterAll(() => {
  for (const k of Object.keys(CLIENT_SIZE)) {
    Reflect.deleteProperty(HTMLElement.prototype, k);
  }
  expect(unmockedCommands).toEqual([]);
});

function row(
  name: string,
  upstreamBranch: string,
  overrides: Partial<Branch> = {},
): Branch {
  return {
    name,
    isCurrent: false,
    upstream: `origin/${upstreamBranch}`,
    lastCommitDate: "2026-11-01T10:00:00Z",
    archived: false,
    upstreamAhead: 0,
    upstreamBehind: 0,
    upstreamGone: false,
    upstreamRemote: "origin",
    upstreamRemoteRef: `refs/heads/${upstreamBranch}`,
    keepLocal: false,
    upstreamIsRemoteDefault: false,
    ...overrides,
  };
}

function pr(
  number: number,
  head: string,
  state: "OPEN" | "MERGED",
  base = "main",
): PrInfo {
  return {
    number,
    url: `https://example.test/pr/${number}`,
    title: `PR ${number}`,
    baseRefName: base,
    headRefName: head,
    isDraft: false,
    state,
    author: { login: "me" },
    labels: [],
    createdAt: "2026-11-01T10:00:00Z",
    headSha: "",
  };
}

/** A local PR whose head is `head`: someone's new local branch named after it. */
function localPr(head: string): LocalPr {
  return {
    id: `local-${head}`,
    title: `Local ${head}`,
    body: "",
    base: "main",
    head,
    status: "open",
    approved: false,
    labels: [],
    comments: [],
    createdAt: "2026-11-01T10:00:00Z",
  };
}

const HEAD: BranchHead = {
  name: "main",
  detached: false,
  oid: "abcdef0123456789abcdef0123456789abcdef01",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamBranch: "main",
  pushNameMismatch: false,
  upstreamIsRemoteDefault: null,
  pushRemote: "origin",
  pushBranch: "main",
};

const forge = (provider: ForgeStatus["provider"]) =>
  ({
    provider,
    installed: true,
    authenticated: true,
    repo: "o/r",
    host: `${provider}.com`,
    login: "me",
    capabilities: {},
    implemented: { pullRequests: true },
  }) as unknown as ForgeStatus;

let provider: ForgeStatus["provider"];

beforeEach(() => {
  vi.clearAllMocks();
  provider = "github";
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(gitStatus).mockResolvedValue({ branch: HEAD, entries: [] });
  vi.mocked(gitBranches).mockResolvedValue([
    row("main", "main", { isCurrent: true, upstreamIsRemoteDefault: true }),
    // Renamed from `old`, still tracking origin/old.
    row("new", "old", { renamedFromUpstream: true }),
    // Cut from origin/develop: a start point, not a rename.
    row("topic", "develop"),
    row("same", "same"),
    // Flagged, but on another remote: its upstream's PR is not origin's.
    row("away", "elsewhere", {
      renamedFromUpstream: true,
      upstreamRemote: "fork",
      upstream: "fork/elsewhere",
    }),
  ]);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "fork"]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([]);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranchDivergence).mockResolvedValue([]);
  vi.mocked(gitBranchRewriteStatus).mockResolvedValue({
    remoteRewritten: null,
    localOnly: 0,
    remoteOnly: 0,
    patchEqual: 0,
    upstream: null,
    upstreamTip: null,
    localTip: null,
  });
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(getSecret).mockResolvedValue(null);
  vi.mocked(forgeStatus).mockImplementation(async () => forge(provider));
  vi.mocked(forgePrList).mockImplementation(async (_repo, state) =>
    state === "open"
      ? [
          pr(8, "develop", "OPEN"),
          pr(9, "same", "OPEN"),
          pr(4, "elsewhere", "OPEN"),
        ]
      : [pr(5, "old", "MERGED"), pr(6, "done", "MERGED")],
  );
  vi.mocked(listUserWorktrees).mockResolvedValue([]);
  vi.mocked(listLocalPrs).mockResolvedValue([]);
  cleanupProps.merged = new Map();
  cleanupProps.closed = new Map();
  useUiStore.setState({ repoPath: REPO });
});

function renderSwitcher() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BranchSwitcher repoPath={REPO} />
    </QueryClientProvider>,
  );
  return { user };
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /^main/ }));
  await screen.findByPlaceholderText("Filter branches");
}

const rowEl = (name: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-row="${name}"]`);
    if (!el) throw new Error(`no row ${name}`);
    return el;
  });

const chipOf = async (name: string) =>
  (await rowEl(name)).querySelector<HTMLElement>("[data-pr-chip]");

/** Waits for the lists to land: `same`'s own chip is the marker. */
async function settled(user: ReturnType<typeof userEvent.setup>) {
  await openList(user);
  await waitFor(async () => expect(await chipOf("same")).not.toBeNull());
}

describe("the switcher's PR chip for a renamed copy", () => {
  it("shows the old name's PR on a renamed copy, never through Clean up", async () => {
    const { user } = renderSwitcher();
    await settled(user);
    const chip = await chipOf("new");
    expect(chip).toHaveTextContent("#5");
    expect(chip).toHaveAttribute("aria-label", "Merged pull request #5");
    // Clean up stays keyed by head name: the merged PR belongs to `old`.
    expect(cleanupProps.merged.has("new")).toBe(false);
    expect(cleanupProps.merged.get("old")?.label).toBe("#5");
    expect(cleanupProps.merged.get("done")?.label).toBe("#6");
  });

  it("tracks origin/develop without the flag: no chip from develop's PR", async () => {
    const { user } = renderSwitcher();
    await settled(user);
    expect(await chipOf("topic")).toBeNull();
  });

  it("a flagged copy on another remote takes no origin PR", async () => {
    const { user } = renderSwitcher();
    await settled(user);
    expect(await chipOf("away")).toBeNull();
  });

  it("the fallback reads remote requests only: a local one on the old name never lights it", async () => {
    vi.mocked(listLocalPrs).mockResolvedValue([localPr("old")]);
    const { user } = renderSwitcher();
    await settled(user);
    // The open local PR outranks merged #5 on `old`, yet the copy keeps #5.
    const chip = await chipOf("new");
    expect(chip).toHaveTextContent("#5");
    expect(chip).toHaveAttribute("aria-label", "Merged pull request #5");
  });

  it("with no remote request on the old name, a local one leaves the copy unchipped", async () => {
    // `topic`'s own local PR is the marker that the local list has landed.
    vi.mocked(listLocalPrs).mockResolvedValue([
      localPr("old"),
      localPr("topic"),
    ]);
    vi.mocked(forgePrList).mockImplementation(async (_repo, state) =>
      state === "open" ? [pr(9, "same", "OPEN")] : [pr(6, "done", "MERGED")],
    );
    const { user } = renderSwitcher();
    await settled(user);
    await waitFor(async () =>
      expect(await chipOf("topic")).toHaveTextContent("local"),
    );
    expect(await chipOf("new")).toBeNull();
  });

  it("a same-name branch keeps its own chip", async () => {
    const { user } = renderSwitcher();
    await settled(user);
    const chip = await chipOf("same");
    expect(chip).toHaveTextContent("#9");
    expect(chip).toHaveAttribute("aria-label", "Open pull request #9");
  });

  it("reads !N on GitLab: chip, label, menu item and Clean up labels", async () => {
    provider = "gitlab";
    const { user } = renderSwitcher();
    await settled(user);
    const chip = await chipOf("new");
    expect(chip).toHaveTextContent("!5");
    expect(chip).toHaveAttribute("aria-label", "Merged merge request !5");
    expect(await chipOf("same")).toHaveAttribute(
      "aria-label",
      "Open merge request !9",
    );
    expect(cleanupProps.merged.get("done")?.label).toBe("!6");
    await user.pointer({ keys: "[MouseRight]", target: await rowEl("new") });
    await screen.findByRole("menu");
    expect(
      screen.getByRole("menuitem", { name: "View merge request !5" }),
    ).toBeInTheDocument();
  });
});
