import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAiClient,
  ModelRefusalError,
  runAgenticStream,
} from "@/lib/ai/client";
import { streamAi } from "@/lib/ai/stream";
import type { AiSettings } from "@/lib/ai/types";

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));
vi.mock("@/lib/git/api", () => ({
  getSecret: async () => "test-key",
  gitFetchObjects: async () => undefined,
  gitRemoveWorktree: async () => undefined,
  gitReviewWorktree: async () => undefined,
}));
vi.mock("@/lib/ai/model-factory", () => ({ createModel: () => ({}) }));

const REFUSED =
  "The model declined to review this change (content-filter). Try again, or choose a different model.";

const settings = { provider: "openai", model: "m" } as AiSettings;

type Part = Record<string, unknown>;

function streamOf(parts: Part[]) {
  streamTextMock.mockReturnValue({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
}

function run(abortSignal = new AbortController().signal) {
  const texts: string[] = [];
  const promise = runAgenticStream({
    settings,
    system: "s",
    prompt: "p",
    tools: {},
    abortSignal,
    setText: (t) => texts.push(t),
    setStatus: () => undefined,
  });
  return { promise, texts };
}

const text = (t: string): Part[] => [
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", text: t },
  { type: "text-end", id: "1" },
];

describe("runAgenticStream refusal guard", () => {
  beforeEach(() => streamTextMock.mockReset());

  it("rejects a content-filter finish that streamed refusal text, and clears the text", async () => {
    streamOf([
      ...text("I can't help with that."),
      { type: "finish", finishReason: "content-filter" },
    ]);
    const { promise, texts } = run();
    await expect(promise).rejects.toThrow(REFUSED);
    await expect(promise).rejects.toBeInstanceOf(ModelRefusalError);
    expect(texts.at(-1)).toBe("");
  });

  it("rejects a content-filter finish with no text", async () => {
    streamOf([{ type: "finish", finishReason: "content-filter" }]);
    await expect(run().promise).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("resolves a normal stop with its text", async () => {
    streamOf([
      ...text("Looks good."),
      { type: "finish", finishReason: "stop" },
    ]);
    const { promise, texts } = run();
    await expect(promise).resolves.toBeUndefined();
    expect(texts.at(-1)).toBe("Looks good.");
  });

  it("returns without throwing when aborted, even after a content-filter finish", async () => {
    const ac = new AbortController();
    ac.abort();
    streamOf([
      { type: "finish", finishReason: "content-filter" },
      { type: "abort" },
    ]);
    await expect(run(ac.signal).promise).resolves.toBeUndefined();
  });

  it("treats a cancel after the finish part as a cancel (no abort part)", async () => {
    const ac = new AbortController();
    ac.abort();
    streamOf([
      ...text("I can't help with that."),
      { type: "finish", finishReason: "content-filter" },
    ]);
    const { promise, texts } = run(ac.signal);
    await expect(promise).resolves.toBeUndefined();
    expect(texts).not.toContain("");
  });
});

async function drain(
  signal: AbortSignal | undefined,
  rejectRefusal: boolean | undefined,
) {
  const client = await createAiClient(settings);
  const chunks: string[] = [];
  const done = (async () => {
    for await (const c of client.stream({
      system: "s",
      prompt: "p",
      abortSignal: signal,
      rejectRefusal,
    }))
      chunks.push(c);
  })();
  return { done, chunks };
}

const refusal = (): Part[] => [
  ...text("I can't help with that."),
  { type: "finish", finishReason: "content-filter" },
];

describe("client.stream rejectRefusal", () => {
  beforeEach(() => streamTextMock.mockReset());

  it("rejects with ModelRefusalError after yielding the text when opted in", async () => {
    streamOf(refusal());
    const { done, chunks } = await drain(undefined, true);
    await expect(done).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(done).rejects.toThrow(REFUSED);
    expect(chunks.join("")).toBe("I can't help with that.");
  });

  it("completes and yields the text without the flag", async () => {
    streamOf(refusal());
    const { done, chunks } = await drain(undefined, undefined);
    await expect(done).resolves.toBeUndefined();
    expect(chunks.join("")).toBe("I can't help with that.");
  });

  it("lets an abort win over a content-filter finish", async () => {
    const ac = new AbortController();
    ac.abort();
    streamOf([...refusal(), { type: "abort" }]);
    const { done } = await drain(ac.signal, true);
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reads a cancel after the finish part as a cancel (no abort part)", async () => {
    const ac = new AbortController();
    ac.abort();
    streamOf(refusal());
    const { done } = await drain(ac.signal, true);
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    await expect(done).rejects.not.toBeInstanceOf(ModelRefusalError);
  });
});

describe("streamAi single-pass review refusal", () => {
  beforeEach(() => streamTextMock.mockReset());

  function runStreamAi(rejectRefusal?: boolean) {
    const texts: string[] = [];
    const promise = streamAi({
      ai: settings,
      system: "s",
      prompt: "p",
      repoPath: "/r",
      rejectRefusal,
      setText: (x) => texts.push(x),
      setStatus: () => undefined,
      onAbort: () => undefined,
      onCliId: () => undefined,
    });
    return { promise, texts };
  }

  it("clears the streamed text and rejects with ModelRefusalError", async () => {
    streamOf(refusal());
    const { promise, texts } = runStreamAi(true);
    await expect(promise).rejects.toBeInstanceOf(ModelRefusalError);
    expect(texts).toContain("I can't help with that.");
    expect(texts.at(-1)).toBe("");
  });

  it("keeps the refusal text when the caller did not opt in", async () => {
    streamOf(refusal());
    const { promise, texts } = runStreamAi();
    await expect(promise).resolves.toBeUndefined();
    expect(texts.at(-1)).toBe("I can't help with that.");
  });

  it("keeps a normal stop's text", async () => {
    streamOf([
      ...text("Looks good."),
      { type: "finish", finishReason: "stop" },
    ]);
    const { promise, texts } = runStreamAi();
    await expect(promise).resolves.toBeUndefined();
    expect(texts.at(-1)).toBe("Looks good.");
  });
});

// Source-shape pin: the opt-in is a one-line literal that no behaviour test reaches.
function callBody(source: string, opener: string): string | null {
  const at = source.indexOf(opener);
  if (at < 0) return null;
  const open = source.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(open, i);
  }
  return null;
}

const OPT_IN = /\brejectRefusal: true\b/;
const REVIEWS = "src/lib/stores/reviews.ts";
const RUNNER = "src/lib/automations/runner.ts";

function optsIn(source: string, opener: string): boolean {
  const body = callBody(source, opener);
  return body !== null && OPT_IN.test(body);
}

describe("rejectRefusal opt-in sites", () => {
  it("the review store's streamAi call and the runner's client.stream call opt in", () => {
    expect(optsIn(readFileSync(REVIEWS, "utf8"), "await streamAi(")).toBe(true);
    expect(optsIn(readFileSync(RUNNER, "utf8"), "client.stream(")).toBe(true);
  });

  it("a removed opt-in line fails the matcher", () => {
    const strip = (s: string) =>
      s.replace(/^.*rejectRefusal: true,?\r?\n/m, "");
    expect(
      optsIn(strip(readFileSync(REVIEWS, "utf8")), "await streamAi("),
    ).toBe(false);
    expect(optsIn(strip(readFileSync(RUNNER, "utf8")), "client.stream(")).toBe(
      false,
    );
  });

  it("no other src file opts in", () => {
    const hits = (
      readdirSync("src", { recursive: true, encoding: "utf8" }) as string[]
    )
      .map((f) => f.replaceAll("\\", "/"))
      .filter((f) => /\.tsx?$/.test(f) && !f.startsWith("test/"))
      .filter((f) => OPT_IN.test(readFileSync(`src/${f}`, "utf8")))
      .sort();
    expect(hits).toEqual([
      "lib/automations/runner.ts",
      "lib/stores/reviews.ts",
    ]);
  });
});
