import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_FILTER_SURFACES,
  useFileFilterStore,
  useFileListFilter,
} from "@/components/use-file-list-filter";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import {
  forgeCommitComments,
  forgeCommitFirstParent,
  forgeFileAtSha,
  forgePrCommitDiff,
  forgeStatus,
  gitFileBase64,
  gitObjectsPresent,
  type PrContentRevs,
} from "@/lib/git/api";
import type { CommitCommentOut, ForgeStatus } from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeCommitComments: vi.fn(),
  forgeCommitFirstParent: vi.fn(),
  forgeFileAtSha: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  gitFileBase64: vi.fn(),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
// The stand-in pane records the props each file's pane was handed and names
// the anchor lines it would draw; with `real` set, the real pane draws them.
const panes = vi.hoisted(() => ({
  props: new Map<string, PaneProps>(),
  real: false,
}));
interface PaneProps {
  filePath: string;
  data?: { oldPath?: string; text: string };
  contentRevs?: { oldRev?: string | null; newRev?: string | null };
  imageRevs?: { old: string | null; new: string | null };
  forgePatch?: { source: unknown; scope?: string };
  previewRev?: string;
  typechangeAnchors?: boolean;
  lineAnchors?: { side: string; line: number }[];
}
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/diff/DiffSurfaceLazy")>();
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffContent(props: PaneProps) {
    panes.props.set(props.filePath, props);
    if (!panes.real) return <StandIn {...props} />;
    const Real = real.DiffContent as unknown as (p: PaneProps) => ReactNode;
    return <Real {...props} />;
  }
  function StandIn(props: PaneProps) {
    useReportPaneSettled(true);
    return (
      <div
        data-open-file={props.filePath}
        data-anchor-lines={(props.lineAnchors ?? [])
          .map((a) => `${a.side}:${a.line}`)
          .join(",")}
      />
    );
  }
  return { DiffSurface: DiffContent, DiffContent };
});

Element.prototype.scrollIntoView = vi.fn();

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const BASE = "abcdef0123".repeat(4);
const HEAD = `b${BASE.slice(1)}`;
const PARENT = `c${BASE.slice(1)}`;
const GITHUB = {
  provider: "github",
  installed: true,
  authenticated: true,
} as unknown as ForgeStatus;

const edit = (p: string) =>
  `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`;
const RENAMED =
  "diff --git a/old/name.ts b/new/name.ts\nsimilarity index 90%\nrename from old/name.ts\nrename to new/name.ts\n--- a/old/name.ts\n+++ b/new/name.ts\n@@ -1 +1 @@\n-old\n+new\n";
/** git's order for a binary file turned into a symbolic link. */
const TYPECHANGE =
  "diff --git a/link b/link\ndeleted file mode 100644\nindex 1111111..0000000\nBinary files a/link and /dev/null differ\n" +
  "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target/path\n\\ No newline at end of file\n";
const BINARY =
  "diff --git a/img.bin b/img.bin\nindex 1111111..2222222 100644\nBinary files a/img.bin and b/img.bin differ\n";

/** Presence answers by the oid list asked: `true` / `false`, a pending
 *  promise, or a rejection. */
