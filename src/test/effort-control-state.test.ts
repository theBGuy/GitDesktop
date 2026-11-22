import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EffortSupport, listAgentEffortLevels } from "@/lib/ai/agent";
import {
  combineEffortStates,
  EFFORT_DEFAULT_USED,
  type EffortControlState,
  effortControlState,
  reviewEffortTargets,
} from "@/lib/ai/effort-levels";
import type { AiSettings } from "@/lib/ai/types";
import { invoke } from "@/lib/tauri/invoke";

vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(async () => ({ perModel: false, levels: [], reason: null })),
}));

const COMMAND = "agent_effort_levels";

// The backend's reason sentences (agent.rs consts), as fixtures.
const NO_MODEL =
  "Pick a model to set effort. opencode 2 offers effort settings per model.";
const HAS_VARIANT =
  "This model name already picks a variant, so effort is off.";
const UNREADABLE =
  "GitDesktop could not read opencode's model list, so effort is off. Try again in a moment.";
const LONG_MODEL =
  "openrouter/some-provider/an-extremely-long-model-identifier-v2";
const NONE_DECLARED = `${LONG_MODEL} has no effort settings in opencode.`;
const LEVEL_UNAVAILABLE = `Not offered by ${LONG_MODEL} in opencode.`;
const CONTAINER_NEEDS_HOST =
  "Effort isn't available for this container session. GitDesktop reads each model's effort settings from the opencode installed on this computer, and that needs opencode 2.2 or later here.";
const NOT_FOUND =
  "opencode CLI not found. Install it or set its path in Settings.";

const LEVELS = ["low", "medium", "high", "xhigh"] as const;

function answer(
  blocked: readonly string[],
  reason: string,
  topReason: string | null = null,
): EffortSupport {
  return {
    perModel: true,
    levels: LEVELS.map((level) =>
      blocked.includes(level)
        ? { level, variant: null, reason }
        : { level, variant: level, reason: null },
    ),
    reason: topReason,
  };
}

const noneSelectable = (reason: string) => answer(LEVELS, reason, reason);
const ALL_FIVE = ["", ...LEVELS];

