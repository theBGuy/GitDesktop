import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreatePrDialog,
  type CreatePrPreset,
} from "@/features/pulls/CreatePrDialog";
import {
  forgeStatus,
  gitBranchAhead,
  gitBranchDiff,
  gitBranches,
  gitRemoteAdd,
  gitRemoteBranches,
  gitRemotes,
} from "@/lib/git/api";
import type {
  Branch,
  CommitSummary,
  ForgeStatus,
  RemoteBranch,
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
  gitRemoteAdd: vi.fn(),
  forgePrCreate,
  gitFetchRemote: vi.fn(async () => undefined),
  gitRemoteDefaultBranch: vi.fn(async () => "main"),
  forgePrsForBranch: vi.fn(async () => []),
  readRepoInstructions: vi.fn(async () => null),
  // Shell reads the dialog makes that these cases never need answered.
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitDefaultBranch: vi.fn(() => new Promise(() => undefined)),
  gitRemoteUrl: vi.fn(() => new Promise(() => undefined)),
  forgeRepoLabels: vi.fn(() => new Promise(() => undefined)),
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
vi.mock("@/lib/stores/pr-create-handoff", () => ({
  armPrCreateHandOff: vi.fn(),
}));

const REPO = "C:/repo";
const ORIGIN_REF = "refs/remotes/origin/feature-x";

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

/** Local branches: no `feature-x`, so the origin preset's base exists only as
 *  a remote-tracking ref. */
const LOCALS = ["main", "feat", "dev"].map(
  (name) => ({ name, isCurrent: name === "feat", archived: false }) as Branch,
);

const REMOTE_BRANCHES: RemoteBranch[] = [
  { name: "main", remote: "upstream", lastCommitDate: "" },
  { name: "release", remote: "upstream", lastCommitDate: "" },
  { name: "feature-x", remote: "origin", lastCommitDate: "" },
] as RemoteBranch[];

const ORIGIN_PRESET: CreatePrPreset = {
  target: "origin",
  base: "feature-x",
  baseRef: ORIGIN_REF,
};

/** A GitHub fork with the upstream remote: the "Create in" picker shows. */
function forkWithUpstream() {
  vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
}

function renderDialog(props: {
  preset?: CreatePrPreset;
  defaultBase?: string;
  defaultHead?: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <CreatePrDialog
        repoPath={REPO}
        defaultHead={props.defaultHead ?? "feat"}
        defaultBase={props.defaultBase}
        preset={props.preset}
        open={open}
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return {
    close: () => view.rerender(ui(false)),
    reopen: () => view.rerender(ui(true)),
  };
}

const baseField = () => screen.getByRole("combobox", { name: "Base" });
const targetButton = (name: "Parent" | "Fork") =>
  screen.getByRole("button", { name });

/** The base each ahead read asked for, in call order. */
const aheadBases = () =>
  vi.mocked(gitBranchAhead).mock.calls.map(([, base]) => base);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ repoPath: REPO });
  // A create in one case leaves its lane behind; every case starts with none.
  usePrCreateStore.setState({ byRepo: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitBranches).mockResolvedValue(LOCALS);
  vi.mocked(gitRemoteBranches).mockResolvedValue(REMOTE_BRANCHES);
  vi.mocked(gitBranchAhead).mockResolvedValue([COMMIT]);
  vi.mocked(gitBranchDiff).mockReturnValue(new Promise(() => undefined));
  // No forge answer and only origin by default: the lens gate stays off.
  vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("CreatePrDialog without a preset", () => {
  // The byte-for-byte control: the ahead read and the AI diff take today's
  // local-branch forms.
  it("reads refs/heads and diffs the bare base", async () => {
    const user = userEvent.setup();
    renderDialog({ defaultBase: "main" });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(gitBranchAhead).toHaveBeenCalledWith(
      REPO,
      "refs/heads/main",
      "refs/heads/feat",
    );
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gitBranchDiff).mock.calls[0].slice(0, 3)).toEqual([
      REPO,
      "main",
      "feat",
    ]);
  });

  it("opens on Parent on a fork with the upstream remote", async () => {
    forkWithUpstream();
    renderDialog({ defaultBase: "dev" });
    await waitFor(() =>
      expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true"),
    );
    // The parent reconcile swaps in the parent's default branch.
    await waitFor(() =>
      expect(aheadBases()).toContain("refs/remotes/upstream/main"),
    );
  });
});

