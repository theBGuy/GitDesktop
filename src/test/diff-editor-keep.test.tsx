import { type DiffFile, multiSelectClassNames } from "@git-diff-view/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createContext,
  createRef,
  Profiler,
  type RefObject,
  use,
  useState,
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
import { Thread } from "@/features/conversations/Thread";
import { DIFF_LINE_CAP, DIFF_MEGA_LINE_CHARS } from "@/features/diff/cap-diff";
import {
  createDiffFile,
  type DiffContentRevs,
  type DiffLineAnchor,
  GitDiffView,
  type LineWidget,
} from "@/features/diff/DiffSurface";
import { captureLineAnchor } from "@/features/diff/diff-rows";
import {
  createEditorKeep,
  KeptRow,
  LINE_COMPOSER_KEEP_ID,
  useDiffRowsHeld,
  useKeptDraft,
  useKeptOpen,
} from "@/features/diff/editor-keep";
import { DIFF_ROWS_HELD_REASON } from "@/features/diff/whitespace-mode";
import {
  COMMIT_LOADING_REASON,
  CommitLineComposer,
} from "@/features/pulls/CommitComments";
import { DraftCommentCard } from "@/features/pulls/PendingReviewBar";
import { DiffThreadAnchor } from "@/features/pulls/RemotePrViewParts";
import { ReviewThreadCard } from "@/features/pulls/ReviewThreads";
import { TabPanel } from "@/features/repository/TabPanel";
import { gitFileBase64 } from "@/lib/git/api";
import type { PrThreadOut, ReviewThreadOut } from "@/lib/git/types";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { bodies, renderBody } from "./anchor-bodies";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
const writes = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let draftPending = false;
  return {
    draft: vi.fn(async (_vars: unknown) => undefined),
    commit: vi.fn(async (_vars: unknown) => undefined),
    /** The draft update's `isPending`, flipped by a test as its write runs. */
    draftPending: () => draftPending,
    setDraftPending(next: boolean) {
      draftPending = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock("@/lib/pulls/review-drafts", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@/lib/pulls/review-drafts")>()),
    useUpdateReviewDraft: () => ({
      mutateAsync: writes.draft,
      isPending: useSyncExternalStore(writes.subscribe, writes.draftPending),
    }),
    useRemoveReviewDraft: () => ({
      mutateAsync: async () => undefined,
      isPending: false,
    }),
  };
});
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitFileBase64: vi.fn(),
}));
vi.mock("@/lib/git/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/host")>()),
  useForgeGhHost: () => undefined,
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useForgeStatus: () => ({ data: undefined }),
  useCreateCommitComment: () => ({
    mutateAsync: writes.commit,
    isPending: false,
  }),
}));

beforeAll(stubCanvas);
afterEach(cleanup);
Element.prototype.scrollIntoView ??= () => undefined;

const PATH = "src/keep.txt";
const diffOf = (two: string) =>
  `${[
    `diff --git a/${PATH} b/${PATH}`,
    `--- a/${PATH}`,
    `+++ b/${PATH}`,
    "@@ -1,6 +1,6 @@",
    " keep 1",
    "-old 2",
    `+${two}`,
    " keep 3",
    " keep 4",
    " keep 5",
    " keep 6",
  ].join("\n")}\n`;
const TEXT = diffOf("new 2");

// What the anchor row on new line 3 renders, steered from the test.
const RowState = createContext({ expanded: true, standIn: false, reply: true });

function ReplySlot() {
  return use(RowState).reply ? <TestReply /> : null;
}

const thread: PrThreadOut = {
  author: "ada",
  authorAvatarUrl: "",
  state: "",
  body: "Original words",
  date: "2026-11-01T10:00:00Z",
  id: "c1",
  url: "",
  viewerDidAuthor: true,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
};

/** A Reply box shaped like ReviewThreadCard's: kept only while it shows. */
function TestReply() {
  const { expanded } = use(RowState);
  const id = "reply:t1";
  const reopened = useKeptOpen(id);
  const [open, setOpen] = useState(reopened);
  const kept = useKeptDraft(expanded && open ? id : null);
  if (!expanded) return null;
  return open ? (
    <div data-diff-editor="">
      <textarea
        aria-label="Reply"
        value={kept.text}
        onChange={(e) => kept.setText(e.target.value)}
      />
      <button
        type="button"
        onClick={() => {
          kept.forget();
          setOpen(false);
        }}
      >
        Close reply
      </button>
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)}>
      Reply…
    </button>
  );
}

function StandIn() {
  const { standIn } = use(RowState);
  return standIn ? <div data-diff-editor="">unadopted</div> : null;
}

const saveEdit = vi.fn(async (_body: string) => true);
const draft: ReviewDraft = {
  id: "d1",
  path: PATH,
  line: 3,
  side: "new",
  body: "Draft words",
  createdAt: "2026-11-01T10:00:00Z",
};

const anchorAt = (line: number): DiffLineAnchor[] =>
  bodies([
    {
      side: "new",
      line,
      ids: ["edit:c1", "reply:t1", "draft:d1"],
      render: () => (
        <>
          <Thread thread={thread} onSaveEdit={saveEdit} />
          <ReplySlot />
          <StandIn />
          <DraftCommentCard
            repoPath="C:/repo"
            lens="origin"
            number={1}
            draft={draft}
          />
        </>
      ),
    },
  ]);
const ANCHORS = anchorAt(3);

function TestComposer({ line }: { line: number }) {
  const { text, setText, restored, setBusy } = useKeptDraft(
    LINE_COMPOSER_KEEP_ID,
  );
  const held = useDiffRowsHeld();
  return (
    <>
      <textarea
        aria-label={`Comment on ${line}`}
        aria-description={held ? "rows held" : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus={!restored}
      />
      <button type="button" onClick={() => setBusy(true)}>
        Busy
      </button>
      <button type="button" onClick={() => setBusy(false)}>
        Idle
      </button>
    </>
  );
}

const widget: LineWidget = {
  enabled: true,
  render: ({ line }) => <TestComposer line={line} />,
};

let client: QueryClient;
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    diffViewMode: "split" as const,
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: "split" as const,
  });
});

interface ViewProps {
  narrow: boolean;
  text?: string;
  active?: boolean;
  expanded?: boolean;
  standIn?: boolean;
  /** A keep scope: a rebuild under it is judged rather than dropped. */
  scope?: string;
  anchors?: DiffLineAnchor[];
  reply?: boolean;
  lineWidget?: LineWidget;
  /** History's shape: the record comes from the revisions alone. */
  revs?: DiffContentRevs;
  /** With `revs`, the repo whose whole files content mode reads. */
  repo?: string;
  scroller?: RefObject<HTMLDivElement | null>;
}

function view({
  narrow,
  text = TEXT,
  active = true,
  expanded = true,
  standIn = false,
  scope,
  anchors = ANCHORS,
  reply = true,
  lineWidget = widget,
  revs,
  repo,
  scroller,
}: ViewProps) {
  return (
    <QueryClientProvider client={client}>
      <button type="button">outside</button>
      <TabPanel active={active}>
        <RowState value={{ expanded, standIn, reply }}>
          <div ref={scroller} data-testid="scroller">
            <GitDiffView
              filePath={PATH}
              text={text}
              forceUnified={narrow}
              lineWidget={lineWidget}
              lineAnchors={anchors}
              renderAnchor={renderBody}
              contentRevs={revs}
              repoPath={repo}
              scrollerRef={scroller}
              forgePatch={
                scope === undefined ? undefined : { source: null, scope }
              }
            />
          </div>
        </RowState>
      </TabPanel>
    </QueryClientProvider>
  );
}

