import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
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
  FILE_FILTER_SURFACES,
  useFileFilterStore,
  useFileListFilter,
} from "@/components/use-file-list-filter";
import type { LineWidget } from "@/features/diff/DiffSurface";
import {
  LINE_COMPOSER_KEEP_ID,
  useKeptDraft,
} from "@/features/diff/editor-keep";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import type { SuggestionApply } from "@/features/pulls/ReviewThreads";
import { forgeStatus, gitObjectsPresent } from "@/lib/git/api";
import type {
  FileDiff,
  ForgeStatus,
  PrThreadOut,
  ReviewThreadOut,
} from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

// Cards on rows the real diff holds for an open editor act on the slot's live
// state: Apply reads the branch checked out now, a held card shows the
// thread's newest replies, and a thread resolved elsewhere keeps an open edit.

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  gitObjectsPresent: vi.fn(),
  gitFileBase64: vi.fn(async () => null),
  forgeFileAtSha: vi.fn(async () => null),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
vi.mock("@/lib/git/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/host")>()),
  useForgeGhHost: () => undefined,
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));
Element.prototype.scrollIntoView ??= () => undefined;
beforeAll(stubCanvas);

const comment = (id: string, body: string, mine = false): PrThreadOut => ({
  author: "octo",
  authorAvatarUrl: "",
  state: "",
  body,
  date: "2026-01-01T00:00:00Z",
  id,
  url: "",
  viewerDidAuthor: mine,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
});
const thread = (
  id: string,
  path: string,
  line: number,
  comments: PrThreadOut[],
  diffHunk = "",
): ReviewThreadOut => ({
  id,
  reviewId: "",
  path,
  line,
  startLine: 0,
  side: "new",
  isResolved: false,
  isOutdated: false,
  diffHunk,
  comments,
});
const apply = (currentBranch: string): SuggestionApply => ({
  headRefName: "feature",
  currentBranch,
  onApply: vi.fn(async () => ({ staged: true, hadLocalChanges: false })),
});
const CHECK_OUT = "Check out feature to apply.";

interface Frame {
  path: string;
  text: string;
  binary?: boolean;
  threads: ReviewThreadOut[];
  apply: SuggestionApply;
  lineWidget?: LineWidget;
  /** The read serves an older head's patch of this pull request. */
  placeholder?: boolean;
}

function Harness({ frame }: { frame: Frame }) {
  const [picked, setPicked] = useState<string | null>(null);
  const filter = useFileListFilter({
    ...FILE_FILTER_SURFACES["pr-files"],
    files: [{ path: frame.path, additions: 1, deletions: 1 }],
    settled: true,
    picked,
    onPick: setPicked,
  });
  const open = filter.openPath;
  const data: FileDiff | undefined = open
    ? {
        filePath: open,
        text: frame.text,
        isBinary: frame.binary ?? false,
        isTruncated: false,
      }
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
      repoPath="/repo"
      lens="origin"
      number={7}
      threads={frame.threads}
      onReply={async () => undefined}
      onEditComment={async () => true}
      apply={frame.apply}
      lineWidget={frame.lineWidget}
    />
  );
}

function mount(frame: Frame) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const ui = (f: Frame): ReactNode => (
    <QueryClientProvider client={qc}>
      <Harness frame={f} />
    </QueryClientProvider>
  );
  const view = render(ui(frame));
  return {
    ...view,
    update: (f: Frame) => act(async () => view.rerender(ui(f))),
  };
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const applyButton = () => screen.getByRole("button", { name: "Apply" });
const OUTDATED = "This suggestion is outdated — the code has changed.";
const header = (id: string) =>
  document.querySelector(`[data-thread-id="${id}"]`) as HTMLElement;
const card = (id: string) =>
  header(id).closest("[data-keep-id]") as HTMLElement;
const editBox = () => screen.getByRole("textbox", { name: "Edit comment" });

