import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardOpenContext } from "@/features/projects/card-destination";
import {
  type CardOpenInput,
  useCardOpen,
} from "@/features/projects/use-card-open";
import type { BoardItem, BoardItemContent } from "@/lib/git/types";
import type { LocalLandingTarget } from "@/lib/local-landing/match";
import {
  type LocalLanding,
  type LocalLandingOptions,
  resolveLocalLanding,
} from "@/lib/local-landing/resolve";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

// The board's card open through its hook: the destination's arm, the claim and
// the generation that retire a pending open, the wait shown past the threshold,
// and what each navigator is handed. The resolver is a controllable deferred;
// the claims are real, read against the store's epoch.

const claims = vi.hoisted(() => ({
  epoch: (): number => 0,
  claim: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/features/repository/useOpenRepoByPath", async (importOriginal) => {
  const { createOpenClaims } = await import(
    "@/features/repository/open-claims"
  );
  const open = createOpenClaims(() => claims.epoch());
  claims.claim = vi.fn(open.claim);
  return {
    ...(await importOriginal<
      typeof import("@/features/repository/useOpenRepoByPath")
    >()),
    claimRepoOpen: claims.claim,
  };
});
// `isWindows` and `isMac` are read once at import, and jsdom's empty platform
// reads as neither: getters let a case pick the platform.
const platformIs = vi.hoisted(() => ({ windows: true, mac: false }));
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  get isWindows() {
    return platformIs.windows;
  },
  get isMac() {
    return platformIs.mac;
  },
}));
vi.mock("@/lib/local-landing/resolve", () => ({
  resolveLocalLanding: vi.fn(),
}));
vi.mock("@/lib/repo-lens/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/queries")>()),
  applyRepoLens: vi.fn(),
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

const REPO = "C:/src/harbor";
const resolve = vi.mocked(resolveLocalLanding);
const applyLens = vi.mocked(applyRepoLens);
const opened = vi.mocked(openUrl);
const openPr = vi.fn();
const openIssue = vi.fn();
const selectIssue = vi.fn();
const setRepoTab = vi.fn();

interface Pending {
  target: LocalLandingTarget;
  candidates: readonly RecentRepo[];
  opts: LocalLandingOptions;
  settle: (landing: LocalLanding) => Promise<void>;
}
let pending: Pending[] = [];

function issue(repoNameWithOwner: string, number: number): BoardItemContent {
  return {
    kind: "issue",
    id: `I_${number}`,
    number,
    title: "An issue",
    state: "OPEN",
    stateReason: null,
    repoNameWithOwner,
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    viewerCanSetFields: false,
  };
}

