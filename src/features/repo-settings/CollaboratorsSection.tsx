import { UserPlusIcon, XIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import { AsyncListBody, InlineConfirm } from "./parts";

const ROLES: { value: RepoRole; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "triage", label: "Triage" },
  { value: "write", label: "Write" },
  { value: "maintain", label: "Maintain" },
  { value: "admin", label: "Admin" },
];

/** Trigger labels for the role selects — without them Base UI shows the raw
 *  role ("maintain"). Covers every role, including ones a narrowed picker omits. */
const ROLE_ITEMS: Record<string, string> = Object.fromEntries(
  ROLES.map((r) => [r.value, r.label]),
);

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

  // GitHub silently clamps triage/maintain/admin to `write` on a USER-owned repo
  // (the PUT returns 204 but never applies them), so only Read/Write actually work
  // there. Offer the granular roles on org repos only.
  const isOrg = settings.data?.isOrg ?? false;
  // Until settings resolve, show the FULL role set rather than clamping — otherwise an
  // existing org "maintain"/"admin" collaborator whose row loads from cache first would
  // briefly hold a Select value with no matching item. Once we KNOW it's a personal
  // repo, filter to the two roles that actually stick.
  const roles =
    !settings.data || settings.data.isOrg
      ? ROLES
      : ROLES.filter((r) => r.value === "read" || r.value === "write");

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<RepoRole>("read");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [activeCollab, setActiveCollab] = useState(-1);
  const [activeInvite, setActiveInvite] = useState(-1);
  const invitesLabelId = useId();
  // `meta` is a plain string prop, so the shared clock has to be threaded in by
  // hand — `<RelativeTime>` can't render there.
  const now = useRelativeNow();

  const canAdd = validUsername(username.trim()) && !add.isPending;

  const collabRows = collaborators.data ?? [];
  const inviteRows = invitations.data ?? [];

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function addCollaborator() {
    try {
      const pending = await add.mutateAsync({
        username: username.trim(),
        role,
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
          <Select
            items={ROLE_ITEMS}
            value={role}
            onValueChange={(v) => v && setRole(v as RepoRole)}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!canAdd} onClick={addCollaborator}>
            {add.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UserPlusIcon data-icon="inline-start" />
            )}
            Invite
          </Button>
        </div>
        {settings.data && !isOrg && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Personal repositories support the{" "}
            <span className="font-medium text-foreground">Read</span> and{" "}
            <span className="font-medium text-foreground">Write</span> roles
            only. Triage, Maintain, and Admin apply to organization
            repositories.
          </p>
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
            return (
              <PersonRow
                key={c.login}
                login={c.login}
                avatarUrl={c.avatarUrl}
                dataKey={c.login}
                dataAttr="data-collab"
                active={i === activeCollab}
                onFocus={() => setActiveCollab(i)}
                roleValue={c.roleName}
                roleDisabled={add.isPending}
                roles={roles}
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
                  roleDisabled={updateInvite.isPending}
                  roles={roles}
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

function PersonRow({
  login,
  avatarUrl,
  meta,
  dataKey,
  dataAttr,
  active,
  onFocus,
  roleValue,
  roleDisabled,
  roles,
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
  dataKey: string;
  dataAttr: string;
  active: boolean;
  onFocus: () => void;
  roleValue: string;
  roleDisabled: boolean;
  roles: { value: RepoRole; label: string }[];
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
      {confirming ? (
        <InlineConfirm
          prompt="Remove?"
          actLabel="Remove"
          pending={pending}
          onCancel={onCancel}
          onAct={onRemove}
        />
      ) : (
        <>
          <Select
            items={ROLE_ITEMS}
            value={roleValue}
            disabled={roleDisabled}
            onValueChange={(v) => v && onRole(v as RepoRole)}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onConfirm}
            title="Remove"
          >
            <XIcon />
          </Button>
        </>
      )}
    </div>
  );
}
