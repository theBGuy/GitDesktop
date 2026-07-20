//! Append-only, per-session transcript persistence for agent sessions.
//!
//! Each session is one JSON-Lines file at `<app_data>/sessions/<id>.jsonl`
//! (beside `worktrees/`, so a session's transcript and its throwaway worktree
//! share the same app-data isolation). Line 1 is the immutable `session` header;
//! a turn appends a `turn` line (the prompt) when it starts and a `result` line
//! (status + narration + the checkpoint commit) when it ends. Mutable session
//! fields (model, kept) are appended as `meta`/`status` events and folded
//! last-wins on read.
//!
//! Nothing is ever rewritten — appends are O(1), so a long, resumable
//! conversation never re-serializes its whole history (the failure mode of the
//! previous single growing blob). Diffs are deliberately NOT stored: a result
//! carries its commit hash and the diff is reconstructed from git (`base..commit`).
//! See docs/agent-sessions.md.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// Serializes every transcript append process-wide. Writes are tiny and happen
/// at turn granularity, so contention is negligible; this guarantees line
/// ordering (the header stays line 1) and prevents interleaving when, say, a
/// model change races a turn result on the same file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Back-compat default for sessions persisted before isolation was a field:
/// they ran on the host, confined only by the worktree.
fn default_isolation() -> String {
    "worktree".to_string()
}

/// Back-compat default for sessions persisted before the agent was a field.
fn default_agent() -> String {
    "claude".to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ----------------------------------------------------------------- on-disk schema (v1)

/// One transcript line. Internally tagged on `t`; variants serialize to
/// `"session" | "turn" | "result" | "status" | "meta"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Event {
    Session(Header),
    Turn(TurnEvent),
    Result(ResultEvent),
    Status(StatusEvent),
    Meta(MetaEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    v: u32,
    id: String,
    created_at: i64,
    repo_path: String,
    worktree_path: String,
    branch: String,
    base: String,
    claude_session_id: String,
    model: String,
    /// How the session runs: "worktree" (host, worktree-only) or "container".
    /// Fixed at creation — every turn must run the same way (`--resume` keeps its
    /// transcript in a mode-specific place).
    #[serde(default = "default_isolation")]
    isolation: String,
    /// Which CLI drives the session: "claude" or "codex". Fixed at creation.
    #[serde(default = "default_agent")]
    agent: String,
    /// Reasoning/effort level ("" = provider default; else low/medium/high/xhigh).
    /// Mapped per-CLI at invocation. Changeable mid-session (folded last-wins like
    /// `model`); the header carries the creation value. New field → defaults "".
    #[serde(default)]
    effort: String,
    /// Ids of the MCP servers this session opted into (from the settings
    /// registry). Fixed at creation. New field → defaults to empty (no MCP).
    #[serde(default)]
    mcp_servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnEvent {
    seq: u32,
    ts: i64,
    prompt: String,
    model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultEvent {
    seq: u32,
    ts: i64,
    /// Terminal turn status as persisted: "done" or "error".
    status: String,
    narration: String,
    /// The turn's interleaved transcript (prose + tool steps) as opaque JSON — the
    /// frontend `TranscriptSegment[]`, stored verbatim so the activity log survives
    /// a restart. Absent on turns persisted before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    segments: Option<serde_json::Value>,
    commit_hash: Option<String>,
    cost_usd: Option<f64>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    ts: i64,
    /// "kept" or "active".
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaEvent {
    ts: i64,
    /// A mid-session model change. Absent on a resume-id-only meta event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// The CLI's native resume id, captured from turn 1 (Codex thread / opencode
    /// sessionID) — lets a host session resume the right conversation (the CLI
    /// shares its home across sessions). Absent for Claude / container / a model-only
    /// meta event. The `codexThreadId` alias reads sessions persisted before the rename.
    #[serde(
        default,
        alias = "codexThreadId",
        skip_serializing_if = "Option::is_none"
    )]
    native_session_id: Option<String>,
    /// A mid-session effort change. Absent on a model/resume-id-only meta event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    /// A mid-session MCP-server selection change (the full opted-in id list).
    /// Absent on other meta events; folded last-wins like the rest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp_servers: Option<Vec<String>>,
}

// ----------------------------------------------------------------- folded (read) view

/// Mirrors the frontend `SessionTurn` exactly (camelCase), so a loaded session
/// drops straight into the store. `statusText` is always "" on load.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTurn {
    prompt: String,
    narration: String,
    /// The interleaved transcript (`TranscriptSegment[]`), restored so the activity
    /// log shows on reload instead of the flat prose. None on legacy turns.
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<serde_json::Value>,
    status: String,
    status_text: String,
    commit_hash: Option<String>,
    cost_usd: Option<f64>,
    error: Option<String>,
}

/// Mirrors the frontend `AgentSession`. `running` is always false (the CLI
/// process is gone after a load); interrupted turns are already marked.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSession {
    id: String,
    repo_path: String,
    worktree_path: String,
    branch: String,
    base: String,
    head_hash: String,
    claude_session_id: String,
    model: String,
    isolation: String,
    agent: String,
    effort: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_session_id: Option<String>,
    /// MCP server ids the session opted into (empty = none). From the header.
    mcp_servers: Vec<String>,
    running: bool,
    kept: bool,
    turns: Vec<LoadedTurn>,
}

