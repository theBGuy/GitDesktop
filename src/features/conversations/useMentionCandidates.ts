import { useCallback, useState } from "react";
import { useForgeGhHost } from "@/lib/git/host";
import { useAssignableUsers, useIssueList, usePrList } from "@/lib/git/queries";
import type {
  ForgeProvider,
  ForgeUserRef,
  IssueInfo,
  PrInfo,
  RemoteLens,
} from "@/lib/git/types";

/** A character that opens the suggestion popover when typed at a word boundary. */
export type MentionTrigger = "@" | "#" | "!";

export interface MentionCandidate {
  /** Stable React key, unique per row. */
  key: string;
  /** Spliced into the body AFTER the trigger char (login, number, or Bitbucket "{accountId}"). */
  insert: string;
  /** Primary row text (display name, or the title for refs). */
  label: string;
  /** Muted secondary (login for users; nothing for refs). */
  detail?: string;
  /** Present on user rows — drives ForgeUserAvatar. */
  user?: ForgeUserRef;
  /** Present on ref rows — drives the mono number and the state glyph. */
  refGlyph?: { numberLabel: string; state: string; isPr: boolean };
}

export interface MentionSource {
  triggers: readonly MentionTrigger[];
  /** GitHub host for login-derived avatars; `null` off GitHub. */
  ghHost: string | null;
  /** First time a trigger token opens — flips the lazy queries on. Idempotent. */
  onActive: () => void;
  /** Pure filter over cached data; called during render. `isError` reports that a
   *  backing list failed, which an empty result would otherwise present as a
   *  confident "nothing matches". */
  query: (
    trigger: MentionTrigger,
    query: string,
  ) => { items: MentionCandidate[]; loading: boolean; isError: boolean };
}

/**
 * Which triggers each forge autolinks in a comment body. GitHub resolves `#N` from a
 * single number space covering issues AND PRs; GitLab numbers them separately (`#`
 * issues, `!` merge requests). Bitbucket autolinks neither a bare `#N` nor a plain
 * `@nickname` written through its API — its mentions need `@{accountId}`, which
 * `forge_assignable_users` has no Bitbucket arm to supply, so it offers none.
 */
const TRIGGERS: Record<ForgeProvider, readonly MentionTrigger[]> = {
  github: ["@", "#"],
  gitlab: ["@", "#", "!"],
  bitbucket: [],
};

/** No provider resolved yet: the source is inert (no triggers, no queries). */
const NO_TRIGGERS: readonly MentionTrigger[] = [];

/** How many rows the popover shows, applied after ranking. */
const MAX_ROWS = 8;

const NUMERIC = /^\d+$/;

/** A ref candidate before it becomes a row — the two lists share one ordering. */
interface RefRow {
  number: number;
  title: string;
  state: string;
  isPr: boolean;
  /** The freshest timestamp the source carries, for the recency ordering. */
  sortAt: string;
}

/** Prefix matches outrank substring matches; -1 drops the row. `needle` must
 *  already be lower-cased. */
function textRank(haystack: string, needle: string): 0 | 1 | -1 {
  if (!needle) return 0;
  const i = haystack.toLowerCase().indexOf(needle);
  if (i === 0) return 0;
  return i > 0 ? 1 : -1;
}

function rankUsers(
  users: ForgeUserRef[],
  query: string,
  provider: ForgeProvider,
): MentionCandidate[] {
  const needle = query.toLowerCase();
  const scored: { user: ForgeUserRef; rank: number; order: number }[] = [];
  for (const [order, user] of users.entries()) {
    // Ranking both fields covers a provider whose display name differs from the
    // handle; the wired ones set them equal, so today the two ranks agree.
    const ranks = [
      textRank(user.label, needle),
      textRank(user.id, needle),
    ].filter((r) => r !== -1);
    if (ranks.length > 0) {
      scored.push({ user, rank: Math.min(...ranks), order });
    }
  }
  // Provider order is the tiebreak: the forge already returns its own relevance.
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return scored.slice(0, MAX_ROWS).map(({ user }) => ({
    key: `user:${user.id}`,
    // Bitbucket resolves a mention by account id wrapped in braces; every other
    // provider takes the handle verbatim.
    insert: provider === "bitbucket" ? `{${user.id}}` : user.id,
    label: user.label || user.id,
    // Bitbucket's id is an opaque account uuid, so it stays out of the row.
    detail:
      provider !== "bitbucket" && user.id !== user.label ? user.id : undefined,
    user,
  }));
}

