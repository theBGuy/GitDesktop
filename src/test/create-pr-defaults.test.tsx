import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CreatePrDialog } from "@/features/pulls/CreatePrDialog";
import {
  BRANCH_PLACEHOLDER,
  defaultPrPair,
  forgeStatusArm,
  forgeUnchosenSide,
  PARENT_FETCHING_COPY,
  UNCHOSEN_COPY,
} from "@/features/pulls/pr-branch-defaults";
import { keptLocalPrReason } from "@/features/repository/keep-local-copy";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  forgeStatus,
  gitBranchAhead,
  gitBranchDiff,
  gitBranches,
  gitDefaultBranch,
  gitFetchRemote,
  gitRemoteAdd,
  gitRemoteBranches,
  gitRemoteDefaultBranch,
  gitRemotes,
  gitStatus,
} from "@/lib/git/api";
import { remotesOptions, repoKeys } from "@/lib/git/queries";
import type {
  Branch,
  CommitSummary,
  ForgeStatus,
  RemoteBranch,
  RepoStatus,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { usePrCreateStore } from "@/lib/stores/pr-create";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The create's push api is spied, never imported: only useCreatePr may name it
// (scripts/publish-hold-routes.test.mjs).
const forgePrCreate = vi.hoisted(() =>
  vi.fn(async () => ({
    number: 7,
    url: "https://github.com/me/project/pull/7",
  })),
);
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchAhead: vi.fn(),
  gitBranchDiff: vi.fn(),
  gitBranches: vi.fn(),
  gitRemotes: vi.fn(),
  forgeStatus: vi.fn(),
  gitRemoteBranches: vi.fn(),
  gitStatus: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitFetchRemote: vi.fn(),
  gitRemoteAdd: vi.fn(),
  forgePrCreate,
  forgePrComment: vi.fn(async () => ({ failedAttachments: [] })),
  gitRemoteDefaultBranch: vi.fn(async () => "main"),
  forgePrsForBranch: vi.fn(async () => []),
  readRepoInstructions: vi.fn(async () => null),
  pathIsDir: vi.fn(async () => true),
  // Shell reads the dialog makes that these cases never need answered.
  gitRemoteUrl: vi.fn(() => new Promise(() => undefined)),
  forgeRepoLabels: vi.fn(() => new Promise(() => undefined)),
  forgeRepoWriteAccess: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => null,
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(async () => []),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/jira/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/store")>()),
  getJiraLink: vi.fn(async () => null),
}));
vi.mock("@/lib/review-notes/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review-notes/store")>()),
  getReviewNote: vi.fn(async () => null),
  deleteReviewNote: vi.fn(async () => undefined),
}));
vi.mock("@/lib/automations/runner", () => ({
  triggerAutomations: vi.fn(),
}));

const REPO = "C:/repo";

const COMMIT = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  subject: "feature work",
} as unknown as CommitSummary;

const GITHUB = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "me/project",
  host: "github.com",
  login: "me",
  capabilities: {},
  implemented: {},
} as unknown as ForgeStatus;

/** Git order puts a non-default branch first, so "the first other branch"
 *  and "the default branch" never coincide. */
const ORDER = ["aaa-old", "feat", "main"];

function locals(names: string[], keepLocal: string[] = []) {
  return names.map(
    (name) =>
      ({
        name,
        archived: false,
        keepLocal: keepLocal.includes(name),
      }) as Branch,
  );
}

const onBranch = (name: string | null) =>
  ({
    branch: name === null ? null : { name },
    entries: [],
  }) as unknown as RepoStatus;

function setRepo(opts: {
  current: string | null;
  defaultBranch: string | null;
  branches?: string[];
  keepLocal?: string[];
}) {
  vi.mocked(gitStatus).mockResolvedValue(onBranch(opts.current));
  vi.mocked(gitDefaultBranch).mockResolvedValue(opts.defaultBranch as string);
  vi.mocked(gitBranches).mockResolvedValue(
    locals(opts.branches ?? ORDER, opts.keepLocal),
  );
}

