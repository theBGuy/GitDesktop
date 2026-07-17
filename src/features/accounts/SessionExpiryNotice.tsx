import { WarningIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useForgeSessionHealth } from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

/** Whole days from now until an ISO-8601 instant (may be negative/0). Null when
 *  the input isn't a parseable date. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((then - Date.now()) / 86_400_000);
}

/**
 * A quiet one-line banner that warns before a repo's forge token lapses — shown
 * at the top of the Pull Requests and Issues panels when the session is still
 * healthy but its token expires within a week. GitHub/GitLab expiry comes from
 * the session-health probe; Bitbucket has no reported expiry, so it's derived
 * from the date the user optionally saved (Settings → Accounts). Dismissal is
 * session-scoped (returns next launch until the token is actually renewed), and
 * meaning is never color-only — the warning icon pairs with words.
 */
export function SessionExpiryNotice({ repoPath }: { repoPath: string }) {
  const health = useForgeSessionHealth(repoPath);
  const settings = useSettings();
  const openReconnect = useUiStore((s) => s.openReconnect);
  const openSettings = useUiStore((s) => s.openSettings);
  const dismissed = useUiStore((s) => s.dismissedExpiryNotices);
  const dismiss = useUiStore((s) => s.dismissExpiryNotice);

  const data = health.data;
  // Only warn on a HEALTHY session — a broken one is handled by the reconnect
  // ladders, and "offline" (inconclusive) must change nothing.
  if (!data || data.state !== "healthy") return null;

  const provider = data.provider;
  // Bitbucket has no reported expiry: derive it from the user-entered date.
  // GitHub/GitLab carry `daysLeft` on the health probe directly.
  const expiresAt =
    provider === "bitbucket"
      ? (settings.data?.bitbucketTokenExpiresAt ?? null)
      : data.expiresAt;
  const daysLeft =
    provider === "bitbucket" ? daysUntil(expiresAt) : data.daysLeft;

  if (daysLeft == null || daysLeft > 7) return null;

  const key = `${provider}|${data.host}|${expiresAt ?? ""}`;
  if (dismissed.has(key)) return null;

  const when =
    daysLeft <= 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-warning/5 px-3 py-1.5 text-xs"
    >
      <WarningIcon className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0">
        Your {providerLabel(provider)} token expires {when}.
      </span>
      <button
        type="button"
        className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          if (provider === "bitbucket") {
            openSettings("accounts");
          } else {
            openReconnect({ provider, host: data.host, mode: "refresh" });
          }
        }}
      >
        Reconnect
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto shrink-0"
        aria-label="Dismiss"
        onClick={() => dismiss(key)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
