// Negative control: removing useGenerateSquashMessage's unmount cleanup
// (src/features/history/RewriteDialogs.tsx) leaves the stream's signal live
// after the host unmounts and lets the empty-range toast fire, so the unmount
// cases go red; removing its post-context aborted check builds a client for a
// non-empty diff that settles after unmount.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerateSquashMessage } from "@/features/history/RewriteDialogs";
import { createAiClient } from "@/lib/ai/client";
import type { AiClient } from "@/lib/ai/types";
import {
  gitBranchDiff,
  gitRecentCommits,
  readRepoInstructions,
} from "@/lib/git/api";
import type { StagedDiff } from "@/lib/git/types";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(async () => structuredClone(DEFAULT_SETTINGS)),
}));

vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(async () => []),
}));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchDiff: vi.fn(),
  gitRecentCommits: vi.fn(),
  readRepoInstructions: vi.fn(),
}));

vi.mock("@/lib/ai/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/client")>()),
  createAiClient: vi.fn(),
}));

const diffOf = (text: string): StagedDiff => ({
  text,
  truncated: false,
  files: [],
  excludedFiles: 0,
  unreadableFiles: 0,
});

/** Signals the mocked client's streams were handed, in call order. */
let signals: AbortSignal[] = [];

// A stream that never yields text and ends only by rejecting on abort, like a
// provider stream cancelled mid-request.
const endlessClient: AiClient = {
  stream: (req) =>
    (async function* () {
      const signal = req.abortSignal;
      if (signal) signals.push(signal);
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
      yield "";
    })(),
  testConnection: async () => ({ ok: true }),
};

function Harness() {
  const { generate, cancel, generating } = useGenerateSquashMessage(
    "/repo",
    vi.fn(),
  );
  return (
    <>
      <button type="button" onClick={() => void generate("base", "head")}>
        Generate
      </button>
      <button type="button" onClick={cancel}>
        Cancel
      </button>
      <output data-testid="generating">{String(generating)}</output>
    </>
  );
}

/** Lets settled promises run their continuations. */
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

let toastErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  signals = [];
  vi.mocked(gitBranchDiff).mockReset();
  vi.mocked(gitBranchDiff).mockResolvedValue(diffOf("diff --git a/x b/x\n"));
  vi.mocked(gitRecentCommits).mockResolvedValue([]);
  vi.mocked(readRepoInstructions).mockResolvedValue(null);
  vi.mocked(createAiClient).mockResolvedValue(endlessClient);
  toastErrorSpy = vi.spyOn(toast, "error");
});

afterEach(() => {
  toastErrorSpy.mockRestore();
});

describe("squash message generation stops with its host", () => {
  it("aborts the running stream on unmount, silently", async () => {
    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0].aborted).toBe(false);
    unmount();
    expect(signals[0].aborted).toBe(true);
    await flush();
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("toasts nothing when the diff read settles empty after unmount", async () => {
    let resolveDiff: ((diff: StagedDiff) => void) | undefined;
    vi.mocked(gitBranchDiff).mockReturnValue(
      new Promise((r) => {
        resolveDiff = r;
      }),
    );
    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalled());
    unmount();
    resolveDiff?.(diffOf(""));
    await flush();
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(createAiClient).not.toHaveBeenCalled();
  });

  it("builds no client when a non-empty diff settles after unmount", async () => {
    let resolveDiff: ((diff: StagedDiff) => void) | undefined;
    vi.mocked(gitBranchDiff).mockReturnValue(
      new Promise((r) => {
        resolveDiff = r;
      }),
    );
    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalled());
    unmount();
    resolveDiff?.(diffOf("diff --git a/x b/x\n"));
    await flush();
    expect(createAiClient).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("still toasts an empty range while mounted", async () => {
    vi.mocked(gitBranchDiff).mockResolvedValue(diffOf(""));
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "These commits have no combined changes to describe.",
      ),
    );
  });

  it("Cancel still aborts the stream while mounted", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signals[0].aborted).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("generating").textContent).toBe("false"),
    );
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });
});
