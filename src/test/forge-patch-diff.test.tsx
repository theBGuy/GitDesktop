import { DiffFile } from "@git-diff-view/react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQueries,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IMAGE_CAPTION_REASON } from "@/components/markdown/markdown-images";
import {
  contentSourceKey,
  FORGE_CONTENT_BUDGET_BYTES,
} from "@/features/diff/content-source";
import { DiffContent, type LineWidget } from "@/features/diff/DiffSurface";
import { HOLD_BOUND_MS } from "@/features/diff/diff-pane-slots";
import { ImagePanes } from "@/features/diff/ImageDiff";
import { SHOW_FULL_COMPOSER_HELD } from "@/features/diff/whitespace-mode";
import { ReviewThreadCard } from "@/features/pulls/ReviewThreads";
import { type FileBytes, forgeFileAtSha, gitFileBase64 } from "@/lib/git/api";
import {
  commitFirstParentOptions,
  fileAtRevOptions,
  forgeFileAtShaOptions,
} from "@/lib/git/queries";
import type { FileDiff, ReviewThreadOut } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeFileAtSha: vi.fn(),
  forgeCommitFirstParent: vi.fn(async () => null),
  gitFileBase64: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

beforeAll(stubCanvas);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const n of document.querySelectorAll("[data-stand-in]")) n.remove();
});

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
/** A 40-line file edited at line 2 and at line 32: two hunks over a gap. */
const OLD = lines(40);
const NEW = OLD.replace("line 2\n", "line two\n").replace(
  "line 32\n",
  "line thirty-two\n",
);
const TEXT =
  "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n" +
  "@@ -31,3 +31,3 @@\n line 31\n-line 32\n+line thirty-two\n line 33\n";
const DIFF: FileDiff = {
  filePath: "f.txt",
  text: TEXT,
  isBinary: false,
  isTruncated: false,
};
const bytes = (text: string): FileBytes =>
  ({
    base64: Buffer.from(text).toString("base64"),
    mime: null,
    tooLarge: false,
    size: text.length,
  }) as FileBytes;

/** Whole-file reads, forge or local, that answer only when the test lands
 *  them, by sha. */
function deferredReads() {
  const waiting = new Map<string, (b: FileBytes | null) => void>();
  const wait = (sha: string | null) =>
    new Promise<FileBytes | null>((resolve) => waiting.set(sha ?? "", resolve));
  vi.mocked(forgeFileAtSha)
    .mockClear()
    .mockImplementation((_repo, sha) => wait(sha));
  vi.mocked(gitFileBase64)
    .mockClear()
    .mockImplementation((_repo, rev) => wait(rev));
  return async (
    oldText: string,
    newText: string,
    oldSha = OLD_SHA,
    newSha = NEW_SHA,
  ) => {
    await act(async () => {
      waiting.get(oldSha)?.(bytes(oldText));
      waiting.get(newSha)?.(bytes(newText));
    });
    await act(async () => undefined);
  };
}

type PaneProps = Partial<ComponentProps<typeof DiffContent>>;
const FORGE: PaneProps = {
  contentRevs: { oldRev: OLD_SHA, newRev: NEW_SHA },
  imageRevs: { old: OLD_SHA, new: NEW_SHA },
  forgePatch: { source: { lens: "origin" } },
};
const LOCAL: PaneProps = { ...FORGE, forgePatch: { source: "local" } };
/** A PR host's first paint: the marker, with no revs or source yet. */
const UNKNOWN: PaneProps = { forgePatch: { source: null } };

/** The query keys of the whole-file reads a pane with `p` makes. */
function readKeys(p: PaneProps): (readonly unknown[])[] {
  const source = p.forgePatch?.source;
  const revs = p.contentRevs;
  if (!source || !revs) return [];
  return [revs.oldRev, revs.newRev].map((rev) =>
    source === "local"
      ? fileAtRevOptions("/repo", rev ?? null, "f.txt").queryKey
      : forgeFileAtShaOptions(
          "/repo",
          source.lens,
          rev ?? "",
          "f.txt",
          FORGE_CONTENT_BUDGET_BYTES,
        ).queryKey,
  );
}

/** Marks the render in which the pane's reads have landed: react-query
 *  notifies this disabled observer of the same keys in the same batch. */
function ReadsLanded({ keys }: { keys: (readonly unknown[])[] }) {
  const reads = useQueries({
    queries: keys.map((queryKey) => ({
      queryKey: [...queryKey],
      enabled: false,
    })),
  });
  return keys.length > 0 && reads.every((r) => r.data !== undefined) ? (
    <span data-reads-landed="" />
  ) : null;
}

/** Waits for the pane's reads to reach its observers: react-query notifies in
 *  a later task, so flushing microtasks alone proves nothing. */
async function landed(view: { container: HTMLElement }) {
  await waitFor(() =>
    expect(view.container.querySelector("[data-reads-landed]")).not.toBeNull(),
  );
  await act(async () => undefined);
}

function mountPane(props: PaneProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  const ui = (p: PaneProps) => (
    <QueryClientProvider client={client}>
      <DiffContent
        filePath="f.txt"
        data={DIFF}
        isPending={false}
        isError={false}
        repoPath="/repo"
        {...p}
      />
      <ReadsLanded keys={readKeys(p)} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  const group = () =>
    view.container.querySelector<HTMLElement>('[role="group"][aria-label]');
  const expands = () => view.container.querySelectorAll('[title^="Expand"]');
  const rows = () => view.container.querySelectorAll("tr[data-line]");
  const update = (p: PaneProps) => view.rerender(ui(p));
  return { ...view, client, group, expands, rows, update };
}

function renderPane(lineWidget?: LineWidget) {
  return mountPane({ ...FORGE, lineWidget });
}

/** Counts the times the diff's rows dropped to none, over the whole run: a
 *  blank that lasts to a microtask checkpoint is one a frame could paint. */
function watchBlanks(container: HTMLElement) {
  let blanks = 0;
  const observer = new MutationObserver(() => {
    if (container.querySelectorAll("tr[data-line]").length === 0) blanks++;
  });
  observer.observe(container, { childList: true, subtree: true });
  return {
    blanks: () => {
      observer.disconnect();
      return blanks;
    },
  };
}

/** jsdom lays nothing out: table rows stack in document order, 20px each, and
 *  a row of expand controls (content mode's gap rows) 40px, under whatever
 *  `above` says sits over the rows in the scroller. */
function stubLayout(above: (scroller: Element) => number = () => 0) {
  let top = 0;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => 0);
  const height = (tr: Element) =>
    tr.querySelector('[title^="Expand"]') ? 40 : 20;
  const offsetOf = (tr: Element) => {
    const box = tr.closest(".overflow-auto");
    const all = [...(box?.querySelectorAll("tr") ?? [])];
    let y = box ? above(box) : 0;
    for (const row of all.slice(0, all.indexOf(tr as HTMLTableRowElement)))
      y += height(row);
    return y;
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.tagName !== "TR" || !this.closest(".overflow-auto"))
        return { top: 0, bottom: 0 } as DOMRect;
      const y = offsetOf(this) - top;
      return { top: y, bottom: y + height(this) } as DOMRect;
    },
  );
  let scroller: HTMLElement | null = null;
  return {
    /** Gives the pane's scroller a scrollTop the stub reads. */
    attach(container: HTMLElement) {
      scroller = container.querySelector(".overflow-auto") as HTMLElement;
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (v: number) => {
          top = v;
        },
      });
    },
    /** The content offset of the row drawing new line `n`. */
    rowOf(n: number) {
      const row = [...(scroller?.querySelectorAll("tr") ?? [])].find(
        (tr) => tr.querySelector(`span[data-line-new-num="${n}"]`) !== null,
      );
      if (!row) throw new Error(`no row draws new line ${n}`);
      return offsetOf(row);
    },
    /** Scrolls to `y` and runs the frames that read the line shown there. */
    scrollTo(y: number) {
      top = y;
      scroller?.dispatchEvent(new Event("scroll"));
      for (const frame of frames.splice(0)) frame(0);
    },
    top: () => top,
  };
}