/** A GitHub fork with the upstream remote: the parent target is the default. */
function forkWithUpstream() {
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** Mounts closed, lets the shell reads answer (as the shell warm-up has them
 *  by the time an opener runs), then opens with nothing handed in. */
async function openDialog(
  props: { defaultHead?: string; defaultBase?: string; tab?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let active = true;
  let isOpen = false;
  const ui = () => {
    const dialog = (
      <CreatePrDialog
        repoPath={REPO}
        defaultHead={props.defaultHead}
        defaultBase={props.defaultBase}
        open={isOpen}
        onOpenChange={() => undefined}
        host="pull-requests"
      />
    );
    return (
      <QueryClientProvider client={client}>
        {props.tab ? <TabPanel active={active}>{dialog}</TabPanel> : dialog}
      </QueryClientProvider>
    );
  };
  const view = render(ui());
  await waitFor(() => {
    expect(gitStatus).toHaveBeenCalled();
    expect(gitDefaultBranch).toHaveBeenCalled();
    expect(gitBranches).toHaveBeenCalled();
  });
  await settle();
  const rerender = () => view.rerender(ui());
  isOpen = true;
  rerender();
  await settle();
  return {
    client,
    close: () => {
      isOpen = false;
      rerender();
    },
    reopen: () => {
      isOpen = true;
      rerender();
    },
    hide: () => {
      active = false;
      rerender();
    },
    show: () => {
      active = true;
      rerender();
    },
  };
}

const mergeField = () => screen.getByRole("combobox", { name: "Merge" });
const baseField = () => screen.getByRole("combobox", { name: "Base" });
const titleInput = () => screen.getByLabelText("Title");
const createButton = () =>
  screen.getByRole("button", { name: "Create pull request" });
const generateButton = () => screen.getByRole("button", { name: "Generate" });
const aheadBases = () =>
  vi.mocked(gitBranchAhead).mock.calls.map(([, base]) => base);

/** Every submit path: the mod+Enter chord, Enter in Title, and the button. */
async function tryEverySubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(titleInput(), "A title");
  titleInput().focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await user.keyboard("{Enter}");
  fireEvent.click(createButton());
  await settle();
}

function expectHeld(reason: string) {
  const button = createButton();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(button).toHaveAccessibleDescription(reason);
  expect(button.parentElement).toHaveAttribute("title", reason);
}

/** The generate gate on an unchosen side: the button and its chord both hold,
 *  even when the count read has an answer cached for the half-empty pair. */
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
  expect(forgePrCreate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: drop the ones a test installs and
  // nothing below re-installs (setRepo sets the three shell reads per test).
  vi.mocked(gitRemoteAdd).mockReset();
  vi.mocked(gitStatus).mockReset();
  vi.mocked(gitDefaultBranch).mockReset();
  vi.mocked(gitBranches).mockReset();
  useUiStore.setState({ repoPath: REPO });
  usePrCreateStore.setState({ byRepo: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    { name: "main", remote: "upstream", lastCommitDate: "" },
    { name: "release", remote: "upstream", lastCommitDate: "" },
  ] as RemoteBranch[]);
  vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
  vi.mocked(gitBranchDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitFetchRemote).mockResolvedValue(undefined);
  vi.mocked(gitRemoteDefaultBranch).mockResolvedValue("main");
  // No forge answer and only origin by default: the lens gate stays off.
  vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("CreatePrDialog opened with nothing handed in, own repository", () => {
  it("leaves Merge unchosen on the default branch and holds every submit (M1)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    await openDialog();
    expect(baseField()).toHaveTextContent("main");
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(screen.getByText(UNCHOSEN_COPY.head)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ commits? to merge\./)).toBeNull();
    expect(gitBranchAhead).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(mergeField());
    expectHeld(UNCHOSEN_COPY.head);
    await tryEverySubmit(user);
    expect(forgePrCreate).not.toHaveBeenCalled();
  });

  it("holds Generate and its chord while Merge is unchosen (M1)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    const { client } = await openDialog();
    await expectGenerateHeld(
      user,
      client,
      repoKeys.branchAhead(REPO, "refs/heads/main", ""),
    );
    expectHeld(UNCHOSEN_COPY.head);
  });

  it("keeps focus where the pick leaves it, never on Title", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    await openDialog();
    expect(document.activeElement).toBe(mergeField());
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "feat" }));
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(mergeField()).toHaveTextContent("feat");
    expect(document.activeElement).toBe(mergeField());
  });

  it("starts from the current branch and the default branch elsewhere (M2)", async () => {
    setRepo({ current: "feat", defaultBranch: "main" });
    await openDialog();
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent("main");
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(document.activeElement).toBe(titleInput());
  });

  it("leaves Base unchosen when the default branch is unknown (M3)", async () => {
    setRepo({ current: "feat", defaultBranch: null });
    const user = userEvent.setup();
    const { client } = await openDialog();
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).not.toHaveTextContent("aaa-old");
    expect(screen.getByText(UNCHOSEN_COPY.base)).toBeInTheDocument();
    expect(document.activeElement).toBe(baseField());
    expectHeld(UNCHOSEN_COPY.base);
    await expectGenerateHeld(
      user,
      client,
      repoKeys.branchAhead(REPO, "", "refs/heads/feat"),
    );
  });

  it("leaves Merge unchosen on a detached HEAD, never the first branch (M4)", async () => {
    setRepo({ current: null, defaultBranch: "main" });
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(mergeField()).not.toHaveTextContent("aaa-old");
    expect(baseField()).toHaveTextContent("main");
    expect(document.activeElement).toBe(mergeField());
    expectHeld(UNCHOSEN_COPY.head);
  });

  it("asks for Merge first when both sides are unchosen (M5)", async () => {
    setRepo({ current: null, defaultBranch: null });
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(screen.getByText(UNCHOSEN_COPY.head)).toBeInTheDocument();
    expect(screen.queryByText(UNCHOSEN_COPY.base)).toBeNull();
    expect(document.activeElement).toBe(mergeField());
    expectHeld(UNCHOSEN_COPY.head);
  });

  it("asks for Merge in a one-branch repository on its default (M6)", async () => {
    setRepo({ current: "main", defaultBranch: "main", branches: ["main"] });
    const user = userEvent.setup();
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).toHaveTextContent("main");
    expect(document.activeElement).toBe(mergeField());
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "main" }));
    expect(
      await screen.findByText("Pick two different branches."),
    ).toBeInTheDocument();
  });

  it("asks for Base in a one-branch repository with no default (M7)", async () => {
    setRepo({ current: "feat", defaultBranch: null, branches: ["feat"] });
    await openDialog();
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(screen.getByText(UNCHOSEN_COPY.base)).toBeInTheDocument();
    expect(document.activeElement).toBe(baseField());
  });

  it("keeps an opener's pair and Title focus (M11)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    await openDialog({ defaultHead: "feat", defaultBase: "main" });
    expect(mergeField()).toHaveTextContent("feat");
    expect(baseField()).toHaveTextContent("main");
    expect(document.activeElement).toBe(titleInput());
  });
});

