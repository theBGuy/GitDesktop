import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitComments } from "@/features/pulls/CommitComments";
import { forgeCommitComments, forgeStatus } from "@/lib/git/api";
import { sectionIsBinary, splitUnifiedDiff } from "@/lib/git/diff-split";
import type { CommitCommentOut, ForgeStatus } from "@/lib/git/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeCommitComments: vi.fn(),
  forgeStatus: vi.fn(),
}));

/** A symlink at x replaced by a binary file, as a forge's combined patch: the
 *  split joins both halves, so the binary arm renders the file. */
const LINK_TO_BINARY =
  "diff --git a/x b/x\ndeleted file mode 120000\nindex 3333ccc..0000000\n" +
  "--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n" +
  "diff --git a/x b/x\nnew file mode 100644\nindex 0000000..4444ddd\n" +
  "Binary files /dev/null and b/x differ\n";
/** The symlink's deletion alone: a text diff, so the binary-arm fallback is off. */
const LINK_ONLY = LINK_TO_BINARY.slice(0, LINK_TO_BINARY.indexOf("diff", 1));

const COMMENT: CommitCommentOut = {
  id: "1",
  author: "octo",
  body: "note on the link line",
  createdAt: "2026-01-01T00:00:00Z",
  viewerDidAuthor: false,
  path: "x",
  line: 1,
  startLine: null,
  position: null,
};

beforeEach(() => {
  vi.mocked(forgeCommitComments).mockResolvedValue([COMMENT]);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    authenticated: false,
  } as unknown as ForgeStatus);
});

function renderPane(patch: string) {
  const sections = splitUnifiedDiff(patch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommitComments
        repoPath="/repo"
        sha={"a".repeat(40)}
        canComment={false}
        remoteLabel="origin"
        diffSections={sections}
        selectedPath="x"
        selectedBinary={sectionIsBinary(sections.get("x") ?? "")}
        lens="origin"
      />
    </QueryClientProvider>,
  );
}

/** A whole-commit comment: it always renders, so awaiting it proves the list
 *  landed before an absence is asserted. */
const WHOLE_COMMIT: CommitCommentOut = {
  ...COMMENT,
  id: "2",
  body: "note on the whole commit",
  path: null,
  line: null,
};

/** Only the path truncates: the line suffix sits in its own sibling span, so a
 *  narrow pane never clips it and two comments on one file stay distinct. */
function expectSplitLabel(suffix: string) {
  const note = screen.getByText(/couldn't place in this diff/);
  const label = note.parentElement;
  const truncating = label?.querySelector(".truncate");
  expect(truncating?.textContent).toBe("x");
  const sibling = truncating?.nextElementSibling;
  expect(sibling?.textContent).toBe(suffix);
  expect(truncating?.contains(sibling ?? null)).toBe(false);
}

describe("CommitComments over a file the binary arm renders", () => {
  it("keeps the open file's line comment in the labelled group", async () => {
    renderPane(LINK_TO_BINARY);
    expect(await screen.findByText("note on the link line")).toBeTruthy();
    expect(screen.getByText(/couldn't place in this diff/)).toBeTruthy();
    expectSplitLabel(":1");
  });

  it("labels a range comment on the open file with its line span", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([
      { ...COMMENT, line: 2, startLine: 1 },
    ]);
    renderPane(LINK_TO_BINARY);
    expect(await screen.findByText("note on the link line")).toBeTruthy();
    expectSplitLabel(":1–2");
  });

  it("keeps a text diff's line comment out of the labelled group", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([COMMENT, WHOLE_COMMIT]);
    renderPane(LINK_ONLY);
    expect(await screen.findByText("note on the whole commit")).toBeTruthy();
    expect(screen.queryByText("note on the link line")).toBeNull();
  });
});
