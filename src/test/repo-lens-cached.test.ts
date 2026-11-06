import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { remotesOptions } from "@/lib/git/queries";
import type { ForgeStatus, RemoteLens } from "@/lib/git/types";
import { cachedRepoLens, lensKey, useLensState } from "@/lib/repo-lens/queries";

// The hook's three reads refetch past their staleTime; a fetch that never
// settles keeps each seeded value in place, so the hook reads only the seeds.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  gitRemotes: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/repo-lens/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/store")>()),
  loadRepoLens: vi.fn(() => new Promise(() => undefined)),
}));

const REPO = "C:/repos/fork";

type Seed = {
  forge?: Partial<ForgeStatus>;
  remotes?: string[];
  raw?: RemoteLens;
};

const FORK: Seed = {
  forge: { provider: "github", authenticated: true },
  remotes: ["origin", "upstream"],
  raw: "upstream",
};

const CASES: [name: string, seed: Seed, lens: RemoteLens][] = [
  ["a signed-in GitHub fork on the upstream lens", FORK, "upstream"],
  [
    "signed out",
    { ...FORK, forge: { provider: "github", authenticated: false } },
    "origin",
  ],
  ["no upstream remote", { ...FORK, remotes: ["origin"] }, "origin"],
  [
    "a GitLab provider",
    { ...FORK, forge: { provider: "gitlab", authenticated: true } },
    "origin",
  ],
  ["the stored lens is origin", { ...FORK, raw: "origin" }, "origin"],
  ["every cache cold", {}, "origin"],
];

function seeded(seed: Seed) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed.forge)
    client.setQueryData(["repo", REPO, "forge-status"], seed.forge);
  if (seed.remotes)
    client.setQueryData(remotesOptions(REPO).queryKey, seed.remotes);
  if (seed.raw) client.setQueryData(lensKey(REPO), seed.raw);
  return client;
}

describe("cachedRepoLens", () => {
  it.each(CASES)("reads %s", (_name, seed, lens) => {
    expect(cachedRepoLens(seeded(seed), REPO)).toBe(lens);
  });

  it.each(CASES)("agrees with useLensState: %s", (_name, seed, lens) => {
    const client = seeded(seed);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useLensState(REPO), { wrapper });
    expect(result.current.lens).toBe(lens);
    expect(cachedRepoLens(client, REPO)).toBe(result.current.lens);
  });
});
