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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  useLanDeviceRevoke,
  useLanDevices,
  useLanDisable,
  useLanEnable,
  useLanStatus,
} from "@/lib/git/queries";
import type { LanDevice } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { errorMessage } from "@/lib/tauri/invoke";
import { formatRelativeTime } from "@/lib/time";
import { PairDeviceDialog } from "./PairDeviceDialog";

export function CompanionSection() {
  const status = useLanStatus();
  const enable = useLanEnable();
  const disable = useLanDisable();
  const revoke = useLanDeviceRevoke();

  const enabled = status.data?.enabled ?? false;
  // Read the device list only while sharing is on (nothing to show otherwise).
  const devices = useLanDevices({ enabled });
  const deviceList = devices.data ?? [];

  const [pairOpen, setPairOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<LanDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

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
          Share the open repository with your phone over your local network.
          This is an early preview: it exposes a{" "}
          <strong className="font-medium">read-only</strong> API for the open
          repo, and the companion phone app arrives in an upcoming release.
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
        sharing is on. It's unencrypted on your local network — use it on
        trusted networks only. Turn sharing off when you're done.
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

      {deviceList.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {enabled
            ? "No devices paired yet. Choose “Pair a device” to add your phone."
            : "Turn on sharing to pair a device."}
        </p>
      ) : (
        // A roving-focus list (arrow keys move between rows).
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
