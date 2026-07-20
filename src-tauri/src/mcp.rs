//! Managed MCP-server config generation for agent sessions.
//!
//! GitDesktop is not an MCP client — the CLIs are the hosts. This module only
//! turns the user's registered, session-opted-in servers into the config file a
//! CLI consumes, resolving any secret env/header values from the OS keychain at
//! launch time (so secrets never live in settings.json, argv, or the worktree).
//!
//! Host sessions are wired for **Claude**, **GitHub Copilot**, and **opencode** —
//! each consumes a different config shape (`build_claude_config` /
//! `build_copilot_config` / `build_opencode_config`) delivered a different way
//! (Claude `--mcp-config`, Copilot `--additional-mcp-config @file`, opencode the
//! `OPENCODE_CONFIG` env var). **Codex** is container-only (`build_codex_config`);
//! container delivery for the other CLIs is a later tier.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// One opted-in server, passed from the frontend (resolved from the settings
/// registry). Secret values are NOT here — `secret_keys` names the env/header
/// entries whose values live in the keychain under `mcp-server/<id>/<key>`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    pub id: String,
    pub name: String,
    /// "stdio" | "http".
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<KeyValue>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub secret_keys: Vec<String>,
}

/// Build the single `McpServerSpec` that exposes GitDesktop ITSELF as a read-only
/// MCP server for a CLI PR review (`gitdesktop mcp --repo <repo_path>`), so the
/// review agent can pull the full PR diff / read files at any ref / blame / list
/// PR comments instead of relying on the budget-truncated diff in the prompt.
///
/// The command is the CURRENT executable resolved at call time — NOT the update-safe
/// managed launcher (`mcp_launcher.rs`). That launcher exists so a persisted GLOBAL
/// config entry keeps working after the app updates and its exe is replaced; here the
/// config is regenerated per review run, so `current_exe()` is always fresh and the
/// managed copy is unnecessary. No env/url/headers/secrets: it's a plain stdio server
/// launched read-only (no `--allow-write` / `--allow-remote-write`).
pub fn self_server_spec(repo_path: &str) -> AppResult<McpServerSpec> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Command(format!("resolve current executable: {e}")))?;
    Ok(McpServerSpec {
        id: "gitdesktop".into(),
        name: "gitdesktop".into(),
        transport: "stdio".into(),
        command: exe.to_string_lossy().into_owned(),
        args: vec!["mcp".into(), "--repo".into(), repo_path.to_string()],
        env: vec![],
        url: String::new(),
        headers: vec![],
        secret_keys: vec![],
    })
}

impl McpServerSpec {
    fn is_stdio(&self) -> bool {
        self.transport == "stdio"
    }
    /// env (stdio) or headers (http) for this server's transport.
    fn entries(&self) -> &[KeyValue] {
        if self.is_stdio() {
            &self.env
        } else {
            &self.headers
        }
    }
}

/// Resolve a server's env/header map, substituting secret values from the
/// keychain. Fails loudly if an entry is marked secret but has no stored value —
/// a silent empty token would just make the server fail opaquely at runtime.
fn resolve_entries(spec: &McpServerSpec) -> AppResult<Map<String, Value>> {
    let secret: std::collections::HashSet<&str> =
        spec.secret_keys.iter().map(String::as_str).collect();
    let mut out = Map::new();
    for kv in spec.entries() {
        let value = if secret.contains(kv.key.as_str()) {
            crate::secrets::read_mcp_secret(&spec.id, &kv.key)?.ok_or_else(|| {
                AppError::Command(format!(
                    "MCP server \"{}\": secret \"{}\" isn't set. Add it in Settings → MCP servers.",
                    spec.name, kv.key
                ))
            })?
        } else {
            kv.value.clone()
        };
        out.insert(kv.key.clone(), Value::String(value));
    }
    Ok(out)
}

/// Claude's `--tools` allowlist entries that expose every opted-in server's
/// tools: `mcp__<server>` admits all tools from that server. Loading a server via
/// `--mcp-config` is NOT enough — `--tools` is a strict allowlist, so without
/// these the server connects but its tools can never be called (caught live).
pub fn tool_allow_patterns(specs: &[McpServerSpec]) -> Vec<String> {
    specs.iter().map(|s| format!("mcp__{}", s.name)).collect()
}

/// Build Claude Code's `{ "mcpServers": { name: {…} } }` document for the given
/// opted-in servers. Each server is keyed by its (unique) name.
pub fn build_claude_config(specs: &[McpServerSpec]) -> AppResult<Value> {
    let mut servers = Map::new();
    for spec in specs {
        let entry = if spec.is_stdio() {
            json!({
                "command": spec.command,
                "args": spec.args,
                "env": resolve_entries(spec)?,
            })
        } else {
            json!({
                "type": "http",
                "url": spec.url,
                "headers": resolve_entries(spec)?,
            })
        };
        servers.insert(spec.name.clone(), entry);
    }
    Ok(json!({ "mcpServers": servers }))
}

/// Build GitHub Copilot CLI's `{ "mcpServers": { name: {…} } }` document, passed
/// per-session via `--additional-mcp-config @<path>` (it *augments* — never mutates
/// — the user's `~/.copilot/mcp-config.json`). A stdio server uses `"type": "local"`
/// (the config-file spelling; the CLI's `--transport` flag spells the same thing
/// "stdio"), an http server `"type": "http"`. `"tools": ["*"]` exposes every tool;
/// `--allow-all-tools` (already passed for non-interactive runs) auto-approves them,
/// so no per-tool allowlist is needed — unlike Claude. Secrets are resolved into the
/// `env` / `headers` map from the keychain, never argv.
pub fn build_copilot_config(specs: &[McpServerSpec]) -> AppResult<Value> {
    let mut servers = Map::new();
    for spec in specs {
        let entry = if spec.is_stdio() {
            json!({
                "type": "local",
                "command": spec.command,
                "args": spec.args,
                "env": resolve_entries(spec)?,
                "tools": ["*"],
            })
        } else {
            json!({
                "type": "http",
                "url": spec.url,
                "headers": resolve_entries(spec)?,
                "tools": ["*"],
            })
        };
        servers.insert(spec.name.clone(), entry);
    }
    Ok(json!({ "mcpServers": servers }))
}

