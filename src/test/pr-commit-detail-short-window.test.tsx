import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import {
  forgeCommitComments,
  forgeCommitFirstParent,
  forgePrCommitDiff,
  forgeStatus,
  gitObjectsPresent,
} from "@/lib/git/api";
import type { ForgeStatus, PrCommitOut } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
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
const commit: PrCommitOut = {
  oid: COMMIT,
  headline: "Add a line",
  date: "2026-11-01T10:00:00Z",
  author: "Ada",
  messageBody: "",
};
const ALL_ON = new Proxy({}, { get: () => true });
const classes = (el: Element | null | undefined) =>
  (el?.getAttribute("class") ?? "").split(/\s+/);

// jsdom lays nothing out, so this pins the class chain a real Chromium
// measured: on a 600 px window the composer's Comment button sat under the PR
// footer, and the comments list shrank below its own padding.
describe("the PR commit view on a short window", () => {
  it("scrolls the diff-and-comments column instead of spilling the composer", async () => {
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
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
    vi.mocked(gitObjectsPresent).mockResolvedValue(false);
    vi.mocked(forgeCommitFirstParent).mockResolvedValue(null);
    vi.mocked(forgePrCommitDiff).mockResolvedValue(
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1,2 @@\n one\n+two\n",
    );
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
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
    const list = await waitFor(
      () => {
        const el = document.querySelector('[aria-label="Commit comments"]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
      },
      { timeout: 10_000 },
    );
    const pane = list.parentElement;
    const column = pane?.parentElement;
    // The one scroll region for the diff and the comments together.
    expect(column?.tagName).toBe("MAIN");
    expect(classes(column)).toEqual(
      expect.arrayContaining(["flex-1", "flex-col", "overflow-y-auto"]),
    );
    // The diff keeps a usable floor instead of collapsing to a sliver.
    const diff = column?.firstElementChild;
    expect(classes(diff)).toEqual(
      expect.arrayContaining(["min-h-40", "flex-1"]),
    );
    expect(classes(diff)).not.toContain("min-h-0");
    // The pane's cap never drops below a list line plus the composer.
    expect(classes(pane)).toEqual(
      expect.arrayContaining(["max-h-[max(45%,16rem)]", "shrink-0"]),
    );
    expect(classes(pane)).not.toContain("max-h-[45%]");
    // The list keeps one line visible rather than shrinking into its padding.
    expect(classes(list)).toEqual(
      expect.arrayContaining(["min-h-10", "overflow-y-auto"]),
    );
    client.clear();
  }, 30_000);
});
