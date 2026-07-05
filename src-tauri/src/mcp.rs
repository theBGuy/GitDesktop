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

    // --- mcp_json_write ------------------------------------------------------

    fn tmp_dir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "gd-mcp-json-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn entry() -> Value {
        json!({ "command": "gitdesktop", "args": ["mcp", "--repo", "."] })
    }

    #[tokio::test]
    async fn write_creates_file_when_missing() {
        let dir = tmp_dir();
        let res = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), false)
            .await
            .unwrap();
        assert!(res.written);
        assert!(!res.existed);
        let doc: Value =
            serde_json::from_slice(&std::fs::read(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["gitdesktop"]["command"], "gitdesktop");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_preserves_siblings_and_unknown_top_level_keys() {
        let dir = tmp_dir();
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
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_detects_existing_and_refuses_without_overwrite() {
        let dir = tmp_dir();
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
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_errors_on_malformed_existing_file_without_clobber() {
        let dir = tmp_dir();
        let path = dir.join(".mcp.json");
        std::fs::write(&path, b"{ not valid json").unwrap();
        let err = mcp_json_write(dir.to_string_lossy().into_owned(), entry(), true)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is untouched.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not valid json");
        std::fs::remove_dir_all(&dir).ok();
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
}
