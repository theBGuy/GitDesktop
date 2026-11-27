import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { StashesDialog } from "@/features/repository/StashesDialog";
import { NAME_CHECK_FAILED_NOTE } from "@/lib/deleted-branches/copy";
import {
  claimDeletedBranchFlight,
  DELETED_BRANCHES_KEY,
  useDeletedBranches,
  useDeletedBranchFlights,
} from "@/lib/deleted-branches/queries";
import {
  type DeletedBranchEntry,
  forgetDeletedBranch,
  loadDeletedBranches,
} from "@/lib/deleted-branches/store";
import {
  gitBranches,
  gitBranchTips,
  gitCreateBranch,
  gitFindCommitsByPrefix,
  gitObjectsPresent,
  gitOrphanedStashes,
  gitSetBranchKeepLocal,
  gitStashList,
  gitStatus,
} from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type { Branch, RepoStatus } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStashList: vi.fn(),
  gitOrphanedStashes: vi.fn(),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitBranchTips: vi.fn(),
  gitObjectsPresent: vi.fn(),
  gitFindCommitsByPrefix: vi.fn(),
  gitCreateBranch: vi.fn(),
  gitSetBranchKeepLocal: vi.fn(),
}));
const identity = vi.hoisted(() => ({
  strict: (path: string): Promise<string> => Promise.resolve(`${path}/.git`),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => `${path}/.git`,
  repoIdentityStrict: (path: string) => identity.strict(path),
}));
// The record's own suite covers its store; here the list it hands over matters.
vi.mock("@/lib/deleted-branches/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deleted-branches/store")>()),
  loadDeletedBranches: vi.fn(),
  forgetDeletedBranch: vi.fn(),
  recordDeletedBranches: vi.fn(),
}));

const REPO = "C:/repos/recover";
const TIP_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const TIP_B = "b1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const TIP_C = "c1b2c3d4e5f60718293a4b5c6d7e8f9011223344";

Element.prototype.scrollIntoView ??= () => undefined;
beforeAll(() => {
  useUiStore.setState({ repoPath: REPO });
});
afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

function entry(
  id: string,
  name: string,
  tip: string,
  over: Partial<DeletedBranchEntry> = {},
): DeletedBranchEntry {
  return {
    id,
    name,
    tip,
    deletedAt: Date.parse("2026-11-10T10:00:00Z"),
    keptLocal: false,
    upstream: null,
    ...over,
  };
}

function branchRow(name: string): Branch {
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
  };
}

/** The list on disk; a forget or restore removes from it, as the store does. */
let disk: DeletedBranchEntry[];
/** Tips `git_objects_present` and the prefix lookup report as gone. */
let pruned: Set<string>;
/** Tips whose reads both fail ("unknown"). */
let unreadable: Set<string>;
let success: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // A never-settling press in an earlier case would hold every later list.
  useDeletedBranchFlights.setState({ flights: new Map() });
  // A case that switched repositories leaves the live repo moved.
  useUiStore.setState({ repoPath: REPO });
  identity.strict = (path) => Promise.resolve(`${path}/.git`);
  disk = [];
  pruned = new Set();
  unreadable = new Set();
  success = vi.spyOn(toast, "success");
  error = vi.spyOn(toast, "error");
  info = vi.spyOn(toast, "info");
  vi.mocked(loadDeletedBranches).mockImplementation(async () => [...disk]);
  vi.mocked(forgetDeletedBranch).mockImplementation(async (_repo, id) => {
    disk = disk.filter((e) => e.id !== id);
    return true;
  });
  vi.mocked(gitStashList).mockResolvedValue([]);
  vi.mocked(gitOrphanedStashes).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitBranches).mockResolvedValue([branchRow("main")]);
  vi.mocked(gitBranchTips).mockResolvedValue({});
  vi.mocked(gitObjectsPresent).mockImplementation(async (_repo, oids) => {
    if (oids.some((o) => unreadable.has(o))) throw new Error("spawn failed");
    return !oids.some((o) => pruned.has(o));
  });
  vi.mocked(gitFindCommitsByPrefix).mockImplementation(async (_repo, tip) => {
    if (unreadable.has(tip)) throw new Error("spawn failed");
    return pruned.has(tip)
      ? []
      : ([{ commit: { hash: tip } }] as unknown as Awaited<
          ReturnType<typeof gitFindCommitsByPrefix>
        >);
  });
  vi.mocked(gitCreateBranch).mockResolvedValue(
    undefined as unknown as Awaited<ReturnType<typeof gitCreateBranch>>,
  );
  vi.mocked(gitSetBranchKeepLocal).mockResolvedValue(
    undefined as unknown as Awaited<ReturnType<typeof gitSetBranchKeepLocal>>,
  );
});