/// New-session header fields supplied by the frontend on create.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    id: String,
    repo_path: String,
    worktree_path: String,
    branch: String,
    base: String,
    claude_session_id: String,
    model: String,
    isolation: String,
    agent: String,
    #[serde(default)]
    effort: String,
    #[serde(default)]
    mcp_servers: Vec<String>,
}

// ----------------------------------------------------------------- paths + io

fn sessions_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
        .join("sessions");
    Ok(dir)
}

/// Session ids are app-generated (`worktree.rs::new_session_id` → hex), but they
/// arrive from the frontend, so guard against path traversal before using one in
/// a filename.
pub(crate) fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid session id: {id:?}"
        )));
    }
    Ok(())
}

fn append_to_dir(dir: &Path, id: &str, event: &Event) -> AppResult<()> {
    validate_id(id)?;
    let line = serde_json::to_string(event)
        .map_err(|e| AppError::Command(format!("serialize transcript event: {e}")))?;
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| AppError::Command("transcript write lock poisoned".into()))?;
    std::fs::create_dir_all(dir)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{id}.jsonl")))?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

/// Reads only a session file's header (line 1), without folding the whole
/// transcript — the worktree manager's exclusion gate only needs each session's
/// owned worktree path, and a kept session's log can be long.
fn read_header(path: &Path) -> Option<Header> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(file).read_line(&mut line).ok()?;
    match serde_json::from_str::<Event>(line.trim()).ok()? {
        Event::Session(h) => Some(h),
        _ => None,
    }
}

/// The set of absolute worktree paths owned by persisted agent sessions (active
/// or kept), normalized (lower-cased, forward-slashed) for path comparison.
///
/// This is the **authoritative** exclusion set for the user-facing worktree
/// manager: a worktree a live/kept session depends on must never be listed to,
/// switched into, or deleted by the user (the user dogfoods `gd/session/*` in a
/// real repo). The manager pairs this with a secondary `gd/session/*`-branch +
/// app-data-path filter as defense-in-depth, so a real session worktree stays
/// hidden even if the registry entry is missing.
pub(crate) fn session_worktree_paths(app: &AppHandle) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Ok(dir) = sessions_dir(app) else {
        return set;
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return set;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(h) = read_header(&path) {
            if !h.worktree_path.is_empty() {
                set.insert(crate::git::worktree::normalize_wt_path(&h.worktree_path));
            }
        }
    }
    set
}

