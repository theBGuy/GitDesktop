import { useEffect } from "react";
import { BottomNav, TopBar } from "./components/Chrome";
import { ErrorState, UnreachableBanner } from "./components/states";
import { lastPairedAt } from "./lib/pairing-signal";
import { asApiError, useStatus } from "./lib/queries";
import { navigate, useRoute } from "./lib/router";
import { CiBody, CiDetail } from "./screens/Ci";
import { Pair } from "./screens/Pair";
import { PrDetail, PrsBody } from "./screens/Prs";
import { StatusBody } from "./screens/Status";

// The app shell. It owns the cross-cutting states so every screen inherits them:
//   • 401 anywhere → route to #pair (token revoked / never paired)
//   • the sticky TopBar (repo name + connection) + BottomNav
//   • a top-of-flow "unreachable" banner when the server can't be reached but a
//     screen still has stale data on show.
// The Status query doubles as the shell's connection probe: it drives the
// TopBar's live/offline dot and the global 401 redirect.

export default function App() {
  const route = useRoute();

  // Probe the shared repo's status regardless of the active tab — it's the
  // cheapest always-available authenticated call, so it's our connection +
  // auth signal. Only poll it while Status is the visible tab (other tabs run
  // their own polling query); elsewhere it still fetches once on mount/route
  // change for the header + 401 check.
  const statusQuery = useStatus(route.tab === "status" && !route.isPairing);
  const statusErr = asApiError(statusQuery.error);

  // Global 401 → the device isn't paired (or was revoked). Bounce to #pair —
  // but ONLY on a FRESH 401.
  //
  // LIVE-FOUND RACE (post-pair bounce): while the user sat on #pair, this probe
  // cached a 401 (no cookie yet). Without the guards below, pairing → navigate
  // to #status → this effect reads the STALE cached 401 → bounces the freshly-
  // paired user straight back to the PIN screen (Back then lands on #status,
  // authed). Two guards make a pre-pair 401 un-bounceable:
  //   • `!isFetching` — never act while a refetch is in flight (the settled
  //     result may be a 200);
  //   • `errorUpdatedAt > lastPairedAt()` — the 401 must be NEWER than the last
  //     successful pair. Pair.tsx stamps `markPaired()` and awaits a status
  //     refetch before navigating, so a genuine post-pair revoke still bounces,
  //     but the pre-pair 401 (older timestamp) never does.
  useEffect(() => {
    if (
      statusErr?.isUnauthorized &&
      !route.isPairing &&
      !statusQuery.isFetching &&
      statusQuery.errorUpdatedAt > lastPairedAt()
    ) {
      navigate("#pair");
    }
  }, [
    statusErr,
    route.isPairing,
    statusQuery.isFetching,
    statusQuery.errorUpdatedAt,
  ]);

  if (route.isPairing) {
    return <Pair />;
  }

  const repoName = deriveRepoName(statusQuery.data?.branch.name ?? null);
  const connected = statusQuery.isSuccess;
  const unreachable = statusErr?.isUnreachable ?? false;
  // A no-repo (409) is a whole-app state — show it centrally, not per tab.
  const noRepo = statusErr?.isNoActiveRepo ?? false;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <TopBar
        title={repoName}
        subtitle={statusQuery.data?.branch.name ?? undefined}
        connected={connected}
      />
      {unreachable && statusQuery.data ? (
        <UnreachableBanner onRetry={() => statusQuery.refetch()} />
      ) : null}

      <main className="flex-1">
        {noRepo ? (
          <ErrorState
            error={statusQuery.error}
            onRetry={() => statusQuery.refetch()}
          />
        ) : (
          <Screen route={route} />
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function Screen({ route }: { route: ReturnType<typeof useRoute> }) {
  if (route.tab === "prs") {
    return route.detailId != null ? (
      <PrDetail number={route.detailId} />
    ) : (
      <PrsBody active />
    );
  }
  if (route.tab === "ci") {
    return route.detailId != null ? (
      <CiDetail id={route.detailId} />
    ) : (
      <CiBody active />
    );
  }
  return <StatusBody active />;
}

/** A short repo label. The status API exposes the branch, not the repo name, so
 *  fall back to a neutral title until a richer field exists (a later slice). */
function deriveRepoName(_branch: string | null): string {
  return "GitDesktop";
}
