import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { SHOW_WHITESPACE_LABEL } from "@/features/diff/whitespace-mode";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { drawnDiffFor } from "@/features/history/drawn-diff";
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
  CommitCommentOut,
  CommitDetails,
  DiffStatEntry,
  FileDiff,
  ForgeStatus,
  RepoStatus,
} from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
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
  saveSettingsPatch: vi.fn(),
}));

/** False holds every pane's anchors back, as a diff still building would. */
const drawGate = vi.hoisted(() => ({
  open: true,
  listeners: new Set<() => void>(),
}));
/** Opens or closes the gate and re-renders every pane. */
const setGate = (open: boolean) =>
  act(() => {
    drawGate.open = open;
    for (const l of drawGate.listeners) l();
  });
// The pane stands in for DiffSurface: it draws exactly the anchors whose line
// its own text has on the new side.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  const { useSyncExternalStore } = await import("react");
  const subscribe = (l: () => void) => {
    drawGate.listeners.add(l);
    return () => drawGate.listeners.delete(l);
  };
  function drawnLines(text: string): Set<number> {
    const out = new Set<number>();
    let next = 0;
    let inHunk = false;
    for (const l of text.split("\n")) {
      const m = /^@@ -\S+ \+(\d+)/.exec(l);
      if (m) {
        next = Number(m[1]);
        inHunk = true;
      } else if (inHunk && (l.startsWith(" ") || l.startsWith("+"))) {
        out.add(next);
        next++;
      }
    }
    return out;
  }
  function DiffSurface({
    diff,
    lineAnchors,
  }: {
    diff: { data?: FileDiff; isPlaceholderData: boolean };
    lineAnchors?: DiffLineAnchor[];
  }) {
    useReportPaneSettled(diff.data !== undefined && !diff.isPlaceholderData);
    const open = useSyncExternalStore(subscribe, () => drawGate.open);
    if (diff.data === undefined || !open) return null;
    const lines = drawnLines(diff.data.text);
    return (
      <div data-testid="inline-anchors">
        {lineAnchors
          ?.filter((a) => lines.has(a.line))
          .map((a) => (
            <div key={`${a.side}:${a.line}`}>{a.render()}</div>
          ))}
      </div>
    );
  }
  return { DiffSurface, DiffContent: () => null };
});

const REPO = "/repo";
const A = "abcdef0123".repeat(4);
const B = `b${A.slice(1)}`;
const pending = <T,>() => new Promise<T>(() => undefined);

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const details = (hash: string): CommitDetails => ({
  hash,
  subject: `subject ${hash.slice(0, 4)}`,
  body: "",
  author: "Ada",
  authorEmail: "ada@example.com",
  date: "2026-11-01T10:00:00Z",
  committerDate: "2026-11-01T10:00:00Z",
});
const row = (path: string): DiffStatEntry => ({
  path,
  added: 1,
  deleted: 1,
  isBinary: false,
  binaryKind: null,
});

const header = (p: string) =>
  `diff --git a/${p} b/${p}\nindex 1111aaa..2222bbb 100644\n--- a/${p}\n+++ b/${p}\n`;
/** Lines 1-3 with line 2 re-indented, then a real change at 19-21. */
const PLAIN_X = `${header("x")}@@ -1,3 +1,3 @@\n a\n-b\n+  b\n c\n@@ -19,3 +19,3 @@\n s\n-t\n+T\n u\n`;
const HIDDEN_X = `${header("x")}@@ -19,3 +19,3 @@\n s\n-t\n+T\n u\n`;
const diff = (path: string, text: string): FileDiff => ({
  filePath: path,
  isBinary: false,
  isTruncated: false,
  text,
});