function pr(repoNameWithOwner: string, number: number): BoardItemContent {
  return {
    kind: "pullRequest",
    id: `PR_${number}`,
    number,
    title: "A pull request",
    state: "OPEN",
    isDraft: false,
    repoNameWithOwner,
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function card(itemId: string, content: BoardItemContent): BoardItem {
  return {
    itemId,
    isArchived: false,
    content,
    fieldValues: [],
    addedAt: "2026-01-01T00:00:00Z",
  };
}

const HERE_ISSUE = card("PVTI_here_issue", issue("me/harbor", 7));
const HERE_PR = card("PVTI_here_pr", pr("Me/Harbor", 8));
const UP_ISSUE = card("PVTI_up_issue", issue("upstream-org/harbor", 9));
const UP_PR = card("PVTI_up_pr", pr("upstream-org/harbor", 10));
const FORK_ISSUE = card("PVTI_fork_issue", issue("me/harbor", 11));
const WIDGETS_ISSUE = card("PVTI_widgets_issue", issue("acme/widgets", 12));
const WIDGETS_PR = card("PVTI_widgets_pr", pr("acme/widgets", 13));
const GIZMOS_ISSUE = card("PVTI_gizmos", issue("acme/gizmos", 3));
const DRAFT = card("PVTI_draft", {
  kind: "draft",
  id: "DI_1",
  title: "A note",
  body: "",
  assignees: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const REDACTED = card("PVTI_redacted", { kind: "redacted" });

const WIDGETS_CLONE: RecentRepo = {
  path: "C:/src/widgets",
  name: "widgets",
  lastOpenedAt: "2026-01-01T00:00:00Z",
  owner: "acme",
  host: "github.com",
  repoName: "widgets",
  provider: "github",
};

const WIDGETS_ISSUE_URL = "https://github.com/acme/widgets/issues/12";
const OTHER = "C:/src/other";

const UNPROVEN: LocalLanding = { kind: "browser", reason: "unproven" };
const STALE: LocalLanding = {
  kind: "browser",
  reason: "stale",
  path: "C:/src/widgets",
  error: new Error("gone"),
};

/** The active lens is Fork (origin `me/harbor`), the other side Upstream. */
function forkCtx(over: Partial<CardOpenContext> = {}): CardOpenContext {
  return {
    repoSlug: "me/harbor",
    otherSide: { lens: "upstream", slug: "upstream-org/harbor" },
    forgeHost: "github.com",
    recents: [WIDGETS_CLONE],
    ...over,
  };
}

/** The active lens is Upstream, the other side the Fork. */
function upstreamCtx(over: Partial<CardOpenContext> = {}): CardOpenContext {
  return forkCtx({
    repoSlug: "upstream-org/harbor",
    otherSide: { lens: "origin", slug: "me/harbor" },
    ...over,
  });
}

function renderOpen(ctx: CardOpenContext = forkCtx()) {
  const client = new QueryClient();
  const noteOpener = vi.fn();
  const announce = vi.fn();
  const announceArrival = vi.fn();
  const view = renderHook((props: CardOpenInput) => useCardOpen(props), {
    initialProps: {
      repoPath: REPO,
      ctx,
      noteOpener,
      announce,
      announceArrival,
    },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client, noteOpener, announce, announceArrival };
}

type Opener = ReturnType<typeof renderOpen>;

const open = (h: Opener, item: BoardItem) =>
  act(() => h.result.current.openItem(item));

const epoch = () => useUiStore.getState().interactionEpoch;

const bumpStoreEpoch = () =>
  useUiStore.setState((s) => ({ interactionEpoch: s.interactionEpoch + 1 }));

const bumpEpoch = () => act(bumpStoreEpoch);

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** The single argument of a spy's only call. */
function onlyArg(spy: ReturnType<typeof vi.fn>) {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0][0] as {
    beforeSelect?: () => void;
    stillValid?: (epochAtRequest: number) => boolean;
  } & Record<string, unknown>;
}

const order = (spy: ReturnType<typeof vi.fn>, call = 0) =>
  spy.mock.invocationCallOrder[call];

beforeEach(() => {
  vi.useFakeTimers();
  // The fixtures' paths are Windows paths.
  platformIs.windows = true;
  platformIs.mac = false;
  pending = [];
  resolve.mockReset().mockImplementation(
    (target, candidates, opts) =>
      new Promise<LocalLanding>((done) => {
        pending.push({
          target,
          candidates,
          opts,
          settle: (landing) =>
            act(async () => {
              done(landing);
              await vi.advanceTimersByTimeAsync(0);
            }),
        });
      }),
  );
  claims.claim.mockClear();
  claims.epoch = epoch;
  applyLens.mockReset();
  opened.mockReset().mockResolvedValue(undefined);
  vi.mocked(toastError).mockReset();
  vi.mocked(toast.error).mockReset();
  openPr.mockReset();
  openIssue.mockReset();
  selectIssue.mockReset();
  setRepoTab.mockReset();
  useUiStore.setState({
    view: "repo",
    repoPath: REPO,
    repoName: "harbor",
    repoTab: "projects",
    openPr,
    openIssue,
    selectIssue,
    setRepoTab,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function expectNoNavigation() {
  expect(openPr).not.toHaveBeenCalled();
  expect(openIssue).not.toHaveBeenCalled();
  expect(selectIssue).not.toHaveBeenCalled();
}

function expectNoToast() {
  expect(toastError).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
}

describe("a card of the open repository", () => {
  it("H1: an issue selects in place, the opener noted first", () => {
    const h = renderOpen();
    open(h, HERE_ISSUE);
    expect(h.noteOpener).toHaveBeenCalledWith("PVTI_here_issue");
    expect(selectIssue).toHaveBeenCalledWith({ kind: "remote", id: "7" });
    expect(setRepoTab).toHaveBeenCalledWith("issues");
    expect(order(h.noteOpener)).toBeLessThan(order(selectIssue));
    expect(order(selectIssue)).toBeLessThan(order(setRepoTab));
    expect(openPr).not.toHaveBeenCalled();
    expect(openIssue).not.toHaveBeenCalled();
    expect(claims.claim).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("H2: a pull request opens in place through openPr, with no carry and no re-check", async () => {
    const h = renderOpen();
    open(h, HERE_PR);
    const arg = onlyArg(openPr);
    expect(arg).toEqual({
      kind: "remote",
      repoPath: REPO,
      repoName: "harbor",
      ref: "8",
      section: null,
      beforeSelect: expect.any(Function),
    });
    expect("carryHistory" in arg).toBe(false);
    expect("stillValid" in arg).toBe(false);
    expect(h.noteOpener).not.toHaveBeenCalled();
    arg.beforeSelect?.();
    expect(h.noteOpener).toHaveBeenCalledWith("PVTI_here_pr");
    await advance(1000);
    expect(h.result.current.openingItemId).toBeNull();
    expect(h.announce).not.toHaveBeenCalled();
    expect(claims.claim).not.toHaveBeenCalled();
  });
});

describe("a card of the other fork side", () => {
  it.each([
    ["issue", UP_ISSUE, openIssue, { number: 9 }],
    [
      "pull request",
      UP_PR,
      openPr,
      { kind: "remote", ref: "10", section: null },
    ],
  ] as const)(
    "H3: the %s hops sides in the same checkout, lens first",
    async (_label, item, navigator, fields) => {
      const h = renderOpen();
      open(h, item);
      const arg = onlyArg(navigator);
      expect(arg).toEqual({
        ...fields,
        repoPath: REPO,
        repoName: "harbor",
        carryHistory: true,
        beforeSelect: expect.any(Function),
        stillValid: expect.any(Function),
      });
      expect(applyLens).not.toHaveBeenCalled();
      arg.beforeSelect?.();
      expect(applyLens).toHaveBeenCalledWith(h.client, REPO, "upstream", {
        clearSelections: true,
        persist: false,
      });
      expect(h.noteOpener).toHaveBeenCalledWith(item.itemId);
      expect(order(applyLens)).toBeLessThan(order(h.noteOpener));
      expect(arg.stillValid?.(epoch())).toBe(true);
      expect(arg.stillValid?.(epoch() + 1)).toBe(false);
      open(h, HERE_ISSUE);
      expect(arg.stillValid?.(epoch())).toBe(false);
      // Nothing awaited, so no wait, no claim and no resolve.
      await advance(1000);
      expect(h.result.current.openingItemId).toBeNull();
      expect(h.announce).not.toHaveBeenCalled();
      expect(claims.claim).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Upstream", forkCtx(), UP_ISSUE, "upstream"],
    ["Fork", upstreamCtx(), FORK_ISSUE, "origin"],
  ] as const)(
    "H3b: a hop to %s speaks its arrival last, once, only when it lands",
    (side, ctx, item, lens) => {
      const h = renderOpen(ctx);
      open(h, item);
      const arg = onlyArg(openIssue);
      // A navigator that refuses never runs beforeSelect: nothing is spoken.
      expect(h.announceArrival).not.toHaveBeenCalled();
      arg.beforeSelect?.();
      expect(applyLens).toHaveBeenCalledWith(h.client, REPO, lens, {
        clearSelections: true,
        persist: false,
      });
      expect(h.announceArrival).toHaveBeenCalledTimes(1);
      expect(h.announceArrival).toHaveBeenCalledWith(`Opened in ${side}`);
      expect(order(h.noteOpener)).toBeLessThan(order(h.announceArrival));
      expect(h.announce).not.toHaveBeenCalled();
    },
  );
});

describe("a card of another repository with a clone in recents", () => {
  it("H4: an immediate local landing opens the issue there, carried, with no wait", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    expect(pending).toHaveLength(1);
    expect(pending[0].target).toMatchObject({
      repoFullName: "acme/widgets",
      number: 12,
      isPullRequest: false,
    });
    expect(pending[0].candidates).toEqual([WIDGETS_CLONE]);
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    const arg = onlyArg(openIssue);
    expect(arg).toEqual({
      repoPath: "C:/src/widgets",
      repoName: "widgets",
      number: 12,
      carryHistory: true,
      beforeSelect: expect.any(Function),
      stillValid: expect.any(Function),
    });
    arg.beforeSelect?.();
    expect(applyLens).toHaveBeenCalledWith(
      h.client,
      "C:/src/widgets",
      "origin",
      {
        clearSelections: true,
        persist: false,
      },
    );
    expect(h.noteOpener).toHaveBeenCalledWith("PVTI_widgets_issue");
    expect(h.announceArrival).toHaveBeenCalledTimes(1);
    expect(h.announceArrival).toHaveBeenCalledWith("Opened in widgets");
    expect(order(applyLens)).toBeLessThan(order(h.noteOpener));
    expect(order(h.noteOpener)).toBeLessThan(order(h.announceArrival));
    await advance(1000);
    expect(h.result.current.openingItemId).toBeNull();
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("H5: a slow resolve shows the wait at 300 ms and speaks it once", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await advance(299);
    expect(h.result.current.openingItemId).toBeNull();
    expect(h.announce).not.toHaveBeenCalled();
    await advance(1);
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_issue");
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledWith("Opening widgets issue 12…");
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(h.result.current.openingItemId).toBeNull();
    expect(openIssue).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledTimes(1);
  });

  it("H6: a slow pull request speaks its own sentence and lands through openPr", async () => {
    const h = renderOpen();
    open(h, WIDGETS_PR);
    expect(pending[0].opts.preferWorktree).toBe(true);
    await advance(300);
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_pr");
    expect(h.announce).toHaveBeenCalledWith("Opening widgets pull request 13…");
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets-feat",
      name: "widgets-feat",
    });
    const arg = onlyArg(openPr);
    expect(arg).toEqual({
      kind: "remote",
      repoPath: "C:/src/widgets-feat",
      repoName: "widgets-feat",
      ref: "13",
      section: null,
      carryHistory: true,
      beforeSelect: expect.any(Function),
      stillValid: expect.any(Function),
    });
    // The held landing re-checks the click's generation and the navigator's
    // own epoch.
    expect(arg.stillValid?.(epoch())).toBe(true);
    expect(arg.stillValid?.(epoch() + 1)).toBe(false);
    open(h, HERE_ISSUE);
    expect(arg.stillValid?.(epoch())).toBe(false);
  });

  it("H7: a second open supersedes a slow first one at its call", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await advance(300);
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_issue");
    open(h, WIDGETS_PR);
    expect(h.result.current.openingItemId).toBeNull();
    expect(pending[0].opts.superseded()).toBe(true);
    expect(pending[1].opts.superseded()).toBe(false);
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(openIssue).not.toHaveBeenCalled();
    expect(h.result.current.openingItemId).toBeNull();
    // The successor owns the wait from its arm time.
    await advance(300);
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_pr");
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(h.announce).toHaveBeenLastCalledWith(
      "Opening widgets pull request 13…",
    );
    await pending[1].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(openPr).toHaveBeenCalledTimes(1);
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("H19: a double click on one card resolves again and lands once", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    open(h, WIDGETS_ISSUE);
    expect(pending).toHaveLength(2);
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(openIssue).not.toHaveBeenCalled();
    await pending[1].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(openIssue).toHaveBeenCalledTimes(1);
  });

  it("H20: the landing keeps the click's target and candidates across a re-render", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    h.rerender({
      repoPath: REPO,
      ctx: forkCtx({ recents: [] }),
      noteOpener: h.noteOpener,
      announce: h.announce,
      announceArrival: h.announceArrival,
    });
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: "acme/widgets", number: 12 }),
      [WIDGETS_CLONE],
      expect.objectContaining({ preferWorktree: true }),
    );
    expect(onlyArg(openIssue)).toMatchObject({
      repoPath: "C:/src/widgets",
      number: 12,
    });
  });

  it.each([
    ["unproven", UNPROVEN],
    ["stale", STALE],
  ])(
    "H8: a %s outcome opens the card's web page once, with no toast",
    async (_label, landing) => {
      const h = renderOpen();
      open(h, WIDGETS_ISSUE);
      expect(opened).not.toHaveBeenCalled();
      await pending[0].settle(landing);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened).toHaveBeenCalledWith(WIDGETS_ISSUE_URL);
      expectNoToast();
      expectNoNavigation();
    },
  );

  it("H8: a superseded outcome does nothing", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await pending[0].settle({ kind: "superseded" });
    expect(opened).not.toHaveBeenCalled();
    expectNoNavigation();
    expectNoToast();
  });

  it.each([
    ["a tab change", () => useUiStore.setState({ repoTab: "issues" })],
    ["an epoch bump", bumpStoreEpoch],
    ["a repository change", () => useUiStore.setState({ repoPath: OTHER })],
    ["a view change", () => useUiStore.setState({ view: "settings" })],
  ] as const)(
    "H9: a browser outcome after %s opens nothing",
    async (_label, change) => {
      const h = renderOpen();
      open(h, WIDGETS_ISSUE);
      act(() => change());
      expect(pending[0].opts.superseded()).toBe(true);
      await pending[0].settle(UNPROVEN);
      expect(opened).not.toHaveBeenCalled();
      expectNoNavigation();
    },
  );

  it("H17: another surface's claim while the resolve is pending retires the open", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    // Another surface's open, through the same claims and with no epoch move.
    act(() => {
      (claims.claim as () => () => boolean)();
    });
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expectNoNavigation();
    expect(opened).not.toHaveBeenCalled();
  });

  it("H12: an unmount while pending leaves the later settle nothing to do", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    h.unmount();
    expect(pending[0].opts.superseded()).toBe(true);
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expectNoNavigation();
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a local landing",
      { kind: "local", path: "C:/src/widgets", name: "widgets" } as const,
    ],
    ["a browser outcome", UNPROVEN],
  ])(
    "H16: an epoch move clears a shown wait at once, and %s after it lands, opens and speaks nothing",
    async (_label, landing) => {
      const h = renderOpen();
      open(h, WIDGETS_ISSUE);
      await advance(300);
      expect(h.result.current.openingItemId).toBe("PVTI_widgets_issue");
      // A store write that leaves the epoch alone keeps the wait shown.
      act(() => useUiStore.setState({ repoName: "harbor" }));
      await advance(500);
      expect(h.result.current.openingItemId).toBe("PVTI_widgets_issue");
      // The board's own project or view pick moves the epoch this way.
      bumpEpoch();
      expect(h.result.current.openingItemId).toBeNull();
      expect(useUiStore.getState()).toMatchObject({
        view: "repo",
        repoPath: REPO,
        repoTab: "projects",
      });
      await advance(1000);
      await pending[0].settle(landing);
      await advance(1000);
      expectNoNavigation();
      expect(opened).not.toHaveBeenCalled();
      expect(h.result.current.openingItemId).toBeNull();
      expect(h.announce).toHaveBeenCalledTimes(1);
      expect(h.announceArrival).not.toHaveBeenCalled();
      expectNoToast();
    },
  );

  it("H21: a superseded open's late settle leaves its successor's shown wait standing", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    open(h, WIDGETS_PR);
    await advance(300);
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_pr");
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_pr");
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("H22: a superseded open's timer shows and speaks nothing at its threshold", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await advance(100);
    open(h, WIDGETS_PR);
    await advance(200);
    expect(h.result.current.openingItemId).toBeNull();
    expect(h.announce).not.toHaveBeenCalled();
    await advance(100);
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_pr");
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledWith("Opening widgets pull request 13…");
  });
});

