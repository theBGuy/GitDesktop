// Negative controls: removing useGenerateSquashMessage's unmount cleanup
// (src/features/history/RewriteDialogs.tsx) leaves the stream's signal live
// after the host unmounts and lets the empty-range toast fire, so the unmount
// cases go red; removing its post-context aborted check builds a client for a
// non-empty diff that settles after unmount. Aborting on every cleanup (the
// host node ignored) turns the tab-hide cases red; dropping SquashDialog's host
// span turns its hide case red; dropping the removal watch turns the no-chunk
// case red.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, createElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SquashDialog,
  useGenerateSquashMessage,
} from "@/features/history/RewriteDialogs";
import { createAiClient } from "@/lib/ai/client";
import type { AiClient } from "@/lib/ai/types";
import {
  gitBranchDiff,
  gitRecentCommits,
  readRepoInstructions,
} from "@/lib/git/api";
import type { StagedDiff } from "@/lib/git/types";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { type Feed, feedingClient } from "./ai-feed-client";

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
  useUiStore.setState({ repoPath: "/repo" });
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

let feeds: Feed[] = [];
const feedClient = feedingClient(
  (signal) => signals.push(signal),
  (feed) => feeds.push(feed),
);

const inTab = (shown: boolean, child: ReactNode) =>
  createElement(Activity, {
    mode: shown ? "visible" : "hidden",
    children: child,
  });

function HostedHarness({ onText }: { onText: (message: string) => void }) {
  const { generate, generating, hostRef } = useGenerateSquashMessage(
    "/repo",
    onText,
  );
  return (
    <>
      <span hidden ref={hostRef} />
      <button type="button" onClick={() => void generate("base", "head")}>
        Generate
      </button>
      <output data-testid="generating">{String(generating)}</output>
    </>
  );
}

describe("squash message generation through a tab hide", () => {
  beforeEach(() => {
    feeds = [];
    vi.mocked(createAiClient).mockResolvedValue(feedClient);
  });

  it("keeps streaming while hidden and lands the whole message", async () => {
    const onText = vi.fn();
    const view = render(inTab(true, <HostedHarness onText={onText} />));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(feeds).toHaveLength(1));
    view.rerender(inTab(false, <HostedHarness onText={onText} />));
    expect(signals[0].aborted).toBe(false);
    await act(async () => feeds[0].push("Squash "));
    await act(async () => feeds[0].push("the fixups"));
    await act(async () => feeds[0].end());
    view.rerender(inTab(true, <HostedHarness onText={onText} />));
    expect(onText).toHaveBeenLastCalledWith("Squash the fixups");
    await waitFor(() =>
      expect(screen.getByTestId("generating").textContent).toBe("false"),
    );
    expect(signals[0].aborted).toBe(false);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("stops when the shown host unmounts", async () => {
    const view = render(inTab(true, <HostedHarness onText={vi.fn()} />));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(feeds).toHaveLength(1));
    view.unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it("stops once the hidden host is removed, with no chunk to notice it", async () => {
    const onText = vi.fn();
    const view = render(inTab(true, <HostedHarness onText={onText} />));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(feeds).toHaveLength(1));
    view.rerender(inTab(false, <HostedHarness onText={onText} />));
    view.rerender(inTab(false, null));
    await flush();
    expect(signals[0].aborted).toBe(true);
    await act(async () => feeds[0].push("orphaned"));
    expect(onText).not.toHaveBeenCalled();
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("stops a run whose repository is no longer the open one", async () => {
    const onText = vi.fn();
    render(inTab(true, <HostedHarness onText={onText} />));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(feeds).toHaveLength(1));
    act(() => useUiStore.setState({ repoPath: "/other" }));
    await act(async () => feeds[0].push("for the old repo"));
    expect(signals[0].aborted).toBe(true);
    expect(onText).not.toHaveBeenCalled();
    await flush();
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("toasts nothing when a read rejects after the hidden host is removed", async () => {
    let failDiff: ((e: Error) => void) | undefined;
    vi.mocked(gitBranchDiff).mockReturnValue(
      new Promise((_, reject) => {
        failDiff = reject;
      }),
    );
    const view = render(inTab(true, <HostedHarness onText={vi.fn()} />));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(gitBranchDiff).toHaveBeenCalled());
    view.rerender(inTab(false, <HostedHarness onText={vi.fn()} />));
    view.rerender(inTab(false, null));
    await act(async () => failDiff?.(new Error("repository gone")));
    await flush();
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(createAiClient).not.toHaveBeenCalled();
  });

  it("opens no stream when the hidden host goes while the client builds", async () => {
    let finishClient: ((client: AiClient) => void) | undefined;
    vi.mocked(createAiClient).mockReturnValue(
      new Promise((r) => {
        finishClient = r;
      }),
    );
    const view = render(inTab(true, <HostedHarness onText={vi.fn()} />));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(createAiClient).toHaveBeenCalled());
    view.rerender(inTab(false, <HostedHarness onText={vi.fn()} />));
    view.rerender(inTab(false, null));
    await act(async () => finishClient?.(feedClient));
    await flush();
    expect(signals).toHaveLength(0);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });
});

function SquashHost() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <SquashDialog
      repoPath="/repo"
      base={"f".repeat(40)}
      steps={[{ hashes: ["a".repeat(40), "b".repeat(40)] }]}
      count={2}
      defaultMessage="First"
      open
      onOpenChange={(next) => setOpen(next)}
      onDone={vi.fn()}
    />
  );
}

describe("SquashDialog's generation", () => {
  beforeEach(() => {
    feeds = [];
    vi.mocked(createAiClient).mockResolvedValue(feedClient);
  });

  function renderInTab() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (shown: boolean) => (
      <QueryClientProvider client={client}>
        {inTab(shown, <SquashHost />)}
      </QueryClientProvider>
    );
    const view = render(tree(true));
    return { setShown: (shown: boolean) => view.rerender(tree(shown)) };
  }

  it("fills the message through a tab hide", async () => {
    const tab = renderInTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Generate/ }),
    );
    await waitFor(() => expect(feeds).toHaveLength(1));
    tab.setShown(false);
    expect(signals[0].aborted).toBe(false);
    await act(async () => feeds[0].push("Squash the fixups"));
    await act(async () => feeds[0].end());
    tab.setShown(true);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Commit message" }),
      ).toHaveValue("Squash the fixups"),
    );
  });

  it("stops the stream when the dialog closes", async () => {
    renderInTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Generate/ }),
    );
    await waitFor(() => expect(feeds).toHaveLength(1));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(signals[0].aborted).toBe(true);
  });
});
