import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { startTransition } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { HOLD_BOUND_MS } from "@/features/diff/diff-pane-slots";
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
  CommitCommentOut,
  CommitDetails,
  DiffStatEntry,
  FileDiff,
  ForgeStatus,
  RepoStatus,
} from "@/lib/git/types";
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
/** Every pane render's read and the commit it renders for, so a test can
 *  prove what a pane drew (or never drew) under which commit. */
const paneReads = vi.hoisted(
  () =>
    [] as { data?: FileDiff; isPlaceholderData: boolean; commit?: string }[],
);
/** Binary paths whose size read is still out: like BinaryFileSummary, the pane
 *  withholds its settle report, so the slot stays preparing. */
const sizesPending = vi.hoisted(() => new Set<string>());
// The pane stands in for DiffSurface's settle report and anchor placement: a
// text diff draws its line anchors inline, a binary one draws none.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffSurface({
    diff,
    lineAnchors,
    contentRevs,
  }: {
    diff: { data?: FileDiff; isPlaceholderData: boolean };
    lineAnchors?: DiffLineAnchor[];
    contentRevs?: { newRev?: string };
  }) {
    paneReads.push({
      data: diff.data,
      isPlaceholderData: diff.isPlaceholderData,
      commit: contentRevs?.newRev,
    });
    useReportPaneSettled(
      diff.data !== undefined &&
        !diff.isPlaceholderData &&
        !(diff.data.isBinary && sizesPending.has(diff.data.filePath)),
    );
    if (diff.data?.isBinary !== false) return null;
    return (
      <div data-testid="inline-anchors">
        {lineAnchors?.map((a) => (
          <div key={`${a.side}:${a.line}`}>{a.render()}</div>
        ))}
      </div>
    );
  }
  return { DiffSurface, DiffContent: () => null };
});

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const A = "abcdef0123".repeat(4);
const B = `b${A.slice(1)}`;

/** Never settles: commit B's reads stay pending, so A's serve as placeholder. */
const pending = <T,>() => new Promise<T>(() => undefined);

const details = (hash: string): CommitDetails => ({
  hash,
  subject: `subject ${hash.slice(0, 4)}`,
  body: "",
  author: "Ada",
  authorEmail: "ada@example.com",
  date: "2026-11-01T10:00:00Z",
  committerDate: "2026-11-01T10:00:00Z",
});

const bin = (path: string): DiffStatEntry => ({
  path,
  added: 0,
  deleted: 0,
  isBinary: true,
  binaryKind: null,
});
const text = (path: string): DiffStatEntry => ({
  path,
  added: 1,
  deleted: 1,
  isBinary: false,
  binaryKind: null,
});

const binDiff = (path: string): FileDiff => ({
  filePath: path,
  isBinary: true,
  isTruncated: false,
  text: `diff --git a/${path} b/${path}\nindex 1111aaa..2222bbb 100644\nBinary files a/${path} and b/${path} differ\n`,
});
/** `line` tells two commits' diffs of one path apart: the gates compare content. */
const textDiff = (path: string, line = "new"): FileDiff => ({
  filePath: path,
  isBinary: false,
  isTruncated: false,
  text: `diff --git a/${path} b/${path}\nindex 1111aaa..2222bbb 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`,
});

const comment = (id: string, path: string | null): CommitCommentOut => ({
  id,
  author: "octo",
  body: `note on ${path ?? "the whole commit"}`,
  createdAt: "2026-01-01T00:00:00Z",
  viewerDidAuthor: false,
  path,
  line: path === null ? null : 1,
  startLine: null,
  position: null,
});
const WHOLE = comment("whole", null);
const ALL_ON = new Proxy({}, { get: () => true });

/** Commit A's reads; anything else (commit B) never settles. */
function serveA(
  rows: DiffStatEntry[],
  diffs: Record<string, FileDiff | Promise<FileDiff>>,
  comments: CommitCommentOut[],
) {
  vi.mocked(gitCommitDetails).mockImplementation((_r, hash) =>
    hash === A ? Promise.resolve(details(A)) : pending(),
  );
  vi.mocked(gitCommitFiles).mockImplementation((_r, hash) =>
    hash === A ? Promise.resolve(rows) : pending(),
  );
  vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash, path) =>
    hash === A && diffs[path] !== undefined
      ? Promise.resolve(diffs[path])
      : pending(),
  );
  vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
    sha === A ? [...comments, WHOLE] : [],
  );
}

