// Negative control (run once, reverted): dropping `!searchActive` from
// HistoryPanel's edit-commit-dates gate keeps the palette action available
// under a search, and the search case's palette assertion goes red.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import {
  gitCommitDetails,
  gitCommitFiles,
  gitFindCommitsByPrefix,
  gitLog,
  gitOpState,
  gitStatus,
  gitUnpushedCount,
  gitUnpushedMessages,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { CommitSummary } from "@/lib/git/types";
import { useAvailableActions } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  gitOpState: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitFindCommitsByPrefix: vi.fn(),
  gitUnpushedCount: vi.fn(),
  gitUnpushedMessages: vi.fn(),
}));

const REPO = "/repo";
const REPO_B = "/repo-b";
const PLACEHOLDER = "Filter loaded commits, or search all history";
const MULTI_HINT = " (select only this commit in History)";
const SEARCH_HINT = " (clear History's search first)";

/** Non-zero hex, so the oid-width guard never reads a zero run. */
const HASH_HEAD = "abcdef0123".repeat(4);
const HASH_PARENT = `b${HASH_HEAD.slice(1)}`;

const summary = (hash: string, subject: string): CommitSummary => ({
  hash,
  subject,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  committerDate: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
});

// jsdom lays nothing out, so the virtualized commit list would paint no rows.
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
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  // A grep finds nothing: the search lists no rows.
  vi.mocked(gitLog).mockImplementation(async (_r, _limit, _skip, q) =>
    q
      ? []
      : [
          summary(HASH_HEAD, "Add the parser"),
          summary(HASH_PARENT, "Start the project"),
        ],
  );
  vi.mocked(gitFindCommitsByPrefix).mockResolvedValue([]);
  // Two commits ahead of the upstream: both are editable.
  vi.mocked(gitStatus).mockResolvedValue({
    branch: {
      name: "main",
      detached: false,
      oid: HASH_HEAD,
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      upstreamGone: false,
      upstreamRemote: "origin",
      upstreamBranch: "main",
      pushNameMismatch: false,
      upstreamIsRemoteDefault: true,
      pushRemote: null,
      pushBranch: null,
    },
    entries: [],
  });
  const date = { epochSeconds: 1_761_991_200, offsetMinutes: 0 };
  vi.mocked(gitUnpushedMessages).mockResolvedValue([
    {
      hash: HASH_HEAD,
      message: "Add the parser",
      authorDate: date,
      committerDate: date,
    },
    {
      hash: HASH_PARENT,
      message: "Start the project",
      authorDate: date,
      committerDate: date,
    },
  ]);
  vi.mocked(gitOpState).mockResolvedValue({
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
    rebaseStop: null,
  });
  vi.mocked(gitCommitDetails).mockImplementation(async (_repo, hash) => ({
    hash,
    subject: "Add the parser",
    body: "",
    author: "Ada",
    authorEmail: "",
    date: "2026-11-01T10:00:00Z",
    committerDate: "2026-11-01T10:00:00Z",
  }));
  // The pane renders its actions once its file list reads.
  vi.mocked(gitCommitFiles).mockResolvedValue([]);
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "history",
    selectedCommitHash: null,
    historyDatesHold: null,
  });
});

function PaletteProbe() {
  const live = useAvailableActions().has("edit-commit-dates");
  return <output data-testid="palette">{String(live)}</output>;
}

let client: QueryClient;

/** History beside a detail pane fixed on HEAD, as RepositoryView pairs them. */
function renderHistory() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const tree = (repo: string) => (
    <QueryClientProvider client={client}>
      <HistoryPanel repoPath={repo} />
      <CommitDetailView repoPath={repo} hash={HASH_HEAD} />
      <PaletteProbe />
    </QueryClientProvider>
  );
  const { container, rerender, unmount } = render(tree(REPO));
  return {
    container,
    unmount,
    switchTo: (repo: string) => rerender(tree(repo)),
  };
}

const rowOf = (container: HTMLElement, hash: string) => {
  const row = container.querySelector<HTMLElement>(`[data-hash="${hash}"]`);
  if (!row) throw new Error("no row");
  return row;
};
const palette = () => screen.getByTestId("palette").textContent;

/** Opens the detail pane's actions menu and returns its Edit dates item. */
async function detailDatesItem() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Commit actions" }),
  );
  return screen.findByRole("menuitem", { name: /^Edit dates…/ });
}

async function closeMenu() {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

async function startSearch() {
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "zzz");
  await userEvent.click(
    await screen.findByRole("button", { name: /^Search all history/ }),
  );
}