describe("CreatePrDialog unchosen reason ranking", () => {
  it("gives a kept-local head's reason over an unchosen Base", async () => {
    setRepo({ current: "feat", defaultBranch: null, keepLocal: ["feat"] });
    await openDialog();
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    await waitFor(() => expectHeld(keptLocalPrReason("feat")));
  });

  it("gives the unchosen sentence over offline", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    await openDialog();
    act(() => onlineManager.setOnline(false));
    await settle();
    expectHeld(UNCHOSEN_COPY.head);
  });
});

describe("CreatePrDialog picker focus", () => {
  it("never pulls focus back to Merge after a tab hide and show (A12)", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    const dialog = await openDialog({ tab: true });
    expect(document.activeElement).toBe(mergeField());
    await user.click(titleInput());
    expect(document.activeElement).toBe(titleInput());
    dialog.hide();
    await settle();
    dialog.show();
    await settle();
    expect(document.activeElement).not.toBe(mergeField());
  });

  it("lands on Title when the next open has a full pair", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const dialog = await openDialog();
    expect(document.activeElement).toBe(mergeField());
    dialog.close();
    await settle();
    setRepo({ current: "feat", defaultBranch: "main" });
    await act(() =>
      dialog.client.refetchQueries({ queryKey: ["repo", REPO, "status"] }),
    );
    dialog.reopen();
    await settle();
    expect(mergeField()).toHaveTextContent("feat");
    expect(document.activeElement).toBe(titleInput());
  });
});

