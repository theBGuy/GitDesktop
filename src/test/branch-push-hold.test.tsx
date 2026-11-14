import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CherryPickOntoDialog,
  ResetCommitDialog,
} from "@/features/history/HistoryDialogs";
import { gitCherryPickOnto, gitReset } from "@/lib/git/api";
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  BRANCH_PUSH_ELSEWHERE_MESSAGE,
  refuseWhileBranchPushes,
  refuseWhilePinnedBranchPushes,
  usePush,
} from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitPush: vi.fn(() => new Promise(() => undefined)),
  gitReset: vi.fn(() => new Promise(() => undefined)),
  gitCherryPickOnto: vi.fn(() => new Promise(() => undefined)),
}));

/** Two checkouts of one repository, and a different repository. A path absent
 *  here peeks undefined and its strict read never settles, so both reads of the
 *  module answer from this one table and cannot disagree. */
const MAIN = "C:/repo";
const WT = "C:/repo-wt";
const ID = "C:/repo/.git";
const OTHER = "C:/other";
const IDENTITIES = new Map([
  [MAIN, ID],
  [WT, ID],
  [OTHER, "C:/other/.git"],
]);
/** Never resolved by any test in this file. */
const FRESH = "C:/repo-fresh";
/** A second checkout of ID whose strict read waits on `resolveEarly`; it joins
 *  IDENTITIES at that moment, so the peek and the strict read still agree. */
const EARLY = "C:/repo-early";
let resolveEarly: ((id: string) => void) | undefined;

vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => IDENTITIES.get(path),
  repoIdentityStrict: (path: string) => {
    const id = IDENTITIES.get(path);
    if (id !== undefined) return Promise.resolve(id);
    if (path === EARLY)
      return new Promise<string>((resolve) => {
        resolveEarly = (resolved) => {
          IDENTITIES.set(EARLY, resolved);
          resolve(resolved);
        };
      });
    return new Promise<string>(() => undefined);
  },
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

/** One usePush binding per file: the usePush scan reads a second `const push`
 *  as a use of the first. */
function PushHarness({ path, kind }: { path: string; kind: "named" | "head" }) {
  const push = usePush(path);
  return (
    <button
      type="button"
      onClick={() => {
        if (kind === "named")
          void push.mutateAsync({ setUpstream: false, branch: "feat" });
        else void push.mutateAsync({ setUpstream: false, startedOn: "feat" });
      }}
    >
      {kind} {path}
    </button>
  );
}

let queryClient: QueryClient;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  info = vi.spyOn(toast, "info");
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  queryClient.clear();
  IDENTITIES.delete(EARLY);
  resolveEarly = undefined;
  vi.restoreAllMocks();
});

/** Starts one push from `path`, after its identity resolved unless `early`. */
async function startPush(kind: "named" | "head", path: string, early = false) {
  const pendingBefore = queryClient
    .getMutationCache()
    .findAll({ status: "pending" }).length;
  render(
    <QueryClientProvider client={queryClient}>
      <PushHarness path={path} kind={kind} />
    </QueryClientProvider>,
  );
  if (!early)
    await waitFor(() =>
      expect(
        queryClient.getQueryData(repoIdentityQueryOptions(path).queryKey),
      ).toBe(IDENTITIES.get(path)),
    );
  await userEvent.click(
    screen.getByRole("button", { name: `${kind} ${path}` }),
  );
  await waitFor(() =>
    expect(
      queryClient.getMutationCache().findAll({ status: "pending" }),
    ).toHaveLength(pendingBefore + 1),
  );
}

const refuse = (
  repo: string,
  branch: string,
  current: string | null,
  opts?: { message?: string; elsewhereMessage?: string; alsoHeld?: boolean },
) => refuseWhileBranchPushes(queryClient, repo, branch, current, opts);

