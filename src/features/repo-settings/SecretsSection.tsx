import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { toast } from "sonner";
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
  useDeleteSecret,
  useDeleteVariable,
  useEnvironments,
  useSecrets,
  useSetSecret,
  useSetVariable,
  useVariables,
} from "@/lib/git/queries";
import type { SecretApp } from "@/lib/git/types";
import { formatRelativeTime, parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AsyncListBody, InlineConfirm } from "./parts";

const APPS: { value: SecretApp; label: string }[] = [
  { value: "actions", label: "Actions" },
  { value: "dependabot", label: "Dependabot" },
  { value: "codespaces", label: "Codespaces" },
];

const REPO_SCOPE = "$repo";

/** Trigger labels for the store select — without them Base UI shows the raw
 *  value ("codespaces"). */
const APP_ITEMS: Record<string, string> = Object.fromEntries(
  APPS.map((a) => [a.value, a.label]),
);

/** Trigger label for the scope sentinel. Environment names label as themselves,
 *  which is what an unmapped value already renders. */
const SCOPE_ITEMS: Record<string, string> = { [REPO_SCOPE]: "Repository" };

/** GitHub's rule: letters/digits/underscore, not starting with a digit, and not
 *  starting with GITHUB_. */
function nameError(name: string): string | null {
  if (!name) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return "Use letters, numbers and _, not starting with a number.";
  }
  if (/^github_/i.test(name)) return "Names can't start with GITHUB_.";
  return null;
}

