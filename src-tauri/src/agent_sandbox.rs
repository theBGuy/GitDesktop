//! Optional **container isolation** for write-capable agent sessions.
//!
//! By default a session runs the agent CLI full-auto on the host, confined only
//! by its throwaway git worktree (a soft boundary). When the user opts into
//! container isolation and Docker/Podman is available, we instead run the same
//! CLI inside an ephemeral `--rm` container with **only** the worktree
//! bind-mounted — so the agent's writes are confined to that mount by the kernel,
//! and full-auto bypass is safe inside. The host still drives git (the worktree
//! `.git` is a file-pointer that doesn't resolve in-container), so commit/diff/
//! Keep-Discard are unchanged.
//!
//! Auth: each agent CLI's credentials are a file (Claude `~/.claude/
//! .credentials.json`, Codex `~/.codex/auth.json`, opencode optionally
//! `~/.local/share/opencode/auth.json`), so we seed a **copy** into a per-session,
//! per-agent home that's mounted read-write at the CLI's dir — the container
//! authenticates with no API key, can refresh its own token, and never sees the
//! host's real config. The home persists across a session's turns (so `--resume`
//! finds the transcript) and is removed on discard/delete. **opencode needs no
//! creds for its free hosted models**, so its container runs keyless out of the box.
//! **Copilot has no mountable creds file** (its login lives in the OS keychain), so
//! its container authenticates from a GitHub token (`gh auth token`) passed by env
//! (`COPILOT_GITHUB_TOKEN`), never a file.
//!
//! Every agent — Codex included — runs on the host or in a container; on the host
//! Codex is confined by its own OS sandbox (`-s workspace-write`), and the container
//! is what makes its full-bypass safe. Only Codex's **MCP** support is container-only
//! (see `mcp.rs`). Validated end-to-end by spike + live runs (Codex 2026-06-22,
//! opencode 2026-06-23); see docs/agent-sandbox-docker.md.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

use crate::agent::{resolve_named, run_capture, DETECT_TIMEOUT};
use crate::error::{AppError, AppResult};

/// The managed image: a small Node base with the user-selected agent CLIs, run as
/// the non-root `node` user (the CLIs refuse full-bypass as root). A single fixed
/// tag, rebuilt in place when the user changes the Node version or providers; the
/// built config is recorded as the `gdconfig` image LABEL so detect can tell
/// whether the image matches the current selection (else the UI prompts a rebuild).
pub const IMAGE: &str = "gitdesktop-agent:latest";
const BUILD_TIMEOUT: Duration = Duration::from_secs(600);

/// Tag prefix for a per-repo DERIVED image — the managed base plus the repo's
/// `.gitdesktop/agent.Dockerfile` extra layers. The tag body is a content hash so a
/// changed Dockerfile (or a rebuilt base) becomes a new tag = "rebuild needed".
const CUSTOM_IMAGE_PREFIX: &str = "gitdesktop-agent-custom";
/// A repo's custom Dockerfile MUST start with this so the derived image inherits the
/// hardened managed base (non-root `node`, ca-certs, the agent CLIs). Everything after is
/// arbitrary — gated by confirm-to-build, never auto-run.
const CUSTOM_DOCKERFILE_FROM: &str = "FROM gitdesktop-agent:latest";

/// Monotonic suffix for build-context temp dirs, so two concurrent builds (two Settings
/// panels, or two repos) never share a context dir and overwrite each other's Dockerfile —
/// `process::id()` alone is constant for the process, so it can't disambiguate concurrent calls.
static BUILD_CTX_SEQ: AtomicU64 = AtomicU64::new(0);

/// npm package for a **container-capable** agent. `None` for an agent we can't run
/// in the container.
fn agent_npm_package(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("@anthropic-ai/claude-code"),
        "codex" => Some("@openai/codex"),
        "opencode" => Some("opencode-ai"),
        // Copilot has no mountable creds file (its login lives in the OS keychain),
        // so a container session authenticates from a `gh auth token` passed by env
        // — see `build_run_args` / the `agent_session` container branch.
        "copilot" => Some("@github/copilot"),
        _ => None,
    }
}

/// The container dir an agent's seeded home mounts at — where it keeps its creds +
/// session store. opencode uses an XDG data dir (its SQLite session db + optional
/// auth.json live in `~/.local/share/opencode`), not a top-level dotdir.
fn agent_dotdir(agent: &str) -> &'static str {
    match agent {
        "codex" => "/home/node/.codex",
        "opencode" => "/home/node/.local/share/opencode",
        // Copilot keeps its session-store.db (for `--resume`) + config here; no creds
        // file (it authenticates from the env token), but the dir still mounts so the
        // session db survives across a session's turns.
        "copilot" => "/home/node/.copilot",
        _ => "/home/node/.claude",
    }
}

/// The MCP config an in-container agent reads, as `(home-relative filename,
/// absolute container path)`. The per-session home mounts at the agent's dotdir
/// (`agent_dotdir`), so writing `<home>/<filename>` lands the file at the returned
/// container path. Each CLI consumes it differently (Claude `--mcp-config <path>`;
/// opencode `OPENCODE_CONFIG=<path>`; Codex + Copilot read their dotdir file
/// implicitly — `config.toml` / `mcp-config.json`). The seeded home is clean, so
/// the written file is the ONLY MCP source (strict). `None` for an unknown agent.
pub(crate) fn container_mcp_config(agent: &str) -> Option<(&'static str, String)> {
    let dotdir = agent_dotdir(agent);
    let filename = match agent {
        "claude" => "mcp.json",
        "codex" => "config.toml",
        "copilot" => "mcp-config.json",
        "opencode" => "opencode-mcp.json",
        _ => return None,
    };
    Some((filename, format!("{dotdir}/{filename}")))
}

/// Where the in-container CLI reads GLOBAL skills — Claude reads only
/// `~/.claude/skills` (the host junctions it to the canonical store), every other
/// agent reads the vendor-neutral `~/.agents/skills` directly.
fn skills_target(agent: &str) -> &'static str {
    match agent {
        "claude" => "/home/node/.claude/skills",
        _ => "/home/node/.agents/skills",
    }
}

/// Digits-only Node major version (e.g. "24"), guarded so it can't inject into the
/// Dockerfile or the image label.
fn valid_node_version(v: &str) -> bool {
    !v.is_empty() && v.len() <= 3 && v.bytes().all(|b| b.is_ascii_digit())
}

/// A deterministic signature of the image config, stored as the `gdconfig` image
/// label — detect compares it to the current selection to decide "matches" vs
/// "rebuild needed". Providers are sorted + de-duped so order doesn't matter.
fn config_signature(node_version: &str, providers: &[String]) -> String {
    let mut p: Vec<&str> = providers.iter().map(String::as_str).collect();
    p.sort_unstable();
    p.dedup();
    format!("node{node_version}-{}", p.join("-"))
}

