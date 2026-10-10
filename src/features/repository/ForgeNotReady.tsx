import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  GearSixIcon,
  GithubLogoIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type Ref, useEffect, useRef } from "react";
import { PathText } from "@/components/path-text";
import { useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import { openInTerminal } from "@/lib/git/api";
import {
  useForgeSessionHealth,
  useForgeStatus,
  usePathPresent,
  useRemotes,
} from "@/lib/git/queries";
import { providerLabel, rateLimitResetTime } from "@/lib/git/types";
import { useOfflineHold } from "@/lib/offline-writes";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import {
  PUBLISH_ACCOUNTS_OFFLINE,
  PublishRepoControl,
  publishPendingReason,
  usePublishProviders,
} from "./PublishRepoControl";
import {
  REMOTES_FAILED_REASON,
  REMOTES_PENDING_REASON,
} from "./sync-controls-state";

/** Where a Bitbucket / Atlassian API token is created. */
const ATLASSIAN_TOKEN_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Shared "this hosted feature isn't available" empty state for the Pull
 * Requests, Issues, Discussions, Actions, and Findings tabs. Names the actual
 * blocker and pairs it with the one action that resolves it, so the tab is a
 * path forward instead of a dead end. `feature` is the noun the message reads
 * with ("pull requests", "workflow runs").
 *
 * A missing checkout folder outranks every provider arm: a repo-scoped read on a
 * deleted path fails exactly like a signed-out CLI, so without this arm the panel
 * would send the user to `gh auth status` for a folder that simply isn't there.
 *
 * Provider-aware, with the publish path taking precedence: when this repo has
 * no origin and ≥1 provider can publish it, the panel offers the shared
 * "Publish repository…" control (a menu when 2+ are ready) instead of the gh
 * setup ladder, holding it disabled with a reason while the probes are out.
 * Otherwise GitHub walks the gh setup ladder (install → sign in → publish,
 * or — if gh is ready but the repo isn't resolvable — a `gh auth
 * status` diagnostic); GitLab walks the analogous glab ladder (install → sign
 * in), then — if glab is ready but the repo still isn't resolvable to a GitLab
 * project — points at `glab auth status`; Bitbucket walks the connect-account
 * ladder — no saved Atlassian API token → connect one, a saved token that won't
 * authenticate → update it — both deep-linking to Settings → Accounts. A
 * rate-limited GitHub or GitLab session outranks each ladder's sign-in arms,
 * which a rate limit would otherwise trip, and a GitHub repo lookup refused by a
 * rate limit outranks the `gh auth status` diagnostic.
 */
export function ForgeNotReady({
  repoPath,
  feature,
  retryRef,
}: {
  repoPath: string;
  feature: string;
  /** Rides the unreachable-host arm's Retry, for a caller's
   *  `useRetryFocusRescue`. The rescue can't live in here: a Retry resets the
   *  never-loaded probe to pending, and every caller unmounts this card for its
   *  skeleton then, so only a caller-owned host survives the swap. */
  retryRef?: Ref<HTMLButtonElement>;
}) {
  const forge = useForgeStatus(repoPath);
  const settings = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const openReconnect = useUiStore((s) => s.openReconnect);
  const closeRepo = useUiStore((s) => s.closeRepo);
  const queryClient = useQueryClient();
  // Render precedence only — `useForgeStatus` and the panels' own reads stay
  // ungated, so a pending probe changes nothing and only a measured `false`
  // takes over the panel.
  const present = usePathPresent(repoPath);
  const prevPresent = useRef<{ repo: string; missing: boolean } | null>(null);
  // A restored folder recovers without a restart: forge-status carries a 60s
  // staleTime and remotes was read against the dead path, so this repo's own
  // false → true transition re-reads both. The first resolve and a repo switch
  // are not transitions — there is nothing poisoned to replace.
  useEffect(() => {
    if (present.data === undefined) return;
    const prev = prevPresent.current;
    prevPresent.current = { repo: repoPath, missing: !present.data };
    if (!prev || prev.repo !== repoPath || !prev.missing || !present.data) {
      return;
    }
    queryClient.invalidateQueries({
      queryKey: ["repo", repoPath, "forge-status"],
    });
    queryClient.invalidateQueries({ queryKey: ["repo", repoPath, "remotes"] });
  }, [present.data, repoPath, queryClient]);
  // A dead session shows as `broken`; "offline" (inconclusive probe) reads like
  // any non-broken state and changes nothing here, so a network blip never flips
  // the copy or the button mode (anti-flap).
  const health = useForgeSessionHealth(repoPath);
  const sessionBroken = health.data?.state === "broken";
  const healthLogin = health.data?.login ?? null;
  // Health outranks forge-status here: a rate-limited host reads as signed out (the
  // per-host probe authenticates only Healthy; old gh's global exit code agrees), so
  // the sign-in arms would misdirect.
  const rateLimitedProvider =
    health.data?.state === "rateLimited" ? health.data.provider : null;

  const provider = forge.data?.provider;
  const installed = Boolean(forge.data?.installed);
  const authed = Boolean(forge.data?.authenticated);
  const remotes = useRemotes(repoPath);
  // From data, like the sync bar: a failed refresh over loaded remotes keeps
  // offering Publish there, so it must here too.
  const noOrigin =
    remotes.data !== undefined && !remotes.data.includes("origin");
  // A repo with no hosted remote has nothing to detect a provider from, so
  // publish targets are probed explicitly (which CLIs are installed + signed
  // in), yielding the ready providers in a stable order. This is what lets a
  // glab-only machine publish to GitLab even while the gh ladder below is still
  // asking for the GitHub CLI. Gated on the repo actually having NO origin:
  // provider is ALSO null for repos whose remote gh simply can't identify (gh
  // signed out, an unrecognized host) — publishing those would create an orphan
  // project and then fail adding `origin`.
  const { providers, settled } = usePublishProviders(
    repoPath,
    provider == null && Boolean(forge.data) && noOrigin,
  );
  const offlineHold = useOfflineHold();
  // A disabled probe reads settled, so this is false whenever the probe is off.
  const publishArm = providers.length > 0 || !settled;
  // The publish arm's swaps unmount its focused button: a settle onto the
  // ladder, or onto 2+ providers (the dropdown mounts its own trigger). Every
  // root carries this ref as a silent landing spot, since other edges (an
  // origin added, the folder vanishing) leave the publish arm too.
  const landingRef = useRef<HTMLDivElement>(null);
  useFocusOnControlsSwap(publishArm, landingRef);
  useFocusOnControlsSwap(providers.length >= 2, landingRef);

  // The folder is gone: name that and offer the one way out. Nothing about the
  // forge is knowable from a dead path, so no provider copy runs. While the probe
  // is pending the arms below render unchanged.
  if (present.data === false) {
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        <p>This repository's folder no longer exists on disk.</p>
        <PathText path={repoPath} className="font-mono text-foreground" />
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={closeRepo}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          Back to repositories
        </Button>
      </div>
    );
  }

  // GitLab: `glab` is wired (status detects install + sign-in) — walk the glab
  // setup ladder (install → sign in). If glab is already ready, this repo just
  // couldn't be resolved to a GitLab project; point at `glab auth status`. (A
  // not-ready GitHub repo has provider `null`, so it skips this and falls through
  // to the gh ladder below, unchanged.)
  if (provider === "gitlab") {
    if (!forge.data?.installed) {
      return (
        <div
          ref={landingRef}
          tabIndex={-1}
          className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
        >
          <p>
            The GitLab CLI (<span className="font-mono">glab</span>) isn't
            installed. GitDesktop will use it to work with {feature} on GitLab.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              openUrl("https://gitlab.com/gitlab-org/cli#installation")
            }
            className="cursor-pointer"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            Install the GitLab CLI
          </Button>
        </div>
      );
    }
    if (rateLimitedProvider === "gitlab") {
      return (
        <RateLimitedNotice
          repoPath={repoPath}
          provider="gitlab"
          feature={feature}
          resetAt={health.data?.resetAt}
          checkedAt={health.dataUpdatedAt}
          landingRef={landingRef}
        />
      );
    }
    if (!forge.data?.authenticated) {
      const host = forge.data?.host ?? health.data?.host ?? "gitlab.com";
      return (
        <div
          ref={landingRef}
          tabIndex={-1}
          className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
        >
          <p>
            {sessionBroken
              ? `Your GitLab session${
                  healthLogin ? ` for @${healthLogin}` : ""
                } expired or was revoked. Reconnect to keep working with ${feature}.`
              : `Sign in to GitLab to work with ${feature}.`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={() =>
                openReconnect({
                  provider: "gitlab",
                  host,
                  mode: sessionBroken ? "refresh" : "login",
                })
              }
            >
              {sessionBroken ? "Reconnect GitLab…" : "Sign in to GitLab…"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                openInTerminal(
                  repoPath,
                  settings.data?.terminal,
                  settings.data?.terminalPath,
                  settings.data?.terminalCommand,
                ).catch(toastError)
              }
            >
              <TerminalIcon data-icon="inline-start" />
              Open terminal to sign in
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Tip: choose the browser (OAuth) option — OAuth sessions renew
            themselves, while personal access tokens expire.
          </p>
        </div>
      );
    }
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        <p>
          GitDesktop couldn't connect this repository to GitLab, so {feature}{" "}
          aren't available here. Run{" "}
          <span className="font-mono text-foreground">glab auth status</span> in
          a terminal to check the host's connection.
        </p>
      </div>
    );
  }

  // Bitbucket: read integration via an Atlassian API token. Walk the connect
  // ladder — no token saved → connect; a saved token that won't authenticate →
  // update it. Both deep-link to Settings → Accounts in one atomic navigation.
  if (provider === "bitbucket") {
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        {!installed ? (
          <p>
            Connect your Bitbucket account with an Atlassian API token to see{" "}
            {feature} here.
          </p>
        ) : (
          <p>
            GitDesktop couldn't sign in to Bitbucket with the saved token — it
            may be expired, revoked, or missing scopes. Update it in Settings →
            Accounts.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openSettings("accounts")}
          >
            <GearSixIcon data-icon="inline-start" />
            Open Settings → Accounts
          </Button>
          {!installed && (
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer"
              onClick={() => openUrl(ATLASSIAN_TOKEN_URL)}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              Create an API token
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Until remotes answer, neither publish nor the ladder is honest for a
  // provider-less repo; hold the frame blank (busy, with a status line) instead.
  if (
    provider == null &&
    forge.data &&
    remotes.data === undefined &&
    remotes.errorUpdateCount === 0
  ) {
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        {/* Outside the aria-busy subtree: busy suppresses descendant live-region
            announcements, and this arm unmounts instead of flipping. */}
        <span role="status" className="sr-only">
          {REMOTES_PENDING_REASON}
        </span>
        <div aria-busy="true" />
      </div>
    );
  }

  // A remotes read that failed with nothing loaded leaves the same question
  // open; say so rather than send the user to a CLI setup step. The
  // useRemotes error-only poll and a window focus heal it, so no Retry.
  if (
    provider == null &&
    forge.data &&
    remotes.data === undefined &&
    remotes.errorUpdateCount > 0
  ) {
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        <p>
          {REMOTES_FAILED_REASON}, so {feature} aren't available right now.
        </p>
      </div>
    );
  }

  // Publish takes precedence: a no-origin repo that any signed-in provider can
  // take is offered the shared Publish control (a menu when 2+ are ready)
  // instead of the gh setup ladder. One arm from pending through settled keeps
  // one control node, so a disabled → single-provider settle keeps its focus.
  if (publishArm) {
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        <p>
          This repository isn't published yet. Publish it to use {feature} here.
        </p>
        <PublishRepoControl
          repoPath={repoPath}
          providers={providers}
          disabledTitle={
            settled ? undefined : publishPendingReason(offlineHold)
          }
        />
        {/* Only while the button is held: the targets probe parks offline,
            so the accounts are checked only once the connection returns. */}
        {!settled && offlineHold && providers.length === 0 && (
          <p>{PUBLISH_ACCOUNTS_OFFLINE}</p>
        )}
      </div>
    );
  }

  if (rateLimitedProvider === "github") {
    return (
      <RateLimitedNotice
        repoPath={repoPath}
        provider="github"
        feature={feature}
        resetAt={health.data?.resetAt}
        checkedAt={health.dataUpdatedAt}
        landingRef={landingRef}
      />
    );
  }

  // A limit that refused only the repo lookup reaches forge-status while auth
  // reads healthy, so the "couldn't connect" arm below would misdirect. Health
  // carries no reset here; the recheck keys on the forge-status read instead.
  if (
    (provider == null || provider === "github") &&
    forge.data?.probeError === "rateLimited" &&
    authed
  ) {
    return (
      <RateLimitedNotice
        repoPath={repoPath}
        provider="github"
        feature={feature}
        resetAt={null}
        checkedAt={forge.dataUpdatedAt}
        landingRef={landingRef}
      />
    );
  }

  // A status probe that rejected with nothing cached (a cold start while the host
  // is unreachable) knows neither the provider nor its install or sign-in state,
  // so this copy names no host and the ladder below would misdirect.
  if (forge.isError && forge.data === undefined) {
    return (
      <div
        ref={landingRef}
        tabIndex={-1}
        className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
      >
        <p>
          GitDesktop couldn't reach this repository's host, so {feature} aren't
          available right now. Check your network connection.
        </p>
        <Button
          ref={retryRef}
          variant="outline"
          size="sm"
          className="cursor-pointer"
          // Joins a probe already in flight rather than spawning a second one.
          onClick={() => void forge.refetch({ cancelRefetch: false })}
        >
          Retry
        </Button>
      </div>
    );
  }

  // GitHub: nothing can publish this repo, so walk the gh setup ladder
  // (install → sign in), then — if gh is ready but the repo still isn't
  // resolvable (an origin gh can't identify, or the targets probe found
  // nothing) — point at `gh auth status`.
  return (
    <div
      ref={landingRef}
      tabIndex={-1}
      className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground outline-none"
    >
      {!installed ? (
        <>
          <p>
            The GitHub CLI (<span className="font-mono">gh</span>) isn't
            installed. GitDesktop uses it to work with {feature}.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openUrl("https://cli.github.com")}
            className="cursor-pointer"
          >
            <GithubLogoIcon data-icon="inline-start" />
            Install GitHub CLI
          </Button>
        </>
      ) : !authed ? (
        <>
          <p>
            {sessionBroken
              ? `Your GitHub session${
                  healthLogin ? ` for @${healthLogin}` : ""
                } expired or was revoked. Reconnect to keep working with ${feature}.`
              : `Sign in to GitHub to work with ${feature}.`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={() =>
                openReconnect({
                  provider: "github",
                  host: forge.data?.host ?? health.data?.host ?? "github.com",
                  mode: sessionBroken ? "refresh" : "login",
                })
              }
            >
              {sessionBroken ? "Reconnect GitHub…" : "Sign in to GitHub…"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                openInTerminal(
                  repoPath,
                  settings.data?.terminal,
                  settings.data?.terminalPath,
                  settings.data?.terminalCommand,
                ).catch(toastError)
              }
            >
              <TerminalIcon data-icon="inline-start" />
              Open terminal to sign in
            </Button>
          </div>
        </>
      ) : (
        <p>
          GitDesktop couldn't connect this repository to GitHub, so {feature}{" "}
          aren't available here. Run{" "}
          <span className="font-mono text-foreground">gh auth status</span> in a
          terminal to check the connection.
        </p>
      )}
    </div>
  );
}

/** Slack past the reset second, so the re-read doesn't land a hair early. */
const RESET_GRACE_MS = 5_000;
/** The longest a rate-limited panel waits after the driving read before
 *  checking again, whatever the reset says (null, past, or far out). */
const RATE_LIMIT_RECHECK_MS = 2 * 60_000;

/** The rate-limited arm. Deliberately no Reconnect: the credential is fine, and a
 *  fresh sign-in draws on the same exhausted quota. */
function RateLimitedNotice({
  repoPath,
  provider,
  feature,
  resetAt,
  checkedAt,
  landingRef,
}: {
  repoPath: string;
  provider: "github" | "gitlab";
  feature: string;
  resetAt: number | null | undefined;
  /** When the driving query (health, or forge-status) was last read (`dataUpdatedAt`, epoch ms). */
  checkedAt: number;
  /** The panel's focus landing spot, shared by every root it renders. */
  landingRef: Ref<HTMLDivElement>;
}) {
  const queryClient = useQueryClient();
  const now = useRelativeNow();
  const label = providerLabel(provider);
  const resumesAt = rateLimitResetTime(resetAt, now);
  // Re-read this repo's forge status and session health, plus the accounts list
  // behind Settings' "rate limited" badge, so no surface stays stuck without a
  // restart. The timer fires at whichever comes first: just past a known future
  // reset, or RATE_LIMIT_RECHECK_MS after the driving read. A stale
  // `checkedAt` fires at once, which stays bounded: each re-arm needs a fresh
  // successful read to move `checkedAt`, never a tight loop.
  useEffect(() => {
    const nowMs = Date.now();
    const recheck = Math.max(0, checkedAt + RATE_LIMIT_RECHECK_MS - nowMs);
    const resetMs = typeof resetAt === "number" ? resetAt * 1000 : null;
    const delay =
      resetMs !== null && resetMs > nowMs
        ? Math.min(resetMs - nowMs + RESET_GRACE_MS, recheck)
        : recheck;
    const timer = setTimeout(() => {
      queryClient.invalidateQueries({
        queryKey: ["repo", repoPath, "forge-status"],
      });
      queryClient.invalidateQueries({
        queryKey: ["repo", repoPath, "forge-session-health"],
      });
      queryClient.invalidateQueries({ queryKey: ["accounts-health"] });
    }, delay);
    return () => clearTimeout(timer);
  }, [resetAt, checkedAt, repoPath, queryClient]);
  return (
    <div
      ref={landingRef}
      tabIndex={-1}
      className="space-y-1.5 px-3 py-4 text-xs text-muted-foreground outline-none"
    >
      <p className="font-medium text-foreground">
        {label} API rate limit reached
      </p>
      <p>
        {`${label}'s API rate limit is in effect${
          resumesAt ? ` — access resumes at ${resumesAt}` : ""
        }. You don't need to sign in again: ${feature} will load once it lifts.`}
      </p>
    </div>
  );
}
