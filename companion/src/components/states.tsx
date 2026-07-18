import {
  ArrowClockwiseIcon,
  PlugsIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";

// The shared data-screen states. Every list/detail screen routes its hook's
// status through these so loading/empty/error/no-repo/unreachable look identical
// everywhere. Meaning is never carried by color alone — each state pairs an icon
// (or text) with its message.

/** A single skeleton row (a pulsing placeholder, not a spinner). */
export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col divide-y divide-border" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-4">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

/** A calm centered message block used by empty / error / no-repo states. */
function CenteredState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-8 py-16 text-center"
      role="status"
    >
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? (
        // A div, not a <p>: some callers pass action buttons alongside text
        // (valid phrasing content in a <p>, but a paragraph isn't the right
        // container for controls — and a div also tolerates future block content).
        <div className="max-w-xs text-sm text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

/** A teaching empty state — the screen is fine, there's just nothing here yet. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return <CenteredState title={title}>{hint}</CenteredState>;
}

/** A retry button matching the primary-action styling. */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
    >
      <ArrowClockwiseIcon size={16} weight="bold" />
      Retry
    </button>
  );
}

/**
 * Route a query error to the right full-screen state. 401 never lands here —
 * the app shell redirects to `#pair` before rendering — but we guard it anyway.
 * 409 → no-repo teaching state. status 0 → unreachable banner-style state. Any
 * other error → a generic error with retry.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const api = error instanceof ApiError ? error : null;

  if (api?.isUnauthorized) {
    // Shouldn't normally render (shell redirects first), but fail safe.
    return (
      <CenteredState
        icon={<PlugsIcon size={32} className="text-muted-foreground" />}
        title="This phone isn't paired."
      >
        <button
          type="button"
          onClick={() => navigate("#pair")}
          className="mt-3 inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Pair this device
        </button>
      </CenteredState>
    );
  }

  if (api?.isNoRemote) {
    // A local-only repo (no `origin` remote — the desktop shows "Publish
    // repository…"). PRs/CI live on a forge, so there's nothing to fetch yet.
    // This is a teaching state, not an error: calm empty-state treatment, and NO
    // retry (retrying can't conjure a remote). See `ApiError.isNoRemote` for why
    // the detection is a display-only heuristic.
    return (
      <CenteredState title="No remote yet">
        PRs and CI live on a forge like GitHub. Publish this repository from
        GitDesktop on your desktop to browse them here.
      </CenteredState>
    );
  }

  if (api?.isNoActiveRepo) {
    return (
      <CenteredState title="No repository shared.">
        Open a repository in GitDesktop on your desktop.
      </CenteredState>
    );
  }

  if (api?.isUnreachable) {
    return (
      <CenteredState
        icon={<PlugsIcon size={32} className="text-warning" />}
        title="Can't reach your desktop."
      >
        Make sure GitDesktop is sharing and your phone is on the same network.
        <span className="mt-3 block">
          <RetryButton onRetry={onRetry} />
        </span>
      </CenteredState>
    );
  }

  return (
    <CenteredState
      icon={<WarningCircleIcon size={32} className="text-destructive" />}
      title="Something went wrong."
    >
      {api?.message ?? "The request failed."}
      <span className="mt-3 block">
        <RetryButton onRetry={onRetry} />
      </span>
    </CenteredState>
  );
}

/**
 * A slim inline banner rendered ABOVE a body's content (in layout flow, never an
 * overlay) when that body's OWN query has errored but still holds its last
 * successful data. Calm warning treatment — the data below is real, just stale.
 *
 * ROUND-4 FINDING (PR #75, doubled message + lost snapshot): the earlier design
 * full-screened `ErrorState` from each body on `isError` AND rendered a separate
 * shell-level unreachable banner (gated on the status query's data) at the same
 * time — so on the Status tab a mid-session drop showed the "can't reach" message
 * TWICE and discarded the last-known snapshot the banner was meant to preserve;
 * meanwhile PRs/CI showed no banner at all (it derived from the status query, not
 * theirs). The fix: each body owns its degraded presentation keyed on its own
 * query — render stale data with THIS banner above it, and only full-screen
 * `ErrorState` when there's no data to show. Do not reintroduce a shell-level
 * banner.
 *
 * The copy blames the LAN link ONLY for a genuinely unreachable server (status
 * 0); any other error (e.g. a transient forge 5xx behind a reachable desktop)
 * gets neutral "couldn't refresh" wording — round-5 finding: a hardcoded
 * "can't reach your desktop" misattributed forge blips to the LAN.
 */
export function StaleBanner({
  error,
  onRetry,
}: {
  error?: unknown;
  onRetry: () => void;
}) {
  const unreachable = error instanceof ApiError && error.isUnreachable;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-warning/15 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 text-foreground">
        <PlugsIcon size={16} className="text-warning" />
        {unreachable
          ? "Can't reach your desktop — showing the last known state."
          : "Couldn't refresh — showing the last known state."}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded px-2 py-1 font-medium text-primary"
      >
        <ArrowClockwiseIcon size={14} weight="bold" />
        Retry
      </button>
    </div>
  );
}
