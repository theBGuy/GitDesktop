import { useQuery } from "@tanstack/react-query";
import { presentError } from "@/lib/error-summary";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  type AgentKind,
  type EffortSupport,
  listAgentEffortLevels,
  providerKind,
} from "./agent";
import {
  EFFORT_LEVEL_LABELS,
  EFFORT_LEVELS,
  type EffortLevel,
  reviewEffortCapable,
} from "./review-effort";
import type { AiSettings } from "./types";

/** Appended to the line when the stored level will not be sent. True for every
 *  per-model reason, so no code reads the backend's sentence to decide it. */
export const EFFORT_DEFAULT_USED =
  "This level is not sent, and the model's own setting is used.";

/** The text mark of a blocked level, on the four levels only: the no-level
 *  option keeps its bare label in every state. */
export const EFFORT_UNAVAILABLE_SUFFIX = " (unavailable)";

const FALLBACK_REASON = "This effort level isn't available.";

/** Typed axes settle before a query is enabled, so a half-typed model or path
 *  never spawns the CLI. */
const SETTLE_MS = 300;

/** What a run would pass. `isolation` is null for reviews. */
export interface EffortInputs {
  kind: AgentKind;
  binPath: string | null;
  model: string;
  isolation: string | null;
}

/** queryKey ["agent-effort-levels", kind, settledBinPath, settledModel,
 *  isolation]. Enabled, and its answer used, only while the settled pair equals
 *  the live one, so an answer for another keystroke, model, kind, path or
 *  isolation never renders; no placeholder from another key either. */
function useAgentEffortLevels(inputs: EffortInputs | null): {
  support: EffortSupport | undefined;
  error: unknown;
} {
  // One primitive key for the pair, so the debounce sees a stable value.
  const live = inputs ? JSON.stringify([inputs.binPath, inputs.model]) : null;
  const settled = useDebouncedValue(live, SETTLE_MS);
  const ready = inputs !== null && settled === live;
  const [settledBinPath, settledModel]: [string | null, string] = settled
    ? JSON.parse(settled)
    : [null, ""];
  const kind = inputs?.kind ?? null;
  const isolation = inputs?.isolation ?? null;
  const query = useQuery({
    queryKey: [
      "agent-effort-levels",
      kind,
      settledBinPath,
      settledModel,
      isolation,
    ],
    queryFn: () =>
      listAgentEffortLevels({
        // `enabled` holds the query until `inputs` (and so `kind`) is known.
        kind: kind as AgentKind,
        binPath: settledBinPath,
        model: settledModel,
        isolation,
      }),
    enabled: ready,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A local process: a parked offline query would never resolve.
    networkMode: "always",
  });
  if (!ready) return { support: undefined, error: null };
  return { support: query.data, error: query.error };
}

export interface EffortControlState {
  /** Every option, the no-level one included, is held. */
  allBlocked: boolean;
  /** Level -> why it cannot be picked ("" is the no-level option, present only
   *  when allBlocked: it is held like the rest but never marked "(unavailable)"). */
  blocked: Partial<Record<string, string>>;
  /** The one line under the control, or null. */
  line: { tone: "warn" | "muted"; text: string } | null;
}

const OPEN_STATE: EffortControlState = {
  allBlocked: false,
  blocked: {},
  line: null,
};

function holdAll(reason: string): Partial<Record<string, string>> {
  const blocked: Partial<Record<string, string>> = { "": reason };
  for (const level of EFFORT_LEVELS) blocked[level] = reason;
  return blocked;
}

function isEffortLevel(level: unknown): level is EffortLevel {
  return (EFFORT_LEVELS as readonly unknown[]).includes(level);
}

/** The line under the control for a stored `value`, with the suffix when that
 *  level is blocked (S3/S4 only: a rejected call starts no run). */
function withStoredSuffix(
  text: string,
  value: string,
  blocked: Partial<Record<string, string>>,
): string {
  return value !== "" && blocked[value] !== undefined
    ? `${text} ${EFFORT_DEFAULT_USED}`
    : text;
}

/** What one effort control renders for an answer (pure). `value` is the level
 *  as a run sends it: `""` for the no-level option. */