/// Reads a transcript file into events, skipping any unparseable line (e.g. a
/// final line torn by a crash mid-append — at most the last event is lost).
fn read_events(path: &Path) -> Vec<Event> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Event>(l).ok())
        .collect()
}

/// Folds an event log into a session view. A turn with no matching `result` is
/// rendered as interrupted (nothing is running after a load). Returns None if
/// the first line isn't a header.
fn fold(events: &[Event]) -> Option<LoadedSession> {
    let header = match events.first() {
        Some(Event::Session(h)) => h.clone(),
        _ => return None,
    };
    let mut turns: Vec<LoadedTurn> = Vec::new();
    let mut model = header.model.clone();
    let mut effort = header.effort.clone();
    let mut kept = false;
    let mut head_hash = header.base.clone();
    let mut native_session_id: Option<String> = None;
    let mut mcp_servers = header.mcp_servers.clone();

    for e in events {
        match e {
            Event::Session(_) => {}
            Event::Turn(t) => {
                model = t.model.clone();
                turns.push(LoadedTurn {
                    prompt: t.prompt.clone(),
                    narration: String::new(),
                    segments: None,
                    status: "error".into(),
                    status_text: String::new(),
                    commit_hash: None,
                    cost_usd: None,
                    error: Some("Interrupted by restart.".into()),
                });
            }
            Event::Result(r) => {
                if let Some(turn) = turns.last_mut() {
                    turn.status = r.status.clone();
                    turn.narration = r.narration.clone();
                    turn.segments = r.segments.clone();
                    turn.commit_hash = r.commit_hash.clone();
                    turn.cost_usd = r.cost_usd;
                    turn.error = r.error.clone();
                    if let Some(h) = &r.commit_hash {
                        head_hash = h.clone();
                    }
                }
            }
            Event::Status(s) => match s.status.as_str() {
                "kept" => kept = true,
                "active" => kept = false,
                _ => {}
            },
            Event::Meta(m) => {
                if let Some(mm) = &m.model {
                    model = mm.clone();
                }
                if let Some(ef) = &m.effort {
                    effort = ef.clone();
                }
                if let Some(sid) = &m.native_session_id {
                    native_session_id = Some(sid.clone());
                }
                if let Some(servers) = &m.mcp_servers {
                    mcp_servers = servers.clone();
                }
            }
        }
    }

    Some(LoadedSession {
        id: header.id,
        repo_path: header.repo_path,
        worktree_path: header.worktree_path,
        branch: header.branch,
        base: header.base,
        head_hash,
        claude_session_id: header.claude_session_id,
        model,
        isolation: header.isolation,
        agent: header.agent,
        effort,
        native_session_id,
        mcp_servers,
        running: false,
        kept,
        turns,
    })
}

/// Loads + folds every `*.jsonl` in `dir`, in session creation order.
fn load_dir(dir: &Path) -> Vec<LoadedSession> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions: Vec<(i64, LoadedSession)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let events = read_events(&path);
        let created = match events.first() {
            Some(Event::Session(h)) => h.created_at,
            _ => continue,
        };
        if let Some(s) = fold(&events) {
            sessions.push((created, s));
        }
    }
    sessions.sort_by_key(|(created, _)| *created);
    sessions.into_iter().map(|(_, s)| s).collect()
}

