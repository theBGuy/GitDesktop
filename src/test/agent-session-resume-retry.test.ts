import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentSessionArgs,
  cancelAgentSession,
  isResumeMiss,
  type ReviewEvent,
  resumeMissNote,
  runAgentSession,
} from "@/lib/ai/agent";
import { invoke } from "@/lib/tauri/invoke";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => undefined;
  },
}));
vi.mock("@/lib/tauri/invoke", () => ({ invoke: vi.fn() }));

/** One scripted `agent_session` call: `before` goes out on the channel at once,
 *  `after` once `wait` settles, then the call rejects or resolves `returned`. */
interface Script {
  before?: ReviewEvent[];
  wait?: Promise<void>;
  after?: ReviewEvent[];
  returned?: ReviewEvent | null;
  reject?: Error;
}

const SID = "d81ccead-3501-4eb3-bf30-7ee29543d3b2";
const OTHER = "4c7d1e9a-2b3f-4e6a-9d8c-5f0a1b2c3d4e";
const RUN = "run-0001";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let scripts: Script[] = [];
let cancelReply: () => Promise<void> = async () => undefined;

async function fakeInvoke(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  calls.push({ cmd, args });
  if (cmd === "agent_review_cancel") return cancelReply();
  if (cmd !== "agent_session") throw new Error(`unexpected command ${cmd}`);
  const script = scripts.shift();
  if (!script) throw new Error("no scripted agent_session call left");
  const channel = args.onEvent as { onmessage: (event: ReviewEvent) => void };
  for (const event of script.before ?? []) channel.onmessage(event);
  if (script.wait) await script.wait;
  for (const event of script.after ?? []) channel.onmessage(event);
  if (script.reject) throw script.reject;
  return script.returned ?? null;
}

