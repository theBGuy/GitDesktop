import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
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
import { PromoteLocalPrDialog } from "@/features/pulls/PromoteLocalPrDialog";
import { presentError } from "@/lib/error-summary";
import {
  forgePrsForBranch,
  forgeStatus,
  gitBranchAhead,
  gitBranchDiff,
  gitBranches,
  gitDefaultBranch,
  gitRemotes,
  gitStatus,
} from "@/lib/git/api";
import type {
  Branch,
  CommitSummary,
  ForgeStatus,
  PrInfo,
  RepoStatus,
} from "@/lib/git/types";
import { notifyPrCreateFailed } from "@/lib/notifications/pr-create-failed";
import { type LocalPr, updateLocalPr } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { usePrCreateStore } from "@/lib/stores/pr-create";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The mocks of create-pr-defaults.test.tsx and promote-local-pr-keep-local.test.tsx.
// The create's push api is spied, never imported: only useCreatePr may name it
// (scripts/publish-hold-routes.test.mjs).
const forgePrCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchAhead: vi.fn(),
  gitBranchDiff: vi.fn(),
  gitBranches: vi.fn(),
  gitRemotes: vi.fn(),
  forgeStatus: vi.fn(),
  gitRemoteBranches: vi.fn(async () => []),
  gitStatus: vi.fn(),
  gitDefaultBranch: vi.fn(),
  forgePrCreate,
  forgePrComment: vi.fn(async () => ({ failedAttachments: [] })),
  gitRemoteDefaultBranch: vi.fn(async () => "main"),
  forgePrsForBranch: vi.fn(async () => []),
  forgeIssueList: vi.fn(() => new Promise(() => undefined)),
  readRepoInstructions: vi.fn(async () => null),
  pathIsDir: vi.fn(async () => true),
  gitRemoteUrl: vi.fn(() => new Promise(() => undefined)),
  forgeRepoLabels: vi.fn(() => new Promise(() => undefined)),
  forgeRepoWriteAccess: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (p: string) => p,
  repoIdentityStrict: async (p: string) => p,
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
  // A landed promote sets the origin lens, which persists.
  saveRepoLens: vi.fn(async () => undefined),
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
vi.mock("@/lib/automations/runner", () => ({ triggerAutomations: vi.fn() }));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  updateLocalPr: vi.fn(),
}));
// Only the record of what the notification would carry; the sentence builder
// stays real.
vi.mock("@/lib/notifications/pr-create-failed", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/notifications/pr-create-failed")
  >()),
  notifyPrCreateFailed: vi.fn(),
}));

const REPO = "C:/repo";

const REFUSAL = {
  kind: "pushUpstreamNameMismatch",
  message:
    "Push blocked — feat tracks origin/old, which has a different name. Choose where to push from the Push menu.",
  branch: "feat",
  remote: "origin",
  remoteBranch: "old",
};
const CURRENT_LINE = REFUSAL.message;
const ROW_LINE =
  "Push blocked — feat tracks origin/old, which has a different name. Choose where to push it from feat's menu in the branch list.";
const NOTE = "The pull request for feat wasn't created.";

const COMMIT = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  subject: "feature work",
} as unknown as CommitSummary;