describe("CreatePrDialog with an origin preset", () => {
  it("reads and diffs the remote-tracking base, and creates on the bare name", async () => {
    const user = userEvent.setup();
    renderDialog({ preset: ORIGIN_PRESET, defaultBase: "feature-x" });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(gitBranchAhead).toHaveBeenCalledWith(
      REPO,
      ORIGIN_REF,
      "refs/heads/feat",
    );
    expect(aheadBases()).not.toContain("refs/heads/feature-x");
    // Offered and selected though no local branch carries the name, and the
    // field holds the bare name.
    expect(baseField()).toHaveTextContent("feature-x");
    expect(baseField().textContent).not.toMatch(/refs\//);

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gitBranchDiff).mock.calls[0].slice(0, 3)).toEqual([
      REPO,
      ORIGIN_REF,
      "feat",
    ]);
  });

  it("keeps a base no local branch carries without a default to fall back on", async () => {
    renderDialog({ preset: ORIGIN_PRESET });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(baseField()).toHaveTextContent("feature-x");
    expect(aheadBases()).toEqual([ORIGIN_REF]);
  });

  it("submits the bare base", async () => {
    const user = userEvent.setup();
    renderDialog({ preset: ORIGIN_PRESET, defaultBase: "feature-x" });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "A title");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    const [repo, base, head] = forgePrCreate.mock.calls[0] as unknown[];
    expect([repo, base, head]).toEqual([REPO, "feature-x", "feat"]);
  });

  it("opens on Fork, drops the ref when the base moves, and takes it back on return", async () => {
    forkWithUpstream();
    const user = userEvent.setup();
    renderDialog({ preset: ORIGIN_PRESET, defaultBase: "feature-x" });
    await waitFor(() =>
      expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() => expect(aheadBases()).toContain(ORIGIN_REF));

    await user.click(baseField());
    await user.click(await screen.findByRole("option", { name: "dev" }));
    await waitFor(() => expect(aheadBases()).toContain("refs/heads/dev"));

    await user.click(baseField());
    await user.click(await screen.findByRole("option", { name: "feature-x" }));
    await waitFor(() => expect(aheadBases().at(-1)).toBe(ORIGIN_REF));
  });

  it("keeps the ref on its own target only", async () => {
    forkWithUpstream();
    const user = userEvent.setup();
    renderDialog({ preset: ORIGIN_PRESET, defaultBase: "feature-x" });
    await waitFor(() =>
      expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() => expect(aheadBases()).toContain(ORIGIN_REF));
    const before = aheadBases().length;
    await user.click(targetButton("Parent"));
    // feature-x isn't a parent branch, so the parent reconcile re-seeds.
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    expect(aheadBases().slice(before)).not.toContain(ORIGIN_REF);
    expect(baseField()).toHaveTextContent("main");
  });

  it("is a distinct ref from a same-named head", async () => {
    renderDialog({
      preset: {
        target: "origin",
        base: "feat",
        baseRef: "refs/remotes/origin/feat",
      },
      defaultBase: "feat",
    });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(gitBranchAhead).toHaveBeenCalledWith(
      REPO,
      "refs/remotes/origin/feat",
      "refs/heads/feat",
    );
    expect(screen.queryByText("Pick two different branches.")).toBeNull();
  });
});

describe("CreatePrDialog with an upstream preset", () => {
  it("opens on Parent with the preset's base", async () => {
    forkWithUpstream();
    renderDialog({
      preset: { target: "upstream", base: "release" },
      defaultBase: "release",
    });
    await waitFor(() =>
      expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(aheadBases()).toContain("refs/remotes/upstream/release"),
    );
    expect(aheadBases()).not.toContain("refs/remotes/upstream/main");
    expect(baseField()).toHaveTextContent("release");
  });
});

describe("CreatePrDialog preset over a kept draft", () => {
  it("applies the preset's target and base while the title stays", async () => {
    forkWithUpstream();
    const user = userEvent.setup();
    const dialog = renderDialog({
      preset: ORIGIN_PRESET,
      defaultBase: "feature-x",
    });
    await waitFor(() =>
      expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() => expect(aheadBases()).toContain(ORIGIN_REF));
    await user.type(screen.getByLabelText("Title"), "Kept title");
    await user.click(targetButton("Parent"));
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    // A generation still running keeps the draft across the close.
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledTimes(1));
    dialog.close();
    dialog.reopen();

    await waitFor(() =>
      expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(baseField()).toHaveTextContent("feature-x");
    await waitFor(() => expect(aheadBases().at(-1)).toBe(ORIGIN_REF));
    expect(screen.getByLabelText("Title")).toHaveValue("Kept title");
  });
});

describe("Add upstream remote offer", () => {
  const FORK_SETTINGS = {
    ...DEFAULT_SETTINGS,
    recentRepos: [
      {
        path: REPO,
        name: "repo",
        isFork: true,
        forkParent: "octo/project",
      },
    ],
  } as typeof DEFAULT_SETTINGS;

  it("offers the remote on a fork without it and adds it from the parent slug", async () => {
    vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    vi.mocked(gitRemoteAdd).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderDialog({ defaultBase: "main" });
    const add = await screen.findByRole("button", {
      name: "Add upstream remote",
    });
    expect(screen.getByText(/This repository is a fork of/).textContent).toBe(
      "This repository is a fork of octo/project. Add an upstream remote to open pull requests against octo/project.",
    );
    await user.click(add);
    expect(gitRemoteAdd).toHaveBeenCalledWith(
      REPO,
      "upstream",
      "https://github.com/octo/project.git",
    );
  });

  it("offers nothing to a signed-out fork that already has the remote", async () => {
    vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue({
      ...GITHUB,
      authenticated: false,
    });
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    renderDialog({ defaultBase: "main" });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Add upstream remote" }),
    ).toBeNull();
  });
});
