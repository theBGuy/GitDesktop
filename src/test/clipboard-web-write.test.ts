import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FAILED, copyText, writeClipboard } from "@/lib/clipboard";
import { isWindows } from "@/lib/hotkeys/binding";

// The binding module stays unmocked: jsdom's empty platform is the macOS/Linux
// app's branch, where the web API keeps writing.
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async () => undefined),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const pluginWrite = vi.mocked(writeText);
const webWrite = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: webWrite },
    configurable: true,
  });
  vi.stubGlobal("isTauri", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("writeClipboard inside Tauri off Windows", () => {
  it("runs under the not-Windows premise", () => {
    expect(isWindows).toBe(false);
  });

  it("writes the identical string through the web API", async () => {
    const input = "#!/bin/sh\nset -e\n\nexit 0\n";
    await writeClipboard(input);
    expect(webWrite).toHaveBeenCalledTimes(1);
    expect(webWrite).toHaveBeenCalledWith(input);
    expect(pluginWrite).not.toHaveBeenCalled();
  });

  it("copyText toasts its message on success", async () => {
    expect(await copyText("abc", "Commit hash copied")).toBe(true);
    expect(webWrite).toHaveBeenCalledWith("abc");
    expect(pluginWrite).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Commit hash copied");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("copyText toasts the copy failure when the web write rejects", async () => {
    webWrite.mockRejectedValueOnce(new Error("denied"));
    expect(await copyText("abc", "Commit hash copied")).toBe(false);
    expect(pluginWrite).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(COPY_FAILED);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
