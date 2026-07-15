import {
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { withForm } from "@/lib/form";
import { deleteMcpSecret } from "@/lib/git/api";
import { repoIdentity } from "@/lib/git/repo-identity";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { McpServer } from "@/lib/settings/api";
import {
  effectiveMcpState,
  foldServerScopeKeys,
  isServerInScope,
  MCP_SCOPE_GLOBAL,
  type McpRepoState,
  serverScope,
} from "@/lib/settings/mcp";
import { useRepoKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { BrowseRegistryDialog } from "./mcp/BrowseRegistryDialog";
import { GitDesktopAsServer } from "./mcp/GitDesktopAsServer";
import { ImportMcpDialog } from "./mcp/ImportMcpDialog";
import { McpServerDialog } from "./mcp/McpServerDialog";
import { PerRepoStateControl } from "./mcp/PerRepoStateControl";
import { repoBasename } from "./mcp/shared";
import { settingsFormOpts } from "./settings-form";

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
    // Scope/override lookup keys for the open repo: [repoPath] while the identity
    // resolves, [repoPath, identity] once it does. Matches a server scoped/overridden
    // under EITHER the raw checkout path (legacy) or the worktree-stable identity,
    // so a scope set from a sibling worktree is recognized here.
    const repoKeys = useRepoKeys(repoPath);
    // The single key writes land under (the resolved identity, or the raw path
    // while it's still resolving / unresolvable). PerRepoStateControl does an
    // exact-key override lookup, so it must read under this same key.
    const repoScopeKey = repoKeys.length ? repoKeys[repoKeys.length - 1] : null;
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

    async function saveServer(server: McpServer) {
      // Fold the dialog's scope/override keys onto the repo IDENTITY before
      // storing: the dialog's "This repo" option carries the raw checkout path,
      // and folding here (rather than editing the dialog) is what makes a
      // repo-scoped server cross the repo's worktrees. A no-op for global servers
      // and for paths git can't resolve.
      const folded = await foldServerScopeKeys(server);
      // Re-read via the functional setter so this async write composes with any
      // interleaving edit instead of clobbering it.
      form.setFieldValue("mcpServers", (prev) => {
        const cur = prev ?? [];
        return cur.some((s) => s.id === folded.id)
          ? cur.map((s) => (s.id === folded.id ? folded : s))
          : [...cur, folded];
      });
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
    // per-repo state override for the open repo. Writes under the repo's
    // worktree-stable IDENTITY key (resolved from the checkout path `rp`), and
    // folds the server's legacy raw-path keys onto their identities in the same
    // write, so an override set from any checkout is honored from its siblings.
    async function setRepoOverride(
      server: McpServer,
      rp: string,
      state: McpRepoState | null,
    ) {
      const key = await repoIdentity(rp);
      const folded = await foldServerScopeKeys(server);
      const overrides = { ...(folded.repoOverrides ?? {}) };
      if (state) overrides[key] = state;
      else delete overrides[key];
      const next: McpServer = { ...folded, repoOverrides: overrides };
      if (Object.keys(overrides).length === 0) next.repoOverrides = undefined;
      // Re-read `list` via the functional setter so this async write composes with
      // any interleaving edit rather than clobbering it.
      form.setFieldValue("mcpServers", (prev) =>
        (prev ?? []).map((s) => (s.id === server.id ? next : s)),
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
        // "This repo" = scoped to any of the open repo's keys (identity or a
        // legacy raw checkout path), so a server scoped from a sibling worktree
        // groups here too.
        servers: repoPath
          ? list.filter(
              (s) =>
                serverScope(s) !== MCP_SCOPE_GLOBAL &&
                isServerInScope(s, repoKeys),
            )
          : [],
      },
      {
        key: "other",
        label: "Other repositories",
        servers: list.filter((s) => {
          const sc = serverScope(s);
          return sc !== MCP_SCOPE_GLOBAL && !isServerInScope(s, repoKeys);
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
                        repoKeys,
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
                        {isGlobal && repoPath && repoScopeKey ? (
                          <PerRepoStateControl
                            server={server}
                            // Read the override under the identity key (where writes
                            // land); the write resolves identity from repoPath itself.
                            repoPath={repoScopeKey}
                            disabled={incomplete}
                            onChange={(state) =>
                              void setRepoOverride(server, repoPath, state)
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