describe("CreatePrDialog on the parent target", () => {
  it("keeps the default branch as Merge and takes the parent's default (M8)", async () => {
    forkWithUpstream();
    setRepo({
      current: "main",
      defaultBranch: "main",
      branches: ["main", "release"],
    });
    await openDialog();
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    expect(mergeField()).toHaveTextContent("main");
    expect(baseField()).toHaveTextContent("main");
    expect(aheadBases()).not.toContain("refs/remotes/upstream/release");
    expect(document.activeElement).toBe(titleInput());
  });

  it("shows no placeholder in Base while the parent's branches load (A7)", async () => {
    forkWithUpstream();
    vi.mocked(gitFetchRemote).mockReturnValue(new Promise(() => undefined));
    setRepo({ current: "main", defaultBranch: "main" });
    await openDialog();
    expect(
      await screen.findByText("Fetching upstream branches…"),
    ).toBeInTheDocument();
    expect(baseField()).not.toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(mergeField()).toHaveTextContent("main");
    expect(screen.queryByText(UNCHOSEN_COPY.base)).toBeNull();
  });

  // The seed leaves Base empty for the parent to fill, so no side is unchosen
  // while the empty side alone holds Generate over a cached count.
  it("holds Create, Generate and its chord on an empty Base the parent fills", async () => {
    forkWithUpstream();
    vi.mocked(gitFetchRemote).mockReturnValue(new Promise(() => undefined));
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    const { client } = await openDialog();
    expect(
      await screen.findByText("Fetching upstream branches…"),
    ).toBeInTheDocument();
    await expectGenerateHeld(
      user,
      client,
      repoKeys.branchAhead(REPO, "", "refs/heads/main"),
    );
    expect(createButton()).toBeDisabled();
    await tryEverySubmit(user);
    expect(forgePrCreate).not.toHaveBeenCalled();
  });

  it("asks for Merge on a detached HEAD (M10)", async () => {
    forkWithUpstream();
    setRepo({ current: null, defaultBranch: "main" });
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(document.activeElement).toBe(mergeField());
    await waitFor(() =>
      expect(screen.getByText(UNCHOSEN_COPY.head)).toBeInTheDocument(),
    );
  });

  it("leaves Base unchosen on the fork when no default is known (A13)", async () => {
    forkWithUpstream();
    setRepo({ current: "feat", defaultBranch: null });
    const user = userEvent.setup();
    await openDialog();
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    await user.click(baseField());
    await user.click(await screen.findByRole("option", { name: "release" }));
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/release"),
    );
    await user.click(screen.getByRole("button", { name: "Fork" }));
    expect(await screen.findByText(UNCHOSEN_COPY.base)).toBeInTheDocument();
    expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).not.toHaveTextContent("aaa-old");
    await user.click(screen.getByRole("button", { name: "Parent" }));
    await waitFor(() => expect(baseField()).toHaveTextContent("main"));
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
  });

  it("takes the default branch on the fork when it is known (A13)", async () => {
    forkWithUpstream();
    setRepo({ current: "feat", defaultBranch: "main" });
    const user = userEvent.setup();
    await openDialog();
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    await user.click(baseField());
    await user.click(await screen.findByRole("option", { name: "release" }));
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/release"),
    );
    await user.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(aheadBases().at(-1)).toBe("refs/heads/main"));
    expect(baseField()).toHaveTextContent("main");
  });
});