/// Renders the Dockerfile for the chosen Node version + agent providers. Validates
/// inputs (digits-only version; every provider container-capable; ≥1 provider).
/// `node:<ver>-slim` lacks ca-certificates, so the agents' TLS to their APIs fails
/// ("no native root CA certificates found") — install them.
fn render_dockerfile(node_version: &str, providers: &[String]) -> AppResult<String> {
    if !valid_node_version(node_version) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Node version: {node_version:?}"
        )));
    }
    let mut pkgs: Vec<&str> = Vec::new();
    let mut dirs: Vec<&str> = Vec::new();
    for a in providers {
        let pkg = agent_npm_package(a).ok_or_else(|| {
            AppError::InvalidArgument(format!("agent can't run in a container: {a:?}"))
        })?;
        pkgs.push(pkg);
        dirs.push(agent_dotdir(a));
    }
    pkgs.sort_unstable();
    pkgs.dedup();
    dirs.sort_unstable();
    dirs.dedup();
    if pkgs.is_empty() {
        return Err(AppError::InvalidArgument(
            "select at least one agent to install in the image".into(),
        ));
    }
    let pkgs = pkgs.join(" ");
    let dirs = dirs.join(" ");
    // `chown` the WHOLE home, not just `{dirs}`: opencode's dotdir is several levels
    // deep (`~/.local/share/opencode`), so `mkdir -p` leaves the intermediate
    // `~/.local` root-owned — and then `node` can't create the sibling XDG dirs
    // opencode needs at runtime (`~/.local/state`), failing with EACCES. Chowning
    // `/home/node` (nearly empty in the slim image) is a harmless superset for the
    // top-level Claude/Codex dotdirs and fixes the deep opencode case. Verified live.
    Ok(format!(
        "FROM node:{node_version}-slim\nRUN apt-get update \\\n && apt-get install -y --no-install-recommends ca-certificates \\\n && rm -rf /var/lib/apt/lists/* \\\n && npm install -g {pkgs} \\\n && mkdir -p {dirs} \\\n && chown -R node:node /home/node\nUSER node\nWORKDIR /workspace\n"
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatus {
    /// "docker" | "podman", or null if neither is on PATH.
    pub runtime: Option<String>,
    /// The runtime is installed AND its daemon answers (`<rt> version` exit 0).
    pub ready: bool,
    /// The managed agent image has been built (any config).
    pub image_present: bool,
    /// The built image's `gdconfig` label matches the requested Node version +
    /// providers — `false` while `image_present` is true means "rebuild to apply".
    pub image_matches: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// The host credentials file an agent's container home is seeded from. `None` for an
/// agent with no mountable creds file — Copilot (login is in the OS keychain; it auths
/// from an env token instead) and opencode when it has no `auth.json` (free models).
fn host_creds(agent: &str) -> Option<PathBuf> {
    // Copilot has no creds file to seed — its container authenticates from a GitHub
    // token passed by env, not a mounted file.
    if agent == "copilot" {
        return None;
    }
    home_dir().map(|h| match agent {
        "codex" => h.join(".codex").join("auth.json"),
        "opencode" => h
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json"),
        _ => h.join(".claude").join(".credentials.json"),
    })
}

/// Whether the agent CLI is logged in on the host (its creds file exists) — so a
/// container session can fail early with a clear "log in first" message instead
/// of a cryptic in-container auth error.
pub(crate) fn host_logged_in(agent: &str) -> bool {
    host_creds(agent).is_some_and(|p| p.is_file())
}

/// The host's GLOBAL skills store — the vendor-neutral canonical `~/.agents/skills`
/// — if it exists, to bind-mount read-only into a container session. Without it, a
/// container only sees PROJECT skills carried in the mounted worktree, so a nudge to
/// a global skill (which the host CLI would auto-load from home) can't resolve. We
/// source the canonical dir (all real subdirs); a Claude-only skill living solely in
/// a real `~/.claude/skills` entry isn't covered (a follow-up if it's ever needed).
pub(crate) fn global_skills_dir() -> Option<PathBuf> {
    home_dir()
        .map(|h| h.join(".agents").join("skills"))
        .filter(|p| p.is_dir())
}

/// Finds Docker or Podman on PATH (Docker preferred). Returns (binary, name).
pub(crate) async fn detect_runtime() -> Option<(PathBuf, String)> {
    if let Some(bin) = resolve_named(&["docker"], None).await {
        return Some((bin, "docker".to_string()));
    }
    if let Some(bin) = resolve_named(&["podman"], None).await {
        return Some((bin, "podman".to_string()));
    }
    // Windows: Podman Desktop installs here but isn't on PATH until the app is
    // relaunched after install — check the known location so a just-installed
    // Podman is found without a restart.
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local)
            .join("Programs")
            .join("Podman")
            .join("podman.exe");
        if p.is_file() {
            return Some((p, "podman".to_string()));
        }
    }
    None
}

/// True when `<rt> version` exits 0 (engine reachable, not just the client).
pub(crate) async fn runtime_ready(bin: &Path) -> bool {
    matches!(
        run_capture(bin, &["version"], DETECT_TIMEOUT).await,
        Ok((0, _))
    )
}

pub(crate) async fn image_present(bin: &Path) -> bool {
    matches!(
        run_capture(bin, &["image", "inspect", IMAGE], DETECT_TIMEOUT).await,
        Ok((0, _))
    )
}

/// Reads the built image's `gdconfig` label (`None` if the image/label is absent).
async fn image_config_label(bin: &Path) -> Option<String> {
    match run_capture(
        bin,
        &[
            "image",
            "inspect",
            "--format",
            "{{index .Config.Labels \"gdconfig\"}}",
            IMAGE,
        ],
        DETECT_TIMEOUT,
    )
    .await
    {
        Ok((0, out)) => Some(out.trim().to_string()),
        _ => None,
    }
}

/// Whether the built image includes `agent` (per its `gdconfig` label) — lets a
/// container session fail clearly if the user left that agent out of the image. An
/// old image with no label is treated as "has it" (don't block; the run will tell).
pub(crate) async fn image_has_agent(bin: &Path, agent: &str) -> bool {
    match image_config_label(bin).await {
        Some(sig) if !sig.is_empty() => sig.split('-').any(|t| t == agent),
        _ => true,
    }
}

/// Reports whether container isolation is usable on this machine and whether the
/// agent image still needs building. Drives the Settings affordance.
#[tauri::command]
pub async fn agent_container_detect(
    node_version: String,
    providers: Vec<String>,
) -> AppResult<ContainerStatus> {
    let Some((bin, name)) = detect_runtime().await else {
        return Ok(ContainerStatus {
            runtime: None,
            ready: false,
            image_present: false,
            image_matches: false,
        });
    };
    let ready = runtime_ready(&bin).await;
    // Only probe the image if the engine is up (inspect needs the daemon).
    let image_present = ready && image_present(&bin).await;
    let image_matches = image_present
        && image_config_label(&bin).await.as_deref()
            == Some(config_signature(&node_version, &providers).as_str());
    Ok(ContainerStatus {
        runtime: Some(name),
        ready,
        image_present,
        image_matches,
    })
}

/// Builds the managed agent image (`<rt> build -t IMAGE <ctx>` from a tiny temp
/// context dir). Idempotent + cached by the engine; a few minutes on first run.
#[tauri::command]
pub async fn agent_container_prepare(
    node_version: String,
    providers: Vec<String>,
    force: bool,
) -> AppResult<()> {
    let (bin, _) = detect_runtime()
        .await
        .ok_or_else(|| AppError::Command("Docker or Podman is not installed.".into()))?;
    if !runtime_ready(&bin).await {
        return Err(AppError::Command(
            "Docker/Podman is installed but its engine isn't running. Start it and try again."
                .into(),
        ));
    }

    // Render + validate the Dockerfile for the selected Node version + providers,
    // and stamp the config as a label so detect can spot a stale image.
    let dockerfile = render_dockerfile(&node_version, &providers)?;
    let label = format!("gdconfig={}", config_signature(&node_version, &providers));

    // Write the Dockerfile into an empty temp context dir and build from it,
    // rather than piping it on stdin — `build -` reads stdin differently across
    // Docker and Podman, so a real (tiny) context dir is the portable form.
    let ctx = std::env::temp_dir().join(format!(
        "gd-agent-build-{}-{}",
        std::process::id(),
        BUILD_CTX_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&ctx)?;
    std::fs::write(ctx.join("Dockerfile"), &dockerfile)?;
    let ctx_str = ctx.to_string_lossy().into_owned();

    let mut build_args: Vec<String> =
        vec!["build".into(), "-t".into(), IMAGE.into(), "--label".into(), label];
    // Rebuild ("update") pulls a fresh base + reinstalls the CLIs rather than
    // reusing cached layers, so newer CLI / Node releases are actually picked up.
    if force {
        build_args.push("--no-cache".into());
        build_args.push("--pull".into());
    }
    build_args.push(ctx_str);

    let result = run_build(&bin, &build_args).await;
    let _ = std::fs::remove_dir_all(&ctx); // clean the context regardless
    result
}

/// Runs a `<rt> build …` invocation with the build timeout, no console window on Windows,
/// and a tail of the build log on failure. Shared by the base-image build
/// (`agent_container_prepare`) and the per-repo derived-image build; each caller manages
/// its own temp context dir.
async fn run_build(bin: &Path, build_args: &[String]) -> AppResult<()> {
    let mut cmd = Command::new(bin);
    cmd.args(build_args)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(BUILD_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::Timeout(BUILD_TIMEOUT.as_secs()))?
        .map_err(AppError::Io)?;
    if !out.status.success() {
        let mut log = String::from_utf8_lossy(&out.stdout).into_owned();
        log.push_str(&String::from_utf8_lossy(&out.stderr));
        let tail: String = log
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(AppError::Command(format!(
            "Building the agent image failed:\n{tail}"
        )));
    }
    Ok(())
}

// --- per-repo derived (custom) image -----------------------------------------
//
// A repo can layer extra tools (e.g. Playwright) onto the managed base by committing a
// `.gitdesktop/agent.Dockerfile` that starts `FROM gitdesktop-agent:latest`. GitDesktop
// builds that into a per-repo image tagged by a content hash, and container sessions (plus
// the Test shell) for that repo run in it. The build runs the Dockerfile's arbitrary
// commands, so it is ONLY ever user-initiated after a review + confirm — never automatic —
// the guard against a cloned/untrusted repo. The tag's existence doubles as the "built"
// record: a changed Dockerfile (or a rebuilt base) hashes to a new tag, so it reads as
// "needs build" until the user confirms again.

/// The repo-relative custom Dockerfile path (`<repo>/.gitdesktop/agent.Dockerfile`).
fn custom_dockerfile_path(worktree_path: &str) -> PathBuf {
    Path::new(worktree_path)
        .join(".gitdesktop")
        .join("agent.Dockerfile")
}

/// Reads a repo/worktree's custom agent Dockerfile. `Ok(None)` = no file (the common case →
/// the repo uses the base image); `Err` = the file exists but couldn't be read (permissions,
/// bad encoding) — surfaced rather than silently treated as "no custom image".
fn read_custom_dockerfile(worktree_path: &str) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(custom_dockerfile_path(worktree_path)) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The first non-blank, non-comment line of a Dockerfile — its `FROM`.
fn first_instruction(dockerfile: &str) -> Option<&str> {
    dockerfile
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
}

/// The name of a Docker **parser directive** (`syntax` / `escape`) in the leading comment
/// block, if present. Parser directives are processed by BuildKit BEFORE any instruction —
/// `# syntax=<image>` makes it fetch an arbitrary remote build *frontend* that can ignore the
/// `FROM` boundary and run build-time code the reviewer never saw. Docker only honours them in
/// the unbroken run of comment lines at the very top (a blank line or an instruction ends that
/// run), and only after a **single** `#` — so we scan that region, skip `##…` lines (ordinary
/// comments, e.g. a directive deliberately commented out), and reject any real directive we find.
fn leading_parser_directive(dockerfile: &str) -> Option<String> {
    for raw in dockerfile.lines() {
        let line = raw.trim();
        // A blank line or an instruction (no leading `#`) ends the directive block.
        let Some(rest) = line.strip_prefix('#') else {
            break;
        };
        // `##…` is an ordinary comment — Docker only treats `# name=value` (one `#`) as a
        // directive — so skip it rather than mis-reading it as `# name=value`.
        if rest.starts_with('#') {
            continue;
        }
        if let Some((name, _value)) = rest.trim().split_once('=') {
            let name = name.trim().to_ascii_lowercase();
            if name == "syntax" || name == "escape" {
                return Some(name);
            }
        }
    }
    None
}

/// Validates a repo's custom Dockerfile against the security contract, returning the
/// user-facing reason on failure: no build-altering parser directives (see
/// [`leading_parser_directive`]), and a first instruction of exactly
/// `FROM gitdesktop-agent:latest` (case-insensitive keyword, exact image) so the derived image
/// inherits the hardened managed base rather than an arbitrary one.
fn validate_custom_dockerfile(dockerfile: &str) -> Result<(), String> {
    if let Some(name) = leading_parser_directive(dockerfile) {
        return Err(format!(
            "Remove the `# {name}=` parser directive — BuildKit runs it before any instruction, so it can pull an arbitrary build frontend and bypass the managed base."
        ));
    }
    let valid_from = first_instruction(dockerfile).is_some_and(|line| {
        let mut toks = line.split_whitespace();
        matches!(toks.next(), Some(kw) if kw.eq_ignore_ascii_case("FROM"))
            && toks.next() == Some("gitdesktop-agent:latest")
            && toks.next().is_none()
    });
    if valid_from {
        Ok(())
    } else {
        Err(format!(
            "The first instruction must be `{CUSTOM_DOCKERFILE_FROM}` so the image builds on the managed base."
        ))
    }
}

/// Bool form of [`validate_custom_dockerfile`] for callers that only branch on validity.
fn custom_dockerfile_valid(dockerfile: &str) -> bool {
    validate_custom_dockerfile(dockerfile).is_ok()
}

/// FNV-1a of the base image Id + the Dockerfile bytes → the derived image tag. A changed
/// Dockerfile OR a rebuilt base changes the hash (a new tag = rebuild needed).
/// Dependency-free, matching `test_container_name`; collision risk is negligible here.
fn derived_tag(base_image_id: &str, dockerfile: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in base_image_id
        .bytes()
        .chain(std::iter::once(0u8))
        .chain(dockerfile.bytes())
    {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{CUSTOM_IMAGE_PREFIX}:{hash:016x}")
}

/// The managed base image's content Id (`<rt> image inspect --format {{.Id}}`), or `None`
/// when the base isn't built (a derived image can't exist without it).
async fn base_image_id(bin: &Path) -> Option<String> {
    match run_capture(
        bin,
        &["image", "inspect", "--format", "{{.Id}}", IMAGE],
        DETECT_TIMEOUT,
    )
    .await
    {
        Ok((0, out)) if !out.trim().is_empty() => Some(out.trim().to_string()),
        _ => None,
    }
}

/// Whether an image with `tag` exists locally.
async fn image_exists(bin: &Path, tag: &str) -> bool {
    matches!(
        run_capture(bin, &["image", "inspect", tag], DETECT_TIMEOUT).await,
        Ok((0, _))
    )
}

/// The image a container session / Test shell should run for `worktree_path`: the repo's
/// per-repo derived image when it is valid AND built, else the managed base. Best-effort —
/// any missing piece falls back to the base so a session always launches.
pub(crate) async fn resolve_session_image(bin: &Path, worktree_path: &str) -> String {
    if let Ok(Some(dockerfile)) = read_custom_dockerfile(worktree_path) {
        if custom_dockerfile_valid(&dockerfile) {
            if let Some(id) = base_image_id(bin).await {
                let tag = derived_tag(&id, &dockerfile);
                if image_exists(bin, &tag).await {
                    return tag;
                }
            }
        }
    }
    IMAGE.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomImageStatus {
    /// "none" (no Dockerfile), "invalid" (bad `FROM`), "needsBuild", or "built".
    pub state: &'static str,
    /// The Dockerfile's contents, for the View Dockerfile affordance (present for every
    /// state except "none").
    pub dockerfile: Option<String>,
    /// A human explanation for the "invalid" state.
    pub error: Option<String>,
}

/// Reports the state of a repo's per-repo custom agent image (from its
/// `.gitdesktop/agent.Dockerfile`) for the Settings sandbox affordance. `none` when the
/// repo ships no custom Dockerfile — it uses the base image.
#[tauri::command]
pub async fn agent_custom_image_status(worktree_path: String) -> AppResult<CustomImageStatus> {
    let dockerfile = match read_custom_dockerfile(&worktree_path) {
        Ok(Some(contents)) => contents,
        Ok(None) => {
            return Ok(CustomImageStatus {
                state: "none",
                dockerfile: None,
                error: None,
            });
        }
        Err(e) => {
            return Ok(CustomImageStatus {
                state: "invalid",
                dockerfile: None,
                error: Some(format!("Couldn't read .gitdesktop/agent.Dockerfile: {e}")),
            });
        }
    };
    if let Err(reason) = validate_custom_dockerfile(&dockerfile) {
        return Ok(CustomImageStatus {
            state: "invalid",
            dockerfile: Some(dockerfile),
            error: Some(reason),
        });
    }
    // Valid → is it built? Needs the runtime + the base image to compute the tag.
    let built = match detect_runtime().await {
        Some((bin, _)) => match base_image_id(&bin).await {
            Some(id) => image_exists(&bin, &derived_tag(&id, &dockerfile)).await,
            None => false,
        },
        None => false,
    };
    Ok(CustomImageStatus {
        state: if built { "built" } else { "needsBuild" },
        dockerfile: Some(dockerfile),
        error: None,
    })
}

/// Builds (or rebuilds with `force`) a repo's custom agent image from its
/// `.gitdesktop/agent.Dockerfile`, layered on the managed base. **User-initiated only** —
/// this runs the Dockerfile's arbitrary build-time commands, so the UI shows the file and
/// requires an explicit confirm before ever calling this (never automatic), the guard
/// against a cloned/untrusted repo.
#[tauri::command]
pub async fn agent_build_custom_image(
    worktree_path: String,
    expected_dockerfile: String,
    force: bool,
) -> AppResult<()> {
    let Some(dockerfile) = read_custom_dockerfile(&worktree_path)? else {
        return Err(AppError::InvalidArgument(
            "this repository has no .gitdesktop/agent.Dockerfile".into(),
        ));
    };
    // TOCTOU guard: build ONLY the exact bytes the user reviewed in the dialog. If the file
    // changed on disk since it was shown (e.g. a `git pull` in a terminal while the dialog was
    // open), refuse rather than silently building unreviewed content.
    if dockerfile != expected_dockerfile {
        return Err(AppError::InvalidArgument(
            "The Dockerfile changed since you reviewed it. Reopen the review to see the current contents, then build.".into(),
        ));
    }
    validate_custom_dockerfile(&dockerfile).map_err(AppError::InvalidArgument)?;
    let (bin, _) = detect_runtime()
        .await
        .ok_or_else(|| AppError::Command("Docker or Podman is not installed.".into()))?;
    if !runtime_ready(&bin).await {
        return Err(AppError::Command(
            "Docker/Podman is installed but its engine isn't running. Start it and try again."
                .into(),
        ));
    }
    let id = base_image_id(&bin).await.ok_or_else(|| {
        AppError::Command(
            "Build the base agent image first (Settings → container isolation), then build the custom image."
                .into(),
        )
    })?;
    let tag = derived_tag(&id, &dockerfile);

    let ctx = std::env::temp_dir().join(format!(
        "gd-agent-custom-{}-{}",
        std::process::id(),
        BUILD_CTX_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&ctx)?;
    std::fs::write(ctx.join("Dockerfile"), &dockerfile)?;
    let ctx_str = ctx.to_string_lossy().into_owned();

    // No `--pull`: the FROM is the LOCAL managed base, not a registry image (a pull would
    // fail). `--no-cache` on rebuild re-runs the RUN layers to pick up tool updates.
    let mut build_args: Vec<String> = vec![
        "build".into(),
        "-t".into(),
        tag,
        "--label".into(),
        "gdderived=1".into(),
    ];
    if force {
        build_args.push("--no-cache".into());
    }
    build_args.push(ctx_str);

    let result = run_build(&bin, &build_args).await;
    let _ = std::fs::remove_dir_all(&ctx);
    result
}

/// Writes a starter `.gitdesktop/agent.Dockerfile` into the repo for the user to edit +
/// commit (scaffold local, never auto-commit). Returns `false` without touching anything
/// if one already exists. Creates `.gitdesktop/` as needed.
#[tauri::command]
pub async fn agent_scaffold_custom_dockerfile(repo_path: String) -> AppResult<bool> {
    let dir = Path::new(&repo_path);
    if !dir.is_dir() {
        return Err(AppError::InvalidArgument(format!(
            "not a directory: {repo_path}"
        )));
    }
    let file = custom_dockerfile_path(&repo_path);
    if tokio::fs::try_exists(&file).await.unwrap_or(false) {
        return Ok(false);
    }
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&file, CUSTOM_DOCKERFILE_STARTER).await?;
    Ok(true)
}

/// The scaffolded starter — a valid, no-op derived Dockerfile (the example tool line is
/// commented out) that the user edits to add tools.
const CUSTOM_DOCKERFILE_STARTER: &str = concat!(
    "# Custom agent container image for this repository.\n",
    "#\n",
    "# GitDesktop builds this into a per-repo image layered on its managed agent base, and runs\n",
    "# containerized agent sessions (and the Test shell) for this repo inside it. It MUST start\n",
    "# with `FROM gitdesktop-agent:latest`. Everything below is yours to add — but note the\n",
    "# image is only ever (re)built after you review it and confirm, so a build runs your\n",
    "# commands. Switch to `USER root` to install system packages, then back to `USER node`.\n",
    "#\n",
    "# Example: add Playwright + Chromium for browser tests.\n",
    "FROM gitdesktop-agent:latest\n",
    "USER root\n",
    "# RUN npx -y playwright@latest install --with-deps chromium\n",
    "USER node\n",
);

// --- per-session claude-home (mounted, holds creds + transcript) -------------

fn agent_home_root(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
        .join("agent-home"))
}

/// A persistent host npm cache, mounted into every container at `~/.npm` so an
/// `npx`-based MCP server (or any `npx` use) downloads ONCE and is reused across
/// turns + sessions instead of re-fetching each run (the per-session home is wiped
/// on discard, so without this every first turn re-downloads). Shared across
/// sessions — npm's content-addressed cache is concurrency-safe. Best-effort:
/// returns `None` if the dir can't be created, so a session still runs (just slower).
pub(crate) fn npm_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("agent-npm-cache");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// `<app_data>/agent-home/<session>/<agent>` — mounted at the container's
/// `~/.claude` or `~/.codex`. Session ids are app-generated hex; validated upstream.
fn session_home(app: &AppHandle, session_id: &str, agent: &str) -> AppResult<PathBuf> {
    Ok(agent_home_root(app)?.join(session_id).join(agent))
}

/// Ensures the per-session agent-home exists and (re-)seeds the host's current
/// credentials for `agent` into it, so the container authenticates with the
/// user's live subscription and a refreshed token each run. Returns the home path
/// to mount. Claude reads `~/.claude/.credentials.json`; Codex `~/.codex/auth.json`.
pub(crate) fn seed_session_home(
    app: &AppHandle,
    session_id: &str,
    agent: &str,
) -> AppResult<PathBuf> {
    crate::sessions::validate_id(session_id)?; // no path traversal into the home root
    let home = session_home(app, session_id, agent)?;
    std::fs::create_dir_all(&home)?;
    // Re-copy every run so an expired in-home token is refreshed from the host's
    // current one. Best-effort: the container branch pre-checks `host_logged_in`
    // for a clearer message if the creds are absent.
    if let Some(src) = host_creds(agent) {
        if let (true, Some(name)) = (src.is_file(), src.file_name()) {
            let _ = std::fs::copy(&src, home.join(name));
        }
    }
    Ok(home)
}

/// Removes a session's claude-home (on discard / kept-record delete) and force-
/// removes any lingering container. Best-effort.
#[tauri::command]
pub async fn agent_sandbox_cleanup(app: AppHandle, session_id: String) -> AppResult<()> {
    // This deletes a directory by id, so reject any traversal before touching FS.
    crate::sessions::validate_id(&session_id)?;
    if let Ok(dir) = agent_home_root(&app).map(|r| r.join(&session_id)) {
        let _ = std::fs::remove_dir_all(dir);
    }
    // Drop the generated MCP config too (it may hold resolved secrets).
    crate::mcp::cleanup_host_config(&app, &session_id);
    if let Some((bin, _)) = detect_runtime().await {
        let name = container_name(&session_id);
        let _ = run_capture(&bin, &["rm", "-f", &name], DETECT_TIMEOUT).await;
    }
    Ok(())
}

// --- launch ------------------------------------------------------------------

pub(crate) fn container_name(session_id: &str) -> String {
    format!("gd-agent-{session_id}")
}

/// Converts a host path to the `-v` source form the engine expects. The Windows
/// form is RUNTIME-SPECIFIC (validated 2026-06-22): Docker Desktop wants the
/// MSYS-style `//c/a/b`, while Podman (a WSL machine) wants the WSL path
/// `/mnt/c/a/b` and rejects `//c/...` with "no such file or directory".
/// Elsewhere (Linux/macOS) both runtimes take the POSIX path as-is.
pub(crate) fn to_mount_source(path: &str, runtime: &str) -> String {
    #[cfg(windows)]
    {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            let drive = (bytes[0] as char).to_ascii_lowercase();
            let rest = path[2..].replace('\\', "/");
            let rest = rest.trim_start_matches('/');
            return if runtime == "podman" {
                format!("/mnt/{drive}/{rest}")
            } else {
                format!("//{drive}/{rest}")
            };
        }
        path.replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        let _ = runtime;
        path.to_string()
    }
}

/// Validates a single user-supplied port spec — either a bare `PORT` (published
/// host→container 1:1) or a `HOST:CONTAINER` remap — returning the parsed
/// `(host, container)` pair. Everything is parsed as a `u16` (1..=65535), so
/// nothing non-numeric the user typed can reach the engine argv unchecked, and a
/// busy host port can be sidestepped by remapping (e.g. `5174:5173` when host 5173
/// is taken). `u16::parse` already rejects empty / non-digit / out-of-range.
fn parse_port_spec(spec: &str) -> AppResult<(u16, u16)> {
    let spec = spec.trim();
    let (h, c) = spec.split_once(':').unwrap_or((spec, spec));
    let parse = |p: &str| p.trim().parse::<u16>().ok().filter(|&n| n > 0);
    match (parse(h), parse(c)) {
        (Some(host), Some(container)) => Ok((host, container)),
        _ => Err(AppError::InvalidArgument(format!(
            "invalid port {spec:?} — use a port like 5173, or host:container like 5174:5173"
        ))),
    }
}

/// A stable container name for a worktree's test shell — `gd-test-<hash>`, an
/// FNV-1a of the normalized path. Stable so re-opening **Test** finds (and can
/// reconnect to / stop) the same container instead of spawning a second one.
fn test_container_name(worktree_path: &str) -> String {
    let norm = worktree_path.replace('\\', "/").to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in norm.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("gd-test-{hash:016x}")
}

/// Whether a container named `name` is currently *running* (not just present).
async fn container_running(bin: &Path, name: &str) -> bool {
    match run_capture(
        bin,
        &[
            "ps",
            "--filter",
            &format!("name=^{name}$"),
            "--filter",
            "status=running",
            "-q",
        ],
        DETECT_TIMEOUT,
    )
    .await
    {
        Ok((0, out)) => !out.trim().is_empty(),
        _ => false,
    }
}

/// Opens an **interactive shell inside a container** with a session's worktree
/// bind-mounted at `/workspace`, so the user can test a container session's changes
/// in the *matching* Linux environment (its host deps would be Linux builds — wrong
/// on Windows/macOS). Reuses the session image + the runtime-specific mount form;
/// runs as the default user so `pnpm`/`npm`/build all work the way they did for the
/// agent. Launches a real terminal window because `run -it` needs a TTY.
///
/// The container is **named per-worktree** and `run -it` (not detached): if its
/// terminal is closed without `exit`, the container — and any dev server in it —
/// keeps running in the daemon, holding the published ports. So on re-open we
/// **reconnect** a new shell (`exec`) into the still-running container instead of
/// starting a second one (which would collide on the name and ports). An explicit
/// `agent_stop_test_container` shuts it down when you're done.
///
/// `ports` are the user-chosen dev-server ports to publish to the host loopback
/// (each a bare `PORT` or a `HOST:CONTAINER` remap). A fixed list used to be
/// published, but that fails hard (`ports are not available`) when *any* one of
/// them is already bound on the host — so the port set is now the user's call,
/// defaulted in the UI but fully overridable, and a busy host port can be remapped.
#[tauri::command]
pub async fn agent_open_container_shell(
    worktree_path: String,
    ports: Vec<String>,
) -> AppResult<()> {
    if !Path::new(&worktree_path).is_dir() {
        return Err(AppError::InvalidArgument(format!(
            "not a directory: {worktree_path}"
        )));
    }
    let (bin, args, tip) = container_shell_command(&worktree_path, &ports).await?;
    launch_container_shell(&bin, &args, &tip)
}

/// Builds the docker/podman command (binary + args) that opens a shell for a
/// worktree's test container — `exec` into it if it's already running, else `run`
/// a fresh named container publishing `ports` with the worktree mounted (clearing
/// any stale same-name container first). Returns `(binary, args, tip)`; the tip
/// names the reachable `localhost:<port>` URLs (or the reconnect note). Shared by
/// the external terminal launcher (above) and the in-app PTY terminal so both use
/// the identical run-or-exec, port, and cleanup logic.
pub(crate) async fn container_shell_command(
    worktree_path: &str,
    ports: &[String],
) -> AppResult<(String, Vec<String>, String)> {
    let (bin_path, rt) = detect_runtime().await.ok_or_else(|| {
        AppError::Command(
            "Docker or Podman not found on PATH — install one to test a container session."
                .into(),
        )
    })?;
    let name = test_container_name(worktree_path);
    let bin = bin_path.to_string_lossy().to_string();

    // Already running (its terminal was closed without `exit`) → reconnect a fresh
    // shell into it; its server + published ports are untouched. `exec` takes no
    // ports/mount — those belong to the original `run`.
    if container_running(&bin_path, &name).await {
        let args = vec!["exec".into(), "-it".into(), name, "bash".into()];
        let tip = "Tip: reconnected to the container that is still running - your server and ports are unchanged. Use Stop test container to shut it down.".to_string();
        return Ok((bin, args, tip));
    }

    // Validate the ports before touching anything, so a bad spec fails before we
    // remove/start a container.
    let mut port_args: Vec<String> = Vec::new();
    let mut host_ports: Vec<u16> = Vec::new();
    for spec in ports {
        let (host, container) = parse_port_spec(spec)?;
        port_args.push("-p".into());
        port_args.push(format!("127.0.0.1:{host}:{container}"));
        host_ports.push(host);
    }

    // Clear any stale stopped container with this name so `--name` can't collide.
    let _ = run_capture(&bin_path, &["rm", "-f", &name], DETECT_TIMEOUT).await;

    // Use the repo's per-repo custom image when it's built, else the managed base — so the
    // Test shell matches the environment a container session for this repo runs in.
    let image = resolve_session_image(&bin_path, worktree_path).await;
    let mount = format!("{}:/workspace", to_mount_source(worktree_path, &rt));
    let mut args: Vec<String> =
        vec!["run".into(), "-it".into(), "--rm".into(), "--name".into(), name];
    // Publish the user's chosen dev-server ports to the host's loopback so a server
    // started in the container is reachable at `localhost:<host>` from the host
    // browser (it must bind `0.0.0.0` inside — e.g. Vite `--host`). Bound to
    // 127.0.0.1 so nothing is exposed to the LAN.
    args.extend(port_args);
    args.push("-v".into());
    args.push(mount);
    args.push("-w".into());
    args.push("/workspace".into());
    args.push(image);
    args.push("bash".into());
    let tip = if host_ports.is_empty() {
        "Tip: no ports were published - re-open with a port to reach a dev server from your browser.".to_string()
    } else {
        let urls = host_ports
            .iter()
            .map(|p| format!("localhost:{p}"))
            .collect::<Vec<_>>()
            .join(" / ");
        format!(
            "Tip: bind your dev server to 0.0.0.0 - e.g. pnpm dev --host - then open {urls} in your browser."
        )
    };
    Ok((bin, args, tip))
}

/// Whether this worktree's test-shell container is currently running — lets the UI
/// offer to reconnect to it or stop it instead of starting a new one.
#[tauri::command]
pub async fn agent_test_container_running(worktree_path: String) -> AppResult<bool> {
    let Some((bin, _)) = detect_runtime().await else {
        return Ok(false);
    };
    Ok(container_running(&bin, &test_container_name(&worktree_path)).await)
}

/// Force-stops + removes this worktree's test-shell container, freeing its
/// published ports. Best-effort — a no-op if it isn't running / doesn't exist.
#[tauri::command]
pub async fn agent_stop_test_container(worktree_path: String) -> AppResult<()> {
    if let Some((bin, _)) = detect_runtime().await {
        let _ = run_capture(
            &bin,
            &["rm", "-f", &test_container_name(&worktree_path)],
            DETECT_TIMEOUT,
        )
        .await;
    }
    Ok(())
}

/// POSIX single-quote a token (mac/Linux launch scripts).
#[cfg(unix)]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Windows: write a temp `.cmd` that runs the (double-quoted) command and pauses,
/// then `start` it. A temp script avoids cmd's nested-quoting traps, and `start`
/// gives the `docker run -it` a fresh, fully-wired console (spawning a console
/// directly leaves stdio bound to ours, so it can't take keyboard input).
#[cfg(windows)]
fn launch_container_shell(bin: &str, args: &[String], tip: &str) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut line = format!("\"{bin}\"");
    for a in args {
        line.push_str(&format!(" \"{a}\""));
    }
    let script = format!(
        "@echo off\r\ntitle GitDesktop - container test shell\r\necho {tip}\r\necho.\r\n{line}\r\necho.\r\necho (container exited) Press any key to close...\r\npause >nul\r\n"
    );
    let path = std::env::temp_dir()
        .join(format!("gd-container-shell-{}.cmd", std::process::id()));
    std::fs::write(&path, script).map_err(AppError::Io)?;
    let mut c = Command::new("cmd");
    c.raw_arg(format!("/c start \"GitDesktop\" \"{}\"", path.display()));
    c.creation_flags(CREATE_NO_WINDOW);
    c.spawn().map(|_| ()).map_err(AppError::Io)
}

/// macOS: write a temp `.command` (Terminal.app runs it on `open`).
#[cfg(target_os = "macos")]
fn launch_container_shell(bin: &str, args: &[String], tip: &str) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let mut line = shell_quote(bin);
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    let script = format!(
        "#!/bin/bash\necho 'GitDesktop — container test shell'\necho '{tip}'\n{line}\necho\necho '(container exited)'\n"
    );
    let path = std::env::temp_dir()
        .join(format!("gd-container-shell-{}.command", std::process::id()));
    std::fs::write(&path, script).map_err(AppError::Io)?;
    let mut perm = std::fs::metadata(&path).map_err(AppError::Io)?.permissions();
    perm.set_mode(0o755);
    std::fs::set_permissions(&path, perm).map_err(AppError::Io)?;
    Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(AppError::Io)
}

