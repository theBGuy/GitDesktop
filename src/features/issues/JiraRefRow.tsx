import { KanbanIcon } from "@phosphor-icons/react";
import { extractJiraKeys } from "@/lib/jira/keys";
import { useJiraIssues, useJiraLink } from "@/lib/jira/queries";
import { useUiStore } from "@/lib/stores/ui";

/**
 * The shared "Jira issues referenced" presentation: one full-width row per
 * matched key (icon + key + the cached issue title when available), in the house
 * "related items" idiom (`IssueDevelopment`). Clicking a row selects the issue in
 * the Jira panel AND switches to the Issues tab — both are required, since
 * `selectIssue` alone never changes tabs. A bare key with no cached title still
 * renders and still navigates (the detail view fetches it by key).
 *
 * Renders nothing when the repo is unlinked or `text` references no keys — the
 * omit-when-empty precedent (no persistent empty state).
 */
export function JiraRefRow({
  repoPath,
  text,
}: {
  repoPath: string;
  /** The git text to scan (e.g. `subject + "\n" + body`). */
  text: string;
}) {
  const link = useJiraLink(repoPath).data;
  const keys = link ? extractJiraKeys(text, link.projectKey) : [];
  // Titles are best-effort from whatever list is already cached; "all" is the
  // broadest filter so it covers open and closed referenced issues. Passing the
  // link only when there's something to resolve keeps the query disabled (so a
  // linked repo with no referenced keys fires ZERO Jira calls); when it IS
  // enabled the panel has usually already warmed this cache.
  const issues = useJiraIssues(repoPath, keys.length > 0 ? link : null, "all");
  const selectIssue = useUiStore((s) => s.selectIssue);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  if (!link || keys.length === 0) return null;

  const titleFor = (key: string) =>
    issues.data?.find((i) => i.key === key)?.summary;

  function open(key: string) {
    // Both calls, always: selectIssue targets the panel selection, setRepoTab
    // brings the Issues tab forward so the selection is actually visible.
    selectIssue({ kind: "jira", id: key });
    setRepoTab("issues");
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">
        Jira issues
      </p>
      {keys.map((key) => {
        const title = titleFor(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => open(key)}
            className="flex w-full cursor-pointer items-center gap-1.5 text-left text-xs hover:underline"
            title={title ? `${key} ${title}` : key}
          >
            <KanbanIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-muted-foreground">
              {key}
            </span>
            {title && <span className="min-w-0 flex-1 truncate">{title}</span>}
          </button>
        );
      })}
    </div>
  );
}