describe("forgeUnchosenSide", () => {
  const side = (over: Partial<Parameters<typeof forgeUnchosenSide>[0]>) =>
    forgeUnchosenSide({
      head: "feat",
      base: "main",
      baseLoading: false,
      readFailed: false,
      targetIsParent: false,
      parentBase: "",
      ...over,
    });

  it("never asks for Base while the parent's branches couldn't be read", () => {
    expect(
      side({ base: "", targetIsParent: true, readFailed: true }),
    ).toBeNull();
    expect(side({ head: "", base: "", readFailed: true })).toBe("head");
  });

  it("asks for Merge first, loading or not", () => {
    expect(side({ head: "", base: "" })).toBe("head");
    expect(side({ head: "", baseLoading: true, targetIsParent: true })).toBe(
      "head",
    );
  });

  it("asks for an empty Base on the own target", () => {
    expect(side({ base: "" })).toBe("base");
    expect(side({})).toBeNull();
  });

  it("leaves an empty Base the parent is about to fill unasked", () => {
    expect(
      side({ base: "", targetIsParent: true, baseLoading: true }),
    ).toBeNull();
    expect(
      side({ base: "", targetIsParent: true, parentBase: "main" }),
    ).toBeNull();
  });

  it("asks for Base on a parent with no resolvable base", () => {
    expect(side({ base: "", targetIsParent: true, parentBase: "" })).toBe(
      "base",
    );
  });
});

describe("defaultPrPair", () => {
  const pair = (over: Partial<Parameters<typeof defaultPrPair>[0]>) =>
    defaultPrPair({
      handedHead: undefined,
      handedBase: undefined,
      current: "main",
      defaultBranch: "main",
      parentTarget: false,
      ...over,
    });

  it("keeps the current branch as Merge when only a base is handed in", () => {
    expect(pair({ handedBase: "release" })).toEqual({
      head: "main",
      base: "release",
    });
  });

  it("leaves Merge unchosen on the default branch with nothing handed in (M1)", () => {
    expect(pair({})).toEqual({ head: "", base: "main" });
  });
});

describe("forgeStatusArm", () => {
  const arm = (over: Partial<Parameters<typeof forgeStatusArm>[0]>) =>
    forgeStatusArm({
      parentReadFailed: false,
      baseLoading: false,
      fetchError: false,
      unchosen: null,
      sideEmpty: false,
      sameBranch: false,
      counting: false,
      countFailed: false,
      ...over,
    });

  it("counts, never reads zero, on an empty side the parent is about to fill", () => {
    expect(arm({ sideEmpty: true })).toBe("counting");
    expect(arm({ sideEmpty: true, countFailed: true })).toBe("counting");
  });

  it("keeps the unchosen line over an empty side", () => {
    expect(arm({ unchosen: "base", sideEmpty: true })).toBe("unchosen");
  });

  it("ranks a failed parent read first, a refetch's pending included", () => {
    expect(
      arm({ parentReadFailed: true, baseLoading: true, unchosen: "head" }),
    ).toBe("parentReadFailed");
    expect(arm({ parentReadFailed: true, sideEmpty: true })).toBe(
      "parentReadFailed",
    );
  });

  it("ranks the upstream lines first", () => {
    expect(arm({ baseLoading: true, fetchError: true, sideEmpty: true })).toBe(
      "baseLoading",
    );
    expect(arm({ fetchError: true, unchosen: "head" })).toBe("fetchError");
  });

  it("shows the count once both sides are filled and it answered", () => {
    expect(arm({})).toBe("count");
    expect(arm({ sameBranch: true })).toBe("sameBranch");
    expect(arm({ counting: true, countFailed: true })).toBe("counting");
    expect(arm({ countFailed: true })).toBe("countFailed");
  });
});

/** Create's description ids, each carried by exactly one element. */
function describedIds() {
  const ids = (createButton().getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  }
  return ids;
}

function expectDescribedOnce(sentence: string) {
  const texts = describedIds().map(
    (id) => document.getElementById(id)?.textContent ?? "",
  );
  expect(texts.join("\n").split(sentence).length - 1).toBe(1);
}

/** The one element in the DOM saying `sentence`, which carries Create's id. */
function unchosenCarrier(sentence: string) {
  expectDescribedOnce(sentence);
  const [shown] = screen.getAllByText(sentence);
  expect(screen.getAllByText(sentence)).toHaveLength(1);
  expect(describedIds()).toContain(shown.id);
  return shown;
}

