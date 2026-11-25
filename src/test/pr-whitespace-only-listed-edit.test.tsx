// A whitespace-only PR commit file whose listed comment is being edited while
// the setting turns off by another route (another window's write): the edit
// pins its row, so nothing holds the view and nothing moves the edit.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  saveSettingsPatch: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

// jsdom has none; the commit composer's editor scrolls itself into view.
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
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n}\n";
// The forge's re-indent of f's body; its `-w` diff has no hunk (git 2.51.1).
const FORGE =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,10 +1,10 @@\n function f() {\n" +
  "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
  "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
  " }\n function g() {\n   line 7\n";
const ARM = "Only whitespace changed in this file";
const HIDDEN_NOTE = /on a line hidden by Hide whitespace/;
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
  const settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: true };
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
  vi.mocked(gitDiffBytesIgnoringWhitespace).mockResolvedValue({
    hunks: "",
    isBinary: false,
  });
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

describe("a whitespace-only file under a listed edit", () => {
  it("lands the forge rows when the setting turns off elsewhere, keeping the edit in its pinned row", async () => {
    const user = userEvent.setup();
    const client = mount();
    expect(
      await screen.findByText(ARM, undefined, { timeout: 10_000 }),
    ).toBeTruthy();
    expect(await screen.findByText(HIDDEN_NOTE)).toBeTruthy();
    await user.click(
      await screen.findByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Edit comment" });
    await user.type(editor, " and more");
    // A settings re-read carrying another window's write: no probe ran.
    act(() =>
      client.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        diffHideWhitespace: false,
      }),
    );
    // Nothing holds the view: the forge rows paint at once.
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    await settle();
    expect(screen.queryByText(ARM)).toBeNull();
    // The pinned row keeps its edit, and the pane draws no copy of it.
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit comment",
      }).value,
    ).toBe(`${BODY} and more`);
    expect(document.querySelector("[data-diff-anchor]")).toBeNull();
    // Closing the edit moves the comment inline, drawn once.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.getByText(BODY).closest("[data-diff-anchor]"),
      ).not.toBeNull(),
    );
    expect(screen.getAllByText(BODY)).toHaveLength(1);
  }, 30_000);
});
