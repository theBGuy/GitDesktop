import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/clipboard";
import { withForm } from "@/lib/form";
import {
  appExePath,
  deleteMcpSecret,
  mcpJsonWrite,
  setMcpSecret,
} from "@/lib/git/api";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { McpServer } from "@/lib/settings/api";
import {
  effectiveMcpState,
  emptyMcpServer,
  entriesFor,
  MCP_SCOPE_GLOBAL,
  type McpRepoState,
  serverScope,
  validateMcpServer,
} from "@/lib/settings/mcp";
import {
  discoverMcpServers,
  type ImportCandidate,
  toImportCandidate,
} from "@/lib/settings/mcp-import";
import {
  ghRepoStats,
  npmWeeklyDownloadsBatch,
  type RegistryCandidate,
  type RepoStat,
  repoKey,
  searchGithub,
  searchRegistry,
  uniqueServerName,
} from "@/lib/settings/mcp-registry";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { settingsFormOpts } from "./settings-form";

/** One editable env-var (stdio) / header (http) row in the dialog. Kept with a
 *  stable local `rowId` so renaming a key doesn't reorder or lose focus, and a
 *  separate `secretInput` for a newly-typed secret (the saved value is never
 *  read back out of the keychain). */
interface EntryRow {
  rowId: string;
  key: string;
  value: string;
  secret: boolean;
  secretInput: string;
}

