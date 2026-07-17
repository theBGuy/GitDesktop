import {
  ArrowSquareOutIcon,
  GearSixIcon,
  GithubLogoIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { openInTerminal } from "@/lib/git/api";
import {
  useForgeSessionHealth,
  useForgeStatus,
  useRemotes,
} from "@/lib/git/queries";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { PublishRepoControl, usePublishProviders } from "./PublishRepoControl";

/** Where a Bitbucket / Atlassian API token is created. */
const ATLASSIAN_TOKEN_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Shared "this hosted feature isn't available" empty state for the Pull
 * Requests, Issues, Discussions, and Actions tabs. Names the actual blocker and
 * pairs it with the one action that resolves it, so the tab is a path forward
 * instead of a dead end. `feature` is the noun the message reads with ("pull
 * requests", "workflow runs").
 *
 * Provider-aware, with the publish path taking precedence: when this repo has
 * no origin and ≥1 provider can publish it, the panel offers the shared
 * "Publish repository…" control (a menu when 2+ are ready) instead of the gh
 * setup ladder. Otherwise GitHub walks the gh setup ladder (install → sign in
 * → publish, or — if gh is ready but the repo isn't resolvable — a `gh auth
 * status` diagnostic); GitLab walks the analogous glab ladder (install → sign
 * in), then — if glab is ready but the repo still isn't resolvable to a GitLab
 * project — points at `glab auth status`; Bitbucket walks the connect-account
 * ladder — no saved Atlassian API token → connect one, a saved token that won't
 * authenticate → update it — both deep-linking to Settings → Accounts.
 */
export function ForgeNotReady({
  repoPath,
  feature,
}: {
  repoPath: string;
  feature: string;
}) {
  const forge = useForgeStatus(repoPath);
  const settings = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const openReconnect = useUiStore((s) => s.openReconnect);
  // A dead session shows as `broken`; "offline" (inconclusive probe) reads like
  // any non-broken state and changes nothing here, so a network blip never flips
  // the copy or the button mode (anti-flap).
  const health = useForgeSessionHealth(repoPath);
  const sessionBroken = health.data?.state === "broken";
  const healthLogin = health.data?.login ?? null;

  const provider = forge.data?.provider;
  const installed = Boolean(forge.data?.installed);
  const authed = Boolean(forge.data?.authenticated);
  const remotes = useRemotes(repoPath);
  const noOrigin = remotes.isSuccess && !remotes.data.includes("origin");
  // A repo with no hosted remote has nothing to detect a provider from, so
  // publish targets are probed explicitly (which CLIs are installed + signed
  // in), yielding the ready providers in a stable order. This is what lets a
  // glab-only machine publish to GitLab even while the gh ladder below is still
  // asking for the GitHub CLI. Gated on the repo actually having NO origin:
  // provider is ALSO null for repos whose remote gh simply can't identify (gh
  // signed out, an unrecognized host) — publishing those would create an orphan
  // project and then fail adding `origin`.
  const providers = usePublishProviders(
    repoPath,
    provider == null && Boolean(forge.data) && noOrigin,
  );

  // GitLab: `glab` is wired (status detects install + sign-in) — walk the glab
  // setup ladder (install → sign in). If glab is already ready, this repo just
  // couldn't be resolved to a GitLab project; point at `glab auth status`. (A
  // not-ready GitHub repo has provider `null`, so it skips this and falls through
  // to the gh ladder below, unchanged.)
  if (provider === "gitlab") {
    if (!forge.data?.installed) {
      return (
        <div className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground">
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
    if (!forge.data?.authenticated) {
      const host = forge.data?.host ?? health.data?.host ?? "gitlab.com";
      return (
        <div className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground">
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
      <div className="px-3 py-4 text-xs text-muted-foreground">
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
      <div className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground">
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

  // Publish takes precedence: a no-origin repo that any signed-in provider can
  // take is offered the shared Publish control (a menu when 2+ are ready)
  // instead of the gh setup ladder.
  if (providers.length > 0) {
    return (
      <div className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground">
        <p>
          This repository isn't published yet. Publish it to use {feature} here.
        </p>
        <PublishRepoControl repoPath={repoPath} providers={providers} />
      </div>
    );
  }

  // GitHub: nothing can publish this repo, so walk the gh setup ladder
  // (install → sign in), then — if gh is ready but the repo still isn't
  // resolvable (an origin gh can't identify, or the targets probe found
  // nothing) — point at `gh auth status`.
  return (
    <div className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground">
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
