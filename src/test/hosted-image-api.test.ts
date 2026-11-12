import { afterEach, describe, expect, it, vi } from "vitest";
import { ghHostedImage, type HostedImage } from "@/lib/hosted-images/api";
import { invoke } from "@/lib/tauri/invoke";

// The api module's one seam: no test reaches Rust.
vi.mock("@/lib/tauri/invoke", () => ({ invoke: vi.fn() }));

const READ = "github_hosted_image";
const CANCEL = "github_hosted_image_cancel";
const REPO = "C:/repos/demo";
const URL1 =
  "https://github.com/user-attachments/assets/c162f463-c831-4173-8a80-4197acc4a8ac";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAILED: HostedImage = { bytes: null, unavailable: "failed" };

/** Answers the read command with a promise the test settles, and the cancel
 *  command with `cancel`. */
function backend(cancel: () => Promise<unknown> = async () => undefined) {
  let answer: (v: HostedImage) => void = () => undefined;
  vi.mocked(invoke).mockImplementation(((cmd: string) =>
    cmd === READ
      ? new Promise<HostedImage>((r) => {
          answer = r;
        })
      : cancel()) as typeof invoke);
  return (v: HostedImage) => answer(v);
}

const calls = () => vi.mocked(invoke).mock.calls;
const commands = () => calls().map((c) => c[0]);

afterEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("ghHostedImage", () => {
  it("asks the read command with a lowercase uuid request id", async () => {
    const answer = backend();
    const read = ghHostedImage(REPO, URL1);
    answer(FAILED);
    await expect(read).resolves.toEqual(FAILED);
    expect(calls()).toHaveLength(1);
    const [cmd, args] = calls()[0];
    expect(cmd).toBe(READ);
    expect(args).toEqual({
      repoPath: REPO,
      url: URL1,
      requestId: expect.any(String),
    });
    expect((args as { requestId: string }).requestId).toMatch(UUID);
  });

  it("mints a new request id per call", async () => {
    const answer = backend();
    const a = ghHostedImage(REPO, URL1);
    answer(FAILED);
    await a;
    const b = ghHostedImage(REPO, URL1);
    answer(FAILED);
    await b;
    const ids = calls().map((c) => (c[1] as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("an abort while pending withdraws the read once and settles with its answer", async () => {
    const answer = backend();
    const controller = new AbortController();
    let settled = false;
    const read = ghHostedImage(REPO, URL1, controller.signal).then((v) => {
      settled = true;
      return v;
    });
    controller.abort();
    controller.abort();
    await Promise.resolve();
    expect(commands()).toEqual([READ, CANCEL]);
    const id = (calls()[0][1] as { requestId: string }).requestId;
    expect(calls()[1][1]).toEqual({ requestId: id });
    // It keeps awaiting the read: the withdrawn read's own answer settles it.
    expect(settled).toBe(false);
    answer(FAILED);
    await expect(read).resolves.toEqual(FAILED);
    expect(commands()).toEqual([READ, CANCEL]);
  });

  it("an abort after the read settled sends nothing", async () => {
    const answer = backend();
    const controller = new AbortController();
    const read = ghHostedImage(REPO, URL1, controller.signal);
    answer(FAILED);
    await read;
    controller.abort();
    await Promise.resolve();
    expect(commands()).toEqual([READ]);
  });

  it("a signal aborted at call time rejects with its reason and invokes nothing", async () => {
    backend();
    const controller = new AbortController();
    const reason = new Error("left");
    controller.abort(reason);
    await expect(ghHostedImage(REPO, URL1, controller.signal)).rejects.toBe(
      reason,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows a rejected cancel", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const answer = backend(async () => {
        throw new Error("ipc");
      });
      const controller = new AbortController();
      const read = ghHostedImage(REPO, URL1, controller.signal);
      controller.abort();
      answer(FAILED);
      await expect(read).resolves.toEqual(FAILED);
      await new Promise((r) => setTimeout(r, 0));
      expect(commands()).toEqual([READ, CANCEL]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
