import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";
import { normPath } from "@/lib/git/path";
import { slugFromRemoteUrl } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { type ConfirmRequest, useConfirm } from "@/lib/stores/confirm";
import {
  destinationSlug,
  publishConfirmBody,
  publishConfirmTitle,
} from "./branch-sync-state";

/** Where one surface records the publish prompt it asked last, so it can
 *  withdraw its own prompt (and never another surface's confirm). */
export type PublishAskSlot = { current: ConfirmRequest | null };

/** Shows the shared confirm before a push that would create `branch` on
 *  `remote`; resolves true = publish. Cancel takes the initial focus (rendered
 *  first, no `initialFocus`), so a reflexive Enter backs out. Spelled as one
 *  `useConfirm.getState().ask(...)` chain, the form the confirm-scope ratchet
 *  reads. The request lands in `slot` while it is open. */
export function askPublishConfirm(
  opts: {
    /** The CAPTURED branch name the push will send. */
    branch: string;
    remote: string;
    /** The destination remote's PUSH URL (`get-url --push`), where the branch
     *  is created; null = unknown. */
    pushUrl: string | null;
    /** `RecentRepo.visibility`, passed only when it was verified for that push
     *  URL (`visibilityApplies`); absent never means public. */
    visibility: string | null;
    goneUpstream: boolean;
    /** The gone upstream's remote; null when there is none. */
    upstreamRemote: string | null;
    /** The gone upstream's branch name on that remote; null when unknown. */
    upstreamBranch: string | null;
    /** The name created on the remote when it differs from `branch`. */
    createdBranch?: string;
  },
  slot: PublishAskSlot,
): Promise<boolean> {
  const segments = publishConfirmBody({
    branch: opts.branch,
    remote: opts.remote,
    slug: destinationSlug(opts.pushUrl, slugFromRemoteUrl),
    visibility: opts.visibility,
    goneUpstream: opts.goneUpstream,
    upstreamRemote: opts.upstreamRemote,
    upstreamBranch: opts.upstreamBranch,
    createdBranch: opts.createdBranch,
  });
  const answer = useConfirm.getState().ask({
    title: publishConfirmTitle(opts.branch),
    // Nested fragments rather than a keyed list: the sentence is fixed and
    // never reorders, so there is no identity to key on.
    body: segments.reduce<ReactNode>(
      (acc, s) => (
        <>
          {acc}
          {s.mono ? <span className="font-mono">{s.text}</span> : s.text}
        </>
      ),
      null,
    ),
    confirmLabel: "Publish",
    holdOffline: true,
  });
  // `ask` installs its request synchronously.
  const asked = useConfirm.getState().request;
  slot.current = asked;
  return answer.finally(() => {
    if (slot.current === asked) slot.current = null;
  });
}

/** Answers this surface's own publish prompt with Cancel, if it is still the
 *  one showing: a fork-PR guard about to open for a newer press of the same
 *  route takes over from it rather than stacking over it. */
export function withdrawPublishConfirm(slot: PublishAskSlot) {
  const mine = slot.current;
  slot.current = null;
  if (mine !== null && useConfirm.getState().request === mine)
    useConfirm.getState().answer(false);
}

/** The open repository's recorded visibility, or null when the probe never
 *  resolved it (which must not read as public). */
export function recordedVisibility(
  recentRepos: readonly RecentRepo[] | undefined,
  repoPath: string,
): string | null {
  const want = normPath(repoPath);
  return (
    recentRepos?.find((r) => normPath(r.path) === want)?.visibility ?? null
  );
}

/** How long a close may take to report before the ask goes ahead anyway: a
 *  root that unmounts mid-close never reports. Outlasts the menus' exit fade. */
const CLOSE_SETTLE_BOUND_MS = 500;

/** Lets a prompt opened from a menu item wait until that menu (or the popover
 *  holding it) has finished closing. Base UI returns focus to the trigger from
 *  the popup's unmount, which is what fires `onOpenChangeComplete(false)`; a
 *  dialog opened before that return would lose its initial focus to it. Spread
 *  `onOpenChangeComplete` on the Root whose `open` is passed here. */
export function useCloseSettled(open: boolean) {
  const state = useRef<{
    open: boolean;
    closed: boolean;
    /** Bumped on every edge, so a completion frame queued for an earlier
     *  close can't settle a later one. */
    cycle: number;
    waiters: Set<() => void>;
  }>({ open, closed: !open, cycle: 0, waiters: new Set() });
  // Either edge starts a new cycle: an open is not closed, and a close has not
  // settled until its completion reports.
  useLayoutEffect(() => {
    const s = state.current;
    if (s.open === open) return;
    s.open = open;
    s.closed = false;
    s.cycle += 1;
  }, [open]);
  const onOpenChangeComplete = useCallback((o: boolean) => {
    if (o) return;
    const cycle = state.current.cycle;
    // The frame after the unmount sees where the focus return landed.
    requestAnimationFrame(() => {
      const s = state.current;
      if (s.open || s.cycle !== cycle) return;
      s.closed = true;
      const waiters = [...s.waiters];
      s.waiters.clear();
      for (const w of waiters) w();
    });
  }, []);
  const waitClosed = useCallback(
    () =>
      new Promise<void>((resolve) => {
        const s = state.current;
        if (s.closed) {
          resolve();
          return;
        }
        // Settles once, by whichever comes first; each path retires the other.
        const settle = () => {
          clearTimeout(cap);
          s.waiters.delete(settle);
          resolve();
        };
        const cap = setTimeout(settle, CLOSE_SETTLE_BOUND_MS);
        s.waiters.add(settle);
      }),
    [],
  );
  return { onOpenChangeComplete, waitClosed };
}
