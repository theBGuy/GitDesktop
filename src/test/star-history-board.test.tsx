import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InsightsBoard } from "@/features/repository/insights/InsightsBoard";
import {
  monthYearLabel,
  weekLabel,
} from "@/features/repository/insights/star-history";
import { TabPanel } from "@/features/repository/TabPanel";
import { HELD_RATE_LIMIT_TEXTS } from "@/lib/forge-backoff";
import {
  forgeRepoDelete,
  forgeRepoSetStar,
  forgeRepoSetVisibility,
  forgeStatus,
  ghCommunityInsights,
  ghRepoFork,
  ghStarHistoryPage,
  gitRemoteSetUrl,
  gitUpdateBranchFrom,
  gitUpdateHookManager,
  type StarHistoryPage,
} from "@/lib/git/api";
import {
  invalidateRepoAfterWrite,
  repoKeys,
  settlesOnRepoWrite,
  starHistorySeries,
  useDeleteRepo,
  useForkRepo,
  useSetRemoteUrl,
  useSetRepoStar,
  useSetVisibility,
  useStarHistory,
  useUpdateBranchFrom,
  useUpdateHookManager,
} from "@/lib/git/queries";
import { focusRefetchPredicate } from "@/lib/git/queries/board-writes";
import { peekRepoIdentity } from "@/lib/git/repo-identity";
import type { ForgeStatus } from "@/lib/git/types";
import { queryClient as appQueryClient } from "@/lib/query-client";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => {
  // The board's other reads stay loading: only the star read is under test.
  const loading = () => new Promise<never>(() => undefined);
  return {
    ...(await importOriginal<typeof import("@/lib/git/api")>()),
    forgeStatus: vi.fn(),
    gitCommitActivity: vi.fn(loading),
    gitCodeFrequency: vi.fn(loading),
    gitPunchCard: vi.fn(loading),
    gitContributorActivity: vi.fn(loading),
    ghCommunityInsights: vi.fn(loading),
    ghRepoTraffic: vi.fn(loading),
    ghRepoDependencies: vi.fn(loading),
    forgeForkActivity: vi.fn(loading),
    ghStarHistoryPage: vi.fn(),
    forgeRepoSetStar: vi.fn(),
    gitUpdateBranchFrom: vi.fn(),
    gitUpdateHookManager: vi.fn(),
    ghRepoFork: vi.fn(),
    gitRemoteSetUrl: vi.fn(),
    forgeRepoDelete: vi.fn(),
    forgeRepoSetVisibility: vi.fn(),
  };
});

vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: vi.fn(() => undefined),
}));

vi.mock("@/lib/github/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/actions")>()),
  useWorkflowRuns: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPaused: false,
    isFetching: false,
    isPlaceholderData: false,
    errorUpdatedAt: 0,
    dataUpdatedAt: 0,
    refetch: () => Promise.resolve(),
  }),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

const REPO = "C:/repo";
const OTHER = "C:/other";
const WEEK = 7 * 86_400;
/** Sunday 1 November 2026, 00:00 UTC. */
const NEWEST = Date.UTC(2026, 10, 1) / 1000;

const GITHUB = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "github.com",
  login: "me",
  capabilities: {},
  implemented: { insights: true },
} as unknown as ForgeStatus;

const RATE_LIMITED = { kind: "gh", message: HELD_RATE_LIMIT_TEXTS.REST };
const TRANSPORT = { kind: "gh", message: "error connecting to api.github.com" };

const fill = (n: number, v: number) => Array.from({ length: n }, () => v);
/** 150 weeks (5 pages), newest first: 34 stars in the newest 52, 106 before. */
const OLD_150 = [...fill(34, 1), ...fill(18, 0), ...fill(8, 2), ...fill(90, 1)];
/** 21 weeks summing to 246. */
const YOUNG_21 = [...fill(20, 12), 6];
/** 90 weeks (3 pages) summing to 150: a fork's own series. */
const FORK_90 = [...fill(60, 2), ...fill(30, 1)];

/** The wire's pages for `totals` (newest first): 30 weeks each, the count on
 *  page 1 only, and rel="last" on every page but the real last one. */
function pagesOf(totals: number[], count: number | null): StarHistoryPage[] {
  const weeks = totals.map((total, i) => ({ week: NEWEST - i * WEEK, total }));
  const chunks: (typeof weeks)[] = [];
  for (let i = 0; i < weeks.length; i += 30)
    chunks.push(weeks.slice(i, i + 30));
  if (chunks.length === 0) chunks.push([]);
  const n = chunks.length;
  return chunks.map((w, i) => ({
    available: true,
    weeks: w,
    nextPage: i + 1 < n ? i + 2 : null,
    lastPage: n > 1 && i + 1 < n ? n : null,
    stargazersCount: i === 0 ? count : null,
  }));
}

// The star read's backend: each repo's pages, answered at once unless the repo
// is held (then a test releases each call), or failed on a given attempt.
let fixtures: Record<string, StarHistoryPage[]> = {};
let failures: {
  repo: string;
  page: number;
  attempt: number;
  error: unknown;
}[] = [];
const holdFor = new Set<string>();
const attempts = new Map<string, number>();
const held: {
  repo: string;
  page: number;
  settle: () => void;
  done: boolean;
}[] = [];

/** Each checkout's origin slug and host, as its forge status names them. */
const SLUG = "owner/repo";
const HOST = "github.com";
const SERIES = `${HOST}/${SLUG}`;
let slugs: Record<string, string> = {};
let hosts: Record<string, string> = {};
/** REPO's fork, whose own series is FORK_90. */
const FORK = "me/repo";
function forkOrigin() {
  slugs[REPO] = FORK;
  fixtures[FORK] = pagesOf(FORK_90, 150);
}

