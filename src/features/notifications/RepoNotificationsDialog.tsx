import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  useId,
  useState,
} from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { clipTitleFromText } from "@/lib/clip-title";
import { useRepoIdentity } from "@/lib/git/queries";
import {
  effectiveChannels,
  effectiveChecksScope,
  overrideEntry,
  type RepoNotificationOverride,
} from "@/lib/notifications/overrides";
import {
  useNotificationOverrides,
  useSaveRepoNotificationOverride,
} from "@/lib/notifications/queries";
import {
  type ChannelPrefs,
  NOTIFICATION_SOURCES,
  type NotificationSettings,
  type NotificationSource,
  type PrCheckScopeFilter,
} from "@/lib/settings/api";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { ARIA_DISABLED_CLASS } from "@/lib/use-disabled-reason";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

// ── Shared vocabulary (imported by Settings → Notifications) ────────────────

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
  prChecks: "CI checks finish (pass or fail)",
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

/** The source × channel grid. A real table with scoped headers: the row and
 *  column headers ARE the a11y wiring, which is why no LabeledGroup wraps it. */
export function MatrixTable({ children }: { children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          <th className="w-full" />
          {CHANNELS.map((channel) => (
            <th
              key={channel}
              scope="col"
              className="px-2 pb-1 text-center align-bottom font-medium whitespace-nowrap text-muted-foreground"
            >
              {CHANNEL_LABELS[channel]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** A row's label cell — the `<th scope="row">` every cell in the row is named
 *  by, plus its optional muted description line. */
export function RowLabelCell({
  label,
  description,
  chip,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** Muted word-chip (never color alone) marking the row as overridden. */
  chip?: ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="row"
      className={cn("py-1.5 pr-2 text-left font-normal", className)}
    >
      <span className="flex items-center gap-1.5">
        <span>{label}</span>
        {chip}
      </span>
      {description ? (
        <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
          {description}
        </span>
      ) : null}
    </th>
  );
}

/** Cell wrapper, so every checkbox sits in the same box in both matrices. */
export function MatrixCell({ children }: { children: ReactNode }) {
  return <td className="px-2 py-1.5 text-center align-top">{children}</td>;
}

const OVERRIDDEN_CHIP = (
  <span className="border px-1 text-[10px] text-muted-foreground">
    overridden
  </span>
);

/** Why the scope picker is held while the CI-checks source delivers nowhere.
 *  Shared so the global matrix and the per-repo dialog say the same sentence. */
export const CHECKS_OFF_WATCH_REASON =
  "Turn on a CI checks channel to choose which pull requests to watch";

/**
 * Which pull requests the CI-checks source watches. Composed from the Select
 * primitives rather than SelectField for two reasons the wrapper can't serve:
 * the reason has to reach the trigger through `aria-describedby`, and a held
 * picker must stay in the tab order — Base UI's `disabled` sets `tabIndex={-1}`
 * on the trigger, which would put the control and its reason out of reach.
 * `readOnly` locks the value (including closed-trigger typeahead) but still
 * lets the popup open, so the open state is controlled and gated here too.
 */
function WatchSelect({
  value,
  onValueChange,
  disabledReason,
  sharedReasonId,
  chip,
}: {
  value: PrCheckScopeFilter;
  onValueChange: (value: PrCheckScopeFilter) => void;
  /** Non-null holds the select and renders the reason as a visible line. */
  disabledReason?: string | null;
  /** Id of a reason line the caller already shows for a whole group of
   *  controls; set, the select points at that instead of printing a copy. */
  sharedReasonId?: string;
  chip?: ReactNode;
}) {
  const id = useId();
  const ownReasonId = useId();
  const reasonId = sharedReasonId ?? ownReasonId;
  const held = !!disabledReason;
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1.5">
        <Label htmlFor={id}>Watch</Label>
        {chip}
      </span>
      <Select
        items={CHECK_SCOPE_LABELS}
        value={value}
        onValueChange={(v) => {
          if (v) onValueChange(v as PrCheckScopeFilter);
        }}
        readOnly={held}
        open={open}
        onOpenChange={(next) => {
          if (!held) setOpen(next);
        }}
      >
        <SelectTrigger
          id={id}
          size="sm"
          className={cn("w-full", ARIA_DISABLED_CLASS)}
          aria-disabled={held || undefined}
          aria-describedby={held ? reasonId : undefined}
        >
          <SelectValue onMouseEnter={clipTitleFromText} />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(CHECK_SCOPE_LABELS) as PrCheckScopeFilter[]).map(
            (scope) => (
              <SelectItem key={scope} value={scope}>
                <SelectClipText>{CHECK_SCOPE_LABELS[scope]}</SelectClipText>
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
      {disabledReason && !sharedReasonId ? (
        <p id={ownReasonId} className="text-[11px] text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

/** The Watch picker as a matrix sub-row, indented under the CI-checks row it
 *  qualifies. The channel columns stay empty: the scope is orthogonal to the
 *  channels, so it has no cell of its own to fill. */
export function WatchRow(props: ComponentProps<typeof WatchSelect>) {
  return (
    <tr>
      <td className="py-1.5 pr-2 pl-4">
        <WatchSelect {...props} />
      </td>
      <td colSpan={CHANNELS.length} />
    </tr>
  );
}

// ── Open-state store + host ─────────────────────────────────────────────────

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

/** Open-state for the one mounted {@link RepoNotificationsDialogHost}, so the
 *  settings footer, the overrides audit list, and the command palette all reach
 *  the same dialog without threading props or mounting a second copy. */
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
 *  it. Screen-scoped, not panel-scoped: the draft survives a panel switch, so
 *  the section never clears on unmount and App retires it on leaving Settings —
 *  a flag that outlived its screen would hold the palette action shut forever. */
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
 * compared against the live saved value rather than cleared by every writer, so
 * a Save from another panel resolves it on its own. A Discard from another
 * panel can't be seen — the section is unmounted — and leaves the verdict set
 * until the screen closes: the fail-safe direction, since the section's own
 * Customize button stays correct and reachable.
 */
export function notificationsDraftOutOfSync(
  published: string | null,
  saved: NotificationSettings | undefined,
): boolean {
  if (published === null || saved === undefined) return false;
  return published !== notificationsSignature(saved);
}

const EMPTY_OVERRIDE: RepoNotificationOverride = {};

/** Which body the dialog shows. A failed overrides load is its OWN state, never
 *  a slow one: the query settles with no data, so a loading placeholder would
 *  spin forever and an editable matrix would edit against nothing. */
function bodyState({
  error,
  loaded,
  identityPending,
}: {
  error: boolean;
  loaded: boolean;
  /** The repo's identity keys the lookup, so an editable matrix has to wait for
   *  it — an identity-keyed override is invisible until it resolves. */
  identityPending: boolean;
}): "error" | "loading" | "ready" {
  if (error) return "error";
  if (!loaded || identityPending) return "loading";
  return "ready";
}

/** The overrides store failed to load. Offers the retry rather than a dead
 *  dialog: the store's loader doesn't memoize its rejection, so a storage
 *  hiccup can genuinely clear. */
function OverridesLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Couldn't load this repository's overrides.
      </p>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function sortedJson(value: unknown): string {
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

/** How many individual settings an override pins — each channel field plus the
 *  scope. The Reset gate and the settings footer's status line both count it. */
export function overrideCount(
  override: RepoNotificationOverride | undefined,
): number {
  if (!override) return 0;
  let count = override.prChecksScope === undefined ? 0 : 1;
  for (const source of NOTIFICATION_SOURCES) {
    const cell = override.sources?.[source];
    if (!cell) continue;
    if (cell.inApp !== undefined) count += 1;
    if (cell.os !== undefined) count += 1;
  }
  return count;
}

/**
 * One repository's notification overrides: per-cell adjustments on top of the
 * global matrix. Edited as a draft behind Cancel / Save changes; a cell edited
 * back to the global value drops its override (inherits again).
 */
export function RepoNotificationsDialogHost() {
  const repoPath = useRepoNotificationsDialog((s) => s.repoPath);
  const close = useRepoNotificationsDialog((s) => s.close);
  // Retained so the body keeps its repo through the close fade instead of
  // blanking the dialog as it animates out.
  const shownRepo = useRetained(repoPath);

  return (
    <Dialog
      open={repoPath !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* Capped flex column: the header and footer stay pinned while the mute
          row, the matrix, and the Watch select scroll as one body. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Repository notifications</DialogTitle>
          <DialogDescription>
            What notifies from this repository. Cells start from your defaults
            in Settings → Notifications; change one here to override it for this
            repository only.
          </DialogDescription>
        </DialogHeader>
        {shownRepo !== null && (
          <RepoNotificationsBody
            // A repo switch while the dialog is open must not carry the draft
            // across; the key makes that structural rather than an effect.
            key={shownRepo}
            repoPath={shownRepo}
            open={repoPath !== null}
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RepoNotificationsBody({
  repoPath,
  open,
  onClose,
}: {
  repoPath: string;
  open: boolean;
  onClose: () => void;
}) {
  const aiEnabled = useAiEnabled();
  const settings = useSettings();
  const overrides = useNotificationOverrides();
  const save = useSaveRepoNotificationOverride(repoPath);
  // One reason line for the whole muted group — the grid's cells and the Watch
  // select all point at it rather than each repeating the sentence.
  const mutedReasonId = useId();
  // Worktree-stable identity, so a linked worktree edits the same entry as its
  // main checkout. The raw path is the SETTLED fallback (the resolver returns it
  // when git can't answer), never a stand-in to edit against while the lookup is
  // still pending — see the skeleton gate below.
  const identityQuery = useRepoIdentity(repoPath);
  const identity = identityQuery.data;

  // undefined until the stored overrides are actually in hand. EMPTY is only
  // honest once the load SUCCEEDED and found nothing: a failed load standing in
  // as "no overrides" would let a Save replace the repo's real entry.
  const saved = overrides.data
    ? (overrideEntry(overrides.data, identity ?? repoPath, repoPath) ??
      EMPTY_OVERRIDE)
    : undefined;

  // null = untouched, so the draft follows the saved override (and any refetch
  // of it) until the user's first edit — no seeding effect to race the query.
  const [edited, setEdited] = useState<RepoNotificationOverride | null>(null);
  useSeedOnOpen(open, () => setEdited(null));

  const global = settings.data?.notifications;
  // Which of the three bodies renders. Every editable path hangs off "ready", so
  // the baseline behind it is always a real one.
  const state = bodyState({
    error: overrides.isError,
    loaded: global !== undefined && saved !== undefined,
    identityPending: identityQuery.isPending,
  });

  // Render-only: the EMPTY tail feeds the derivations below, which are inert
  // unless `state === "ready"`. The BASELINE `saved` above never falls back.
  const draft = edited ?? saved ?? EMPTY_OVERRIDE;
  const dirty =
    edited !== null &&
    saved !== undefined &&
    sortedJson(edited) !== sortedJson(saved);
  const rows = notificationRows(aiEnabled);
  const muted = draft.muted === true;
  const mutedReason = muted
    ? "Muted — nothing from this repository notifies."
    : null;
  // The scope is held for the same reason it is in the global matrix — a source
  // delivering on no channel has nothing to watch — read off the EFFECTIVE
  // channels so an inherited pair counts. Muting zeroes both, so it is tested
  // first and its sentence wins.
  const checksChannels = global
    ? effectiveChannels(global, draft, "prChecks")
    : null;
  const watchReason =
    mutedReason ??
    (checksChannels && !checksChannels.inApp && !checksChannels.os
      ? CHECKS_OFF_WATCH_REASON
      : null);

  function patch(
    mutate: (current: RepoNotificationOverride) => RepoNotificationOverride,
  ) {
    // No baseline, no edit: an override minted from a stand-in would be saved
    // as the repo's whole entry.
    if (saved === undefined) return;
    setEdited((current) => mutate(current ?? saved));
  }

  function toggleMuted(next: boolean) {
    patch((current) => {
      const out = { ...current };
      if (next) out.muted = true;
      else delete out.muted;
      return out;
    });
  }

  // An override is stored only where the resulting cell differs from the global
  // value; edited back to match, the field is dropped and the cell inherits.
  function patchCell(
    source: NotificationSource,
    channel: Channel,
    next: boolean,
  ) {
    if (!global) return;
    patch((current) => {
      const sources = { ...(current.sources ?? {}) };
      const cell: Partial<ChannelPrefs> = { ...sources[source] };
      if (next === global.sources[source][channel]) delete cell[channel];
      else cell[channel] = next;
      if (cell.inApp === undefined && cell.os === undefined)
        delete sources[source];
      else sources[source] = cell;
      const out = { ...current };
      if (Object.keys(sources).length === 0) delete out.sources;
      else out.sources = sources;
      return out;
    });
  }

  function setScope(next: PrCheckScopeFilter) {
    if (!global) return;
    patch((current) => {
      const out = { ...current };
      if (next === global.prChecksScope) delete out.prChecksScope;
      else out.prChecksScope = next;
      return out;
    });
  }

  async function doSave() {
    // Captured before the await: this save belongs to ONE opening of the dialog.
    const savedGeneration = useRepoNotificationsDialog.getState().generation;
    try {
      await save.mutateAsync(draft);
      // The toast is unconditional — the save landed either way. The close does
      // not: it drives a SHARED store this continuation can outlive, and closing
      // a dialog opened AFTER this save started throws away that dialog's edits
      // (the next open reseeds the draft from disk). Same repo is not the same
      // dialog, so the generation is what decides.
      toast.success("Repository notifications saved");
      const live = useRepoNotificationsDialog.getState();
      if (live.repoPath === repoPath && live.generation === savedGeneration)
        onClose();
    } catch (e) {
      toastError(e);
    }
  }

  const hasOverrides = muted || overrideCount(draft) > 0;

  // Why Save is held, in precedence order. The error arm keeps it unreachable
  // while there is no baseline to save against.
  function saveBlockedReason(): string | null {
    if (save.isPending) return "Saving…";
    if (state === "error") return "Couldn't load this repository's overrides";
    if (!dirty) return "No changes to save";
    return null;
  }
  const saveReason = saveBlockedReason();

  return (
    <>
      {/* overflow-x-hidden alongside overflow-y-auto so the vertical scrollbar's
          width can't induce a phantom horizontal one. */}
      <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto pr-1">
        {state === "error" && (
          <OverridesLoadFailed onRetry={() => overrides.refetch()} />
        )}
        {state === "loading" && <Skeleton className="h-40 w-full" />}
        {/* `global !== undefined` re-narrows the type the discriminant already
            guarantees; the matrix reads it on every row. */}
        {state === "ready" && global !== undefined && (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={muted}
                onCheckedChange={(checked) => toggleMuted(checked === true)}
              />
              Mute this repository
            </label>
            {mutedReason ? (
              <p
                id={mutedReasonId}
                className="text-[11px] text-muted-foreground"
              >
                {mutedReason}
              </p>
            ) : null}
            <MatrixTable>
              {rows.map((source) => {
                const channels = effectiveChannels(global, draft, source);
                const label = SOURCE_LABELS[source];
                return (
                  <Fragment key={source}>
                    <tr>
                      <RowLabelCell
                        label={label}
                        description={SOURCE_DESCRIPTIONS[source]}
                        chip={draft.sources?.[source] ? OVERRIDDEN_CHIP : null}
                      />
                      {CHANNELS.map((channel) => (
                        <MatrixCell key={channel}>
                          {/* Held, never natively disabled: a disabled checkbox
                              leaves the tab order and takes its reason with it.
                              `readOnly` is the primitive's own interaction
                              block and keeps the cell focusable. */}
                          <Checkbox
                            checked={channels[channel]}
                            readOnly={muted}
                            aria-disabled={muted || undefined}
                            aria-label={channelAriaLabel(label, channel)}
                            aria-describedby={muted ? mutedReasonId : undefined}
                            className={ARIA_DISABLED_CLASS}
                            onCheckedChange={(checked) =>
                              patchCell(source, channel, checked === true)
                            }
                          />
                        </MatrixCell>
                      ))}
                    </tr>
                    {source === "prChecks" && (
                      <WatchRow
                        value={effectiveChecksScope(global, draft)}
                        onValueChange={setScope}
                        disabledReason={watchReason}
                        sharedReasonId={muted ? mutedReasonId : undefined}
                        chip={
                          draft.prChecksScope !== undefined
                            ? OVERRIDDEN_CHIP
                            : null
                        }
                      />
                    )}
                  </Fragment>
                );
              })}
            </MatrixTable>
            <div className="flex justify-end">
              <DisabledReasonButton
                variant="ghost"
                size="xs"
                onClick={() => setEdited(EMPTY_OVERRIDE)}
                disabled={!hasOverrides}
                reason="No overrides to reset"
                title="Remove all overrides and inherit the global defaults"
              >
                Reset to global defaults
              </DisabledReasonButton>
            </div>
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <DisabledReasonButton
          // Below `sm` the footer stacks and stretches the wrapper span; the
          // Button fills it to match the stretched Cancel beside it.
          className="w-full"
          onClick={doSave}
          disabled={saveReason !== null}
          reason={saveReason}
        >
          Save changes
        </DisabledReasonButton>
      </DialogFooter>
    </>
  );
}
