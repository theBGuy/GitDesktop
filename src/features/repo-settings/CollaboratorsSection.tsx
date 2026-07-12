import { UserPlusIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
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
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { AsyncListBody, InlineConfirm } from "./parts";

const ROLES: { value: RepoRole; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "triage", label: "Triage" },
  { value: "write", label: "Write" },
  { value: "maintain", label: "Maintain" },
  { value: "admin", label: "Admin" },
];

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

  const canAdd = validUsername(username.trim()) && !add.isPending;

  function addCollaborator() {
    add.mutate(
      { username: username.trim(), role },
      {
        onSuccess: (pending) => {
          toast.success(pending ? "Invitation sent" : "Collaborator added");
          setUsername("");
        },
        onError: toastError,
      },
    );
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
              if (e.key === "Enter" && canAdd) addCollaborator();
            }}
          />
          <Select
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
            <span className="font-medium text-foreground">Write</span> roles only.
            Triage, Maintain, and Admin apply to organization repositories.
          </p>
        )}
      </div>

      <AsyncListBody
        loading={collaborators.isLoading}
        error={collaborators.error}
        empty={collaborators.data?.length === 0}
        emptyLabel="No collaborators yet."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load collaborators."
        errorHint="Managing collaborators needs repo-admin access."
      >
        {collaborators.data?.map((c) => {
          const key = `collab:${c.login}`;
          return (
            <PersonRow
              key={c.login}
              login={c.login}
              avatarUrl={c.avatarUrl}
              roleValue={c.roleName}
              roleDisabled={add.isPending}
              roles={roles}
              onRole={(r) =>
                add.mutate(
                  { username: c.login, role: r },
                  {
                    onSuccess: () => toast.success(`${c.login} is now ${r}`),
                    onError: toastError,
                  },
                )
              }
              confirming={confirming === key}
              pending={remove.isPending}
              onConfirm={() => setConfirming(key)}
              onCancel={() => setConfirming(null)}
              onRemove={() =>
                remove.mutate(c.login, {
                  onSuccess: () => {
                    toast.success(`Removed ${c.login}`);
                    setConfirming(null);
                  },
                  onError: toastError,
                })
              }
            />
          );
        })}
      </AsyncListBody>

      {invitations.data && invitations.data.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            Pending invitations
          </Label>
          {invitations.data.map((inv) => {
            const key = `invite:${inv.id}`;
            return (
              <PersonRow
                key={inv.id}
                login={inv.login}
                avatarUrl={inv.avatarUrl}
                meta={
                  inv.createdAt
                    ? `invited ${formatRelativeTime(inv.createdAt)}`
                    : "pending"
                }
                roleValue={inv.permission}
                roleDisabled={updateInvite.isPending}
                roles={roles}
                onRole={(r) =>
                  updateInvite.mutate(
                    { id: inv.id, permission: r },
                    {
                      onSuccess: () => toast.success("Invitation updated"),
                      onError: toastError,
                    },
                  )
                }
                confirming={confirming === key}
                pending={cancelInvite.isPending}
                onConfirm={() => setConfirming(key)}
                onCancel={() => setConfirming(null)}
                onRemove={() =>
                  cancelInvite.mutate(inv.id, {
                    onSuccess: () => {
                      toast.success("Invitation canceled");
                      setConfirming(null);
                    },
                    onError: toastError,
                  })
                }
              />
            );
          })}
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
    <div className="flex items-center gap-2 rounded-md border p-2 text-xs">
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
