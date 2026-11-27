import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineComposerOpen } from "@/features/diff/whitespace-mode";
import {
  CommitLineComposer,
  lineFromPosition,
  newSideLines,
  positionFromLine,
} from "@/features/pulls/CommitComments";
import { DraftCommentCard } from "@/features/pulls/PendingReviewBar";
import {
  OFF_PATCH_REVIEW_REASON,
  ReviewComposer,
} from "@/features/pulls/ReviewComposer";
import { ReviewThreadCard } from "@/features/pulls/ReviewThreads";
import { forgeStatus } from "@/lib/git/api";
import type {
  ForgeStatus,
  PrThreadOut,
  ReviewThreadOut,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

const writes = vi.hoisted(() => ({
  thread: vi.fn(async () => undefined),
  draft: vi.fn(async () => undefined),
  commit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useCreateReviewThread: () => ({ mutateAsync: writes.thread }),
  useCreateCommitComment: () => ({
    mutateAsync: writes.commit,
    isPending: false,
  }),
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

type Provider = "github" | "gitlab" | "bitbucket";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: false,
  } as unknown as ForgeStatus);
});
afterEach(cleanup);

/** Two hunks over a gap: lines 1-3 and 31-33 on both sides. */
const SECTION =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line two\n line 3\n" +
  "@@ -31,3 +31,3 @@\n line 31\n-line 32\n+line thirty-two\n line 33\n";

// A byte cap cut this section right after a newline: the header still owes
// one line on each side.
const TRUNCATED =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,2 +1,2 @@\n-old\n+new\n";

const wrap = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
);

function renderComposer(
  provider: Provider,
  side: "new" | "old",
  line: number,
  fromLine?: number,
) {
  const onClose = vi.fn();
  render(
    wrap(
      <ReviewComposer
        repoPath="/repo"
        number={7}
        path="f.txt"
        side={side}
        line={line}
        fromLine={fromLine}
        provider={provider}
        fileSection={SECTION}
        draftCount={0}
        canCreateThread
        lens="origin"
        onClose={onClose}
      />,
    ),
  );
  return { onClose };
}

const single = () => screen.getByRole("button", { name: "Add single comment" });
const review = () => screen.getByRole("button", { name: "Start a review" });
const editor = () => screen.getByRole("textbox");

/** Types a body and presses mod+Enter in the editor. */
async function typeAndSubmit() {
  const user = userEvent.setup();
  await user.click(editor());
  await user.keyboard("looks off");
  await user.keyboard("{Control>}{Enter}{/Control}");
  return user;
}

function expectHeld(reason: string) {
  for (const button of [single(), review()]) {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(reason);
  }
}

const PROVIDERS: Provider[] = ["github", "gitlab", "bitbucket"];
const SIDES = ["new", "old"] as const;

