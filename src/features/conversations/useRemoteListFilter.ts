import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  conversationFilterPrefsKey,
  useConversationFilterPrefs,
  useSaveConversationFilterPrefs,
} from "@/lib/conversation-filters/queries";
import {
  type ConversationFilterPrefs,
  DEFAULT_CONVERSATION_FILTER_PREFS,
} from "@/lib/conversation-filters/store";
import { useMyTeams } from "@/lib/git/queries";
import type { RemoteLens, RemoteListFilter, TeamRef } from "@/lib/git/types";
import type { ConversationFeature } from "./useCollapsedSections";

/** The toolbar's one-click scopes. "needs-review" is the PR panel's only — it adds
 *  the review-state grouping on top of "mine". */
export type ConversationPreset = "all" | "mine" | "needs-review";

/**
 * The whole server-side filter for one conversation panel: the persisted "mine"
 * axes (assigned / review-requested / my teams) plus the session-scoped
 * author/label choices, composed into the {@link RemoteListFilter} the list query
 * takes. An empty filter resolves to `null`, which is the panel's pre-filter
 * behavior exactly — the list query then omits the argument entirely.
 *
 * Two contracts worth stating:
 * - A provider that can't express an axis never contributes it, whatever the
 *   prefs hold, so a stored filter from a GitHub repo can't leak into a Bitbucket
 *   one's query.
 * - Teams enter the filter only once `useMyTeams` has ANSWERED and vouched for
 *   each slug; pending or errored, the axis is omitted entirely, so the mine union
 *   starts as assigned + review-requested and widens when the team legs validate
 *   (see the exclusion below). A resolved-but-unknown slug also keeps its chip,
 *   flagged "no longer your team", so the narrowing is visible rather than silent.
 */