const splitRows = () =>
  document.querySelectorAll("td[data-side] span[data-line-num]").length;
const composer = (line: number) =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", {
    name: `Comment on ${line}`,
  });
const anyComposer = () =>
  screen.queryAllByRole("textbox", { name: /^Comment on / });

/** The unified gutter's number cell of new `line`, once it is drawn. */
const gutter = (line: number) =>
  waitFor(() => {
    const cell = document
      .querySelector(`span[data-line-new-num="${line}"]`)
      ?.closest(".diff-line-num");
    expect(cell).toBeTruthy();
    return cell as HTMLElement;
  });

/** Opens the line composer from the unified gutter's "+" on new `line`. */
async function openComposer(line: number, name = `Comment on ${line}`) {
  const num = await gutter(line);
  fireEvent.mouseOver(num);
  fireEvent.mouseDown(
    num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
  );
  return waitFor(() => {
    const box = screen.queryByRole<HTMLTextAreaElement>("textbox", { name });
    expect(box).toBeTruthy();
    return box as HTMLTextAreaElement;
  });
}

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

describe("in-diff editors across a layout swap", () => {
  it("A1-1 K1: the line composer comes back on its line with its text, both ways", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    const box = await openComposer(2);
    await user.type(box, "kept");
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(composer(2)).toHaveValue("kept");
    expect(anyComposer()).toHaveLength(1);
    await act(async () => rerender(view({ narrow: true })));
    await settle();
    expect(splitRows()).toBe(0);
    expect(composer(2)).toHaveValue("kept");
  });

  it("A1-9: typing in a kept composer leaves the table's rows in place", async () => {
    const user = userEvent.setup();
    render(view({ narrow: true }));
    const box = await openComposer(2);
    const row = document.querySelector('span[data-line-new-num="1"]');
    await user.type(box, "abc");
    expect(document.querySelector('span[data-line-new-num="1"]')).toBe(row);
  });

  it("A1-1 K2: a comment edit open in an anchor row keeps its text", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.click(
      await screen.findByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const box = await screen.findByRole("textbox", { name: "Edit comment" });
    await user.clear(box);
    await user.type(box, "Revised");
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "Revised",
    );
  });

  it("A1-1 K3: an open Reply keeps its text, and widening back keeps it again", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    const reply = () => screen.getByRole("textbox", { name: "Reply" });
    await user.type(reply(), "hello");
    const narrowBox = reply();
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(reply()).not.toBe(narrowBox);
    expect(reply()).toHaveValue("hello");
    const wideBox = reply();
    await act(async () => rerender(view({ narrow: true })));
    await settle();
    expect(splitRows()).toBe(0);
    expect(reply()).not.toBe(wideBox);
    expect(reply()).toHaveValue("hello");
  });

  it("A1-5: an editor the keep cannot place holds the layout until it goes", async () => {
    const { rerender } = render(view({ narrow: true, standIn: true }));
    await screen.findByText("unadopted");
    await act(async () => rerender(view({ narrow: false, standIn: true })));
    await settle();
    expect(splitRows()).toBe(0);
    expect(screen.getByText("unadopted")).toBeInTheDocument();
    await act(async () => rerender(view({ narrow: false, standIn: false })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
  });

  it("A1-8: a composer that had focus takes it back; one that did not leaves it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    const box = await openComposer(2);
    await user.type(box, "x");
    expect(document.activeElement).toBe(box);
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    const back = composer(2);
    expect(back).not.toBe(box);
    expect(document.activeElement).toBe(back);
    expect(back?.selectionStart).toBe(1);
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    await act(async () => rerender(view({ narrow: true })));
    await settle();
    expect(composer(2)).toHaveValue("x");
    expect(document.activeElement).toBe(outside);
  });

  it("A1-17 (i): a widget moved to another line replaces the record", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.type(await openComposer(2), "two");
    const five = await openComposer(5);
    await user.type(five, "five");
    expect(composer(2)).toBeNull();
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    expect(anyComposer()).toHaveLength(1);
    expect(composer(5)).toHaveValue("five");
    expect(composer(2)).toBeNull();
  });

  it("A1-17 (ii): a Reply collapsed under its row forgets its record", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "gone");
    await act(async () => rerender(view({ narrow: true, expanded: false })));
    await settle();
    await act(async () => rerender(view({ narrow: false, expanded: true })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reply…" })).toBeInTheDocument();
  });

  it("a new build drops every record: no kept text seeds the next composer", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.type(await openComposer(2), "stale");
    await act(async () =>
      rerender(view({ narrow: true, text: diffOf("newer 2") })),
    );
    await settle();
    await waitFor(() => expect(composer(2)).toBeNull());
    const again = await openComposer(2);
    expect(again).toHaveValue("");
  });

  it("A1-1 K4: a pending draft's edit keeps its text", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.click(
      await screen.findByRole("button", { name: "Edit pending comment" }),
    );
    const box = screen.getByRole("textbox", { name: "Edit pending comment" });
    await user.clear(box);
    await user.type(box, "Draft revised");
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(
      screen.getByRole("textbox", { name: "Edit pending comment" }),
    ).toHaveValue("Draft revised");
  });

  it("A1-8: a restored edit that did not have focus leaves it where it was", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.click(
      await screen.findByRole("button", { name: "Edit pending comment" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Edit pending comment" }),
      "!",
    );
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(
      screen.getByRole("textbox", { name: "Edit pending comment" }),
    ).toHaveValue("Draft words!");
    expect(document.activeElement).toBe(outside);
  });

  it("A1-17 (iii): a handed-over record no editor re-claims is gone", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "lost");
    // The new rows draw the row without its Reply, so nothing re-claims it.
    await act(async () => rerender(view({ narrow: false, reply: false })));
    await settle();
    await act(async () => rerender(view({ narrow: false })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reply…" })).toBeInTheDocument();
  });
});