export function SecretsSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const [kind, setKind] = useState<"secrets" | "variables">("secrets");
  const [app, setApp] = useState<SecretApp>("actions");
  const [scope, setScope] = useState<string>(REPO_SCOPE);
  const storeSelectId = useId();
  const scopeSelectId = useId();

  const envs = useEnvironments(repoPath, open);
  // Environment scope exists only for Actions (secrets and variables).
  const envAllowed = kind === "variables" || app === "actions";
  const env = envAllowed && scope !== REPO_SCOPE ? scope : null;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex rounded-md border p-0.5">
          {(["secrets", "variables"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "cursor-pointer rounded px-2.5 py-1 text-xs capitalize",
                kind === k
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k}
            </button>
          ))}
        </div>

        {kind === "secrets" && (
          <div className="space-y-1">
            <Label
              htmlFor={storeSelectId}
              className="text-[11px] text-muted-foreground"
            >
              Store
            </Label>
            <Select
              items={APP_ITEMS}
              value={app}
              onValueChange={(v) => v && setApp(v as SecretApp)}
            >
              <SelectTrigger id={storeSelectId} size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPS.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1">
          <Label
            htmlFor={scopeSelectId}
            className="text-[11px] text-muted-foreground"
          >
            Scope
          </Label>
          <Select
            items={SCOPE_ITEMS}
            value={env ?? REPO_SCOPE}
            onValueChange={(v) => v && setScope(v)}
            disabled={!envAllowed}
          >
            <SelectTrigger id={scopeSelectId} size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={REPO_SCOPE}>Repository</SelectItem>
              {(envs.data ?? []).map((e) => (
                <SelectItem
                  key={e}
                  value={e}
                  // The dropdown is pinned to the narrow trigger width, so long
                  // environment names clip. Surface the full name on hover, but
                  // only when it's actually cut off. The clip happens at the
                  // popup (overflow-x-hidden), not the inner span, so measure the
                  // item itself — a span-level check wouldn't fire here.
                  onMouseEnter={(ev) => {
                    const el = ev.currentTarget;
                    el.title = el.scrollWidth > el.clientWidth ? e : "";
                  }}
                >
                  <span className="block truncate">{e}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {kind === "secrets" ? (
        <SecretsList repoPath={repoPath} app={app} env={env} open={open} />
      ) : (
        <VariablesList repoPath={repoPath} env={env} open={open} />
      )}
    </div>
  );
}

function SecretsList({
  repoPath,
  app,
  env,
  open,
}: {
  repoPath: string;
  app: SecretApp;
  env: string | null;
  open: boolean;
}) {
  const secrets = useSecrets(repoPath, app, env, open);
  const set = useSetSecret(repoPath);
  const del = useDeleteSecret(repoPath);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  // `meta` is a plain string prop, so the shared clock has to be threaded in by
  // hand — `<RelativeTime>` can't render there.
  const now = useRelativeNow();
  const invalid = nameError(name);
  const canAdd = !!name && !!value && !invalid && !set.isPending;

  function add() {
    set.mutate(
      { app, env, name: name.trim(), value },
      {
        onSuccess: () => {
          toast.success("Secret saved");
          setName("");
          setValue("");
        },
        onError: toastError,
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3">
        <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
          <div className="space-y-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SECRET_NAME"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            {invalid && (
              <p className="text-[11px] text-destructive">{invalid}</p>
            )}
          </div>
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value"
            autoComplete="off"
          />
          <Button size="sm" disabled={!canAdd} onClick={add}>
            {set.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Add
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Encrypted before it leaves your machine. The value can't be shown
          again — re-enter it to change it.
        </p>
      </div>

      <AsyncListBody
        loading={secrets.isLoading}
        error={secrets.error}
        empty={secrets.data?.length === 0}
        emptyLabel="No secrets here yet."
        errorScope="repo"
      >
        {secrets.data?.map((s) => (
          <Row
            key={s.name}
            name={s.name}
            meta={
              s.updatedAt && parseableDate(s.updatedAt)
                ? `Updated ${formatRelativeTime(s.updatedAt, now)}`
                : ""
            }
            confirming={confirming === s.name}
            pending={del.isPending}
            onConfirm={() => setConfirming(s.name)}
            onCancel={() => setConfirming(null)}
            onDelete={() =>
              del.mutate(
                { app, env, name: s.name },
                {
                  onSuccess: () => {
                    toast.success("Secret removed");
                    setConfirming(null);
                  },
                  onError: toastError,
                },
              )
            }
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function VariablesList({
  repoPath,
  env,
  open,
}: {
  repoPath: string;
  env: string | null;
  open: boolean;
}) {
  const variables = useVariables(repoPath, env, open);
  const set = useSetVariable(repoPath);
  const del = useDeleteVariable(repoPath);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const invalid = nameError(name);
  const canAdd = !!name && !invalid && !set.isPending;

  function add() {
    set.mutate(
      { env, name: name.trim(), value },
      {
        onSuccess: () => {
          toast.success("Variable saved");
          setName("");
          setValue("");
        },
        onError: toastError,
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3">
        <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
          <div className="space-y-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VARIABLE_NAME"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            {invalid && (
              <p className="text-[11px] text-destructive">{invalid}</p>
            )}
          </div>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value"
            autoComplete="off"
          />
          <Button size="sm" disabled={!canAdd} onClick={add}>
            {set.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Save
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Reusing an existing name updates that variable.
        </p>
      </div>

      <AsyncListBody
        loading={variables.isLoading}
        error={variables.error}
        empty={variables.data?.length === 0}
        emptyLabel="No variables here yet."
        errorScope="repo"
      >
        {variables.data?.map((v) => (
          <Row
            key={v.name}
            name={v.name}
            meta={v.value}
            metaMono
            confirming={confirming === v.name}
            pending={del.isPending}
            onConfirm={() => setConfirming(v.name)}
            onCancel={() => setConfirming(null)}
            onEdit={() => {
              setName(v.name);
              setValue(v.value);
            }}
            onDelete={() =>
              del.mutate(
                { env, name: v.name },
                {
                  onSuccess: () => {
                    toast.success("Variable removed");
                    setConfirming(null);
                  },
                  onError: toastError,
                },
              )
            }
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function Row({
  name,
  meta,
  metaMono,
  confirming,
  pending,
  onConfirm,
  onCancel,
  onDelete,
  onEdit,
}: {
  name: string;
  meta: string;
  metaMono?: boolean;
  confirming: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border p-2.5 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono font-medium">{name}</p>
        {meta && (
          <p
            className={cn(
              "truncate text-muted-foreground",
              metaMono && "font-mono",
            )}
          >
            {meta}
          </p>
        )}
      </div>
      {confirming ? (
        <InlineConfirm
          prompt="Delete?"
          actLabel="Delete"
          pending={pending}
          onCancel={onCancel}
          onAct={onDelete}
        />
      ) : (
        <>
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            aria-label={`Delete ${name}`}
            onClick={onConfirm}
          >
            <TrashIcon />
          </Button>
        </>
      )}
    </div>
  );
}
