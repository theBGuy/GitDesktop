import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OperationHistoryDialog } from "@/features/repository/OperationHistoryDialog";
import { OpRecoveryBanner } from "@/features/repository/OpRecoveryBanner";
import {
  gitOplogCheck,
  gitOplogList,
  gitUpdateLocalPrHead,
} from "@/lib/git/api";
import { useStartLocalPrUpdate } from "@/lib/git/queries";
import type { OpLogEntry } from "@/lib/git/types";
import {
  type LocalPr,
  listLocalPrs,
  type PendingUpdate,
} from "@/lib/pulls/local";
import { localPrKey } from "@/lib/pulls/queries";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitOplogCheck: vi.fn(),
  gitOplogList: vi.fn(),
  gitUpdateLocalPrHead: vi.fn(),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
}));

const REPO = "C:/repos/demo";

const entry = (over: Partial<OpLogEntry> = {}): OpLogEntry => ({
  id: "op-1",
  op: "update_local_pr_head",
  label: "Update feat from main",
  status: "pending",
  startedAt: "2026-11-02T00:00:00.000Z",
  finishedAt: null,
  originalRef: "feat",
  originalSha: "abc1234def5678abc1234def5678abc1234def56",
  preOpTip: "abc1234def5678abc1234def5678abc1234def56",
  error: null,
  ...over,
});

const update: PendingUpdate = {
  base: "main",
  head: "feat",
  worktreePath: "C:/data/wt/gd-resolve-0123456789ab",
  worktreeId: "0123456789ab",
  opId: "op-1",
  journalRepo: REPO,
  startedAt: "2026-11-02T00:00:00.000Z",
};

const pr = (over: Partial<LocalPr> = {}): LocalPr => ({
  id: "pr-1",
  title: "Feature",
  body: "",
  base: "main",
  head: "feat",
  status: "open",
  approved: false,
  labels: [],
  comments: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unmockedCommands.length = 0;
  vi.mocked(gitOplogCheck).mockReset();
  vi.mocked(gitOplogList).mockReset();
  vi.mocked(listLocalPrs).mockReset();
  vi.mocked(gitUpdateLocalPrHead).mockReset();
});

afterEach(() => {
  qc.clear();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const INTERRUPTED = /Interrupted: Update feat from main/;

async function renderBanner(prs: LocalPr[], check: OpLogEntry[]) {
  vi.mocked(listLocalPrs).mockResolvedValue(prs);
  vi.mocked(gitOplogCheck).mockResolvedValue(check);
  const view = render(<OpRecoveryBanner repoPath={REPO} />, { wrapper });
  await waitFor(() => {
    expect(qc.getQueryState(localPrKey(REPO))?.status).toBe("success");
    expect(qc.getQueryState(["repo", REPO, "oplog-check"])?.status).toBe(
      "success",
    );
  });
  return view;
}

describe("OpRecoveryBanner and an update's journal entry", () => {
  it("is silent for an entry an open PR's unfinished update still owns", async () => {
    await renderBanner([pr({ pendingUpdate: update })], [entry()]);
    expect(screen.queryByText(INTERRUPTED)).toBeNull();
  });

  it("reports the same entry once its PR is closed", async () => {
    await renderBanner(
      [pr({ status: "closed", pendingUpdate: update })],
      [entry()],
    );
    expect(await screen.findByText(INTERRUPTED)).toBeTruthy();
  });

  /** A start in flight while the banner's check caches its entry as pending; the
   *  check's next read waits on the returned `reread`. */
  async function startDuringCheck() {
    let finish!: (reason: unknown) => void;
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(
      new Promise((_resolve, reject) => {
        finish = reject;
      }),
    );
    const starter = renderHook(
      () => useStartLocalPrUpdate(REPO, ["local-prs", "x"]),
      { wrapper },
    );
    let started!: Promise<unknown>;
    act(() => {
      started = starter.result.current
        .mutateAsync({ id: "pr-1", base: "main", head: "feat" })
        .catch(() => undefined);
    });
    // No record names the entry yet: only the running start keeps it quiet.
    await renderBanner([pr()], [entry()]);
    expect(screen.queryByText(INTERRUPTED)).toBeNull();
    let reread!: (check: OpLogEntry[]) => void;
    vi.mocked(gitOplogCheck).mockReturnValue(
      new Promise((resolve) => {
        reread = resolve;
      }),
    );
    await act(async () => {
      finish(new Error("start failed"));
      await new Promise((r) => setTimeout(r, 30));
    });
    return {
      started,
      reread: (check: OpLogEntry[]) =>
        act(async () => {
          reread(check);
          await started;
        }),
    };
  }

  it("never reports a start's entry once it settles: the check re-reads first", async () => {
    const start = await startDuringCheck();
    // The start failed (its entry is closed), but its check re-read is still out:
    // the start stays pending and the cached "pending" entry stays held back.
    expect(gitOplogCheck).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(INTERRUPTED)).toBeNull();
    await start.reread([]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByText(INTERRUPTED)).toBeNull();
  });

  it("judges the kind again once the start has settled", async () => {
    const start = await startDuringCheck();
    // A check that still answers the entry pending after the start settled.
    await start.reread([entry()]);
    expect(await screen.findByText(INTERRUPTED)).toBeTruthy();
  });

  it("still reports another kind while a start runs", async () => {
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(
      new Promise(() => undefined),
    );
    const starter = renderHook(
      () => useStartLocalPrUpdate(REPO, localPrKey(REPO)),
      { wrapper },
    );
    act(() => {
      void starter.result.current
        .mutateAsync({ id: "pr-1", base: "main", head: "feat" })
        .catch(() => undefined);
    });
    await renderBanner(
      [pr()],
      [entry({ op: "cherry_pick_onto", label: "Cherry-pick onto main" })],
    );
    expect(
      await screen.findByText(/Interrupted: Cherry-pick onto main/),
    ).toBeTruthy();
  });
});

describe("OperationHistoryDialog", () => {
  it("names a paused update and shows it as Paused", async () => {
    vi.mocked(gitOplogList).mockResolvedValue([
      entry({ status: "paused" }),
      entry({
        id: "op-2",
        op: "future_op" as OpLogEntry["op"],
        status: "done",
      }),
    ]);
    render(
      <OperationHistoryDialog
        repoPath={REPO}
        open={true}
        onOpenChange={() => undefined}
      />,
      { wrapper },
    );
    expect(await screen.findByText("Local PR branch update")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    // An unknown kind still renders its raw key.
    expect(screen.getByText("future_op")).toBeTruthy();
  });

  it("lists branch updates among the journaled operations when empty", async () => {
    vi.mocked(gitOplogList).mockResolvedValue([]);
    render(
      <OperationHistoryDialog
        repoPath={REPO}
        open={true}
        onOpenChange={() => undefined}
      />,
      { wrapper },
    );
    expect(
      await screen.findByText(
        /local PR merges and branch updates, cherry-picks/,
      ),
    ).toBeTruthy();
  });
});