describe("the browser arms", () => {
  it("H10: a card with no clone opens the web at once, superseding a pending open", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await advance(300);
    expect(claims.claim).toHaveBeenCalledTimes(1);
    open(h, GIZMOS_ISSUE);
    expect(opened).toHaveBeenCalledWith(
      "https://github.com/acme/gizmos/issues/3",
    );
    expect(claims.claim).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(h.result.current.openingItemId).toBeNull();
    expect(pending[0].opts.superseded()).toBe(true);
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expectNoNavigation();
  });

  it("H18: a browser open the opener rejects reaches toastError once", async () => {
    const failure = new Error("no browser");
    opened.mockRejectedValueOnce(failure);
    const h = renderOpen();
    open(h, GIZMOS_ISSUE);
    await advance(0);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(failure);
    expectNoNavigation();
  });

  it("H18: a clone resolve's browser ending the opener rejects reaches toastError once", async () => {
    const failure = new Error("no browser");
    opened.mockRejectedValueOnce(failure);
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await pending[0].settle(UNPROVEN);
    expect(opened).toHaveBeenCalledWith(WIDGETS_ISSUE_URL);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(failure);
    expectNoNavigation();
  });

  it("H18: an openOnWeb the opener rejects reaches toastError once", async () => {
    const failure = new Error("no browser");
    opened.mockRejectedValueOnce(failure);
    const h = renderOpen();
    act(() => h.result.current.openOnWeb(WIDGETS_ISSUE));
    await advance(0);
    expect(opened).toHaveBeenCalledWith(WIDGETS_ISSUE_URL);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(failure);
    expectNoNavigation();
  });

  it("H11: openOnWeb opens a clone card's web page, never claiming", async () => {
    const h = renderOpen();
    open(h, WIDGETS_PR);
    await advance(300);
    act(() => h.result.current.openOnWeb(WIDGETS_ISSUE));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(WIDGETS_ISSUE_URL);
    expect(claims.claim).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(h.result.current.openingItemId).toBeNull();
    expect(pending[0].opts.superseded()).toBe(true);
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expectNoNavigation();
  });

  it("H14: a draft and a redacted item open nothing, and a pending open stays pending", async () => {
    const h = renderOpen();
    open(h, WIDGETS_ISSUE);
    await advance(300);
    open(h, DRAFT);
    open(h, REDACTED);
    act(() => h.result.current.openOnWeb(DRAFT));
    act(() => h.result.current.openOnWeb(REDACTED));
    expect(h.result.current.openingItemId).toBe("PVTI_widgets_issue");
    expect(pending[0].opts.superseded()).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    expect(h.noteOpener).not.toHaveBeenCalled();
    expectNoNavigation();
    await pending[0].settle({
      kind: "local",
      path: "C:/src/widgets",
      name: "widgets",
    });
    expect(openIssue).toHaveBeenCalledTimes(1);
  });
});

