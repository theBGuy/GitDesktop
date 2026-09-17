import type { ForgeProvider } from "./forge";

export interface GhAccount {
  /** The host this account is signed in to ("github.com" or an Enterprise
   *  server). Accounts are grouped by host and switched per host. */
  host: string;
  login: string;
  active: boolean;
}

export interface GhAccounts {
  /** gh's version (e.g. "2.18.1"), "" when gh isn't installed. */
  version: string;
  accounts: GhAccount[];
}

/** The health of a forge sign-in session (gh/glab account, or a Bitbucket token).
 *  `"offline"` means the probe was inconclusive (a network blip) — treated as
 *  "unchanged": it must never flip any UI, so nothing regresses on a bad network. */
export type SessionState =
  | "healthy"
  | "broken"
  | "notConnected"
  | "cliMissing"
  | "offline";

/** One forge session's health, provider-neutral. Populated by `forge_session_health`
 *  (this repo's session) and `forge_accounts_health` (every known account). */
export interface SessionHealth {
  provider: ForgeProvider;
  host: string;
  state: SessionState;
  login: string | null;
  /** gh accounts only — whether this is the active account on its host. */
  active: boolean | null;
  /** A short human reason for a `broken`/`offline` state (a tooltip). */
  detail: string | null;
  method: "oauth" | "pat" | "token" | null;
  /** ISO-8601 expiry when knowable (GitLab/GitHub PAT, user-entered Bitbucket
   *  date); null otherwise (e.g. an OAuth session that renews itself). */
  expiresAt: string | null;
  /** Whole days until `expiresAt` (may be negative/0); null when not knowable. */
  daysLeft: number | null;
}

/** A streaming event from a `forge_reconnect` flow, delivered over a Channel.
 *  `code` is gh's device-flow one-time code + URL; `line` is a glab progress
 *  line; `finished` is the terminal result. */
export type ReconnectEvent =
  | { type: "code"; code: string; url: string }
  | { type: "line"; text: string }
  | {
      type: "finished";
      ok: boolean;
      login: string | null;
      message: string | null;
    };

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  /** The active account's login on this repo's host, when it can be determined. */
  login: string | null;
  /** "owner/name" when this repo has a GitHub remote gh recognizes. */
  repo: string | null;
  /** The repo's GitHub host — "github.com" or an Enterprise server like
   *  "github.acme.com" — when it's a recognized GitHub repo. */
  host: string | null;
}

/** A signed-in Bitbucket Cloud account (validated against GET /2.0/user before
 *  the token is saved). The token itself is never returned by anything. */
export interface BbAccountInfo {
  /** The Atlassian account email — the HTTP Basic username for API-token auth. */
  email: string;
  username: string | null;
  displayName: string | null;
}

/** The active gh token's OAuth scopes. `classic: false` = a fine-grained PAT /
 *  App token (no readable scopes — don't treat "missing scope" as a problem). */
export interface GhScopes {
  scopes: string[];
  classic: boolean;
}
