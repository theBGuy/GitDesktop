import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRepoLensKeeper } from "@/features/repository/OpenRepoLensKeeper";
import type { RepoInfo } from "@/lib/git/types";
import { applyRepoLens, lensKey } from "@/lib/repo-lens/queries";
import { loadRepoLens } from "@/lib/repo-lens/store";
import { useUiStore } from "@/lib/stores/ui";

// The lens store (app data) is never read: a load stays in flight, so any read
// of disk shows up as a call, never as a value.
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";
const SIX_MINUTES = 6 * 60_000;
const st = () => useUiStore.getState();
const info = (root: string) => ({ root, name: "x" }) as RepoInfo;

/** A client built after the fake timers, so its collection timers are fake. */
function renderKeeper(seed: (client: QueryClient) => void = () => undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed(client);
  const view = render(
    <QueryClientProvider client={client}>
      <OpenRepoLensKeeper />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

/** Lets a cache write reach the subscribed hook, then moves fake time on. */
function pass(ms: number) {
  act(() => {
    vi.advanceTimersByTime(0);
  });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** K1's state: REPO open with Settings on screen, a session-only "upstream"
 *  applied over a cached "origin", and six minutes passed. */
function settingsOverSessionLens() {
  act(() => {
    st().openRepo(info(REPO));
    st().openSettings();
  });
  expect(st().view).toBe("settings");
  expect(st().repoPath).toBe(REPO);
  const view = renderKeeper((c) => c.setQueryData(lensKey(REPO), "origin"));
  act(() => {
    applyRepoLens(view.client, REPO, "upstream", {
      clearSelections: false,
      persist: false,
    });
  });
  pass(SIX_MINUTES);
  return view;
}

const lensEntries = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .filter((q) => q.queryKey[0] === "repo-lens");

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.mocked(loadRepoLens).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenRepoLensKeeper", () => {
  it("K1: keeps a session-only lens while Settings covers the open repository", () => {
    const { client } = settingsOverSessionLens();
    expect(client.getQueryData(lensKey(REPO))).toBe("upstream");
    expect(vi.mocked(loadRepoLens)).not.toHaveBeenCalled();
  });

  it("K2: lets the lens of a repository left behind expire on the default", () => {
    const { client } = settingsOverSessionLens();
    act(() => {
      st().openRepo(info(OTHER));
    });
    expect(st().repoPath).toBe(OTHER);
    pass(SIX_MINUTES);
    expect(client.getQueryData(lensKey(REPO))).toBeUndefined();
    const other = client.getQueryCache().find({ queryKey: lensKey(OTHER) });
    expect(other?.getObserversCount()).toBe(1);
  });

  it("K3: holds no lens entry while no repository is open", () => {
    expect(st().repoPath).toBeNull();
    const { client } = renderKeeper();
    pass(SIX_MINUTES);
    expect(lensEntries(client)).toEqual([]);
    expect(vi.mocked(loadRepoLens)).not.toHaveBeenCalled();
  });

  it("K4: renders no DOM, a repository open or not", () => {
    const closed = renderKeeper();
    expect(closed.container).toBeEmptyDOMElement();
    closed.unmount();
    const open = settingsOverSessionLens();
    expect(open.container).toBeEmptyDOMElement();
  });
});