export function effortControlState({
  support,
  error,
  value,
}: {
  support: EffortSupport | undefined;
  error: unknown;
  value: string;
}): EffortControlState {
  if (!support) {
    if (error == null) return OPEN_STATE;
    const text = presentError(error).summary;
    return {
      allBlocked: true,
      blocked: holdAll(text),
      line: { tone: "warn", text },
    };
  }
  if (!support.perModel) return OPEN_STATE;
  const answered = new Map<
    EffortLevel,
    { variant: unknown; reason: unknown }
  >();
  for (const l of support.levels) {
    if (isEffortLevel(l.level)) answered.set(l.level, l);
  }
  // A level the answer omits counts as selectable.
  const blockedLevels = EFFORT_LEVELS.filter((level) => {
    const state = answered.get(level);
    return state !== undefined && state.variant == null;
  });
  if (blockedLevels.length === EFFORT_LEVELS.length) {
    const first = answered.get(EFFORT_LEVELS[0])?.reason;
    const reason =
      support.reason ||
      (typeof first === "string" && first ? first : FALLBACK_REASON);
    const blocked = holdAll(reason);
    return {
      allBlocked: true,
      blocked,
      line: { tone: "muted", text: withStoredSuffix(reason, value, blocked) },
    };
  }
  if (blockedLevels.length === 0) return OPEN_STATE;
  const blocked: Partial<Record<string, string>> = {};
  const groups = new Map<string, string[]>();
  for (const level of blockedLevels) {
    const own = answered.get(level)?.reason;
    const reason = typeof own === "string" && own ? own : FALLBACK_REASON;
    blocked[level] = reason;
    groups.set(reason, [
      ...(groups.get(reason) ?? []),
      EFFORT_LEVEL_LABELS[level],
    ]);
  }
  const text = [...groups]
    .map(([reason, labels]) => `${labels.join(", ")}: ${reason}`)
    .join(" ");
  return {
    allBlocked: false,
    blocked,
    line: { tone: "muted", text: withStoredSuffix(text, value, blocked) },
  };
}

/** `effortControlState` over the query: what a control renders from. `null`
 *  inputs = nothing to ask yet, so the control stays as it is today. */
export function useEffortControl(
  inputs: EffortInputs | null,
  value: string,
): EffortControlState {
  return effortControlState({ ...useAgentEffortLevels(inputs), value });
}

/** One control driven by several runs (Review effort): a level is held only
 *  when no run could use it, and the line names each run it speaks for. */
export function combineEffortStates(
  parts: { label: string; state: EffortControlState }[],
): EffortControlState {
  if (parts.length === 0) return OPEN_STATE;
  if (parts.length === 1) return parts[0].state;
  const [first, ...rest] = parts;
  const blocked: Partial<Record<string, string>> = {};
  for (const [level, reason] of Object.entries(first.state.blocked)) {
    if (rest.every((p) => p.state.blocked[level] !== undefined)) {
      blocked[level] = reason;
    }
  }
  const lines = parts.flatMap((p) =>
    p.state.line ? [{ label: p.label, line: p.state.line }] : [],
  );
  return {
    allBlocked: parts.every((p) => p.state.allBlocked),
    blocked,
    line:
      lines.length === 0
        ? null
        : {
            tone: lines.some((l) => l.line.tone === "warn") ? "warn" : "muted",
            text: lines.map((l) => `${l.label}: ${l.line.text}`).join(" "),
          },
  };
}

/** A Select's `items` map for a control: each blocked level reads
 *  `<label> (unavailable)`, the no-level key keeps its bare label. One map
 *  feeds both the popup and the closed trigger. */
export function effortSelectItems(
  noLevel: { key: string; label: string },
  control: EffortControlState | undefined,
): Record<string, string> {
  const items: Record<string, string> = { [noLevel.key]: noLevel.label };
  for (const level of EFFORT_LEVELS) {
    const label = EFFORT_LEVEL_LABELS[level];
    items[level] =
      control?.blocked[level] !== undefined
        ? `${label}${EFFORT_UNAVAILABLE_SUFFIX}`
        : label;
  }
  return items;
}

export interface ReviewEffortTarget {
  label: "Reviews" | "Security audits";
  inputs: EffortInputs;
}

/** The reviewers the one Review effort setting drives, as what each review run
 *  passes. `securityReviewAi` undefined = the security toggle is off. Two
 *  reviewers with the same inputs collapse to one unlabelled target. Pure. */
export function reviewEffortTargets(
  reviewAi: AiSettings,
  securityReviewAi: AiSettings | undefined,
): ReviewEffortTarget[] {
  const reviewers: { label: ReviewEffortTarget["label"]; ai: AiSettings }[] = [
    { label: "Reviews", ai: reviewAi },
  ];
  if (securityReviewAi) {
    reviewers.push({ label: "Security audits", ai: securityReviewAi });
  }
  const targets: ReviewEffortTarget[] = [];
  for (const { label, ai } of reviewers) {
    const kind = providerKind(ai.provider);
    if (!kind || !reviewEffortCapable(ai.provider)) continue;
    targets.push({
      label,
      // What a review run passes: its own CLI path, no isolation.
      inputs: {
        kind,
        binPath: ai.cliPath?.trim() || null,
        model: ai.model,
        isolation: null,
      },
    });
  }
  const [a, b] = targets;
  if (
    a &&
    b &&
    a.inputs.kind === b.inputs.kind &&
    a.inputs.binPath === b.inputs.binPath &&
    a.inputs.model === b.inputs.model &&
    a.inputs.isolation === b.inputs.isolation
  ) {
    return [a];
  }
  return targets;
}
