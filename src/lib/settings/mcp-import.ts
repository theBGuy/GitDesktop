import { invoke } from "@/lib/tauri/invoke";
import type { McpServer } from "./api";
import { MCP_NAME_RE, MCP_SCOPE_GLOBAL } from "./mcp";

/** A server object as it appears in a Claude `.mcp.json` / `~/.claude.json`. */
interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** One server found in an existing config (from the Rust discovery command). */
export interface DiscoveredServer {
  origin: "repo" | "global";
  name: string;
  config: RawMcpServer;
}

/** Read MCP servers already configured for Claude — the open repo's `.mcp.json`
 *  and the global `~/.claude.json` — for the reviewed-import flow. Read-only. */
export const discoverMcpServers = (repoPath: string | null) =>
  invoke<DiscoveredServer[]>("discover_mcp_servers", {
    repoPath: repoPath ?? null,
  });

/** Env/header names that almost certainly hold a secret, so on import their
 *  values go to the keychain instead of settings.json. Shared with the registry
 *  browser, which applies the same heuristic on top of the registry's own
 *  `isSecret` flag. */
export const SECRET_KEY_RE =
  /key|token|secret|password|passwd|auth|credential|bearer/i;

/** Coerce a source name to the registry's charset (letters/digits/`-`/`_`, must
 *  start with an alphanumeric). Spaces → `-`; e.g. "Astro docs" → "Astro-docs". */
export function normalizeMcpName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");
  return MCP_NAME_RE.test(cleaned) ? cleaned : "server";
}

/** A discovered server prepared for import: the registry entry it becomes, plus
 *  the secret values to stash in the keychain (never written to settings.json). */
export interface ImportCandidate {
  server: McpServer;
  origin: "repo" | "global";
  /** Original source name, shown when normalization changed it. */
  sourceName: string;
  renamed: boolean;
  /** Secret-flagged values, staged for the keychain at the settings Save. */
  secretWrites: { key: string; value: string }[];
  /** A registry server already uses this (normalized) name. */
  duplicate: boolean;
}

/**
 * Convert a discovered server into an import candidate. Secret-looking env/header
 * values are routed to the keychain (their key recorded in `secretKeys`, value
 * emptied in the entry); everything else is imported as a literal. The entry
 * always lands **disabled** so the user opts in deliberately.
 */
export function toImportCandidate(
  d: DiscoveredServer,
  existingNames: Set<string>,
  repoPath: string | null,
): ImportCandidate {
  const id = crypto.randomUUID();
  const name = normalizeMcpName(d.name);
  const raw = d.config ?? {};
  const transport: McpServer["transport"] =
    raw.url || raw.type === "http" || raw.type === "sse" ? "http" : "stdio";

  const rawEntries = Object.entries(
    (transport === "stdio" ? raw.env : raw.headers) ?? {},
  );
  const entries: { key: string; value: string }[] = [];
  const secretKeys: string[] = [];
  const secretWrites: { key: string; value: string }[] = [];
  for (const [key, value] of rawEntries) {
    if (SECRET_KEY_RE.test(key)) {
      secretKeys.push(key);
      entries.push({ key, value: "" });
      if (value) secretWrites.push({ key, value });
    } else {
      entries.push({ key, value: value ?? "" });
    }
  }

  const server: McpServer = {
    id,
    name,
    description:
      d.origin === "repo"
        ? "Imported from .mcp.json"
        : "Imported from global config",
    enabled: false,
    // A repo's `.mcp.json` server is scoped to that repo; a global one stays global.
    scope: d.origin === "repo" && repoPath ? repoPath : MCP_SCOPE_GLOBAL,
    transport,
    command: raw.command ?? "",
    args: raw.args ?? [],
    env: transport === "stdio" ? entries : [],
    url: raw.url ?? "",
    headers: transport === "http" ? entries : [],
    secretKeys,
  };

  return {
    server,
    origin: d.origin,
    sourceName: d.name,
    renamed: name !== d.name,
    secretWrites,
    duplicate: existingNames.has(name.toLowerCase()),
  };
}
