import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditHistoryDialog } from "@/features/history/EditHistoryDialog";
import { gitUnpushedMessages } from "@/lib/git/api";
import type { CommitSummary } from "@/lib/git/types";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitUnpushedMessages: vi.fn(),
  gitRewriteCommits: vi.fn(),
  gitRebaseEdit: vi.fn(),
}));

const DROP_ALL = "Keep at least one commit";
const CATCHING_UP = "Catching up with the branch…";
const PUSHED = "Nothing left to edit: every commit is pushed.";

const HASH_A = "abcdef0123".repeat(4);
const HASH_BASE = `b${HASH_A.slice(1)}`;

const commitA: CommitSummary = {
  hash: HASH_A,
  subject: "Add the parser",
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
};

function renderDialog(props: {
  commits: CommitSummary[];
  base: string;
  emptyNote: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // useAiEnabled reads the settings optimistically, so seed what it reads.
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const tree = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <EditHistoryDialog
        repoPath="/repo"
        open
        onOpenChange={vi.fn()}
        onDone={vi.fn()}
        {...p}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(tree(props));
  return (next: typeof props) => rerender(tree(next));
}

const rewriteButton = () =>
  screen.getByRole("button", { name: /Rewrite history/ });

beforeEach(() => {
  vi.mocked(gitUnpushedMessages).mockReset();
  vi.mocked(gitUnpushedMessages).mockResolvedValue([
    { hash: HASH_A, message: "Add the parser" },
  ]);
});

describe("Edit history over an empty commit set", () => {
  it("shows the hold's note, muted, instead of the drop-all error", () => {
    renderDialog({ commits: [], base: "", emptyNote: CATCHING_UP });
    const note = screen.getByText(CATCHING_UP);
    expect(note.closest(".text-warning")).toBeNull();
    expect(screen.queryByText(new RegExp(DROP_ALL))).toBeNull();
    expect(rewriteButton()).toBeDisabled();
  });

  it("announces the note when the set empties under the open dialog", async () => {
    const rerender = renderDialog({
      commits: [commitA],
      base: HASH_BASE,
      emptyNote: "",
    });
    await screen.findByRole("dialog");
    rerender({ commits: [], base: "", emptyNote: PUSHED });
    const status = within(screen.getByRole("dialog")).getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(PUSHED));
  });

  it("still holds a non-empty set whose every row is dropped", async () => {
    const user = userEvent.setup();
    renderDialog({ commits: [commitA], base: HASH_BASE, emptyNote: "" });
    await user.click(
      screen.getByRole("button", { name: `Action for ${commitA.subject}` }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /^Drop/ }));
    const error = await screen.findByText(new RegExp(DROP_ALL));
    expect(error.closest(".text-warning")).not.toBeNull();
    expect(screen.queryByText(CATCHING_UP)).toBeNull();
    expect(rewriteButton()).toBeDisabled();
  });
});