function installBackend() {
  vi.mocked(ghStarHistoryPage).mockImplementation((repo, page, slug, _host) => {
    const key = `${repo}#${page}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const failure = failures.find(
      (f) => f.repo === repo && f.page === page && f.attempt === attempt,
    );
    // A slug's own pages outrank the checkout's.
    const answer = (fixtures[slug] ?? fixtures[repo])?.[page - 1];
    const settle = (
      resolve: (p: StarHistoryPage) => void,
      reject: (e: unknown) => void,
    ) => {
      if (failure) reject(failure.error);
      else if (answer) resolve(answer);
      else reject(new Error(`no fixture for ${key}`));
    };
    return new Promise<StarHistoryPage>((resolve, reject) => {
      if (!holdFor.has(repo)) return settle(resolve, reject);
      held.push({
        repo,
        page,
        settle: () => settle(resolve, reject),
        done: false,
      });
    });
  });
}

/** Answers the oldest unanswered held call for `page`. */
async function release(page: number, repo = REPO) {
  const call = held.find((h) => !h.done && h.page === page && h.repo === repo);
  if (!call) throw new Error(`no held call for ${repo} page ${page}`);
  call.done = true;
  await act(async () => call.settle());
}

const pagesCalled = (repo = REPO) =>
  vi
    .mocked(ghStarHistoryPage)
    .mock.calls.filter(([r]) => r === repo)
    .map(([, page]) => page);

/** Lets every scheduled fetch and render land, for absence checks. */
async function flush() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}

/** The board on a fresh client, or on `client` (the app's, for its offline
 *  park). */
function renderBoard(
  repo = REPO,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const ui = (repoPath: string, hidden: boolean) => (
    <QueryClientProvider client={client}>
      <TabPanel active={!hidden}>
        <InsightsBoard repoPath={repoPath} active />
      </TabPanel>
    </QueryClientProvider>
  );
  const view = render(ui(repo, false));
  return {
    client,
    rerender: (repoPath: string, hidden = false) =>
      view.rerender(ui(repoPath, hidden)),
  };
}

function card(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: "Star history", hidden: true })
    .closest("section");
  if (!section) throw new Error("no Star history card");
  return section;
}
/** The always-mounted header slot, the in-card Retry's focus host. */
const slot = () => {
  const host = card().querySelector<HTMLElement>('span[tabindex="-1"]');
  if (!host) throw new Error("no header slot host");
  return host;
};
const cardBodyEl = () => card().children[1] as HTMLElement;
const caption = () => card().querySelector("figcaption")?.textContent ?? null;
const tableRows = () => card().querySelectorAll("tbody tr").length;
const cardRetry = () =>
  within(card()).queryByRole("button", { name: "Retry loading older weeks" });
const button = (name: string) => screen.getByRole("button", { name });

const LEAD = "Today's stargazers by the week they starred";
const GAINS = `${LEAD}, as new stars per week.`;
const headers = () =>
  [...card().querySelectorAll("thead th")].map((h) => h.textContent);
const OFFLINE =
  "You're offline — older weeks will load once you're back online.";
const STAR_KEY = ["repo", REPO, "insights", "starHistory", SERIES];
const FORK_KEY = ["repo", REPO, "insights", "starHistory", `${HOST}/${FORK}`];
const COMMUNITY_KEY = ["repo", REPO, "insights", "community"];
const partialLine = (oldestIndex: number) =>
  `Showing since ${monthYearLabel(NEWEST - oldestIndex * WEEK)} — couldn't load older weeks.`;

beforeEach(() => {
  vi.mocked(ghStarHistoryPage).mockReset();
  vi.mocked(peekRepoIdentity).mockImplementation(() => undefined);
  vi.mocked(forgeStatus).mockReset();
  slugs = { [REPO]: SLUG, [OTHER]: "owner/other" };
  hosts = {};
  vi.mocked(forgeStatus).mockImplementation(async (path) => ({
    ...GITHUB,
    repo: slugs[path] ?? SLUG,
    host: hosts[path] ?? HOST,
  }));
  fixtures = { [REPO]: pagesOf(OLD_150, 140) };
  failures = [];
  holdFor.clear();
  attempts.clear();
  held.length = 0;
  installBackend();
});

afterEach(() => {
  onlineManager.setOnline(true);
  // The app's client outlives a test: unmount its observers, then empty it.
  cleanup();
  appQueryClient.clear();
});

describe("Star history: the 52-week window", () => {
  it("holds a skeleton until two pages fill the window, then draws once", async () => {
    holdFor.add(REPO);
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    expect(caption()).toBeNull();
    expect(cardBodyEl().querySelector('[data-slot="skeleton"]')).not.toBeNull();
    await release(2);
    await waitFor(() =>
      expect(caption()).toBe(`${LEAD}. 140 stars, +34 in the last 52 weeks.`),
    );
    expect(slot().textContent).toBe("140 stars · +34 in 52 weeks");
    expect(tableRows()).toBe(52);
    const firstRow = card().querySelector("tbody tr");
    expect(firstRow?.textContent).toContain(weekLabel(NEWEST - 51 * WEEK));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
  });

  it("draws a young history from its first week, without the gain clause", async () => {
    fixtures[REPO] = pagesOf(YOUNG_21, 246);
    renderBoard();
    await waitFor(() => expect(caption()).toBe(`${LEAD}. 246 stars.`));
    expect(slot().textContent).toBe("246 stars");
    expect(tableRows()).toBe(21);
    expect(pagesCalled()).toEqual([1]);
  });

  it("a page that names itself as next ends the series", async () => {
    fixtures[REPO] = [{ ...pagesOf(YOUNG_21, 246)[0], nextPage: 1 }];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await flush();
    expect(pagesCalled()).toEqual([1]);
  });
});

describe("Star history: All time", () => {
  it("dims the window under a page counter, then draws the whole curve once", async () => {
    holdFor.add(REPO);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await waitFor(() => expect(caption()).not.toBeNull());
    const allTime = button("All time");
    await user.click(allTime);
    expect(document.activeElement).toBe(allTime);
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 2 of 5"),
    );
    expect(card().getAttribute("aria-busy")).toBe("true");
    expect(cardBodyEl().hasAttribute("inert")).toBe(true);
    // The window stays up while older weeks load.
    expect(tableRows()).toBe(52);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    await release(3);
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 3 of 5"),
    );
    expect(tableRows()).toBe(52);
    await release(4);
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 4 of 5"),
    );
    await release(5);
    await waitFor(() => expect(slot().textContent).toBe("140 stars"));
    expect(caption()).toBe(
      `${LEAD}. 140 stars since ${monthYearLabel(NEWEST - 149 * WEEK)}.`,
    );
    expect(card().hasAttribute("aria-busy")).toBe(false);
    expect(cardBodyEl().hasAttribute("inert")).toBe(false);
    expect(tableRows()).toBe(150);
    expect(document.activeElement).toBe(allTime);
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]);
  });

  it("loads a 31-page history to its end", async () => {
    const totals = [...OLD_150, ...fill(780, 0)];
    fixtures[REPO] = pagesOf(totals, 140);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(tableRows()).toBe(930));
    expect(slot().textContent).toBe("140 stars");
    await flush();
    expect(pagesCalled()).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  it("going back to 52 weeks stops the drive; the page in flight still lands", async () => {
    holdFor.add(REPO);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    await user.click(button("52 weeks"));
    expect(slot().textContent).toBe("140 stars · +34 in 52 weeks");
    expect(card().hasAttribute("aria-busy")).toBe(false);
    await release(3);
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3]);
    expect(caption()).toBe(`${LEAD}. 140 stars, +34 in the last 52 weeks.`);
    // It landed: All time asks for the page after it.
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4]));
  });

  it("a park offline stops the drive until the connection returns", async () => {
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    act(() => onlineManager.setOnline(false));
    await user.click(button("All time"));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    expect(slot().textContent).toBe("140 stars · +34 in 52 weeks");
    expect(card().hasAttribute("aria-busy")).toBe(false);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]);
  });

  it("a hidden tab loads no pages, and showing it resumes the drive", async () => {
    holdFor.add(REPO);
    const user = userEvent.setup();
    const board = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    board.rerender(REPO, true);
    await release(3);
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3]);
    board.rerender(REPO, false);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4]));
  });

  it("a repo switch mid-load never paints the old repo's weeks", async () => {
    holdFor.add(REPO);
    fixtures[OTHER] = pagesOf(YOUNG_21, 246);
    const board = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    board.rerender(OTHER);
    await waitFor(() => expect(caption()).toBe(`${LEAD}. 246 stars.`));
    await release(2);
    await flush();
    expect(caption()).toBe(`${LEAD}. 246 stars.`);
    expect(slot().textContent).toBe("246 stars");
    expect(tableRows()).toBe(21);
    expect(pagesCalled(OTHER)).toEqual([1]);
  });
});

