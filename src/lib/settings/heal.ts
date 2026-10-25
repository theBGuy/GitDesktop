// The settings heal and the cache seed, runtime-import-free of ./api and
// @/lib/theme so scripts/settings-heal.test.mjs loads it with no install. Type-only
// imports use the `import type` declaration form: Node's type stripping keeps an
// inline `type` specifier's import as a real one.
import { ALL_PROVIDER_IDS } from "@/lib/ai/providers";
import { REVIEW_CONTEXT_SIZES } from "@/lib/ai/review-context-size";
import { REVIEW_EFFORTS } from "@/lib/ai/review-effort";
import { REVIEW_TIMEOUTS } from "@/lib/ai/review-timeout";
import type { AiSettings } from "@/lib/ai/types";
import type { ThemeSetting } from "@/lib/theme";
import type {
  AppSettings,
  ChannelPrefs,
  McpServer,
  NotificationOutcome,
  NotificationSettings,
  NotificationSource,
  OutcomeFilter,
  OutcomeSource,
} from "./api";

/** A global server's per-repo states. Declared here rather than beside
 *  {@link McpRepoState} in ./mcp so `loadSettings` can heal against it without
 *  importing that module — "default" is key ABSENCE, so it is not a member. */
export const MCP_REPO_STATES = ["on", "optional", "off"] as const;

/** How a server is reached. The Add/Edit dialog's transport toggle renders from
 *  this list and `loadSettings` heals against it, so the two can't drift. */
export const MCP_TRANSPORTS = ["stdio", "http"] as const;

/** The background-fetch cadences offered in Settings, in render order. */
export const AUTO_FETCH_INTERVALS = ["5", "10", "15", "30", "60"] as const;

/** Every notification source, in render order. The single manifest: the settings
 *  matrix, the heal, and the emit gate all iterate THIS list, so a new source
 *  cannot ship half-wired. */
export const NOTIFICATION_SOURCES = [
  "prChecks",
  "prActivity",
  "prCreate",
  "prReviews",
  "actionRuns",
  "reviews",
  "automations",
  "agents",
] as const;

/** CI-check scopes offered in Settings. The legacy tri-state's "off" is retired —
 *  both prChecks channels off expresses it, and {@link healNotifications} maps it. */
export const PR_CHECK_SCOPE_FILTERS = ["mine", "all"] as const;

/** The outcome classes the CI producers actually emit today. Adding one is a SHAPE
 *  change (see {@link OUTCOME_FILTERS}) — not a new member here. */
export const OUTCOME_CLASSES = ["success", "failure"] as const;

/** The non-empty subsets of {@link OUTCOME_CLASSES}; the empty subset is spelled
 *  "both channels off". Every member delivers SOMETHING — the poll-enable gates rely
 *  on it (see `anyChannelOn`); a member that can empty the set must thread into them. */
export const OUTCOME_FILTERS = ["all", "failures", "successes"] as const;

/** Per-source outcome axis, declared for EVERY source so adding a source forces an
 *  explicit decision (an empty array = no outcome axis). The split typing is the
 *  drift guard: only an {@link OutcomeSource} may carry classes, so handing another
 *  source an axis here fails to compile until it joins that union too. Read through
 *  {@link isOutcomeSource} and {@link OUTCOME_SOURCES}, which are this manifest's
 *  two public forms. */
const SOURCE_OUTCOMES: Record<OutcomeSource, readonly NotificationOutcome[]> &
  Record<Exclude<NotificationSource, OutcomeSource>, readonly []> = {
  prChecks: OUTCOME_CLASSES,
  prActivity: [],
  // Empty by design: only a failed create emits, so there is no result to filter.
  prCreate: [],
  prReviews: [],
  actionRuns: OUTCOME_CLASSES,
  reviews: [],
  // Empty by design: automations filters by KIND, via `automationKinds`.
  automations: [],
  agents: [],
};

/** Narrowing form of the axis test — `OUTCOME_SOURCES.includes` does not narrow, and
 *  the typing above is what makes the predicate true rather than asserted. */
export function isOutcomeSource(
  source: NotificationSource,
): source is OutcomeSource {
  return SOURCE_OUTCOMES[source].length > 0;
}

