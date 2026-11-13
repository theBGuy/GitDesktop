import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/lib/ai/types";
import { saveReview } from "@/lib/pulls/reviews-history";
import {
  type ReviewContext,
  type ReviewTarget,
  resetReview,
  reviewKey,
  startReview,
  useReviewRun,
} from "@/lib/stores/reviews";

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));
vi.mock("@/lib/ai/model-factory", () => ({ createModel: () => ({}) }));
vi.mock("@/lib/git/api", () => ({
  getSecret: async () => "test-key",
  gitFetchObjects: async () => undefined,
  gitRemoveWorktree: async () => undefined,
  gitReviewWorktree: async () => undefined,
  forgePrExternalReviews: async () => [],
  readRepoInstructions: async () => null,
}));
vi.mock("@/lib/settings/api", () => ({
  loadSettings: async () => ({ aiIgnorePatterns: [], globalInstructions: "" }),
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
vi.mock("@/lib/ai/context-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/context-budget")>()),
  resolveBudgetProfile: async () =>
    (await importOriginal<typeof import("@/lib/ai/context-budget")>())
      .DEFAULT_BUDGET_PROFILE,
}));
vi.mock("@/lib/pulls/reviews-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/reviews-history")>()),
  saveReview: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/git/repo-identity", () => ({
  repoIdentity: async (p: string) => p,
}));

const settings = { provider: "openai", model: "m" } as AiSettings;
const target: ReviewTarget = {
  kind: "remote",
  repoPath: "/r",
  repoName: "r",
  lens: "origin",
  ref: "7",
};
const context: ReviewContext = {
  title: "t",
  body: "",
  commitSubjects: [],
  repoPath: "/r",
  lens: "origin",
  loadDiff: async () => ({
    text: "diff --git a/f b/f\n+x\n",
    truncated: false,
    files: [],
  }),
};

type Part = Record<string, unknown>;
const streamOf = (parts: Part[]) =>
  streamTextMock.mockReturnValue({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
const text = (t: string): Part[] => [
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", text: t },
  { type: "text-end", id: "1" },
];

const key = reviewKey(target);
const state = () => renderHook(() => useReviewRun(target)).result.current;

describe("single-pass review store with an API provider", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    vi.mocked(saveReview).mockClear();
    resetReview(key);
  });

  it("ends a refused review in error with no text and nothing saved", async () => {
    streamOf([
      ...text("I can't help with that."),
      { type: "finish", finishReason: "content-filter" },
    ]);
    await startReview(target, "t", settings, "general", context);
    const run = state();
    expect(run.phase).toBe("error");
    expect(run.error).toContain("declined to review");
    expect(run.text).toBe("");
    expect(saveReview).not.toHaveBeenCalled();
  });

  it("saves a normal stop", async () => {
    streamOf([
      ...text("Looks good."),
      { type: "finish", finishReason: "stop" },
    ]);
    await startReview(target, "t", settings, "general", context);
    const run = state();
    expect(run.phase).toBe("done");
    expect(run.text).toBe("Looks good.");
    expect(saveReview).toHaveBeenCalledTimes(1);
  });
});
