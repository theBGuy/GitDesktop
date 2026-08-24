import { load, type Store } from "@tauri-apps/plugin-store";
import type { ReviewContextSize } from "@/lib/ai/context-budget";
import type { ReviewTimeout } from "@/lib/ai/review-timeout";
import type { AiSettings, ReviewMode } from "@/lib/ai/types";
import { repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";
import type { ThemeSetting } from "@/lib/theme";

export interface RecentRepo {
  path: string;
  name: string;
  lastOpenedAt: string;
  /** User-chosen display name shown in place of the folder name. */
  alias?: string;
  /** Owner (from the origin remote) the repo list groups under. Stored so the list groups
   *  synchronously and never reflows while the async owners query resolves; refreshed in
   *  the background. Absent until first resolved; an empty remote clears it. */
  owner?: string;
  /** The origin remote's host (e.g. "gitlab.com"), stored alongside `owner` so
   *  the context menu names the right provider from the first frame. */
  host?: string;
  /** The provider that host routes to ("github"/"gitlab"/"bitbucket") — resolved
   *  backend-side (it knows glab's self-managed hosts) and stored so labels are right from
   *  the first frame. Absent until first resolved. */
  provider?: string;
  /** The persisted result of the visibility probe ("public" | "private" |
   *  "internal"). Absent = never resolved (the repo list shows no badge, which
   *  must never read as "public"). Cleared when the provider is cleared, so a
   *  stale badge never outlives the remote it was probed from. */
  visibility?: string;
  /** Whether the repo is a fork, resolved in the SAME probe as `visibility` (no extra API
   *  call). Tri-state so the probe converges: `undefined` = never probed (backfill fires),
   *  `false` = probed, not a fork (no re-probe), `true` = a fork. Only `true` on positive
   *  API evidence, so absence never reads as "fork". Cleared with `visibility`. */
  isFork?: boolean;
  /** The upstream repo this fork was made from, as an "owner/repo" slug, when the provider
   *  supplies it. Powers the "Fork of <parent>" label; cleared alongside
   *  `isFork`/`visibility`. */
  forkParent?: string;
}

/** What to call a repo in the UI: its alias when set, else its name. */
export function repoDisplayName(repo: RecentRepo): string {
  return repo.alias?.trim() || repo.name;
}

/**
 * A user-defined minimal grammar for diff syntax highlighting, referenced from
 * `syntaxMap` by its `id`. Built into a highlight.js language at runtime — see
 * features/diff/syntax.ts.
 */
export interface CustomLanguage {
  /** Stable id used as the highlighter language name and the syntaxMap target.
   *  Lowercase token (letters/digits/hyphen). */
  id: string;
  /** Display name shown in pickers. */
  name: string;
  /** Keywords, separated by spaces, commas, or newlines. */
  keywords: string;
  /** Line-comment prefix (e.g. "//" or "#"); empty = none. */
  lineComment: string;
  /** Block-comment delimiters (e.g. "/*" and "*\/"); both empty = none. */
  blockCommentStart: string;
  blockCommentEnd: string;
  /** String delimiter characters (e.g. "\"'`"); empty = none. */
  stringDelimiters: string;
  /** Match keywords case-insensitively. */
  caseInsensitive: boolean;
  /** A full VSCode TextMate grammar (parsed `.tmLanguage.json`). When present,
   *  the diff renders this language with Shiki for VSCode-fidelity highlighting
   *  and the minimal fields above are ignored. */
  tmGrammar?: Record<string, unknown>;
}

/**
 * A user-defined agent slash command, surfaced in the agent composer's `/` menu alongside
 * the built-ins and the repo's own `.claude/commands`. `$ARGUMENTS` (and `$1`..`$9`) are
 * expanded client-side before the prompt reaches the agent.
 */
export interface CustomCommand {
  /** Stable id (uuid) used for list keys. */
  id: string;
  /** Name typed after `/` — letters, digits, `-`, `_` (no spaces). */
  name: string;
  /** Short description shown in the slash menu. */
  description: string;
  /** Prompt template; `$ARGUMENTS`/`$1..` expanded on use. */
  prompt: string;
}

/** One ordered environment variable / request header entry in an MCP server
 *  definition. Secret-bearing entries keep their `value` empty here (the real
 *  value lives in the OS keychain — see `McpServer.secretKeys`). */
export interface McpKeyValue {
  key: string;
  value: string;
}

/**
 * A managed MCP (Model Context Protocol) server the user has registered. GitDesktop passes
 * *exactly* the opted-in servers to the CLI in strict / only-these mode, so a run never
 * silently inherits whatever MCP servers happen to be on the machine. The CLIs are the MCP
 * *hosts* — GitDesktop only generates their config. Secret values live in the OS keychain
 * keyed by `mcp-server/<id>/<entry-key>` and are never written to settings.json;
 * `secretKeys` names which env (stdio) / header (http) entries are secret, resolved at
 * session-launch time.
 */
export interface McpServer {
  /** Stable id (uuid) — list key, per-session opt-in reference, keychain namespace. */
  id: string;
  /** Display name; also the server key in the generated config. Letters, digits,
   *  `-`, `_` (no spaces); unique across the registry. */
  name: string;
  /** Optional human description shown in the list and the composer picker. */
  description: string;
  /** Offered to new sessions by default when true. */
  enabled: boolean;
  /** Where this server is available: "global" (or absent) = every repo; otherwise a repo's
   *  worktree-stable identity key (`repoIdentity`, the git common dir — shared by a repo's
   *  main checkout and all its worktrees). Legacy raw-checkout-path values are still
   *  honored on read and folded onto the identity on write. Organization only — strict mode
   *  still gags un-registered servers. */
  scope?: string;
  /** Per-repo overrides of a GLOBAL server's state, keyed by the repo's worktree-stable
   *  identity (legacy raw-path keys honored on read, folded on write): "on" / "optional" /
   *  "off". Absent for a repo = inherit `enabled`. Meaningless for repo-scoped servers. */
  repoOverrides?: Record<string, "on" | "optional" | "off">;
  /** "stdio" = a local subprocess; "http" = a remote streamable-HTTP server. */
  transport: "stdio" | "http";
  /** Executable to launch (stdio only), e.g. `npx`. */
  command: string;
  /** Arguments passed to `command` (stdio only). */
  args: string[];
  /** Non-secret environment variables (stdio only). */
  env: McpKeyValue[];
  /** Server URL (http only). */
  url: string;
  /** Non-secret request headers (http only). */
  headers: McpKeyValue[];
  /** env (stdio) / header (http) names whose values live in the OS keychain. */
  secretKeys: string[];
}

/** Background-fetch cadence, in minutes (stored as a string so it binds to the
 *  settings Select directly). */
export type AutoFetchInterval = "5" | "10" | "15" | "30" | "60";

export interface NotificationSettings {
  /** Automation results (review posted / ready / failed). */
  automations: boolean;
  /** An AI code review or security audit you started finishing in the background. */
  reviews: boolean;
  /** CI check completion on open PRs. */
  prChecks: "off" | "mine" | "all";
  /** PRs opened / merged / closed in the current repo. */
  prActivity: boolean;
  /** Review decisions on PRs you authored. */
  prReviews: boolean;
  /** Workflow runs finishing (success/failure) on the current branch. */
  actionRuns: boolean;
}

export interface AppSettings {
  ai: AiSettings;
  /** Provider/model for AI PR review (independent of the commit model). */
  reviewAi: AiSettings;
  /** Optional dedicated provider/model for AI security audits; absent = security
   *  audits use `reviewAi`. Not in DEFAULT_SETTINGS — its absence is the meaningful
   *  default, so existing users keep byte-identical behavior until they opt in. */
  securityReviewAi?: AiSettings;
  /** How much diff + prior-discussion context AI reviews send, scaled to the
   *  reviewing model. `"auto"` fits the model's context window (probing Ollama
   *  live); the others force a fixed multiple of the default budget. */
  reviewContextSize?: ReviewContextSize;
  /** How long an agent-CLI review may run before it's stopped (interactive, automated, and
   *  security audits alike). Absent — settings written before this shipped — reads as
   *  `"auto"`, the backend's tier defaults. */
  reviewTimeout?: ReviewTimeout;
  /** Hide every AI surface — commit/PR helpers, review panel, and the AI-related
   *  settings sections (AI, Slash commands, MCP servers, Automations) — and pause
   *  automations: no new automated run starts while set (an in-flight run finishes).
   *  Provider config, API keys, and rules are kept. */
  hideAi: boolean;
  /** OS notifications (sent only while the window is unfocused). */
  notifications: NotificationSettings;
  /** Hide the app to the system tray on window close (so background work keeps
   *  running) instead of quitting. */
  closeToTray: boolean;
  /** Which agent CLI a new Session, Plan, or Research run starts on. Not in
   *  DEFAULT_SETTINGS — its absence is the meaningful "Auto" state: follow the
   *  main AI provider when that's an agent CLI, else Claude. Inline union (the
   *  sessions store does the same) to avoid a settings↔ai import cycle, even a
   *  type-only one. */
  defaultAgent?: "claude" | "codex" | "copilot" | "opencode";
  /** How write-capable agent sessions are isolated. "worktree" = the throwaway
   *  git worktree only (host, full-auto); "container" = also run inside an
   *  ephemeral Docker/Podman container for kernel-enforced filesystem
   *  confinement (opt-in; needs Docker/Podman installed). */
  agentIsolation: "worktree" | "container";
  /** Node base-image major version for the agent container image (digits, e.g.
   *  "24"). */
  agentImageNodeVersion: string;
  /** Which container-capable agents to bake into the image. */
  agentImageProviders: ("claude" | "codex" | "opencode" | "copilot")[];
  globalInstructions: string;
  /** gitignore-style globs (one per line) excluded from AI context. */
  aiIgnorePatterns: string;
  /** Extra network hosts (`host` or `host:port`) the app may reach for AI inference, beyond
   *  the built-in provider hosts and localhost. The shared AI `fetch` wrapper blocks any
   *  other host and is the effective gate — the Tauri HTTP capability is opened to
   *  `http(s)://*` only as a coarse backstop. */
  aiAllowedHosts: string[];
  /** Path to a program used by "Open in editor" (empty = not configured). */
  externalEditor: string;
  /** Friendly name for the configured editor, used in menu labels. */
  externalEditorName: string;
  /** Terminal kind id for "Open in terminal" (empty = default). */
  terminal: string;
  /** Executable path for the chosen terminal (empty for default/built-ins). */
  terminalPath: string;
  /** Argv command template for the "custom-command" terminal mode. `{path}` is
   *  replaced with the repository path; runs with no shell. Empty otherwise. */
  terminalCommand: string;
  /** @deprecated No longer read. The default branch for new repos now lives in
   *  global git config (`init.defaultBranch`), edited in Settings → Git. Kept so
   *  existing settings.json files round-trip without churn. */
  defaultBranch: string;
  /** Hotkey overrides by action id; null = explicitly unbound. Actions not
   *  present use their registry default. */
  hotkeys: Record<string, string | null>;
  /** Warn before amending a commit that's already on the remote (force push).
   *  Cleared by the dialog's "Don't show this again". */
  confirmAmendForcePush: boolean;
  /** Skip the stash-and-reapply prompt and just recover whenever a pull, an
   *  update from upstream, or a branch update would overwrite uncommitted
   *  changes. Set by the prompt's "Always stash and reapply". */
  autoStashOnPull: boolean;
  /** Pop the stash again on the new branch after "Stash and switch" — the
   *  remembered state of that dialog's "Reapply after switching" checkbox. */
  reapplyStashOnSwitch: boolean;
  /** Show the Ctrl/Shift-click multi-select hint above the changes list.
   *  Cleared by the hint's "Don't show again". */
  showSelectionHint: boolean;
  /** Show the "drag to stage individual lines" hint in the working-tree diff. */
  showLineStageHint: boolean;
  /** Check GitHub Releases for a new version on launch (install stays opt-in). */
  autoCheckUpdates: boolean;
  /** Periodically run a background `git fetch` for the open repo so the
   *  behind-count and incoming commits stay current. Fetch only — never pulls,
   *  merges, or touches the working tree. */
  autoFetch: boolean;
  /** How often the background fetch runs, in minutes. */
  autoFetchInterval: AutoFetchInterval;
  /** Run the automated first review when a draft PR is created. Off by default — the review
   *  then waits until the draft is marked ready for review. */
  reviewDraftPrs: boolean;
  /** Default new pull requests to draft: the Create-PR dialog's "Create as draft" checkbox
   *  starts ticked. Off by default; still overridable per dialog. */
  createPrsAsDraft: boolean;
  /** First-run nudge toward the user guide; set once the user opens or dismisses it. */
  seenGuideNudge: boolean;
  /** Send anonymous usage events to PostHog. Default on (opt-out). */
  analyticsEnabled: boolean;
  /** Record masked session replays. Default off (opt-in, for GDPR/ePrivacy). */
  recordReplay: boolean;
  /** Set once the first-run analytics notice has been dismissed. */
  seenAnalyticsNotice: boolean;
  /** App version last shown to the user, to drive the "What's new" dialog. */
  lastSeenVersion: string;
  /** Diff syntax highlighting: file extension (no dot, lowercase) → a
   *  highlight.js language name or a CustomLanguage id. Overrides built-ins. */
  syntaxMap: Record<string, string>;
  /** User-defined grammars referenced by `syntaxMap`. */
  customLanguages: CustomLanguage[];
  /** User-defined agent slash commands for the agent composer's `/` menu. */
  customCommands: CustomCommand[];
  /** Managed MCP servers an agent session can opt into. Empty = MCP stays off. */
  mcpServers: McpServer[];
  recentRepos: RecentRepo[];
  /** Color theme (Settings → Appearance). "system" follows the OS scheme; "slate" is a
   *  softer dark variant that lifts surfaces off pure black to reduce eye strain. Applied
   *  outside the bulk settings form (apply-on-change), like diffViewMode. */
  theme: ThemeSetting;
  diffViewMode: "unified" | "split";
  /** Which conversation-list sections the user collapsed, keyed `"<feature>:<kind>"`
   *  (`pulls:local`, `issues:remote`, …); a missing key = expanded. Global and
   *  feature-scoped, so the remote key collapses that section across every repo. */
  collapsedConversationSections: string[];
  /** Collapse the docked comment composer on every conversation surface down to a
   *  one-line peek strip. Global, so the reading space is reclaimed everywhere at
   *  once; the surface's own actions stay docked either way. */
  commentComposerCollapsed: boolean;
  /** ISO-8601 expiry the user optionally entered for a Bitbucket (Atlassian) API token —
   *  Bitbucket never reports one, so it's user-supplied. null = not provided; cleared on
   *  disconnect. */
  bitbucketTokenExpiresAt: string | null;
}

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
  hideAi: false,
  notifications: {
    automations: true,
    reviews: true,
    prChecks: "all",
    prActivity: true,
    prReviews: true,
    actionRuns: true,
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
  showLineStageHint: true,
  autoCheckUpdates: true,
  autoFetch: true,
  autoFetchInterval: "10",
  reviewDraftPrs: false,
  createPrsAsDraft: false,
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
  collapsedConversationSections: [],
  commentComposerCollapsed: false,
  bitbucketTokenExpiresAt: null,
};

/**
 * The AI config a review should use for `mode`: security audits use `securityReviewAi` when
 * the user configured one, else `reviewAi`. Centralized so the automation runner and the
 * manual review panel can't disagree on which model runs.
 */
export function effectiveReviewAi(
  settings: AppSettings,
  mode: ReviewMode,
): AiSettings {
  return mode === "security"
    ? (settings.securityReviewAi ?? settings.reviewAi)
    : settings.reviewAi;
}

const MAX_RECENT_REPOS = 200;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(storeName("settings.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

/** Loads settings, healing an older or partial saved object against DEFAULT_SETTINGS:
 *  any field absent (stored before that field shipped) reads as its default. Nested
 *  ai/reviewAi/notifications objects are merged, not replaced. */
export async function loadSettings(): Promise<AppSettings> {
  const store = await getStore();
  const saved = await store.get<Partial<AppSettings>>("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    ai: { ...DEFAULT_SETTINGS.ai, ...saved?.ai },
    reviewAi: { ...DEFAULT_SETTINGS.reviewAi, ...saved?.reviewAi },
    // Nested-merge only when present so a partial saved object heals against the
    // reviewAi defaults; an absent one stays absent (security audits then fall
    // back to reviewAi via effectiveReviewAi).
    ...(saved?.securityReviewAi
      ? {
          securityReviewAi: {
            ...DEFAULT_SETTINGS.reviewAi,
            ...saved.securityReviewAi,
          },
        }
      : {}),
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...saved?.notifications,
    },
  };
}

/**
 * Module-private on purpose: a raw save skips the serialized merge chain below,
 * so every write rides one of this module's `serializedRecentRepoWrite` writers
 * (or the `useSaveSettings` hook above them). Un-exported makes that
 * compiler-enforced; the biome `noRestrictedImports` entry stays as the backstop
 * if it is ever re-exported.
 */
async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  await store.set("settings", settings);
}

/**
 * Serializes every `recentRepos` read-modify-write through one module-level promise chain,
 * so concurrent mutators can't clobber each other. Each wrapped helper is a NON-atomic
 * load→modify→save; run two at once and the later save wins with a stale snapshot. That
 * lost-update race is real — the visibility backfill fires concurrent persists alongside
 * `persistRepoOwners` / `addRecentRepo` and silently dropped persisted visibility.
 *
 * The no-op-when-unchanged guards inside each helper MUST stay inside this critical section
 * (they re-read fresh state under the lock) — do not hoist them out.
 */
let recentRepoWrites: Promise<unknown> = Promise.resolve();
function serializedRecentRepoWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = recentRepoWrites.then(fn, fn);
  recentRepoWrites = run.catch(() => undefined);
  return run;
}

