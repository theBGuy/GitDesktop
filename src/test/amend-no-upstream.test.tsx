// Negative control (run once, reverted): dropping useAmendWithConfirm's
// `elsewhere` arm (src/features/history/useAmendCommit.ts) amends without a
// dialog, and the "a remote branch has HEAD" cases go red.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmendForcePushDialog } from "@/features/commit/AmendForcePushDialog";
import { useAmendWithConfirm } from "@/features/history/useAmendCommit";
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import {
  gitCommitDetails,
  gitStatus,
  gitUnpushedCount,
  type UnpushedCount,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { RepoStatus } from "@/lib/git/types";
import type { AppSettings } from "@/lib/settings/api";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitUnpushedCount: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));

vi.mock("@/lib/branch-rules/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/queries")>()),
  useEffectiveBranchRules: () => EMPTY_BRANCH_RULES,
  useEffectiveBranchRulesSettling: () => false,
}));

const REPO = "/repo-a";
const HASH = "abcdef0123".repeat(4);
const OTHER = "0123456789".repeat(4);

const ELSEWHERE_TITLE = "This commit is already on a remote branch";
const ELSEWHERE_BODY =
  "Amending rewrites it on this branch only: the remote branch keeps the original, and the two will differ.";
const UNCHECKED_TITLE = "This commit may already be on a remote branch";
const UNCHECKED_BODY =
  "Couldn't check whether a remote branch has this commit. If one does, amending rewrites it on this branch only.";

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

const count = (over: Partial<UnpushedCount> = {}): UnpushedCount => ({
  count: 0,
  basis: "remotes",
  defaultBranch: null,
  headOid: HASH,
  ...over,
});

let stored: AppSettings;
let client: QueryClient;

function Harness() {
  const { requestAmend, forcePushDialog } = useAmendWithConfirm(REPO);
  const amending = useUiStore((s) => s.amendingHash);
  return (
    <>
      <button type="button" onClick={() => requestAmend(HASH)}>
        Amend
      </button>
      <output data-testid="amending">{amending ?? ""}</output>
      <AmendForcePushDialog {...forcePushDialog} />
    </>
  );
}

function renderHarness() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, structuredClone(stored));
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const amending = () => screen.getByTestId("amending").textContent;

