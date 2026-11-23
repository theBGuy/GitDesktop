import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BranchSwitcher } from "@/features/repository/BranchSwitcher";
import { SyncControls } from "@/features/repository/SyncControls";
import {
  forgeDetectForkPrForBranch,
  forgeStatus,
  getSecret,
  gitBranchDivergence,
  gitBranches,
  gitBranchRewriteStatus,
  gitDefaultBranch,
  gitFetch,
  gitRemoteBranches,
  gitRemotePushUrl,
  gitRemotes,
  gitRemoteUrl,
  gitStashCount,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type {
  Branch,
  BranchHead,
  ForkPrMatch,
  RemoteBranch,
} from "@/lib/git/types";
import { listUserWorktrees } from "@/lib/git/worktree";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The harnesses of sync-bar-push-routing and branch-push-routing, merged. The
// push callee is reached only through its spy: publish-hold-routes lets no file
// but its one hook import it by name.
const pushSpy = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitFetch: vi.fn(),
  gitBranches: vi.fn(),
  gitBranchDivergence: vi.fn(),
  gitBranchRewriteStatus: vi.fn(),
  gitRemotes: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitStashCount: vi.fn(),
  readRepoBranchRules: vi.fn(),
  forgeStatus: vi.fn(),
  getSecret: vi.fn(),
  gitRemoteUrl: vi.fn(),
  gitRemotePushUrl: vi.fn(),
  forgeDetectForkPrForBranch: vi.fn(),
  gitPush: pushSpy,
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
// Marks the subscription the late-match notice makes: it subscribes inside
// this synchronous call.
const noticeCall = vi.hoisted(() => ({ active: false }));
// A short bound, so a test can answer Publish after it has passed.
vi.mock("@/features/repository/publish-confirm", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@/features/repository/publish-confirm")
    >();
  return {
    ...real,
    PUBLISH_FORK_CHECK_BOUND_MS: 20,
    noticeLateForkMatch: (
      opts: Parameters<typeof real.noticeLateForkMatch>[0],
    ) => {
      noticeCall.active = true;
      try {
        real.noticeLateForkMatch(opts);
      } finally {
        noticeCall.active = false;
      }
    },
  };
});

const REPO = "C:/repos/late";
const OTHER_REPO = "C:/repos/late-other";
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => `${path}/.git`,
  repoIdentityStrict: (path: string) => Promise.resolve(`${path}/.git`),
}));

// The virtualized list sizes its viewport from clientWidth/clientHeight, which
// jsdom leaves at 0 (no row would paint).
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

const URL_ = "https://example.test/late.git";
const GUARD_TEXT = "This branch belongs to a pull request from a fork";
const MATCH: ForkPrMatch = {
  number: 7,
  title: "Fork work",
  url: "https://github.com/acme/late/pull/7",
  headRefName: "feat",
  headRepoOwner: "someone",
  headRepoName: "late",
  maintainerCanModify: true,
  aheadCount: 1,
};
const TITLE = "feat is also the head of #7";
const DESCRIPTION =
  "Publish made a separate copy on origin; the pull request from someone/late was not updated.";

function row(name: string, over: Partial<Branch> = {}): Branch {
  return {
    name,
    isCurrent: false,
    upstream: null,
    lastCommitDate: "2026-11-01T10:00:00Z",
    archived: false,
    upstreamAhead: 0,
    upstreamBehind: 0,
    upstreamGone: false,
    upstreamRemote: null,
    upstreamRemoteRef: null,
    keepLocal: false,
    upstreamIsRemoteDefault: false,
    ...over,
  };
}

