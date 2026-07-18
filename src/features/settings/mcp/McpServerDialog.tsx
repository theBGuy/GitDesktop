import { useId, useState } from "react";
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
import { isHostAllowed, normalizeHost } from "@/lib/ai/allowed-hosts";
import { deleteMcpSecret, setMcpSecret } from "@/lib/git/api";
import type { McpServer } from "@/lib/settings/api";
import {
  emptyMcpServer,
  entriesFor,
  MCP_SCOPE_GLOBAL,
  scopeRepoPath,
  serverScope,
  validateMcpServer,
} from "@/lib/settings/mcp";
import { useRepoKeys } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { HostAllowNote } from "../HostAllowNote";
import { EntryEditor } from "./EntryEditor";
import { type EntryRow, repoBasename } from "./shared";

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
 *  from fresh local state. Save persists secret values to the OS keychain, then
 *  hands the (secret-free) server up to the settings form. */
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
  /** The draft AI allow list (the settings form both screens share), so an http
   *  URL pointing at a not-yet-allowed host can surface the advisory note. */
  allowedHosts: string[];
  /** Add a URL's host to the draft allow list — the one-click fix behind the
   *  advisory note. Mutates the draft settings, not persisted settings. */
  onAllowHost: (url: string) => void;
  onSave: (server: McpServer) => void;
  onClose: () => void;
}) {
  // Per-mount base for the field ids (label↔control association).
  const idBase = useId();
  const editing = initial !== null;
  const [draft, setDraft] = useState<McpServer>(initial ?? emptyMcpServer());
  const [rows, setRows] = useState<EntryRow[]>(initial ? toRows(initial) : []);
  const [saving, setSaving] = useState(false);
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
      label: `This repo — ${repoName ?? repoBasename(repoPath)}`,
    });
  if (curScope !== MCP_SCOPE_GLOBAL && !scopedToThisRepo)
    scopeOptions.push({
      value: curScope,
      // The stored scope is a worktree-stable identity key (`…/.git`); show the
      // containing repo folder, never a bare ".git".
      label: `${repoBasename(scopeRepoPath(curScope))} — other repo`,
    });
  // The Select's value must equal an option value. A draft scoped to the current
  // repo under a legacy raw path (curScope) won't equal the canonical "This repo"
  // option value (the identity); normalize to it so the option stays selected.
  // The `?? curScope` arm is type-level only: `scopedToThisRepo` implies repoKeys
  // is non-empty, so `thisRepoKey` is non-null here — the fallback is unreachable
  // at runtime, but TS can't narrow `thisRepoKey` across the `scopedToThisRepo`
  // check, so removing it fails the null check.
  const selectedScope = scopedToThisRepo ? (thisRepoKey ?? curScope) : curScope;

  // Reconstruct a candidate server from the live draft + rows for validation.
  function candidate(): McpServer {
    const entries = rows.map((r) => ({
      key: r.key.trim(),
      value: r.secret ? "" : r.value,
    }));
    const secretKeys = rows.filter((r) => r.secret).map((r) => r.key.trim());
    return {
      ...draft,
      name: draft.name.trim(),
      args: draft.args,
      env: isStdio ? entries : [],
      headers: isStdio ? [] : entries,
      secretKeys,
    };
  }

  const validationError = validateMcpServer(candidate(), others);

  async function save() {
    if (validationError) {
      setError(validationError);
      return;
    }
    const server = candidate();
    setSaving(true);
    setError(null);
    try {
      // Write any newly-typed secret values to the keychain (keyed per server +
      // entry name); only the names are kept in `secretKeys`, never the values.
      for (const row of rows) {
        if (row.secret && row.secretInput.trim())
          await setMcpSecret(server.id, row.key.trim(), row.secretInput);
      }
      // Clean up keychain entries for keys that are no longer secret (renamed,
      // removed, or flipped back to a plain value).
      const liveSecretKeys = new Set(server.secretKeys);
      for (const old of initial?.secretKeys ?? []) {
        if (!liveSecretKeys.has(old)) await deleteMcpSecret(server.id, old);
      }
      onSave(server);
    } catch (e) {
      setSaving(false);
      toastError(e);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
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
            <div className="space-y-2">
              <Label>Transport</Label>
              <div className="flex gap-1">
                {(["stdio", "http"] as const).map((t) => (
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
            </div>
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
              {/* The CLI connects to this URL outside GitDesktop's AI host
                  allowlist. Advisory only — never feeds validationError or
                  disables Save. Gated on a PARSEABLE host (so a half-typed
                  "http://" shows nothing, not an empty note) that isn't already
                  allowed; empty/allowlisted/local URLs show nothing. */}
              {/* The outer guard duplicates HostAllowNote's internal checks ON
                  PURPOSE: with `defaultNote={null}` the component's all-clear
                  branch would render an empty <p>, so it must never mount for a
                  parseable-and-allowed (or unparseable mid-typing) URL. */}
              {normalizeHost(draft.url) &&
                !isHostAllowed(draft.url, allowedHosts) && (
                  <HostAllowNote
                    url={draft.url}
                    allowedHosts={allowedHosts}
                    onAllowHost={onAllowHost}
                    defaultNote={null}
                    consequence="the agent CLI will still connect to it — it sits outside GitDesktop's AI host allowlist."
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
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!!validationError || saving}>
            {editing ? "Save server" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
