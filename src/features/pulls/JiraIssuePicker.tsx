import { CheckCircleIcon, CircleDashedIcon } from "@phosphor-icons/react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { issuePickerStatus } from "@/features/issues/issue-picker-status";
import { clipTitleFromText } from "@/lib/clip-title";
import { useJiraIssues } from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import type { JiraIssueInfo } from "@/lib/jira/types";

/** Open/closed glyph for a Jira issue, so status isn't conveyed by text alone.
 *  `done` maps to the closed/merged treatment (matching the native `StateIcon`
 *  CLOSED pair); anything else to the open/success treatment. */
export function JiraStatusIcon({ statusCategory }: { statusCategory: string }) {
  return statusCategory.toLowerCase() === "done" ? (
    <CheckCircleIcon className="size-3.5 shrink-0 text-merged" />
  ) : (
    <CircleDashedIcon className="size-3.5 shrink-0 text-success" />
  );
}

/**
 * Autocomplete over the linked Jira project's issues (all states), excluding the
 * keys already chipped. Picking one fires `onPick`. The Jira twin of `IssuePicker`
 * (src/features/issues/IssueRelations.tsx) — same Combobox composition, keyed by
 * the human key (`PROJ-123`). The list loads only while this is mounted (open).
 */
export function JiraIssuePicker({
  repoPath,
  link,
  exclude,
  pending,
  onPick,
}: {
  repoPath: string;
  link: JiraLink | null;
  exclude: Set<string>;
  pending: boolean;
  onPick: (key: string) => void;
}) {
  const issues = useJiraIssues(repoPath, link, "all");
  const candidates = (issues.data ?? []).filter((i) => !exclude.has(i.key));
  // One read, so `partial` is always null: no partial line or announcer here.
  const status = issuePickerStatus([issues], candidates.length);
  return (
    <Combobox
      items={candidates}
      itemToStringLabel={(i: JiraIssueInfo) => `${i.key} ${i.summary}`}
      value={null}
      onValueChange={(item: JiraIssueInfo | null) => item && onPick(item.key)}
      openOnInputClick
    >
      <ComboboxInput
        autoFocus
        className="w-full"
        placeholder="Search issues by key or summary"
        disabled={pending}
      />
      <ComboboxContent>
        <ComboboxEmpty>{status.empty}</ComboboxEmpty>
        <ComboboxList>
          {(item: JiraIssueInfo) => (
            <ComboboxItem key={item.key} value={item}>
              <JiraStatusIcon statusCategory={item.statusCategory} />
              <span className="shrink-0 font-mono text-muted-foreground">
                {item.key}
              </span>
              <span className="truncate" onMouseEnter={clipTitleFromText}>
                {item.summary}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
