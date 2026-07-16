import {
  ArrowSquareOutIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useCreateLinkedBranch, useIssueDevelopment } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Icon + tone for a linked PR, so state isn't conveyed by color alone. */
function prPresentation(state: string): {
  Icon: typeof GitPullRequestIcon;
  tone: string;
} {
  if (state === "MERGED") {
    return {
      Icon: GitMergeIcon,
      tone: "text-merged",
    };
  }
  if (state === "CLOSED") {
    return {
      Icon: GitPullRequestIcon,
      tone: "text-destructive",
    };
  }
  return {
    Icon: GitPullRequestIcon,
    tone: "text-success",
  };
}

/** GitHub's default linked-branch name: `<number>-<slugified title>`. */
function defaultBranchName(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60);
  return slug ? `${number}-${slug}` : `${number}-branch`;
}

/**
 * GitHub's issue "Development" section: the PRs that close/reference the issue
 * and the branches linked to it. Clicking a PR opens it in the Pulls tab.
 * "Create a branch" makes a new remote branch linked to the issue; linking an
 * existing PR/branch has no public mutation, so it links out to GitHub. A
 * meta-sidebar section (shows an empty state rather than hiding).
 */
export function IssueDevelopment({
  repoPath,
  number,
  issueId,
  issueTitle,
  issueUrl,
  lens,
}: {
  repoPath: string;
  number: number;
  issueId: string;
  issueTitle: string;
  issueUrl: string;
  /** The origin|upstream lens the parent issue view resolved. */
  lens: RemoteLens;
}) {
  const dev = useIssueDevelopment(repoPath, number, lens);
  const createBranch = useCreateLinkedBranch(repoPath, lens);
  const selectPr = useUiStore((s) => s.selectPr);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState("");

  const prs = dev.data?.prs ?? [];
  const branches = dev.data?.branches ?? [];
  const loaded = dev.data !== undefined;

  function openPr(n: number) {
    selectPr({ kind: "remote", id: String(n) });
    setRepoTab("pulls");
  }

  function submitBranch() {
    const name = branchName.trim();
    if (!name) return;
    createBranch.mutate(
      { issueId, name },
      {
        onSuccess: () => {
          toast.success(`Created branch ${name}`, {
            description: "Fetch to check it out locally.",
          });
          setBranchOpen(false);
        },
        onError: toastError,
      },
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">Development</p>
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-label="Development actions"
              />
            }
          >
            <PlusIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              onClick={() => {
                setBranchName(defaultBranchName(number, issueTitle));
                setBranchOpen(true);
              }}
            >
              Create a branch…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openUrl(issueUrl)}>
              <ArrowSquareOutIcon />
              Link a pull request or branch on GitHub…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {prs.map((pr) => {
        const { Icon, tone } = prPresentation(pr.state);
        return (
          <button
            key={pr.number}
            type="button"
            onClick={() => openPr(pr.number)}
            className="flex w-full cursor-pointer items-center gap-1.5 text-left text-xs hover:underline"
            title={`#${pr.number} ${pr.title}`}
          >
            <Icon className={cn("size-3.5 shrink-0", tone)} />
            <span className="text-muted-foreground">#{pr.number}</span>
            <span className="min-w-0 flex-1 truncate">{pr.title}</span>
          </button>
        );
      })}
      {branches.map((b) => (
        <div
          key={b}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title={b}
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">{b}</span>
        </div>
      ))}
      {loaded && prs.length === 0 && branches.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No linked pull requests or branches.
        </p>
      )}

      <Dialog open={branchOpen} onOpenChange={setBranchOpen}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitBranch();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create a branch</DialogTitle>
              <DialogDescription>
                Creates a branch off the default branch on GitHub, linked to #
                {number}. Fetch afterwards to check it out locally.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="branch-name"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBranchOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!branchName.trim() || createBranch.isPending}
              >
                {createBranch.isPending && <Spinner data-icon="inline-start" />}
                Create branch
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