export function useRemoteListFilter(opts: {
  repoPath: string;
  feature: ConversationFeature;
  lens: RemoteLens;
  /** `implemented.listFilterMine` — assigned / review-requested, server-side. */
  canFilterMine: boolean;
  /** `implemented.listFilterTeam` — team review requests (GitHub only). */
  canFilterTeam: boolean;
  /** `implemented.listFilterAuthor` — server-side author filtering. */
  canFilterAuthor: boolean;
  /** Borrowed from `implemented.mrLabels` / `issueLabels`: those say the provider
   *  has labels at all, and one that doesn't can't filter by them either way. */
  canFilterLabel: boolean;
  /** `implemented.reviewGrouping` — the per-PR review timestamps (GitHub only). */
  canGroupByReview: boolean;
}) {
  const {
    repoPath,
    feature,
    lens,
    canFilterMine,
    canFilterTeam,
    canFilterAuthor,
    canFilterLabel,
    canGroupByReview,
  } = opts;
  const isPulls = feature === "pulls";

  const prefsQuery = useConversationFilterPrefs(repoPath);
  const prefs = prefsQuery.data ?? DEFAULT_CONVERSATION_FILTER_PREFS;
  const savePrefs = useSaveConversationFilterPrefs(repoPath);
  const queryClient = useQueryClient();

  // Author/label choices are session-scoped by design (they name page-specific
  // people and labels), unlike the "mine" axes, which persist per repo.
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());

  const assignedToMe =
    canFilterMine &&
    (isPulls ? prefs.pulls.assignedToMe : prefs.issues.assignedToMe);
  const reviewRequestedMe =
    canFilterMine && isPulls && prefs.pulls.reviewRequestedMe;
  const groupByReview =
    canGroupByReview && isPulls && prefs.pulls.groupByReview;
  const chosenTeams = isPulls && canFilterTeam ? prefs.pulls.teams : [];

  const teamsEnabled = isPulls && canFilterTeam;
  const myTeams = useMyTeams(repoPath, lens, teamsEnabled);
  const knownTeams: TeamRef[] | undefined = myTeams.data?.teams;
  const knownSlugs = new Set((knownTeams ?? []).map((t) => t.slug));
  // Only validated slugs may reach the query: an unresolvable
  // `team-review-requested:` qualifier zeroes the ENTIRE parenthesized OR group it
  // sits in, not just its own leg (measured on GitHub's ISSUE_ADVANCED search), so
  // one stale team would empty the whole mine union with nothing on screen to
  // explain it. Undefined data = idle, pending, or failed: all three leave the axis
  // unvouched-for, and a chip must not be flagged stale on a query that hasn't answered.
  const teamsAnswered = knownTeams !== undefined;
  const effectiveTeams = teamsAnswered
    ? chosenTeams.filter((slug) => knownSlugs.has(slug))
    : [];

  // A provider that can't filter by author server-side gets no author terms at
  // all; the popover holds those rows with the reason rather than sending a
  // qualifier the forge would answer arbitrarily.
  const authors = canFilterAuthor ? [...authorFilter] : [];
  // The label axis rides the payload only where the forge can apply it. Elsewhere
  // the pick is honoured CLIENT-side (see useLocalRemoteFilter) rather than dropped,
  // so it still counts as an active choice in the badge below.
  const serverLabels = canFilterLabel ? [...labelFilter] : [];
  const filter = buildFilter({
    assignedToMe,
    reviewRequestedMe,
    teams: effectiveTeams,
    authors,
    labels: serverLabels,
  });

  // The badge counts the user's CHOICES, so the whole team axis reads as one
  // filter however many teams it names; grouping isn't a filter and never counts.
  // The team axis stops counting only once the membership query has ANSWERED and
  // disowned every chosen slug — zeroing it while pending would flicker the badge.
  const teamAxisCounts =
    chosenTeams.length > 0 && (!teamsAnswered || effectiveTeams.length > 0);
  const activeFilterCount =
    (assignedToMe ? 1 : 0) +
    (reviewRequestedMe ? 1 : 0) +
    (teamAxisCounts ? 1 : 0) +
    authors.length +
    labelFilter.size;

  // Local PRs/issues have no forge assignee or reviewer, so any active "mine"
  // axis excludes them — measured against the EFFECTIVE axes, since an all-stale
  // team choice filters nothing and must not hide the local section either.
  const mineActive =
    assignedToMe || reviewRequestedMe || effectiveTeams.length > 0;

  const preset = derivePreset({
    isPulls,
    assignedToMe,
    reviewRequestedMe,
    groupByReview,
    teamCount: chosenTeams.length,
    valueAxisCount: authors.length + labelFilter.size,
  });

  /**
   * Persist a whole prefs object. Patching the cache first is load-bearing: the
   * prefs query never goes stale on its own, so without it a toggle wouldn't show
   * until the disk write round-tripped through the mutation's invalidate.
   * Gated on the query having resolved — writing over a default-while-loading
   * snapshot would erase the stored filter.
   */
  function writePrefs(next: ConversationFilterPrefs) {
    if (!prefsQuery.data) return;
    queryClient.setQueryData(conversationFilterPrefsKey(repoPath), next);
    savePrefs.mutate(next);
  }

  function setPulls(patch: Partial<ConversationFilterPrefs["pulls"]>) {
    writePrefs({ ...prefs, pulls: { ...prefs.pulls, ...patch } });
  }

  function setPreset(next: ConversationPreset) {
    // "All" is the true clear-all: the session author/label picks are server axes
    // too, so leaving them set would light a segment titled "show every …" over a
    // filtered list, with no control left that clears them.
    if (next === "all") {
      setAuthorFilter(new Set());
      setLabelFilter(new Set());
    }
    if (!isPulls) {
      writePrefs({ ...prefs, issues: { assignedToMe: next !== "all" } });
      return;
    }
    if (next === "all") {
      setPulls({
        assignedToMe: false,
        reviewRequestedMe: false,
        teams: [],
        groupByReview: false,
      });
      return;
    }
    // "mine" and "needs-review" leave `teams` alone: the chosen teams ARE the
    // preset's team component, so picking one in the popover keeps the segment lit.
    setPulls({
      assignedToMe: true,
      reviewRequestedMe: true,
      groupByReview: next === "needs-review",
    });
  }

  function setAssignedToMe(on: boolean) {
    if (isPulls) setPulls({ assignedToMe: on });
    else writePrefs({ ...prefs, issues: { assignedToMe: on } });
  }

  function toggleTeam(slug: string, on: boolean) {
    const current = prefs.pulls.teams;
    setPulls({
      teams: on
        ? [...current.filter((s) => s !== slug), slug]
        : current.filter((s) => s !== slug),
    });
  }

  function toggleValue(which: "author" | "label", value: string, on: boolean) {
    const update = which === "author" ? setAuthorFilter : setLabelFilter;
    // Functional update: several toggles fired in one event batch must each build
    // on the previous one — cloning the render-time Set would drop all but the last.
    update((prev) => {
      const next = new Set(prev);
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  /** A chosen team's display name; falls back to the slug's own team part while
   *  the membership query hasn't answered (a chip still has to read as a team). */
  function teamName(slug: string): string {
    const known = (knownTeams ?? []).find((t) => t.slug === slug);
    return known?.name ?? (slug.split("/").pop() || slug);
  }

  return {
    /** What the list queries take. `null` = unfiltered (the legacy path). */
    filter,
    /**
     * The stored filter has been read, so `filter` is final rather than a
     * default-while-loading stand-in. List queries AND this into their `enabled`
     * so a repo with a stored filter fetches ONCE, filtered, instead of flashing
     * an unfiltered page. It cannot wedge closed: the loader catches its own
     * failures and resolves to the defaults, so the query always settles.
     */
    prefsReady: prefsQuery.data !== undefined,
    /** The forge applies the label axis itself. False = the list hook must apply it
     *  to the remote rows, or a label pick would silently do nothing to them. */
    labelsServerSide: canFilterLabel,
    preset,
    setPreset,
    assignedToMe,
    setAssignedToMe,
    reviewRequestedMe,
    setReviewRequestedMe: (on: boolean) => setPulls({ reviewRequestedMe: on }),
    groupByReview,
    setGroupByReview: (on: boolean) => setPulls({ groupByReview: on }),
    /** Slugs the user picked, stale ones included (the chips render them flagged). */
    chosenTeams,
    toggleTeam,
    teamName,
    isStaleTeam: (slug: string) => teamsAnswered && !knownSlugs.has(slug),
    teamOptions: knownTeams ?? [],
    teamsPending: teamsEnabled && myTeams.isPending,
    teamsError: teamsEnabled && myTeams.isError,
    missingTeamScope: myTeams.data?.missingScope === true,
    authorFilter,
    labelFilter,
    toggleValue,
    activeFilterCount,
    mineActive,
  };
}

function buildFilter(axes: {
  assignedToMe: boolean;
  reviewRequestedMe: boolean;
  teams: string[];
  authors: string[];
  labels: string[];
}): RemoteListFilter | null {
  const f: RemoteListFilter = {};
  if (axes.assignedToMe) f.assignedToMe = true;
  if (axes.reviewRequestedMe) f.reviewRequestedMe = true;
  if (axes.teams.length > 0) f.teams = axes.teams;
  if (axes.authors.length > 0) f.authors = axes.authors;
  if (axes.labels.length > 0) f.labels = axes.labels;
  // Absent axes and an empty filter are the same thing to `remoteListFilterKey`;
  // null keeps the query on its pre-filter argument shape.
  return Object.keys(f).length > 0 ? f : null;
}

/** Which toolbar segment (if any) the current scope spells exactly. Hand-picked
 *  axes matching no canned scope light nothing — the popover badge carries the
 *  detail. The team choice is free within "mine"/"needs-review" by construction,
 *  but an author or label pick narrows EVERY scope, so it lights none: a pressed
 *  "All" over a server-filtered list would be a claim the list contradicts. */
function derivePreset(s: {
  isPulls: boolean;
  assignedToMe: boolean;
  reviewRequestedMe: boolean;
  groupByReview: boolean;
  teamCount: number;
  valueAxisCount: number;
}): ConversationPreset | null {
  if (s.valueAxisCount > 0) return null;
  if (!s.isPulls) return s.assignedToMe ? "mine" : "all";
  if (
    !s.assignedToMe &&
    !s.reviewRequestedMe &&
    !s.groupByReview &&
    s.teamCount === 0
  ) {
    return "all";
  }
  if (s.assignedToMe && s.reviewRequestedMe) {
    return s.groupByReview ? "needs-review" : "mine";
  }
  return null;
}
