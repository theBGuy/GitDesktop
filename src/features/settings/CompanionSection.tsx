import { DeviceMobileIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  useLanDeviceRevoke,
  useLanDevices,
  useLanDisable,
  useLanEnable,
  useLanSharedRepos,
  useLanShareRepo,
  useLanStatus,
  useLanUnshareRepo,
} from "@/lib/git/queries";
import type { LanDevice, LanSharedRepo } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { formatRelativeTime } from "@/lib/time";
import { PairDeviceDialog } from "./PairDeviceDialog";

export function CompanionSection() {
  const status = useLanStatus();
  const enable = useLanEnable();
  const disable = useLanDisable();
  const revoke = useLanDeviceRevoke();

  // The repo currently open on the desktop — the one "Share current repository"
  // adds, and the one that's always reachable without being in the shared list.
  const repoPath = useUiStore((s) => s.repoPath);

  const enabled = status.data?.enabled ?? false;
  // Always read the device list, even while sharing is off: a paired device's
  // token persists across sharing being toggled, so the user must be able to see
  // and revoke standing access at any time (the guide promises exactly this).
  const devices = useLanDevices({ enabled: true });
  const deviceList = devices.data ?? [];

  // Shared repos are read the same way as devices — always, even while sharing
  // is off, since the shared set persists across toggling sharing.
  const sharedRepos = useLanSharedRepos({ enabled: true });
  const sharedList = sharedRepos.data ?? [];
  const share = useLanShareRepo();
  const unshare = useLanUnshareRepo();

  const [pairOpen, setPairOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<LanDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const [sharedActiveIndex, setSharedActiveIndex] = useState(-1);
  const sharedListRef = useRef<HTMLDivElement>(null);

  function toggle(next: boolean) {
    setError(null);
    if (next) {
      // The panel always binds to the LAN — loopback-only is a dev/test mode.
      enable.mutate(true, { onError: (e) => setError(errorMessage(e)) });
    } else {
      disable.mutate(undefined, { onError: (e) => setError(errorMessage(e)) });
    }
  }

  // Clamp a stale active index when rows are removed (revoke).
  const safeActive =
    activeIndex >= deviceList.length ? deviceList.length - 1 : activeIndex;
  const onKeyDown = listKeyboardNav<LanDevice>({
    items: deviceList,
    activeIndex: safeActive,
    onActivate: (_d, to) => setActiveIndex(to),
    rowKey: (d) => d.id,
    rowAttr: "data-device-row",
  });

  // Same roving-focus pattern for the shared-repos list, keyed by path.
  const safeSharedActive =
    sharedActiveIndex >= sharedList.length
      ? sharedList.length - 1
      : sharedActiveIndex;
  const onSharedKeyDown = listKeyboardNav<LanSharedRepo>({
    items: sharedList,
    activeIndex: safeSharedActive,
    onActivate: (_r, to) => setSharedActiveIndex(to),
    rowKey: (r) => r.path,
    rowAttr: "data-shared-repo-row",
  });

  // "Share current repository" is available only when a repo is open and it
  // isn't already shared — surface each reason so the disabled button explains
  // itself (house rule: no silent disabled controls).
  const alreadyShared =
    repoPath !== null && sharedList.some((r) => r.path === repoPath);
  const shareDisabledReason = !repoPath
    ? "Open a repository first, then share it with your phone."
    : alreadyShared
      ? "This repository is already shared."
      : null;

  function shareCurrentRepo() {
    if (!repoPath) return;
    share.mutate(repoPath, { onError: (e) => setError(errorMessage(e)) });
  }

  const toggleBusy = enable.isPending || disable.isPending;
  const pairDisabledReason = enabled
    ? null
    : "Turn on sharing first, then pair a device.";

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">
          Phone companion{" "}
          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
            Experimental
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Share the open repository — and any repositories you add below — with
          your phone over your local network. Scanning the pairing code opens
          the companion app in your phone's browser —{" "}
          <strong className="font-medium">read-only</strong> status, changes,
          history, branches, pull requests, issues, and CI. Early preview.
        </p>
      </div>

      {/* The enable toggle — runtime state from the backend, not a settings
          draft, so it applies immediately (no Save bar). */}
      <div className="flex items-center justify-between gap-3 rounded border px-3 py-2.5">
        <label
          htmlFor="companion-enabled"
          className="cursor-pointer text-xs font-medium"
        >
          Share with your phone on this network
        </label>
        <div className="flex items-center gap-2">
          {toggleBusy && <Spinner className="size-3.5" />}
          <Switch
            id="companion-enabled"
            checked={enabled}
            disabled={toggleBusy || status.isPending}
            onCheckedChange={toggle}
            aria-label="Share with your phone on this network"
          />
        </div>
      </div>

      {error !== null && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {/* The honest security caveat — always visible, never a tooltip. */}
      <p className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
        Anyone on this Wi-Fi with the pairing PIN can read this repo while
        sharing is on. Traffic is encrypted with a certificate this app
        generates, so your phone asks you to confirm it on first connect. Use it
        on trusted networks only, and turn sharing off when you're done.
      </p>

      {/* Keep-awake is always-on while sharing (no toggle) — disclose it so the
          behavior isn't a surprise. */}
      <p className="text-xs text-muted-foreground">
        While sharing is on, your computer won't go to sleep (the display still
        can).
      </p>

      {enabled && status.data && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {status.data.urls.length > 0 ? (
            <p>
              Reachable at{" "}
              {status.data.urls.map((url, i) => (
                <span key={url}>
                  {i > 0 && ", "}
                  <span className="font-mono select-all">{url}</span>
                </span>
              ))}
            </p>
          ) : (
            <p>
              Sharing on port{" "}
              <span className="font-mono">{status.data.port}</span> — no network
              address detected. Check you're connected to Wi-Fi.
            </p>
          )}
          {status.data.certFingerprint !== null && (
            <p>
              Certificate SHA-256:{" "}
              <span className="font-mono break-all select-all">
                {status.data.certFingerprint}
              </span>
            </p>
          )}
        </div>
      )}

      {/* Shared repositories — repos that stay reachable even when a different
          repo is open on the desktop. The open repo is always reachable on its
          own; sharing keeps others live while you work elsewhere. */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium">Shared repositories</h3>
          <p className="text-[11px] text-muted-foreground">
            Keep repositories reachable from your phone even when they're not
            the one open here.
          </p>
        </div>
        {/* Disabled buttons don't show a native `title`, so wrap it. */}
        <span title={shareDisabledReason ?? undefined} className="inline-flex">
          <Button
            variant="outline"
            size="sm"
            disabled={shareDisabledReason !== null || share.isPending}
            onClick={shareCurrentRepo}
          >
            {share.isPending && <Spinner data-icon="inline-start" />}
            Share current repository
          </Button>
        </span>
      </div>

      {sharedRepos.isPending ? (
        // First fetch: shared repos may exist, so show a placeholder rather than
        // flashing the empty-state copy.
        <Skeleton className="h-16 w-full" />
      ) : sharedRepos.isError ? (
        <p className="text-xs text-muted-foreground">
          Couldn't load shared repositories.
        </p>
      ) : sharedList.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Only the repository open on this desktop is visible to phones. Share
          repositories to keep them reachable while you work elsewhere.
        </p>
      ) : (
        // A roving-focus list (arrow keys move between rows).
        <div
          ref={sharedListRef}
          onKeyDown={onSharedKeyDown}
          className="space-y-2"
        >
          {sharedList.map((repo, i) => (
            <div
              key={repo.path}
              data-shared-repo-row={repo.path}
              aria-label={`Shared repository ${repo.name}, ${repo.path}`}
              tabIndex={
                i === safeSharedActive || (safeSharedActive === -1 && i === 0)
                  ? 0
                  : -1
              }
              onFocus={() => setSharedActiveIndex(i)}
              className="flex items-center gap-2 rounded border px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{repo.name}</p>
                {/* Truncate from the START so the meaningful tail of the path
                    stays visible: an RTL block places the ellipsis at the left,
                    and a bdi/ltr child keeps the path's own characters in
                    left-to-right order. */}
                <p
                  dir="rtl"
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={repo.path}
                >
                  <bdi dir="ltr">{repo.path}</bdi>
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0"
                disabled={unshare.isPending}
                onClick={() =>
                  unshare.mutate(repo.path, {
                    onError: (e) => setError(errorMessage(e)),
                  })
                }
                aria-label={`Unshare ${repo.name}`}
              >
                Unshare
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium">Paired devices</h3>
          <p className="text-[11px] text-muted-foreground">
            Each device holds its own token you can revoke at any time.
          </p>
        </div>
        {/* Disabled buttons don't show a native `title`, so wrap it. */}
        <span title={pairDisabledReason ?? undefined} className="inline-flex">
          <Button
            variant="outline"
            size="sm"
            disabled={!enabled}
            onClick={() => setPairOpen(true)}
          >
            <DeviceMobileIcon data-icon="inline-start" /> Pair a device
          </Button>
        </span>
      </div>

      {devices.isPending ? (
        // First fetch: paired devices may exist, so don't flash the empty-state
        // copy — show a placeholder of roughly list-row height instead.
        <Skeleton className="h-16 w-full" />
      ) : devices.isError ? (
        // A failed read is not "no devices" — paired devices may exist, so never
        // show the empty-state copy on error.
        <p className="text-xs text-muted-foreground">
          Couldn't load paired devices.
        </p>
      ) : deviceList.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {enabled
            ? "No devices paired yet. Choose “Pair a device” to add your phone."
            : "Turn on sharing to pair a device."}
        </p>
      ) : (
        <>
          {/* Paired tokens persist while sharing is off, so the list stays
              visible and revocable — but note they can't connect right now. */}
          {!enabled && (
            <p className="text-xs text-muted-foreground">
              These devices can connect the next time sharing is on.
            </p>
          )}
          {/* A roving-focus list (arrow keys move between rows). */}
          <div ref={listRef} onKeyDown={onKeyDown} className="space-y-2">
            {deviceList.map((device, i) => (
              <div
                key={device.id}
                data-device-row={device.id}
                aria-label={`${device.name}, ${device.scope}, last seen ${formatRelativeTime(
                  device.lastSeenAt,
                )}`}
                tabIndex={
                  i === safeActive || (safeActive === -1 && i === 0) ? 0 : -1
                }
                onFocus={() => setActiveIndex(i)}
                className="flex items-center gap-2 rounded border px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="shrink-0 text-xs font-medium">
                  {device.name}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
                  {device.scope}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  paired {formatRelativeTime(device.createdAt)} · seen{" "}
                  {formatRelativeTime(device.lastSeenAt)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setConfirmRevoke(device)}
                  aria-label={`Revoke ${device.name}`}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </>
      )}

      <PairDeviceDialog open={pairOpen} onOpenChange={setPairOpen} />

      <Dialog
        open={confirmRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRevoke(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke access?</DialogTitle>
            <DialogDescription>
              {confirmRevoke?.name} will immediately lose access to this repo.
              It'll need to pair again to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRevoke(null)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => {
                if (!confirmRevoke) return;
                revoke.mutate(confirmRevoke.id, {
                  onSettled: () => setConfirmRevoke(null),
                });
              }}
            >
              {revoke.isPending && <Spinner data-icon="inline-start" />}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
