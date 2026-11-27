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
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  commitOnRemote,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitFileBase64,
  gitLog,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type {
  CommitCommentOut,
  FileDiff,
  ForgeStatus,
  RepoStatus,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

// History through the real diff: a commit selected while its file diff is
// still the previous commit's, as a placeholder, draws none of that commit's
// comments inline, and lists its own until its diff lands; a held row draws
// only its placement's comments, so a newer one on its line stays listed.

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  commitOnRemote: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  ghCommitAuthorAvatars: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitFileBase64: vi.fn(),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));
// A placement whose comments the body no longer lists draws no row, so the
// resolver draws a marker for any item its comments lack: a kept placement of
// the commit left behind then shows as a row.
vi.mock("@/features/pulls/CommitComments", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/pulls/CommitComments")>();
  return {
    ...real,
    useCommitLineAnchors: (
      ...args: Parameters<typeof real.useCommitLineAnchors>
    ) => {
      const out = real.useCommitLineAnchors(...args);
      const listed = new Set((args[0] ?? []).map((c) => c.id));
      return {
        ...out,
        renderAnchor: (anchor: DiffLineAnchor) => {
          const strays = anchor.items.filter((id) => !listed.has(id));
          return strays.length > 0 ? (
            <span data-stray-anchor={strays.join(",")} />
          ) : (
            out.renderAnchor(anchor)
          );
        },
      };
    },
  };
});
Element.prototype.scrollIntoView = vi.fn();
beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Non-zero hex, so the oid-width guard never reads a zero run. */
const A = "abcdef0123".repeat(4);
const B = "bcdef01234".repeat(4);
const PATH = "src/keep.txt";
const HEAD = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n`;
const diffOf = (first: string) =>
  `${HEAD}@@ -1,3 +1,3 @@\n-old 1\n+${first}\n keep 2\n keep 3\n`;
const file = (first: string) => `${first}\nkeep 2\nkeep 3\n`;
const comment = (id: string, body: string, line = 1): CommitCommentOut => ({
  id,
  author: "octo",
  body,
  createdAt: "2026-11-01T10:00:00Z",
  viewerDidAuthor: false,
  path: PATH,
  line,
  startLine: null,
  position: null,
});
const inline = (text: string) =>
  screen.getByText(text).closest("[data-diff-anchor]") !== null;

let releaseB: () => void = () => undefined;
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "gitlab",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "gitlab.com",
    login: "octo",
    capabilities: new Proxy({}, { get: () => true }),
    implemented: new Proxy({}, { get: () => true }),
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue("");
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  vi.mocked(gitLog).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: null,
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) => ({
    hash,
    subject: hash === A ? "Commit A" : "Commit B",
    body: "",
    author: "Ada",
    authorEmail: "ada@example.com",
    date: "2026-11-01T10:00:00Z",
    committerDate: "2026-11-01T10:00:00Z",
  }));
  vi.mocked(gitCommitFiles).mockResolvedValue([
    { path: PATH, added: 1, deleted: 1, isBinary: false, binaryKind: null },
  ]);
  vi.mocked(forgeCommitComments).mockImplementation(async (_r, hash) =>
    hash === A
      ? [comment("CA", "Comment of A")]
      : [comment("CB", "Comment of B")],
  );
  const bDiff = new Promise<FileDiff>((resolve) => {
    releaseB = () =>
      resolve({
        filePath: PATH,
        isBinary: false,
        isTruncated: false,
        text: diffOf("b 1"),
      });
  });
  vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, hash, path) =>
    hash === A
      ? {
          filePath: path,
          isBinary: false,
          isTruncated: false,
          text: diffOf("a 1"),
        }
      : bDiff,
  );
  vi.mocked(gitFileBase64).mockImplementation(async (_r, rev) => {
    const body =
      rev === A ? file("a 1") : rev === B ? file("b 1") : file("old 1");
    return {
      base64: Buffer.from(body).toString("base64"),
      mime: null,
      tooLarge: false,
      size: body.length,
    };
  });
});

function mount(hash: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const ui = (h: string): ReactNode => (
    <QueryClientProvider client={client}>
      <CommitDetailView repoPath="/repo" hash={h} />
    </QueryClientProvider>
  );
  const view = render(ui(hash));
  return { ...view, select: (h: string) => view.rerender(ui(h)) };
}

it("draws no comment of the commit it left over that commit's diff, and lists its own until its diff lands", async () => {
  const view = mount(A);
  await waitFor(() => expect(inline("Comment of A")).toBe(true), {
    timeout: 10_000,
  });
  view.select(B);
  // B's header and comments are ready; its diff is still A's.
  await screen.findByText("Comment of B", undefined, { timeout: 10_000 });
  expect(document.body.textContent).toContain("a 1");
  expect(screen.queryByText("Comment of A")).toBeNull();
  expect(inline("Comment of B")).toBe(false);
  // The diff draws none of A's placements under B's comments.
  await waitFor(() =>
    expect(document.querySelector("[data-stray-anchor]")).toBeNull(),
  );
  releaseB();
  await waitFor(() => expect(inline("Comment of B")).toBe(true), {
    timeout: 10_000,
  });
  expect(document.body.textContent).not.toContain("a 1");
  expect(screen.queryByText("Comment of A")).toBeNull();
});

it("lists a comment that lands on a held row's line until the row draws it", async () => {
  const SIX = `${HEAD}@@ -1,6 +1,6 @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n keep 5\n keep 6\n`;
  /** Line 6 edited: the composer's line 5 no longer reads the same around it. */
  const SIX_EDITED = `${HEAD}@@ -1,6 +1,6 @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n keep 5\n-keep 6\n+six\n`;
  let text = SIX;
  let comments = [comment("CA", "Comment of A", 2)];
  vi.mocked(forgeCommitComments).mockImplementation(async () => comments);
  vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, path) => ({
    filePath: path,
    isBinary: false,
    isTruncated: false,
    text,
  }));
  // No whole files: the rows build from the hunks alone.
  vi.mocked(gitFileBase64).mockResolvedValue({
    base64: "",
    mime: null,
    tooLarge: true,
    size: 10_000_000,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  render(
    <QueryClientProvider client={client}>
      <CommitDetailView repoPath="/repo" hash={A} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(inline("Comment of A")).toBe(true), {
    timeout: 10_000,
  });
  const num = document
    .querySelector('span[data-line-new-num="5"]')
    ?.closest(".diff-line-num") as HTMLElement;
  fireEvent.mouseOver(num);
  fireEvent.mouseDown(
    num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
  );
  const box = await screen.findByRole("textbox", {
    name: /^Comment on Line 5 · /,
  });
  const user = userEvent.setup();
  await user.type(box, "kept");
  // A rebuild the keep refuses: the rows stay on the earlier text.
  text = SIX_EDITED;
  await act(async () => {
    await client.invalidateQueries({
      queryKey: repoKeys.commitFileDiff("/repo", A, PATH),
    });
  });
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  expect(document.body.textContent).not.toContain("six");
  // B lands on A's line while the row is held.
  comments = [
    comment("CA", "Comment of A", 2),
    comment("CB", "Comment of B", 2),
  ];
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["repo", "/repo"] });
  });
  await screen.findByText("Comment of B", undefined, { timeout: 10_000 });
  expect(inline("Comment of B")).toBe(false);
  expect(inline("Comment of A")).toBe(true);
  expect(document.body.textContent).not.toContain("six");
  // The composer closes: the rows rebuild and draw both.
  await user.click(
    within(box.closest("[data-diff-line-widget]") as HTMLElement).getByRole(
      "button",
      { name: "Cancel" },
    ),
  );
  await waitFor(() => expect(inline("Comment of B")).toBe(true), {
    timeout: 10_000,
  });
  expect(inline("Comment of A")).toBe(true);
  expect(document.body.textContent).toContain("six");
  client.clear();
}, 30_000);
