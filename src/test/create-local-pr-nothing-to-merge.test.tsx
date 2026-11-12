import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateLocalPrDialog } from "@/features/pulls/CreateLocalPrDialog";
import { gitBranchAhead, gitBranches } from "@/lib/git/api";
import type { Branch, CommitSummary } from "@/lib/git/types";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { createLocalPr } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
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

/** Create is usable: a held Create is aria-disabled, so enabled alone isn't. */
function expectLive() {
  const button = createButton();
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-disabled", "true");
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
    expectLive();
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
    expectLive();
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
    expectLive();
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
    expectLive();
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
    expectLive();
    await user.click(screen.getByRole("combobox", { name: "Base" }));
    await user.click(await screen.findByRole("option", { name: /dev/ }));
    expect(
      await screen.findByText("Counting commits to merge…", { selector: "p" }),
    ).toBeInTheDocument();
    expectHeld("Counting commits to merge…");
  });
});

describe("Create local PR: a running create", () => {
  it("lets no further mod+Enter or field Enter start a second create", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
    let settle: () => void = () => undefined;
    vi.mocked(createLocalPr).mockImplementation(
      (_repo, input) =>
        new Promise((resolve) => {
          settle = () =>
            resolve({
              id: "pr-1",
              ...input,
              status: "open",
              approved: false,
              labels: [],
              comments: [],
              createdAt: new Date().toISOString(),
            });
        }),
    );
    const user = userEvent.setup();
    renderDialog();
    const title = await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    title.focus();
    const chord = () => user.keyboard("{Control>}{Enter}{/Control}");
    await chord();
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
    await waitFor(() => expectHeld(ACT_PENDING_REASON));
    await chord();
    await chord();
    // Enter in a field reaches the same refusal through the native submit.
    fireEvent.submit(title.closest("form") as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 20));
    expect(createLocalPr).toHaveBeenCalledTimes(1);
    settle();
  });

  it("re-arms the shortcut after a failed create", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
    vi.mocked(createLocalPr).mockRejectedValueOnce(new Error("refused"));
    const user = userEvent.setup();
    renderDialog();
    const title = await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    title.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
    await waitFor(expectLive);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(2));
  });

  it("starts one create from a held mod+Enter", async () => {
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
    // user-event awaits advanceTimers before each repeat: once the first Enter
    // is down, hold the repeats until its create settled and Create is live, so
    // only the repeat arm can refuse them.
    let enterDown = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") enterDown = true;
    };
    document.addEventListener("keydown", onKey, true);
    const user = userEvent.setup({
      advanceTimers: async () => {
        if (!enterDown) return;
        await waitFor(() => {
          expect(createLocalPr).toHaveBeenCalledTimes(1);
          expectLive();
        });
      },
    });
    try {
      renderDialog();
      const title = await fillTitle(user);
      expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
      title.focus();
      await user.keyboard("{Control>}{Enter>3}{/Enter}{/Control}");
      await new Promise((r) => setTimeout(r, 20));
      expect(createLocalPr).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", onKey, true);
    }
  });
});

describe("Create local PR: a reopen during a create", () => {
  type Seeds = { defaultHead?: string; defaultBase?: string };
  const control = {
    setOpen: (_open: boolean) => undefined as void,
    setSeeds: (_seeds: Seeds) => undefined as void,
    setRepo: (_repo: string) => undefined as void,
  };

  function Host() {
    const [repo, setRepo] = useState(REPO);
    control.setRepo = setRepo;
    const [open, setOpen] = useState(true);
    const [seeds, setSeeds] = useState<Seeds>({
      defaultHead: "feat",
      defaultBase: "main",
    });
    control.setOpen = setOpen;
    control.setSeeds = setSeeds;
    return (
      <CreateLocalPrDialog
        repoPath={repo}
        defaultHead={seeds.defaultHead}
        defaultBase={seeds.defaultBase}
        open={open}
        onOpenChange={setOpen}
      />
    );
  }

  /** Closes, then reopens the way the host does: seeds and open in one update. */
  const reopen = (seeds: Seeds = {}) =>
    act(() => {
      control.setSeeds(seeds);
      control.setOpen(true);
    });

  beforeEach(() => {
    useUiStore.setState({ repoPath: REPO });
    vi.mocked(gitBranches).mockResolvedValue(
      ["main", "feat", "dev"].map(
        (name) =>
          ({ name, isCurrent: name === "feat", archived: false }) as Branch,
      ),
    );
    vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
  });

  async function createThenClose() {
    const pending: {
      resolve: (v: Awaited<ReturnType<typeof createLocalPr>>) => void;
      reject: (e: unknown) => void;
    } = { resolve: () => undefined, reject: () => undefined };
    vi.mocked(createLocalPr).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          pending.resolve = resolve;
          pending.reject = reject;
        }),
    );
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    );
    const title = await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    title.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
    act(() => control.setOpen(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return { user, pending };
  }

  const created = {
    id: "pr-1",
    title: "A title",
    body: "",
    base: "main",
    head: "feat",
    status: "open",
    approved: false,
    labels: [],
    comments: [],
    createdAt: new Date().toISOString(),
  } as unknown as Awaited<ReturnType<typeof createLocalPr>>;

  it("keeps the draft with Create held, and the settle closes it", async () => {
    const { user, pending } = await createThenClose();
    reopen();
    expect(await screen.findByLabelText("Title")).toHaveValue("A title");
    expectHeld(ACT_PENDING_REASON);
    screen.getByLabelText("Title").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 20));
    expect(createLocalPr).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(created));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createLocalPr).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog and the draft when that create fails, and re-arms the shortcut", async () => {
    const { user, pending } = await createThenClose();
    reopen();
    expect(await screen.findByLabelText("Title")).toHaveValue("A title");
    await act(async () => pending.reject(new Error("refused")));
    await waitFor(expectLive);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("A title");
    screen.getByLabelText("Title").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(2));
  });

  it("still shows an explicitly requested head and base over a running create", async () => {
    const { pending } = await createThenClose();
    reopen({ defaultHead: "dev", defaultBase: "main" });
    expect(await screen.findByLabelText("Title")).toHaveValue("");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Merge" })).toHaveTextContent(
        "dev",
      ),
    );
    expect(screen.getByRole("combobox", { name: "Base" })).toHaveTextContent(
      "main",
    );
    await act(async () => pending.resolve(created));
    // The first create's settle closes only its own draft, never the requested one.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Merge" })).toHaveTextContent(
      "dev",
    );
    expect(screen.getByRole("combobox", { name: "Base" })).toHaveTextContent(
      "main",
    );
  });

  it("resets for another repository opened during a create", async () => {
    const { pending } = await createThenClose();
    const other = "C:/other";
    act(() => {
      useUiStore.setState({ repoPath: other });
      control.setRepo(other);
    });
    reopen({});
    expect(await screen.findByLabelText("Title")).toHaveValue("");
    expect(createButton()).not.toHaveAccessibleDescription(ACT_PENDING_REASON);
    await act(async () => pending.resolve(created));
  });
});
