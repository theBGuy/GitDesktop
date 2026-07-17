import { useEffect, useEffectEvent, useRef, useState } from "react";
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
import { errorMessage } from "@/lib/tauri/invoke";
import {
  useLanDevices,
  useLanPairingCancel,
  useLanPairingStart,
} from "@/lib/git/queries";
import type { LanPairing } from "@/lib/git/types";

/** Remaining whole seconds until `expiresAt`, clamped at 0. */
function secondsLeft(expiresAt: string): number {
  return Math.max(
    0,
    Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
}

interface PairDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The pairing flow: open a pairing window on the backend, show its QR + URL +
 * PIN, and poll the device list until a new device appears. Closing/canceling
 * the dialog cancels the pairing window (best-effort). On expiry the user can
 * start again.
 */
export function PairDeviceDialog({
  open,
  onOpenChange,
}: PairDeviceDialogProps) {
  const start = useLanPairingStart();
  const cancel = useLanPairingCancel();
  const [pairing, setPairing] = useState<LanPairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [pairedName, setPairedName] = useState<string | null>(null);

  // Wall-clock time (ms) the current pairing session started. A device counts as
  // freshly paired only if its `createdAt` is at/after this, so a PRE-EXISTING
  // device can't be misdetected as new when the parent's device query hadn't
  // resolved at open time (an id snapshot would have been empty). Server and UI
  // share this machine's clock; the 5s slack below absorbs any tiny skew/latency.
  const startTimeRef = useRef(0);

  // Poll devices only while the dialog is open and we're still waiting for one.
  const devices = useLanDevices({
    enabled: open && pairedName === null,
    refetchInterval: open && pairedName === null ? 1500 : false,
  });

  // Begin (or restart) a pairing window. Not an effect-event: it's also called
  // from the "Start again" button.
  function begin() {
    setError(null);
    setPairedName(null);
    // Mark this session's start BEFORE requesting the offer, so any device that
    // pairs against it is timestamped at/after this.
    startTimeRef.current = Date.now();
    start.mutate(undefined, {
      onSuccess: (p) => {
        setPairing(p);
        setRemaining(secondsLeft(p.expiresAt));
      },
      onError: (e) => setError(errorMessage(e)),
    });
  }

  // Open/close side effects, as effect-events so the open-transition effect can
  // depend on `open` alone (no re-runs when the mutations' identities change).
  const onOpen = useEffectEvent(() => {
    begin();
  });
  const onClose = useEffectEvent(() => {
    setPairing(null);
    setError(null);
    setPairedName(null);
    cancel.mutate(); // best-effort — drop the live pairing offer server-side
  });

  // Fire exactly on the open→close and close→open edges (the ref guards against
  // re-running the same transition).
  const openedRef = useRef(false);
  useEffect(() => {
    if (open && !openedRef.current) {
      openedRef.current = true;
      onOpen();
    } else if (!open && openedRef.current) {
      openedRef.current = false;
      onClose();
    }
  }, [open]);

  // Countdown tick while a pairing offer is live and unclaimed.
  useEffect(() => {
    if (!open || !pairing || pairedName !== null) return;
    const id = setInterval(
      () => setRemaining(secondsLeft(pairing.expiresAt)),
      1000,
    );
    return () => clearInterval(id);
  }, [open, pairing, pairedName]);

  // Detect a newly-paired device: one created at/after this pairing session
  // started (with 5s slack for clock skew), NOT a pre-existing device.
  useEffect(() => {
    if (!open || pairedName !== null || !devices.data) return;
    const threshold = startTimeRef.current - 5000;
    const fresh = devices.data.find(
      (d) => new Date(d.createdAt).getTime() >= threshold,
    );
    if (fresh) setPairedName(fresh.name);
  }, [open, devices.data, pairedName]);

  const expired = pairing !== null && remaining <= 0 && pairedName === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            On your phone, scan this code (or open the URL) and enter the PIN to
            pair. Keep this window open until it connects.
          </DialogDescription>
        </DialogHeader>

        {pairedName !== null ? (
          <div className="space-y-2 py-2 text-center">
            <p className="text-sm font-medium text-success">
              {pairedName} paired
            </p>
            <p className="text-xs text-muted-foreground">
              It can now read this repo while sharing is on. Manage or revoke it
              from the device list.
            </p>
          </div>
        ) : error !== null ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : start.isPending || pairing === null ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Server-generated SVG (a QR image), NOT user content — safe to
                inline. Fixed-size box so layout is stable while it loads. */}
            <div
              aria-label="Pairing QR code"
              className="mx-auto flex size-48 items-center justify-center rounded border bg-white p-2 [&_svg]:size-full"
              dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
            />
            <div className="space-y-1 text-center">
              <p className="text-xs text-muted-foreground">
                Or open this URL on your phone:
              </p>
              <p className="font-mono text-xs break-all select-all">
                {pairing.url}
              </p>
            </div>
            <div className="space-y-1 text-center">
              <p className="text-xs text-muted-foreground">PIN</p>
              <p className="font-mono text-2xl font-semibold tracking-[0.3em] select-all">
                {pairing.pin}
              </p>
              <p className="text-xs text-muted-foreground" role="status">
                {expired
                  ? "This code has expired."
                  : `Expires in ${remaining}s`}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {pairedName !== null ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {(expired || error !== null) && (
                <Button onClick={begin} disabled={start.isPending}>
                  {start.isPending && <Spinner data-icon="inline-start" />}
                  Start again
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}