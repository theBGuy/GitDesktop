import { invoke } from "@/lib/tauri/invoke";
import {
  COLD_START,
  coldStartDeleteSecret,
  coldStartGetSecret,
  coldStartSetSecret,
} from "@/lib/test-mode";

/** Absolute path to the managed MCP launcher executable — ensures the
 *  update-safe copy exists (Windows) before returning. The command for the
 *  "use GitDesktop as an MCP server" config (`<launcher> mcp --repo <path>`). */
export const mcpLauncherPath = () => invoke<string>("mcp_launcher_path");

/** State of the `gitdesktop-mcp` command-line launcher (Settings → MCP servers).
 *  Windows puts the managed launcher's bin dir on the user PATH (migrating any
 *  older app-dir entry); macOS/Linux symlink `gitdesktop-mcp` into ~/.local/bin.
 *  See src-tauri/src/path_launcher.rs. */
export interface PathLauncherStatus {
  /** `gitdesktop-mcp` resolves in a newly-opened terminal (persisted PATH). */
  onPath: boolean;
  /** We installed it, so Remove can undo it (false when on PATH by other means). */
  managed: boolean;
  /** Install location for display (the PATH dir on Windows, symlink path on Unix). */
  target: string;
  /** Persistent caveat, e.g. Unix "~/.local/bin isn't on your PATH". */
  warning: string | null;
  /** One-shot success note from install/remove (shown as a toast, not persisted). */
  note: string | null;
}

export const pathLauncherStatus = () =>
  invoke<PathLauncherStatus>("path_launcher_status");

/** Add `gitdesktop` to PATH (append app dir / symlink), returning fresh status. */
export const pathLauncherInstall = () =>
  invoke<PathLauncherStatus>("path_launcher_install");

/** Reverse exactly what we added, returning fresh status. */
export const pathLauncherRemove = () =>
  invoke<PathLauncherStatus>("path_launcher_remove");

/** Merge the `gitdesktop` MCP entry into `<repo>/.mcp.json`, preserving any
 *  sibling servers. Returns whether it wrote and whether an entry already
 *  existed; with `overwrite:false` an existing entry is left untouched
 *  (`{ existed: true, written: false }`). */
export const mcpJsonWrite = (
  repoPath: string,
  entry: unknown,
  overwrite: boolean,
) =>
  invoke<{ written: boolean; existed: boolean }>("mcp_json_write", {
    repoPath,
    entry,
    overwrite,
  });

/** Install the `gitdesktop` MCP server into a client's GLOBAL (user-scope) config
 *  via that client's own CLI — `claude mcp add-json … -s user` /
 *  `copilot mcp add … -- <cmd>`. Mirrors mcpJsonWrite's existed/overwrite dance:
 *  `{ existed: true, written: false }` when an entry already exists and
 *  `overwrite` is false. See src-tauri/src/mcp.rs. */
export const mcpGlobalInstall = (
  client: "claude" | "copilot",
  command: string,
  args: string[],
  overwrite: boolean,
) =>
  invoke<{ written: boolean; existed: boolean }>("mcp_global_install", {
    client,
    command,
    args,
    overwrite,
  });

/** Whether a client's GLOBAL (user-scope) config has a `gitdesktop` server, and
 *  whether its configured command points at the CURRENT managed launcher. */
export interface McpGlobalClientStatus {
  /** A `gitdesktop` server exists in this client's user config. */
  installed: boolean;
  /** The configured command, or null when not installed (for display). */
  command: string | null;
  /** The configured command resolves to the current managed launcher
   *  (path-normalized) — false for an older install or a custom entry. */
  current: boolean;
  /** The installed entry's `args` (string elements only), so the UI can read
   *  WHICH permission tier is installed and nudge Reinstall when it drifts from
   *  the selected permissions. `null` when not installed, unreadable, or the
   *  entry predates this probe — never guessed. */
  args: string[] | null;
}

export interface McpGlobalStatus {
  claude: McpGlobalClientStatus;
  copilot: McpGlobalClientStatus;
}

/** Read-only probe of the global `gitdesktop` install state for both clients,
 *  by reading each client's config file directly (no CLI spawn). Never creates
 *  the managed launcher copy. See src-tauri/src/mcp.rs. */
export const mcpGlobalStatus = () =>
  invoke<McpGlobalStatus>("mcp_global_status");

/** Remove the `gitdesktop` server from a client's GLOBAL (user-scope) config via
 *  that client's own CLI. Errors carry actionable messages (e.g. CLI not found). */
export const mcpGlobalRemove = (client: "claude" | "copilot") =>
  invoke<null>("mcp_global_remove", { client });

// MCP server secrets are keyed per registered server id + entry (env/header)
// name; in cold-start mode they reuse the isolated store via a combined key.
const mcpRef = (serverId: string, key: string) =>
  `mcp-server/${serverId}/${key}`;

export const setMcpSecret = (serverId: string, key: string, value: string) =>
  COLD_START
    ? Promise.resolve(coldStartSetSecret(mcpRef(serverId, key), value))
    : invoke<void>("set_mcp_secret", { serverId, key, value });

export const deleteMcpSecret = (serverId: string, key: string) =>
  COLD_START
    ? Promise.resolve(coldStartDeleteSecret(mcpRef(serverId, key)))
    : invoke<void>("delete_mcp_secret", { serverId, key });

export const mcpSecretExists = (serverId: string, key: string) =>
  COLD_START
    ? Promise.resolve(coldStartGetSecret(mcpRef(serverId, key)) !== null)
    : invoke<boolean>("mcp_secret_exists", { serverId, key });
