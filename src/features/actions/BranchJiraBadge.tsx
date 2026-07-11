import { KanbanIcon } from "@phosphor-icons/react";
import { useRepoStatus } from "@/lib/git/queries";
import { extractJiraKeys } from "@/lib/jira/keys";
import { useJiraLink } from "@/lib/jira/queries";
import { useUiStore } from "@/lib/stores/ui";

/**
 * Glanceable Jira issue reference for the current branch, in the repo header.
 * Scans the branch name for the linked project's keys (e.g. `PROJ-42` in
 * `proj-42-fix`); renders nothing when the repo is unlinked, the branch name has
 * no match, or HEAD is detached (branch name null). Clicking jumps to the Issues
 * tab with that issue selected. Mirrors `BranchCiBadge` exactly.
 */
export function BranchJiraBadge({ repoPath }: { repoPath: string }) {
  const link = useJiraLink(repoPath).data;
  const status = useRepoStatus(repoPath);
  const branch = status.data?.branch.name ?? null;
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const selectIssue = useUiStore((s) => s.selectIssue);

  const keys = link ? extractJiraKeys(branch, link.projectKey) : [];
  if (keys.length === 0) return null;

  // Compact: the first key, plus a "+N" affordance when the branch names more.
  const first = keys[0];
  const extra = keys.length - 1;

  return (
    <button
      type="button"
      // Middle tier of the header shrink cascade, alongside BranchCiBadge — the
      // key label stays legible while the icon carries the meaning under pressure.
      className="flex min-w-0 shrink-4 items-center gap-1.5 rounded-none px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      title={
        extra > 0
          ? `${keys.join(", ")} — referenced in the branch name, view in Issues`
          : `${first} — referenced in the branch name, view in Issues`
      }
      onClick={() => {
        selectIssue({ kind: "jira", id: first });
        setRepoTab("issues");
      }}
    >
      <KanbanIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-mono">{first}</span>
      {extra > 0 && <span className="shrink-0">+{extra}</span>}
    </button>
  );
}
