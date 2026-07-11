import { KanbanIcon } from "@phosphor-icons/react";
import { extractJiraKeys } from "@/lib/jira/keys";
import { useJiraIssues, useJiraLink } from "@/lib/jira/queries";
import { useUiStore } from "@/lib/stores/ui";

/** One place a Jira key can be referenced, with a human label for attribution
 *  (e.g. `{label: "branch name", text: headRefName}`). */
export interface JiraRefSource {
  label: string;
  text: string | null | undefined;
}

/**
 * The shared "Jira issues referenced" presentation: one full-width row per
 * matched key (icon + key + the cached issue title when available), in the house
 * "related items" idiom (`IssueDevelopment`). Clicking a row selects the issue in
 * the Jira panel AND switches to the Issues tab — both are required, since
 * `selectIssue` alone never changes tabs. A bare key with no cached title still
 * renders and still navigates (the detail view fetches it by key).
 *
 * `sources` are scanned in order; a key referenced in several sources is
 * attributed to the FIRST one it appears in (so callers put the noisier source —
 * a branch name — LAST, letting title/description attribution win). The overall
 * row order preserves first-occurrence across all sources.
 *
 * Renders nothing when the repo is unlinked or no source references a key — the
 * omit-when-empty precedent (no persistent empty state).
 */
export function JiraRefRow({
  repoPath,
  sources,
}: {
  repoPath: string;
  sources: JiraRefSource[];
}) {
  const link = useJiraLink(repoPath).data;
  // Extract per source in order (reusing extractJiraKeys); first source wins a
  // key, and overall first-occurrence order is preserved. `attribution` maps each
  // key → the label of the source it was first seen in.
  const keys: string[] = [];
  const attribution = new Map<string, string>();
  if (link) {
    for (const source of sources) {
      for (const key of extractJiraKeys(source.text, link.projectKey)) {
        if (!attribution.has(key)) {
          attribution.set(key, source.label);
          keys.push(key);
        }
      }
    }
  }

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
        const source = attribution.get(key);
        // One title per element: fold the (optional) issue title AND the source
        // attribution into a single tooltip so neither is lost.
        const attributionSuffix = source
          ? ` — referenced in the ${source}`
          : "";
        const tooltip = (title ? `${key} ${title}` : key) + attributionSuffix;
        return (
          <button
            key={key}
            type="button"
            onClick={() => open(key)}
            className="flex w-full cursor-pointer items-center gap-1.5 text-left text-xs hover:underline"
            title={tooltip}
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
