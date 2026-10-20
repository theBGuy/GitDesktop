import { useId, useState } from "react";
import { LabeledGroup } from "@/components/form/labeled-group";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { isWindows } from "@/lib/hotkeys/binding";
import { MCP_TRANSPORTS, type McpServer } from "@/lib/settings/api";
import {
  emptyMcpServer,
  entriesFor,
  MCP_SCOPE_GLOBAL,
  mcpHostAllowFixable,
  scopeRepoPath,
  serverScope,
  validateMcpServer,
} from "@/lib/settings/mcp";
import { useRepoKeys } from "@/lib/settings/queries";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { HostAllowNote } from "../HostAllowNote";
import { EntryEditor } from "./EntryEditor";
import {
  entryPlanFromRows,
  isSafeMcpSecretKey,
  MAX_WINDOWS_SECRET_UTF16,
  type McpSecretWriteProblem,
  secretWriteProblem,
} from "./secret-ops";
import type { EntryRow } from "./shared";

/** The validation line for a typed secret value the keychain would refuse. */
const SECRET_REFUSAL: Record<
  McpSecretWriteProblem<string>["kind"],
  (noun: string, key: string) => string
> = {
  name: (noun, key) =>
    `Secret ${noun} "${key}" can only use letters, numbers, dots, dashes and underscores in its name.`,
  length: (noun, key) =>
    `Secret ${noun} "${key}" is too long for your keychain: Windows allows at most ${MAX_WINDOWS_SECRET_UTF16.toLocaleString("en-US")} characters.`,
};

function toRows(server: McpServer): EntryRow[] {
  const secretKeys = new Set(server.secretKeys);
  return entriesFor(server).map((e) => ({
    rowId: crypto.randomUUID(),
    key: e.key,
    value: e.value,
    secret: secretKeys.has(e.key),
    secretInput: "",
  }));
}

/** Add/edit dialog for one MCP server. Mounted with a `key` so each open starts
 *  from fresh local state. Save hands the (secret-free) server and its typed
 *  secret values up to the settings form, which stages them; nothing reaches
 *  the keychain until the screen's Save commits. */