describe("Star history: a failed older page", () => {
  it("keeps the loaded span; Retry resumes at that page and keeps the span drawn", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: RATE_LIMITED }];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() =>
      expect(within(card()).getByText(partialLine(59))).toBeTruthy(),
    );
    expect(
      screen.getByText(
        "Couldn't refresh some insights while GitHub's API rate limit is in effect — showing the last loaded ones.",
      ),
    ).toBeTruthy();
    const span = `${LEAD}. 140 stars; showing weeks since ${monthYearLabel(NEWEST - 59 * WEEK)}.`;
    expect(caption()).toBe(span);
    expect(tableRows()).toBe(60);
    expect(slot().textContent).toBe("140 stars");
    expect(card().hasAttribute("aria-busy")).toBe(false);
    // No retry of its own: the failed page waits for a press.
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3]);

    holdFor.add(REPO);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3]));
    // The line holds through its own retry.
    await flush();
    expect(cardRetry()).not.toBeNull();
    expect(pagesCalled()).toEqual([1, 2, 3, 3]);

    await release(3);
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 3 of 5"),
    );
    expect(cardRetry()).toBeNull();
    // Focus left with the Retry and landed on the header slot, outside the
    // body the resumed load dims.
    expect(document.activeElement).toBe(slot());
    expect(cardBodyEl().hasAttribute("inert")).toBe(true);
    // The resume keeps the span it showed, never the window.
    expect(caption()).toBe(
      `${LEAD}. 140 stars; showing weeks since ${monthYearLabel(NEWEST - 89 * WEEK)}.`,
    );
    expect(tableRows()).toBe(90);
    await release(4);
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 4 of 5"),
    );
    expect(tableRows()).toBe(120);
    await release(5);
    await waitFor(() => expect(slot().textContent).toBe("140 stars"));
    expect(tableRows()).toBe(150);
  });

  // The page in flight fails once its view has moved on. The read stays a
  // success (a marker), so it never sits static: the card shows the span and
  // its Retry wherever the view needs the page, and the read still ages.
  it.each(["52 weeks", "a hide", "a repo switch"] as const)(
    "a page that fails after %s leaves the span and its Retry, and the read still ages",
    async (leave) => {
      holdFor.add(REPO);
      fixtures[OTHER] = pagesOf(YOUNG_21, 246);
      failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
      const user = userEvent.setup();
      const board = renderBoard();
      await waitFor(() => expect(pagesCalled()).toEqual([1]));
      await release(1);
      await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
      await release(2);
      await user.click(button("All time"));
      await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
      if (leave === "52 weeks") await user.click(button("52 weeks"));
      if (leave === "a hide") board.rerender(REPO, true);
      if (leave === "a repo switch") board.rerender(OTHER);
      await release(3);
      await flush();
      expect(board.client.getQueryState(STAR_KEY)?.status).toBe("success");
      if (leave === "52 weeks") {
        // A full window loses nothing to it: neither the card nor the board
        // says so.
        expect(cardRetry()).toBeNull();
        expect(screen.queryByText(/Couldn't refresh some insights/)).toBeNull();
        await user.click(button("All time"));
      }
      if (leave === "a hide") board.rerender(REPO, false);
      if (leave === "a repo switch") board.rerender(REPO);
      await waitFor(() =>
        expect(within(card()).getByText(partialLine(59))).toBeTruthy(),
      );
      expect(cardRetry()).not.toBeNull();
      expect(screen.getByText(/Couldn't refresh some insights/)).toBeTruthy();
      await flush();
      expect(pagesCalled()).toEqual([1, 2, 3]);
      // Past its staleTime a remount walks from page 1, and the walk fills
      // the failed page's place before the drive carries on.
      holdFor.delete(REPO);
      const later = Date.now() + 31 * 60_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        board.rerender(REPO, true);
        board.rerender(REPO, false);
        await waitFor(() => expect(tableRows()).toBe(150));
      } finally {
        clock.mockRestore();
      }
      expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
      expect(cardRetry()).toBeNull();
    },
  );

  it("a Retry that fails again leaves the marker; each attempt is one press", async () => {
    failures = [
      { repo: REPO, page: 3, attempt: 1, error: TRANSPORT },
      { repo: REPO, page: 3, attempt: 2, error: TRANSPORT },
    ];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    await user.click(button("52 weeks"));
    expect(screen.queryByText(/Couldn't refresh some insights/)).toBeNull();
    await user.click(button("All time"));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't refresh some insights/)).toBeTruthy(),
    );
    expect(pagesCalled()).toEqual([1, 2, 3]);
    await user.click(button("Retry loading insights"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3]));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't refresh some insights/)).toBeTruthy(),
    );
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3, 3]);
    expect(within(card()).getByText(partialLine(59))).toBeTruthy();
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 3, 3, 4, 5]);
  });

  it("the next refetch walk leaves a marker where the page fails again, then fills it", async () => {
    failures = [
      { repo: REPO, page: 3, attempt: 1, error: TRANSPORT },
      { repo: REPO, page: 3, attempt: 2, error: TRANSPORT },
    ];
    vi.mocked(forgeRepoSetStar).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    const toggle = renderHook(() => useSetRepoStar(REPO), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }).result;
    // A star toggle's walk: fresh pages up to the marker's place, a marker
    // there again, and nothing after it.
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3]));
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3]);
    expect(within(card()).getByText(partialLine(59))).toBeTruthy();
    // The next walk fills it, and the drive carries on from there.
    await act(() => toggle.current.mutateAsync(false));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 5]);
    expect(cardRetry()).toBeNull();
  });

  it("a failed refresh over a full window still reaches the board", async () => {
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    failures = [{ repo: REPO, page: 1, attempt: 2, error: TRANSPORT }];
    await act(() => client.refetchQueries({ queryKey: STAR_KEY }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't refresh some insights — showing the last loaded ones.",
        ),
      ).toBeTruthy(),
    );
  });

  it("windowed: a failed second page draws the first; Retry fills the window", async () => {
    failures = [{ repo: REPO, page: 2, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() =>
      expect(within(card()).getByText(partialLine(29))).toBeTruthy(),
    );
    expect(caption()).toBe(`${LEAD}. 140 stars.`);
    expect(slot().textContent).toBe("140 stars");
    expect(tableRows()).toBe(30);
    expect(
      screen.getByText(
        "Couldn't refresh some insights — showing the last loaded ones.",
      ),
    ).toBeTruthy();
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() =>
      expect(slot().textContent).toBe("140 stars · +34 in 52 weeks"),
    );
    expect(cardRetry()).toBeNull();
    expect(document.activeElement).toBe(slot());
    expect(pagesCalled()).toEqual([1, 2, 2]);
  });

  it("the board's Retry resumes at the failed page, not page 1", async () => {
    failures = [{ repo: REPO, page: 2, attempt: 1, error: RATE_LIMITED }];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    expect(
      screen.getByText(
        "Couldn't refresh some insights while GitHub's API rate limit is in effect — showing the last loaded ones.",
      ),
    ).toBeTruthy();
    await user.click(button("Retry loading insights"));
    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() =>
      expect(slot().textContent).toBe("140 stars · +34 in 52 weeks"),
    );
    expect(pagesCalled()).toEqual([1, 2, 2]);
  });

  it("without a count, says neither the count nor the gain", async () => {
    fixtures[REPO] = pagesOf(OLD_150, null);
    failures = [{ repo: REPO, page: 2, attempt: 1, error: TRANSPORT }];
    renderBoard();
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    expect(slot().textContent).toBe("");
    expect(caption()).toBe(GAINS);
  });
});

/** The Y axis's tick values, which the plotted series decides. */
const yTicks = () =>
  [
    ...card().querySelectorAll(
      ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
    ),
  ].map((t) => Number(t.textContent?.replace(/,/g, "")));

describe("Star history: an unknown count", () => {
  // jsdom lays nothing out, and Recharts draws no surface at a zero size.
  beforeEach(() => {
    const size = { x: 0, y: 0, top: 0, left: 0, width: 320, height: 160 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      ...size,
      right: 320,
      bottom: 160,
      toJSON: () => size,
    });
  });
  afterEach(() =>
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore(),
  );

  it("draws weekly gains while pages are owed, then the running total", async () => {
    // 13 pages; GitHub sent no count on page 1.
    fixtures[REPO] = pagesOf(fill(390, 1), null);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    // Each week's gain of 1 is plotted, not the running total (339 to 390).
    await waitFor(() => expect(yTicks().length).toBeGreaterThan(0));
    expect(Math.max(...yTicks())).toBeLessThan(10);
    expect(pagesCalled()).toEqual([1, 2]);
    expect(headers()).toEqual(["Week", "New stars"]);
    expect(caption()).toBe(GAINS);
    // The window's gain is exact without a count; the count stays out.
    expect(slot().textContent).toBe("+52 in 52 weeks");
    expect(card().querySelector("tbody tr")?.textContent).toBe(
      `${weekLabel(NEWEST - 51 * WEEK)}1`,
    );
    await user.click(button("All time"));
    await waitFor(() => expect(slot().textContent).toBe("390 stars"));
    expect(headers()).toEqual(["Week", "New stars", "Total"]);
    expect(tableRows()).toBe(390);
    // The running total is plotted now, up to its 390.
    expect(Math.max(...yTicks())).toBeGreaterThanOrEqual(390);
    expect(caption()).toBe(
      `${LEAD}. 390 stars since ${monthYearLabel(NEWEST - 389 * WEEK)}.`,
    );
  });
});

describe("Star history: a failed refresh", () => {
  async function refreshThenAllTime(refreshFails: boolean) {
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    if (refreshFails)
      failures = [{ repo: REPO, page: 1, attempt: 2, error: TRANSPORT }];
    await act(() =>
      client.refetchQueries({
        queryKey: ["repo", REPO, "insights", "starHistory"],
      }),
    );
    await user.click(button("All time"));
    await flush();
  }

  it("All time draws the loaded span, issues no pages, and its Retry re-runs the refresh", async () => {
    await refreshThenAllTime(true);
    expect(pagesCalled()).toEqual([1, 2, 1]);
    expect(caption()).toBe(
      `${LEAD}. 140 stars; showing weeks since ${monthYearLabel(NEWEST - 59 * WEEK)}.`,
    );
    expect(within(card()).getByText(partialLine(59))).toBeTruthy();
    expect(
      screen.getByText(
        "Couldn't refresh some insights — showing the last loaded ones.",
      ),
    ).toBeTruthy();
    expect(slot().textContent).toBe("140 stars");
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await userEvent.setup().click(retry);
    await waitFor(() => expect(tableRows()).toBe(150));
    // The refresh's own arm: every loaded page again, then the drive.
    expect(pagesCalled()).toEqual([1, 2, 1, 1, 2, 3, 4, 5]);
  });

  it("control: a refresh that lands lets All time drive on", async () => {
    await refreshThenAllTime(false);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 1, 2, 3, 4, 5]);
  });
});

