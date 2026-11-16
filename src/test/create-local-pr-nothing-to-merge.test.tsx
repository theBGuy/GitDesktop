import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_PENDING_GENERATE_REASON } from "@/features/conversations/useAiStream";
import { CreateLocalPrDialog } from "@/features/pulls/CreateLocalPrDialog";
import { triggerAutomations } from "@/lib/automations/runner";
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
// Pass-through spy over the options hook: each COMMITTED render's open flag and
// keep list are recorded from a layout effect, so a render React discards (a
// render-phase state update re-runs it) never counts.
const pickerCommits = vi.hoisted(
  () => [] as { open: boolean; keep: unknown[] }[],
);
vi.mock("@/features/pulls/useBranchPickerOptions", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@/features/pulls/useBranchPickerOptions")
    >();
  const { useLayoutEffect } = await import("react");
  function useSpiedBranchPickerOptions(
    ...args: Parameters<typeof real.useBranchPickerOptions>
  ) {
    const [, open, keep] = args;
    useLayoutEffect(() => {
      pickerCommits.push({ open, keep: [...(keep ?? [])] });
    });
    return real.useBranchPickerOptions(...args);
  }
  return { ...real, useBranchPickerOptions: useSpiedBranchPickerOptions };
});
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

  async function createThenClose(
    fill?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
  ) {
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
    await fill?.(user);
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

  /** The next create stays pending until the test settles it. */
  function deferNextCreate() {
    const next: {
      resolve: (v: Awaited<ReturnType<typeof createLocalPr>>) => void;
      reject: (e: unknown) => void;
    } = { resolve: () => undefined, reject: () => undefined };
    vi.mocked(createLocalPr).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          next.resolve = resolve;
          next.reject = reject;
        }),
    );
    return next;
  }

  /** Draft A's create runs; a requested pair reseeds draft B, whose create starts too. */
  async function twoCreatesRunning() {
    const { user, pending: a } = await createThenClose();
    const b = deferNextCreate();
    reopen({ defaultHead: "dev", defaultBase: "main" });
    const title = await screen.findByLabelText("Title");
    expect(title).toHaveValue("");
    await user.type(title, "B title");
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    title.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(2));
    return { user, a, b };
  }

  const chord = (user: ReturnType<typeof userEvent.setup>) => {
    screen.getByLabelText("Title").focus();
    return user.keyboard("{Control>}{Enter}{/Control}");
  };

  it("holds a newer draft's Create after the older create settles (T1)", async () => {
    const { user, a, b } = await twoCreatesRunning();
    await act(async () => a.resolve(created));
    await waitFor(() => expectHeld(ACT_PENDING_REASON));
    expect(within(createButton()).getByRole("status")).toBeInTheDocument();
    const generate = screen.getByRole("button", { name: /Generate/ });
    expect(generate).toHaveAttribute("aria-disabled", "true");
    expect(generate).toHaveAccessibleDescription(
      new RegExp(CREATE_PENDING_GENERATE_REASON),
    );
    await chord(user);
    fireEvent.submit(
      screen.getByLabelText("Title").closest("form") as HTMLFormElement,
    );
    fireEvent.click(createButton());
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createLocalPr).toHaveBeenCalledTimes(2);
    await act(async () => b.resolve({ ...created, id: "pr-2" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the newer running draft held on a plain reopen after the older settled (T2)", async () => {
    const { a, b } = await twoCreatesRunning();
    act(() => control.setOpen(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => a.resolve(created));
    reopen();
    expect(await screen.findByLabelText("Title")).toHaveValue("B title");
    expectHeld(ACT_PENDING_REASON);
    await act(async () => b.resolve({ ...created, id: "pr-2" }));
  });

  it("keeps the newer draft held when the older create fails, and re-arms on its own failure (T3)", async () => {
    const { user, a, b } = await twoCreatesRunning();
    await act(async () => a.reject(new Error("refused")));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expectHeld(ACT_PENDING_REASON);
    await chord(user);
    fireEvent.submit(
      screen.getByLabelText("Title").closest("form") as HTMLFormElement,
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createLocalPr).toHaveBeenCalledTimes(2);
    await act(async () => b.reject(new Error("refused")));
    await waitFor(expectLive);
    expect(screen.getByLabelText("Title")).toHaveValue("B title");
    await chord(user);
    await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(3));
  });

  it("closes once when the newer create settles first, and the older settle starts nothing (T4)", async () => {
    const { a, b } = await twoCreatesRunning();
    await act(async () => b.resolve({ ...created, id: "pr-2" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => a.resolve(created));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(createLocalPr).toHaveBeenCalledTimes(2);
  });

  it("starts one create from two submit events in one task (T4b)", async () => {
    const user = userEvent.setup();
    renderDialog();
    const title = await fillTitle(user);
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expectLive();
    act(() => {
      fireEvent.click(createButton());
      fireEvent.submit(title.closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(createLocalPr).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createLocalPr).toHaveBeenCalledTimes(1);
  });

  describe("Create local PR: a create that fails while closed", () => {
    const NOTES_PLACEHOLDER =
      "Deliberate calls, tradeoffs, and context reviewers should ground against…";
    const notesToggle = () =>
      screen.getByRole("button", { name: "Notes for reviewers" });
    const pause = () => act(() => new Promise((r) => setTimeout(r, 20)));

    async function closeDialog() {
      act(() => control.setOpen(false));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    it("shows the failed draft again on the first reopen, and a retry creates it (T8)", async () => {
      const { user, pending } = await createThenClose(async (u) => {
        await u.type(screen.getByLabelText("Description"), "A description");
        fireEvent.click(notesToggle());
        await u.type(screen.getByPlaceholderText(NOTES_PLACEHOLDER), "A note");
      });
      await act(async () => pending.reject(new Error("refused")));
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("A title");
      expect(screen.getByLabelText("Description")).toHaveValue("A description");
      expect(screen.getByRole("combobox", { name: "Merge" })).toHaveTextContent(
        "feat",
      );
      expect(screen.getByRole("combobox", { name: "Base" })).toHaveTextContent(
        "main",
      );
      expect(notesToggle()).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(notesToggle());
      expect(screen.getByPlaceholderText(NOTES_PLACEHOLDER)).toHaveValue(
        "A note",
      );
      await waitFor(expectLive);
      await chord(user);
      await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(2));
      expect(vi.mocked(createLocalPr).mock.calls[1]?.[1]).toMatchObject({
        title: "A title",
        head: "feat",
        base: "main",
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
    });

    it("lets a requested pair consume the kept draft (T9)", async () => {
      const { user, pending } = await createThenClose();
      await act(async () => pending.reject(new Error("refused")));
      reopen({ defaultHead: "dev", defaultBase: "main" });
      const title = await screen.findByLabelText("Title");
      expect(title).toHaveValue("");
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Merge" }),
        ).toHaveTextContent("dev"),
      );
      await user.type(title, "Requested");
      await closeDialog();
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
    });

    it("never carries the kept draft across repositories (T10)", async () => {
      const { pending } = await createThenClose();
      await act(async () => pending.reject(new Error("refused")));
      const other = "C:/other";
      act(() => {
        useUiStore.setState({ repoPath: other });
        control.setRepo(other);
      });
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
      await closeDialog();
      act(() => {
        useUiStore.setState({ repoPath: REPO });
        control.setRepo(REPO);
      });
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
    });

    it("keeps nothing for a failure seen while open (T11a)", async () => {
      const { pending } = await createThenClose();
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("A title");
      await act(async () => pending.reject(new Error("refused")));
      await waitFor(expectLive);
      await closeDialog();
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
    });

    it("keeps nothing when a step after the create throws (T11b)", async () => {
      vi.mocked(triggerAutomations).mockImplementationOnce(() => {
        throw new Error("automation boom");
      });
      const { pending } = await createThenClose();
      await act(async () => pending.resolve(created));
      await pause();
      expect(triggerAutomations).toHaveBeenCalled();
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
    });

    it("keeps nothing when a reseed replaced the draft before the failure (T11c)", async () => {
      const { user, pending } = await createThenClose();
      reopen({ defaultHead: "dev", defaultBase: "main" });
      const title = await screen.findByLabelText("Title");
      expect(title).toHaveValue("");
      await user.type(title, "Second");
      await closeDialog();
      await act(async () => pending.reject(new Error("refused")));
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
    });
  });

  describe("Create local PR: a kept draft whose head is archived", () => {
    beforeEach(() => {
      vi.mocked(gitBranches).mockResolvedValue(
        ["main", "feat", "dev", "old"].map(
          (name) =>
            ({
              name,
              isCurrent: name === "feat",
              archived: name === "old",
            }) as Branch,
        ),
      );
    });

    const merge = () => screen.getByRole("combobox", { name: "Merge" });
    const pause = () => act(() => new Promise((r) => setTimeout(r, 20)));

    /** The Merge picker's option names, read from its open popup and closed again. */
    async function mergeOptions(user: ReturnType<typeof userEvent.setup>) {
      await user.click(merge());
      const listbox = await screen.findByRole("listbox");
      const names = within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent ?? "");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
      return names;
    }

    /** Opens on the archived head by request, submits, and closes mid-create. */
    async function createOldThenClose() {
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
      await screen.findByLabelText("Title");
      act(() => control.setOpen(false));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      reopen({ defaultHead: "old", defaultBase: "main" });
      await waitFor(() => expect(merge()).toHaveTextContent("old"));
      const title = await fillTitle(user);
      expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
      expect(await mergeOptions(user)).toContainEqual(
        expect.stringContaining("old"),
      );
      title.focus();
      await user.keyboard("{Control>}{Enter}{/Control}");
      await waitFor(() => expect(createLocalPr).toHaveBeenCalledTimes(1));
      expect(vi.mocked(createLocalPr).mock.calls[0]?.[1]).toMatchObject({
        head: "old",
      });
      act(() => control.setOpen(false));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      return { user, pending };
    }

    it("still lists the kept head when the failed draft reopens", async () => {
      const { user, pending } = await createOldThenClose();
      await act(async () => pending.reject(new Error("refused")));
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("A title");
      expect(merge()).toHaveTextContent("old");
      expect(await mergeOptions(user)).toContainEqual(
        expect.stringContaining("old"),
      );
    });

    it("still lists the kept head when a reopen finds the create running", async () => {
      const { user, pending } = await createOldThenClose();
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("A title");
      expect(merge()).toHaveTextContent("old");
      expect(await mergeOptions(user)).toContainEqual(
        expect.stringContaining("old"),
      );
      await act(async () => pending.reject(new Error("refused")));
      await pause();
    });

    /** Whether any open render since `from` kept the archived head listed. */
    const keptOldSince = (from: number) =>
      pickerCommits
        .slice(from)
        .some(({ open, keep }) => open && keep.includes("old"));

    it("lists the kept head in no render of a later normal open", async () => {
      const { pending } = await createOldThenClose();
      await act(async () => pending.reject(new Error("refused")));
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("A title");
      act(() => control.setOpen(false));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const from = pickerCommits.length;
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
      await pause();
      expect(keptOldSince(from)).toBe(false);
    });

    it("lists the kept head in no render of a requested reopen over the create, nor of the open after it", async () => {
      const { pending } = await createOldThenClose();
      const from = pickerCommits.length;
      reopen({ defaultHead: "dev", defaultBase: "main" });
      await waitFor(() => expect(merge()).toHaveTextContent("dev"));
      act(() => control.setOpen(false));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => pending.reject(new Error("refused")));
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
      await pause();
      expect(keptOldSince(from)).toBe(false);
    });

    it("lists the kept head in no render of the open after a create that landed", async () => {
      const { pending } = await createOldThenClose();
      await act(async () => pending.resolve({ ...created, head: "old" }));
      await pause();
      const from = pickerCommits.length;
      reopen();
      expect(await screen.findByLabelText("Title")).toHaveValue("");
      await pause();
      expect(keptOldSince(from)).toBe(false);
    });
  });
});