describe("review composer on a line outside the pull request's patch", () => {
  for (const provider of PROVIDERS)
    for (const side of SIDES) {
      it(`${provider}, ${side} side: stays open and editable, posts nothing`, async () => {
        const { onClose } = renderComposer(provider, side, 20);
        expectHeld(OFF_PATCH_REVIEW_REASON.line);
        await typeAndSubmit();
        expect(editor()).toHaveValue("looks off");
        expectHeld(OFF_PATCH_REVIEW_REASON.line);
        expect(writes.thread).not.toHaveBeenCalled();
        expect(writes.draft).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        await userEvent
          .setup()
          .click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it(`${provider}, ${side} side: a patch line posts as before`, async () => {
        const { onClose } = renderComposer(provider, side, 2);
        await typeAndSubmit();
        expect(writes.thread).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    }

  it("closes on Escape", async () => {
    const { onClose } = renderComposer("gitlab", "new", 20);
    const user = userEvent.setup();
    await user.click(editor());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty-body reason on a patch line", () => {
    renderComposer("github", "new", 2);
    expectHeld("Write a comment first");
  });
});

describe("review composer ranges, per provider", () => {
  const ranges: [string, number, number][] = [
    ["patch to gap", 2, 20],
    ["gap to patch", 20, 32],
    ["two hunks", 2, 32],
  ];
  for (const [name, from, to] of ranges)
    it(`github refuses a range leaving one hunk: ${name}`, async () => {
      renderComposer("github", "new", to, from);
      expectHeld(OFF_PATCH_REVIEW_REASON.range);
      await typeAndSubmit();
      expect(writes.thread).not.toHaveBeenCalled();
    });

  it("github posts a range inside one hunk", async () => {
    renderComposer("github", "old", 3, 1);
    await typeAndSubmit();
    expect(writes.thread).toHaveBeenCalledTimes(1);
  });

  for (const provider of ["gitlab", "bitbucket"] as const) {
    it(`${provider} posts a range whose end is a patch line, across hunks`, async () => {
      renderComposer(provider, "new", 32, 2);
      await typeAndSubmit();
      expect(writes.thread).toHaveBeenCalledTimes(1);
    });

    it(`${provider} posts a range starting in a gap`, async () => {
      renderComposer(provider, "new", 32, 20);
      await typeAndSubmit();
      expect(writes.thread).toHaveBeenCalledTimes(1);
    });

    it(`${provider} refuses a range ending in a gap, with the line sentence`, async () => {
      renderComposer(provider, "new", 20, 2);
      expectHeld(OFF_PATCH_REVIEW_REASON.line);
      await typeAndSubmit();
      expect(writes.thread).not.toHaveBeenCalled();
    });
  }
});

describe("commit line composer: patch-only lines on every provider", () => {
  const COMMIT_OFF = "This line isn't in the commit's diff for this file.";
  function renderCommitComposer(
    provider: Provider,
    line: number,
    patchOnly: boolean,
    fromLine?: number,
  ) {
    render(
      wrap(
        <CommitLineComposer
          repoPath="/repo"
          sha={"abcdef0123".repeat(4)}
          path="f.txt"
          side="new"
          line={line}
          fromLine={fromLine}
          provider={provider}
          fileSection={SECTION}
          onClose={() => undefined}
          lens="origin"
          patchOnly={patchOnly}
        />,
      ),
    );
  }
  const comment = () => screen.getByRole("button", { name: "Comment" });

  for (const provider of PROVIDERS)
    it(`${provider}: a gap line is refused with the commit's reason`, async () => {
      renderCommitComposer(provider, 20, true);
      expect(comment()).toHaveAccessibleDescription(COMMIT_OFF);
      await typeAndSubmit();
      expect(writes.commit).not.toHaveBeenCalled();
    });

  for (const provider of ["gitlab", "bitbucket"] as const) {
    it(`${provider}: a patch line posts`, async () => {
      renderCommitComposer(provider, 2, true);
      await typeAndSubmit();
      expect(writes.commit).toHaveBeenCalledTimes(1);
    });

    it(`${provider}: without patchOnly (History) a gap line still posts`, async () => {
      renderCommitComposer(provider, 20, false);
      await typeAndSubmit();
      expect(writes.commit).toHaveBeenCalledTimes(1);
    });

    it(`${provider}: a range of two patch lines across hunks posts`, async () => {
      renderCommitComposer(provider, 32, true, 2);
      await typeAndSubmit();
      expect(writes.commit).toHaveBeenCalledTimes(1);
      expect(writes.commit).toHaveBeenCalledWith(
        provider === "gitlab"
          ? expect.objectContaining({ line: 32, startLine: 2 })
          : expect.not.objectContaining({ startLine: expect.anything() }),
      );
    });
  }

  it("github: the line after the last hunk is refused, the hunk's last line posts", async () => {
    renderCommitComposer("github", 34, false);
    expect(comment()).toHaveAccessibleDescription(COMMIT_OFF);
    await typeAndSubmit();
    expect(writes.commit).not.toHaveBeenCalled();
    cleanup();
    renderCommitComposer("github", 33, false);
    await typeAndSubmit();
    expect(writes.commit).toHaveBeenCalledWith(
      expect.objectContaining({ line: 33, position: 9 }),
    );
  });

  /** A binary-to-text typechange's two sections, joined under one path. */
  const JOINED =
    "diff --git a/p b/p\ndeleted file mode 120000\nindex 1111111..0000000\n--- a/p\n+++ /dev/null\n" +
    "@@ -1 +0,0 @@\n-target\n\\ No newline at end of file\n" +
    "diff --git a/p b/p\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/p\n" +
    "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";

  it("github: line and position round-trip over exactly the lines a hunk holds", () => {
    for (const section of [SECTION, JOINED, TRUNCATED]) {
      const mapped: number[] = [];
      for (let line = 1; line <= 40; line++) {
        const position = positionFromLine(section, line);
        if (position === null) continue;
        mapped.push(line);
        expect(lineFromPosition(section, position)).toBe(line);
      }
      // The lines with a position are the ones the diff draws.
      expect(mapped).toEqual([...newSideLines(section)]);
      for (let position = 1; position <= 20; position++) {
        const line = lineFromPosition(section, position);
        if (line !== null)
          expect(positionFromLine(section, line)).toBe(position);
      }
    }
    // Past the last hunk, and where the joined section's second file header
    // sits in a walk that counts it, no position maps to a line.
    expect(lineFromPosition(SECTION, 10)).toBeNull();
    expect(lineFromPosition(JOINED, 3)).toBeNull();
    expect(lineFromPosition(JOINED, 7)).toBeNull();
    // A hunk cut short ends at the text's end: nothing past `+new` has a row.
    expect(lineFromPosition(TRUNCATED, 2)).toBe(1);
    expect(lineFromPosition(TRUNCATED, 3)).toBeNull();
    expect(positionFromLine(TRUNCATED, 2)).toBeNull();
    expect([...newSideLines(TRUNCATED)]).toEqual([1]);
  });

  it("github: positions in a joined typechange section skip the second file's header", () => {
    const joined = JOINED;
    expect(positionFromLine(joined, 1)).toBe(4);
    expect(positionFromLine(joined, 2)).toBe(5);
    expect(positionFromLine(joined, 3)).toBe(6);
    expect(positionFromLine(joined, 4)).toBeNull();
    // The first section's lines keep their positions.
    expect(positionFromLine(SECTION, 1)).toBe(1);
    expect(positionFromLine(SECTION, 31)).toBe(6);
  });

  it("gitlab: a range starting in a gap is refused, its start named", async () => {
    renderCommitComposer("gitlab", 32, true, 20);
    expect(comment()).toHaveAccessibleDescription(
      "This range starts on a line that isn't in the commit's diff for this file.",
    );
    await typeAndSubmit();
    expect(writes.commit).not.toHaveBeenCalled();
  });

  it("bitbucket: a range starting in a gap posts at its end line", async () => {
    renderCommitComposer("bitbucket", 32, true, 20);
    await typeAndSubmit();
    expect(writes.commit).toHaveBeenCalledWith(
      expect.not.objectContaining({ startLine: expect.anything() }),
    );
  });

  it("gitlab: without patchOnly (History) a range starting in a gap posts", async () => {
    renderCommitComposer("gitlab", 32, false, 20);
    await typeAndSubmit();
    expect(writes.commit).toHaveBeenCalledWith(
      expect.objectContaining({ line: 32, startLine: 20 }),
    );
  });
});

// ------------------------------------------------ the in-diff editor markers

const threadRow = (over: Partial<PrThreadOut>): PrThreadOut => ({
  author: "someone",
  authorAvatarUrl: "",
  state: "",
  body: "",
  date: "2026-01-01T00:00:00Z",
  id: "",
  url: "",
  viewerDidAuthor: false,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
  ...over,
});
const thread: ReviewThreadOut = {
  id: "T_1",
  reviewId: "",
  path: "f.txt",
  line: 2,
  startLine: 0,
  side: "new",
  isResolved: false,
  isOutdated: false,
  diffHunk: "",
  comments: [threadRow({ id: "N_1", body: "Look at this line" })],
};

/** Renders `node` inside a diff anchor row, or bare. */
const inAnchor = (node: ReactNode, anchored: boolean) =>
  anchored ? <div data-diff-anchor="layout">{node}</div> : node;

describe("editors open inside a diff hold the layout probe", () => {
  for (const anchored of [true, false])
    it(`a thread Reply box ${anchored ? "inside" : "outside"} a diff anchor`, async () => {
      const user = userEvent.setup();
      render(
        wrap(
          inAnchor(
            <ReviewThreadCard
              thread={thread}
              expanded
              onToggleExpand={() => undefined}
              onReply={async () => undefined}
            />,
            anchored,
          ),
        ),
      );
      expect(lineComposerOpen()).toBe(false);
      await user.click(screen.getByRole("button", { name: "Reply…" }));
      expect(lineComposerOpen()).toBe(anchored);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(lineComposerOpen()).toBe(false);
    });

  for (const anchored of [true, false])
    it(`a pending draft's Edit ${anchored ? "inside" : "outside"} a diff anchor`, async () => {
      const user = userEvent.setup();
      render(
        wrap(
          inAnchor(
            <DraftCommentCard
              repoPath="/repo"
              lens="origin"
              number={7}
              draft={{
                id: "d1",
                path: "f.txt",
                line: 2,
                side: "new",
                body: "draft body",
                createdAt: "2026-11-01T10:00:00Z",
              }}
            />,
            anchored,
          ),
        ),
      );
      expect(lineComposerOpen()).toBe(false);
      await user.click(
        screen.getByRole("button", { name: "Edit pending comment" }),
      );
      expect(lineComposerOpen()).toBe(anchored);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await act(async () => undefined);
      expect(lineComposerOpen()).toBe(false);
    });
});
