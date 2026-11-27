// A typechange's text half held under an open composer: its line submits hold
// through the arm change, and the release lands focus the rows held.
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
import type { ComponentProps, ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DiffContent, type LineWidget } from "@/features/diff/DiffSurface";
import {
  LINE_COMPOSER_KEEP_ID,
  useKeptDraft,
} from "@/features/diff/editor-keep";
import { DIFF_ROWS_HELD_REASON } from "@/features/diff/whitespace-mode";
import { ReviewComposer } from "@/features/pulls/ReviewComposer";
import { forgeStatus } from "@/lib/git/api";
import type { ForgeStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { bodies, renderBody } from "./anchor-bodies";
import { stubCanvas } from "./canvas-stub";

const writes = vi.hoisted(() => ({
  thread: vi.fn(async () => undefined),
  draft: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useCreateReviewThread: () => ({ mutateAsync: writes.thread }),
}));
vi.mock("@/lib/pulls/review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/review-drafts")>()),
  useAddReviewDraft: () => ({ mutateAsync: writes.draft }),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgeFileAtSha: vi.fn(async () => null),
  gitFileBase64: vi.fn(async () => null),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView ??= () => undefined;
beforeAll(stubCanvas);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "gitlab",
    installed: true,
    authenticated: false,
  } as unknown as ForgeStatus);
});
afterEach(cleanup);

/** A symlink pushed as a regular binary file: the text half is the removed
 *  link, old line 1. */
const TO_BINARY =
  "diff --git a/link b/link\ndeleted file mode 120000\nindex 1111111..0000000\n--- a/link\n+++ /dev/null\n" +
  "@@ -1 +0,0 @@\n-old-target\n\\ No newline at end of file\n" +
  "diff --git a/link b/link\nnew file mode 100644\nindex 0000000..3333333\nBinary files /dev/null and b/link differ\n";
/** The path pushed again as an ordinary binary replacement: no text half. */
const BINARY_ONLY =
  "diff --git a/link b/link\nindex 3333333..4444444 100644\nBinary files a/link and b/link differ\n";
const SECTION =
  "diff --git a/link b/link\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-old-target\n";

type PaneProps = Partial<ComponentProps<typeof DiffContent>>;
const at = (text: string, extra: PaneProps): PaneProps => ({
  forgePatch: { source: null, scope: "pr-1" },
  filePath: "link",
  data: { filePath: "link", text, isBinary: true, isTruncated: false },
  typechangeAnchors: true,
  ...extra,
});

