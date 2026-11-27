import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PendingPrRow } from "@/features/pulls/PendingPrRow";
import { usePrNotifications } from "@/features/repository/usePrNotifications";
import { forgePrPoll } from "@/lib/git/api";
import type { ForgeStatus, PrPollInfo } from "@/lib/git/types";
import { emitNotification } from "@/lib/notifications/emit";
import { usePrAuditByBranch } from "@/lib/pulls/audit";
import type { PrCreate } from "@/lib/stores/pr-create";

const REPO = "/r";
const forge = vi.hoisted(() => ({ provider: "github" as string }));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrPoll: vi.fn(),
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  forgeFeatureReady: () => true,
  useForgeStatus: () => ({
    data: { provider: forge.provider, login: "me" } as ForgeStatus,
  }),
  useRepoIdentity: () => ({ data: REPO }),
  usePrList: (_repo: string, _on: boolean, state: string) => ({
    data:
      state === "open"
        ? [
            {
              number: 12,
              state: "OPEN",
              isDraft: false,
              headRefName: "feat",
              crossRepository: false,
            },
          ]
        : [],
  }),
}));
vi.mock("@/lib/pulls/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/queries")>()),
  useLocalPrs: () => ({ data: [] }),
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: { notifications: {}, reviewDraftPrs: false } }),
  useAiEnabled: () => false,
}));
vi.mock("@/lib/automations/queries", () => ({
  useAutomations: () => ({ data: undefined }),
}));
vi.mock("@/lib/notifications/queries", () => ({
  useRepoNotificationOverride: () => undefined,
}));
vi.mock("@/lib/notifications/overrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/overrides")>()),
  anyChannelOn: () => true,
  effectiveChecksScope: () => "mine",
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const opened = {
  number: 12,
  state: "OPEN",
  author: "someone",
  isDraft: false,
  title: "Fix",
  headSha: "abc",
  baseRefName: "main",
  headRefName: "feat",
} as unknown as PrPollInfo;

beforeEach(() => {
  vi.mocked(emitNotification).mockClear();
  vi.mocked(forgePrPoll).mockReset();
});

describe("PR notification titles carry the forge's sigil", () => {
  it.each([
    ["gitlab", "New merge request !12"],
    ["github", "New pull request #12"],
  ])("%s → %s", async (provider, title) => {
    forge.provider = provider;
    vi.mocked(forgePrPoll)
      .mockResolvedValueOnce([])
      .mockResolvedValue([opened]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(() => usePrNotifications(REPO), {
      wrapper: wrapperFor(client),
    });
    // The first answer only primes the snapshot; it must land before the next.
    await waitFor(() =>
      expect(client.getQueryData(["repo", REPO, "pr-poll"])).toEqual([]),
    );
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "pr-poll"] }),
    );
    await waitFor(() => expect(emitNotification).toHaveBeenCalledTimes(1));
    const [n] = vi.mocked(emitNotification).mock.calls[0];
    expect(n.row.title).toBe(title);
    expect(n.os?.title).toBe(title);
  });
});

describe("the session audit chip labels a remote PR by its forge's sigil", () => {
  it.each([
    ["gitlab", "!12"],
    ["github", "#12"],
  ])("%s → %s", (provider, label) => {
    forge.provider = provider;
    const client = new QueryClient();
    const { result } = renderHook(() => usePrAuditByBranch(REPO, true), {
      wrapper: wrapperFor(client),
    });
    expect(result.current.get("feat")).toEqual({ state: "open", label });
  });
});

describe("the pending create row names the new request by its forge's sigil", () => {
  const create = (noun: PrCreate["noun"]) =>
    ({
      phase: "created",
      guardReleased: true,
      noun,
      number: 12,
      title: "Fix",
      draft: false,
      head: "feat",
      base: "main",
    }) as unknown as PrCreate;

  it.each([
    ["merge request", "!12 · opened, not in this view yet"],
    ["pull request", "#12 · opened, not in this view yet"],
  ] as const)("%s → %s", (noun, line) => {
    render(<PendingPrRow create={create(noun)} />);
    expect(screen.getByText(line)).toBeTruthy();
  });
});