function head(name: string, tracked: boolean): BranchHead {
  return {
    name,
    detached: false,
    oid: "abcdef0123456789abcdef0123456789abcdef01",
    upstream: tracked ? `origin/${name}` : null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    upstreamRemote: tracked ? "origin" : null,
    upstreamBranch: tracked ? name : null,
    pushNameMismatch: false,
    upstreamIsRemoteDefault: null,
    pushRemote: tracked ? "origin" : null,
    pushBranch: tracked ? name : null,
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let check: ReturnType<typeof deferred<ForkPrMatch | null>>;
let remoteBranches: RemoteBranch[];
let info: ReturnType<typeof vi.spyOn>;
/** The notices' repo-switch subscriptions, by whether each was released. */
let noticeSubs: { released: boolean }[];

beforeEach(() => {
  vi.clearAllMocks();
  check = deferred();
  remoteBranches = [];
  noticeSubs = [];
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "fork"]);
  vi.mocked(gitRemoteBranches).mockImplementation(async () => remoteBranches);
  vi.mocked(gitFetch).mockResolvedValue(undefined);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitBranchDivergence).mockResolvedValue([]);
  vi.mocked(gitBranchRewriteStatus).mockImplementation(
    () => new Promise(() => undefined),
  );
  vi.mocked(gitStashCount).mockResolvedValue(0);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(getSecret).mockResolvedValue(null);
  vi.mocked(forgeStatus).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(listUserWorktrees).mockResolvedValue([]);
  vi.mocked(gitRemoteUrl).mockResolvedValue(URL_);
  vi.mocked(gitRemotePushUrl).mockResolvedValue(URL_);
  vi.mocked(forgeDetectForkPrForBranch).mockImplementation(() => check.promise);
  pushSpy.mockResolvedValue("leaseAndIncludes");
  info = vi.spyOn(toast, "info");
  useUiStore.setState({ repoPath: REPO });
  // Tells the notice's own subscription apart by the call that makes it.
  const subscribe = useUiStore.subscribe;
  vi.spyOn(useUiStore, "subscribe").mockImplementation((listener) => {
    const off = subscribe(listener);
    if (!noticeCall.active) return off;
    const sub = { released: false };
    noticeSubs.push(sub);
    return () => {
      sub.released = true;
      off();
    };
  });
});

afterEach(() => {
  if (useConfirm.getState().request)
    act(() => useConfirm.getState().answer(false));
  vi.restoreAllMocks();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

type InfoCall = [string, { action: { onClick: () => void } }];
const lateToasts = () =>
  (info.mock.calls as InfoCall[]).filter((c) => c[0] === TITLE);

interface Route {
  name: string;
  /** Renders the route and presses its Publish, up to the open prompt. */
  press: () => Promise<void>;
}

const ROUTES: Route[] = [
  {
    name: "sync bar",
    press: async () => {
      vi.mocked(gitStatus).mockResolvedValue({
        branch: head("feat", false),
        entries: [],
      });
      vi.mocked(gitBranches).mockResolvedValue([
        row("feat", { isCurrent: true }),
      ]);
      const user = userEvent.setup();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <SyncControls repoPath={REPO} />
        </QueryClientProvider>,
      );
      await user.click(
        await screen.findByRole("button", { name: /^Publish branch/ }),
      );
    },
  },
  {
    name: "branch switcher",
    press: async () => {
      vi.mocked(gitStatus).mockResolvedValue({
        branch: head("main", true),
        entries: [],
      });
      vi.mocked(gitBranches).mockResolvedValue([
        row("main", {
          isCurrent: true,
          upstream: "origin/main",
          upstreamRemote: "origin",
          upstreamRemoteRef: "refs/heads/main",
          upstreamIsRemoteDefault: true,
        }),
        row("feat"),
      ]);
      const user = userEvent.setup();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <BranchSwitcher repoPath={REPO} />
        </QueryClientProvider>,
      );
      await user.click(await screen.findByRole("button", { name: /^main/ }));
      await screen.findByPlaceholderText("Filter branches");
      const target = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-row="feat"]');
        if (!el) throw new Error("no row feat");
        return el;
      });
      await user.pointer({ keys: "[MouseRight]", target });
      const menu = await screen.findByRole("menu");
      await user.click(
        within(menu).getByRole("menuitem", { name: "Publish to origin" }),
      );
    },
  },
];

