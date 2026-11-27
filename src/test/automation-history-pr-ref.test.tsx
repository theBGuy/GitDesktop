import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  AutomationHistoryDialogHost,
  useAutomationHistoryDialog,
} from "@/features/automations/AutomationHistoryDialog";
import type { AutomationHistoryEntry } from "@/lib/automations/history";
import type { ForgeStatus } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

const REPO = "/repo";

vi.mock("@/lib/automations/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/history")>()),
  listAutomationHistory: async (): Promise<AutomationHistoryEntry[]> => [
    {
      schemaVersion: 1,
      id: "e1",
      ts: "2026-11-20T10:00:00Z",
      trigger: "pr-sync",
      targetKind: "remote",
      ref: "12",
      title: "Fix login",
      headSha: "abc",
      outcomes: [],
    } as AutomationHistoryEntry,
  ],
  recordAutomationPauseMarker: async () => undefined,
}));
vi.mock("@/lib/automations/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/queries")>()),
  useAutomations: () => ({ data: undefined }),
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useAiEnabled: () => true,
  useSettings: () => ({ data: undefined }),
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useRepoIdentity: () => ({ data: REPO }),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (p: string) => p,
}));

afterEach(() => {
  act(() => useAutomationHistoryDialog.getState().close());
  cleanup();
});
afterAll(() => expect(unmockedCommands).toEqual([]));

function renderOpen(provider: ForgeStatus["provider"] | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (provider !== null) {
    client.setQueryData(["repo", REPO, "forge-status"], {
      provider,
    } as ForgeStatus);
  }
  render(
    <QueryClientProvider client={client}>
      <AutomationHistoryDialogHost />
    </QueryClientProvider>,
  );
  act(() => useAutomationHistoryDialog.getState().open(REPO));
  return client;
}

describe("automation history names a remote request by its forge's sigil", () => {
  it.each<[ForgeStatus["provider"] | null, string]>([
    ["gitlab", "!12 · Fix login"],
    ["github", "#12 · Fix login"],
    ["bitbucket", "#12 · Fix login"],
    [null, "#12 · Fix login"],
  ])("%s → %s", async (provider, label) => {
    renderOpen(provider);
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it("re-reads the sigil when the forge status lands after the list painted", async () => {
    const client = renderOpen(null);
    expect(await screen.findByText("#12 · Fix login")).toBeTruthy();
    act(() =>
      client.setQueryData(["repo", REPO, "forge-status"], {
        provider: "gitlab",
      } as ForgeStatus),
    );
    expect(await screen.findByText("!12 · Fix login")).toBeTruthy();
  });
});