/** Waits until the status read and the count read have each answered. */
async function settled() {
  await waitFor(() => expect(gitStatus).toHaveBeenCalled());
  await waitFor(() => {
    const q = client.getQueryState(repoKeys.unpushedCount(REPO));
    expect(q?.status === "success" || q?.status === "error").toBe(true);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = structuredClone(DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(saveSettingsMerged).mockImplementation(async (next) => {
    stored = structuredClone(next);
    return structuredClone(next);
  });
  vi.mocked(gitStatus).mockResolvedValue(status());
  vi.mocked(gitUnpushedCount).mockResolvedValue(count());
  vi.mocked(gitCommitDetails).mockResolvedValue({
    hash: HASH,
    subject: "Add the thing",
    body: "",
    author: "Ann",
    authorEmail: "ann@example.com",
    date: "2026-11-07T23:58:04+01:00",
    committerDate: "2026-11-07T23:58:04+01:00",
  });
  useUiStore.setState({
    repoPath: REPO,
    amendingHash: null,
    commitTitle: "",
    commitBody: "",
  });
});

describe("Amend on a branch with no upstream", () => {
  it.each([
    ["no upstream", {}],
    ["a gone upstream", { upstream: "origin/topic", upstreamGone: true }],
  ])(
    "a remote branch has HEAD (%s): the dialog asks, Confirm amends",
    async (_n, over) => {
      vi.mocked(gitStatus).mockResolvedValue(status(over));
      renderHarness();
      await settled();
      await userEvent.click(screen.getByRole("button", { name: "Amend" }));
      const dialog = await screen.findByRole("dialog", {
        name: ELSEWHERE_TITLE,
      });
      expect(dialog).toHaveTextContent(ELSEWHERE_BODY);
      expect(gitCommitDetails).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: "Begin amend" }),
      );
      await waitFor(() => expect(amending()).toBe(HASH));
    },
  );

  it("Cancel doesn't amend", async () => {
    renderHarness();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await screen.findByRole("dialog", { name: ELSEWHERE_TITLE });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(gitCommitDetails).not.toHaveBeenCalled();
    expect(amending()).toBe("");
  });

  it("Don't show again suppresses the next ask", async () => {
    renderHarness();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await screen.findByRole("dialog", { name: ELSEWHERE_TITLE });
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Begin amend" }));
    await waitFor(() => expect(stored.confirmAmendForcePush).toBe(false));
    await waitFor(() =>
      expect(
        client.getQueryData<AppSettings>(settingsKeys.settings)
          ?.confirmAmendForcePush,
      ).toBe(false),
    );
    act(() => useUiStore.setState({ amendingHash: null }));
    vi.mocked(gitCommitDetails).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await waitFor(() => expect(amending()).toBe(HASH));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed count asks with the unchecked copy", async () => {
    vi.mocked(gitUnpushedCount).mockRejectedValue({
      kind: "git",
      message: "boom",
    });
    renderHarness();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    const dialog = await screen.findByRole("dialog", { name: UNCHECKED_TITLE });
    expect(dialog).toHaveTextContent(UNCHECKED_BODY);
  });

  it("a count still loading amends without asking", async () => {
    vi.mocked(gitUnpushedCount).mockImplementation(
      () => new Promise(() => undefined),
    );
    renderHarness();
    await waitFor(() => expect(gitUnpushedCount).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await waitFor(() => expect(amending()).toBe(HASH));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["HEAD has unpushed commits", count({ count: 1 })],
    ["the count was taken on another HEAD", count({ headOid: OTHER })],
    [
      "the count ran against the default branch",
      count({ basis: "default-branch" }),
    ],
  ])("%s: amends without asking", async (_n, answer) => {
    vi.mocked(gitUnpushedCount).mockResolvedValue(answer);
    renderHarness();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await waitFor(() => expect(amending()).toBe(HASH));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the open dialog keeps its copy while the count refetches and changes", async () => {
    renderHarness();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await screen.findByRole("dialog", { name: ELSEWHERE_TITLE });
    // A refetch in flight ("refreshing"), then an answer that says unpushed.
    let answer: ((c: UnpushedCount) => void) | undefined;
    vi.mocked(gitUnpushedCount).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    act(() => {
      void client.resetQueries({ queryKey: repoKeys.unpushedCount(REPO) });
    });
    await waitFor(() => expect(answer).toBeDefined());
    expect(
      screen.getByRole("dialog", { name: ELSEWHERE_TITLE }),
    ).toHaveTextContent(ELSEWHERE_BODY);
    act(() => answer?.(count({ count: 2 })));
    await waitFor(() =>
      expect(
        client.getQueryData<UnpushedCount>(repoKeys.unpushedCount(REPO))?.count,
      ).toBe(2),
    );
    expect(
      screen.getByRole("dialog", { name: ELSEWHERE_TITLE }),
    ).toHaveTextContent(ELSEWHERE_BODY);
    await userEvent.click(screen.getByRole("button", { name: "Begin amend" }));
    await waitFor(() => expect(amending()).toBe(HASH));
  });

  it("the latched dialog still cancels after the count changes", async () => {
    renderHarness();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Amend" }));
    await screen.findByRole("dialog", { name: ELSEWHERE_TITLE });
    vi.mocked(gitUnpushedCount).mockResolvedValue(count({ count: 2 }));
    await act(() =>
      client.refetchQueries({ queryKey: repoKeys.unpushedCount(REPO) }),
    );
    await waitFor(() =>
      expect(
        client.getQueryData<UnpushedCount>(repoKeys.unpushedCount(REPO))?.count,
      ).toBe(2),
    );
    expect(
      screen.getByRole("dialog", { name: ELSEWHERE_TITLE }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(gitCommitDetails).not.toHaveBeenCalled();
  });
});
