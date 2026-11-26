import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  createRef,
  Profiler,
  type ReactNode,
  type RefObject,
  Suspense,
} from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type DiffLineAnchor,
  GitDiffView,
  type LineWidget,
} from "@/features/diff/DiffSurface";
import { DiffViewer } from "@/features/diff/DiffViewer";
import { SnapshotMark } from "@/features/diff/snapshot-mark";
import {
  type FileBytes,
  gitBlobSizes,
  gitDiffFile,
  gitFileBase64,
  gitStatus,
} from "@/lib/git/api";
import type { FileDiff, RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { bodies, renderBody } from "./anchor-bodies";
import { stubCanvas } from "./canvas-stub";

/** A render-time suspension the deferred rebuild hits inside the library's
 *  rows, after the library view's own function has run. Only the new build's
 *  rows reach it, so the committed rows' urgent re-render never suspends. */
const gate = vi.hoisted(() => ({
  armed: false,
  promise: null as Promise<void> | null,
  release: (): void => undefined,
  /** Every scroller `captureLineAnchor` read, in call order. */
  lineReads: [] as HTMLElement[],
  /** Settles once a render first reaches the armed gate. */
  entered: Promise.resolve(),
  enter: (): void => undefined,
}));

// The staging viewer's hunk headers call `hunkRange` from the library's extend
// rows; the new build's second hunk (header context `fnB`) suspends there.
vi.mock("@/features/diff/diff-rows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/diff/diff-rows")>();
  return {
    ...actual,
    hunkRange: (hunk: Parameters<typeof actual.hunkRange>[0]) => {
      if (gate.armed && gate.promise && hunk.header.includes("fnB")) {
        gate.enter();
        throw gate.promise;
      }
      return actual.hunkRange(hunk);
    },
    captureLineAnchor: (
      ...args: Parameters<typeof actual.captureLineAnchor>
    ) => {
      gate.lineReads.push(args[0]);
      return actual.captureLineAnchor(...args);
    },
  };
});

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitDiffFile: vi.fn(),
  gitBlobSizes: vi.fn(),
  gitFileBase64: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

// Wide enough for split, so the layout is the urgent prop.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 2000],
}));

beforeAll(stubCanvas);

function arm() {
  gate.entered = new Promise<void>((resolve) => {
    gate.enter = resolve;
  });
  gate.promise = new Promise<void>((resolve) => {
    gate.release = () => {
      gate.armed = false;
      resolve();
    };
  });
  gate.armed = true;
}

function SuspendWhileArmed(): null {
  if (gate.armed && gate.promise) {
    gate.enter();
    throw gate.promise;
  }
  return null;
}

/** Lets the query notifications and the deferred render after them land. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

const wrapperOf = (root: ParentNode) =>
  root.querySelector<HTMLElement>(".diff-tailwindcss-wrapper");

/** Whether the library rows show `text` (its cells split a line into spans). */
const rowsShow = (text: string) =>
  wrapperOf(document.body)?.textContent?.includes(text) ?? false;

/** Each commit's wrapper node and theme, read in the commit's layout phase
 *  (before the library's passive effect re-themes its clone). */
let commits: { node: HTMLElement; theme: string | null }[] = [];
function CommitProbe({ children }: { children: ReactNode }) {
  return (
    <Profiler
      id="diff"
      onRender={() => {
        const node = wrapperOf(document.body);
        if (node !== null)
          commits.push({ node, theme: node.getAttribute("data-theme") });
      }}
    >
      {children}
    </Profiler>
  );
}

let client: QueryClient;
beforeEach(() => {
  commits = [];
  gate.armed = false;
  gate.promise = null;
  document.documentElement.classList.add("dark");
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: "split" as const,
  });
});

afterEach(() => {
  gate.release();
  document.documentElement.classList.remove("dark");
});

