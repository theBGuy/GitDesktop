import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/lib/ai/types";
import { runAutomationNow } from "@/lib/automations/runner";
import { gitBranchTips } from "@/lib/git/api";
import type { LocalPr } from "@/lib/pulls/local";
import { useConfirm } from "@/lib/stores/confirm";

const REPO = "/r";
const UNRESOLVED_HEAD =
  "Couldn't resolve the pull request's current head — try refreshing.";
const ai = { provider: "openai", model: "m" } as AiSettings;

const h = vi.hoisted(() => ({ prs: [] as LocalPr[] }));

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
  loadAutomationsFresh: async () => ({
    schemaVersion: 2,
    lifecycles: { "pr-sync": { actions: { general: { enabled: true } } } },
    repos: {},
  }),
  repoAutomationsFor: async () => undefined,
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  reloadLocalPrs: async () => undefined,
  listLocalPrs: async () => h.prs,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchTips: vi.fn(),
}));

const pr = (head: string): LocalPr =>
  ({
    id: "lp-1",
    head,
    base: "main",
    title: "Local PR",
    body: "",
    status: "open",
  }) as LocalPr;

const ask = vi.fn(async () => false);

describe("runAutomationNow on a local pull request", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    vi.mocked(gitBranchTips).mockReset();
    ask.mockClear();
    useConfirm.setState({ ask });
  });

  it("refuses a head named like an Object.prototype key that the tips read omitted", async () => {
    h.prs = [pr("constructor")];
    vi.mocked(gitBranchTips).mockResolvedValue({});
    runAutomationNow(REPO, { kind: "local", id: "lp-1" });
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(UNRESOLVED_HEAD),
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("reports a failed tips read as the run's own failure, not an unresolved head", async () => {
    h.prs = [pr("feat/a")];
    vi.mocked(gitBranchTips).mockRejectedValue({
      kind: "git",
      message: "git failed",
      stderr: "fatal: not a git repository",
    });
    runAutomationNow(REPO, { kind: "local", id: "lp-1" });
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const titles = vi.mocked(toast.error).mock.calls.map((c) => c[0]);
    expect(titles).toHaveLength(1);
    expect(String(titles[0])).toMatch(
      /^Couldn't run automations on this pull request: /,
    );
    expect(titles).not.toContain(UNRESOLVED_HEAD);
    expect(ask).not.toHaveBeenCalled();
  });
});
