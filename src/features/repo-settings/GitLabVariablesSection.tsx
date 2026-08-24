import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
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
import { AsyncListBody, InlineConfirm } from "./parts";

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
    !setVariable.isPending;
  const keyWarning = key.trim()
    ? keyTaken
      ? "A variable with this key already exists — edit it below."
      : validKey(key.trim())
        ? null
        : "Keys use only letters, digits, and underscores."
    : null;

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
            {setVariable.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Add
          </Button>
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

      <AsyncListBody
        loading={variables.isPending}
        error={variables.error}
        empty={variables.data?.length === 0}
        emptyLabel="No CI/CD variables yet."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load variables."
        errorHint="Managing CI/CD variables needs the Maintainer role."
      >
        {variables.data?.map((v) => {
          // A key can repeat at different environment scopes — address both.
          const rowId = `${v.key}\u0000${v.environmentScope}`;
          return (
            <VariableRow
              key={rowId}
              variable={v}
              saving={setVariable.isPending}
              onSave={(newValue) => handleSave(v, newValue)}
              confirming={confirming === rowId}
              pending={deleteVariable.isPending}
              onConfirm={() => setConfirming(rowId)}
              onCancel={() => setConfirming(null)}
              onRemove={() => handleRemove(v)}
            />
          );
        })}
      </AsyncListBody>
    </div>
  );
}

function VariableRow({
  variable,
  saving,
  onSave,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onRemove,
}: {
  variable: GitLabVariable;
  saving: boolean;
  onSave: (value: string) => void;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(variable.value);
  const dirty = draft !== variable.value;

  return (
    <div className="space-y-1.5 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate font-mono font-medium"
          title={variable.key}
        >
          {variable.key}
        </p>
        {variable.environmentScope !== "*" && (
          <Badge
            variant="secondary"
            title="Scoped to this environment (scopes are managed on GitLab)"
          >
            {variable.environmentScope}
          </Badge>
        )}
        {variable.protected && <Badge variant="secondary">protected</Badge>}
        {variable.masked && <Badge variant="secondary">masked</Badge>}
        {confirming ? (
          <InlineConfirm
            prompt="Delete?"
            actLabel="Delete"
            pending={pending}
            onCancel={onCancel}
            onAct={onRemove}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onConfirm}
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
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => onSave(draft)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
