import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_FILTER_SURFACES,
  useFileFilterStore,
  useFileListFilter,
} from "@/components/use-file-list-filter";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import type { SuggestionApply } from "@/features/pulls/ReviewThreads";
import { forgeStatus, gitObjectsPresent } from "@/lib/git/api";
import type { FileDiff, ForgeStatus, ReviewThreadOut } from "@/lib/git/types";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

// The Files pane's anchors are placements whose bodies read the slot's live
// items and handlers. The stand-in pane draws each anchor's body; with `hold`
// set it keeps the first anchor list it drew, as a held paint does. It names
// the placements it was handed in `data-anchor-lines`, since a placement whose
// items resolve to nothing draws no row.

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
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
const panes = vi.hoisted(() => ({
  hold: false,
  removed: [] as string[],
}));
vi.mock("@/features/diff/DiffSurfaceLazy", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/diff/DiffSurfaceLazy")>();
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffContent(props: {
    filePath: string;
    lineAnchors?: DiffLineAnchor[];
    renderAnchor?: (anchor: DiffLineAnchor) => ReactNode;
  }) {
    useReportPaneSettled(true);
    const live = props.lineAnchors ?? [];
    const [first] = useState(live);
    const drawn = panes.hold ? first : live;
    return (
      <div
        data-open-file={props.filePath}
        data-anchor-lines={live.map((a) => `${a.side}:${a.line}`).join(",")}
      >
        {drawn.map((a) => {
          const body = props.renderAnchor?.(a) ?? null;
          return body === null ? null : (
            <div
              key={`${a.side}:${a.line}`}
              data-anchor={`${a.side}:${a.line}`}
            >
              {body}
            </div>
          );
        })}
      </div>
    );
  }
  return { ...real, DiffSurface: DiffContent, DiffContent };
});
vi.mock("@/features/pulls/ReviewThreads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/pulls/ReviewThreads")>()),
  ReviewThreadCard: ({
    thread,
    apply,
  }: {
    thread: ReviewThreadOut;
    apply?: SuggestionApply;
  }) => (
    <p>
      {`Thread ${thread.id}${thread.isOutdated ? " outdated" : ""}, ${thread.comments.length} comments, on ${apply?.currentBranch ?? "none"}`}
    </p>
  ),
}));
vi.mock("@/features/pulls/PendingReviewBar", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/pulls/PendingReviewBar")
  >()),
  DraftCommentCard: ({
    draft,
    number,
  }: {
    draft: ReviewDraft;
    number: number;
  }) => (
    <button
      type="button"
      onClick={() => panes.removed.push(`${number}:${draft.id}`)}
    >
      {`Delete pending comment ${draft.id} of #${number}`}
    </button>
  ),
}));
Element.prototype.scrollIntoView = vi.fn();

const REPO = "/repo";
const PATH = "src/a.ts";
const OLDER = "@@ -1,2 +1,2 @@\n-a\n+b\n c\n";
const NEWER = "@@ -1,3 +1,3 @@\n-a\n+b\n c\n+d\n";
const GITHUB = {
  provider: "github",
  ghAvailable: true,
  authenticated: true,
  remote: { host: "github.com", owner: "o", name: "r", url: "" },
} as unknown as ForgeStatus;

const thread = (
  id: string,
  line: number,
  extra: Partial<ReviewThreadOut> = {},
): ReviewThreadOut =>
  ({
    id,
    path: PATH,
    line,
    side: "new",
    isOutdated: false,
    isResolved: false,
    comments: [{ id: `${id}-c1` }],
    ...extra,
  }) as unknown as ReviewThreadOut;
const draft = (id: string, line: number): ReviewDraft =>
  ({ id, path: PATH, line, side: "new", body: "draft" }) as ReviewDraft;
const apply = (currentBranch: string) =>
  ({
    headRefName: "feature",
    currentBranch,
    onApply: async () => undefined,
  }) as unknown as SuggestionApply;

interface Frame {
  number: number;
  text: string;
  placeholder?: boolean;
  threads?: ReviewThreadOut[];
  drafts?: ReviewDraft[];
  apply?: SuggestionApply;
}

