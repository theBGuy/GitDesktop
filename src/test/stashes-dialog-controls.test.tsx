import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { StashesDialog } from "@/features/repository/StashesDialog";
import { useDeletedBranchFlights } from "@/lib/deleted-branches/queries";
import { loadDeletedBranches } from "@/lib/deleted-branches/store";
import {
  gitBranches,
  gitBranchTips,
  gitDropStashBySha,
  gitObjectsPresent,
  gitOrphanedStashes,
  gitOrphanedStashFiles,
  gitRestoreOrphaned,
  gitStashApply,
  gitStashList,
  gitStatus,
} from "@/lib/git/api";
import type { OrphanedStash, RepoStatus, StashEntry } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStashList: vi.fn(),
  gitStashApply: vi.fn(),
  gitDropStashBySha: vi.fn(),
  gitOrphanedStashes: vi.fn(),
  gitOrphanedStashFiles: vi.fn(),
  gitRestoreOrphaned: vi.fn(),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitBranchTips: vi.fn(),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) => `${path}/.git`,
  repoIdentityStrict: (path: string) => Promise.resolve(`${path}/.git`),
}));
vi.mock("@/lib/deleted-branches/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deleted-branches/store")>()),
  loadDeletedBranches: vi.fn(),
}));

const REPO = "C:/repos/stashes";
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const SHA_B = "b1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const ORPHAN_KEY = ["repo", REPO, "orphaned-stashes"];

Element.prototype.scrollIntoView ??= () => undefined;
beforeAll(() => {
  useUiStore.setState({ repoPath: REPO });
});
afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const stashes: StashEntry[] = [
  { index: 0, sha: SHA_A, message: "WIP on main: first", date: "" },
  { index: 1, sha: SHA_B, message: "WIP on main: second", date: "" },
];
const orphans: OrphanedStash[] = [
  { sha: SHA_A, message: "lost one", date: "", fileCount: 1 },
  { sha: SHA_B, message: "lost two", date: "", fileCount: 2 },
];