describe("CreatePrDialog unchosen reason carrier", () => {
  it("is the status line while it shows the unchosen sentence", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    await openDialog();
    const carrier = unchosenCarrier(UNCHOSEN_COPY.head);
    expect(carrier.tagName).toBe("P");
    expect(carrier).not.toHaveClass("sr-only");
  });

  it("is the footer while the upstream fetch line shows", async () => {
    forkWithUpstream();
    vi.mocked(gitFetchRemote).mockReturnValue(new Promise(() => undefined));
    setRepo({ current: null, defaultBranch: "main" });
    await openDialog();
    expect(
      await screen.findByText("Fetching upstream branches…"),
    ).toBeInTheDocument();
    // The only element saying it is the footer's, so the status line doesn't.
    const carrier = unchosenCarrier(UNCHOSEN_COPY.head);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier).toHaveClass("sr-only");
  });

  it("is the footer while the upstream fetch failure shows", async () => {
    forkWithUpstream();
    vi.mocked(gitFetchRemote).mockRejectedValue(new Error("fetch boom"));
    setRepo({ current: null, defaultBranch: "main" });
    await openDialog();
    expect(
      await screen.findByText(/Couldn't fetch upstream/),
    ).toBeInTheDocument();
    const carrier = unchosenCarrier(UNCHOSEN_COPY.head);
    expect(carrier.tagName).toBe("SPAN");
    expect(carrier).toHaveClass("sr-only");
  });
});

describe("CreatePrDialog unchosen paths across a target change", () => {
  it("gives the unchosen reason, not the draft's, when Fork leaves Base unchosen mid-generate", async () => {
    forkWithUpstream();
    setRepo({
      current: "feat",
      defaultBranch: null,
      branches: ["aaa-old", "feat"],
    });
    const user = userEvent.setup();
    await openDialog();
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    await user.click(generateButton());
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalled());
    // A running draft swaps Generate for its Cancel.
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() =>
      expect(baseField()).toHaveTextContent(BRANCH_PLACEHOLDER),
    );
    // A running draft swaps Generate for its Cancel.
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expectHeld(UNCHOSEN_COPY.base);
  });

  it("keeps Merge unchosen and takes the parent's base when Add upstream lands", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentRepos: [
        { path: REPO, name: "repo", isFork: true, forkParent: "octo/project" },
      ],
    } as typeof DEFAULT_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    vi.mocked(gitRemoteBranches).mockResolvedValue([
      { name: "release", remote: "upstream", lastCommitDate: "" },
    ] as RemoteBranch[]);
    vi.mocked(gitRemoteDefaultBranch).mockResolvedValue("release");
    vi.mocked(gitRemoteAdd).mockImplementation(async () => {
      vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    });
    setRepo({ current: "main", defaultBranch: "main" });
    const user = userEvent.setup();
    await openDialog();
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).toHaveTextContent("main");
    await user.click(
      await screen.findByRole("button", { name: "Add upstream remote" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Parent" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() => expect(baseField()).toHaveTextContent("release"));
    expect(mergeField()).toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(screen.getByText(UNCHOSEN_COPY.head)).toBeInTheDocument();
    expect(gitBranchAhead).not.toHaveBeenCalled();
    expectHeld(UNCHOSEN_COPY.head);
  });
});

