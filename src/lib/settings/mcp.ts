import { repoIdentity } from "@/lib/git/repo-identity";
import type { McpKeyValue, McpServer } from "./api";

/** Server name = the key in the generated MCP config: letters/digits/`-`/`_`,
 *  must start with a letter or digit, no spaces. */
export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The sentinel scope meaning "available in every repo". */
export const MCP_SCOPE_GLOBAL = "global";

/** A server's effective scope ("global" when unset, for back-compat with
 *  registries saved before scoping existed). */
export function serverScope(server: McpServer): string {
  const s = server.scope?.trim();
  return s ? s : MCP_SCOPE_GLOBAL;
}

/** The scope / override keys that identify "the current repo", most-preferred
 *  LAST. Holds both the worktree-stable identity ({@link repoIdentity}) and the raw
 *  checkout path, so lookups match a value stored under either — new writes land on
 *  the identity, legacy raw-path ones stay honored. Callers build this via
 *  `useRepoKeys` (queries.ts): `[repoPath]` while the identity resolves, `[]` when
 *  no repo is open. */
export type RepoKeys = readonly string[];

/** The override/scope value that wins for `repoKeys`, preferring the LATER key
 *  (the resolved identity) over an earlier one (the raw path) so a folded
 *  identity entry beats a stale legacy one. */
export function pickForRepo<T>(
  byKey: Record<string, T> | undefined,
  repoKeys: RepoKeys,
): T | undefined {
  if (!byKey) return undefined;
  let hit: T | undefined;
  for (const k of repoKeys) {
    const v = byKey[k];
    if (v !== undefined) hit = v;
  }
  return hit;
}

/** Whether a server is in SCOPE for `repoKeys` (ignores per-repo on/off):
 *  global servers always are; a repo-scoped server only when its scope matches
 *  one of the repo's keys (identity or raw checkout path). */
export function isServerInScope(
  server: McpServer,
  repoKeys: RepoKeys,
): boolean {
  const scope = serverScope(server);
  return scope === MCP_SCOPE_GLOBAL || repoKeys.includes(scope);
}

/** A server's resolved state in the repo named by `repoKeys`: "on" (available +
 *  default-on), "optional" (available, off by default), or "off" (not offered).
 *  A global server can be overridden per repo (`repoOverrides`, keyed by identity
 *  or a legacy raw path); otherwise — and always for repo-scoped servers — it
 *  follows `enabled` (on / optional). */
export type McpRepoState = "on" | "optional" | "off";
export function effectiveMcpState(
  server: McpServer,
  repoKeys: RepoKeys,
): McpRepoState {
  if (repoKeys.length > 0 && serverScope(server) === MCP_SCOPE_GLOBAL) {
    const override = pickForRepo(server.repoOverrides, repoKeys);
    if (override) return override;
  }
  return server.enabled ? "on" : "optional";
}

/** Whether a server is OFFERED to sessions in the repo named by `repoKeys` (in
 *  scope and not per-repo "off"). The composer picker + resume both use this. */
export function isServerAvailable(
  server: McpServer,
  repoKeys: RepoKeys,
): boolean {
  return (
    isServerInScope(server, repoKeys) &&
    effectiveMcpState(server, repoKeys) !== "off"
  );
}

/** Whether a server is pre-selected by default for a new session in the repo
 *  named by `repoKeys`. */
export function isServerDefaultOn(
  server: McpServer,
  repoKeys: RepoKeys,
): boolean {
  return (
    isServerAvailable(server, repoKeys) &&
    effectiveMcpState(server, repoKeys) === "on"
  );
}

/** A repo-scope key rendered for humans: strip a trailing `.git` common-dir
 *  segment (the identity key is `<repo>/.git`) so the label shows the containing
 *  repo folder, not a bare `.git`. Global stays "global"; a raw legacy path (no
 *  `.git` suffix) is returned unchanged. The STORED value is never altered — this
 *  is display-only. */
export function scopeRepoPath(scope: string): string {
  return scope.replace(/[/\\]\.git\/?$/, "");
}

/** Fold a written server's LEGACY raw-path scope/override keys onto the repo's
 *  worktree-stable identity, so a value set from one checkout is honored from a
 *  sibling worktree. Resolves {@link repoIdentity} for `scope` (when repo-scoped) and
 *  each `repoOverrides` key; an existing identity value WINS over a legacy one, and a
 *  key that already IS its identity folds to a no-op. Call at write time on the single
 *  server being written — never a global sweep, so untouched legacy entries stay
 *  harmless (reads already match both forms). */
