import { UserPlusIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { StatusDetailChip } from "@/components/status-detail-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { DegradedListNotice } from "@/features/conversations/ConversationListPanel";
import {
  offlinePendingMessage,
  parkedUnlessPermanent,
  resolveRemoteSection,
  sectionReadNotice,
} from "@/features/conversations/remote-section-state";
import {
  useGlAddMember,
  useGlMembers,
  useGlRemoveMember,
  useGlRepoSettings,
  useGlUpdateMember,
} from "@/lib/git/queries";
import type { GitLabMember } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { AsyncListBody, InlineConfirm } from "./parts";

/** The roles the app offers (the classic five — Planner is newer and not
 *  accepted by older self-managed instances; it still DISPLAYS if present). */
const ROLES: { value: number; label: string }[] = [
  { value: 10, label: "Guest" },
  { value: 20, label: "Reporter" },
  { value: 30, label: "Developer" },
  { value: 40, label: "Maintainer" },
  { value: 50, label: "Owner" },
];

function roleLabel(level: number): string {
  if (level === 15) return "Planner";
  return ROLES.find((r) => r.value === level)?.label ?? `Level ${level}`;
}

const SAVING_REASON = "Saving your last change…";

function validUsername(u: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(u);
}

/** The GitLab counterpart of {@link CollaboratorsSection}: numeric access
 *  levels instead of role names, and members inherited from a group show
 *  read-only (they're managed on the group, not the project). */
export function GitLabMembersSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const members = useGlMembers(repoPath, open);
  const settings = useGlRepoSettings(repoPath, open);
  const add = useGlAddMember(repoPath);
  const update = useGlUpdateMember(repoPath);
  const remove = useGlRemoveMember(repoPath);

  const [username, setUsername] = useState("");
  const [level, setLevel] = useState(30);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const canAdd = validUsername(username.trim()) && !add.isPending;
  // The username is the blocker to name first: it's the one the user can fix here.
  const addHeldReason = (() => {
    switch (true) {
      case username.trim() === "":
        return "Enter a GitLab username";
      case !validUsername(username.trim()):
        return "That isn't a valid GitLab username";
      case add.isPending:
        return SAVING_REASON;
      default:
        return undefined;
    }
  })();
  const roleHeld = update.isPending ? SAVING_REASON : undefined;

  const memberRows = members.data ?? [];
  // A failed or parked refresh keeps the loaded rows under a notice; only a
  // read with nothing loaded falls back to the error card or the offline line.
  const parked = parkedUnlessPermanent(members);
  const listState = resolveRemoteSection({
    ghPending: false,
    ghReady: true,
    listPending: members.isPending,
    error: members.isError,
    rowCount: memberRows.length,
    paused: parked,
  });
  const notice = sectionReadNotice({
    noun: "members",
    loadFailed: "Couldn't load members.",
    rowCount: members.data?.length,
    isError: members.isError,
    isPaused: parked,
  });
  const noticeMessage = (() => {
    switch (listState) {
      case "offline":
        return offlinePendingMessage("members");
      case "rows-degraded":
      case "rows-offline":
        return notice?.message;
      default:
        return undefined;
    }
  })();
  // GitLab namespace paths are unique across users AND groups, so a username
  // equal to the first path segment is the owner of a personal-namespace project.
  // Unknown until settings resolve, so every row keeps Remove until then.
  const ownerUsername =
    settings.data?.fullName.split("/")[0].toLowerCase() ?? null;

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function addMember() {
    try {
      await add.mutateAsync({ username: username.trim(), accessLevel: level });
      toast.success("Member added");
      setUsername("");
    } catch (e) {
      toastError(e);
    }
  }

  async function handleRole(member: GitLabMember, accessLevel: number) {
    try {
      await update.mutateAsync({ userId: member.id, accessLevel });
      toast.success(`${member.username} is now ${roleLabel(accessLevel)}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleRemove(member: GitLabMember) {
    try {
      await remove.mutateAsync(member.id);
      toast.success(`Removed ${member.username}`);
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="rounded-md border p-3">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="GitLab username"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAdd) void addMember();
            }}
          />
          <Select
            value={String(level)}
            onValueChange={(v) => v && setLevel(Number(v))}
            itemToStringLabel={(v) => roleLabel(Number(v))}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r.value} value={String(r.value)}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DisabledReasonButton
            size="sm"
            disabled={!canAdd}
            reason={addHeldReason}
            onClick={addMember}
          >
            {add.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UserPlusIcon data-icon="inline-start" />
            )}
            Add
          </DisabledReasonButton>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          GitLab grants access immediately — there's no pending-invitation step
          for existing users.
        </p>
      </div>

      <div className="space-y-2">
        <DegradedListNotice
          noun="members"
          degraded={noticeMessage !== undefined}
          message={noticeMessage}
          retryLabel={notice?.retryLabel}
          onRetry={
            listState === "rows-degraded"
              ? () => void members.refetch()
              : undefined
          }
          className="px-0 pb-0"
        />
        {listState !== "offline" && (
          <AsyncListBody
            loading={listState === "list-skeleton"}
            error={listState === "error" ? members.error : null}
            empty={listState === "empty"}
            emptyLabel="No members yet."
            skeletonClassName="h-11 w-full"
            errorTitle="Couldn't load members."
            errorHint="If this is a permissions error, managing members needs the Maintainer role."
          >
            <div
              role="listbox"
              aria-label="Members"
              tabIndex={0}
              className="space-y-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onKeyDown={listKeyboardNav({
                items: memberRows,
                activeIndex,
                onActivate: (_m, to) => setActiveIndex(to),
                rowKey: (m) => m.id,
                rowAttr: "data-member",
              })}
            >
              {memberRows.map((m, i) => {
                // Personal-namespace owner only: a group project's Owner rows stay
                // removable, since GitLab's refusal is probed for the personal case alone.
                const owner = m.username.toLowerCase() === ownerUsername;
                return (
                  <MemberRow
                    key={m.id}
                    member={m}
                    meta={owner ? "Owner" : undefined}
                    removeHeld={
                      owner
                        ? `${m.username} owns this project and can't be removed`
                        : undefined
                    }
                    active={i === activeIndex}
                    onFocus={() => setActiveIndex(i)}
                    roleHeld={roleHeld}
                    onRole={(accessLevel) => handleRole(m, accessLevel)}
                    confirming={confirming === m.id}
                    pending={remove.isPending}
                    onConfirm={() => setConfirming(m.id)}
                    onCancel={() => setConfirming(null)}
                    onRemove={() => handleRemove(m)}
                  />
                );
              })}
            </div>
          </AsyncListBody>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Members inherited from a group are managed on the group, not here.
      </p>
    </div>
  );
}