describe("CreatePrDialog when the parent's branches can't be read", () => {
  const READ_LINE = /^Couldn't read upstream branches: /;
  const retryButton = () => screen.getByRole("button", { name: "Retry" });

  /** The parent read rejects while `failing.now`; a test may swap in its own
   *  pending answer through `failing.next`. */
  function failParentRead() {
    const failing: {
      now: boolean;
      next: Promise<RemoteBranch[]> | null;
    } = { now: true, next: null };
    vi.mocked(gitRemoteBranches).mockImplementation(async () => {
      if (failing.next) return failing.next;
      if (failing.now) throw new Error("refs boom");
      return [
        { name: "main", remote: "upstream", lastCommitDate: "" },
      ] as RemoteBranch[];
    });
    forkWithUpstream();
    setRepo({ current: "feat", defaultBranch: "main" });
    return failing;
  }

  it("says so with Retry, holds Create on that line once, and asks for no Base", async () => {
    const failing = failParentRead();
    let reject!: (e: unknown) => void;
    failing.next = new Promise((_, r) => {
      reject = r;
    });
    await openDialog();
    const loading = await screen.findByText(PARENT_FETCHING_COPY);
    const loadingRegion = loading.closest('[role="status"]');
    expect(loadingRegion).not.toBeNull();
    failing.next = null;
    await act(async () => reject(new Error("refs boom")));
    const line = await screen.findByText(READ_LINE);
    // Mounted before the failure reached it, so only its text changed.
    expect(line.closest('[role="status"]')).toBe(loadingRegion);
    const sentence = line.textContent ?? "";
    expect(retryButton()).toBeInTheDocument();
    expect(baseField()).not.toHaveTextContent(BRANCH_PLACEHOLDER);
    expect(baseField()).toHaveAttribute("data-disabled");
    expect(screen.queryByText(UNCHOSEN_COPY.base)).toBeNull();
    expectHeld(sentence);
    expect(screen.getAllByText(sentence)).toHaveLength(1);
    expect(describedIds()).toEqual([line.id]);
    // The sentence alone is the live region; Retry stays out of it.
    const region = line.closest('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe(sentence);
    expect(generateButton()).toBeDisabled();
  });

  /** A parent read that stays in flight until the test answers it. */
  function holdParentRead(failing: ReturnType<typeof failParentRead>) {
    let resolve!: (rows: RemoteBranch[]) => void;
    failing.now = false;
    failing.next = new Promise((r) => {
      resolve = r;
    });
    return () =>
      act(async () => {
        failing.next = null;
        resolve([
          { name: "main", remote: "upstream", lastCommitDate: "" },
        ] as RemoteBranch[]);
      });
  }

  it("leaves focus on Fork when a Retry lands after the target moved", async () => {
    const failing = failParentRead();
    const user = userEvent.setup();
    await openDialog();
    await screen.findByText(READ_LINE);
    const answer = holdParentRead(failing);
    await user.click(retryButton());
    expect(await screen.findByText(PARENT_FETCHING_COPY)).toBeInTheDocument();
    const fork = screen.getByRole("button", { name: "Fork" });
    await user.click(fork);
    await answer();
    await settle();
    expect(document.activeElement).toBe(fork);
  });

  it("leaves focus alone when the parent target goes away under a focused Retry", async () => {
    failParentRead();
    const { client } = await openDialog();
    await screen.findByText(READ_LINE);
    retryButton().focus();
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    await act(async () => {
      await client.invalidateQueries({
        queryKey: remotesOptions(REPO).queryKey,
      });
    });
    await settle();
    // The gate is off: no target picker, so no failed line and no Retry.
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).not.toBe(titleInput());
  });

  it("leaves focus in Description when a Retry lands after the user moved there", async () => {
    const failing = failParentRead();
    const user = userEvent.setup();
    await openDialog();
    await screen.findByText(READ_LINE);
    const answer = holdParentRead(failing);
    await user.click(retryButton());
    expect(await screen.findByText(PARENT_FETCHING_COPY)).toBeInTheDocument();
    const description = screen.getByRole("textbox", { name: "Description" });
    await user.click(description);
    await answer();
    await settle();
    await waitFor(() => expect(baseField()).toHaveTextContent("main"));
    expect(document.activeElement).toBe(description);
  });

  it("holds the line and Retry through a refetch Retry didn't start, then lands on Title", async () => {
    const failing = failParentRead();
    const { client } = await openDialog();
    await screen.findByText(READ_LINE);
    retryButton().focus();
    const answer = holdParentRead(failing);
    // What a local write's settle does to the repo's reads.
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["repo", REPO] });
    });
    expect(await screen.findByText(PARENT_FETCHING_COPY)).toBeInTheDocument();
    expect(retryButton()).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(retryButton());
    await answer();
    await settle();
    await waitFor(() => expect(baseField()).toHaveTextContent("main"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).toBe(titleInput());
  });

  it("fills Base on a Retry that succeeds and lands on an empty Title", async () => {
    const failing = failParentRead();
    const user = userEvent.setup();
    await openDialog();
    await screen.findByText(READ_LINE);
    failing.now = false;
    await user.click(retryButton());
    await settle();
    await waitFor(() => expect(baseField()).toHaveTextContent("main"));
    expect(screen.queryByText(READ_LINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).toBe(titleInput());
  });

  it("lands on a typed Title after a Retry that succeeds", async () => {
    const failing = failParentRead();
    const user = userEvent.setup();
    await openDialog();
    await screen.findByText(READ_LINE);
    await user.type(titleInput(), "A title");
    failing.now = false;
    await user.click(retryButton());
    await settle();
    await waitFor(() => expect(baseField()).toHaveTextContent("main"));
    expect(document.activeElement).toBe(titleInput());
    expect(titleInput()).toHaveValue("A title");
  });

  it("keeps focus on a held Retry while it runs and after it fails again", async () => {
    const failing = failParentRead();
    const user = userEvent.setup();
    await openDialog();
    await screen.findByText(READ_LINE);
    let reject!: (e: unknown) => void;
    failing.next = new Promise((_, r) => {
      reject = r;
    });
    await user.click(retryButton());
    expect(await screen.findByText(PARENT_FETCHING_COPY)).toBeInTheDocument();
    expect(retryButton()).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(retryButton());
    expectHeld(PARENT_FETCHING_COPY);
    expect(screen.getAllByText(PARENT_FETCHING_COPY)).toHaveLength(1);
    failing.next = null;
    await act(async () => reject(new Error("refs boom again")));
    expect(await screen.findByText(READ_LINE)).toHaveTextContent(
      "refs boom again",
    );
    await waitFor(() =>
      expect(retryButton()).not.toHaveAttribute("aria-disabled"),
    );
    expect(document.activeElement).toBe(retryButton());
  });
});

