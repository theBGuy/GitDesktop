import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaintedCut, PaintedView } from "@/features/diff/painted-view";
import {
  SHOW_WHITESPACE_LABEL,
  WHITESPACE_COMPOSER_HELD,
  whitespaceComposerOpen,
} from "@/features/diff/whitespace-mode";
import {
  CommitComments,
  newSideLines,
  useCommentPins,
  useCommitLineAnchors,
} from "@/features/pulls/CommitComments";
import {
  forgeCommitComments,
  forgeStatus,
  gitCommitFileDiff,
} from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import type { CommitCommentOut, FileDiff, ForgeStatus } from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeCommitComments: vi.fn(),
  forgeStatus: vi.fn(),
  gitCommitFileDiff: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));

// jsdom implements no scrollIntoView; the edit-in-place editor calls it on open.
Element.prototype.scrollIntoView ??= () => undefined;

const SHA = "abcdef0123".repeat(4);
const HEADER =
  "diff --git a/x b/x\nindex 1111aaa..2222bbb 100644\n--- a/x\n+++ b/x\n";
/** Lines 1-3, line 2 re-indented: the hunk `-w` drops. */
const WS_HUNK = "@@ -1,3 +1,3 @@\n a\n-b\n+  b\n c\n";
/** Lines 19-21, a real change: drawn in both modes. */
const REAL_HUNK = "@@ -19,3 +19,3 @@\n s\n-t\n+T\n u\n";
const PLAIN = HEADER + WS_HUNK + REAL_HUNK;

const diff = (text: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  filePath: "x",
  isBinary: false,
  isTruncated: false,
  text,
  ...extra,
});
/** A block duplicated and re-indented above itself (git 2.51.1): the shown
 *  read's hunk covers new lines 1-9, the `-w` read's realigned one 4-13. */
const REALIGN_SHOWN =
  HEADER +
  "@@ -1,3 +1,9 @@\n+    a\n+    b\n+    c\n+    d\n+    e\n+    f\n a\n b\n c\n";
const REALIGN_HIDDEN =
  HEADER +
  "@@ -4,4 +4,10 @@ c\n     d\n     e\n     f\n+a\n+b\n+c\n+d\n+e\n+f\n end\n";
/** The `-w` read the pane draws while Hide whitespace is on. */
const HIDDEN = diff(HEADER + REAL_HUNK, { whitespaceHidden: true });

