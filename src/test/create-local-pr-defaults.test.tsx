import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateLocalPrDialog } from "@/features/pulls/CreateLocalPrDialog";
import {
  BRANCH_PLACEHOLDER,
  COUNTING_COPY,
  UNCHOSEN_COPY,
} from "@/features/pulls/pr-branch-defaults";
import {
  gitBranchAhead,
  gitBranchDiff,
  gitBranches,
  gitDefaultBranch,
  gitStatus,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { Branch, CommitSummary, RepoStatus } from "@/lib/git/types";
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
  gitBranchDiff: vi.fn(),
  gitStatus: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitBranches: vi.fn(),
  // Shell reads the dialog makes that these cases never need answered.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  readRepoInstructions: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(async () => []),
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

/** A non-default branch sorts first, so "first other" and "default" differ. */
const ORDER = ["aaa-old", "feat", "main"];

const onBranch = (name: string | null) =>
  ({
    branch: name === null ? null : { name },
    entries: [],
  }) as unknown as RepoStatus;

function setRepo(opts: {
  current: string | null;
  defaultBranch: string | null;
  branches?: string[];
}) {
  vi.mocked(gitStatus).mockResolvedValue(onBranch(opts.current));
  vi.mocked(gitDefaultBranch).mockResolvedValue(opts.defaultBranch as string);
  vi.mocked(gitBranches).mockResolvedValue(
    (opts.branches ?? ORDER).map(
      (name) => ({ name, archived: false }) as Branch,
    ),
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** Mounts closed, lets the shell reads answer, then opens. */
async function openDialog(props: { defaultHead?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <CreateLocalPrDialog
        repoPath={REPO}
        defaultHead={props.defaultHead}
        open={open}
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  );
  const view = render(ui(false));
  await waitFor(() => {
    expect(gitStatus).toHaveBeenCalled();
    expect(gitDefaultBranch).toHaveBeenCalled();
    expect(gitBranches).toHaveBeenCalled();
  });
  await settle();
  view.rerender(ui(true));
  await settle();
  return client;
}

const mergeField = () => screen.getByRole("combobox", { name: "Merge" });
const baseField = () => screen.getByRole("combobox", { name: "Base" });
const titleInput = () => screen.getByLabelText("Title");
const createButton = () =>
  screen.getByRole("button", { name: /Create local PR/ });
const generateButton = () => screen.getByRole("button", { name: "Generate" });

/** The one element saying `sentence` is Create's only description. */
function expectAnnouncedOnce(sentence: string) {
  const shown = screen.getAllByText(sentence);
  expect(shown).toHaveLength(1);
  const ids = (createButton().getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  expect(ids).toEqual([shown[0].id]);
  expect(document.querySelectorAll(`[id="${ids[0]}"]`)).toHaveLength(1);
}

function expectHeld(reason: string) {
  const button = createButton();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(button).toHaveAccessibleDescription(reason);
  expect(button.parentElement).toHaveAttribute("title", reason);
}

/** Every submit path: the mod+Enter chord, Enter in Title, and the button. */
async function tryEverySubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(titleInput(), "A title");
  titleInput().focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await user.keyboard("{Enter}");
  fireEvent.click(createButton());
  await settle();
}

/** Generate and its chord hold on an unchosen side, even with an answer
 *  cached for the half-empty pair's count. */
async function expectGenerateHeld(
  user: ReturnType<typeof userEvent.setup>,
  client: QueryClient,
  cachedKey: readonly unknown[],
) {
  act(() => {
    client.setQueryData(cachedKey, [COMMIT]);
  });
  await settle();
  expect(generateButton()).toBeDisabled();
  titleInput().focus();
  await user.keyboard("{Control>}g{/Control}");
  fireEvent.click(generateButton());
  await settle();
  expect(gitBranchDiff).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
  vi.mocked(gitBranchDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(createLocalPr).mockImplementation(async (_repo, input) => ({
    id: "pr-1",
    ...input,
    status: "open",
    approved: false,
    labels: [],
    comments: [],
    createdAt: new Date().toISOString(),
  }));
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("New local pull request opened with nothing handed in", () => {
  it("leaves Merge unchosen on the default branch and holds every submit (M1)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    await openDialog();
    expect(baseField()).toHaveTextContent("main");
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expectAnnouncedOnce(UNCHOSEN_COPY.head);
    expect(screen.queryByText(/\d+ commits? to merge\./)).toBeNull();
    expect(gitBranchAhead).not.toHaveBeenCalled();
    // Pins the outcome only: Merge is also the dialog's default first focus;
    // the Base-focus cases are what exercise the focus mark.
    expect(document.activeElement).toBe(mergeField());
    expectHeld(UNCHOSEN_COPY.head);
    await tryEverySubmit(user);
    expect(createLocalPr).not.toHaveBeenCalled();
  });

  it("holds Generate and its chord while Merge is unchosen (M1)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    const client = await openDialog();
    await expectGenerateHeld(
      user,
      client,
      repoKeys.branchAhead(REPO, "refs/heads/main", ""),
    );
  });

  it("starts from the current branch and the default branch elsewhere (M2)", async () => {
    setRepo({ current: "feat", defaultBranch: "main" });
    await openDialog();
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent("main");
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    // This dialog has no focus rule of its own for a full pair: the dialog's
    // default first focus, which is the Merge trigger, never Base.
    // Pins the outcome only; the Base-focus cases exercise the focus mark.
    expect(document.activeElement).not.toBe(baseField());
  });

  it("leaves Base unchosen when the default branch is unknown (M3)", async () => {
    setRepo({ current: "feat", defaultBranch: null });
    const user = userEvent.setup();
    const client = await openDialog();
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).not.toHaveTextContent("aaa-old");
    expectAnnouncedOnce(UNCHOSEN_COPY.base);
    expect(document.activeElement).toBe(baseField());
    expectHeld(UNCHOSEN_COPY.base);
    await expectGenerateHeld(
      user,
      client,
      repoKeys.branchAhead(REPO, "", "refs/heads/feat"),
    );
  });

  it("asks for Merge on a detached HEAD, never the first branch (M4)", async () => {
    setRepo({ current: null, defaultBranch: "main" });
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(mergeField()).not.toHaveTextContent("aaa-old");
    expect(baseField()).toHaveTextContent("main");
    // Pins the outcome only: Merge is also the dialog's default first focus;
    // the Base-focus cases are what exercise the focus mark.
    expect(document.activeElement).toBe(mergeField());
  });

  it("says neither the same-branch nor the counting line for an empty pair (M5)", async () => {
    setRepo({ current: null, defaultBranch: null });
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expectAnnouncedOnce(UNCHOSEN_COPY.head);
    expect(screen.queryByText("Pick two different branches.")).toBeNull();
    expect(screen.queryByText(COUNTING_COPY)).toBeNull();
    expectHeld(UNCHOSEN_COPY.head);
    // Pins the outcome only: Merge is also the dialog's default first focus;
    // the Base-focus cases are what exercise the focus mark.
    expect(document.activeElement).toBe(mergeField());
  });

  it("asks for Merge in a one-branch repository on its default (M6)", async () => {
    setRepo({ current: "main", defaultBranch: "main", branches: ["main"] });
    const user = userEvent.setup();
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).toHaveTextContent("main");
    // Pins the outcome only: Merge is also the dialog's default first focus;
    // the Base-focus cases are what exercise the focus mark.
    expect(document.activeElement).toBe(mergeField());
    expectHeld(UNCHOSEN_COPY.head);
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "main" }));
    expect(
      await screen.findByText("Pick two different branches.", {
        selector: "p",
      }),
    ).toBeInTheDocument();
  });

  it("asks for Base in a one-branch repository with no default (M7)", async () => {
    setRepo({ current: "feat", defaultBranch: null, branches: ["feat"] });
    await openDialog();
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(document.activeElement).toBe(baseField());
  });
});

