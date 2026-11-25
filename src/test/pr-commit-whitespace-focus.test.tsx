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
  gitDiffBytesIgnoringWhitespace,
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
  gitDiffBytesIgnoringWhitespace: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitFirstParent: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView = vi.fn();

beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Non-zero hex, so the oid-width guard never reads a zero run. */
const COMMIT = "abcdef0123".repeat(4);
const OLD_SHA = "1234567890".repeat(4);
// A re-indent of f() plus a content edit in g(): the forge's patch and the
// real `git diff -w` hunk of the pair (git 2.51.1).
const OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line 11\n  line 12\n  line 13\n  line 14\n}\n";
const NEW =
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line ELEVEN\n  line 12\n  line 13\n  line 14\n}\n";
const FORGE_TEXT =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,17 +1,17 @@\n function f() {\n" +
  "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
  "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
  " }\n function g() {\n   line 7\n   line 8\n   line 9\n   line 10\n" +
  "-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const WS_HUNKS =
  "@@ -11,7 +11,7 @@ function g() {\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const bytes = (text: string): FileBytes =>
  ({
    base64: Buffer.from(text).toString("base64"),
    mime: null,
    tooLarge: false,
    size: text.length,
  }) as FileBytes;
const commit: PrCommitOut = {
  oid: COMMIT,
  headline: "Re-indent f",
  date: "2026-11-01T10:00:00Z",
  author: "Ada",
  messageBody: "",
};
const comment = (
  path: string | null,
  line: number | null,
  body: string,
): CommitCommentOut => ({
  id: `c${line ?? 0}`,
  author: "Ada",
  body,
  createdAt: "2026-11-01T10:00:00Z",
  viewerDidAuthor: false,
  path,
  line,
  startLine: null,
  position: null,
});
const ALL_ON = new Proxy({}, { get: () => true });
const newLine = (n: number) =>
  document.querySelector(`span[data-line-new-num="${n}"]`);

describe("the PR commit view's comment list across a flip", () => {
  it("AC-U3: a focused Show whitespace button a flip removes hands focus to the list", async () => {
    const on = { ...DEFAULT_SETTINGS, diffHideWhitespace: true };
    vi.mocked(loadSettings).mockResolvedValue(on);
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
    vi.mocked(gitObjectsPresent).mockImplementation(
      async (_r, oids) => oids.length === 0,
    );
    vi.mocked(forgeCommitFirstParent).mockResolvedValue(OLD_SHA);
    vi.mocked(forgePrCommitDiff).mockResolvedValue(FORGE_TEXT);
    vi.mocked(forgeFileAtSha).mockImplementation(async (_repo, sha) =>
      bytes(sha === OLD_SHA ? OLD : NEW),
    );
    vi.mocked(gitDiffBytesIgnoringWhitespace).mockResolvedValue({
      hunks: WS_HUNKS,
      isBinary: false,
    });
    // One comment on a re-indented line, and one on the commit, which stays
    // in the list whatever the setting.
    vi.mocked(forgeCommitComments).mockResolvedValue([
      comment("f.txt", 4, "On a re-indented line"),
      comment(null, null, "On the commit"),
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, on);
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
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    const show = await screen.findByRole(
      "button",
      { name: "Show whitespace" },
      { timeout: 10_000 },
    );
    act(() => show.focus());
    expect(document.activeElement).toBe(show);
    // A flip by another route: the setting written straight into the cache.
    const off = { ...on, diffHideWhitespace: false };
    vi.mocked(loadSettings).mockResolvedValue(off);
    act(() => {
      client.setQueryData(settingsKeys.settings, off);
    });
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(show.isConnected).toBe(false));
    expect(
      screen.queryByText(/on a line hidden by Hide whitespace/),
    ).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Commit comments"]'),
    );
    client.clear();
  }, 30_000);
});
