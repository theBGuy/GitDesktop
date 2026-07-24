import { useEffect, useRef } from "react";
import { BottomNav, TopBar } from "./components/Chrome";
import { ErrorState } from "./components/states";
import type { RepoSummary } from "./lib/api";
import { lastPairedAt } from "./lib/pairing-signal";
import { asApiError, useRepos } from "./lib/queries";
import {
  isRepoId,
  navigate,
  type Route,
  replace,
  repoHash,
  type Tab,
  useRoute,
} from "./lib/router";
import { AgentsBody, AgentWatch } from "./screens/Agents";
import { BranchesBody } from "./screens/Branches";
import { ChangesBody, ChangesFileBody } from "./screens/Changes";
import { CiBody, CiDetail } from "./screens/Ci";
import { DiscussionDetailBody, DiscussionsBody } from "./screens/Discussions";
import { CommitBody, CommitFileBody, HistoryBody } from "./screens/History";
import { IssueDetailBody, IssuesBody } from "./screens/Issues";
import { Pair } from "./screens/Pair";
import { PrDetail, PrsBody } from "./screens/Prs";
import { ReposBody } from "./screens/Repos";
import { StatusBody } from "./screens/Status";
import { TagsBody } from "./screens/Tags";
import { TodosBody } from "./screens/Todos";

// The app shell. It owns the cross-cutting states so every screen inherits them:
//   • 401 anywhere → route to #pair (token revoked / never paired)
//   • the selected repository (from the URL) + the shared-repos list
//   • the sticky TopBar (repo name + connection) + BottomNav
// Degraded/unreachable presentation is NOT here: each body renders its own
// StaleBanner keyed on its OWN query (see the round-4 finding in states.tsx).
//
// The selected repo is a first-class, URL-persisted concept (slice 4). The
// canonical routes are scoped (`#r/{repoId}/…`); the shell resolves a repo-less
// route (a legacy bookmark, or the bare app entry) into a scoped one — or the
// picker — once it knows the shared set. The `["repos"]` query doubles as the
// device-level connection + auth signal (a 401 on it routes through the central
// QueryCache → #pair, same as any other query).

