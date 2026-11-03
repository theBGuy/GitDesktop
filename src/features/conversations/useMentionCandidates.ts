import { useCallback, useState } from "react";
import type { MarkdownRefs } from "@/components/markdown/markdown-refs";
import { useForgeGhHost } from "@/lib/git/host";
import { type MentionTrigger, TRIGGERS } from "@/lib/git/mention-triggers";
import {
  useAssignableUsers,
  useForgeStatus,
  useIssueList,
  usePrList,
} from "@/lib/git/queries";
import type {
  ForgeProvider,
  ForgeUserRef,
  IssueInfo,
  PrInfo,
  RemoteLens,
} from "@/lib/git/types";
import { PR_NOUN, type PrNoun } from "@/lib/pulls/pr-state";
import {
  MAX_ROWS,
  type RefRow,
  rankRefs,
  refInputRows,
  textRank,
} from "./mention-ref-rank";

export type { MentionTrigger };

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
  /** Present on ref rows — drives the mono number, the state glyph and the
   *  state word, open or closed alike. */
  refGlyph?: {
    numberLabel: string;
    state: string;
    isPr: boolean;
    isDraft: boolean;
  };
}

export interface MentionSource {
  triggers: readonly MentionTrigger[];
  /** GitHub host for login-derived avatars; `null` off GitHub. */
  ghHost: string | null;
  /** The forge's word for a pull request, spoken in each PR row's state word. */
  prNoun: PrNoun;
  /** The same forge context, shaped for the markdown renderer so a body can
   *  linkify the references this source helps write. Undefined while forge status
   *  is unresolved or there's no hosted remote; present signed out, where links
   *  still work but the triggers stay inert. */
  refs?: MarkdownRefs;
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

/** No provider resolved yet: the source is inert (no triggers, no queries). */
const NO_TRIGGERS: readonly MentionTrigger[] = [];

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

function refCandidates(
  rows: RefRow[],
  query: string,
  numberLabel: (row: RefRow) => string,
): MentionCandidate[] {
  return rankRefs(rows, query).map((row) => ({
    key: `${row.isPr ? "pr" : "issue"}:${row.number}`,
    insert: String(row.number),
    label: row.title,
    refGlyph: {
      numberLabel: numberLabel(row),
      state: row.state,
      isPr: row.isPr,
      isDraft: row.isDraft,
    },
  }));
}

// Rows keep the state they report, whichever read returned them: a read's
// membership can lag a close or merge, and ranking reads each row's own state.
const issueRows = (list: IssueInfo[] | undefined): RefRow[] =>
  (list ?? []).map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    isPr: false,
    isDraft: false,
    sortAt: i.updatedAt,
  }));

const prRows = (list: PrInfo[] | undefined): RefRow[] =>
  // `PrInfo` carries no `updatedAt`, so PR rows order by their open date.
  (list ?? []).map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    isPr: true,
    isDraft: p.isDraft,
    sortAt: p.createdAt,
  }));

/**
 * The per-surface data behind the comment composers' `@`/`#`/`!` autocomplete:
 * which triggers this forge autolinks, and a pure filter over the cached
 * candidates each one offers, open and closed refs alike. Strictly lazy — the
 * five underlying queries (users, plus open and closed issues and PRs) stay
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
  // Signed out, the status still names a github.com repo: its references keep
  // linkifying, but the candidate lists need the forge, so no trigger opens.
  const signedIn = Boolean(useForgeStatus(repoPath).data?.authenticated);
  const triggers = provider && signedIn ? TRIGGERS[provider] : NO_TRIGGERS;
  const wantsUsers = active && triggers.includes("@");
  const wantsIssues = active && triggers.includes("#");
  // GitHub's `#` covers PRs too; GitLab reaches merge requests through `!` instead.
  const wantsPrs =
    active && (provider === "github" ? wantsIssues : triggers.includes("!"));

  const users = useAssignableUsers(repoPath, wantsUsers, lens);
  const issues = useIssueList(repoPath, wantsIssues, "open", 50, lens);
  const closedIssues = useIssueList(repoPath, wantsIssues, "closed", 50, lens);
  const prs = usePrList(repoPath, wantsPrs, "open", 50, lens);
  const closedPrs = usePrList(repoPath, wantsPrs, "closed", 50, lens);
  const ghHost = useForgeGhHost(repoPath);

  const onActive = useCallback(() => setActive(true), []);

  // The data/loading/error triples below are the only query state `query`
  // closes over — never the query result objects, which re-identify every
  // render and would churn this source's identity downstream. A placeholder
  // page (another state's or limit's rows) reads as still loading, not as this
  // key's answer, which it would mis-rank and could double against its twin.
  const issueData = issues.isPlaceholderData ? undefined : issues.data;
  const closedIssueData = closedIssues.isPlaceholderData
    ? undefined
    : closedIssues.data;
  const prData = prs.isPlaceholderData ? undefined : prs.data;
  const closedPrData = closedPrs.isPlaceholderData ? undefined : closedPrs.data;
  const issuesLoading =
    issues.isLoading ||
    issues.isPlaceholderData ||
    closedIssues.isLoading ||
    closedIssues.isPlaceholderData;
  const prsLoading =
    prs.isLoading ||
    prs.isPlaceholderData ||
    closedPrs.isLoading ||
    closedPrs.isPlaceholderData;
  const issuesError = issues.isError || closedIssues.isError;
  const prsError = prs.isError || closedPrs.isError;
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
    // A number both reads returned keeps the open read's row whenever it
    // matches. Built only by the arms that show PRs: GitLab's `#` never does.
    const allPrRows = () => refInputRows(prRows(prData), prRows(closedPrData));
    if (trigger === "!") {
      return {
        items: refCandidates(allPrRows(), text, (r) => `!${r.number}`),
        loading: prsLoading,
        isError: prsError,
      };
    }
    const allIssueRows = refInputRows(
      issueRows(issueData),
      issueRows(closedIssueData),
    );
    // `#`: GitHub merges issue and PR rows into its shared number space;
    // GitLab's `#` addresses issues alone.
    const rows =
      provider === "github" ? [...allIssueRows, ...allPrRows()] : allIssueRows;
    return {
      items: refCandidates(rows, text, (r) => `#${r.number}`),
      loading: issuesLoading || (provider === "github" && prsLoading),
      isError: issuesError || (provider === "github" && prsError),
    };
  };

  return {
    triggers,
    ghHost,
    prNoun: provider ? PR_NOUN[provider] : "pull request",
    refs: provider ? { provider, repoPath, lens } : undefined,
    onActive,
    query,
  };
}