/** The outcome sources in manifest order — the one enumeration a heal branch, an
 *  override normalizer, or a matrix sub-row iterates. */
export const OUTCOME_SOURCES: readonly OutcomeSource[] =
  NOTIFICATION_SOURCES.filter(isOutcomeSource);

/** The automations source's own filter vocabulary. Its events are distinct notification
 *  KINDS rather than a success/failure lattice, so this is a separate axis with its own
 *  roster — never a member of {@link OUTCOME_FILTERS}. */
export const AUTOMATION_KIND_FILTERS = ["all", "failures"] as const;

/** The agent CLIs offerable as the Default agent, in render order. Spelled out here
 *  rather than reusing lib/ai's identical `AgentKind` list because `lib/ai/agent.ts`
 *  imports the settings module, so importing back from it is the one edge that would
 *  close a cycle. (Other lib/ai leaves are imported above — they import nothing of
 *  ours.) */
export const DEFAULT_AGENT_IDS = [
  "claude",
  "codex",
  "copilot",
  "opencode",
] as const;

/** The agent-session isolation modes offered in Settings. */
export const AGENT_ISOLATIONS = ["worktree", "container"] as const;

/** Node base-image majors offered for the agent container image (current LTS
 *  first). The Settings picker renders this list; `loadSettings` heals against it. */
export const NODE_VERSIONS = ["24", "22", "20"] as const;

/** The diff layouts offered in the diff surface's view toggle. */
export const DIFF_VIEW_MODES = ["unified", "split"] as const;

/** The layouts offered in the Changes panel's view toggle. */
export const CHANGES_VIEW_MODES = ["list", "tree"] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "https://ai-gateway.vercel.sh/v1",
  },
  reviewAi: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "https://ai-gateway.vercel.sh/v1",
  },
  reviewContextSize: "auto",
  reviewTimeout: "auto",
  reviewEffort: "auto",
  hideAi: false,
  notifications: {
    sources: {
      prChecks: { inApp: true, os: true },
      prActivity: { inApp: true, os: true },
      prCreate: { inApp: true, os: true },
      prReviews: { inApp: true, os: true },
      actionRuns: { inApp: true, os: true },
      reviews: { inApp: true, os: true },
      automations: { inApp: true, os: true },
      agents: { inApp: true, os: true },
    },
    prChecksScope: "all",
    outcomes: {
      prChecks: "all",
      actionRuns: "all",
    },
    automationKinds: "all",
  },
  closeToTray: true,
  agentIsolation: "worktree",
  agentImageNodeVersion: "24",
  agentImageProviders: ["claude", "codex"],
  globalInstructions: "",
  aiIgnorePatterns: "",
  aiAllowedHosts: [],
  externalEditor: "",
  externalEditorName: "",
  terminal: "",
  terminalPath: "",
  terminalCommand: "",
  defaultBranch: "main",
  hotkeys: {},
  confirmAmendForcePush: true,
  autoStashOnPull: false,
  reapplyStashOnSwitch: false,
  showSelectionHint: true,
  showBoardSelectionHint: true,
  showLineStageHint: true,
  autoCheckUpdates: true,
  autoFetch: true,
  autoFetchInterval: "10",
  reviewDraftPrs: false,
  createPrsAsDraft: false,
  fetchLinkPreviews: true,
  seenGuideNudge: false,
  analyticsEnabled: true,
  recordReplay: false,
  seenAnalyticsNotice: false,
  lastSeenVersion: "",
  syntaxMap: {},
  customLanguages: [],
  customCommands: [],
  mcpServers: [],
  recentRepos: [],
  theme: "system",
  diffViewMode: "unified",
  changesViewMode: "list",
  collapsedConversationSections: [],
  commentComposerCollapsed: false,
  diffFileListCollapsed: false,
  sidebarCollapsed: false,
  bitbucketTokenExpiresAt: null,
};

/** The stored theme's membership list. Spelled here because @/lib/theme reads
 *  `window.matchMedia` at load; `satisfies` pins it to {@link ThemeSetting} both
 *  ways, so a member missing from either side fails to compile. */
const THEME_MEMBERS = {
  system: true,
  light: true,
  dark: true,
  slate: true,
} satisfies Record<ThemeSetting, true>;
const THEMES = Object.keys(THEME_MEMBERS) as ThemeSetting[];