export default function App() {
  const route = useRoute();

  // The shared repos list — device-level (no repo scope), so it's our always-
  // available authenticated probe AND the source of truth for the picker/title.
  // Gated OFF while pairing: a revoked-but-still-cookied device would otherwise
  // bank rate-limit failures on every foreground during the pairing dance (the
  // PR-75 lockout budget). See `useRepos`.
  const reposQuery = useRepos(!route.isPairing);
  const reposErr = asApiError(reposQuery.error);
  // `/api/repos` is now an envelope `{ repos, hideAi }`. Destructure the list (what
  // every downstream consumer expects) and the desktop's "Hide AI features"
  // preference. `hideAi` defaults false until the list loads — AI surfaces show by
  // default and hide only once the desktop says so, matching the desktop's own gate.
  const repos = reposQuery.data?.repos;
  const hideAi = reposQuery.data?.hideAi ?? false;

  // Remember the last SCOPED route context (which repo + tab the user was on) so
  // the picker — reached via `#repos`, whose hash carries NO repo segment — can
  // still highlight the current repo and preserve the tab on a switch. In-memory
  // only: a reload landing directly on `#repos` degrades to no-highlight/status,
  // which is acceptable. Updated in an effect so the render stays pure.
  const lastScoped = useRef<{ repoId: string; tab: Tab } | null>(null);
  useEffect(() => {
    if (route.repoId != null) {
      lastScoped.current = { repoId: route.repoId, tab: route.tab };
    }
  }, [route.repoId, route.tab]);

  // Global 401 → the device isn't paired (or was revoked). Bounce to #pair — but
  // ONLY on a FRESH 401 (newer than the last successful pair), and never while a
  // refetch is in flight (the settled result may be a 200). This mirrors the
  // original status-probe guard, now driven by the device-level repos query so it
  // holds on every route (including #repos, which has no repo to probe).
  //
  // LIVE-FOUND RACE (post-pair bounce): while the user sat on #pair, this probe
  // could cache a 401 (no cookie yet); without these guards, pairing → navigate
  // would read the STALE 401 and bounce the freshly-paired user back to the PIN
  // screen. `errorUpdatedAt > lastPairedAt()` + `!isFetching` make a pre-pair 401
  // un-bounceable; a genuine post-pair revoke (newer timestamp) still bounces.
  // (The central QueryCache onError also redirects on 401; this guarded effect is
  // the belt-and-braces that survives the post-pair race.)
  useEffect(() => {
    if (
      reposErr?.isUnauthorized &&
      !route.isPairing &&
      !reposQuery.isFetching &&
      reposQuery.errorUpdatedAt > lastPairedAt()
    ) {
      navigate("#pair");
    }
  }, [
    reposErr,
    route.isPairing,
    reposQuery.isFetching,
    reposQuery.errorUpdatedAt,
  ]);

  // Bootstrap/redirect: a repo-less route that isn't #pair/#repos needs resolving
  // once the shared set is known. Exactly one repo, or an active repo → REPLACE to
  // its scoped equivalent (preserving the tab tail). Anything else — multiple repos
  // with none active, OR zero shared repos — sends to the picker, which owns both
  // the choose-one and the nothing-shared teaching states. REPLACE (not push) so
  // Back doesn't bounce onto the bare legacy hash that would just redirect again.
  useEffect(() => {
    if (route.isPairing || route.isRepos || route.repoId != null) return;
    if (!repos) return; // wait for the list
    const target = resolveRepo(repos);
    if (target) {
      replace(repoHash(target, tabTail(route)));
    } else {
      replace("#repos");
    }
  }, [route, repos]);

  // Hide AI: when the desktop has "Hide AI features" on, the Agents tab and the
  // agent-watch screen must be unreachable on the phone, matching the desktop. Any
  // agents route (scoped `#r/{id}/agents[/streamId]` OR the legacy repo-less
  // `#agents[/streamId]`) REPLACES to the status tab for the same scope. Gate
  // strictly on the list having LOADED (`reposQuery.data !== undefined`) so we never
  // redirect on the stale-undefined default and flicker the tab away mid-load. A flag
  // flip mid-watch converges on the next poll (≤15s): this effect re-runs when
  // `hideAi` turns true and unmounts the live stream — the intended behavior.
  useEffect(() => {
    if (reposQuery.data === undefined) return; // wait for the real value
    if (!hideAi || route.tab !== "agents" || route.isPairing || route.isRepos)
      return;
    replace(
      route.repoId != null ? repoHash(route.repoId, "status") : "#status",
    );
  }, [reposQuery.data, hideAi, route]);

  if (route.isPairing) {
    return <Pair />;
  }

  const selectedRepo =
    route.repoId != null
      ? (repos?.find((r) => r.id === route.repoId) ?? null)
      : null;
  // The title: the selected repo's name, a neutral label on the picker, or a
  // fallback while the list loads / mid-redirect. `connected` is the device-level
  // reachability of the repos probe.
  const title = route.isRepos
    ? "Choose repository"
    : (selectedRepo?.name ?? "GitDesktop");
  const connected = reposQuery.isSuccess;

  // The repo context the chrome should reflect. On a scoped route it's the route
  // itself; on the picker (`#repos`, no repo in the hash) it's the remembered
  // last-scoped context so the picker highlights the current repo, preserves the
  // tab on a switch, and the bottom tabs still point somewhere coherent. Null on a
  // cold entry directly on `#repos` (nothing remembered) — then the picker shows no
  // highlight and the bottom nav is hidden (no repo to point its tabs at).
  const chromeContext = route.isRepos
    ? lastScoped.current
    : route.repoId != null
      ? { repoId: route.repoId, tab: route.tab }
      : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <TopBar
        title={title}
        // The title is a tappable "switch repository" trigger EXCEPT on the picker
        // itself (nowhere to switch to) — the shell passes the handler only when a
        // repo context exists.
        onSwitchRepo={route.isRepos ? undefined : () => navigate("#repos")}
        connected={connected}
      />

      <main className="flex-1">
        <Shell
          route={route}
          repos={repos}
          selectedRepo={selectedRepo}
          pickerContext={chromeContext}
          hideAi={hideAi}
          reposError={reposQuery.error}
          onReposRetry={() => reposQuery.refetch()}
        />
      </main>

      {/* Hide the bottom nav on the picker when there's no remembered repo — its
          tabs would point at legacy hashes that just bounce back to #repos. With a
          remembered repo they navigate to that repo's tabs (a real leave-the-picker
          affordance). Off the picker it always shows, scoped to the live repo. */}
      {route.isRepos && !chromeContext ? null : (
        <BottomNav repoId={chromeContext?.repoId ?? null} hideAi={hideAi} />
      )}
    </div>
  );
}