beforeEach(() => {
  calls.length = 0;
  scripts = [];
  cancelReply = async () => undefined;
  vi.mocked(invoke).mockImplementation(fakeInvoke as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A turn whose terminal goes out on the channel and is also returned. */
const turn = (terminal: ReviewEvent, before: ReviewEvent[] = []): Script => ({
  before: [...before, terminal],
  returned: terminal,
});

type DoneEvent = Extract<ReviewEvent, { kind: "done" }>;
type ErrorEvent = Extract<ReviewEvent, { kind: "error" }>;

const claudeMiss = (id = SID): DoneEvent => ({
  kind: "done",
  text: `No conversation found with session ID: ${id}`,
  isError: true,
  costUsd: 0,
});

/** Copilot CLI 1.0.105's stderr for `--resume <unknown id>`, as the backend
 *  forwards it. */
const copilotMiss = (id = SID, eol = "\n", lead = "Error: "): ErrorEvent => ({
  kind: "error",
  message: [
    `${lead}No session, task, or name matched '${id}'.`,
    "",
    "To resume by session or task ID:  copilot --resume=<id>",
    "To start a new session with ID:   copilot --session-id=<valid-uuid>",
  ].join(eol),
  partialText: null,
  timedOut: false,
});

const ok: ReviewEvent = {
  kind: "done",
  text: "answer",
  isError: false,
  costUsd: 0.01,
};
const status: ReviewEvent = { kind: "status", text: "Starting" };
const delta: ReviewEvent = { kind: "delta", text: "partial" };
const tool: ReviewEvent = { kind: "tool", tool: "read", target: "a.ts" };
const notice = (label: string): ReviewEvent => ({
  kind: "notice",
  code: "nativeSessionReset",
  text: resumeMissNote(label),
});

function sessionArgs(
  events: ReviewEvent[],
  over: Partial<AgentSessionArgs> = {},
): AgentSessionArgs {
  return {
    agent: "claude",
    binPath: null,
    model: "",
    effort: "",
    systemPrompt: "",
    userPrompt: "next",
    worktreePath: "C:/wt/gd-session-1",
    sessionId: SID,
    runId: RUN,
    resume: true,
    readOnly: false,
    isolation: "host",
    nativeSessionId: null,
    onEvent: (event) => events.push(event),
    ...over,
  };
}

/** Each `agent_session` call's arguments, without its channel. */
const sessionCalls = () =>
  calls
    .filter((c) => c.cmd === "agent_session")
    .map(({ args: { onEvent: _channel, ...rest } }) => rest);
const cancelCalls = () => calls.filter((c) => c.cmd === "agent_review_cancel");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("a resume whose conversation does not exist", () => {
  it.each([
    ["Claude", "claude" as const, claudeMiss()],
    ["GitHub Copilot", "copilot" as const, copilotMiss()],
    ["GitHub Copilot", "copilot" as const, copilotMiss(SID, "\r\n")],
    ["GitHub Copilot", "copilot" as const, copilotMiss(SID, "\n", "")],
  ])(
    "%s holds the miss and runs once as a first turn",
    async (label, agent, miss) => {
      scripts = [turn(miss, [status]), turn(ok, [delta])];
      const events: ReviewEvent[] = [];
      const result = await runAgentSession(sessionArgs(events, { agent }));
      expect(result).toEqual(ok);
      expect(events).toEqual([status, notice(label), delta, ok]);
      const [first, second] = sessionCalls();
      expect(sessionCalls()).toHaveLength(2);
      expect(first.resume).toBe(true);
      expect(second).toEqual({ ...first, resume: false });
    },
  );

  it("retries after status and notice events only", async () => {
    const earlier: ReviewEvent = { kind: "notice", code: "other", text: "x" };
    scripts = [turn(claudeMiss(), [status, earlier]), turn(ok)];
    const events: ReviewEvent[] = [];
    expect(await runAgentSession(sessionArgs(events))).toEqual(ok);
    expect(events).toEqual([status, earlier, notice("Claude"), ok]);
  });

  it("retries after an empty delta", async () => {
    const empty: ReviewEvent = { kind: "delta", text: "" };
    scripts = [turn(claudeMiss(), [empty]), turn(ok)];
    const events: ReviewEvent[] = [];
    expect(await runAgentSession(sessionArgs(events))).toEqual(ok);
    expect(events).toEqual([empty, notice("Claude"), ok]);
    expect(sessionCalls()).toHaveLength(2);
  });

  it("delivers the second attempt's own miss and never invokes a third time", async () => {
    scripts = [turn(claudeMiss()), turn(claudeMiss())];
    const events: ReviewEvent[] = [];
    expect(await runAgentSession(sessionArgs(events))).toEqual(claudeMiss());
    expect(events).toEqual([claudeMiss()]);
    expect(sessionCalls()).toHaveLength(2);
  });

  it("holds a miss the command only returned, once the gate replays it", async () => {
    vi.useFakeTimers();
    scripts = [{ returned: claudeMiss() }, turn(ok)];
    const events: ReviewEvent[] = [];
    const run = runAgentSession(sessionArgs(events));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await run).toEqual(ok);
    expect(events).toEqual([notice("Claude"), ok]);
    expect(sessionCalls()).toHaveLength(2);
  });

  it("still runs the second attempt when the consumer throws on the notice", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    scripts = [turn(claudeMiss()), turn(ok)];
    const events: ReviewEvent[] = [];
    const result = await runAgentSession(
      sessionArgs([], {
        onEvent: (event) => {
          if (event.kind === "notice") throw new Error("boom");
          events.push(event);
        },
      }),
    );
    expect(result).toEqual(ok);
    expect(events).toEqual([ok]);
    expect(logged).toHaveBeenCalledWith(
      "[agent] event handler failed",
      expect.any(Error),
    );
    expect(sessionCalls()).toHaveLength(2);
  });

  it("propagates a first attempt's rejection and drops the held miss", async () => {
    scripts = [
      { before: [claudeMiss()], reject: new Error("ipc failed") },
      turn(ok),
    ];
    const events: ReviewEvent[] = [];
    await expect(runAgentSession(sessionArgs(events))).rejects.toThrow(
      "ipc failed",
    );
    expect(events).toEqual([]);
    expect(sessionCalls()).toHaveLength(1);
  });
});

describe("the reset notice", () => {
  it("goes out just ahead of the second attempt's first delta", async () => {
    scripts = [turn(claudeMiss()), turn(ok, [delta])];
    const events: ReviewEvent[] = [];
    expect(await runAgentSession(sessionArgs(events))).toEqual(ok);
    expect(events).toEqual([notice("Claude"), delta, ok]);
  });

  it("is not sent when the second attempt returns nothing", async () => {
    scripts = [turn(claudeMiss()), { returned: null }];
    const events: ReviewEvent[] = [];
    expect(await runAgentSession(sessionArgs(events))).toBeNull();
    expect(events).toEqual([]);
    expect(sessionCalls()).toHaveLength(2);
  });

  it("is not sent when the second attempt fails at once", async () => {
    const inUse: ReviewEvent = {
      kind: "done",
      text: `Error: Session ID ${SID} is already in use.`,
      isError: true,
      costUsd: null,
    };
    scripts = [turn(claudeMiss()), turn(inUse)];
    const events: ReviewEvent[] = [];
    expect(await runAgentSession(sessionArgs(events))).toEqual(inUse);
    expect(events).toEqual([inUse]);
  });

  it("is not sent when the second attempt rejects", async () => {
    scripts = [turn(claudeMiss()), { reject: new Error("refused") }];
    const events: ReviewEvent[] = [];
    await expect(runAgentSession(sessionArgs(events))).rejects.toThrow(
      "refused",
    );
    expect(events).toEqual([]);
  });

  it("precedes a success the second attempt only returned", async () => {
    vi.useFakeTimers();
    scripts = [turn(claudeMiss()), { returned: ok }];
    const events: ReviewEvent[] = [];
    const run = runAgentSession(sessionArgs(events));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await run).toEqual(ok);
    expect(events).toEqual([notice("Claude"), ok]);
  });
});