/** The stored value when it is one of `allowed`, else `fallback`. */
const pick = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => (allowed.includes(value as T) ? (value as T) : fallback);

/** Re-pairs a stored AI config whose provider is off-list. The model belongs to its
 *  provider, so healing the provider alone would leave a pair the UI can never mint —
 *  `switchProvider` always re-pairs via `defaultModelForProvider`. Membership is
 *  checked against the FULL provider list, never a per-surface filtered subset: a
 *  valid provider that some picker hides must survive the load untouched. */
const healAi = (stored: AiSettings, fallback: AiSettings): AiSettings =>
  ALL_PROVIDER_IDS.includes(stored.provider)
    ? stored
    : { ...stored, provider: fallback.provider, model: fallback.model };

/** Heals one server's enumerated fields: an off-list `transport` falls back to the
 *  empty-draft default, and per-repo override entries whose value isn't a real state
 *  are dropped — absence IS the "Default" choice there, so a junk entry heals by
 *  disappearing rather than by picking a state the user never made. Returns the same
 *  object when nothing was junk, and passes through anything that isn't a server
 *  object at all: the heal's premise is that settings.json lies, so it must not
 *  assume shape either. */
function healMcpServer(server: unknown): McpServer {
  // Arrays are excluded explicitly (`typeof [] === "object"`): spreading one would
  // fabricate a phantom `{transport: "stdio"}` server that the next write persists.
  if (typeof server !== "object" || server === null || Array.isArray(server))
    return server as McpServer;
  const stored = server as McpServer;
  let healed = stored;
  const transport = pick(stored.transport, MCP_TRANSPORTS, "stdio");
  if (transport !== stored.transport) healed = { ...healed, transport };
  const overrides = stored.repoOverrides;
  if (
    typeof overrides === "object" &&
    overrides !== null &&
    !Array.isArray(overrides)
  ) {
    const kept = Object.entries(overrides).filter(([, state]) =>
      (MCP_REPO_STATES as readonly string[]).includes(state),
    );
    if (kept.length !== Object.keys(overrides).length) {
      healed = { ...healed, repoOverrides: Object.fromEntries(kept) };
    }
  }
  return healed;
}

/** A plain object, or `{}` for anything else (null, an array, a primitive) — the
 *  stored settings file is hand-editable, so every branch below reads through this. */
const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Builds a full source map from the manifest, which is the only enumeration of
 *  source keys — a new source therefore cannot be missed by a heal branch. */
const mapSources = (
  cell: (source: NotificationSource) => ChannelPrefs,
): Record<NotificationSource, ChannelPrefs> =>
  Object.fromEntries(
    NOTIFICATION_SOURCES.map((source) => [source, cell(source)]),
  ) as Record<NotificationSource, ChannelPrefs>;

/** The same trick over the outcome manifest, so a source that gains an axis cannot
 *  be missed by a heal branch either. */
const mapOutcomes = (
  filter: (source: OutcomeSource) => OutcomeFilter,
): Record<OutcomeSource, OutcomeFilter> =>
  Object.fromEntries(
    OUTCOME_SOURCES.map((source) => [source, filter(source)]),
  ) as Record<OutcomeSource, OutcomeFilter>;

/**
 * Coerces a stored `notifications` value — new-shape, legacy (six accreted prefs),
 * or junk — into a full {@link NotificationSettings}. The legacy branch stays
 * forever: an install that skips several releases must still find its path here.
 * A stored `sources` object marks the new shape and wins outright, so a file
 * carrying both shapes never reads a stale legacy key.
 *
 * Pure; exported for the heal's reviewability.
 */
