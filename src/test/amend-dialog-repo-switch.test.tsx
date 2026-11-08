// Negative control: removing the render-time `pendingRepo` reset from
// useAmendWithConfirm (src/features/history/useAmendCommit.ts) keeps the
// force-push confirm open across the switch, and the "closes" case goes red.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAmendWithConfirm } from "@/features/history/useAmendCommit";
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import { gitStatus } from "@/lib/git/api";
import type { RepoStatus } from "@/lib/git/types";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
}));

// Rules settled and empty, so the force-push arm reaches its confirm.
vi.mock("@/lib/branch-rules/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/queries")>()),
  useEffectiveBranchRules: () => EMPTY_BRANCH_RULES,
  useEffectiveBranchRulesSettling: () => false,
}));

const HASH = "abcdef0123".repeat(4);

// On its upstream and not ahead: the commit is pushed, so amending force-pushes.
const pushedStatus: RepoStatus = {
  branch: {
    name: "main",
    detached: false,
    oid: HASH,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    upstreamRemote: "origin",
    upstreamBranch: "main",
    pushNameMismatch: false,
    upstreamIsRemoteDefault: true,
    pushRemote: "origin",
    pushBranch: "main",
  },
  entries: [],
};

function Harness({ repoPath }: { repoPath: string }) {
  const { requestAmend, forcePushDialog } = useAmendWithConfirm(repoPath);
  return (
    <>
      <button type="button" onClick={() => requestAmend(HASH)}>
        Amend
      </button>
      <output data-testid="open">{String(forcePushDialog.open)}</output>
      <output data-testid="upstream">{forcePushDialog.upstream ?? ""}</output>
    </>
  );
}

function renderHarness(repoPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Keeps confirmAmendForcePush on, so a pushed commit asks first.
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const tree = (path: string) => (
    <QueryClientProvider client={client}>
      <Harness repoPath={path} />
    </QueryClientProvider>
  );
  const { rerender } = render(tree(repoPath));
  return (next: string) => rerender(tree(next));
}

const openState = () => screen.getByTestId("open").textContent;

// The gate holds until the status read lands, so wait for it before asking.
async function openConfirm() {
  await waitFor(() =>
    expect(screen.getByTestId("upstream").textContent).toBe("origin/main"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Amend" }));
  expect(openState()).toBe("true");
}

beforeEach(() => {
  vi.mocked(gitStatus).mockReset();
  vi.mocked(gitStatus).mockResolvedValue(pushedStatus);
});

describe("amend force-push confirm across a repo switch", () => {
  it("opens for a pushed commit", async () => {
    renderHarness("/repo-a");
    await openConfirm();
  });

  it("closes in the render that switches the repository", async () => {
    const switchTo = renderHarness("/repo-a");
    await openConfirm();
    switchTo("/repo-b");
    expect(openState()).toBe("false");
  });

  it("stays closed when switching back", async () => {
    const switchTo = renderHarness("/repo-a");
    await openConfirm();
    switchTo("/repo-b");
    switchTo("/repo-a");
    expect(openState()).toBe("false");
  });
});