describe("no retry", () => {
  it.each<[string, Partial<AgentSessionArgs>, Script]>([
    ["a Claude fork", { fork: true }, turn(claudeMiss())],
    ["a Copilot fork", { agent: "copilot", fork: true }, turn(copilotMiss())],
    ["a Claude first turn", { resume: false }, turn(claudeMiss())],
    [
      "a Copilot first turn",
      { agent: "copilot", resume: false },
      turn(copilotMiss()),
    ],
    ["Codex", { agent: "codex" }, turn(claudeMiss())],
    ["Codex, Copilot's sentence", { agent: "codex" }, turn(copilotMiss())],
    ["opencode", { agent: "opencode" }, turn(claudeMiss())],
    ["a Claude miss naming another id", {}, turn(claudeMiss(OTHER))],
    [
      "a Claude miss that is not an error",
      {},
      turn({ ...claudeMiss(), isError: false }),
    ],
    [
      "a Claude miss as an error event",
      {},
      turn({
        kind: "error",
        message: `No conversation found with session ID: ${SID}`,
        partialText: null,
        timedOut: false,
      }),
    ],
    [
      "a Claude miss with extra text",
      {},
      turn({
        ...claudeMiss(),
        text: `No conversation found with session ID: ${SID}\nmore`,
      }),
    ],
    [
      "a Copilot sentence on line 2",
      { agent: "copilot" },
      turn({
        kind: "error",
        message: `Warning: x\nError: No session, task, or name matched '${SID}'.`,
        partialText: null,
        timedOut: false,
      }),
    ],
    [
      "a Copilot sentence as a done",
      { agent: "copilot" },
      turn({
        kind: "done",
        text: `Error: No session, task, or name matched '${SID}'.`,
        isError: true,
        costUsd: null,
      }),
    ],
    [
      "a Copilot miss naming another id",
      { agent: "copilot" },
      turn(copilotMiss(OTHER)),
    ],
    [
      "a timed-out Copilot error",
      { agent: "copilot" },
      turn({ ...copilotMiss(), timedOut: true }),
    ],
    ["a Claude miss after a delta", {}, turn(claudeMiss(), [delta])],
    ["a Claude miss after a tool step", {}, turn(claudeMiss(), [tool])],
    [
      "a Copilot miss after a delta",
      { agent: "copilot" },
      turn(copilotMiss(), [delta]),
    ],
  ])("%s takes today's path", async (_name, over, script) => {
    scripts = [script, turn(ok)];
    const events: ReviewEvent[] = [];
    const result = await runAgentSession(sessionArgs(events, over));
    expect(result).toEqual(script.returned);
    expect(events).toEqual(script.before);
    expect(sessionCalls()).toHaveLength(1);
  });
});

