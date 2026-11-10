// A reword's AI generation in Edit history: it survives the History tab's
// <Activity> hide, and a reseed of the commit set stops it. Negative controls:
// dropping EditHistoryDialog's host span turns the hide case red (the hook then
// aborts on every cleanup); dropping its reseed cancel turns the reseed case
// red; cancelling on every effect run turns the hide-and-show case red; dropping
// the run's reseed check on its text turns the hidden-reseed case red; keying
// both on the commit set instead of the reseed count turns the set-back case red.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditHistoryDialog } from "@/features/history/EditHistoryDialog";
import { createAiClient } from "@/lib/ai/client";
import {
  gitBranchDiff,
  gitRecentCommits,
  gitUnpushedMessages,
  readRepoInstructions,
} from "@/lib/git/api";
import type { CommitSummary } from "@/lib/git/types";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { type Feed, feedingClient } from "./ai-feed-client";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitUnpushedMessages: vi.fn(),
  gitRewriteCommits: vi.fn(),
  gitRebaseEdit: vi.fn(),
  gitBranchDiff: vi.fn(),
  gitRecentCommits: vi.fn(),
  readRepoInstructions: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(async () => structuredClone(DEFAULT_SETTINGS)),
}));

vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(async () => []),
}));

vi.mock("@/lib/ai/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/client")>()),
  createAiClient: vi.fn(),
}));

const commit = (char: string, subject: string): CommitSummary => ({
  hash: char.repeat(40),
  subject,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
});
const FOURTH = commit("d", "Fourth");
const THIRD = commit("c", "Third");
const SECOND = commit("b", "Second");
const FIRST = commit("a", "First");
const COMMITS = [THIRD, SECOND, FIRST];

let signals: AbortSignal[] = [];
let feeds: Feed[] = [];
const feedClient = feedingClient(
  (signal) => signals.push(signal),
  (feed) => feeds.push(feed),
);

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const tree = (shown: boolean, commits: CommitSummary[]) => (
    <QueryClientProvider client={client}>
      {createElement(Activity, {
        mode: shown ? "visible" : "hidden",
        children: (
          <EditHistoryDialog
            repoPath="/repo"
            base={"f".repeat(40)}
            commits={commits}
            emptyNote=""
            open
            onOpenChange={vi.fn()}
            onDone={vi.fn()}
          />
        ),
      })}
    </QueryClientProvider>
  );
  const view = render(tree(true, COMMITS));
  return {
    rerender: (shown: boolean, commits = COMMITS) =>
      view.rerender(tree(shown, commits)),
  };
}

async function rewordSecond(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Action for Second" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: /^Reword/ }));
}

async function startGenerate(user: ReturnType<typeof userEvent.setup>) {
  const generate = await screen.findByRole("button", { name: /^Generate/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await user.click(generate);
  await waitFor(() => expect(feeds).toHaveLength(1));
}

const messageOf = (subject: string) =>
  screen.getByRole("textbox", { name: `Message for ${subject}` });

// jsdom has no scrollIntoView; the dialog scrolls a moved or reseeded row in.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  useUiStore.setState({ repoPath: "/repo" });
  signals = [];
  feeds = [];
  vi.mocked(gitUnpushedMessages).mockResolvedValue(
    [FOURTH, ...COMMITS].map((c) => ({
      hash: c.hash,
      message: c.subject,
      authorDate: { epochSeconds: 1_762_000_000, offsetMinutes: 60 },
      committerDate: { epochSeconds: 1_762_000_000, offsetMinutes: 60 },
    })),
  );
  vi.mocked(gitBranchDiff).mockResolvedValue({
    text: "diff --git a/x b/x\n",
    truncated: false,
    files: [],
    excludedFiles: 0,
    unreadableFiles: 0,
  });
  vi.mocked(gitRecentCommits).mockResolvedValue([]);
  vi.mocked(readRepoInstructions).mockResolvedValue(null);
  vi.mocked(createAiClient).mockResolvedValue(feedClient);
});

describe("Edit history reword generation", () => {
  it("fills the reword through a tab hide", async () => {
    const user = userEvent.setup();
    const dialog = renderDialog();
    await rewordSecond(user);
    await startGenerate(user);
    dialog.rerender(false);
    expect(signals[0].aborted).toBe(false);
    await act(async () => feeds[0].push("Reword the "));
    await act(async () => feeds[0].push("second commit"));
    await act(async () => feeds[0].end());
    dialog.rerender(true);
    await waitFor(() =>
      expect(messageOf("Second")).toHaveValue("Reword the second commit"),
    );
  });

  it("keeps the run through a hide and show with no reseed", async () => {
    const user = userEvent.setup();
    const dialog = renderDialog();
    await rewordSecond(user);
    await startGenerate(user);
    dialog.rerender(false);
    dialog.rerender(true);
    expect(signals[0].aborted).toBe(false);
    await act(async () => feeds[0].push("Shown again"));
    await act(async () => feeds[0].end());
    await waitFor(() => expect(messageOf("Second")).toHaveValue("Shown again"));
  });

  it("drops a hidden reseed's stale text and stops on show", async () => {
    const user = userEvent.setup();
    const dialog = renderDialog();
    await rewordSecond(user);
    await startGenerate(user);
    dialog.rerender(false);
    dialog.rerender(false, [FOURTH, ...COMMITS]);
    await act(async () => feeds[0].push("stale text"));
    // Still streaming while hidden: only a shown tab's effects stop it.
    expect(signals[0].aborted).toBe(false);
    dialog.rerender(true, [FOURTH, ...COMMITS]);
    expect(signals[0].aborted).toBe(true);
    await rewordSecond(user);
    expect(messageOf("Second")).toHaveValue("Second");
  });

  it("stops on show after a hidden reseed that changes the set back", async () => {
    const user = userEvent.setup();
    const dialog = renderDialog();
    await rewordSecond(user);
    await startGenerate(user);
    dialog.rerender(false);
    dialog.rerender(false, [FOURTH, ...COMMITS]);
    dialog.rerender(false, COMMITS);
    await act(async () => feeds[0].push("stale text"));
    dialog.rerender(true);
    expect(signals[0].aborted).toBe(true);
    await rewordSecond(user);
    expect(messageOf("Second")).toHaveValue("Second");
  });

  it("stops the run when the commit set reseeds", async () => {
    const user = userEvent.setup();
    const dialog = renderDialog();
    await rewordSecond(user);
    await startGenerate(user);
    // A commit landed elsewhere; the generating row survives the reseed.
    dialog.rerender(true, [FOURTH, ...COMMITS]);
    expect(signals[0].aborted).toBe(true);
    await act(async () => feeds[0].push("stale text"));
    await rewordSecond(user);
    expect(messageOf("Second")).toHaveValue("Second");
    expect(
      await screen.findByRole("button", { name: /^Generate/ }),
    ).toBeEnabled();
  });
});
