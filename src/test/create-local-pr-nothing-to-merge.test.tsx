import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateLocalPrDialog } from "@/features/pulls/CreateLocalPrDialog";
import { gitBranchAhead, gitBranches } from "@/lib/git/api";
import type { Branch, CommitSummary } from "@/lib/git/types";
import { createLocalPr } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchAhead: vi.fn(),
  // Shell reads the dialog makes that these cases never need answered.
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitDefaultBranch: vi.fn(() => new Promise(() => undefined)),
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  createLocalPr: vi.fn(),
  updateLocalPr: vi.fn(async () => undefined),
}));
vi.mock("@/lib/automations/runner", () => ({
  triggerAutomations: vi.fn(),
}));
vi.mock("@/lib/review-notes/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review-notes/store")>()),
  getReviewNote: vi.fn(async () => null),
  deleteReviewNote: vi.fn(async () => undefined),
}));

const REPO = "C:/repo";

const COMMIT = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  subject: "feature work",
} as unknown as CommitSummary;

function renderDialog({ base = "main" }: { base?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreateLocalPrDialog
        repoPath={REPO}
        defaultHead="feat"
        defaultBase={base || undefined}
        open
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>,
  );
  return client;
}

/** Re-read only the commit-count query; the dialog's shell reads never settle. */
const refetchCount = (client: QueryClient) =>
  client.refetchQueries({
    predicate: (q) => q.queryKey.includes("ahead"),
  });

const createButton = () =>
  screen.getByRole("button", { name: /Create local PR/ });

/** Fill the title so the form is otherwise submittable: only the hold can refuse. */
async function fillTitle(user: ReturnType<typeof userEvent.setup>) {
  const title = screen.getByLabelText("Title");
  await user.type(title, "A title");
  return title;
}

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(createLocalPr).mockReset();
  vi.mocked(createLocalPr).mockImplementation(async (_repo, input) => ({
    id: "pr-1",
    ...input,
    status: "open",
    approved: false,
    labels: [],
    comments: [],
    createdAt: new Date().toISOString(),
  }));
  vi.mocked(gitBranchAhead).mockReset();
  vi.mocked(gitBranches).mockImplementation(() => new Promise(() => undefined));
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

function expectHeld(reason: string) {
  const button = createButton();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(button).toHaveAccessibleDescription(reason);
  expect(button.parentElement).toHaveAttribute("title", reason);
}

/** Every submit path: the mod+Enter chord, Enter in a field, and the button. */
async function tryEverySubmit(
  user: ReturnType<typeof userEvent.setup>,
  title: HTMLElement,
) {
  title.focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await user.keyboard("{Enter}");
  fireEvent.click(createButton());
}

describe("Create local PR: nothing to merge", () => {
  it("holds Create while the count is loading", async () => {
    vi.mocked(gitBranchAhead).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderDialog();
    const title = await fillTitle(user);
    expect(
      await screen.findByText("Counting commits to merge…", { selector: "p" }),
    ).toBeInTheDocument();
    expectHeld("Counting commits to merge…");
    await tryEverySubmit(user, title);
    expect(createLocalPr).not.toHaveBeenCalled();
  });

  it("holds Create with its reason when the head is already in the base", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();
    const title = await fillTitle(user);
    const reason = "Nothing to merge: feat is already in main.";
    expect(
      await screen.findByText(reason, { selector: "p > span" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 commits to merge/)).toBeNull();
    expectHeld(reason);
    await tryEverySubmit(user, title);
    expect(createLocalPr).not.toHaveBeenCalled();
  });

  it("says a failed count failed and leaves Create enabled", async () => {
    vi.mocked(gitBranchAhead).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderDialog();
    await fillTitle(user);
    expect(
      await screen.findByText("Couldn't count the commits to merge."),
    ).toBeInTheDocument();
    expect(createButton()).not.toHaveAttribute("aria-disabled");
    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
  });

  it("keeps the loaded count when a background refetch fails", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT, COMMIT, COMMIT]);
    const user = userEvent.setup();
    const client = renderDialog();
    await fillTitle(user);
    expect(await screen.findByText("3 commits to merge.")).toBeInTheDocument();
    vi.mocked(gitBranchAhead).mockRejectedValue(new Error("boom"));
    await refetchCount(client);
    await waitFor(() =>
      expect(vi.mocked(gitBranchAhead).mock.calls.length).toBeGreaterThan(1),
    );
    expect(screen.getByText("3 commits to merge.")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't count the commits to merge."),
    ).toBeNull();
    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
  });

  it("stays held at zero when the refetch of an empty count fails", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([]);
    const user = userEvent.setup();
    const client = renderDialog();
    const title = await fillTitle(user);
    const reason = "Nothing to merge: feat is already in main.";
    expect(
      await screen.findByText(reason, { selector: "p > span" }),
    ).toBeInTheDocument();
    vi.mocked(gitBranchAhead).mockRejectedValue(new Error("boom"));
    await refetchCount(client);
    expectHeld(reason);
    await tryEverySubmit(user, title);
    expect(createLocalPr).not.toHaveBeenCalled();
  });

  it("creates when there is something to merge", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
    const user = userEvent.setup();
    renderDialog();
    await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
  });

  it("creates for a kept-local head, which a local pull request never pushes", async () => {
    vi.mocked(gitBranches).mockResolvedValue(
      ["main", "feat"].map(
        (name) =>
          ({
            name,
            isCurrent: name === "feat",
            archived: false,
            keepLocal: name === "feat",
          }) as Branch,
      ),
    );
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
    const user = userEvent.setup();
    renderDialog();
    await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    expect(createButton()).toBeEnabled();
    expect(createButton()).not.toHaveAttribute("aria-disabled");
    await user.click(createButton());
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
  });

  it("holds Create and names why when there is no base branch to choose", async () => {
    const user = userEvent.setup();
    renderDialog({ base: "" });
    const title = await fillTitle(user);
    const reason = "Choose a base branch to merge into.";
    expect(
      await screen.findByText(reason, { selector: "p" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Counting commits/, { selector: "p" }),
    ).toBeNull();
    expectHeld(reason);
    expect(gitBranchAhead).not.toHaveBeenCalled();
    await tryEverySubmit(user, title);
    expect(createLocalPr).not.toHaveBeenCalled();
  });

  it("holds Create with its reason when head and base are the same branch", async () => {
    vi.mocked(gitBranchAhead).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderDialog({ base: "feat" });
    const title = await fillTitle(user);
    const reason = "Pick two different branches.";
    expect(
      await screen.findByText(reason, { selector: "p" }),
    ).toBeInTheDocument();
    expectHeld(reason);
    await tryEverySubmit(user, title);
    expect(createLocalPr).not.toHaveBeenCalled();
  });

  it("re-holds Create when the pair changes under a counted one", async () => {
    vi.mocked(gitBranches).mockResolvedValue(
      ["main", "feat", "dev"].map(
        (name) =>
          ({ name, isCurrent: name === "feat", archived: false }) as Branch,
      ),
    );
    vi.mocked(gitBranchAhead).mockImplementation(async (_repo, base) =>
      base === "refs/heads/main" ? [COMMIT] : new Promise(() => undefined),
    );
    const user = userEvent.setup();
    renderDialog();
    await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(createButton()).toBeEnabled();
    await user.click(screen.getByRole("combobox", { name: "Base" }));
    await user.click(await screen.findByRole("option", { name: /dev/ }));
    expect(
      await screen.findByText("Counting commits to merge…", { selector: "p" }),
    ).toBeInTheDocument();
    expectHeld("Counting commits to merge…");
  });
});