function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const view = (repo: string) => (
    <QueryClientProvider client={client}>
      <StashesDialog
        repoPath={repo}
        open
        onOpenChange={() => undefined}
        initialView="recoverable"
      />
    </QueryClientProvider>
  );
  const { rerender } = render(view(REPO));
  const switchTo = (repo: string) =>
    act(() => {
      useUiStore.setState({ repoPath: repo });
      rerender(view(repo));
    });
  return { user: userEvent.setup(), client, switchTo };
}

const section = () => screen.getByRole("region", { name: "Deleted branches" });
const row = (name: string) =>
  within(section())
    .getAllByRole("button")
    .find(
      (b) =>
        b.hasAttribute("data-deleted-branch") && b.textContent?.includes(name),
    ) as HTMLElement;
const footer = () =>
  within(section())
    .getAllByRole("button")
    .find((b) => !b.hasAttribute("data-deleted-branch")) as HTMLElement;
const held = (b: HTMLElement) => b.getAttribute("aria-disabled") === "true";
/** The text a button's aria-describedby points at. */
const description = (b: HTMLElement) =>
  (b.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
/** A deferred `gitCreateBranch`; `finish` lets it resolve. */
function deferCreate() {
  let finish: () => void = () => undefined;
  vi.mocked(gitCreateBranch).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () =>
        resolve(
          undefined as unknown as Awaited<ReturnType<typeof gitCreateBranch>>,
        );
    }),
  );
  return () => finish();
}
const RESTORE_RUNNING = "A restore is already running.";
const PRUNED = "Can't be restored — Git has removed this commit.";
/** The name-tips read for a list whose only taken name is feat/a. */
const NAME_TIPS_KEY = ["repo", REPO, "deleted-name-tips", ["feat/a"]];