// ----------------------------------------------------------------- legacy migration

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// One-shot migration of the previous single-file store
/// (`agent-sessions.json`, a tauri-plugin-store blob of `{ "sessions": [...] }`)
/// into per-session `.jsonl` files. Runs only when the `sessions/` dir does not
/// yet exist; renames the legacy blob aside afterwards so it never repeats.
fn migrate_legacy_if_needed(app: &AppHandle) -> AppResult<()> {
    let dir = sessions_dir(app)?;
    if dir.exists() {
        return Ok(());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let legacy = app_data.join("agent-sessions.json");
    if !legacy.exists() {
        return Ok(());
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&legacy)?).unwrap_or(serde_json::Value::Null);
    let arr = parsed
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for s in &arr {
        let id = str_field(s, "id");
        if validate_id(&id).is_err() {
            continue;
        }
        append_to_dir(
            &dir,
            &id,
            &Event::Session(Header {
                v: 1,
                id: id.clone(),
                created_at: now_ms(),
                repo_path: str_field(s, "repoPath"),
                worktree_path: str_field(s, "worktreePath"),
                branch: str_field(s, "branch"),
                base: str_field(s, "base"),
                claude_session_id: str_field(s, "claudeSessionId"),
                model: str_field(s, "model"),
                isolation: "worktree".into(),
                agent: "claude".into(),
                effort: String::new(),
                mcp_servers: Vec::new(),
            }),
        )?;
        let turns = s
            .get("turns")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for (i, t) in turns.iter().enumerate() {
            let seq = i as u32;
            append_to_dir(
                &dir,
                &id,
                &Event::Turn(TurnEvent {
                    seq,
                    ts: now_ms(),
                    prompt: str_field(t, "prompt"),
                    model: str_field(s, "model"),
                }),
            )?;
            // Transient statuses (running/committing) become "error" — a session
            // that was mid-flight when last persisted was interrupted.
            let status = if str_field(t, "status") == "done" {
                "done"
            } else {
                "error"
            };
            append_to_dir(
                &dir,
                &id,
                &Event::Result(ResultEvent {
                    seq,
                    ts: now_ms(),
                    status: status.into(),
                    narration: str_field(t, "narration"),
                    // Legacy plan/session JSON never carried segments.
                    segments: None,
                    commit_hash: t
                        .get("commitHash")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    cost_usd: t.get("costUsd").and_then(|v| v.as_f64()),
                    error: t.get("error").and_then(|v| v.as_str()).map(String::from),
                }),
            )?;
        }
        if s.get("kept").and_then(|v| v.as_bool()).unwrap_or(false) {
            append_to_dir(
                &dir,
                &id,
                &Event::Status(StatusEvent {
                    ts: now_ms(),
                    status: "kept".into(),
                }),
            )?;
        }
    }

    let _ = std::fs::rename(&legacy, legacy.with_extension("json.bak"));
    Ok(())
}

// ----------------------------------------------------------------- commands

/// Loads all persisted sessions (folded, in creation order), migrating the
/// legacy single-file store on first run.
#[tauri::command]
pub async fn transcript_load_all(app: AppHandle) -> AppResult<Vec<LoadedSession>> {
    migrate_legacy_if_needed(&app)?;
    Ok(load_dir(&sessions_dir(&app)?))
}

/// Writes a new session's header line (call once, when the session is created).
#[tauri::command]
pub async fn transcript_create(app: AppHandle, session: NewSession) -> AppResult<()> {
    append_to_dir(
        &sessions_dir(&app)?,
        &session.id,
        &Event::Session(Header {
            v: 1,
            id: session.id.clone(),
            created_at: now_ms(),
            repo_path: session.repo_path,
            worktree_path: session.worktree_path,
            branch: session.branch,
            base: session.base,
            claude_session_id: session.claude_session_id,
            model: session.model,
            isolation: session.isolation,
            agent: session.agent,
            effort: session.effort,
            mcp_servers: session.mcp_servers,
        }),
    )
}

/// Records the start of a turn (its prompt + the model it runs with).
#[tauri::command]
pub async fn transcript_append_turn(
    app: AppHandle,
    id: String,
    seq: u32,
    prompt: String,
    model: String,
) -> AppResult<()> {
    append_to_dir(
        &sessions_dir(&app)?,
        &id,
        &Event::Turn(TurnEvent {
            seq,
            ts: now_ms(),
            prompt,
            model,
        }),
    )
}

