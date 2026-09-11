import { useState } from "react";
import {
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

/** A provider's ceiling on how many values ONE filter axis may carry, with the
 *  copy that explains it to the user. */
export interface AxisCap {
  max: number;
  reason: string;
}

/**
 * GitLab has no server-side boolean OR, so the backend fans a filter out into one
 * request per value and refuses more than six in the group it sends
 * (`MAX_FILTER_MEMBERS`, forge/gitlab.rs). Only the FIRST non-empty group becomes
 * that fan-out — mine, else authors, else labels — so capping each axis at six is
 * a superset of the server rule and holds whichever group wins.
 *
 * Keyed off the provider identity rather than a `ForgeImplemented` flag: this is
 * one provider's numeric server constant, not a capability axis, and the Rust
 * guard remains the backstop if the two ever drift.
 */
export function gitlabAxisCap(providerName: string): AxisCap {
  const max = 6;
  return {
    max,
    reason: `${providerName} filters take up to ${max} values per axis`,
  };
}

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
 *   each slug; pending, errored, or short the token scope that reads membership,
 *   the axis is omitted entirely, so the mine union starts as assigned +
 *   review-requested and widens when the team legs validate (see the exclusion
 *   below). A resolved-but-unknown slug also keeps its chip,
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
  /** This panel's tab is the one on screen. Gates the only NETWORK read this hook
   *  owns; the prefs read stays ungated, being local. */
  tabActive: boolean;
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
    tabActive,
  } = opts;
  const isPulls = feature === "pulls";

  const prefsQuery = useConversationFilterPrefs(repoPath);
  const prefs = prefsQuery.data ?? DEFAULT_CONVERSATION_FILTER_PREFS;
  const savePrefs = useSaveConversationFilterPrefs(repoPath);

  // Author/label choices are deliberately not persisted — they name people and
  // labels this page happened to load — and their session ENDS AT A REPO SWITCH:
  // they're server constraints now, and one repo's logins mean nothing in the next.
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());

  // Reset DURING RENDER (React's adjust-state-on-prop-change pattern), not in an
  // effect: the panels take a new `repoPath` without remounting, and an effect runs
  // only after a render has COMMITTED — by which point the list query for the new
  // repo has already been created under the old repo's authors and subscribed.
  // `scopeReady` doesn't cover the window either: on a repo the user has already
  // visited, both the identity and the prefs entry are cached (staleTime Infinity),
  // so the gate is open on the very first render after the switch. Setting state
  // here makes React discard this pass and re-run before children or effects see it.
  const [seenRepo, setSeenRepo] = useState(repoPath);
  if (seenRepo !== repoPath) {
    setSeenRepo(repoPath);
    setAuthorFilter(new Set());
    setLabelFilter(new Set());
  }

  const assignedToMe =
    canFilterMine &&
    (isPulls ? prefs.pulls.assignedToMe : prefs.issues.assignedToMe);
  const reviewRequestedMe =
    canFilterMine && isPulls && prefs.pulls.reviewRequestedMe;
  const groupByReview =
    canGroupByReview && isPulls && prefs.pulls.groupByReview;
  const chosenTeams = isPulls && canFilterTeam ? prefs.pulls.teams : [];

  // `tabActive` mirrors the review-state gate in the PR panel: a hidden <Activity>
  // panel still fetches, and this is a paginated walk of the viewer's `user/teams`
  // that a repo invalidation can re-run — so it waits until its panel is on screen.
  // The prefs and identity reads above stay ungated: those are local, and gating
  // them would strand the panel on default filters until its tab is opened.
  const teamsEnabled = isPulls && canFilterTeam && tabActive;
  const myTeams = useMyTeams(repoPath, lens, teamsEnabled);
  const knownTeams: TeamRef[] | undefined = myTeams.data?.teams;
  const knownSlugs = new Set((knownTeams ?? []).map((t) => t.slug));
  // Only validated slugs may reach the query: an unresolvable
  // `team-review-requested:` qualifier zeroes the ENTIRE parenthesized OR group it
  // sits in, not just its own leg (measured on GitHub's ISSUE_ADVANCED search), so
  // one stale team would empty the whole mine union with nothing on screen to
  // explain it. Three states vouch for nothing: undefined data (idle or pending), an
  // ERRORED query — retained cache included, since last-known-good membership is not
  // current membership — and a `missingScope` success, whose empty `teams` reports a
  // token that couldn't look rather than a membership of none. A chip must not be
  // flagged stale on a slug nothing ever disowned.
  const scopeMissing = teamsEnabled && myTeams.data?.missingScope === true;
  const teamsAnswered =
    knownTeams !== undefined && !scopeMissing && !myTeams.isError;
  const teamsFailed = teamsEnabled && myTeams.isError;
  const teamsUnavailable = teamsFailed || scopeMissing;
  const effectiveTeams = teamsAnswered
    ? chosenTeams.filter((slug) => knownSlugs.has(slug))
    : [];

  // A saved team choice puts the list in one of three states, and the list may only
  // ever run the scope the user actually saved:
  //  - PENDING: hold. `effectiveTeams` is [] until validation lands, so a team-ONLY
  //    scope would fetch the WHOLE repo under an active badge — "narrower first,
  //    wider later" only holds while another mine axis is also narrowing.
  //  - UNAVAILABLE (errored, or a `missingScope` success — an empty list meaning the
  //    token couldn't look): run without the team axis, but say so at the LIST
  //    (`teamScopeDropped` below) — the popover note alone leaves a wrong scope on
  //    screen unexplained, and `retry: false` means both are permanent until
  //    something refetches. A scope the app can't grant announces, never vouches.
  //  - ANSWERED: the validated path, unchanged.
  const teamScopeSettled =
    chosenTeams.length === 0 || teamsAnswered || teamsUnavailable;

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
   * Persist a whole prefs object. The mutation owns the optimistic cache patch
   * (it has to land behind that mutation's cancel, or an in-flight read swallows
   * it), so this only decides WHETHER to write: gated on the query having
   * resolved, since composing over a default-while-loading snapshot would erase
   * the stored filter.
   */
  function writePrefs(next: ConversationFilterPrefs) {
    if (!prefsQuery.data) return;
    // `repoPath` rides the payload so the write stays pinned to the repo on screen
    // now, whatever is open by the time it lands.
    savePrefs.mutate({ prefs: next, repo: repoPath });
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
     * `filter` is the saved scope, not a stand-in for one: the prefs have been read
     * AND any saved team choice has been validated (or, for good, cannot be). List
     * queries AND this into their `enabled`, so a repo with a stored filter fetches
     * ONCE, under the scope the user saved, instead of flashing a different one.
     *
     * It cannot wedge closed. The prefs loader catches its own failures and resolves
     * to the defaults; `useMyTeams` carries `retry: false`, so it always reaches
     * success or error; and the team leg only applies where teams can be chosen at
     * all, which the issue panel never does.
     */
    scopeReady: prefsQuery.data !== undefined && teamScopeSettled,
    /** A saved team axis that will NOT be in the running filter, because it could not
     *  be validated (the query errored, or the token lacks the scope to read
     *  membership) — the list is showing a wider scope than the saved one and must say
     *  so where the rows are, not only in the popover. */
    teamScopeDropped: chosenTeams.length > 0 && teamsUnavailable,
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
    teamsError: teamsFailed,
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