/// The name of GitDesktop's generated opencode Research agent (see
/// `build_opencode_config`). Selected with `opencode run --agent <this>`.
pub const GD_RESEARCH_AGENT: &str = "gd-research";

/// Build opencode's config document, pointed at per-session via the `OPENCODE_CONFIG`
/// env var. opencode *merges* config layers (it never replaces), so this adds our
/// servers (and the Research agent) on top of the user's global config without
/// disturbing it. A stdio server is `"type": "local"` with a single `command`
/// ARRAY (the binary + args, joined — opencode has no separate args field) and an
/// `environment` map; an http server is `"type": "remote"` with `url` + `headers`.
/// `enabled: true` is explicit. Tools are auto-exposed and `--dangerously-skip-permissions`
/// (already passed) auto-approves them, so no allowlist is needed.
///
/// `research` adds a read-only **web** agent (`GD_RESEARCH_AGENT`): the builtin
/// `plan` agent is read-only but has NO web tools, and opencode has no permission
/// CLI flags, so a read-only-with-web profile must be defined in config — edit/bash
/// denied, webfetch/websearch allowed. (`websearch` also needs Exa enabled — the
/// opencode provider or `OPENCODE_ENABLE_EXA`; `webfetch` always works.)
pub fn build_opencode_config(specs: &[McpServerSpec], research: bool) -> AppResult<Value> {
    let mut servers = Map::new();
    for spec in specs {
        let entry = if spec.is_stdio() {
            let mut command = vec![Value::String(spec.command.clone())];
            command.extend(spec.args.iter().map(|a| Value::String(a.clone())));
            json!({
                "type": "local",
                "command": command,
                "environment": resolve_entries(spec)?,
                "enabled": true,
            })
        } else {
            json!({
                "type": "remote",
                "url": spec.url,
                "headers": resolve_entries(spec)?,
                "enabled": true,
            })
        };
        servers.insert(spec.name.clone(), entry);
    }
    let mut doc = json!({ "mcp": servers });
    if research {
        doc["agent"] = json!({
            GD_RESEARCH_AGENT: {
                "description": "GitDesktop read-only web research — no file writes.",
                "mode": "primary",
                // STRUCTURAL read-only guarantee (matches the builtin `plan` agent):
                // remove the write surface entirely so it can't be auto-approved by
                // `--dangerously-skip-permissions` — robust even if a future opencode
                // tool or an attached MCP server escapes the permission denylist below.
                "tools": {
                    "write": false,
                    "edit": false,
                    "patch": false,
                    "bash": false,
                },
                // Belt-and-suspenders + the web tools: deny edits/shell, allow web.
                "permission": {
                    "edit": "deny",
                    "bash": "deny",
                    "webfetch": "allow",
                    "websearch": "allow",
                },
            },
        });
    }
    Ok(doc)
}

/// Server-name charset (mirrors the frontend `MCP_NAME_RE`): a letter/digit first,
/// then letters/digits/`-`/`_`. Safe as a bare TOML key and a JSON map key.
fn is_valid_server_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Pre-flight each opted-in server before turn 1 spawns. Catches the
/// deterministic failures — bad name, missing command/url, a secret that was never
/// entered — with an actionable message so the user fixes it instead of seeing
/// the agent fail opaquely. (Resolving the stdio binary on PATH is intentionally
/// left to the CLI itself: a cross-platform PATH/PATHEXT probe is fragile enough
/// that a false "not found" would block valid setups.)
pub fn validate_specs(specs: &[McpServerSpec]) -> AppResult<()> {
    for spec in specs {
        // The name is a config key (a bare TOML table key for Codex, a JSON map
        // key for Claude). The frontend constrains it, but validate it server-side
        // too so a name from any future caller can't break / inject the config.
        if !is_valid_server_name(&spec.name) {
            return Err(AppError::Command(format!(
                "MCP server name \"{}\" is invalid — use letters, digits, - and _ (starting with a letter or digit).",
                spec.name
            )));
        }
        if spec.is_stdio() {
            if spec.command.trim().is_empty() {
                return Err(AppError::Command(format!(
                    "MCP server \"{}\" has no command to run.",
                    spec.name
                )));
            }
        } else {
            let url = spec.url.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(AppError::Command(format!(
                    "MCP server \"{}\" needs a valid http(s) URL.",
                    spec.name
                )));
            }
        }
        // Force keychain resolution now so a missing secret is reported here, by
        // name, rather than as a runtime failure inside the CLI.
        resolve_entries(spec)?;
    }
    Ok(())
}

/// `<app_data>/mcp` — where per-session host config files are written. Kept out
/// of the repo/worktree entirely (the generated file may contain resolved
/// secrets, so it must never be a candidate for commit).
fn config_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
        .join("mcp"))
}

/// The generated-config filenames a host session can leave in `<app_data>/mcp`,
/// one per CLI shape. Each turn references its file explicitly (Claude's
/// `--mcp-config`, Copilot's `@file`, opencode's `OPENCODE_CONFIG`), so a stale
/// file from a de-selected turn is simply never read — but cleanup still removes
/// all of them when a session is discarded.
const HOST_CONFIG_FILES: [&str; 3] = ["json", "copilot.json", "opencode.json"];

/// Validate the session id + servers, serialize `config`, and write it to a stable
/// per-session path (`<app_data>/mcp/<session_id>.<ext>`) — kept out of the
/// repo/worktree since it may hold resolved secrets. Overwritten each turn so an
/// edited registry takes effect next turn. Returns `Ok(None)` when there are no
/// servers (the caller then omits the flag/env, so nothing loads).
fn write_session_config(
    app: &tauri::AppHandle,
    session_id: &str,
    ext: &str,
    specs: &[McpServerSpec],
    config: &Value,
    // Write even when there are no MCP servers — e.g. an opencode Research session
    // whose config carries only the generated read-only-web agent, no servers.
    force: bool,
) -> AppResult<Option<PathBuf>> {
    if specs.is_empty() && !force {
        return Ok(None);
    }
    crate::sessions::validate_id(session_id)?;
    let dir = config_root(app)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{session_id}.{ext}"));
    let body = serde_json::to_string_pretty(config)
        .map_err(|e| AppError::Command(format!("serialize mcp config: {e}")))?;
    std::fs::write(&path, body)?;
    Ok(Some(path))
}