const comment = (id: string, path: string, line: number): CommitCommentOut => ({
  id,
  author: "octo",
  body: `note ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  viewerDidAuthor: false,
  path,
  line,
  startLine: null,
  position: null,
});
const WHOLE: CommitCommentOut = {
  ...comment("whole", "x", 1),
  path: null,
  line: null,
};
const ALL_ON = new Proxy({}, { get: () => true });

let stored: AppSettings = DEFAULT_SETTINGS;

beforeEach(() => {
  unmockedCommands.length = 0;
  drawGate.open = true;
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () => stored);
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "gitlab",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "gitlab.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue("");
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  vi.mocked(gitLog).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: null,
    entries: [],
  } as unknown as RepoStatus);
});

afterEach(() => {
  // Unmount on the fake clock: setup.ts's cleanup runs after this hook, and the
  // last query observer leaving would arm a real gc timer that outlives the case.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(unmockedCommands).toEqual([]);
});

/** One commit A whose files answer by whitespace mode (`[plain, -w]`). */
function serveA(
  texts: Record<string, [string, string]>,
  comments: CommitCommentOut[],
) {
  vi.mocked(gitCommitDetails).mockImplementation(async () => details(A));
  vi.mocked(gitCommitFiles).mockImplementation(async () =>
    Object.keys(texts).map(row),
  );
  vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, path, iw) =>
    diff(path, texts[path][iw ? 1 : 0]),
  );
  vi.mocked(forgeCommitComments).mockImplementation(async () => [
    ...comments,
    WHOLE,
  ]);
}

function renderView(hash: string, hide: boolean) {
  stored = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, stored);
  const view = (h: string) => (
    <QueryClientProvider client={client}>
      <CommitDetailView repoPath={REPO} hash={h} />
    </QueryClientProvider>
  );
  const result = render(view(hash));
  const setHide = (next: boolean) =>
    act(() => {
      client.setQueryData(settingsKeys.settings, {
        ...stored,
        diffHideWhitespace: next,
      });
    });
  return {
    ...result,
    setHide,
    switchTo: (h: string) => result.rerender(view(h)),
  };
}

const settle = () => act(() => Promise.resolve());
/** Lets react-query's batched notifications (a macrotask) and the renders and
 *  effects they start land, so each mode flip is seen before the next. */
const flushNotify = async () => {
  for (let i = 0; i < 3; i++)
    await act(() => new Promise((r) => setTimeout(r, 0)));
};
const showButtons = () =>
  screen.queryAllByRole("button", { name: SHOW_WHITESPACE_LABEL });
const sink = () => screen.getByRole("group", { name: "Commit comments" });

/** jsdom measures the rail at zero width; expand it, then find the file's row. */
function railRow(path: string) {
  const expand = screen.queryByRole("button", { name: "Expand file list" });
  if (expand) fireEvent.click(expand);
  const found = screen
    .getAllByRole("button")
    .find(
      (b) => b.textContent?.startsWith(path) && /added/.test(b.textContent),
    );
  if (!found) throw new Error(`no rail row for ${path}`);
  return found;
}

/** Records whether either note ever rendered, a one-frame row included. */
function watchNotes(container: HTMLElement) {
  const seen = { flashed: false };
  const check = () => {
    if (
      /couldn't place in this diff|hidden by Hide whitespace/.test(
        container.textContent ?? "",
      )
    )
      seen.flashed = true;
  };
  const observer = new MutationObserver(check);
  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return {
    seen,
    stop: () => {
      check();
      observer.disconnect();
    },
  };
}

const Y_TEXT = `${header("y")}@@ -1 +1 @@\n-p\n+q\n`;

describe("CommitDetailView lists comments its diff hides", () => {
  it("shows the whitespace row, flips the mode, and lands on the thread", async () => {
    serveA({ x: [PLAIN_X, HIDDEN_X] }, [comment("c2", "x", 2)]);
    renderView(A, true);
    await waitFor(() => expect(showButtons()).toHaveLength(1));
    expect(
      screen.getByText(/on a line hidden by Hide whitespace/),
    ).toBeTruthy();
    fireEvent.click(showButtons()[0]);
    await waitFor(() =>
      expect(saveSettingsPatch).toHaveBeenCalledWith({
        diffHideWhitespace: false,
      }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("group", { name: "Comments on line 2" }),
      ),
    );
    expect(showButtons()).toHaveLength(0);
    expect(screen.queryByText(/hidden by Hide whitespace/)).toBeNull();
  });

  it("removes every whitespace row with one press, and keeps focus on the list while nothing draws", async () => {
    serveA({ x: [PLAIN_X, HIDDEN_X] }, [
      comment("c1", "x", 1),
      comment("c2", "x", 2),
    ]);
    renderView(A, true);
    await waitFor(() => expect(showButtons()).toHaveLength(2));
    drawGate.open = false;
    fireEvent.click(showButtons()[1]);
    await waitFor(() => expect(showButtons()).toHaveLength(0));
    expect(document.activeElement).toBe(sink());
  });

  it("drops the landing when the file changes before the thread draws", async () => {
    serveA(
      {
        x: [PLAIN_X, HIDDEN_X],
        y: [Y_TEXT, Y_TEXT],
      },
      [comment("c2", "x", 2)],
    );
    renderView(A, true);
    await waitFor(() => expect(showButtons()).toHaveLength(1));
    drawGate.open = false;
    fireEvent.click(showButtons()[0]);
    await settle();
    fireEvent.click(railRow("y"));
    await settle();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "x:2" })).toBeTruthy(),
    );
    // A fired click moves no focus, so the list still holds it when x returns.
    expect(document.activeElement).toBe(sink());
    drawGate.open = true;
    fireEvent.click(railRow("x"));
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Comments on line 2" }),
      ).toBeTruthy(),
    );
    await settle();
    expect(document.activeElement).toBe(sink());
  });

  it("never flashes a note across a commit switch's placeholder windows (AC4g)", async () => {
    const PLAIN_A = `${header("x")}@@ -5,3 +5,3 @@\n e\n-f\n+F\n g\n`;
    const PLAIN_B = `${header("x")}@@ -1 +1 @@\n-p\n+q\n`;
    const bDetails = deferred<CommitDetails>();
    const bFiles = deferred<DiffStatEntry[]>();
    const bDiff = deferred<FileDiff>();
    vi.mocked(gitCommitDetails).mockImplementation((_r, h) =>
      h === A ? Promise.resolve(details(A)) : bDetails.promise,
    );
    vi.mocked(gitCommitFiles).mockImplementation((_r, h) =>
      h === A ? Promise.resolve([row("x")]) : bFiles.promise,
    );
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, h, path) =>
      h === A ? Promise.resolve(diff(path, PLAIN_A)) : bDiff.promise,
    );
    vi.mocked(forgeCommitComments).mockImplementation((_r, sha) =>
      sha === A ? Promise.resolve([comment("c7", "x", 7), WHOLE]) : pending(),
    );
    const { container, switchTo } = renderView(A, true);
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Comments on line 7" }),
      ).toBeTruthy(),
    );
    const watch = watchNotes(container);
    switchTo(B);
    await settle();
    await act(async () => bDetails.resolve(details(B)));
    await settle();
    await act(async () => bFiles.resolve([row("x")]));
    await settle();
    await act(async () => bDiff.resolve(diff("x", PLAIN_B)));
    await settle();
    watch.stop();
    expect(watch.seen.flashed).toBe(false);
  });

  it("never judges a file's comments by the previous file's lines (AC4g)", async () => {
    const yDiff = deferred<FileDiff>();
    vi.mocked(gitCommitDetails).mockImplementation(async () => details(A));
    vi.mocked(gitCommitFiles).mockImplementation(async () => [
      row("x"),
      row("y"),
    ]);
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, _h, path) =>
      path === "x"
        ? Promise.resolve(diff("x", `${header("x")}@@ -1 +1 @@\n-p\n+q\n`))
        : yDiff.promise,
    );
    vi.mocked(forgeCommitComments).mockImplementation(async () => [
      comment("c3", "y", 3),
      WHOLE,
    ]);
    const { container } = renderView(A, false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "y:3" })).toBeTruthy(),
    );
    const watch = watchNotes(container);
    fireEvent.click(railRow("y"));
    await settle();
    await settle();
    await act(async () =>
      yDiff.resolve(
        diff("y", `${header("y")}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Comments on line 3" }),
      ).toBeTruthy(),
    );
    watch.stop();
    expect(watch.seen.flashed).toBe(false);
  });
});

