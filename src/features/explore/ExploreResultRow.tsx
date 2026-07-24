import {
  BookBookmarkIcon,
  GitForkIcon,
  LockSimpleIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import type { ForgeSearchRepo } from "@/lib/git/types";
import { cn } from "@/lib/utils";
import { compactNumber, exploreOptionId } from "./explore-utils";

/** One repository result row — a `role="option"` in the results listbox. Row
 *  anatomy mirrors the clone browser's RepoRow (leading icon by private/fork
 *  priority) plus stars and a truncated description for the richer search shape. */
export function ExploreResultRow({
  repo,
  active,
  onSelect,
}: {
  repo: ForgeSearchRepo;
  active: boolean;
  onSelect: (repo: ForgeSearchRepo) => void;
}) {
  const Icon = repo.private
    ? LockSimpleIcon
    : repo.fork
      ? GitForkIcon
      : BookBookmarkIcon;
  return (
    <button
      type="button"
      id={exploreOptionId(repo.fullName)}
      role="option"
      aria-selected={active}
      onClick={() => onSelect(repo)}
      className={cn(
        "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <span className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">{repo.owner}/</span>
          <span className="font-medium">{repo.name}</span>
        </span>
        {repo.archived && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            Archived
          </Badge>
        )}
        {repo.stars != null && (
          <span className="flex shrink-0 items-center gap-0.5 tabular-nums text-muted-foreground">
            <StarIcon className="size-3" />
            {compactNumber.format(repo.stars)}
          </span>
        )}
      </span>
      {repo.description && (
        <span className="truncate pl-[1.375rem] text-[11px] text-muted-foreground">
          {repo.description}
        </span>
      )}
    </button>
  );
}
