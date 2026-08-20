import { CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { isReconnectHostSafe, useActiveGhHost } from "@/lib/git/host";
import { useGhScopes } from "@/lib/git/queries";
import { useUiStore } from "@/lib/stores/ui";

/**
 * Offers the in-app reconnect (and a copyable `gh auth refresh -s <scope>`) when
 * the active gh token is a classic OAuth/PAT token missing `scope`. Renders
 * nothing when the scope is present, or for a fine-grained/App token (those have
 * no readable scopes and can't be refreshed this way) — so it never nags about a
 * non-problem.
 */
export function ScopeRefreshHint({
  scope,
  action,
}: {
  scope: string;
  action: string;
}) {
  const host = useActiveGhHost();
  const scopes = useGhScopes(host);
  const openReconnect = useUiStore((s) => s.openReconnect);
  if (!scopes.data?.classic || scopes.data.scopes.includes(scope)) return null;
  // A host outside the reconnect grammar never reaches a copyable command string
  // (shell-syntax injection via a crafted remote) — only the command block is
  // suppressed: the explanation and the button stay, and the button's flow
  // re-validates the host backend-side, failing loudly rather than silently.
  const hostSafe = isReconnectHostSafe(host);
  // Spelled as the reconnect flow spawns it (`--hostname`, one `-s` per scope), so
  // the copied command and the button do the same thing.
  const cmd = `gh auth refresh --hostname ${host} -s ${scope}`;
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[11px]">
      <p className="text-muted-foreground">
        {action} needs the <span className="font-mono">{scope}</span> scope,
        which your GitHub sign-in is missing.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          onClick={() =>
            openReconnect({
              provider: "github",
              host,
              mode: "refresh",
              scopes: [scope],
            })
          }
        >
          Reconnect GitHub…
        </Button>
      </div>
      {hostSafe && (
        <>
          <p className="mt-2 text-muted-foreground">
            Or run this, then reopen:
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono">
              {cmd}
            </code>
            <button
              type="button"
              className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              title="Copy command"
              onClick={() => copyText(cmd, "Command copied")}
            >
              <CopyIcon className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