describe("CommitDetailView's Show whitespace focus", () => {
  it("leaves focus on the body when Hide whitespace turns on or off by another route", async () => {
    serveA({ x: [PLAIN_X, HIDDEN_X] }, [comment("c2", "x", 2)]);
    const { setHide } = renderView(A, false);
    await waitFor(() => expect(screen.getByText("note whole")).toBeTruthy());
    await settle();
    // The view lands its own load on its host; start from the body.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await setHide(true);
    await waitFor(() => expect(showButtons()).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);
    await setHide(false);
    await waitFor(() => expect(showButtons()).toHaveLength(0));
    expect(document.activeElement).toBe(document.body);
  });

  it("drops the landing when the mode flips back before the thread draws", async () => {
    serveA({ x: [PLAIN_X, HIDDEN_X] }, [comment("c2", "x", 2)]);
    const { setHide } = renderView(A, true);
    await waitFor(() => expect(showButtons()).toHaveLength(1));
    await setGate(false);
    fireEvent.click(showButtons()[0]);
    await waitFor(() => expect(showButtons()).toHaveLength(0));
    await flushNotify();
    await setHide(true);
    await waitFor(() => expect(showButtons()).toHaveLength(1));
    await flushNotify();
    await setGate(true);
    await setHide(false);
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Comments on line 2" }),
      ).toBeTruthy(),
    );
    await settle();
    expect(document.activeElement).toBe(sink());
  });

  it("drops the landing once its wait runs out", async () => {
    serveA({ x: [PLAIN_X, HIDDEN_X] }, [comment("c2", "x", 2)]);
    renderView(A, true);
    await waitFor(() => expect(showButtons()).toHaveLength(1));
    await setGate(false);
    // The press arms the landing's bound as a timeout and a performance.now()
    // deadline; the clock goes fake only now so the initial load runs on real
    // timers. waitFor moves it via the stub.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
    fireEvent.click(showButtons()[0]);
    await waitFor(() => expect(showButtons()).toHaveLength(0));
    // Past LANDING_TIMEOUT_MS (2000 ms).
    await act(() => vi.advanceTimersByTimeAsync(2200));
    await setGate(true);
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Comments on line 2" }),
      ).toBeTruthy(),
    );
    await settle();
    expect(document.activeElement).toBe(sink());
  });
});

