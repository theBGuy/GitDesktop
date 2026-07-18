import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, pairChallenge, pairSubmit } from "../lib/api";
import { markPaired } from "../lib/pairing-signal";
import { navigate } from "../lib/router";
import { computeProof } from "../lib/sha256";

// The pairing screen. The desktop shows a QR + a 6-digit PIN; the phone lands
// here (via the QR's `#pair` url), the user types the PIN, and we run the
// challenge/response so the PIN never travels the wire.

type PairState =
  | { kind: "entry" }
  | { kind: "submitting" }
  | { kind: "wrongPin" }
  | { kind: "locked"; retryAfter: number | null }
  | { kind: "waiting" }
  | { kind: "error"; message: string }
  | { kind: "success" };

const PIN_LENGTH = 6;

/** A stable device name from the browser UA — best-effort, user-editable later
 *  is out of scope for this slice. */
function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua)) return "iPad";
  if (/android/i.test(ua)) return "Android phone";
  return "Phone";
}

export function Pair() {
  const [pin, setPin] = useState("");
  const [state, setState] = useState<PairState>({ kind: "entry" });
  const queryClient = useQueryClient();

  async function submit(pinValue: string) {
    setState({ kind: "submitting" });
    try {
      const { challenge, salt } = await pairChallenge();
      const proof = computeProof(pinValue, salt, challenge);
      await pairSubmit(defaultDeviceName(), proof);
      // The server set the `gd_lan` cookie; the browser now authenticates
      // automatically.
      //
      // LIVE-FOUND RACE (post-pair bounce): while the user sat on #pair, the
      // shell's `["status"]` probe cached a 401 (no cookie yet). If we navigate
      // to #status now, the shell's 401→#pair redirect reads that STALE 401 and
      // bounces straight back to the PIN screen. Defeat it on BOTH sides:
      //   1) here — stamp `markPaired()` (so the redirect can tell a pre-pair
      //      401 from a fresh one), then RESET the status query and AWAIT its
      //      refetch so the cache holds an authenticated 200 before we navigate;
      //   2) in App.tsx — the redirect ignores any 401 older than `markPaired()`.
      markPaired();
      setState({ kind: "success" });
      await queryClient.resetQueries({ queryKey: ["status"] });
      // Keep the brief success confirmation, then head to Status with fresh auth
      // state already in the cache.
      window.setTimeout(() => navigate("#status"), 900);
    } catch (e) {
      handleError(e);
    }
  }

  function handleError(e: unknown) {
    if (e instanceof ApiError) {
      if (e.isRateLimited) {
        setState({ kind: "locked", retryAfter: e.retryAfter });
        return;
      }
      // A wrong PIN comes back 401 (from submit). A missing/expired offer comes
      // back 403 `pairingInactive` (from EITHER challenge or submit) — that's not
      // an error, it means the desktop has no live offer, so show the calm
      // waiting state that auto-re-checks.
      if (e.isPairingInactive) {
        setState({ kind: "waiting" });
        return;
      }
      if (e.status === 401) {
        setPin("");
        setState({ kind: "wrongPin" });
        return;
      }
      setState({ kind: "error", message: e.message });
      return;
    }
    setState({ kind: "error", message: "Pairing failed. Please try again." });
  }

  function onPinChange(value: string) {
    // Don't accept edits mid-submit (or after success) — the input is disabled
    // while submitting, but guard anyway so a stray change can't double-fire.
    if (state.kind === "submitting" || state.kind === "success") return;
    const digits = value.replace(/\D/g, "").slice(0, PIN_LENGTH);
    setPin(digits);
    if (state.kind === "wrongPin" || state.kind === "error") {
      setState({ kind: "entry" });
    }
    if (digits.length === PIN_LENGTH) {
      void submit(digits);
    }
  }

  if (state.kind === "success") {
    return (
      <CenteredPair
        icon={<CheckCircleIcon size={40} className="text-success" />}
        title="Paired!"
        body="Taking you to your repository…"
      />
    );
  }

  if (state.kind === "waiting") {
    return <WaitingForDesktop onOfferLive={() => resetTo(setPin, setState)} />;
  }

  if (state.kind === "locked") {
    return (
      <LockedOut
        retryAfter={state.retryAfter}
        onTryAgain={() => resetTo(setPin, setState)}
      />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-8 py-12 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-foreground">
          Pair with GitDesktop
        </h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          Enter the 6-digit code shown on your desktop.
        </p>
      </div>

      <label className="flex w-full max-w-xs flex-col items-center gap-2">
        <span className="sr-only">Pairing PIN</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          aria-label="Pairing PIN"
          aria-invalid={state.kind === "wrongPin"}
          disabled={state.kind === "submitting"}
          value={pin}
          onChange={(e) => onPinChange(e.target.value)}
          // A single-purpose pairing screen — the PIN field is the only
          // interactive element, so autofocus is right (raises the phone keyboard
          // immediately). This repo's biome config doesn't flag noAutofocus, so
          // no suppression is needed.
          autoFocus
          className="w-full rounded-md border border-border bg-card px-4 py-3 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums text-foreground outline-none focus-visible:border-primary"
          placeholder="000000"
        />
      </label>

      {state.kind === "wrongPin" ? (
        <p
          className="flex items-center gap-1.5 text-sm text-destructive"
          role="alert"
        >
          <WarningCircleIcon size={16} />
          That code didn't match. Check the desktop and try again.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p
          className="flex items-center gap-1.5 text-sm text-destructive"
          role="alert"
        >
          <WarningCircleIcon size={16} />
          {state.message}
        </p>
      ) : null}
      {state.kind === "submitting" ? (
        <p className="text-sm text-muted-foreground">Pairing…</p>
      ) : null}
    </div>
  );
}

function resetTo(
  setPin: (v: string) => void,
  setState: (s: PairState) => void,
) {
  setPin("");
  setState({ kind: "entry" });
}

function CenteredPair({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 py-12 text-center">
      {icon}
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">{body}</p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 inline-flex min-h-11 items-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** How often the waiting state re-checks whether the desktop has a live pairing
 *  offer. Deliberately gentle — the desktop user is walking over to click "Pair
 *  a device", not racing a clock. */
const WAITING_RECHECK_MS = 4000;

/** The calm "no active offer yet" state. Polls the challenge endpoint on a gentle
 *  interval; the first success means the desktop now has a live offer, so it hands
 *  control back to the PIN entry via `onOfferLive`. */
function WaitingForDesktop({ onOfferLive }: { onOfferLive: () => void }) {
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function recheck() {
      // Skip if a prior probe is still outstanding (slow network) — never stack
      // requests. The server no longer counts a challenge with no active session
      // as a rate-limit failure, but the client stays polite regardless: one
      // probe at a time, on a slow interval.
      if (inFlight) return;
      inFlight = true;
      try {
        await pairChallenge();
        // Succeeded → an offer is live now. Return to entry so the user can type
        // the new PIN.
        if (!cancelled) onOfferLive();
      } catch {
        // Still inactive (or a transient error) — keep waiting; the next tick
        // re-checks. No state change, so the calm screen stays put.
      } finally {
        inFlight = false;
      }
    }

    const id = window.setInterval(recheck, WAITING_RECHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [onOfferLive]);

  return (
    <CenteredPair
      icon={<WarningCircleIcon size={40} className="text-muted-foreground" />}
      title="Waiting for your desktop"
      body="In GitDesktop, choose Settings → Phone companion → Pair a device, then scan the new code or enter the new PIN."
    />
  );
}

/** The rate-limited state with a LIVE countdown. Ticks the remaining seconds down
 *  each second from the server's `Retry-After`; the "Try again" button is disabled
 *  and muted while the count is running, and lights up at zero. (A missing
 *  `Retry-After` → no countdown, button immediately enabled.) */
function LockedOut({
  retryAfter,
  onTryAgain,
}: {
  retryAfter: number | null;
  onTryAgain: () => void;
}) {
  const [remaining, setRemaining] = useState(
    retryAfter && retryAfter > 0 ? retryAfter : 0,
  );

  useEffect(() => {
    if (remaining <= 0) return;
    const id = window.setInterval(() => {
      setRemaining((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [remaining]);

  const counting = remaining > 0;
  const body = counting
    ? `For safety, the desktop paused pairing from this device for a short while. Try again in ${remaining} second${remaining === 1 ? "" : "s"}.`
    : "For safety, the desktop paused pairing from this device for a short while. You can try again now.";

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 py-12 text-center">
      <WarningCircleIcon size={40} className="text-destructive" />
      <h1 className="text-lg font-semibold text-foreground">
        Too many attempts.
      </h1>
      <p className="max-w-xs text-sm text-muted-foreground">{body}</p>
      <button
        type="button"
        onClick={onTryAgain}
        disabled={counting}
        aria-disabled={counting}
        className={`mt-2 inline-flex min-h-11 items-center rounded-md px-5 py-2 text-sm font-medium ${
          counting
            ? "bg-muted text-muted-foreground"
            : "bg-primary text-primary-foreground"
        }`}
      >
        {counting ? `Try again in ${remaining}s` : "Try again"}
      </button>
    </div>
  );
}
