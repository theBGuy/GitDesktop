use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::error::{AppError, AppResult};

/// Per-repo AI instructions, read from `<repo>/.gitdesktop/instructions.md`.
#[tauri::command]
pub async fn read_repo_instructions(repo_path: String) -> AppResult<Option<String>> {
    let path = Path::new(&repo_path)
        .join(".gitdesktop")
        .join("instructions.md");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => {
            let trimmed = text.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Per-repo AI ignore patterns from `<repo>/.gitdesktop/aiignore`
/// (gitignore-style globs, one per line, # comments).
#[tauri::command]
pub async fn read_repo_ai_ignore(repo_path: String) -> AppResult<Vec<String>> {
    let path = Path::new(&repo_path).join(".gitdesktop").join("aiignore");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => Ok(parse_patterns(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Appends AI-ignore patterns to `<repo>/.gitdesktop/aiignore`, creating the
/// `.gitdesktop` directory and the file (with a header comment) if absent.
/// Mirrors `append_to_gitignore` (trim + in-batch de-dupe + skip lines already
/// present), with one delta: a fresh file is seeded with a header comment
/// (`parse_patterns` and `git::ai_ignore` both skip `#` lines). Lines are stored
/// verbatim, gitignore-style — in particular a leading `/` is preserved and
/// anchors the pattern to the repo root, which is how the UI's "exclude THIS
/// file" actions mean one file rather than every file with that name. Returns
/// the number of patterns actually appended (0 when every pattern was empty or
/// already present).
#[tauri::command]
pub async fn append_repo_ai_ignore(repo_path: String, patterns: Vec<String>) -> AppResult<usize> {
    const HEADER: &str =
        "# Files excluded from AI context — gitignore-style patterns, one per line.";

    // Normalize (trim only — a leading '/' is meaningful anchoring) and de-dupe
    // within the batch (preserving order).
    let mut wanted: Vec<String> = Vec::new();
    for p in patterns {
        let t = p.trim().to_string();
        if !t.is_empty() && !wanted.contains(&t) {
            wanted.push(t);
        }
    }
    if wanted.is_empty() {
        return Ok(0);
    }

    let dir = Path::new(&repo_path).join(".gitdesktop");
    let path = dir.join("aiignore");
    let (mut content, is_new) = match tokio::fs::read_to_string(&path).await {
        Ok(text) => (text, false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), true),
        Err(e) => return Err(AppError::Io(e)),
    };

    // Drop anything already in the file (scoped so the borrow ends before we
    // mutate `content`).
    let to_add: Vec<String> = {
        let existing: HashSet<&str> = content.lines().map(str::trim).collect();
        wanted
            .into_iter()
            .filter(|p| !existing.contains(p.as_str()))
            .collect()
    };
    if to_add.is_empty() {
        return Ok(0);
    }
    let added = to_add.len();

    tokio::fs::create_dir_all(&dir).await.map_err(AppError::Io)?;

    if is_new {
        content.push_str(HEADER);
        content.push('\n');
    } else if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    for p in to_add {
        content.push_str(&p);
        content.push('\n');
    }
    tokio::fs::write(&path, content).await.map_err(AppError::Io)?;
    Ok(added)
}

/// Per-repo SHARED branch rules, read from `<repo>/.gitdesktop/branch-rules.json`.
/// Returns the raw file contents (parsed and normalized on the frontend, which
/// owns the schema), or None when the file is absent or empty.
#[tauri::command]
pub async fn read_repo_branch_rules(repo_path: String) -> AppResult<Option<String>> {
    let path = Path::new(&repo_path)
        .join(".gitdesktop")
        .join("branch-rules.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Writes the repo's shared branch rules to `<repo>/.gitdesktop/branch-rules.json`,
/// creating the `.gitdesktop` directory if needed. The caller passes the
/// already-serialized (pretty-printed) JSON so the committed file is
/// diff-friendly.
#[tauri::command]
pub async fn write_repo_branch_rules(repo_path: String, contents: String) -> AppResult<()> {
    let dir = Path::new(&repo_path).join(".gitdesktop");
    tokio::fs::create_dir_all(&dir).await.map_err(AppError::Io)?;
    let path = dir.join("branch-rules.json");
    tokio::fs::write(&path, contents).await.map_err(AppError::Io)
}

/// Per-repo SHARED syntax config, read from `<repo>/.gitdesktop/syntax.json`.
/// Returns the raw file contents (parsed on the frontend, which owns the
/// schema), or None when the file is absent or empty.
#[tauri::command]
pub async fn read_repo_syntax(repo_path: String) -> AppResult<Option<String>> {
    let path = Path::new(&repo_path).join(".gitdesktop").join("syntax.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Writes the repo's shared syntax config to `<repo>/.gitdesktop/syntax.json`,
/// creating `.gitdesktop` if needed. The caller passes already-serialized
/// (pretty-printed) JSON so the committed file stays diff-friendly.
#[tauri::command]
pub async fn write_repo_syntax(repo_path: String, contents: String) -> AppResult<()> {
    let dir = Path::new(&repo_path).join(".gitdesktop");
    tokio::fs::create_dir_all(&dir).await.map_err(AppError::Io)?;
    let path = dir.join("syntax.json");
    tokio::fs::write(&path, contents).await.map_err(AppError::Io)
}

pub fn parse_patterns(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(String::from)
        .collect()
}

/// One discovered agent slash-command or skill, surfaced in the composer's `/`
/// menu for the selected agent.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// Name typed after `/` (a command's file stem, or a skill's frontmatter
    /// `name`/dir name).
    pub name: String,
    /// Short description from frontmatter (may be empty).
    pub description: String,
    /// Prompt body for commands (`$ARGUMENTS`/`$1..` expanded on the frontend);
    /// empty for skills, which are invoked by name so the CLI loads the real
    /// skill (scripts/references and all) rather than us inlining it.
    pub prompt: String,
    /// Frontmatter `argument-hint` shown after the name (may be empty).
    pub argument_hint: String,
    /// "command" or "skill".
    pub kind: String,
    /// "project" (repo) or "global" (home).
    pub scope: String,
}

/// Discovers the slash-commands and skills available to `agent`, from both the
/// repo (project) and the user's home (global), following each CLI's own
/// conventions plus the vendor-neutral `.agents/skills` canonical store (into
/// which the per-agent skill dirs are typically symlinked). Skills come back
/// with an empty `prompt` (invoked by name, not inlined). Deduped by (kind,
/// lowercased name): the first dir in priority order wins, so project beats
/// global and the canonical `.agents` dir beats a vendor mirror (junction).
#[tauri::command]
pub fn read_agent_commands(
    app: tauri::AppHandle,
    repo_path: String,
    agent: String,
) -> AppResult<Vec<AgentCommand>> {
    let repo = Path::new(&repo_path);
    let home = app.path().home_dir().ok();
    let home = home.as_deref();

    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut out: Vec<AgentCommand> = Vec::new();

    // Commands: a prompt template per `*.md`. We expand the body on the frontend,
    // so execution is provider-agnostic — the dirs are just where each CLI looks.
    for (dir, scope) in command_dirs(&agent, repo, home) {
        for path in md_files(&dir) {
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let key = ("command".to_string(), stem.to_lowercase());
            // Already emitted by a higher-priority dir — don't re-read.
            if seen.contains(&key) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let (front, body) = split_frontmatter(&text);
            if body.trim().is_empty() {
                continue;
            }
            // Mark seen only once VALID, so an empty/unreadable file in a higher
            // dir doesn't suppress a real same-named command in a lower one.
            seen.insert(key);
            let meta = parse_meta(front);
            out.push(AgentCommand {
                name: stem.to_string(),
                description: meta.description,
                prompt: body.to_string(),
                argument_hint: meta.argument_hint,
                kind: "command".to_string(),
                scope: scope.clone(),
            });
        }
    }

    // Skills: each is a `<name>/SKILL.md` directory. Surfaced for display + a
    // by-name nudge; the body isn't sent (the CLI already loaded the real skill).
    for (dir, scope) in skill_dirs(&agent, repo, home) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut skill_dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        skill_dirs.sort();
        for skill_dir in skill_dirs {
            let Ok(text) = std::fs::read_to_string(skill_dir.join("SKILL.md")) else {
                continue;
            };
            let (front, _) = split_frontmatter(&text);
            let meta = parse_meta(front);
            let name = if meta.name.is_empty() {
                skill_dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string()
            } else {
                meta.name
            };
            if name.is_empty() {
                continue;
            }
            if !seen.insert(("skill".to_string(), name.to_lowercase())) {
                continue;
            }
            out.push(AgentCommand {
                name,
                description: meta.description,
                prompt: String::new(),
                argument_hint: meta.argument_hint,
                kind: "skill".to_string(),
                scope: scope.clone(),
            });
        }
    }

    Ok(out)
}

/// Per-agent custom-command directories, project before global (project wins
/// dedup). The dirs are just where each CLI's own commands live; we expand them
/// the same way regardless.
fn command_dirs(agent: &str, repo: &Path, home: Option<&Path>) -> Vec<(PathBuf, String)> {
    let mut dirs: Vec<(PathBuf, String)> = Vec::new();
    match agent {
        "opencode" => dirs.push((repo.join(".opencode").join("commands"), "project".to_string())),
        // Codex has no project-level prompts — only the global dir below.
        "codex" => {}
        // Claude, Copilot (which reuses Claude's `.claude/commands`), and default.
        _ => dirs.push((repo.join(".claude").join("commands"), "project".to_string())),
    }
    if let Some(h) = home {
        match agent {
            "codex" => dirs.push((h.join(".codex").join("prompts"), "global".to_string())),
            "opencode" => dirs.push((
                h.join(".config").join("opencode").join("commands"),
                "global".to_string(),
            )),
            _ => dirs.push((h.join(".claude").join("commands"), "global".to_string())),
        }
    }
    dirs
}

/// Per-agent skill directories. The vendor-neutral `.agents/skills` canonical
/// store is listed first so it wins dedup over a vendor mirror; the agent's own
/// vendor dir(s) follow, to catch skills defined only there.
fn skill_dirs(agent: &str, repo: &Path, home: Option<&Path>) -> Vec<(PathBuf, String)> {
    let mut dirs: Vec<(PathBuf, String)> = Vec::new();
    dirs.push((repo.join(".agents").join("skills"), "project".to_string()));
    match agent {
        "opencode" => dirs.push((repo.join(".opencode").join("skills"), "project".to_string())),
        "copilot" => dirs.push((repo.join(".github").join("skills"), "project".to_string())),
        _ => {}
    }
    // `.claude/skills` is also read by opencode/copilot and is the Claude store.
    if agent != "codex" {
        dirs.push((repo.join(".claude").join("skills"), "project".to_string()));
    }
    if let Some(h) = home {
        dirs.push((h.join(".agents").join("skills"), "global".to_string()));
        match agent {
            "codex" => dirs.push((h.join(".codex").join("skills"), "global".to_string())),
            "opencode" => dirs.push((
                h.join(".config").join("opencode").join("skills"),
                "global".to_string(),
            )),
            "copilot" => dirs.push((h.join(".copilot").join("skills"), "global".to_string())),
            _ => {}
        }
        if agent != "codex" {
            dirs.push((h.join(".claude").join("skills"), "global".to_string()));
        }
    }
    dirs
}

/// Sorted `*.md` files directly in `dir` (empty if the dir is absent/unreadable).
fn md_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .collect();
    paths.sort();
    paths
}

struct Meta {
    name: String,
    description: String,
    argument_hint: String,
}

/// Pulls `name`/`description`/`argument-hint` from a frontmatter block, scanning
/// lines flatly so an `argument-hint` nested under `metadata:` is still found.
/// Unknown keys are ignored.
fn parse_meta(front: &str) -> Meta {
    let mut meta = Meta {
        name: String::new(),
        description: String::new(),
        argument_hint: String::new(),
    };
    for line in front.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("name:") {
            meta.name = unquote(v);
        } else if let Some(v) = line.strip_prefix("description:") {
            meta.description = unquote(v);
        } else if let Some(v) = line.strip_prefix("argument-hint:") {
            meta.argument_hint = unquote(v);
        }
    }
    meta
}

/// Splits a leading `--- … ---` frontmatter block from the body. Returns
/// (frontmatter_inner, body); ("", whole-trimmed-text) when there's no
/// frontmatter. Skips the entire closing-fence LINE (whatever its dash count),
/// so a body that itself starts with `-` (a markdown list) is preserved.
fn split_frontmatter(text: &str) -> (&str, &str) {
    let trimmed = text.trim_start_matches(['\u{feff}', '\n', '\r', ' ']);
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            // `end` indexes the "\n" before the closing fence.
            let after_fence = &rest[end + 1..];
            let body = match after_fence.find('\n') {
                Some(nl) => after_fence[nl + 1..].trim(),
                None => "",
            };
            return (front, body);
        }
    }
    ("", text.trim())
}

/// Trims a frontmatter value and strips one layer of matching quotes.
fn unquote(value: &str) -> String {
    let v = value.trim();
    let bytes = v.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let md = "---\ndescription: Review the diff\nargument-hint: [focus]\n---\nReview $ARGUMENTS now.\n";
        let (front, body) = split_frontmatter(md);
        let meta = parse_meta(front);
        assert_eq!(meta.description, "Review the diff");
        assert_eq!(meta.argument_hint, "[focus]");
        assert_eq!(body, "Review $ARGUMENTS now.");
    }

    #[test]
    fn strips_quotes_from_values() {
        let md = "---\ndescription: \"Quoted desc\"\nargument-hint: '[x]'\n---\nBody\n";
        let (front, body) = split_frontmatter(md);
        let meta = parse_meta(front);
        assert_eq!(meta.description, "Quoted desc");
        assert_eq!(meta.argument_hint, "[x]");
        assert_eq!(body, "Body");
    }

    #[test]
    fn body_only_without_frontmatter() {
        let (front, body) = split_frontmatter("Just a prompt body.\n");
        let meta = parse_meta(front);
        assert_eq!(meta.description, "");
        assert_eq!(meta.argument_hint, "");
        assert_eq!(body, "Just a prompt body.");
    }

    #[test]
    fn ignores_unknown_frontmatter_keys() {
        let (front, body) = split_frontmatter("---\nmodel: opus\ndescription: D\n---\nBody");
        let meta = parse_meta(front);
        assert_eq!(meta.description, "D");
        assert_eq!(body, "Body");
    }

    #[test]
    fn preserves_body_starting_with_dash() {
        let (front, body) = split_frontmatter("---\ndescription: D\n---\n- first\n- second\n");
        let meta = parse_meta(front);
        assert_eq!(meta.description, "D");
        assert_eq!(body, "- first\n- second");
    }

    #[test]
    fn parses_skill_name_and_nested_argument_hint() {
        // `argument-hint` nested under `metadata:` is still found by the flat scan.
        let md = "---\nname: writing-guidelines\ndescription: Review docs\nmetadata:\n  author: vercel\n  argument-hint: <file>\n---\n# Writing\n";
        let (front, _) = split_frontmatter(md);
        let meta = parse_meta(front);
        assert_eq!(meta.name, "writing-guidelines");
        assert_eq!(meta.description, "Review docs");
        assert_eq!(meta.argument_hint, "<file>");
    }

    fn ai_ignore_test_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-aiignore-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[tokio::test]
    async fn append_ai_ignore_creates_file_with_header() {
        let (_tmp, dir) = ai_ignore_test_repo();
        let repo = dir.to_string_lossy().into_owned();

        let added =
            append_repo_ai_ignore(repo.clone(), vec!["src/foo.rs".to_string(), "*.log".to_string()])
                .await
                .unwrap();
        // A fresh file: both patterns are appended.
        assert_eq!(added, 2);

        let path = dir.join(".gitdesktop").join("aiignore");
        let text = std::fs::read_to_string(&path).unwrap();
        let first_line = text.lines().next().unwrap();
        assert_eq!(
            first_line,
            "# Files excluded from AI context — gitignore-style patterns, one per line."
        );
        assert!(text.contains("\nsrc/foo.rs\n"));
        assert!(text.contains("\n*.log\n"));

        // read_repo_ai_ignore / parse_patterns round-trips the patterns, header filtered.
        let parsed = read_repo_ai_ignore(repo).await.unwrap();
        assert_eq!(parsed, vec!["src/foo.rs".to_string(), "*.log".to_string()]);
    }

    #[tokio::test]
    async fn append_ai_ignore_appends_without_duplicating() {
        let (_tmp, dir) = ai_ignore_test_repo();
        let repo = dir.to_string_lossy().into_owned();

        let added_first = append_repo_ai_ignore(repo.clone(), vec!["a.txt".to_string()])
            .await
            .unwrap();
        assert_eq!(added_first, 1);
        let path = dir.join(".gitdesktop").join("aiignore");
        let after_first = std::fs::read_to_string(&path).unwrap();

        // Re-add the same line plus a new one: the existing line is not duplicated,
        // the new line is appended, existing content is preserved, no second header.
        let added_second =
            append_repo_ai_ignore(repo.clone(), vec!["a.txt".to_string(), "b.txt".to_string()])
                .await
                .unwrap();
        // Only the new line counts — the already-present one is skipped.
        assert_eq!(added_second, 1);
        let after_second = std::fs::read_to_string(&path).unwrap();

        assert_eq!(after_second.matches("\na.txt\n").count(), 1);
        assert!(after_second.contains("\nb.txt\n"));
        assert!(after_second.starts_with(&after_first));
        assert_eq!(
            after_second
                .lines()
                .filter(|l| l.starts_with('#'))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn append_ai_ignore_normalizes_patterns() {
        let (_tmp, dir) = ai_ignore_test_repo();
        let repo = dir.to_string_lossy().into_owned();

        // Leading slash PRESERVED (it anchors the pattern to the repo root),
        // whitespace trimmed, whitespace-only skipped, in-batch dupes collapsed.
        let added = append_repo_ai_ignore(
            repo.clone(),
            vec![
                "/foo".to_string(),
                "   ".to_string(),
                "  bar  ".to_string(),
                "bar".to_string(),
            ],
        )
        .await
        .unwrap();
        // The whitespace-only entry and the in-batch dupe collapse: "/foo" + "bar".
        assert_eq!(added, 2);
        let parsed = read_repo_ai_ignore(repo.clone()).await.unwrap();
        assert_eq!(parsed, vec!["/foo".to_string(), "bar".to_string()]);

        // `/foo` and `foo` are DIFFERENT patterns (anchored vs any-depth), so the
        // unanchored twin is a new line, not a duplicate.
        let added_unanchored = append_repo_ai_ignore(repo.clone(), vec!["foo".to_string()])
            .await
            .unwrap();
        assert_eq!(added_unanchored, 1);

        // An all-duplicates batch leaves the file byte-identical and appends nothing.
        let path = dir.join(".gitdesktop").join("aiignore");
        let before = std::fs::read_to_string(&path).unwrap();
        let added_dupe = append_repo_ai_ignore(repo, vec!["/foo".to_string(), "bar".to_string()])
            .await
            .unwrap();
        assert_eq!(added_dupe, 0);
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after);
    }
}