export function healNotifications(saved: unknown): NotificationSettings {
  const defaults = DEFAULT_SETTINGS.notifications;
  const obj = asObject(saved);

  // Read the same way by BOTH branches below: no legacy writer ever produced this
  // key, so a stored `outcomes` is always an intentional hand-edit and heals
  // generously, per key. The "a stored `sources` wins outright" discriminant
  // arbitrates the two conflicting CHANNEL shapes only — outcomes has just the one.
  const outcomes = mapOutcomes((source) =>
    pick(asObject(obj.outcomes)[source], OUTCOME_FILTERS, "all"),
  );
  // Same story for the automations kind axis: no legacy writer produced this key
  // either, so one generous read serves both branches.
  const automationKinds = pick(
    obj.automationKinds,
    AUTOMATION_KIND_FILTERS,
    "all",
  );

  if (
    obj.sources &&
    typeof obj.sources === "object" &&
    !Array.isArray(obj.sources)
  ) {
    const stored = obj.sources as Record<string, unknown>;
    return {
      sources: mapSources((source) => {
        const pair = asObject(stored[source]);
        return {
          inApp:
            typeof pair.inApp === "boolean"
              ? pair.inApp
              : defaults.sources[source].inApp,
          os:
            typeof pair.os === "boolean"
              ? pair.os
              : defaults.sources[source].os,
        };
      }),
      prChecksScope: pick(obj.prChecksScope, PR_CHECK_SCOPE_FILTERS, "all"),
      outcomes,
      automationKinds,
    };
  }

  // Legacy: five boolean prefs named exactly like their sources, plus a tri-state
  // prChecks whose "off" becomes both channels off and whose scope moves out. The
  // `agents` producers were ungated before this shape, so they default on.
  const legacyChecks = obj.prChecks;
  return {
    sources: mapSources((source) => {
      if (source === "prChecks") {
        return legacyChecks === "off"
          ? { inApp: false, os: false }
          : { ...defaults.sources.prChecks };
      }
      const stored = obj[source];
      return typeof stored === "boolean"
        ? { inApp: stored, os: stored }
        : { ...defaults.sources[source] };
    }),
    prChecksScope: pick(legacyChecks, PR_CHECK_SCOPE_FILTERS, "all"),
    outcomes,
    automationKinds,
  };
}

/**
 * Coerces every statically-enumerable field to its default when the stored value is
 * off-list. settings.json is hand-editable and no writer validates membership, so an
 * unrecognized string otherwise reaches a `Select` with no matching item — an empty
 * trigger whose next Save persists the junk. Silent and deterministic, so a healed
 * value simply rides the next natural settings write.
 *
 * Deliberately not healed: terminal / terminalPath / externalEditor (their own custom
 * sentinels), syntaxMap (user-defined language ids), hotkeys, and MCP server scopes,
 * whose membership is only known at runtime; plus agentImageProviders, which is
 * statically enumerable but validated where it is consumed (render_dockerfile refuses
 * an agent it has no package for) and rendered by no picker, so a stray entry sits
 * inert in the file.
 */
function healEnumerated(settings: AppSettings): AppSettings {
  // Destructured out because an off-list agent must heal to ABSENT — that absence is
  // the meaningful "Auto" state, so a stand-in string would silently pin an agent.
  const { defaultAgent, ...rest } = settings;
  return {
    ...rest,
    ...(defaultAgent && DEFAULT_AGENT_IDS.includes(defaultAgent)
      ? { defaultAgent }
      : {}),
    ai: healAi(settings.ai, DEFAULT_SETTINGS.ai),
    reviewAi: healAi(settings.reviewAi, DEFAULT_SETTINGS.reviewAi),
    ...(settings.securityReviewAi
      ? {
          securityReviewAi: healAi(
            settings.securityReviewAi,
            DEFAULT_SETTINGS.reviewAi,
          ),
        }
      : {}),
    reviewContextSize: pick(
      settings.reviewContextSize,
      REVIEW_CONTEXT_SIZES,
      "auto",
    ),
    reviewTimeout: pick(settings.reviewTimeout, REVIEW_TIMEOUTS, "auto"),
    reviewEffort: pick(settings.reviewEffort, REVIEW_EFFORTS, "auto"),
    agentIsolation: pick(
      settings.agentIsolation,
      AGENT_ISOLATIONS,
      DEFAULT_SETTINGS.agentIsolation,
    ),
    agentImageNodeVersion: pick(
      settings.agentImageNodeVersion,
      NODE_VERSIONS,
      DEFAULT_SETTINGS.agentImageNodeVersion,
    ),
    autoFetchInterval: pick(
      settings.autoFetchInterval,
      AUTO_FETCH_INTERVALS,
      DEFAULT_SETTINGS.autoFetchInterval,
    ),
    theme: pick(settings.theme, THEMES, DEFAULT_SETTINGS.theme),
    diffViewMode: pick(
      settings.diffViewMode,
      DIFF_VIEW_MODES,
      DEFAULT_SETTINGS.diffViewMode,
    ),
    changesViewMode: pick(
      settings.changesViewMode,
      CHANGES_VIEW_MODES,
      DEFAULT_SETTINGS.changesViewMode,
    ),
    // A corrupt container is passed through, never substituted: every writer in the
    // serialized RMW chain re-reads through loadSettings, so a stand-in [] would
    // persist on the next unrelated write and destroy whatever definitions the shape
    // held. Untouched, the MCP surfaces degrade exactly as they did before this heal
    // existed and the file stays repairable. null/undefined resets — nothing to lose.
    mcpServers: Array.isArray(settings.mcpServers)
      ? settings.mcpServers.map(healMcpServer)
      : settings.mcpServers == null
        ? []
        : settings.mcpServers,
  };
}

