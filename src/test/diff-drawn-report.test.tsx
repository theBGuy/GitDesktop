import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useLayoutEffect } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DiffContent, type DiffLineAnchor } from "@/features/diff/DiffSurface";
import {
  FileSlots,
  keyedPaneView,
  useFileSlots,
  usePaintedView,
} from "@/features/diff/file-slot";
import type { PaintedView } from "@/features/diff/painted-view";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  commitOnRemote,
  decodeBase64Utf8,
  type FileBytes,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitFileBase64,
  gitLog,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { typechangeHalves } from "@/lib/git/diff-split";
import type { FileDiff, ForgeStatus, RepoStatus } from "@/lib/git/types";
import { type AppSettings, loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { bodies, renderBody } from "./anchor-bodies";
import { stubCanvas } from "./canvas-stub";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git/api")>();
  return {
    ...actual,
    // Spied through to the real decoder: the size gate must skip the call.
    decodeBase64Utf8: vi.fn(actual.decodeBase64Utf8),
    commitOnRemote: vi.fn(),
    forgeCommitComments: vi.fn(),
    forgeCommitDiff: vi.fn(),
    forgeStatus: vi.fn(),
    ghCommitAuthorAvatars: vi.fn(),
    gitCommitDetails: vi.fn(),
    gitCommitFileDiff: vi.fn(),
    gitCommitFiles: vi.fn(),
    gitFileBase64: vi.fn(),
    gitLog: vi.fn(),
    gitStatus: vi.fn(),
    readRepoBranchRules: vi.fn(),
  };
});
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView = vi.fn();

let settings: AppSettings = DEFAULT_SETTINGS;
beforeAll(stubCanvas);
beforeEach(() => {
  unmockedCommands.length = 0;
  settings = DEFAULT_SETTINGS;
  vi.mocked(loadSettings).mockImplementation(async () => settings);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  expect(unmockedCommands).toEqual([]);
});

