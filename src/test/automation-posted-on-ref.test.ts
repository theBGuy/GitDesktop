import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/lib/ai/types";
import { runAutomationNow } from "@/lib/automations/runner";
import { forgePrComment } from "@/lib/git/api";
import type { ForgeStatus } from "@/lib/git/types";
import { emitNotification } from "@/lib/notifications/emit";
import { queryClient } from "@/lib/query-client";
import { useConfirm } from "@/lib/stores/confirm";
import { type Part, streamResult, text } from "./ai-stream-parts";
import { unmockedCommands } from "./setup";

const streamTextMock = vi.hoisted(() => vi.fn());
// Commands the transport mock below has no answer for: its throw lands with
// whichever caller catches it, so the list is what can fail the file.
const strayCommands = vi.hoisted(() => [] as string[]);
const ai = { provider: "openai", model: "m" } as AiSettings;

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/ai/model-factory", () => ({ createModel: () => ({}) }));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: async () => "test-key",
  forgeStatus: async () => {
    throw new Error("no forge");
  },
  forgePrView: async () => ({
    state: "OPEN",
    title: "Fix",
    baseRefName: "main",
    headRefName: "feat",
    body: "",
    headSha: "abc1234567",
    commits: [],
    commitsUnknown: false,
  }),
  forgePrPoll: async () => [],
  forgePrDiff: async () =>
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+x\n",
  forgePrComment: vi.fn(async () => ({ failedAttachments: [] })),
  forgePrExternalReviews: async () => [],
  readRepoInstructions: async () => null,
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
vi.mock("@/lib/automations/store", async (importOriginal) => {
  const config = {
    schemaVersion: 2,
    lifecycles: { "pr-sync": { actions: { general: { enabled: true } } } },
    repos: {},
  };
  return {
    ...(await importOriginal<typeof import("@/lib/automations/store")>()),
    loadAutomations: async () => config,
    loadAutomationsFresh: async () => config,
    repoAutomationsFor: async () => undefined,
  };
});
vi.mock("@/lib/automations/history", () => ({
  recordAutomationActivity: async () => "entry",
  updateAutomationActivity: async () => undefined,
}));
vi.mock("@/lib/stores/reviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/reviews")>()),
  hasLiveAutomationRun: async () => false,
}));
// The runner calls the claim commands directly, so there is no api function to mock.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: async (cmd: string) => {
    switch (cmd) {
      case "claim_automation_run":
        return true;
      case "release_automation_claim":
      case "touch_automation_claim":
        return undefined;
      default:
        strayCommands.push(cmd);
        throw new Error(`unexpected command ${cmd}`);
    }
  },
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: async () => [],
  filterDiffByAiIgnore: async (a: { text: string; files: unknown[] }) => ({
    text: a.text,
    files: a.files,
    excludedFiles: 0,
  }),
}));
vi.mock("@/lib/ai/prior-context", () => ({
  resolvePriorContext: async () => ({}),
}));
vi.mock("@/lib/ai/external-context", () => ({
  resolveExternalContext: async () => ({}),
}));
vi.mock("@/lib/ai/own-context", () => ({
  resolveOwnCommentsContext: async () => ({}),
}));
vi.mock("@/lib/ai/notes-context", () => ({
  resolveReviewerNotesContext: async () => ({}),
}));
vi.mock("@/lib/ai/docs-context", () => ({
  resolveDocSurfacesContext: async () => ({}),
}));
vi.mock("@/lib/ai/context-budget", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/context-budget")>();
  return {
    ...real,
    resolveBudgetProfile: async () => real.DEFAULT_BUDGET_PROFILE,
  };
});
vi.mock("@/lib/pulls/reviews-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/reviews-history")>()),
  listReviews: async () => [],
  saveReview: vi.fn(async () => undefined),
}));
vi.mock("@/lib/automations/dismissals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/dismissals")>()),
  getDismissedHeadMap: async () => ({}),
  clearDismissedHead: async () => undefined,
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (p: string) => p,
}));

const parts: Part[] = [
  ...text("Looks good."),
  { type: "finish", finishReason: "stop" },
];

describe("a delivered automation review names the PR by its forge's sigil", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue(streamResult(parts));
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(forgePrComment).mockClear();
    vi.mocked(emitNotification).mockClear();
    useConfirm.setState({ ask: vi.fn(async () => true) });
    queryClient.clear();
  });

  it.each<[ForgeStatus["provider"], string]>([
    ["gitlab", "AI review posted on !12"],
    ["github", "AI review posted on #12"],
  ])(
    "%s → %s in the toast, the row and the OS title",
    async (provider, line) => {
      const repo = `/r-${provider}`;
      queryClient.setQueryData(["repo", repo, "forge-status"], {
        provider,
      } as ForgeStatus);
      runAutomationNow(repo, { kind: "remote", number: 12 });
      await vi.waitFor(
        () => {
          expect(vi.mocked(toast.error).mock.calls).toEqual([]);
          expect(toast.success).toHaveBeenCalledWith(line);
        },
        { timeout: 4000 },
      );
      expect(forgePrComment).toHaveBeenCalledTimes(1);
      const posted = vi
        .mocked(emitNotification)
        .mock.calls.map(([n]) => n)
        .find((n) => n.row.kind === "review-posted");
      expect(posted?.row.title).toBe(line);
      expect(posted?.os?.title).toBe(line);
    },
  );

  it("keeps the sigil read at run start when the forge status leaves the cache mid-run", async () => {
    const repo = "/r-gitlab-evicted";
    queryClient.setQueryData(["repo", repo, "forge-status"], {
      provider: "gitlab",
    } as ForgeStatus);
    streamTextMock.mockImplementation(() => {
      queryClient.removeQueries({ queryKey: ["repo", repo, "forge-status"] });
      return streamResult(parts);
    });
    runAutomationNow(repo, { kind: "remote", number: 12 });
    await vi.waitFor(
      () => {
        expect(vi.mocked(toast.error).mock.calls).toEqual([]);
        expect(toast.success).toHaveBeenCalledWith("AI review posted on !12");
      },
      { timeout: 4000 },
    );
    expect(
      queryClient.getQueryData(["repo", repo, "forge-status"]),
    ).toBeUndefined();
  });
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
  expect(strayCommands).toEqual([]);
});