beforeEach(() => {
  unmockedCommands.length = 0;
  paneReads.length = 0;
  sizesPending.clear();
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "github.com",
    login: "octo",
    // GitHub is all-true on both axes.
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
  } as unknown as RepoStatus);
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

function renderView(hash: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (h: string) => (
    <QueryClientProvider client={client}>
      <CommitDetailView repoPath={REPO} hash={h} />
    </QueryClientProvider>
  );
  const result = render(view(hash));
  return { ...result, switchTo: (h: string) => result.rerender(view(h)) };
}

/** Lets every resolved read land and the deferred path catch up. */
const settle = () => act(() => Promise.resolve());

/** jsdom measures the rail's row at zero width, which forces the collapsed
 *  strip; its explicit expand is local to the narrow row. */
function railRow(path: string) {
  const expand = screen.queryByRole("button", { name: "Expand file list" });
  if (expand) fireEvent.click(expand);
  const row = screen
    .getAllByRole("button")
    .find(
      (b) =>
        b.textContent?.startsWith(path) &&
        /Binary file|added/.test(b.textContent),
    );
  if (!row) throw new Error(`no rail row for ${path}`);
  return row;
}

/** Another file's comment carries a jump button; the shown file's does not. */
const jumpTo = (path: string) =>
  screen.queryByRole("button", { name: `${path}:1` });

/** A comment rendered outside the pane's inline anchors (the labelled group). */
const grouped = (body: string) =>
  screen
    .queryAllByText(body)
    .find((el) => el.closest("[data-testid=inline-anchors]") === null) ?? null;

/** `path` is the shown file and its line comment sits in the labelled group. */
async function expectGroupedAsShown(path: string) {
  await waitFor(() => {
    expect(screen.getByText(`note on ${path}`)).toBeTruthy();
    expect(jumpTo(path)).toBeNull();
  });
}