let presence: (oids: string[]) => Promise<boolean>;
const never = () => new Promise<boolean>(() => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(forgeFileAtSha).mockReset();
  vi.mocked(gitFileBase64).mockReset();
  panes.real = false;
  panes.props.clear();
  useFileFilterStore.setState({ texts: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(forgeCommitComments).mockResolvedValue([]);
  presence = async () => false;
  vi.mocked(gitObjectsPresent).mockImplementation(async (_r, oids) =>
    presence(oids),
  );
});
afterEach(cleanup);

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

// ------------------------------------------------------------ PR Files pane

interface FilesProps {
  sections: Record<string, string>;
  settled?: boolean;
  contentRevs?: PrContentRevs;
  onSelectPath?: (path: string) => void;
  /** The open file's diff is binary. */
  binary?: boolean;
}

function FilesHarness({
  sections,
  settled = true,
  contentRevs,
  onSelectPath = () => undefined,
  binary = false,
}: FilesProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const files = Object.keys(sections).map((path) => ({
    path,
    additions: 1,
    deletions: 1,
  }));
  const filter = useFileListFilter({
    ...FILE_FILTER_SURFACES["pr-files"],
    files,
    settled,
    picked,
    onPick: setPicked,
  });
  const open = filter.openPath;
  return (
    <PrFilesPane
      filter={filter}
      onSelectPath={onSelectPath}
      fileDiff={
        open
          ? {
              filePath: open,
              text: sections[open] ?? "",
              isBinary: binary,
              isTruncated: false,
            }
          : undefined
      }
      isPending={false}
      isError={false}
      isFetching={false}
      repoPath={REPO}
      lens="origin"
      number={7}
      blameRev={HEAD}
      contentRevs={contentRevs}
    />
  );
}

function renderFiles(props: FilesProps) {
  const qc = client();
  const ui = (p: FilesProps): ReactNode => (
    <QueryClientProvider client={qc}>
      <FilesHarness {...p} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { ...view, qc, update: (p: FilesProps) => view.rerender(ui(p)) };
}

const REVS: PrContentRevs = { oldSha: BASE, newSha: HEAD };
/** The Files slot's record: the lens and number. */
const FILES_SCOPE = "origin#7";
const pane = (path: string) => panes.props.get(path);
const pairAsked = () =>
  vi
    .mocked(gitObjectsPresent)
    .mock.calls.some(([, oids]) => oids.join() === `${BASE},${HEAD}`);

describe("PR Files: whole-file reads follow the presence of both commits", () => {
  it("reads this clone's objects when it holds both", async () => {
    presence = async (oids) => oids.length === 2;
    renderFiles({ sections: { "a.ts": edit("a.ts") }, contentRevs: REVS });
    await waitFor(() =>
      expect(pane("a.ts")?.forgePatch).toEqual({
        source: "local",
        scope: FILES_SCOPE,
      }),
    );
    expect(pane("a.ts")?.contentRevs).toEqual({ oldRev: BASE, newRev: HEAD });
    expect(pane("a.ts")?.imageRevs).toEqual({ old: BASE, new: HEAD });
    expect(pane("a.ts")?.typechangeAnchors).toBe(true);
    expect(forgeFileAtSha).not.toHaveBeenCalled();
  });

  it("reads through the forge under the lens when the clone lacks them", async () => {
    renderFiles({ sections: { "a.ts": edit("a.ts") }, contentRevs: REVS });
    await waitFor(() =>
      expect(pane("a.ts")?.forgePatch).toEqual({
        source: { lens: "origin" },
        scope: FILES_SCOPE,
      }),
    );
    expect(pane("a.ts")?.contentRevs).toEqual({ oldRev: BASE, newRev: HEAD });
    expect(pairAsked()).toBe(true);
  });

  it("passes no revs while the presence read is pending or failed, and marks a settled failure", async () => {
    presence = (oids) => (oids.length === 2 ? never() : Promise.resolve(false));
    const view = renderFiles({
      sections: { "a.ts": edit("a.ts") },
      contentRevs: REVS,
    });
    await waitFor(() => expect(pairAsked()).toBe(true));
    expect(pane("a.ts")?.contentRevs).toBeUndefined();
    expect(pane("a.ts")?.imageRevs).toBeUndefined();
    expect(pane("a.ts")?.forgePatch).toEqual({
      source: null,
      scope: FILES_SCOPE,
    });
    view.unmount();

    presence = (oids) =>
      oids.length === 2
        ? Promise.reject(new Error("probe failed"))
        : Promise.resolve(false);
    vi.mocked(gitObjectsPresent).mockClear();
    renderFiles({ sections: { "a.ts": edit("a.ts") }, contentRevs: REVS });
    await waitFor(() => expect(pairAsked()).toBe(true));
    // A failure that settled marks the pair unavailable.
    await waitFor(() =>
      expect(pane("a.ts")?.forgePatch).toEqual({
        source: null,
        scope: FILES_SCOPE,
        pairUnavailable: true,
      }),
    );
    expect(pane("a.ts")?.contentRevs).toBeUndefined();
  });

  it("keeps the pair's forge source once the clone holds both commits", async () => {
    // The real pane, so its whole-file reads are the ones the source names.
    panes.real = true;
    stubCanvas();
    vi.mocked(forgeFileAtSha).mockImplementation(async (_r, sha) => ({
      base64: btoa(sha === BASE ? "old\n" : "new\n"),
      mime: null,
      tooLarge: false,
      size: 4,
    }));
    const view = renderFiles({
      sections: { "a.ts": edit("a.ts") },
      contentRevs: REVS,
    });
    const forge = { source: { lens: "origin" }, scope: FILES_SCOPE };
    await waitFor(() => expect(pane("a.ts")?.forgePatch).toEqual(forge));
    // The real pane loads its chunk first.
    await waitFor(() => expect(forgeFileAtSha).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    // A fetch brings both commits in; every presence read re-asks.
    presence = async () => true;
    vi.mocked(gitObjectsPresent).mockClear();
    await act(() => view.qc.invalidateQueries());
    // The head's answer reaches the pane as its Preview rev.
    await waitFor(() => expect(pane("a.ts")?.previewRev).toBe(HEAD));
    await waitFor(() => expect(view.qc.isFetching()).toBe(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(pairAsked()).toBe(true);
    // No read moved to this clone's objects.
    expect(gitFileBase64).not.toHaveBeenCalled();
    expect(pane("a.ts")?.forgePatch).toEqual(forge);
    expect(pane("a.ts")?.contentRevs).toEqual({ oldRev: BASE, newRev: HEAD });
  }, 15_000);

  it("keeps an image's panes, never the binary band, while the revs go and come back", async () => {
    panes.real = true;
    stubCanvas();
    vi.mocked(forgeFileAtSha).mockImplementation(async () => ({
      base64: "iVBORw0KGgo=",
      mime: "image/png",
      tooLarge: false,
      size: 8,
    }));
    const PNG =
      "diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ\n";
    const props = {
      sections: { "img.png": PNG },
      contentRevs: REVS,
      binary: true,
    };
    const view = renderFiles(props);
    const figures = () => view.container.querySelectorAll("figure");
    await waitFor(() => expect(figures()).toHaveLength(2), { timeout: 10_000 });
    const [first, second] = figures();
    let lost = 0;
    const observer = new MutationObserver(() => {
      const now = figures();
      if (now.length !== 2 || now[0] !== first || now[1] !== second) lost++;
    });
    observer.observe(view.container, { childList: true, subtree: true });
    // A new head's revs are pending: the host hands the pane none.
    view.update({ ...props, contentRevs: undefined });
    await act(async () => undefined);
    expect(pane("img.png")?.imageRevs).toBeUndefined();
    view.update(props);
    await waitFor(() =>
      expect(pane("img.png")?.imageRevs).toEqual({ old: BASE, new: HEAD }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    observer.disconnect();
    expect(lost).toBe(0);
    expect(first.isConnected).toBe(true);
    expect(second.isConnected).toBe(true);
  }, 15_000);

  it("keeps an image's panes across a new head's pair, reading the new head", async () => {
    panes.real = true;
    stubCanvas();
    const HEAD2 = `d${BASE.slice(1)}`;
    const png = (base64: string) => ({
      base64,
      mime: "image/png",
      tooLarge: false,
      size: 8,
    });
    let headRead: (b: ReturnType<typeof png>) => void = () => undefined;
    vi.mocked(forgeFileAtSha).mockImplementation((_r, sha) =>
      sha === HEAD2
        ? new Promise((resolve) => {
            headRead = resolve;
          })
        : Promise.resolve(png("iVBORw0KGgo=")),
    );
    let pairPresent: (v: boolean) => void = () => undefined;
    presence = (oids) =>
      oids.join() === `${BASE},${HEAD2}`
        ? new Promise((resolve) => {
            pairPresent = resolve;
          })
        : Promise.resolve(false);
    const PNG =
      "diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ\n";
    const props = {
      sections: { "img.png": PNG },
      contentRevs: REVS,
      binary: true,
    };
    const view = renderFiles(props);
    const figures = () => view.container.querySelectorAll("figure");
    await waitFor(() => expect(figures()).toHaveLength(2), { timeout: 10_000 });
    const [first, second] = figures();
    let lost = 0;
    const observer = new MutationObserver(() => {
      const now = figures();
      if (now.length !== 2 || now[0] !== first || now[1] !== second) lost++;
    });
    observer.observe(view.container, { childList: true, subtree: true });
    // A push: the revs re-read, then the new pair's presence, then its read.
    view.update({ ...props, contentRevs: undefined });
    await act(async () => undefined);
    view.update({ ...props, contentRevs: { oldSha: BASE, newSha: HEAD2 } });
    await waitFor(() =>
      expect(
        vi
          .mocked(gitObjectsPresent)
          .mock.calls.some(([, oids]) => oids.join() === `${BASE},${HEAD2}`),
      ).toBe(true),
    );
    await act(async () => pairPresent(false));
    await waitFor(() =>
      expect(forgeFileAtSha).toHaveBeenCalledWith(
        REPO,
        HEAD2,
        "img.png",
        "origin",
        null,
      ),
    );
    await act(async () => headRead(png("iVBORw0KGgoAAAA=")));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    observer.disconnect();
    expect(lost).toBe(0);
    expect(
      view.container.querySelector('img[alt="New"]')?.getAttribute("src"),
    ).toBe("data:image/png;base64,iVBORw0KGgoAAAA=");
    expect(pane("img.png")?.forgePatch?.scope).toBe(FILES_SCOPE);
  }, 15_000);

  it("passes no revs and asks nothing without the pull request's revs", async () => {
    renderFiles({ sections: { "a.ts": edit("a.ts") } });
    await waitFor(() => expect(pane("a.ts")).toBeDefined());
    expect(pane("a.ts")?.contentRevs).toBeUndefined();
    expect(pairAsked()).toBe(false);
  });

  it("reads a renamed file's old side at its source path", async () => {
    renderFiles({ sections: { "new/name.ts": RENAMED }, contentRevs: REVS });
    await waitFor(() =>
      expect(pane("new/name.ts")?.data?.oldPath).toBe("old/name.ts"),
    );
  });

  it("keeps Markdown preview on the head-only gate under a forge source", async () => {
    // Head local, merge base not: the pair reads from the forge, and Preview
    // still takes the head from this clone.
    presence = async (oids) => oids.length === 1;
    renderFiles({ sections: { "doc.md": edit("doc.md") }, contentRevs: REVS });
    await waitFor(() =>
      expect(pane("doc.md")?.forgePatch).toEqual({
        source: { lens: "origin" },
        scope: FILES_SCOPE,
      }),
    );
    await waitFor(() => expect(pane("doc.md")?.previewRev).toBe(HEAD));

    // Head not local: no Preview rev, whatever the pair's source.
    presence = async () => false;
    cleanup();
    panes.props.clear();
    renderFiles({ sections: { "doc.md": edit("doc.md") }, contentRevs: REVS });
    await waitFor(() =>
      expect(pane("doc.md")?.forgePatch).toEqual({
        source: { lens: "origin" },
        scope: FILES_SCOPE,
      }),
    );
    expect(pane("doc.md")?.previewRev).toBeUndefined();
  });
});

describe("PR Files: rows of an unsettled list pick nothing", () => {
  it("ignores a click, arrows and Enter until the list settles", async () => {
    const user = userEvent.setup();
    const onSelectPath = vi.fn();
    const sections = { "a.ts": edit("a.ts"), "b.ts": edit("b.ts") };
    const view = renderFiles({ sections, settled: false, onSelectPath });
    const row = (p: string) =>
      document.querySelector<HTMLElement>(`button[data-path="${p}"]`);
    await waitFor(() => expect(row("b.ts")).not.toBeNull());
    await user.click(row("b.ts") as HTMLElement);
    act(() => row("a.ts")?.focus());
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(onSelectPath).not.toHaveBeenCalled();

    view.update({ sections, settled: true, onSelectPath });
    await user.click(row("b.ts") as HTMLElement);
    expect(onSelectPath).toHaveBeenCalledWith("b.ts");
    onSelectPath.mockClear();
    act(() => row("a.ts")?.focus());
    await user.keyboard("{ArrowDown}");
    expect(onSelectPath).toHaveBeenCalled();
  });
});

// ------------------------------------------------------- PR commit drill-in

const OID = HEAD;
/** The commit view's record: the lens and the commit. */
const COMMIT_SCOPE = `origin\0${OID}`;
const comment = (over: Partial<CommitCommentOut>): CommitCommentOut => ({
  id: "c1",
  author: "Ada",
  body: "a comment",
  createdAt: "2026-11-01T10:00:00Z",
  viewerDidAuthor: false,
  path: null,
  line: null,
  startLine: null,
  position: null,
  ...over,
});

function renderCommit(patch: string) {
  vi.mocked(forgePrCommitDiff).mockResolvedValue(patch);
  return render(
    <QueryClientProvider client={client()}>
      <PrCommitDetail
        repoPath={REPO}
        number={7}
        commit={{
          oid: OID,
          headline: "headline",
          date: "2026-11-01T10:00:00Z",
          author: "Ada",
          messageBody: "",
        }}
        onBack={() => undefined}
        canCommentCommits={false}
        remoteLabel="GitHub"
        lens="origin"
      />
    </QueryClientProvider>,
  );
}

describe("PR commit drill-in: whole-file reads at the first parent", () => {
  it("reads this clone's objects at oid~1 when the commit is local", async () => {
    presence = async () => true;
    renderCommit(edit("a.ts"));
    await waitFor(() =>
      expect(pane("a.ts")?.forgePatch).toEqual({
        source: "local",
        scope: COMMIT_SCOPE,
      }),
    );
    expect(pane("a.ts")?.contentRevs).toEqual({
      oldRev: `${OID}~1`,
      newRev: OID,
    });
    expect(pane("a.ts")?.imageRevs).toEqual({ old: `${OID}~1`, new: OID });
    expect(pane("a.ts")?.typechangeAnchors).toBe(true);
    expect(forgeCommitFirstParent).not.toHaveBeenCalled();
  });

  it("reads the forge at the forge's first parent when it isn't", async () => {
    vi.mocked(forgeCommitFirstParent).mockResolvedValue(PARENT);
    renderCommit(edit("a.ts"));
    await waitFor(() =>
      expect(pane("a.ts")?.contentRevs).toEqual({
        oldRev: PARENT,
        newRev: OID,
      }),
    );
    expect(pane("a.ts")?.imageRevs).toEqual({ old: PARENT, new: OID });
    expect(pane("a.ts")?.forgePatch).toEqual({
      source: { lens: "origin" },
      scope: COMMIT_SCOPE,
    });
    expect(forgeCommitFirstParent).toHaveBeenCalledWith(REPO, OID, "origin");
  });

  it("gives a forge-read root commit only its new side, and no images", async () => {
    vi.mocked(forgeCommitFirstParent).mockResolvedValue(null);
    renderCommit(edit("a.ts"));
    await waitFor(() =>
      expect(pane("a.ts")?.contentRevs).toEqual({ newRev: OID }),
    );
    expect(pane("a.ts")?.imageRevs).toBeUndefined();
  });

  it("passes no revs while presence or the parent read is unsettled", async () => {
    presence = never;
    renderCommit(edit("a.ts"));
    await waitFor(() => expect(pane("a.ts")).toBeDefined());
    expect(pane("a.ts")?.contentRevs).toBeUndefined();
    expect(pane("a.ts")?.forgePatch).toEqual({
      source: null,
      scope: COMMIT_SCOPE,
    });
    cleanup();
    panes.props.clear();

    presence = async () => false;
    vi.mocked(forgeCommitFirstParent).mockImplementation(
      () => new Promise(() => undefined),
    );
    renderCommit(edit("a.ts"));
    await waitFor(() => expect(forgeCommitFirstParent).toHaveBeenCalled());
    expect(pane("a.ts")?.contentRevs).toBeUndefined();
  });

  it("reads a renamed file's old side at its source path", async () => {
    presence = async () => true;
    renderCommit(RENAMED);
    await waitFor(() =>
      expect(pane("new/name.ts")?.data?.oldPath).toBe("old/name.ts"),
    );
  });

  it("draws inline only the comments on lines the patch draws", async () => {
    presence = async () => true;
    vi.mocked(forgeCommitComments).mockResolvedValue([
      comment({ id: "in", body: "on the change", path: "a.ts", line: 1 }),
      comment({ id: "off", body: "on a gap line", path: "a.ts", line: 20 }),
    ]);
    renderCommit(edit("a.ts"));
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-open-file]")
          ?.getAttribute("data-anchor-lines"),
      ).toBe("new:1"),
    );
    // The gap-line comment stays in the list below, once.
    expect(await screen.findAllByText("on a gap line")).toHaveLength(1);
    expect(screen.queryByText("on the change")).toBeNull();
  });

  it("anchors a typechange's link-line comment inline, never also in the list", async () => {
    presence = async () => true;
    vi.mocked(forgeCommitComments).mockResolvedValue([
      comment({ id: "l", body: "on the link", path: "link", line: 1 }),
    ]);
    renderCommit(TYPECHANGE);
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-open-file]")
          ?.getAttribute("data-anchor-lines"),
      ).toBe("new:1"),
    );
    await act(async () => undefined);
    expect(screen.queryByText("on the link")).toBeNull();
  });

  it("still lists a plain binary file's anchored comments", async () => {
    presence = async () => true;
    vi.mocked(forgeCommitComments).mockResolvedValue([
      comment({ id: "b", body: "on the binary", path: "img.bin", line: 1 }),
    ]);
    renderCommit(BINARY);
    expect(await screen.findByText("on the binary")).toBeInTheDocument();
  });
});
