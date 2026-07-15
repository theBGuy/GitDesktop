import { useEffect, useState } from "react";
import type { CommitAuthorAvatar } from "./api";
import { ghBotAvatar } from "./api";

// Commit-author avatars for the History surfaces.
//
// A commit only carries an author name + email locally (never a forge login), so
// we derive an avatar from the email the way desktop git clients do:
//   • GitHub no-reply emails embed the login (and the host, for Enterprise), so
//     the avatar resolves synchronously at `<host>/<login>.png` — nothing is sent
//     to a third party.
//   • GitHub BOT no-reply emails (`ID+dependabot[bot]@users.noreply.github.com`)
//     carry brackets that GH_NOREPLY excludes by design, and bots have no
//     `<host>/<login>.png` — so they resolve through the `gh_bot_avatar` command
//     (async, github.com only), cached like Gravatar below.
//   • Everyone else falls back to Gravatar, keyed by a SHA-256 of the email.
//     `d=404` makes emails with no Gravatar fail the image load, so the caller's
//     <AvatarFallback> shows the author initial — identical to showing no avatar.
//
// SHA-256 hashing and the bot lookup are async, so a module-level cache resolves
// each distinct email exactly once: the virtualized History list re-renders rows
// constantly, and we never want to re-hash or flash a resolved avatar back out.

// `ID+login@users.noreply.github.com` and the legacy `login@users.noreply.github.com`.
// The host is pinned to github.com (never read from the email) and the login is
// constrained to GitHub's username grammar: a commit author email is untrusted input,
// and with a null CSP an attacker-chosen host would otherwise beacon on mere view.
// (GitHub Enterprise no-reply emails fall through to Gravatar / initials.)
const GH_NOREPLY =
  /^(?:\d+\+)?([a-z\d][a-z\d-]{0,38})@users\.noreply\.github\.com$/i;

// GitHub BOT no-reply emails: `ID+dependabot[bot]@users.noreply.github.com` (the
// `[bot]` suffix is what GH_NOREPLY deliberately excludes). Captures the bare bot
// name, grammar-constrained to GitHub's username charset — that name is the only
// untrusted part and feeds `gh_bot_avatar`, which re-validates it and validates
// the returned URL's host Rust-side before it can reach an <img src>.
const GH_BOT_NOREPLY =
  /^(?:\d+\+)?([a-z\d][a-z\d-]{0,38})\[bot\]@users\.noreply\.github\.com$/i;

// Resolved Gravatar URLs by lowercased email; a present entry means "hashing done".
const gravatarCache = new Map<string, string>();
const gravatarPending = new Map<string, Promise<string>>();

// Resolved bot-avatar URLs by bare bot name; a present entry means "lookup done"
// (the value may be "" — an unresolvable bot, cached so we never re-fetch it).
const botAvatarCache = new Map<string, string>();
const botAvatarPending = new Map<string, Promise<string>>();

// The fourth tier: commit-author `email → avatar_url` resolved in a batch from
// the GitHub commits API (see `useCommitAuthorAvatarIndex`), for human authors
// whose email is neither a GitHub no-reply nor has a Gravatar. Keyed by
// lowercased email. Unlike the caches above (populated on demand, one email at a
// time), this arrives asynchronously per repo AFTER rows have already painted, so
// a listener set lets mounted rows re-resolve when it lands — the index wins over
// an already-resolved Gravatar, since a real GitHub avatar beats an identicon.
const authorIndexCache = new Map<string, string>();
const authorIndexListeners = new Set<() => void>();

function subscribeAuthorIndex(listener: () => void): () => void {
  authorIndexListeners.add(listener);
  return () => {
    authorIndexListeners.delete(listener);
  };
}

/** Merge a batch of commit-author `email → avatarUrl` pairs into the module index
 *  and notify mounted rows so any showing initials (or a Gravatar) upgrade to the
 *  real avatar. Idempotent; safe to call repeatedly as the query refetches. */
export function primeCommitAuthorIndex(entries: CommitAuthorAvatar[]): void {
  let changed = false;
  for (const { email, avatarUrl } of entries) {
    const key = email.trim().toLowerCase();
    if (!key || !avatarUrl) continue;
    if (authorIndexCache.get(key) !== avatarUrl) {
      authorIndexCache.set(key, avatarUrl);
      changed = true;
    }
  }
  if (changed) {
    for (const listener of authorIndexListeners) listener();
  }
}

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
  // A bot no-reply email — resolve through `gh_bot_avatar`. A cached entry
  // (possibly "") returns immediately; otherwise `null` defers to the async hook.
  const bot = normalized.match(GH_BOT_NOREPLY);
  if (bot) {
    return botAvatarCache.get(bot[1]) ?? null;
  }
  // Fourth tier, ahead of Gravatar: a batch-resolved GitHub avatar for this
  // email (a real avatar beats a Gravatar identicon). A miss falls through — the
  // index is partial by design, so most emails still resolve via Gravatar/initials.
  const indexed = authorIndexCache.get(normalized);
  if (indexed) return indexed;
  return gravatarCache.get(normalized) ?? null;
}

/** Resolve a bot's avatar URL through the command exactly once per bot name,
 *  caching the result (including "") so a virtualized re-render never re-fetches.
 *  Mirrors the Gravatar pending/rejection discipline: a rejected lookup clears
 *  `pending` and resolves to "" so the email doesn't stick pending forever. */
function resolveBotAvatar(botName: string): Promise<string> {
  let pending = botAvatarPending.get(botName);
  if (!pending) {
    pending = ghBotAvatar(botName)
      .then((resolved) => {
        botAvatarCache.set(botName, resolved);
        botAvatarPending.delete(botName);
        return resolved;
      })
      .catch(() => {
        botAvatarPending.delete(botName);
        return "";
      });
    botAvatarPending.set(botName, pending);
  }
  return pending;
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

  // The author-index tier arrives asynchronously per repo, often AFTER this row
  // has already resolved to a Gravatar or initials. Subscribe so that when the
  // index lands with an entry for this email, we upgrade to the real avatar (the
  // index wins over an already-resolved Gravatar). No-op for emails never in the
  // index — the notify just re-checks the map and finds nothing.
  useEffect(() => {
    const normalized = email.trim().toLowerCase();
    return subscribeAuthorIndex(() => {
      const indexed = authorIndexCache.get(normalized);
      if (indexed) setUrl(indexed);
    });
  }, [email]);

  useEffect(() => {
    const sync = commitAvatarUrlSync(email);
    if (sync !== null) {
      setUrl(sync);
      return;
    }
    const normalized = email.trim().toLowerCase();
    let live = true;
    // A bot no-reply email whose lookup hasn't resolved — resolve it once via the
    // command, then paint the resolved URL (or "" → initials) if still mounted.
    const bot = normalized.match(GH_BOT_NOREPLY);
    if (bot) {
      resolveBotAvatar(bot[1]).then((resolved) => {
        if (live) setUrl(resolved);
      });
      return () => {
        live = false;
      };
    }
    // Needs a Gravatar hash. Bail to the initial if Web Crypto is unavailable.
    if (!globalThis.crypto?.subtle) {
      setUrl("");
      return;
    }
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