describe("a forge-patch diff", () => {
  it("paints hunk-only first, then upgrades in place once the reads match", async () => {
    const land = deferredReads();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    expect(pane.expands().length).toBe(0);
    // Content mode's budgeted forge reads, never a local object read.
    expect(forgeFileAtSha).toHaveBeenCalledWith(
      "/repo",
      OLD_SHA,
      "f.txt",
      "origin",
      FORGE_CONTENT_BUDGET_BYTES,
    );
    expect(gitFileBase64).not.toHaveBeenCalled();
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    expect(pane.rows().length).toBeGreaterThan(0);
  });

  it("stays hunk-only when the reads are not the diff's files", async () => {
    const land = deferredReads();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    // Every hunk matches; the gap between them doesn't.
    await land(OLD, NEW.replace("line 20\n", "line twenty\n"));
    // Longer than the matching case's upgrade takes, so a build would show.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(pane.expands().length).toBe(0);
    expect(pane.rows().length).toBeGreaterThan(0);
  });

  it.each([
    ["a line composer", () => marker("data-diff-line-widget", "layout")],
    ["a comment edit", () => inAnchor("data-thread-editing")],
    ["a thread reply or a draft edit", () => inAnchor("data-diff-editor")],
  ])("holds the upgrade while %s is open inside it", async (_, make) => {
    const land = deferredReads();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    const row = pane.rows()[0];
    const editor = make();
    pane.group()?.append(editor);
    await act(async () => undefined);
    await land(OLD, NEW);
    await landed(pane);
    expect(pane.expands().length).toBe(0);
    expect(row.isConnected).toBe(true);
    editor.remove();
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
  });

  it("holds the upgrade while a mounted node's editor mark is on, and releases once it turns off in place", async () => {
    const land = deferredReads();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    const row = pane.rows()[0];
    // A host's node that stays mounted and flips its mark, as the pending
    // review bar does around a draft edit.
    const anchor = marker("data-diff-anchor", "layout");
    const node = marker("data-stand-in");
    anchor.append(node);
    pane.group()?.append(anchor);
    await act(async () => undefined);
    act(() => node.setAttribute("data-diff-editor", "true"));
    await act(async () => undefined);
    await land(OLD, NEW);
    await landed(pane);
    expect(pane.expands().length).toBe(0);
    expect(row.isConnected).toBe(true);
    act(() => node.removeAttribute("data-diff-editor"));
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
  });

  it("is not held by an editor open in another diff", async () => {
    const land = deferredReads();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    document.body.append(inAnchor("data-diff-editor"));
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
  });

  it("lands focus that was inside the replaced rows on the diff's group", async () => {
    const land = deferredReads();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    const cell = pane.rows()[1].querySelector("td") as HTMLElement;
    cell.tabIndex = -1;
    act(() => cell.focus());
    expect(document.activeElement).toBe(cell);
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    expect(cell.isConnected).toBe(false);
    expect(document.activeElement).toBe(pane.group());
  });

  it("keeps the reader's top line across the upgrade", async () => {
    const land = deferredReads();
    const layout = stubLayout();
    const pane = renderPane();
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    layout.attach(pane.container);
    const before = layout.rowOf(32);
    expect(before).toBeGreaterThan(0);
    layout.scrollTo(before);
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    await act(async () => undefined);
    const after = layout.rowOf(32);
    // The content build lays out differently above the line, or this proves
    // nothing.
    expect(after).not.toBe(before);
    expect(layout.top()).toBe(after);
  });

  it("AC-R6: a drag from one hunk into the next reaches the composer as one range", async () => {
    vi.mocked(forgeFileAtSha).mockImplementation(
      () => new Promise(() => undefined),
    );
    const received: { line: number; fromLine?: number }[] = [];
    const lineWidget: LineWidget = {
      enabled: true,
      render: ({ line, fromLine }) => {
        received.push({ line, fromLine });
        return null;
      },
    } as LineWidget;
    const pane = renderPane(lineWidget);
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    const numCell = (n: number) =>
      pane.container
        .querySelector(`span[data-line-new-num="${n}"]`)
        ?.closest(".diff-line-num") as HTMLElement;
    fireEvent.mouseDown(numCell(2));
    fireEvent.mouseOver(numCell(32));
    fireEvent.mouseUp(document);
    const plus = numCell(32)
      ?.closest("tr")
      ?.querySelector(".diff-add-widget") as HTMLElement;
    fireEvent.mouseDown(plus);
    await act(async () => undefined);
    expect(received.at(-1)).toEqual({ line: 32, fromLine: 2 });
  });
});

function marker(name: string, value = "") {
  const el = document.createElement("div");
  el.setAttribute(name, value);
  el.setAttribute("data-stand-in", "");
  return el;
}
function inAnchor(name: string) {
  const anchor = marker("data-diff-anchor", "layout");
  anchor.append(marker(name));
  return anchor;
}

/** Opens the line composer on new line `line`. */
function openComposer(container: HTMLElement, line: number) {
  const num = container
    .querySelector(`span[data-line-new-num="${line}"]`)
    ?.closest(".diff-line-num") as HTMLElement;
  fireEvent.mouseOver(num);
  const plus = num
    .closest("tr")
    ?.querySelector(".diff-add-widget") as HTMLElement;
  fireEvent.mouseDown(plus);
}

