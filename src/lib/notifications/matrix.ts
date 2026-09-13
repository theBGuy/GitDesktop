import { create } from "zustand";
import {
  type AutomationKindFilter,
  NOTIFICATION_SOURCES,
  type NotificationSettings,
  type NotificationSource,
  OUTCOME_SOURCES,
  type OutcomeFilter,
  type OutcomeSource,
  type PrCheckScopeFilter,
} from "@/lib/settings/api";
import type { RepoNotificationOverride } from "./overrides";

// The notification matrix's shared vocabulary and its two open-state stores.
// Component-free on purpose: the table primitives and the dialog live in
// features/notifications, and a module mixing them with these values can't
// Fast-Refresh (vite-plugin-react full-invalidates it, which reads as ghost
// state at runtime).

/** Delivery channels in column order; the matrix's DOM order is row-major over
 *  this list, so the tab order matches what a reader hears. */
export const CHANNELS = ["inApp", "os"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  inApp: "In-app",
  os: "OS",
};

/** Spoken channel word inside a cell's aria-label — the column header is a
 *  `<th scope="col">`, but a checkbox still needs a name of its own. */
const CHANNEL_ARIA: Record<Channel, string> = {
  inApp: "in-app",
  os: "OS",
};

/** Record-typed against the manifest, so a new source can't ship label-less. */
export const SOURCE_LABELS: Record<NotificationSource, string> = {
  prChecks: "CI checks finish",
  prActivity: "Pull requests opened, merged, or closed",
  prReviews: "Reviews on my pull requests",
  actionRuns: "Workflow runs finish on the current branch",
  reviews: "AI reviews I start",
  automations: "Automation results",
  agents: "Agent tasks finish",
};

/** Second line under a row's label; a source with nothing to add carries none. */
export const SOURCE_DESCRIPTIONS: Partial<Record<NotificationSource, string>> =
  {
    prReviews:
      "Approvals, change requests, comments, and requests for your review",
    reviews: "A review or security audit finishing in the background",
    automations: "Automated reviews ready, posted, or failed",
    agents: "Sessions, plans, and research",
  };

/** Sources hidden with the AI surfaces. */
const AI_SOURCES: ReadonlySet<NotificationSource> = new Set<NotificationSource>(
  ["reviews", "automations", "agents"],
);

export const CHECK_SCOPE_LABELS: Record<PrCheckScopeFilter, string> = {
  mine: "My pull requests only",
  all: "All open pull requests",
};

/** Names the SET each filter delivers, never "All results": a class this app doesn't
 *  classify yet (cancelled, skipped) must not silently join an existing user's
 *  choice when it does. */
export const OUTCOME_FILTER_LABELS: Record<OutcomeFilter, string> = {
  all: "Successes and failures",
  failures: "Failures only",
  successes: "Successes only",
};

/** Deliberately NOT the closed-set rule above: "Everything" IS the identity filter
 *  here, so a kind this app doesn't emit yet joins it by design rather than being
 *  silently excluded. Only "Failures only" names a closed set. */
export const AUTOMATION_KIND_FILTER_LABELS: Record<
  AutomationKindFilter,
  string
> = {
  all: "Everything",
  failures: "Failures only",
};

/** A source carrying a Notify-on sub-row — the CI sources on the outcome axis, plus
 *  automations on its kind axis. Named once here, since the label, the held reason,
 *  and both dialog predicates all key off the same set. */
export type SubrowSource = OutcomeSource | "automations";

/** Visible label on every Notify-on sub-row, on both the outcome and kind axes. */
export const SUBROW_LABEL = "Notify on";

/** Accessible name for a Notify-on picker: each matrix holds one per CI source plus
 *  the automations row, so the visible word alone names none of them. Visible text
 *  first (WCAG 2.5.3). */
export function subrowAriaLabel(source: SubrowSource): string {
  return `${SUBROW_LABEL} — ${SOURCE_LABELS[source]}`;
}

/** Why the CI-checks sub-rows are held while that source delivers nowhere. Named
 *  rather than inlined below because the Watch and Notify-on pickers are held by
 *  exactly the same condition and print one line between them; every reader reaches
 *  it through {@link SUBROW_HELD_REASONS}, so it stays module-private. */
const CHECKS_OFF_REASON =
  "Turn on a CI checks channel to choose which pull requests to watch and which results notify";

/** Why a qualifying sub-row is held, per source — the CI-checks sentence also covers
 *  its Watch neighbour, so those two rows print one line between them. */
