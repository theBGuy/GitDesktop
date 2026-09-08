import { toast } from "sonner";
import { create } from "zustand";
import { normPath } from "@/lib/git/path";
import { repoNameFromPath } from "./notifications";
import { useUiStore } from "./ui";

/** What one finished generation has to hand back to a form. */
export interface RepoDescResult {
  description: string;
  topics: string[];
}

/**
 * AI description generations, held outside the settings dialog's tree: the
 * dialog unmounts on close and the rail unmounts the outgoing section on every
 * switch, so a stream settling afterwards would land on a dead component and a
 * paid run would be lost. Claimed here, its result is delivered to a mounted
 * section or stashed for the next one. Keyed by {@link normPath} repo path and
 * never cleared on repo switch — a run belongs to the repo it started in.
 *
 * The key is the CHECKOUT path, not `--git-common-dir`: this is ephemeral UI
 * bookkeeping rather than app data, and two worktrees of one repo run two
 * independent lanes with their own dialogs. PublishDialog's generator stays
 * outside this lane deliberately — an unpublished repo and a remote admin's
 * settings barely overlap, and it does its own finish-and-surface.
 */
interface RepoDescGenerationState {
  /** repo key → the running generation's abort hook. Presence IS the busy flag,
   *  so a reopened section paints busy for a run it never started. */
  inFlight: Record<string, { cancel: () => void }>;
  /** repo key → a result that settled with no section mounted to take it. */
  pending: Record<string, RepoDescResult>;
}

const useStore = create<RepoDescGenerationState>()(() => ({
  inFlight: {},
  pending: {},
}));

/** Mounted sections waiting for a result, newest last. A stack rather than one
 *  slot: each unregister splices only itself, so an unmounting section can never
 *  linger as the recipient while a live one exists. Listeners never affect
 *  rendering, so they live beside the store, not in its state. */
const listeners = new Map<string, ((result: RepoDescResult) => void)[]>();

/** Repos whose settings dialog is mounted. Its host DROPS a request to open it
 *  while it is already open, so a "View" action offered then would be dead. */
const openDialogs = new Map<string, number>();

/** Marks this repo's settings dialog as mounted; call the returned function on
 *  unmount. */
export function registerRepoSettingsOpenMarker(repoPath: string): () => void {
  return mark(openDialogs, normPath(repoPath));
}

/** Repos whose settings dialog is showing its General section. The crossfade
 *  keeps an EXITING section mounted — listener included — for the whole fade,
 *  so delivery follows the dialog's own view, which is outside the animation. */
const generalSections = new Map<string, number>();

/** Marks this repo's General section as the dialog's active one; call the
 *  returned function when it stops being active. */
export function registerRepoDescActiveSection(repoPath: string): () => void {
  return mark(generalSections, normPath(repoPath));
}

/** Counted rather than a flag, so overlapping registrations for one key —
 *  StrictMode's double-invoke included — can't clear each other. */
function mark(counts: Map<string, number>, key: string): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return () => {
    const count = counts.get(key);
    if (count === undefined) return;
    if (count > 1) counts.set(key, count - 1);
    else counts.delete(key);
  };
}

/**
 * Claims the lane for one repo. Returns false when a generation is already
 * running there — the caller no-ops, because whatever surface is mounted already
 * paints the busy affordance for it. Call this synchronously before the first
 * await: the stream runs for a while behind a closed dialog.
 */
export function claimRepoDescGeneration(
  repoPath: string,
  cancel: () => void,
): boolean {
  const repo = normPath(repoPath);
  if (useStore.getState().inFlight[repo]) return false;
  useStore.setState((s) => ({
    inFlight: { ...s.inFlight, [repo]: { cancel } },
  }));
  return true;
}

/** Long enough to outlast the section crossfade, so the fallback announcement
 *  only fires when the arriving General section really never mounted. */
const PENDING_ANNOUNCE_DELAY_MS = 800;

/**
 * Releases the lane and routes the outcome. `null` (bailed, aborted, or errored)
 * only frees it — those paths have already toasted for themselves. A result goes
 * to the newest listener while General is the live section; otherwise it waits
 * in `pending` and gets announced, at once or once the crossfade has had its
 * chance — a result nobody can see is what this store prevents.
 */