describe("a Stop around the retry", () => {
  it.each([
    ["before the miss arrived", false],
    ["after the miss arrived", true],
  ])("sent %s ends the turn with no second attempt", async (_name, early) => {
    const gate = deferred();
    scripts = [
      early
        ? { before: [claudeMiss()], wait: gate.promise, returned: claudeMiss() }
        : { wait: gate.promise, after: [claudeMiss()], returned: claudeMiss() },
      turn(ok),
    ];
    const events: ReviewEvent[] = [];
    const run = runAgentSession(sessionArgs(events));
    await cancelAgentSession(RUN);
    gate.resolve();
    expect(await run).toBeNull();
    expect(events).toEqual([]);
    expect(sessionCalls()).toHaveLength(1);
    expect(cancelCalls()).toEqual([
      { cmd: "agent_review_cancel", args: { reviewId: RUN } },
    ]);
  });

  it("issued in the same tick as the run still counts", async () => {
    scripts = [turn(claudeMiss()), turn(ok)];
    const run = runAgentSession(sessionArgs([]));
    void cancelAgentSession(RUN);
    expect(await run).toBeNull();
    expect(sessionCalls()).toHaveLength(1);
  });

  it("counts before its own invoke settles", async () => {
    cancelReply = () => new Promise<void>(() => undefined);
    const gate = deferred();
    scripts = [
      { wait: gate.promise, after: [claudeMiss()], returned: claudeMiss() },
      turn(ok),
    ];
    const run = runAgentSession(sessionArgs([]));
    void cancelAgentSession(RUN);
    gate.resolve();
    expect(await run).toBeNull();
    expect(sessionCalls()).toHaveLength(1);
  });

  it("during the second attempt goes out as today", async () => {
    const gate = deferred();
    scripts = [turn(claudeMiss()), { wait: gate.promise, returned: null }];
    const events: ReviewEvent[] = [];
    const run = runAgentSession(sessionArgs(events));
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(2));
    await cancelAgentSession(RUN);
    gate.resolve();
    expect(await run).toBeNull();
    expect(events).toEqual([]);
    expect(cancelCalls()).toEqual([
      { cmd: "agent_review_cancel", args: { reviewId: RUN } },
    ]);
    expect(sessionCalls()[1].runId).toBe(RUN);
  });

  it("leaves no record once the run settles", async () => {
    const gate = deferred();
    scripts = [
      { before: [claudeMiss()], wait: gate.promise, returned: claudeMiss() },
    ];
    const run = runAgentSession(sessionArgs([]));
    await cancelAgentSession(RUN);
    gate.resolve();
    expect(await run).toBeNull();
    // A Stop for a settled run records nothing, so the next run with that id retries.
    await cancelAgentSession(RUN);
    scripts = [turn(claudeMiss()), turn(ok)];
    expect(await runAgentSession(sessionArgs([]))).toEqual(ok);
    scripts = [{ before: [claudeMiss()], reject: new Error("ipc failed") }];
    const rejected = expect(runAgentSession(sessionArgs([]))).rejects.toThrow(
      "ipc failed",
    );
    await cancelAgentSession(RUN);
    await rejected;
    scripts = [turn(claudeMiss()), turn(ok)];
    expect(await runAgentSession(sessionArgs([]))).toEqual(ok);
  });

  it("aimed at an id with no run in flight records nothing", async () => {
    await cancelAgentSession(RUN);
    scripts = [turn(claudeMiss()), turn(ok)];
    expect(await runAgentSession(sessionArgs([]))).toEqual(ok);
    expect(sessionCalls()).toHaveLength(2);
  });
});

describe("isResumeMiss", () => {
  it("reads only the probed sentences", () => {
    expect(isResumeMiss("claude", SID, claudeMiss())).toBe(true);
    expect(isResumeMiss("copilot", SID, copilotMiss())).toBe(true);
    expect(isResumeMiss("copilot", SID, claudeMiss())).toBe(false);
    expect(isResumeMiss("claude", SID, copilotMiss())).toBe(false);
    expect(isResumeMiss("codex", SID, claudeMiss())).toBe(false);
  });
});

describe("the reset note", () => {
  it("reads like the backend's opencode reset note", () => {
    const rust = readFileSync(
      resolve(process.cwd(), "src-tauri/src/agent.rs"),
      "utf8",
    );
    const literal = /const NOTICE_RESET_GENERIC: &str = "([^"]*)";/.exec(
      rust,
    )?.[1];
    expect(literal).toBeTruthy();
    expect(resumeMissNote("opencode")).toBe(literal);
  });
});