/** `value`'s own entries minus the `undefined`-valued ones. JSON storage cannot
 *  hold an `undefined`, so a committed object carrying one would shadow the default
 *  a re-read applies; stored (JSON-parsed) input spreads exactly as before. */
function withoutUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Heals an older or partial saved object against DEFAULT_SETTINGS: any field absent
 *  (stored before that field shipped) reads as its default. Nested ai/reviewAi
 *  objects are merged, not replaced; `notifications` is rebuilt by
 *  {@link healNotifications}, which is total (a nested spread there would splash
 *  legacy primitives over the new channel objects). Enumerated fields are then
 *  membership-checked by {@link healEnumerated}. One transform for the load path
 *  and the post-write cache seed, so a seed always equals what a re-read returns. */
export function healLoadedSettings(
  saved: Partial<AppSettings> | null | undefined,
): AppSettings {
  const stored = withoutUndefined(saved);
  return healEnumerated({
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...withoutUndefined(stored?.ai) },
    reviewAi: {
      ...DEFAULT_SETTINGS.reviewAi,
      ...withoutUndefined(stored?.reviewAi),
    },
    // Nested-merge only when present so a partial saved object heals against the
    // reviewAi defaults; an absent one stays absent (security audits then fall
    // back to reviewAi via effectiveReviewAi).
    ...(stored?.securityReviewAi
      ? {
          securityReviewAi: {
            ...DEFAULT_SETTINGS.reviewAi,
            ...withoutUndefined(stored.securityReviewAi),
          },
        }
      : {}),
    notifications: healNotifications(stored?.notifications),
  });
}

/** The QueryClient surface the settings seed calls. Structural, so this module
 *  carries no runtime react-query import. */
export interface SettingsSeedClient {
  setQueryData(queryKey: readonly unknown[], data: AppSettings): unknown;
  invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<void>;
}

/** What a settings write's `onMutate` hands its `onSuccess`. */
export interface SettingsSeedContext {
  seq: number;
}

/** Settings writes started in this runtime. Settings-only by construction: the one
 *  factory below over the one settings key is the only writer, so it orders exactly
 *  the settings write STARTS the seed guard compares. */
let started = 0;

/**
 * Every settings mutation's callbacks. `onMutate` stamps the write's start
 * synchronously; `onSuccess` seeds the cache with the write's committed (healed)
 * snapshot unless a newer settings write has started since, whose optimistic patch
 * or own seed must win. The invalidate follows in the same synchronous block: its
 * `cancelRefetch` drops an older in-flight read that would land pre-write data
 * over the seed, its refetch reconciles a skipped seed, and returning its promise
 * holds `mutateAsync` until that refetch settles.
 */
export function settingsSeedCallbacks(
  client: SettingsSeedClient,
  key: readonly unknown[],
) {
  return {
    onMutate: (): SettingsSeedContext => ({ seq: ++started }),
    onSuccess: (
      committed: AppSettings | null,
      _variables: unknown,
      ctx: SettingsSeedContext | undefined,
    ) => {
      if (committed && ctx?.seq === started)
        client.setQueryData(key, committed);
      return client.invalidateQueries({ queryKey: key });
    },
  };
}