/// Records a turn's terminal result (status + coalesced narration + checkpoint).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcript_append_result(
    app: AppHandle,
    id: String,
    seq: u32,
    status: String,
    narration: String,
    segments: Option<serde_json::Value>,
    commit_hash: Option<String>,
    cost_usd: Option<f64>,
    error: Option<String>,
) -> AppResult<()> {
    append_to_dir(
        &sessions_dir(&app)?,
        &id,
        &Event::Result(ResultEvent {
            seq,
            ts: now_ms(),
            status,
            narration,
            segments,
            commit_hash,
            cost_usd,
            error,
        }),
    )
}

/// Records a mid-session `meta` change (folded last-wins): a model switch and/or
/// the CLI's captured native resume id (Codex thread / opencode session). Pass only
/// the field that changed.
#[tauri::command]
pub async fn transcript_append_meta(
    app: AppHandle,
    id: String,
    model: Option<String>,
    native_session_id: Option<String>,
    effort: Option<String>,
    mcp_servers: Option<Vec<String>>,
) -> AppResult<()> {
    append_to_dir(
        &sessions_dir(&app)?,
        &id,
        &Event::Meta(MetaEvent {
            ts: now_ms(),
            model,
            native_session_id,
            effort,
            mcp_servers,
        }),
    )
}

/// Records a Keep (`kept=true`) or Resume (`kept=false`).
#[tauri::command]
pub async fn transcript_set_kept(app: AppHandle, id: String, kept: bool) -> AppResult<()> {
    append_to_dir(
        &sessions_dir(&app)?,
        &id,
        &Event::Status(StatusEvent {
            ts: now_ms(),
            status: if kept { "kept" } else { "active" }.into(),
        }),
    )
}

