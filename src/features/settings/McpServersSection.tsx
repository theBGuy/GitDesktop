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
import { isHostAllowed, normalizeHost } from "@/lib/ai/allowed-hosts";
import { clipTitleFromText } from "@/lib/clip-title";
import { withForm } from "@/lib/form";
import { deleteMcpSecret } from "@/lib/git/api";
import { repoIdentity } from "@/lib/git/repo-identity";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { asMcpServerArray, type McpServer } from "@/lib/settings/api";
import {
  effectiveMcpState,
  foldServerScopeKeys,
  isServerInScope,
  MCP_SCOPE_GLOBAL,
  type McpRepoState,
  mcpHostGateReason,
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
    // The registry as an array whatever the stored container is: `loadSettings`
    // preserves a corrupt non-array rather than destroying it, so this section
    // renders empty and every edit below BUILDS FROM this guarded view — writing a
    // real array back is the repair, and it only ever happens on a deliberate edit.
    const list = useSelector(form.store, (s) =>
      asMcpServerArray(s.values.mcpServers),
    );
    // The draft AI allow list, shared with the AI provider screen. Rows already
    // in the registry keep a warn-only "host not allowed" badge and go on
    // working. On REGISTRATION the seams explain the block in place and the
    // write funnel (admitServers) enforces it, so a route that skips a seam
    // still can't append an unchecked http server.
    const allowedHosts = useSelector(
      form.store,
      (s) => s.values.aiAllowedHosts,
    );
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

    function setServers(next: McpServer[]) {
      form.setFieldValue("mcpServers", next);
    }

    /** The host gate at the WRITE funnel, applied the moment a server would land
     *  in the registry. Every seam already explains and blocks its own case, so
     *  this never fires today; it exists so a new registration route can't append
     *  an unchecked http server silently. Returns the servers that may be written,
     *  naming the host in a refusal toast for any it drops. */
    function admitServers(incoming: McpServer[]): McpServer[] {
      const admitted: McpServer[] = [];
      for (const s of incoming) {
        const reason = mcpHostGateReason(s, allowedHosts);
        if (reason) toast.error(`"${s.name}" wasn't registered — ${reason}`);
        else admitted.push(s);
      }
      return admitted;
    }

    function addServers(added: McpServer[]) {
      const admitted = admitServers(added);
      if (admitted.length) setServers([...list, ...admitted]);
      setImportOpen(false);
    }

    // Append one server (registry browser), without closing — the dialog stays
    // open for adding several. Functional update so back-to-back adds compose.
    function appendServer(server: McpServer) {
      if (admitServers([server]).length === 0) return;
      form.setFieldValue("mcpServers", (prev) => [
        ...asMcpServerArray(prev),
        server,
      ]);
    }

    async function saveServer(server: McpServer) {
      // Refuse before the optimistic close, so a rejected draft stays on screen
      // for the user to fix rather than vanishing with its edits.
      if (admitServers([server]).length === 0) return;
      // Close optimistically FIRST: foldServerScopeKeys' cold repoIdentity IPC
      // call would otherwise visibly delay the dialog closing. It never rejects,
      // and the write below composes via the functional setter, so closing before
      // the await is safe.
      setEditing(null);
      // Fold the dialog's scope/override keys onto the repo IDENTITY before
      // storing: the dialog's "This repo" option carries the raw checkout path,
      // and folding here (rather than editing the dialog) is what makes a
      // repo-scoped server cross the repo's worktrees. A no-op for global servers
      // and for paths git can't resolve.
      const folded = await foldServerScopeKeys(server);
      // Re-read via the functional setter so this async write composes with any
      // interleaving edit instead of clobbering it.
      form.setFieldValue("mcpServers", (prev) => {
        const cur = asMcpServerArray(prev);
        return cur.some((s) => s.id === folded.id)
          ? cur.map((s) => (s.id === folded.id ? folded : s))
          : [...cur, folded];
      });
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

    /** Add a URL's host to the draft allow list — the one-click fix behind the
     *  host note in each registration seam. Mutates the shared settings draft, committed
     *  by the screen's Save bar, exactly like the AI URL fields. Dedups via
     *  `isHostAllowed` (not a bare `includes`), so a host already covered by a
     *  built-in/local entry or a no-port entry isn't added redundantly. */
    function allowHost(url: string) {
      const host = normalizeHost(url);
      if (host && !isHostAllowed(url, allowedHosts))
        form.setFieldValue("aiAllowedHosts", [...allowedHosts, host]);
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
        asMcpServerArray(prev).map((s) => (s.id === server.id ? next : s)),
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
        <div className="flex flex-wrap items-start justify-between gap-3">
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
          <div className="flex items-center gap-2">
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
                  // An http server whose URL host isn't on the AI allowlist: the
                  // CLI still connects (outside GitDesktop's AI host gate), so
                  // flag it non-blockingly. Empty URLs are covered by `needs
                  // setup`; stdio/allowlisted/local hosts show nothing.
                  const hostNotAllowed =
                    server.transport === "http" &&
                    !!server.url.trim() &&
                    !isHostAllowed(server.url, allowedHosts);
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
                      {/* Truncatable, not shrink-0: an unbounded name is the
                          row's width floor, and the badges beside it are the
                          part that must never be clipped. */}
                      <span
                        className="min-w-0 truncate font-mono text-xs font-medium"
                        onMouseEnter={clipTitleFromText}
                      >
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
                      {hostNotAllowed && (
                        <span
                          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-warning"
                          title="The CLI connects to this host outside GitDesktop's AI host allowlist. Allow the host in AI settings to clear this."
                        >
                          host not allowed
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
                            // Read the override across ALL the repo's keys (raw path
                            // AND identity) so a legacy raw-path override still shows;
                            // the write resolves identity from repoPath itself.
                            repoKeys={repoKeys}
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
            allowedHosts={allowedHosts}
            onAllowHost={allowHost}
            onSave={saveServer}
            onClose={() => setEditing(null)}
          />
        )}

        {importOpen && (
          <ImportMcpDialog
            repoPath={repoPath}
            existing={list}
            allowedHosts={allowedHosts}
            onAllowHost={allowHost}
            onImport={addServers}
            onClose={() => setImportOpen(false)}
          />
        )}

        {browseOpen && (
          <BrowseRegistryDialog
            existing={list}
            allowedHosts={allowedHosts}
            onAllowHost={allowHost}
            onAdd={appendServer}
            onClose={() => setBrowseOpen(false)}
          />
        )}
      </section>
    );
  },
});
