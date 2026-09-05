## Learned User Preferences

- User dislikes GitDesktop's UI and information architecture; Clinically work should not extend or reskin it in this worktree.
- Clinically product is "Clinically Code Control" (`au.clinically.codecontrol`): keep GitDesktop's Rust backend, replace the entire React shell from scratch.
- Use Tauri + React for the Clinically shell, not native SwiftUI.
- Do not port GitDesktop's `src/features/` or reskin to Clinically design tokens; build new flows and screens from scratch.
- Clinically visual language comes from Stream's `.impeccable/design.json` (warm stone, clinical teal, Inter, light mode), not GitDesktop's mint/dark theme.
- Active Clinically app development lives in `/Users/wojt/Code/clinically-au/code-control`, not this GitDesktop worktree.
- Clinically JS repos should set pnpm `blockExoticSubdeps: true`, `trustPolicy: no-downgrade`, and `minimumReleaseAge: 10080`.
- Code Control is intended as a daily-driver desktop Git client (stage/commit/push/PR/CI loop beside the editor), not an occasional specialist tool.
- Cross-repo views are central to Code Control; home is a dashboard (open PRs + CI, running Actions, release cards), not a single-repo picker.
- Code Control is editor-agnostic — no Cursor or IDE-specific hooks; use copy path, reveal in Finder, and OS default open only.
- Code Control v0.1 hosted features are GitHub-only via `gh`; GitLab/Bitbucket are deferred.
- Repo registry is built via multi-org scan (`gh repo list` matched to local clones), configured in settings.

## Learned Workspace Facts

- GitDesktop's Rust backend (`src-tauri/`) shells out to system `git` and `gh`; GitHub auth uses the existing `gh auth login` session, not app-managed OAuth.
- GitDesktop is Apache 2.0; Clinically Code Control copies `src-tauri/` once with LICENSE/NOTICE preserved, without maintaining a tracking upstream fork.
- The Tauri invoke surface (`*_core` functions, `src/lib/git/api.ts`) is the stable contract between frontend and Rust for Clinically builds.
- GitDesktop's `com.thebguy.gitdesktop` bundle id, updater, and branding must not ship in Clinically Code Control builds.
- Stream (`clinically-au/stream`): `main` is staging, `prod` is production; promotion is via tag + GitHub Release workflow.
- Planned Code Control integrations (post-v0.1): Laravel Forge v2 API for deploy status/logs/commands; AWS CLI for Parameter Store secrets.
- This worktree's `.gitignore` should exclude `.cursor/` and `.pnpm-store/`.
