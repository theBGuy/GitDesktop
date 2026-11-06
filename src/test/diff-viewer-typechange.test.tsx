import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffViewer } from "@/features/diff/DiffViewer";
import { gitBlobSizes, gitDiffFile, gitStatus } from "@/lib/git/api";
import type { FileDiff, RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitDiffFile: vi.fn(),
  gitBlobSizes: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

// @git-diff-view measures text on a 2D canvas, which jsdom leaves null.
beforeAll(() => {
  const measure = {
    font: "",
    measureText: (t: string) => ({ width: t.length }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => measure as unknown as CanvasRenderingContext2D,
  );
});

/** A symlink at x replaced by a binary file, unstaged: one FileDiff whose text
 *  holds a text half and a binary half. */
const TYPECHANGE =
  "diff --git a/x b/x\ndeleted file mode 120000\nindex 3333ccc..0000000\n" +
  "--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n" +
  "diff --git a/x b/x\nnew file mode 100644\nindex 0000000..4444ddd\n" +
  "Binary files /dev/null and b/x differ\n";
const TEXT =
  "diff --git a/x b/x\nindex 1111aaa..2222bbb 100644\n--- a/x\n+++ b/x\n" +
  "@@ -1 +1 @@\n-target\n+other\n";

const STAGING = /Stage|Unstage|Discard/;
/** The line-staging hint the staging view leads with. Its hunk buttons ride
 *  the diff renderer's rows, which jsdom never lays out. */
const LINE_STAGING_HINT = /Drag across the line numbers to/;

function renderViewer(diff: FileDiff) {
  vi.mocked(gitDiffFile).mockResolvedValue(diff);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  return render(
    <QueryClientProvider client={client}>
      <DiffViewer repoPath="/repo" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBlobSizes).mockResolvedValue({ oldSize: null, newSize: 7 });
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "main", detached: false, oid: null, upstream: null },
    entries: [{ path: "x", staged: null, unstaged: "modified" }],
  } as unknown as RepoStatus);
  useUiStore.setState({
    selectedFile: { path: "x", staged: false, untracked: false },
  });
});

describe("DiffViewer on a typechange with a binary half", () => {
  it("never offers to stage, unstage or discard half of it", async () => {
    renderViewer({
      filePath: "x",
      text: TYPECHANGE,
      isBinary: true,
      isTruncated: false,
    });
    expect(await screen.findByText("Binary file added")).toBeTruthy();
    expect(await screen.findByText("target")).toBeTruthy();
    const names = screen.queryAllByRole("button").map((b) => b.textContent);
    expect(names.filter((name) => STAGING.test(name ?? ""))).toEqual([]);
    expect(screen.queryByText(LINE_STAGING_HINT)).toBeNull();
  });

  // The control: the same harness over a text diff reaches the staging view,
  // so the assertion above bites on DiffViewer's isBinary gate.
  it("offers hunk staging on the same file as a text diff", async () => {
    renderViewer({
      filePath: "x",
      text: TEXT,
      isBinary: false,
      isTruncated: false,
    });
    expect(await screen.findByText(LINE_STAGING_HINT)).toBeTruthy();
    expect(screen.queryByText("Binary file added")).toBeNull();
  });
});
