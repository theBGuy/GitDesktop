import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { queryClient } from "@/lib/query-client";
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
 *  being offline is exactly when this asks. */
export async function confirmDiscardParkedWrites(
  action: DiscardingAction,
): Promise<boolean> {
  if (!hasParkedWrites()) return true;
  const copy = DISCARD_COPY[action];
  return useConfirm.getState().ask({
    title: copy.title,
    body: `Some changes are waiting to send once you're back online. ${copy.consequence}`,
    confirmLabel: copy.confirmLabel,
    confirmVariant: "destructive",
  });
}

let mirrored: boolean | undefined;

function pushParked(parked: boolean) {
  mirrored = parked;
  invoke<void>("set_parked_writes", { parked }).catch(() => {
    // Forget a push that never landed, so the next cache event retries it.
    if (mirrored === parked) mirrored = undefined;
  });
}

/** Mirrors parked-write presence into the backend, which owns the quit decision
 *  (the tray's Quit never passes through the webview). Pushes on subscribe, as a
 *  reloaded webview leaves the mirror stale, then only when the zero boundary is
 *  crossed. Returns the unsubscribe. */
function mirrorParkedWrites(): () => void {
  pushParked(hasParkedWrites());
  return queryClient.getMutationCache().subscribe(() => {
    const parked = hasParkedWrites();
    if (parked !== mirrored) pushParked(parked);
  });
}

async function onQuitRequested() {
  // The ack tells the backend the prompt is on screen, so a later quit asks
  // again rather than reading the webview as hung and exiting.
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