/// Linux: run the command in the first available terminal emulator (`-e bash -c`),
/// dropping into a shell afterwards so the window stays open.
#[cfg(all(unix, not(target_os = "macos")))]
fn launch_container_shell(bin: &str, args: &[String], tip: &str) -> AppResult<()> {
    use std::process::Command;

    let mut line = shell_quote(bin);
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    let cmd = format!("echo '{tip}'; {line}; echo; echo '(container exited)'; exec bash");
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if Command::new(term)
            .args(["-e", "bash", "-c", &cmd])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(AppError::Io(std::io::Error::other(
        "no terminal emulator found",
    )))
}

/// Builds the full `run …` argv that wraps the inner agent invocation in an
/// ephemeral, worktree-confined container. The agent runs as `node`, cwd
/// `/workspace` (the bind-mounted worktree), with the seeded claude-home mounted +
/// (when present) the user's global skills mounted read-only so a nudged skill
/// resolves; `--rm` tears it down, resource + capability limits harden it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_run_args(
    runtime: &str,
    agent: &str,
    worktree_path: &str,
    home_path: &Path,
    container_name: &str,
    // The image tag to run: the managed base, or a repo's derived custom image.
    image: &str,
    // Host path to the global skills store to mount read-only (None = don't mount).
    skills_src: Option<&str>,
    // Host path to the shared npm cache to mount at `~/.npm` (None = don't mount).
    npm_cache_src: Option<&str>,
    // Extra container env (`-e K=V`) — e.g. opencode's `OPENCODE_CONFIG`. Values are
    // non-secret (a path); a secret is passed by-name instead (see Copilot's token).
    container_env: &[(&str, String)],
    inner: &[String],
) -> Vec<String> {
    let workspace_mount = format!("{}:/workspace", to_mount_source(worktree_path, runtime));
    // The agent-home mounts at the CLI's own dotdir so it finds its creds +
    // session transcript (Codex resumes via `--last` from its mounted ~/.codex).
    let home_target = agent_dotdir(agent);
    let home_mount = format!(
        "{}:{}",
        to_mount_source(&home_path.to_string_lossy(), runtime),
        home_target
    );
    let mut args: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "-i".into(),
        "--name".into(),
        container_name.into(),
    ];
    // Copilot authenticates from a GitHub token instead of a mounted creds file. Pass
    // it through to the container BY NAME (no `=value`): the runtime client inherits
    // `COPILOT_GITHUB_TOKEN` from its own env (set in the `agent_session` container
    // branch), so the token never appears in this argv / `docker inspect`.
    if agent == "copilot" {
        args.push("-e".into());
        args.push("COPILOT_GITHUB_TOKEN".into());
    }
    // Extra container env (`-e K=V`) — e.g. opencode's `OPENCODE_CONFIG` pointing at
    // the mounted MCP config. Paths, never secrets (those go by-name, above).
    for (k, v) in container_env {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    // Rootless Podman on Linux maps the container's non-root `node` (uid 1000) to
    // a host *subuid*, so it can't even write the host-user-owned worktree, and
    // any files it does write aren't owned by the host user (its git can't touch
    // them). `keep-id` maps the host user in as `node` so writes land owned by the
    // host user. Validated 2026-06-22 (without it: EACCES; with it: files owned by
    // the host uid, host git works). NOT needed for Docker, nor the Podman-machine
    // VMs on Windows/macOS (NTFS/VirtioFS already present files as the host user) —
    // and `keep-id` assumes the host login uid is 1000 (= our image's `node`),
    // the overwhelmingly common Linux-desktop case.
    if cfg!(target_os = "linux") && runtime == "podman" {
        args.push("--userns=keep-id".into());
    }
    args.extend([
        "--user".into(),
        "node".into(),
        "-w".into(),
        "/workspace".into(),
        "-v".into(),
        workspace_mount,
        "-v".into(),
        home_mount,
    ]);
    // Mount the user's GLOBAL skills read-only so a skill nudged by name resolves
    // in-container like it does on the host (the worktree only carries PROJECT
    // skills). Target is per-agent (`skills_target`); for Claude it nests under the
    // `~/.claude` home mount, so it MUST be added after it. `:ro` — the agent reads
    // skills, never edits the user's store.
    if let Some(src) = skills_src {
        args.push("-v".into());
        args.push(format!(
            "{}:{}:ro",
            to_mount_source(src, runtime),
            skills_target(agent)
        ));
    }
    // Persistent npm cache (read-write) at `~/.npm` so an npx MCP server is fetched
    // once, not every turn. Sits beside the home mount (`~/.npm` ≠ the agent dotdir).
    if let Some(src) = npm_cache_src {
        args.push("-v".into());
        args.push(format!(
            "{}:/home/node/.npm",
            to_mount_source(src, runtime)
        ));
    }
    args.extend([
        // Hardening: drop Linux capabilities (a userland Node process needs
        // none), block privilege escalation, and cap resources.
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--memory".into(),
        "4g".into(),
        "--pids-limit".into(),
        "1024".into(),
        image.into(),
    ]);
    // Name the agent CLI as the in-container command. The image inherits the `node`
    // base entrypoint, which execs its args directly BUT prepends `node` to a leading
    // `-flag` — so a bare `-p …` / `exec …` (what the `*_session_args` builders emit,
    // since the host path supplies the binary separately) would run `node`, not the
    // CLI. The CLIs install on PATH under exactly these names
    // (`claude`/`codex`/`opencode`/`copilot`), so prepend `agent` here.
    args.push(agent.into());
    args.extend(inner.iter().cloned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_source_posix_is_unchanged() {
        // On non-Windows this is identity for either runtime.
        assert_eq!(to_mount_source("/home/u/wt", "docker"), "/home/u/wt");
        assert_eq!(to_mount_source("/home/u/wt", "podman"), "/home/u/wt");
    }

    #[cfg(windows)]
    #[test]
    fn mount_source_windows_form_is_runtime_specific() {
        // Docker Desktop wants //c/..., Podman (WSL) wants /mnt/c/...
        assert_eq!(to_mount_source("C:\\Temp\\x", "docker"), "//c/Temp/x");
        assert_eq!(to_mount_source("C:\\Temp\\x", "podman"), "/mnt/c/Temp/x");
        assert_eq!(to_mount_source("D:\\a\\b\\c", "podman"), "/mnt/d/a/b/c");
    }

    #[test]
    fn build_run_args_mounts_workspace_and_home_then_inner() {
        let home = PathBuf::from(if cfg!(windows) {
            "C:\\data\\agent-home\\s1\\claude"
        } else {
            "/data/agent-home/s1/claude"
        });
        let inner = vec!["-p".to_string(), "--resume".to_string(), "s1".to_string()];
        let args = build_run_args(
            "docker",
            "claude",
            "/repos/wt",
            &home,
            "gd-agent-s1",
            IMAGE,
            None,
            None,
            &[],
            &inner,
        );
        assert_eq!(args[0], "run");
        assert!(args.contains(&"--rm".to_string()));
        assert!(args.contains(&"node".to_string())); // runs as non-root
        assert!(args.iter().any(|a| a.ends_with(":/workspace")));
        assert!(args.iter().any(|a| a.ends_with(":/home/node/.claude")));
        // Codex mounts its home at ~/.codex instead.
        let codex = build_run_args(
            "docker", "codex", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner,
        );
        assert!(codex.iter().any(|a| a.ends_with(":/home/node/.codex")));
        // opencode mounts its XDG data dir.
        let oc = build_run_args(
            "docker", "opencode", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner,
        );
        assert!(oc
            .iter()
            .any(|a| a.ends_with(":/home/node/.local/share/opencode")));
        assert!(args.contains(&IMAGE.to_string()));
        // After IMAGE: the agent CLI command name, then its inner args (the node base
        // entrypoint would otherwise run `node` on a bare `-p …`).
        let img = args.iter().position(|a| a == IMAGE).unwrap();
        assert_eq!(args[img + 1], "claude");
        assert_eq!(&args[img + 2..], &inner[..]);
    }

    #[test]
    fn copilot_passes_token_env_by_name_only() {
        let home = PathBuf::from("/data/agent-home/s1/copilot");
        let inner = vec!["-p".to_string(), "hi".to_string()];
        let cp = build_run_args("docker", "copilot", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner);
        // Token is passed through by NAME (no `=value`) so it never lands in argv.
        let e = cp.iter().position(|a| a == "-e").expect("has -e");
        assert_eq!(cp[e + 1], "COPILOT_GITHUB_TOKEN");
        assert!(!cp.iter().any(|a| a.contains("COPILOT_GITHUB_TOKEN=")));
        // Copilot's home mounts at ~/.copilot (for its session-store.db).
        assert!(cp.iter().any(|a| a.ends_with(":/home/node/.copilot")));
        // The CLI command name is prepended after IMAGE.
        let img = cp.iter().position(|a| a == IMAGE).unwrap();
        assert_eq!(cp[img + 1], "copilot");
        // Other agents get no token env passthrough.
        let claude = build_run_args("docker", "claude", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner);
        assert!(!claude.iter().any(|a| a == "COPILOT_GITHUB_TOKEN"));
    }

    #[test]
    fn mounts_global_skills_read_only_at_agent_dir() {
        let home = PathBuf::from("/data/agent-home/s1/x");
        let inner = vec!["-p".to_string()];
        let src = if cfg!(windows) {
            "C:\\Users\\u\\.agents\\skills"
        } else {
            "/home/u/.agents/skills"
        };
        // Claude reads only ~/.claude/skills; the mount is read-only.
        let cl = build_run_args("docker", "claude", "/repos/wt", &home, "n", IMAGE, Some(src), None, &[], &inner);
        assert!(cl
            .iter()
            .any(|a| a.ends_with(":/home/node/.claude/skills:ro")));
        // Every other agent reads the vendor-neutral ~/.agents/skills.
        let cx = build_run_args("docker", "codex", "/repos/wt", &home, "n", IMAGE, Some(src), None, &[], &inner);
        assert!(cx
            .iter()
            .any(|a| a.ends_with(":/home/node/.agents/skills:ro")));
        // No source → no skills mount at all.
        let none = build_run_args("docker", "claude", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner);
        assert!(!none.iter().any(|a| a.contains("/skills:ro")));
    }

    #[test]
    fn mounts_npm_cache_and_sets_container_env() {
        let home = PathBuf::from("/data/agent-home/s1/opencode");
        let inner = vec!["run".to_string()];
        let cache = if cfg!(windows) {
            "C:\\data\\agent-npm-cache"
        } else {
            "/data/agent-npm-cache"
        };
        let env = [(
            "OPENCODE_CONFIG",
            "/home/node/.local/share/opencode/opencode-mcp.json".to_string(),
        )];
        let a = build_run_args(
            "docker",
            "opencode",
            "/repos/wt",
            &home,
            "n",
            IMAGE,
            None,
            Some(cache),
            &env,
            &inner,
        );
        // npm cache mounts read-write at ~/.npm (no :ro), beside the home mount.
        assert!(a.iter().any(|m| m.ends_with(":/home/node/.npm")));
        // container env is `-e KEY=VALUE` (a path, in argv — it's not a secret).
        assert!(a
            .iter()
            .any(|m| m == "OPENCODE_CONFIG=/home/node/.local/share/opencode/opencode-mcp.json"));
        // None → neither appears.
        let none = build_run_args(
            "docker", "opencode", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner,
        );
        assert!(!none.iter().any(|m| m.ends_with(":/home/node/.npm")));
        assert!(!none.iter().any(|m| m.starts_with("OPENCODE_CONFIG=")));
    }

    #[test]
    fn container_mcp_config_paths_match_agent_dotdirs() {
        assert_eq!(
            container_mcp_config("claude").unwrap(),
            ("mcp.json", "/home/node/.claude/mcp.json".to_string())
        );
        assert_eq!(
            container_mcp_config("codex").unwrap(),
            ("config.toml", "/home/node/.codex/config.toml".to_string())
        );
        assert_eq!(
            container_mcp_config("copilot").unwrap(),
            ("mcp-config.json", "/home/node/.copilot/mcp-config.json".to_string())
        );
        assert_eq!(
            container_mcp_config("opencode").unwrap(),
            (
                "opencode-mcp.json",
                "/home/node/.local/share/opencode/opencode-mcp.json".to_string()
            )
        );
        assert!(container_mcp_config("nope").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_podman_adds_keep_id_docker_does_not() {
        let home = PathBuf::from("/data/agent-home/s1/claude");
        let inner = vec!["-p".to_string()];
        let podman = build_run_args("podman", "claude", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner);
        assert!(podman.iter().any(|a| a == "--userns=keep-id"));
        let docker = build_run_args("docker", "claude", "/repos/wt", &home, "n", IMAGE, None, None, &[], &inner);
        assert!(!docker.iter().any(|a| a == "--userns=keep-id"));
    }

    #[test]
    fn container_name_is_stable_and_prefixed() {
        assert_eq!(container_name("abc123"), "gd-agent-abc123");
    }

    #[test]
    fn test_container_name_is_stable_prefixed_and_path_normalized() {
        let a = test_container_name("C:\\repos\\wt");
        assert!(a.starts_with("gd-test-"));
        assert_eq!(a.len(), "gd-test-".len() + 16); // 16 hex chars
        // Deterministic across calls, and Windows/POSIX + case variants collapse
        // to the same name (so re-opening Test finds the same container).
        assert_eq!(a, test_container_name("C:\\repos\\wt"));
        assert_eq!(a, test_container_name("c:/repos/wt"));
        // Different worktrees get different names.
        assert_ne!(a, test_container_name("C:\\repos\\other"));
    }

    #[test]
    fn parse_port_spec_accepts_port_and_mapping() {
        // A bare port publishes host→container 1:1.
        assert_eq!(parse_port_spec("5173").unwrap(), (5173, 5173));
        // host:container remaps a busy host port; surrounding whitespace is trimmed.
        assert_eq!(parse_port_spec(" 5174:5173 ").unwrap(), (5174, 5173));
        // Reject port 0, out-of-range, non-numeric, and a half-bad mapping — none of
        // these may reach the engine argv.
        assert!(parse_port_spec("0").is_err());
        assert!(parse_port_spec("99999").is_err());
        assert!(parse_port_spec("abc").is_err());
        assert!(parse_port_spec("5173:abc").is_err());
        assert!(parse_port_spec("").is_err());
    }

    #[test]
    fn render_dockerfile_selects_node_and_providers() {
        let df = render_dockerfile("24", &["claude".into(), "codex".into()]).unwrap();
        assert!(df.contains("FROM node:24-slim"));
        assert!(df.contains("@anthropic-ai/claude-code"));
        assert!(df.contains("@openai/codex"));
        assert!(df.contains("ca-certificates")); // TLS roots, else the agents fail
        // A codex-only image omits the claude package + its dotdir.
        let codex_only = render_dockerfile("22", &["codex".into()]).unwrap();
        assert!(codex_only.contains("FROM node:22-slim"));
        assert!(codex_only.contains("@openai/codex"));
        assert!(!codex_only.contains("claude-code"));
        // opencode is container-capable: its npm package + deep XDG dotdir, and the
        // whole-home chown that makes that deep dir usable by the `node` user.
        let oc = render_dockerfile("24", &["opencode".into()]).unwrap();
        assert!(oc.contains("opencode-ai"));
        assert!(oc.contains("/home/node/.local/share/opencode"));
        assert!(oc.contains("chown -R node:node /home/node"));
        // Copilot is now container-capable too (npm package + its dotdir); it auths
        // from an env token rather than a mounted creds file.
        let cp = render_dockerfile("24", &["copilot".into()]).unwrap();
        assert!(cp.contains("@github/copilot"));
        assert!(cp.contains("/home/node/.copilot"));
        // Bad inputs rejected: non-numeric version, empty set, unknown agent.
        assert!(render_dockerfile("24; rm -rf /", &["claude".into()]).is_err());
        assert!(render_dockerfile("24", &[]).is_err());
        assert!(render_dockerfile("24", &["cursor".into()]).is_err());
    }

    #[test]
    fn config_signature_is_order_independent() {
        assert_eq!(
            config_signature("24", &["codex".into(), "claude".into()]),
            config_signature("24", &["claude".into(), "codex".into()])
        );
        assert_eq!(
            config_signature("24", &["claude".into(), "codex".into()]),
            "node24-claude-codex"
        );
    }

    #[test]
    fn custom_dockerfile_valid_requires_managed_base_from() {
        assert!(custom_dockerfile_valid(
            "FROM gitdesktop-agent:latest\nRUN echo hi\n"
        ));
        // Leading comments + blank lines before FROM are fine; the keyword is case-insensitive.
        assert!(custom_dockerfile_valid(
            "# my tools\n\nfrom gitdesktop-agent:latest\n"
        ));
        // Wrong/arbitrary base, an extra token (multi-stage `AS`), or no FROM are rejected.
        assert!(!custom_dockerfile_valid("FROM node:24-slim\n"));
        assert!(!custom_dockerfile_valid(
            "FROM gitdesktop-agent:latest AS build\n"
        ));
        assert!(!custom_dockerfile_valid("RUN echo hi\n"));
        assert!(!custom_dockerfile_valid(""));
        // `# syntax=` / `# escape=` parser directives at the very top are rejected: BuildKit
        // runs them before any instruction and `# syntax=` can load an arbitrary build frontend
        // that bypasses the managed base — even though the `FROM` line itself looks correct.
        assert!(!custom_dockerfile_valid(
            "# syntax=docker/dockerfile:1\nFROM gitdesktop-agent:latest\n"
        ));
        assert!(!custom_dockerfile_valid(
            "# escape=`\nFROM gitdesktop-agent:latest\n"
        ));
        // A directive commented out with `##` is an ordinary comment (Docker ignores it as a
        // directive), so it's accepted — only a single-`#` `# syntax=`/`# escape=` is a real one.
        assert!(custom_dockerfile_valid(
            "## syntax=docker/dockerfile:1\nFROM gitdesktop-agent:latest\n"
        ));
        // An ordinary leading comment (no `key=value`) is fine, and a `key=value` line that
        // isn't in the top directive block (e.g. an `ENV`) doesn't trip the directive scan.
        assert!(custom_dockerfile_valid(
            "# tools for this repo\nFROM gitdesktop-agent:latest\nENV FOO=bar\n"
        ));
    }

    #[test]
    fn derived_tag_is_deterministic_and_content_sensitive() {
        let df = "FROM gitdesktop-agent:latest\nRUN x\n";
        let t = derived_tag("sha256:abc", df);
        assert!(t.starts_with("gitdesktop-agent-custom:"));
        assert_eq!(t.len(), "gitdesktop-agent-custom:".len() + 16); // 16 hex chars
        assert_eq!(t, derived_tag("sha256:abc", df)); // deterministic
        // A changed Dockerfile OR a rebuilt base (new id) yields a different tag.
        assert_ne!(
            t,
            derived_tag("sha256:abc", "FROM gitdesktop-agent:latest\nRUN y\n")
        );
        assert_ne!(t, derived_tag("sha256:def", df));
    }

    #[test]
    fn build_run_args_uses_the_given_image() {
        let home = PathBuf::from("/data/agent-home/s1/claude");
        let inner = vec!["-p".to_string()];
        let tag = "gitdesktop-agent-custom:00ff00ff00ff00ff";
        let a = build_run_args(
            "docker", "claude", "/repos/wt", &home, "n", tag, None, None, &[], &inner,
        );
        // The given (custom) image tag is what runs, and the CLI command follows it.
        let img = a.iter().position(|x| x == tag).expect("custom image present");
        assert_eq!(a[img + 1], "claude");
        assert!(!a.iter().any(|x| x == IMAGE)); // the base tag is not used
    }
}