/** Pick the repo to auto-select for a repo-less route: the single shared repo, or
 *  the active one (open on the desktop). Returns its id, or null when the choice
 *  is ambiguous (multiple repos, none active) or empty.
 *
 *  Defense-in-depth: ignore any repo whose id fails the router's grammar. A
 *  redirect to `#r/{bad}/…` would parse back to `repoId: null`, re-fire the
 *  bootstrap effect, and loop; degrading a malformed id to the picker (or the
 *  next valid candidate) is the safe failure. */
function resolveRepo(repos: RepoSummary[]): string | null {
  const valid = repos.filter((r) => isRepoId(r.id));
  if (valid.length === 1) return valid[0].id;
  const active = valid.find((r) => r.active);
  return active ? active.id : null;
}

/** The `{tab}[/{detail}]` tail of the current route, for preserving context across
 *  a redirect. A legacy `#prs/4` becomes `prs/4`; a bare `#status` becomes
 *  `status`. */
function tabTail(route: Route): string {
  if (route.tab === "prs" && route.detailId != null)
    return `prs/${route.detailId}`;
  if (route.tab === "ci" && route.detailId != null)
    return `ci/${route.detailId}`;
  if (route.tab === "agents" && route.streamId != null)
    return `agents/${route.streamId}`;
  if (route.tab === "discussions" && route.detailId != null)
    return `discussions/${route.detailId}`;
  return route.tab;
}

/** Route to the right body. The picker (`#repos`) is handled here; a repo-less
 *  route normally renders nothing (a redirect is pending — see the bootstrap
 *  effect) but shows the repos error state when the list can't load; a scoped
 *  route whose repo isn't in the shared set falls back to the picker. */
function Shell({
  route,
  repos,
  selectedRepo,
  pickerContext,
  hideAi,
  reposError,
  onReposRetry,
}: {
  route: Route;
  repos: RepoSummary[] | undefined;
  selectedRepo: RepoSummary | null;
  pickerContext: { repoId: string; tab: Tab } | null;
  hideAi: boolean;
  reposError: unknown;
  onReposRetry: () => void;
}) {
  if (route.isRepos) {
    // `#repos` carries no repo in the hash, so use the remembered scoped context
    // (if any) to highlight the current repo and preserve its tab on a switch.
    return (
      <ReposBody
        currentRepoId={pickerContext?.repoId ?? null}
        currentTab={pickerContext?.tab ?? null}
      />
    );
  }

  // Repo-less route (bare entry, a legacy bookmark, or the post-pair
  // `navigate("#status")`): the bootstrap effect redirects to a scoped route or
  // the picker ONCE the list loads. But if the list itself can't load (desktop
  // unreachable / 5xx — a 401 already bounced to #pair), there's no repo to
  // redirect to and no tab to fall back on, so render the repos error state with a
  // Retry rather than a permanent blank main area. (`ErrorState` owns the
  // unreachable/generic branches; `noSuchRepo` can't occur on the un-scoped repos
  // route.)
  if (route.repoId == null) {
    if (!repos && reposError != null) {
      return <ErrorState error={reposError} onRetry={onReposRetry} />;
    }
    // Still loading, or a redirect is pending — render nothing to avoid a flash.
    return null;
  }

  // A scoped route whose repoId isn't in the loaded shared set — it just stopped
  // being shared, or the URL was hand-crafted. Route through the picker (with the
  // current tab preserved) rather than firing scoped queries that would 404. While
  // the list is still loading (`repos` undefined) we let the screen mount — its own
  // query surfaces a `noSuchRepo` teaching state if the id is genuinely gone.
  if (repos && !selectedRepo) {
    return <ReposBody currentRepoId={route.repoId} currentTab={route.tab} />;
  }

  return <Screen route={route} repoId={route.repoId} hideAi={hideAi} />;
}

