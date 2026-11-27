import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWatchPrHeads } from "@/features/pulls/useWatchPrHeads";
import { maybeFireSync } from "@/lib/automations/sync";
import { gitBranchTips } from "@/lib/git/api";
import type { LocalPr } from "@/lib/pulls/local";

const REPO = "/r";
const SHA = "a".repeat(40);

const pr = (id: string, head: string): LocalPr =>
  ({
    id,
    head,
    base: "main",
    title: `PR ${id}`,
    body: "",
    status: "open",
  }) as LocalPr;

// One stable array per case: the hook's effect keys on the memoized open list.
const h = vi.hoisted(() => ({ prs: [] as LocalPr[] }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/pulls/queries", () => ({
  useLocalPrs: () => ({ data: h.prs }),
}));
vi.mock("@/lib/settings/queries", () => ({ useAiEnabled: () => true }));
vi.mock("@/lib/automations/sync", () => ({ maybeFireSync: vi.fn() }));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchTips: vi.fn(),
}));

function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(() => useWatchPrHeads(REPO), { wrapper });
  return client;
}

const tipsState = (client: QueryClient) =>
  client.getQueryCache().find({ queryKey: ["branch-tips", REPO], exact: false })
    ?.state;

describe("useWatchPrHeads", () => {
  beforeEach(() => {
    vi.mocked(maybeFireSync).mockReset();
    vi.mocked(gitBranchTips).mockReset();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  it("never reads an inherited member as the tip of a head named like an Object.prototype key", async () => {
    h.prs = [pr("1", "constructor"), pr("2", "feat/a")];
    vi.mocked(gitBranchTips).mockResolvedValue({ "feat/a": SHA });
    mount();
    await waitFor(() => expect(maybeFireSync).toHaveBeenCalled());
    expect(maybeFireSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(maybeFireSync).mock.calls[0][0]).toMatchObject({
      ref: "2",
      head: "feat/a",
      currentHeadSha: SHA,
    });
  });

  it("keeps watching a head named __proto__ across refetches whose answers differ", async () => {
    const [A, B, C] = ["a", "b", "c"].map((c) => c.repeat(40));
    h.prs = [pr("1", "__proto__"), pr("2", "feat/a")];
    // JSON.parse makes an own key; an object literal would set the prototype.
    const answer = (proto: string, feat: string) =>
      JSON.parse(`{"__proto__":"${proto}","feat/a":"${feat}"}`);
    const protoSyncs = () =>
      vi
        .mocked(maybeFireSync)
        .mock.calls.filter(([e]) => e.ref === "1")
        .map(([e]) => e.currentHeadSha);
    vi.mocked(gitBranchTips).mockResolvedValueOnce(answer(A, A));
    const client = mount();
    await waitFor(() => expect(protoSyncs()).toEqual([A]));
    // Another key differs, so structural sharing rebuilds the answer.
    vi.mocked(gitBranchTips).mockResolvedValueOnce(answer(A, B));
    await act(() => client.refetchQueries({ queryKey: ["branch-tips", REPO] }));
    await waitFor(() => expect(protoSyncs()).toEqual([A, A]));
    // The __proto__ branch itself moves.
    vi.mocked(gitBranchTips).mockResolvedValueOnce(answer(C, B));
    await act(() => client.refetchQueries({ queryKey: ["branch-tips", REPO] }));
    await waitFor(() => expect(protoSyncs()).toEqual([A, A, C]));
  });

  it("pins, with no fix to revert: a tips read that rejects after a success fires nothing more", async () => {
    h.prs = [pr("2", "feat/a")];
    vi.mocked(gitBranchTips).mockResolvedValueOnce({ "feat/a": SHA });
    const client = mount();
    await waitFor(() => expect(maybeFireSync).toHaveBeenCalledTimes(1));
    vi.mocked(gitBranchTips).mockRejectedValueOnce({
      kind: "git",
      message: "fatal: not a git repository",
    });
    await act(() => client.refetchQueries({ queryKey: ["branch-tips", REPO] }));
    expect(tipsState(client)?.status).toBe("error");
    expect(tipsState(client)?.data).toEqual([["feat/a", SHA]]);
    expect(maybeFireSync).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a first tips read that rejects fires nothing and reads once per poll", async () => {
    h.prs = [pr("2", "feat/a")];
    vi.mocked(gitBranchTips).mockRejectedValue({
      kind: "git",
      message: "fatal: not a git repository",
    });
    // react-query's own retry default, so only the query's option can stop it.
    const client = mount(new QueryClient());
    await waitFor(() => expect(tipsState(client)?.status).toBe("error"));
    expect(gitBranchTips).toHaveBeenCalledTimes(1);
    await act(() => client.refetchQueries({ queryKey: ["branch-tips", REPO] }));
    expect(tipsState(client)?.status).toBe("error");
    expect(gitBranchTips).toHaveBeenCalledTimes(2);
    expect(maybeFireSync).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
});
