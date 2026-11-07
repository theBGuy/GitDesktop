import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { forgeStatus, gitRemotes } from "@/lib/git/api";
import { remotesOptions } from "@/lib/git/queries";
import { lensKey, useLensState } from "@/lib/repo-lens/queries";
import { loadRepoLens } from "@/lib/repo-lens/store";

// Every loader stays in flight, so a seeded read's refetch never lands, and the
// lens store (app data) is never read.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  gitRemotes: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "/repo";
/** useForgeStatus's key (accounts.ts), which no exported builder spells. */
const FORGE_STATUS_KEY = ["repo", REPO, "forge-status"];

function renderLensState(seed: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useLensState(REPO), { wrapper });
}

describe("useLensState", () => {
  // Negative control: deriving `answered` the way `settled` is (no input
  // fetching either) fails this test, as the forge and remotes reads refetch.
  it("answers on a new observer over stale cached reads, before they settle", () => {
    const { result } = renderLensState((client) => {
      // Stale on purpose: forge status and remotes refetch on mount; the lens
      // read never goes stale, so its seed only makes it answered.
      const old = { updatedAt: 1 };
      client.setQueryData(
        FORGE_STATUS_KEY,
        { provider: "github", authenticated: true },
        old,
      );
      client.setQueryData(remotesOptions(REPO).queryKey, ["origin"], old);
      client.setQueryData(lensKey(REPO), "origin", old);
    });
    expect(result.current.answered).toBe(true);
    expect(result.current.settled).toBe(false);
    expect(vi.mocked(gitRemotes)).toHaveBeenCalled();
    expect(vi.mocked(forgeStatus)).toHaveBeenCalled();
  });

  it("has not answered while a lens input has nothing cached", () => {
    const { result } = renderLensState(() => undefined);
    expect(result.current.answered).toBe(false);
    expect(result.current.settled).toBe(false);
    expect(vi.mocked(loadRepoLens)).toHaveBeenCalled();
  });
});
