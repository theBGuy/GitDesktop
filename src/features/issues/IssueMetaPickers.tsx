import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  FlagIcon,
  ShapesIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { type ComponentProps, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MetaValueCell, UserChip } from "@/components/meta-field-cells";
import { usePanelPortalContainer } from "@/components/panel-portal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  redirectPopupFocus,
  toUserPickerRead,
  USER_PICKER_POPUP_CLASS,
  UserPickerBody,
} from "@/components/user-picker-body";
import { sortedSnapshot } from "@/components/user-picker-model";
import { emptyPickerCopy } from "@/features/conversations/remote-section-state";
import { useForgeGhHost } from "@/lib/git/host";
import {
  useAssignableUserList,
  useIssueTypes,
  useMilestones,
} from "@/lib/git/queries";
import type { ForgeUserRef, IssueType, RemoteLens } from "@/lib/git/types";
import { cn } from "@/lib/utils";

const ASSIGNEE_COPY = {
  noun: "assignable users",
  loadFailed: "Couldn't load assignable users.",
  empty: "No assignable users.",
};

/** GitHub issue-type color NAMES → a swatch hex (matches GitHub's palette). */
const ISSUE_TYPE_COLORS: Record<string, string> = {
  GRAY: "#6b7280",
  BLUE: "#3b82f6",
  GREEN: "#22c55e",
  YELLOW: "#eab308",
  ORANGE: "#f97316",
  RED: "#ef4444",
  PINK: "#ec4899",
  PURPLE: "#a855f7",
};

function typeColor(color: string): string {
  return ISSUE_TYPE_COLORS[color?.toUpperCase()] ?? ISSUE_TYPE_COLORS.GRAY;
}

function TypeDot({
  color,
  ...rest
}: { color: string } & ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: typeColor(color) }}
      {...rest}
    />
  );
}

/**
 * Assignee multi-select shared by the create dialog and the issue/PR view.
 * `commitOnClose` batches edits into one `onChange` when the popover closes
 * (used in the view, where each change is a network PATCH); otherwise it fires
 * per toggle (used in the create dialog, where state is local). Entries are
 * `ForgeUserRef`s so rows and chips render the provider's avatar (GitLab/Bitbucket
 * supply a real URL; GitHub is login-derived), mirroring the reviewer picker.
 */