export function addRecentRepo(repo: {
  path: string;
  name: string;
}): Promise<void> {
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    // Windows paths are case-insensitive; compare them that way to dedupe
    const samePath = (a: string, b: string) =>
      a.toLowerCase() === b.toLowerCase();
    // Reopening a repo must PRESERVE everything backfilled onto its previous entry — the
    // alias AND the derived forge metadata (owner/host/provider/visibility/isFork/
    // forkParent). Spread `previous` first, then `repo`, so the derived fields survive
    // while the fresh `path`/`name` win (Windows case refresh); a brand-new repo starts
    // with just its own fields. Staleness self-corrects — the open-time visibility probe
    // re-persists owner + visibility on every open.
    const previous = settings.recentRepos.find((r) =>
      samePath(r.path, repo.path),
    );
    const recentRepos = [
      {
        ...previous,
        ...repo,
        lastOpenedAt: new Date().toISOString(),
      },
      ...settings.recentRepos.filter((r) => !samePath(r.path, repo.path)),
    ].slice(0, MAX_RECENT_REPOS);
    await saveSettings({ ...settings, recentRepos });
  });
}

/**
 * Stores resolved repo owners (+ hosts) onto the matching recent-repo records so the repo
 * list groups synchronously and the context menu names the right provider from the first
 * frame. Touches only records whose stored values changed (an empty remote clears them) —
 * a no-op write would loop with its own settings refetch.
 *
 * Matched by worktree-stable identity ({@link repoIdentity}, git common dir), not raw
 * checkout path, so a probe from one checkout updates EVERY row for the same underlying
 * repo; rows keep their own `.path`. Falls back to the raw path on a git error.
 */
