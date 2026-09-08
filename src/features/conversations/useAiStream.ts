import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { createAiClient, MissingApiKeyError } from "@/lib/ai/client";
import { normPath } from "@/lib/git/path";
import { loadSettings } from "@/lib/settings/api";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

type Settings = Awaited<ReturnType<typeof loadSettings>>;

export interface AiStreamRequest {
  system: string;
  prompt: string;
}

/**
 * The streaming-AI scaffold shared by the PR-description and issue-draft
 * generators (and reusable by other one-shot generators): owns the
 * AbortController, the `generating` flag, settings load, client creation, the
 * for-await accumulation loop, and the MissingApiKeyError / error toasts.
 *
 * `buildRequest` does its own context fetch + prompt build and may return null
 * to bail silently (after toasting itself). `onChunk` fires with the cumulative
 * buffer per delta for live previews. `run` resolves with the final buffer, or
 * null if it bailed / aborted / errored, so the caller can parse the result.
 *
 * The one-shot generator path (`createAiClient`): HTTP providers stream over the
 * AI SDK, CLI providers stream from an agent-CLI subprocess through
 * `createAiClient`'s CLI branch — `repoPath` is forwarded to `client.stream` for
 * those (ignored by HTTP). Still intentionally separate from lib/ai/stream.ts's
 * `useAiTextStream` (the review path). CLI providers never throw
 * MissingApiKeyError — they're not in PROVIDERS_REQUIRING_KEY.
 */
export function useAiStream(repoPath: string) {
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const run = useCallback(
    async (
      buildRequest: (settings: Settings) => Promise<AiStreamRequest | null>,
      opts?: { onChunk?: (buffer: string) => void },
    ): Promise<string | null> => {
      const abort = new AbortController();
      abortRef.current = abort;
      setGenerating(true);
      try {
        const settings = await loadSettings();
        const request = await buildRequest(settings);
        if (!request) return null;
        const client = await createAiClient(settings.ai);
        let buffer = "";
        for await (const chunk of client.stream({
          system: request.system,
          prompt: request.prompt,
          abortSignal: abort.signal,
          repoPath,
        })) {
          buffer += chunk;
          opts?.onChunk?.(buffer);
        }
        return buffer;
      } catch (e) {
        if (!abort.signal.aborted) {
          if (e instanceof MissingApiKeyError) {
            toast.error(e.message, {
              duration: 8000,
              action: {
                label: "Open settings",
                onClick: () => useUiStore.getState().openSettings("ai"),
              },
            });
          } else {
            toastError(e);
          }
        }
        return null;
      } finally {
        setGenerating(false);
        abortRef.current = null;
      }
    },
    [repoPath],
  );

  return { generating, cancel, run };
}

/**
 * Cancels an in-flight generation when the entity on screen changes — the PR views
 * keep their edit dialog mounted across a switch, so a stream started on one PR would
 * otherwise keep writing into the next one's dialog.
 *
 * An EFFECT, not a render-time reset: cancelling aborts a live stream, and React may
 * discard and replay a render. The ref is seeded with the current identity, so
 * mounting cancels nothing, and it advances before the call so a re-render mid-cancel
 * can't fire twice. `cancel` rides an effect event, so a caller passing an unstable
 * function can't re-trigger the effect.
 */
export function useCancelOnIdentityChange(
  identity: string,
  cancel: () => void,
): void {
  const cancelNow = useEffectEvent(() => cancel());
  const activeFor = useRef(identity);
  useEffect(() => {
    if (activeFor.current === identity) return;
    activeFor.current = identity;
    cancelNow();
  }, [identity]);
}

/** Where a run that settles while its dialog is closed should surface. */
export interface FinishAndSurfaceOpts {
  /** toast.success title, e.g. "Pull request description ready". */
  readyTitle: string;
  /** Toast description, e.g. "It's waiting in the dialog." */
  readyDescription?: string;
  /** Reopens the surface (the toast's "View" action). Omit when no reliable
   *  reopen path exists from a toast. */
  reopen?: () => void;
}

/**
 * Closing a generator dialog never cancels its run — this decides where the
 * result lands instead. A run settling while the dialog is CLOSED latches
 * skip-seed (the reopen keeps the whole draft rather than resetting it) and, on
 * success, toasts with a "View" reopen; one settling while the dialog is OPEN is
 * already visible in place, so it latches nothing.
 *
 * The latch is a ref, so it survives an `<Activity>` tab hide (which tears down
 * effects but keeps refs) and dies with a true unmount, where nothing is left to
 * skip. The toast alone gates on effects being live, since after an unmount
 * there is no draft to promise — the accepted cost being that a run settling
 * while its host tab is hidden resurfaces silently on reopen instead of
 * toasting.
 *
 * A generation belongs to the repository it started in. `<RepositoryView>` is one
 * instance across repo switches, so the dialogs' state outlives the repo: a
 * switch therefore cancels the run and drops the latch (the identity-cancel the
 * edit views already use), and the toast's action refuses to fire once the live
 * repo is a different one. The draft a settled-but-unseen run left behind is
 * discarded by that switch — the toast announced it while the user was still in
 * the originating repo. `shouldSkipSeed` is the seed guard rather than each
 * caller's own `generating ||`, because `run` awaits its context fetch before
 * the stream and the abort reaches only the stream: a discarded run can keep
 * `generating` true for seconds, and a reopen inside that window must reseed.
 */
