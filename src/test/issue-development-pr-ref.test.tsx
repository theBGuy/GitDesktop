import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { IssueDevelopment } from "@/features/issues/IssueDevelopment";
import type { ForgeProvider } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

const data = vi.hoisted(() => ({
  provider: undefined as ForgeProvider | undefined,
}));

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useIssueDevelopment: () => ({
    data: {
      prs: [
        {
          number: 12,
          title: "Fix login",
          state: "OPEN",
          url: "https://example.test/12",
        },
      ],
      branches: [],
    },
    isPending: false,
    isSuccess: true,
    isError: false,
    isPaused: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useForgeStatus: () => ({
    data: data.provider === undefined ? undefined : { provider: data.provider },
  }),
  useCreateLinkedBranch: () => ({
    isPending: false,
    isPaused: false,
    mutateAsync: vi.fn(),
  }),
}));

afterEach(cleanup);
afterAll(() => expect(unmockedCommands).toEqual([]));

describe("an issue's development links number a request by its forge's sigil", () => {
  it.each<[ForgeProvider | undefined, string]>([
    ["gitlab", "!12"],
    ["github", "#12"],
    ["bitbucket", "#12"],
    [undefined, "#12"],
  ])("%s → %s", (provider, ref) => {
    data.provider = provider;
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <IssueDevelopment
          repoPath="/repo"
          number={3}
          issue={{ id: "I_3", number: 3, title: "Login", url: "https://x/3" }}
          lens="origin"
        />
      </QueryClientProvider>,
    );
    const link = screen.getByTitle(`${ref} Fix login`);
    expect(screen.getByText(ref).closest("button")).toBe(link);
  });
});