export function persistRepoOwners(
  owners: {
    path: string;
    owner: string | null;
    host: string | null;
    provider: string | null;
  }[],
): Promise<void> {
  if (owners.length === 0) return Promise.resolve();
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    // Index the probes by repo IDENTITY and resolve each existing row's identity too, so a
    // row matches an entry for a sibling worktree of the same repo. repoIdentity is
    // promise-memoized per path — one IPC round per path per session, not per probe.
    const byIdentity = new Map(
      await Promise.all(
        owners.map(async (o) => [await repoIdentity(o.path), o] as const),
      ),
    );
    const rowIdentities = await Promise.all(
      settings.recentRepos.map((r) => repoIdentity(r.path)),
    );
    let changed = false;
    const recentRepos = settings.recentRepos.map((r, i) => {
      const resolved = byIdentity.get(rowIdentities[i]);
      if (!resolved) return r;
      const owner = resolved.owner || undefined;
      const host = resolved.host || undefined;
      const provider = resolved.provider || undefined;
      // Visibility and fork provenance come from the provider; when the provider is being
      // cleared (remote removed) they can't outlive it — drop them so no stale badge
      // lingers on a now-local-only repo.
      const visibility = provider ? r.visibility : undefined;
      const isFork = provider ? r.isFork : undefined;
      const forkParent = provider ? r.forkParent : undefined;
      if (
        owner === r.owner &&
        host === r.host &&
        provider === r.provider &&
        visibility === r.visibility &&
        isFork === r.isFork &&
        forkParent === r.forkParent
      )
        return r;
      changed = true;
      return { ...r, owner, host, provider, visibility, isFork, forkParent };
    });
    if (!changed) return;
    await saveSettings({ ...settings, recentRepos });
  });
}

