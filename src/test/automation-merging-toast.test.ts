import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/lib/ai/types";
import { runAutomationNow } from "@/lib/automations/runner";
import { forgePrView } from "@/lib/git/api";
import type { PrDetails } from "@/lib/git/types";
import { useConfirm } from "@/lib/stores/confirm";

const REPO = "/r";
const MERGING_COPY =
  "This merge request is being merged — automations run on open merge requests.";
const CLOSED_COPY =
  "This pull request is closed — automations run on open pull requests.";
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
  loadAutomationsFresh: async () => ({
    schemaVersion: 2,
    lifecycles: { "pr-sync": { actions: { general: { enabled: true } } } },
    repos: {},
  }),
  repoAutomationsFor: async () => undefined,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgePrView: vi.fn(),
}));

const ask = vi.fn(async () => false);

describe("runAutomationNow on a remote request that isn't open", () => {
  beforeEach(() => {
    vi.mocked(toast.info).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(forgePrView).mockReset();
    ask.mockClear();
    useConfirm.setState({ ask });
  });

  for (const [number, state, copy, other] of [
    [7, "MERGING", MERGING_COPY, CLOSED_COPY],
    [8, "CLOSED", CLOSED_COPY, MERGING_COPY],
  ] as const)
    it(`a ${state} request says so and runs nothing`, async () => {
      vi.mocked(forgePrView).mockResolvedValue({
        number,
        state,
      } as unknown as PrDetails);
      runAutomationNow(REPO, { kind: "remote", number });
      await vi.waitFor(() => expect(toast.info).toHaveBeenCalled());
      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith(copy);
      expect(toast.info).not.toHaveBeenCalledWith(other);
      expect(forgePrView).toHaveBeenCalledTimes(1);
      expect(ask).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
});