export async function foldServerScopeKeys(
  server: McpServer,
): Promise<McpServer> {
  let next = server;

  // Repo-scoped servers: migrate the scope key itself onto the identity.
  const scope = server.scope?.trim();
  if (scope && scope !== MCP_SCOPE_GLOBAL) {
    const id = await repoIdentity(scope);
    if (id !== scope) next = { ...next, scope: id };
  }

  const overrides = server.repoOverrides;
  if (overrides && Object.keys(overrides).length > 0) {
    const keys = Object.keys(overrides);
    const ids = await Promise.all(
      keys.map(async (key) =>
        key === MCP_SCOPE_GLOBAL
          ? key
          : await repoIdentity(key).catch(() => key),
      ),
    );
    // Seed with entries already on their identity key (`id === key`) FIRST, so a
    // legacy raw-path value can't clobber one regardless of key order.
    const folded: Record<string, McpRepoState> = {};
    keys.forEach((key, i) => {
      if (ids[i] === key) folded[key] = overrides[key];
    });
    keys.forEach((key, i) => {
      const id = ids[i];
      if (folded[id] === undefined) folded[id] = overrides[key];
    });
    next = { ...next, repoOverrides: folded };
  }

  return next;
}

/** Whether an (agent, isolation) combination can run MCP servers at all.
 *  Claude / Copilot / opencode: BOTH host and container — each CLI auto-approves MCP
 *  tool calls non-interactively, and the container delivers the same config into the
 *  CLI's mounted home. Codex: container only — host `codex exec` cancels every MCP
 *  tool call (stdin EOF → "declined", an upstream limitation), while a container
 *  session bypasses approvals. Shared by the composer (gating) and the store. */
export function mcpSupportedFor(agent: string, isContainer: boolean): boolean {
  if (agent === "codex") return isContainer;
  return agent === "claude" || agent === "copilot" || agent === "opencode";
}

/** Whether a specific server can run under `agent`. Codex's MCP config only takes
 *  local (stdio) servers cleanly (its remote support is bearer-token-only, not the
 *  arbitrary headers our http servers carry), so http servers aren't offered to it.
 *  Claude, Copilot, and opencode all take stdio + http. */
export function mcpServerUsableBy(server: McpServer, agent: string): boolean {
  return agent === "codex" ? server.transport === "stdio" : true;
}

/** A blank server for the "Add" dialog. stdio + global are the common defaults;
 *  the dialog's scope control narrows it to the open repo when wanted. */
export function emptyMcpServer(): McpServer {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    enabled: true,
    scope: MCP_SCOPE_GLOBAL,
    transport: "stdio",
    command: "",
    args: [],
    env: [],
    url: "",
    headers: [],
    secretKeys: [],
  };
}

/** The env (stdio) or header (http) entries for a server, by its transport. */
export function entriesFor(server: McpServer): McpKeyValue[] {
  return server.transport === "stdio" ? server.env : server.headers;
}

/** The OS-keychain "provider" string a secret env/header value is stored under.
 *  Namespaced per server id + entry key so two servers can't collide. */
export function mcpSecretRef(serverId: string, entryKey: string): string {
  return `mcp-server/${serverId}/${entryKey}`;
}

/**
 * Validate one server against the rest of the registry. Returns the first
 * problem as a human message, or null when it's valid. Drives the dialog's
 * inline error + disabled Save (we never silently drop a bad server).
 */
export function validateMcpServer(
  server: McpServer,
  others: McpServer[],
): string | null {
  const name = server.name.trim();
  if (!name) return "Give the server a name.";
  if (!MCP_NAME_RE.test(name))
    return "Name can use letters, digits, - and _ only (no spaces).";
  // Names are unique across the WHOLE registry, not per scope: the name is the
  // key in the generated config, and a session can hold global + repo-scoped
  // servers together, so two same-named servers could otherwise collide. Global
  // uniqueness keeps every generated config key unambiguous.
  if (
    others.some(
      (o) =>
        o.id !== server.id &&
        o.name.trim().toLowerCase() === name.toLowerCase(),
    )
  )
    return `Another server is already named "${name}".`;

  if (server.transport === "stdio") {
    if (!server.command.trim()) return "Enter the command to run (e.g. npx).";
  } else {
    const url = server.url.trim();
    if (!url) return "Enter the server URL.";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Enter a valid URL (https://…).";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return "URL must be http(s).";
  }

  const entries = entriesFor(server);
  const seen = new Set<string>();
  for (const e of entries) {
    const key = e.key.trim();
    if (!key)
      return server.transport === "stdio"
        ? "An environment variable is missing its name."
        : "A header is missing its name.";
    if (seen.has(key))
      return `Duplicate ${server.transport === "stdio" ? "variable" : "header"} "${key}".`;
    seen.add(key);
  }
  return null;
}