describe("Star history: copy and gates", () => {
  it("shows the live count over a history that sums past it", async () => {
    // 31 stars across the weeks, 30 live: the curve ends at 31.
    fixtures[REPO] = pagesOf([2, ...fill(29, 1)], 30);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).toBe(`${LEAD}. 30 stars.`));
    expect(slot().textContent).toBe("30 stars");
    await user.click(button("All time"));
    await waitFor(() =>
      expect(caption()).toBe(
        `${LEAD}. 30 stars since ${monthYearLabel(NEWEST - 29 * WEEK)}.`,
      ),
    );
    expect(slot().textContent).toBe("30 stars");
    expect(card().querySelector("tbody tr:last-child")?.textContent).toMatch(
      /31$/,
    );
  });

  it("says when the history isn't available, with no header", async () => {
    fixtures[REPO] = [
      {
        available: false,
        weeks: [],
        nextPage: null,
        lastPage: null,
        stargazersCount: null,
      },
    ];
    renderBoard();
    await waitFor(() =>
      expect(
        within(card()).getByText(
          "Star history isn't available for this repository.",
        ),
      ).toBeTruthy(),
    );
    expect(slot().textContent).toBe("");
    expect(caption()).toBeNull();
    await flush();
    expect(pagesCalled()).toEqual([1]);
  });

  it("says the same for a GitHub repo whose status names no host, reading nothing", async () => {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      repo: SLUG,
      host: null,
    } as unknown as ForgeStatus);
    renderBoard();
    await waitFor(() =>
      expect(
        within(card()).getByText(
          "Star history isn't available for this repository.",
        ),
      ).toBeTruthy(),
    );
    expect(card().querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(slot().textContent).toBe("");
    await flush();
    expect(pagesCalled()).toEqual([]);
  });

  it("a 0-star repo draws a flat line with no header, said once", async () => {
    // jsdom lays nothing out, and Recharts draws no surface at a zero size.
    const size = { x: 0, y: 0, top: 0, left: 0, width: 320, height: 160 };
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        ...size,
        right: 320,
        bottom: 160,
        toJSON: () => size,
      });
    try {
      fixtures[REPO] = pagesOf(fill(21, 0), 0);
      renderBoard();
      await waitFor(() =>
        expect(within(card()).getByText("No stars yet.")).toBeTruthy(),
      );
      expect(caption()).toBe(`${LEAD}.`);
      expect(slot().textContent).toBe("");
      expect(tableRows()).toBe(21);
      // The series draws one level line across the plot.
      const curve = await waitFor(() => {
        const path = card().querySelector(".recharts-area-curve");
        if (!path?.getAttribute("d")) throw new Error("no area curve");
        return path.getAttribute("d") ?? "";
      });
      const ys = [...curve.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) =>
        Number(m[2]),
      );
      expect(ys.length).toBeGreaterThan(1);
      expect(new Set(ys).size).toBe(1);
    } finally {
      rect.mockRestore();
    }
  });

  it("names the card's group and its figure by the title, adding no landmark", async () => {
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    const region = screen.getByRole("group", { name: "Star history" });
    expect(region).toBe(card());
    expect(screen.queryAllByRole("region")).toEqual([]);
    const figure = within(region).getByRole("figure", { name: "Star history" });
    const described = figure.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe(
      caption(),
    );
    expect(
      within(region).getByRole("table", {
        name: "Star history data",
        hidden: true,
      }),
    ).toBeTruthy();
  });

  it("names the chart surface by the card title", async () => {
    // jsdom lays nothing out, and Recharts draws no surface at a zero size.
    const size = { x: 0, y: 0, top: 0, left: 0, width: 320, height: 160 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      ...size,
      right: 320,
      bottom: 160,
      toJSON: () => size,
    });
    try {
      renderBoard();
      await waitFor(() => expect(caption()).not.toBeNull());
      expect(
        within(card()).getByRole("application", {
          name: "Star history chart",
        }),
      ).toBeTruthy();
    } finally {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
    }
  });

  it("an old 0-star repo counts its pages while All time loads", async () => {
    fixtures[REPO] = pagesOf(fill(150, 0), 0);
    holdFor.add(REPO);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await waitFor(() => expect(tableRows()).toBe(52));
    expect(slot().textContent).toBe("");
    await user.click(button("All time"));
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 2 of 5"),
    );
    for (const page of [3, 4, 5]) {
      await waitFor(() => expect(pagesCalled()).toContain(page));
      await release(page);
    }
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(slot().textContent).toBe("");
    expect(within(card()).getByText("No stars yet.")).toBeTruthy();
  });

  it("names a quiet tail of 4 weeks or more", async () => {
    fixtures[REPO] = pagesOf([0, 0, 0, 0, ...fill(17, 3)], 51);
    renderBoard();
    await waitFor(() =>
      expect(
        within(card()).getByText("No new stars in the last 4 weeks."),
      ).toBeTruthy(),
    );
  });

  it("says nothing of a 3-week quiet tail", async () => {
    fixtures[REPO] = pagesOf([0, 0, 0, ...fill(18, 3)], 54);
    renderBoard();
    await waitFor(() => expect(caption()).toBe(`${LEAD}. 54 stars.`));
    expect(within(card()).queryByText(/No new stars/)).toBeNull();
  });

  it("skips a malformed week and still draws", async () => {
    const [page] = pagesOf(YOUNG_21, 246);
    page.weeks[3] = { week: page.weeks[3].week, total: "12" as never };
    fixtures[REPO] = [page];
    renderBoard();
    await waitFor(() => expect(caption()).toBe(`${LEAD}. 246 stars.`));
    expect(tableRows()).toBe(20);
  });

  it("a failed first page says it couldn't load", async () => {
    failures = [{ repo: REPO, page: 1, attempt: 1, error: TRANSPORT }];
    renderBoard();
    await waitFor(() =>
      expect(
        within(card()).getByText("Couldn't load star history."),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/^Couldn't load some insights\./)).toBeTruthy();
    expect(slot().textContent).toBe("");
  });

  it("offline with nothing loaded says it waits for the connection", async () => {
    onlineManager.setOnline(false);
    renderBoard();
    await waitFor(() =>
      expect(
        within(card()).getByText(
          "You're offline — star history will load once you're back online.",
        ),
      ).toBeTruthy(),
    );
    expect(pagesCalled()).toEqual([]);
  });

  it("is absent on GitLab", async () => {
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      provider: "gitlab",
    });
    renderBoard();
    await waitFor(() => expect(screen.getByText("Pipelines")).toBeTruthy());
    expect(
      screen.queryByRole("heading", { name: "Star history", hidden: true }),
    ).toBeNull();
    expect(pagesCalled()).toEqual([]);
  });

  it("holds a skeleton while the forge is still detected", async () => {
    vi.mocked(forgeStatus).mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    renderBoard();
    expect(cardBodyEl().querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(pagesCalled()).toEqual([]);
  });
});