export const SUBROW_HELD_REASONS: Record<SubrowSource, string> = {
  prChecks: CHECKS_OFF_REASON,
  actionRuns: "Turn on a workflow-runs channel to choose which results notify",
  automations: "Turn on an automations channel to choose which results notify",
};

/** The rows the matrix renders, in manifest order. Hidden AI rows keep whatever
 *  the draft holds — they are omitted from the view, never rewritten. */
export function notificationRows(
  aiEnabled: boolean,
): readonly NotificationSource[] {
  return aiEnabled
    ? NOTIFICATION_SOURCES
    : NOTIFICATION_SOURCES.filter((source) => !AI_SOURCES.has(source));
}

export function channelAriaLabel(rowLabel: string, channel: Channel): string {
  return `${rowLabel} — ${CHANNEL_ARIA[channel]}`;
}

/** JSON with object keys sorted, so a comparison is insensitive to key order. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

/** Key-order-insensitive fingerprint of the global notification settings. The
 *  dialog's mint/drop-on-match baseline is the SAVED value, so the settings
 *  screen compares its draft against this to know when the two disagree. */
export function notificationsSignature(value: NotificationSettings): string {
  return sortedJson(value);
}

/** How many individual settings an override pins — each channel field, the scope,
 *  each outcome filter, and the automations kind filter. The Reset gate and the
 *  settings footer's status line both count it. */
export function overrideCount(
  override: RepoNotificationOverride | undefined,
): number {
  if (!override) return 0;
  let count = override.prChecksScope === undefined ? 0 : 1;
  if (override.automationKinds !== undefined) count += 1;
  for (const source of OUTCOME_SOURCES) {
    if (override.outcomes?.[source] !== undefined) count += 1;
  }
  for (const source of NOTIFICATION_SOURCES) {
    const cell = override.sources?.[source];
    if (!cell) continue;
    if (cell.inApp !== undefined) count += 1;
    if (cell.os !== undefined) count += 1;
  }
  return count;
}

interface RepoNotificationsDialogState {
  /** Repo path whose notifications are open, or null when closed. */
  repoPath: string | null;
  /** Bumped by every `open()`. An awaited save that outlived its own dialog
   *  compares this to tell "still my dialog" from "a later one for the same
   *  repo" — the repo path alone can't, and the two hold different edits. */
  generation: number;
  open: (repoPath: string) => void;
  close: () => void;
}

/** Open-state for the one mounted `RepoNotificationsDialogHost`, so the settings
 *  footer, the overrides audit list, and the command palette all reach the same
 *  dialog without threading props or mounting a second copy. */
export const useRepoNotificationsDialog =
  create<RepoNotificationsDialogState>()((set) => ({
    repoPath: null,
    generation: 0,
    open: (repoPath) =>
      set((s) => ({ repoPath, generation: s.generation + 1 })),
    close: () => set({ repoPath: null }),
  }));

interface NotificationsDraftState {
  /** Fingerprint of the notifications slice a MOUNTED settings form holds, or
   *  null when no settings screen is on. */
  signature: string | null;
  publish: (signature: string) => void;
  clear: () => void;
}

/** What a live settings form is holding for notifications, so routes into the
 *  per-repo dialog that render OUTSIDE the form (the command palette) can see
 *  it. SettingsScreen publishes it from the form store and App retires it on
 *  leaving Settings: the screen outlives every panel switch, and a value that
 *  outlived its screen would hold the palette action shut forever. */
export const useNotificationsDraft = create<NotificationsDraftState>()(
  (set) => ({
    signature: null,
    publish: (signature) => set({ signature }),
    clear: () => set({ signature: null }),
  }),
);

/**
 * Whether a live settings form holds notification edits the store hasn't taken
 * yet. Per-repo overrides are minted against the SAVED matrix, so opening the
 * dialog over an unsaved draft lets a user "change" a cell the dialog already
 * reads as global — it stores nothing, and the pending Save then moves the
 * global underneath it.
 *
 * The published signature carries the draft it was produced under and is
 * compared against the live saved value rather than cleared per writer, so a
 * Save OR a Discard from any panel resolves it: SettingsScreen publishes from
 * the form store, which outlives panel switches, and App clears on screen close.
 */
export function notificationsDraftOutOfSync(
  published: string | null,
  saved: NotificationSettings | undefined,
): boolean {
  if (published === null || saved === undefined) return false;
  return published !== notificationsSignature(saved);
}
