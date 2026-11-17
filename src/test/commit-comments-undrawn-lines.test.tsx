import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHOW_WHITESPACE_LABEL,
  WHITESPACE_COMPOSER_HELD,
  whitespaceComposerOpen,
} from "@/features/diff/whitespace-mode";
import {
  CommitComments,
  newSideLines,
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

function renderPane({
  comments,
  hide,
  drawnDiff,
  diffSections,
}: {
  comments: CommitCommentOut[];
  hide: boolean;
  drawnDiff?: FileDiff | null;
  diffSections?: ReturnType<typeof splitUnifiedDiff>;
}) {
  vi.mocked(forgeCommitComments).mockResolvedValue([...comments, WHOLE]);
  stored = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, stored);
  const props = drawnDiff === undefined ? {} : { drawnDiff };
  return render(
    <QueryClientProvider client={client}>
      <CommitComments
        repoPath="/repo"
        sha={SHA}
        canComment={false}
        remoteLabel="origin"
        selectedPath="x"
        diffSections={diffSections}
        lens="origin"
        {...props}
      />
    </QueryClientProvider>,
  );
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

  it("calls a line past the pane's line cap unplaced (AC4d)", async () => {
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
    await waitFor(() =>
      expect(labelOf("c300")).toContain("couldn't place in this diff"),
    );
    expect(button()).toBeNull();
    expect(plainCalls()).toBe(1);
  });

  it("judges the PR-commit host by its patch section, never whitespace (AC4e)", async () => {
    renderPane({
      comments: [comment("c21", 21), comment("c50", 50)],
      hide: true,
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

  it("judges nothing by a -w read once the setting is already off (AC4h)", async () => {
    renderPane({
      comments: [comment("c2", 2)],
      hide: false,
      drawnDiff: HIDDEN,
    });
    await landed();
    await settle();
    expect(listed("c2")).toBe(false);
    expect(plainCalls()).toBe(0);
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

  it("holds Show whitespace while a listed thread's edit is open, keeping its draft", async () => {
    const user = userEvent.setup();
    renderPane({
      comments: [comment("c2", 2, { viewerDidAuthor: true })],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    await user.click(
      within(rowOf("c2")).getByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Edit comment" });
    await user.type(editor, " more");
    const held = button() as HTMLElement;
    await user.click(held);
    await settle();
    await settle();
    // The flip would draw the thread inline and drop this row, editor and all.
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "note c2 more",
    );
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    expect(held.getAttribute("aria-disabled")).toBe("true");
    expect(description(held)).toBe(
      `x:2 · on a line hidden by Hide whitespace ${WHITESPACE_COMPOSER_HELD}`,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(button()?.getAttribute("aria-disabled")).toBeNull(),
    );
  });

  // Only a whitespace row leaves the list on the flip; these editors stay mounted.
  it.each([
    ["the whole-commit list", comment("w2", null, { path: null })],
    ["a row on another file", comment("y1", 1, { path: "y" })],
  ])("lets an open edit in %s keep Show whitespace free", async (_, own) => {
    const user = userEvent.setup();
    const authored = { ...own, viewerDidAuthor: true };
    renderPane({
      comments: [comment("c2", 2), authored],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    const thread = screen
      .getByText(`note ${own.id}`)
      .closest(".group") as HTMLElement;
    await user.click(
      within(thread).getByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Edit comment" });
    await user.type(editor, " more");
    await settle();
    expect(button()?.getAttribute("aria-disabled")).toBeNull();
    await user.click(button() as HTMLElement);
    await waitFor(() =>
      expect(saveSettingsPatch).toHaveBeenCalledWith(
        expect.objectContaining({ diffHideWhitespace: false }),
      ),
    );
    await waitFor(() => expect(listed("c2")).toBe(false));
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

// Turning Hide whitespace off leaves every selected-file row with a resolved
// line out of the list until the shown read lands, whatever its reason.
describe("an open edit in a row the flip may drop", () => {
  it("holds while the plain read is out", async () => {
    const user = userEvent.setup();
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, _f, iw) =>
      iw ? HIDDEN : new Promise<FileDiff>(() => undefined),
    );
    renderPane({
      comments: [comment("c2", 2, { viewerDidAuthor: true })],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await settle();
    expect(button()).toBeNull();
    expect(whitespaceComposerOpen()).toBe(false);
    await editAndType(user, "c2");
    expect(whitespaceComposerOpen()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(whitespaceComposerOpen()).toBe(false);
  });

  it("holds when the plain read failed", async () => {
    const user = userEvent.setup();
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, _f, iw) => {
      if (iw) return HIDDEN;
      throw new Error("boom");
    });
    renderPane({
      comments: [comment("c2", 2, { viewerDidAuthor: true })],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() =>
      expect(labelOf("c2")).toContain("couldn't place in this diff"),
    );
    expect(whitespaceComposerOpen()).toBe(false);
    await editAndType(user, "c2");
    expect(whitespaceComposerOpen()).toBe(true);
  });

  // Turning Hide whitespace on draws a `-w` read, whose hunks git can align
  // over lines no shown hunk covers, or past a truncated shown read's cut.
  it.each([
    // Line 20 is in the `-w` read's hunk, past the cut of a read that kept only
    // the first hunk.
    ["c20", 20, diff(HEADER + WS_HUNK, { isTruncated: true })],
    // A complete shown read: line 11 is in the realigned `-w` hunk only.
    ["c11", 11, diff(REALIGN_SHOWN)],
  ])(
    "with whitespace shown, an edit on listed %s holds the flip",
    async (id, line, drawnDiff) => {
      const user = userEvent.setup();
      renderPane({
        comments: [comment(id, line, { viewerDidAuthor: true })],
        hide: false,
        drawnDiff,
      });
      await landed();
      await waitFor(() => expect(listed(id)).toBe(true));
      expect(whitespaceComposerOpen()).toBe(false);
      await editAndType(user, id);
      expect(whitespaceComposerOpen()).toBe(true);
    },
  );

  it("never holds on a host whose diff doesn't follow the setting", async () => {
    const user = userEvent.setup();
    renderPane({
      comments: [comment("c10", 10, { viewerDidAuthor: true })],
      hide: false,
      diffSections: splitUnifiedDiff(PLAIN),
    });
    await landed();
    await waitFor(() => expect(listed("c10")).toBe(true));
    await editAndType(user, "c10");
    expect(whitespaceComposerOpen()).toBe(false);
  });

  it("holds on a line the shown read also lacks, keeping the draft", async () => {
    const user = userEvent.setup();
    renderPane({
      comments: [
        comment("c2", 2),
        comment("c10", 10, { viewerDidAuthor: true }),
      ],
      hide: true,
      drawnDiff: HIDDEN,
    });
    await landed();
    await waitFor(() => expect(button()).toBeTruthy());
    expect(labelOf("c10")).toContain("couldn't place in this diff");
    await editAndType(user, "c10");
    const held = button() as HTMLElement;
    await waitFor(() =>
      expect(held.getAttribute("aria-disabled")).toBe("true"),
    );
    await user.click(held);
    await settle();
    await settle();
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "note c10 more",
    );
  });
});

/** The inline anchors the commit diff draws for file `x`. */
function InlineAnchors({ comments }: { comments: CommitCommentOut[] }) {
  const anchors = useCommitLineAnchors(comments, splitUnifiedDiff(PLAIN), "x");
  return <div>{anchors.map((a) => a.render())}</div>;
}

describe("inline commit comment anchors", () => {
  // A whitespace flip moves a comment between the diff and the hidden list, so
  // an editor added here would need the whitespace probe's mark too.
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
});