/** Presses Publish, lets the bound pass, then answers the prompt. */
async function publishPastTheBound(route: Route, answer: boolean) {
  await route.press();
  await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
  await settle();
  act(() => useConfirm.getState().answer(answer));
}

for (const route of ROUTES)
  describe(`a fork match after Publish, from the ${route.name}`, () => {
    // The route hands the notice its own fork-PR check, never a settled stand-in.
    it("announces it once the push lands, and its action opens the pull request", async () => {
      await publishPastTheBound(route, true);
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      await settle();
      expect(lateToasts()).toEqual([]);
      await act(async () => check.resolve(MATCH));
      await waitFor(() => expect(lateToasts()).toHaveLength(1));
      const [, opts] = lateToasts()[0];
      expect(opts).toMatchObject({
        description: DESCRIPTION,
        action: { label: "View pull request" },
      });
      expect(screen.queryByText(GUARD_TEXT)).toBeNull();
      act(() => opts.action.onClick());
      expect(openUrl).toHaveBeenCalledWith(MATCH.url);
      expect(noticeSubs).toEqual([{ released: true }]);
    });

    it("says nothing after Cancel, and pushes nothing", async () => {
      await publishPastTheBound(route, false);
      await act(async () => check.resolve(MATCH));
      await settle();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(lateToasts()).toEqual([]);
    });

    it("says nothing when the push fails", async () => {
      pushSpy.mockRejectedValue({ kind: "git", message: "rejected" });
      await publishPastTheBound(route, true);
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      await act(async () => check.resolve(MATCH));
      await settle();
      expect(lateToasts()).toEqual([]);
      expect(noticeSubs).toEqual([{ released: true }]);
    });

    for (const [what, outcome] of [
      ["finds nothing", () => check.resolve(null)],
      ["fails", () => check.reject(new Error("gh failed"))],
    ] as const)
      it(`says nothing when the check ${what}`, async () => {
        await publishPastTheBound(route, true);
        await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
        await act(async () => outcome());
        await settle();
        expect(lateToasts()).toEqual([]);
        expect(noticeSubs).toEqual([{ released: true }]);
      });

    it("says nothing after a repository switch before the match", async () => {
      await publishPastTheBound(route, true);
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
      await act(async () => check.resolve(MATCH));
      await settle();
      expect(lateToasts()).toEqual([]);
    });

    // The switch back leaves the repository as it was: only the notice's own
    // record of the switch keeps it quiet.
    it("says nothing after a switch away and back before the match", async () => {
      await publishPastTheBound(route, true);
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
      act(() => useUiStore.setState({ repoPath: REPO }));
      await act(async () => check.resolve(MATCH));
      await settle();
      expect(lateToasts()).toEqual([]);
      expect(noticeSubs).toEqual([{ released: true }]);
    });

    it("waits for the push when the match lands first", async () => {
      const pushed = deferred<string>();
      pushSpy.mockImplementation(() => pushed.promise);
      await publishPastTheBound(route, true);
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      await act(async () => check.resolve(MATCH));
      await settle();
      expect(lateToasts()).toEqual([]);
      await act(async () => pushed.resolve("leaseAndIncludes"));
      await waitFor(() => expect(lateToasts()).toHaveLength(1));
    });

    it("a match while the prompt still shows opens the guard instead", async () => {
      await route.press();
      await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
      await act(async () => check.resolve(MATCH));
      expect(await screen.findByText(GUARD_TEXT)).toBeTruthy();
      await settle();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(lateToasts()).toEqual([]);
    });

    it("the promptless arm, which awaits its check first, says nothing", async () => {
      remoteBranches = [
        { name: "feat", remote: "origin", lastCommitDate: "2026-11-01" },
      ];
      await route.press();
      await settle();
      expect(useConfirm.getState().request).toBeNull();
      await act(async () => check.resolve(null));
      await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
      await settle();
      expect(lateToasts()).toEqual([]);
      expect(noticeSubs).toEqual([{ released: true }]);
    });
  });