describe("New local pull request focus mark", () => {
  // Closed from a sibling's effect that runs right after the seed's, so the
  // seed's pending focus mark is still unconsumed when the dialog closes.
  it("drops a pending picker focus when the dialog closes before it attaches", async () => {
    setRepo({ current: "feat", defaultBranch: null });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let openWith: (base: string | undefined) => void = () => undefined;
    function Closer({ when, close }: { when: boolean; close: () => void }) {
      useEffect(() => {
        if (when) close();
      }, [when, close]);
      return null;
    }
    function Host() {
      const [state, setState] = useState<{ open: boolean; base?: string }>({
        open: false,
      });
      openWith = (base) => setState({ open: true, base });
      return (
        <>
          <CreateLocalPrDialog
            repoPath={REPO}
            defaultBase={state.base}
            open={state.open}
            onOpenChange={() => undefined}
          />
          <Closer
            when={state.open && state.base === undefined}
            close={() => setState({ open: false })}
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    const focused: Element[] = [];
    const record = (e: FocusEvent) => focused.push(e.target as Element);
    document.addEventListener("focusin", record);
    try {
      // M3: Base unchosen, so the seed marks Base for focus.
      act(() => openWith(undefined));
      await settle();
      act(() => openWith("main"));
      await settle();
      expect(baseField()).toHaveTextContent("main");
      expect(focused).not.toContain(baseField());
      expect(document.activeElement).not.toBe(baseField());
    } finally {
      document.removeEventListener("focusin", record);
    }
  });
});

describe("New local pull request handed a head only", () => {
  it("takes the default branch as Base (M12)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    await openDialog({ defaultHead: "feat" });
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent("main");
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
  });

  it("leaves Base unchosen when the default is unknown (M13)", async () => {
    setRepo({ current: "main", defaultBranch: null });
    await openDialog({ defaultHead: "feat" });
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).not.toHaveTextContent("aaa-old");
    expect(document.activeElement).toBe(baseField());
    await waitFor(() => expectHeld(UNCHOSEN_COPY.base));
  });

  it("leaves Base unchosen when the head is the default branch (M13)", async () => {
    setRepo({ current: "feat", defaultBranch: "main" });
    await openDialog({ defaultHead: "main" });
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(document.activeElement).toBe(baseField());
  });
});