/// Generate + write the Claude config for a HOST session, returning its path for
/// `--mcp-config`. `Ok(None)` when there are no servers.
pub fn write_host_config(
    app: &tauri::AppHandle,
    session_id: &str,
    specs: &[McpServerSpec],
) -> AppResult<Option<PathBuf>> {
    validate_specs(specs)?;
    write_session_config(
        app,
        session_id,
        "json",
        specs,
        &build_claude_config(specs)?,
        false,
    )
}

/// Generate + write the GitHub Copilot config for a HOST session, returning its
/// path for `--additional-mcp-config @<path>`. `Ok(None)` when there are no servers.
pub fn write_copilot_config(
    app: &tauri::AppHandle,
    session_id: &str,
    specs: &[McpServerSpec],
) -> AppResult<Option<PathBuf>> {
    validate_specs(specs)?;
    write_session_config(
        app,
        session_id,
        "copilot.json",
        specs,
        &build_copilot_config(specs)?,
        false,
    )
}

/// Generate + write the opencode config for a HOST session, returning its path for
/// the `OPENCODE_CONFIG` env var. `Ok(None)` when there are no servers AND it's not
/// a Research session (which writes the read-only-web agent even with no servers).
pub fn write_opencode_config(
    app: &tauri::AppHandle,
    session_id: &str,
    specs: &[McpServerSpec],
    research: bool,
) -> AppResult<Option<PathBuf>> {
    validate_specs(specs)?;
    write_session_config(
        app,
        session_id,
        "opencode.json",
        specs,
        &build_opencode_config(specs, research)?,
        research,
    )
}

/// Remove a session's generated host configs (best-effort, every CLI shape),
/// called on cleanup so resolved-secret files don't linger after a session is
/// discarded.
pub fn cleanup_host_config(app: &tauri::AppHandle, session_id: &str) {
    if crate::sessions::validate_id(session_id).is_err() {
        return;
    }
    if let Ok(dir) = config_root(app) {
        for ext in HOST_CONFIG_FILES {
            let _ = std::fs::remove_file(dir.join(format!("{session_id}.{ext}")));
        }
    }
}

// --- Codex (container only) --------------------------------------------------
//
// Codex reads MCP servers from its `~/.codex/config.toml`, NOT a `--mcp-config`
// flag. A container session's `~/.codex` is a per-session mounted home seeded
// with only the user's `auth.json`, so writing our `config.toml` there makes the
// opted-in servers the ONLY MCP source (strict) and keeps secrets in the file,
// never in argv. Host Codex is unsupported on purpose: `codex exec` cancels every
// MCP tool call (stdin EOF → "declined", upstream); the container already passes
// `--dangerously-bypass-approvals-and-sandbox`, so its tool calls run.

/// A TOML basic-string literal for an arbitrary value — escapes quotes, backslashes
/// and control chars, so a secret with special characters can't break the file.
fn toml_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Control chars incl. DEL (U+007F) must be escaped or the TOML parser
            // rejects the whole file — a secret with a stray control byte otherwise
            // fails the session opaquely.
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A TOML key — bare when it's the safe charset, else a quoted literal.
fn toml_key(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        s.to_string()
    } else {
        toml_basic_string(s)
    }
}

/// Build Codex's `config.toml` body for the opted-in servers (written into the
/// session's mounted `~/.codex` home). **stdio only** — Codex's remote-MCP config
/// supports just a bearer token, not the arbitrary headers our http servers carry,
/// so the composer offers Codex local servers only; a remote one here is an error.
/// Secrets are resolved into each `[mcp_servers.<name>.env]` table.
pub fn build_codex_config(specs: &[McpServerSpec]) -> AppResult<String> {
    let mut out = String::new();
    for spec in specs {
        if !spec.is_stdio() {
            return Err(AppError::Command(format!(
                "Codex sessions support local (stdio) MCP servers only right now; \
                 \"{}\" is a remote server.",
                spec.name
            )));
        }
        // The server name is validated (letters/digits/`-`/`_`), so it's a safe
        // bare TOML key.
        out.push_str(&format!("[mcp_servers.{}]\n", spec.name));
        out.push_str(&format!("command = {}\n", toml_basic_string(&spec.command)));
        let args: Vec<String> = spec.args.iter().map(|a| toml_basic_string(a)).collect();
        out.push_str(&format!("args = [{}]\n", args.join(", ")));
        let env = resolve_entries(spec)?;
        if !env.is_empty() {
            out.push_str(&format!("\n[mcp_servers.{}.env]\n", spec.name));
            for (key, value) in &env {
                out.push_str(&format!(
                    "{} = {}\n",
                    toml_key(key),
                    toml_basic_string(value.as_str().unwrap_or(""))
                ));
            }
        }
        out.push('\n');
    }
    Ok(out)
}

// --- discovery (import, not inherit) -----------------------------------------
//
// Reads the MCP servers the user has ALREADY configured for Claude — the open
// repo's `.mcp.json` and the global `~/.claude.json` — so the Settings panel can
// offer them as a reviewed import into the managed registry. This is the only
// place GitDesktop reads those files; sessions never inherit them (that's what
// `--strict-mcp-config` enforces). Read-only: the source files are never written.

/// One server found in an existing config, with where it came from. `config` is
/// the raw server object (Claude `.mcp.json` shape) for the frontend to convert.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    /// "repo" (the open repo's `.mcp.json`) or "global" (`~/.claude.json`).
    origin: String,
    name: String,
    config: Value,
}

/// `mcpServers` map from a config file, pushing each entry. Best-effort: a
/// missing / oversized / malformed file is silently skipped (it just yields no
/// imports). The size guard keeps a large `~/.claude.json` (it also holds chat
/// history) from being slurped whole.
fn collect_discovered(path: &Path, origin: &str, out: &mut Vec<DiscoveredServer>) {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    match std::fs::metadata(path) {
        Ok(m) if m.len() <= MAX_BYTES => {}
        _ => return,
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, config) in servers {
            out.push(DiscoveredServer {
                origin: origin.into(),
                name: name.clone(),
                config: config.clone(),
            });
        }
    }
}

