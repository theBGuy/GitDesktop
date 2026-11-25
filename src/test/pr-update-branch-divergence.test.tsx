import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ghPrUpdateBranch } from "@/lib/git/api";
import { prBaseDivergenceKey, usePrUpdateBranch } from "@/lib/git/queries";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  ghPrUpdateBranch: vi.fn(),
}));

const REPO = "C:/repo";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("an update-branch settle re-reads its own lens's divergence, never the other lens's PR at that number", async () => {
  vi.mocked(ghPrUpdateBranch).mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const origin = prBaseDivergenceKey(REPO, 7, "origin");
  const upstream = prBaseDivergenceKey(REPO, 7, "upstream");
  client.setQueryData(origin, { behind: 1 });
  client.setQueryData(upstream, { behind: 2 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => usePrUpdateBranch(REPO), { wrapper });

  await act(() =>
    result.current.mutateAsync({ number: 7, rebase: false, lens: "origin" }),
  );

  expect(ghPrUpdateBranch).toHaveBeenCalledWith(REPO, 7, false, "origin");
  expect([
    client.getQueryState(origin)?.isInvalidated,
    client.getQueryState(upstream)?.isInvalidated,
  ]).toEqual([true, false]);
  client.clear();
});