const PATH = "src/flash.txt";
const patchOf = (lines: string[]) =>
  `${[`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, ...lines].join("\n")}\n`;
const TEXT_A = patchOf(["@@ -1,3 +1,3 @@", " a1", "-a2", "+A2", " a3"]);
const TEXT_B = patchOf(["@@ -1,3 +1,3 @@", " b1", "-b2", "+B2", " b3"]);

const anchorsOf = (render: () => ReactNode): DiffLineAnchor[] =>
  bodies([{ side: "new", line: 2, render }]);

function view(props: {
  text: string;
  anchors?: DiffLineAnchor[];
  forceUnified?: boolean;
  lineWidget?: LineWidget;
  /** The scroller around the diff, passed as its `scrollerRef`. */
  scroller?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <QueryClientProvider client={client}>
      <CommitProbe>
        <Suspense fallback={<p>suspended</p>}>
          <div ref={props.scroller}>
            <GitDiffView
              filePath={PATH}
              text={props.text}
              lineAnchors={props.anchors}
              renderAnchor={renderBody}
              forceUnified={props.forceUnified}
              lineWidget={props.lineWidget}
              scrollerRef={props.scroller}
            />
          </div>
        </Suspense>
      </CommitProbe>
    </QueryClientProvider>
  );
}

const widget: LineWidget = { enabled: true, render: () => null };

describe("RenderedDiff keeps the dark theme through a discarded rebuild", () => {
  it.each([
    ["the line-comment view (A-2)", widget],
    ["the read-only view (A-3)", undefined],
  ])("%s", async (_name, lineWidget) => {
    const quiet = anchorsOf(() => null);
    const { container, rerender } = render(
      view({ text: TEXT_A, anchors: quiet, forceUnified: true, lineWidget }),
    );
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("dark");
    expect(rowsShow("A2")).toBe(true);

    arm();
    const suspending = anchorsOf(() => <SuspendWhileArmed />);
    rerender(
      view({
        text: TEXT_B,
        anchors: suspending,
        forceUnified: true,
        lineWidget,
      }),
    );
    await gate.entered;
    // The rebuild is still suspended: the committed rows are the old build's.
    expect(rowsShow("B2")).toBe(false);
    expect(screen.queryByText("suspended")).toBeNull();

    // An urgent prop the library view receives re-renders the committed view.
    rerender(
      view({
        text: TEXT_B,
        anchors: suspending,
        forceUnified: false,
        lineWidget,
      }),
    );
    await settle();
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("dark");
    expect(rowsShow("A2")).toBe(true);

    await act(async () => gate.release());
    await settle();
    expect(rowsShow("B2")).toBe(true);
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("dark");
  });

  it("a new build's first commit is already dark (fix B)", () => {
    render(view({ text: TEXT_A }));
    expect(commits[0]?.theme).toBe("dark");
  });

  it("a theme toggle re-themes the same view, never a rebuild", async () => {
    const { container } = render(view({ text: TEXT_A }));
    const before = wrapperOf(container);
    expect(before?.getAttribute("data-theme")).toBe("dark");
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    await settle();
    const after = wrapperOf(container);
    expect(after).toBe(before);
    expect(after?.getAttribute("data-theme")).toBe("light");
  });

  it("a theme toggle keeps the context an expand revealed", async () => {
    // Lines are `c<n>;`, so no line's text holds another's.
    const old = Array.from({ length: 30 }, (_, i) => `c${i + 1};\n`).join("");
    const next = old.replace("c15;\n", "C15;\n");
    vi.mocked(gitFileBase64).mockImplementation(
      async (_repo, rev) =>
        ({
          base64: btoa(rev === "A" ? old : next),
          mime: null,
          tooLarge: false,
        }) as FileBytes,
    );
    const text = patchOf([
      "@@ -12,7 +12,7 @@",
      ...[12, 13, 14].map((n) => ` c${n};`),
      "-c15;",
      "+C15;",
      ...[16, 17, 18].map((n) => ` c${n};`),
    ]);
    const { container } = render(
      <QueryClientProvider client={client}>
        <GitDiffView
          filePath={PATH}
          text={text}
          repoPath="/repo"
          contentRevs={{ oldRev: "A", newRev: "B" }}
        />
      </QueryClientProvider>,
    );
    const expands = () => container.querySelectorAll('[title^="Expand"]');
    /** The lines outside the hunk the rows show. */
    const revealed = () =>
      [...Array.from({ length: 11 }, (_, i) => i + 1), 19, 20, 21, 22]
        .map((n) => `c${n};`)
        .filter(rowsShow);
    await waitFor(() => expect(expands().length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(revealed()).toEqual([]);
    await act(async () => {
      (expands()[0] as HTMLElement).click();
    });
    await waitFor(() => expect(revealed().length).toBeGreaterThan(0));
    const shown = revealed();
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    await settle();
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("light");
    expect(revealed()).toEqual(shown);
  }, 30_000);

  it("an arm swap after a theme toggle first-commits the current theme", async () => {
    const { container, rerender } = render(view({ text: TEXT_A }));
    const first = wrapperOf(container);
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    await settle();
    expect(first?.getAttribute("data-theme")).toBe("light");
    commits = [];
    rerender(view({ text: TEXT_A, lineWidget: widget }));
    const swapped = commits.find((c) => c.node !== first);
    expect(swapped).toBeDefined();
    expect(swapped?.theme).toBe("light");
  });
});

// The staging viewer, reached through DiffViewer. The second hunk starts right
// under the first, so its inline header (an extend row) renders on the first
// hunk's last line, inside the library's rows.
const S = "staged.txt";
const stagingPatch = (index: string, lines: string[]) =>
  `${[`diff --git a/${S} b/${S}`, `index ${index} 100644`, `--- a/${S}`, `+++ b/${S}`, ...lines].join("\n")}\n`;
const STAGING_A = stagingPatch("1111aaa..2222bbb", [
  "@@ -1,3 +1,3 @@",
  " a1",
  "-a2",
  "+A2",
  " a3",
  "@@ -4,3 +4,3 @@ fnA",
  " a4",
  "-a5",
  "+A5",
  " a6",
]);
const STAGING_B = stagingPatch("1111aaa..3333ccc", [
  "@@ -1,3 +1,3 @@",
  " b1",
  "-b2",
  "+B2",
  " b3",
  "@@ -4,3 +4,3 @@ fnB",
  " b4",
  "-b5",
  "+B5",
  " b6",
]);
const diffOf = (text: string): FileDiff => ({
  filePath: S,
  text,
  isBinary: false,
  isTruncated: false,
});

/** The whole-file sides content mode reads, per fixture (`rev` null = the
 *  working tree). */
const sides = { old: "", new: "" };
const sidesOf = (tag: "a" | "b") => {
  const up = tag.toUpperCase();
  const lines = (changed: boolean) =>
    [1, 2, 3, 4, 5, 6].map((n) =>
      changed && (n === 2 || n === 5) ? `${up}${n}` : `${tag}${n}`,
    );
  sides.old = `${lines(false).join("\n")}\n`;
  sides.new = `${lines(true).join("\n")}\n`;
};

function renderStaging() {
  sidesOf("a");
  vi.mocked(gitFileBase64).mockImplementation(
    async (_repo, rev) =>
      ({
        base64: btoa(rev === null ? sides.new : sides.old),
        mime: null,
        tooLarge: false,
      }) as FileBytes,
  );
  vi.mocked(gitDiffFile).mockResolvedValue(diffOf(STAGING_A));
  vi.mocked(gitBlobSizes).mockResolvedValue({ oldSize: null, newSize: 7 });
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "main", detached: false, oid: null, upstream: null },
    entries: [{ path: S, staged: null, unstaged: "modified" }],
  } as unknown as RepoStatus);
  useUiStore.setState({
    selectedFile: { path: S, staged: false, untracked: false },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  return render(
    <QueryClientProvider client={client}>
      <CommitProbe>
        <Suspense fallback={<p>suspended</p>}>
          <DiffViewer repoPath="/repo" />
        </Suspense>
      </CommitProbe>
    </QueryClientProvider>,
  );
}

describe("StagingDiffView keeps the dark theme through a discarded rebuild", () => {
  it("the staging view (A-1)", async () => {
    const { container } = renderStaging();
    await waitFor(() => expect(rowsShow("A2")).toBe(true));
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("dark");

    arm();
    // A new answer for the file and its whole-file sides: a deferred rebuild.
    sidesOf("b");
    vi.mocked(gitDiffFile).mockResolvedValue(diffOf(STAGING_B));
    await act(async () => {
      await client.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== settingsKeys.settings[0],
      });
    });
    await gate.entered;
    expect(rowsShow("B2")).toBe(false);
    expect(screen.queryByText("suspended")).toBeNull();

    // The layout is a prop the library view receives: an urgent re-render.
    await act(async () => {
      client.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        diffViewMode: "split" as const,
      });
    });
    await settle();
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("dark");
    expect(rowsShow("A2")).toBe(true);

    await act(async () => gate.release());
    await waitFor(() => expect(rowsShow("B2")).toBe(true));
    expect(wrapperOf(container)?.getAttribute("data-theme")).toBe("dark");
  });

  it("a new build's first commit is already dark (fix B)", async () => {
    renderStaging();
    await waitFor(() => expect(rowsShow("A2")).toBe(true));
    expect(commits[0]?.theme).toBe("dark");
  });
});

/** One `SnapshotMark` update, read when it ran: the layout it left, the
 *  layout it renders, and the scrollers `captureLineAnchor` read inside it. */
type MarkUpdate = { from: string; to: string; scrollers: HTMLElement[] };

/** Runs `before` and then switches the setting to split, and returns every
 *  layout flip a mounted `SnapshotMark` made in an update (a mark that mounts
 *  reads nothing), each as [from, to, the rows' scrollers it read the line
 *  on]: a scroller that holds the diff's rows and is on the page. */
async function modeReadsOnSplit(before?: () => void) {
  const original = SnapshotMark.prototype.getSnapshotBeforeUpdate;
  const updates: MarkUpdate[] = [];
  const snapshot = vi
    .spyOn(SnapshotMark.prototype, "getSnapshotBeforeUpdate")
    .mockImplementation(function (this: SnapshotMark, prev) {
      const read = gate.lineReads.length;
      const result = original.call(this, prev);
      updates.push({
        from: prev.on,
        to: this.props.on,
        scrollers: gate.lineReads.slice(read),
      });
      return result;
    });
  const rows = () => wrapperOf(document.body);
  const flips = () =>
    updates
      .filter(
        ({ from, to }) => from !== to && ["unified", "split"].includes(from),
      )
      .map(({ from, to, scrollers }) => [
        from,
        to,
        scrollers.filter((s) => s.isConnected && s.contains(rows())).length,
      ]);
  try {
    if (before !== undefined) await act(async () => before());
    await act(async () => {
      client.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        diffViewMode: "split" as const,
      });
    });
    // Waits for the commit that flips the layout, then lets any later read in.
    await waitFor(() => expect(flips().length).toBeGreaterThan(0), {
      timeout: 2_000,
    });
    await settle();
    return flips();
  } finally {
    snapshot.mockRestore();
  }
}

describe("each useModeLineAnchor caller reads its line once on a switch", () => {
  it("RenderedDiff", async () => {
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    const scroller = createRef<HTMLDivElement>();
    const { rerender } = render(view({ text: TEXT_A, scroller }));
    await waitFor(() => expect(rowsShow("A2")).toBe(true));
    // A mark update while still unified (a new scroller ref re-renders it)
    // comes before the switch, and is no flip.
    const next = createRef<HTMLDivElement>();
    const reads = await modeReadsOnSplit(() =>
      rerender(view({ text: TEXT_A, scroller: next })),
    );
    expect(reads).toEqual([["unified", "split", 1]]);
    expect(next.current?.contains(wrapperOf(document.body))).toBe(true);
  });

  it("the staging viewer", async () => {
    renderStaging();
    await waitFor(() => expect(rowsShow("A2")).toBe(true));
    expect(await modeReadsOnSplit()).toEqual([["unified", "split", 1]]);
  });
});