/// Discover MCP servers already configured for Claude, for the Settings import
/// flow: the open repo's `.mcp.json` (when a repo is open) and the global
/// `~/.claude.json`. Read-only; returns an empty list when neither exists.
#[tauri::command]
pub async fn discover_mcp_servers(
    app: tauri::AppHandle,
    repo_path: Option<String>,
) -> AppResult<Vec<DiscoveredServer>> {
    use tauri::Manager;
    let mut out = Vec::new();
    if let Some(rp) = repo_path.as_deref().filter(|s| !s.is_empty()) {
        collect_discovered(&Path::new(rp).join(".mcp.json"), "repo", &mut out);
    }
    if let Ok(home) = app.path().home_dir() {
        collect_discovered(&home.join(".claude.json"), "global", &mut out);
    }
    Ok(out)
}

// --- config-helper backend (write the `gitdesktop` server into `.mcp.json`) ------
//
// The GUI "Use GitDesktop as an MCP server" helper calls this to add the
// `gitdesktop` server entry to a project's `.mcp.json` — the SAME file shape
// `discover_mcp_servers` reads (top-level `"mcpServers"`). It merges: every sibling
// server and any unknown top-level key is preserved. This writes ONLY the local
// `.mcp.json`; no git operation is ever involved.

/// Result of [`mcp_json_write`]. `written` is whether the file was actually written;
/// `existed` is whether a `gitdesktop` entry was already present (so the GUI can
/// confirm before overwriting).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpJsonWriteResult {
    pub written: bool,
    pub existed: bool,
}

/// Write/merge the `gitdesktop` server `entry` into `<repo_path>/.mcp.json`.
///
/// - A missing file starts from `{"mcpServers":{}}`.
/// - A malformed existing file is an ERROR (never clobbered).
/// - If `mcpServers.gitdesktop` already exists and `!overwrite`, returns
///   `{ written: false, existed: true }` untouched (the GUI confirms, then re-calls
///   with `overwrite: true`).
/// - Otherwise sets `mcpServers.gitdesktop = entry`, preserving ALL sibling servers
///   and unknown top-level keys, and pretty-writes the file with a trailing newline.
#[tauri::command]
pub async fn mcp_json_write(
    repo_path: String,
    entry: Value,
    overwrite: bool,
) -> AppResult<McpJsonWriteResult> {
    let path = Path::new(&repo_path).join(".mcp.json");

    // The entry must be a JSON object — anything else (null, number, array) would write an
    // invalid MCP server config. Fail fast before touching the file.
    if !entry.is_object() {
        return Err(AppError::Command(
            "the .mcp.json entry must be a JSON object".to_string(),
        ));
    }

    // Parse the existing file as a Value so unknown keys round-trip. Missing → start
    // from an empty document; malformed → error (do NOT clobber the user's file).
    let mut doc: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            AppError::Command(format!(
                "{} is not valid JSON: {e}. Fix or remove it, then try again.",
                path.display()
            ))
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "mcpServers": {} }),
        Err(e) => return Err(AppError::Io(e)),
    };
    if !doc.is_object() {
        return Err(AppError::Command(format!(
            "{} is not a JSON object.",
            path.display()
        )));
    }

    // Ensure `mcpServers` is an object (create it if absent; error if present but the
    // wrong type rather than dropping it).
    let root = doc.as_object_mut().expect("checked is_object above");
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    let servers = servers.as_object_mut().ok_or_else(|| {
        AppError::Command(format!(
            "{} has a non-object \"mcpServers\".",
            path.display()
        ))
    })?;

    let existed = servers.contains_key("gitdesktop");
    if existed && !overwrite {
        return Ok(McpJsonWriteResult {
            written: false,
            existed: true,
        });
    }
    servers.insert("gitdesktop".to_string(), entry);

    let mut body = serde_json::to_string_pretty(&doc)
        .map_err(|e| AppError::Command(format!("serialize .mcp.json: {e}")))?;
    body.push('\n');
    crate::fsops::atomic_write(&path, body.as_bytes())?;

    Ok(McpJsonWriteResult {
        written: true,
        existed,
    })
}

/// Result of a GLOBAL (user-scope) MCP install, mirroring [`McpJsonWriteResult`]:
/// `existed` = an entry was already there; with `overwrite:false` it's left
/// untouched (`written:false`) so the GUI confirms, then re-calls `overwrite:true`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGlobalInstallResult {
    pub written: bool,
    pub existed: bool,
}

const MCP_CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Run a client CLI (`claude` / `copilot`) non-interactively, returning
/// (stdout, stderr, exit_code). A missing binary is a friendly, actionable error.
async fn run_client_cli(bin: &str, args: &[&str]) -> AppResult<(String, String, i32)> {
    use std::process::Stdio;

    use tokio::process::Command;

    // Resolve through the shared resolver (PATH + candidate dirs + the LIVE registry
    // PATH on Windows, macOS login shell) rather than a bare `Command::new(bin)`, which
    // only searches the app's *inherited* PATH — a `claude`/`copilot` installed to a
    // registry-PATH-only dir (or added to PATH after the app launched) would otherwise
    // read as "not found". Mirrors every other CLI runner; see the resolver gotcha in
    // agent.rs (`resolve_named`).
    let program = crate::agent::resolve_named(&[bin], None).await.ok_or_else(|| {
        AppError::Command(format!(
            "`{bin}` was not found on PATH. Install it, or copy the snippet into the config manually."
        ))
    })?;

    let mut cmd = Command::new(&program);
    cmd.args(args)
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    let output = tokio::time::timeout(MCP_CLI_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::Timeout(MCP_CLI_TIMEOUT.as_secs()))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Command(format!(
                    "`{bin}` was not found on PATH. Install it, or copy the snippet into the config manually."
                ))
            } else {
                AppError::Io(e)
            }
        })?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code().unwrap_or(-1),
    ))
}

/// Both `claude` and `copilot` report a duplicate name with "already exists" —
/// distinguish that (a benign "confirm to replace") from a real add failure.
/// `output` is the CLI's combined stdout+stderr (either stream may carry it).
fn is_already_exists(output: &str) -> bool {
    output.to_lowercase().contains("already exists")
}

