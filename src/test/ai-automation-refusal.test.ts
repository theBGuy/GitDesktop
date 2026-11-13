import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/lib/ai/types";
import { useAutomationResults } from "@/lib/automations/results";
import { triggerAutomations } from "@/lib/automations/runner";
import { saveReview } from "@/lib/pulls/reviews-history";
import { type Part, streamResult, text } from "./ai-stream-parts";

const streamTextMock = vi.hoisted(() => vi.fn());
const ai = { provider: "openai", model: "m" } as AiSettings;

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/ai/model-factory", () => ({ createModel: () => ({}) }));
vi.mock("@/lib/git/api", () => ({
  getSecret: async () => "test-key",
  gitCommitDiff: async () => ({
    text: "diff --git a/f b/f\n+x\n",
    truncated: false,
    files: [],
  }),
  forgeStatus: async () => {
    throw new Error("no forge");
  },
  forgePrExternalReviews: async () => [],
  readRepoInstructions: async () => null,
}));
vi.mock("@/lib/settings/api", () => ({
  loadSettings: async () => ({
    hideAi: false,
    reviewAi: ai,
    aiIgnorePatterns: [],
    globalInstructions: "",
  }),
  effectiveReviewAi: () => ai,
}));
vi.mock("@/lib/automations/store", () => ({
  loadAutomations: async () => ({
    schemaVersion: 2,
    lifecycles: { commit: { actions: { general: { enabled: true } } } },
    repos: {},
  }),
  repoAutomationsFor: async () => undefined,
}));
vi.mock("@/lib/automations/history", () => ({
  recordAutomationActivity: async () => "entry",
  updateAutomationActivity: async () => undefined,
}));
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: async () => true,
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
  saveReview: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentity: async (p: string) => p,
}));

const streamOf = (parts: Part[]) =>
  streamTextMock.mockReturnValue(streamResult(parts));

const event = {
  kind: "commit" as const,
  repoPath: "/r",
  hash: "abcdef1234567",
  title: "t",
  branch: "main",
};

async function settle() {
  triggerAutomations(event);
  await vi.waitFor(() => {
    const done =
      vi.mocked(toast.error).mock.calls.length +
      vi.mocked(toast.success).mock.calls.length;
    expect(done).toBeGreaterThan(0);
  });
}

describe("automation review over an API provider", () => {
  const add = vi.fn(async () => undefined);
  beforeEach(() => {
    streamTextMock.mockReset();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(saveReview).mockClear();
    add.mockClear();
    useAutomationResults.setState({ add });
  });

  it("fails a refused run and delivers or persists nothing", async () => {
    streamOf([
      ...text("I can't help with that."),
      { type: "finish", finishReason: "content-filter" },
    ]);
    await settle();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain(
      "declined to review",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
  });

  it("delivers a normal stop", async () => {
    streamOf([
      ...text("Looks good."),
      { type: "finish", finishReason: "stop" },
    ]);
    await settle();
    expect(toast.error).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });
});