export function useFinishAndSurface(
  repoPath: string,
  open: boolean,
  opts: FinishAndSurfaceOpts & {
    /** This dialog's generation cancel — invoked when the repo changes. */
    cancel: () => void;
    /** Whether a run is in flight, so the switch's own abort can be told from a
     *  later genuine settle. */
    generating: boolean;
    /** Closes the dialog. Called when the repo changes with it still open: the
     *  draft on screen belongs to the repo the user just left. */
    close?: () => void;
  },
): {
  /** Report a run settling; ok = a non-null result landed. */
  noteRunSettled: (ok: boolean) => void;
  /** Whether the run in flight was discarded by an identity switch — a read,
   *  never a consume. Callers whose seed guard has further arms keyed on the
   *  form's retained values use it to skip them: those values are the old
   *  identity's. */
  runDiscardedBySwitch: () => boolean;
  /** Seed-guard predicate: true ⇒ the caller's seedOnOpen must return without
   *  reseeding. A live run justifies the skip only while it still belongs here —
   *  one discarded by an identity switch does not; failing that, a settled-unseen
   *  latch (consumed here) does. */
  shouldSkipSeed: (generating: boolean) => boolean;
  /** Consume the settled-while-closed latch; true ⇒ the caller's seedOnOpen
   *  must return without reseeding. */
  consumeSkipSeed: () => boolean;
} {
  const repo = normPath(repoPath);
  // Effects, never render-time ref writes: React may discard and replay a
  // render, and these flags are read from stream continuations outside render.
  // Both syncs are LAYOUT effects: a settle landing between the commit and a
  // passive flush would otherwise read the previous open state — missing the
  // latch, or toasting over a dialog that is back on screen.
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  const repoRef = useRef(repo);
  // The display name comes off the RAW path — the normalized key is lower-cased
  // for comparison only.
  const repoNameRef = useRef(repoNameFromPath(repoPath));
  useLayoutEffect(() => {
    repoRef.current = repo;
    repoNameRef.current = repoNameFromPath(repoPath);
  }, [repo, repoPath]);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const skipSeedRef = useRef(false);
  const abortedBySwitchRef = useRef(false);

  useCancelOnIdentityChange(repo, () => {
    skipSeedRef.current = false;
    // The abort's settle lands after this effect — a microtask later at best,
    // seconds later when the run is still in its context fetch. Without this the
    // discarded run would re-latch and the next repo's open would show its
    // partial draft.
    abortedBySwitchRef.current = opts.generating;
    opts.cancel();
    // A dialog left open now targets the new repo while holding the old repo's
    // draft; closing hands the next open back to the seed.
    if (openRef.current) opts.close?.();
  });

  const consumeLatch = () => {
    const skip = skipSeedRef.current;
    skipSeedRef.current = false;
    return skip;
  };

  return {
    noteRunSettled: (ok: boolean) => {
      if (abortedBySwitchRef.current) {
        abortedBySwitchRef.current = false;
        return;
      }
      if (openRef.current) return;
      skipSeedRef.current = true;
      if (!ok || !mountedRef.current) return;
      // The action outlives the repo the run belongs to, so it re-checks the
      // live repo rather than the one captured here. Sonner dismisses the toast
      // on any action click, so the mismatch arm has to say where the draft is
      // rather than swallow the user's only pointer to it.
      const settleRepo = repoRef.current;
      const settleRepoName = repoNameRef.current;
      const reopen = opts.reopen;
      toast.success(opts.readyTitle, {
        description: opts.readyDescription,
        duration: 10_000,
        action: reopen
          ? {
              label: "View",
              onClick: () => {
                const live = normPath(useUiStore.getState().repoPath ?? "");
                if (live === settleRepo) reopen();
                else
                  toast.info(
                    `Waiting in ${settleRepoName} — switch back to see it.`,
                  );
              },
            }
          : undefined,
      });
    },
    runDiscardedBySwitch: () => abortedBySwitchRef.current,
    shouldSkipSeed: (generating: boolean) => {
      // The latch stays unconsumed behind this short-circuit: a run that is
      // still ours will settle and latch, and that latch is for a later open.
      if (generating && !abortedBySwitchRef.current) return true;
      return consumeLatch();
    },
    consumeSkipSeed: consumeLatch,
  };
}