/// Install the `gitdesktop` server into a client's GLOBAL (user-scope) config via
/// the client's OWN CLI — safer than hand-editing `~/.claude.json` /
/// `~/.copilot/mcp-config.json`. `command` + `args` are the stdio entry to write
/// (the caller already picked the client-appropriate dynamic `--repo`). Both CLIs
/// error on a duplicate name, so `overwrite` removes the existing entry first.
#[tauri::command]
pub async fn mcp_global_install(
    client: String,
    command: String,
    args: Vec<String>,
    overwrite: bool,
) -> AppResult<McpGlobalInstallResult> {
    match client.as_str() {
        "claude" => claude_global_install(&command, &args, overwrite).await,
        "copilot" => copilot_global_install(&command, &args, overwrite).await,
        other => Err(AppError::Command(format!(
            "unknown MCP client \"{other}\" (expected \"claude\" or \"copilot\")"
        ))),
    }
}

/// Remove the `gitdesktop` entry from Claude's GLOBAL (user-scope) config via its
/// own CLI. `-s user` scopes to the user config (where `add-json -s user` writes).
async fn claude_global_remove() -> AppResult<(String, String, i32)> {
    run_client_cli("claude", &["mcp", "remove", "gitdesktop", "-s", "user"]).await
}

/// Remove the `gitdesktop` entry from Copilot's user config via its own CLI.
/// `copilot mcp remove` takes NO scope flag — it only ever manages the user config
/// (`~/.copilot/mcp-config.json`), which is exactly where `add` writes.
async fn copilot_global_remove() -> AppResult<(String, String, i32)> {
    run_client_cli("copilot", &["mcp", "remove", "gitdesktop"]).await
}

async fn claude_global_install(
    command: &str,
    args: &[String],
    overwrite: bool,
) -> AppResult<McpGlobalInstallResult> {
    let entry_str = serde_json::to_string(&json!({ "command": command, "args": args }))
        .map_err(|e| AppError::Command(format!("serialize entry: {e}")))?;
    if overwrite {
        // May or may not exist; a "not found" remove is harmless.
        let _ = claude_global_remove().await;
    }
    let (stdout, stderr, code) = run_client_cli(
        "claude",
        &["mcp", "add-json", "gitdesktop", &entry_str, "-s", "user"],
    )
    .await?;
    if code == 0 {
        return Ok(McpGlobalInstallResult { written: true, existed: overwrite });
    }
    // Fold both streams — a CLI may print the duplicate-name / error text to
    // stdout, and either detecting a benign "already exists" or surfacing a real
    // failure must not depend on which stream it chose.
    let out = format!("{stdout}{stderr}");
    if is_already_exists(&out) {
        return Ok(McpGlobalInstallResult { written: false, existed: true });
    }
    Err(AppError::Command(format!(
        "`claude mcp add-json` failed: {}",
        out.trim()
    )))
}

async fn copilot_global_install(
    command: &str,
    args: &[String],
    overwrite: bool,
) -> AppResult<McpGlobalInstallResult> {
    if overwrite {
        // `copilot mcp remove` takes NO scope flag — it only ever manages the user
        // config (`~/.copilot/mcp-config.json`), which is exactly where `add`
        // writes, so there's no scope to mismatch. A "not found" remove is harmless.
        let _ = copilot_global_remove().await;
    }
    // `copilot mcp add gitdesktop -- <command> <args...>` — everything after `--`
    // is the stdio launch command, written to Copilot's user config.
    let mut argv: Vec<&str> = vec!["mcp", "add", "gitdesktop", "--", command];
    argv.extend(args.iter().map(String::as_str));
    let (stdout, stderr, code) = run_client_cli("copilot", &argv).await?;
    if code == 0 {
        return Ok(McpGlobalInstallResult { written: true, existed: overwrite });
    }
    // Fold both streams (see claude_global_install) — don't depend on which one
    // the CLI uses for the duplicate-name / error text.
    let out = format!("{stdout}{stderr}");
    if is_already_exists(&out) {
        return Ok(McpGlobalInstallResult { written: false, existed: true });
    }
    Err(AppError::Command(format!(
        "`copilot mcp add` failed: {}",
        out.trim()
    )))
}

// --- global install STATUS + REMOVE ------------------------------------------
//
// The Settings "Install globally" buttons write a `gitdesktop` server into a
// client's user config. These read-only probes let the UI tell whether an entry
// already exists — and whether it points at the CURRENT managed launcher vs an
// older install path (old-path entries keep locking the installed exe against
// updates) — and the remove command lets the UI clear one.

/// Per-client global-install status. See the frozen contract in P4.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGlobalClientStatus {
    /// A `gitdesktop` entry exists in this client's global (user) config.
    pub installed: bool,
    /// The configured command string, when installed and readable.
    pub command: Option<String>,
    /// The configured command points at the CURRENT managed launcher path
    /// (path-normalized compare). False for older install paths or custom entries.
    pub current: bool,
    /// The installed entry's `args` array (string elements only), so the UI can
    /// show WHICH permission tier is installed and nudge Reinstall on drift.
    /// `None` when not installed, unreadable, or the args aren't an array — never
    /// guessed. Non-string elements are dropped, never panicked on.
    pub args: Option<Vec<String>>,
}

impl McpGlobalClientStatus {
    fn not_installed() -> Self {
        Self {
            installed: false,
            command: None,
            current: false,
            args: None,
        }
    }
}

/// Global-install status across every supported client.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGlobalStatus {
    pub claude: McpGlobalClientStatus,
    pub copilot: McpGlobalClientStatus,
}

/// Path-normalized comparison for the launcher-path check: trailing-separator
/// insensitive and `/` vs `\` insensitive (unconditional — the separator fold is
/// applied to both sides, so it stays compare-safe everywhere). Case folding is
/// gated to case-insensitive filesystems (Windows, macOS); on Linux two paths
/// differing only in case are genuinely distinct, so case is preserved there.
/// Mirrors `path_launcher::norm` (which is `#[cfg(windows)]`-private, so it's
/// re-derived locally here) with the interior-separator fold added.
fn norm_launcher_path(p: &str) -> String {
    let normalized = p.trim().trim_end_matches(['\\', '/']).replace('/', "\\");
    #[cfg(any(windows, target_os = "macos"))]
    let normalized = normalized.to_ascii_lowercase();
    normalized
}

