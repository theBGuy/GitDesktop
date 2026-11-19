import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FileFilterSurface,
  useFileFilterStore,
} from "@/components/use-file-list-filter";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  commitOnRemote,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitLog,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type {
  CommitDetails,
  DiffStatEntry,
  FileDiff,
  ForgeStatus,
  RepoStatus,
} from "@/lib/git/types";
import { useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  commitOnRemote: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  ghCommitAuthorAvatars: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
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
// The stand-in pane names the file it shows, and whether its read is enabled.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffSurface({
    filePath,
    diff,
  }: {
    filePath: string;
    diff?: { isEnabled: boolean };
  }) {
    useReportPaneSettled(true);
    return (
      <div data-open-file={filePath} data-read-enabled={diff?.isEnabled} />
    );
  }
  return { DiffSurface, DiffContent: DiffSurface };
});
// The real comments child, plus a jump that takes its file route.
const jump = vi.hoisted(() => ({ to: "" }));
vi.mock("@/features/pulls/CommitComments", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/pulls/CommitComments")>();
  function CommitComments(props: Parameters<typeof real.CommitComments>[0]) {
    return (
      <>
        <real.CommitComments {...props} />
        <button type="button" onClick={() => props.onSelectFile?.(jump.to)}>
          Jump from comment
        </button>
      </>
    );
  }
  return { ...real, CommitComments };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const A = "abcdef0123".repeat(4);
const B = `b${A.slice(1)}`;
const C = `c${A.slice(1)}`;
const ALL_ON = new Proxy({}, { get: () => true });

const details = (hash: string): CommitDetails => ({
  hash,
  subject: `subject ${hash.slice(0, 4)}`,
  body: "",
  author: "Ada",
  authorEmail: "ada@example.com",
  date: "2026-11-01T10:00:00Z",
  committerDate: "2026-11-01T10:00:00Z",
});
const entry = (path: string): DiffStatEntry => ({
  path,
  added: 1,
  deleted: 1,
  isBinary: false,
  binaryKind: null,
});
const LONG = Array.from(
  { length: 42 },
  (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`,
);

/** The files each commit serves; a missing commit never settles. */
let lists: Record<string, string[] | Promise<string[]>> = {};

function Listener() {
  useHotkeysListener();
  return null;
}

function renderView(hash: string, surface?: FileFilterSurface) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (h: string, s?: FileFilterSurface) => (
    <QueryClientProvider client={client}>
      <Listener />
      <CommitDetailView repoPath={REPO} hash={h} filterSurface={s} />
    </QueryClientProvider>
  );
  const utils = render(view(hash, surface));
  return {
    ...utils,
    switchTo: (h: string, s: FileFilterSurface | undefined = surface) =>
      utils.rerender(view(h, s)),
    refetch: () => act(() => client.refetchQueries()),
  };
}

const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });
const fieldGroup = () =>
  field().closest('[data-slot="input-group"]') as HTMLElement;
const rail = () => screen.getByRole("complementary");
const rendered = () =>
  Array.from(
    rail().querySelectorAll<HTMLElement>("[data-path]"),
    (el) => el.dataset.path,
  );
const openFile = () =>
  Array.from(document.querySelectorAll("[data-open-file]"))
    .find((el) => el.closest("[inert]") === null)
    ?.getAttribute("data-open-file");
const openPane = () =>
  Array.from(document.querySelectorAll("[data-open-file]")).find(
    (el) => el.closest("[inert]") === null,
  );
const status = () =>
  document.querySelector<HTMLElement>("[data-file-filter-status]");
const expectOpen = (path: string) =>
  waitFor(() => expect(openFile()).toBe(path));

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
  useFileFilterStore.setState({ texts: {} });
  lists = {};
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "github.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue("");
  vi.mocked(forgeCommitComments).mockResolvedValue([]);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  vi.mocked(gitLog).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: null,
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) =>
    details(hash),
  );
  vi.mocked(gitCommitFiles).mockImplementation(async (_r, hash) => {
    const served = await lists[hash];
    if (served === undefined) return new Promise(() => undefined);
    return served.map(entry);
  });
  vi.mocked(gitCommitFileDiff).mockImplementation(
    async (_r, _h, path) =>
      ({
        filePath: path,
        isBinary: false,
        isTruncated: false,
        text: `diff --git a/${path} b/${path}\n`,
      }) as FileDiff,
  );
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("CommitDetailView file filter", () => {
  it("C-a C-f: the count lives in the field; typing filters the rows and keeps the pane", async () => {
    lists[A] = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const user = userEvent.setup();
    renderView(A);
    await expectOpen("src/a.ts");
    expect(fieldGroup().textContent).toContain("3 files");
    expect(screen.queryByText(/changed file/)).toBeNull();
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    expect(fieldGroup().textContent).toContain("1 of 3");
    await act(() => Promise.resolve());
    expect(openFile()).toBe("src/a.ts");
    expect(rail().querySelector("[aria-current]")).toBeNull();
  });

  it("C-b: list arrows walk the matches only", async () => {
    lists[A] = LONG;
    const user = userEvent.setup();
    renderView(A);
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

  it("C-c C-h: a commit switch's placeholder window changes nothing; the settled list opens its first match", async () => {
    lists[A] = ["a/x.ts", "b/y.ts", "c/z.md"];
    let land: (paths: string[]) => void = () => undefined;
    lists[B] = new Promise((r) => {
      land = r;
    });
    const user = userEvent.setup();
    const { switchTo } = renderView(A);
    await expectOpen("a/x.ts");
    await user.type(field(), "t");
    expect(status()?.textContent).toBe("Showing 2 of 3 files");
    switchTo(B);
    await act(() => Promise.resolve());
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(status()?.closest('[aria-busy="true"]')).toBeNull();
    await user.type(field(), "y");
    expect(rendered()).toEqual([]);
    expect(status()?.textContent).toBe("Showing 2 of 3 files");
    expect(openFile()).toBe("a/x.ts");
    await act(async () => land(["d/one.ts", "e/two.md", "f/ty.ts"]));
    await expectOpen("f/ty.ts");
    expect(status()?.textContent).toBe("Showing 1 of 3 files");
    lists[C] = ["g/a.md", "h/b.md"];
    switchTo(C);
    await expectOpen("g/a.md");
    expect(rendered()).toEqual([]);
  });

  it("the status stays empty over the skeleton until the details land", async () => {
    useFileFilterStore.setState({ texts: { history: "t" } });
    lists[A] = ["a/x.ts", "b/y.ts", "c/z.md"];
    let land: (d: CommitDetails) => void = () => undefined;
    vi.mocked(gitCommitDetails).mockImplementation(
      () =>
        new Promise((r) => {
          land = r;
        }),
    );
    renderView(A);
    await waitFor(() => expect(vi.mocked(gitCommitFiles)).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(status()?.textContent).toBe("");
    await act(async () => land(details(A)));
    await expectOpen("a/x.ts");
    expect(status()?.textContent).toBe("Showing 2 of 3 files");
  });

  it("the status stays empty under the error when the details fail", async () => {
    useFileFilterStore.setState({ texts: { history: "t" } });
    lists[A] = ["a/x.ts", "b/y.ts", "c/z.md"];
    let fail: (e: unknown) => void = () => undefined;
    vi.mocked(gitCommitDetails).mockImplementation(
      () =>
        new Promise((_r, reject) => {
          fail = reject;
        }),
    );
    renderView(A);
    await waitFor(() => expect(vi.mocked(gitCommitFiles)).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(status()?.textContent).toBe("");
    await act(async () => fail({ kind: "git", message: "boom" }));
    await screen.findByText("Could not load this commit");
    expect(status()?.textContent).toBe("");
  });

  it("the status empties when the next commit's files fail to load", async () => {
    lists[A] = ["a/x.ts", "b/y.ts", "c/z.md"];
    const failed = Promise.reject({ kind: "git", message: "boom" });
    failed.catch(() => undefined);
    lists[B] = failed;
    const user = userEvent.setup();
    const { switchTo } = renderView(A);
    await expectOpen("a/x.ts");
    await user.type(field(), "t");
    expect(status()?.textContent).toBe("Showing 2 of 3 files");
    switchTo(B);
    await screen.findByText("Could not load this commit");
    expect(status()?.textContent).toBe("");
  });

  it("an ordinary commit switch never passes the status through empty", async () => {
    lists[A] = ["a/x.ts", "b/y.ts", "c/z.md"];
    lists[B] = ["d/one.ts", "e/x.md", "f/z.md"];
    const user = userEvent.setup();
    const { switchTo } = renderView(A);
    await expectOpen("a/x.ts");
    await user.type(field(), "t");
    const el = status() as HTMLElement;
    expect(el.textContent).toBe("Showing 2 of 3 files");
    const seen: string[] = [];
    const observer = new MutationObserver(() =>
      seen.push(el.textContent ?? ""),
    );
    observer.observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    switchTo(B);
    await expectOpen("d/one.ts");
    await waitFor(() => expect(el.textContent).toBe("Showing 1 of 3 files"));
    observer.disconnect();
    expect(seen).not.toContain("");
    expect(seen.at(-1)).toBe("Showing 1 of 3 files");
  });

  it("C-i: only the compare surface claims Mod+F tab-wide; surfaces keep separate text", async () => {
    lists[A] = ["src/a.ts", "src/b.md"];
    const user = userEvent.setup();
    const { switchTo } = renderView(A);
    await expectOpen("src/a.ts");
    await user.type(field(), "b.md");
    await act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(document.body);
    switchTo(A, "compare");
    await waitFor(() => expect(field().value).toBe(""));
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(field());
    expect(useFileFilterStore.getState().texts).toEqual({ history: "b.md" });
  });

  it("C-k: an untouched list follows a new first file; a typed filter pins the open file", async () => {
    lists[A] = ["b.ts", "c.ts"];
    const user = userEvent.setup();
    const { refetch } = renderView(A);
    await expectOpen("b.ts");
    lists[A] = ["a.ts", "b.ts", "c.ts"];
    await refetch();
    await expectOpen("a.ts");
    await user.type(field(), "c");
    expect(rendered()).toEqual(["c.ts"]);
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
    lists[A] = ["0.ts", "a.ts", "c.ts"];
    await refetch();
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
  });

  it("a comment's jump opens a file the filter hides, against the full list", async () => {
    lists[A] = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const info = vi.spyOn(toast, "info");
    const user = userEvent.setup();
    renderView(A);
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    jump.to = "src/b.md";
    await user.click(screen.getByRole("button", { name: "Jump from comment" }));
    await expectOpen("src/b.md");
    expect(info).not.toHaveBeenCalled();
    expect(rendered()).toEqual(["lib/c.ts"]);
    expect(rail().querySelector("[aria-current]")).toBeNull();
    info.mockRestore();
  });

  it("the open file's read stays enabled while the filter hides its row", async () => {
    lists[A] = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const user = userEvent.setup();
    renderView(A);
    await expectOpen("src/a.ts");
    await waitFor(() =>
      expect(openPane()?.getAttribute("data-read-enabled")).toBe("true"),
    );
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    await act(() => Promise.resolve());
    expect(openFile()).toBe("src/a.ts");
    expect(openPane()?.getAttribute("data-read-enabled")).toBe("true");
  });
});