const rows = (current: string, flagged = false) =>
  ["feat", "main"].map(
    (name) =>
      ({
        name,
        archived: false,
        keepLocal: false,
        isCurrent: name === current,
        renamedFromUpstream: flagged && name === "feat",
      }) as Branch,
  );

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  usePrCreateStore.setState({ byRepo: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
  vi.mocked(gitBranchDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  error = vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** The one toast and the one notification a refused create raised. */
async function refusalSurfaces() {
  await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(notifyPrCreateFailed).toHaveBeenCalledTimes(1));
  const [title, options] = error.mock.calls[0] as [
    string,
    { description?: string },
  ];
  const notified = vi.mocked(notifyPrCreateFailed).mock.calls[0][0];
  return {
    title,
    description: options?.description,
    notified: presentError(notified.error).summary,
  };
}

describe("CreatePrDialog over a renamed copy's refusal", () => {
  async function submit(current: string, defaultHead?: string) {
    vi.mocked(gitStatus).mockResolvedValue({
      branch: { name: current },
      entries: [],
    } as unknown as RepoStatus);
    vi.mocked(gitBranches).mockResolvedValue(rows(current));
    forgePrCreate.mockRejectedValueOnce(REFUSAL);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (open: boolean) => (
      <QueryClientProvider client={client}>
        <CreatePrDialog
          repoPath={REPO}
          defaultHead={defaultHead}
          defaultBase="main"
          open={open}
          onOpenChange={() => undefined}
          host="pull-requests"
        />
      </QueryClientProvider>
    );
    const view = render(ui(false));
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    view.rerender(ui(true));
    await settle();
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Title"), "A title");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    return refusalSurfaces();
  }

  const stillOpenWithDraft = () =>
    expect(screen.getByLabelText("Title")).toHaveValue("A title");

  it("a checked-out head gets the backend's line, toast and notification alike", async () => {
    const seen = await submit("feat");
    expect(seen).toEqual({
      title: CURRENT_LINE,
      description: NOTE,
      notified: CURRENT_LINE,
    });
    stillOpenWithDraft();
  });

  it("any other head is pointed at its row menu", async () => {
    const seen = await submit("main", "feat");
    expect(seen).toEqual({
      title: ROW_LINE,
      description: NOTE,
      notified: ROW_LINE,
    });
    stillOpenWithDraft();
  });
});

const PR: LocalPr = {
  id: "pr-1",
  title: "Feature",
  body: "",
  base: "main",
  head: "feat",
  status: "open",
  approved: false,
  labels: [],
  comments: [],
  createdAt: "2026-11-01T00:00:00Z",
};

describe("PromoteLocalPrDialog over a renamed copy's refusal", () => {
  function renderPromote(onOpenChange = vi.fn()) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PromoteLocalPrDialog
          repoPath={REPO}
          pr={PR}
          open
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>,
    );
    return onOpenChange;
  }
  const publishButton = () =>
    screen.getByRole("button", { name: /Publish to / });

  async function press() {
    const user = userEvent.setup();
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    await user.click(publishButton());
  }

  it.each([
    { variant: "checked out", current: "feat", line: CURRENT_LINE },
    { variant: "not checked out", current: "main", line: ROW_LINE },
  ])(
    "a head $variant: closes, reopens, and carries one guided sentence",
    async ({ current, line }) => {
      vi.mocked(gitBranches).mockResolvedValue(rows(current));
      vi.mocked(updateLocalPr)
        .mockImplementationOnce(async (_r, _id, mutate) => mutate(PR))
        .mockImplementationOnce(async (_r, _id, mutate) => mutate(PR));
      forgePrCreate.mockRejectedValueOnce(REFUSAL);
      useUiStore.setState({ selectedPr: { kind: "local", id: PR.id } });
      const onOpenChange = renderPromote();
      await press();
      const seen = await refusalSurfaces();
      expect(seen).toEqual({ title: line, description: NOTE, notified: line });
      // The close ran first, then the reopen put back the prior status.
      expect(updateLocalPr).toHaveBeenCalledTimes(2);
      const [, , close] = vi.mocked(updateLocalPr).mock.calls[0];
      const closed = close(PR);
      expect(closed.status).toBe("closed");
      const [, , reopen] = vi.mocked(updateLocalPr).mock.calls[1];
      const reopened = reopen(closed);
      expect(reopened.status).toBe("open");
      expect(reopened.closedAt).toBe(PR.closedAt);
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(useUiStore.getState().selectedPr).toEqual({
        kind: "local",
        id: PR.id,
      });
    },
  );

  it("the refusal, then a failed reopen: the composed toast's create half is guided", async () => {
    vi.mocked(gitBranches).mockResolvedValue(rows("main"));
    vi.mocked(updateLocalPr)
      .mockImplementationOnce(async (_r, _id, mutate) => mutate(PR))
      .mockRejectedValueOnce(new Error("reopen refused"));
    forgePrCreate.mockRejectedValueOnce(REFUSAL);
    renderPromote();
    await press();
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    const [title] = error.mock.calls[0] as [string];
    expect(title).toBe(`Couldn't create the pull request: ${ROW_LINE}`);
    await waitFor(() => expect(notifyPrCreateFailed).toHaveBeenCalledTimes(1));
    expect(
      presentError(vi.mocked(notifyPrCreateFailed).mock.calls[0][0].error)
        .summary,
    ).toBe(ROW_LINE);
  });

  it("a flagged head whose create succeeds promotes as today", async () => {
    vi.mocked(gitBranches).mockResolvedValue(rows("main", true));
    vi.mocked(updateLocalPr).mockImplementation(async (_r, _id, mutate) =>
      mutate(PR),
    );
    forgePrCreate.mockResolvedValueOnce({
      number: 12,
      url: "https://github.com/me/project/pull/12",
    });
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const onOpenChange = renderPromote();
    await press();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(forgePrCreate).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalled();
    await waitFor(() =>
      expect(useUiStore.getState().selectedPr).toEqual({
        kind: "remote",
        id: "12",
      }),
    );
  });
});