export function McpServerDialog({
  initial,
  others,
  repoPath,
  repoName,
  allowedHosts,
  onAllowHost,
  onSave,
  onClose,
}: {
  initial: McpServer | null;
  /** The other servers in the registry, for duplicate-name detection. */
  others: McpServer[];
  /** The repo open behind Settings (for the "This repo" scope option). */
  repoPath: string | null;
  repoName: string | null;
  /** The draft AI allow list (the settings form both screens share). An http URL
   *  pointing at a host that isn't on it blocks Save until the host is added. */
  allowedHosts: string[];
  /** Add a URL's host to the draft allow list — the one-click fix behind the
   *  host note. Mutates the draft settings, not persisted settings. */
  onAllowHost: (url: string) => void;
  onSave: (
    server: McpServer,
    secretWrites: { key: string; value: string }[],
  ) => void;
  onClose: () => void;
}) {
  // Per-mount base for the field ids (label↔control association).
  const idBase = useId();
  const editing = initial !== null;
  const [draft, setDraft] = useState<McpServer>(initial ?? emptyMcpServer());
  const [rows, setRows] = useState<EntryRow[]>(initial ? toRows(initial) : []);
  const [error, setError] = useState<string | null>(null);

  const isStdio = draft.transport === "stdio";
  const set = <K extends keyof McpServer>(key: K, value: McpServer[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setRow = (rowId: string, patch: Partial<EntryRow>) =>
    setRows((rs) =>
      rs.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );

  // Scope/override lookup keys for the open repo: [repoPath] while its identity
  // resolves, [repoPath, identity] once it does. A server scoped under EITHER the
  // raw checkout path (legacy) or the worktree-stable identity counts as "this
  // repo", so a scope set from a sibling worktree is recognized here.
  const repoKeys = useRepoKeys(repoPath);
  // The canonical value the "This repo" option stores + selects with: the resolved
  // identity when available (so new/changed scopes are identity-keyed, matching
  // fold-on-write), else the raw path.
  const thisRepoKey = repoKeys.length ? repoKeys[repoKeys.length - 1] : null;

  const curScope = serverScope(draft);
  // Is the draft repo-scoped to the OPEN repo (under any of its keys)? Legacy
  // raw-path scopes for the current repo read as "this repo" too — repoKeys
  // includes the raw path — so they select the "This repo" option, not "other".
  const scopedToThisRepo =
    curScope !== MCP_SCOPE_GLOBAL && repoKeys.includes(curScope);

  // Scope choices: always Global; "This repo" when one is open; plus the server's
  // own scope when it points at a DIFFERENT repo (editing it elsewhere), so that
  // assignment is preserved rather than silently dropped.
  const scopeOptions: { value: string; label: string }[] = [
    { value: MCP_SCOPE_GLOBAL, label: "Global — all repositories" },
  ];
  if (repoPath && thisRepoKey)
    scopeOptions.push({
      value: thisRepoKey,
      label: `This repo — ${repoName ?? repoNameFromPath(repoPath)}`,
    });
  if (curScope !== MCP_SCOPE_GLOBAL && !scopedToThisRepo)
    scopeOptions.push({
      value: curScope,
      // The stored scope is a worktree-stable identity key (`…/.git`); show the
      // containing repo folder, never a bare ".git".
      label: `${repoNameFromPath(scopeRepoPath(curScope))} — other repo`,
    });
  // The Select's value must equal an option value. A draft scoped to the current
  // repo under a legacy raw path (curScope) won't equal the canonical "This repo"
  // option value (the identity); normalize to it so the option stays selected.
  // The `?? curScope` arm is type-level only: `scopedToThisRepo` implies repoKeys
  // is non-empty, so `thisRepoKey` is non-null here — the fallback is unreachable
  // at runtime, but TS can't narrow `thisRepoKey` across the `scopedToThisRepo`
  // check, so removing it fails the null check.
  const selectedScope = scopedToThisRepo ? (thisRepoKey ?? curScope) : curScope;

  // The one derivation of entries, secret names and typed secret values.
  const plan = entryPlanFromRows(rows);

  // Reconstruct a candidate server from the live draft + rows for validation.
  function candidate(): McpServer {
    return {
      ...draft,
      name: draft.name.trim(),
      args: draft.args,
      env: isStdio ? plan.entries : [],
      headers: isStdio ? [] : plan.entries,
      secretKeys: plan.secretKeys,
    };
  }

  // The keychain refuses unsafe names and (on Windows) over-long values, so a
  // typed value hitting either would commit a pair no Save could ever store;
  // refuse it here instead.
  function secretRefusal(): string | null {
    const problem = secretWriteProblem(plan.secretWrites, isWindows);
    if (problem)
      return SECRET_REFUSAL[problem.kind](
        isStdio ? "variable" : "header",
        problem.key,
      );
    if (plan.secretWrites.length > 0 && !isSafeMcpSecretKey(draft.id))
      return "This server's id (edited in your settings file) can only use letters, numbers, dots, dashes and underscores to store secrets.";
    return null;
  }

  const validationError =
    validateMcpServer(candidate(), others, allowedHosts) ?? secretRefusal();

  function save() {
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onSave(candidate(), plan.secretWrites);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit MCP server" : "Add MCP server"}
          </DialogTitle>
          <DialogDescription>
            A Model Context Protocol server an agent session can opt into. Only
            the servers a session picks are passed to its CLI — nothing else on
            your machine is inherited.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-1">
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <div className="space-y-2">
              <Label htmlFor={`${idBase}-name`}>Name</Label>
              <Input
                id={`${idBase}-name`}
                autoFocus
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="filesystem"
                className="font-mono"
                spellCheck={false}
              />
            </div>
            <LabeledGroup label="Transport">
              <div className="flex gap-1">
                {MCP_TRANSPORTS.map((t) => (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={draft.transport === t ? "default" : "outline"}
                    aria-pressed={draft.transport === t}
                    className="flex-1"
                    onClick={() => set("transport", t)}
                  >
                    {t === "stdio" ? "Local (stdio)" : "Remote (HTTP)"}
                  </Button>
                ))}
              </div>
            </LabeledGroup>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${idBase}-desc`}>Description</Label>
            <Input
              id={`${idBase}-desc`}
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Local file operations"
            />
          </div>

          {scopeOptions.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor={`${idBase}-scope`}>Available in</Label>
              <Select
                value={selectedScope}
                onValueChange={(v) => v && set("scope", v)}
                // Without `items`, Base UI's SelectValue renders the RAW value in
                // the trigger — for an identity-keyed scope that's a bare
                // "…/.git" path. The map makes the trigger show the option label.
                items={Object.fromEntries(
                  scopeOptions.map((o) => [o.value, o.label]),
                )}
              >
                <SelectTrigger
                  id={`${idBase}-scope`}
                  size="sm"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopeOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Repo-scoped servers only appear in that repo's sessions.
              </p>
            </div>
          )}

          {isStdio ? (
            <>
              <div className="space-y-2">
                <Label htmlFor={`${idBase}-command`}>Command</Label>
                <Input
                  id={`${idBase}-command`}
                  value={draft.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="npx"
                  className="font-mono"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${idBase}-args`}>Arguments</Label>
                <Textarea
                  id={`${idBase}-args`}
                  value={draft.args.join("\n")}
                  onChange={(e) =>
                    set(
                      "args",
                      e.target.value.split("\n").map((a) => a.trimEnd()),
                    )
                  }
                  onBlur={() =>
                    set("args", draft.args.map((a) => a.trim()).filter(Boolean))
                  }
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
                  className="min-h-24 font-mono"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  One argument per line.
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`${idBase}-url`}>URL</Label>
              <Input
                id={`${idBase}-url`}
                value={draft.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className="font-mono"
                spellCheck={false}
              />
              {/* The guided fix for the registration gate: Save stays blocked
                  (validateMcpServer carries the same host check) until this host
                  is on the draft allow list, and allowing it here clears both.
                  Mounted only where Allow host actually clears the block — with
                  `defaultNote={null}` the all-clear branch renders an empty <p>,
                  and a malformed or non-http(s) URL is refused for a reason no
                  host can fix. */}
              {mcpHostAllowFixable(draft, allowedHosts) && (
                <HostAllowNote
                  url={draft.url}
                  allowedHosts={allowedHosts}
                  onAllowHost={onAllowHost}
                  defaultNote={null}
                  consequence="the agent CLI connects outside GitDesktop's AI allowlist, so allow it before saving."
                />
              )}
            </div>
          )}

          <EntryEditor
            label={isStdio ? "Environment variables" : "Headers"}
            keyPlaceholder={isStdio ? "API_KEY" : "Authorization"}
            rows={rows}
            editing={editing}
            onAdd={() =>
              setRows((rs) => [
                ...rs,
                {
                  rowId: crypto.randomUUID(),
                  key: "",
                  value: "",
                  secret: false,
                  secretInput: "",
                },
              ])
            }
            onChange={setRow}
            onRemove={(rowId) =>
              setRows((rs) => rs.filter((r) => r.rowId !== rowId))
            }
          />

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">
                Offer this server to new sessions by default.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => set("enabled", v)}
            />
          </label>
        </div>

        <DialogFooter>
          {error ? (
            <p className="mr-auto self-center text-xs text-destructive">
              {error}
            </p>
          ) : validationError ? (
            <p className="mr-auto self-center text-xs text-muted-foreground">
              {validationError}
            </p>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!!validationError}>
            {editing ? "Save server" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