describe("Edit dates while History offers no single commit", () => {
  it("a Shift or Ctrl multi-selection holds the detail item and the palette; one row restores both", async () => {
    const { container } = renderHistory();
    await waitFor(() => expect(rowOf(container, HASH_PARENT)).toBeDefined());
    fireEvent.click(rowOf(container, HASH_HEAD));
    await waitFor(() => expect(palette()).toBe("true"));

    const shift = userEvent.setup();
    await shift.keyboard("{Shift>}");
    await shift.click(rowOf(container, HASH_PARENT));
    await shift.keyboard("{/Shift}");
    await waitFor(() => expect(palette()).toBe("false"));
    const held = await detailDatesItem();
    expect(held).toHaveTextContent(`Edit dates…${MULTI_HINT}`);
    expect(held).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(held);
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
    await closeMenu();

    // A plain click collapses to one row; a Ctrl+click builds the set again.
    fireEvent.click(rowOf(container, HASH_HEAD));
    await waitFor(() => expect(palette()).toBe("true"));
    const user = userEvent.setup();
    await user.keyboard("{Control>}");
    await user.click(rowOf(container, HASH_PARENT));
    await user.keyboard("{/Control}");
    await waitFor(() => expect(palette()).toBe("false"));
    fireEvent.click(rowOf(container, HASH_HEAD));
    await waitFor(() => expect(palette()).toBe("true"));

    const item = await detailDatesItem();
    expect(item).toHaveTextContent(/^Edit dates…$/);
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(item);
    expect(
      await screen.findByRole("dialog", { name: "Edit dates" }),
    ).toBeInTheDocument();
  });

  it("a search holds the detail item and the palette", async () => {
    const { container } = renderHistory();
    await waitFor(() => expect(rowOf(container, HASH_HEAD)).toBeDefined());
    fireEvent.click(rowOf(container, HASH_HEAD));
    await waitFor(() => expect(palette()).toBe("true"));
    await startSearch();
    await waitFor(() => expect(palette()).toBe("false"));
    const item = await detailDatesItem();
    expect(item).toHaveTextContent(`Edit dates…${SEARCH_HINT}`);
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("a search carried across a repo switch still holds the new repo's item", async () => {
    const { container, switchTo } = renderHistory();
    await waitFor(() => expect(rowOf(container, HASH_HEAD)).toBeDefined());
    await startSearch();
    await waitFor(() =>
      expect(useUiStore.getState().historyDatesHold).toBe("search"),
    );
    act(() => useUiStore.setState({ repoPath: REPO_B }));
    switchTo(REPO_B);
    await waitFor(() =>
      expect(useUiStore.getState().historyDatesHold).toBe("search"),
    );
    const item = await detailDatesItem();
    expect(item).toHaveTextContent(`Edit dates…${SEARCH_HINT}`);
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("an unmounted History publishes no hold", async () => {
    const { container, unmount } = renderHistory();
    await waitFor(() => expect(rowOf(container, HASH_HEAD)).toBeDefined());
    await startSearch();
    await waitFor(() =>
      expect(useUiStore.getState().historyDatesHold).toBe("search"),
    );
    unmount();
    expect(useUiStore.getState().historyDatesHold).toBeNull();
  });

  it("outside the History tab the hold changes nothing", async () => {
    vi.mocked(gitLog).mockResolvedValue([
      summary(HASH_HEAD, "Add the parser"),
      summary(HASH_PARENT, "Start the project"),
    ]);
    useUiStore.setState({ repoTab: "compare", historyDatesHold: "search" });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      settingsKeys.settings,
      structuredClone(DEFAULT_SETTINGS),
    );
    render(
      <QueryClientProvider client={client}>
        <CommitDetailView repoPath={REPO} hash={HASH_HEAD} />
      </QueryClientProvider>,
    );
    const item = await detailDatesItem();
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled"));
    expect(item).toHaveTextContent(/^Edit dates…$/);
  });
});

// The hosts spread useAmendWithConfirm's dialog props: a dropped spread or a
// dropped variant shows no dialog, or the force-push copy.
describe("Amend from its hosts on a no-upstream HEAD a remote branch has", () => {
  const ELSEWHERE_TITLE = "This commit is already on a remote branch";
  const ELSEWHERE_BODY =
    "Amending rewrites it on this branch only: the remote branch keeps the original, and the two will differ.";

  beforeEach(() => {
    vi.mocked(gitStatus).mockResolvedValue({
      branch: {
        name: "topic",
        detached: false,
        oid: HASH_HEAD,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstreamGone: false,
        upstreamRemote: null,
        upstreamBranch: null,
        pushNameMismatch: false,
        upstreamIsRemoteDefault: false,
        pushRemote: null,
        pushBranch: null,
      },
      entries: [],
    });
    vi.mocked(gitUnpushedCount).mockResolvedValue({
      count: 0,
      basis: "remotes",
      defaultBranch: null,
      headOid: HASH_HEAD,
    });
  });

  const countRead = () =>
    waitFor(() =>
      expect(client.getQueryState(repoKeys.unpushedCount(REPO))?.status).toBe(
        "success",
      ),
    );

  it("History's HEAD row menu asks with the remote-branch copy", async () => {
    const { container } = renderHistory();
    await waitFor(() => expect(rowOf(container, HASH_HEAD)).toBeDefined());
    await countRead();
    fireEvent.contextMenu(rowOf(container, HASH_HEAD));
    const item = await screen.findByRole("menuitem", {
      name: /^Amend commit…/,
    });
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: ELSEWHERE_TITLE });
    expect(dialog).toHaveTextContent(ELSEWHERE_BODY);
  });

  it("the commit detail's actions menu asks with the remote-branch copy", async () => {
    renderHistory();
    await countRead();
    await userEvent.click(
      await screen.findByRole("button", { name: "Commit actions" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: /^Amend commit…/,
    });
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: ELSEWHERE_TITLE });
    expect(dialog).toHaveTextContent(ELSEWHERE_BODY);
  });
});