export function settleRepoDescGeneration(
  repoPath: string,
  result: RepoDescResult | null,
): void {
  const repo = normPath(repoPath);
  useStore.setState((s) => {
    if (!s.inFlight[repo]) return s;
    const { [repo]: _settled, ...rest } = s.inFlight;
    return { inFlight: rest };
  });
  if (!result) return;
  // Deliver only while General is the dialog's active section: a section on its
  // way out still holds a registered listener, and applying there writes into a
  // form that is about to be discarded.
  const generalActive = generalSections.has(repo);
  if (generalActive) {
    const apply = listeners.get(repo)?.at(-1);
    if (apply) {
      apply(result);
      return;
    }
  }
  useStore.setState((s) => ({ pending: { ...s.pending, [repo]: result } }));
  if (!generalActive) {
    announcePendingRepoDesc(repoPath);
    return;
  }
  // Mid-switch ONTO General: the arriving section is expected to consume this,
  // but leaving or closing inside the fade breaks that promise, so one timer
  // turns a stash nobody claimed into a late announcement.
  setTimeout(() => {
    if (!useStore.getState().pending[repo]) return;
    if (listeners.get(repo)?.length) return;
    announcePendingRepoDesc(repoPath);
  }, PENDING_ANNOUNCE_DELAY_MS);
}

/** The live announcement per repo. The toast is the stash's public face: once
 *  the pending result has been delivered or replaced, a surviving View is a
 *  dead click at a dialog that is already open. */
const announceToasts = new Map<string, string | number>();

function retireAnnounceToast(repo: string): void {
  const id = announceToasts.get(repo);
  if (id === undefined) return;
  toast.dismiss(id);
  announceToasts.delete(repo);
}

/** The one announcement for a stashed result. Its copy is decided at FIRE time
 *  because the fallback can run long after the settle: while the dialog is open
 *  its host drops a deep link, so that arm points at the section instead. */
function announcePendingRepoDesc(repoPath: string): void {
  const repo = normPath(repoPath);
  // One live announcement per repo — a fresh stash replaces its predecessor's.
  retireAnnounceToast(repo);
  const dialogOpen = openDialogs.has(repo);
  const id = toast.success("Repository description ready", {
    description: dialogOpen
      ? "Switch to the General section to review it."
      : "Reopen Repository settings to review.",
    duration: 10_000,
    ...(dialogOpen
      ? {}
      : {
          action: {
            label: "View",
            onClick: () => {
              const ui = useUiStore.getState();
              // The request targets the ACTIVE repo. Away from it the result is
              // still recoverable, so say where rather than doing nothing —
              // clicking dismisses the toast, and with it the only pointer.
              if (normPath(ui.repoPath ?? "") !== repo) {
                // Name off the RAW path — the key is lower-cased for comparison.
                toast.info(
                  `Waiting in ${repoNameFromPath(repoPath)} — switch back to see it.`,
                );
                return;
              }
              ui.requestRepoSettings("general", repoPath);
            },
          },
        }),
  });
  announceToasts.set(repo, id);
}

/** Registers a mounted section's field-apply for one repo; call the returned
 *  function on unmount. */
export function registerRepoDescListener(
  repoPath: string,
  apply: (result: RepoDescResult) => void,
): () => void {
  const repo = normPath(repoPath);
  const stack = listeners.get(repo) ?? [];
  stack.push(apply);
  listeners.set(repo, stack);
  return () => {
    const cur = listeners.get(repo);
    if (!cur) return;
    const i = cur.indexOf(apply);
    if (i !== -1) cur.splice(i, 1);
    if (cur.length === 0) listeners.delete(repo);
  };
}

/** Reads and clears the result a closed dialog never got to show. */
export function consumePendingRepoDesc(
  repoPath: string,
): RepoDescResult | null {
  const repo = normPath(repoPath);
  const result = useStore.getState().pending[repo];
  if (!result) return null;
  // The stash is being delivered, so its announcement has been made good.
  retireAnnounceToast(repo);
  useStore.setState((s) => {
    const { [repo]: _taken, ...rest } = s.pending;
    return { pending: rest };
  });
  return result;
}

/** Aborts the running generation for one repo — the affordance a section that
 *  remounted over an orphaned run needs. The stream's own settle clears the
 *  lane; a missing entry is a no-op. */
export function cancelRepoDescGeneration(repoPath: string): void {
  useStore.getState().inFlight[normPath(repoPath)]?.cancel();
}

/** True while a description generation is running for this repo, whichever
 *  surface started it. */
export function useIsGeneratingRepoDesc(repoPath: string): boolean {
  return useStore((s) => Boolean(s.inFlight[normPath(repoPath)]));
}
