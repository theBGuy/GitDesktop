import { FolderDashedIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  RemoveRepoDialog,
  RepoAliasDialog,
} from "@/features/repository/RepoDialogs";
import { RepoList } from "@/features/repository/RepoList";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import {
  BOX_CLASS,
  COLUMN_CLASS,
  HEADING_CLASS,
} from "./recent-repo-list-sizes";

export function RecentRepoList() {
  const settings = useSettings();
  const recents = settings.data?.recentRepos ?? [];
  const [aliasTarget, setAliasTarget] = useState<RecentRepo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentRepo | null>(null);

  return (
    <div className={COLUMN_CLASS}>
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className={HEADING_CLASS}>Repositories</h2>
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
        <div className={BOX_CLASS}>
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
