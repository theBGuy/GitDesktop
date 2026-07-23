import {
  ArrowSquareOutIcon,
  ChartBarIcon,
  CodeIcon,
  CopyIcon,
  CubeIcon,
  DotsThreeVerticalIcon,
  FilesIcon,
  FolderOpenIcon,
  GearSixIcon,
  GitForkIcon,
  KanbanIcon,
  LightningIcon,
  LinkIcon,
  PencilSimpleIcon,
  ShieldCheckIcon,
  StarIcon,
  TagSimpleIcon,
  TerminalIcon,
  TrashIcon,
  TreeStructureIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { lazy, Suspense, useState } from "react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { RepoAutomationsDialog } from "@/features/automations/RepoAutomationsDialog";
import { BranchRulesDialog } from "@/features/branch-rules/BranchRulesDialog";
import { HooksDialog } from "@/features/hooks/HooksDialog";
import { RepoJiraDialog } from "@/features/issues/RepoJiraDialog";
import { copyText } from "@/lib/clipboard";
import {
  forgeRepoUrl,
  openInTerminal,
  openWithDefault,
  openWithProgram,
} from "@/lib/git/api";
import {
  forgeFeatureReady,
  forgeSupports,
  useForgeStatus,
  useForkRepo,
  useRepoAdmin,
  useRepoStarStatus,
  useRepoStatus,
  useSetRepoStar,
  useSubmodules,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useJiraLink } from "@/lib/jira/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { RemoteUrlDialog } from "./RemoteUrlDialog";
import { RemoveRepoDialog, RepoAliasDialog } from "./RepoDialogs";
import { RepositoryFilesDialog } from "./RepositoryFilesDialog";
import { SubmodulesDialog } from "./SubmodulesDialog";
import { WorktreesDialog } from "./WorktreesDialog";

// RepoSettingsDialog's tree pulls in the Shiki highlighter (via parts.tsx →
// shiki-highlighter's highlightJson), which is heavy and only needed once an
// admin opens repository settings. Loading it lazily keeps that chunk off the
// boot path. The dialog is rendered ONLY while open (not always-mounted like
// the sibling dialogs): a lazy component that is always rendered loads its
// chunk immediately, defeating the split — the open-gate is what defers the
// import to first open. Trade-off: the dialog no longer stays mounted across
// close/reopen, so its remembered rail section resets to "general" each open
// (see the state note at its render site).
const RepoSettingsDialog = lazy(() =>
  import("@/features/repo-settings/RepoSettingsDialog").then((m) => ({
    default: m.RepoSettingsDialog,
  })),
);

export function RepositoryMenu({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  const settings = useSettings();
  const repoName = useUiStore((s) => s.repoName);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const fork = useForkRepo(repoPath);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [branchRulesOpen, setBranchRulesOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [submodulesOpen, setSubmodulesOpen] = useState(false);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  // Only offer the Submodules menu item when the repo actually has submodules.
  const submodules = useSubmodules(repoPath);
  const hasSubmodules = (submodules.data?.length ?? 0) > 0;
  const [forkOpen, setForkOpen] = useState(false);
  const [forkIntent, setForkIntent] = useState<"contribute" | "own">(
    "contribute",
  );
  const [remoteUrlOpen, setRemoteUrlOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [aliasTarget, setAliasTarget] = useState<RecentRepo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentRepo | null>(null);

  // This repo's recents entry (carries the alias); synthesized if missing.
  const repoEntry: RecentRepo = settings.data?.recentRepos.find(
    (r) => r.path === repoPath,
  ) ?? {
    path: repoPath,
    name: repoName ?? repoPath,
    lastOpenedAt: "",
  };

  // View-on-host works for GitHub, GitLab, and Bitbucket (forge_repo_url is
  // implemented everywhere); the other host actions gate on capability. Forking
  // on GitLab/Bitbucket is a web link-out (the fork dialog's remote-rewiring
  // flow is GitHub-only); starring and creating issues on the host are hidden
  // where the platform lacks them (Bitbucket has no stars and its issue tracker
  // is retired).
  const provider = gh.data?.provider;
  const canGh = forgeFeatureReady(gh.data, "repoActions");
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  const remoteLabel = providerLabel(provider);
  const canStar = canGh && forgeSupports(gh.data, "stars");
  const canCreateHostIssue = canGh && forgeSupports(gh.data, "issues");
  const starStatus = useRepoStarStatus(repoPath, canStar);
  const setStar = useSetRepoStar(repoPath);
  const starred = starStatus.data ?? false;
  // Repo settings are admin-only, on both providers (GitHub admin / GitLab
  // Maintainer+ — the probe dispatches per provider); the menu item hides for
  // everyone else.
  const settingsReady = forgeFeatureReady(gh.data, "repoSettings");
  const admin = useRepoAdmin(repoPath, settingsReady);
  const editor = (settings.data?.externalEditor ?? "").trim();
  const editorName =
    (settings.data?.externalEditorName ?? "").trim() || "editor";

  // Current branch name + HEAD OID, for the copy actions. The two go null
  // independently: a detached HEAD nulls only `name` (the OID is still a real
  // SHA), and an unborn/empty repo nulls only `oid` (the branch name is still
  // present). Each item disables on its own value, and the palette handlers
  // explain why rather than copying "null".
  const status = useRepoStatus(repoPath);
  const branchName = status.data?.branch.name ?? null;
  const headOid = status.data?.branch.oid ?? null;

  // The repo's Jira link (if any), so the menu item reads "Change…" vs "Link…"
  // and the dialog opens in edit mode.
  const jiraLink = useJiraLink(repoPath);

  const onError = (e: unknown) => toastError(e);

  async function openWeb(suffix = "") {
    try {
      const url = await forgeRepoUrl(repoPath);
      await openUrl(`${url}${suffix}`);
    } catch (e) {
      onError(e);
    }
  }

  // Fork: GitHub uses the remote-rewiring dialog; GitLab and Bitbucket fork from
  // their web page (the dialog's flow is GitHub-only). Bitbucket's fork URL is
  // <repo>/fork; GitLab's is <repo>/-/forks/new.
  const forkAction = () => {
    if (isGitLab) return openWeb("/-/forks/new");
    if (isBitbucket) return openWeb("/fork");
    return setForkOpen(true);
  };

  // Every menu entry doubles as a hotkey/palette action with the same gates.
  useHotkeyAction("view-on-github", () => openWeb(), canGh);
  // create-issue is the in-app dialog (registered in RepositoryView + IssuesPanel);
  // the "Create issue on {host}" menu item below still opens the web page.
  useHotkeyAction("fork-repository", forkAction, canGh);
  useHotkeyAction("open-in-terminal", () =>
    openInTerminal(
      repoPath,
      settings.data?.terminal,
      settings.data?.terminalPath,
      settings.data?.terminalCommand,
    ).catch(onError),
  );
  useHotkeyAction("show-in-explorer", () =>
    openWithDefault(repoPath).catch(onError),
  );
  useHotkeyAction(
    "open-in-editor",
    () => openWithProgram(editor, repoPath).catch(onError),
    Boolean(editor),
  );
  useHotkeyAction("repository-statistics", () => setRepoTab("insights"));
  useHotkeyAction("manage-files", () => setFilesOpen(true));
  useHotkeyAction("automations", () => setAutomationsOpen(true));
  useHotkeyAction("link-jira-project", () => setJiraOpen(true));
  useHotkeyAction(
    "repository-settings",
    () => setRepoSettingsOpen(true),
    settingsReady && Boolean(admin.data?.admin),
  );
  useHotkeyAction("branch-rules", () => setBranchRulesOpen(true));
  useHotkeyAction("git-hooks", () => setHooksOpen(true));
  useHotkeyAction("submodules", () => setSubmodulesOpen(true), hasSubmodules);
  useHotkeyAction("worktrees", () => setWorktreesOpen(true));
  useHotkeyAction(
    "star-repository",
    () =>
      setStar.mutate(!starred, {
        onSuccess: () =>
          toast.success(
            starred
              ? "Star removed"
              : `Starred ${gh.data?.repo ?? "repository"}`,
          ),
        onError,
      }),
    canStar && !setStar.isPending,
  );
  useHotkeyAction("change-remote-url", () => setRemoteUrlOpen(true));
  useHotkeyAction("repo-alias", () => setAliasTarget(repoEntry));
  useHotkeyAction("copy-repo-path", () =>
    copyText(repoPath, "Repository path copied"),
  );
  useHotkeyAction("copy-branch-name", () =>
    branchName
      ? copyText(branchName, "Branch name copied")
      : toast.error("Detached HEAD — no branch to copy"),
  );
  useHotkeyAction("copy-head-sha", () =>
    headOid
      ? copyText(headOid, "HEAD SHA copied")
      : toast.error("No commits yet — nothing to copy"),
  );
  useHotkeyAction("remove-repository", () => setRemoveTarget(repoEntry));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Repository actions"
          />
        }
      >
        <DotsThreeVerticalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {canGh && (
          <>
            <DropdownMenuItem onClick={() => openWeb()}>
              <ArrowSquareOutIcon />
              View on {remoteLabel}
            </DropdownMenuItem>
            {canStar && (
              <DropdownMenuItem
                disabled={setStar.isPending}
                onClick={() =>
                  setStar.mutate(!starred, {
                    onSuccess: () =>
                      toast.success(
                        starred
                          ? "Star removed"
                          : `Starred ${gh.data?.repo ?? "repository"}`,
                      ),
                    onError,
                  })
                }
              >
                <StarIcon weight={starred ? "fill" : "regular"} />
                {starred ? "Unstar repository" : "Star repository"}
              </DropdownMenuItem>
            )}
            {canCreateHostIssue && (
              <DropdownMenuItem
                onClick={() =>
                  openWeb(isGitLab ? "/-/issues/new" : "/issues/new")
                }
              >
                <WarningCircleIcon />
                Create issue on {remoteLabel}
              </DropdownMenuItem>
            )}
            {isGitLab || isBitbucket ? (
              // The fork dialog's flow (fork + rewire remotes + set-default) is
              // GitHub-only; GitLab/Bitbucket fork from their web page instead of
              // hiding the affordance.
              <DropdownMenuItem onClick={forkAction}>
                <GitForkIcon />
                Fork on {remoteLabel}…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => setForkOpen(true)}>
                <GitForkIcon />
                Fork repository…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onClick={() =>
            openInTerminal(
              repoPath,
              settings.data?.terminal,
              settings.data?.terminalPath,
              settings.data?.terminalCommand,
            ).catch(onError)
          }
        >
          <TerminalIcon />
          Open in terminal
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => openWithDefault(repoPath).catch(onError)}
        >
          <FolderOpenIcon />
          Show in Explorer
        </DropdownMenuItem>
        {editor && (
          <DropdownMenuItem
            onClick={() => openWithProgram(editor, repoPath).catch(onError)}
          >
            <PencilSimpleIcon />
            Open in {editorName}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setRepoTab("insights")}>
          <ChartBarIcon />
          Insights…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFilesOpen(true)}>
          <FilesIcon />
          Manage files…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setAutomationsOpen(true)}>
          <LightningIcon />
          Automations…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setJiraOpen(true)}>
          <KanbanIcon />
          {jiraLink.data ? "Change Jira project…" : "Link Jira project…"}
        </DropdownMenuItem>
        {settingsReady && admin.data?.admin && (
          <DropdownMenuItem onClick={() => setRepoSettingsOpen(true)}>
            <GearSixIcon />
            Repository settings…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => setBranchRulesOpen(true)}>
          <ShieldCheckIcon />
          Branch rules…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setHooksOpen(true)}>
          <CodeIcon />
          Git hooks…
        </DropdownMenuItem>
        {hasSubmodules && (
          <DropdownMenuItem onClick={() => setSubmodulesOpen(true)}>
            <CubeIcon />
            Submodules…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => setWorktreesOpen(true)}>
          <TreeStructureIcon />
          Worktrees…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setRemoteUrlOpen(true)}>
          <LinkIcon />
          Change remote URL…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setAliasTarget(repoEntry)}>
          <TagSimpleIcon />
          {repoEntry.alias ? "Change alias…" : "Create alias…"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => copyText(repoPath, "Repository path copied")}
        >
          <CopyIcon />
          Copy repository path
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!branchName}
          title={branchName ? undefined : "Detached HEAD — no branch to copy"}
          onClick={() =>
            branchName && copyText(branchName, "Branch name copied")
          }
        >
          <CopyIcon />
          Copy branch name
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!headOid}
          title={headOid ? undefined : "No commits yet — nothing to copy"}
          onClick={() => headOid && copyText(headOid, "HEAD SHA copied")}
        >
          <CopyIcon />
          Copy HEAD SHA
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => setRemoveTarget(repoEntry)}
        >
          <TrashIcon />
          Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
      <RepoAutomationsDialog
        repoPath={repoPath}
        open={automationsOpen}
        onOpenChange={setAutomationsOpen}
      />
      <RepoJiraDialog
        repoPath={repoPath}
        open={jiraOpen}
        onOpenChange={setJiraOpen}
        existingLink={jiraLink.data ?? null}
      />
      {/* Open-gated (unlike the always-mounted siblings above) so its lazy
          chunk loads on first open, not on boot. `open` stays true while
          mounted; `onOpenChange(false)` flips the gate, unmounting the subtree
          — the same immediate-unmount-on-close idiom the other open-gated
          dialogs in this app use (e.g. ImportMcpDialog). The dialog's remembered
          rail section (its internal `section` state) no longer persists across
          close/reopen and resets to "general" each open. */}
      {repoSettingsOpen && (
        <Suspense fallback={null}>
          <RepoSettingsDialog
            repoPath={repoPath}
            open={repoSettingsOpen}
            onOpenChange={setRepoSettingsOpen}
          />
        </Suspense>
      )}
      <BranchRulesDialog
        repoPath={repoPath}
        open={branchRulesOpen}
        onOpenChange={setBranchRulesOpen}
      />
      <HooksDialog
        repoPath={repoPath}
        open={hooksOpen}
        onOpenChange={setHooksOpen}
      />
      <SubmodulesDialog
        repoPath={repoPath}
        open={submodulesOpen}
        onOpenChange={setSubmodulesOpen}
      />
      <WorktreesDialog
        repoPath={repoPath}
        open={worktreesOpen}
        onOpenChange={setWorktreesOpen}
      />
      <RemoteUrlDialog
        repoPath={repoPath}
        open={remoteUrlOpen}
        onOpenChange={setRemoteUrlOpen}
      />
      <RepositoryFilesDialog
        repoPath={repoPath}
        open={filesOpen}
        onOpenChange={setFilesOpen}
      />
      <RepoAliasDialog
        key={
          aliasTarget
            ? `${aliasTarget.path}:${aliasTarget.alias ?? ""}`
            : "none"
        }
        repo={aliasTarget}
        onClose={() => setAliasTarget(null)}
      />
      <RemoveRepoDialog
        repo={removeTarget}
        onClose={() => setRemoveTarget(null)}
      />
      <Dialog open={forkOpen} onOpenChange={setForkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fork this repository?</DialogTitle>
            <DialogDescription>
              Creates a fork of {gh.data?.repo ?? "this repository"} under your
              GitHub account and rewires the remotes: your fork becomes{" "}
              <span className="font-mono">origin</span> and the original
              repository becomes <span className="font-mono">upstream</span>.
              Pushes go to your fork either way.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs font-medium">I'll be using this fork…</p>
            <RadioGroup
              value={forkIntent}
              onValueChange={(v) => setForkIntent(v as "contribute" | "own")}
            >
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <Radio value="contribute" className="mt-0.5" />
                <span>
                  <span className="font-medium">
                    To contribute to the parent repository
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    Pull requests, issues, and "View on GitHub" keep targeting{" "}
                    {gh.data?.repo ?? "the original repository"}.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <Radio value="own" className="mt-0.5" />
                <span>
                  <span className="font-medium">For my own purposes</span>
                  <span className="mt-0.5 block text-muted-foreground">
                    Pull requests, issues, and "View on GitHub" target your fork
                    instead.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setForkOpen(false)}
              disabled={fork.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={fork.isPending}
              onClick={() =>
                fork.mutate(forkIntent === "contribute", {
                  onSuccess: (url) => {
                    setForkOpen(false);
                    toast.success(
                      url
                        ? "Forked — your fork is now origin"
                        : "Fork already existed — remotes updated",
                      { description: url || undefined },
                    );
                  },
                  onError,
                })
              }
            >
              {fork.isPending && <Spinner data-icon="inline-start" />}
              Fork repository
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  );
}
