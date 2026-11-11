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
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreatePrDialog,
  type CreatePrPreset,
} from "@/features/pulls/CreatePrDialog";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import {
  forgeStatus,
  gitBranchAhead,
  gitBranchDiff,
  gitBranches,
  gitFetchRemote,
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
  // A failed create's notification checks its checkout still exists.
  pathIsDir: vi.fn(async () => true),
  // Shell reads the dialog makes that these cases never need answered.
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitDefaultBranch: vi.fn(() => new Promise(() => undefined)),
  gitRemoteUrl: vi.fn(() => new Promise(() => undefined)),
  forgeRepoLabels: vi.fn(() => new Promise(() => undefined)),
  forgeRepoWriteAccess: vi.fn(() => new Promise(() => undefined)),
}));

// The attachments gate reads the CLI health probe; these cases never attach.
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
// A failed create's notification keys its mute on the repo's identity.
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
  const ui = (
    open: boolean,
    opener: { preset?: CreatePrPreset; defaultBase?: string } = props,
  ) => (
    <QueryClientProvider client={client}>
      <CreatePrDialog
        repoPath={REPO}
        defaultHead={props.defaultHead ?? "feat"}
        defaultBase={opener.defaultBase}
        preset={opener.preset}
        open={open}
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return {
    client,
    close: () => view.rerender(ui(false)),
    reopen: () => view.rerender(ui(true)),
    /** Reopens with the props Compare passes for `preset`: a parent preset
     *  carries no `defaultBase`. */
    reopenWith: (preset: CreatePrPreset | undefined, defaultBase?: string) =>
      view.rerender(ui(true, { preset, defaultBase })),
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

describe("CreatePrDialog preset under a lens-gate flip", () => {
  const UPSTREAM_REF = "refs/remotes/upstream/release";

  it("drops the parent ref once the gate turns off", async () => {
    forkWithUpstream();
    const user = userEvent.setup();
    const dialog = renderDialog({
      preset: { target: "upstream", base: "release", baseRef: UPSTREAM_REF },
    });
    await waitFor(() => expect(aheadBases()).toContain(UPSTREAM_REF));
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    await act(() =>
      dialog.client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    // The fork reconcile reseeds: release is no local branch.
    await waitFor(() => expect(aheadBases().at(-1)).toBe("refs/heads/main"));
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gitBranchDiff).mock.calls[0][1]).not.toBe(UPSTREAM_REF);
  });
});

describe("CreatePrDialog preset base row", () => {
  it("keeps the same-named local branch's chip off the remote row only", async () => {
    vi.mocked(gitBranches).mockResolvedValue(
      LOCALS.map((b) => (b.name === "main" ? { ...b, archived: true } : b)),
    );
    const user = userEvent.setup();
    renderDialog({
      preset: {
        target: "origin",
        base: "main",
        baseRef: "refs/remotes/origin/main",
      },
      defaultBase: "main",
    });
    await waitFor(() =>
      expect(aheadBases()).toContain("refs/remotes/origin/main"),
    );
    await user.click(baseField());
    const baseRow = await screen.findByRole("option", { name: /^main/ });
    expect(baseRow).not.toHaveTextContent("archived");
    await user.keyboard("{Escape}");
    // Control: the head picker lists local branches and keeps the chip.
    await user.click(screen.getByRole("combobox", { name: "Merge" }));
    expect(
      await screen.findByRole("option", { name: /^main/ }),
    ).toHaveTextContent("archived");
  });
});

describe("CreatePrDialog reopen over a running create", () => {
  it("keeps the submitted target and base when another preset reopens it", async () => {
    forkWithUpstream();
    let finish!: (v: { number: number; url: string }) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    const dialog = renderDialog({
      preset: ORIGIN_PRESET,
      defaultBase: "feature-x",
    });
    await waitFor(() =>
      expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() => expect(aheadBases()).toContain(ORIGIN_REF));
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    dialog.close();
    dialog.reopenWith({
      target: "upstream",
      base: "release",
      baseRef: "refs/remotes/upstream/release",
    });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true");
    expect(baseField()).toHaveTextContent("feature-x");
    await act(async () =>
      finish({ number: 7, url: "https://github.com/me/project/pull/7" }),
    );
  });

  it("holds a running create's base while the lens gate drops its target", async () => {
    forkWithUpstream();
    let finish!: (v: { number: number; url: string }) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    const dialog = renderDialog({
      preset: {
        target: "upstream",
        base: "release",
        baseRef: "refs/remotes/upstream/release",
      },
    });
    await waitFor(() =>
      expect(aheadBases()).toContain("refs/remotes/upstream/release"),
    );
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    // The gate settles off mid-create: release is no local branch. The dialog
    // keeps showing the parent target the create captured.
    vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
    await act(() =>
      dialog.client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const route = screen.getByText(
      (_, el) => el?.tagName === "P" && /^feat →/.test(el.textContent ?? ""),
    );
    expect(route).toHaveTextContent("feat → upstream/release");
    expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true");
    await act(async () =>
      finish({ number: 7, url: "https://github.com/me/project/pull/7" }),
    );
  });

  it("shows the fork a running create targets while the gate turns on", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    const dialog = renderDialog({ defaultBase: "main" });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parent" })).toBeNull();
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    // Upstream lands elsewhere mid-create: the live gate turns on.
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    await act(() =>
      dialog.client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole("button", { name: "Parent" })).toBeNull();
    const route = screen.getByText(
      (_, el) => el?.tagName === "P" && /^feat →/.test(el.textContent ?? ""),
    );
    expect(route).toHaveTextContent("feat → main");
    expect(route.textContent).not.toMatch(/upstream\//);
    expect(aheadBases()).not.toContain("refs/remotes/upstream/main");
    // Settled, the dialog follows the live gate.
    await act(async () => fail({ message: "No commits between" }));
    await waitFor(() =>
      expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("drops the last preset when a kept draft reopens without one", async () => {
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    const dialog = renderDialog({
      preset: ORIGIN_PRESET,
      defaultBase: "feature-x",
    });
    await waitFor(() => expect(aheadBases()).toContain(ORIGIN_REF));
    await user.type(screen.getByLabelText("Title"), "Kept");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    dialog.close();
    await act(async () => fail({ message: "No commits between" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    // A local pick's opener: no preset, its branch as the default base.
    dialog.reopenWith(undefined, "dev");
    await waitFor(() => expect(baseField()).toHaveTextContent("dev"));
    expect(screen.getByLabelText("Title")).toHaveValue("Kept");
    await waitFor(() => expect(aheadBases().at(-1)).toBe("refs/heads/dev"));
  });

  /** Fails a create from `opener`, then reopens the kept draft with no preset
   *  and `reopenBase` as the default base. */
  async function failThenReopenLocal(
    opener: { preset?: CreatePrPreset; defaultBase: string },
    reopenBase: string | undefined,
  ) {
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    const dialog = renderDialog(opener);
    await screen.findByText("1 commit to merge.");
    await user.type(screen.getByLabelText("Title"), "Kept");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    dialog.close();
    await act(async () => fail({ message: "No commits between" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    dialog.reopenWith(undefined, reopenBase);
    return user;
  }

  /** Resubmits the kept draft and returns the base the second create sent. */
  async function resubmittedBase(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create pull request" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(2));
    return (forgePrCreate.mock.calls[1] as unknown[])[1];
  }

  it("moves a kept draft's locally named remote base to a local pick's base", async () => {
    const user = await failThenReopenLocal(
      {
        preset: {
          target: "origin",
          base: "main",
          baseRef: "refs/remotes/origin/main",
        },
        defaultBase: "main",
      },
      "dev",
    );
    await waitFor(() => expect(baseField()).toHaveTextContent("dev"));
    await waitFor(() => expect(aheadBases().at(-1)).toBe("refs/heads/dev"));
    expect(screen.getByLabelText("Title")).toHaveValue("Kept");
    expect(await resubmittedBase(user)).toBe("dev");
  });

  it("moves a kept draft from one local pick's base to the next", async () => {
    const user = await failThenReopenLocal({ defaultBase: "main" }, "dev");
    await waitFor(() => expect(baseField()).toHaveTextContent("dev"));
    await waitFor(() => expect(aheadBases().at(-1)).toBe("refs/heads/dev"));
    expect(screen.getByLabelText("Title")).toHaveValue("Kept");
    expect(await resubmittedBase(user)).toBe("dev");
  });

  it("returns a kept draft to the parent target a local pick opens on", async () => {
    forkWithUpstream();
    await failThenReopenLocal(
      { preset: ORIGIN_PRESET, defaultBase: "feature-x" },
      "dev",
    );
    await waitFor(() =>
      expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true"),
    );
    // The parent reconcile swaps in the parent's default branch, as on a
    // fresh open.
    await waitFor(() =>
      expect(aheadBases().at(-1)).toBe("refs/remotes/upstream/main"),
    );
    expect(screen.getByLabelText("Title")).toHaveValue("Kept");
  });

  it("keeps a kept draft's base when the pull requests list reopens it", async () => {
    // The list's opener passes neither a preset nor a default base; a fresh
    // open there would seed main.
    const user = await failThenReopenLocal({ defaultBase: "dev" }, undefined);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(baseField()).toHaveTextContent("dev");
    expect(screen.getByLabelText("Title")).toHaveValue("Kept");
    expect(await resubmittedBase(user)).toBe("dev");
  });

  it("keeps a remote-only base through the create and its failure", async () => {
    forkWithUpstream();
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    const dialog = renderDialog({
      preset: ORIGIN_PRESET,
      defaultBase: "feature-x",
    });
    await waitFor(() => expect(aheadBases()).toContain(ORIGIN_REF));
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    dialog.close();
    dialog.reopenWith({
      target: "upstream",
      base: "release",
      baseRef: "refs/remotes/upstream/release",
    });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(baseField()).toHaveTextContent("feature-x");
    expect(aheadBases().at(-1)).toBe(ORIGIN_REF);
    await act(async () => fail({ message: "No commits between" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create pull request" }),
      ).toBeEnabled(),
    );
    expect(targetButton("Fork")).toHaveAttribute("aria-pressed", "true");
    expect(baseField()).toHaveTextContent("feature-x");
    expect(aheadBases().at(-1)).toBe(ORIGIN_REF);
  });
});

describe("CreatePrDialog frozen target", () => {
  const OTHER = "C:/other";

  /** A host whose own state owns `open`, so the create's close lands, and
   *  whose repo can move. */
  function renderHost() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let setShown!: (open: boolean) => void;
    function Host({ repoPath }: { repoPath: string }) {
      const [open, setOpen] = useState(true);
      setShown = setOpen;
      return (
        <CreatePrDialog
          repoPath={repoPath}
          defaultHead="feat"
          defaultBase="main"
          open={open}
          onOpenChange={setOpen}
        />
      );
    }
    const ui = (repoPath: string) => (
      <QueryClientProvider client={client}>
        <Host repoPath={repoPath} />
      </QueryClientProvider>
    );
    const view = render(ui(REPO));
    return {
      client,
      setOpen: (open: boolean) => act(() => setShown(open)),
      switchTo: (repo: string) => view.rerender(ui(repo)),
    };
  }

  const routeLine = () =>
    screen.getByText(
      (_, el) => el?.tagName === "P" && /^feat →/.test(el.textContent ?? ""),
    );

  it("keeps the submitted target through a successful create's close", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    let finish!: (v: { number: number; url: string }) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    const host = renderHost();
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    await act(() =>
      host.client.refetchQueries({ queryKey: ["repo", REPO, "remotes"] }),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(routeLine()).toHaveTextContent("feat → main");
    // How long the closing popup stays mounted is timing, not contract, so
    // every committed change is checked as it lands: none may paint the
    // parent target, whenever the popup unmounts.
    const painted: string[] = [];
    const paintsParent = (node: Node) =>
      /upstream\//.test(node.textContent ?? "") ||
      (node instanceof Element &&
        [
          ...(node.matches("button") ? [node] : []),
          ...node.querySelectorAll("button"),
        ].some((b) => b.textContent?.includes("Parent")));
    const scan = (records: MutationRecord[]) => {
      for (const record of records) {
        const nodes =
          record.type === "characterData"
            ? [record.target]
            : [...record.addedNodes];
        for (const node of nodes)
          if (paintsParent(node)) painted.push(node.textContent ?? "");
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    await act(async () =>
      finish({ number: 7, url: "https://github.com/me/project/pull/7" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    scan(observer.takeRecords());
    observer.disconnect();
    expect(painted).toEqual([]);
  });

  it("shows another repo its own gate while a create runs in the first", async () => {
    forkWithUpstream();
    vi.mocked(gitRemotes).mockImplementation(async (repo) =>
      repo === REPO ? ["origin", "upstream"] : ["origin"],
    );
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    const host = renderHost();
    await waitFor(() =>
      expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true"),
    );
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    await host.setOpen(false);
    useUiStore.setState({ repoPath: OTHER });
    host.switchTo(OTHER);
    await host.setOpen(true);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole("button", { name: "Parent" })).toBeNull();
    expect(gitFetchRemote).not.toHaveBeenCalledWith(OTHER, "upstream");
    await act(async () => fail({ message: "No commits between" }));
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

  it("keeps the pending add's button focusable with its reason", async () => {
    vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    let finish!: () => void;
    vi.mocked(gitRemoteAdd).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderDialog({ defaultBase: "main" });
    await user.click(
      await screen.findByRole("button", { name: "Add upstream remote" }),
    );
    const busy = await screen.findByRole("button", {
      name: "Adding upstream remote…",
    });
    expect(busy).not.toHaveAttribute("disabled");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAccessibleDescription("Adding the upstream remote");
    await act(async () => finish());
  });

  it("holds the add while a create runs, since the add would flip its target", async () => {
    vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    renderDialog({ defaultBase: "main" });
    const add = await screen.findByRole("button", {
      name: "Add upstream remote",
    });
    expect(add).not.toHaveAttribute("aria-disabled");
    await screen.findByText("1 commit to merge.");
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(add).toHaveAttribute("aria-disabled", "true"));
    expect(add).toHaveAccessibleDescription(
      "Creating the pull request — the target is locked until it finishes.",
    );
    await user.click(add);
    expect(gitRemoteAdd).not.toHaveBeenCalled();
    await act(async () => fail({ message: "No commits between" }));
    await waitFor(() => expect(add).not.toHaveAttribute("aria-disabled"));
  });

  it("shows the fork a create targets when an add started before it lands", async () => {
    vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    let added!: () => void;
    vi.mocked(gitRemoteAdd).mockReturnValue(
      new Promise<void>((resolve) => {
        added = resolve;
      }),
    );
    let fail!: (e: unknown) => void;
    forgePrCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    renderDialog({ defaultBase: "main" });
    await user.click(
      await screen.findByRole("button", { name: "Add upstream remote" }),
    );
    await waitFor(() => expect(gitRemoteAdd).toHaveBeenCalledTimes(1));
    await screen.findByText("1 commit to merge.");
    await user.type(screen.getByLabelText("Title"), "Running");
    await user.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    // The add lands mid-create: the live gate turns on.
    vi.mocked(gitRemotes).mockResolvedValue(["origin", "upstream"]);
    await act(async () => added());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole("button", { name: "Parent" })).toBeNull();
    const route = screen.getByText(
      (_, el) => el?.tagName === "P" && /^feat →/.test(el.textContent ?? ""),
    );
    expect(route).toHaveTextContent("feat → main");
    expect(route.textContent).not.toMatch(/upstream\//);
    await act(async () => fail({ message: "No commits between" }));
    await waitFor(() =>
      expect(targetButton("Parent")).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("withdraws the card when a remotes refresh fails over the cached list", async () => {
    vi.mocked(loadSettings).mockResolvedValue(FORK_SETTINGS);
    vi.mocked(forgeStatus).mockResolvedValue(GITHUB);
    const dialog = renderDialog({ defaultBase: "main" });
    await screen.findByRole("button", { name: "Add upstream remote" });
    vi.mocked(gitRemotes).mockRejectedValue(new Error("remotes boom"));
    await act(() =>
      dialog.client
        .refetchQueries({ queryKey: ["repo", REPO, "remotes"] })
        .catch(() => undefined),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Add upstream remote" }),
      ).toBeNull(),
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

describe("CreatePrDialog image attachments (T16)", () => {
  const SESSION = "c".repeat(32);

  beforeEach(() => {
    let n = 0;
    vi.mocked(attachmentStage).mockImplementation(async (session) => {
      n += 1;
      return {
        session: session ?? SESSION,
        name: `image-${n}.png`,
        mime: "image/png",
        size: 2,
        width: 1,
        height: 1,
      };
    });
    let urls = 0;
    URL.createObjectURL = vi.fn(() => {
      urls += 1;
      return `blob:create-${urls}`;
    });
    URL.revokeObjectURL = vi.fn();
  });

  const description = () =>
    screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;

  /** Opens the dialog ready to create, with `count` pasted images staged. */
  async function readyWithImages(count: number) {
    const view = renderDialog({
      preset: ORIGIN_PRESET,
      defaultBase: "feature-x",
    });
    expect(await screen.findByText("1 commit to merge.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A title" },
    });
    const files = Array.from(
      { length: count },
      () => new File([new Uint8Array([1])], "shot.png", { type: "image/png" }),
    );
    fireEvent.paste(description(), {
      clipboardData: { files, types: ["Files"], getData: () => "" },
    });
    await waitFor(() =>
      expect(description().value).toContain(`](image-${count}.png)`),
    );
    vi.mocked(attachmentDiscard).mockClear();
    return view;
  }

  const create = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Create pull request" }),
    );

  it("sends the attachments and, on a partial create, warns and discards the session", async () => {
    const warning = vi.spyOn(toast, "warning");
    const success = vi.spyOn(toast, "success");
    await readyWithImages(2);
    forgePrCreate.mockResolvedValueOnce({
      number: 7,
      url: "https://github.com/me/project/pull/7",
      failedAttachments: ["image-2.png"],
    } as never);
    create();
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    expect((forgePrCreate.mock.calls[0] as unknown[])[10]).toEqual({
      session: SESSION,
      names: ["image-1.png", "image-2.png"],
    });
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    expect(warning.mock.calls[0][0]).toBe(
      "Pull request created, but image-2.png didn't upload. Add it in a comment on the pull request.",
    );
    expect(success).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
    warning.mockRestore();
    success.mockRestore();
  });

  it("keeps the chips and every staged file when the create fails", async () => {
    await readyWithImages(1);
    forgePrCreate.mockRejectedValueOnce(new Error("push rejected"));
    create();
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create pull request" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(
      screen.getByRole("button", { name: "Remove image-1.png" }),
    ).toBeInTheDocument();
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });

  it("discards the images when a close leaves the draft to the next open's reset (S3)", async () => {
    const view = await readyWithImages(1);
    view.close();
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
    view.reopen();
    await waitFor(() => expect(description().value).toBe(""));
    expect(
      screen.queryByRole("button", { name: "Remove image-1.png" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the images through a close after a failed create, for the reopen (S3)", async () => {
    const view = await readyWithImages(1);
    forgePrCreate.mockRejectedValueOnce(new Error("push rejected"));
    create();
    await waitFor(() => expect(forgePrCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create pull request" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    view.close();
    await act(async () => undefined);
    expect(attachmentDiscard).not.toHaveBeenCalled();
    view.reopen();
    await waitFor(() =>
      expect(description().value).toContain("](image-1.png)"),
    );
    expect(
      screen.getByRole("button", { name: "Remove image-1.png" }),
    ).toBeInTheDocument();
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });
});