describe("Star history: across refreshes, switches and reconnects", () => {
  const KEY = STAR_KEY;

  it("a failed older page leaves a fresh success: the focus pass skips it, and it isn't static", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    const query = client.getQueryCache().find({ queryKey: KEY });
    if (!query) throw new Error("no star query");
    const focusRefetches = focusRefetchPredicate(new Set());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    expect(query.state.status).toBe("success");
    expect(query.isStatic()).toBe(false);
    expect(focusRefetches(query as never)).toBe(false);
  });

  it("a repo switch and back mid-load resumes the returning repo's pages", async () => {
    holdFor.add(REPO);
    fixtures[OTHER] = pagesOf(YOUNG_21, 246);
    const user = userEvent.setup();
    const board = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    await release(3);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4]));
    board.rerender(OTHER);
    await waitFor(() => expect(tableRows()).toBe(21));
    // Page 4 lands in the away repo's cache.
    await release(4);
    board.rerender(REPO);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]));
    expect(pagesCalled(OTHER)).toEqual([1]);
    await release(5);
    await waitFor(() => expect(slot().textContent).toBe("140 stars"));
    expect(tableRows()).toBe(150);
  });

  it("a drive the reconnect starts moves focus out of the body before it goes inert", async () => {
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    act(() => onlineManager.setOnline(false));
    await user.click(button("All time"));
    await flush();
    const summary = card().querySelector("summary");
    if (!summary) throw new Error("no table toggle");
    act(() => summary.focus());
    expect(document.activeElement).toBe(summary);
    holdFor.add(REPO);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(cardBodyEl().hasAttribute("inert")).toBe(true));
    expect(document.activeElement).toBe(slot());
  });

  it("a drive the toggle starts leaves focus on the toggle", async () => {
    holdFor.add(REPO);
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await waitFor(() => expect(caption()).not.toBeNull());
    const allTime = button("All time");
    await user.click(allTime);
    await waitFor(() => expect(cardBodyEl().hasAttribute("inert")).toBe(true));
    expect(document.activeElement).toBe(allTime);
  });

  it("a windowed park draws page 1, and the reconnect keeps it drawn", async () => {
    holdFor.add(REPO);
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    act(() => onlineManager.setOnline(false));
    await release(1);
    await waitFor(() => expect(tableRows()).toBe(30));
    expect(pagesCalled()).toEqual([1]);
    expect(within(card()).getByText(OFFLINE)).toBeTruthy();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    expect(cardBodyEl().querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(tableRows()).toBe(30);
    expect(within(card()).queryByText(OFFLINE)).toBeNull();
    await release(2);
    await waitFor(() => expect(tableRows()).toBe(52));
  });

  it("All time parked over a full window says it waits for the connection", async () => {
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    act(() => onlineManager.setOnline(false));
    await user.click(button("All time"));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    expect(tableRows()).toBe(52);
    expect(within(card()).getByText(OFFLINE)).toBeTruthy();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(within(card()).queryByText(OFFLINE)).toBeNull();
  });

  it("a refresh parked over a full window says nothing of the connection", async () => {
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    act(() => onlineManager.setOnline(false));
    act(() => {
      void client.refetchQueries({ queryKey: KEY });
    });
    await flush();
    expect(
      client.getQueryCache().find({ queryKey: KEY })?.state.fetchStatus,
    ).toBe("paused");
    expect(within(card()).queryByText(OFFLINE)).toBeNull();
  });

  it("a read that lost its data waits for 52 weeks again", async () => {
    const board = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    board.rerender(REPO, true);
    board.client.removeQueries({ queryKey: KEY });
    holdFor.add(REPO);
    board.rerender(REPO, false);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 2]));
    expect(caption()).toBeNull();
    expect(cardBodyEl().querySelector('[data-slot="skeleton"]')).not.toBeNull();
    await release(2);
    await waitFor(() => expect(tableRows()).toBe(52));
  });

  // The second press lands on the held Retry (star-history-card.test.tsx pins
  // that it calls nothing); this pins the board end: no second walk starts.
  it("a second Retry press starts no second walk", async () => {
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    failures = [{ repo: REPO, page: 1, attempt: 2, error: TRANSPORT }];
    await act(() => client.refetchQueries({ queryKey: KEY }));
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    holdFor.add(REPO);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 1]));
    await user.click(retry);
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 1, 1]);
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 1, 2]));
  });

  it("holds the in-card Retry while its walk runs, focusable and inert to presses", async () => {
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    failures = [{ repo: REPO, page: 1, attempt: 2, error: TRANSPORT }];
    await act(() => client.refetchQueries({ queryKey: KEY }));
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    expect(retry.hasAttribute("aria-disabled")).toBe(false);
    holdFor.add(REPO);
    await user.click(retry);
    await waitFor(() =>
      expect(retry.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(cardRetry()).toBe(retry);
    expect(document.activeElement).toBe(retry);
    const reason = retry.getAttribute("aria-describedby");
    expect(reason && document.getElementById(reason)?.textContent).toBe(
      "Loading older weeks…",
    );
    // A held press calls nothing (pinned in star-history-card.test.tsx);
    // here only that no page call follows.
    await user.keyboard("{Enter}");
    retry.click();
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 1, 1]);
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 1, 2]));
    await release(2);
    await waitFor(() => expect(cardRetry()).toBeNull());
    expect(document.activeElement).toBe(slot());
  });

  it("names the empty header host for the focus it may take", async () => {
    fixtures[REPO] = pagesOf(fill(21, 0), 0);
    const board = renderBoard();
    await waitFor(() =>
      expect(within(card()).getByText("No stars yet.")).toBeTruthy(),
    );
    // A group, which can carry the name (a generic span can't), named apart
    // from the card's own group.
    const SUMMARY = "Star history summary";
    expect(within(card()).getByRole("group", { name: SUMMARY })).toBe(slot());
    expect(screen.getByRole("group", { name: "Star history" })).toBe(card());
    fixtures[OTHER] = pagesOf(YOUNG_21, 246);
    board.rerender(OTHER);
    await waitFor(() => expect(slot().textContent).toBe("246 stars"));
    expect(within(card()).getByRole("group", { name: SUMMARY })).toBe(slot());
  });
});

describe("Star history: writes and starring", () => {
  it("a whole-repo write settle leaves star history alone", async () => {
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    act(() => {
      void invalidateRepoAfterWrite(client, REPO);
    });
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(false);
    // Control: the settle reached the repo's other reads.
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(true);
  });

  it("a write settle over a page in flight leaves it to land, re-reading nothing", async () => {
    holdFor.add(REPO);
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    act(() => {
      void invalidateRepoAfterWrite(client, REPO);
    });
    await release(3);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4]));
    await release(4);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]));
    await release(5);
    await waitFor(() => expect(tableRows()).toBe(150));
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]);
  });

  it("a write settle while hidden over a page in flight: showing it resumes, re-reading nothing", async () => {
    holdFor.add(REPO);
    const user = userEvent.setup();
    const board = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    board.rerender(REPO, true);
    act(() => {
      void invalidateRepoAfterWrite(board.client, REPO);
    });
    await release(3);
    await flush();
    board.rerender(REPO, false);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 4]));
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3, 4]);
  });

  it("a star toggle refreshes star history and Community, in the repo it fired in", async () => {
    let land: () => void = () => undefined;
    vi.mocked(forgeRepoSetStar).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const toggle = renderHook(({ repo }) => useSetRepoStar(repo), {
      wrapper,
      initialProps: { repo: REPO },
    });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = toggle.result.current.mutateAsync(true);
    });
    await waitFor(() =>
      expect(forgeRepoSetStar).toHaveBeenCalledWith(REPO, true),
    );
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(false);
    // The host moves to another repo before the write lands.
    toggle.rerender({ repo: OTHER });
    await act(async () => {
      land();
      await done;
    });
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 2]));
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(true);
    expect(pagesCalled(OTHER)).toEqual([]);
  });
});