describe("drawnDiffFor", () => {
  const xDiff = diff("x", PLAIN_X);
  const yDiff = diff("y", Y_TEXT);

  it("takes a settled read of the listed path for the rendered commit", () => {
    const shownDiff = { data: xDiff, isPlaceholderData: false };
    expect(
      drawnDiffFor({
        selectedPathProp: "x",
        shownDiff,
        hash: A,
        renderedHash: A,
        retainedDiff: null,
      }),
    ).toBe(xDiff);
    expect(
      drawnDiffFor({
        selectedPathProp: "y",
        shownDiff,
        hash: A,
        renderedHash: A,
        retainedDiff: null,
      }),
    ).toBeNull();
  });

  it("never lets the previous file's placeholder judge the selected file", () => {
    expect(
      drawnDiffFor({
        selectedPathProp: "y",
        shownDiff: { data: xDiff, isPlaceholderData: true },
        hash: A,
        renderedHash: A,
        retainedDiff: { hash: A, path: "x", data: xDiff },
      }),
    ).toBeNull();
  });

  it("serves the retained read through a commit switch only for its own commit and path", () => {
    const shownDiff = { data: yDiff, isPlaceholderData: true };
    const retainedDiff = { hash: A, path: "y", data: yDiff };
    expect(
      drawnDiffFor({
        selectedPathProp: "y",
        shownDiff,
        hash: B,
        renderedHash: A,
        retainedDiff,
      }),
    ).toBe(yDiff);
    expect(
      drawnDiffFor({
        selectedPathProp: "y",
        shownDiff,
        hash: B,
        renderedHash: B,
        retainedDiff,
      }),
    ).toBeNull();
  });
});
