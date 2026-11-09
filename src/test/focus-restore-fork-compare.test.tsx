import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { ForkActivityCard } from "@/features/repository/insights/ForkActivityCard";
import { forgeForkDivergence } from "@/lib/git/api";
import type { ForgeForkActivity, ForgeForkDivergence } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeForkDivergence: vi.fn(),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

const REPO = "C:/repo";

const ACTIVITY: ForgeForkActivity = {
  totalCount: 1,
  defaultBranch: "main",
  forks: [
    {
      fullName: "someone/project",
      webUrl: "https://github.com/someone/project",
      activeAt: null,
      stars: null,
      isPrivate: false,
      defaultBranch: "main",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Queues one test-controlled settle per divergence fetch, in call order. */
function queueFetches(count: number) {
  const settles = Array.from({ length: count }, () =>
    deferred<ForgeForkDivergence>(),
  );
  let call = 0;
  vi.mocked(forgeForkDivergence).mockImplementation(
    () => settles[call++].promise,
  );
  return settles;
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ForkActivityCard
        repoPath={REPO}
        data={ACTIVITY}
        provider="github"
        canCompare
      />
    </QueryClientProvider>,
  );
  return client;
}

const compareButton = () =>
  screen.getByRole("button", {
    name: "Compare someone/project with this repository",
  });
const allForksButton = () =>
  screen.getByRole("button", { name: "All forks on GitHub" });
const resultSpan = () => screen.getByText(/ahead ·/);

describe("ForkActivityCard compare focus restore", () => {
  beforeEach(() => {
    vi.mocked(forgeForkDivergence).mockReset();
  });
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("leaves focus where the user moved it during the compare", async () => {
    const [first] = queueFetches(1);
    const user = userEvent.setup();
    renderCard();
    await user.click(compareButton());
    act(() => allForksButton().focus());
    await act(async () => first.resolve({ aheadBy: 2, behindBy: 3 }));
    await waitFor(() => expect(resultSpan()).toBeTruthy());
    expect(document.activeElement).toBe(allForksButton());
    expect(resultSpan().getAttribute("aria-live")).toBe("polite");
  });

  it("focuses the result when focus fell to body at the swap", async () => {
    const [first] = queueFetches(1);
    const user = userEvent.setup();
    renderCard();
    await user.click(compareButton());
    expect(document.activeElement).toBe(document.body);
    await act(async () => first.resolve({ aheadBy: 2, behindBy: 3 }));
    await waitFor(() => expect(document.activeElement).toBe(resultSpan()));
  });

  it("a refused claim is spent, so a later settle doesn't take focus", async () => {
    const [first, second] = queueFetches(2);
    const user = userEvent.setup();
    const client = renderCard();
    await user.click(compareButton());
    act(() => allForksButton().focus());
    await act(async () => first.resolve({ aheadBy: 2, behindBy: 3 }));
    await waitFor(() => expect(resultSpan()).toBeTruthy());
    expect(document.activeElement).toBe(allForksButton());
    // Focus now sits unclaimed, so only a still-pending claim could land.
    act(() => allForksButton().blur());
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      void client.invalidateQueries();
    });
    await act(async () => second.resolve({ aheadBy: 5, behindBy: 1 }));
    await waitFor(() => expect(resultSpan().textContent).toMatch(/^5 ahead/));
    expect(document.activeElement).toBe(document.body);
  });

  it("hands focus on after an offline park that held it", async () => {
    const [first] = queueFetches(1);
    const user = userEvent.setup();
    renderCard();
    act(() => onlineManager.setOnline(false));
    await user.click(compareButton());
    const parked = await screen.findByText(/You're offline/);
    await waitFor(() => expect(document.activeElement).toBe(parked));
    act(() => onlineManager.setOnline(true));
    // The resumed fetch swaps the parked line for a skeleton, which drops focus.
    await waitFor(() =>
      expect(screen.queryByText(/You're offline/)).toBeNull(),
    );
    await act(async () => first.resolve({ aheadBy: 2, behindBy: 3 }));
    await waitFor(() => expect(document.activeElement).toBe(resultSpan()));
  });

  it("an offline park that found focus claimed holds nothing for the reconnect", async () => {
    const [first, second] = queueFetches(2);
    const user = userEvent.setup();
    renderCard();
    await user.click(compareButton());
    await act(async () => first.reject(new Error("boom")));
    const retry = await screen.findByRole("button", {
      name: "Retry comparing someone/project with this repository",
    });
    act(() => onlineManager.setOnline(false));
    // The parked state reaches the card through react-query's batched notify,
    // so focus can move between the press and the park.
    act(() => retry.click());
    act(() => allForksButton().focus());
    await screen.findByText(/You're offline/);
    expect(document.activeElement).toBe(allForksButton());
    // Focus now sits unclaimed, so only a held park could re-arm on reconnect.
    act(() => allForksButton().blur());
    act(() => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(screen.queryByText(/You're offline/)).toBeNull(),
    );
    await act(async () => second.resolve({ aheadBy: 2, behindBy: 3 }));
    await waitFor(() => expect(resultSpan()).toBeTruthy());
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses Retry when the compare fails with focus unclaimed", async () => {
    const [first] = queueFetches(1);
    const user = userEvent.setup();
    renderCard();
    await user.click(compareButton());
    await act(async () => first.reject(new Error("boom")));
    const retry = await screen.findByRole("button", {
      name: "Retry comparing someone/project with this repository",
    });
    await waitFor(() => expect(document.activeElement).toBe(retry));
  });
});