describe("CreatePrDialog Generate title", () => {
  const PLAIN = "Generate the title and description with AI";

  it("offers no shortcut while a side is unchosen", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const { client } = await openDialog();
    // A cached count for the half-empty pair: nothing to merge can't hold it.
    act(() => {
      client.setQueryData(repoKeys.branchAhead(REPO, "refs/heads/main", ""), [
        COMMIT,
      ]);
    });
    await settle();
    expect(generateButton()).toHaveAttribute("title", PLAIN);
  });

  it("offers the shortcut once both sides are chosen", async () => {
    setRepo({ current: "feat", defaultBranch: "main" });
    await openDialog();
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(generateButton().getAttribute("title")).not.toBe(PLAIN);
    expect(generateButton().getAttribute("title")).toMatch(/^Generate/);
  });
});

describe("CreatePrDialog focus mark", () => {
  // Closed from a sibling's effect that runs right after the seed's, so the
  // seed's pending focus mark is still unconsumed when the dialog closes.
  it("drops a pending picker focus when the dialog closes before it attaches", async () => {
    setRepo({ current: "main", defaultBranch: "main" });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let openWith: (head: string | undefined) => void = () => undefined;
    function Closer({ when, close }: { when: boolean; close: () => void }) {
      useEffect(() => {
        if (when) close();
      }, [when, close]);
      return null;
    }
    function Host() {
      const [state, setState] = useState<{ open: boolean; head?: string }>({
        open: false,
      });
      openWith = (head) => setState({ open: true, head });
      return (
        <>
          <CreatePrDialog
            repoPath={REPO}
            defaultHead={state.head}
            open={state.open}
            onOpenChange={() => undefined}
            host="pull-requests"
          />
          <Closer
            when={state.open && state.head === undefined}
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
    await waitFor(() => expect(gitDefaultBranch).toHaveBeenCalled());
    await settle();
    const focused: Element[] = [];
    const record = (e: FocusEvent) => focused.push(e.target as Element);
    document.addEventListener("focusin", record);
    try {
      // M1: Merge unchosen, so the seed marks Merge for focus.
      act(() => openWith(undefined));
      await settle();
      act(() => openWith("feat"));
      await settle();
      expect(mergeField()).toHaveTextContent("feat");
      expect(document.activeElement).toBe(titleInput());
      expect(focused).not.toContain(mergeField());
    } finally {
      document.removeEventListener("focusin", record);
    }
  });
});