describe("a PR host's build across its revs arriving and changing", () => {
  const NEW2_SHA = "c".repeat(40);
  const PAIR2: PaneProps = {
    contentRevs: { oldRev: OLD_SHA, newRev: NEW2_SHA },
    imageRevs: { old: OLD_SHA, new: NEW2_SHA },
    forgePatch: { source: { lens: "origin" } },
  };
  /** The diff with only its first hunk: new text for the same path. */
  const TEXT2 = TEXT.slice(0, TEXT.indexOf("@@ -31"));

  /** Content mode on screen from the forge pair. */
  async function contentOnScreen() {
    const land = deferredReads();
    const pane = mountPane(FORGE);
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    return { pane, land, row: pane.rows()[0] };
  }

  it("never blanks its first paint, and upgrades a local source through the release step", async () => {
    const land = deferredReads();
    const layout = stubLayout();
    const pane = mountPane(UNKNOWN);
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    const watch = watchBlanks(pane.container);
    layout.attach(pane.container);
    const before = layout.rowOf(32);
    layout.scrollTo(before);
    pane.update(LOCAL);
    await waitFor(() => expect(gitFileBase64).toHaveBeenCalled());
    await act(async () => undefined);
    // The local reads are in flight: the painted build stays, never blank.
    expect(pane.rows().length).toBeGreaterThan(0);
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    await act(async () => undefined);
    const after = layout.rowOf(32);
    expect(after).not.toBe(before);
    expect(layout.top()).toBe(after);
    // Not one render of the whole sequence left the diff without rows.
    expect(watch.blanks()).toBe(0);
  });

  it("holds other content for the same text while an editor is open, then rebuilds keeping the top line", async () => {
    const layout = stubLayout();
    const { pane, land } = await contentOnScreen();
    // Every gap drawn, so the new content's middle line would show.
    for (let i = 0; i < 10 && pane.expands().length > 0; i++)
      fireEvent.click(pane.expands()[0]);
    await waitFor(() => expect(pane.expands().length).toBe(0));
    layout.attach(pane.container);
    // A wheel hands the line back to scrolling, as a reader's scroll does.
    fireEvent.wheel(pane.container);
    layout.scrollTo(layout.rowOf(32));
    expect(layout.top()).toBeGreaterThan(0);
    const editor = inAnchor("data-diff-editor");
    pane.group()?.append(editor);
    await act(async () => undefined);
    // A new pair whose files differ only outside the hunks: the same text.
    const OLD3_SHA = "d".repeat(40);
    pane.update({
      ...PAIR2,
      contentRevs: { oldRev: OLD3_SHA, newRev: NEW2_SHA },
    });
    const twenty = (s: string) => s.replace("line 20\n", "line twenty\n");
    await land(twenty(OLD), twenty(NEW), OLD3_SHA, NEW2_SHA);
    await landed(pane);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const text = () => pane.container.textContent ?? "";
    expect(text()).toContain("line 20");
    expect(text()).not.toContain("line twenty");
    act(() => editor.remove());
    await waitFor(() => expect(text()).not.toContain("line 20"));
    await act(async () => undefined);
    expect(layout.top()).toBe(layout.rowOf(32));
    // The rebuild is the new pair's content, not hunk-only: its gap draws the
    // new middle line.
    for (let i = 0; i < 10 && pane.expands().length > 0; i++)
      fireEvent.click(pane.expands()[0]);
    await waitFor(() => expect(text()).toContain("line twenty"));
  });

  it("keeps the reader's top line when SVG panes appear above the rows", async () => {
    const land = deferredReads();
    // Each drawn image side stands 100px tall over the rows.
    const layout = stubLayout(
      (scroller) => scroller.querySelectorAll("figure").length * 100,
    );
    const svg: PaneProps = {
      filePath: "a.svg",
      data: {
        ...DIFF,
        filePath: "a.svg",
        text: TEXT.replaceAll("f.txt", "a.svg"),
      },
    };
    const pane = mountPane({ ...UNKNOWN, ...svg });
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    layout.attach(pane.container);
    const before = layout.rowOf(32);
    layout.scrollTo(before);
    pane.update({
      ...svg,
      imageRevs: FORGE.imageRevs,
      forgePatch: FORGE.forgePatch,
    });
    await land("<svg/>", "<svg/>");
    await waitFor(() =>
      expect(pane.container.querySelectorAll("figure").length).toBe(2),
    );
    await act(async () => undefined);
    const after = layout.rowOf(32);
    // The panes moved the line down, or this proves nothing.
    expect(after).toBe(before + 200);
    expect(layout.top()).toBe(after);
  });

  it("keeps a composer's text through a failed revs read and the local upgrade", async () => {
    const land = deferredReads();
    let close: () => void = () => undefined;
    const lineWidget: LineWidget = {
      enabled: true,
      render: ({ onClose }) => {
        close = onClose;
        return <textarea aria-label="Draft" />;
      },
    };
    const pane = mountPane({ ...UNKNOWN, lineWidget });
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    openComposer(pane.container, 2);
    const draft = (await screen.findByRole("textbox", {
      name: "Draft",
    })) as HTMLTextAreaElement;
    draft.value = "kept";
    // A failed revs read re-renders with nothing new; its retry lands them.
    pane.update({ ...UNKNOWN, lineWidget });
    pane.update({ ...LOCAL, lineWidget });
    await land(OLD, NEW);
    await landed(pane);
    expect(draft.isConnected).toBe(true);
    expect(draft.value).toBe("kept");
    expect(pane.expands().length).toBe(0);
    act(() => close());
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
  });

  it("keeps a composer's text past a refresh's hold when a failed read's retry lands, then upgrades once it closes", async () => {
    // The new side's first read fails (a refusal, so it settles with no
    // automatic retries); a later retry for the same pair answers.
    let newFails = true;
    vi.mocked(forgeFileAtSha).mockImplementation(async (_repo, sha) => {
      if (sha === NEW_SHA && newFails)
        throw { kind: "invalidArgument", message: "refused" };
      return bytes(sha === OLD_SHA ? OLD : NEW);
    });
    let close: () => void = () => undefined;
    const lineWidget: LineWidget = {
      enabled: true,
      render: ({ onClose }) => {
        close = onClose;
        return <textarea aria-label="Draft" />;
      },
    };
    const pane = mountPane({ ...FORGE, lineWidget });
    const newKey = readKeys(FORGE)[1];
    await waitFor(() =>
      expect(pane.client.getQueryState(newKey)?.status).toBe("error"),
    );
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    await act(async () => undefined);
    openComposer(pane.container, 2);
    const draft = (await screen.findByRole("textbox", {
      name: "Draft",
    })) as HTMLTextAreaElement;
    draft.value = "kept";
    const row = pane.rows()[0];
    const builds = vi.spyOn(DiffFile, "createInstance");
    newFails = false;
    await act(async () => {
      await pane.client.refetchQueries({ queryKey: newKey });
    });
    await landed(pane);
    // Past the refresh hold's bound, which then lets the same inputs through.
    await act(
      () => new Promise((resolve) => setTimeout(resolve, HOLD_BOUND_MS + 200)),
    );
    const shown = screen.getByRole("textbox", {
      name: "Draft",
    }) as HTMLTextAreaElement;
    expect(shown.value).toBe("kept");
    expect(shown).toBe(draft);
    expect(row.isConnected).toBe(true);
    expect(builds).not.toHaveBeenCalled();
    expect(pane.expands().length).toBe(0);
    act(() => close());
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
  });

  it("keeps a content build when the host loses its revs and source", async () => {
    const { pane, row } = await contentOnScreen();
    pane.update(UNKNOWN);
    await act(async () => undefined);
    expect(row.isConnected).toBe(true);
    expect(pane.expands().length).toBeGreaterThan(0);
  });

  it("keeps a content build across a new head until the diff text changes", async () => {
    const { pane, land, row } = await contentOnScreen();
    pane.update(UNKNOWN);
    pane.update(PAIR2);
    await act(async () => undefined);
    expect(row.isConnected).toBe(true);
    await land(OLD, NEW, OLD_SHA, NEW2_SHA);
    await landed(pane);
    expect(row.isConnected).toBe(true);
    expect(pane.expands().length).toBeGreaterThan(0);
    pane.update({ ...PAIR2, data: { ...DIFF, text: TEXT2 } });
    await waitFor(() => expect(row.isConnected).toBe(false));
    expect(pane.expands().length).toBe(0);
  });
});