/**
 * Stores the resolved repo visibility plus fork provenance (`isFork` / `forkParent`, from
 * the same probe) onto the matching recent-repo records. A null `visibility` clears all
 * three (no resolvable remote anymore). Touches only changed records, so it never loops
 * with its own settings refetch. Matched by worktree-stable identity like
 * {@link persistRepoOwners}, falling back to the raw path when git can't resolve it.
 */
export function persistRepoVisibility(
  entries: {
    path: string;
    visibility: string | null;
    /** Whether the repo is a fork; omitted/false when unknown or not a fork. */
    isFork?: boolean;
    /** Upstream "owner/repo" slug when the provider supplies it. */
    forkParent?: string;
  }[],
): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    // Identity lookups are promise-memoized per path (see persistRepoOwners).
    const byIdentity = new Map(
      await Promise.all(
        entries.map(async (e) => [await repoIdentity(e.path), e] as const),
      ),
    );
    const rowIdentities = await Promise.all(
      settings.recentRepos.map((r) => repoIdentity(r.path)),
    );
    let changed = false;
    const recentRepos = settings.recentRepos.map((r, i) => {
      const resolved = byIdentity.get(rowIdentities[i]);
      if (!resolved) return r;
      const visibility = resolved.visibility || undefined;
      // Fork provenance shares visibility's lifecycle: a null visibility (remote gone)
      // clears the fork badge too. On a successful probe `isFork` persists as a REAL
      // boolean (`false` included) so the probe converges — only `undefined` re-probes.
      // `forkParent` stays undefined-when-absent.
      const isFork = visibility ? (resolved.isFork ?? false) : undefined;
      const forkParent = visibility
        ? resolved.forkParent || undefined
        : undefined;
      if (
        visibility === r.visibility &&
        isFork === r.isFork &&
        forkParent === r.forkParent
      )
        return r;
      changed = true;
      return { ...r, visibility, isFork, forkParent };
    });
    if (!changed) return;
    await saveSettings({ ...settings, recentRepos });
  });
}