describe("Star history: every whole-repo settle", () => {
  it("the shared predicate skips star history alone", () => {
    expect(repoKeys.starHistory(REPO, SERIES)).toEqual(STAR_KEY);
    expect(settlesOnRepoWrite({ queryKey: STAR_KEY })).toBe(false);
    expect(settlesOnRepoWrite({ queryKey: [...STAR_KEY, "x"] })).toBe(false);
    expect(settlesOnRepoWrite({ queryKey: COMMUNITY_KEY })).toBe(true);
    expect(settlesOnRepoWrite({ queryKey: ["repo", REPO] })).toBe(true);
    expect(settlesOnRepoWrite({ queryKey: ["repo", REPO, "status"] })).toBe(
      true,
    );
  });

  /** Mounts a write hook on the board's client, runs it, then reports whether
   *  star history refetched or was marked, beside the Community control. */
  async function settleThrough(
    mount: (client: QueryClient) => () => Promise<unknown>,
  ) {
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const write = mount(client);
    await act(() => write());
    await flush();
    return {
      pages: pagesCalled(),
      starMarked: client.getQueryState(STAR_KEY)?.isInvalidated,
      communityMarked: client.getQueryState(COMMUNITY_KEY)?.isInvalidated,
    };
  }
  const hookOn = <T,>(client: QueryClient, hook: () => T) =>
    renderHook(hook, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }).result;

  // A write on useRepoMutation's whole-repo default, as a push is; usePush
  // itself is held to its push-route guards, which a test call would trip.
  it("a write on the whole-repo default leaves star history alone", async () => {
    vi.mocked(gitUpdateHookManager).mockResolvedValue("updated");
    const result = await settleThrough((client) => {
      const update = hookOn(client, () => useUpdateHookManager(REPO));
      return () => update.current.mutateAsync("husky");
    });
    expect(gitUpdateHookManager).toHaveBeenCalledWith(REPO, "husky");
    expect(result).toEqual({
      pages: [1, 2],
      starMarked: false,
      communityMarked: true,
    });
  });

  it("a fork re-points origin: the parent's pages go and a fresh walk reads the fork's", async () => {
    vi.mocked(ghRepoFork).mockImplementation(async () => {
      forkOrigin();
      return "" as never;
    });
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    expect(caption()).toContain("140 stars");
    const fork = hookOn(client, () => useForkRepo(REPO));
    await act(() => fork.current.mutateAsync(false));
    await waitFor(() => expect(caption()).toContain("150 stars"));
    expect(caption()).not.toContain("140 stars");
    expect(pagesCalled()).toEqual([1, 2, 1, 2]);
    await user.click(button("All time"));
    await waitFor(() => expect(tableRows()).toBe(90));
    expect(pagesCalled()).toEqual([1, 2, 1, 2, 3]);
    // Every page of the fork's series is the fork's, in order, and the
    // parent's series keeps only the parent's.
    expect(
      client.getQueryData<{ pages: StarHistoryPage[] }>(FORK_KEY)?.pages,
    ).toEqual(pagesOf(FORK_90, 150));
    expect(
      client.getQueryData<{ pages: StarHistoryPage[] }>(STAR_KEY)?.pages,
    ).toEqual(pagesOf(OLD_150, 140).slice(0, 2));
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(true);
  });

  it("an update run inside this repo's checkout leaves its star history alone", async () => {
    vi.mocked(gitUpdateBranchFrom).mockResolvedValue({
      outcome: "merge",
      holder: REPO,
    });
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const update = renderHook(() => useUpdateBranchFrom(OTHER), { wrapper });
    await act(() =>
      update.result.current.mutateAsync({ branch: "feat", base: "main" }),
    );
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(false);
    // Control: the holder's other reads were invalidated.
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(true);
  });
});

describe("Star history: writes that reset it", () => {
  const hookOn = <T,>(client: QueryClient, hook: () => T) =>
    renderHook(hook, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }).result;

  it("an origin set-url walks the new origin from page 1", async () => {
    vi.mocked(gitRemoteSetUrl).mockImplementation(async () => {
      forkOrigin();
    });
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const set = hookOn(client, () => useSetRemoteUrl(REPO));
    await act(() => set.current.mutateAsync({ name: "origin", url: "x" }));
    await waitFor(() => expect(caption()).toContain("150 stars"));
    expect(pagesCalled()).toEqual([1, 2, 1, 2]);
  });

  it("control: an upstream set-url keeps the pages", async () => {
    vi.mocked(gitRemoteSetUrl).mockResolvedValue(undefined as never);
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const set = hookOn(client, () => useSetRemoteUrl(REPO));
    await act(() => set.current.mutateAsync({ name: "upstream", url: "x" }));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(false);
    expect(caption()).toContain("140 stars");
  });

  it("a delete drops the deleted repo's pages and reads none from it", async () => {
    vi.mocked(forgeRepoDelete).mockResolvedValue(undefined as never);
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const del = hookOn(client, () => useDeleteRepo(REPO));
    await act(() => del.current.mutateAsync());
    await flush();
    expect(client.getQueryData(STAR_KEY)).toBeUndefined();
    expect(pagesCalled()).toEqual([1, 2]);
    expect(within(card()).queryByText(/couldn't load/i)).toBeNull();
  });

  it("a failed visibility change still walks star history again", async () => {
    vi.mocked(forgeRepoSetVisibility).mockRejectedValue(TRANSPORT);
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const vis = hookOn(client, () => useSetVisibility(REPO));
    await act(() => vis.current.mutateAsync("private").catch(() => undefined));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 2]));
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(true);
  });

  it("a fork that fails after re-pointing origin still walks the fork", async () => {
    vi.mocked(ghRepoFork).mockImplementation(async () => {
      forkOrigin();
      throw new Error("gh repo set-default failed");
    });
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    const fork = hookOn(client, () => useForkRepo(REPO));
    await act(() => fork.current.mutateAsync(false).catch(() => undefined));
    await waitFor(() => expect(caption()).toContain("150 stars"));
    expect(pagesCalled()).toEqual([1, 2, 1, 2]);
  });

  it("a visibility change walks every checkout's series of the repo's, and no other slug's or host's", async () => {
    const SIBLING = "C:/repo-wt";
    const GHE = "C:/repo-ghe";
    slugs[SIBLING] = SLUG;
    slugs[GHE] = SLUG;
    hosts[GHE] = "ghe.acme.io";
    vi.mocked(forgeRepoSetVisibility).mockResolvedValue(undefined as never);
    for (const path of [SIBLING, OTHER, GHE])
      fixtures[path] = pagesOf(OLD_150, 140);
    const { client } = renderBoard();
    renderBoard(SIBLING, client);
    renderBoard(OTHER, client);
    renderBoard(GHE, client);
    await waitFor(() => {
      expect(pagesCalled()).toEqual([1, 2]);
      expect(pagesCalled(SIBLING)).toEqual([1, 2]);
      expect(pagesCalled(OTHER)).toEqual([1, 2]);
      expect(pagesCalled(GHE)).toEqual([1, 2]);
    });
    // Each read is pinned to its own checkout's host.
    for (const [path, host] of [
      [REPO, HOST],
      [GHE, "ghe.acme.io"],
    ])
      expect(
        vi
          .mocked(ghStarHistoryPage)
          .mock.calls.filter(([r]) => r === path)
          .map(([, , slug, h]) => `${h}/${slug}`),
      ).toEqual([`${host}/${SLUG}`, `${host}/${SLUG}`]);
    const vis = hookOn(client, () => useSetVisibility(REPO));
    await act(() => vis.current.mutateAsync("private"));
    await waitFor(() => {
      expect(pagesCalled()).toEqual([1, 2, 1, 2]);
      expect(pagesCalled(SIBLING)).toEqual([1, 2, 1, 2]);
    });
    await flush();
    expect(pagesCalled(OTHER)).toEqual([1, 2]);
    expect(pagesCalled(GHE)).toEqual([1, 2]);
  });

  it("offline, an origin set-url's fresh walk waits for the connection", async () => {
    vi.mocked(gitRemoteSetUrl).mockImplementation(async () => {
      forkOrigin();
    });
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    act(() => onlineManager.setOnline(false));
    const set = hookOn(client, () => useSetRemoteUrl(REPO));
    await act(() => set.current.mutateAsync({ name: "origin", url: "x" }));
    await flush();
    expect(client.getQueryState(FORK_KEY)?.fetchStatus).toBe("paused");
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(caption()).toContain("150 stars"));
    expect(pagesCalled()).toEqual([1, 2, 1, 2]);
  });

  it("a visibility change walks star history again and marks Community", async () => {
    vi.mocked(forgeRepoSetVisibility).mockResolvedValue(undefined as never);
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(false);
    const vis = hookOn(client, () => useSetVisibility(REPO));
    await act(() => vis.current.mutateAsync("private"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 2]));
    expect(client.getQueryState(COMMUNITY_KEY)?.isInvalidated).toBe(true);
  });

  it("a fork over a failed page drops the failure and walks the fork", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    vi.mocked(ghRepoFork).mockImplementation(async () => {
      forkOrigin();
      return "" as never;
    });
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    const fork = hookOn(client, () => useForkRepo(REPO));
    await act(() => fork.current.mutateAsync(false));
    await waitFor(() => expect(tableRows()).toBe(90));
    expect(cardRetry()).toBeNull();
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

describe("Star history: a failed page stays put", () => {
  /** All time over OLD_150 with page 3 failing once: three pages, an error. */
  async function failedOverPages() {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    fixtures[OTHER] = pagesOf(YOUNG_21, 246);
    const user = userEvent.setup();
    const board = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    expect(pagesCalled()).toEqual([1, 2, 3]);
    return { user, board };
  }
  const refocus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
  afterEach(() => focusManager.setFocused(undefined));

  it("a window refocus re-walks no page; Retry still resumes there", async () => {
    const { user } = await failedOverPages();
    refocus();
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3]);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 3, 4, 5]);
  });

  it("control: a failed first page, with nothing loaded, re-reads on refocus", async () => {
    failures = [{ repo: REPO, page: 1, attempt: 1, error: TRANSPORT }];
    renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await flush();
    refocus();
    await waitFor(() => expect(tableRows()).toBe(52));
    expect(pagesCalled()).toEqual([1, 1, 2]);
  });
});

