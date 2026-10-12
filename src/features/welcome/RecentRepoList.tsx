import { FolderDashedIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  RemoveRepoDialog,
  RepoAliasDialog,
} from "@/features/repository/RepoDialogs";
import {
  REPO_LIST_MAX_HEIGHT_PX,
  RepoList,
} from "@/features/repository/RepoList";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";

// This column at its tallest, which the Welcome reserves so the centered block
// never moves: the heading row (the `text-sm` h2's line box), the `space-y-2`
// gap, the box's `border`, and RepoList's own maximum. Each px figure mirrors
// the markup below, so a size change edits both.
const HEADING_ROW_PX = 20;
const HEADING_GAP_PX = 8;
const BOX_BORDER_PX = 2;
export const RECENT_REPO_LIST_MAX_HEIGHT_PX =
  HEADING_ROW_PX + HEADING_GAP_PX + BOX_BORDER_PX + REPO_LIST_MAX_HEIGHT_PX;

export function RecentRepoList() {
  const settings = useSettings();
  const recents = settings.data?.recentRepos ?? [];
  const [aliasTarget, setAliasTarget] = useState<RecentRepo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentRepo | null>(null);

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="font-heading text-sm font-medium">Repositories</h2>
        {recents.length > 0 && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {recents.length}
          </span>
        )}
      </div>
      {recents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 border border-dashed px-6 py-10 text-center">
          <FolderDashedIcon className="size-6 text-muted-foreground" />
          <p className="text-xs font-medium">No repositories yet</p>
          <p className="max-w-[30ch] text-[11px] text-muted-foreground">
            Open, clone, or create a repository and it&apos;ll show up here for
            quick access.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-none border">
          <RepoList
            onAliasRepo={setAliasTarget}
            onRemoveRepo={setRemoveTarget}
          />
        </div>
      )}
      <RepoAliasDialog
        key={aliasTarget?.path ?? "none"}
        repo={aliasTarget}
        onClose={() => setAliasTarget(null)}
      />
      <RemoveRepoDialog
        repo={removeTarget}
        onClose={() => setRemoveTarget(null)}
      />
    </div>
  );
}