function Screen({
  route,
  repoId,
  hideAi,
}: {
  route: Route;
  repoId: string;
  hideAi: boolean;
}) {
  if (route.tab === "prs") {
    return route.detailId != null ? (
      <PrDetail repoId={repoId} number={route.detailId} />
    ) : (
      <PrsBody repoId={repoId} active />
    );
  }
  if (route.tab === "ci") {
    return route.detailId != null ? (
      <CiDetail repoId={repoId} id={route.detailId} />
    ) : (
      <CiBody repoId={repoId} active />
    );
  }
  if (route.tab === "agents") {
    // The ternary UNMOUNTS the list while a watch is open, so the list's polling
    // query stops on its own — the list is only mounted (and thus polling) in the
    // else-arm, where it's always the active view. Key the watch by `repoId:id` so
    // a change of either forces a fresh mount (resetting the SSE reducer state) —
    // no current path swaps them under a mounted watch, but keying makes that a
    // non-footgun rather than relying on it never happening.
    // `hideAi` is a defensive guard: the redirect effect in App already bounces any
    // agents route to status when Hide AI is on, so this branch normally can't render
    // hidden. It covers the one-frame race before that effect runs (both components
    // render null when `hideAi`).
    return route.streamId != null ? (
      <AgentWatch
        key={`${repoId}:${route.streamId}`}
        repoId={repoId}
        id={route.streamId}
        hideAi={hideAi}
      />
    ) : (
      <AgentsBody repoId={repoId} active hideAi={hideAi} />
    );
  }
  if (route.tab === "changes") {
    // A file-diff route needs BOTH a section and a decoded file; the router only
    // emits them together (a section without a file falls back to the list), but
    // gate on both so a partial route always renders the list, never a half-formed
    // detail.
    return route.section != null && route.filePath != null ? (
      <ChangesFileBody
        repoId={repoId}
        section={route.section}
        filePath={route.filePath}
      />
    ) : (
      <ChangesBody repoId={repoId} active />
    );
  }
  if (route.tab === "history") {
    if (route.sha != null) {
      return route.filePath != null ? (
        <CommitFileBody
          repoId={repoId}
          sha={route.sha}
          filePath={route.filePath}
        />
      ) : (
        <CommitBody repoId={repoId} sha={route.sha} />
      );
    }
    return <HistoryBody repoId={repoId} active />;
  }
  if (route.tab === "branches") {
    return <BranchesBody repoId={repoId} active />;
  }
  if (route.tab === "issues") {
    return route.detailId != null ? (
      <IssueDetailBody repoId={repoId} number={route.detailId} />
    ) : (
      <IssuesBody repoId={repoId} active />
    );
  }
  if (route.tab === "tags") {
    return <TagsBody repoId={repoId} active />;
  }
  if (route.tab === "todos") {
    return <TodosBody repoId={repoId} active />;
  }
  if (route.tab === "discussions") {
    return route.detailId != null ? (
      <DiscussionDetailBody repoId={repoId} number={route.detailId} />
    ) : (
      <DiscussionsBody repoId={repoId} active />
    );
  }
  return <StatusBody repoId={repoId} active />;
}