describe("effortControlState", () => {
  it("S0: no answer and no error is today's control", () => {
    expect(
      effortControlState({ support: undefined, error: null, value: "high" }),
    ).toEqual({ allBlocked: false, blocked: {}, line: null });
  });

  it("S1: a rejection holds all five with its summary, never the suffix", () => {
    const error = { kind: "command", message: NOT_FOUND };
    const state = effortControlState({
      support: undefined,
      error,
      value: "xhigh",
    });
    expect(state.allBlocked).toBe(true);
    expect(Object.keys(state.blocked).sort()).toEqual([...ALL_FIVE].sort());
    expect(state.line?.tone).toBe("warn");
    expect(state.line?.text).not.toContain(EFFORT_DEFAULT_USED);
    expect(state.line?.text).toContain(NOT_FOUND);
  });

  it("S2: perModel false is today's control", () => {
    expect(
      effortControlState({
        support: { perModel: false, levels: [], reason: null },
        error: null,
        value: "xhigh",
      }),
    ).toEqual({ allBlocked: false, blocked: {}, line: null });
  });

  it.each([
    ["no model", NO_MODEL],
    ["none declared", NONE_DECLARED],
    ["container needs host", CONTAINER_NEEDS_HOST],
    ["unreadable catalog", UNREADABLE],
    ["#-id model", HAS_VARIANT],
  ])("S3 (%s): all held, muted line is the reason", (_n, reason) => {
    const state = effortControlState({
      support: noneSelectable(reason),
      error: null,
      value: "",
    });
    expect(state.allBlocked).toBe(true);
    expect(Object.keys(state.blocked).sort()).toEqual([...ALL_FIVE].sort());
    expect(state.line).toEqual({ tone: "muted", text: reason });
  });

  it("S3 with a stored level ends with the default-used sentence, the #-id reason included", () => {
    expect(EFFORT_DEFAULT_USED).toBe(
      "This level is not sent, and the model's own setting is used.",
    );
    for (const reason of [NONE_DECLARED, HAS_VARIANT]) {
      const state = effortControlState({
        support: noneSelectable(reason),
        error: null,
        value: "high",
      });
      expect(state.line?.text).toBe(`${reason} ${EFFORT_DEFAULT_USED}`);
    }
  });

  it("S3 falls back to the first level's reason when the top one is missing", () => {
    const state = effortControlState({
      support: answer(LEVELS, NO_MODEL, null),
      error: null,
      value: "",
    });
    expect(state.line?.text).toBe(NO_MODEL);
  });

  it("S3 with an empty top reason falls back, never an empty line", () => {
    const state = effortControlState({
      support: answer(LEVELS, NO_MODEL, ""),
      error: null,
      value: "",
    });
    expect(state.line?.text).toBe(NO_MODEL);
    expect(Object.values(state.blocked)).not.toContain("");
  });

  it("S4: all levels with variants blocks nothing", () => {
    expect(
      effortControlState({
        support: answer([], LEVEL_UNAVAILABLE),
        error: null,
        value: "xhigh",
      }),
    ).toEqual({ allBlocked: false, blocked: {}, line: null });
  });

  it("S4: only xhigh blocked names Max, Auto never blocked", () => {
    const state = effortControlState({
      support: answer(["xhigh"], LEVEL_UNAVAILABLE),
      error: null,
      value: "high",
    });
    expect(state.allBlocked).toBe(false);
    expect(state.blocked).toEqual({ xhigh: LEVEL_UNAVAILABLE });
    expect(state.line).toEqual({
      tone: "muted",
      text: `Max: ${LEVEL_UNAVAILABLE}`,
    });
  });

  it("S4: two levels with one reason group into one sentence; a stored blocked level adds the suffix", () => {
    const state = effortControlState({
      support: answer(["low", "xhigh"], LEVEL_UNAVAILABLE),
      error: null,
      value: "low",
    });
    expect(state.line?.text).toBe(
      `Low, Max: ${LEVEL_UNAVAILABLE} ${EFFORT_DEFAULT_USED}`,
    );
  });

  it("support wins over an error, and unknown or omitted levels count as selectable", () => {
    const support: EffortSupport = {
      perModel: true,
      levels: [
        { level: "bogus", variant: null, reason: "x" },
        { level: "xhigh", variant: null, reason: LEVEL_UNAVAILABLE },
      ],
      reason: null,
    };
    const state = effortControlState({
      support,
      error: new Error("refresh failed"),
      value: "",
    });
    expect(state.blocked).toEqual({ xhigh: LEVEL_UNAVAILABLE });
  });
});

describe("listAgentEffortLevels payload", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("sends the four keys verbatim", async () => {
    await listAgentEffortLevels({
      kind: "opencode",
      binPath: "/opt/oc",
      model: "anthropic/claude",
      isolation: "container",
    });
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [
        COMMAND,
        {
          kind: "opencode",
          binPath: "/opt/oc",
          model: "anthropic/claude",
          isolation: "container",
        },
      ],
    ]);
  });

  it("sends null binPath and isolation as null keys", async () => {
    await listAgentEffortLevels({
      kind: "opencode",
      binPath: null,
      model: "",
      isolation: null,
    });
    expect(vi.mocked(invoke).mock.calls).toStrictEqual([
      [
        COMMAND,
        { kind: "opencode", binPath: null, model: "", isolation: null },
      ],
    ]);
  });
});

const ai = (over: Partial<AiSettings>): AiSettings =>
  ({ provider: "opencode-cli", model: "m1", ...over }) as AiSettings;