describe("CommitDetailView keeps a binary file's comments grouped", () => {
  // Negative control: restoring the old `!shownDiff.isPlaceholderData &&
  // shownDiff.data?.isBinary === true` derivation fails this test.
  it("through a commit switch's placeholder window", async () => {
    serveA([bin("x.bin")], { "x.bin": binDiff("x.bin") }, [
      comment("x", "x.bin"),
    ]);
    const { switchTo } = renderView(A);
    await expectGroupedAsShown("x.bin");
    await settle();
    switchTo(B);
    await settle();
    expect(screen.getByText("subject abcd")).toBeTruthy();
    expect(screen.getByText("note on x.bin")).toBeTruthy();
    expect(jumpTo("x.bin")).toBeNull();
  });

  it("never groups a text file's placeable comment", async () => {
    serveA([text("y.txt")], { "y.txt": textDiff("y.txt") }, [
      comment("y", "y.txt"),
    ]);
    const { switchTo } = renderView(A);
    expect(await screen.findByText("note on the whole commit")).toBeTruthy();
    // A's settled diff must render first, or the switch beats both stamps.
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors").textContent).toContain(
        "note on y.txt",
      ),
    );
    expect(grouped("note on y.txt")).toBeNull();
    await settle();
    switchTo(B);
    await settle();
    expect(screen.getByText("subject abcd")).toBeTruthy();
    expect(screen.getByText("note on the whole commit")).toBeTruthy();
    expect(grouped("note on y.txt")).toBeNull();
  });

  it("keeps a text file ungrouped while its diff loads after a binary one", async () => {
    let resolveY: ((d: FileDiff) => void) | undefined;
    const yDiff = new Promise<FileDiff>((r) => {
      resolveY = r;
    });
    serveA(
      [bin("x.bin"), text("y.txt")],
      { "x.bin": binDiff("x.bin"), "y.txt": yDiff },
      [comment("x", "x.bin"), comment("y", "y.txt")],
    );
    renderView(A);
    await expectGroupedAsShown("x.bin");
    await settle();
    fireEvent.click(railRow("y.txt"));
    await settle();
    // y is shown (x's comment now jumps) while its own diff is still pending.
    expect(jumpTo("x.bin")).toBeTruthy();
    expect(grouped("note on y.txt")).toBeNull();
    await act(async () => resolveY?.(textDiff("y.txt")));
    await settle();
    expect(grouped("note on y.txt")).toBeNull();
    expect(jumpTo("x.bin")).toBeTruthy();
  });

  it("keeps the first file's comments when the switch resets the selection", async () => {
    serveA(
      [bin("f.bin"), bin("x.bin")],
      { "f.bin": binDiff("f.bin"), "x.bin": binDiff("x.bin") },
      [comment("f", "f.bin")],
    );
    const { switchTo } = renderView(A);
    await expectGroupedAsShown("f.bin");
    fireEvent.click(railRow("x.bin"));
    await waitFor(() => expect(jumpTo("f.bin")).toBeTruthy());
    await settle();
    switchTo(B);
    await settle();
    // The reset walked the shown path back to f, while the retained diff
    // verdict now names x: only the settled file list can answer for f.
    expect(screen.getByText("subject abcd")).toBeTruthy();
    expect(screen.getByText("note on f.bin")).toBeTruthy();
    expect(jumpTo("f.bin")).toBeNull();
  });

  // Negative control: building the anchors on `anchorsOn ? path : null` alone
  // fails this test (f.bin's comment renders inline on x.txt and in the group).
  it("never anchors the reset file's comment on another file's held diff", async () => {
    // B's header and file list are cached from an earlier visit; only f.bin's
    // diff is still loading, so its slot serves x.txt's diff as a placeholder.
    vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) =>
      details(hash),
    );
    vi.mocked(gitCommitFiles).mockImplementation(async (_r, hash) =>
      hash === B ? [bin("f.bin")] : [text("x.txt")],
    );
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash, path) =>
      hash === A && path === "x.txt"
        ? Promise.resolve(textDiff("x.txt"))
        : pending(),
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === B ? [comment("f", "f.bin"), WHOLE] : [WHOLE],
    );
    const { switchTo } = renderView(B);
    await screen.findByText("subject bbcd");
    await settle();
    switchTo(A);
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors")).toBeTruthy(),
    );
    await settle();
    // In a transition the deferred path lands with the commit: one re-target.
    await act(() => startTransition(() => switchTo(B)));
    await expectGroupedAsShown("f.bin");
    await settle();
    expect(screen.getByTestId("inline-anchors")).toBeTruthy();
    expect(screen.getAllByText("note on f.bin")).toHaveLength(1);
    expect(screen.getByTestId("inline-anchors").textContent).not.toContain(
      "note on f.bin",
    );
  });

  // Negative control: gating a placeholder's anchors on its echoed path alone
  // fails this test (f.dat's comment renders inline on A's text and in the group).
  it("never anchors a binary file's comment on the same path held from another commit", async () => {
    // B's header and file list are cached from an earlier visit; only its f.dat
    // diff is still loading, so the slot serves A's text f.dat as a placeholder.
    vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) =>
      details(hash),
    );
    vi.mocked(gitCommitFiles).mockImplementation(async (_r, hash) =>
      hash === B ? [bin("f.dat")] : [text("f.dat")],
    );
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash, path) =>
      hash === A && path === "f.dat"
        ? Promise.resolve(textDiff("f.dat"))
        : pending(),
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === B ? [comment("f", "f.dat"), WHOLE] : [WHOLE],
    );
    const { switchTo } = renderView(B);
    await screen.findByText("subject bbcd");
    await settle();
    switchTo(A);
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors")).toBeTruthy(),
    );
    await settle();
    await act(() => startTransition(() => switchTo(B)));
    await expectGroupedAsShown("f.dat");
    await settle();
    expect(screen.getByText("subject bbcd")).toBeTruthy();
    expect(screen.getByTestId("inline-anchors")).toBeTruthy();
    expect(screen.getAllByText("note on f.dat")).toHaveLength(1);
    expect(screen.getByTestId("inline-anchors").textContent).not.toContain(
      "note on f.dat",
    );
  });

  // Negative control: passing the shown path to the list through the window
  // fails this test (f.txt's comment renders nowhere until B's diff lands).
  it("lists a text file's comment while the same path loads from another commit", async () => {
    let resolveB: ((d: FileDiff) => void) | undefined;
    const bDiff = new Promise<FileDiff>((r) => {
      resolveB = r;
    });
    vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) =>
      details(hash),
    );
    vi.mocked(gitCommitFiles).mockImplementation(async () => [text("f.txt")]);
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash) =>
      hash === A ? Promise.resolve(textDiff("f.txt")) : bDiff,
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === B ? [comment("f", "f.txt"), WHOLE] : [WHOLE],
    );
    const { switchTo } = renderView(B);
    await screen.findByText("subject bbcd");
    await settle();
    switchTo(A);
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors")).toBeTruthy(),
    );
    await settle();
    await act(() => startTransition(() => switchTo(B)));
    await settle();
    // B's header, list and comments are cached; only its diff is pending.
    expect(screen.getByText("subject bbcd")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText("note on f.txt")).toHaveLength(1);
      expect(grouped("note on f.txt")).toBeTruthy();
    });
    await act(async () => resolveB?.(textDiff("f.txt", "newer")));
    await waitFor(() => {
      expect(screen.getAllByText("note on f.txt")).toHaveLength(1);
      expect(grouped("note on f.txt")).toBeNull();
      expect(screen.getByTestId("inline-anchors").textContent).toContain(
        "note on f.txt",
      );
    });
  });

  // Negative controls: dropping the content term from the slot's gate (the
  // comment renders twice) or from the parent's (it renders nowhere) fails this.
  it("lists a text file's comment over a settled read that never rendered", async () => {
    const C = `c${A.slice(1)}`;
    const settledB = textDiff("p.txt", "newer");
    let resolveB: ((d: FileDiff) => void) | undefined;
    const bDiff = new Promise<FileDiff>((r) => {
      resolveB = r;
    });
    // A settles; B's details never land, so A stays the rendered commit while
    // B's file list and diff load; C's details, file list and diff never settle.
    vi.mocked(gitCommitDetails).mockImplementation((_r, hash) =>
      hash === A ? Promise.resolve(details(A)) : pending(),
    );
    vi.mocked(gitCommitFiles).mockImplementation((_r, hash) =>
      hash === C ? pending() : Promise.resolve([text("p.txt")]),
    );
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash) => {
      if (hash === A) return Promise.resolve(textDiff("p.txt"));
      return hash === B ? bDiff : pending();
    });
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === A ? [comment("p", "p.txt"), WHOLE] : [WHOLE],
    );
    const { switchTo } = renderView(A);
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors").textContent).toContain(
        "note on p.txt",
      ),
    );
    await settle();
    switchTo(B);
    await waitFor(() =>
      expect(
        vi.mocked(gitCommitFileDiff).mock.calls.some(([, h]) => h === B),
      ).toBe(true),
    );
    await settle();
    // B's diff settles in the cache, and the switch to C lands before React
    // renders that answer: both observers then serve it as C's placeholder.
    await act(async () => {
      resolveB?.(settledB);
      await new Promise((r) => setTimeout(r, 0));
      switchTo(C);
    });
    await settle();
    // The window's premise: B's answer reached the pane only as a placeholder.
    expect(
      paneReads.some(
        (r) => !r.isPlaceholderData && r.data?.text === settledB.text,
      ),
    ).toBe(false);
    expect(paneReads.some((r) => r.data?.text === settledB.text)).toBe(true);
    expect(screen.getByText("subject abcd")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText("note on p.txt")).toHaveLength(1);
      expect(grouped("note on p.txt")).toBeTruthy();
    });
  });

  // Negative control: dropping the parent's path term while the header lags
  // fails this test (f.txt's comment renders nowhere until B lands).
  it("lists the reset file's comment over another file's read while the header lags", async () => {
    // B's details and file list never land: the selection resets to f.txt off
    // A's list while the pane still serves A's x.txt read.
    vi.mocked(gitCommitDetails).mockImplementation((_r, hash) =>
      hash === A ? Promise.resolve(details(A)) : pending(),
    );
    vi.mocked(gitCommitFiles).mockImplementation((_r, hash) =>
      hash === A ? Promise.resolve([text("f.txt"), text("x.txt")]) : pending(),
    );
    vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash, path) =>
      hash === A ? Promise.resolve(textDiff(path)) : pending(),
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === A ? [comment("f", "f.txt"), WHOLE] : [],
    );
    const { switchTo } = renderView(A);
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors").textContent).toContain(
        "note on f.txt",
      ),
    );
    await settle();
    fireEvent.click(railRow("x.txt"));
    await waitFor(() => expect(jumpTo("f.txt")).toBeTruthy());
    await settle();
    switchTo(B);
    await settle();
    expect(screen.getByText("subject abcd")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText("note on f.txt")).toHaveLength(1);
      expect(grouped("note on f.txt")).toBeTruthy();
    });
  });

  // A switch's selection reset retargets through the previous path (y.bin) and
  // replaces the held x.txt slot; a click back on x.txt first reuses it in place
  // under B. Negative control: gating the slots' anchors on `anchorsMatchDiff`
  // alone fails this test (x.txt's comment renders inline and in the list).
  it("never anchors inline while the list keeps every file's comments", async () => {
    sizesPending.add("y.bin");
    // The hold's bound would promote y.bin's slot unsettled; pinning it open
    // makes the switch land while that slot is still preparing.
    const realSetTimeout = window.setTimeout.bind(window);
    const pinBound = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(((
        handler: TimerHandler,
        ms?: number,
        ...args: unknown[]
      ) =>
        ms === HOLD_BOUND_MS
          ? 0
          : realSetTimeout(handler, ms, ...args)) as typeof window.setTimeout);
    try {
      vi.mocked(gitCommitDetails).mockImplementation((_r, hash) =>
        hash === A ? Promise.resolve(details(A)) : pending(),
      );
      vi.mocked(gitCommitFiles).mockImplementation((_r, hash) =>
        hash === A ? Promise.resolve([text("x.txt"), bin("y.bin")]) : pending(),
      );
      vi.mocked(gitCommitFileDiff).mockImplementation((_r, hash, path) => {
        if (hash !== A) return pending();
        return Promise.resolve(
          path === "y.bin" ? binDiff("y.bin") : textDiff("x.txt"),
        );
      });
      vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
        sha === A ? [comment("x", "x.txt"), WHOLE] : [],
      );
      const { switchTo } = renderView(A);
      await waitFor(() =>
        expect(screen.getByTestId("inline-anchors").textContent).toContain(
          "note on x.txt",
        ),
      );
      await settle();
      fireEvent.click(railRow("y.bin"));
      await waitFor(() =>
        expect(
          paneReads.some(
            (r) => !r.isPlaceholderData && r.data?.filePath === "y.bin",
          ),
        ).toBe(true),
      );
      await settle();
      // y.bin settled but its slot is still preparing: x.txt's stays painted.
      expect(screen.getByTestId("inline-anchors")).toBeTruthy();
      // The click is urgent and leaves the deferred path on y.bin; the switch,
      // a transition, reads x.txt at once and retargets the held slot to B.
      // B's details and file list never land.
      await act(async () => {
        fireEvent.click(railRow("x.txt"));
        startTransition(() => switchTo(B));
      });
      await settle();
      // The precondition: the x.txt pane drew under B from A's x.txt read.
      expect(
        paneReads.some(
          (r) =>
            r.commit === B &&
            r.isPlaceholderData &&
            r.data?.filePath === "x.txt",
        ),
      ).toBe(true);
      expect(screen.getByText("subject abcd")).toBeTruthy();
      await waitFor(() => {
        expect(screen.getAllByText("note on x.txt")).toHaveLength(1);
        expect(grouped("note on x.txt")).toBeTruthy();
      });
      expect(
        screen.queryByTestId("inline-anchors")?.textContent ?? "",
      ).not.toContain("note on x.txt");
    } finally {
      pinBound.mockRestore();
    }
  });

  // Negative control: gating the anchors on `!diff.isPlaceholderData` fails this
  // test (the comment leaves the held text and no group lists it).
  it("keeps a text file's inline anchor while the next commit's details load", async () => {
    serveA([text("y.txt")], { "y.txt": textDiff("y.txt") }, [
      comment("y", "y.txt"),
    ]);
    const { switchTo } = renderView(A);
    await waitFor(() =>
      expect(screen.getByTestId("inline-anchors").textContent).toContain(
        "note on y.txt",
      ),
    );
    await settle();
    switchTo(B);
    await settle();
    // B's details never land, so A stays the rendered commit.
    expect(screen.getByText("subject abcd")).toBeTruthy();
    expect(screen.getByTestId("inline-anchors").textContent).toContain(
      "note on y.txt",
    );
    expect(screen.getAllByText("note on y.txt")).toHaveLength(1);
  });
});

describe("CommitDetailView file rail", () => {
  it("labels a mode-only binary row", async () => {
    serveA(
      [{ ...bin("m.bin"), binaryKind: "mode" }],
      { "m.bin": textDiff("m.bin") },
      [],
    );
    renderView(A);
    await screen.findByText("note on the whole commit");
    const row = railRow("m.bin");
    expect(row.querySelector("[aria-hidden]")?.textContent).toBe("mode");
    expect(row.querySelector(".sr-only")?.textContent).toBe(
      "Binary file, mode changed",
    );
    // The rail's ScrollArea updates a tick after the last read: let it land
    // inside act.
    await settle();
  });
});