describe("Recover lost work: deleted branches", () => {
  it("titles the view and lists deleted branches while the stash scan still runs", async () => {
    disk = [entry("1", "feat/x", TIP_A, { keptLocal: true })];
    vi.mocked(gitOrphanedStashes).mockReturnValue(new Promise(() => undefined));
    mount();
    expect(
      screen.getByRole("heading", { name: "Recover lost work" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /^Branches you deleted in GitDesktop, and lost uncommitted work/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Lost stashes" })).toBeTruthy();
    expect(screen.getByText("Scanning for lost stashes…")).toBeTruthy();
    await waitFor(() => expect(row("feat/x")).toBeTruthy());
    expect(row("feat/x").textContent).toContain("a1b2c3d");
    expect(row("feat/x").textContent).toContain("deleted");
    expect(row("feat/x").textContent).toContain("Keep local");
    expect(loadDeletedBranches).toHaveBeenCalledWith(`${REPO}/.git`, REPO);
  });

  it("shows the empty line only from a read that answered none, and the lost-stash empty line", async () => {
    mount();
    await waitFor(() =>
      expect(
        screen.getByText(
          "No deleted branches. Branches you delete in GitDesktop are listed here so you can restore them.",
        ),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByText("No lost stashes found.")).toBeTruthy(),
    );
  });

  it("shows skeletons while loading, and a failed read with a Retry that keeps focus off <body>", async () => {
    let fail: (e: unknown) => void = () => undefined;
    const read = new Promise<DeletedBranchEntry[]>((_, reject) => {
      fail = reject;
    });
    // The query observes it; this only keeps the runner from flagging it first.
    read.catch(() => undefined);
    vi.mocked(loadDeletedBranches).mockReturnValueOnce(read);
    const { user } = mount();
    await waitFor(() =>
      expect(screen.getByText("Loading deleted branches…")).toBeTruthy(),
    );
    expect(screen.queryByText(/^No deleted branches/)).toBeNull();
    await act(async () => fail(new Error("store unreadable")));
    await waitFor(() =>
      expect(screen.getByText("Couldn't load deleted branches.")).toBeTruthy(),
    );
    expect(screen.queryByText(/^No deleted branches/)).toBeNull();
    disk = [entry("1", "feat/x", TIP_A)];
    const retry = within(section()).getByRole("button", { name: "Retry" });
    await user.click(retry);
    await waitFor(() => expect(row("feat/x")).toBeTruthy());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("shows the read-failed line when the identity lookup failed, and Retry re-resolves it", async () => {
    identity.strict = () => Promise.reject(new Error("ipc down"));
    // Only the identity key holds entries, as the writers store them.
    vi.mocked(loadDeletedBranches).mockImplementation(async (key) =>
      key === `${REPO}/.git` ? [...disk] : [],
    );
    disk = [entry("1", "feat/x", TIP_A)];
    const { user } = mount();
    await waitFor(() =>
      expect(screen.getByText("Couldn't load deleted branches.")).toBeTruthy(),
    );
    expect(screen.queryByText(/^No deleted branches/)).toBeNull();
    identity.strict = (path) => Promise.resolve(`${path}/.git`);
    await user.click(within(section()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row("feat/x")).toBeTruthy());
    expect(loadDeletedBranches).toHaveBeenCalledWith(`${REPO}/.git`, REPO);
  });

  it("walks the rows with the arrow keys", async () => {
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    const { user } = mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    expect(row("feat/a").getAttribute("aria-current")).toBe("true");
    await user.click(row("feat/a"));
    await user.keyboard("{ArrowDown}");
    expect(row("feat/b").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(row("feat/b"));
    await user.keyboard("{ArrowUp}");
    expect(row("feat/a").getAttribute("aria-current")).toBe("true");
  });

  it("restores the selected row at its commit without checkout, holds while it runs, and moves to the next row", async () => {
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    let finish: () => void = () => undefined;
    vi.mocked(gitCreateBranch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () =>
          resolve(
            undefined as unknown as Awaited<ReturnType<typeof gitCreateBranch>>,
          );
      }),
    );
    const { user } = mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    const button = footer();
    expect(button.textContent).toBe("Restore branch");
    // The name carries the row it acts on.
    expect(
      within(section()).getByRole("button", { name: "Restore branch: feat/a" }),
    ).toBe(button);
    expect(held(button)).toBe(false);
    await user.click(button);
    await waitFor(() => expect(held(footer())).toBe(true));
    expect(footer()).toBe(button);
    expect(
      within(section()).getByText("A restore is already running."),
    ).toBeTruthy();
    await act(async () => finish());
    await waitFor(() =>
      expect(within(section()).queryByText("feat/a")).toBeNull(),
    );
    expect(gitCreateBranch).toHaveBeenCalledWith(
      REPO,
      "feat/a",
      false,
      TIP_A,
      true,
    );
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "1");
    expect(success).toHaveBeenCalledWith("Restored feat/a", undefined);
    expect(row("feat/b").getAttribute("aria-current")).toBe("true");
    expect(footer()).toBe(button);
    expect(held(button)).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("lands focus on the section when the last row is restored", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    const { user } = mount();
    await waitFor(() => expect(row("feat/a")).toBeTruthy());
    await user.click(footer());
    await waitFor(() =>
      expect(screen.getByText(/^No deleted branches/)).toBeTruthy(),
    );
    expect(document.activeElement).toBe(section());
  });

  it("offers Remove from list on a pruned row, forgets it with no git write, and swaps back to Restore on a restorable row", async () => {
    disk = [entry("1", "feat/gone", TIP_A), entry("2", "feat/b", TIP_B)];
    pruned.add(TIP_A);
    const { user } = mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "Can't be restored — Git has removed this commit.",
        ),
      ).toBeTruthy(),
    );
    const button = footer();
    expect(button.textContent).toBe("Remove from list");
    expect(
      within(section()).getByRole("button", {
        name: "Remove from list: feat/gone",
      }),
    ).toBe(button);
    expect(held(button)).toBe(false);
    await user.click(row("feat/b"));
    expect(footer()).toBe(button);
    expect(button.textContent).toBe("Restore branch");
    await user.click(row("feat/gone"));
    expect(button.textContent).toBe("Remove from list");
    await user.click(button);
    await waitFor(() =>
      expect(within(section()).queryByText("feat/gone")).toBeNull(),
    );
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "1");
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(row("feat/b").getAttribute("aria-current")).toBe("true");
    expect(footer().textContent).toBe("Restore branch");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps a pruned row whose removal failed, with a failure toast", async () => {
    disk = [entry("1", "feat/gone", TIP_A)];
    pruned.add(TIP_A);
    vi.mocked(forgetDeletedBranch).mockResolvedValueOnce(false);
    const { user } = mount();
    await waitFor(() => expect(footer().textContent).toBe("Remove from list"));
    await user.click(footer());
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Couldn't remove feat/gone from the list.",
      ),
    );
    expect(row("feat/gone")).toBeTruthy();
    expect(held(footer())).toBe(false);
  });

  it("holds Restore with its reason when a branch of that name exists again", async () => {
    disk = [entry("1", "main", TIP_A)];
    const { user } = mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "A branch named main exists again. Rename or delete it to restore this one.",
        ),
      ).toBeTruthy(),
    );
    expect(footer().textContent).toBe("Restore branch");
    expect(held(footer())).toBe(true);
    await user.click(footer());
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });

  it("clears a row whose name is back at the recorded commit through Restore, re-marking Keep local", async () => {
    disk = [
      entry("1", "feat/a", TIP_A, { keptLocal: true }),
      entry("2", "feat/b", TIP_B),
    ];
    vi.mocked(gitBranches).mockResolvedValue([
      branchRow("main"),
      branchRow("feat/a"),
    ]);
    // Upper case: the compare ignores the hex digits' case.
    vi.mocked(gitBranchTips).mockResolvedValue({
      "feat/a": TIP_A.toUpperCase(),
    });
    const { user } = mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "A branch named feat/a is already at this commit.",
        ),
      ).toBeTruthy(),
    );
    expect(gitBranchTips).toHaveBeenCalledWith(REPO, ["feat/a"]);
    const button = footer();
    expect(button.textContent).toBe("Restore branch");
    expect(held(button)).toBe(false);
    await user.click(button);
    await waitFor(() =>
      expect(within(section()).queryByText("feat/a")).toBeNull(),
    );
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitSetBranchKeepLocal).toHaveBeenCalledWith(REPO, "feat/a", true);
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "1");
    expect(success).toHaveBeenCalledWith("Restored feat/a", {
      description: "Keep local is on again.",
    });
    expect(row("feat/b").getAttribute("aria-current")).toBe("true");
    expect(footer()).toBe(button);
  });

  it("leaves a taken name pressable under the failed-check note when its tip read fails, and the press creates nothing", async () => {
    disk = [entry("1", "feat/a", TIP_A, { keptLocal: true })];
    vi.mocked(gitBranches).mockResolvedValue([branchRow("feat/a")]);
    vi.mocked(gitBranchTips).mockRejectedValue(new Error("spawn failed"));
    const { client, user } = mount();
    await waitFor(() =>
      expect(client.getQueryState(NAME_TIPS_KEY)?.status).toBe("error"),
    );
    await waitFor(() =>
      expect(within(section()).getByText(NAME_CHECK_FAILED_NOTE)).toBeTruthy(),
    );
    expect(within(section()).queryByText(/exists again/)).toBeNull();
    expect(within(section()).queryByText(/already at this commit/)).toBeNull();
    expect(footer().textContent).toBe("Restore branch");
    expect(held(footer())).toBe(false);
    // The press's own name check fails too: a failure report, nothing written.
    await user.click(footer());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(info).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitSetBranchKeepLocal).not.toHaveBeenCalled();
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
    expect(row("feat/a")).toBeTruthy();
    expect(held(footer())).toBe(false);
  });

  it("keeps a taken name held while its tip read is still pending", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    vi.mocked(gitBranches).mockResolvedValue([branchRow("feat/a")]);
    vi.mocked(gitBranchTips).mockReturnValue(new Promise(() => undefined));
    const { user } = mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "A branch named feat/a exists again. Rename or delete it to restore this one.",
        ),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(gitBranchTips).toHaveBeenCalledTimes(1));
    expect(held(footer())).toBe(true);
    expect(within(section()).queryByText(NAME_CHECK_FAILED_NOTE)).toBeNull();
    expect(within(section()).queryByText(/already at this commit/)).toBeNull();
    await user.click(footer());
    await act(() => Promise.resolve());
    expect(gitBranchTips).toHaveBeenCalledTimes(1);
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
  });

  it("turns an already-back row into the failed-check note when a later tip read fails", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    vi.mocked(gitBranches).mockResolvedValue([branchRow("feat/a")]);
    vi.mocked(gitBranchTips).mockResolvedValue({ "feat/a": TIP_A });
    const { client } = mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "A branch named feat/a is already at this commit.",
        ),
      ).toBeTruthy(),
    );
    expect(held(footer())).toBe(false);
    vi.mocked(gitBranchTips).mockRejectedValue(new Error("spawn failed"));
    await act(() => client.invalidateQueries({ queryKey: NAME_TIPS_KEY }));
    await waitFor(() =>
      expect(client.getQueryState(NAME_TIPS_KEY)?.status).toBe("error"),
    );
    await waitFor(() =>
      expect(within(section()).getByText(NAME_CHECK_FAILED_NOTE)).toBeTruthy(),
    );
    expect(within(section()).queryByText(/already at this commit/)).toBeNull();
    expect(within(section()).queryByText(/exists again/)).toBeNull();
    expect(held(footer())).toBe(false);
  });

  it("clears a failed-check row whose press finds the name at the recorded commit", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    vi.mocked(gitBranches).mockResolvedValue([branchRow("feat/a")]);
    vi.mocked(gitBranchTips)
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue({ "feat/a": TIP_A });
    const { user } = mount();
    await waitFor(() =>
      expect(within(section()).getByText(NAME_CHECK_FAILED_NOTE)).toBeTruthy(),
    );
    await user.click(footer());
    await waitFor(() =>
      expect(within(section()).queryByText("feat/a")).toBeNull(),
    );
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "1");
    expect(success).toHaveBeenCalledWith("Restored feat/a", undefined);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "holds a taken %s the tips read omitted without reading an inherited member",
    async (name) => {
      disk = [entry("1", name, TIP_A)];
      vi.mocked(gitBranches).mockResolvedValue([branchRow(name)]);
      const { client } = mount();
      const key = ["repo", REPO, "deleted-name-tips", [name]];
      await waitFor(() =>
        expect(client.getQueryState(key)?.status).toBe("success"),
      );
      await waitFor(() =>
        expect(
          within(section()).getByText(
            `A branch named ${name} exists again. Rename or delete it to restore this one.`,
          ),
        ).toBeTruthy(),
      );
      expect(held(footer())).toBe(true);
    },
  );

  it("reads an own __proto__ tip at the recorded commit as already back", async () => {
    disk = [entry("1", "__proto__", TIP_A)];
    vi.mocked(gitBranches).mockResolvedValue([branchRow("__proto__")]);
    // JSON.parse makes an own key; an object literal would set the prototype.
    vi.mocked(gitBranchTips).mockResolvedValue(
      JSON.parse(`{"__proto__":"${TIP_A}"}`),
    );
    mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "A branch named __proto__ is already at this commit.",
        ),
      ).toBeTruthy(),
    );
    expect(held(footer())).toBe(false);
  });

  it("keeps an own __proto__ tip already back after a refetch whose answer differs", async () => {
    disk = [entry("1", "__proto__", TIP_A), entry("2", "feat/a", TIP_B)];
    vi.mocked(gitBranches).mockResolvedValue([
      branchRow("__proto__"),
      branchRow("feat/a"),
    ]);
    const answer = (feat: string) =>
      JSON.parse(`{"__proto__":"${TIP_A}","feat/a":"${feat}"}`);
    vi.mocked(gitBranchTips)
      .mockResolvedValueOnce(answer(TIP_C))
      .mockResolvedValueOnce(answer(TIP_B));
    const { client } = mount();
    const already = "A branch named __proto__ is already at this commit.";
    await waitFor(() =>
      expect(within(section()).getByText(already)).toBeTruthy(),
    );
    // Another name's tip differs, so structural sharing rebuilds the answer.
    await act(() =>
      client.invalidateQueries({
        queryKey: ["repo", REPO, "deleted-name-tips", ["__proto__", "feat/a"]],
      }),
    );
    expect(gitBranchTips).toHaveBeenCalledTimes(2);
    // The other row's note flips only once the refetched answer has rendered.
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "A branch named feat/a is already at this commit.",
        ),
      ).toBeTruthy(),
    );
    expect(within(section()).getByText(already)).toBeTruthy();
    expect(held(footer())).toBe(false);
  });

  it("keeps a selection moved while a restore runs", async () => {
    disk = [
      entry("1", "feat/a", TIP_A),
      entry("2", "feat/b", TIP_B),
      entry("3", "feat/c", TIP_C),
    ];
    let finish: () => void = () => undefined;
    vi.mocked(gitCreateBranch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () =>
          resolve(
            undefined as unknown as Awaited<ReturnType<typeof gitCreateBranch>>,
          );
      }),
    );
    const { user } = mount();
    await waitFor(() => expect(row("feat/c")).toBeTruthy());
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    await user.click(row("feat/b"));
    await user.keyboard("{ArrowDown}");
    expect(row("feat/c").getAttribute("aria-current")).toBe("true");
    await act(async () => finish());
    await waitFor(() =>
      expect(within(section()).queryByText("feat/a")).toBeNull(),
    );
    expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "1");
    expect(row("feat/c").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(row("feat/c"));
  });

  it("keeps a selection moved while a removal runs", async () => {
    disk = [
      entry("1", "feat/gone", TIP_A),
      entry("2", "feat/b", TIP_B),
      entry("3", "feat/c", TIP_C),
    ];
    pruned.add(TIP_A);
    let finish: () => void = () => undefined;
    vi.mocked(forgetDeletedBranch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => {
          disk = disk.filter((e) => e.id !== "1");
          resolve(true);
        };
      }),
    );
    const { user } = mount();
    await waitFor(() => expect(footer().textContent).toBe("Remove from list"));
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    await user.click(row("feat/b"));
    await user.keyboard("{ArrowDown}");
    expect(row("feat/c").getAttribute("aria-current")).toBe("true");
    await act(async () => finish());
    await waitFor(() =>
      expect(within(section()).queryByText("feat/gone")).toBeNull(),
    );
    expect(row("feat/c").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(row("feat/c"));
  });

  it("walks held, already-back and restorable rows with the arrow keys on one footer", async () => {
    disk = [
      entry("1", "feat/a", TIP_A),
      entry("2", "main", TIP_B),
      entry("3", "feat/c", TIP_C),
    ];
    vi.mocked(gitBranches).mockResolvedValue([
      branchRow("main"),
      branchRow("feat/a"),
    ]);
    vi.mocked(gitBranchTips).mockResolvedValue({
      "feat/a": TIP_A,
      main: TIP_A,
    });
    const { user } = mount();
    await waitFor(() =>
      expect(
        within(section()).getByText(/already at this commit/),
      ).toBeTruthy(),
    );
    const button = footer();
    expect(held(button)).toBe(false);
    await user.click(row("feat/a"));
    await user.keyboard("{ArrowDown}");
    expect(row("main").getAttribute("aria-current")).toBe("true");
    expect(footer()).toBe(button);
    expect(held(button)).toBe(true);
    await user.keyboard("{ArrowDown}");
    expect(row("feat/c").getAttribute("aria-current")).toBe("true");
    expect(footer()).toBe(button);
    expect(held(button)).toBe(false);
  });

  it("never offers removal on a row whose commit couldn't be read", async () => {
    disk = [entry("1", "feat/x", TIP_C)];
    unreadable.add(TIP_C);
    mount();
    // The batch read and the per-tip read both fail: "unknown".
    await waitFor(() => expect(gitObjectsPresent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(footer().textContent).toBe("Restore branch"));
    expect(held(footer())).toBe(false);
    expect(within(section()).queryByText(/Can't be restored/)).toBeNull();
  });

  it("labels the footer by the selected row while a press runs, holding it for the press", async () => {
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/gone", TIP_B)];
    pruned.add(TIP_B);
    vi.mocked(gitCreateBranch).mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const { user } = mount();
    await waitFor(() =>
      expect(within(section()).getByText(PRUNED)).toBeTruthy(),
    );
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    await user.click(row("feat/gone"));
    expect(footer().textContent).toBe("Remove from list");
    expect(held(footer())).toBe(true);
    expect(
      within(section()).getByText("A restore is already running."),
    ).toBeTruthy();
  });

  it("never holds another repository's list for a press still running here", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    vi.mocked(gitCreateBranch).mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const { user, switchTo } = mount();
    await waitFor(() => expect(row("feat/a")).toBeTruthy());
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    const OTHER = "C:/repos/other";
    vi.mocked(loadDeletedBranches).mockImplementation(async (key) =>
      key === `${OTHER}/.git` ? [entry("9", "feat/z", TIP_C)] : [...disk],
    );
    switchTo(OTHER);
    await waitFor(() => expect(row("feat/z")).toBeTruthy());
    expect(footer().textContent).toBe("Restore branch");
    expect(held(footer())).toBe(false);
    expect(
      within(section()).queryByText("A restore is already running."),
    ).toBeNull();
  });

  it("keeps one tab stop on the selected row", async () => {
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    const { user } = mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    expect(row("feat/a").tabIndex).toBe(0);
    expect(row("feat/b").tabIndex).toBe(-1);
    await user.click(row("feat/a"));
    await user.keyboard("{ArrowDown}");
    expect(row("feat/a").tabIndex).toBe(-1);
    expect(row("feat/b").tabIndex).toBe(0);
  });

  it("keeps the rows under a notice with Retry when a refresh fails", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    const { user, client } = mount();
    await waitFor(() => expect(row("feat/a")).toBeTruthy());
    vi.mocked(loadDeletedBranches).mockRejectedValueOnce(
      new Error("store unreadable"),
    );
    await act(() =>
      client.invalidateQueries({ queryKey: ["deleted-branches"] }),
    );
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "Couldn't refresh deleted branches — showing the last loaded results.",
        ),
      ).toBeTruthy(),
    );
    expect(row("feat/a")).toBeTruthy();
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    await user.click(
      within(section()).getByRole("button", {
        name: "Retry loading deleted branches",
      }),
    );
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    expect(
      within(section()).queryByText(/^Couldn't refresh deleted branches/),
    ).toBeNull();
  });

  it("ignores a held Enter on the footer in either label", async () => {
    disk = [entry("1", "feat/gone", TIP_A), entry("2", "feat/b", TIP_B)];
    pruned.add(TIP_A);
    const { user } = mount();
    await waitFor(() => expect(footer().textContent).toBe("Remove from list"));
    const held1 = fireEvent.keyDown(footer(), { key: "Enter", repeat: true });
    expect(held1).toBe(false);
    await user.click(row("feat/b"));
    expect(footer().textContent).toBe("Restore branch");
    expect(fireEvent.keyDown(footer(), { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(footer(), { key: "Enter" })).toBe(true);
    expect(forgetDeletedBranch).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });
});

