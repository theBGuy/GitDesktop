import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/lib/ai/types";
import { runAutomationNow } from "@/lib/automations/runner";
import { forgePrView } from "@/lib/git/api";
import type { ForgeStatus, PrDetails } from "@/lib/git/types";
import { queryClient } from "@/lib/query-client";
import { useConfirm } from "@/lib/stores/confirm";

const REPO = "/r";
const ai = { provider: "openai", model: "m" } as AiSettings;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: async () => ({
    hideAi: false,
    reviewAi: ai,
    aiIgnorePatterns: [],
    globalInstructions: "",
  }),
  effectiveReviewAi: () => ai,
}));
vi.mock("@/lib/automations/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/store")>()),
  loadAutomations: async () => ({
    schemaVersion: 2,
    lifecycles: { "pr-sync": { actions: { general: { enabled: true } } } },
    repos: {},
  }),
  repoAutomationsFor: async () => undefined,
}));
vi.mock("@/lib/stores/reviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/reviews")>()),
  hasLiveAutomationRun: async () => false,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
}));

const ask = vi.fn(async () => false);

/** The confirm the run-now preview asks with, for PR 12. */
async function confirmAsked(): Promise<{ title: string; body: string }> {
  runAutomationNow(REPO, { kind: "remote", number: 12 });
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  return (ask.mock.calls[0] as unknown as [{ title: string; body: string }])[0];
}
const confirmBody = async () => (await confirmAsked()).body;

describe("runAutomationNow names the remote PR by its forge's sigil", () => {
  beforeEach(() => {
    ask.mockClear();
    useConfirm.setState({ ask });
    queryClient.clear();
    vi.mocked(forgePrView).mockResolvedValue({
      state: "OPEN",
      title: "Fix",
      headSha: "abc123",
      commits: [],
    } as unknown as PrDetails);
  });

  it.each<[ForgeStatus["provider"] | "uncached", string]>([
    ["gitlab", "!12 · Fix"],
    ["github", "#12 · Fix"],
    ["bitbucket", "#12 · Fix"],
    // No cached forge status: the print keeps `#` rather than probe.
    ["uncached", "#12 · Fix"],
  ])("%s → %s", async (provider, lead) => {
    if (provider !== "uncached")
      queryClient.setQueryData(["repo", REPO, "forge-status"], {
        provider,
      } as ForgeStatus);
    expect(await confirmBody()).toMatch(new RegExp(`^${lead} — runs `));
  });

  it.each<[ForgeStatus["provider"] | "uncached", string]>([
    ["gitlab", "merge request"],
    ["github", "pull request"],
    ["bitbucket", "pull request"],
    ["uncached", "pull request"],
  ])("%s: the confirm calls it a %s", async (provider, noun) => {
    if (provider !== "uncached")
      queryClient.setQueryData(["repo", REPO, "forge-status"], {
        provider,
      } as ForgeStatus);
    const { title, body } = await confirmAsked();
    expect(title).toBe(`Run automations on this ${noun}?`);
    expect(
      body.endsWith(`. The result is posted as a comment on the ${noun}.`),
    ).toBe(true);
  });
});
