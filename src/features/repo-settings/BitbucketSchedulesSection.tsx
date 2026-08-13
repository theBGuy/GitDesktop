import { PlusIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
  useBbCreateSchedule,
  useBbDeleteSchedule,
  useBbPipelinesConfig,
  useBbSchedules,
  useBbSetPipelinesEnabled,
  useBbSetScheduleEnabled,
  useBranches,
} from "@/lib/git/queries";
import type { BitbucketPipelineSchedule } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { PipelinesDisabledBanner } from "./BitbucketVariablesSection";
import { AsyncListBody, InlineConfirm } from "./parts";

const bbSchedulesKey = (repo: string) => ["repo", repo, "bb-schedules"];

/** Bitbucket pipeline schedules: cron-triggered pipelines on a branch. Same
 *  pipelines-disabled banner as the variables section; each row toggles enabled
 *  in place (a single discrete control, so apply-on-change) and deletes with a
 *  confirm. Cron patterns are QUARTZ format (e.g. "0 0 12 * * ?"). The list can lag
 *  a create by ~1s (server replication), so the created row is patched into the
 *  cache in the create's onSuccess and reconciled by a single delayed refetch. */
export function BitbucketSchedulesSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const config = useBbPipelinesConfig(repoPath, open);
  const setEnabled = useBbSetPipelinesEnabled(repoPath);
  const enabled = config.data?.enabled ?? false;
  const schedules = useBbSchedules(repoPath, open && enabled);
  const branches = useBranches(repoPath);
  const setScheduleEnabled = useBbSetScheduleEnabled(repoPath);
  const remove = useBbDeleteSchedule(repoPath);
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  function patchRow(row: BitbucketPipelineSchedule) {
    queryClient.setQueryData<BitbucketPipelineSchedule[]>(
      bbSchedulesKey(repoPath),
      (prev) => {
        const list = prev ?? [];
        const at = list.findIndex((s) => s.uuid === row.uuid);
        if (at >= 0) {
          const next = [...list];
          next[at] = row;
          return next;
        }
        return [...list, row];
      },
    );
  }

  // Bitbucket's schedules LIST lags a create by ~1s, so reconcile the optimistic
  // patch with a SINGLE delayed refetch (past the observed lag) — this is what
  // swaps a synthetic `pending:` uuid for the server's real one. An immediate
  // invalidate would refetch a list without the new row and keep the empty state.
  function reconcileAfterCreate() {
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: bbSchedulesKey(repoPath) });
    }, 2500);
  }

  if (config.data && !enabled) {
    return (
      <PipelinesDisabledBanner
        pending={setEnabled.isPending}
        onEnable={() =>
          setEnabled.mutate(true, {
            onSuccess: () => toast.success("Pipelines enabled"),
            onError: toastError,
          })
        }
      />
    );
  }

  if (creating) {
    return (
      <ScheduleForm
        repoPath={repoPath}
        branches={(branches.data ?? [])
          .map((b) => b.name)
          .filter((n) => !n.startsWith("gd/session/"))}
        onPatch={patchRow}
        onReconcile={reconcileAfterCreate}
        onDone={() => setCreating(false)}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Run a pipeline on a branch automatically, on a cron schedule.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          Add schedule
        </Button>
      </div>

      <AsyncListBody
        loading={schedules.isLoading}
        error={schedules.error}
        empty={schedules.data?.length === 0}
        emptyLabel="No schedules yet — a schedule runs a branch's pipeline on a recurring cron."
        skeletonClassName="h-12 w-full"
        errorTitle="Couldn't load schedules."
        errorHint="Managing schedules needs admin on this repository."
      >
        {schedules.data?.map((s) => (
          <ScheduleRow
            key={s.uuid}
            schedule={s}
            toggling={
              setScheduleEnabled.isPending &&
              setScheduleEnabled.variables?.uuid === s.uuid
            }
            onToggle={(next) =>
              setScheduleEnabled.mutate(
                { uuid: s.uuid, enabled: next },
                { onError: toastError },
              )
            }
            confirming={confirming === s.uuid}
            pending={remove.isPending}
            onConfirm={() => setConfirming(s.uuid)}
            onCancel={() => setConfirming(null)}
            onRemove={() =>
              remove.mutate(s.uuid, {
                onSuccess: () => {
                  toast.success("Schedule deleted");
                  setConfirming(null);
                },
                onError: toastError,
              })
            }
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function ScheduleRow({
  schedule,
  toggling,
  onToggle,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onRemove,
}: {
  schedule: BitbucketPipelineSchedule;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  // A just-created row carries a synthetic `pending:` uuid until the reconcile
  // refetch swaps in the server's real one; a toggle/delete against a fake uuid
  // would 404, so both controls stay disabled while it's syncing.
  const syncing = schedule.uuid.startsWith("pending:");
  return (
    <div className="flex items-center gap-2 rounded-md border p-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono font-medium" title={schedule.refName}>
          {schedule.refName}
        </p>
        <p className="mt-0.5 font-mono text-muted-foreground">
          {schedule.cronPattern}
        </p>
      </div>
      {syncing ? (
        // A natively-disabled control drops its title, so wrap it to explain why.
        <span title="Syncing with Bitbucket…" className="inline-flex">
          <Switch
            checked={schedule.enabled}
            disabled
            aria-label="Schedule enabled"
          />
        </span>
      ) : (
        <Switch
          checked={schedule.enabled}
          disabled={toggling}
          onCheckedChange={onToggle}
          aria-label="Schedule enabled"
        />
      )}
      {confirming ? (
        <InlineConfirm
          prompt="Delete?"
          actLabel="Delete"
          pending={pending}
          onCancel={onCancel}
          onAct={onRemove}
        />
      ) : syncing ? (
        <DisabledReasonButton
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled
          reason="Syncing with Bitbucket…"
        >
          Delete
        </DisabledReasonButton>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={onConfirm}
        >
          Delete
        </Button>
      )}
    </div>
  );
}

function ScheduleForm({
  repoPath,
  branches,
  onPatch,
  onReconcile,
  onDone,
}: {
  repoPath: string;
  branches: string[];
  onPatch: (row: BitbucketPipelineSchedule) => void;
  onReconcile: () => void;
  onDone: () => void;
}) {
  const create = useBbCreateSchedule(repoPath);
  const [refName, setRefName] = useState(branches[0] ?? "");
  const [cron, setCron] = useState("");

  const cronValid = cron.trim().length > 0;
  const canSave = refName.length > 0 && cronValid && !create.isPending;
  const warning = !refName
    ? "Pick a branch."
    : !cronValid
      ? "Enter a Quartz cron pattern."
      : null;

  function submit() {
    const cronPattern = cron.trim();
    const created: BitbucketPipelineSchedule = {
      // The create call returns void, so synthesize a uuid; the reconcile refetch
      // replaces it with the server's real row shortly. A random uuid (not one
      // derived from branch+cron) keeps two identical back-to-back creates from
      // colliding on the same synthetic key and overwriting in the cache.
      uuid: `pending:${crypto.randomUUID()}`,
      refName,
      cronPattern,
      enabled: true,
    };
    create.mutate(
      { refName, cronPattern, enabled: true },
      {
        onSuccess: () => {
          onPatch(created);
          onReconcile();
          toast.success("Schedule added");
          onDone();
        },
        onError: toastError,
      },
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-3 rounded-md border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="bb-schedule-branch">Branch</Label>
          <Select
            items={Object.fromEntries(branches.map((b) => [b, b]))}
            value={refName}
            onValueChange={(v) => {
              if (v) setRefName(v);
            }}
          >
            <SelectTrigger id="bb-schedule-branch" className="w-full">
              <SelectValue placeholder="Select a branch" />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bb-schedule-cron">Cron pattern</Label>
          <Input
            id="bb-schedule-cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 0 12 * * ?"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            Quartz cron format.
          </p>
        </div>
        {warning && <p className="text-[11px] text-warning">{warning}</p>}
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={submit}>
            {create.isPending && <Spinner data-icon="inline-start" />}
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}