describe("Recover lost work: one press per repository", () => {
  it("holds another checkout of the same repository while a restore runs there", async () => {
    const OTHER = "C:/repos/recover-linked";
    identity.strict = () => Promise.resolve("C:/repos/shared/.git");
    disk = [entry("1", "feat/a", TIP_A)];
    deferCreate();
    const { user, switchTo } = mount();
    await waitFor(() => expect(row("feat/a")).toBeTruthy());
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    switchTo(OTHER);
    await waitFor(() => expect(loadDeletedBranches).toHaveBeenCalledTimes(2));
    expect(row("feat/a")).toBeTruthy();
    expect(held(footer())).toBe(true);
    expect(within(section()).getByText(RESTORE_RUNNING)).toBeTruthy();
  });

  it("holds a dialog mounted while another instance's restore runs, until it settles", async () => {
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    const finish = deferCreate();
    const first = mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    await first.user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    cleanup();

    mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    expect(held(footer())).toBe(true);
    expect(within(section()).getByText(RESTORE_RUNNING)).toBeTruthy();
    await act(async () => finish());
    await waitFor(() => expect(held(footer())).toBe(false));
    expect(within(section()).queryByText(RESTORE_RUNNING)).toBeNull();
  });

  it("keeps a selection made in another repository when this repository's restore settles", async () => {
    const OTHER = "C:/repos/other";
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    vi.mocked(loadDeletedBranches).mockImplementation(async (key) =>
      key === `${OTHER}/.git`
        ? [entry("9", "feat/z", TIP_C), entry("1", "feat/y", TIP_C)]
        : [...disk],
    );
    const finish = deferCreate();
    const { user, switchTo } = mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    switchTo(OTHER);
    await waitFor(() => expect(row("feat/y")).toBeTruthy());
    await user.click(row("feat/y"));
    expect(row("feat/y").getAttribute("aria-current")).toBe("true");
    await act(async () => finish());
    await waitFor(() => expect(forgetDeletedBranch).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(row("feat/y").getAttribute("aria-current")).toBe("true");
    expect(row("feat/z").getAttribute("aria-current")).toBeNull();
  });

  it("keeps holding a press made before the identity resolved, and moves the selection when it settles", async () => {
    let calls = 0;
    // The identity read fails; the list's own strict lookup then answers.
    identity.strict = (path) =>
      calls++ === 0
        ? Promise.reject(new Error("ipc down"))
        : Promise.resolve(`${path}/.git`);
    disk = [
      entry("1", "feat/a", TIP_A),
      entry("2", "feat/b", TIP_B),
      entry("3", "feat/c", TIP_C),
    ];
    const finish = deferCreate();
    const { user, client } = mount();
    await waitFor(() => expect(row("feat/c")).toBeTruthy());
    await user.click(row("feat/b"));
    await user.click(footer());
    await waitFor(() => expect(held(footer())).toBe(true));
    act(() => {
      client.setQueryData(
        repoIdentityQueryOptions(REPO).queryKey,
        `${REPO}/.git`,
      );
    });
    await waitFor(() =>
      expect(loadDeletedBranches).toHaveBeenLastCalledWith(
        `${REPO}/.git`,
        REPO,
      ),
    );
    await waitFor(() => expect(row("feat/c")).toBeTruthy());
    expect(held(footer())).toBe(true);
    expect(within(section()).getByText(RESTORE_RUNNING)).toBeTruthy();
    expect(
      claimDeletedBranchFlight(`${REPO}/.git`, "restoring", normPath(REPO)),
    ).toBeNull();
    await user.click(footer());
    await act(() => Promise.resolve());
    expect(gitCreateBranch).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(held(footer())).toBe(false));
    await waitFor(() =>
      expect(row("feat/c").getAttribute("aria-current")).toBe("true"),
    );
    expect(row("feat/a").getAttribute("aria-current")).toBeNull();
  });

  it("keeps a restored row whose record couldn't be removed listed and selected", async () => {
    disk = [entry("1", "feat/a", TIP_A), entry("2", "feat/b", TIP_B)];
    vi.mocked(forgetDeletedBranch).mockResolvedValueOnce(false);
    const { user } = mount();
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    await user.click(footer());
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(success.mock.calls[0]?.[0]).toBe("Restored feat/a");
    await waitFor(() => expect(held(footer())).toBe(false));
    expect(row("feat/a")).toBeTruthy();
    expect(row("feat/a").getAttribute("aria-current")).toBe("true");
    expect(row("feat/b").getAttribute("aria-current")).toBeNull();
  });
});

