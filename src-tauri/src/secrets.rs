use crate::error::{AppError, AppResult};

const SERVICE: &str = "com.thebguy.gitdesktop";
const KNOWN_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "openai-compatible",
    "google",
    "openrouter",
    "ollama",
    "ollama-cloud",
];

fn entry_for(provider: &str) -> AppResult<keyring::Entry> {
    if !KNOWN_PROVIDERS.contains(&provider) {
        return Err(AppError::InvalidArgument(format!(
            "unknown provider: {provider}"
        )));
    }
    keyring::Entry::new(SERVICE, &format!("ai-api-key/{provider}"))
        .map_err(|e| AppError::Keyring(e.to_string()))
}

#[tauri::command]
pub async fn set_secret(provider: String, value: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        entry_for(&provider)?
            .set_password(&value)
            .map_err(|e| AppError::Keyring(e.to_string()))
    })
    .await
    .map_err(|e| AppError::Keyring(e.to_string()))?
}

#[tauri::command]
pub async fn get_secret(provider: String) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || match entry_for(&provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    })
    .await
    .map_err(|e| AppError::Keyring(e.to_string()))?
}

#[tauri::command]
pub async fn delete_secret(provider: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        match entry_for(&provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    })
    .await
    .map_err(|e| AppError::Keyring(e.to_string()))?
}

#[tauri::command]
pub async fn secret_exists(provider: String) -> AppResult<bool> {
    Ok(get_secret(provider).await?.is_some())
}

// --- MCP server secrets ---------------------------------------------------
//
// MCP env/header secrets are namespaced per registered server + entry key, so
// they need their own keychain accounts separate from the fixed AI-provider
// allowlist above. The account string is `mcp-server/<id>/<key>`; both parts
// are validated to a safe character set so a malformed id/key can't smuggle an
// unexpected account name into the keychain.

fn safe_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn mcp_entry_for(server_id: &str, key: &str) -> AppResult<keyring::Entry> {
    if !safe_token(server_id) || !safe_token(key) {
        return Err(AppError::InvalidArgument(
            "invalid MCP secret reference".into(),
        ));
    }
    keyring::Entry::new(SERVICE, &format!("mcp-server/{server_id}/{key}"))
        .map_err(|e| AppError::Keyring(e.to_string()))
}

/// Read an MCP secret synchronously (no async bridge), for config generation at
/// session-launch time. `None` when no secret is stored for that ref.
pub fn read_mcp_secret(server_id: &str, key: &str) -> AppResult<Option<String>> {
    match mcp_entry_for(server_id, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

#[tauri::command]
pub async fn set_mcp_secret(server_id: String, key: String, value: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        mcp_entry_for(&server_id, &key)?
            .set_password(&value)
            .map_err(|e| AppError::Keyring(e.to_string()))
    })
    .await
    .map_err(|e| AppError::Keyring(e.to_string()))?
}

#[tauri::command]
pub async fn delete_mcp_secret(server_id: String, key: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        match mcp_entry_for(&server_id, &key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    })
    .await
    .map_err(|e| AppError::Keyring(e.to_string()))?
}

#[tauri::command]
pub async fn mcp_secret_exists(server_id: String, key: String) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || Ok(read_mcp_secret(&server_id, &key)?.is_some()))
        .await
        .map_err(|e| AppError::Keyring(e.to_string()))?
}

// --- Forge (HTTP provider) credentials ------------------------------------
//
// The HTTP forge providers (Bitbucket Cloud today) authenticate with a token
// the user stores here, namespaced per host + credential key — mirroring the
// MCP scheme above. The account string is `forge/<host>/<key>`; both parts are
// validated with the same `safe_token` set (note `bitbucket.org` passes — dots
// are allowed). These are `pub(crate)` sync helpers, NOT Tauri commands: the
// provider impls (e.g. `forge::bitbucket`) call them via `spawn_blocking`
// (keyring is blocking; all forge commands are async), so no generic
// forge-secret command surface is exposed to the frontend and the token is
// never returned across IPC.

fn forge_entry_for(host: &str, key: &str) -> AppResult<keyring::Entry> {
    if !safe_token(host) || !safe_token(key) {
        return Err(AppError::InvalidArgument(
            "invalid forge credential reference".into(),
        ));
    }
    keyring::Entry::new(SERVICE, &format!("forge/{host}/{key}"))
        .map_err(|e| AppError::Keyring(e.to_string()))
}

/// Store a forge credential (`forge/<host>/<key>`). Blocking.
pub(crate) fn set_forge_secret(host: &str, key: &str, value: &str) -> AppResult<()> {
    forge_entry_for(host, key)?
        .set_password(value)
        .map_err(|e| AppError::Keyring(e.to_string()))
}

/// Read a forge credential; `None` when nothing is stored for that ref. Blocking.
pub(crate) fn read_forge_secret(host: &str, key: &str) -> AppResult<Option<String>> {
    match forge_entry_for(host, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

/// Delete a forge credential; a missing entry is tolerated. Blocking.
pub(crate) fn delete_forge_secret(host: &str, key: &str) -> AppResult<()> {
    match forge_entry_for(host, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}