export function AssigneesPopover({
  repoPath,
  enabled,
  value,
  onChange,
  commitOnClose = false,
  lens,
  disabledReason,
  cells = false,
}: {
  repoPath: string;
  enabled: boolean;
  value: ForgeUserRef[];
  onChange: (next: ForgeUserRef[]) => void;
  commitOnClose?: boolean;
  /** The origin|upstream lens the parent surface resolved. */
  lens: RemoteLens;
  /** Set when this picker can't be edited right now — the viewer lacks the access
   *  its action needs, or the surface is still loading the entity. The trigger
   *  stays visible but disabled and this text explains why. Absent = editable. */
  disabledReason?: string;
  /** Emit the trigger and the chips as two SIBLING elements rather than one
   *  inline row, so a caller's label/value grid can place each in its own
   *  column. Default renders the inline row. */
  cells?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Latched by the trigger's first hover or focus, so the list starts loading a
  // beat before the click while a picker nobody approaches costs no read.
  const [intent, setIntent] = useState(false);
  const users = useAssignableUserList(
    repoPath,
    enabled && (open || intent),
    lens,
  );
  const ghHost = useForgeGhHost(repoPath);
  const [draft, setDraft] = useState<Map<string, ForgeUserRef>>(new Map());
  // Per open: the body's key (fresh filter, cursor and scroll) and the users
  // selected at open, which keep their rows at the top until it closes.
  const [session, setSession] = useState<{
    key: number;
    snapshot: ForgeUserRef[];
  }>({ key: 0, snapshot: [] });
  const portalContainer = usePanelPortalContainer();
  // Per-toggle mode reads `value`; commit-on-close mode reads the local draft
  // (seeded from `value` on open). Keyed by the provider's stable id.
  const checked = commitOnClose ? draft : new Map(value.map((u) => [u.id, u]));
  const latchIntent = () => {
    if (!disabledReason) setIntent(true);
  };

  function toggle(user: ForgeUserRef, on: boolean) {
    if (commitOnClose) {
      setDraft((prev) => {
        const next = new Map(prev);
        if (on) next.set(user.id, user);
        else next.delete(user.id);
        return next;
      });
      return;
    }
    const next = new Map(value.map((u) => [u.id, u]));
    if (on) next.set(user.id, user);
    else next.delete(user.id);
    onChange([...next.values()]);
  }

  function handleOpenChange(o: boolean) {
    if (o) {
      setDraft(new Map(value.map((u) => [u.id, u])));
      setSession((prev) => ({
        key: prev.key + 1,
        snapshot: sortedSnapshot(value),
      }));
      setOpen(true);
      return;
    }
    setOpen(false);
    // Only commit when the draft actually differs from `value` — otherwise
    // merely opening and closing the popover would fire a redundant assignees
    // PATCH (onChange → the view's mutation). Compare id sets.
    if (commitOnClose) {
      const valueIds = new Set(value.map((u) => u.id));
      const changed =
        draft.size !== valueIds.size ||
        value.some((u) => !draft.has(u.id)) ||
        [...draft.keys()].some((id) => !valueIds.has(id));
      if (changed) onChange([...draft.values()]);
    }
  }

  const trigger = (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        onPointerEnter={latchIntent}
        onFocus={latchIntent}
        render={
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            aria-label="Edit assignees"
            disabled={!!disabledReason}
            reason={disabledReason}
          />
        }
      >
        <UserPlusIcon data-icon="inline-start" />
        Assignees
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup
            className={USER_PICKER_POPUP_CLASS}
            onFocus={redirectPopupFocus}
          >
            <UserPickerBody
              key={session.key}
              title="Assignees"
              read={toUserPickerRead(users)}
              copy={ASSIGNEE_COPY}
              snapshot={session.snapshot}
              checked={checked}
              onToggle={toggle}
              commitsOnClose={commitOnClose}
              ghHost={ghHost}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
  const chips = value.map((user) => (
    <UserChip key={user.id} user={user} ghHost={ghHost} />
  ));

  if (cells) {
    return (
      <>
        {trigger}
        <MetaValueCell label="Assignees" empty={value.length === 0}>
          {chips}
        </MetaValueCell>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {trigger}
      {chips}
    </div>
  );
}

/**
 * Single-select milestone menu. `valueLabel` shows the current title even when
 * it's a closed milestone (not in the open-milestone list).
 */
export function MilestoneMenu({
  repoPath,
  enabled,
  value,
  valueLabel,
  onChange,
  lens,
  disabledReason,
}: {
  repoPath: string;
  enabled: boolean;
  value: number | null;
  valueLabel?: string;
  onChange: (milestone: number | null, title: string | null) => void;
  /** The origin|upstream lens the parent surface resolved. */
  lens: RemoteLens;
  /** Set when this picker can't be edited right now — the viewer lacks the access
   *  its action needs (callers pass the reason for the matching axis), or the
   *  surface is still loading the entity. The trigger stays visible but disabled
   *  and this text explains why. Absent = editable as before. */
  disabledReason?: string;
}) {
  const milestones = useMilestones(repoPath, enabled, lens);
  const list = milestones.data ?? [];
  const current = list.find((m) => m.number === value);
  const display =
    value === null
      ? "Milestone"
      : (current?.title ?? valueLabel ?? `#${value}`);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              aria-label="Set milestone"
              disabled={!!disabledReason}
              reason={disabledReason}
            />
          }
        >
          <FlagIcon data-icon="inline-start" />
          {display}
          <CaretDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuItem
            onClick={() => onChange(null, null)}
            className={cn(value === null && "bg-accent text-accent-foreground")}
          >
            No milestone
          </DropdownMenuItem>
          {list.map((m) => (
            <DropdownMenuItem
              key={m.number}
              onClick={() => onChange(m.number, m.title)}
              className={cn(
                value === m.number && "bg-accent text-accent-foreground",
              )}
            >
              {m.title}
            </DropdownMenuItem>
          ))}
          {list.length === 0 && (
            <DropdownMenuItem disabled>
              {emptyPickerCopy(milestones, {
                noun: "milestones",
                loadFailed: "Couldn't load milestones.",
                empty: "No open milestones",
              })}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Single-select issue-type menu (org-defined Bug/Feature/Task/…). Renders
 * nothing when the repo's owner defines no types, so personal repos show no
 * empty control. `onChange` receives the type NAME (or null to clear).
 */
export function IssueTypeMenu({
  repoPath,
  enabled,
  value,
  onChange,
  lens,
  disabledReason,
}: {
  repoPath: string;
  enabled: boolean;
  value: IssueType | null;
  onChange: (type: IssueType | null) => void;
  /** The origin|upstream lens the parent surface resolved. */
  lens: RemoteLens;
  /** Set when this picker can't be edited right now — the viewer lacks the access
   *  its action needs (callers pass the reason for the matching axis), or the
   *  surface is still loading the entity. The trigger stays visible but disabled
   *  and this text explains why. Absent = editable as before. */
  disabledReason?: string;
}) {
  const types = useIssueTypes(repoPath, enabled, lens);
  const list = types.data ?? [];
  // No types defined for this owner → hide the control entirely.
  if (list.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              aria-label="Set issue type"
              disabled={!!disabledReason}
              reason={disabledReason}
            />
          }
        >
          {value ? (
            <TypeDot color={value.color} data-icon="inline-start" />
          ) : (
            <ShapesIcon data-icon="inline-start" />
          )}
          {value?.name ?? "Type"}
          <CaretDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuItem
            onClick={() => onChange(null)}
            className={cn(!value && "bg-accent text-accent-foreground")}
          >
            No type
          </DropdownMenuItem>
          {list.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onClick={() => onChange(t)}
              className={cn(
                value?.name === t.name && "bg-accent text-accent-foreground",
              )}
            >
              <TypeDot color={t.color} />
              {t.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