describe("Recover lost work: one list per checkout", () => {
  it("caches two checkouts of one repository apart, and a family invalidation re-reads both", async () => {
    const LINKED = "C:/repos/recover-linked";
    const SHARED = "C:/repos/shared/.git";
    identity.strict = () => Promise.resolve(SHARED);
    // The read merges entries still stored under each checkout's raw path.
    vi.mocked(loadDeletedBranches).mockImplementation(async (_id, path) =>
      path === LINKED
        ? [entry("2", "feat/linked", TIP_B)]
        : [entry("1", "feat/main", TIP_A)],
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => ({
        main: useDeletedBranches(REPO, true),
        linked: useDeletedBranches(LINKED, true),
      }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => {
      expect(result.current.main.data?.map((e) => e.name)).toEqual([
        "feat/main",
      ]);
      expect(result.current.linked.data?.map((e) => e.name)).toEqual([
        "feat/linked",
      ]);
    });
    // The keys an identity resolved, beside the disabled pre-resolution ones.
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: [...DELETED_BRANCHES_KEY, SHARED] })
        .map((q) => q.queryKey),
    ).toEqual([
      [...DELETED_BRANCHES_KEY, SHARED, REPO],
      [...DELETED_BRANCHES_KEY, SHARED, LINKED],
    ]);
    vi.mocked(loadDeletedBranches).mockClear();
    await act(() =>
      client.invalidateQueries({ queryKey: DELETED_BRANCHES_KEY }),
    );
    expect(
      vi
        .mocked(loadDeletedBranches)
        .mock.calls.map((c) => c[1])
        .sort(),
    ).toEqual([LINKED, REPO].sort());
  });
});

