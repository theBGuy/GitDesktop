import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEAD_PENDING_REVIEW_REASON,
  type HeadPendingKind,
  headPendingKind,
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
      await user.click(editor());
      await user.keyboard("kept");
      expectHeld(HEAD_PENDING_REVIEW_REASON[kind]("merge request"));
      await user.keyboard("{Control>}{Enter}{/Control}");
      await user.click(single());
      expect(writes.thread).not.toHaveBeenCalled();
      expect(writes.draft).not.toHaveBeenCalled();
      expect(editor()).toHaveValue("kept");
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
