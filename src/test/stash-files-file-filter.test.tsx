import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// A wide row, so the rail is expanded and its field rendered.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
// The stand-in pane names the file it shows in an attribute.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffContent({
    filePath,
    contentRevs,
  }: {
    filePath: string;
    contentRevs?: { oldRev: string; newRev: string };
  }) {
    useReportPaneSettled(true);
    return <div data-open-file={filePath} data-new-rev={contentRevs?.newRev} />;
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
  const onOpenChange = vi.fn();
  let open = true;
  let shown = true;
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
  return {
    user: userEvent.setup(),
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
const openFile = () =>
  Array.from(document.querySelectorAll("[data-open-file]"))
    .find((el) => el.closest("[inert]") === null)
    ?.getAttribute("data-open-file");
const expectOpen = (path: string) =>
  waitFor(() => expect(openFile()).toBe(path));
const stashRow = (sha: string) =>
  document.querySelector(`[data-stash^="${sha}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
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
    async (_r, _sha, filePath) => ({
      filePath,
      isBinary: false,
      isTruncated: false,
      text: "",
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
    expect(openFile()).toBe("src/a.ts");
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
    // Long enough for a deferred path to land if it were going to move.
    await new Promise((r) => setTimeout(r, 50));
    await act(() => Promise.resolve());
    expect(openFile()).toBe("src/b.md");
  });

  it("S5: text persists stash to stash; the two views keep their own", async () => {
    lists[SHA_A] = ["a/x.ts", "b/y.md"];
    lists[SHA_B] = ["c/one.md", "d/two.ts", "e/a-three.ts"];
    lists[SHA_L] = ["lost/one.ts", "lost/two.md"];
    const { user } = mount();
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    await user.click(stashRow(SHA_B));
    // Stash B's own rows are narrowed by the carried text, and its first match opens.
    await expectOpen("e/a-three.ts");
    expect(field().value).toBe("a");
    expect(rendered()).toEqual(["e/a-three.ts"]);
    await user.click(screen.getByRole("button", { name: "Recoverable" }));
    await expectOpen("lost/one.ts");
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
    await expectOpen("lost/one.ts");
    await user.type(field(), "b");
    await user.click(screen.getByRole("button", { name: "Stashes" }));
    await expectOpen("a/x.ts");
    await user.type(field(), "a");
    setOpen(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Cleared by the popup's unmount, before any reopen render can read it.
    expect(useFileFilterStore.getState().texts).toMatchObject({
      stash: "",
      "stash-recoverable": "",
    });
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
    await expectOpen("lost/one.ts");
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
    expect(useFileFilterStore.getState().texts.stash).toBe("a");
    act(() => setShown(true));
    await waitFor(() => expect(field().value).toBe("a"));
    expect(rendered()).toEqual(["a/x.ts"]);
  });
});
