import { UserPlusIcon, XIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  useAddCollaborator,
  useCancelInvitation,
  useCollaborators,
  useInvitations,
  useRemoveCollaborator,
  useRepoSettings,
  useUpdateInvitation,
} from "@/lib/git/queries";
import type { RepoRole } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { formatRelativeTime, parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { AsyncListBody, InlineConfirm } from "./parts";

const ROLES: { value: RepoRole; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "triage", label: "Triage" },
  { value: "write", label: "Write" },
  { value: "maintain", label: "Maintain" },
  { value: "admin", label: "Admin" },
];

/** Labels for every role, for the selects' triggers (without them Base UI shows the
 *  raw role, "maintain") and the static role text on a personal repo. */
const ROLE_ITEMS: Record<string, string> = Object.fromEntries(
  ROLES.map((r) => [r.value, r.label]),
);

const ROLES_UNREAD_REASON =
  "Couldn't check which roles this repository supports";
const SAVING_REASON = "Saving your last change…";

function validUsername(u: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(u);
}

export function CollaboratorsSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const collaborators = useCollaborators(repoPath, open);
  const invitations = useInvitations(repoPath, open);
  const settings = useRepoSettings(repoPath, open);
  const add = useAddCollaborator(repoPath);
  const remove = useRemoveCollaborator(repoPath);
  const updateInvite = useUpdateInvitation(repoPath);
  const cancelInvite = useCancelInvitation(repoPath);

  // Every collaborator on a USER-owned repo gets write: GitHub 422s a read invite and
  // silently clamps triage/maintain/admin to write. So a KNOWN personal repo offers no
  // role picker, and Invite and the row pickers hold until org-ness resolves rather
  // than send a role blind (a clamped row pick would toast the role it didn't get).
  const personal = settings.data !== undefined && !settings.data.isOrg;
  const rolesUnknownReason = (() => {
    switch (true) {
      case settings.data !== undefined:
        return undefined;
      case settings.isError:
        return ROLES_UNREAD_REASON;
      default:
        return "Checking which roles this repository supports…";
    }
  })();

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<RepoRole>("read");
  const inviteRole: RepoRole = personal ? "write" : role;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [activeCollab, setActiveCollab] = useState(-1);
  const [activeInvite, setActiveInvite] = useState(-1);
  const invitesLabelId = useId();
  // `meta` is a plain string prop, so the shared clock has to be threaded in by
  // hand — `<RelativeTime>` can't render there.
  const now = useRelativeNow();

  const canAdd =
    validUsername(username.trim()) &&
    !add.isPending &&
    rolesUnknownReason === undefined;
  // The username is the blocker to name first: it's the one the user can fix here.
  const inviteHeldReason = (() => {
    switch (true) {
      case username.trim() === "":
        return "Enter a GitHub username";
      case !validUsername(username.trim()):
        return "That isn't a valid GitHub username";
      case add.isPending:
        return SAVING_REASON;
      default:
        return rolesUnknownReason;
    }
  })();
  const collabRoleHeld =
    rolesUnknownReason ?? (add.isPending ? SAVING_REASON : undefined);
  const inviteRoleHeld =
    rolesUnknownReason ?? (updateInvite.isPending ? SAVING_REASON : undefined);

  const collabRows = collaborators.data ?? [];
  const inviteRows = invitations.data ?? [];
  // A personal repo's owner is listed as a collaborator but can't be removed.
  // Unknown until settings resolve, so every row keeps Remove until then; an
  // org-owned repo has no owner row.
  const ownerLogin =
    settings.data && !settings.data.isOrg
      ? settings.data.fullName.split("/")[0].toLowerCase()
      : null;

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function addCollaborator() {
    try {
      const pending = await add.mutateAsync({
        username: username.trim(),
        role: inviteRole,
      });
      toast.success(pending ? "Invitation sent" : "Collaborator added");
      setUsername("");
    } catch (e) {
      toastError(e);
    }
  }

  async function setCollaboratorRole(login: string, next: RepoRole) {
    try {
      await add.mutateAsync({ username: login, role: next });
      toast.success(`${login} is now ${next}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function removeCollaborator(login: string) {
    try {
      await remove.mutateAsync(login);
      toast.success(`Removed ${login}`);
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  async function setInvitationRole(id: string, permission: RepoRole) {
    try {
      await updateInvite.mutateAsync({ id, permission });
      toast.success("Invitation updated");
    } catch (e) {
      toastError(e);
    }
  }

  async function cancelInvitation(id: string) {
    try {
      await cancelInvite.mutateAsync(id);
      toast.success("Invitation canceled");
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
            placeholder="GitHub username"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAdd) void addCollaborator();
            }}
          />
          <RoleSlot personal={personal} value={inviteRole} onRole={setRole} />
          <DisabledReasonButton
            size="sm"
            disabled={!canAdd}
            reason={inviteHeldReason}
            onClick={addCollaborator}
          >
            {add.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UserPlusIcon data-icon="inline-start" />
            )}
            Invite
          </DisabledReasonButton>
        </div>
        {personal && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Collaborators on a personal repository get{" "}
            <span className="font-medium text-foreground">Write</span> access.
            Read, Triage, Maintain, and Admin roles need the repository in an
            organization.
          </p>
        )}
        {/* The settings read has `retry: false`: an error holds Invite and the row
            pickers until a re-read: this Retry, the window-focus `["repo"]`
            invalidation, or reopening the dialog. */}
        {rolesUnknownReason === ROLES_UNREAD_REASON && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <p>{ROLES_UNREAD_REASON}.</p>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void settings.refetch()}
            >
              {settings.isFetching && <Spinner data-icon="inline-start" />}
              Retry
            </Button>
          </div>
        )}
      </div>

      <AsyncListBody
        loading={collaborators.isPending}
        error={collaborators.error}
        empty={collaborators.data?.length === 0}
        emptyLabel="No collaborators yet."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load collaborators."
        errorHint="Managing collaborators needs repo-admin access."
      >
        <div
          role="listbox"
          aria-label="Collaborators"
          tabIndex={0}
          className="space-y-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onKeyDown={listKeyboardNav({
            items: collabRows,
            activeIndex: activeCollab,
            onActivate: (_c, to) => setActiveCollab(to),
            rowKey: (c) => c.login,
            rowAttr: "data-collab",
          })}
        >
          {collabRows.map((c, i) => {
            const key = `collab:${c.login}`;
            const owner = c.login.toLowerCase() === ownerLogin;
            return (
              <PersonRow
                key={c.login}
                login={c.login}
                avatarUrl={c.avatarUrl}
                meta={owner ? "Owner" : undefined}
                removeHeld={
                  owner
                    ? `${c.login} owns this repository and can't be removed`
                    : undefined
                }
                dataKey={c.login}
                dataAttr="data-collab"
                active={i === activeCollab}
                onFocus={() => setActiveCollab(i)}
                roleValue={c.roleName}
                roleHeld={collabRoleHeld}
                personal={personal}
                onRole={(r) => setCollaboratorRole(c.login, r)}
                confirming={confirming === key}
                pending={remove.isPending}
                onConfirm={() => setConfirming(key)}
                onCancel={() => setConfirming(null)}
                onRemove={() => removeCollaborator(c.login)}
              />
            );
          })}
        </div>
      </AsyncListBody>

      {inviteRows.length > 0 && (
        <div className="space-y-2">
          <Label id={invitesLabelId} className="text-xs text-muted-foreground">
            Pending invitations
          </Label>
          <div
            role="listbox"
            aria-labelledby={invitesLabelId}
            tabIndex={0}
            className="space-y-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={listKeyboardNav({
              items: inviteRows,
              activeIndex: activeInvite,
              onActivate: (_inv, to) => setActiveInvite(to),
              rowKey: (inv) => inv.id,
              rowAttr: "data-invite",
            })}
          >
            {inviteRows.map((inv, i) => {
              const key = `invite:${inv.id}`;
              return (
                <PersonRow
                  key={inv.id}
                  login={inv.login}
                  avatarUrl={inv.avatarUrl}
                  dataKey={inv.id}
                  dataAttr="data-invite"
                  active={i === activeInvite}
                  onFocus={() => setActiveInvite(i)}
                  meta={
                    inv.createdAt && parseableDate(inv.createdAt)
                      ? `invited ${formatRelativeTime(inv.createdAt, now)}`
                      : "pending"
                  }
                  roleValue={inv.permission}
                  roleHeld={inviteRoleHeld}
                  personal={personal}
                  onRole={(r) => setInvitationRole(inv.id, r)}
                  confirming={confirming === key}
                  pending={cancelInvite.isPending}
                  onConfirm={() => setConfirming(key)}
                  onCancel={() => setConfirming(null)}
                  onRemove={() => cancelInvitation(inv.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Removing someone revokes only their direct access — they may still reach
        the repo through a team or organization.
      </p>
    </div>
  );
}

/** A role picker, or on a personal repo, where every collaborator gets write, the
 *  role as static text in the picker's slot. The full role set stays offered until
 *  org-ness resolves, so a cached org row's maintain/admin keeps a matching item. */
function RoleSlot({
  personal,
  value,
  heldReason,
  onRole,
}: {
  personal: boolean;
  value: string;
  /** Why the picker is held, as its hover text and accessible description. */
  heldReason?: string;
  onRole: (role: RepoRole) => void;
}) {
  const held = heldReason !== undefined;
  const reason = useDisabledReason({ disabled: held, reason: heldReason });
  // Held by readOnly + a gated open state, never Base UI's `disabled`: that sets
  // the trigger's tabIndex to -1, taking the picker and its reason out of reach.
  const [open, setOpen] = useState(false);
  if (held && open) setOpen(false);
  if (personal)
    return (
      <span className="flex h-7 w-28 shrink-0 items-center pl-2.5 text-xs">
        <span className="sr-only">Role: </span>
        {ROLE_ITEMS[value] ?? value}
      </span>
    );
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        reason.blockedReason !== null && "cursor-not-allowed",
      )}
      title={reason.wrapperTitle}
    >
      <Select
        items={ROLE_ITEMS}
        value={value}
        onValueChange={(v) => v && onRole(v as RepoRole)}
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
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((r) => (
            <SelectItem key={r.value} value={r.value}>
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

function PersonRow({
  login,
  avatarUrl,
  meta,
  removeHeld,
  dataKey,
  dataAttr,
  active,
  onFocus,
  roleValue,
  roleHeld,
  personal,
  onRole,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onRemove,
}: {
  login: string;
  avatarUrl: string;
  meta?: string;
  /** Why this person can't be removed; unset leaves Remove enabled. */
  removeHeld?: string;
  dataKey: string;
  dataAttr: string;
  active: boolean;
  onFocus: () => void;
  roleValue: string;
  /** Why the role picker is held; unset leaves it editable. */
  roleHeld?: string;
  personal: boolean;
  onRole: (role: RepoRole) => void;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      {...{ [dataAttr]: dataKey }}
      tabIndex={-1}
      onFocus={onFocus}
      className={cn(
        "flex items-center gap-2 rounded-md border p-2 text-xs outline-none",
        active && "ring-1 ring-ring",
      )}
    >
      <ForgeUserAvatar login={login} avatarUrl={avatarUrl} decorative />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={login}>
          {login}
        </p>
        {meta && <p className="truncate text-muted-foreground">{meta}</p>}
      </div>
      {/* A confirm opened before settings named the owner yields to the hold. */}
      {confirming && removeHeld === undefined ? (
        <InlineConfirm
          prompt="Remove?"
          actLabel="Remove"
          pending={pending}
          onCancel={onCancel}
          onAct={onRemove}
        />
      ) : (
        <>
          <RoleSlot
            personal={personal}
            value={roleValue}
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
              aria-label={`Remove ${login}`}
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
              aria-label={`Remove ${login}`}
            >
              <XIcon />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