const COMMIT = "abcdef0123".repeat(4);
const header = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1111aaa..2222bbb 100644\n--- a/${path}\n+++ b/${path}\n`;
const SHORT = `${header("n.txt")}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
const SHORT_NEXT = `${header("n.txt")}@@ -1,3 +1,3 @@\n a\n-b\n+BB\n c\n`;
const ADDED = (path: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
// Past the pane's 200-line cap: a hunk-only diff draws its first lines.
const LINES_300 = Array.from({ length: 300 }, (_, i) => `+l${i + 1}\n`).join(
  "",
);
const LONG = `${ADDED("n.txt")}@@ -0,0 +1,300 @@\n${LINES_300}`;
const MEGA = `${ADDED("n.txt")}@@ -0,0 +1,2 @@\n+${"x".repeat(20_001)}\n+short\n`;
const MD = `${header("n.md")}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
// A file-to-symlink typechange: a binary half removed, then a long text half.
const TYPECHANGE =
  "diff --git a/x b/x\ndeleted file mode 100644\nindex 4444ddd..0000000\n" +
  "Binary files a/x and /dev/null differ\n" +
  "diff --git a/x b/x\nnew file mode 120000\nindex 0000000..3333ccc\n" +
  `--- /dev/null\n+++ b/x\n@@ -0,0 +1,300 @@\n${LINES_300}`;

const diff = (
  filePath: string,
  text: string,
  extra: Partial<FileDiff> = {},
): FileDiff => ({
  filePath,
  text,
  isBinary: false,
  isTruncated: false,
  ...extra,
});
const bytes = (s: string): FileBytes => ({
  base64: btoa(s),
  mime: null,
  tooLarge: false,
  size: s.length,
});
/** A button of the diff pane's Raw/Preview toggle. */
const mdToggle = (name: "Raw" | "Preview") =>
  within(screen.getByRole("group", { name: "Markdown view" })).getByRole(
    "button",
    { name },
  );
const newLine = (n: number) =>
  document.querySelector(`span[data-line-new-num="${n}"]`);

type PaneProps = Partial<ComponentProps<typeof DiffContent>>;

/** An anchor whose row shows its own report key. */
const anchor = (line: number): DiffLineAnchor =>
  bodies([
    {
      side: "new",
      line,
      render: () => <span>{`new:${line}`}</span>,
    },
  ])[0];

/** A real DiffContent in a file slot; `last` is the slot's newest painted
 *  report, as its host reads it. */
function renderPane(props: PaneProps) {
  let latest: PaintedView | null = null;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  function Host({ p }: { p: PaneProps }) {
    const target = keyedPaneView("/repo", "commit-1", "n", "n");
    const slots = useFileSlots(target);
    const painted = usePaintedView(slots);
    useLayoutEffect(() => {
      latest = painted;
    });
    return (
      <FileSlots slots={slots} target={target}>
        {() => (
          <DiffContent
            filePath="n.txt"
            data={undefined}
            isPending={false}
            isError={false}
            renderAnchor={renderBody}
            {...p}
          />
        )}
      </FileSlots>
    );
  }
  const ui = (p: PaneProps) => (
    <QueryClientProvider client={client}>
      <Host p={p} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return {
    client,
    rerender: (p: PaneProps) => view.rerender(ui(p)),
    last: () => latest,
  };
}

describe("the pane's painted report, arm by arm", () => {
  it("reports a whole drawn diff whole", async () => {
    const pane = renderPane({ data: diff("n.txt", SHORT) });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: SHORT, cut: null }),
    );
  });

  it("draws no row and reports no anchor for a kept placement whose items the host dropped", async () => {
    const placed = { side: "new" as const, line: 2, items: ["T1"] };
    const live = (items: string[]) => (a: DiffLineAnchor) =>
      a.items.some((k) => items.includes(k)) ? <span>Thread T1</span> : null;
    const pane = renderPane({
      data: diff("n.txt", SHORT),
      lineAnchors: [placed],
      renderAnchor: live(["T1"]),
    });
    await waitFor(() => expect(pane.last()?.anchors).toEqual(["new:2"]));
    expect(document.querySelector("[data-diff-anchor]")).not.toBeNull();
    // The same placement, as a held row keeps it; the host no longer lists T1.
    pane.rerender({
      data: diff("n.txt", SHORT),
      lineAnchors: [{ ...placed }],
      renderAnchor: live([]),
    });
    await waitFor(() => expect(pane.last()?.anchors).toEqual([]));
    expect(document.querySelector("[data-diff-anchor]")).toBeNull();
    expect(screen.queryByText("Thread T1")).toBeNull();
  });

  it("reports the capped part until Show full diff draws the rest", async () => {
    const pane = renderPane({
      data: diff("n.txt", LONG),
      lineAnchors: [anchor(1), anchor(250)],
    });
    await waitFor(() => expect(pane.last()?.cut).toBe("cap"));
    expect(pane.last()?.patch).toBe(LONG);
    await waitFor(() => expect(pane.last()?.anchors).toEqual(["new:1"]));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show full diff" }));
    await waitFor(() =>
      expect(pane.last()).toMatchObject({
        patch: LONG,
        cut: null,
        anchors: ["new:1", "new:250"],
      }),
    );
  });

  it("reports nothing drawn under the mega-line placeholder", async () => {
    const pane = renderPane({
      data: diff("n.txt", MEGA),
      lineAnchors: [anchor(2)],
    });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({
        patch: MEGA,
        cut: "mega-line",
        anchors: [],
      }),
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show diff anyway" }));
    await waitFor(() =>
      expect(pane.last()).toMatchObject({
        patch: MEGA,
        cut: null,
        anchors: ["new:2"],
      }),
    );
  });

  it("reports nothing drawn while Markdown Preview is up, and the rows again on Raw", async () => {
    vi.mocked(gitFileBase64).mockResolvedValue(bytes("a\nB\nc\n"));
    const pane = renderPane({
      filePath: "n.md",
      data: diff("n.md", MD),
      repoPath: "/repo",
      previewRev: "B",
    });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: MD, cut: null }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: MD, cut: "preview" }),
    );
    await user.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: MD, cut: null }),
    );
  });

  it("reports nothing drawn for the binary, whitespace-only and loading arms", async () => {
    const bin =
      "diff --git a/n.bin b/n.bin\nBinary files a/n.bin and b/n.bin differ\n";
    const first = renderPane({
      filePath: "n.bin",
      data: diff("n.bin", bin, { isBinary: true }),
    });
    await waitFor(() =>
      expect(first.last()).toMatchObject({
        patch: bin,
        cut: null,
        anchors: [],
      }),
    );
    cleanup();
    settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: true };
    const wsOnly = header("n.txt");
    const second = renderPane({
      data: diff("n.txt", wsOnly, {
        whitespaceHidden: true,
        whitespaceOnly: true,
      }),
      whitespaceControl: true,
    });
    await waitFor(() =>
      expect(second.last()).toMatchObject({
        patch: wsOnly,
        cut: null,
        whitespaceHidden: true,
        anchors: [],
      }),
    );
    cleanup();
    const third = renderPane({ isPending: true });
    await waitFor(() =>
      expect(third.last()).toMatchObject({ patch: "", cut: "pending" }),
    );
  });

  it("reports a typechange's text half as the text its rows build from, with the read's cut mark", async () => {
    const half = typechangeHalves(TYPECHANGE, "x")?.text;
    expect(half).toBeDefined();
    expect(half).not.toBe(TYPECHANGE);
    const pane = renderPane({
      filePath: "x",
      data: diff("x", TYPECHANGE, { isBinary: true, isTruncated: true }),
      typechangeAnchors: true,
      lineAnchors: [anchor(1), anchor(250)],
    });
    await waitFor(() => expect(pane.last()?.cut).toBe("cap"));
    expect(pane.last()).toMatchObject({ patch: half, truncated: true });
    await waitFor(() => expect(pane.last()?.anchors).toEqual(["new:1"]));
  });

  it("reports a failed read with nothing to show as a pending paint", async () => {
    const pane = renderPane({ isError: true });
    await screen.findByText("Could not load diff for this file");
    await waitFor(() =>
      expect(pane.last()).toMatchObject({
        patch: "",
        cut: "pending",
        anchors: [],
      }),
    );
  });

  it("re-reads the cut mark when a read of the same text arrives truncated", async () => {
    const pane = renderPane({ data: diff("n.txt", SHORT) });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({
        patch: SHORT,
        cut: null,
        truncated: false,
      }),
    );
    // The rows don't change, so only the pane's replay can carry the mark.
    pane.rerender({ data: diff("n.txt", SHORT, { isTruncated: true }) });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: SHORT, truncated: true }),
    );
  });

  it("reports a paint its host names another commit's as pending, rows and all", async () => {
    const pane = renderPane({
      data: diff("n.txt", SHORT),
      lineAnchors: [anchor(2)],
      paintsOtherCommit: true,
    });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({
        patch: SHORT,
        cut: "pending",
        anchors: ["new:2"],
      }),
    );
    pane.rerender({ data: diff("n.txt", SHORT), lineAnchors: [anchor(2)] });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: SHORT, cut: null }),
    );
  });

  it("reports the rows a refresh's hold keeps on screen, never the text behind them", async () => {
    vi.mocked(gitFileBase64).mockImplementation(async (_r, rev) =>
      bytes(rev === "A" ? "a\nb\nc\n" : "a\nB\nc\n"),
    );
    const props: PaneProps = {
      repoPath: "/repo",
      contentRevs: { oldRev: "A", newRev: "B" },
    };
    const pane = renderPane({ ...props, data: diff("n.txt", SHORT) });
    await waitFor(() =>
      expect(pane.last()).toMatchObject({ patch: SHORT, cut: null }),
    );
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    // The reads refetch and never answer: the new text holds the old rows.
    vi.mocked(gitFileBase64).mockImplementation(
      () => new Promise<FileBytes>(() => undefined),
    );
    act(() => {
      void pane.client.invalidateQueries({
        queryKey: ["repo", "/repo", "file-b64"],
      });
    });
    pane.rerender({ ...props, data: diff("n.txt", SHORT_NEXT) });
    await act(async () => undefined);
    expect(document.body.textContent).not.toContain("BB");
    expect(pane.last()?.patch).toBe(SHORT);
  });
});

describe("content mode's whole-file reads", () => {
  it("never decodes a side over the byte budget", async () => {
    const big = "x\n".repeat(200_000);
    vi.mocked(gitFileBase64).mockImplementation(async (_r, rev) =>
      bytes(rev === "A" ? "a\nb\nc\n" : big),
    );
    renderPane({
      repoPath: "/repo",
      contentRevs: { oldRev: "A", newRev: "B" },
      data: diff("n.txt", SHORT),
    });
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    await act(async () => undefined);
    expect(gitFileBase64).toHaveBeenCalled();
    const decoded = vi
      .mocked(decodeBase64Utf8)
      .mock.calls.map(([s]) => s.length);
    expect(decoded.some((n) => n > 400_000)).toBe(false);
  });
});

describe("a History commit comment while Markdown Preview is up", () => {
  it("is listed naming Raw, and drawn inline once Raw is back", async () => {
    const body = "On the changed line";
    const md = MD;
    vi.mocked(forgeStatus).mockResolvedValue({
      provider: "gitlab",
      installed: true,
      authenticated: true,
      repo: "octo/repo",
      host: "gitlab.com",
      login: "octo",
      capabilities: new Proxy({}, { get: () => true }),
      implemented: new Proxy({}, { get: () => true }),
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
    vi.mocked(gitCommitDetails).mockResolvedValue({
      hash: COMMIT,
      subject: "Edit notes",
      body: "",
      author: "Ada",
      authorEmail: "ada@example.com",
      date: "2026-11-01T10:00:00Z",
      committerDate: "2026-11-01T10:00:00Z",
    });
    vi.mocked(gitCommitFiles).mockResolvedValue([
      { path: "n.md", added: 1, deleted: 1, isBinary: false, binaryKind: null },
    ]);
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, path) =>
      diff(path, md),
    );
    vi.mocked(gitFileBase64).mockImplementation(async (_r, rev) =>
      bytes(rev === COMMIT ? "a\nB\nc\n" : "a\nb\nc\n"),
    );
    vi.mocked(forgeCommitComments).mockResolvedValue([
      {
        id: "c2",
        author: "octo",
        body,
        createdAt: "2026-11-01T10:00:00Z",
        viewerDidAuthor: false,
        path: "n.md",
        line: 2,
        startLine: null,
        position: null,
      },
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, settings);
    render(
      <QueryClientProvider client={client}>
        <CommitDetailView repoPath="/repo" hash={COMMIT} />
      </QueryClientProvider>,
    );
    const inline = () => screen.getByText(body).closest("[data-diff-anchor]");
    await waitFor(() => expect(screen.queryByText(body)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(inline()).not.toBeNull());
    const user = userEvent.setup();
    await user.click(mdToggle("Preview"));
    await waitFor(() =>
      expect(screen.queryByText(/inline in Raw/)).not.toBeNull(),
    );
    expect(inline()).toBeNull();
    expect(screen.getAllByText(body)).toHaveLength(1);
    await user.click(mdToggle("Raw"));
    await waitFor(() => expect(inline()).not.toBeNull());
    expect(screen.getAllByText(body)).toHaveLength(1);
    expect(screen.queryByText(/inline in Raw/)).toBeNull();
    client.clear();
  }, 30_000);
});