/// Classify a client's user-config JSON into an [`McpGlobalClientStatus`] for the
/// `gitdesktop` entry. Pure — takes the parsed config `Value` and the current
/// launcher path so tests need no filesystem or env. Tolerant of untrusted JSON:
///
/// * `mcpServers.gitdesktop` absent (or the shape isn't a map) ⇒ not installed.
/// * present but `command` isn't a string ⇒ installed, `command: None`,
///   `current: false` (args still carried when present).
/// * present with a string `command` ⇒ installed; `current` iff it path-normal-
///   equals `launcher_path`.
///
/// `args` carries the entry's `args` array (string elements only) whenever the
/// entry exists and `args` is an array; non-string junk elements are dropped and
/// a non-array `args` yields `None`. Untrusted JSON from another CLI's config, so
/// every element is type-checked — this never panics on shape surprises.
fn classify_global_entry(config: &Value, launcher_path: &str) -> McpGlobalClientStatus {
    let Some(entry) = config
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get("gitdesktop"))
    else {
        return McpGlobalClientStatus::not_installed();
    };
    // Only string elements count; a non-array `args` (or a missing one) ⇒ None.
    let args = entry.get("args").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<String>>()
    });
    let Some(command) = entry.get("command").and_then(|v| v.as_str()) else {
        // Present but no string command — installed, but we can't classify it.
        // Still carry args so the UI can read the installed tier.
        return McpGlobalClientStatus {
            installed: true,
            command: None,
            current: false,
            args,
        };
    };
    let current = norm_launcher_path(command) == norm_launcher_path(launcher_path);
    McpGlobalClientStatus {
        installed: true,
        command: Some(command.to_string()),
        current,
        args,
    }
}

