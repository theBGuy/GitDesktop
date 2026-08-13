import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  FlagIcon,
  ShapesIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { type ComponentProps, useState } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useForgeGhHost } from "@/lib/git/host";
import {
  useAssignableUsers,
  useIssueTypes,
  useMilestones,
} from "@/lib/git/queries";
import type { ForgeUserRef, IssueType, RemoteLens } from "@/lib/git/types";
import { cn } from "@/lib/utils";

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
}: {
  repoPath: string;
  enabled: boolean;
  value: ForgeUserRef[];
  onChange: (next: ForgeUserRef[]) => void;
  commitOnClose?: boolean;
  /** The origin|upstream lens the parent surface resolved. */
  lens: RemoteLens;
  /** Set when the viewer lacks the access this picker's action needs — callers
   *  pass the reason for the matching axis. The trigger stays visible but
   *  disabled and this text explains why. Absent = editable as before. */
  disabledReason?: string;
}) {
  const users = useAssignableUsers(repoPath, enabled, lens);
  const ghHost = useForgeGhHost(repoPath);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Map<string, ForgeUserRef>>(new Map());
  // Per-toggle mode reads `value`; commit-on-close mode reads the local draft
  // (seeded from `value` on open). Compare by the provider's stable id.
  const checkedIds = commitOnClose
    ? new Set(draft.keys())
    : new Set(value.map((u) => u.id));

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

  const loaded = users.data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        {/* A natively disabled button swallows `title`, so the reason rides a
            wrapping span. */}
        <span
          title={disabledReason}
          className={
            disabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"
          }
        >
          <Popover.Trigger
            disabled={!!disabledReason}
            render={
              <Button variant="ghost" size="xs" aria-label="Edit assignees" />
            }
          >
            <UserPlusIcon data-icon="inline-start" />
            Assignees
          </Popover.Trigger>
        </span>
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              <p className="px-1 pb-1.5 text-xs font-medium">Assignees</p>
              {loaded.length === 0 && (
                <p className="px-1 py-1 text-xs text-muted-foreground">
                  {users.isPending ? "Loading…" : "No assignable users."}
                </p>
              )}
              {loaded.map((user) => (
                <label
                  key={user.id}
                  className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
                >
                  <Checkbox
                    checked={checkedIds.has(user.id)}
                    onCheckedChange={(v) => toggle(user, v === true)}
                  />
                  <ForgeUserAvatar user={user} ghHost={ghHost} />
                  <span className="flex-1 truncate" title={user.label}>
                    {user.label}
                  </span>
                </label>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {value.map((user) => (
        <span
          key={user.id}
          className="inline-flex items-center gap-1 border py-0.5 pr-1.5 pl-0.5 text-[11px] text-muted-foreground"
        >
          <ForgeUserAvatar user={user} ghHost={ghHost} />
          {user.label}
        </span>
      ))}
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
  /** Set when the viewer lacks the access this picker's action needs — callers
   *  pass the reason for the matching axis. The trigger stays visible but
   *  disabled and this text explains why. Absent = editable as before. */
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
        {/* A natively disabled button swallows `title`, so the reason rides a
            wrapping span. */}
        <span
          title={disabledReason}
          className={
            disabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"
          }
        >
          <DropdownMenuTrigger
            disabled={!!disabledReason}
            render={
              <Button variant="ghost" size="xs" aria-label="Set milestone" />
            }
          >
            <FlagIcon data-icon="inline-start" />
            {display}
            <CaretDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
        </span>
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
              {milestones.isPending ? "Loading…" : "No open milestones"}
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
  /** Set when the viewer lacks the access this picker's action needs — callers
   *  pass the reason for the matching axis. The trigger stays visible but
   *  disabled and this text explains why. Absent = editable as before. */
  disabledReason?: string;
}) {
  const types = useIssueTypes(repoPath, enabled, lens);
  const list = types.data ?? [];
  // No types defined for this owner → hide the control entirely.
  if (list.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        {/* A natively disabled button swallows `title`, so the reason rides a
            wrapping span. */}
        <span
          title={disabledReason}
          className={
            disabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"
          }
        >
          <DropdownMenuTrigger
            disabled={!!disabledReason}
            render={
              <Button variant="ghost" size="xs" aria-label="Set issue type" />
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
        </span>
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
