import { load, type Store } from "@tauri-apps/plugin-store";
import { repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

// The per-repo filter choices for the Pull Requests + Issues panels, persisted in
// app data (never committed). Keyed by the repo's worktree-stable identity
// (git-common-dir), like the other per-repo personal stores, so a saved filter is
// shared across a repo's main checkout and every worktree.
//
// This is a NEW store file, so there are no legacy checkout-path-keyed entries to
// fold — a plain identity-key read/write suffices (no identityKeyFor).

/** What a repo's PR/issue panels filter by, as persisted. `teams` holds
 *  org-qualified slugs ("org/slug"); `groupByReview` is the PR list's review-state
 *  grouping toggle. */
export interface ConversationFilterPrefs {
  pulls: {
    assignedToMe: boolean;
    reviewRequestedMe: boolean;
    teams: string[];
    groupByReview: boolean;
  };
  issues: { assignedToMe: boolean };
}

export const DEFAULT_CONVERSATION_FILTER_PREFS: ConversationFilterPrefs = {
  pulls: {
    assignedToMe: false,
    reviewRequestedMe: false,
    teams: [],
    groupByReview: false,
  },
  issues: { assignedToMe: false },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Strings only — a hand-edited array of anything else keeps its usable entries
 *  instead of poisoning the team axis. */
function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Coerce a loosely-typed (older, partial, or hand-edited) value into full prefs,
 * FIELD BY FIELD: every field that isn't the expected type falls back to its
 * default rather than discarding the rest. All-or-nothing parsing here would blank
 * a repo's saved filters on one bad key, so each axis defends itself.
 */
export function normalizeConversationFilterPrefs(
  saved: unknown,
): ConversationFilterPrefs {
  const obj = isRecord(saved) ? saved : {};
  const pulls = isRecord(obj.pulls) ? obj.pulls : {};
  const issues = isRecord(obj.issues) ? obj.issues : {};
  return {
    pulls: {
      assignedToMe: pulls.assignedToMe === true,
      reviewRequestedMe: pulls.reviewRequestedMe === true,
      teams: strings(pulls.teams),
      groupByReview: pulls.groupByReview === true,
    },
    issues: { assignedToMe: issues.assignedToMe === true },
  };
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("conversation-filters.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

/** Read a repo's persisted filter prefs. Never throws: an unreadable store reads as
 *  the defaults (an unfiltered panel), since a failed preference read must not keep
 *  the list from rendering. */
export async function loadConversationFilterPrefs(
  repo: string,
): Promise<ConversationFilterPrefs> {
  try {
    const store = await getStore();
    const id = await repoIdentity(repo);
    return normalizeConversationFilterPrefs(await store.get(id));
  } catch {
    return normalizeConversationFilterPrefs(undefined);
  }
}

export async function saveConversationFilterPrefs(
  repo: string,
  prefs: ConversationFilterPrefs,
): Promise<void> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  await store.set(id, prefs);
}