/// Read + parse a client's user-config file into a JSON `Value`, tolerantly: a
/// missing / oversized / unreadable / malformed file yields `None` (⇒ treated as
/// "not installed" by the caller), never an error. The size guard matches
/// `collect_discovered` — `~/.claude.json` also holds chat history.
fn read_global_config(path: &Path) -> Option<Value> {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    match std::fs::metadata(path) {
        Ok(m) if m.len() <= MAX_BYTES => {}
        _ => return None,
    }
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

/// Read-only status of the `gitdesktop` global (user-scope) MCP install for each
/// client: whether an entry exists, its configured command, and whether that
/// command points at the CURRENT managed launcher. Reads config files directly
/// (Claude `~/.claude.json`, Copilot `~/.copilot/mcp-config.json`) — it does NOT
/// shell out and, critically, does NOT ensure/create the managed launcher copy
/// (uses [`mcp_launcher::resolved_launcher_path`], a zero-write path accessor).
/// Never errors on a missing/malformed config — those read as "not installed".
#[tauri::command]
pub async fn mcp_global_status(app: tauri::AppHandle) -> AppResult<McpGlobalStatus> {
    use tauri::Manager;

    // Zero-write: resolve the launcher path WITHOUT ensuring the copy.
    let launcher = crate::mcp_launcher::resolved_launcher_path()?
        .to_string_lossy()
        .into_owned();

    let (claude, copilot) = match app.path().home_dir() {
        Ok(home) => {
            let claude = read_global_config(&home.join(".claude.json"))
                .map(|cfg| classify_global_entry(&cfg, &launcher))
                .unwrap_or_else(McpGlobalClientStatus::not_installed);
            let copilot = read_global_config(&home.join(".copilot").join("mcp-config.json"))
                .map(|cfg| classify_global_entry(&cfg, &launcher))
                .unwrap_or_else(McpGlobalClientStatus::not_installed);
            (claude, copilot)
        }
        // No home dir ⇒ nothing to read; report both not-installed rather than error.
        Err(_) => (
            McpGlobalClientStatus::not_installed(),
            McpGlobalClientStatus::not_installed(),
        ),
    };

    Ok(McpGlobalStatus { claude, copilot })
}

/// Remove the `gitdesktop` server from a client's GLOBAL (user-scope) config via
/// the client's OWN CLI — the same per-client remove invocations the overwrite
/// path of [`mcp_global_install`] uses. Dispatches on `client` like
/// `mcp_global_install`; an unknown client is an actionable error. Removing an
/// entry that doesn't exist lets the CLI's own behavior/error pass through (the
/// UI only offers Remove when installed; a race just yields the CLI's message).
#[tauri::command]
pub async fn mcp_global_remove(client: String) -> AppResult<()> {
    let (stdout, stderr, code) = match client.as_str() {
        "claude" => claude_global_remove().await?,
        "copilot" => copilot_global_remove().await?,
        other => {
            return Err(AppError::Command(format!(
                "unknown MCP client \"{other}\" (expected \"claude\" or \"copilot\")"
            )));
        }
    };
    if code == 0 {
        return Ok(());
    }
    let out = format!("{stdout}{stderr}");
    Err(AppError::Command(format!(
        "`{client} mcp remove gitdesktop` failed: {}",
        out.trim()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str) -> McpServerSpec {
        McpServerSpec {
            id: "id-1".into(),
            name: name.into(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-everything".into()],
            env: vec![KeyValue {
                key: "TOKEN".into(),
                value: "plain".into(),
            }],
            url: String::new(),
            headers: vec![],
            secret_keys: vec![], // no secret → resolve_entries won't touch the keychain
        }
    }

    fn http(name: &str) -> McpServerSpec {
        McpServerSpec {
            id: "id-2".into(),
            name: name.into(),
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            env: vec![],
            url: "https://mcp.example.com/mcp".into(),
            headers: vec![KeyValue {
                key: "Authorization".into(),
                value: "Bearer x".into(),
            }],
            secret_keys: vec![],
        }
    }

    #[test]
    fn copilot_stdio_uses_local_type_with_command_args_and_tools() {
        let cfg = build_copilot_config(&[stdio("everything")]).unwrap();
        let srv = &cfg["mcpServers"]["everything"];
        assert_eq!(srv["type"], "local");
        assert_eq!(srv["command"], "npx");
        assert_eq!(srv["args"][1], "@modelcontextprotocol/server-everything");
        assert_eq!(srv["env"]["TOKEN"], "plain");
        assert_eq!(srv["tools"][0], "*");
    }

    #[test]
    fn copilot_http_uses_http_type_with_url_and_headers() {
        let cfg = build_copilot_config(&[http("remote")]).unwrap();
        let srv = &cfg["mcpServers"]["remote"];
        assert_eq!(srv["type"], "http");
        assert_eq!(srv["url"], "https://mcp.example.com/mcp");
        assert_eq!(srv["headers"]["Authorization"], "Bearer x");
        assert!(srv.get("command").is_none());
    }

    #[test]
    fn opencode_stdio_merges_command_and_args_into_one_array() {
        let cfg = build_opencode_config(&[stdio("everything")], false).unwrap();
        let srv = &cfg["mcp"]["everything"];
        assert_eq!(srv["type"], "local");
        // command is a single array: binary then args (opencode has no args field).
        assert_eq!(srv["command"][0], "npx");
        assert_eq!(srv["command"][1], "-y");
        assert_eq!(srv["command"][2], "@modelcontextprotocol/server-everything");
        assert_eq!(srv["environment"]["TOKEN"], "plain");
        assert_eq!(srv["enabled"], true);
    }

    #[test]
    fn opencode_http_uses_remote_type_with_url_and_headers() {
        let cfg = build_opencode_config(&[http("remote")], false).unwrap();
        let srv = &cfg["mcp"]["remote"];
        assert_eq!(srv["type"], "remote");
        assert_eq!(srv["url"], "https://mcp.example.com/mcp");
        assert_eq!(srv["headers"]["Authorization"], "Bearer x");
        assert_eq!(srv["enabled"], true);
    }

    // --- self_server_spec ----------------------------------------------------

    #[test]
    fn self_server_spec_points_at_current_exe_with_repo_args() {
        let spec = self_server_spec(r"C:\repos\app").unwrap();
        assert_eq!(spec.id, "gitdesktop");
        assert_eq!(spec.name, "gitdesktop");
        assert_eq!(spec.transport, "stdio");
        // command is the current test binary — non-empty and equal to current_exe().
        let exe = std::env::current_exe().unwrap();
        assert_eq!(spec.command, exe.to_string_lossy());
        assert!(!spec.command.is_empty());
        // args are exactly `mcp --repo <path>` — read-only, no write opt-ins.
        assert_eq!(spec.args, vec!["mcp", "--repo", r"C:\repos\app"]);
        // No secrets/env/url/headers — a plain read-only stdio launch.
        assert!(spec.env.is_empty());
        assert!(spec.url.is_empty());
        assert!(spec.headers.is_empty());
        assert!(spec.secret_keys.is_empty());
        // It validates + emits the expected tool allowlist entry for Claude.
        validate_specs(std::slice::from_ref(&spec)).unwrap();
        assert_eq!(
            tool_allow_patterns(std::slice::from_ref(&spec)),
            vec!["mcp__gitdesktop".to_string()]
        );
    }

    // --- mcp_json_write ------------------------------------------------------

    fn tmp_dir() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-mcp-json-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    fn entry() -> Value {
        json!({ "command": "gitdesktop", "args": ["mcp", "--repo", "."] })
    }

    #[tokio::test]
    async fn write_creates_file_when_missing() {
        let (_tmp, dir) = tmp_dir();
        let res = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), false)
            .await
            .unwrap();
        assert!(res.written);
        assert!(!res.existed);
        let doc: Value =
            serde_json::from_slice(&std::fs::read(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["gitdesktop"]["command"], "gitdesktop");
    }

    #[tokio::test]
    async fn write_preserves_siblings_and_unknown_top_level_keys() {
        let (_tmp, dir) = tmp_dir();
        let path = dir.join(".mcp.json");
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "mcpServers": { "other": { "command": "other-bin" } },
                "someUnknownTopKey": { "keep": true }
            }))
            .unwrap(),
        )
        .unwrap();

        let res = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), false)
            .await
            .unwrap();
        assert!(res.written);
        assert!(!res.existed);

        let doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Sibling server preserved.
        assert_eq!(doc["mcpServers"]["other"]["command"], "other-bin");
        // Our entry added.
        assert_eq!(doc["mcpServers"]["gitdesktop"]["command"], "gitdesktop");
        // Unknown top-level key preserved.
        assert_eq!(doc["someUnknownTopKey"]["keep"], true);
    }

    #[tokio::test]
    async fn write_detects_existing_and_refuses_without_overwrite() {
        let (_tmp, dir) = tmp_dir();
        let path = dir.join(".mcp.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "mcpServers": { "gitdesktop": { "command": "OLD" } }
            }))
            .unwrap(),
        )
        .unwrap();

        // !overwrite → reports existed, writes nothing.
        let res = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), false)
            .await
            .unwrap();
        assert!(!res.written);
        assert!(res.existed);
        let doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["gitdesktop"]["command"], "OLD");

        // overwrite → replaces.
        let res = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), true)
            .await
            .unwrap();
        assert!(res.written);
        assert!(res.existed);
        let doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["gitdesktop"]["command"], "gitdesktop");
    }

    #[tokio::test]
    async fn write_errors_on_malformed_existing_file_without_clobber() {
        let (_tmp, dir) = tmp_dir();
        let path = dir.join(".mcp.json");
        std::fs::write(&path, b"{ not valid json").unwrap();
        let err = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), true)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is untouched.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not valid json");
    }

    #[test]
    fn opencode_research_defines_readonly_web_agent() {
        let cfg = build_opencode_config(&[], true).unwrap();
        let agent = &cfg["agent"][super::GD_RESEARCH_AGENT];
        // Structural removal of the write surface (the hard guarantee).
        assert_eq!(agent["tools"]["write"], false);
        assert_eq!(agent["tools"]["edit"], false);
        assert_eq!(agent["tools"]["patch"], false);
        assert_eq!(agent["tools"]["bash"], false);
        assert_eq!(agent["permission"]["edit"], "deny");
        assert_eq!(agent["permission"]["bash"], "deny");
        assert_eq!(agent["permission"]["webfetch"], "allow");
        assert_eq!(agent["permission"]["websearch"], "allow");
        // No servers, but the agent still makes the config worth writing.
        assert!(cfg["mcp"].as_object().unwrap().is_empty());
        // Plan (research=false) defines no agent.
        let plan = build_opencode_config(&[], false).unwrap();
        assert!(plan.get("agent").is_none());
    }

    // --- classify_global_entry ----------------------------------------------

    const LAUNCHER: &str = r"C:\Users\me\AppData\Local\com.thebguy.gitdesktop\bin\gitdesktop-mcp.exe";

    #[test]
    fn classify_absent_when_no_mcp_servers_or_key() {
        // Empty doc.
        let s = classify_global_entry(&json!({}), LAUNCHER);
        assert!(!s.installed);
        assert_eq!(s.command, None);
        assert!(!s.current);
        // mcpServers present but no gitdesktop.
        let s = classify_global_entry(&json!({ "mcpServers": { "other": {} } }), LAUNCHER);
        assert!(!s.installed);
        // mcpServers wrong shape (array, not map) ⇒ absent.
        let s = classify_global_entry(&json!({ "mcpServers": [] }), LAUNCHER);
        assert!(!s.installed);
    }

    #[test]
    fn classify_current_when_command_matches_launcher() {
        let doc = json!({ "mcpServers": { "gitdesktop": { "command": LAUNCHER } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(s.command.as_deref(), Some(LAUNCHER));
        assert!(s.current, "exact match is current");
        // No args key ⇒ None (not an empty vec).
        assert_eq!(s.args, None, "missing args ⇒ None");
    }

    #[test]
    fn classify_carries_string_args() {
        let doc = json!({ "mcpServers": { "gitdesktop": {
            "command": LAUNCHER,
            "args": ["mcp", "--repo", ".", "--allow-write", "--allow-remote-write"],
        } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(
            s.args.as_deref(),
            Some(
                [
                    "mcp".to_string(),
                    "--repo".to_string(),
                    ".".to_string(),
                    "--allow-write".to_string(),
                    "--allow-remote-write".to_string(),
                ]
                .as_slice()
            ),
        );
    }

    #[test]
    fn classify_args_drops_non_string_junk() {
        // Untrusted JSON: numbers/objects/nulls mixed into args are dropped, never
        // panicked on; the surviving strings are carried in order.
        let doc = json!({ "mcpServers": { "gitdesktop": {
            "command": LAUNCHER,
            "args": ["mcp", 42, "--repo", { "x": 1 }, ".", null, "--allow-write"],
        } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(
            s.args.as_deref(),
            Some(
                [
                    "mcp".to_string(),
                    "--repo".to_string(),
                    ".".to_string(),
                    "--allow-write".to_string(),
                ]
                .as_slice()
            ),
        );
        // A non-array `args` (wrong shape) ⇒ None, not a partial parse.
        let doc = json!({ "mcpServers": { "gitdesktop": {
            "command": LAUNCHER,
            "args": "not-an-array",
        } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(s.args, None, "non-array args ⇒ None");
    }

    #[test]
    fn classify_current_is_separator_and_trailing_robust() {
        // Config command differs from the launcher only by separator style and a
        // trailing separator (same case) — matches on every platform.
        let configured =
            r"C:/Users/me/AppData/Local/com.thebguy.gitdesktop/bin/gitdesktop-mcp.exe/";
        let doc = json!({ "mcpServers": { "gitdesktop": { "command": configured } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert!(s.current, "separator/trailing differences must still match");
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn classify_current_is_case_robust_on_case_insensitive_fs() {
        // On case-insensitive filesystems a case-only (plus separator) difference
        // is still the current launcher. (On Linux those paths are distinct, so
        // this is gated — see `norm_launcher_path`.)
        let configured = r"c:/users/ME/appdata/local/com.thebguy.gitdesktop/bin/gitdesktop-mcp.exe";
        let doc = json!({ "mcpServers": { "gitdesktop": { "command": configured } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert!(s.current, "case differences must match on case-insensitive fs");
    }

    #[test]
    fn classify_mismatch_for_older_install_path() {
        // The classic old-path entry: the installed exe, not the managed copy.
        let old = r"C:\Program Files\gitdesktop\gitdesktop.exe";
        let doc = json!({ "mcpServers": { "gitdesktop": { "command": old } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(s.command.as_deref(), Some(old));
        assert!(!s.current, "an older install path is not current");
    }

    #[test]
    fn classify_non_string_command_installed_but_unclassified() {
        // command present but not a string (e.g. a number) ⇒ installed, no command,
        // not current — never a panic on untrusted JSON.
        let doc = json!({ "mcpServers": { "gitdesktop": { "command": 42 } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(s.command, None);
        assert!(!s.current);
        // command entirely absent ⇒ same (installed, unclassified) — but args are
        // still carried so the tier readout survives a command-less entry.
        let doc = json!({ "mcpServers": { "gitdesktop": {
            "args": ["mcp", "--repo", ".", "--allow-git-write"],
        } } });
        let s = classify_global_entry(&doc, LAUNCHER);
        assert!(s.installed);
        assert_eq!(s.command, None);
        assert!(!s.current);
        assert_eq!(
            s.args.as_deref(),
            Some(
                [
                    "mcp".to_string(),
                    "--repo".to_string(),
                    ".".to_string(),
                    "--allow-git-write".to_string(),
                ]
                .as_slice()
            ),
            "command-less entry still carries args",
        );
    }

    #[test]
    fn norm_launcher_path_folds_separators_and_trailing() {
        // Separator style + trailing separator + surrounding whitespace fold
        // unconditionally, so identically-cased inputs normalize equal on every
        // platform. (Asserted as an equality invariant rather than a literal,
        // since the case of the output is platform-dependent.)
        assert_eq!(
            norm_launcher_path(r"C:\Foo\Bar\"),
            norm_launcher_path("C:/Foo/Bar")
        );
        assert_eq!(
            norm_launcher_path("  C:\\Foo/Bar/  "),
            norm_launcher_path(r"C:\Foo\Bar")
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn norm_launcher_path_folds_case_on_case_insensitive_fs() {
        // Case folding is gated to case-insensitive filesystems.
        assert_eq!(
            norm_launcher_path(r"C:\Foo\Bar\"),
            norm_launcher_path(r"c:/foo/bar")
        );
        assert_eq!(norm_launcher_path("  C:\\Foo/Bar/  "), r"c:\foo\bar");
    }
}
