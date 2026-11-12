import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { keptLocalPrReason } from "@/features/repository/keep-local-copy";
import {
  forgeStatus,
  gitBranchAhead,
  gitBranchDiff,
  gitBranches,
  gitRemoteBranches,
  gitRemotes,
} from "@/lib/git/api";
import type { Branch, CommitSummary } from "@/lib/git/types";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
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
  gitRemoteAdd: vi.fn(),
  forgePrCreate,
  gitFetchRemote: vi.fn(async () => undefined),
  gitRemoteDefaultBranch: vi.fn(async () => "main"),
  forgePrsForBranch: vi.fn(async () => []),
  readRepoInstructions: vi.fn(async () => null),
  pathIsDir: vi.fn(async () => true),
  // Shell reads the dialog makes that these cases never need answered.
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitDefaultBranch: vi.fn(() => new Promise(() => undefined)),
  gitRemoteUrl: vi.fn(() => new Promise(() => undefined)),
  forgeRepoLabels: vi.fn(() => new Promise(() => undefined)),
}));
// The attachments gate reads the CLI health probe; these cases never attach.
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => null,
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
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (repo: string) => repo,
}));
vi.mock("@/lib/automations/runner", () => ({
  triggerAutomations: vi.fn(),
}));
vi.mock("@/lib/stores/pr-create-handoff", () => ({
  armPrCreateHandOff: vi.fn(),
}));

const REPO = "C:/repo";
const C_PR = keptLocalPrReason("feat");

const COMMIT = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  subject: "feature work",
} as unknown as CommitSummary;

/** `feat` (HEAD, the default head) is marked Keep local; `dev` is not. */
const LOCALS = ["main", "feat", "dev"].map(
  (name) =>
    ({
      name,
      isCurrent: name === "feat",
      archived: false,
      keepLocal: name === "feat",
    }) as Branch,
);

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreatePrDialog
        repoPath={REPO}
        defaultHead="feat"
        defaultBase="main"
        open
        onOpenChange={() => undefined}
        host="compare"
      />
    </QueryClientProvider>,
  );
}

const createButton = () =>
  screen.getByRole("button", { name: "Create pull request" });

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  usePrCreateStore.setState({ byRepo: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBranches).mockResolvedValue(LOCALS);
  vi.mocked(gitRemoteBranches).mockResolvedValue([]);
  vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
  vi.mocked(gitBranchDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
});

afterEach(() => {
  act(() => onlineManager.setOnline(true));
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("CreatePrDialog with a kept-local head", () => {
  it("lists the head with its chip, shows the reason once, and holds Create", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();

    // The visible line is the submit's whole description, and the sentence
    // exists once in the document (no second sr-only copy in the footer).
    const line = await screen.findByText(C_PR);
    expect(line.tagName).toBe("P");
    expect(line).not.toHaveClass("sr-only");
    expect(screen.getAllByText(C_PR)).toHaveLength(1);
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
    expect(createButton()).toHaveAccessibleDescription(C_PR);
    expect(createButton().getAttribute("aria-describedby")).toBe(line.id);

    // Held for the button and for the form's native submit alike.
    await user.type(screen.getByLabelText("Title"), "A title{Enter}");
    await user.click(createButton());
    expect(forgePrCreate).not.toHaveBeenCalled();

    // Still listed in the head picker, wearing the chip.
    await user.click(screen.getByRole("combobox", { name: "Merge" }));
    expect(
      await screen.findByRole("option", { name: /^feat/ }),
    ).toHaveTextContent("kept local");
    expect(screen.getByRole("option", { name: /^dev/ })).not.toHaveTextContent(
      "kept local",
    );
  });

  it("releases the hold when another head is picked", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByText(C_PR)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Merge" }));
    await user.click(await screen.findByRole("option", { name: /^dev/ }));
    await waitFor(() => expect(screen.queryByText(C_PR)).toBeNull());
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(createButton()).not.toHaveAttribute("aria-disabled");
    expect(createButton()).not.toHaveAccessibleDescription(C_PR);

    await user.type(screen.getByLabelText("Title"), "A title");
    await user.click(createButton());
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    const [, , head] = forgePrCreate.mock.calls[0] as unknown[];
    expect(head).toBe("dev");
  });

  it("offline alone: the footer's sr-only reason describes Create", async () => {
    vi.mocked(gitBranches).mockResolvedValue(
      LOCALS.map((b) => ({ ...b, keepLocal: false })),
    );
    renderDialog();
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    act(() => onlineManager.setOnline(false));
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription(OFFLINE_WRITE_REASON),
    );
    expect(screen.queryByText(C_PR)).toBeNull();
    const reasons = screen.getAllByText(OFFLINE_WRITE_REASON);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toHaveClass("sr-only");
  });

  it("kept local and offline: the kept-local line wins and is announced once", async () => {
    renderDialog();
    expect(await screen.findByText(C_PR)).toBeInTheDocument();
    act(() => onlineManager.setOnline(false));
    // A tick for the offline flip to render, so the check reads both holds.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createButton()).toHaveAccessibleDescription(C_PR);
    expect(screen.getAllByText(C_PR)).toHaveLength(1);
    expect(screen.queryByText(OFFLINE_WRITE_REASON)).toBeNull();
  });
});