/** A row's access-level picker, held with a reason while a change saves. */
function RoleSelect({
  level,
  heldReason,
  onRole,
}: {
  level: number;
  /** Why the picker is held, as its hover text and accessible description. */
  heldReason?: string;
  onRole: (level: number) => void;
}) {
  const held = heldReason !== undefined;
  const reason = useDisabledReason({ disabled: held, reason: heldReason });
  // Held by readOnly + a gated open state, never Base UI's `disabled`: that sets
  // the trigger's tabIndex to -1, taking the picker and its reason out of reach.
  const [open, setOpen] = useState(false);
  if (held && open) setOpen(false);
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        reason.blockedReason !== null && "cursor-not-allowed",
      )}
      title={reason.wrapperTitle}
    >
      <Select
        value={String(level)}
        onValueChange={(v) => v && onRole(Number(v))}
        readOnly={held}
        open={open}
        onOpenChange={(next) => {
          if (!held) setOpen(next);
        }}
      >
        <SelectTrigger
          size="sm"
          className={cn("w-28", ARIA_DISABLED_CLASS)}
          aria-label="Role"
          aria-disabled={held || undefined}
          aria-describedby={reason.describedBy}
        >
          <SelectValue>{roleLabel(level)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((r) => (
            <SelectItem key={r.value} value={String(r.value)}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* `hidden` rather than sr-only: a description may point at hidden text, and
          an sr-only sibling would be read again as page text after the trigger. */}
      {reason.blockedReason !== null && (
        <span id={reason.reasonId} hidden>
          {reason.blockedReason}
        </span>
      )}
    </span>
  );
}

function MemberRow({
  member,
  meta,
  removeHeld,
  active,
  onFocus,
  roleHeld,
  onRole,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onRemove,
}: {
  member: GitLabMember;
  meta?: string;
  /** Why this member can't be removed; unset leaves Remove enabled. */
  removeHeld?: string;
  active: boolean;
  onFocus: () => void;
  /** Why the role picker is held; unset leaves it editable. */
  roleHeld?: string;
  onRole: (level: number) => void;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  // A confirm opened before settings named the owner yields to the hold.
  const showConfirm = confirming && removeHeld === undefined;
  return (
    <div
      role="option"
      aria-selected={active}
      data-member={member.id}
      tabIndex={-1}
      onFocus={onFocus}
      className={cn(
        "flex items-center gap-2 rounded-md border p-2 text-xs outline-none",
        active && "ring-1 ring-ring",
      )}
    >
      <ForgeUserAvatar
        login={member.username}
        avatarUrl={member.avatarUrl}
        decorative
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={member.username}>
          {member.username}
        </p>
        {meta && <p className="truncate text-muted-foreground">{meta}</p>}
      </div>
      {!member.direct ? (
        <StatusDetailChip
          variant="secondary"
          label={`${roleLabel(member.accessLevel)} · inherited`}
          detail="Managed on the group"
        />
      ) : showConfirm ? (
        <InlineConfirm
          prompt="Remove?"
          actLabel="Remove"
          pending={pending}
          onCancel={onCancel}
          onAct={onRemove}
        />
      ) : (
        <>
          <RoleSelect
            level={member.accessLevel}
            heldReason={roleHeld}
            onRole={onRole}
          />
          {removeHeld !== undefined ? (
            <DisabledReasonButton
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled
              reason={removeHeld}
              aria-label={`Remove ${member.username}`}
            >
              <XIcon />
            </DisabledReasonButton>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={onConfirm}
              title="Remove"
              aria-label={`Remove ${member.username}`}
            >
              <XIcon />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
