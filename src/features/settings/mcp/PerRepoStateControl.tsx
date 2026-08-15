import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { McpServer } from "@/lib/settings/api";
import {
  type McpRepoState,
  pickForRepo,
  type RepoKeys,
} from "@/lib/settings/mcp";

/** Per-repo state picker for a GLOBAL server, shown on its row when a repo is
 *  open: On (available + default-on) / Optional (available, off by default) /
 *  Off (not offered here), or "Default" to follow the global Enabled. Muted
 *  while inheriting; solid once this repo overrides it.
 *
 *  The override lookup spans ALL of the repo's keys (raw checkout path AND the
 *  worktree-stable identity) via `pickForRepo`, so a pre-identity-keying override
 *  stored under the legacy raw path still displays correctly during the migration
 *  window — an exact-identity-only lookup would show "Default" for a legacy
 *  override that `effectiveMcpState` still honors, inviting the user to
 *  unknowingly overwrite it. `pickForRepo`'s last-hit-wins order means the
 *  identity key (last in `repoKeys`) beats a legacy raw-path override — the
 *  wanted preference. */
export function PerRepoStateControl({
  server,
  repoKeys,
  disabled,
  onChange,
}: {
  server: McpServer;
  repoKeys: RepoKeys;
  disabled?: boolean;
  onChange: (state: McpRepoState | null) => void;
}) {
  const override = pickForRepo(server.repoOverrides, repoKeys);
  const baseline = server.enabled ? "On" : "Optional";
  // Trigger labels, built here because the inherited option names the baseline;
  // without them Base UI shows the raw value ("optional").
  const items: Record<string, string> = {
    default: `Default · ${baseline}`,
    on: "On",
    optional: "Optional",
    off: "Off",
  };
  return (
    <Select
      items={items}
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