describe("Star history: a star toggle over a read in flight", () => {
  const toggleOn = (client: QueryClient) =>
    renderHook(() => useSetRepoStar(REPO), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }).result;

  it("a first page and Community still loading are read again once they land", async () => {
    holdFor.add(REPO);
    vi.mocked(forgeRepoSetStar).mockResolvedValue(undefined);
    let failCommunity: (e: unknown) => void = () => undefined;
    vi.mocked(ghCommunityInsights).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failCommunity = reject;
        }),
    );
    const { client } = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await waitFor(() => expect(ghCommunityInsights).toHaveBeenCalledTimes(1));
    const toggle = toggleOn(client);
    await act(() => toggle.current.mutateAsync(true));
    // Page 1's call already holds the pre-star answer.
    fixtures[REPO] = pagesOf(OLD_150, 141);
    await release(1);
    await act(async () => failCommunity(TRANSPORT));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 1]));
    await waitFor(() => expect(ghCommunityInsights).toHaveBeenCalledTimes(2));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 1, 2]));
    await release(2);
    await waitFor(() => expect(caption()).toContain("141 stars"));
  });

  it("over a failed page, the toggle walks the pages again from page 1", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    vi.mocked(forgeRepoSetStar).mockImplementation(async () => {
      fixtures[REPO] = pagesOf(OLD_150, 141);
    });
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    const toggle = toggleOn(client);
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
    expect(slot().textContent).toBe("141 stars");
  });

  it("over a Retry in flight, the toggle walks the pages again from page 1", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    vi.mocked(forgeRepoSetStar).mockImplementation(async () => {
      fixtures[REPO] = pagesOf(OLD_150, 141);
    });
    holdFor.add(REPO);
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    await release(3);
    const retry = await waitFor(() => {
      const found = cardRetry();
      if (!found) throw new Error("no in-card Retry");
      return found;
    });
    await user.click(retry);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3]));
    const toggle = toggleOn(client);
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3, 1]));
    holdFor.delete(REPO);
    await release(1);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(slot().textContent).toBe("141 stars");
  });

  it("control: over a healthy read, the toggle refreshes in place", async () => {
    vi.mocked(forgeRepoSetStar).mockResolvedValue(undefined);
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    holdFor.add(REPO);
    const toggle = toggleOn(client);
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1]));
    // The loaded weeks stay drawn while the refresh runs.
    expect(tableRows()).toBe(52);
  });

  it("a hidden board's page in flight lands marked for a re-read", async () => {
    holdFor.add(REPO);
    vi.mocked(forgeRepoSetStar).mockResolvedValue(undefined);
    const board = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    board.rerender(REPO, true);
    const toggle = toggleOn(board.client);
    await act(() => toggle.current.mutateAsync(true));
    await release(1);
    await flush();
    expect(board.client.getQueryState(STAR_KEY)?.isInvalidated).toBe(true);
    expect(pagesCalled()).toEqual([1]);
  });

  it("a hidden board's page in flight that fails after the toggle: showing it re-reads page 1", async () => {
    holdFor.add(REPO);
    vi.mocked(forgeRepoSetStar).mockImplementation(async () => {
      fixtures[REPO] = pagesOf(OLD_150, 141);
    });
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    const board = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    board.rerender(REPO, true);
    const toggle = toggleOn(board.client);
    await act(() => toggle.current.mutateAsync(true));
    await release(3);
    await flush();
    // The failure landed as a marker, a success the heal marks again.
    expect(board.client.getQueryState(STAR_KEY)?.isInvalidated).toBe(true);
    expect(pagesCalled()).toEqual([1, 2, 3]);
    holdFor.delete(REPO);
    board.rerender(REPO, false);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(slot().textContent).toBe("141 stars");
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
  });

  it("over a failed refresh, a toggle only marks it; its Retry walks from page 1 to the new count", async () => {
    vi.mocked(forgeRepoSetStar).mockImplementation(async () => {
      fixtures[REPO] = pagesOf(OLD_150, 141);
    });
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    failures = [{ repo: REPO, page: 1, attempt: 2, error: TRANSPORT }];
    const toggle = toggleOn(client);
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't refresh some insights — showing the last loaded ones.",
        ),
      ).toBeTruthy(),
    );
    expect(pagesCalled()).toEqual([1, 2, 1]);
    await act(() => toggle.current.mutateAsync(false));
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 1]);
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(true);
    expect(slot().textContent).toBe("140 stars · +34 in 52 weeks");
    await user.click(button("Retry loading insights"));
    await waitFor(() =>
      expect(slot().textContent).toBe("141 stars · +34 in 52 weeks"),
    );
    expect(pagesCalled()).toEqual([1, 2, 1, 1, 2]);
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(false);
  });

  it("over a failed refresh's Retry in flight, a toggle walks again once the Retry lands", async () => {
    vi.mocked(forgeRepoSetStar).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    failures = [{ repo: REPO, page: 1, attempt: 2, error: TRANSPORT }];
    const toggle = toggleOn(client);
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't refresh some insights — showing the last loaded ones.",
        ),
      ).toBeTruthy(),
    );
    holdFor.add(REPO);
    await user.click(button("Retry loading insights"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 1]));
    // The Retry's page 1 holds the pre-toggle count; the toggle settles over it.
    fixtures[REPO] = pagesOf(OLD_150, 141);
    await act(() => toggle.current.mutateAsync(false));
    holdFor.delete(REPO);
    await release(1);
    await waitFor(() =>
      expect(slot().textContent).toBe("141 stars · +34 in 52 weeks"),
    );
    expect(pagesCalled()).toEqual([1, 2, 1, 1, 2, 1, 2]);
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(false);
  });
});

describe("Star history: a Retry over a marker and a failed refresh", () => {
  it("walks from page 1, refilling the marker's place, and reads the new count", async () => {
    failures = [
      { repo: REPO, page: 3, attempt: 1, error: TRANSPORT },
      { repo: REPO, page: 1, attempt: 2, error: TRANSPORT },
    ];
    vi.mocked(forgeRepoSetStar).mockImplementation(async () => {
      fixtures[REPO] = pagesOf(OLD_150, 141);
    });
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    const toggle = renderHook(() => useSetRepoStar(REPO), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }).result;
    // The toggle's walk fails at page 1: a failed refresh over pages that end
    // on the marker.
    await act(() => toggle.current.mutateAsync(true));
    await waitFor(() =>
      expect(client.getQueryState(STAR_KEY)?.status).toBe("error"),
    );
    expect(pagesCalled()).toEqual([1, 2, 3, 1]);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(slot().textContent).toBe("141 stars");
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 1, 2, 3, 4, 5]);
  });
});

describe("Star history: a parked refresh nobody sees", () => {
  it("hidden before the reconnect: no page; shown again, it re-reads", async () => {
    const board = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    act(() => onlineManager.setOnline(false));
    await act(() => {
      void board.client.invalidateQueries({ queryKey: STAR_KEY });
    });
    await flush();
    expect(board.client.getQueryState(STAR_KEY)?.fetchStatus).toBe("paused");
    board.rerender(REPO, true);
    await flush();
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    board.rerender(REPO, false);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 1, 2]));
  });
});

describe("Star history: the offline park", () => {
  it("a failed older page and an outage: the reconnect re-walks nothing, and Retry resumes there", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    renderBoard(REPO, appQueryClient);
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    act(() => onlineManager.setOnline(false));
    await flush();
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3]);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 3, 4, 5]);
  });

  it("a Retry pressed offline parks only the failed page, says so, and the reconnect sends it", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    renderBoard(REPO, appQueryClient);
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    act(() => onlineManager.setOnline(false));
    await flush();
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(within(card()).getByText(OFFLINE)).toBeTruthy());
    expect(pagesCalled()).toEqual([1, 2, 3]);
    // The parked Retry keeps the span the marker showed, never the window.
    expect(tableRows()).toBe(60);
    expect(caption()).toBe(
      `${LEAD}. 140 stars; showing weeks since ${monthYearLabel(NEWEST - 59 * WEEK)}.`,
    );
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 3, 4, 5]);
  });
});