const HEAD = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n`;
/** TEXT with its line 5 edited: lines 1-4 read as before. */
const FIVE_EDITED = `${HEAD}@@ -1,6 +1,6 @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n-keep 5\n+five\n keep 6\n`;
const SCOPE = "pr-1";

describe("in-diff editors across a text rebuild", () => {
  it("A1-2: a rebuild that keeps the line and its neighbours restores the composer", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    const box = await openComposer(2);
    await user.type(box, "kept");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: FIVE_EDITED })),
    );
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    const back = composer(2);
    expect(back).toHaveValue("kept");
    expect(back).not.toBe(box);
    expect(back).not.toHaveAccessibleDescription("rows held");
  });

  it("A1-3: a rebuild that changed the line holds the older rows, with the composer's submits held", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    const box = await openComposer(2);
    await user.type(box, "kept");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: diffOf("newer 2") })),
    );
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("newer 2");
    expect(box).toHaveAccessibleDescription("rows held");
  });

  it("A1-4: another record's rows paint with no composer and no kept text", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    await user.type(await openComposer(2), "stale");
    await act(async () =>
      rerender(view({ narrow: true, scope: "pr-2", text: FIVE_EDITED })),
    );
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(anyComposer()).toHaveLength(0);
    expect(await openComposer(2)).toHaveValue("");
  });

  it("A1-5 (text): an editor the keep cannot place holds a rebuild until it goes", async () => {
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, standIn: true }),
    );
    await screen.findByText("unadopted");
    await act(async () =>
      rerender(
        view({ narrow: true, scope: SCOPE, standIn: true, text: FIVE_EDITED }),
      ),
    );
    await settle();
    expect(document.body.textContent).not.toContain("five");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: FIVE_EDITED })),
    );
    await settle();
    expect(document.body.textContent).toContain("five");
  });

  it("A1-6: a submit in flight holds the rebuild; settling re-runs the decision", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    await user.type(await openComposer(2), "kept");
    await user.click(screen.getByRole("button", { name: "Busy" }));
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: FIVE_EDITED })),
    );
    await settle();
    expect(document.body.textContent).not.toContain("five");
    await user.click(screen.getByRole("button", { name: "Idle" }));
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(composer(2)).toHaveValue("kept");
  });

  it("A1-7: a second build during a hold is judged afresh", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    await user.type(await openComposer(2), "kept");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: diffOf("newer 2") })),
    );
    await settle();
    expect(document.body.textContent).not.toContain("newer 2");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: FIVE_EDITED })),
    );
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(composer(2)).toHaveValue("kept");
  });

  it("A1-11: an edit the rebuild unplaced still saves once, and closing it paints the new rows", async () => {
    saveEdit.mockClear();
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    await user.click(
      await screen.findByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const box = await screen.findByRole("textbox", { name: "Edit comment" });
    await user.type(box, " more");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: diffOf("newer 2") })),
    );
    await settle();
    expect(document.body.textContent).not.toContain("newer 2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saveEdit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.body.textContent).toContain("newer 2"));
  });

  it("A1-12 + A1-15: a thread moved off an open Reply's row holds the row; a composer stays live", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    const reply = screen.getByRole("textbox", { name: "Reply" });
    await user.type(reply, "typed");
    const box = await openComposer(2);
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, anchors: anchorAt(5) })),
    );
    await settle();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
    expect(reply).toHaveValue("typed");
    expect(box).not.toHaveAccessibleDescription("rows held");
    await user.click(screen.getByRole("button", { name: "Close reply" }));
    await settle();
    const moved = await waitFor(() => {
      const button = screen.getByRole("button", { name: "Reply…" });
      expect(
        button.closest("tr")?.previousElementSibling?.textContent,
      ).toContain("keep 5");
      return button;
    });
    expect(moved).toBeInTheDocument();
  });

  it("A1-14: a layout swap held for an unplaced editor leaves the composer live", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, standIn: true }),
    );
    const box = await openComposer(2);
    await user.type(box, "live");
    await act(async () =>
      rerender(view({ narrow: false, scope: SCOPE, standIn: true })),
    );
    await settle();
    expect(splitRows()).toBe(0);
    expect(box).not.toHaveAccessibleDescription("rows held");
  });

  it("A1-18: a duplicate neighbour shifted by an insert above holds", async () => {
    const dup = `${HEAD}@@ -1,4 +1,4 @@\n keep 1\n-old 2\n+same\n same\n keep 4\n`;
    const inserted = `${HEAD}@@ -1,4 +1,5 @@\n keep 1\n+added\n-old 2\n+same\n same\n keep 4\n`;
    const user = userEvent.setup();
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, text: dup }),
    );
    const box = await openComposer(3);
    await user.type(box, "dup");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: inserted })),
    );
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("added");
  });

  it("A1-18 + A10: a composer on the file's first line restores across a layout swap and a text rebuild", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    const box = await openComposer(1);
    await user.type(box, "first");
    await act(async () => rerender(view({ narrow: false, scope: SCOPE })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(composer(1)).toHaveValue("first");
    const shown = composer(1) as HTMLTextAreaElement;
    await act(async () =>
      rerender(view({ narrow: false, scope: SCOPE, text: FIVE_EDITED })),
    );
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(composer(1)).toHaveValue("first");
    expect(composer(1)).not.toBe(shown);
  });

  it("A1 (placeholder): a gap placeholder above the line never matches a real blank line", async () => {
    const gap = `${HEAD}@@ -5,3 +5,3 @@\n line 5\n-old 6\n+new 6\n line 7\n`;
    const blank = `${HEAD}@@ -4,4 +4,4 @@\n-old 4\n+\n line 5\n-old 6\n+new 6\n line 7\n`;
    const user = userEvent.setup();
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, text: gap }),
    );
    const box = await openComposer(5);
    await user.type(box, "gap");
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: blank })),
    );
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("old 4");
  });
});

const cardThread = (id: string, resolved: boolean): ReviewThreadOut => ({
  id,
  reviewId: "",
  path: PATH,
  line: 3,
  startLine: 0,
  side: "new",
  isResolved: resolved,
  isOutdated: false,
  diffHunk: "",
  comments: [{ ...thread, id: `N_${id}`, body: "Card words" }],
});
const onCardReply = vi.fn(async (_id: string, _body: string) => undefined);
const onCardEdit = vi.fn(async (_id: string, _body: string) => true);
const RESOLVED = cardThread("T_8", true);
const resolvedAnchors: DiffLineAnchor[] = bodies([
  {
    side: "new",
    line: 3,
    ids: ["reply:T_8", "edit:N_T_8"],
    render: () => (
      <DiffThreadAnchor
        threads={[RESOLVED]}
        onReply={onCardReply}
        onEditComment={onCardEdit}
      />
    ),
  },
]);
const OPEN_CARD = cardThread("T_9", false);
function CardSlot() {
  const { reply } = use(RowState);
  return (
    <ReviewThreadCard
      thread={OPEN_CARD}
      compact
      expanded
      onToggleExpand={() => undefined}
      onReply={reply ? onCardReply : undefined}
    />
  );
}
const cardAnchors: DiffLineAnchor[] = bodies([
  { side: "new", line: 3, ids: ["reply:T_9"], render: () => <CardSlot /> },
]);
const REPLY_BOX = { name: "Reply to review thread" };

async function expandResolved() {
  const user = userEvent.setup();
  const header = await waitFor(() => {
    const node = document.querySelector('[data-thread-id="T_8"]');
    expect(node).toBeTruthy();
    return node as HTMLElement;
  });
  await user.click(header);
  return user;
}

describe("fix round: kept editors", () => {
  it("F1: a Reply open in an expanded resolved thread comes back with its text", async () => {
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, anchors: resolvedAnchors }),
    );
    const user = await expandResolved();
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", REPLY_BOX), "resolved reply");
    await act(async () =>
      rerender(view({ narrow: false, scope: SCOPE, anchors: resolvedAnchors })),
    );
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", REPLY_BOX)).toHaveValue(
      "resolved reply",
    );
  });

  it("F1: a comment edit open in an expanded resolved thread comes back with its text", async () => {
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, anchors: resolvedAnchors }),
    );
    const user = await expandResolved();
    await user.click(
      await screen.findByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Edit comment" }),
      " revised",
    );
    await act(async () =>
      rerender(view({ narrow: false, scope: SCOPE, anchors: resolvedAnchors })),
    );
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "Card words revised",
    );
  });

  it("F2: a record move over the same build lets another record's anchors through", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: "pr-3" }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "three");
    await act(async () =>
      rerender(view({ narrow: true, scope: "pr-4", anchors: anchorAt(5) })),
    );
    await settle();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Reply…" });
      expect(
        button.closest("tr")?.previousElementSibling?.textContent,
      ).toContain("keep 5");
    });
  });

  it("F2: no editor carries into another record's rows of the same text", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: "pr-3" }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "three");
    await user.type(await openComposer(2), "three");
    await act(async () => rerender(view({ narrow: true, scope: "pr-4" })));
    await settle();
    expect(anyComposer()).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  });

  it("F2: a push on the record moved to keeps its composer", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: "pr-3" }));
    await act(async () => rerender(view({ narrow: true, scope: "pr-4" })));
    await settle();
    await user.type(await openComposer(2), "four");
    await act(async () =>
      rerender(view({ narrow: true, scope: "pr-4", text: FIVE_EDITED })),
    );
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(composer(2)).toHaveValue("four");
  });

  it("F3: a Reply remounted while replies are withheld never opens empty later", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      view({ narrow: true, scope: SCOPE, anchors: cardAnchors }),
    );
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", REPLY_BOX), "withheld");
    await act(async () =>
      rerender(
        view({
          narrow: false,
          scope: SCOPE,
          anchors: cardAnchors,
          reply: false,
        }),
      ),
    );
    await settle();
    await act(async () =>
      rerender(view({ narrow: false, scope: SCOPE, anchors: cardAnchors })),
    );
    await settle();
    expect(screen.queryByRole("textbox", REPLY_BOX)).toBeNull();
  });

  it("F4: a range composer's check covers the whole range", () => {
    const lines = (five: string, seven: string) =>
      `${HEAD}@@ -1,9 +1,9 @@\n k1\n k2\n k3\n k4\n-k5\n+${five}\n k6\n-k7\n+${seven}\n k8\n k9\n`;
    const base = lines("five", "seven");
    const at = (text: string) => createDiffFile(PATH, text) as DiffFile;
    const placedAfter = (text: string) => {
      const keep = createEditorKeep();
      const file = at(base);
      keep.rowsReplaced(file, "unified", "r");
      keep.claim(
        {
          keep,
          kind: "widget",
          side: "new",
          line: 3,
          file,
          record: "r",
          span: { side: "new", from: 3, to: 5 },
        },
        LINE_COMPOSER_KEEP_ID,
        "range",
      );
      return keep.placed(keep.version(), {
        openEditors: 1,
        file: at(text),
        shown: text,
        anchors: [],
        widgetEnabled: true,
      });
    };
    expect(placedAfter(lines("five", "SEVEN"))).toBe(true);
    expect(placedAfter(lines("FIVE", "seven"))).toBe(false);
  });

  it("F5: a push gated behind the mega-line opt-in holds the rows for an open editor", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    const reply = screen.getByRole("textbox", { name: "Reply" });
    await user.type(reply, "held");
    const mega = diffOf("x".repeat(DIFF_MEGA_LINE_CHARS + 1));
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: mega })),
    );
    await settle();
    expect(reply.isConnected).toBe(true);
    expect(reply).toHaveValue("held");
    const placeholder = "Looks like a generated or minified file";
    expect(screen.queryByText(placeholder)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close reply" }));
    await settle();
    expect(await screen.findByText(placeholder)).toBeInTheDocument();
  });

  it("F9: held rows keep their own cap footer", async () => {
    const user = userEvent.setup();
    const { rerender } = render(view({ narrow: true, scope: SCOPE }));
    const box = await openComposer(2);
    await user.type(box, "kept");
    const count = DIFF_LINE_CAP + 20;
    const extra = Array.from({ length: count }, (_, i) => `+add ${i}`);
    const capped = `${diffOf("newer 2")}@@ -6,0 +7,${count} @@\n${extra.join("\n")}\n`;
    await act(async () =>
      rerender(view({ narrow: true, scope: SCOPE, text: capped })),
    );
    await settle();
    expect(box.isConnected).toBe(true);
    expect(screen.queryByText("Show full diff")).toBeNull();
  });

  it("F10: a saver that rejects keeps the editor open with its draft", async () => {
    const rejected = vi.fn();
    process.on("unhandledRejection", rejected);
    try {
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={client}>
          <Thread
            thread={thread}
            onSaveEdit={() => Promise.reject(new Error("offline"))}
          />
        </QueryClientProvider>,
      );
      await user.click(
        await screen.findByRole("button", { name: "Comment actions" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
      const box = await screen.findByRole("textbox", { name: "Edit comment" });
      await user.type(box, " more");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await settle();
      expect(screen.getByRole("textbox", { name: "Edit comment" })).toBe(box);
      expect(box).toHaveValue("Original words more");
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", rejected);
    }
  });
});

/** The line composer a PR commit drill-in (and History) mounts, over the
 *  section its rows draw. */
const commitWidgets = new Map<string, LineWidget>();
function commitWidgetFor(section: string): LineWidget {
  let w = commitWidgets.get(section);
  if (w === undefined) {
    w = {
      enabled: true,
      render: ({ side, line, fromLine, onClose, rowsBehind }) => (
        <CommitLineComposer
          repoPath="C:/repo"
          sha="abc1234"
          path={PATH}
          side={side}
          line={line}
          fromLine={fromLine}
          provider="github"
          fileSection={section}
          onClose={onClose}
          lens="origin"
          patchOnly
          rowsBehind={rowsBehind}
        />
      ),
    };
    commitWidgets.set(section, w);
  }
  return w;
}
const COMMIT_BOX = `Comment on Line 2 · ${PATH}`;
const commitBox = () =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", { name: COMMIT_BOX });
const REVS = { oldRev: "a1", newRev: "b2" };

/** The anchor row on new line 3 with every id-addressed writer live. */
const liveAnchors: DiffLineAnchor[] = bodies([
  {
    side: "new",
    line: 3,
    ids: ["edit:c1", "reply:T_9", "draft:d1"],
    render: () => (
      <>
        <Thread thread={thread} onSaveEdit={saveEdit} />
        <CardSlot />
        <DraftCommentCard
          repoPath="C:/repo"
          lens="origin"
          number={1}
          draft={draft}
        />
      </>
    ),
  },
]);

/** A promise the test settles, for a write held in flight. */
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<undefined>((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

const LONG = `${HEAD}@@ -1,40 +1,40 @@\n keep 1\n-old 2\n+new 2\n${Array.from(
  { length: 38 },
  (_, i) => ` keep ${i + 3}`,
).join("\n")}\n`;

describe("open coverage: held rows, History, the line anchor, ranges", () => {
  it("A1-11: with the rows held for a line composer, a Reply, a comment edit and a draft edit each send once", async () => {
    saveEdit.mockClear();
    onCardReply.mockClear();
    writes.draft.mockClear();
    const user = userEvent.setup();
    const at = (text: string) =>
      view({ narrow: true, scope: SCOPE, anchors: liveAnchors, text });
    const { rerender } = render(at(TEXT));
    const box = await openComposer(2);
    await user.type(box, "kept");
    await act(async () => rerender(at(diffOf("newer 2"))));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(box).toHaveAccessibleDescription("rows held");

    await user.click(screen.getByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", REPLY_BOX), "a reply");
    const send = screen.getByRole("button", { name: "Reply" });
    expect(send).not.toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    await user.click(send);
    await settle();
    expect(onCardReply).toHaveBeenCalledTimes(1);
    expect(onCardReply).toHaveBeenCalledWith("T_9", "a reply");

    // The row draws the line's own comment first, then the review thread.
    const [own] = screen.getAllByRole("button", { name: "Comment actions" });
    await user.click(own);
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Edit comment" }),
      " more",
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).not.toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    await user.click(save);
    await settle();
    expect(saveEdit).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: "Edit pending comment" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Edit pending comment" }),
      " too",
    );
    const saveDraft = screen.getByRole("button", { name: "Save" });
    expect(saveDraft).not.toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    await user.click(saveDraft);
    await settle();
    expect(writes.draft).toHaveBeenCalledTimes(1);
    // All three went out under the same hold.
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("newer 2");
  });

  it("A1-6 (Reply): a send in flight holds a rebuild that would restore it; success closes it and paints the new rows", async () => {
    const sent = deferred();
    onCardReply.mockImplementationOnce(() => sent.promise);
    const user = userEvent.setup();
    const at = (text: string) =>
      view({ narrow: true, scope: SCOPE, anchors: cardAnchors, text });
    const { rerender } = render(at(TEXT));
    await user.click(await screen.findByRole("button", { name: "Reply…" }));
    const reply = screen.getByRole("textbox", REPLY_BOX);
    await user.type(reply, "in flight");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await act(async () => rerender(at(FIVE_EDITED)));
    await settle();
    expect(document.body.textContent).not.toContain("five");
    expect(screen.getByRole("textbox", REPLY_BOX)).toBe(reply);
    await act(async () => sent.resolve());
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(screen.queryByRole("textbox", REPLY_BOX)).toBeNull();
  });

  it("A1-6 (draft edit): a save in flight holds a rebuild that would restore it; success closes it and paints the new rows", async () => {
    const sent = deferred();
    writes.draft.mockImplementationOnce(() => sent.promise);
    const user = userEvent.setup();
    const at = (text: string) => view({ narrow: true, scope: SCOPE, text });
    const { rerender } = render(at(TEXT));
    await user.click(
      await screen.findByRole("button", { name: "Edit pending comment" }),
    );
    const box = screen.getByRole("textbox", { name: "Edit pending comment" });
    await user.type(box, " later");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => rerender(at(FIVE_EDITED)));
    await settle();
    expect(document.body.textContent).not.toContain("five");
    expect(screen.getByRole("textbox", { name: "Edit pending comment" })).toBe(
      box,
    );
    await act(async () => sent.resolve());
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    expect(
      screen.queryByRole("textbox", { name: "Edit pending comment" }),
    ).toBeNull();
    // The release remounts the row: focus goes back to the draft's Edit.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit pending comment" }),
    );
  });

  it("CommitLineComposer on a PR commit drill-in: a changed line holds its post with the rows reason", async () => {
    writes.commit.mockClear();
    const user = userEvent.setup();
    const at = (text: string) =>
      view({
        narrow: true,
        scope: SCOPE,
        anchors: [],
        text,
        lineWidget: commitWidgetFor(text),
      });
    const { rerender } = render(at(TEXT));
    const box = await openComposer(2, COMMIT_BOX);
    await user.type(box, "kept");
    expect(screen.getByRole("button", { name: "Comment" })).toBeEnabled();
    await act(async () => rerender(at(diffOf("newer 2"))));
    await settle();
    expect(box.isConnected).toBe(true);
    const post = screen.getByRole("button", { name: "Comment" });
    expect(post).toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    await user.click(post);
    box.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await settle();
    expect(writes.commit).not.toHaveBeenCalled();
    expect(box).toHaveValue("kept");
  });

  it("A1-13: History's shape (revisions, no repo): a rebuild keeping the line restores its CommitLineComposer", async () => {
    const user = userEvent.setup();
    const at = (text: string) =>
      view({
        narrow: true,
        revs: REVS,
        anchors: [],
        text,
        lineWidget: commitWidgetFor(text),
      });
    const { rerender } = render(at(TEXT));
    const box = await openComposer(2, COMMIT_BOX);
    await user.type(box, "kept");
    await act(async () => rerender(at(FIVE_EDITED)));
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    const back = commitBox();
    expect(back).toHaveValue("kept");
    expect(back).not.toBe(box);
    expect(
      screen.getByRole("button", { name: "Comment" }),
    ).not.toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
  });

  it("A1-13: History's shape (revisions, no repo): a rebuild changing the line holds its CommitLineComposer", async () => {
    const user = userEvent.setup();
    const at = (text: string) =>
      view({
        narrow: true,
        revs: REVS,
        anchors: [],
        text,
        lineWidget: commitWidgetFor(text),
      });
    const { rerender } = render(at(TEXT));
    const box = await openComposer(2, COMMIT_BOX);
    await user.type(box, "kept");
    await act(async () => rerender(at(diffOf("newer 2"))));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("newer 2");
    expect(
      screen.getByRole("button", { name: "Comment" }),
    ).toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
  });

  it("A1-16: a held layout swap leaves the scroller's top line; the release keeps the line read during the hold", async () => {
    const scroller = createRef<HTMLDivElement>();
    const at = (narrow: boolean, standIn: boolean) =>
      view({ narrow, standIn, scroller, text: LONG });
    const { rerender } = render(at(true, true));
    await screen.findByText("unadopted");
    await gutter(30);
    const el = scroller.current as HTMLDivElement;
    let top = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    // jsdom lays nothing out: each row stacks under the last, split rows
    // 20px tall and unified rows 30px, so a kept scrollTop shows another line.
    const rowsIn = () => [...el.querySelectorAll("tr[data-line]")];
    const height = (row: Element) =>
      row.querySelector("td[data-side]") ? 20 : 30;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const rows = this.matches("tr[data-line]") ? rowsIn() : [];
        const i = rows.indexOf(this);
        if (i < 0) return { top: 0, bottom: 0 } as DOMRect;
        let y = 0;
        for (const row of rows.slice(0, i)) y += height(row);
        return { top: y - top, bottom: y - top + height(this) } as DOMRect;
      });
    try {
      const scrollTo = async (y: number) => {
        top = y;
        el.dispatchEvent(new Event("scroll"));
        await act(
          () => new Promise((resolve) => requestAnimationFrame(resolve)),
        );
      };
      await scrollTo(300);
      const first = captureLineAnchor(el)?.new;
      expect(first).toBeGreaterThan(1);
      await act(async () => rerender(at(false, true)));
      await settle();
      expect(splitRows()).toBe(0);
      expect(top).toBe(300);
      expect(captureLineAnchor(el)?.new).toBe(first);
      // The reader moves on while the swap waits.
      await scrollTo(450);
      const read = captureLineAnchor(el)?.new;
      expect(read).not.toBe(first);
      await act(async () => rerender(at(false, false)));
      await settle();
      expect(splitRows()).toBeGreaterThan(0);
      expect(captureLineAnchor(el)?.new).toBe(read);
    } finally {
      rect.mockRestore();
    }
  });

  it("A1-1 K1 range: a dragged range's composer comes back with its highlight on the range's rows", async () => {
    const { rerender } = render(view({ narrow: true, anchors: [] }));
    const mark = multiSelectClassNames.selected;
    // Drag new lines 2-4 on the gutter, then press "+" on the range's last line.
    fireEvent.mouseDown(await gutter(2));
    fireEvent.mouseOver(await gutter(4));
    fireEvent.mouseUp(document);
    const four = await gutter(4);
    fireEvent.mouseOver(four);
    fireEvent.mouseDown(
      four.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
    );
    await waitFor(() => expect(composer(4)).toBeTruthy());
    await settle();
    fireEvent.change(composer(4) as HTMLTextAreaElement, {
      target: { value: "ranged" },
    });
    const unifiedRow = (line: number) =>
      document
        .querySelector(`span[data-line-new-num="${line}"]`)
        ?.closest("tr");
    expect(unifiedRow(2)?.querySelector(`.${mark}`)).toBeTruthy();
    expect(unifiedRow(4)?.querySelector(`.${mark}`)).toBeTruthy();
    expect(unifiedRow(5)?.querySelector(`.${mark}`)).toBeNull();

    await act(async () => rerender(view({ narrow: false, anchors: [] })));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(composer(4)).toHaveValue("ranged");
    const splitCell = (line: number) =>
      document
        .querySelector(`td[data-side="new"] span[data-line-num="${line}"]`)
        ?.closest("td");
    expect(splitCell(2)).toHaveClass(mark);
    expect(splitCell(4)).toHaveClass(mark);
    expect(splitCell(5)).not.toHaveClass(mark);
  });
});

/** Saves a comment edit open in an anchor row, the save held in flight while
 *  (with `rebuild`) a text rebuild waits behind it. */
async function saveInAnchorRow(rebuild: boolean) {
  const sent = deferred();
  saveEdit.mockImplementationOnce(async () => {
    await sent.promise;
    return true;
  });
  const user = userEvent.setup();
  const at = (text: string) => view({ narrow: true, scope: SCOPE, text });
  const { rerender } = render(at(TEXT));
  await user.click(
    await screen.findByRole("button", { name: "Comment actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Edit comment" }),
    " more",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  const live = () => {
    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active?.matches(":disabled")).toBe(false);
  };
  live();
  if (rebuild) await act(async () => rerender(at(FIVE_EDITED)));
  await settle();
  live();
  if (rebuild) expect(document.body.textContent).not.toContain("five");
  await act(async () => sent.resolve());
  live();
  await settle();
  if (rebuild)
    await waitFor(() => expect(document.body.textContent).toContain("five"));
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull(),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Comment actions" }),
  );
}

describe("fix round 3: focus across a comment save", () => {
  it("a comment edit saved in an anchor row keeps focus live and ends on its actions trigger", async () => {
    await saveInAnchorRow(false);
  });

  it("a save a rebuild held behind it ends on the comment's actions trigger, not the diff group", async () => {
    await saveInAnchorRow(true);
  });
});

const build = (text: string, content?: { old: string; new: string }) =>
  createDiffFile(PATH, text, undefined, content) as DiffFile;
const fileOf = (two: string) =>
  ["keep 1", two, "keep 3", "keep 4", "keep 5", "keep 6"].join("\n");

/** A keep whose widget was claimed on `file` at `line` (side new), over `span`. */
function widgetKeep(
  file: DiffFile,
  line: number,
  span?: { side: "old" | "new"; from: number; to: number },
) {
  const keep = createEditorKeep();
  keep.rowsReplaced(file, "unified", "r");
  const row = (at: number) => ({
    keep,
    kind: "widget" as const,
    side: "new" as const,
    line: at,
    file,
    record: "r",
    span,
  });
  const token = keep.claim(row(line), LINE_COMPOSER_KEEP_ID, "text");
  const placedOn = (next: DiffFile, shown: string) =>
    keep.placed(keep.version(), {
      openEditors: 1,
      file: next,
      shown,
      anchors: [],
      widgetEnabled: true,
    });
  return { keep, row, token, placedOn };
}

/** Nine context lines with `edits` (line → new text) as one-line changes. */
const nine = (edits: Record<number, string> = {}) =>
  `${HEAD}@@ -1,9 +1,9 @@\n${Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return edits[n] === undefined ? ` k${n}` : `-k${n}\n+${edits[n]}`;
  }).join("\n")}\n`;

describe("round zero: keep records", () => {
  it("T2: a range's check covers each of its lines and each neighbour", () => {
    const base = build(nine({ 9: "nine" }));
    const after = (edits: Record<number, string>) => {
      const text = nine({ 9: "nine", ...edits });
      return widgetKeep(base, 5, { side: "new", from: 3, to: 5 }).placedOn(
        build(text),
        text,
      );
    };
    expect(after({ 7: "seven" })).toBe(true);
    expect(after({ 4: "four" })).toBe(false);
    expect(after({ 2: "two" })).toBe(false);
    expect(after({ 6: "six" })).toBe(false);
  });

  it("A2: a Unified range on the other side holds when its anchor line moved", () => {
    // The press reported new 4 ("keep 4") and mapped into old 3-4.
    const inserted = `${HEAD}@@ -1,6 +1,7 @@\n keep 1\n-old 2\n+new 2\n+added\n keep 3\n keep 4\n keep 5\n keep 6\n`;
    const { placedOn } = widgetKeep(build(TEXT), 4, {
      side: "old",
      from: 3,
      to: 4,
    });
    const kept = diffOf("newer 2");
    expect(placedOn(build(kept), kept)).toBe(true);
    expect(placedOn(build(inserted), inserted)).toBe(false);
  });

  it("A4: a settle from a replaced widget claim leaves the new claim's record", () => {
    const { keep, row, token: first } = widgetKeep(build(TEXT), 2);
    const second = keep.claim(row(4), LINE_COMPOSER_KEEP_ID, "other");
    keep.setBusy(first, true);
    keep.forget(first);
    expect(keep.widgetRecord()).toMatchObject({ line: 4 });
    expect(
      keep.placed(keep.version(), {
        openEditors: 1,
        file: null,
        shown: TEXT,
        anchors: [],
        widgetEnabled: true,
      }),
    ).toBe(true);
    keep.forget(second);
    expect(keep.widgetRecord()).toBeNull();
  });

  it("A10: in a whole-file build, a composer on the last line restores", () => {
    const content = (two: string) => ({
      old: fileOf("old 2"),
      new: fileOf(two),
    });
    const { placedOn } = widgetKeep(build(TEXT, content("new 2")), 6);
    const next = diffOf("newer 2");
    expect(placedOn(build(next, content("newer 2")), next)).toBe(true);
    // A hunk-only build knows nothing past its hunk: the same line holds.
    expect(widgetKeep(build(TEXT), 6).placedOn(build(next), next)).toBe(false);
  });

  it("B1: a blank line appended or removed past the last line holds a composer on it", () => {
    const old = `${fileOf("old 2")}\n`;
    const six = (two: string) => `${fileOf(two)}\n`;
    // A blank line's text is "\n", the same as the file's end used to read.
    const blankAtEnd = `${HEAD}@@ -1,6 +1,7 @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n keep 5\n keep 6\n+\n`;
    const next = diffOf("newer 2");
    const plain = widgetKeep(build(TEXT, { old, new: six("new 2") }), 6);
    expect(
      plain.placedOn(build(next, { old, new: six("newer 2") }), next),
    ).toBe(true);
    expect(
      plain.placedOn(
        build(blankAtEnd, { old, new: `${six("new 2")}\n` }),
        blankAtEnd,
      ),
    ).toBe(false);
    const blank = widgetKeep(
      build(blankAtEnd, { old, new: `${six("new 2")}\n` }),
      6,
    );
    expect(blank.placedOn(build(TEXT, { old, new: six("new 2") }), TEXT)).toBe(
      false,
    );
  });

  it("A9: a restore lands on the same comment's control after a comment was added above it", () => {
    const keep = createEditorKeep();
    const file = build(TEXT);
    const Row = ({ ids }: { ids: string[] }) => (
      <KeptRow
        keep={keep}
        kind="anchor"
        side="new"
        line={3}
        file={file}
        record="r"
      >
        {ids.map((id) => (
          <div key={id} data-keep-id={id}>
            <button type="button" aria-label="Comment actions">
              {id}
            </button>
          </div>
        ))}
      </KeptRow>
    );
    const { rerender } = render(<Row ids={["edit:a", "edit:b"]} />);
    act(() => screen.getByText("edit:b").focus());
    rerender(<div />);
    rerender(<Row ids={["edit:new", "edit:a", "edit:b"]} />);
    expect(document.activeElement).toBe(screen.getByText("edit:b"));
  });

  it("A8: a restored edit closed with Cancel takes focus when opened again", async () => {
    const keep = createEditorKeep();
    const file = build(TEXT);
    function Editor() {
      const reopened = useKeptOpen("edit:x");
      const [open, setOpen] = useState(reopened);
      const kept = useKeptDraft(open ? "edit:x" : null);
      return open ? (
        <>
          <textarea
            aria-label="Edit x"
            value={kept.text}
            onChange={(e) => kept.setText(e.target.value)}
            autoFocus={!kept.restored}
          />
          <button
            type="button"
            onClick={() => {
              kept.forget();
              setOpen(false);
            }}
          >
            Cancel x
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Edit x
        </button>
      );
    }
    const at = (n: string) => (
      <KeptRow
        key={n}
        keep={keep}
        kind="anchor"
        side="new"
        line={3}
        file={file}
        record="r"
      >
        <Editor />
      </KeptRow>
    );
    const { rerender } = render(at("1"));
    fireEvent.click(screen.getByRole("button", { name: "Edit x" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit x" }), {
      target: { value: "kept" },
    });
    act(() => screen.getByRole("button", { name: "Cancel x" }).focus());
    rerender(at("2"));
    expect(screen.getByRole("textbox", { name: "Edit x" })).toHaveValue("kept");
    fireEvent.click(screen.getByRole("button", { name: "Cancel x" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit x" }));
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Edit x" }),
    );
  });
});

describe("A11: a pending draft's edit lands like a comment's", () => {
  const card = () => (
    <QueryClientProvider client={client}>
      <DraftCommentCard
        repoPath="C:/repo"
        lens="origin"
        number={1}
        draft={draft}
      />
    </QueryClientProvider>
  );
  const editButton = () =>
    screen.getByRole("button", { name: "Edit pending comment" });
  const box = () =>
    screen.queryByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit pending comment",
    });
  async function open() {
    fireEvent.click(editButton());
    const field = await waitFor(() => box() as HTMLTextAreaElement);
    fireEvent.change(field, { target: { value: "Revised draft" } });
    act(() => field.focus());
    return field;
  }

  it.each(["Save", "Cancel"])(
    "lands on its Edit button after %s",
    async (name) => {
      render(card());
      await open();
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name })),
      );
      await waitFor(() => expect(box()).toBeNull());
      expect(document.activeElement).toBe(editButton());
    },
  );

  it("sends the revised body, holds while it runs, and gives the field back with its text when the save fails", async () => {
    let refuse!: () => void;
    writes.draft.mockImplementationOnce(() => {
      writes.setDraftPending(true);
      return new Promise<undefined>((_, reject) => {
        refuse = () => reject(new Error("refused"));
      });
    });
    render(card());
    const field = await open();
    field.setSelectionRange(0, 0);
    const save = screen.getByRole("button", { name: "Save" });
    await act(async () => fireEvent.click(save));
    expect(writes.draft).toHaveBeenCalledWith({
      id: "d1",
      body: "Revised draft",
    });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      writes.setDraftPending(false);
      refuse();
    });
    await settle();
    expect(box()).toBe(field);
    expect(field).toHaveValue("Revised draft");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
  });
});

describe("round zero: held builds, record moves, hidden tabs and refocus", () => {
  afterEach(() => document.documentElement.classList.remove("dark"));

  it("A1: a held build released after a theme change first-commits the current theme", async () => {
    document.documentElement.classList.add("dark");
    const commits: { node: Element; theme: string | null }[] = [];
    const wrapper = () => document.querySelector(".diff-tailwindcss-wrapper");
    const probed = (props: ViewProps) => (
      <Profiler
        id="keep"
        onRender={() => {
          const node = wrapper();
          if (node !== null)
            commits.push({ node, theme: node.getAttribute("data-theme") });
        }}
      >
        {view(props)}
      </Profiler>
    );
    const at = (standIn: boolean, text = TEXT) =>
      probed({ narrow: true, scope: SCOPE, standIn, text });
    const { rerender } = render(at(true));
    await screen.findByText("unadopted");
    await act(async () => rerender(at(true, FIVE_EDITED)));
    await settle();
    expect(document.body.textContent).not.toContain("five");
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    await settle();
    const held = wrapper();
    expect(held?.getAttribute("data-theme")).toBe("light");
    commits.length = 0;
    await act(async () => rerender(at(false, FIVE_EDITED)));
    await settle();
    expect(document.body.textContent).toContain("five");
    const released = commits.find((c) => c.node !== held);
    expect(released).toBeDefined();
    expect(released?.theme).toBe("light");
  });

  it("A5: a '+' on another record's same line opens a single-line composer", async () => {
    const ranged: LineWidget = {
      enabled: true,
      render: ({ line, fromLine }) => (
        <>
          <TestComposer line={line} />
          <output aria-label="range start">{fromLine ?? line}</output>
        </>
      ),
    };
    const at = (scope: string) =>
      view({ narrow: true, anchors: [], scope, lineWidget: ranged });
    const { rerender } = render(at("pr-3"));
    fireEvent.mouseDown(await gutter(2));
    fireEvent.mouseOver(await gutter(4));
    fireEvent.mouseUp(document);
    await openComposer(4);
    expect(screen.getByLabelText("range start")).toHaveTextContent("2");
    await act(async () => rerender(at("pr-4")));
    await settle();
    expect(anyComposer()).toHaveLength(0);
    await openComposer(4);
    expect(screen.getByLabelText("range start")).toHaveTextContent("4");
  });

  it("A9 (field): a restore refocuses the same comment's edit box after another opened above it", () => {
    const keep = createEditorKeep();
    const file = build(TEXT);
    function Edit({ id }: { id: string }) {
      const kept = useKeptDraft(id);
      return (
        <div data-keep-id={id}>
          <textarea
            aria-label="Edit comment"
            value={kept.text}
            onChange={(e) => kept.setText(e.target.value)}
          />
        </div>
      );
    }
    const at = (n: string, ids: string[]) => (
      <KeptRow
        key={n}
        keep={keep}
        kind="anchor"
        side="new"
        line={3}
        file={file}
        record="r"
      >
        {ids.map((id) => (
          <Edit key={id} id={id} />
        ))}
      </KeptRow>
    );
    const { rerender } = render(at("1", ["edit:a", "edit:b"]));
    const boxes = () =>
      screen.getAllByRole("textbox", { name: "Edit comment" });
    fireEvent.change(boxes()[1], { target: { value: "b text" } });
    act(() => boxes()[1].focus());
    rerender(at("2", ["edit:new", "edit:a", "edit:b"]));
    expect(boxes()[2]).toHaveValue("b text");
    expect(document.activeElement).toBe(boxes()[2]);
  });
});

describe("B5: rows a rebuild's whole-file reads are still building", () => {
  it("hold the commit comment with the loading reason, then catch up and post", async () => {
    writes.commit.mockClear();
    const OLD_FILE = `${fileOf("old 2")}\n`;
    const NEW_FILE = `${fileOf("new 2").replace("keep 5", "five")}\n`;
    const waiting = new Map<string, () => void>();
    vi.mocked(gitFileBase64).mockImplementation(
      (_repo, rev) =>
        new Promise((resolve) => {
          const body = rev === REVS.oldRev ? OLD_FILE : NEW_FILE;
          waiting.set(rev ?? "", () =>
            resolve({
              base64: Buffer.from(body).toString("base64"),
              mime: null,
              tooLarge: false,
              size: body.length,
            }),
          );
        }),
    );
    // Over the line cap, content mode stays off and reads nothing.
    const count = DIFF_LINE_CAP + 20;
    const extra = Array.from({ length: count }, (_, i) => `+add ${i}`);
    const over = `${TEXT}@@ -6,0 +7,${count} @@\n${extra.join("\n")}\n`;
    const user = userEvent.setup();
    const at = (text: string) =>
      view({
        narrow: true,
        revs: REVS,
        repo: "C:/repo",
        anchors: [],
        text,
        lineWidget: commitWidgetFor(text),
      });
    const { rerender } = render(at(over));
    const box = await openComposer(2, COMMIT_BOX);
    await user.type(box, "kept");
    expect(gitFileBase64).not.toHaveBeenCalled();
    await act(async () => rerender(at(FIVE_EDITED)));
    await waitFor(() => expect(waiting.size).toBe(2));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("five");
    const held = screen.getByRole("button", { name: "Comment" });
    expect(held).toHaveAccessibleDescription(COMMIT_LOADING_REASON);
    await user.click(held);
    box.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await settle();
    expect(writes.commit).not.toHaveBeenCalled();
    expect(box).toHaveValue("kept");
    await act(async () => {
      for (const land of waiting.values()) land();
    });
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    await waitFor(() => expect(commitBox()).toHaveValue("kept"));
    const post = screen.getByRole("button", { name: "Comment" });
    expect(post).not.toHaveAccessibleDescription(COMMIT_LOADING_REASON);
    await user.click(post);
    expect(writes.commit).toHaveBeenCalledTimes(1);
    expect(writes.commit).toHaveBeenCalledWith(
      expect.objectContaining({ body: "kept", line: 2, path: PATH }),
    );
  });
});

describe("C2: the close reason means the keep refused a replacement that is there", () => {
  // One array for every render: a new one is an anchors change of its own.
  const NO_ANCHORS: DiffLineAnchor[] = bodies([]);
  const held = (line: number) =>
    expect(composer(line)).toHaveAccessibleDescription("rows held");
  const notHeld = (line: number) =>
    expect(composer(line)).not.toHaveAccessibleDescription("rows held");

  it("(a) a busy composer across a layout change while the whole-file reads load reads as loading, then as held once they land", async () => {
    const OLD_FILE = `${fileOf("old 2")}\n`;
    const NEW_FILE = `${fileOf("new 2").replace("keep 5", "five")}\n`;
    const waiting = new Map<string, () => void>();
    vi.mocked(gitFileBase64).mockImplementation(
      (_repo, rev) =>
        new Promise((resolve) => {
          const body = rev === REVS.oldRev ? OLD_FILE : NEW_FILE;
          waiting.set(rev ?? "", () =>
            resolve({
              base64: Buffer.from(body).toString("base64"),
              mime: null,
              tooLarge: false,
              size: body.length,
            }),
          );
        }),
    );
    const count = DIFF_LINE_CAP + 20;
    const extra = Array.from({ length: count }, (_, i) => `+add ${i}`);
    const over = `${TEXT}@@ -6,0 +7,${count} @@\n${extra.join("\n")}\n`;
    const user = userEvent.setup();
    const at = (narrow: boolean, text: string) =>
      view({ narrow, revs: REVS, repo: "C:/repo", anchors: NO_ANCHORS, text });
    const { rerender } = render(at(true, over));
    const box = await openComposer(2);
    await user.type(box, "kept");
    await user.click(screen.getByRole("button", { name: "Busy" }));
    await act(async () => rerender(at(false, FIVE_EDITED)));
    await waitFor(() => expect(waiting.size).toBe(2));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("five");
    notHeld(2);
    await act(async () => {
      for (const land of waiting.values()) land();
    });
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("five");
    held(2);
    await user.click(screen.getByRole("button", { name: "Idle" }));
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    await waitFor(() => expect(composer(2)).toHaveValue("kept"));
    notHeld(2);
  });

  it("(b) a push that makes the file a mega-line under an open composer reads as held", async () => {
    const user = userEvent.setup();
    const at = (text: string) =>
      view({ narrow: true, scope: SCOPE, anchors: NO_ANCHORS, text });
    const { rerender } = render(at(TEXT));
    const box = await openComposer(2);
    await user.type(box, "kept");
    notHeld(2);
    await act(async () =>
      rerender(at(diffOf("x".repeat(DIFF_MEGA_LINE_CHARS + 1)))),
    );
    await settle();
    expect(box.isConnected).toBe(true);
    held(2);
  });

  it("a candidate build that changes the composer's line reads as held", async () => {
    const user = userEvent.setup();
    const at = (text: string) =>
      view({ narrow: true, scope: SCOPE, anchors: NO_ANCHORS, text });
    const { rerender } = render(at(TEXT));
    const box = await openComposer(2);
    await user.type(box, "kept");
    await act(async () => rerender(at(diffOf("newer 2"))));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).not.toContain("newer 2");
    held(2);
  });
});

describe("B10: a reordered row refocuses the comment focus was in", () => {
  const Order = createContext(["c1", "c2"]);
  function Comments() {
    return use(Order).map((id) => (
      <Thread
        key={id}
        thread={{ ...thread, id, body: `Words ${id}` }}
        onSaveEdit={saveEdit}
      />
    ));
  }
  const twoComments: DiffLineAnchor[] = bodies([
    {
      side: "new",
      line: 3,
      ids: ["edit:c1", "edit:c2"],
      render: () => <Comments />,
    },
  ]);
  const at = (narrow: boolean, order: string[]) => (
    <Order value={order}>{view({ narrow, anchors: twoComments })}</Order>
  );
  const triggers = () =>
    screen.getAllByRole("button", { name: "Comment actions" });
  const boxes = () =>
    screen.getAllByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit comment",
    });
  const c2First = () => {
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Words c2")).toBeLessThan(text.indexOf("Words c1"));
  };

  it("its actions trigger", async () => {
    const { rerender } = render(at(true, ["c1", "c2"]));
    await waitFor(() => expect(triggers()).toHaveLength(2));
    const second = triggers()[1];
    act(() => second.focus());
    await act(async () => rerender(at(false, ["c2", "c1"])));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(second.isConnected).toBe(false);
    c2First();
    expect(document.activeElement).toBe(triggers()[0]);
  });

  it("its edit box", async () => {
    const user = userEvent.setup();
    const { rerender } = render(at(true, ["c1", "c2"]));
    await waitFor(() => expect(triggers()).toHaveLength(2));
    for (const [nth, open] of [
      [1, 1],
      [0, 2],
    ] as const) {
      await user.click(triggers()[nth]);
      await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
      await waitFor(() => expect(boxes()).toHaveLength(open));
    }
    fireEvent.change(boxes()[1], { target: { value: "c2 revised" } });
    const field = boxes()[1];
    act(() => field.focus());
    await act(async () => rerender(at(false, ["c2", "c1"])));
    await settle();
    expect(field.isConnected).toBe(false);
    c2First();
    expect(boxes()[0]).toHaveValue("c2 revised");
    expect(boxes()[1]).toHaveValue("Words c1");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("its review thread's Reply box", async () => {
    const CardOrder = createContext(["T_a", "T_b"]);
    function Cards() {
      return use(CardOrder).map((id) => (
        <ReviewThreadCard
          key={id}
          thread={cardThread(id, false)}
          compact
          expanded
          onToggleExpand={() => undefined}
          onReply={onCardReply}
        />
      ));
    }
    const twoCards: DiffLineAnchor[] = bodies([
      {
        side: "new",
        line: 3,
        ids: ["reply:T_a", "reply:T_b"],
        render: () => <Cards />,
      },
    ]);
    const cardsAt = (narrow: boolean, order: string[]) => (
      <CardOrder value={order}>{view({ narrow, anchors: twoCards })}</CardOrder>
    );
    const user = userEvent.setup();
    const { rerender } = render(cardsAt(true, ["T_a", "T_b"]));
    const replies = () =>
      screen.getAllByRole<HTMLTextAreaElement>("textbox", REPLY_BOX);
    for (const open of [1, 2]) {
      await user.click(
        (await screen.findAllByRole("button", { name: "Reply…" }))[0],
      );
      await waitFor(() => expect(replies()).toHaveLength(open));
    }
    fireEvent.change(replies()[0], { target: { value: "a reply" } });
    fireEvent.change(replies()[1], { target: { value: "b reply" } });
    const field = replies()[1];
    act(() => field.focus());
    await act(async () => rerender(cardsAt(false, ["T_b", "T_a"])));
    await settle();
    expect(splitRows()).toBeGreaterThan(0);
    expect(field.isConnected).toBe(false);
    expect(replies()[0]).toHaveValue("b reply");
    expect(replies()[1]).toHaveValue("a reply");
    expect(document.activeElement).toBe(replies()[0]);
  });
});