/** Opens the edit of the thread's comment and types over its body. */
async function editIn(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(
    within(card(id)).getByRole("button", { name: "Comment actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const box = await screen.findByRole("textbox", { name: "Edit comment" });
  await user.clear(box);
  await user.type(box, "kept edit");
  return box;
}

beforeEach(() => {
  vi.clearAllMocks();
  useFileFilterStore.setState({ texts: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: false,
  } as unknown as ForgeStatus);
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
});
afterEach(cleanup);

describe("Apply on rows held for an open Reply", () => {
  const HEAD = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const HUNK = "@@ -1,5 +1,5 @@\n l1\n l2\n-l3\n+L3\n l4\n l5";
  const P1 = `${HEAD}${HUNK}\n`;
  /** Line 3 changed: the Reply's row (line 2) no longer reads the same. */
  const P2 = `${HEAD}@@ -1,5 +1,5 @@\n l1\n l2\n-l3\n+L3x\n l4\n l5\n`;
  const threads = [
    thread("T_R", "a.ts", 2, [comment("C_R", "Reply here")]),
    thread(
      "T_S",
      "a.ts",
      4,
      [comment("C_S", "```suggestion\nl4 fixed\n```")],
      HUNK,
    ),
  ];

  it("reads the branch checked out now, and keeps the Reply's text", async () => {
    const user = userEvent.setup();
    const view = mount({
      path: "a.ts",
      text: P1,
      threads,
      apply: apply("feature"),
    });
    await waitFor(() => expect(applyButton()).toBeEnabled(), {
      timeout: 10_000,
    });
    expect(applyButton()).not.toHaveAttribute("aria-disabled", "true");
    const replies = await screen.findAllByRole("button", { name: "Reply…" });
    await user.click(replies[0]);
    await user.type(
      screen.getByRole("textbox", { name: "Reply to review thread" }),
      "kept reply",
    );
    // A push the keep refuses: the rows stay on the earlier text.
    await view.update({
      path: "a.ts",
      text: P2,
      threads,
      apply: apply("feature"),
    });
    await settle();
    expect(document.body.textContent).not.toContain("L3x");
    // Another branch is checked out while the rows are held.
    await view.update({
      path: "a.ts",
      text: P2,
      threads,
      apply: apply("main"),
    });
    await waitFor(() =>
      expect(applyButton()).toHaveAccessibleDescription(CHECK_OUT),
    );
    expect(applyButton()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("textbox", { name: "Reply to review thread" }),
    ).toHaveValue("kept reply");
    expect(document.body.textContent).not.toContain("L3x");
  }, 30_000);

  it("keeps an outdated thread's Reply and names the outdated reason on its Apply", async () => {
    const user = userEvent.setup();
    const view = mount({
      path: "a.ts",
      text: P1,
      threads,
      apply: apply("feature"),
    });
    await waitFor(() => expect(applyButton()).toBeEnabled(), {
      timeout: 10_000,
    });
    expect(applyButton()).not.toHaveAttribute("aria-disabled", "true");
    await user.click(
      within(card("T_S")).getByRole("button", { name: "Reply…" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Reply to review thread" }),
      "kept reply",
    );
    // The thread goes outdated: the rows hold its placement for the Reply.
    await view.update({
      path: "a.ts",
      text: P1,
      threads: [threads[0], { ...threads[1], isOutdated: true }],
      apply: apply("feature"),
    });
    await waitFor(() =>
      expect(applyButton()).toHaveAccessibleDescription(OUTDATED),
    );
    expect(applyButton()).toHaveAttribute("aria-disabled", "true");
    expect(within(card("T_S")).getByText("Outdated")).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Reply to review thread" }),
    ).toHaveValue("kept reply");
  }, 30_000);

  it("reads the branch checked out now under an older head's patch with no editor open", async () => {
    const user = userEvent.setup();
    const first = apply("feature");
    const view = mount({ path: "a.ts", text: P1, threads, apply: first });
    await waitFor(() => expect(applyButton()).toBeEnabled(), {
      timeout: 10_000,
    });
    expect(applyButton()).not.toHaveAttribute("aria-disabled", "true");
    // The same pull request's older head serves as the placeholder, and
    // another branch is checked out meanwhile.
    const moved = apply("main");
    await view.update({
      path: "a.ts",
      text: P1,
      placeholder: true,
      threads,
      apply: moved,
    });
    await waitFor(() =>
      expect(applyButton()).toHaveAccessibleDescription(CHECK_OUT),
    );
    expect(applyButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(applyButton());
    applyButton().focus();
    await user.keyboard("{Enter}");
    await settle();
    expect(first.onApply).not.toHaveBeenCalled();
    expect(moved.onApply).not.toHaveBeenCalled();
  }, 30_000);
});

describe("a thread resolved elsewhere while its comment edit is open", () => {
  const HEAD = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const P1 = `${HEAD}@@ -1,5 +1,5 @@\n l1\n l2\n-l3\n+L3\n l4\n l5\n`;
  const open = thread("T_E", "a.ts", 2, [comment("C_E", "Mine", true)]);
  const resolved = { ...open, isResolved: true };

  /** Edits the comment, resolves the thread elsewhere, then Cancels. */
  async function cancelResolvedEdit() {
    const user = userEvent.setup();
    const view = mount({
      path: "a.ts",
      text: P1,
      threads: [open],
      apply: apply("feature"),
    });
    await waitFor(() => expect(header("T_E")).toBeTruthy(), {
      timeout: 10_000,
    });
    await editIn(user, "T_E");
    await view.update({
      path: "a.ts",
      text: P1,
      threads: [resolved],
      apply: apply("feature"),
    });
    await settle();
    expect(within(card("T_E")).getByText("Resolved")).toBeTruthy();
    expect(header("T_E")).toHaveAttribute("aria-expanded", "true");
    expect(editBox()).toHaveValue("kept edit");
    // Closing the edit applies the resolved default; focus lands on the header.
    await user.click(
      within(card("T_E")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(header("T_E")).toHaveAttribute("aria-expanded", "false"),
    );
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
    expect(document.activeElement).toBe(header("T_E"));
  }

  it("stays open with the typed text, and collapses onto its header once the edit closes", async () => {
    await cancelResolvedEdit();
  }, 30_000);

  it("lands on its header when removing the focused control fires a focusout", async () => {
    // Chromium blurs a focused node as it leaves the document, with a
    // focusout that names no related target; jsdom removes it silently.
    const removeChild = Node.prototype.removeChild;
    const ours = new WeakSet<Event>();
    const blurred: EventTarget[] = [];
    const record = (e: Event) => {
      if (ours.has(e) && e.target !== null) blurred.push(e.target);
    };
    document.addEventListener("focusout", record, true);
    const spy = vi
      .spyOn(Node.prototype, "removeChild")
      .mockImplementation(function <T extends Node>(this: Node, child: T): T {
        const active = document.activeElement;
        if (
          active !== null &&
          active !== document.body &&
          child.contains(active)
        ) {
          const out = new FocusEvent("focusout", {
            bubbles: true,
            relatedTarget: null,
          });
          ours.add(out);
          active.dispatchEvent(out);
        }
        return removeChild.call(this, child) as T;
      });
    try {
      await cancelResolvedEdit();
      expect(
        spy.mock.calls.some(([child]) => child.textContent?.includes("Mine")),
      ).toBe(true);
      // The removal blurred the focused Cancel control through the spy.
      expect(
        blurred.some(
          (t) =>
            t instanceof HTMLButtonElement &&
            t.textContent?.trim() === "Cancel",
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      document.removeEventListener("focusout", record, true);
    }
  }, 30_000);
});

describe("Apply on an arm held for an open composer", () => {
  const TEXT_LINK =
    "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/link\n" +
    "@@ -0,0 +1 @@\n+target-A\n\\ No newline at end of file\n";
  const BINARY_TO_LINK =
    "diff --git a/link b/link\ndeleted file mode 100644\nindex 3333333..0000000\nBinary files a/link and /dev/null differ\n" +
    "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..5555555\n--- /dev/null\n+++ b/link\n" +
    "@@ -0,0 +1 @@\n+target-B\n\\ No newline at end of file\n";
  function HeldComposer() {
    const kept = useKeptDraft(LINE_COMPOSER_KEEP_ID);
    return (
      <textarea
        aria-label="Held comment"
        value={kept.text}
        onChange={(e) => kept.setText(e.target.value)}
      />
    );
  }
  const lineWidget: LineWidget = {
    enabled: true,
    render: () => <HeldComposer />,
  };
  const suggestion = (comments: PrThreadOut[]) =>
    thread("T_S", "link", 1, comments, "@@ -0,0 +1 @@\n+target-A");
  const first = [comment("C_S", "```suggestion\ntarget-Z\n```")];

  it("reads the branch checked out now and shows a reply that lands while held", async () => {
    const view = mount({
      path: "link",
      text: TEXT_LINK,
      threads: [suggestion(first)],
      apply: apply("feature"),
      lineWidget,
    });
    await waitFor(() => expect(applyButton()).toBeEnabled(), {
      timeout: 10_000,
    });
    expect(applyButton()).not.toHaveAttribute("aria-disabled", "true");
    const num = await waitFor(() => {
      const cell = document
        .querySelector('span[data-line-new-num="1"]')
        ?.closest(".diff-line-num");
      expect(cell).toBeTruthy();
      return cell as HTMLElement;
    });
    fireEvent.mouseOver(num);
    fireEvent.mouseDown(
      num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
    );
    const box = await screen.findByRole("textbox", { name: "Held comment" });
    // A push to a typechange: the arm holds the text rows.
    await view.update({
      path: "link",
      text: BINARY_TO_LINK,
      binary: true,
      threads: [suggestion(first)],
      apply: apply("feature"),
      lineWidget,
    });
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).toContain("target-A");
    // The branch moves and a reply lands on the held thread.
    await view.update({
      path: "link",
      text: BINARY_TO_LINK,
      binary: true,
      threads: [suggestion([...first, comment("C_S2", "A late reply")])],
      apply: apply("main"),
      lineWidget,
    });
    await waitFor(() =>
      expect(applyButton()).toHaveAccessibleDescription(CHECK_OUT),
    );
    expect(await screen.findByText("A late reply")).toBeTruthy();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).toContain("target-A");
  }, 30_000);

  it("keeps a comment edit open, with its text, when its thread is resolved on the held arm", async () => {
    const user = userEvent.setup();
    const mine = thread("T_E", "link", 1, [comment("C_E", "Mine", true)]);
    const view = mount({
      path: "link",
      text: TEXT_LINK,
      threads: [mine],
      apply: apply("feature"),
    });
    await waitFor(() => expect(header("T_E")).toBeTruthy(), {
      timeout: 10_000,
    });
    const box = await editIn(user, "T_E");
    // A push to a typechange: the arm holds the text rows for the edit.
    await view.update({
      path: "link",
      text: BINARY_TO_LINK,
      binary: true,
      threads: [mine],
      apply: apply("feature"),
    });
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.body.textContent).toContain("target-A");
    await view.update({
      path: "link",
      text: BINARY_TO_LINK,
      binary: true,
      threads: [{ ...mine, isResolved: true }],
      apply: apply("feature"),
    });
    await settle();
    expect(within(card("T_E")).getByText("Resolved")).toBeTruthy();
    expect(header("T_E")).toHaveAttribute("aria-expanded", "true");
    expect(box.isConnected).toBe(true);
    expect(editBox()).toHaveValue("kept edit");
  }, 30_000);
});
