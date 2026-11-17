// Negative controls (run once, reverted): falling through the
// `already-pushed` arm to the plain line reds shapes A, C and J; feeding
// `agreed: true` unconditionally reds shape F.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditDatesDialog,
  type EditDatesTarget,
} from "@/features/history/EditDatesDialog";
import {
  gitAmendCommitDates,
  gitCommitDetails,
  gitCommitRecordsParent,
  gitLog,
  gitOpState,
  gitStatus,
  gitUnpushedCount,
  type UnpushedCount,
} from "@/lib/git/api";
import type { CommitDetails, CommitSummary, RepoStatus } from "@/lib/git/types";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitRecordsParent: vi.fn(),
  gitLog: vi.fn(),
  gitOpState: vi.fn(),
  gitAmendCommitDates: vi.fn(),
  gitUnpushedCount: vi.fn(),
}));

vi.mock("@/lib/branch-rules/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/queries")>()),
  useEffectiveBranchRules: () => ({}),
  useEffectiveBranchRulesSettling: () => false,
}));

vi.mock("@/lib/branch-rules/match", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/match")>()),
  isForcePushBlocked: () => false,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
  Toaster: () => null,
}));

const REPO = "/repo-a";
const HASH = "abcdef0123".repeat(4);
const OTHER = "0123456789".repeat(4);

const PLAIN = "Rewrites this commit; its id changes.";
const PUBLISHED =
  "This commit is already on a remote branch. Changing its dates rewrites it on this branch only: the remote branch keeps the original, and the two will differ.";
const UNCHECKED = "Couldn't check whether a remote branch has this commit.";

const status = (over: Partial<NonNullable<RepoStatus["branch"]>> = {}) =>
  ({
    branch: {
      name: "topic",
      detached: false,
      oid: HASH,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      upstreamRemote: null,
      upstreamBranch: null,
      pushNameMismatch: false,
      upstreamIsRemoteDefault: false,
      pushRemote: null,
      pushBranch: null,
      ...over,
    },
    entries: [],
  }) as unknown as RepoStatus;

const details: CommitDetails = {
  hash: HASH,
  subject: "Add the thing",
  body: "",
  author: "Ann",
  authorEmail: "ann@example.com",
  date: "2026-11-07T23:58:04+01:00",
  committerDate: "2026-11-07T23:58:04+01:00",
};

const logRow: CommitSummary = {
  hash: HASH,
  subject: "a commit",
  author: "Ann",
  authorEmail: "ann@example.com",
  date: "2026-11-07T20:00:00+01:00",
  committerDate: "2026-11-07T20:00:00+01:00",
  tags: [],
  isMerge: false,
};

const count = (over: Partial<UnpushedCount> = {}): UnpushedCount => ({
  count: 0,
  basis: "remotes",
  defaultBranch: null,
  headOid: HASH,
  ...over,
});

