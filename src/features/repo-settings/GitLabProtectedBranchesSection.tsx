import { CaretLeftIcon, PlusIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import {
  useGlProtectBranch,
  useGlProtectedBranches,
  useGlUnprotectBranch,
  useGlUpdateProtectedBranch,
} from "@/lib/git/queries";
import type {
  GitLabAccessLevelEntry,
  GitLabProtectedBranch,
} from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { AsyncListBody, InlineConfirm } from "./parts";

/** GitLab's protectable access levels, for both the "allowed to push" and
 *  "allowed to merge" allow lists. Free tier exposes these three roles; the
 *  numeric codes are GitLab's own. */
const ACCESS_LEVELS = [
  { value: "0", label: "No one" },
  { value: "30", label: "Developers + Maintainers" },
  { value: "40", label: "Maintainers" },
] as const;

/** {code → label} for our known roles; falls back to the API's own
 *  `description` for anything else (e.g. Premium user/group/deploy-key entries). */
const LEVEL_LABELS: Record<number, string> = {
  0: "No one",
  30: "Developers + Maintainers",
  40: "Maintainers",
};

/** Base UI's <Select> resolves value → label from an `items` map; without it a
 *  closed select falls back to the raw value ("40"). */
const ACCESS_LEVEL_ITEMS: Record<string, string> = Object.fromEntries(
  ACCESS_LEVELS.map((o) => [o.value, o.label]),
);

/** Join an allow list into a readable label, using our role names for known
 *  levels and the API description for the rest. */
function levelSummary(entries: GitLabAccessLevelEntry[]): string {
  if (entries.length === 0) return "No one";
  return entries
    .map((e) => LEVEL_LABELS[e.accessLevel] ?? e.description)
    .join(", ");
}

/** GitLab protected branches: list the project's rules, protect a branch or
 *  wildcard, toggle force-push in place (optimistic), and unprotect. Levels are
 *  set at creation only (the REST API ignores level changes on Free tier), so
 *  rows carry just the force-push toggle; group-inherited rules are read-only. */
export function GitLabProtectedBranchesSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const branches = useGlProtectedBranches(repoPath, open);
  const updateBranch = useGlUpdateProtectedBranch(repoPath);
  const unprotect = useGlUnprotectBranch(repoPath);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — a failure would revert silently on refetch.
  async function handleToggleForcePush(name: string, allowForcePush: boolean) {
    try {
      await updateBranch.mutateAsync({ name, allowForcePush });
    } catch (e) {
      toastError(e);
    }
  }

  async function handleUnprotect(name: string) {
    try {
      await unprotect.mutateAsync(name);
      toast.success(`Unprotected ${name}`);
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  if (editing) {
    return (
      <ProtectBranchForm
        repoPath={repoPath}
        existing={branches.data ?? []}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Branches and wildcards protected from force pushes and unauthorized
          changes.
        </p>
        <Button size="sm" onClick={() => setEditing(true)}>
          <PlusIcon data-icon="inline-start" />
          Protect branch
        </Button>
      </div>

      <AsyncListBody
        loading={branches.isPending}
        error={branches.error}
        empty={branches.data?.length === 0}
        emptyLabel="No protected branches."
        skeletonClassName="h-14 w-full"
        errorTitle="Couldn't load protected branches."
        errorHint="Managing protected branches needs the Maintainer role."
      >
        {branches.data?.map((b) => (
          <ProtectedBranchRow
            key={b.id}
            branch={b}
            forceSaving={
              updateBranch.isPending && updateBranch.variables?.name === b.name
            }
            onToggleForcePush={(allowForcePush) =>
              handleToggleForcePush(b.name, allowForcePush)
            }
            confirming={confirming === b.name}
            unprotecting={unprotect.isPending}
            onConfirm={() => setConfirming(b.name)}
            onCancel={() => setConfirming(null)}
            onUnprotect={() => handleUnprotect(b.name)}
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function ProtectedBranchRow({
  branch,
  forceSaving,
  onToggleForcePush,
  confirming,
  unprotecting,
  onConfirm,
  onCancel,
  onUnprotect,
}: {
  branch: GitLabProtectedBranch;
  forceSaving: boolean;
  onToggleForcePush: (allowForcePush: boolean) => void;
  confirming: boolean;
  unprotecting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onUnprotect: () => void;
}) {
  const switchId = useId();
  const inheritedHint = "Inherited from the group — manage it there.";

  return (
    <div className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate font-mono font-medium"
          title={branch.name}
        >
          {branch.name}
        </p>
        {branch.inherited && (
          <Badge variant="secondary" title={inheritedHint}>
            Inherited
          </Badge>
        )}
        {confirming ? (
          <InlineConfirm
            prompt="Unprotect?"
            actLabel="Unprotect"
            pending={unprotecting}
            onCancel={onCancel}
            onAct={onUnprotect}
          />
        ) : branch.inherited ? (
          <DisabledReasonButton
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled
            reason={inheritedHint}
          >
            Unprotect
          </DisabledReasonButton>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onConfirm}
          >
            Unprotect
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">
        Push: {levelSummary(branch.pushLevels)} · Merge:{" "}
        {levelSummary(branch.mergeLevels)}
      </p>
      {branch.inherited ? (
        <span title={inheritedHint} className="inline-flex items-center gap-2">
          <Switch
            id={switchId}
            checked={branch.allowForcePush}
            disabled
            aria-label="Allow force push"
          />
          <Label htmlFor={switchId} className="text-xs text-muted-foreground">
            Allow force push
          </Label>
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={branch.allowForcePush}
            disabled={forceSaving}
            onCheckedChange={onToggleForcePush}
          />
          <Label htmlFor={switchId} className="text-xs">
            Allow force push
          </Label>
        </div>
      )}
    </div>
  );
}

function ProtectBranchForm({
  repoPath,
  existing,
  onDone,
}: {
  repoPath: string;
  existing: GitLabProtectedBranch[];
  onDone: () => void;
}) {
  const protectBranch = useGlProtectBranch(repoPath);
  const [name, setName] = useState("");
  const [pushLevel, setPushLevel] = useState("40");
  const [mergeLevel, setMergeLevel] = useState("40");
  const [allowForcePush, setAllowForcePush] = useState(false);

  const trimmed = name.trim();
  const duplicate = existing.some((b) => b.name === trimmed);
  const canProtect =
    trimmed.length > 0 && !duplicate && !protectBranch.isPending;
  const warning = !trimmed
    ? "Enter a branch name."
    : duplicate
      ? "This branch already has a protection rule."
      : null;

  async function submit() {
    try {
      await protectBranch.mutateAsync({
        name: trimmed,
        pushAccessLevel: Number(pushLevel),
        mergeAccessLevel: Number(mergeLevel),
        allowForcePush,
      });
      toast.success(`Protected ${trimmed}`);
      onDone();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <Button size="sm" variant="ghost" onClick={onDone}>
        <CaretLeftIcon data-icon="inline-start" />
        Back to protected branches
      </Button>
      <div className="space-y-3 rounded-md border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="gl-protect-name">Branch name</Label>
          <Input
            id="gl-protect-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="main or release/*"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            A wildcard like <span className="font-mono">release/*</span>{" "}
            protects every matching branch.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="gl-protect-push">Allowed to push</Label>
            <Select
              items={ACCESS_LEVEL_ITEMS}
              value={pushLevel}
              onValueChange={(v) => {
                if (v) setPushLevel(v);
              }}
            >
              <SelectTrigger id="gl-protect-push" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_LEVELS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gl-protect-merge">Allowed to merge</Label>
            <Select
              items={ACCESS_LEVEL_ITEMS}
              value={mergeLevel}
              onValueChange={(v) => {
                if (v) setMergeLevel(v);
              }}
            >
              <SelectTrigger id="gl-protect-merge" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_LEVELS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="gl-protect-force" className="text-xs">
            Allow force push
          </Label>
          <Switch
            id="gl-protect-force"
            checked={allowForcePush}
            onCheckedChange={setAllowForcePush}
          />
        </div>
        {warning && <p className="text-[11px] text-warning">{warning}</p>}
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canProtect} onClick={submit}>
            {protectBranch.isPending && <Spinner data-icon="inline-start" />}
            Protect
          </Button>
        </div>
      </div>
    </div>
  );
}