function rankRefs(
  rows: RefRow[],
  query: string,
  numberLabel: (row: RefRow) => string,
): MentionCandidate[] {
  const numeric = NUMERIC.test(query);
  const needle = query.toLowerCase();
  const scored: { row: RefRow; rank: number }[] = [];
  for (const row of rows) {
    if (numeric) {
      if (String(row.number).startsWith(query)) scored.push({ row, rank: 0 });
      continue;
    }
    const rank = textRank(row.title, needle);
    if (rank !== -1) scored.push({ row, rank });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Equal timestamps must compare equal, not -1 both ways: an inconsistent
    // comparator lets the sort permute rows that should hold their input order.
    if (a.row.sortAt === b.row.sortAt) return 0;
    return a.row.sortAt < b.row.sortAt ? 1 : -1;
  });
  return scored.slice(0, MAX_ROWS).map(({ row }) => ({
    key: `${row.isPr ? "pr" : "issue"}:${row.number}`,
    insert: String(row.number),
    label: row.title,
    refGlyph: {
      numberLabel: numberLabel(row),
      state: row.state,
      isPr: row.isPr,
    },
  }));
}

const issueRows = (list: IssueInfo[] | undefined): RefRow[] =>
  (list ?? []).map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    isPr: false,
    sortAt: i.updatedAt,
  }));

const prRows = (list: PrInfo[] | undefined): RefRow[] =>
  // `PrInfo` carries no `updatedAt`, so PR rows order by their open date.
  (list ?? []).map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    isPr: true,
    sortAt: p.createdAt,
  }));

/**
 * The per-surface data behind the comment composers' `@`/`#`/`!` autocomplete:
 * which triggers this forge autolinks, and a pure filter over the cached
 * candidates each one offers. Strictly lazy — the three underlying queries stay
 * disabled until the first trigger token opens, so mounting a PR view costs
 * nothing until someone actually types one.
 */
export function useMentionCandidates({
  repoPath,
  lens,
  provider,
}: {
  repoPath: string;
  lens: RemoteLens;
  /** Absent until forge status resolves, and null on a repo with no hosted remote —
   *  the source stays inert (no triggers, no queries) in both cases. */
  provider: ForgeProvider | null | undefined;
}): MentionSource {
  const [active, setActive] = useState(false);
  const triggers = provider ? TRIGGERS[provider] : NO_TRIGGERS;
  const wantsUsers = active && triggers.includes("@");
  const wantsIssues = active && triggers.includes("#");
  // GitHub's `#` covers PRs too; GitLab reaches merge requests through `!` instead.
  const wantsPrs =
    active && (provider === "github" ? wantsIssues : triggers.includes("!"));

  const users = useAssignableUsers(repoPath, wantsUsers, lens);
  const issues = useIssueList(repoPath, wantsIssues, "open", 50, lens);
  const prs = usePrList(repoPath, wantsPrs, "open", 50, lens);
  const ghHost = useForgeGhHost(repoPath);

  const onActive = useCallback(() => setActive(true), []);

  // The data/loading/error triples below are the whole of what `query` closes
  // over — never the query result objects, which re-identify every render and
  // would churn this source's identity downstream. Both list queries also leave
  // state and limit free in their placeholder comparators, so a panel's closed-tab
  // rows can be served here until this key's own fetch lands: placeholder rows
  // read as "still loading" rather than suggesting a closed issue the completion
  // promised would be open.
  const issueData = issues.isPlaceholderData ? undefined : issues.data;
  const prData = prs.isPlaceholderData ? undefined : prs.data;
  const issuesLoading = issues.isLoading || issues.isPlaceholderData;
  const prsLoading = prs.isLoading || prs.isPlaceholderData;
  const issuesError = issues.isError;
  const prsError = prs.isError;
  const userData = users.data;
  const usersLoading = users.isLoading;
  const usersError = users.isError;

  const query = (trigger: MentionTrigger, text: string) => {
    if (!provider) return { items: [], loading: false, isError: false };
    if (trigger === "@") {
      return {
        items: rankUsers(userData ?? [], text, provider),
        loading: usersLoading,
        isError: usersError,
      };
    }
    if (trigger === "!") {
      return {
        items: rankRefs(prRows(prData), text, (r) => `!${r.number}`),
        loading: prsLoading,
        isError: prsError,
      };
    }
    // `#`: GitHub merges both lists into its shared number space; GitLab's `#`
    // addresses issues alone.
    const rows =
      provider === "github"
        ? [...issueRows(issueData), ...prRows(prData)]
        : issueRows(issueData);
    return {
      items: rankRefs(rows, text, (r) => `#${r.number}`),
      loading: issuesLoading || (provider === "github" && prsLoading),
      isError: issuesError || (provider === "github" && prsError),
    };
  };

  return { triggers, ghHost, onActive, query };
}