describe("a PR host's build across a change of record", () => {
  const OLD2_SHA = "d".repeat(40);
  const NEW2_SHA = "c".repeat(40);
  const A: PaneProps = {
    ...FORGE,
    forgePatch: { source: { lens: "origin" }, scope: "origin#7" },
  };
  /** Another pull request's pair for the same path and the same diff text. */
  const B: PaneProps = {
    contentRevs: { oldRev: OLD2_SHA, newRev: NEW2_SHA },
    imageRevs: { old: OLD2_SHA, new: NEW2_SHA },
    forgePatch: { source: { lens: "origin" }, scope: "origin#8" },
  };
  /** B's files: the same change, another line outside its hunks. */
  const twenty = (s: string) => s.replace("line 20\n", "line twenty\n");
  const text = (pane: { container: HTMLElement }) =>
    pane.container.textContent ?? "";

  /** A's content on screen with every gap drawn, so its line 20 shows. */
  async function aExpanded() {
    const land = deferredReads();
    const pane = mountPane(A);
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    await land(OLD, NEW);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    for (let i = 0; i < 10 && pane.expands().length > 0; i++)
      fireEvent.click(pane.expands()[0]);
    await waitFor(() => expect(pane.expands().length).toBe(0));
    expect(text(pane)).toContain("line 20");
    return { pane, land };
  }

  it("never shows a record's lines under another record's identical diff", async () => {
    const { pane } = await aExpanded();
    const drawn = pane.rows().length;
    pane.update(B);
    await waitFor(() =>
      expect(forgeFileAtSha).toHaveBeenCalledWith(
        "/repo",
        NEW2_SHA,
        "f.txt",
        "origin",
        FORGE_CONTENT_BUDGET_BYTES,
      ),
    );
    await act(async () => undefined);
    expect(text(pane)).not.toContain("line 20");
    expect(pane.rows().length).toBeGreaterThan(0);
    expect(pane.rows().length).toBeLessThan(drawn);
  });

  it("keeps a record's build under the next record's placeholder paint", async () => {
    const { pane } = await aExpanded();
    const row = pane.rows()[0];
    const drawn = pane.rows().length;
    const watch = watchBlanks(pane.container);
    pane.update({
      forgePatch: { source: null, scope: "origin#8" },
      dataIsPlaceholder: true,
    });
    await act(async () => undefined);
    expect(row.isConnected).toBe(true);
    expect(pane.rows().length).toBe(drawn);
    expect(text(pane)).toContain("line 20");
    expect(watch.blanks()).toBe(0);
  });

  it("upgrades the next record through the release step once its own reads land", async () => {
    const layout = stubLayout();
    const { pane, land } = await aExpanded();
    pane.update(B);
    await waitFor(() => expect(text(pane)).not.toContain("line 20"));
    layout.attach(pane.container);
    fireEvent.wheel(pane.container);
    layout.scrollTo(layout.rowOf(32));
    expect(layout.top()).toBeGreaterThan(0);
    const editor = inAnchor("data-diff-editor");
    pane.group()?.append(editor);
    await act(async () => undefined);
    await land(twenty(OLD), twenty(NEW), OLD2_SHA, NEW2_SHA);
    await landed(pane);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // B's own reads match, and the open editor holds the upgrade.
    expect(pane.expands().length).toBe(0);
    act(() => editor.remove());
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    await act(async () => undefined);
    expect(layout.top()).toBe(layout.rowOf(32));
  });
});