describe("refuseWhileBranchPushes", () => {
  it("holds a branch another worktree pushes by name, naming that worktree", async () => {
    await startPush("named", WT);
    expect(refuse(MAIN, "other", "main")).toBe(false);
    expect(info).not.toHaveBeenCalled();
    expect(refuse(MAIN, "feat", "main")).toBe(true);
    expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE);
  });

  it("holds only the recorded start of another worktree's HEAD push", async () => {
    await startPush("head", WT);
    expect(refuse(MAIN, "feat", "main")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE);
    expect(refuse(MAIN, "main", "main")).toBe(false);
    expect(refuse(MAIN, "main", null)).toBe(false);
  });

  it("holds an own HEAD push's start, the live current branch, and any while unknown", async () => {
    await startPush("head", MAIN);
    expect(refuse(MAIN, "feat", "dev")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
    expect(refuse(MAIN, "dev", "dev")).toBe(true);
    expect(refuse(MAIN, "zzz", null)).toBe(true);
    expect(refuse(MAIN, "zzz", "dev")).toBe(false);
    // The sibling sees the recorded start only.
    expect(refuse(WT, "dev", "dev")).toBe(false);
    expect(refuse(WT, "feat", "dev")).toBe(true);
  });

  it("an unresolved acting identity sees its own pushes only", async () => {
    await startPush("named", WT);
    expect(refuse(FRESH, "feat", "main")).toBe(false);
    cleanup();
    queryClient.clear();
    await startPush("named", FRESH, true);
    expect(refuse(FRESH, "feat", "main")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });

  it("a push filed before its checkout's identity resolved holds siblings once it is known", async () => {
    await startPush("named", EARLY, true);
    await waitFor(() => expect(resolveEarly).toBeDefined());
    // Before the memo learns EARLY's identity, no sibling can match the push.
    expect(refuse(MAIN, "feat", "main")).toBe(false);
    expect(info).not.toHaveBeenCalled();
    resolveEarly?.(ID);
    // The observer re-keys; the pending push keeps its path-only start key.
    await waitFor(() =>
      expect(
        queryClient.getQueryData(repoIdentityQueryOptions(EARLY).queryKey),
      ).toBe(ID),
    );
    const [pending] = queryClient
      .getMutationCache()
      .findAll({ status: "pending" });
    expect(pending.options.mutationKey).toEqual(["branch-push", EARLY]);
    expect(refuse(MAIN, "feat", "main")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE);
    expect(refuse(MAIN, "other", "main")).toBe(false);
    expect(refuse(OTHER, "feat", "main")).toBe(false);
    expect(refuse(EARLY, "feat", "main")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });

  it("a different repository's same-named branch is not held", async () => {
    await startPush("named", OTHER);
    expect(refuse(MAIN, "feat", "main")).toBe(false);
  });

  it("an own push of the branch outranks the elsewhere message", async () => {
    await startPush("named", WT);
    await startPush("named", MAIN);
    expect(refuse(MAIN, "feat", "main")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });

  it("alsoHeld holds with an empty cache, with the generic message", () => {
    expect(refuse(MAIN, "feat", "main")).toBe(false);
    expect(refuse(MAIN, "feat", "main", { alsoHeld: true })).toBe(true);
    expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });

  it("a caller's message overrides both constants", async () => {
    expect(
      refuse(MAIN, "feat", "main", { alsoHeld: true, message: "custom" }),
    ).toBe(true);
    expect(info).toHaveBeenLastCalledWith("custom");
    await startPush("named", WT);
    expect(refuse(MAIN, "feat", "main", { message: "kept" })).toBe(true);
    expect(info).toHaveBeenLastCalledWith("kept");
  });

  it("elsewhereMessage names only a hold no own push shares", async () => {
    const opts = { message: "here", elsewhereMessage: "there" };
    await startPush("named", WT);
    expect(refuse(MAIN, "feat", "main", opts)).toBe(true);
    expect(info).toHaveBeenLastCalledWith("there");
    // { message } alone still overrides both constants.
    expect(refuse(MAIN, "feat", "main", { message: "kept" })).toBe(true);
    expect(info).toHaveBeenLastCalledWith("kept");
    await startPush("named", MAIN);
    expect(refuse(MAIN, "feat", "main", opts)).toBe(true);
    expect(info).toHaveBeenLastCalledWith("here");
  });

  it("a push parked offline still holds", async () => {
    onlineManager.setOnline(false);
    await startPush("named", WT);
    const [pending] = queryClient
      .getMutationCache()
      .findAll({ status: "pending" });
    expect(pending.state.isPaused).toBe(true);
    expect(refuse(MAIN, "feat", "main")).toBe(true);
  });
});

const refusePinned = (repo: string, pin: string | null) =>
  refuseWhilePinnedBranchPushes(queryClient, repo, pin);

describe("refuseWhilePinnedBranchPushes", () => {
  it("a branch pin holds on that branch's push, here or in a sibling", async () => {
    await startPush("named", WT);
    expect(refusePinned(MAIN, "main")).toBe(false);
    expect(refusePinned(MAIN, "feat")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ELSEWHERE_MESSAGE);
    await startPush("named", MAIN);
    expect(refusePinned(MAIN, "feat")).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });

  it("a detached pin is never held", async () => {
    await startPush("head", MAIN);
    await startPush("named", MAIN);
    expect(refusePinned(MAIN, "HEAD")).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it("a null pin holds on this checkout's HEAD push only", async () => {
    await startPush("named", MAIN);
    await startPush("head", WT);
    expect(refusePinned(MAIN, null)).toBe(false);
    await startPush("head", MAIN);
    expect(refusePinned(MAIN, null)).toBe(true);
    expect(info).toHaveBeenLastCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });
});

describe("ResetCommitDialog while a push runs", () => {
  function renderReset(expectedBranch: string, onClose: () => void) {
    useUiStore.setState({ repoPath: MAIN });
    vi.mocked(gitReset).mockClear();
    render(
      <QueryClientProvider client={queryClient}>
        <ResetCommitDialog
          repoPath={MAIN}
          hash="abcdef0123456789"
          openedIn={MAIN}
          pin={{ expectedHead: "abcdef0123456789", expectedBranch }}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
  }

  it("a push of the pinned branch refuses and keeps the dialog open", async () => {
    await startPush("named", MAIN);
    const onClose = vi.fn();
    renderReset("feat", onClose);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(info).toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
    expect(gitReset).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Reset to commit?")).toBeInTheDocument();
  });

  it("a detached pin resets", async () => {
    await startPush("named", MAIN);
    renderReset("HEAD", vi.fn());
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(gitReset).toHaveBeenCalled());
    expect(info).not.toHaveBeenCalled();
  });
});

describe("CherryPickOntoDialog while the destination pushes", () => {
  function renderPick(branch: string, onClose: () => void) {
    useUiStore.setState({ repoPath: MAIN });
    vi.mocked(gitCherryPickOnto).mockClear();
    render(
      <QueryClientProvider client={queryClient}>
        <CherryPickOntoDialog
          repoPath={MAIN}
          hashes={["abcdef0123456789"]}
          isMerge={false}
          openedIn={MAIN}
          branch={branch}
          onBranchChange={() => undefined}
          branches={[{ name: "feat" }, { name: "dev" }]}
          currentBranch="main"
          onClose={onClose}
          onDone={() => undefined}
        />
      </QueryClientProvider>,
    );
  }

  for (const [where, path, message] of [
    ["this checkout", MAIN, BRANCH_PUSH_ACTIVE_MESSAGE],
    ["another worktree", WT, BRANCH_PUSH_ELSEWHERE_MESSAGE],
  ] as const)
    it(`a push of the destination in ${where} refuses and keeps the dialog`, async () => {
      await startPush("named", path);
      const onClose = vi.fn();
      renderPick("feat", onClose);
      await userEvent.click(
        screen.getByRole("button", { name: "Cherry-pick" }),
      );
      expect(info).toHaveBeenCalledWith(message);
      expect(gitCherryPickOnto).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText("Cherry-pick to branch")).toBeInTheDocument();
    });

  it("a push of another branch lets the pick run", async () => {
    await startPush("named", WT);
    renderPick("dev", vi.fn());
    await userEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
    await waitFor(() => expect(gitCherryPickOnto).toHaveBeenCalled());
    expect(info).not.toHaveBeenCalled();
  });
});