describe("Recover lost work: pruned commits", () => {
  it("reads the tips again when the dialog reopens", async () => {
    disk = [entry("1", "feat/a", TIP_A)];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mount(client);
    await waitFor(() => expect(gitObjectsPresent).toHaveBeenCalled());
    await waitFor(() => expect(footer().textContent).toBe("Restore branch"));
    const reads = vi.mocked(gitObjectsPresent).mock.calls.length;
    cleanup();

    pruned.add(TIP_A);
    mount(client);
    await waitFor(() => expect(footer().textContent).toBe("Remove from list"));
    expect(vi.mocked(gitObjectsPresent).mock.calls.length).toBeGreaterThan(
      reads,
    );
  });

  it("holds Remove from list while a pruned verdict comes from the previous list's read", async () => {
    disk = [entry("1", "feat/gone", TIP_A)];
    pruned.add(TIP_A);
    const { user, client } = mount();
    await waitFor(() => expect(footer().textContent).toBe("Remove from list"));
    let answer: (present: boolean) => void = () => undefined;
    vi.mocked(gitObjectsPresent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    disk = [entry("1", "feat/gone", TIP_A), entry("2", "feat/b", TIP_B)];
    await act(() =>
      client.invalidateQueries({ queryKey: ["deleted-branches"] }),
    );
    await waitFor(() => expect(row("feat/b")).toBeTruthy());
    expect(within(section()).getByText(PRUNED)).toBeTruthy();
    expect(footer().textContent).toBe("Remove from list");
    expect(held(footer())).toBe(true);
    expect(description(footer())).toBe("Checking this commit again…");
    await user.click(footer());
    await act(() => Promise.resolve());
    expect(forgetDeletedBranch).not.toHaveBeenCalled();

    await act(async () => answer(false));
    await waitFor(() => expect(held(footer())).toBe(false));
    await user.click(footer());
    await waitFor(() =>
      expect(forgetDeletedBranch).toHaveBeenCalledWith(REPO, "1"),
    );
  });
});
