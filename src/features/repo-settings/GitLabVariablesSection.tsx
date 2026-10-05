import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { StatusDetailChip } from "@/components/status-detail-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  useGlDeleteVariable,
  useGlSetVariable,
  useGlVariables,
} from "@/lib/git/queries";
import type { GitLabVariable } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { useOnline } from "@/lib/use-online";
import {
  ACT_PENDING_REASON,
  InlineConfirm,
  OFFLINE_WRITE_REASON,
  RemoteListSection,
  SAVING_REASON,
  useConfirmSwapFocus,
} from "./parts";

function validKey(k: string): boolean {
  return /^[A-Za-z0-9_]{1,255}$/.test(k);
}

/** GitLab CI/CD variables — one store (vs GitHub's secrets/variables split):
 *  `masked` hides a value in job logs, `protected` limits it to protected
 *  refs. Values stay readable to maintainers, so they edit in place. */
export function GitLabVariablesSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const variables = useGlVariables(repoPath, open);
  const setVariable = useGlSetVariable(repoPath);
  const deleteVariable = useGlDeleteVariable(repoPath);
  const online = useOnline();

  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [isProtected, setIsProtected] = useState(false);
  const [isMasked, setIsMasked] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Creates are always unscoped ("*"), so only an unscoped duplicate blocks.
  const keyTaken = (variables.data ?? []).some(
    (v) => v.key === key.trim() && v.environmentScope === "*",
  );
  const canAdd =
    validKey(key.trim()) &&
    value.length > 0 &&
    !keyTaken &&
    !setVariable.isPending &&
    online;
  const keyWarning = key.trim()
    ? keyTaken
      ? "A variable with this key already exists — edit it below."
      : validKey(key.trim())
        ? null
        : "Keys use only letters, digits, and underscores."
    : null;
  // Every hold carries a reason, so Add never goes natively disabled and keeps
  // focus through a save, including the field reset after one succeeds.
  const addHeldReason = (() => {
    switch (true) {
      case !online:
        return OFFLINE_WRITE_REASON;
      // Shared with every row's Save: only an in-flight create is Add's own.
      case setVariable.isPending:
        return setVariable.variables?.create
          ? ACT_PENDING_REASON
          : SAVING_REASON;
      case !key.trim():
        return "Enter a variable key";
      case keyWarning !== null:
        return keyWarning;
      case value.length === 0:
        return "Enter a variable value";
      default:
        return undefined;
    }
  })();

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function addVariable() {
    try {
      await setVariable.mutateAsync({
        key: key.trim(),
        value,
        protected: isProtected,
        masked: isMasked,
        create: true,
        scope: "*",
      });
      toast.success(`Added ${key.trim()}`);
      setKey("");
      setValue("");
      setIsProtected(false);
      setIsMasked(false);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleSave(variable: GitLabVariable, newValue: string) {
    try {
      await setVariable.mutateAsync({
        key: variable.key,
        value: newValue,
        protected: variable.protected,
        masked: variable.masked,
        create: false,
        scope: variable.environmentScope,
      });
      toast.success(`Updated ${variable.key}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleRemove(variable: GitLabVariable) {
    try {
      await deleteVariable.mutateAsync({
        key: variable.key,
        scope: variable.environmentScope,
      });
      toast.success(`Deleted ${variable.key}`);
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div data-confirm-section className="min-w-0 space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input
            data-confirm-fallback
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
          <DisabledReasonButton
            size="sm"
            disabled={!canAdd}
            reason={addHeldReason}
            onClick={addVariable}
          >
            {setVariable.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Add
          </DisabledReasonButton>
        </div>
        <div className="flex items-center gap-4">
          <Label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={isProtected}
              onCheckedChange={(v) => setIsProtected(v === true)}
            />
            Protected (protected branches and tags only)
          </Label>
          <Label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={isMasked}
              onCheckedChange={(v) => setIsMasked(v === true)}
            />
            Masked in job logs
          </Label>
        </div>
        {keyWarning && <p className="text-[11px] text-warning">{keyWarning}</p>}
      </div>

      <RemoteListSection
        query={variables}
        rowCount={variables.data?.length ?? 0}
        noun="variables"
        loadFailed="Couldn't load variables."
        emptyLabel="No CI/CD variables yet."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load variables."
        errorHint="If this is a permissions error, managing CI/CD variables needs the Maintainer role."
      >
        {variables.data?.map((v) => {
          // A key can repeat at different environment scopes — address both.
          const rowId = `${v.key}\u0000${v.environmentScope}`;
          return (
            <VariableRow
              key={rowId}
              variable={v}
              saving={setVariable.isPending}
              writeHeld={online ? undefined : OFFLINE_WRITE_REASON}
              onSave={(newValue) => handleSave(v, newValue)}
              confirming={confirming === rowId}
              pending={deleteVariable.isPending}
              onConfirm={() => setConfirming(rowId)}
              onCancel={() => setConfirming(null)}
              onRemove={() => handleRemove(v)}
            />
          );
        })}
      </RemoteListSection>
    </div>
  );
}

function VariableRow({
  variable,
  saving,
  writeHeld,
  onSave,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onRemove,
}: {
  variable: GitLabVariable;
  saving: boolean;
  /** Why Save and the confirmed Delete are held. */
  writeHeld?: string;
  onSave: (value: string) => void;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(variable.value);
  const dirty = draft !== variable.value;
  // A key can repeat across environment scopes; a scoped row's name says which.
  const scoped = variable.environmentScope !== "*";
  const rowName = scoped
    ? `${variable.key} (${variable.environmentScope})`
    : variable.key;
  const swapFocus = useConfirmSwapFocus();

  return (
    <div data-confirm-row className="space-y-1.5 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate font-mono font-medium"
          title={variable.key}
        >
          {variable.key}
        </p>
        {scoped && (
          <StatusDetailChip
            variant="secondary"
            label={variable.environmentScope}
            detail="Scoped to this environment (scopes are managed on GitLab)"
          />
        )}
        {variable.protected && <Badge variant="secondary">protected</Badge>}
        {variable.masked && <Badge variant="secondary">masked</Badge>}
        {confirming ? (
          <InlineConfirm
            prompt="Delete?"
            actLabel="Delete"
            pending={pending}
            heldReason={writeHeld}
            swapFocusRef={swapFocus()}
            onCancel={onCancel}
            onAct={onRemove}
          />
        ) : (
          <Button
            ref={swapFocus()}
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onConfirm}
            aria-label={`Delete ${rowName}`}
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
          autoComplete="off"
          spellCheck={false}
        />
        <DisabledReasonButton
          size="sm"
          variant="outline"
          disabled={!dirty || saving || writeHeld !== undefined}
          reason={
            writeHeld ??
            (saving ? SAVING_REASON : undefined) ??
            (dirty ? undefined : "No changes to save")
          }
          onClick={() => onSave(draft)}
        >
          Save
        </DisabledReasonButton>
      </div>
    </div>
  );
}
