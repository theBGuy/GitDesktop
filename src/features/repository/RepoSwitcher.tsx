import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clipTitle } from "@/lib/clip-title";
import { normPath } from "@/lib/git/path";
import { useUserWorktrees } from "@/lib/git/queries";
import { dispatchAction, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { RecentRepo } from "@/lib/settings/api";
import { useRepoAlias, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { RemoveRepoDialog, RepoAliasDialog } from "./RepoDialogs";
import { RepoList } from "./RepoList";

const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p;

/** A repository action row in the switcher footer (open / clone / create). */
function ActionRow({
  icon: Icon,
  onClick,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </button>
  );
}

export function RepoSwitcher() {
  const repoName = useUiStore((s) => s.repoName);
  const repoPath = useUiStore((s) => s.repoPath);
  // In a linked worktree `repoPath` names the worktree FOLDER, so the slot would
  // forget which repository you're in — line 1 keeps the repo, the worktree drops
  // to a subtitle. Unconditional: this is a cheap local `git worktree list` and
  // the header is always mounted.
  const worktrees = useUserWorktrees(repoPath ?? "");
  const worktreeList = worktrees.data ?? [];
  const activeNorm = normPath(repoPath ?? "");
  const currentWt = worktreeList.find((w) => normPath(w.path) === activeNorm);
  const mainWt = worktreeList.find((w) => w.isMain);
  const inLinkedWorktree = Boolean(currentWt && !currentWt.isMain);
  const settings = useSettings();
  // The alias lookup and the picker's highlight both compare paths by exact
  // string, but git prints forward slashes while the app stores native
  // separators — so resolve the main worktree to its recents row's own spelling
  // before handing it to either.
  const mainRow =
    inLinkedWorktree && mainWt
      ? settings.data?.recentRepos.find(
          (r) => normPath(r.path) === normPath(mainWt.path),
        )
      : undefined;
  const mainRepoPath =
    inLinkedWorktree && mainWt ? (mainRow?.path ?? mainWt.path) : repoPath;
  // The highlight falls back to the CHECKOUT's path when the main workspace has
  // no recents row: a worktree opened via the picker is itself a row, and that
  // row lighting up beats highlighting nothing.
  const pickerCurrentPath =
    inLinkedWorktree && mainWt ? (mainRow?.path ?? repoPath) : repoPath;
  const alias = useRepoAlias(mainRepoPath);
  const [open, setOpen] = useState(false);
  // Dialogs live outside the popover: closing it unmounts its contents.
  const [aliasTarget, setAliasTarget] = useState<RecentRepo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentRepo | null>(null);

  useHotkeyAction("show-repositories", () => setOpen(true));

  const repoLabel =
    alias ??
    (inLinkedWorktree && mainWt
      ? baseName(mainWt.path)
      : (repoName ?? "Repository"));
  // Both sides must resolve — line 1 names the repo from `mainWt` — so a still
  // loading or failed worktree query renders the plain single line.
  const worktreeName =
    inLinkedWorktree && currentWt && mainWt ? baseName(currentWt.path) : null;

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              // Deliberately NOT shrinkable (the vendored Button's shrink-0
              // applies): the repo name holds its natural width while the
              // branch label (shrink-20) and CI badge (shrink-4) absorb header
              // space pressure — even a tiny flex-shrink share would swap
              // characters for an ellipsis. max-w-56 still caps long names.
              // The size's fixed h-7 can't hold two lines: the worktree line
              // grows the button, which the items-center header row re-centers.
              className={cn(
                "max-w-56 min-w-0 gap-1.5",
                worktreeName && "h-auto py-1",
              )}
            >
              {/* Default (stretch) alignment on purpose: a non-stretched column
                  child keeps its intrinsic width, so `truncate` never engages
                  and long names paint past the button (measured). */}
              <span className="flex min-w-0 flex-col">
                <span
                  className="min-w-0 truncate text-sm font-medium leading-tight"
                  onMouseEnter={clipTitle(repoLabel)}
                >
                  {repoLabel}
                </span>
                {worktreeName ? (
                  <span className="flex min-w-0 items-center gap-1 text-[10px] leading-tight text-muted-foreground">
                    <TreeStructureIcon
                      className="size-3 shrink-0"
                      weight="bold"
                      aria-hidden
                    />
                    <span className="sr-only">worktree </span>
                    <span
                      className="min-w-0 truncate"
                      onMouseEnter={clipTitle(worktreeName)}
                    >
                      {worktreeName}
                    </span>
                  </span>
                ) : null}
              </span>
              <CaretDownIcon className="shrink-0 text-muted-foreground" />
            </Button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup className="w-80 rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
              <RepoList
                currentPath={pickerCurrentPath}
                onOpened={() => setOpen(false)}
                onAliasRepo={(repo) => {
                  setOpen(false);
                  setAliasTarget(repo);
                }}
                onRemoveRepo={(repo) => {
                  setOpen(false);
                  setRemoveTarget(repo);
                }}
              />
              <div className="border-t py-1">
                <ActionRow
                  icon={FolderOpenIcon}
                  onClick={() => {
                    setOpen(false);
                    dispatchAction("add-local-repository");
                  }}
                >
                  Open repository…
                </ActionRow>
                <ActionRow
                  icon={DownloadSimpleIcon}
                  onClick={() => {
                    setOpen(false);
                    dispatchAction("clone-repository");
                  }}
                >
                  Clone repository…
                </ActionRow>
                <ActionRow
                  icon={FolderPlusIcon}
                  onClick={() => {
                    setOpen(false);
                    dispatchAction("new-repository");
                  }}
                >
                  Create repository…
                </ActionRow>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <RepoAliasDialog
        key={aliasTarget?.path ?? "none"}
        repo={aliasTarget}
        onClose={() => setAliasTarget(null)}
      />
      <RemoveRepoDialog
        repo={removeTarget}
        onClose={() => setRemoveTarget(null)}
      />
    </>
  );
}
