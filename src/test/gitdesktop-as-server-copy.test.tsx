import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GitDesktopAsServer } from "@/features/settings/mcp/GitDesktopAsServer";
import { copyText } from "@/lib/clipboard";
import { unmockedCommands } from "./setup";

const LAUNCHER = "C:/launcher/gitdesktop-mcp.exe";

vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyText: vi.fn(),
}));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  mcpLauncherPath: vi.fn(async () => LAUNCHER),
  mcpGlobalStatus: vi.fn(async () => ({})),
  pathLauncherStatus: vi.fn(async () => ({
    onPath: false,
    managed: false,
    warning: null,
    note: null,
  })),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Opens the disclosure, waits for the launcher path, presses Copy. */
async function pressCopy(user = userEvent.setup()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GitDesktopAsServer repoPath="C:/repo" />
    </QueryClientProvider>,
  );
  await user.click(
    screen.getByRole("button", { name: /Use GitDesktop as an MCP server/ }),
  );
  // Copy is held until the launcher path resolves into the snippet.
  await screen.findByText(new RegExp(LAUNCHER));
  await user.click(screen.getByRole("button", { name: /^Copy$/ }));
  // Let the awaited copy settle before the caller reads the button.
  await act(() => Promise.resolve());
  return user;
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("GitDesktopAsServer Copy", () => {
  it("shows Copied after a copy that landed", async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    await pressCopy();
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Copied/ })).toBeTruthy();
  });

  it("never shows Copied after a copy that failed", async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    await pressCopy();
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Copied/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Copy$/ })).toBeTruthy();
  });

  it("keeps Copied for the full window after a second copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(copyText).mockResolvedValue(true);
    const user = await pressCopy(
      userEvent.setup({ advanceTimers: vi.advanceTimersByTime }),
    );
    await advance(1000);
    await user.click(screen.getByRole("button", { name: /^Cop(y|ied)$/ }));
    await act(() => Promise.resolve());
    expect(copyText).toHaveBeenCalledTimes(2);
    await advance(700);
    expect(screen.queryByRole("button", { name: /Copied/ })).not.toBeNull();
    await advance(900);
    expect(screen.queryByRole("button", { name: /Copied/ })).toBeNull();
  });
});
