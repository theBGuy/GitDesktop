import { invoke } from "@/lib/tauri/invoke";

/** The real avatar URL for a GitHub bot account (dependabot, renovate, …), or
 *  `""` when it can't be resolved — bot logins have no `<host>/<login>.png`. */
export const ghBotAvatar = (login: string) =>
  invoke<string>("gh_bot_avatar", { login });

/** One commit-author `email → avatar_url` pairing from the commits API. */
export interface CommitAuthorAvatar {
  email: string;
  avatarUrl: string;
}

/** Batch-resolves commit-author `email → GitHub avatar URL` for one recent-commits page.
 *  GitHub-only, deliberately partial (one page), and never errors — empty repo / offline
 *  / non-GitHub resolves to `[]` so callers keep initials. */
export const ghCommitAuthorAvatars = (repoPath: string) =>
  invoke<CommitAuthorAvatar[]>("gh_commit_author_avatars", { repoPath });
