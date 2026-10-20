import { useEffect, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { isWindows } from "@/lib/hotkeys/binding";
import type { McpServer } from "@/lib/settings/api";
import { mcpHostAllowFixable, mcpHostGateReason } from "@/lib/settings/mcp";
import {
  discoverMcpServers,
  type ImportCandidate,
  toImportCandidate,
} from "@/lib/settings/mcp-import";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import {
  MAX_WINDOWS_SECRET_UTF16,
  type McpSecretWriteProblem,
  type McpStagedSecret,
  secretWriteProblem,
} from "./secret-ops";

/** The held row's reason for a secret the keychain would refuse. */
const SECRET_HOLD: Record<
  McpSecretWriteProblem["kind"],
  (noun: string, key: string) => string
> = {
  name: (noun, key) =>
    `Secret ${noun} "${key}" can't move to your keychain: its name can only use letters, numbers, dots, dashes and underscores.`,
  value: (noun, key) =>
    `Secret ${noun} "${key}" can't move to your keychain: its value isn't a string.`,
  length: (noun, key) =>
    `Secret ${noun} "${key}" can't move to your keychain: Windows allows at most ${MAX_WINDOWS_SECRET_UTF16.toLocaleString("en-US")} characters.`,
};

/** Why a candidate can't be imported: a secret the keychain would refuse (an
 *  unsafe name, a non-string value from a hand-edited config, or a value over
 *  the Windows cap) would commit a pair no Save could store, so the row is held. */
function secretHold(c: ImportCandidate): string | null {
  // Typed as strings, but a hand-edited config can hold any JSON value.
  const writes: readonly { key: string; value: unknown }[] = c.secretWrites;
  const problem = secretWriteProblem(writes, isWindows);
  if (!problem) return null;
  return SECRET_HOLD[problem.kind](
    c.server.transport === "stdio" ? "variable" : "header",
    problem.key,
  );
}

/**
 * Reviewed import of servers the user already configured for Claude — the open
 * repo's `.mcp.json` and the global `~/.claude.json`. Nothing is inherited
 * silently: discovered servers land **disabled**, secret-looking values move to
 * the keychain, and the source files are never touched. The user ticks what to add.
 */
export function ImportMcpDialog({
  repoPath,
  existing,
  allowedHosts,
  onAllowHost,
  onImport,
  onClose,
}: {
  repoPath: string | null;
  existing: McpServer[];
  /** The draft AI allow list. An http candidate whose host isn't on it can't be
   *  ticked until the host is allowed (the registration gate). */
  allowedHosts: string[];
  /** Add a URL's host to the draft allow list — the one-click fix behind a
   *  gated row's note. Mutates the draft settings, not persisted settings. */
  onAllowHost: (url: string) => void;
  onImport: (servers: McpServer[], writes: McpStagedSecret[]) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Read the registry through a ref so discovery runs once (keyed on repoPath)
  // and isn't re-triggered — wiping the user's ticks — by the parent handing a
  // new `existing` array reference on re-render. The allow list rides a ref for
  // the same reason: allowing a host mid-dialog must not re-run discovery.
  const existingRef = useLatestRef(existing);
  const allowedHostsRef = useLatestRef(allowedHosts);

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
        // Pre-tick everything that isn't already in the registry, isn't held by
        // the host gate (a gated row is the user's call after allowing it) and
        // isn't held by a secret the keychain would refuse, a hold that is
        // static per candidate.
        setPicked(
          new Set(
            cands
              .filter(
                (c) =>
                  !c.duplicate &&
                  !mcpHostGateReason(c.server, allowedHostsRef.current) &&
                  secretHold(c) === null,
              )
              .map((c) => c.server.id),
          ),
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

  function runImport() {
    // Re-check the host gate at fire time: a tick taken while the host was
    // allowed must not import if the draft allow list has since lost the entry.
    // The secret hold is static per candidate; it is re-checked only so this
    // filter matches pickedCount's.
    const chosen = candidates.filter(
      (c) =>
        picked.has(c.server.id) &&
        !mcpHostGateReason(c.server, allowedHosts) &&
        secretHold(c) === null,
    );
    if (chosen.length === 0) return;
    // Secret-looking values go to the settings screen's Save buffer, never into
    // the server itself; the keychain sees them only when Save commits.
    onImport(
      chosen.map((c) => c.server),
      chosen.flatMap((c) =>
        c.secretWrites.map((s) => ({
          serverId: c.server.id,
          key: s.key,
          value: s.value,
        })),
      ),
    );
    toast.success(
      `Imported ${chosen.length} server${chosen.length === 1 ? "" : "s"} — review and enable them`,
    );
  }

  // Counts what Import will actually write, so the button label can't promise a
  // row the gate would drop.
  const pickedCount = candidates.filter(
    (c) =>
      picked.has(c.server.id) &&
      !mcpHostGateReason(c.server, allowedHosts) &&
      secretHold(c) === null,
  ).length;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
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
            candidates.map((c) => {
              // Gate UI belongs only to rows the user can still act on: a
              // duplicate is already refused on its own terms, so re-explaining
              // an allow-list block it can never reach is noise.
              const gateReason = c.duplicate
                ? null
                : mcpHostGateReason(c.server, allowedHosts);
              const secretHoldReason = c.duplicate ? null : secretHold(c);
              const showKeychainCount =
                c.server.secretKeys.length > 0 && secretHoldReason === null;
              const held =
                c.duplicate || gateReason !== null || secretHoldReason !== null;
              const allowFixable =
                !c.duplicate && mcpHostAllowFixable(c.server, allowedHosts);
              return (
                // The reason TEXT rides inside the label so it joins the disabled
                // checkbox's accessible name, like the duplicate note beside it;
                // the Allow host BUTTON stays outside — nested interactive
                // content would be read as part of that same name.
                <div
                  key={c.server.id}
                  className="overflow-hidden rounded-md border text-xs"
                >
                  <label
                    className={`flex items-start gap-2 p-2 ${
                      held ? "opacity-60" : "cursor-pointer hover:bg-muted"
                    }`}
                  >
                    <Checkbox
                      checked={picked.has(c.server.id)}
                      disabled={held}
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
                        (c.renamed || showKeychainCount) && (
                          <p className="text-[10px] text-muted-foreground">
                            {c.renamed && `Renamed from “${c.sourceName}”. `}
                            {showKeychainCount &&
                              `${c.server.secretKeys.length} secret value${
                                c.server.secretKeys.length === 1 ? "" : "s"
                              } → keychain.`}
                          </p>
                        )
                      )}
                      {gateReason && (
                        <p className="text-[10px] text-warning">
                          {gateReason}
                          {allowFixable &&
                            " The agent CLI connects outside GitDesktop's AI allowlist, so allow it before importing."}
                        </p>
                      )}
                      {secretHoldReason && (
                        <p className="text-[10px] text-warning">
                          {secretHoldReason}
                        </p>
                      )}
                    </div>
                  </label>
                  {allowFixable ? (
                    <div className="px-2 pb-2 pl-8">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => onAllowHost(c.server.url)}
                      >
                        Allow host
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={runImport} disabled={pickedCount === 0 || loading}>
            Import{pickedCount > 0 ? ` ${pickedCount}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
