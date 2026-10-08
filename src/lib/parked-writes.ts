import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { queryClient } from "@/lib/query-client";
import { serializedMirror } from "@/lib/serialized-mirror";
import { useConfirm } from "@/lib/stores/confirm";
import { invoke } from "@/lib/tauri/invoke";

/** Whether any write is parked: pressed, then paused before its request until
 *  the connection returns. The mutation cache lives only in memory, so anything
 *  that ends the process discards these. */
function hasParkedWrites(): boolean {
  return (
    queryClient.getMutationCache().findAll({
      status: "pending",
      predicate: (mutation) => mutation.state.isPaused,
    }).length > 0
  );
}

type DiscardingAction = "quit" | "update";

const DISCARD_COPY: Record<
  DiscardingAction,
  { title: string; consequence: string; confirmLabel: string }
> = {
  quit: {
    title: "Quit with unsent changes?",
    consequence: "Quitting now discards them.",
    confirmLabel: "Quit anyway",
  },
  update: {
    title: "Install the update with unsent changes?",
    consequence: "Restarting to install the update discards them.",
    confirmLabel: "Install anyway",
  },
};

/** Whether `action` may go ahead: at once with nothing parked, otherwise once
 *  the user confirms discarding the parked writes. Never held offline, since
 *  being offline is exactly when this asks. `onAsk` runs only when it does ask,
 *  just before the prompt opens. */
export async function confirmDiscardParkedWrites(
  action: DiscardingAction,
  onAsk?: () => void,
): Promise<boolean> {
  if (!hasParkedWrites()) return true;
  onAsk?.();
  const copy = DISCARD_COPY[action];
  return useConfirm.getState().ask({
    title: copy.title,
    body: `Some changes are waiting to send once you're back online. ${copy.consequence}`,
    confirmLabel: copy.confirmLabel,
    confirmVariant: "destructive",
  });
}

// `set_parked_writes` is async, so two calls can land out of order; pushes are
// serialized, so the backend always converges to the latest value.
const pushParked = serializedMirror((parked: boolean) =>
  invoke<void>("set_parked_writes", { parked }),
);

/** Mirrors parked-write presence into the backend, which owns the quit decision
 *  (the tray's Quit never passes through the webview). Reports on subscribe, as
 *  a reloaded webview leaves the backend's copy stale, then on every cache event:
 *  the mirror sends only a value that differs from what landed, and a failed
 *  push is retried by the next event. Returns the unsubscribe. */
function mirrorParkedWrites(): () => void {
  pushParked(hasParkedWrites());
  return queryClient
    .getMutationCache()
    .subscribe(() => pushParked(hasParkedWrites()));
}

async function onQuitRequested() {
  // The ack, sent before asking, tells the backend this listener ran, so a later
  // quit asks again rather than reading the webview as hung and exiting.
  if (hasParkedWrites()) {
    await invoke<void>("quit_prompt_shown").catch(() => undefined);
  }
  if (await confirmDiscardParkedWrites("quit")) {
    await invoke<void>("quit_app");
  } else {
    // A re-emitted prompt replaces this one, whose `false` lands here and clears
    // the newer prompt's stamp too: the next quit then just asks again.
    await invoke<void>("quit_prompt_closed");
  }
}

/** The quit guard's frontend half: the parked-writes mirror and the prompt the
 *  backend raises when a quit would discard them. Mounted once, in App. */
export function useQuitGuard() {
  useEffect(() => mirrorParkedWrites(), []);

  useEffect(() => {
    // No prompt survives a reload, so one the backend still counts as open
    // would make the next quit exit without asking.
    invoke<void>("quit_prompt_closed").catch(() => undefined);
    // `listen` subscribes asynchronously, so a StrictMode double-mount can tear
    // this effect down before the subscription exists — unlisten on arrival in
    // that case, since cleanup has nothing to unlisten yet.
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen("quit-requested", () => {
      onQuitRequested().catch(() => undefined);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