function mountPane(props: PaneProps, outside?: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const ui = (p: PaneProps) => (
    <QueryClientProvider client={client}>
      {outside}
      <DiffContent
        filePath="link"
        data={undefined}
        isPending={false}
        isError={false}
        repoPath="/repo"
        renderAnchor={renderBody}
        {...p}
      />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { ...view, update: (p: PaneProps) => view.rerender(ui(p)) };
}

/** Opens the line composer on the removed link's line. */
async function openOnLinkLine(container: HTMLElement) {
  const num = await waitFor(() => {
    const cell = container
      .querySelector('span[data-line-old-num="1"]')
      ?.closest(".diff-line-num");
    expect(cell).toBeTruthy();
    return cell as HTMLElement;
  });
  fireEvent.mouseOver(num);
  fireEvent.mouseDown(
    num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
  );
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

describe("a typechange's text half under an open composer, pushed to binary only", () => {
  const widget: LineWidget = {
    enabled: true,
    render: ({ side, line, onClose }) => (
      <ReviewComposer
        repoPath="/repo"
        number={7}
        path="link"
        side={side}
        line={line}
        provider="gitlab"
        fileSection={SECTION}
        draftCount={0}
        canCreateThread
        lens="origin"
        onClose={onClose}
        headPending={null}
      />
    ),
  };

  it("holds the composer's click and chord submits with the held reason", async () => {
    const pane = mountPane(at(TO_BINARY, { lineWidget: widget }));
    await openOnLinkLine(pane.container);
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox");
    await user.click(box);
    await user.keyboard("kept");
    pane.update(at(BINARY_ONLY, { lineWidget: widget }));
    await settle();
    expect(box.isConnected).toBe(true);
    const single = screen.getByRole("button", { name: "Add single comment" });
    expect(single).toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    await user.click(box);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(single);
    expect(writes.thread).not.toHaveBeenCalled();
    expect(writes.draft).not.toHaveBeenCalled();
    expect(box).toHaveValue("kept");
  });

  it("lands focus the field held on the binary body when Escape closes it", async () => {
    const pane = mountPane(at(TO_BINARY, { lineWidget: widget }));
    await openOnLinkLine(pane.container);
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox");
    await user.click(box);
    await user.keyboard("kept");
    pane.update(at(BINARY_ONLY, { lineWidget: widget }));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(document.activeElement).toBe(box);
    // The field leaves first, then the hold releases on the next commit.
    await user.keyboard("{Escape}");
    await settle();
    expect(
      screen.getByText("Binary file — no text diff available"),
    ).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
    expect(pane.container.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toHaveTextContent(
      "Binary file — no text diff available",
    );
    // Escape discarded the text, as it does on rows that never held.
    pane.update(at(TO_BINARY, { lineWidget: widget }));
    await openOnLinkLine(pane.container);
    expect(await screen.findByRole("textbox")).toHaveValue("");
  });

  it.each([
    [
      "failed",
      { isError: true },
      "Couldn't refresh this diff — showing the earlier version while you're editing.",
      "Couldn't refresh this diff — showing the last loaded version.",
    ],
    [
      "offline",
      { isPaused: true },
      "You're offline — showing the earlier version while you're editing.",
      "You're offline — showing the last loaded version.",
    ],
  ])(
    "names the held version in the %s refresh's notice",
    async (_case, status, held, unheld) => {
      const pane = mountPane(at(TO_BINARY, { lineWidget: widget }));
      await openOnLinkLine(pane.container);
      await screen.findByRole("textbox");
      pane.update(at(BINARY_ONLY, { lineWidget: widget, ...status }));
      await settle();
      expect(screen.getByText(held)).toBeTruthy();
      expect(screen.queryByText(unheld)).toBeNull();
      // No editor holds the arm: the notice names the live read's version.
      const plain = mountPane(at(BINARY_ONLY, status));
      await settle();
      expect(within(plain.container).getByText(unheld)).toBeTruthy();
    },
  );
});

describe("a text diff held under an open composer, pushed to a typechange", () => {
  /** A new symlink: its target is new line 1. */
  const TEXT_LINK =
    "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/link\n" +
    "@@ -0,0 +1 @@\n+target-A\n\\ No newline at end of file\n";
  /** The rebased head: a binary `link` on the base, replaced by a symlink to
   *  another target. The text half is the new link, new line 1. */
  const BINARY_TO_LINK =
    "diff --git a/link b/link\ndeleted file mode 100644\nindex 3333333..0000000\nBinary files a/link and /dev/null differ\n" +
    "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..5555555\n--- /dev/null\n+++ b/link\n" +
    "@@ -0,0 +1 @@\n+target-B\n\\ No newline at end of file\n";
  const text = (t: string, extra: PaneProps): PaneProps => ({
    ...at(t, extra),
    data: { filePath: "link", text: t, isBinary: false, isTruncated: false },
  });
  // Claims the line composer's keep record, so a rebuild finds it placed and
  // would take the new anchors.
  function HeldComposer({ onClose }: { onClose: () => void }) {
    const kept = useKeptDraft(LINE_COMPOSER_KEEP_ID);
    return (
      <div>
        <textarea
          aria-label="Held comment"
          value={kept.text}
          onChange={(e) => kept.setText(e.target.value)}
        />
        <button type="button" onClick={onClose}>
          Close held
        </button>
      </div>
    );
  }
  const lineWidget: LineWidget = {
    enabled: true,
    render: ({ onClose }) => <HeldComposer onClose={onClose} />,
  };
  const thread = bodies([
    {
      side: "new" as const,
      line: 1,
      render: () => <p>Thread on target-B</p>,
    },
  ]);

  it("keeps the new head's thread off the held rows until the composer closes", async () => {
    const pane = mountPane(text(TEXT_LINK, { lineWidget }));
    const num = await waitFor(() => {
      const cell = pane.container
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
    pane.update(at(BINARY_TO_LINK, { lineWidget, lineAnchors: thread }));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(pane.container).toHaveTextContent("target-A");
    expect(screen.queryByText("Thread on target-B")).toBeNull();
    // Closing it releases the hold: the thread renders on the live rows.
    fireEvent.click(screen.getByRole("button", { name: "Close held" }));
    await settle();
    expect(await screen.findByText("Thread on target-B")).toBeTruthy();
    expect(pane.container).toHaveTextContent("target-B");
    expect(pane.container).not.toHaveTextContent("target-A");
  });

  it("names the held version while a same-arm rebuild is refused, then the live one", async () => {
    /** The same link retargeted: the composer's line changed, so the rows
     *  stay on the earlier build while it is open. */
    const RETARGETED =
      "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..6666666\n--- /dev/null\n+++ b/link\n" +
      "@@ -0,0 +1 @@\n+target-C\n\\ No newline at end of file\n";
    const held =
      "Couldn't refresh this diff — showing the earlier version while you're editing.";
    const unheld =
      "Couldn't refresh this diff — showing the last loaded version.";
    const pane = mountPane(text(TEXT_LINK, { lineWidget }));
    const num = await waitFor(() => {
      const cell = pane.container
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
    pane.update(text(RETARGETED, { lineWidget, isError: true }));
    await settle();
    expect(box.isConnected).toBe(true);
    expect(pane.container).toHaveTextContent("target-A");
    expect(screen.getByText(held)).toBeTruthy();
    expect(screen.queryByText(unheld)).toBeNull();
    // The same pane once the composer closes: its rows take the live read.
    fireEvent.click(screen.getByRole("button", { name: "Close held" }));
    expect(
      await screen.findByText(unheld, undefined, { timeout: 10_000 }),
    ).toBeTruthy();
    expect(screen.queryByText(held)).toBeNull();
    expect(pane.container).toHaveTextContent("target-C");
  });

  it("draws exactly the anchors its host hands a placeholder paint", async () => {
    const seeded = bodies([
      {
        side: "new" as const,
        line: 1,
        render: () => <p>Thread on target-A</p>,
      },
    ]);
    const pane = mountPane(text(TEXT_LINK, { lineAnchors: seeded }));
    expect(await screen.findByText("Thread on target-A")).toBeTruthy();
    // The host's pairing decides: a placeholder draws the list it is handed.
    pane.update(
      text(TEXT_LINK, {
        lineAnchors: thread,
        dataIsPlaceholder: true,
      }),
    );
    expect(
      await screen.findByText("Thread on target-B", undefined, {
        timeout: 10_000,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Thread on target-A")).toBeNull();
    // And an empty list after an anchored paint draws none.
    pane.update(text(TEXT_LINK, { lineAnchors: [], dataIsPlaceholder: true }));
    await waitFor(
      () => expect(screen.queryByText("Thread on target-B")).toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.queryByText("Thread on target-A")).toBeNull();
  });
});

describe("releasing a held typechange arm into a binary placeholder", () => {
  function Composer({ onClose }: { onClose: () => void }) {
    const kept = useKeptDraft(LINE_COMPOSER_KEEP_ID);
    return (
      <div>
        <textarea
          aria-label="Draft comment"
          value={kept.text}
          onChange={(e) => kept.setText(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            kept.forget();
            onClose();
          }}
        >
          Cancel draft
        </button>
      </div>
    );
  }
  const extra: PaneProps = {
    lineWidget: {
      enabled: true,
      render: ({ onClose }) => <Composer onClose={onClose} />,
    },
    lineAnchors: bodies([
      {
        side: "old",
        line: 1,
        render: () => (
          <button type="button" data-anchor-edit="">
            Edit draft
          </button>
        ),
      },
    ]),
  };

  async function heldWithFocusOn(
    target: () => HTMLElement,
    outside?: ReactNode,
  ) {
    const pane = mountPane(at(TO_BINARY, extra), outside);
    await openOnLinkLine(pane.container);
    await screen.findByRole("textbox", { name: "Draft comment" });
    pane.update(at(BINARY_ONLY, extra));
    await settle();
    expect(
      screen.queryByText("Binary file — no text diff available"),
    ).toBeNull();
    act(() => target().focus());
    // Cancel by pointer: focus stays where it was, then the hold releases.
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
    await settle();
    expect(
      screen.getByText("Binary file — no text diff available"),
    ).toBeTruthy();
    return pane;
  }

  it("lands focus the rows held on the placeholder's body", async () => {
    const pane = await heldWithFocusOn(
      () =>
        document.querySelector<HTMLElement>(
          "[data-anchor-edit]",
        ) as HTMLElement,
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(pane.container.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toHaveTextContent(
      "Binary file — no text diff available",
    );
  });

  it("leaves focus outside the pane where it is", async () => {
    await heldWithFocusOn(
      () => screen.getByRole("button", { name: "Elsewhere" }),
      <button type="button">Elsewhere</button>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Elsewhere" }),
    );
  });
});
