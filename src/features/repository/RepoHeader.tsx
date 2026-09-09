import { ArrowLeftIcon, GearIcon, QuestionIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { BranchCiBadge } from "@/features/actions/BranchCiBadge";
import { BranchJiraBadge } from "@/features/actions/BranchJiraBadge";
import { ActivityDock } from "@/features/activity/ActivityDock";
import { useUpdateCheck } from "@/features/updates/useUpdateCheck";
import { useUiStore } from "@/lib/stores/ui";
import { BranchSwitcher } from "./BranchSwitcher";
import { RepoSwitcher } from "./RepoSwitcher";
import { RepositoryMenu } from "./RepositoryMenu";
import { SyncControls } from "./SyncControls";

export function RepoHeader({ repoPath }: { repoPath: string }) {
  const closeRepo = useUiStore((s) => s.closeRepo);
  const openSettings = useUiStore((s) => s.openSettings);
  const openHelp = useUiStore((s) => s.openHelp);
  const updateAvailable = Boolean(useUpdateCheck().data);

  return (
    <header className="flex items-center gap-2 border-b px-3 py-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to repositories"
        title="Back to repositories"
        onClick={closeRepo}
      >
        <ArrowLeftIcon />
      </Button>
      <RepoSwitcher />
      <RepositoryMenu repoPath={repoPath} />
      <Separator orientation="vertical" className="my-1" />
      <BranchSwitcher repoPath={repoPath} />
      <BranchCiBadge repoPath={repoPath} />
      <BranchJiraBadge repoPath={repoPath} />
      <div className="flex-1" />
      <SyncControls repoPath={repoPath} />
      <ActivityDock />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="User guide"
        title="User guide (F1)"
        onClick={openHelp}
      >
        <QuestionIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        aria-label={
          updateAvailable ? "Settings — update available" : "Settings"
        }
        title={updateAvailable ? "Settings — update available" : "Settings"}
        onClick={() => openSettings()}
      >
        <GearIcon />
        {updateAvailable && (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background animate-in fade-in motion-reduce:animate-none"
          />
        )}
      </Button>
    </header>
  );
}
