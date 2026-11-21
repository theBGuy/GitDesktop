import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileFilterStore } from "@/components/use-file-list-filter";
import { StashesDialog } from "@/features/repository/StashesDialog";
import { TabPanel } from "@/features/repository/TabPanel";
import { useDeletedBranchFlights } from "@/lib/deleted-branches/queries";
import { loadDeletedBranches } from "@/lib/deleted-branches/store";
import {
  gitBranches,
  gitBranchTips,
  gitObjectsPresent,
  gitOrphanedStashes,
  gitOrphanedStashFileDiff,
  gitOrphanedStashFiles,
  gitStashList,
  gitStatus,
} from "@/lib/git/api";
import type {
  OrphanedStash,
  RepoStatus,
  StashEntry,
  StashFile,
} from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStashList: vi.fn(),
  gitOrphanedStashes: vi.fn(),
  gitOrphanedStashFiles: vi.fn(),
  gitOrphanedStashFileDiff: vi.fn(),
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
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
// The measured row's width, per test: wide by default, so the rail is
// expanded and its field rendered.
const pane = vi.hoisted(() => ({ width: 900 }));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, pane.width],
}));
// The stand-in pane names the file it shows and the diff text its read
// answered, in attributes.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffContent({
    filePath,
    diff,
    contentRevs,
  }: {
    filePath: string;
    diff?: { data?: { text: string } };
    contentRevs?: { oldRev: string; newRev: string };
  }) {
    useReportPaneSettled(true);
    return (
      <div
        data-open-file={filePath}
        data-diff-text={diff?.data?.text}
        data-new-rev={contentRevs?.newRev}
      />
    );
  }
  return { DiffSurface: DiffContent, DiffContent };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "C:/repos/stash-filter";
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const SHA_B = "b1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const SHA_L = "c1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const LONG = Array.from(
  { length: 42 },
  (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`,
);

const stashes: StashEntry[] = [
  { index: 0, sha: SHA_A, message: "WIP on main: first", date: "" },
  { index: 1, sha: SHA_B, message: "WIP on main: second", date: "" },
];
const orphans: OrphanedStash[] = [
  { sha: SHA_L, message: "lost one", date: "", fileCount: 2 },
];

/** The files each stash commit carries. */
let lists: Record<string, string[]> = {};
/** Per-path overrides of the default text-file row. */
let shapes: Record<string, Partial<StashFile>> = {};
const stashFile = (path: string): StashFile => ({
  path,
  added: 1,
  deleted: 1,
  isBinary: false,
  binaryKind: null,
  untracked: false,
  ...shapes[path],
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let open = true;
  let shown = true;
  let rerender: (ui: ReactNode) => void = () => undefined;
  // The host's handler: a dismissal (Escape, the close button) closes it.
  const onOpenChange = vi.fn((next: boolean) => {
    open = next;
    rerender(view());
  });
  // The repository tab panel a tab switch hides (its Activity + portal boundary).
  const view = () => (
    <QueryClientProvider client={client}>
      <TabPanel active={shown}>
        <StashesDialog
          repoPath={REPO}
          open={open}
          onOpenChange={onOpenChange}
          initialView="stashes"
        />
      </TabPanel>
    </QueryClientProvider>
  );
  const utils = render(view());
  rerender = utils.rerender;
  return {
    user: userEvent.setup(),
    client,
    onOpenChange,
    setOpen: (next: boolean) => {
      open = next;
      utils.rerender(view());
    },
    setShown: (next: boolean) => {
      shown = next;
      utils.rerender(view());
    },
  };
}

const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });
const fieldGroup = () =>
  field().closest('[data-slot="input-group"]') as HTMLElement;
const rail = () => screen.getByRole("complementary", { name: "Changed files" });
const rendered = () =>
  Array.from(
    rail().querySelectorAll<HTMLElement>("[data-path]"),
    (el) => el.dataset.path,
  );
const row = (path: string) =>
  rail().querySelector<HTMLElement>(`[data-path="${path}"]`) as HTMLElement;
const live = (attr: string) =>
  Array.from(document.querySelectorAll(`[${attr}]`))
    .find((el) => el.closest("[inert]") === null)
    ?.getAttribute(attr);
const openFile = () => live("data-open-file");
/** The shown diff's text: each (stash, path) read answers its own. */
const diffText = () => live("data-diff-text");
const patchOf = (sha: string, path: string) => `${sha}:${path}`;
const expectShown = (path: string, sha = SHA_A) => {
  expect(openFile()).toBe(path);
  expect(diffText()).toBe(patchOf(sha, path));
};
const expectOpen = (path: string, sha = SHA_A) =>
  waitFor(() => expectShown(path, sha));
const stashRow = (sha: string) =>
  document.querySelector(`[data-stash^="${sha}"]`) as HTMLElement;
const status = () =>
  document.querySelector<HTMLElement>("[data-file-filter-status]");
const closeButton = () => screen.getByRole("button", { name: "Close" });
/** Re-reads one list the way a background refetch does. */
const refetchList = (
  client: QueryClient,
  list: "stashes" | "orphaned-stashes",
) => client.invalidateQueries({ queryKey: ["repo", REPO, list] });
/** The stored stash filter texts: each dialog instance keys its own scopes. */
const stashTexts = () =>
  Object.fromEntries(
    Object.entries(useFileFilterStore.getState().texts).filter(([scope]) =>
      scope.startsWith("stash"),
    ),
  );

/** Two dialogs at once: A in a panel a tab switch hides (it stays open), B in
 *  the panel shown instead. */
function mountPair() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let aShown = true;
  let bOpen = false;
  const view = () => (
    <QueryClientProvider client={client}>
      <TabPanel active={aShown}>
        <StashesDialog
          repoPath={REPO}
          open
          onOpenChange={vi.fn()}
          initialView="stashes"
        />
      </TabPanel>
      <TabPanel active={!aShown}>
        <StashesDialog
          repoPath={REPO}
          open={bOpen}
          onOpenChange={vi.fn()}
          initialView="stashes"
        />
      </TabPanel>
    </QueryClientProvider>
  );
  const utils = render(view());
  return {
    user: userEvent.setup(),
    setAShown: (next: boolean) => {
      aShown = next;
      utils.rerender(view());
    },
    setBOpen: (next: boolean) => {
      bOpen = next;
      utils.rerender(view());
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
  pane.width = 900;
  useUiStore.setState({ repoPath: REPO });
  useFileFilterStore.setState({ texts: {} });
  useDeletedBranchFlights.setState({ flights: new Map() });
  lists = {};
  shapes = {};
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(loadDeletedBranches).mockResolvedValue([]);
  vi.mocked(gitStashList).mockResolvedValue(stashes);
  vi.mocked(gitOrphanedStashes).mockResolvedValue(orphans);
  vi.mocked(gitOrphanedStashFiles).mockImplementation(async (_r, sha) =>
    (lists[sha] ?? []).map(stashFile),
  );
  vi.mocked(gitOrphanedStashFileDiff).mockImplementation(
    async (_r, sha, filePath) => ({
      filePath,
      isBinary: false,
      isTruncated: false,
      text: patchOf(sha, filePath),
    }),
  );
  vi.mocked(gitStatus).mockResolvedValue({
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitBranches).mockResolvedValue([]);
  vi.mocked(gitBranchTips).mockResolvedValue({});
  vi.mocked(gitObjectsPresent).mockResolvedValue(true);
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("View stashes file filter", () => {
  it("S1: the count lives in the field; typing narrows the rows by path", async () => {
    lists[SHA_A] = ["src/index.ts", "lib/index.ts", "docs/index.md"];
    const { user } = mount();
    await expectOpen("src/index.ts");
    expect(fieldGroup().textContent).toContain("3 files");
    expect(screen.queryByText(/changed file/)).toBeNull();
    await user.type(field(), "index");
    expect(rendered()).toEqual([
      "src/index.ts",
      "lib/index.ts",
      "docs/index.md",
    ]);
    await user.clear(field());
    await user.type(field(), "lib/");
    expect(rendered()).toEqual(["lib/index.ts"]);
    expect(fieldGroup().textContent).toContain("1 of 3");
  });

  it("S2: typing keeps the open file; Enter opens the first match", async () => {
    lists[SHA_A] = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const { user } = mount();
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    await act(() => Promise.resolve());
    expectShown("src/a.ts");
    await user.keyboard("{Enter}");
    await expectOpen("lib/c.ts");
    expect(row("lib/c.ts").getAttribute("aria-current")).toBe("true");
  });

  it("S3: ArrowDown moves into the list, and arrows walk the matches only", async () => {
    lists[SHA_A] = LONG;
    const { user } = mount();
    await expectOpen("src/file-00.ts");
    await user.type(field(), "5.ts");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "src/file-05.ts",
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "src/file-15.ts",
    );
    await expectOpen("src/file-15.ts");
  });

  it("S4: a picked file the filter hides keeps its diff", async () => {
    lists[SHA_A] = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const { user } = mount();
    await expectOpen("src/a.ts");
    await user.click(row("src/b.md"));
    await expectOpen("src/b.md");
    await user.type(field(), ".ts");
    expect(rendered()).toEqual(["src/a.ts", "lib/c.ts"]);
    expect(rail().querySelector("[aria-current]")).toBeNull();
    await act(() => Promise.resolve());
    expectShown("src/b.md");
  });

  it("S5: text persists stash to stash; the two views keep their own", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    // Typing pins a/x.ts, which stash B also carries after another match: only
    // the stash switch's pick reset lets B open its first match instead.
    lists[SHA_B] = ["c/one.md", "e/a-three.ts", "a/x.ts", "d/two.md"];
    lists[SHA_L] = ["lost/one.ts", "lost/two.md"];
    const { user } = mount();
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    await user.click(stashRow(SHA_B));
    // Stash B's own rows are narrowed by the carried text, and its first match opens.
    await expectOpen("e/a-three.ts", SHA_B);
    expect(field().value).toBe("a");
    expect(rendered()).toEqual(["e/a-three.ts", "a/x.ts"]);
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts", SHA_L);
    expect(field().value).toBe("");
    await user.type(field(), "b");
    await user.click(screen.getByRole("button", { name: "Stashes" }));
    await waitFor(() => expect(field().value).toBe("a"));
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await waitFor(() => expect(field().value).toBe("b"));
  });

  it("S6: a reopen starts both views' fields empty, from its first render", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    lists[SHA_L] = ["lost/one.ts", "lost/two.md"];
    const { user, setOpen } = mount();
    await expectOpen("a/x.ts");
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts", SHA_L);
    await user.type(field(), "b");
    await user.click(screen.getByRole("button", { name: "Stashes" }));
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    act(() => closeButton().click());
    // The close is running: both texts hold until it completes.
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(Object.values(stashTexts()).sort()).toEqual(["a", "b"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Cleared by the popup's unmount, before any reopen render can read it.
    expect(stashTexts()).toEqual({});
    // Every text the status ever holds after the reopen, overwritten ones
    // included: a stale filter would commit "Showing 1 of 2 files" first.
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.oldValue) seen.push(r.oldValue);
        for (const n of [...r.addedNodes, ...r.removedNodes])
          seen.push(n.textContent ?? "");
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    act(() => setOpen(true));
    // The files are cached, so the reopen's first commit already holds the rail.
    expect(field().value).toBe("");
    expect(rendered()).toEqual(["a/x.ts", "b/y.md"]);
    await expectOpen("a/x.ts");
    observer.disconnect();
    expect(seen.filter((t) => t.includes("Showing 1 of"))).toEqual([]);
    expect(field().value).toBe("");
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts", SHA_L);
    expect(field().value).toBe("");
  });

  it("S6b: a reopen before the close completes still starts both fields empty", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    lists[SHA_L] = ["lost/one.ts", "lost/two.md"];
    const { user, setOpen } = mount();
    await expectOpen("a/x.ts");
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts", SHA_L);
    await user.type(field(), "b");
    await user.click(screen.getByRole("button", { name: "Stashes" }));
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    // The reopen lands while the close is still running, so the close never
    // completes and onOpenChangeComplete(false) never clears the texts.
    act(() => closeButton().click());
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(Object.values(stashTexts()).sort()).toEqual(["a", "b"]);
    act(() => setOpen(true));
    await waitFor(() => expect(field().value).toBe(""));
    expect(rendered()).toEqual(["a/x.ts", "b/y.md"]);
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts", SHA_L);
    expect(field().value).toBe("");
  });

  it("S7: Escape in a field with text clears it and keeps the dialog open", async () => {
    lists[SHA_A] = ["src/a.ts", "lib/c.ts"];
    const { user, onOpenChange } = mount();
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    await user.keyboard("{Escape}");
    expect(field().value).toBe("");
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("S8: binary rows keep their stat under the filter", async () => {
    lists[SHA_A] = ["src/a.ts", "img/logo.png", "bin/tool"];
    shapes = {
      "img/logo.png": { isBinary: true, added: 0, deleted: 0 },
      "bin/tool": { isBinary: true, added: 0, deleted: 0, binaryKind: "mode" },
    };
    const { user } = mount();
    await expectOpen("src/a.ts");
    await user.type(field(), "o");
    expect(rendered()).toEqual(["img/logo.png", "bin/tool"]);
    expect(row("img/logo.png").textContent).toContain("bin");
    expect(row("bin/tool").textContent).toContain("mode");
  });

  it("S9: an untracked file keeps its ^3 side, filtered in or hidden", async () => {
    lists[SHA_A] = ["src/a.ts", "new/b.ts"];
    shapes = { "new/b.ts": { untracked: true } };
    const { user } = mount();
    await expectOpen("src/a.ts");
    await user.type(field(), "new");
    expect(rendered()).toEqual(["new/b.ts"]);
    await user.keyboard("{Enter}");
    await expectOpen("new/b.ts");
    const newRev = () =>
      document
        .querySelector('[data-open-file="new/b.ts"]')
        ?.getAttribute("data-new-rev");
    await waitFor(() => expect(newRev()).toBe(`${SHA_A}^3`));
    await user.clear(field());
    await user.type(field(), "src");
    expect(rendered()).toEqual(["src/a.ts"]);
    await act(() => Promise.resolve());
    expect(openFile()).toBe("new/b.ts");
    expect(newRev()).toBe(`${SHA_A}^3`);
  });

  it("S10: hiding and re-showing the panel with the dialog open keeps the text", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    const { user, setShown } = mount();
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    act(() => setShown(false));
    expect(Object.values(stashTexts())).toEqual(["a"]);
    act(() => setShown(true));
    await waitFor(() => expect(field().value).toBe("a"));
    expect(rendered()).toEqual(["a/x.ts"]);
  });

  it("S11: a second dialog opening and closing leaves the hidden one's text", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    const { user, setAShown, setBOpen } = mountPair();
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    act(() => setAShown(false));
    act(() => setBOpen(true));
    await waitFor(() => expect(rendered()).toEqual(["a/x.ts", "b/y.md"]));
    expect(field().value).toBe("");
    await user.type(field(), "y");
    expect(rendered()).toEqual(["b/y.md"]);
    act(() => setBOpen(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => setAShown(true));
    await waitFor(() => expect(field().value).toBe("a"));
    expect(rendered()).toEqual(["a/x.ts"]);
    expect(Object.values(stashTexts())).toEqual(["a"]);
  });

  it("S12: a switch to a cached stash keeps the one status node and updates its text", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    lists[SHA_B] = ["c/a-one.ts", "d/two.md", "e/a-three.ts"];
    const { user } = mount();
    await expectOpen("a/x.ts");
    await user.click(stashRow(SHA_B));
    await expectOpen("c/a-one.ts", SHA_B);
    await user.click(stashRow(SHA_A));
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    const node = status() as HTMLElement;
    await waitFor(() => expect(node.textContent).toBe("Showing 1 of 2 files"));
    await user.click(stashRow(SHA_B));
    await expectOpen("c/a-one.ts", SHA_B);
    expect(status()).toBe(node);
    expect(document.querySelectorAll("[data-file-filter-status]")).toHaveLength(
      1,
    );
    await waitFor(() => expect(node.textContent).toBe("Showing 2 of 3 files"));
  });

  it("S13: a switch to an uncached stash reads only that stash's own paths", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    lists[SHA_B] = ["c/one.md", "d/two.ts"];
    const { user } = mount();
    await expectOpen("a/x.ts");
    await user.click(stashRow(SHA_B));
    await expectOpen("c/one.md", SHA_B);
    const reads = vi
      .mocked(gitOrphanedStashFileDiff)
      .mock.calls.filter(([, sha]) => sha === SHA_B)
      .map(([, , path]) => path);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((p) => !lists[SHA_B].includes(p))).toEqual([]);
  });

  it("S16: a narrow row starts the rail collapsed; its caret expands it locally", async () => {
    pane.width = 400;
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    const { user } = mount();
    await expectOpen("a/x.ts");
    expect(
      screen.queryByRole("textbox", { name: "Filter changed files" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand file list" }));
    expect(rendered()).toEqual(["a/x.ts", "b/y.md"]);
    expect(field().value).toBe("");
    expect(
      screen.getByRole("button", { name: "Collapse file list" }),
    ).toBeTruthy();
    expect(saveSettingsMerged).not.toHaveBeenCalled();
  });

  it("S14: an emptied stash list and back keeps the one status node", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    const { user, client } = mount();
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    const node = status() as HTMLElement;
    await waitFor(() => expect(node.textContent).toBe("Showing 1 of 2 files"));
    vi.mocked(gitStashList).mockResolvedValue([]);
    await act(() => refetchList(client, "stashes"));
    await screen.findByText(/^No stashes./);
    expect(status()).toBe(node);
    expect(node.textContent).toBe("");
    vi.mocked(gitStashList).mockResolvedValue(stashes);
    await act(() => refetchList(client, "stashes"));
    await expectOpen("a/x.ts");
    expect(field().value).toBe("a");
    expect(status()).toBe(node);
    expect(document.querySelectorAll("[data-file-filter-status]")).toHaveLength(
      1,
    );
    await waitFor(() => expect(node.textContent).toBe("Showing 1 of 2 files"));
  });

  it("S15: a rescan that replaces the lost stash keeps the one status node", async () => {
    const SHA_M = "d1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
    lists[SHA_A] = ["a/x.ts"];
    lists[SHA_L] = ["lost/one.ts", "lost/two.md"];
    lists[SHA_M] = ["more/one.ts", "more/two.ts", "more/three.md"];
    vi.mocked(gitOrphanedStashes).mockResolvedValue([
      ...orphans,
      { sha: SHA_M, message: "lost two", date: "", fileCount: 3 },
    ]);
    const { user, client } = mount();
    await expectOpen("a/x.ts");
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts", SHA_L);
    // Stash M's files are cached before the rescan drops stash L.
    await user.click(
      document.querySelector(`[data-orphaned="${SHA_M}"]`) as HTMLElement,
    );
    await expectOpen("more/one.ts", SHA_M);
    await user.click(
      document.querySelector(`[data-orphaned="${SHA_L}"]`) as HTMLElement,
    );
    await expectOpen("lost/one.ts", SHA_L);
    await user.type(field(), ".ts");
    const node = status() as HTMLElement;
    await waitFor(() => expect(node.textContent).toBe("Showing 1 of 2 files"));
    let finishScan: () => void = () => undefined;
    vi.mocked(gitOrphanedStashes).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishScan = () =>
            resolve([
              { sha: SHA_M, message: "lost two", date: "", fileCount: 3 },
            ]);
        }),
    );
    let rescan: Promise<void> = Promise.resolve();
    act(() => {
      rescan = refetchList(client, "orphaned-stashes");
    });
    // The scan's box replaces the list, and with it the rail.
    await screen.findByText(/Scanning for lost stashes/);
    expect(screen.queryByRole("complementary", { name: "Changed files" })).toBe(
      null,
    );
    expect(status()).toBe(node);
    expect(node.textContent).toBe("");
    await act(async () => {
      finishScan();
      await rescan;
    });
    await expectOpen("more/one.ts", SHA_M);
    expect(status()).toBe(node);
    expect(document.querySelectorAll("[data-file-filter-status]")).toHaveLength(
      1,
    );
    await waitFor(() => expect(node.textContent).toBe("Showing 2 of 3 files"));
  });
});
