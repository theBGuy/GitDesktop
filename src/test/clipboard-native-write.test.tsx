import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorDialog } from "@/features/errors/ErrorDialog";
import { COPY_FAILED, copyText, writeClipboard } from "@/lib/clipboard";
import { presentError } from "@/lib/error-summary";
import { isWindows } from "@/lib/hotkeys/binding";
import { useErrorDialog } from "@/lib/stores/error-dialog";
import { errorToastAction } from "@/lib/toast";

// `isWindows` is read once at import, and jsdom's empty platform reads as not
// Windows, so the native branch needs the detector mocked.
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  isWindows: true,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async () => undefined),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

const pluginWrite = vi.mocked(writeText);
const webWrite = vi.fn(async (_text: string) => undefined);

function stubWebClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: webWrite },
    configurable: true,
  });
}

/** A plugin write the test settles by hand. */
function heldPluginWrite() {
  let resolve!: () => void;
  pluginWrite.mockReturnValueOnce(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  return () => resolve();
}

const INPUTS: Record<string, string> = {
  "multi-line LF with a trailing newline": "#!/bin/sh\nset -e\n\nexit 0\n",
  "text already holding CRLF": "a\r\nb",
  "non-ASCII": "é ✓ 日本 🙂\n",
  "the empty string": "",
  "a 40-hex hash": "0123456789abcdef0123456789abcdef01234567",
};

beforeEach(() => {
  stubWebClipboard();
});

afterEach(() => {
  cleanup();
  act(() => useErrorDialog.getState().close());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("writeClipboard on Windows inside Tauri", () => {
  beforeEach(() => {
    vi.stubGlobal("isTauri", true);
  });

  it("runs under the Windows premise", () => {
    expect(isWindows).toBe(true);
  });

  for (const [name, input] of Object.entries(INPUTS)) {
    it(`hands the plugin ${name} unchanged`, async () => {
      await writeClipboard(input);
      expect(pluginWrite).toHaveBeenCalledTimes(1);
      expect(pluginWrite).toHaveBeenCalledWith(input);
      expect(pluginWrite.mock.calls[0][0] === input).toBe(true);
      expect(webWrite).not.toHaveBeenCalled();
    });
  }

  it("rejects when the plugin rejects, without a web fallback", async () => {
    pluginWrite.mockRejectedValueOnce(new Error("denied"));
    await expect(writeClipboard("x\n")).rejects.toThrow("denied");
    expect(webWrite).not.toHaveBeenCalled();
  });
});

describe("writeClipboard outside Tauri", () => {
  it("writes through the web API even on Windows", async () => {
    const input = INPUTS["multi-line LF with a trailing newline"];
    await writeClipboard(input);
    expect(webWrite).toHaveBeenCalledTimes(1);
    expect(webWrite.mock.calls[0][0] === input).toBe(true);
    expect(pluginWrite).not.toHaveBeenCalled();
  });
});

describe("copyText", () => {
  beforeEach(() => {
    vi.stubGlobal("isTauri", true);
  });

  it("toasts its message on success only", async () => {
    await copyText("abc", "Path copied");
    expect(pluginWrite).toHaveBeenCalledWith("abc");
    expect(toast.success).toHaveBeenCalledWith("Path copied");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts the copy failure on a rejected write only", async () => {
    pluginWrite.mockRejectedValueOnce(new Error("denied"));
    await copyText("abc", "Path copied");
    expect(toast.error).toHaveBeenCalledWith(COPY_FAILED);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("ErrorDialog Copy", () => {
  const first = presentError(new Error("first failure\nwith detail"));
  const other = presentError(new Error("other failure\nwith detail"));
  const copiedButton = () => screen.queryByRole("button", { name: /Copied/ });

  beforeEach(() => {
    vi.stubGlobal("isTauri", true);
  });

  function openOn(presentation = first) {
    render(<ErrorDialog />);
    act(() => useErrorDialog.getState().open(presentation));
  }

  it("writes the shown text and shows Copied", async () => {
    openOn();
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
    expect(pluginWrite).toHaveBeenCalledWith(first.fullText);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps Close as the initial focus", async () => {
    openOn();
    // The footer's Close, beside Copy; the header's X carries the same name.
    const footer = screen.getByRole("button", { name: /^Copy$/ }).parentElement;
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Close");
      expect(footer?.contains(document.activeElement)).toBe(true);
    });
  });

  it("toasts the copy failure and never shows Copied", async () => {
    pluginWrite.mockRejectedValueOnce(new Error("denied"));
    openOn();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    });
    expect(toast.error).toHaveBeenCalledWith(COPY_FAILED);
    expect(copiedButton()).toBeNull();
  });

  it("drops a write that settles after another error opened", async () => {
    const settle = heldPluginWrite();
    openOn();
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    act(() => useErrorDialog.getState().open(other));
    await act(async () => settle());
    expect(screen.getByRole("dialog").textContent).toContain("other failure");
    expect(copiedButton()).toBeNull();
  });

  it("drops a write that settles after the dialog closed", async () => {
    const settle = heldPluginWrite();
    openOn();
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    act(() => useErrorDialog.getState().close());
    await act(async () => settle());
    act(() => useErrorDialog.getState().open(other));
    expect(copiedButton()).toBeNull();
  });
});

describe("the error toast's Copy action", () => {
  beforeEach(() => {
    vi.stubGlobal("isTauri", true);
  });

  function copyAction() {
    const presentation = presentError(new Error("one line"));
    expect(presentation.long).toBe(false);
    const action = errorToastAction(presentation);
    expect(action.label).toBe("Copy");
    return { presentation, action };
  }

  it("writes the full text through the plugin", async () => {
    const { presentation, action } = copyAction();
    await act(async () => {
      action.onClick({ currentTarget: document.createElement("button") });
    });
    expect(pluginWrite).toHaveBeenCalledWith(presentation.fullText);
    expect(webWrite).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts the copy failure on a rejected write", async () => {
    pluginWrite.mockRejectedValueOnce(new Error("denied"));
    const { action } = copyAction();
    await act(async () => {
      action.onClick({ currentTarget: document.createElement("button") });
    });
    expect(toast.error).toHaveBeenCalledWith(COPY_FAILED);
  });
});
