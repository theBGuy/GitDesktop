/**
 * Cold-start test mode — a faithful "brand-new user" simulation for walking the
 * onboarding flow without touching real data.
 *
 * Enabled by Vite env flags set by `scripts/cold-start.ps1`. Inert (every flag
 * false) in normal `pnpm tauri dev` and in production builds, where the
 * `VITE_COLD_START*` vars are undefined.
 *
 * When active it isolates every piece of personal state to a throwaway
 * namespace, so the real install is never read or written:
 *   - Tauri stores (settings, local PRs, branch rules, automations) →
 *     separate `coldstart-*.json` files in the same app-data dir. Parallel
 *     instances launched by `scripts/cold-start-instance.ps1` carry a
 *     `GD_INSTANCE_ID`, which reaches the webview as `window.__GD_INSTANCE_ID__`
 *     and namespaces those files further, to `coldstart-<id>-*.json`.
 *   - API keys → an isolated `sessionStorage` store instead of the OS keychain
 *     (the Rust keychain commands reject unknown provider ids anyway), so real
 *     keys are never read and test keys vanish when the window closes.
 *   - Automations don't run at all unless `VITE_COLD_START_AUTOMATIONS` opts them
 *     in, since the claims they take are shared with the real instance.
 *   - Optionally forces git / gh "missing" so the GitMissingScreen and
 *     gh-not-connected states can be exercised without uninstalling anything.
 */

// import.meta.env only types the built-in keys; read our custom flags loosely.
const env = import.meta.env as Record<string, string | undefined>;

export const COLD_START = env.VITE_COLD_START === "1";
export const COLD_START_NO_GIT =
  COLD_START && env.VITE_COLD_START_NO_GIT === "1";
export const COLD_START_NO_GH = COLD_START && env.VITE_COLD_START_NO_GH === "1";
// Polarity is deliberately inverted vs the NO_* flags above: automations are OFF
// by default under cold start and VITE_COLD_START_AUTOMATIONS opts them BACK IN,
// because a cold instance shares the automation-claims dir with the real one and
// could steal its claims. Only the composed gate is exported: the bare opt-in flag
// is false in production too, where negating it would silence every real user's
// automations.
export const COLD_START_AUTOMATIONS_OFF =
  COLD_START && env.VITE_COLD_START_AUTOMATIONS !== "1";

// Per-instance namespace for parallel cold instances, set by
// `scripts/cold-start-instance.ps1` → GD_INSTANCE_ID → a Tauri initialization
// script (src-tauri/src/instance_id.rs). That script runs before any page script,
// so the global is readable here at module scope, before any store is named.
const rawInstanceId = COLD_START
  ? (window as { __GD_INSTANCE_ID__?: unknown }).__GD_INSTANCE_ID__
  : undefined;
// Re-checked against the Rust validator's charset because the id is interpolated
// into store FILENAMES. A stale binary — the old exe still running while the Rust
// watcher rebuilds — simply never set the global, which reads as "no id".
const coldInstanceId =
  typeof rawInstanceId === "string" && /^[a-z0-9-]{1,32}$/.test(rawInstanceId)
    ? rawInstanceId
    : null;

/** This instance's cold-start id, or null when it has none (a lone cold instance,
 *  or a stale binary that never set the global). Surfaced in the cold-start badge
 *  so parallel windows are tellable apart on screen. */
export const COLD_INSTANCE_ID = coldInstanceId;

/** Tauri store filename, redirected to a throwaway file under cold start. An
 *  instance id namespaces it further (`coldstart-<id>-<name>`); without one the
 *  name stays EXACTLY `coldstart-<name>`, so a lone cold instance keeps reading
 *  the store files it wrote before ids existed. */
export function storeName(name: string): string {
  if (!COLD_START) return name;
  return `coldstart-${coldInstanceId ? `${coldInstanceId}-` : ""}${name}`;
}

// Cold-start API keys live in sessionStorage, never the OS keychain — fresh
// each launch, isolated from the user's real provider keys.
const COLD_SECRET_PREFIX = "coldstart-secret:";

export function coldStartGetSecret(provider: string): string | null {
  return sessionStorage.getItem(COLD_SECRET_PREFIX + provider);
}

export function coldStartSetSecret(provider: string, value: string): void {
  sessionStorage.setItem(COLD_SECRET_PREFIX + provider, value);
}

export function coldStartDeleteSecret(provider: string): void {
  sessionStorage.removeItem(COLD_SECRET_PREFIX + provider);
}
