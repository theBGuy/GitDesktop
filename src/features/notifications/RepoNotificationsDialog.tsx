import { Fragment, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
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
import { useModalGateRegistration } from "@/lib/hotkeys/modal-gate";
import {
  AUTOMATION_KIND_FILTER_LABELS,
  CHANNEL_LABELS,
  CHANNELS,
  CHECK_SCOPE_LABELS,
  type Channel,
  channelAriaLabel,
  notificationRows,
  OUTCOME_FILTER_LABELS,
  overrideCount,
  SOURCE_DESCRIPTIONS,
  SOURCE_LABELS,
  SUBROW_HELD_REASONS,
  SUBROW_LABEL,
  type SubrowSource,
  sortedJson,
  subrowAriaLabel,
  useRepoNotificationsDialog,
} from "@/lib/notifications/matrix";
import {
  effectiveAutomationKindFilter,
  effectiveChannels,
  effectiveChecksScope,
  effectiveOutcomeFilter,
  overrideEntry,
  type RepoNotificationOverride,
} from "@/lib/notifications/overrides";
import {
  useNotificationOverrides,
  useSaveRepoNotificationOverride,
} from "@/lib/notifications/queries";
import {
  type AutomationKindFilter,
  type ChannelPrefs,
  isOutcomeSource,
  type NotificationSource,
  type OutcomeFilter,
  type OutcomeSource,
  type PrCheckScopeFilter,
} from "@/lib/settings/api";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { ARIA_DISABLED_CLASS } from "@/lib/use-disabled-reason";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/** The source × channel grid. A real table with scoped headers: the caption
 *  names it for table navigation, and the row and column headers ARE the rest of
 *  the a11y wiring — which is why no LabeledGroup wraps it. */
export function MatrixTable({
  caption,
  children,
}: {
  /** Names the table for assistive tech; required, since a reader landing on an
   *  unnamed grid has nothing to tell it apart from the other one. */
  caption: string;
  children: ReactNode;
}) {
  return (
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">{caption}</caption>
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

interface MatrixSelectProps<T extends string> {
  /** Visible label, associated with the trigger through `htmlFor`. */
  label: string;
  /** Accessible name, for a label that repeats across sub-rows and so names none
   *  of them on its own. Must START with `label` (WCAG 2.5.3); left unset, the
   *  `<Label>` association is the whole name. */
  ariaLabel?: string;
  /** Value → label map, in the order the popup lists them. */
  items: Record<T, string>;
  value: T;
  onValueChange: (value: T) => void;
  /** Non-null holds the select and renders the reason as a visible line. */
  disabledReason?: string | null;
  /** Id of a reason line the caller already shows for a whole group of
   *  controls; set, the select points at that instead of printing a copy. */
  sharedReasonId?: string;
  /** Id for the line this select prints itself, so a sibling held by the same
   *  condition can point at it: a group's FIRST picker owns the one line. */
  reasonId?: string;
  chip?: ReactNode;
}

/**
 * One axis qualifying a matrix row — which pull requests the CI-checks source
 * watches, which results a CI source notifies on, which automation results
 * notify. Composed from the Select primitives rather than SelectField for two
 * reasons the wrapper can't serve:
 * the reason has to reach the trigger through `aria-describedby`, and a held
 * picker must stay in the tab order — Base UI's `disabled` sets `tabIndex={-1}`
 * on the trigger, which would put the control and its reason out of reach.
 * `readOnly` locks the value (including closed-trigger typeahead) but still
 * lets the popup open, so the open state is controlled and gated here too.
 */
function MatrixSelect<T extends string>({
  label,
  ariaLabel,
  items,
  value,
  onValueChange,
  disabledReason,
  sharedReasonId,
  reasonId: printedReasonId,
  chip,
}: MatrixSelectProps<T>) {
  const id = useId();
  const fallbackReasonId = useId();
  const ownReasonId = printedReasonId ?? fallbackReasonId;
  const reasonId = sharedReasonId ?? ownReasonId;
  const held = !!disabledReason;
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {chip}
      </span>
      <Select
        items={items}
        value={value}
        onValueChange={(v) => {
          if (v) onValueChange(v as T);
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
          aria-label={ariaLabel}
          aria-disabled={held || undefined}
          aria-describedby={held ? reasonId : undefined}
        >
          <SelectValue onMouseEnter={clipTitleFromText} />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(items) as T[]).map((item) => (
            <SelectItem key={item} value={item}>
              <SelectClipText>{items[item]}</SelectClipText>
            </SelectItem>
          ))}
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

/** A qualifying picker as a matrix sub-row, indented under the source row it
 *  belongs to. The channel columns stay empty: these axes are orthogonal to the
 *  channels, so they have no cell of their own to fill. */
function MatrixSelectRow<T extends string>(props: MatrixSelectProps<T>) {
  return (
    <tr>
      <td className="py-1.5 pr-2 pl-4">
        <MatrixSelect {...props} />
      </td>
      <td colSpan={CHANNELS.length} />
    </tr>
  );
}

/** Which pull requests the CI-checks source watches. */
export function WatchRow(
  props: Omit<MatrixSelectProps<PrCheckScopeFilter>, "label" | "items">,
) {
  return (
    <MatrixSelectRow {...props} label="Watch" items={CHECK_SCOPE_LABELS} />
  );
}

/** Which results a CI source notifies on. The visible label is the same word on
 *  every such row, so the source rides the accessible name instead. */
export function OutcomeRow({
  source,
  ...props
}: Omit<MatrixSelectProps<OutcomeFilter>, "label" | "ariaLabel" | "items"> & {
  source: OutcomeSource;
}) {
  return (
    <MatrixSelectRow
      {...props}
      label={SUBROW_LABEL}
      ariaLabel={subrowAriaLabel(source)}
      items={OUTCOME_FILTER_LABELS}
    />
  );
}

/** Which automation results notify. Shares the Notify-on label with the CI rows,
 *  so the source rides the accessible name here too — but its own vocabulary: these
 *  are event kinds, not a success/failure outcome. */
export function AutomationKindsRow(
  props: Omit<
    MatrixSelectProps<AutomationKindFilter>,
    "label" | "ariaLabel" | "items"
  >,
) {
  return (
    <MatrixSelectRow
      {...props}
      label={SUBROW_LABEL}
      ariaLabel={subrowAriaLabel("automations")}
      items={AUTOMATION_KIND_FILTER_LABELS}
    />
  );
}

// ── Dialog + host ───────────────────────────────────────────────────────────

const EMPTY_OVERRIDE: RepoNotificationOverride = {};

/** Which body the dialog shows. A failed load of EITHER half of the baseline —
 *  the stored overrides or the global settings they sit on — is its own state,
 *  never a slow one: the query settles with no data, so a loading placeholder
 *  would spin forever and an editable matrix would edit against nothing. */
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

/** Either half of the baseline failed to load. Retry reaches both halves: the
 *  overrides and settings files open through the shared memoized loader, which
 *  drops its memo on a rejected load, so a refetch re-opens the file itself. */
function BaselineLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Couldn't load your notification settings.
      </p>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
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
  // App's repo/settings actions stay reachable from the macOS menu bar, which
  // sits outside this dialog's modal overlay — register so they refuse while it
  // owns the screen. Keyed on the live flag, not the retained one, so the close
  // fade releases the gate.
  useModalGateRegistration(repoPath !== null);

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
  // One reason line for the whole muted group — the grid's cells and the sub-row
  // selects all point at it rather than each repeating the sentence.
  const mutedReasonId = useId();
  // The CI-checks sub-rows are held by one condition and share one sentence, so
  // the Watch row prints it under this id and the Notify-on row points at it.
  const checksReasonId = useId();
  // Worktree-stable identity, so a linked worktree edits the same entry as its
  // main checkout. The `?? repoPath` below is this call site's own fallback for a
  // lookup that FAILED, never a stand-in to edit against while one is still
  // pending — see the skeleton gate below.
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
    // Settings counts too: `global` is half the baseline, and a failed
    // loadSettings would otherwise leave it undefined behind a skeleton that
    // never resolves.
    error: overrides.isError || settings.isError,
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
  // A sub-row is held for the same reason it is in the global matrix — a source
  // delivering on no channel has nothing to watch and no result to filter — read
  // off the EFFECTIVE channels so an inherited pair counts. Muting zeroes both, so
  // it is tested first and its sentence wins.
  function heldReason(source: SubrowSource): string | null {
    if (mutedReason) return mutedReason;
    if (!global) return null;
    const channels = effectiveChannels(global, draft, source);
    return channels.inApp || channels.os ? null : SUBROW_HELD_REASONS[source];
  }

  /** Whose reason line a sub-row points at rather than printing its own. */
  function sharedReasonFor(source: SubrowSource): string | undefined {
    if (muted) return mutedReasonId;
    return source === "prChecks" ? checksReasonId : undefined;
  }

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

  // Same inherit-when-absent rule as the cells: a filter edited back to the global
  // value drops its key rather than pinning a copy of it.
  function patchOutcome(source: OutcomeSource, next: OutcomeFilter) {
    if (!global) return;
    patch((current) => {
      const outcomes = { ...(current.outcomes ?? {}) };
      if (next === global.outcomes[source]) delete outcomes[source];
      else outcomes[source] = next;
      const out = { ...current };
      if (Object.keys(outcomes).length === 0) delete out.outcomes;
      else out.outcomes = outcomes;
      return out;
    });
  }

  // Same rule on the automations kind axis; flat, so the field itself is the key.
  function patchAutomationKinds(next: AutomationKindFilter) {
    if (!global) return;
    patch((current) => {
      const out = { ...current };
      if (next === global.automationKinds) delete out.automationKinds;
      else out.automationKinds = next;
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
    if (state === "error") return "Couldn't load your notification settings";
    if (!dirty) return "No changes to save";
    return null;
  }
  const saveReason = saveBlockedReason();

  return (
    <>
      {/* overflow-x-hidden alongside overflow-y-auto so the vertical scrollbar's
          width can't induce a phantom horizontal one. */}
      <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto pr-1">
        {/* Retries BOTH halves: the arm fires for either failure, and refetching
            only one leaves the other's error in place. */}
        {state === "error" && (
          <BaselineLoadFailed
            onRetry={() => {
              overrides.refetch();
              settings.refetch();
            }}
          />
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
            <MatrixTable caption="Notification channels for this repository">
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
                        disabledReason={heldReason("prChecks")}
                        sharedReasonId={muted ? mutedReasonId : undefined}
                        reasonId={checksReasonId}
                        chip={
                          draft.prChecksScope !== undefined
                            ? OVERRIDDEN_CHIP
                            : null
                        }
                      />
                    )}
                    {isOutcomeSource(source) && (
                      <OutcomeRow
                        source={source}
                        value={effectiveOutcomeFilter(global, draft, source)}
                        onValueChange={(next) => patchOutcome(source, next)}
                        disabledReason={heldReason(source)}
                        sharedReasonId={sharedReasonFor(source)}
                        chip={
                          draft.outcomes?.[source] !== undefined
                            ? OVERRIDDEN_CHIP
                            : null
                        }
                      />
                    )}
                    {source === "automations" && (
                      <AutomationKindsRow
                        value={effectiveAutomationKindFilter(global, draft)}
                        onValueChange={patchAutomationKinds}
                        disabledReason={heldReason("automations")}
                        sharedReasonId={sharedReasonFor("automations")}
                        chip={
                          draft.automationKinds !== undefined
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
