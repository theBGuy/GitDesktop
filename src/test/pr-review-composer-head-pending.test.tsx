import type { DiffFile } from "@git-diff-view/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiffFile } from "@/features/diff/DiffSurface";
import {
  createEditorKeep,
  DiffRowsHeldContext,
  type EditorKeep,
  KeptRow,
  LINE_COMPOSER_KEEP_ID,
} from "@/features/diff/editor-keep";
import { DIFF_ROWS_HELD_REASON } from "@/features/diff/whitespace-mode";
import {
  HEAD_COLD_DIALOG_REASON,
  HEAD_COLD_REVIEW_REASON,
  HEAD_PENDING_DIALOG_REASON,
  HEAD_PENDING_REVIEW_REASON,
  HEAD_UNPROVEN_REVIEW_REASON,
  type HeadPendingKind,
  headPendingKind,
  submitReviewHeadHold,
} from "@/features/pulls/head-pending";
import { ReviewComposer } from "@/features/pulls/ReviewComposer";
import { forgeStatus } from "@/lib/git/api";
import type { ForgeStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

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
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

// jsdom has no layout: the editors scroll themselves into view on focus.
Element.prototype.scrollIntoView = vi.fn();

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

const SECTION =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n";

function composer(
  headPending: HeadPendingKind | null,
  provider: "github" | "gitlab" | "bitbucket" = "gitlab",
  draftCount = 0,
  headUnproven = false,
  headCold: HeadPendingKind | null = null,
) {
  const onClose = vi.fn();
  return {
    onClose,
    node: (
      <QueryClientProvider client={new QueryClient()}>
        <ReviewComposer
          repoPath="/repo"
          number={7}
          path="f.txt"
          side="new"
          line={2}
          provider={provider}
          fileSection={SECTION}
          draftCount={draftCount}
          canCreateThread
          lens="origin"
          onClose={onClose}
          headPending={headPending}
          headCold={headCold}
          headUnproven={headUnproven}
        />
      </QueryClientProvider>
    ),
  };
}

const single = () => screen.getByRole("button", { name: "Add single comment" });
const submitButtons = () => [
  single(),
  screen.getByRole("button", { name: /^(Start a review|Add to review)$/ }),
];
const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox");

function expectHeld(reason: string) {
  for (const button of submitButtons()) {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(reason);
  }
}

/** Types a draft, then presses every way to submit it: both buttons and the
 *  chord. Nothing writes and the text stays. */
async function expectSubmitsWriteNothing(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(editor());
  await user.keyboard("kept");
  for (const button of submitButtons()) await user.click(button);
  editor().focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(writes.thread).not.toHaveBeenCalled();
  expect(writes.draft).not.toHaveBeenCalled();
  expect(editor()).toHaveValue("kept");
}

describe("headPendingKind", () => {
  it.each([
    [{ isError: false, isPaused: true, isFetching: false }, "offline"],
    [{ isError: true, isPaused: false, isFetching: false }, "failed"],
    [{ isError: true, isPaused: false, isFetching: true }, "loading"],
    [{ isError: false, isPaused: false, isFetching: true }, "loading"],
  ] as const)("%o -> %s", (read, kind) => {
    expect(headPendingKind(read)).toBe(kind);
  });
});

describe("the review composer over an older head's diff (AC-A10, AC-A11)", () => {
  for (const kind of ["loading", "failed", "offline"] as const)
    it(`${kind}: both submit paths and the chord hold; typing, Add suggestion and Cancel work`, async () => {
      const { node, onClose } = composer(kind);
      render(node);
      const user = userEvent.setup();
      await expectSubmitsWriteNothing(user);
      expectHeld(HEAD_PENDING_REVIEW_REASON[kind]("merge request"));
      await user.click(screen.getByRole("button", { name: "Add suggestion" }));
      expect(editor().value).toContain("```suggestion");
      expect(onClose).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

  it("names a pull request on GitHub", () => {
    const { node } = composer("loading", "github");
    render(node);
    expectHeld(HEAD_PENDING_REVIEW_REASON.loading("pull request"));
  });

  it("the chord stages nothing while a review is in progress", async () => {
    const { node } = composer("loading", "gitlab", 2);
    render(node);
    const user = userEvent.setup();
    await user.click(editor());
    await user.keyboard("kept{Control>}{Enter}{/Control}");
    expect(writes.draft).not.toHaveBeenCalled();
    expect(editor()).toHaveValue("kept");
  });

  const behind = (held: boolean, rowsBehind = true) => (
    <QueryClientProvider client={new QueryClient()}>
      <DiffRowsHeldContext value={held}>
        <ReviewComposer
          repoPath="/repo"
          number={7}
          path="f.txt"
          side="new"
          line={2}
          provider="gitlab"
          fileSection={SECTION}
          draftCount={0}
          canCreateThread
          lens="origin"
          onClose={vi.fn()}
          headPending={null}
          rowsBehind={rowsBehind}
        />
      </DiffRowsHeldContext>
    </QueryClientProvider>
  );

  it("rows a deferred render has not caught up hold Add suggestion with the submits' loading reason", async () => {
    render(behind(false));
    const user = userEvent.setup();
    const suggest = screen.getByRole("button", { name: "Add suggestion" });
    const loading = HEAD_PENDING_REVIEW_REASON.loading("merge request");
    expect(suggest).toHaveAttribute("aria-disabled", "true");
    expect(suggest).toHaveAccessibleDescription(loading);
    expectHeld(loading);
    await expectSubmitsWriteNothing(user);
    await user.click(suggest);
    expect(editor()).toHaveValue("kept");
  });

  it("held rows hold Add suggestion and the submits with the rows reason", async () => {
    render(behind(true));
    const user = userEvent.setup();
    const suggest = screen.getByRole("button", { name: "Add suggestion" });
    expect(suggest).toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    expectHeld(DIFF_ROWS_HELD_REASON);
    await expectSubmitsWriteNothing(user);
  });

  it("held rows alone, the deferred render caught up, still hold Add suggestion and the submits", async () => {
    render(behind(true, false));
    const user = userEvent.setup();
    const suggest = screen.getByRole("button", { name: "Add suggestion" });
    expect(suggest).toHaveAttribute("aria-disabled", "true");
    expect(suggest).toHaveAccessibleDescription(DIFF_ROWS_HELD_REASON);
    expectHeld(DIFF_ROWS_HELD_REASON);
    await expectSubmitsWriteNothing(user);
    await user.click(suggest);
    expect(editor()).toHaveValue("kept");
  });

  it("lifts in place: the same editor keeps its text and posts once", async () => {
    const held = composer("loading");
    const view = render(held.node);
    const user = userEvent.setup();
    await user.click(editor());
    await user.keyboard("kept");
    const node = editor();
    const lifted = composer(null);
    view.rerender(lifted.node);
    expect(editor()).toBe(node);
    expect(editor()).toHaveValue("kept");
    for (const button of submitButtons())
      expect(button).not.toHaveAttribute("aria-disabled", "true");
    await user.click(single());
    expect(writes.thread).toHaveBeenCalledTimes(1);
    expect(writes.thread).toHaveBeenCalledWith(
      expect.objectContaining({ line: 2, side: "new", body: "kept" }),
    );
  });
});

describe("the review composer over an unproven diff (AC-U1)", () => {
  it("both submit paths and the chord hold with M1; typing and Cancel work; the hold lifts in place", async () => {
    const { node, onClose } = composer(null, "github", 0, true);
    const { rerender } = render(node);
    const user = userEvent.setup();
    await user.click(editor());
    await user.keyboard("kept");
    const box = editor();
    expectHeld(HEAD_UNPROVEN_REVIEW_REASON("pull request"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(single());
    expect(writes.thread).not.toHaveBeenCalled();
    expect(writes.draft).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(composer(null, "github", 0, false).node);
    expect(editor()).toBe(box);
    expect(box).toHaveValue("kept");
    for (const button of submitButtons())
      expect(button).not.toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("a new head's ended moved check over the older head's text holds with the failed reason", () => {
    // What the view passes there: the older head's kind, never with the
    // unproven flag (RemotePrView's `headPending` / `headUnproven`).
    render(composer("failed", "github", 0, false).node);
    expectHeld(HEAD_PENDING_REVIEW_REASON.failed("pull request"));
  });

  it.each(["loading", "failed", "offline"] as const)(
    "G6: a target with no own answer (%s) holds on the cold reason, which claims no update",
    (kind) => {
      render(composer(null, "github", 0, false, kind).node);
      expectHeld(HEAD_COLD_REVIEW_REASON[kind]("pull request"));
      expect(screen.queryByText(/was updated/)).toBeNull();
    },
  );
});

describe("the Submit review dialog's head hold reasons (AC-D*, AC-P*)", () => {
  it.each([
    ["loading", false, HEAD_PENDING_REVIEW_REASON.loading("pull request")],
    ["offline", false, HEAD_PENDING_REVIEW_REASON.offline("pull request")],
    ["failed", true, HEAD_PENDING_DIALOG_REASON.failed("pull request")],
    [null, true, HEAD_UNPROVEN_REVIEW_REASON("pull request")],
    [null, false, null],
  ] as const)("%s / unproven %s", (pending, unproven, reason) => {
    expect(submitReviewHeadHold(pending, null, unproven, "pull request")).toBe(
      reason,
    );
  });

  // G6: the cold arm claims no update, and an update known outranks it.
  it.each([
    ["loading", HEAD_COLD_REVIEW_REASON.loading("pull request")],
    ["offline", HEAD_COLD_REVIEW_REASON.offline("pull request")],
    ["failed", HEAD_COLD_DIALOG_REASON.failed("pull request")],
  ] as const)("cold %s", (cold, reason) => {
    expect(submitReviewHeadHold(null, cold, true, "pull request")).toBe(reason);
    expect(reason).not.toContain("was updated");
    expect(submitReviewHeadHold("loading", cold, false, "pull request")).toBe(
      HEAD_PENDING_DIALOG_REASON.loading("pull request"),
    );
  });

  it("no dialog reason sends the user to a Retry above the diff", () => {
    for (const kind of ["loading", "failed", "offline"] as const)
      expect(HEAD_PENDING_DIALOG_REASON[kind]("pull request")).not.toMatch(
        /Retry above the diff/,
      );
    expect(HEAD_UNPROVEN_REVIEW_REASON("pull request")).not.toMatch(/updated/);
  });

  it("the failed reason names the tab whose notice carries the Retry", () => {
    expect(HEAD_PENDING_DIALOG_REASON.failed("pull request")).toBe(
      "This pull request was updated and its new diff couldn't load. Retry it on the Files tab.",
    );
  });
});

describe("Add to review's settle in a kept row", () => {
  const file = createDiffFile("f.txt", SECTION) as DiffFile;
  const rowOn = (keep: EditorKeep, record: string) => ({
    keep,
    kind: "widget" as const,
    side: "new" as const,
    line: 2,
    file,
    record,
  });

  /** A composer in pull request 7's widget row, its add held until `land`. */
  async function addHeld() {
    let land!: () => void;
    writes.draft.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          land = () => resolve(undefined);
        }),
    );
    const keep = createEditorKeep();
    keep.rowsReplaced(file, "unified", "pr-7");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeptRow {...rowOn(keep, "pr-7")}>
          <ReviewComposer
            repoPath="/repo"
            number={7}
            path="f.txt"
            side="new"
            line={2}
            provider="gitlab"
            fileSection={SECTION}
            draftCount={1}
            canCreateThread
            lens="origin"
            onClose={onClose}
            headPending={null}
          />
        </KeptRow>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(editor());
    await user.keyboard("kept");
    await user.click(screen.getByRole("button", { name: "Add to review" }));
    expect(writes.draft).toHaveBeenCalledWith(
      expect.objectContaining({ line: 2, side: "new", body: "kept" }),
    );
    return { keep, onClose, land: () => act(async () => land()) };
  }

  it("closes its widget once the add lands while it still owns the record", async () => {
    const { keep, onClose, land } = await addHeld();
    await land();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(keep.widgetRecord()).toBeNull();
  });

  it("closes nothing when another pull request's composer took the widget meanwhile", async () => {
    const { keep, onClose, land } = await addHeld();
    keep.claim(rowOn(keep, "pr-8"), LINE_COMPOSER_KEEP_ID, "other");
    await land();
    expect(onClose).not.toHaveBeenCalled();
    expect(keep.widgetRecord()).toMatchObject({ side: "new", line: 2 });
  });
});