/** Last path segment of a repo root, for labelling a repo scope. */
function repoBasename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

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
function McpServerDialog({
  initial,
  others,
  repoPath,
  repoName,
  onSave,
  onClose,
}: {
  initial: McpServer | null;
  /** The other servers in the registry, for duplicate-name detection. */
  others: McpServer[];
  /** The repo open behind Settings (for the "This repo" scope option). */
  repoPath: string | null;
  repoName: string | null;
  onSave: (server: McpServer) => void;
  onClose: () => void;
}) {
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

  // Scope choices: always Global; "This repo" when one is open; plus the server's
  // own scope when it points at a DIFFERENT repo (editing it elsewhere), so that
  // assignment is preserved rather than silently dropped.
  const scopeOptions: { value: string; label: string }[] = [
    { value: MCP_SCOPE_GLOBAL, label: "Global — all repositories" },
  ];
  if (repoPath)
    scopeOptions.push({
      value: repoPath,
      label: `This repo — ${repoName ?? repoBasename(repoPath)}`,
    });
  const curScope = serverScope(draft);
  if (curScope !== MCP_SCOPE_GLOBAL && curScope !== repoPath)
    scopeOptions.push({
      value: curScope,
      label: `${repoBasename(curScope)} — other repo`,
    });

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
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
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
            <Label htmlFor="mcp-desc">Description</Label>
            <Input
              id="mcp-desc"
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Local file operations"
            />
          </div>

          {scopeOptions.length > 1 && (
            <div className="space-y-2">
              <Label>Available in</Label>
              <Select
                value={serverScope(draft)}
                onValueChange={(v) => v && set("scope", v)}
              >
                <SelectTrigger size="sm" className="w-full">
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
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  value={draft.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="npx"
                  className="font-mono"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-args">Arguments</Label>
                <Textarea
                  id="mcp-args"
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
              <Label htmlFor="mcp-url">URL</Label>
              <Input
                id="mcp-url"
                value={draft.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className="font-mono"
                spellCheck={false}
              />
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

/** The env-var / header rows editor inside the dialog. Each row can hold a plain
 *  value or be marked secret (masked, stored in the keychain). */
function EntryEditor({
  label,
  keyPlaceholder,
  rows,
  editing,
  onAdd,
  onChange,
  onRemove,
}: {
  label: string;
  keyPlaceholder: string;
  rows: EntryRow[];
  editing: boolean;
  onAdd: () => void;
  onChange: (rowId: string, patch: Partial<EntryRow>) => void;
  onRemove: (rowId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={onAdd}>
          <PlusIcon data-icon="inline-start" /> Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.rowId} className="flex items-center gap-2">
              <Input
                value={row.key}
                onChange={(e) => onChange(row.rowId, { key: e.target.value })}
                placeholder={keyPlaceholder}
                className="w-44 shrink-0 font-mono"
                spellCheck={false}
              />
              <Input
                type={row.secret ? "password" : "text"}
                value={row.secret ? row.secretInput : row.value}
                onChange={(e) =>
                  onChange(
                    row.rowId,
                    row.secret
                      ? { secretInput: e.target.value }
                      : { value: e.target.value },
                  )
                }
                placeholder={
                  row.secret
                    ? editing
                      ? "•••• (leave blank to keep saved)"
                      : "secret value"
                    : "value"
                }
                className="flex-1 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-pressed={row.secret}
                aria-label={
                  row.secret ? "Stored in keychain" : "Store in keychain"
                }
                title={
                  row.secret
                    ? "Secret — stored in your OS keychain"
                    : "Mark as a secret (store in OS keychain)"
                }
                onClick={() => onChange(row.rowId, { secret: !row.secret })}
              >
                {row.secret ? (
                  <LockSimpleIcon className="text-primary" />
                ) : (
                  <LockSimpleOpenIcon />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove"
                onClick={() => onRemove(row.rowId)}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-repo state picker for a GLOBAL server, shown on its row when a repo is
 *  open: On (available + default-on) / Optional (available, off by default) /
 *  Off (not offered here), or "Default" to follow the global Enabled. Muted
 *  while inheriting; solid once this repo overrides it. */
function PerRepoStateControl({
  server,
  repoPath,
  disabled,
  onChange,
}: {
  server: McpServer;
  repoPath: string;
  disabled?: boolean;
  onChange: (state: McpRepoState | null) => void;
}) {
  const override = server.repoOverrides?.[repoPath];
  const baseline = server.enabled ? "On" : "Optional";
  return (
    <Select
      value={override ?? "default"}
      disabled={disabled}
      onValueChange={(v) =>
        v && onChange(v === "default" ? null : (v as McpRepoState))
      }
    >
      <SelectTrigger
        size="sm"
        aria-label={`Availability of ${server.name} in this repo`}
        className={`w-auto gap-1 ${override ? "" : "text-muted-foreground"}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default · {baseline}</SelectItem>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="optional">Optional</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Bottom-of-section disclosure: the inverse of the rest of this panel. Instead of
 *  consuming MCP servers, expose GitDesktop's OWN read-only git/GitHub tools to
 *  external clients, which run the app as a stdio server via `gitdesktop mcp`.
 *  Collapsed by default — it's a one-time setup, not part of the daily list. */
function GitDesktopAsServer({ repoPath }: { repoPath: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Two config variants driven by checkboxes: Shareable (portable env-var paths
  // a teammate can commit) vs Personal (absolute machine paths), and whether to
  // expose the opt-in local-PR write tools (`--allow-write`).
  const [shareable, setShareable] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [writing, setWriting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The command is this app's own executable; resolved once (it can't change
  // mid-session). Falls back to a bare name only while the path is loading.
  const { data: exePath } = useQuery({
    queryKey: ["app-exe-path"],
    queryFn: appExePath,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Single source of truth for both Copy and Write — the exact entry that gets
  // merged into .mcp.json under `mcpServers.gitdesktop`.
  const entry = useMemo(() => {
    const args = shareable
      ? ["mcp", "--repo", "${CLAUDE_PROJECT_DIR:-.}"]
      : ["mcp", "--repo", repoPath ?? "<path to your repo>"];
    if (allowWrite) args.push("--allow-write");
    return {
      command: shareable
        ? "${GITDESKTOP_BIN:-gitdesktop}"
        : (exePath ?? "gitdesktop"),
      args,
    };
  }, [shareable, allowWrite, repoPath, exePath]);

  const snippet = JSON.stringify(
    { mcpServers: { gitdesktop: entry } },
    null,
    2,
  );

  async function copy() {
    await copyText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Fire the toast whose wording matches the variant just written.
  function writeSuccessToast() {
    toast.success(
      shareable
        ? ".mcp.json written — commit it to share with your team"
        : ".mcp.json written — paths are machine-specific, consider gitignoring it",
    );
  }

  // Write .mcp.json without clobbering an existing entry; if one exists, ask
  // before replacing. `overwrite` is only ever true on the confirm path.
  async function write(overwrite: boolean) {
    if (!repoPath || writing) return;
    setWriting(true);
    try {
      const result = await mcpJsonWrite(repoPath, entry, overwrite);
      if (result.existed && !result.written) {
        setConfirmOpen(true);
        return;
      }
      setConfirmOpen(false);
      writeSuccessToast();
    } catch (e) {
      toastError(e);
    } finally {
      setWriting(false);
    }
  }

  return (
    <div className="border-t pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="gd-as-mcp-config"
        className="flex w-full items-start gap-2 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <CaretRightIcon
          className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            Use GitDesktop as an MCP server
          </span>
          <span className="block text-xs text-muted-foreground">
            Let Claude Desktop, Cursor, or Claude Code use this repo's git &amp;
            GitHub tools — read-only by default, over stdio.
          </span>
        </span>
      </button>

      {open && (
        <div id="gd-as-mcp-config" className="mt-3 space-y-2 pl-6">
          {!repoPath && (
            <p className="text-xs text-muted-foreground">
              No repository open — replace{" "}
              <code className="font-mono">&lt;path to your repo&gt;</code> with
              the repo you want to expose.
            </p>
          )}

          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={shareable}
                onCheckedChange={(c) => setShareable(c === true)}
              />
              Shareable entry
            </label>
            <p className="text-xs text-muted-foreground">
              {shareable
                ? "Portable paths — teammates set GITDESKTOP_BIN to their install path (or have gitdesktop on PATH)."
                : "Absolute paths — works on this machine only. Consider gitignoring .mcp.json."}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={allowWrite}
                onCheckedChange={(c) => setAllowWrite(c === true)}
              />
              Allow write tools
            </label>
            <p className="text-xs text-muted-foreground">
              {allowWrite
                ? "Adds --allow-write — agents can create, comment on, and approve this repo's local PRs."
                : "The server exposes read-only git & GitHub tools."}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              Paste into your client's MCP config
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={copy}>
                {copied ? (
                  <>
                    <CheckIcon data-icon="inline-start" /> Copied
                  </>
                ) : (
                  <>
                    <CopyIcon data-icon="inline-start" /> Copy
                  </>
                )}
              </Button>
              {/* A title on a natively-disabled button never surfaces, so wrap it. */}
              <span
                title={
                  repoPath
                    ? undefined
                    : "Open a repository to write its .mcp.json"
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!repoPath || writing}
                  onClick={() => write(false)}
                >
                  {writing ? (
                    <>
                      <Spinner className="size-3" /> Writing…
                    </>
                  ) : (
                    "Write to .mcp.json"
                  )}
                </Button>
              </span>
            </div>
          </div>
          <pre className="overflow-x-auto rounded border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {snippet}
          </pre>
          <p className="text-xs text-muted-foreground">
            {allowWrite
              ? "Read-write · stdio · adds local-PR write tools (create, comment, status, approve) — gated behind --allow-write."
              : "Read-only · stdio · exposes git & GitHub tools (status, log, diff, blame, PRs, issues, CI)."}
          </p>

          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Replace existing entry?</DialogTitle>
                <DialogDescription>
                  This repo's .mcp.json already has a gitdesktop entry. Replace
                  it with the configuration shown?
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={writing}
                  onClick={() => setConfirmOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={writing}
                  onClick={() => write(true)}
                >
                  {writing ? (
                    <>
                      <Spinner className="size-3" /> Replacing…
                    </>
                  ) : (
                    "Replace entry"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}

export const McpServersSection = withForm({
  ...settingsFormOpts,
  render: function McpServersSectionRender({ form }) {
    const servers = useSelector(form.store, (s) => s.values.mcpServers);
    const [editing, setEditing] = useState<McpServer | "new" | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const listRef = useRef<HTMLDivElement>(null);
    const repoPath = useUiStore((s) => s.repoPath);
    const repoName = useUiStore((s) => s.repoName);
    // The registry browser's open state lives in the store so the command
    // palette can deep-link to it (see openMcpBrowse).
    const browseOpen = useUiStore((s) => s.mcpBrowseOpen);
    const setBrowseOpen = useUiStore((s) => s.setMcpBrowseOpen);

    const list = servers ?? [];

    function setServers(next: McpServer[]) {
      form.setFieldValue("mcpServers", next);
    }

    function addServers(added: McpServer[]) {
      if (added.length) setServers([...list, ...added]);
      setImportOpen(false);
    }

    // Append one server (registry browser), without closing — the dialog stays
    // open for adding several. Functional update so back-to-back adds compose.
    function appendServer(server: McpServer) {
      form.setFieldValue("mcpServers", (prev) => [...(prev ?? []), server]);
    }

    function saveServer(server: McpServer) {
      const exists = list.some((s) => s.id === server.id);
      setServers(
        exists
          ? list.map((s) => (s.id === server.id ? server : s))
          : [...list, server],
      );
      setEditing(null);
    }

    function removeServer(server: McpServer) {
      setServers(list.filter((s) => s.id !== server.id));
      // Tidy up any keychain secrets the server owned (best-effort).
      for (const key of server.secretKeys)
        void deleteMcpSecret(server.id, key).catch(() => undefined);
      toast.success(`Removed "${server.name}"`);
    }

    function toggleEnabled(server: McpServer, enabled: boolean) {
      setServers(list.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
    }

    // Set (or clear, when null = "follow the global default") a global server's
    // per-repo state override for the open repo.
    function setRepoOverride(
      server: McpServer,
      rp: string,
      state: McpRepoState | null,
    ) {
      setServers(
        list.map((s) => {
          if (s.id !== server.id) return s;
          const overrides = { ...(s.repoOverrides ?? {}) };
          if (state) overrides[rp] = state;
          else delete overrides[rp];
          const next: McpServer = { ...s, repoOverrides: overrides };
          if (Object.keys(overrides).length === 0)
            next.repoOverrides = undefined;
          return next;
        }),
      );
    }

    // Group by scope so global vs repo-specific servers read as distinct sets.
    const groups: {
      key: string;
      label: string;
      hint?: string;
      servers: McpServer[];
    }[] = [
      {
        key: "global",
        label: "Global — all repositories",
        // With a repo open, the per-row control sets this repo's override.
        hint: repoPath
          ? "Set how each behaves in this repo, or Default to follow the global setting."
          : undefined,
        servers: list.filter((s) => serverScope(s) === MCP_SCOPE_GLOBAL),
      },
      {
        key: "repo",
        label: `This repo — ${repoName ?? (repoPath ? repoBasename(repoPath) : "")}`,
        servers: repoPath
          ? list.filter((s) => serverScope(s) === repoPath)
          : [],
      },
      {
        key: "other",
        label: "Other repositories",
        servers: list.filter((s) => {
          const sc = serverScope(s);
          return sc !== MCP_SCOPE_GLOBAL && sc !== repoPath;
        }),
      },
    ].filter((g) => g.servers.length > 0);
    // Flattened in display order, so arrow-key nav follows what's on screen.
    const ordered = groups.flatMap((g) => g.servers);
    const indexById = new Map(ordered.map((s, i) => [s.id, i]));
    const showHeaders = groups.length > 1;
    // Removing/adding rows changes `ordered`'s length but not `activeIndex`, so
    // clamp the stale value (keeping -1 = "nothing active yet") to avoid leaving
    // no row focusable when the active row is removed.
    const safeActive =
      activeIndex >= ordered.length ? ordered.length - 1 : activeIndex;

    const onKeyDown = listKeyboardNav<McpServer>({
      items: ordered,
      activeIndex: safeActive,
      onActivate: (_s, to) => setActiveIndex(to),
      rowKey: (s) => s.id,
      rowAttr: "data-mcp-row",
    });

    return (
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">MCP servers</h2>
            <p className="text-xs text-muted-foreground">
              Register Model Context Protocol servers that agent sessions can
              opt into. Each session passes{" "}
              <strong className="font-medium">only</strong> the servers you pick
              to its CLI in strict mode, so a run never inherits other MCP
              servers on your machine. Secrets are stored in your OS keychain.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBrowseOpen(true)}
              title="Browse the MCP registry and GitHub for servers"
            >
              <MagnifyingGlassIcon data-icon="inline-start" /> Browse
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportOpen(true)}
              title="Import servers you've already configured (.mcp.json / global)"
            >
              <DownloadSimpleIcon data-icon="inline-start" /> Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing("new")}
            >
              <PlusIcon data-icon="inline-start" /> Add server
            </Button>
          </div>
        </div>

        {list.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No MCP servers yet. Add one to make it available in the agent
            composer's server picker.
          </p>
        ) : (
          // A roving-focus list (arrow keys move between rows); grouped by scope.
          <div ref={listRef} onKeyDown={onKeyDown} className="space-y-3">
            {groups.map((g) => (
              <div
                key={g.key}
                role="group"
                aria-label={g.label}
                className="space-y-2"
              >
                {showHeaders && (
                  <div className="space-y-0.5">
                    <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {g.label}
                    </p>
                    {g.hint && (
                      <p className="text-[11px] text-muted-foreground">
                        {g.hint}
                      </p>
                    )}
                  </div>
                )}
                {g.servers.map((server) => {
                  const i = indexById.get(server.id) ?? 0;
                  const isGlobal = serverScope(server) === MCP_SCOPE_GLOBAL;
                  // A server with no command/url (e.g. a GitHub stub added
                  // without a manifest) can't run — surface it and block enabling.
                  const incomplete =
                    server.transport === "stdio"
                      ? !server.command.trim()
                      : !server.url.trim();
                  return (
                    <div
                      key={server.id}
                      data-mcp-row={server.id}
                      aria-label={`${server.name}, ${server.transport}, ${effectiveMcpState(
                        server,
                        repoPath,
                      )}. Press Enter to edit.`}
                      tabIndex={
                        i === safeActive || (safeActive === -1 && i === 0)
                          ? 0
                          : -1
                      }
                      onFocus={() => setActiveIndex(i)}
                      onKeyDown={(e) => {
                        // Only the row itself edits on Enter — not when a child
                        // control (the state picker / switch / buttons) is focused.
                        if (e.key === "Enter" && e.target === e.currentTarget) {
                          e.preventDefault();
                          setEditing(server);
                        }
                      }}
                      className="flex items-center gap-2 rounded border px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <span className="shrink-0 font-mono text-xs font-medium">
                        {server.name}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
                        {server.transport}
                      </span>
                      {incomplete && (
                        <span
                          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-warning"
                          title={`Set the ${server.transport === "stdio" ? "command" : "URL"} before enabling — edit this server.`}
                        >
                          needs setup
                        </span>
                      )}
                      {server.description && (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {server.description}
                        </span>
                      )}
                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {isGlobal && repoPath ? (
                          <PerRepoStateControl
                            server={server}
                            repoPath={repoPath}
                            disabled={incomplete}
                            onChange={(state) =>
                              setRepoOverride(server, repoPath, state)
                            }
                          />
                        ) : (
                          <Switch
                            size="sm"
                            checked={server.enabled}
                            disabled={incomplete}
                            onCheckedChange={(v) => toggleEnabled(server, v)}
                            aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${server.name}`}
                          onClick={() => setEditing(server)}
                        >
                          <PencilSimpleIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${server.name}`}
                          onClick={() => removeServer(server)}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <GitDesktopAsServer repoPath={repoPath} />

        {editing !== null && (
          <McpServerDialog
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? null : editing}
            others={list.filter(
              (s) => editing === "new" || s.id !== editing.id,
            )}
            repoPath={repoPath}
            repoName={repoName}
            onSave={saveServer}
            onClose={() => setEditing(null)}
          />
        )}

        {importOpen && (
          <ImportMcpDialog
            repoPath={repoPath}
            existing={list}
            onImport={addServers}
            onClose={() => setImportOpen(false)}
          />
        )}

        {browseOpen && (
          <BrowseRegistryDialog
            existing={list}
            onAdd={appendServer}
            onClose={() => setBrowseOpen(false)}
          />
        )}
      </section>
    );
  },
});

/**
 * Reviewed import of servers the user already configured for Claude — the open
 * repo's `.mcp.json` and the global `~/.claude.json`. Nothing is inherited
 * silently: discovered servers land **disabled**, secret-looking values move to
 * the keychain, and the source files are never touched. The user ticks what to add.
 */
function ImportMcpDialog({
  repoPath,
  existing,
  onImport,
  onClose,
}: {
  repoPath: string | null;
  existing: McpServer[];
  onImport: (servers: McpServer[]) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  // Read the registry through a ref so discovery runs once (keyed on repoPath)
  // and isn't re-triggered — wiping the user's ticks — by the parent handing a
  // new `existing` array reference on re-render.
  const existingRef = useRef(existing);
  existingRef.current = existing;

  useEffect(() => {
    let alive = true;
    const existingNames = new Set(
      existingRef.current.map((s) => s.name.trim().toLowerCase()),
    );
    discoverMcpServers(repoPath)
      .then((found) => {
        if (!alive) return;
        const cands = found.map((d) =>
          toImportCandidate(d, existingNames, repoPath),
        );
        setCandidates(cands);
        // Pre-tick everything that isn't already in the registry.
        setPicked(
          new Set(cands.filter((c) => !c.duplicate).map((c) => c.server.id)),
        );
      })
      .catch((e) => {
        if (alive) toastError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function runImport() {
    const chosen = candidates.filter((c) => picked.has(c.server.id));
    if (chosen.length === 0) return;
    setImporting(true);
    try {
      // Stash secret-looking values in the keychain before the server lands in
      // settings (so the value is never persisted there). Best-effort per entry.
      for (const c of chosen) {
        for (const s of c.secretWrites)
          await setMcpSecret(c.server.id, s.key, s.value);
      }
      onImport(chosen.map((c) => c.server));
      toast.success(
        `Imported ${chosen.length} server${chosen.length === 1 ? "" : "s"} — review and enable them`,
      );
    } catch (e) {
      setImporting(false);
      toastError(e);
    }
  }

  const pickedCount = candidates.filter((c) => picked.has(c.server.id)).length;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !importing) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import MCP servers</DialogTitle>
          <DialogDescription>
            Servers already configured for Claude — the open repo's{" "}
            <code className="font-mono">.mcp.json</code> and your global config.
            Imported servers start{" "}
            <strong className="font-medium">disabled</strong> and secret-looking
            values move to your OS keychain; the source files aren't changed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-2 overflow-y-auto px-1">
          {loading ? (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner /> Looking for configured servers…
            </p>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-xs text-muted-foreground">
              No MCP servers found in {repoPath ? "this repo's " : ""}
              <code className="font-mono">.mcp.json</code>
              {repoPath ? " or " : ""}your global Claude config.
            </p>
          ) : (
            candidates.map((c) => (
              <label
                key={c.server.id}
                className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
                  c.duplicate ? "opacity-60" : "cursor-pointer hover:bg-muted"
                }`}
              >
                <Checkbox
                  checked={picked.has(c.server.id)}
                  disabled={c.duplicate || importing}
                  onCheckedChange={(on) => toggle(c.server.id, on === true)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono font-medium">
                      {c.server.name}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground uppercase">
                      {c.server.transport}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {c.origin === "repo" ? ".mcp.json" : "global"}
                    </span>
                  </div>
                  <p className="truncate text-muted-foreground">
                    {c.server.transport === "stdio"
                      ? [c.server.command, ...c.server.args].join(" ")
                      : c.server.url}
                  </p>
                  {c.duplicate ? (
                    <p className="text-[10px] text-muted-foreground">
                      Already in your registry.
                    </p>
                  ) : (
                    (c.renamed || c.server.secretKeys.length > 0) && (
                      <p className="text-[10px] text-muted-foreground">
                        {c.renamed && `Renamed from “${c.sourceName}”. `}
                        {c.server.secretKeys.length > 0 &&
                          `${c.server.secretKeys.length} secret value${
                            c.server.secretKeys.length === 1 ? "" : "s"
                          } → keychain.`}
                      </p>
                    )
                  )}
                </div>
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button
            onClick={runImport}
            disabled={pickedCount === 0 || importing || loading}
          >
            {importing && <Spinner data-icon="inline-start" />}
            Import{pickedCount > 0 ? ` ${pickedCount}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Compact number for stars/installs (87729 → "87.7K"). */
const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** A one-line summary of what a server will run (stdio) or connect to (http) —
 *  the honest "what can this do" view shown in a result's expanded detail. */
function runSummary(server: McpServer): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].join(" ").trim()
    : server.url;
}

/** Set a hover `title` only when the element's content is actually clipped
 *  (truncate horizontally or line-clamp vertically), so long registry strings
 *  stay readable without redundant tooltips on the short ones. */
function markTitleIfClipped(e: ReactMouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (
    !el.title &&
    (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
  )
    el.title = el.textContent ?? "";
}

/**
 * Browse and add servers from the public MCP registry
 * (registry.modelcontextprotocol.io). Search is debounced; a chosen server is
 * appended to the managed registry **disabled** (the dialog stays open so you
 * can add several), so you review what it runs, fill any secret, and enable it
 * deliberately. Nothing is fetched-and-run automatically — this is discovery.
 */
function BrowseRegistryDialog({
  existing,
  onAdd,
  onClose,
}: {
  existing: McpServer[];
  onAdd: (server: McpServer) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"registry" | "github">("registry");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  // Registry names added this session — flips their row to "Added".
  const [added, setAdded] = useState<Set<string>>(new Set());
  // Server names already in the managed registry when the dialog opened, shown
  // as "In registry". A snapshot, so adding here doesn't reclassify other rows.
  const [initialNames] = useState(
    () => new Set(existing.map((s) => s.name.trim().toLowerCase())),
  );
  // Read the live list through a ref for name-uniqueness on add, without making
  // anything else depend on it (which would re-render the search results).
  const existingRef = useRef(existing);
  existingRef.current = existing;

  // Debounce the query so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Cursor-paginated registry search. TanStack Query owns abort (via signal),
  // caching, retry, and next-page fetching, keyed on the debounced query.
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["mcp-browse", source, debounced],
    queryFn: ({ pageParam, signal }) =>
      source === "github"
        ? searchGithub({ search: debounced, cursor: pageParam ?? undefined })
        : searchRegistry({
            search: debounced,
            cursor: pageParam ?? undefined,
            limit: 30,
            signal,
          }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  // Flatten pages and de-dupe by registry name (different versions can recur).
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: RegistryCandidate[] = [];
    for (const page of data?.pages ?? [])
      for (const c of page.candidates)
        if (!seen.has(c.registryName)) {
          seen.add(c.registryName);
          out.push(c);
        }
    return out;
  }, [data]);

  // Validation signals fetched alongside the results, each best-effort so the
  // list never blocks on (or breaks from) them. GitHub stars/activity come from
  // one batched gh call; npm installs from the downloads API. Keys are the value
  // lists, so they re-fetch only when a new page adds repos/packages.
  const repoRefs = useMemo(() => {
    const set = new Set<string>();
    for (const c of candidates)
      if (c.repo) set.add(`${c.repo.owner}/${c.repo.name}`);
    return [...set];
  }, [candidates]);
  const npmPkgs = useMemo(() => {
    const set = new Set<string>();
    for (const c of candidates) if (c.npmPackage) set.add(c.npmPackage);
    return [...set];
  }, [candidates]);

  const { data: ghStats } = useQuery({
    queryKey: ["gh-repo-stats", repoRefs],
    queryFn: () => ghRepoStats(repoRefs),
    enabled: repoRefs.length > 0,
    staleTime: 5 * 60_000,
  });
  const { data: npmInstalls } = useQuery({
    queryKey: ["npm-installs", npmPkgs],
    queryFn: () => npmWeeklyDownloadsBatch(npmPkgs),
    enabled: npmPkgs.length > 0,
    staleTime: 5 * 60_000,
  });
  const statByRepo = useMemo(() => {
    const map = new Map<string, RepoStat>();
    for (const s of ghStats ?? []) map.set(s.nameWithOwner.toLowerCase(), s);
    return map;
  }, [ghStats]);

  // Which rows have their validation detail expanded (by registry name).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Reset roving focus when the query/source changes the result set under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on new search
  useEffect(() => setActiveIndex(-1), [debounced, source]);

  function add(c: RegistryCandidate) {
    const taken = new Set(
      existingRef.current.map((s) => s.name.trim().toLowerCase()),
    );
    const name = uniqueServerName(c.server.name, taken);
    onAdd({ ...c.server, id: crypto.randomUUID(), name });
    setAdded((prev) => new Set(prev).add(c.registryName));
    toast.success(`Added "${name}" — review and enable it`);
  }

  const errorMessage = isError
    ? error instanceof Error
      ? error.message
      : source === "github"
        ? "Couldn't search GitHub. Is the GitHub CLI signed in?"
        : "Couldn't reach the MCP registry."
    : null;

  // Clamp a stale active index after the result set shrinks (search/retry).
  const safeActive =
    activeIndex >= candidates.length ? candidates.length - 1 : activeIndex;
  const onListKeyDown = listKeyboardNav<RegistryCandidate>({
    items: candidates,
    activeIndex: safeActive,
    onActivate: (_c, to) => setActiveIndex(to),
    rowKey: (c) => c.registryName,
    rowAttr: "data-registry-row",
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Browse MCP servers</DialogTitle>
          <DialogDescription>
            {source === "github" ? (
              <>
                MCP-server repositories on GitHub, ranked by stars. Rougher than
                the registry — some need manual setup after adding.
              </>
            ) : (
              <>
                Public servers from the official Model Context Protocol
                registry.
              </>
            )}{" "}
            Added servers start{" "}
            <strong className="font-medium">disabled</strong> — review what each
            one runs, add any secret, then enable it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1">
          {(
            [
              ["registry", "Official registry"],
              ["github", "GitHub"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={source === value ? "default" : "outline"}
              aria-pressed={source === value}
              className="flex-1"
              onClick={() => setSource(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              source === "github"
                ? "Search GitHub MCP repos…"
                : "Search servers…"
            }
            className="pl-8"
            spellCheck={false}
          />
        </div>

        <div
          onKeyDown={onListKeyDown}
          className="max-h-[55vh] min-h-40 space-y-2 overflow-y-auto px-1"
        >
          {isLoading ? (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner />{" "}
              {source === "github"
                ? "Searching GitHub…"
                : "Searching the registry…"}
            </p>
          ) : errorMessage ? (
            <div className="space-y-2 py-6 text-xs">
              <p className="text-muted-foreground">{errorMessage}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
              </Button>
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-xs text-muted-foreground">
              {debounced
                ? `No ${source === "github" ? "repositories" : "servers"} match “${debounced}”.`
                : "No results found."}
            </p>
          ) : (
            <>
              {candidates.map((c, i) => {
                const isAdded = added.has(c.registryName);
                const inRegistry = initialNames.has(
                  c.server.name.toLowerCase(),
                );
                const disabled = isAdded || inRegistry;
                const repo = c.repo;
                const stat = repo
                  ? statByRepo.get(repoKey(repo.owner, repo.name))
                  : undefined;
                const installs = c.npmPackage
                  ? npmInstalls?.[c.npmPackage]
                  : undefined;
                const deprecated = c.status !== "active";
                const isOpen = expanded.has(c.registryName);
                const entries = entriesFor(c.server);
                const secretSet = new Set(c.server.secretKeys);
                return (
                  <div
                    key={c.registryName}
                    data-registry-row={c.registryName}
                    aria-label={`${c.title}, ${c.server.transport}${
                      disabled
                        ? isAdded
                          ? ", added"
                          : ", already in your registry"
                        : ". Press Enter to add."
                    }`}
                    tabIndex={
                      i === safeActive || (safeActive === -1 && i === 0)
                        ? 0
                        : -1
                    }
                    onFocus={() => setActiveIndex(i)}
                    onKeyDown={(e) => {
                      // Only the row itself adds on Enter — not its child controls.
                      if (
                        e.key === "Enter" &&
                        e.target === e.currentTarget &&
                        !disabled
                      ) {
                        e.preventDefault();
                        add(c);
                      }
                    }}
                    className="flex items-start gap-1.5 rounded-md border p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mt-0.5 shrink-0"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "Hide details" : "Show details"}
                      onClick={() => toggleExpanded(c.registryName)}
                    >
                      <CaretRightIcon
                        className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                    </Button>

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="truncate font-medium"
                          onMouseEnter={markTitleIfClipped}
                        >
                          {c.title}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground uppercase">
                          {c.server.transport}
                        </span>
                        {deprecated && (
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-warning uppercase">
                            {c.status}
                          </span>
                        )}
                        {c.needsSetup && (
                          <span className="shrink-0 text-[10px] text-warning">
                            needs setup
                          </span>
                        )}
                        {(stat || installs != null) && (
                          <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                            {stat && (
                              <span
                                className="flex items-center gap-0.5"
                                title={`${stat.stars.toLocaleString()} stars`}
                              >
                                <StarIcon weight="fill" />
                                {compactNumber.format(stat.stars)}
                              </span>
                            )}
                            {installs != null && (
                              <span
                                className="flex items-center gap-0.5"
                                title={`${installs.toLocaleString()} npm downloads last week`}
                              >
                                <DownloadSimpleIcon />
                                {compactNumber.format(installs)}/wk
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <p
                        className="truncate font-mono text-[10px] text-muted-foreground"
                        onMouseEnter={markTitleIfClipped}
                      >
                        {c.registryName}
                      </p>
                      {c.server.description && (
                        <p
                          className="line-clamp-2 text-muted-foreground"
                          onMouseEnter={markTitleIfClipped}
                        >
                          {c.server.description}
                        </p>
                      )}

                      {isOpen && (
                        <div className="mt-1.5 space-y-1 rounded bg-muted/40 p-2 text-[10px] leading-relaxed">
                          {c.server.transport === "stdio" &&
                          !c.server.command ? (
                            <div className="text-muted-foreground">
                              No manifest found — you'll set the command after
                              adding.
                            </div>
                          ) : (
                            <div>
                              <span className="font-medium">
                                {c.server.transport === "stdio"
                                  ? "Runs locally"
                                  : "Connects to"}
                                :{" "}
                              </span>
                              <span className="font-mono break-all">
                                {runSummary(c.server)}
                              </span>
                            </div>
                          )}
                          {entries.length > 0 && (
                            <div>
                              <span className="font-medium">
                                {c.server.transport === "stdio"
                                  ? "Environment"
                                  : "Headers"}
                                :{" "}
                              </span>
                              {entries.map((e, idx) => (
                                <span key={e.key}>
                                  {idx > 0 && ", "}
                                  <span className="font-mono">{e.key}</span>
                                  {secretSet.has(e.key) && (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      (secret)
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                          {(stat || c.publishedAt) && (
                            <div className="text-muted-foreground">
                              {[
                                stat?.license,
                                stat
                                  ? `${compactNumber.format(stat.forks)} forks`
                                  : null,
                                stat?.pushedAt
                                  ? `updated ${formatRelativeTime(stat.pushedAt)}`
                                  : c.publishedAt
                                    ? `published ${formatRelativeTime(c.publishedAt)}`
                                    : null,
                                stat?.archived ? "archived" : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          )}
                          {repo && (
                            <button
                              type="button"
                              onClick={() => openUrl(repo.url)}
                              className="inline-flex cursor-pointer items-center gap-1 text-primary hover:underline"
                            >
                              View on GitHub
                              <ArrowSquareOutIcon />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {isAdded ? (
                      <span className="flex shrink-0 items-center gap-1 self-start text-[11px] text-success">
                        <CheckIcon weight="bold" /> Added
                      </span>
                    ) : inRegistry ? (
                      <span className="shrink-0 self-start text-[10px] text-muted-foreground">
                        In registry
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => add(c)}
                      >
                        <PlusIcon data-icon="inline-start" /> Add
                      </Button>
                    )}
                  </div>
                );
              })}
              {hasNextPage && (
                <div className="flex justify-center py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                  >
                    {isFetchingNextPage && <Spinner data-icon="inline-start" />}
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