/** Sets (or clears, with an empty string) the display alias for a repo. */
export function setRepoAlias(path: string, alias: string): Promise<void> {
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    const trimmed = alias.trim();
    await saveSettings({
      ...settings,
      recentRepos: settings.recentRepos.map((r) =>
        r.path === path ? { ...r, alias: trimmed || undefined } : r,
      ),
    });
  });
}

export function removeRecentRepo(path: string): Promise<void> {
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    await saveSettings({
      ...settings,
      recentRepos: settings.recentRepos.filter((r) => r.path !== path),
    });
  });
}

/**
 * Repoints a recent-repo row from `oldPath` to `newPath` when the folder moved on disk.
 * Rides the same serialized RMW chain as the other recent-repo writes.
 *
 * It rewrites ONLY the row's `path` — `name`, `lastOpenedAt`, list order, and every derived
 * field stay untouched; the follow-up `addRecentRepo` in the open flow refreshes them, and
 * carrying the derived fields verbatim avoids the wipe-on-reopen class fixed there.
 *
 * Cases: no row at `oldPath` → no-op (the follow-up add creates one). A row ALREADY at
 * `newPath` → MERGE: drop the old row, keep the new-path row in place, adopt the old alias
 * only when the new row has none — never two rows for one path. Otherwise: rewrite in place.
 */
