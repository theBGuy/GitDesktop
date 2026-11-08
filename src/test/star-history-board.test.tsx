import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  act,
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
  forgeStatus,
  ghStarHistoryPage,
  type StarHistoryPage,
} from "@/lib/git/api";
import { useStarHistory } from "@/lib/git/queries";
import { focusRefetchPredicate } from "@/lib/git/queries/board-writes";
import type { ForgeStatus } from "@/lib/git/types";
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
  };
});

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

function installBackend() {
  vi.mocked(ghStarHistoryPage).mockImplementation((repo, page) => {
    const key = `${repo}#${page}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const failure = failures.find(
      (f) => f.repo === repo && f.page === page && f.attempt === attempt,
    );
    const answer = fixtures[repo]?.[page - 1];
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

function renderBoard(repo = REPO) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
const partialLine = (oldestIndex: number) =>
  `Showing since ${monthYearLabel(NEWEST - oldestIndex * WEEK)} — couldn't load older weeks.`;

beforeEach(() => {
  vi.mocked(ghStarHistoryPage).mockReset();
  vi.mocked(forgeStatus).mockReset();
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  fixtures = { [REPO]: pagesOf(OLD_150, 140) };
  failures = [];
  holdFor.clear();
  attempts.clear();
  held.length = 0;
  installBackend();
});

afterEach(() => {
  onlineManager.setOnline(true);
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

  it("leaving All time drops the held span: the next All-time load dims the window", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    await user.click(button("52 weeks"));
    // A full window loses nothing to the failure, so only the board says so.
    expect(cardRetry()).toBeNull();
    await user.click(button("Retry loading insights"));
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't refresh some insights/)).toBeNull(),
    );
    expect(pagesCalled()).toEqual([1, 2, 3, 3]);
    holdFor.add(REPO);
    await user.click(button("All time"));
    await waitFor(() =>
      expect(slot().textContent).toBe("Loading older weeks · 3 of 5"),
    );
    expect(tableRows()).toBe(52);
    expect(caption()).toBe(`${LEAD}. 140 stars, +34 in the last 52 weeks.`);
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
    expect(caption()).toBe(`${LEAD}.`);
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

  it("a 0-star repo draws a flat line with no header, said once", async () => {
    fixtures[REPO] = pagesOf(fill(21, 0), 0);
    renderBoard();
    await waitFor(() =>
      expect(within(card()).getByText("No stars yet.")).toBeTruthy(),
    );
    expect(caption()).toBe(`${LEAD}.`);
    expect(slot().textContent).toBe("");
    expect(tableRows()).toBe(21);
  });

  it("names the card's region and its figure by the title", async () => {
    renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    const region = screen.getByRole("region", { name: "Star history" });
    expect(region).toBe(card());
    const figure = within(region).getByRole("figure", { name: "Star history" });
    const described = figure.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe(
      caption(),
    );
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
  const KEY = ["repo", REPO, "insights", "starHistory"];

  it("a failed refresh after a failed page keeps the partial line; the board Retry re-runs the refresh", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    await user.click(button("All time"));
    await waitFor(() =>
      expect(within(card()).getByText(partialLine(59))).toBeTruthy(),
    );
    failures.push({ repo: REPO, page: 1, attempt: 2, error: TRANSPORT });
    await act(() => client.refetchQueries({ queryKey: KEY }));
    await flush();
    expect(pagesCalled()).toEqual([1, 2, 3, 1]);
    expect(within(card()).getByText(partialLine(59))).toBeTruthy();
    expect(cardRetry()).not.toBeNull();
    await user.click(button("Retry loading insights"));
    await waitFor(() => expect(tableRows()).toBe(150));
    expect(pagesCalled()).toEqual([1, 2, 3, 1, 1, 2, 3, 4, 5]);
  });

  it("the focus pass skips a read in error over loaded pages", async () => {
    failures = [{ repo: REPO, page: 3, attempt: 1, error: TRANSPORT }];
    const user = userEvent.setup();
    const { client } = renderBoard();
    await waitFor(() => expect(caption()).not.toBeNull());
    const query = client.getQueryCache().find({ queryKey: KEY });
    if (!query) throw new Error("no star query");
    const focusRefetches = focusRefetchPredicate(new Set());
    // Settled and fresh: the pass leaves it alone either way.
    expect(focusRefetches(query as never)).toBe(false);
    await user.click(button("All time"));
    await waitFor(() => expect(cardRetry()).not.toBeNull());
    expect(query.state.status).toBe("error");
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
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(pagesCalled()).toEqual([1, 2]));
    expect(cardBodyEl().querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(tableRows()).toBe(30);
    await release(2);
    await waitFor(() => expect(tableRows()).toBe(52));
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

  it("a second Retry press joins the refresh in flight", async () => {
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

  it("names the empty header host for the focus it may take", async () => {
    fixtures[REPO] = pagesOf(fill(21, 0), 0);
    const board = renderBoard();
    await waitFor(() =>
      expect(within(card()).getByText("No stars yet.")).toBeTruthy(),
    );
    expect(slot().getAttribute("aria-label")).toBe("Star history");
    fixtures[OTHER] = pagesOf(YOUNG_21, 246);
    board.rerender(OTHER);
    await waitFor(() => expect(slot().textContent).toBe("246 stars"));
    expect(slot().hasAttribute("aria-label")).toBe(false);
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
      const { result } = renderHook(() => useStarHistory(repo, true), {
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
    const { result: walk } = renderHook(() => useStarHistory(capped, true), {
      wrapper,
    });
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
          queryFn: ({ pageParam }) => ghStarHistoryPage("C:/next-1", pageParam),
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
