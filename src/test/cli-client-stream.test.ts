import { describe, expect, it, vi } from "vitest";
import { type ReviewEvent, runAgentReview } from "@/lib/ai/agent";
import { createCliClient } from "@/lib/ai/cli-client";
import type { AiSettings } from "@/lib/ai/types";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentReview: vi.fn(),
  cancelAgentReview: vi.fn(async () => undefined),
}));

const SETTINGS: AiSettings = {
  provider: "opencode-cli",
  model: "opencode/big-pickle",
  ollamaBaseUrl: "",
  openaiCompatibleBaseUrl: "",
};

const delta = (text: string): ReviewEvent => ({ kind: "delta", text });
const done = (text: string): ReviewEvent => ({
  kind: "done",
  text,
  isError: false,
  costUsd: null,
});

/** Runs one generation whose backend pushes `events` and resolves, and returns
 *  every chunk the client yielded, in order. */
async function chunksOf(events: ReviewEvent[]): Promise<string[]> {
  vi.mocked(runAgentReview).mockImplementationOnce(async (args) => {
    for (const ev of events) args.onEvent(ev);
    return events.at(-1) ?? null;
  });
  const chunks: string[] = [];
  for await (const chunk of createCliClient(SETTINGS).stream({
    system: "",
    prompt: "p",
    repoPath: "C:/repo",
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("cli client: the final text's tail", () => {
  it("appends nothing when the final text does not continue the stream", async () => {
    expect(
      await chunksOf([delta("a1"), delta("\n\na2"), done("a1T\n\na2")]),
    ).toEqual(["a1", "\n\na2"]);
  });

  it("appends the tail of a final text that continues the stream", async () => {
    expect(
      await chunksOf([delta("a1"), delta("\n\na2"), done("a1\n\na2X")]),
    ).toEqual(["a1", "\n\na2", "X"]);
  });

  it("yields the whole final text when nothing streamed", async () => {
    expect(await chunksOf([done("whole")])).toEqual(["whole"]);
  });

  it("adds no empty chunk when the final text equals the stream", async () => {
    expect(
      await chunksOf([delta("a1"), delta("\n\na2"), done("a1\n\na2")]),
    ).toEqual(["a1", "\n\na2"]);
  });

  it("appends nothing when the final text is only the last message", async () => {
    expect(
      await chunksOf([delta("n1"), delta("\n\nfinal"), done("final")]),
    ).toEqual(["n1", "\n\nfinal"]);
  });

  it("yields nothing for an empty final text with no stream", async () => {
    expect(await chunksOf([done("")])).toEqual([]);
  });
});