describe("a PR host's image panes across a pair change", () => {
  const NEW2_SHA = "c".repeat(40);
  const NEW3_SHA = "e".repeat(40);
  /** GitHub's section: its index line names both blobs. */
  const PNG_TEXT =
    "diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ\n";
  /** GitLab's reconstructed section: no index line. */
  const PNG_BARE =
    "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
  const png = (text: string): FileDiff => ({
    filePath: "img.png",
    text,
    isBinary: true,
    isTruncated: false,
  });
  /** The host's live pair for record `scope`. */
  const pairOf = (newSha: string, scope = "origin#7"): PaneProps => ({
    filePath: "img.png",
    imageRevs: { old: OLD_SHA, new: newSha },
    forgePatch: { source: { lens: "origin" }, scope },
  });
  /** The host holds no pair for record `scope` (revs or presence pending). */
  const lost = (scope = "origin#7"): PaneProps => ({
    filePath: "img.png",
    forgePatch: { source: null, scope },
  });
  const figures = (view: { container: HTMLElement }) => [
    ...view.container.querySelectorAll("figure"),
  ];
  const srcOf = (view: { container: HTMLElement }, alt: string) =>
    view.container.querySelector(`img[alt="${alt}"]`)?.getAttribute("src");
  const pngSrc = (text: string) =>
    `data:image/png;base64,${Buffer.from(text).toString("base64")}`;
  /** Fires each drawn image's load, as a decode would. */
  function measure(view: { container: HTMLElement }) {
    for (const img of view.container.querySelectorAll("img")) {
      Object.defineProperty(img, "naturalWidth", { value: 10 });
      Object.defineProperty(img, "naturalHeight", { value: 20 });
      fireEvent.load(img);
    }
  }
  /** Panes for pair 1 on screen. */
  async function onScreen(props: PaneProps) {
    const land = deferredReads();
    const pane = mountPane(props);
    await land("old-1", "new-1");
    await waitFor(() => expect(figures(pane)).toHaveLength(2));
    return { pane, land };
  }
  /** Counts, over the whole run, the mutations that left no panes and those
   *  that left other panes than `nodes`. */
  function watchPanes(view: { container: HTMLElement }, nodes: Element[]) {
    const seen = { blank: 0, replaced: 0 };
    const observer = new MutationObserver(() => {
      const now = figures(view);
      if (now.length === 0) seen.blank++;
      else if (
        now.length !== nodes.length ||
        now.some((n, i) => n !== nodes[i])
      )
        seen.replaced++;
    });
    observer.observe(view.container, { childList: true, subtree: true });
    return { seen, stop: () => observer.disconnect() };
  }
  const settle = () =>
    act(() => new Promise((resolve) => setTimeout(resolve, 20)));

  it("draws the new head's pair once it lands, never a pair it kept", async () => {
    const { pane, land } = await onScreen({
      ...pairOf(NEW_SHA),
      data: png(PNG_TEXT),
    });
    // The push's new text lands while the host still holds the old head's
    // pair, then the host's revs re-read, then the new head's pair arrives.
    const TEXT2 = PNG_TEXT.replace("2222222", "3333333");
    pane.update({ ...pairOf(NEW_SHA), data: png(TEXT2) });
    pane.update({ ...lost(), data: png(TEXT2) });
    pane.update({ ...pairOf(NEW2_SHA), data: png(TEXT2) });
    await land("old-1", "new-2", OLD_SHA, NEW2_SHA);
    await waitFor(() => expect(srcOf(pane, "New")).toBe(pngSrc("new-2")));
  });

  it("draws a kept side under the path it was read at, never the new pair's", async () => {
    // A rename whose source moves to another format with the new head; the
    // reads sniff no type, so the extension names it.
    const renamed = (oldPath: string): FileDiff => ({
      ...png(PNG_TEXT),
      oldPath,
    });
    const { pane, land } = await onScreen({
      ...pairOf(NEW_SHA),
      data: renamed("pic.png"),
    });
    expect(srcOf(pane, "Old")).toBe(pngSrc("old-1"));
    pane.update({ ...pairOf(NEW2_SHA), data: renamed("pic.jpg") });
    await act(async () => undefined);
    expect(forgeFileAtSha).toHaveBeenCalledWith(
      "/repo",
      OLD_SHA,
      "pic.jpg",
      "origin",
      null,
    );
    expect(srcOf(pane, "Old")).toBe(pngSrc("old-1"));
    await land("old-2", "new-2", OLD_SHA, NEW2_SHA);
    await waitFor(() =>
      expect(srcOf(pane, "Old")).toBe(
        `data:image/jpeg;base64,${Buffer.from("old-2").toString("base64")}`,
      ),
    );
  });

  it("keeps the panes, their measurements, the viewer and focus while a new pair reads", async () => {
    const { pane, land } = await onScreen({
      ...pairOf(NEW_SHA),
      data: png(PNG_BARE),
    });
    measure(pane);
    await waitFor(() =>
      expect(pane.container.textContent).toContain("10 × 20"),
    );
    const nodes = figures(pane);
    const img = pane.container.querySelector('img[alt="New"]');
    const watch = watchPanes(pane, nodes);
    const view = screen.getByRole("button", {
      name: "View New image fullscreen",
    });
    act(() => view.focus());
    // A new pair whose new side's read is deferred, then lands the same bytes.
    pane.update({ ...pairOf(NEW2_SHA), data: png(PNG_BARE) });
    await act(async () => undefined);
    expect(forgeFileAtSha).toHaveBeenCalledWith(
      "/repo",
      NEW2_SHA,
      "img.png",
      "origin",
      null,
    );
    await land("old-1", "new-1", OLD_SHA, NEW2_SHA);
    await settle();
    expect(watch.seen.blank).toBe(0);
    expect(watch.seen.replaced).toBe(0);
    expect(document.activeElement).toBe(view);
    expect(pane.container.querySelector('img[alt="New"]')).toBe(img);
    expect(pane.container.textContent?.match(/10 × 20/g) ?? []).toHaveLength(2);
    // Different bytes, with the viewer open over the new side.
    fireEvent.click(view);
    const dialog = await screen.findByRole("dialog");
    const focused = document.activeElement;
    pane.update({ ...pairOf(NEW3_SHA), data: png(PNG_BARE) });
    await act(async () => undefined);
    await land("old-1", "new-3", OLD_SHA, NEW3_SHA);
    await waitFor(() => expect(img?.getAttribute("src")).toBe(pngSrc("new-3")));
    watch.stop();
    expect(watch.seen.blank).toBe(0);
    expect(watch.seen.replaced).toBe(0);
    expect(pane.container.querySelector('img[alt="New"]')).toBe(img);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(focused);
  });

  it("keeps the viewer on the side it opened, and closes it for good once that side leaves", async () => {
    const OLD2_SHA = "f".repeat(40);
    // Pair 1 adds the image; pair 2 modifies it; pair 3 deletes it.
    vi.mocked(forgeFileAtSha)
      .mockClear()
      .mockImplementation(async (_repo, sha) =>
        sha === OLD_SHA || sha === NEW3_SHA ? null : bytes(`at-${sha[0]}`),
      );
    const pane = mountPane({ ...pairOf(NEW_SHA), data: png(PNG_BARE) });
    await waitFor(() => expect(figures(pane)).toHaveLength(1));
    fireEvent.click(
      screen.getByRole("button", { name: "View Added image fullscreen" }),
    );
    const shownAlt = () =>
      screen.queryByRole("dialog")?.querySelector("img")?.getAttribute("alt");
    await waitFor(() => expect(shownAlt()).toBe("Added"));
    const both: PaneProps = {
      ...pairOf(NEW2_SHA),
      imageRevs: { old: OLD2_SHA, new: NEW2_SHA },
      data: png(PNG_BARE),
    };
    pane.update(both);
    await waitFor(() => expect(figures(pane)).toHaveLength(2));
    await settle();
    expect(shownAlt()).toBe("New");
    pane.update({
      ...pairOf(NEW3_SHA),
      imageRevs: { old: OLD2_SHA, new: NEW3_SHA },
      data: png(PNG_BARE),
    });
    await waitFor(() => expect(figures(pane)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The side coming back doesn't reopen a viewer the reader saw close.
    pane.update(both);
    await waitFor(() => expect(figures(pane)).toHaveLength(2));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the viewer's zoom and image when its side moves to another index", async () => {
    const OLD2_SHA = "f".repeat(40);
    // Pair 1 adds the image; pair 2 gains an old side, the new bytes unchanged.
    vi.mocked(forgeFileAtSha)
      .mockClear()
      .mockImplementation(async (_repo, sha) => {
        if (sha === OLD_SHA) return null;
        return bytes(sha === OLD2_SHA ? "old" : "same");
      });
    const pane = mountPane({ ...pairOf(NEW_SHA), data: png(PNG_BARE) });
    await waitFor(() => expect(figures(pane)).toHaveLength(1));
    fireEvent.click(
      screen.getByRole("button", { name: "View Added image fullscreen" }),
    );
    const dialog = await screen.findByRole("dialog");
    const shownImg = () => dialog.querySelector("img");
    await waitFor(() => expect(shownImg()?.getAttribute("alt")).toBe("Added"));
    const img = shownImg();
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "Zoom to 100%" })[0],
    );
    expect(
      within(dialog).getAllByRole("button", { name: "Fit to window" }),
    ).not.toHaveLength(0);
    pane.update({
      ...pairOf(NEW2_SHA),
      imageRevs: { old: OLD2_SHA, new: NEW2_SHA },
      data: png(PNG_BARE),
    });
    await waitFor(() => expect(figures(pane)).toHaveLength(2));
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(shownImg()?.getAttribute("alt")).toBe("New");
    expect(shownImg()).toBe(img);
    expect(
      within(dialog).getAllByRole("button", { name: "Fit to window" }),
    ).not.toHaveLength(0);
  });

  it("never falls back to the binary band while the revs are lost and the text changes", async () => {
    const { pane } = await onScreen({
      ...pairOf(NEW_SHA),
      data: png(PNG_TEXT),
    });
    const nodes = figures(pane);
    let band = 0;
    const observer = new MutationObserver(() => {
      if (pane.container.textContent?.includes("Binary file")) band++;
    });
    observer.observe(pane.container, { childList: true, subtree: true });
    pane.update({ ...lost(), data: png(PNG_TEXT) });
    pane.update({
      ...lost(),
      data: png(PNG_TEXT.replace("2222222", "3333333")),
    });
    await settle();
    observer.disconnect();
    expect(band).toBe(0);
    expect(figures(pane)).toEqual(nodes);
  });

  it("never carries a pair into another record", async () => {
    const { pane, land } = await onScreen({
      ...pairOf(NEW_SHA),
      data: png(PNG_TEXT),
    });
    pane.update({ ...lost("origin#8"), data: png(PNG_TEXT) });
    await settle();
    expect(figures(pane)).toHaveLength(0);
    pane.update({ ...pairOf(NEW2_SHA, "origin#8"), data: png(PNG_TEXT) });
    await land("old-1", "new-8", OLD_SHA, NEW2_SHA);
    await waitFor(() => expect(srcOf(pane, "New")).toBe(pngSrc("new-8")));
  });

  /** The host's pair read for record `scope` settled in error. */
  const refused = (scope = "origin#7"): PaneProps => ({
    filePath: "img.png",
    forgePatch: { source: null, scope, pairUnavailable: true },
  });

  it("drops a kept pair once the new head's pair can't be read, never while it reads", async () => {
    const { pane } = await onScreen({
      ...pairOf(NEW_SHA),
      data: png(PNG_TEXT),
    });
    const nodes = figures(pane);
    const TEXT2 = PNG_TEXT.replace("2222222", "3333333");
    // A push: the new head's revs read is in flight or retrying.
    pane.update({ ...lost(), data: png(TEXT2) });
    await settle();
    expect(figures(pane)).toEqual(nodes);
    expect(srcOf(pane, "New")).toBe(pngSrc("new-1"));
    // It settles refused: no figure of the old head's pair stays.
    pane.update({ ...refused(), data: png(TEXT2) });
    await settle();
    expect(figures(pane)).toHaveLength(0);
    expect(nodes.some((n) => n.isConnected)).toBe(false);
    expect(pane.container.textContent).toContain("Binary file");
    // A re-read in flight after that never brings the old pair back.
    pane.update({ ...lost(), data: png(TEXT2) });
    await settle();
    expect(figures(pane)).toHaveLength(0);
  });

  describe("an SVG's panes above a scrolled diff", () => {
    const svg: PaneProps = {
      filePath: "a.svg",
      data: {
        ...DIFF,
        filePath: "a.svg",
        text: TEXT.replaceAll("f.txt", "a.svg"),
      },
    };
    /** Panes of record A on screen, the reader on new line 32. */
    async function scrolled() {
      const land = deferredReads();
      // Each drawn image side stands 100px tall over the rows.
      const layout = stubLayout(
        (scroller) => scroller.querySelectorAll("figure").length * 100,
      );
      const pane = mountPane({
        ...svg,
        imageRevs: FORGE.imageRevs,
        forgePatch: { source: { lens: "origin" }, scope: "origin#7" },
      });
      await land("<svg/>", "<svg/>");
      await waitFor(() => expect(figures(pane)).toHaveLength(2));
      layout.attach(pane.container);
      // A wheel hands the line back to scrolling, as a reader's scroll does.
      fireEvent.wheel(pane.container);
      layout.scrollTo(layout.rowOf(32));
      expect(layout.top()).toBeGreaterThan(200);
      return { pane, layout };
    }

    it("keeps the previous record's panes under its placeholder paint", async () => {
      const { pane, layout } = await scrolled();
      const nodes = figures(pane);
      const top = layout.top();
      pane.update({
        ...svg,
        dataIsPlaceholder: true,
        forgePatch: { source: null, scope: "origin#8" },
      });
      await settle();
      expect(figures(pane)).toEqual(nodes);
      expect(layout.top()).toBe(top);
    });

    it("keeps the reader's top line when the panes leave from above the rows", async () => {
      const { pane, layout } = await scrolled();
      const row = pane.rows()[0];
      pane.update({ ...svg, forgePatch: { source: null, scope: "origin#8" } });
      await settle();
      expect(figures(pane)).toHaveLength(0);
      expect(row.isConnected).toBe(true);
      expect(layout.top()).toBe(layout.rowOf(32));
    });

    it("keeps the panes while the new pair reads, and the top line as they leave once it can't be read", async () => {
      const { pane, layout } = await scrolled();
      const nodes = figures(pane);
      const row = pane.rows()[0];
      pane.update({ ...svg, forgePatch: { source: null, scope: "origin#7" } });
      await settle();
      expect(figures(pane)).toEqual(nodes);
      pane.update({
        ...svg,
        forgePatch: { source: null, scope: "origin#7", pairUnavailable: true },
      });
      await settle();
      expect(figures(pane)).toHaveLength(0);
      expect(row.isConnected).toBe(true);
      expect(layout.top()).toBe(layout.rowOf(32));
    });
  });

  it("leaves a local host's panes as they were: an empty shell, then new nodes", async () => {
    const local = (newSha: string): PaneProps => ({
      filePath: "img.png",
      data: png(PNG_TEXT),
      imageRevs: { old: OLD_SHA, new: newSha },
    });
    const { pane, land } = await onScreen(local(NEW_SHA));
    const [first] = figures(pane);
    pane.update(local(NEW2_SHA));
    await act(async () => undefined);
    expect(figures(pane)).toHaveLength(0);
    await land("old-1", "new-2", OLD_SHA, NEW2_SHA);
    await waitFor(() => expect(figures(pane)).toHaveLength(2));
    expect(figures(pane)[0]).not.toBe(first);
  });

  it.each([
    ["rejects", false],
    ["is paused", true],
  ])(
    "shows a new pair's read that %s as failed, with Retry, never the kept image",
    async (_, offline) => {
      const { pane } = await onScreen({
        ...pairOf(NEW_SHA),
        data: png(PNG_TEXT),
      });
      vi.mocked(forgeFileAtSha).mockImplementation(async () => {
        throw new Error("read failed");
      });
      if (offline) onlineManager.setOnline(false);
      try {
        pane.update({ ...pairOf(NEW2_SHA), data: png(PNG_TEXT) });
        // A rejected read is retried once, a second later, before it fails.
        expect(
          await screen.findByText(IMAGE_CAPTION_REASON.readFailed, undefined, {
            timeout: 5_000,
          }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
        expect(srcOf(pane, "New")).toBeUndefined();
      } finally {
        onlineManager.setOnline(true);
      }
    },
    10_000,
  );

  it("shows a new pair's failed side at once while the other side's first read keeps its kept image", async () => {
    const OLD2_SHA = "d".repeat(40);
    const { pane } = await onScreen({
      ...pairOf(NEW_SHA),
      data: png(PNG_TEXT),
    });
    // Both sides re-key: the old side is refused (never retried), the new
    // side's first read stays in flight.
    let newRead: (b: FileBytes | null) => void = () => undefined;
    vi.mocked(forgeFileAtSha).mockImplementation((_repo, sha) =>
      sha === OLD2_SHA
        ? Promise.reject({ kind: "invalidArgument", message: "refused" })
        : new Promise((resolve) => {
            newRead = resolve;
          }),
    );
    pane.update({
      ...pairOf(NEW2_SHA),
      imageRevs: { old: OLD2_SHA, new: NEW2_SHA },
      data: png(PNG_TEXT),
    });
    expect(
      await screen.findByText(IMAGE_CAPTION_REASON.notImage),
    ).toBeInTheDocument();
    expect(srcOf(pane, "Old")).toBeUndefined();
    expect(srcOf(pane, "New")).toBe(pngSrc("new-1"));
    // The in-flight side lands: it draws its own bytes, the failed side stays.
    await act(async () => newRead(bytes("new-2")));
    await waitFor(() => expect(srcOf(pane, "New")).toBe(pngSrc("new-2")));
    expect(screen.getByText(IMAGE_CAPTION_REASON.notImage)).toBeInTheDocument();
  });
});

describe("a binary-to-link typechange on an image path", () => {
  const LINK_TEXT =
    "diff --git a/logo.png b/logo.png\ndeleted file mode 100644\nindex 1111111..0000000\nBinary files a/logo.png and /dev/null differ\n" +
    "diff --git a/logo.png b/logo.png\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/logo.png\n@@ -0,0 +1 @@\n+target.png\n\\ No newline at end of file\n";
  /** `answer` is every forge read's bytes; unset, the reads never answer. */
  function renderTypechange(typechangeAnchors: boolean, answer?: FileBytes) {
    vi.mocked(forgeFileAtSha).mockImplementation(() =>
      answer === undefined
        ? new Promise(() => undefined)
        : Promise.resolve(answer),
    );
    return mountPane({
      ...FORGE,
      filePath: "logo.png",
      data: {
        filePath: "logo.png",
        text: LINK_TEXT,
        isBinary: true,
        isTruncated: false,
      },
      typechangeAnchors,
    });
  }
  const linkLine = (view: { container: HTMLElement }) =>
    view.container.querySelector('span[data-line-new-num="1"]');

  it("draws both halves on a host that anchors them", async () => {
    const view = renderTypechange(true);
    await waitFor(() => expect(linkLine(view)).not.toBeNull());
  });

  it("keeps the image comparison on a host that doesn't", async () => {
    const view = renderTypechange(false, bytes("png"));
    // The comparison draws both sides, and the link half stays out.
    await waitFor(() =>
      expect(view.container.querySelectorAll("figure img").length).toBe(2),
    );
    await act(async () => undefined);
    expect(linkLine(view)).toBeNull();
  });
});

describe("an image pair's forge reads that can't run", () => {
  function renderPanes(oldRev: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <ImagePanes
          repoPath="/repo"
          filePath="a.png"
          oldPath="a.png"
          revs={{ old: oldRev, new: NEW_SHA }}
          forgePatch={{ source: { lens: "origin" } }}
        />
      </QueryClientProvider>,
    );
  }

  it("shows a side without a full sha as unavailable, never loading", async () => {
    vi.mocked(forgeFileAtSha).mockResolvedValue(bytes("png"));
    const view = renderPanes("abc1234");
    expect(
      await screen.findByText(IMAGE_CAPTION_REASON.notImage),
    ).toBeInTheDocument();
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps a local pair's empty shell when its first reads stop idle", async () => {
    vi.mocked(gitFileBase64).mockImplementation(
      () => new Promise(() => undefined),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <ImagePanes
          repoPath="/repo"
          filePath="a.png"
          oldPath="a.png"
          revs={{ old: OLD_SHA, new: NEW_SHA }}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(gitFileBase64).toHaveBeenCalledTimes(2));
    // A cancelled first read is pending and idle, with nothing scheduled.
    await act(() => client.cancelQueries());
    // react-query notifies its observers in a later task.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const reads = client.getQueryCache().getAll();
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.state.status).toBe("pending");
      expect(read.state.fetchStatus).toBe("idle");
    }
    expect(screen.queryByText(IMAGE_CAPTION_REASON.notImage)).toBeNull();
    expect(view.container.querySelector("figure")).toBeNull();
  });

  it("shows a paused read as failed, with Retry", async () => {
    onlineManager.setOnline(false);
    try {
      vi.mocked(forgeFileAtSha).mockResolvedValue(bytes("png"));
      const view = renderPanes(OLD_SHA);
      expect(
        await screen.findAllByText(IMAGE_CAPTION_REASON.readFailed),
      ).toHaveLength(2);
      expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe("the forge read keys", () => {
  it("sit outside the repo subtree, so a repo-wide invalidation never re-reads them", async () => {
    vi.mocked(forgeFileAtSha).mockResolvedValue(bytes("x"));
    const client = new QueryClient();
    const file = forgeFileAtShaOptions(
      "/repo",
      "origin",
      NEW_SHA,
      "f.txt",
      null,
    );
    const parent = commitFirstParentOptions("/repo", "origin", NEW_SHA);
    await client.fetchQuery(file);
    await client.fetchQuery(parent);
    await client.invalidateQueries({ queryKey: ["repo", "/repo"] });
    expect(client.getQueryState(file.queryKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(parent.queryKey)?.isInvalidated).toBe(false);
  });

  it("keep content mode's budgeted read apart from the image read", () => {
    const text = forgeFileAtShaOptions(
      "/repo",
      "origin",
      NEW_SHA,
      "a.svg",
      FORGE_CONTENT_BUDGET_BYTES,
    ).queryKey;
    const image = forgeFileAtShaOptions(
      "/repo",
      "origin",
      NEW_SHA,
      "a.svg",
      null,
    ).queryKey;
    expect(text).not.toEqual(image);
    expect(FORGE_CONTENT_BUDGET_BYTES).toBe(300_000);
  });

  it("spell a source as one key segment", () => {
    expect(contentSourceKey("local")).toBe("local");
    expect(contentSourceKey({ lens: "origin" })).toBe("forge:origin");
    expect(contentSourceKey({ lens: "upstream" })).toBe("forge:upstream");
  });
});

describe("an upgrade under a review thread card", () => {
  const CARD_THREAD: ReviewThreadOut = {
    id: "T_1",
    reviewId: "",
    path: "f.txt",
    line: 2,
    startLine: 0,
    side: "new",
    isResolved: false,
    isOutdated: false,
    diffHunk: "",
    comments: [
      {
        author: "someone",
        authorAvatarUrl: "",
        state: "",
        body: "Look at this line",
        date: "2026-01-01T00:00:00Z",
        id: "N_1",
        url: "",
        viewerDidAuthor: false,
        isMinimized: false,
        minimizedReason: "",
        reviewId: "",
      },
    ],
  };
  const ANCHORS = [
    {
      side: "new" as const,
      line: 2,
      render: () => (
        <ReviewThreadCard
          thread={CARD_THREAD}
          expanded
          compact
          onToggleExpand={() => undefined}
        />
      ),
    },
  ];

  it("lands focus from a thread card's button in the replaced rows on the diff's group", async () => {
    const land = deferredReads();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    const view = render(
      <QueryClientProvider client={client}>
        <DiffContent
          filePath="f.txt"
          data={DIFF}
          isPending={false}
          isError={false}
          repoPath="/repo"
          contentRevs={{ oldRev: OLD_SHA, newRev: NEW_SHA }}
          forgePatch={{ source: { lens: "origin" } }}
          lineAnchors={ANCHORS}
        />
      </QueryClientProvider>,
    );
    const cardButton = () =>
      view.container.querySelector<HTMLElement>("[data-diff-anchor] button");
    await waitFor(() => expect(cardButton()).not.toBeNull());
    const button = cardButton() as HTMLElement;
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    await land(OLD, NEW);
    await waitFor(() =>
      expect(
        view.container.querySelectorAll('[title^="Expand"]').length,
      ).toBeGreaterThan(0),
    );
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      view.container.querySelector('[role="group"][aria-label]'),
    );
  });
});

describe("Markdown preview on a forge-patch diff with a local source", () => {
  /** A Markdown file the pull request deletes. */
  const MD_DIFF: FileDiff = {
    filePath: "doc.md",
    text:
      "diff --git a/doc.md b/doc.md\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/doc.md\n+++ /dev/null\n" +
      "@@ -1,2 +0,0 @@\n-# Title\n-body\n",
    isBinary: false,
    isTruncated: false,
  };

  function renderMd(previewRev?: string) {
    vi.mocked(gitFileBase64).mockImplementation(async (_repo, rev) =>
      rev === OLD_SHA ? bytes("# Title\nbody\n") : null,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    const view = render(
      <QueryClientProvider client={client}>
        <DiffContent
          filePath="doc.md"
          data={MD_DIFF}
          isPending={false}
          isError={false}
          repoPath="/repo"
          contentRevs={{ oldRev: OLD_SHA, newRev: NEW_SHA }}
          forgePatch={{ source: "local" }}
          previewRev={previewRev}
        />
      </QueryClientProvider>,
    );
    const preview = () =>
      Array.from(view.container.querySelectorAll("button")).find(
        (b) => b.textContent === "Preview",
      );
    return { ...view, preview };
  }

  it("offers no Preview without the host's head rev", async () => {
    const pane = renderMd();
    await waitFor(() =>
      expect(
        pane.container.querySelectorAll("tr[data-line]").length,
      ).toBeGreaterThan(0),
    );
    await act(async () => undefined);
    expect(pane.preview()).toBeUndefined();
  });

  it("previews only the head rev, never the deleted file's previous version", async () => {
    const pane = renderMd(NEW_SHA);
    await waitFor(() => expect(pane.preview()).toBeDefined());
    act(() => pane.preview()?.click());
    // The preview's own answer for the head, where the file is gone; the
    // previous version would render its heading under a deleted-file note.
    await waitFor(() =>
      expect(pane.queryByText("Nothing to preview")).not.toBeNull(),
    );
    expect(
      pane.queryByText("File deleted — previewing the previous version."),
    ).toBeNull();
    expect(pane.queryByRole("heading", { name: "Title" })).toBeNull();
  });
});

describe("Show full diff while an editor is open in the diff", () => {
  /** One hunk of 220 rows, over the 200-line cap, so the footer offers Show
   *  full diff; new line 110 is past the cap. */
  const CAPPED: FileDiff = {
    ...DIFF,
    text:
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,110 +1,110 @@\n" +
      Array.from({ length: 110 }, (_, i) => `-old ${i}\n+new ${i}\n`).join(""),
  };
  const showFull = () => screen.getByRole("button", { name: "Show full diff" });
  const hosts: [string, PaneProps][] = [
    ["a forge-patch host", UNKNOWN],
    ["a host without a forge patch (History)", {}],
  ];

  for (const [name, host] of hosts)
    it(`${name}: waits with its reason while a comment is open, then shows the full diff once it closes`, async () => {
      const user = userEvent.setup();
      let close: () => void = () => undefined;
      const lineWidget: LineWidget = {
        enabled: true,
        render: ({ onClose }) => {
          close = onClose;
          return <textarea aria-label="Draft" />;
        },
      };
      const pane = mountPane({ ...host, data: CAPPED, lineWidget });
      await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
      expect(showFull()).not.toHaveAttribute("aria-disabled");
      openComposer(pane.container, 2);
      const draft = (await screen.findByRole("textbox", {
        name: "Draft",
      })) as HTMLTextAreaElement;
      draft.value = "kept";
      await act(async () => undefined);

      const draftShown = () =>
        screen.queryByRole("textbox", {
          name: "Draft",
        }) as HTMLTextAreaElement | null;
      fireEvent.click(showFull());
      await act(async () => undefined);
      expect(draftShown()?.value).toBe("kept");
      expect(draftShown()).toBe(draft);
      expect(
        pane.container.querySelector('span[data-line-new-num="110"]'),
      ).toBeNull();
      expect(showFull()).toHaveAttribute("aria-disabled", "true");
      expect(showFull()).toHaveAccessibleDescription(SHOW_FULL_COMPOSER_HELD);
      // Enter and Space on the focused button only keep its reason.
      showFull().focus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      await act(async () => undefined);
      expect(draftShown()?.value).toBe("kept");
      expect(document.activeElement).toBe(showFull());
      expect(showFull()).toHaveAccessibleDescription(SHOW_FULL_COMPOSER_HELD);

      act(() => close());
      await waitFor(() =>
        expect(showFull()).not.toHaveAttribute("aria-disabled"),
      );
      expect(showFull()).not.toHaveAccessibleDescription(
        SHOW_FULL_COMPOSER_HELD,
      );
      fireEvent.click(showFull());
      await waitFor(() =>
        expect(
          pane.container.querySelector('span[data-line-new-num="110"]'),
        ).not.toBeNull(),
      );
      expect(
        screen.queryByRole("button", { name: "Show full diff" }),
      ).toBeNull();
    }, 20_000);
});

describe("a blank context line written without its space", () => {
  // `diff.suppressBlankEmpty`: the blank line 2 arrives as an empty row.
  const LF_TEXT =
    "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n" +
    "@@ -1,4 +1,4 @@\n line 1\n\n line 3\n-line 4\n+line four\n";
  const CRLF_TEXT = LF_TEXT.replace(/\n/g, "\r\n");
  const drawn = (container: HTMLElement, n: number) =>
    container.querySelector(`span[data-line-new-num="${n}"]`);

  it.each([
    ["LF", LF_TEXT],
    ["CRLF", CRLF_TEXT],
  ])("renders every row of a %s patch hunk-only", async (_eol, text) => {
    const pane = mountPane({ data: { ...DIFF, text } });
    await waitFor(() => expect(pane.rows().length).toBeGreaterThan(0));
    expect(screen.queryByText("No changes to show")).toBeNull();
    for (const n of [1, 2, 3, 4])
      expect(drawn(pane.container, n)).not.toBeNull();
  });

  it("renders a CRLF patch's rows in content mode too", async () => {
    const land = deferredReads();
    const pane = mountPane({ ...FORGE, data: { ...DIFF, text: CRLF_TEXT } });
    await land(
      "line 1\r\n\r\nline 3\r\nline 4\r\nline 5\r\n",
      "line 1\r\n\r\nline 3\r\nline four\r\nline 5\r\n",
    );
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
    expect(screen.queryByText("No changes to show")).toBeNull();
    for (const n of [1, 2, 3, 4])
      expect(drawn(pane.container, n)).not.toBeNull();
  });
});
