import { useEffect, useState } from "react";

// Commit-author avatars for the History surfaces.
//
// A commit only carries an author name + email locally (never a forge login), so
// we derive an avatar from the email the way desktop git clients do:
//   • GitHub no-reply emails embed the login (and the host, for Enterprise), so
//     the avatar resolves synchronously at `<host>/<login>.png` — nothing is sent
//     to a third party.
//   • Everyone else falls back to Gravatar, keyed by a SHA-256 of the email.
//     `d=404` makes emails with no Gravatar fail the image load, so the caller's
//     <AvatarFallback> shows the author initial — identical to showing no avatar.
//
// SHA-256 hashing is async (Web Crypto), so a module-level cache resolves each
// distinct email exactly once: the virtualized History list re-renders rows
// constantly, and we never want to re-hash or flash a resolved avatar back out.

// `ID+login@users.noreply.github.com` and the legacy `login@users.noreply.github.com`.
// The host is pinned to github.com (never read from the email) and the login is
// constrained to GitHub's username grammar: a commit author email is untrusted input,
// and with a null CSP an attacker-chosen host would otherwise beacon on mere view.
// (GitHub Enterprise no-reply emails fall through to Gravatar / initials.)
const GH_NOREPLY =
  /^(?:\d+\+)?([a-z\d][a-z\d-]{0,38})@users\.noreply\.github\.com$/i;

// Resolved Gravatar URLs by lowercased email; a present entry means "hashing done".
const gravatarCache = new Map<string, string>();
const gravatarPending = new Map<string, Promise<string>>();

/**
 * The avatar URL for a commit author's email, `""` when there's nothing to show
 * (no email / no crypto), or `null` when the answer needs an async Gravatar hash
 * that hasn't resolved yet — callers show the initial until
 * {@link useCommitAvatarUrl} fills it in.
 */
function commitAvatarUrlSync(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return "";
  const noreply = normalized.match(GH_NOREPLY);
  if (noreply) {
    // Login is grammar-constrained above (URL-path-safe chars); host is literal.
    return `https://github.com/${noreply[1]}.png?size=48`;
  }
  return gravatarCache.get(normalized) ?? null;
}

async function computeGravatarUrl(normalizedEmail: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizedEmail);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://www.gravatar.com/avatar/${hex}?d=404&s=48`;
}

/**
 * The avatar URL for a commit author's email, or `""` while a Gravatar hash is
 * still pending (or when there's no avatar to derive). Safe to call per row in a
 * virtualized list — each distinct email is hashed at most once.
 */
export function useCommitAvatarUrl(email: string): string {
  // Lazy init reads the sync answer (no-reply URL, cached Gravatar, or "") once
  // on mount, so a cache hit paints immediately with no flash. `null` → pending.
  const [url, setUrl] = useState(() => commitAvatarUrlSync(email) ?? "");

  useEffect(() => {
    const sync = commitAvatarUrlSync(email);
    if (sync !== null) {
      setUrl(sync);
      return;
    }
    // Needs a Gravatar hash. Bail to the initial if Web Crypto is unavailable.
    if (!globalThis.crypto?.subtle) {
      setUrl("");
      return;
    }
    const normalized = email.trim().toLowerCase();
    let live = true;
    let pending = gravatarPending.get(normalized);
    if (!pending) {
      pending = computeGravatarUrl(normalized)
        .then((resolved) => {
          gravatarCache.set(normalized, resolved);
          gravatarPending.delete(normalized);
          return resolved;
        })
        .catch(() => {
          // A rejected hash (e.g. crypto.subtle throwing) must clear `pending` too,
          // or the email is stuck "pending" forever and the rejection goes unhandled.
          gravatarPending.delete(normalized);
          return "";
        });
      gravatarPending.set(normalized, pending);
    }
    pending.then((resolved) => {
      if (live) setUrl(resolved);
    });
    return () => {
      live = false;
    };
  }, [email]);

  return url;
}