describe("Star history: a parked page nobody wants", () => {
  async function parkAllTime() {
    const user = userEvent.setup();
    const board = renderBoard();
    await waitFor(() => expect(tableRows()).toBe(52));
    act(() => onlineManager.setOnline(false));
    await user.click(button("All time"));
    await waitFor(() => expect(within(card()).getByText(OFFLINE)).toBeTruthy());
    return { user, board };
  }

  it("hidden before the reconnect: no page; shown again, it asks", async () => {
    const { board } = await parkAllTime();
    board.rerender(REPO, true);
    await flush();
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    board.rerender(REPO, false);
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]);
  });

  it("back to a full 52 weeks before the reconnect: no page; All time again asks", async () => {
    const { user } = await parkAllTime();
    await user.click(button("52 weeks"));
    expect(within(card()).queryByText(OFFLINE)).toBeNull();
    await flush();
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
    await user.click(button("All time"));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 4, 5]);
  });

  it("a repo switch before the reconnect: the old repo sends no page", async () => {
    fixtures[OTHER] = pagesOf(YOUNG_21, 246);
    const { board } = await parkAllTime();
    board.rerender(OTHER);
    await flush();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(pagesCalled(OTHER)).toEqual([1]));
    await flush();
    expect(pagesCalled()).toEqual([1, 2]);
  });
});

describe("useStarHistory", () => {
  it("follows only the next page, within the API's 100", async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const [page] = pagesOf(YOUNG_21, 246);
    // Itself, a jump past page 2, and past the cap.
    for (const nextPage of [1, 3, 101]) {
      const repo = `C:/next-${nextPage}`;
      fixtures[repo] = [{ ...page, nextPage }];
      const { result } = renderHook(() => useStarHistory(repo, SERIES, true), {
        wrapper,
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.hasNextPage).toBe(false);
    }
    // Page 100 naming 101: consecutive, but past the cap.
    const capped = "C:/next-cap";
    fixtures[capped] = Array.from({ length: 100 }, (_, i) => ({
      ...page,
      weeks: [],
      nextPage: i + 2,
    }));
    const { result: walk } = renderHook(
      () => useStarHistory(capped, SERIES, true),
      {
        wrapper,
      },
    );
    // Read both up front: the result re-renders only for the props read.
    await waitFor(() => expect(walk.current.data?.pages).toHaveLength(1));
    expect(walk.current.hasNextPage).toBe(true);
    for (let n = 1; n < 100; n++) await act(() => walk.current.fetchNextPage());
    await waitFor(() => expect(walk.current.data?.pages).toHaveLength(100));
    expect(walk.current.hasNextPage).toBe(false);
    // Control: the same answer under an unguarded next-page read would ask
    // for page 1 again.
    const { result } = renderHook(
      () =>
        useInfiniteQuery({
          queryKey: ["unguarded"],
          queryFn: ({ pageParam }) =>
            ghStarHistoryPage("C:/next-1", pageParam, SLUG, HOST),
          initialPageParam: 1,
          getNextPageParam: (last: StarHistoryPage) =>
            last.nextPage ?? undefined,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
  });
});

describe("Star history: one series per slug", () => {
  afterEach(() => focusManager.setFocused(undefined));

  it("keys each series by its slug, which every page of it is read from", () => {
    expect(repoKeys.starHistory(REPO, "a/x")).toEqual([
      "repo",
      REPO,
      "insights",
      "starHistory",
      "a/x",
    ]);
    expect(repoKeys.starHistory(REPO, "a/x")).not.toEqual(
      repoKeys.starHistory(REPO, "a/y"),
    );
    const github = starHistorySeries({ ...GITHUB, repo: "o/r" });
    const ghe = starHistorySeries({ ...GITHUB, repo: "o/r", host: "ghe.io" });
    expect(github).toBe("github.com/o/r");
    expect(ghe).toBe("ghe.io/o/r");
    expect(repoKeys.starHistory(REPO, github)).not.toEqual(
      repoKeys.starHistory(REPO, ghe),
    );
  });

  it("an out-of-band origin change mid-walk moves the read to a fresh series; neither mixes", async () => {
    holdFor.add(REPO);
    fixtures[FORK] = pagesOf(FORK_90, 150);
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(pagesCalled()).toEqual([1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await release(2);
    await user.click(button("All time"));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3]));
    // A terminal set-url: the forge status names the new origin on its next
    // read, here the focus pass once it is stale.
    slugs[REPO] = FORK;
    const later = Date.now() + 61_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 1]));
    } finally {
      clock.mockRestore();
    }
    holdFor.delete(REPO);
    // The old origin's page lands in its own series only.
    await release(3);
    await release(1);
    await waitFor(() => expect(tableRows()).toBe(90));
    expect(
      vi
        .mocked(ghStarHistoryPage)
        .mock.calls.map(([, page, slug, host]) => [page, slug, host]),
    ).toEqual([
      [1, SLUG, HOST],
      [2, SLUG, HOST],
      [3, SLUG, HOST],
      [1, FORK, HOST],
      [2, FORK, HOST],
      [3, FORK, HOST],
    ]);
    expect(
      client.getQueryData<{ pages: StarHistoryPage[] }>(STAR_KEY)?.pages,
    ).toEqual(pagesOf(OLD_150, 140).slice(0, 3));
    expect(
      client.getQueryData<{ pages: StarHistoryPage[] }>(FORK_KEY)?.pages,
    ).toEqual(pagesOf(FORK_90, 150));
    expect(caption()).toContain("150 stars");
  });

  /** A focus pass once the forge status is stale, which re-reads it. */
  async function refocusLater(until: () => void) {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(until);
    } finally {
      clock.mockRestore();
    }
  }

  it("a toggle settling after origin moved refreshes the series it starred, siblings included", async () => {
    const SIBLING = "C:/sibling";
    slugs[SIBLING] = SLUG;
    fixtures[SIBLING] = pagesOf(OLD_150, 140);
    fixtures[FORK] = pagesOf(FORK_90, 150);
    const { client, rerender } = renderBoard(SIBLING);
    await waitFor(() => expect(tableRows()).toBe(52));
    rerender(REPO);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    await waitFor(() => expect(caption()).toContain("140 stars"));
    let land: () => void = () => undefined;
    vi.mocked(forgeRepoSetStar).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const toggle = renderHook(() => useSetRepoStar(REPO), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }).result;
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = toggle.current.mutateAsync(true);
    });
    await waitFor(() =>
      expect(forgeRepoSetStar).toHaveBeenCalledWith(REPO, true),
    );
    // Origin moves to the fork, and the board's series with it, before the
    // write lands.
    slugs[REPO] = FORK;
    await refocusLater(() => expect(pagesCalled()).toEqual([1, 2, 1, 2]));
    await waitFor(() => expect(caption()).toContain("150 stars"));
    await act(async () => {
      land();
      await done;
    });
    await flush();
    const sibling = ["repo", SIBLING, "insights", "starHistory", SERIES];
    expect(client.getQueryState(STAR_KEY)?.isInvalidated).toBe(true);
    expect(client.getQueryState(sibling)?.isInvalidated).toBe(true);
    expect(client.getQueryState(FORK_KEY)?.isInvalidated).toBe(false);
    expect(pagesCalled()).toEqual([1, 2, 1, 2]);
  });

  it("a held marker Retry never holds the same slug's series on another host", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: RATE_LIMITED }];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() =>
      expect(within(card()).getByText(partialLine(59))).toBeTruthy(),
    );
    holdFor.add(REPO);
    const retry = cardRetry();
    if (!retry) throw new Error("no in-card Retry");
    await user.click(retry);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3]));
    // Origin's host moves while that page is held: same slug, a new series.
    hosts[REPO] = "ghe.acme.io";
    await refocusLater(() => expect(pagesCalled()).toEqual([1, 2, 3, 3, 1]));
    await release(1);
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3, 1, 2]));
    await release(2);
    // The new series drives its own page 3, the page the old Retry holds.
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2, 3, 3, 1, 2, 3]));
    await flush();
    expect(cardRetry()).toBeNull();
    expect(slot().textContent).toBe("Loading older weeks · 2 of 5");
  });
});
