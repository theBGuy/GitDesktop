import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/tauri/invoke";
import { COLD_START } from "@/lib/test-mode";
import type {
  BackgroundRepoStatus,
  BbAccountInfo,
  ForgeStatus,
  GhAccounts,
  GhScopes,
  ReconnectEvent,
  SessionHealth,
} from "../types";

/** Provider-neutral hosted-integration status (GitHub, GitLab, Bitbucket) — the gate
 *  hosted panels read for any provider. */
export const forgeStatus = (repoPath: string) =>
  invoke<ForgeStatus>("forge_status", { repoPath });

/** Background PR-sync readiness for many repos in one call, in input order —
 *  GitHub auth for registered hosts is probed once per tick, not once per repo; a
 *  repo on an unmapped host spelling takes a per-repo status probe instead. */
export const forgeBackgroundStatuses = (paths: string[]) =>
  invoke<BackgroundRepoStatus[]>("forge_background_statuses", { paths });

// ── Bitbucket account (Atlassian API token) ──────────────────────────────────
//
// Bitbucket Cloud auth is an Atlassian API token used with the account email (HTTP
// Basic); the token lives in the OS keychain and is never returned. Cold-start test
// mode has no keychain, so `forgeBbAccount` reports "not connected".

/** Validate an Atlassian API token against GET /2.0/user and, on success, save
 *  it to the keychain. Throws (nothing saved) on an invalid token or a network
 *  failure — the message distinguishes the two. */
export const forgeBbSetAccount = (email: string, token: string) =>
  invoke<BbAccountInfo>("forge_bb_set_account", { email, token });

/** Remove the saved Bitbucket token from the keychain. */
export const forgeBbClearAccount = () => invoke<void>("forge_bb_clear_account");

/** The saved Bitbucket account (fast keyring check, no network); null when none. */
export const forgeBbAccount = () =>
  COLD_START
    ? Promise.resolve<BbAccountInfo | null>(null)
    : invoke<BbAccountInfo | null>("forge_bb_account");

// ── Forge session health & reconnect ─────────────────────────────────────────
//
// Probe a session (gh/glab account or the Bitbucket token) and drive an in-app
// reconnect (gh's device flow / glab's `--web`) instead of sending the user to a
// terminal.

/** The health of the forge session backing THIS repo (its provider only). */
export const forgeSessionHealth = (repoPath: string) =>
  invoke<SessionHealth>("forge_session_health", { repoPath });

/** The health of every known forge account (gh accounts + glab hosts). */
export const forgeAccountsHealth = () =>
  invoke<SessionHealth[]>("forge_accounts_health");

/** Drive an in-app reconnect: `mode: "login"` signs in a new session, `"refresh"`
 *  renews an existing one. Streams `ReconnectEvent`s (the verification URL, the
 *  one-time code when the CLI's wording is recognised, progress lines, then a
 *  terminal `finished`) over a Channel; resolves when the flow ends. Cancel a live
 *  flow via {@link forgeReconnectCancel} with the same `sessionId` (generated
 *  frontend-side with `crypto.randomUUID()`). */
export const forgeReconnect = (args: {
  sessionId: string;
  provider: "github" | "gitlab";
  host: string;
  mode: "login" | "refresh";
  /** Extra OAuth scopes (`gh auth refresh -s …`) — GitHub `refresh` only; the
   *  backend rejects them elsewhere rather than dropping them. */
  scopes?: string[];
  onEvent: (event: ReconnectEvent) => void;
}): Promise<void> => {
  const channel = new Channel<ReconnectEvent>();
  channel.onmessage = args.onEvent;
  return invoke<void>("forge_reconnect", {
    sessionId: args.sessionId,
    provider: args.provider,
    host: args.host,
    mode: args.mode,
    scopes: args.scopes ?? null,
    onEvent: channel,
  });
};

/** Cancel an in-flight reconnect flow (kills the CLI subprocess). */
export const forgeReconnectCancel = (sessionId: string) =>
  invoke<void>("forge_reconnect_cancel", { sessionId });

// ── GitLab review-bot token ──────────────────────────────────────────────────
//
// A second GitLab token so batch reviews / bot comments post under a distinct
// identity. The token itself is never returned. Cold-start test mode has no
// keychain, so status reports null.

/** The bot login when a review-bot token is configured; null otherwise. */
export const forgeGitlabReviewTokenStatus = () =>
  COLD_START
    ? Promise.resolve<string | null>(null)
    : invoke<string | null>("forge_gitlab_review_token_status", {});

/** Validate and store a review-bot token; resolves to the bot login. Throws
 *  (nothing stored) when validation fails. */
export const forgeGitlabReviewTokenSet = (token: string) =>
  invoke<string>("forge_gitlab_review_token_set", { token });

/** Clear the stored review-bot token and its login. */
export const forgeGitlabReviewTokenClear = () =>
  invoke<void>("forge_gitlab_review_token_clear", {});

// ── GitHub accounts & token scopes ───────────────────────────────────────────

export const ghAccounts = () => invoke<GhAccounts>("gh_accounts");

export const ghSwitchAccount = (host: string, login: string) =>
  invoke<void>("gh_switch_account", { host, login });

/** The active gh token's OAuth scopes (for "needs gh auth refresh -s …" hints). */
export const ghTokenScopes = (host?: string) =>
  invoke<GhScopes>("gh_token_scopes", { host: host ?? null });