/// Deletes a session's transcript (on discard / record removal). No-op if absent.
#[tauri::command]
pub async fn transcript_remove(app: AppHandle, id: String) -> AppResult<()> {
    validate_id(&id)?;
    let path = sessions_dir(&app)?.join(format!("{id}.jsonl"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-transcript-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    fn header(id: &str, created: i64) -> Event {
        Event::Session(Header {
            v: 1,
            id: id.into(),
            created_at: created,
            repo_path: "C:/repo".into(),
            worktree_path: format!("C:/wt/{id}"),
            branch: format!("gd/session/{id}"),
            base: "base000".into(),
            claude_session_id: "uuid".into(),
            model: "opus".into(),
            isolation: "worktree".into(),
            agent: "claude".into(),
            effort: String::new(),
            mcp_servers: Vec::new(),
        })
    }

    #[test]
    fn validate_id_rejects_traversal() {
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("abc123-_").is_ok());
    }

    #[test]
    fn fold_pairs_results_and_tracks_head_and_kept() {
        let events = vec![
            header("s1", 10),
            Event::Turn(TurnEvent {
                seq: 0,
                ts: 1,
                prompt: "do x".into(),
                model: "opus".into(),
            }),
            Event::Result(ResultEvent {
                seq: 0,
                ts: 2,
                status: "done".into(),
                narration: "did x".into(),
                segments: None,
                commit_hash: Some("c1".into()),
                cost_usd: Some(0.5),
                error: None,
            }),
            Event::Meta(MetaEvent {
                ts: 3,
                model: Some("sonnet".into()),
                native_session_id: None,
                effort: Some("high".into()),
                mcp_servers: None,
            }),
            Event::Meta(MetaEvent {
                ts: 4,
                model: None,
                native_session_id: Some("thread-xyz".into()),
                effort: None,
                mcp_servers: None,
            }),
            Event::Status(StatusEvent {
                ts: 5,
                status: "kept".into(),
            }),
        ];
        let s = fold(&events).unwrap();
        assert_eq!(s.turns.len(), 1);
        assert_eq!(s.turns[0].status, "done");
        assert_eq!(s.turns[0].narration, "did x");
        assert_eq!(s.turns[0].commit_hash.as_deref(), Some("c1"));
        assert_eq!(s.head_hash, "c1");
        assert_eq!(s.model, "sonnet"); // meta last-wins
        assert_eq!(s.effort, "high"); // effort meta folds like model
        // a model-only meta then a resume-id-only meta each apply their own field
        assert_eq!(s.native_session_id.as_deref(), Some("thread-xyz"));
        assert!(s.kept);
        assert!(!s.running);
    }

    #[test]
    fn fold_marks_resultless_turn_interrupted_even_when_not_last() {
        // turn0 interrupted (no result), then a fresh turn1 completes.
        let events = vec![
            header("s2", 1),
            Event::Turn(TurnEvent {
                seq: 0,
                ts: 1,
                prompt: "first".into(),
                model: "opus".into(),
            }),
            Event::Turn(TurnEvent {
                seq: 1,
                ts: 2,
                prompt: "second".into(),
                model: "opus".into(),
            }),
            Event::Result(ResultEvent {
                seq: 1,
                ts: 3,
                status: "done".into(),
                narration: "ok".into(),
                segments: None,
                commit_hash: Some("c2".into()),
                cost_usd: None,
                error: None,
            }),
        ];
        let s = fold(&events).unwrap();
        assert_eq!(s.turns[0].status, "error");
        assert_eq!(s.turns[0].error.as_deref(), Some("Interrupted by restart."));
        assert_eq!(s.turns[1].status, "done");
        assert_eq!(s.head_hash, "c2");
    }

    #[test]
    fn meta_reads_legacy_codex_thread_id_key() {
        // Sessions persisted before the rename wrote `codexThreadId`; the serde
        // alias must still fold it into `native_session_id` so a host Codex session
        // created earlier still resumes the right thread.
        let line = r#"{"t":"meta","ts":7,"codexThreadId":"thread-legacy"}"#;
        let ev: Event = serde_json::from_str(line).unwrap();
        match ev {
            Event::Meta(m) => assert_eq!(m.native_session_id.as_deref(), Some("thread-legacy")),
            other => panic!("expected Meta, got {other:?}"),
        }
    }

    #[test]
    fn fold_requires_header_first() {
        let events = vec![Event::Turn(TurnEvent {
            seq: 0,
            ts: 1,
            prompt: "x".into(),
            model: "m".into(),
        })];
        assert!(fold(&events).is_none());
    }

    #[test]
    fn append_then_load_roundtrip_and_orders_by_creation() {
        let (_dir, dir) = temp_dir("roundtrip");
        // Two sessions written out of creation order on disk.
        append_to_dir(&dir, "bbb", &header("bbb", 200)).unwrap();
        append_to_dir(&dir, "aaa", &header("aaa", 100)).unwrap();
        append_to_dir(
            &dir,
            "aaa",
            &Event::Turn(TurnEvent {
                seq: 0,
                ts: 1,
                prompt: "hi".into(),
                model: "opus".into(),
            }),
        )
        .unwrap();
        append_to_dir(
            &dir,
            "aaa",
            &Event::Result(ResultEvent {
                seq: 0,
                ts: 2,
                status: "done".into(),
                narration: "hello".into(),
                segments: None,
                commit_hash: Some("c9".into()),
                cost_usd: None,
                error: None,
            }),
        )
        .unwrap();

        let loaded = load_dir(&dir);

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "aaa"); // created 100 sorts before 200
        assert_eq!(loaded[1].id, "bbb");
        assert_eq!(loaded[0].turns[0].narration, "hello");
        assert_eq!(loaded[0].head_hash, "c9");
    }

    #[test]
    fn read_events_skips_a_torn_final_line() {
        let (_dir, dir) = temp_dir("torn");
        append_to_dir(&dir, "t1", &header("t1", 1)).unwrap();
        // Simulate a crash mid-append: a partial trailing line.
        let path = dir.join("t1.jsonl");
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(b"{\"t\":\"turn\",\"seq\":0,\"ts\":1,\"prom")
            .unwrap();
        let events = read_events(&path);
        assert_eq!(events.len(), 1); // header survived, torn line dropped
        assert!(fold(&events).is_some());
    }
}
