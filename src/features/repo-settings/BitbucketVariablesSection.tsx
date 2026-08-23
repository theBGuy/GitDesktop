import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  bbVariablesKey,
  useBbCreateVariable,
  useBbDeleteVariable,
  useBbPipelinesConfig,
  useBbSetPipelinesEnabled,
  useBbUpdateVariable,
  useBbVariables,
} from "@/lib/git/queries";
import type { BitbucketPipelineVariable } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { AsyncErrorCard, AsyncListBody, InlineConfirm } from "./parts";

function validKey(k: string): boolean {
  return /^[A-Za-z0-9_]{1,255}$/.test(k);
}

/** Bitbucket pipeline variables. A secured variable's value is write-only — the
 *  API never returns it, so secured rows show "Secured — value hidden" (never
 *  faked masked text). The list can lag a write by ~1s (server replication), so
 *  the created/edited row is patched into the cache by the awaited mutation's
 *  continuation and reconciled by the invalidation refetch. */
export function BitbucketVariablesSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const config = useBbPipelinesConfig(repoPath, open);
  const setEnabled = useBbSetPipelinesEnabled(repoPath);
  const enabled = config.data?.enabled ?? false;
  const variables = useBbVariables(repoPath, open && enabled);
  const create = useBbCreateVariable(repoPath);
  const remove = useBbDeleteVariable(repoPath);
  const queryClient = useQueryClient();

  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secured, setSecured] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function handleEnablePipelines() {
    try {
      await setEnabled.mutateAsync(true);
      toast.success("Pipelines enabled");
    } catch (e) {
      toastError(e);
    }
  }

  if (config.isError && !config.data) {
    return <PipelinesConfigErrorCard error={config.error} />;
  }

  if (config.data && !enabled) {
    return (
      <PipelinesDisabledBanner
        pending={setEnabled.isPending}
        onEnable={handleEnablePipelines}
      />
    );
  }

  const keyTaken = (variables.data ?? []).some((v) => v.key === key.trim());
  const canAdd =
    validKey(key.trim()) && value.length > 0 && !keyTaken && !create.isPending;
  const keyWarning = key.trim()
    ? keyTaken
      ? "A variable with this key already exists — edit it below."
      : validKey(key.trim())
        ? null
        : "Keys use only letters, digits, and underscores."
    : null;

  function patchRow(row: BitbucketPipelineVariable) {
    queryClient.setQueryData<BitbucketPipelineVariable[]>(
      bbVariablesKey(repoPath),
      (prev) => {
        const list = prev ?? [];
        const at = list.findIndex((v) => v.uuid === row.uuid);
        if (at >= 0) {
          const next = [...list];
          next[at] = row;
          return next;
        }
        return [...list, row];
      },
    );
  }

  // Bitbucket's variables LIST lags a write by ~1s, so reconcile the optimistic
  // patch with a SINGLE delayed refetch (past the observed lag) — this is what
  // swaps a synthetic `pending:` uuid for the server's real one. An immediate
  // invalidate would refetch a list without the new row and blink it out.
  function reconcileAfterWrite() {
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: bbVariablesKey(repoPath) });
    }, 2500);
  }

  async function addVariable() {
    const created: BitbucketPipelineVariable = {
      // The create call returns void, so synthesize a uuid keyed on the name;
      // the refetch replaces it with the server's real row shortly.
      uuid: `pending:${key.trim()}`,
      key: key.trim(),
      value: secured ? null : value,
      secured,
    };
    try {
      await create.mutateAsync({ key: key.trim(), value, secured });
      patchRow(created);
      reconcileAfterWrite();
      toast.success(`Added ${key.trim()}`);
      setKey("");
      setValue("");
      setSecured(false);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleRemove(uuid: string, variableKey: string) {
    try {
      await remove.mutateAsync(uuid);
      toast.success(`Deleted ${variableKey}`);
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="VARIABLE_KEY"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Button size="sm" disabled={!canAdd} onClick={addVariable}>
            {create.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Add
          </Button>
        </div>
        <Label className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={secured}
            onCheckedChange={(v) => setSecured(v === true)}
          />
          Secured
        </Label>
        <p className="text-[11px] text-muted-foreground">
          A secured variable's value can't be read back.
        </p>
        {keyWarning && <p className="text-[11px] text-warning">{keyWarning}</p>}
      </div>

      <AsyncListBody
        loading={variables.isPending}
        error={variables.error}
        empty={variables.data?.length === 0}
        emptyLabel="No pipeline variables yet."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load variables."
        errorHint="Managing pipeline variables needs admin on this repository."
      >
        {variables.data?.map((v) => (
          <VariableRow
            key={v.uuid}
            repoPath={repoPath}
            variable={v}
            onPatch={patchRow}
            onReconcile={reconcileAfterWrite}
            confirming={confirming === v.uuid}
            pending={remove.isPending}
            onConfirm={() => setConfirming(v.uuid)}
            onCancel={() => setConfirming(null)}
            onRemove={() => handleRemove(v.uuid, v.key)}
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function VariableRow({
  repoPath,
  variable,
  onPatch,
  onReconcile,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onRemove,
}: {
  repoPath: string;
  variable: BitbucketPipelineVariable;
  onPatch: (row: BitbucketPipelineVariable) => void;
  onReconcile: () => void;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const update = useBbUpdateVariable(repoPath);
  const [draft, setDraft] = useState(
    variable.secured ? "" : (variable.value ?? ""),
  );
  const [secure, setSecure] = useState(variable.secured);
  // A just-created row carries a synthetic `pending:` uuid until the reconcile
  // refetch swaps in the server's real one; edit/delete against a fake uuid would
  // 404, so they stay disabled while it's syncing.
  const syncing = variable.uuid.startsWith("pending:");
  // A secured variable's stored value never comes back, so an empty draft on a
  // secured row means "keep it" — only a non-empty draft (or a secure-state
  // change) is a real edit.
  const dirty = variable.secured
    ? draft.length > 0 || secure !== variable.secured
    : draft !== (variable.value ?? "") || secure !== variable.secured;

  async function save() {
    try {
      await update.mutateAsync({
        uuid: variable.uuid,
        value: draft,
        secured: secure,
      });
      onPatch({
        uuid: variable.uuid,
        key: variable.key,
        value: secure ? null : draft,
        secured: secure,
      });
      onReconcile();
      toast.success(`Updated ${variable.key}`);
      setDraft("");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="space-y-1.5 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate font-mono font-medium"
          title={variable.key}
        >
          {variable.key}
        </p>
        {variable.secured && <Badge variant="secondary">secured</Badge>}
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
            aria-label={`Delete ${variable.key}`}
            reason="Syncing with Bitbucket…"
          >
            <XIcon />
          </DisabledReasonButton>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onConfirm}
            aria-label={`Delete ${variable.key}`}
            title="Delete"
          >
            <XIcon />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 flex-1 font-mono"
          placeholder={variable.secured ? "Secured — value hidden" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {syncing ? (
          <DisabledReasonButton
            size="sm"
            variant="outline"
            disabled
            reason="Syncing with Bitbucket…"
          >
            Save
          </DisabledReasonButton>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || update.isPending}
            onClick={save}
          >
            {update.isPending && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        )}
      </div>
      <Label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Checkbox
          checked={secure}
          disabled={variable.secured}
          onCheckedChange={(v) => setSecure(v === true)}
        />
        Secured
        {variable.secured ? " (secured variables can't be un-secured)" : ""}
      </Label>
    </div>
  );
}

/** The card the three Pipelines sections show when the availability check itself
 *  failed. Every call site gates it on ABSENT config data, ahead of the disabled
 *  banner: a read that never landed leaves `enabled` false with nothing to tell
 *  it apart from "pipelines are off", and the section's list query stays
 *  disabled while it is, so no other surface reports the failure. A failed
 *  background REFETCH keeps the last good config, where tearing a working
 *  section down would be wrong. */
export function PipelinesConfigErrorCard({ error }: { error: unknown }) {
  return (
    <AsyncErrorCard
      title="Couldn't check whether Pipelines are enabled."
      error={error}
    />
  );
}

/** Shown when Bitbucket Pipelines is off for the repo: variables and schedules
 *  can't exist until pipelines are enabled, so offer that as the one action. */
export function PipelinesDisabledBanner({
  pending,
  onEnable,
}: {
  pending: boolean;
  onEnable: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-dashed p-4 text-xs">
      <div className="min-w-0">
        <p className="font-medium">
          Pipelines are disabled for this repository
        </p>
        <p className="mt-0.5 text-muted-foreground">
          Enable Bitbucket Pipelines to manage variables, schedules, and
          deployments.
        </p>
      </div>
      <Button size="sm" disabled={pending} onClick={onEnable}>
        {pending && <Spinner data-icon="inline-start" />}
        Enable
      </Button>
    </div>
  );
}