function Host() {
  const [target, setTarget] = useState<EditDatesTarget | null>({
    hash: HASH,
    repo: REPO,
    expectedHead: HASH,
    expectedBranch: "topic",
  });
  return (
    <EditDatesDialog
      repoPath={REPO}
      target={target}
      onClose={() => setTarget(null)}
    />
  );
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

/** Holds every exit animation until released, so a closing dialog keeps its
 *  content mounted the way a real fade does. */
function holdExitAnimations() {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = Element.prototype.getAnimations;
  const animation = {
    finished,
    pending: false,
    playState: "running",
    effect: { getTiming: () => ({ duration: 100, iterations: 1 }) },
  };
  Element.prototype.getAnimations = () => [animation as unknown as Animation];
  return {
    release: () => {
      Element.prototype.getAnimations = original;
      finish();
    },
  };
}

/** Lets the status and count reads answer and their renders land. */
async function settled() {
  await screen.findByLabelText("Author date");
  await act(() => new Promise((r) => setTimeout(r, 40)));
}

const primary = () => screen.getByRole("button", { name: /Change dates/ });

function expectBlock(shown: { plain: boolean; published: boolean }) {
  expect(screen.queryByText(PLAIN) !== null).toBe(shown.plain);
  expect(screen.queryByText(PUBLISHED) !== null).toBe(shown.published);
  expect(screen.queryByText(/force push/)).toBeNull();
}

beforeEach(() => {
  vi.mocked(gitStatus).mockReset().mockResolvedValue(status());
  vi.mocked(gitCommitDetails).mockReset().mockResolvedValue(details);
  vi.mocked(gitLog).mockReset().mockResolvedValue([logRow]);
  vi.mocked(gitCommitRecordsParent).mockReset().mockResolvedValue(false);
  vi.mocked(gitOpState).mockReset().mockResolvedValue({
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
    rebaseStop: null,
  });
  vi.mocked(gitAmendCommitDates).mockReset().mockResolvedValue(OTHER);
  vi.mocked(gitUnpushedCount).mockReset().mockResolvedValue(count());
  useConfirm.setState({ request: null, requestHold: null });
  useUiStore.setState({ repoPath: REPO, selectedCommitHash: HASH });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Edit dates on a branch with no upstream", () => {
  it("A: warns when a remote branch has HEAD, without a hold", async () => {
    renderHost();
    expect(await screen.findByText(PUBLISHED)).toBeInTheDocument();
    expectBlock({ plain: false, published: true });
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Author date");
    await user.clear(field);
    await user.type(field, "2026-11-08 10:00:00 +01:00");
    expect(primary()).not.toHaveAttribute("aria-disabled");
    await user.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalled());
  });

  it("B: shows the plain line when no remote branch has HEAD", async () => {
    vi.mocked(gitUnpushedCount).mockResolvedValue(count({ count: 2 }));
    renderHost();
    expect(await screen.findByText(PLAIN)).toBeInTheDocument();
    await settled();
    expectBlock({ plain: true, published: false });
  });

  it("C: warns on a gone upstream, never with the force-push sentence", async () => {
    vi.mocked(gitStatus).mockResolvedValue(
      status({ upstream: "origin/gone", upstreamGone: true }),
    );
    renderHost();
    expect(await screen.findByText(PUBLISHED)).toBeInTheDocument();
    expectBlock({ plain: false, published: true });
    expect(screen.queryByText(/origin\/gone/)).toBeNull();
  });

  it("D: shows neither line while the count is unread", async () => {
    vi.mocked(gitUnpushedCount).mockReturnValue(new Promise(() => undefined));
    renderHost();
    await settled();
    expect(gitUnpushedCount).toHaveBeenCalled();
    expectBlock({ plain: false, published: false });
  });

  it("E: says it couldn't check when the count fails", async () => {
    vi.mocked(gitUnpushedCount).mockRejectedValue(new Error("boom"));
    renderHost();
    expect(await screen.findByText(UNCHECKED)).toBeInTheDocument();
    expectBlock({ plain: true, published: false });
  });

  it("F: shows neither line for a count taken from another HEAD", async () => {
    vi.mocked(gitUnpushedCount).mockResolvedValue(count({ headOid: OTHER }));
    renderHost();
    await settled();
    await waitFor(() => expect(gitUnpushedCount).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expectBlock({ plain: false, published: false });
  });

  it.each([
    ["default-branch", 0],
    ["default-branch", 3],
    ["on-default-branch", 0],
    ["on-default-branch", 3],
    ["unresolved", 0],
    ["unresolved", 3],
  ] as const)(
    "G: a %s basis (count %d) shows the plain line",
    async (basis, n) => {
      vi.mocked(gitUnpushedCount).mockResolvedValue(count({ basis, count: n }));
      renderHost();
      expect(await screen.findByText(PLAIN)).toBeInTheDocument();
      await settled();
      expectBlock({ plain: true, published: false });
    },
  );

  it("H: an upstream HEAD keeps the force-push warning and reads no count", async () => {
    vi.mocked(gitStatus).mockResolvedValue(
      status({
        upstream: "origin/main",
        upstreamRemote: "origin",
        upstreamBranch: "main",
        pushRemote: "origin",
        pushBranch: "main",
        ahead: 0,
      }),
    );
    renderHost();
    expect(
      await screen.findByText(/This commit is already on origin\/main\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(PUBLISHED)).toBeNull();
    expect(gitUnpushedCount).not.toHaveBeenCalled();
  });

  it("I: an upstream branch ahead shows the plain line and reads no count", async () => {
    vi.mocked(gitStatus).mockResolvedValue(
      status({
        upstream: "origin/main",
        upstreamRemote: "origin",
        upstreamBranch: "main",
        pushRemote: "origin",
        pushBranch: "main",
        ahead: 1,
      }),
    );
    renderHost();
    expect(await screen.findByText(PLAIN)).toBeInTheDocument();
    await settled();
    expectBlock({ plain: true, published: false });
    expect(gitUnpushedCount).not.toHaveBeenCalled();
  });

  it("K: the warning holds through the close fade while the change's refresh lands", async () => {
    vi.mocked(toast.success).mockClear();
    const hold = holdExitAnimations();
    try {
      renderHost();
      expect(await screen.findByText(PUBLISHED)).toBeInTheDocument();
      const user = userEvent.setup();
      const field = await screen.findByLabelText("Author date");
      await user.clear(field);
      await user.type(field, "2026-11-08 10:00:00 +01:00");
      const statusReads = vi.mocked(gitStatus).mock.calls.length;
      const countReads = vi.mocked(gitUnpushedCount).mock.calls.length;
      // The rewrite moved HEAD, and no remote branch has the new commit.
      vi.mocked(gitStatus).mockResolvedValue(status({ oid: OTHER }));
      vi.mocked(gitUnpushedCount).mockResolvedValue(
        count({ headOid: OTHER, count: 1 }),
      );
      await user.click(primary());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      await waitFor(() =>
        expect(vi.mocked(gitStatus).mock.calls.length).toBeGreaterThan(
          statusReads,
        ),
      );
      await waitFor(() =>
        expect(vi.mocked(gitUnpushedCount).mock.calls.length).toBeGreaterThan(
          countReads,
        ),
      );
      await act(() => new Promise((r) => setTimeout(r, 40)));
      // Still fading: the form is mounted, closed, and shows the same block.
      expect(screen.getByLabelText("Author date")).toBeInTheDocument();
      expectBlock({ plain: false, published: true });
      // The fade ends inside act, so the dialog's unmount lands in this test.
      await act(async () => {
        hold.release();
        await new Promise((r) => setTimeout(r, 20));
      });
    } finally {
      hold.release();
    }
  });

  it("J: a detached HEAD a remote branch has warns", async () => {
    vi.mocked(gitStatus).mockResolvedValue(
      status({ detached: true, name: null } as never),
    );
    renderHost();
    expect(await screen.findByText(PUBLISHED)).toBeInTheDocument();
    expectBlock({ plain: false, published: true });
  });
});