describe("CreatePrDialog names an existing request by its forge's sigil", () => {
  const status = (provider: "github" | "gitlab") =>
    ({
      provider,
      installed: true,
      authenticated: true,
      repo: "me/project",
      host: `${provider}.com`,
      login: "me",
      capabilities: {},
      implemented: { mrCreate: true, pullRequests: true },
    }) as unknown as ForgeStatus;
  const existing = {
    number: 12,
    url: "https://example.test/12",
    title: "Existing",
    isDraft: false,
    baseRefName: "main",
    crossRepository: false,
  } as unknown as PrInfo;

  async function renderOpen(provider: "github" | "gitlab") {
    vi.mocked(forgeStatus).mockResolvedValue(status(provider));
    vi.mocked(gitStatus).mockResolvedValue({
      branch: { name: "feat" },
      entries: [],
    } as unknown as RepoStatus);
    vi.mocked(gitBranches).mockResolvedValue(rows("feat"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (open: boolean) => (
      <QueryClientProvider client={client}>
        <CreatePrDialog
          repoPath={REPO}
          defaultBase="main"
          open={open}
          onOpenChange={() => undefined}
          host="pull-requests"
        />
      </QueryClientProvider>
    );
    const view = render(ui(false));
    await waitFor(() => expect(gitBranches).toHaveBeenCalled());
    await settle();
    view.rerender(ui(true));
    await settle();
  }

  it.each([
    ["gitlab", "View merge request !12"],
    ["github", "View pull request #12"],
  ] as const)("%s: the View offer reads %s", async (provider, name) => {
    vi.mocked(forgePrsForBranch).mockResolvedValue([existing]);
    await renderOpen(provider);
    expect(await screen.findByRole("button", { name })).toBeInTheDocument();
  });

  it.each([
    [
      "gitlab",
      "Create merge request",
      "A merge request for this branch already exists — !12.",
    ],
    [
      "github",
      "Create pull request",
      "A pull request for this branch already exists — #12.",
    ],
  ] as const)(
    "%s: a submit over the first probe reads %s's refusal",
    async (provider, create, line) => {
      let answer: (prs: PrInfo[]) => void = () => undefined;
      const probe = new Promise<PrInfo[]>((r) => {
        answer = r;
      });
      vi.mocked(forgePrsForBranch).mockReturnValue(probe);
      await renderOpen(provider);
      expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Title"), "A title");
      await user.click(await screen.findByRole("button", { name: create }));
      await act(async () => answer([existing]));
      await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      expect(error.mock.calls[0][0]).toBe(line);
      expect(forgePrCreate).not.toHaveBeenCalled();
    },
  );
});
