import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
  FolderPlusIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CloneRepoDialog } from "@/features/welcome/CloneRepoDialog";
import { CreateRepoDialog } from "@/features/welcome/CreateRepoDialog";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { RecentRepo } from "@/lib/settings/api";
import { useRepoAlias } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { RemoveRepoDialog, RepoAliasDialog } from "./RepoDialogs";
import { RepoList } from "./RepoList";
import { usePickAndOpenRepo } from "./useOpenRepoByPath";

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
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </button>
  );
}

export function RepoSwitcher() {
  const repoName = useUiStore((s) => s.repoName);
  const repoPath = useUiStore((s) => s.repoPath);
  const alias = useRepoAlias(repoPath);
  const pickAndOpen = usePickAndOpenRepo();
  const [open, setOpen] = useState(false);
  // Dialogs live outside the popover: closing it unmounts its contents.
  const [aliasTarget, setAliasTarget] = useState<RecentRepo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentRepo | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Open/clone/create are reachable here too, so you don't have to leave the
  // repository view to get to another repo.
  useHotkeyAction("show-repositories", () => setOpen(true));
  useHotkeyAction("add-local-repository", pickAndOpen);
  useHotkeyAction("clone-repository", () => setCloneOpen(true));
  useHotkeyAction("new-repository", () => setCreateOpen(true));

  const repoLabel = alias ?? repoName ?? "Repository";

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
              className="max-w-56 min-w-0 gap-1.5"
            >
              <span
                className="min-w-0 truncate text-sm font-medium"
                // Only expose the full name as a tooltip when it's actually
                // clipped — measured just-in-time on hover, so no ref needed.
                onMouseEnter={(e) => {
                  const el = e.currentTarget;
                  if (el)
                    el.title =
                      el.scrollWidth > el.clientWidth ? repoLabel : "";
                }}
              >
                {repoLabel}
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
                currentPath={repoPath}
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
                    pickAndOpen();
                  }}
                >
                  Open repository…
                </ActionRow>
                <ActionRow
                  icon={DownloadSimpleIcon}
                  onClick={() => {
                    setOpen(false);
                    setCloneOpen(true);
                  }}
                >
                  Clone repository…
                </ActionRow>
                <ActionRow
                  icon={FolderPlusIcon}
                  onClick={() => {
                    setOpen(false);
                    setCreateOpen(true);
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
      <CloneRepoDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      <CreateRepoDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
