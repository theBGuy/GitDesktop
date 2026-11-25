// A PR commit file's inline comments follow the rows on screen: while a
// refresh's hold keeps the previous rows up over a newer view, a comment on a
// line only those rows draw stays inline (the list below judges the same rows).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import {
  type FileBytes,
  forgeCommitComments,
  forgeCommitFirstParent,
  forgeFileAtSha,
  forgePrCommitDiff,
  forgeStatus,
  gitObjectsPresent,
} from "@/lib/git/api";
import type {
  CommitCommentOut,
  ForgeStatus,
  PrCommitOut,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeFileAtSha: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitFirstParent: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView = vi.fn();

beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

const OLD_SHA = "a".repeat(40);
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const COMMIT = "abcdef0123".repeat(4);
const OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n}\n";
const NEW =
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7x\n}\n";
// The forge's patch: f's body re-indented, g's line changed.
const FORGE =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,11 +1,11 @@\n function f() {\n" +
  "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
  "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
  " }\n function g() {\n-  line 7\n+  line 7x\n }\n";
// A newer answer for the same commit that draws only g's change.
const FORGE_NEXT =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -9,3 +9,3 @@\n function g() {\n-  line 7\n+  line 7x\n }\n";
const BODY = "On a re-indented line";
const ALL_ON = new Proxy({}, { get: () => true });
const bytes = (text: string): FileBytes => ({
  base64: Buffer.from(text).toString("base64"),
  mime: null,
  tooLarge: false,
  size: text.length,
});
const comment: CommitCommentOut = {
  id: "c4",
  author: "Ada",
  body: BODY,
  createdAt: "2026-11-01T10:00:00Z",
  viewerDidAuthor: true,
  path: "f.txt",
  line: 4,
  startLine: null,
  position: null,
};
const commit: PrCommitOut = {
  oid: COMMIT,
  headline: "Re-indent f",
  date: "2026-11-01T10:00:00Z",
  author: "Ada",
  messageBody: "",
};
const newLine = (n: number) =>
  document.querySelector(`span[data-line-new-num="${n}"]`);
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
};

function mount() {
  const settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: false };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "github.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(gitObjectsPresent).mockImplementation(async (_r, oids) =>
    oids.length > 0 ? false : true,
  );
  vi.mocked(forgeCommitFirstParent).mockResolvedValue(OLD_SHA);
  vi.mocked(forgePrCommitDiff).mockResolvedValue(FORGE);
  vi.mocked(forgeFileAtSha).mockImplementation(async (_repo, sha) =>
    bytes(sha === OLD_SHA ? OLD : NEW),
  );
  vi.mocked(forgeCommitComments).mockResolvedValue([comment]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  render(
    <QueryClientProvider client={client}>
      <PrCommitDetail
        repoPath="/repo"
        number={7}
        commit={commit}
        onBack={() => undefined}
        canCommentCommits={false}
        remoteLabel="GitHub"
        lens="origin"
      />
    </QueryClientProvider>,
  );
  return client;
}

describe("a PR commit file's inline comments under a refresh's hold", () => {
  it("keeps a comment on a line only the held rows draw inline", async () => {
    const client = mount();
    await waitFor(
      () =>
        expect(
          screen.getByText(BODY).closest("[data-diff-anchor]"),
        ).not.toBeNull(),
      { timeout: 10_000 },
    );
    // The whole-file reads answered: the content build is on screen.
    await waitFor(() => {
      const reads = client
        .getQueryCache()
        .findAll({ queryKey: ["forge-file-at-sha"] });
      expect(reads.length).toBe(2);
      for (const q of reads) expect(q.state.fetchStatus).toBe("idle");
    });
    await settle();
    // A refresh: the whole-file reads refetch and never answer, and the
    // commit's patch answers a newer text without f's lines, so the rows
    // built from the older text hold.
    vi.mocked(forgeFileAtSha).mockImplementation(
      () => new Promise<FileBytes>(() => undefined),
    );
    vi.mocked(forgePrCommitDiff).mockResolvedValue(FORGE_NEXT);
    act(() => {
      void client.invalidateQueries({ queryKey: ["forge-file-at-sha"] });
    });
    act(() => {
      void client.invalidateQueries({
        queryKey: ["repo", "/repo", "pr", "origin", 7, "commit-diff"],
      });
    });
    await waitFor(() => expect(forgePrCommitDiff).toHaveBeenCalledTimes(2));
    await settle();
    // The newer text reached the slot: its line 10 is drawn by both texts.
    expect(newLine(10)).not.toBeNull();
    // Still the held rows: line 4 is drawn, and its comment with it.
    expect(newLine(4)).not.toBeNull();
    expect(screen.getByText(BODY).closest("[data-diff-anchor]")).not.toBeNull();
    // The hold's bound paints the newer rows, and the comment moves to the list.
    await waitFor(() => expect(newLine(4)).toBeNull());
    await settle();
    expect(screen.getByText(BODY).closest("[data-diff-anchor]")).toBeNull();
  }, 30_000);
});
