import { StackIcon } from "@phosphor-icons/react";
import { extractLinearKeys } from "@/lib/linear/keys";
import { useLinearIssues, useLinearLink } from "@/lib/linear/queries";
import { useUiStore } from "@/lib/stores/ui";

export interface LinearRefSource {
  label: string;
  text: string | null | undefined;
}

/**
 * The shared "Linear issues referenced" presentation: one full-width row per
 * matched identifier. Same idiom as JiraRefRow — clicking a row selects the
 * issue in the Linear panel AND switches to the Issues tab.
 */
export function LinearRefRow({
  repoPath,
  sources,
}: {
  repoPath: string;
  sources: LinearRefSource[];
}) {
  const link = useLinearLink(repoPath).data;
  const keys: string[] = [];
  const attribution = new Map<string, string>();
  if (link) {
    for (const source of sources) {
      for (const key of extractLinearKeys(source.text, link.teamKey)) {
        if (!attribution.has(key)) {
          attribution.set(key, source.label);
          keys.push(key);
        }
      }
    }
  }

  const issues = useLinearIssues(repoPath, keys.length > 0 ? link : null, "all");
  const selectIssue = useUiStore((s) => s.selectIssue);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  if (!link || keys.length === 0) return null;

  const titleFor = (key: string) =>
    issues.data?.find((i) => i.identifier === key)?.title;

  function open(key: string) {
    selectIssue({ kind: "linear", id: key });
    setRepoTab("issues");
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">
        Linear issues
      </p>
      {keys.map((key) => {
        const title = titleFor(key);
        const source = attribution.get(key);
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
            <StackIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-muted-foreground">
              {key}
            </span>
            {title && (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