/** A promise and the function that settles it. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDeletedBranchFlights.setState({ flights: new Map() });
  vi.mocked(loadDeletedBranches).mockResolvedValue([]);
  vi.mocked(gitStashList).mockResolvedValue(stashes);
  vi.mocked(gitOrphanedStashes).mockResolvedValue([]);
  vi.mocked(gitOrphanedStashFiles).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitBranches).mockResolvedValue([]);
  vi.mocked(gitBranchTips).mockResolvedValue({});
  vi.mocked(gitObjectsPresent).mockResolvedValue(true);
});

function mount(initialView: "stashes" | "recoverable") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StashesDialog
        repoPath={REPO}
        open
        onOpenChange={() => undefined}
        initialView={initialView}
      />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client };
}

const held = (b: HTMLElement) => b.getAttribute("aria-disabled") === "true";
/** The text a button's aria-describedby points at. */
const description = (b: HTMLElement) =>
  (b.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
const stashRow = (sha: string) =>
  document.querySelector(`[data-stash^="${sha}"]`) as HTMLElement;
const orphanRow = (sha: string) =>
  document.querySelector(`[data-orphaned="${sha}"]`) as HTMLElement;
const lostPane = () => screen.getByRole("region", { name: "Lost stashes" });
const rescan = () => within(lostPane()).getByRole("button", { name: "Rescan" });
/** `hidden`: the drop's confirm stays open over them while the drop runs. */
const footerButtons = () =>
  ["Drop", "Apply", "Pop"].map((verb) =>
    screen.getByRole("button", { name: `${verb} stash@{0}`, hidden: true }),
  );

describe("View stashes: the stash list", () => {
  it("names each footer button by its stash and marks the selected row", async () => {
    const { user } = mount("stashes");
    await waitFor(() => expect(stashRow(SHA_B)).toBeTruthy());
    expect(stashRow(SHA_A).getAttribute("aria-current")).toBe("true");
    expect(stashRow(SHA_B).getAttribute("aria-current")).toBeNull();
    const [drop, apply, pop] = footerButtons();
    expect(drop.textContent).toBe("Drop…");
    expect(apply.textContent).toBe("Apply");
    expect(pop.textContent).toBe("Pop");
    await user.click(stashRow(SHA_B));
    expect(stashRow(SHA_B).getAttribute("aria-current")).toBe("true");
    expect(stashRow(SHA_A).getAttribute("aria-current")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Apply stash@{1}" }),
    ).toBeTruthy();
  });

  it("holds Drop, Apply and Pop with the apply's reason while it runs", async () => {
    const write = deferred<void>();
    vi.mocked(gitStashApply).mockReturnValueOnce(write.promise);
    const { user } = mount("stashes");
    await waitFor(() => expect(stashRow(SHA_A)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Apply stash@{0}" }));
    await user.click(
      await screen.findByRole("button", { name: "Apply stash" }),
    );
    await waitFor(() => expect(held(footerButtons()[1])).toBe(true));
    for (const button of footerButtons()) {
      expect(held(button)).toBe(true);
      expect(description(button)).toBe("Applying a stash…");
    }
    await act(async () => write.settle());
    await waitFor(() => expect(held(footerButtons()[1])).toBe(false));
  });

  it("holds Drop, Apply and Pop with the drop's reason while it runs", async () => {
    const write = deferred<Awaited<ReturnType<typeof gitDropStashBySha>>>();
    vi.mocked(gitDropStashBySha).mockReturnValueOnce(write.promise);
    const { user } = mount("stashes");
    await waitFor(() => expect(stashRow(SHA_A)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Drop stash@{0}" }));
    await user.click(await screen.findByRole("button", { name: "Drop stash" }));
    await waitFor(() => expect(held(footerButtons()[0])).toBe(true));
    for (const button of footerButtons()) {
      expect(held(button)).toBe(true);
      expect(description(button)).toBe("Dropping a stash…");
    }
  });
});

describe("Recover lost work: lost stashes", () => {
  it("names Restore to working tree by its stash, marks the selected row, and holds it with a reason while it runs", async () => {
    vi.mocked(gitOrphanedStashes).mockResolvedValue(orphans);
    const write = deferred<void>();
    vi.mocked(gitRestoreOrphaned).mockReturnValueOnce(write.promise);
    const { user } = mount("recoverable");
    await waitFor(() => expect(orphanRow(SHA_B)).toBeTruthy());
    expect(orphanRow(SHA_A).getAttribute("aria-current")).toBe("true");
    expect(orphanRow(SHA_B).getAttribute("aria-current")).toBeNull();
    const restore = screen.getByRole("button", {
      name: "Restore to working tree: lost one",
    });
    expect(restore.textContent).toBe("Restore to working tree");
    await user.click(restore);
    await waitFor(() => expect(held(restore)).toBe(true));
    expect(description(restore)).toBe("Restoring a stash…");
    expect(gitRestoreOrphaned).toHaveBeenCalledWith(REPO, SHA_A);
    await user.click(orphanRow(SHA_B));
    expect(orphanRow(SHA_B).getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Restore to working tree: lost two" }),
    ).toBe(restore);
  });

  it("keeps one Rescan through its own scan, held with its reason", async () => {
    const { user } = mount("recoverable");
    await waitFor(() =>
      expect(screen.getByText("No lost stashes found.")).toBeTruthy(),
    );
    const button = rescan();
    expect(held(button)).toBe(false);
    const scan = deferred<OrphanedStash[]>();
    vi.mocked(gitOrphanedStashes).mockReturnValueOnce(scan.promise);
    await user.click(button);
    await waitFor(() =>
      expect(screen.getByText("Scanning for lost stashes…")).toBeTruthy(),
    );
    expect(rescan()).toBe(button);
    expect(held(button)).toBe(true);
    expect(description(button)).toBe("A scan is already running.");
    expect(document.activeElement).toBe(button);
    await act(async () => scan.settle([]));
    await waitFor(() => expect(held(button)).toBe(false));
    expect(rescan()).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("lands focus on the first lost stash when a scan finds some, and the arrows walk them", async () => {
    const { user } = mount("recoverable");
    await waitFor(() =>
      expect(screen.getByText("No lost stashes found.")).toBeTruthy(),
    );
    const scan = deferred<OrphanedStash[]>();
    vi.mocked(gitOrphanedStashes).mockReturnValueOnce(scan.promise);
    rescan().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(held(rescan())).toBe(true));
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      await act(async () => scan.settle(orphans));
      await waitFor(() => expect(orphanRow(SHA_A)).toBeTruthy());
      expect(document.activeElement).toBe(orphanRow(SHA_A));
      // The remounted list starts at the top, so the landed row scrolls in.
      expect(scrolled.mock.contexts).toEqual([orphanRow(SHA_A)]);
      expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      scrolled.mockRestore();
    }
    expect(orphanRow(SHA_A).getAttribute("aria-current")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(orphanRow(SHA_B));
    expect(orphanRow(SHA_B).getAttribute("aria-current")).toBe("true");
  });

  it("lands focus on Rescan when a refetch replaces the listed stashes", async () => {
    vi.mocked(gitOrphanedStashes).mockResolvedValue(orphans);
    const { user, client } = mount("recoverable");
    await waitFor(() => expect(orphanRow(SHA_B)).toBeTruthy());
    await user.click(orphanRow(SHA_B));
    expect(document.activeElement).toBe(orphanRow(SHA_B));
    const scan = deferred<OrphanedStash[]>();
    vi.mocked(gitOrphanedStashes).mockReturnValueOnce(scan.promise);
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      await act(() => {
        void client.invalidateQueries({ queryKey: ORPHAN_KEY });
        return Promise.resolve();
      });
      await waitFor(() => expect(rescan()).toBeTruthy());
      expect(document.activeElement).toBe(rescan());
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      scrolled.mockRestore();
    }
    await act(async () => scan.settle(orphans));
  });

  it("takes no focus when the pane mounts while nothing holds focus", async () => {
    const scan = deferred<OrphanedStash[]>();
    vi.mocked(gitOrphanedStashes).mockReturnValueOnce(scan.promise);
    mount("stashes");
    await waitFor(() => expect(stashRow(SHA_A)).toBeTruthy());
    // The dialog's own initial focus lands first, so it can't move focus later.
    await waitFor(() =>
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
        true,
      ),
    );
    const toggle = screen.getByRole("button", { name: "Recoverable" });
    // A native click moves no focus, so the pane mounts with <body> focused.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      toggle.click();
    });
    // Read in the mount's own commit: Base UI's focus-out fallback may later
    // move <body> focus to the popup, which is the dialog's, not the pane's.
    expect(screen.getByText("Scanning for lost stashes…")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    await act(async () => scan.settle([]));
    await waitFor(() =>
      expect(screen.getByText("No lost stashes found.")).toBeTruthy(),
    );
    expect(lostPane().contains(document.activeElement)).toBe(false);
  });

  it("takes no focus when a scan lands while focus is on another control", async () => {
    vi.mocked(gitOrphanedStashes).mockResolvedValue(orphans);
    const { user } = mount("stashes");
    await waitFor(() => expect(stashRow(SHA_A)).toBeTruthy());
    const toggle = screen.getByRole("button", { name: "Recoverable" });
    await user.click(toggle);
    await waitFor(() => expect(orphanRow(SHA_A)).toBeTruthy());
    expect(document.activeElement).toBe(toggle);
  });
});