describe("reviewEffortTargets", () => {
  it("trims the CLI path and passes no isolation", () => {
    expect(
      reviewEffortTargets(ai({ cliPath: "  /opt/oc  " }), undefined),
    ).toEqual([
      {
        label: "Reviews",
        inputs: {
          kind: "opencode",
          binPath: "/opt/oc",
          model: "m1",
          isolation: null,
        },
      },
    ]);
  });

  it.each([
    ["whitespace", "   "],
    ["missing", undefined],
  ])("a %s cliPath is null", (_n, cliPath) => {
    expect(
      reviewEffortTargets(ai({ cliPath }), undefined)[0].inputs.binPath,
    ).toBe(null);
  });

  it("two identical configs collapse to one Reviews target", () => {
    const targets = reviewEffortTargets(ai({}), ai({}));
    expect(targets.map((t) => t.label)).toEqual(["Reviews"]);
  });

  it.each([
    ["cliPath", { cliPath: "/other" }],
    ["model", { model: "m2" }],
  ])("configs differing only in %s give two targets, in order", (_n, over) => {
    const targets = reviewEffortTargets(ai({}), ai(over));
    expect(targets.map((t) => t.label)).toEqual(["Reviews", "Security audits"]);
  });

  it("configs differing only in provider give two labelled targets", () => {
    const targets = reviewEffortTargets(
      ai({ provider: "claude-cli" }),
      ai({ provider: "opencode-cli" }),
    );
    expect(targets.map((t) => [t.label, t.inputs.kind])).toEqual([
      ["Reviews", "claude"],
      ["Security audits", "opencode"],
    ]);
  });

  it("drops a provider that is not effort-capable, on either side", () => {
    expect(
      reviewEffortTargets(ai({ provider: "codex-cli" }), ai({})).map(
        (t) => t.label,
      ),
    ).toEqual(["Security audits"]);
    expect(
      reviewEffortTargets(ai({}), ai({ provider: "anthropic" })).map(
        (t) => t.label,
      ),
    ).toEqual(["Reviews"]);
    expect(
      reviewEffortTargets(
        ai({ provider: "codex-cli" }),
        ai({ provider: "anthropic" }),
      ),
    ).toEqual([]);
  });
});

const held = (
  text: string,
  tone: "warn" | "muted" = "muted",
): EffortControlState => ({
  allBlocked: true,
  blocked: { "": text, low: text, medium: text, high: text, xhigh: text },
  line: { tone, text },
});
const maxBlocked: EffortControlState = {
  allBlocked: false,
  blocked: { xhigh: LEVEL_UNAVAILABLE },
  line: { tone: "muted", text: `Max: ${LEVEL_UNAVAILABLE}` },
};
const open: EffortControlState = { allBlocked: false, blocked: {}, line: null };

describe("combineEffortStates", () => {
  it("no part is today's control; one part is unchanged and unlabelled", () => {
    expect(combineEffortStates([])).toEqual(open);
    expect(combineEffortStates([{ label: "Reviews", state: maxBlocked }])).toBe(
      maxBlocked,
    );
  });

  it("a level blocked for one reviewer only stays selectable, the line names that reviewer", () => {
    const state = combineEffortStates([
      { label: "Reviews", state: open },
      { label: "Security audits", state: maxBlocked },
    ]);
    expect(state.allBlocked).toBe(false);
    expect(state.blocked).toEqual({});
    expect(state.line).toEqual({
      tone: "muted",
      text: `Security audits: Max: ${LEVEL_UNAVAILABLE}`,
    });
  });

  it("two all-blocked parts hold the control", () => {
    const state = combineEffortStates([
      { label: "Reviews", state: held(NO_MODEL) },
      { label: "Security audits", state: held(NONE_DECLARED) },
    ]);
    expect(state.allBlocked).toBe(true);
    expect(state.blocked.xhigh).toBe(NO_MODEL);
    expect(state.line?.text).toBe(
      `Reviews: ${NO_MODEL} Security audits: ${NONE_DECLARED}`,
    );
  });

  it("a warn part beside a muted one makes the line warn", () => {
    const state = combineEffortStates([
      { label: "Reviews", state: held(NOT_FOUND, "warn") },
      { label: "Security audits", state: maxBlocked },
    ]);
    expect(state.line?.tone).toBe("warn");
    expect(state.allBlocked).toBe(false);
    expect(state.blocked).toEqual({ xhigh: NOT_FOUND });
  });
});
