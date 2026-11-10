import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openWithDefault } from "@/lib/git/api/desktop";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

const PATH = "C:\\repo\\tools\\x.bat";
const REFUSED = {
  kind: "defaultOpenRefused",
  message: "x.bat isn't opened with its default program because it would run.",
  name: "x.bat",
};
const NOTICE =
  "x.bat wasn't opened: its default program could run it. Show it in Explorer instead.";

type ToastOptions = {
  action?: { label: string; onClick: (event: unknown) => void };
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  for (const fn of Object.values(toast)) vi.mocked(fn).mockClear();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("openWithDefault's refusal arm", () => {
  it("answers the refused kind with one notice offering Show in Explorer, and resolves", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(REFUSED);
    await expect(openWithDefault(PATH)).resolves.toBeUndefined();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [text, options] = vi.mocked(toast.warning).mock.calls[0] as [
      string,
      ToastOptions,
    ];
    expect(text).toBe(NOTICE);
    expect(options.action?.label).toBe("Show in Explorer");
    expect(toast.error).not.toHaveBeenCalled();

    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    options.action?.onClick({});
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke).mock.calls[1]).toEqual([
      "reveal_in_explorer",
      { path: PATH },
    ]);
  });

  it("rejects any other failure to the caller without a notice", async () => {
    const io = { kind: "io", message: "io error: no association" };
    vi.mocked(invoke).mockRejectedValueOnce(io);
    await expect(openWithDefault(PATH)).rejects.toBe(io);
    const plain = new Error("boom");
    vi.mocked(invoke).mockRejectedValueOnce(plain);
    await expect(openWithDefault(PATH)).rejects.toBe(plain);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("opens without a notice when the backend accepts the path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await expect(
      openWithDefault("C:\\repo\\notes.txt"),
    ).resolves.toBeUndefined();
    expect(vi.mocked(invoke).mock.calls[0][1]).toEqual({
      path: "C:\\repo\\notes.txt",
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