export function relocateRecentRepo(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    // Windows paths are case-insensitive; compare them that way (see addRecentRepo).
    const samePath = (a: string, b: string) =>
      a.toLowerCase() === b.toLowerCase();
    // Picking the folder at its ORIGINAL path (repo restored / moved back) is a
    // no-op — the row already points there. Without this guard the merge branch
    // below would match the row as both `old` and `existing` and drop it.
    if (samePath(oldPath, newPath)) return;
    const old = settings.recentRepos.find((r) => samePath(r.path, oldPath));
    if (!old) return;
    const existing = settings.recentRepos.find((r) =>
      samePath(r.path, newPath),
    );
    const recentRepos = existing
      ? // Merge: keep the new-path row, drop the old, adopt its alias only if none.
        settings.recentRepos
          .filter((r) => !samePath(r.path, oldPath))
          .map((r) =>
            samePath(r.path, newPath)
              ? { ...r, alias: existing.alias ?? old.alias }
              : r,
          )
      : // Rewrite the old row in place — everything but `path` stays put.
        settings.recentRepos.map((r) =>
          samePath(r.path, oldPath) ? { ...r, path: newPath } : r,
        );
    await saveSettings({ ...settings, recentRepos });
  });
}

/**
 * Sets (or clears, with null) the optional Bitbucket token expiry date. Rides the same
 * serialized chain as the recent-repo writes: it's a top-level settings RMW writing the
 * whole `settings` object, so unserialized it would interleave with a concurrent
 * `addRecentRepo` / visibility backfill and lose one of the two writes.
 */
export function setBitbucketTokenExpiresAt(
  value: string | null,
): Promise<void> {
  return serializedRecentRepoWrite(async () => {
    const settings = await loadSettings();
    if (settings.bitbucketTokenExpiresAt === value) return;
    await saveSettings({ ...settings, bitbucketTokenExpiresAt: value });
  });
}

/**
 * Saves a whole settings object built by the UI (which holds a snapshot from before the
 * user started editing) without losing what the chained writers changed meanwhile.
 *
 * `recentRepos` and `bitbucketTokenExpiresAt` are the only fields those writers own, so
 * they're re-pinned from a read taken INSIDE the critical section — the caller's snapshot
 * of them is stale by definition, every other field is the user's intent. Serialization is
 * per-runtime: a second window writing settings is a separate chain.
 */
export function saveSettingsMerged(settings: AppSettings): Promise<void> {
  return serializedRecentRepoWrite(async () => {
    const fresh = await loadSettings();
    await saveSettings({
      ...settings,
      recentRepos: fresh.recentRepos,
      bitbucketTokenExpiresAt: fresh.bitbucketTokenExpiresAt,
    });
  });
}