function Harness({ frame }: { frame: Frame }) {
  const [picked, setPicked] = useState<string | null>(null);
  const filter = useFileListFilter({
    ...FILE_FILTER_SURFACES["pr-files"],
    files: [{ path: PATH, additions: 1, deletions: 1 }],
    settled: true,
    picked,
    onPick: setPicked,
  });
  const open = filter.openPath;
  const data: FileDiff | undefined = open
    ? { filePath: open, text: frame.text, isBinary: false, isTruncated: false }
    : undefined;
  return (
    <PrFilesPane
      filter={filter}
      onSelectPath={() => undefined}
      fileDiff={data}
      isPending={false}
      isError={false}
      isFetching={false}
      dataIsPlaceholder={frame.placeholder ?? false}
      repoPath={REPO}
      lens="origin"
      number={frame.number}
      threads={frame.threads}
      drafts={frame.drafts}
      apply={frame.apply}
    />
  );
}

function mount(frame: Frame) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (f: Frame): ReactNode => (
    <QueryClientProvider client={qc}>
      <Harness frame={f} />
    </QueryClientProvider>
  );
  const view = render(ui(frame));
  return { ...view, update: (f: Frame) => view.rerender(ui(f)) };
}

beforeEach(() => {
  panes.hold = false;
  panes.removed = [];
  useFileFilterStore.setState({ texts: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
});
afterEach(cleanup);

describe("PR Files anchors under a placeholder patch", () => {
  it("draws no card of the pull request it left under another's placeholder", async () => {
    const view = mount({ number: 7, text: OLDER, drafts: [draft("d1", 1)] });
    await screen.findByText("Delete pending comment d1 of #7");
    // Another pull request sharing the path: its details are ready, its patch
    // is still the one before, as a placeholder.
    view.update({ number: 8, text: OLDER, placeholder: true, drafts: [] });
    await waitFor(() =>
      expect(screen.queryByText(/Delete pending comment/)).toBeNull(),
    );
    expect(view.container.querySelector("[data-anchor]")).toBeNull();
    // The host hands the placeholder frame none of #7's placements.
    expect(
      view.container
        .querySelector("[data-open-file]")
        ?.getAttribute("data-anchor-lines"),
    ).toBe("");
    expect(panes.removed).toEqual([]);
  });

  it("keeps an older head's placements, never a newer head's, until its patch lands", async () => {
    const seeded = thread("t1", 1);
    const view = mount({ number: 7, text: OLDER, threads: [seeded] });
    await screen.findByText(/^Thread t1,/);
    // The threads refresh before the patch of the head they name.
    view.update({
      number: 7,
      text: OLDER,
      placeholder: true,
      threads: [seeded, thread("t2", 3)],
    });
    await waitFor(() => expect(screen.getByText(/^Thread t1,/)).toBeTruthy());
    expect(screen.queryByText(/^Thread t2,/)).toBeNull();
    view.update({
      number: 7,
      text: NEWER,
      threads: [seeded, thread("t2", 3)],
    });
    expect(await screen.findByText(/^Thread t2,/)).toBeTruthy();
    expect(screen.getByText(/^Thread t1,/)).toBeTruthy();
  });
});

describe("PR Files anchors held by the diff", () => {
  it("render the slot's live thread and Apply wiring", async () => {
    panes.hold = true;
    const t1 = thread("t1", 1);
    const view = mount({
      number: 7,
      text: OLDER,
      threads: [t1],
      apply: apply("feature"),
    });
    await screen.findByText("Thread t1, 1 comments, on feature");
    // A reply lands and the branch moves while the rows are held.
    view.update({
      number: 7,
      text: OLDER,
      threads: [
        thread("t1", 1, {
          comments: [{ id: "c1" }, { id: "c2" }],
        } as Partial<ReviewThreadOut>),
      ],
      apply: apply("other"),
    });
    expect(
      await screen.findByText("Thread t1, 2 comments, on other"),
    ).toBeTruthy();
  });

  it("keep a thread that went outdated on its held row, shown as the live thread", async () => {
    panes.hold = true;
    const view = mount({ number: 7, text: OLDER, threads: [thread("t1", 1)] });
    await screen.findByText(/^Thread t1,/);
    view.update({
      number: 7,
      text: OLDER,
      threads: [thread("t1", 1, { isOutdated: true })],
    });
    expect(await screen.findByText(/^Thread t1 outdated,/)).toBeTruthy();
  });

  it("draw nothing for a held row once the slot lists none of its items", async () => {
    panes.hold = true;
    const view = mount({ number: 7, text: OLDER, threads: [thread("t1", 1)] });
    await screen.findByText(/^Thread t1,/);
    view.update({ number: 7, text: OLDER, threads: [] });
    await waitFor(() =>
      expect(view.container.querySelector("[data-anchor]")).toBeNull(),
    );
    expect(screen.queryByText(/^Thread t1/)).toBeNull();
  });
});