const comment = (
  id: string,
  line: number | null,
  extra: Partial<CommitCommentOut> = {},
): CommitCommentOut => ({
  id,
  author: "octo",
  body: `note ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  viewerDidAuthor: false,
  path: "x",
  line,
  startLine: null,
  position: null,
  ...extra,
});
const WHOLE = comment("whole", null, { path: null });

let stored: AppSettings = DEFAULT_SETTINGS;
const plainCalls = () =>
  vi.mocked(gitCommitFileDiff).mock.calls.filter(([, , , iw]) => iw === false)
    .length;

beforeEach(() => {
  vi.clearAllMocks();
  stored = DEFAULT_SETTINGS;
  vi.mocked(loadSettings).mockImplementation(async () => stored);
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "gitlab",
    authenticated: false,
  } as unknown as ForgeStatus);
  vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, _f, iw) =>
    iw ? HIDDEN : diff(PLAIN),
  );
});

afterEach(() => {
  for (const n of document.querySelectorAll("[data-diff-line-widget]"))
    n.remove();
});

const NO_PINS: ReadonlySet<string> = new Set();

/** The pane's paint, as its painted report says it: `drawn` is the read its
 *  rows were built from (null: nothing reports); `mounts: false`, a cut that
 *  mounts no rows. */
interface Paint {
  drawn: FileDiff | null;
  cut?: PaintedCut | null;
  mounts?: boolean;
}

/** A host: its pins shared by the list and the pane, whose report mounts an
 *  anchor row for each unpinned comment whose line the paint draws. */
function Host({
  comments,
  paint,
  diffSections,
  onPins,
}: {
  comments: CommitCommentOut[];
  paint: Paint;
  diffSections?: ReturnType<typeof splitUnifiedDiff>;
  onPins: (pinned: ReadonlySet<string>) => void;
}) {
  const pins = useCommentPins();
  // Reported from a layout effect, so a replayed or discarded render reports
  // nothing.
  useLayoutEffect(() => onPins(pins.pinned));
  const { drawn, cut = null, mounts = true } = paint;
  const drawnLines = newSideLines(drawn?.text ?? "");
  const drawnComments = comments.filter(
    (c) =>
      c.path === "x" &&
      mounts &&
      c.line != null &&
      drawnLines.has(c.line) &&
      !pins.pinned.has(c.id),
  );
  const painted: PaintedView | null =
    drawn === null
      ? null
      : {
          path: "x",
          patch: drawn.text,
          whitespaceHidden: drawn.whitespaceHidden === true,
          truncated: drawn.isTruncated,
          cut,
          anchors: drawnComments.map((c) => `new:${c.line}`).sort(),
          drawn: drawnComments.map((c) => c.id).sort(),
        };
  return (
    <CommitComments
      repoPath="/repo"
      sha={SHA}
      canComment={false}
      remoteLabel="origin"
      diffSections={diffSections}
      painted={painted}
      pins={pins}
      lens="origin"
    />
  );
}

function renderPane({
  comments,
  hide,
  drawnDiff,
  cut,
  mounts,
  diffSections,
}: {
  comments: CommitCommentOut[];
  hide: boolean;
  drawnDiff: FileDiff | null;
  cut?: PaintedCut | null;
  mounts?: boolean;
  diffSections?: ReturnType<typeof splitUnifiedDiff>;
}) {
  vi.mocked(forgeCommitComments).mockResolvedValue([...comments, WHOLE]);
  stored = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, stored);
  let pinned: ReadonlySet<string> = NO_PINS;
  const ui = (paint: Paint) => (
    <QueryClientProvider client={client}>
      <Host
        comments={comments}
        paint={paint}
        diffSections={diffSections}
        onPins={(p) => {
          pinned = p;
        }}
      />
    </QueryClientProvider>
  );
  const view = render(ui({ drawn: drawnDiff, cut, mounts }));
  return {
    unmount: view.unmount,
    /** The pane paints another read. */
    repaint: (paint: Paint) => view.rerender(ui(paint)),
    pinned: () => pinned,
  };
}

/** The list landed: the whole-commit comment always renders. */
const landed = () => screen.findByText("note whole");
const settle = () => act(() => Promise.resolve());
const listed = (id: string) => screen.queryByText(`note ${id}`) !== null;
const button = () =>
  screen.queryAllByRole("button", { name: SHOW_WHITESPACE_LABEL })[0] ?? null;
/** A listed comment's row: its label line, then its thread. */
function rowOf(id: string): HTMLElement {
  let row: HTMLElement = screen.getByText(`note ${id}`);
  while (row.parentElement && !row.parentElement.matches(".space-y-3"))
    row = row.parentElement;
  return row;
}
/** The label line of a listed comment. */
function labelOf(id: string): string {
  return rowOf(id).firstElementChild?.textContent ?? "";
}
const description = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("newSideLines", () => {
  it("lets a realigned -w hunk cover a line no shown hunk does", () => {
    expect(newSideLines(REALIGN_SHOWN).has(11)).toBe(false);
    expect(newSideLines(REALIGN_HIDDEN).has(11)).toBe(true);
  });

  it("counts context and added lines inside each hunk's bounds", () => {
    expect([...newSideLines(PLAIN)]).toEqual([1, 2, 3, 19, 20, 21]);
  });

  it("never counts a joined second file header or a no-newline marker", () => {
    const joined = `${HEADER}@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n${HEADER}@@ -0,0 +1 @@\n+c\n`;
    expect([...newSideLines(joined)]).toEqual([1]);
    expect(newSideLines(HEADER).size).toBe(0);
  });
});

describe("CommitComments over lines the drawn diff lacks", () => {
  it("lists a whitespace-hidden thread with its reason and a Show whitespace button", async () => {
    renderPane({
      comments: [
        comment("c2", 2),
        comment("c21", 21),
        comment("1a2b3c:9", 2, { startLine: 1 }),
      ],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    expect(labelOf("c2")).toContain(
      "x:2 · on a line hidden by Hide whitespace",
    );
    expect(labelOf("1a2b3c:9")).toContain(
      "x:1–2 · on a line hidden by Hide whitespace",
    );
    expect(
      screen.getAllByRole("button", { name: SHOW_WHITESPACE_LABEL }),
    ).toHaveLength(2);
    // Drawn in both modes: inline, never listed.
    expect(listed("c21")).toBe(false);
    expect(plainCalls()).toBe(1);
  });

  it("explains a whitespace-only file's thread", async () => {
    renderPane({
      comments: [comment("c2", 2)],
      hide: true,
      drawnDiff: diff(HEADER, { whitespaceHidden: true, whitespaceOnly: true }),
    });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    expect(labelOf("c2")).toContain("on a line hidden by Hide whitespace");
    expect(plainCalls()).toBe(1);
  });

  it("calls a GitLab note outside every hunk unplaced, in both modes (AC4a)", async () => {
    const note = comment("1a2b3c:77", 50);
    const first = renderPane({
      comments: [note],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() =>
      expect(labelOf("1a2b3c:77")).toContain("couldn't place in this diff"),
    );
    expect(button()).toBeNull();
    first.unmount();
    vi.mocked(gitCommitFileDiff).mockClear();
    renderPane({
      comments: [note],
      hide: false,
      drawnDiff: diff(PLAIN, { whitespaceHidden: false }),
    });
    await landed();
    expect(labelOf("1a2b3c:77")).toContain("couldn't place in this diff");
    expect(button()).toBeNull();
    expect(plainCalls()).toBe(0);
  });

  it("never blames whitespace for a truncated read, nor reads plain (AC4b)", async () => {
    renderPane({
      comments: [comment("c21", 21)],
      hide: true,
      drawnDiff: diff(HEADER + WS_HUNK, {
        whitespaceHidden: true,
        isTruncated: true,
      }),
    });
    await landed();
    await settle();
    expect(labelOf("c21")).toContain("couldn't place in this diff");
    expect(button()).toBeNull();
    expect(plainCalls()).toBe(0);
  });

  it("holds the note while the plain read is out, and says unplaced if it fails (AC4c)", async () => {
    vi.mocked(gitCommitFileDiff).mockImplementation(
      () => new Promise<FileDiff>(() => undefined),
    );
    const first = renderPane({
      comments: [comment("c2", 2)],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await settle();
    expect(labelOf("c2")).toBe("x:2");
    expect(button()).toBeNull();
    first.unmount();
    vi.mocked(gitCommitFileDiff).mockRejectedValue(new Error("boom"));
    renderPane({ comments: [comment("c2", 2)], hide: true, drawnDiff: HIDDEN });
    await landed();
    await waitFor(() =>
      expect(labelOf("c2")).toContain("couldn't place in this diff"),
    );
    expect(button()).toBeNull();
  });

  it("blames whitespace first for a hidden line past the shown view's cap (AC4d)", async () => {
    const body = Array.from({ length: 210 }, (_, i) => ` l${i + 1}`).join("\n");
    const long = `${HEADER}@@ -1,210 +1,210 @@\n${body}\n@@ -300,1 +300,1 @@\n-p\n+  p\n`;
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, _f, iw) =>
      iw ? HIDDEN : diff(long),
    );
    renderPane({
      comments: [comment("c300", 300)],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    // Show whitespace is the first control it needs; the cap's note follows.
    await waitFor(() =>
      expect(labelOf("c300")).toContain("on a line hidden by Hide whitespace"),
    );
    expect(button()).not.toBeNull();
    expect(plainCalls()).toBe(1);
  });

  it("judges the PR-commit host by its patch section, never whitespace (AC4e)", async () => {
    renderPane({
      comments: [comment("c21", 21), comment("c50", 50)],
      hide: true,
      drawnDiff: diff(PLAIN),
      diffSections: splitUnifiedDiff(PLAIN),
    });
    await landed();
    await settle();
    expect(listed("c21")).toBe(false);
    expect(labelOf("c50")).toContain("couldn't place in this diff");
    expect(screen.queryByText(/hidden by Hide whitespace/)).toBeNull();
    expect(gitCommitFileDiff).not.toHaveBeenCalled();
  });

  it("keeps a line drawn in both modes inline in both (AC4f)", async () => {
    const first = renderPane({
      comments: [comment("c21", 21)],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await settle();
    expect(listed("c21")).toBe(false);
    first.unmount();
    renderPane({
      comments: [comment("c21", 21)],
      hide: false,
      drawnDiff: diff(PLAIN, { whitespaceHidden: false }),
    });
    await landed();
    await settle();
    expect(listed("c21")).toBe(false);
    expect(plainCalls()).toBe(0);
  });

  it("lists every comment with no note while nothing reports, whatever the setting", async () => {
    renderPane({
      comments: [comment("c2", 2), comment("c21", 21)],
      hide: true,
      drawnDiff: null,
    });
    await landed();
    await settle();
    expect(labelOf("c2")).toBe("x:2");
    expect(labelOf("c21")).toBe("x:21");
    expect(plainCalls()).toBe(0);
  });

  it("judges a `-w` paint by what it mounts, whatever the setting says (AC4h)", async () => {
    renderPane({
      comments: [comment("c2", 2), comment("c21", 21)],
      hide: false,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() =>
      expect(labelOf("c2")).toContain("on a line hidden by Hide whitespace"),
    );
    expect(listed("c21")).toBe(false);
  });

  it("reads nothing when no comment is anchored", async () => {
    renderPane({ comments: [], hide: true, drawnDiff: HIDDEN });
    await landed();
    await settle();
    expect(plainCalls()).toBe(0);
    expect(button()).toBeNull();
  });

  it("explains a hidden first line and a hidden last line before a no-newline marker", async () => {
    const tail = `${HEADER}@@ -1,2 +1,2 @@\n-a\n+ a\n-z\n+ z\n\\ No newline at end of file\n`;
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, _f, iw) =>
      iw ? diff(HEADER, { whitespaceHidden: true }) : diff(tail),
    );
    renderPane({
      comments: [comment("c1", 1), comment("c2", 2)],
      hide: true,
      drawnDiff: diff(HEADER, { whitespaceHidden: true, whitespaceOnly: true }),
    });
    await landed();
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: SHOW_WHITESPACE_LABEL }),
      ).toHaveLength(2),
    );
    expect(labelOf("c1")).toContain("x:1 · on a line hidden");
    expect(labelOf("c2")).toContain("x:2 · on a line hidden");
  });

  it("explains a GitHub position-only comment the -w diff hides", async () => {
    renderPane({
      comments: [comment("p", null, { position: 3 })],
      hide: true,
      drawnDiff: HIDDEN,
      diffSections: splitUnifiedDiff(PLAIN),
    });
    await landed();
    await waitFor(() =>
      expect(labelOf("p")).toContain(
        "x:2 · on a line hidden by Hide whitespace",
      ),
    );
  });

  it("holds Show whitespace live while a whitespace-view composer is open", async () => {
    const user = userEvent.setup();
    renderPane({ comments: [comment("c2", 2)], hide: true, drawnDiff: HIDDEN });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    const composer = document.createElement("div");
    composer.setAttribute("data-diff-line-widget", "whitespace");
    await act(async () => document.body.append(composer));
    const held = button() as HTMLElement;
    await waitFor(() =>
      expect(held.getAttribute("aria-disabled")).toBe("true"),
    );
    // Described by its row's label, then the hold's reason.
    expect(description(held)).toBe(
      `x:2 · on a line hidden by Hide whitespace ${WHITESPACE_COMPOSER_HELD}`,
    );
    await user.click(held);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    await act(async () => composer.remove());
    await waitFor(() =>
      expect(button()?.getAttribute("aria-disabled")).toBeNull(),
    );
    expect(button()).toBe(held);
    const layout = document.createElement("div");
    layout.setAttribute("data-diff-line-widget", "layout");
    await act(async () => document.body.append(layout));
    expect(button()?.getAttribute("aria-disabled")).toBeNull();
  });

  // An open list edit pins its row: no flip waits on it, and none moves it.
  it.each([
    ["the row it belongs to", comment("c2", 2, { viewerDidAuthor: true })],
    ["the whole-commit list", comment("w2", null, { path: null })],
    ["a row on another file", comment("y1", 1, { path: "y" })],
  ])("lets an open edit in %s keep Show whitespace free", async (_, own) => {
    const user = userEvent.setup();
    const authored = { ...own, viewerDidAuthor: true };
    const others = own.id === "c2" ? [] : [comment("c2", 2)];
    const pane = renderPane({
      comments: [...others, authored],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    await editAndType(user, own.id);
    expect(whitespaceComposerOpen()).toBe(false);
    expect(button()?.getAttribute("aria-disabled")).toBeNull();
    await user.click(button() as HTMLElement);
    await waitFor(() =>
      expect(saveSettingsPatch).toHaveBeenCalledWith(
        expect.objectContaining({ diffHideWhitespace: false }),
      ),
    );
    pane.repaint({ drawn: diff(PLAIN) });
    // The pinned row stays listed with its draft (its label shows, its body
    // is the editor); an unpinned line 2 goes inline.
    await waitFor(() =>
      expect(screen.queryByText("x:2") !== null).toBe(own.id === "c2"),
    );
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
      `note ${own.id} more`,
    );
  });
});

/** Opens the edit-in-place editor of a listed comment and types into it. */
async function editAndType(
  user: ReturnType<typeof userEvent.setup>,
  id: string,
) {
  const thread = screen
    .getByText(`note ${id}`)
    .closest(".group") as HTMLElement;
  await user.click(
    within(thread).getByRole("button", { name: "Comment actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Edit comment" }),
    " more",
  );
}

describe("an open list edit pins its row", () => {
  it("keeps the row listed while the pane draws its line, and frees it on Cancel", async () => {
    const user = userEvent.setup();
    const pane = renderPane({
      comments: [comment("c2", 2, { viewerDidAuthor: true })],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await editAndType(user, "c2");
    expect(pane.pinned()).toEqual(new Set(["c2"]));
    expect(whitespaceComposerOpen()).toBe(false);
    pane.repaint({ drawn: diff(PLAIN) });
    await settle();
    expect(screen.getByText("x:2")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "note c2 more",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(listed("c2")).toBe(false));
    expect(pane.pinned()).toEqual(new Set());
  });

  it("names no cut for a pinned row on a line the patch holds", async () => {
    const user = userEvent.setup();
    const pane = renderPane({
      comments: [comment("c2", 2, { viewerDidAuthor: true })],
      hide: false,
      drawnDiff: null,
    });
    await landed();
    await editAndType(user, "c2");
    pane.repaint({ drawn: diff(PLAIN), cut: "cap" });
    await settle();
    expect(screen.getByText("x:2")).toBeTruthy();
    expect(screen.queryByText(/inline after/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(listed("c2")).toBe(false));
  });
});

/** The inline anchors the commit diff draws for file `x`. */
function InlineAnchors({
  comments,
  pinned = NO_PINS,
}: {
  comments: CommitCommentOut[];
  pinned?: ReadonlySet<string>;
}) {
  const { anchors, renderAnchor } = useCommitLineAnchors(
    comments,
    splitUnifiedDiff(PLAIN),
    "x",
    undefined,
    pinned,
  );
  return <div>{anchors.map((a) => renderAnchor(a))}</div>;
}

describe("inline commit comment anchors", () => {
  // An inline anchor offers no edit: an edit opens only in the list, where it
  // pins its row.
  it("offer no edit on a whitespace-only line or a real change", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <InlineAnchors
          comments={[
            comment("c2", 2, { viewerDidAuthor: true }),
            comment("c20", 20, { viewerDidAuthor: true }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("note c2")).toBeTruthy();
    expect(screen.getByText("note c20")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("leave out a pinned comment, keeping its line's others", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <InlineAnchors
          comments={[comment("a", 2), comment("b", 2), comment("c", 20)]}
          pinned={new Set(["a", "c"])}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("note b")).toBeTruthy();
    expect(screen.queryByText("note a")).toBeNull();
    expect(screen.queryByText("note c")).toBeNull();
  });
});

describe("a listed comment's note on the painted file", () => {
  it("leaves an unresolved position unnoted while the paint is pending", async () => {
    const view = renderPane({
      comments: [comment("u", null)],
      hide: false,
      drawnDiff: diff(PLAIN),
      cut: "pending",
    });
    await landed();
    await settle();
    expect(labelOf("u")).toBe("x");
    view.repaint({ drawn: diff(PLAIN), cut: null });
    await waitFor(() =>
      expect(labelOf("u")).toBe("x · couldn't place in this diff"),
    );
  });

  it("names Raw, then Show diff anyway, then Show full diff over a mega-line Markdown preview", async () => {
    const mega = "m".repeat(20_001);
    const body = Array.from({ length: 300 }, (_, i) =>
      i === 0 ? `+${mega}` : `+l${i + 1}`,
    ).join("\n");
    const text = `diff --git a/x b/x\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,300 @@\n${body}\n`;
    renderPane({
      comments: [comment("early", 2), comment("late", 250)],
      hide: false,
      drawnDiff: diff(text),
      cut: "preview",
      mounts: false,
    });
    await landed();
    await waitFor(() =>
      expect(labelOf("early")).toBe(
        "x:2 · inline in Raw, then Show diff anyway",
      ),
    );
    expect(labelOf("late")).toBe(
      "x:250 · inline in Raw, then Show diff anyway, then Show full diff",
    );
  });
});