describe("a clone landing on the open repository", () => {
  it.each([
    ["the other side unread", { lens: "upstream", slug: null }],
    ["no other side", null],
  ] as const)(
    "H13: under Fork with %s, a landing on the open checkout (a precondition only the mocked resolver produces) gets the store's own path, silently",
    async (_label, otherSide) => {
      const h = renderOpen(
        forkCtx({
          otherSide,
          recents: [
            {
              ...WIDGETS_CLONE,
              path: "c:\\SRC\\harbor",
              name: "harbor-checkout",
              owner: "upstream-org",
              repoName: "harbor",
            },
          ],
        }),
      );
      open(h, UP_ISSUE);
      await pending[0].settle({
        kind: "local",
        path: "c:\\SRC\\harbor",
        name: "harbor-checkout",
      });
      const arg = onlyArg(openIssue);
      expect(arg).toMatchObject({ repoPath: REPO, repoName: "harbor" });
      arg.beforeSelect?.();
      expect(applyLens).toHaveBeenCalledWith(h.client, REPO, "origin", {
        clearSelections: true,
        persist: false,
      });
      expect(h.noteOpener).toHaveBeenCalledWith("PVTI_up_issue");
      expect(h.announceArrival).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a case-sensitive platform", false, false, "C:/SRC/Harbor", "Harbor"],
    ["Windows", true, false, REPO, "harbor"],
    ["macOS", false, true, REPO, "harbor"],
  ] as const)(
    "H23: on %s, a proven clone whose path differs from the open checkout only by case lands in the right repository",
    async (_label, windows, mac, repoPath, repoName) => {
      platformIs.windows = windows;
      platformIs.mac = mac;
      const h = renderOpen(
        forkCtx({
          recents: [
            { ...WIDGETS_CLONE, path: "C:/SRC/Harbor", name: "Harbor" },
          ],
        }),
      );
      open(h, WIDGETS_ISSUE);
      await pending[0].settle({
        kind: "local",
        path: "C:/SRC/Harbor",
        name: "Harbor",
      });
      expect(onlyArg(openIssue)).toMatchObject({ repoPath, repoName });
    },
  );

  it("H15: under Upstream the landing switches to the Fork and says so", async () => {
    const h = renderOpen(
      upstreamCtx({
        otherSide: { lens: "origin", slug: null },
        recents: [
          {
            ...WIDGETS_CLONE,
            path: "c:/SRC/Harbor",
            name: "harbor-checkout",
            owner: "me",
            repoName: "harbor",
          },
        ],
      }),
    );
    open(h, FORK_ISSUE);
    await pending[0].settle({
      kind: "local",
      path: "c:/SRC/Harbor",
      name: "harbor-checkout",
    });
    const arg = onlyArg(openIssue);
    expect(arg).toMatchObject({ repoPath: REPO, repoName: "harbor" });
    arg.beforeSelect?.();
    expect(applyLens).toHaveBeenCalledWith(h.client, REPO, "origin", {
      clearSelections: true,
      persist: false,
    });
    expect(h.announceArrival).toHaveBeenCalledTimes(1);
    expect(h.announceArrival).toHaveBeenCalledWith("Opened in Fork");
  });
});
