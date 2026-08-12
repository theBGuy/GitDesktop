import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { probeAndPersistVisibility } from "@/features/repository/useRepoVisibilityProbe";
import {
  useBbRepoSettings,
  useDeleteRepo,
  useForgeStatus,
  useGlRemoveForkRelationship,
  useGlRepoSettings,
  useRemotes,
  useRemoveRemote,
  useRenameRepo,
  useRepoAdmin,
  useRepoSettings,
  useSetArchived,
  useSetVisibility,
  useTransferRepo,
} from "@/lib/git/queries";
import { type ForgeProvider, providerLabel } from "@/lib/git/types";
import { deleteRepoLens } from "@/lib/repo-lens/store";
import { settingsKeys, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { InlineConfirm } from "./parts";
import { ScopeRefreshHint } from "./ScopeRefreshHint";

/** The provider-neutral facts the danger actions need, sourced from whichever
 *  provider's settings read is active. */
interface DangerInfo {
  /** "owner/repo" (GitHub) or the full project path (GitLab) — the confirm phrase. */
  fullName: string;
  /** What the rename input starts from (GitHub repo name / GitLab path slug). */
  currentName: string;
  archived: boolean;
  visibility: string;
  /** The repo's web URL — Bitbucket's transfer link-out targets `{webUrl}/admin`. */
  webUrl: string;
}

/** A guarded destructive dialog: the confirm button stays disabled until the
 *  user types the repo's `owner/repo` exactly. */
function DangerDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmPhrase,
  confirmLabel,
  pending,
  disabled,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmPhrase: string;
  confirmLabel: string;
  pending: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const matches = typed.trim() === confirmPhrase;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <div className="space-y-1.5">
          <Label htmlFor="danger-confirm" className="text-xs">
            Type <span className="font-mono">{confirmPhrase}</span> to confirm
          </Label>
          <Input
            id="danger-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || disabled || pending}
            onClick={onConfirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </div>
      {children}
    </div>
  );
}

const OWNER_HINT = "Needs the Owner role on GitLab";

/** A danger-zone trigger whose disabled state still explains itself: the
 *  vendored Button renders a NATIVE `disabled`, which swallows pointer events
 *  (so a `title` on the button never shows) — the hint rides a wrapping span. */
function DangerButton({
  hint,
  className,
  ...props
}: ComponentProps<typeof Button> & { hint?: string }) {
  return (
    <span title={hint} className={cn("inline-flex", className)}>
      <Button size="sm" {...props} />
    </span>
  );
}

function RenameAction({
  repoPath,
  info,
  isGitLab,
  isBitbucket,
}: {
  repoPath: string;
  info: DangerInfo;
  isGitLab: boolean;
  isBitbucket: boolean;
}) {
  const rename = useRenameRepo(repoPath);
  const current = info.currentName;
  const [name, setName] = useState(current);
  // GitLab paths must start alphanumeric; GitHub/Bitbucket allow a leading
  // `.`/`_`/`-` (".github" is a standard repo name) — the check branches so
  // they keep their fuller grammar.
  const valid = isGitLab
    ? /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim())
    : /^[A-Za-z0-9._-]+$/.test(name.trim());
  const changed = name.trim() !== current;

  return (
    <Row
      title={isGitLab ? "Rename project" : "Rename repository"}
      desc={
        isGitLab
          ? "Renames the name and path; old paths redirect."
          : isBitbucket
            ? "Renaming changes the repository URL; GitDesktop will update your local 'origin' remote automatically."
            : "Old links and clones keep working."
      }
    >
      <div className="flex shrink-0 items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-44 font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!valid || !changed || rename.isPending}
          onClick={() =>
            rename.mutate(name.trim(), {
              onSuccess: () =>
                toast.success(
                  isBitbucket
                    ? `Renamed to ${name.trim()} — origin remote updated`
                    : `Renamed to ${name.trim()} — links redirect`,
                ),
              onError: toastError,
            })
          }
        >
          {rename.isPending && <Spinner data-icon="inline-start" />}
          Rename
        </Button>
      </div>
    </Row>
  );
}

function ArchiveAction({
  repoPath,
  info,
  isGitLab,
  isOwner,
}: {
  repoPath: string;
  info: DangerInfo;
  isGitLab: boolean;
  isOwner: boolean;
}) {
  const setArchived = useSetArchived(repoPath);
  const [confirming, setConfirming] = useState(false);
  const archived = info.archived;
  // Sentence-cased for toasts, lowercase mid-sentence — GitHub copy unchanged.
  const noun = isGitLab ? "project" : "repository";
  const nounCap = isGitLab ? "Project" : "Repository";

  return (
    <Row
      title={archived ? `Unarchive ${noun}` : `Archive ${noun}`}
      desc={
        archived
          ? `Make the ${noun} writable again.`
          : `Make the ${noun} read-only. Reversible.`
      }
    >
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <InlineConfirm
            actLabel={archived ? "Unarchive" : "Archive"}
            actVariant={archived ? "default" : "destructive"}
            pending={setArchived.isPending}
            onCancel={() => setConfirming(false)}
            onAct={() =>
              setArchived.mutate(!archived, {
                onSuccess: () => {
                  toast.success(
                    archived ? `${nounCap} unarchived` : `${nounCap} archived`,
                  );
                  setConfirming(false);
                },
                onError: toastError,
              })
            }
          />
        </div>
      ) : (
        <DangerButton
          variant="outline"
          disabled={!isOwner}
          hint={isOwner ? undefined : OWNER_HINT}
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          {archived ? "Unarchive" : "Archive"}
        </DangerButton>
      )}
    </Row>
  );
}

/** Local detach: drop the `upstream` remote, collapsing every fork-identity
 *  surface (the origin/upstream switcher, "Update from upstream", "Create on
 *  parent") via the broad `["repo", repo]` invalidation. Reversible — the user
 *  can re-add the remote (CreatePrDialog's Add-upstream affordance returns for a
 *  known fork). Shown for ANY provider whenever an `upstream` remote exists;
 *  never fakes the persisted `isFork` provenance (that reflects GitHub-side
 *  truth and only changes via re-probe). */
function RemoveUpstreamAction({ repoPath }: { repoPath: string }) {
  const remotes = useRemotes(repoPath);
  const removeRemote = useRemoveRemote(repoPath);
  const [confirming, setConfirming] = useState(false);

  if (!remotes.data?.includes("upstream")) return null;

  return (
    <>
      <div className="border-t" />
      <Row
        title="Remove upstream remote"
        desc="Detaches this clone from the fork's parent locally: the Fork/Upstream switcher and “Update from upstream” disappear, and branches that tracked upstream lose their tracking. Reversible — re-add the remote to restore it."
      >
        {confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <InlineConfirm
              actLabel="Remove"
              pending={removeRemote.isPending}
              onCancel={() => setConfirming(false)}
              onAct={() =>
                removeRemote.mutate(
                  { name: "upstream" },
                  {
                    onSuccess: () => {
                      // Hygiene: the persisted "upstream" lens no longer applies.
                      // Fire-and-forget — the lens read safe-defaults to origin,
                      // so a failure here is harmless.
                      deleteRepoLens(repoPath).catch(() => undefined);
                      // Removing upstream collapses the lens to origin, so a still-
                      // selected remote number would resolve against the other repo.
                      // Same clears `useSetRepoLens` does on an explicit lens flip.
                      const ui = useUiStore.getState();
                      if (ui.selectedPr?.kind === "remote") ui.selectPr(null);
                      if (ui.selectedIssue?.kind === "remote")
                        ui.selectIssue(null);
                      toast.success("Upstream remote removed");
                      setConfirming(false);
                    },
                    onError: toastError,
                  },
                )
              }
            />
          </div>
        ) : (
          <DangerButton
            variant="outline"
            className="shrink-0"
            onClick={() => setConfirming(true)}
          >
            Remove upstream
          </DangerButton>
        )}
      </Row>
    </>
  );
}

/** Leave the fork network — provider-branched, gated on the persisted fork
 *  provenance (independent of the upstream-remote gate):
 *  - **GitLab** has a real API, so this is an in-app, Owner-gated detach that
 *    removes the fork relationship (open MRs to the parent are closed).
 *  - **GitHub** and **Bitbucket** have no detach API, so they link out to the
 *    provider's settings page (GitHub `…/settings`, Bitbucket `…/admin`).
 *  A shared "Re-check fork status" affordance re-probes and re-persists, so the
 *  fork badge + persisted `isFork` clear once the network is left — never
 *  cleared optimistically (it reflects forge-side truth). Its toasts name the
 *  active provider. The GitLab arm also fires the re-probe itself on success. */
function LeaveForkNetworkAction({
  repoPath,
  fullName,
  provider,
  isOwner,
}: {
  repoPath: string;
  fullName: string;
  provider: ForgeProvider;
  isOwner: boolean;
}) {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const forge = useForgeStatus(repoPath);
  const removeFork = useGlRemoveForkRelationship(repoPath);
  const [rechecking, setRechecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const record = settings.data?.recentRepos.find((r) => r.path === repoPath);

  if (record?.isFork !== true) return null;

  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  // The provider's own label, for the re-check toasts.
  const label = providerLabel(provider);

  // Derive the host — on GitHub Enterprise the provider is still "github" but a
  // hardcoded github.com would open the wrong host's settings page. While the
  // forge status is still resolving (or errored — retry: false), fall back to
  // the persisted RecentRepo host, which is available synchronously. Bitbucket
  // support is Cloud-only, so its fallback is always bitbucket.org.
  const ghHost = forge.data?.host || record?.host || "github.com";
  const bbHost = record?.host || "bitbucket.org";

  // Post-success confirmation probe (GitLab in-app detach). A failure is
  // swallowed deliberately: the detach itself already succeeded (and toasted),
  // the persisted badge self-heals on the next repo open, and the row's own
  // "Re-check fork status" button — which does surface errors — remains
  // available meanwhile.
  const reprobe = () =>
    probeAndPersistVisibility(repoPath)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
      )
      .catch(() => undefined);

  const recheck = async () => {
    setRechecking(true);
    try {
      const probe = await probeAndPersistVisibility(repoPath);
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings });
      // A null probe means no provider was detected (e.g. the origin remote is
      // gone) — the badge still clears, but don't present that as a verified
      // detach.
      if (probe === null) {
        toast.success(`Couldn't verify on ${label} — fork badge cleared`);
      } else {
        toast.success(
          probe.isFork
            ? `Still a fork on ${label}`
            : `No longer a fork on ${label} — badge cleared`,
        );
      }
    } catch (e) {
      toastError(e);
    } finally {
      setRechecking(false);
    }
  };

  const desc = isGitLab
    ? "Removes the fork relationship on GitLab. Open merge requests to the parent are closed — they stay closed even if the relationship is later re-established via the GitLab API. Your code and history are kept. Requires the Owner role."
    : isBitbucket
      ? "Bitbucket has no API for this — detach on bitbucket.org under Repository settings → Repository details → Manage repository → Detach fork. A one-time action that cannot be undone. Existing pull requests to the parent stay viewable; new ones can't be created."
      : "Permanently detaches this repository from its fork network on GitHub — this cannot be undone. GitHub requires the fork be public, under 1 GB, and have no child forks. Your code and history are kept; issues, PRs, stars, and watchers are lost.";

  return (
    <>
      <div className="border-t" />
      <Row title="Leave fork network" desc={desc}>
        {/* Stacked so the description keeps its width — two side-by-side
            buttons squeezed the copy into a tall, narrow column. */}
        <div className="flex shrink-0 flex-col gap-2">
          {isGitLab ? (
            confirming ? (
              <InlineConfirm
                actLabel="Remove"
                pending={removeFork.isPending}
                onCancel={() => setConfirming(false)}
                onAct={() =>
                  removeFork.mutate(undefined, {
                    onSuccess: () => {
                      toast.success("Fork relationship removed");
                      setConfirming(false);
                      // Re-probe to flip the persisted badge; the row unmounts
                      // itself once `isFork` reads false.
                      reprobe();
                    },
                    onError: toastError,
                  })
                }
              />
            ) : (
              <DangerButton
                variant="destructive"
                disabled={!isOwner}
                hint={isOwner ? undefined : OWNER_HINT}
                onClick={() => setConfirming(true)}
              >
                Remove fork relationship
              </DangerButton>
            )
          ) : isBitbucket ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => openUrl(`https://${bbHost}/${fullName}/admin`)}
            >
              Detach on Bitbucket…
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => openUrl(`https://${ghHost}/${fullName}/settings`)}
            >
              Leave on GitHub…
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={rechecking}
            onClick={recheck}
          >
            {rechecking && <Spinner data-icon="inline-start" />}
            Re-check fork status
          </Button>
        </div>
      </Row>
    </>
  );
}

const VISIBILITIES = ["public", "private", "internal"];
// Bitbucket only knows public/private — no "internal".
const BB_VISIBILITIES = ["public", "private"];

function VisibilityAction({
  repoPath,
  info,
  isGitLab,
  isBitbucket,
  isOwner,
}: {
  repoPath: string;
  info: DangerInfo;
  isGitLab: boolean;
  isBitbucket: boolean;
  isOwner: boolean;
}) {
  const setVisibility = useSetVisibility(repoPath);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(info.visibility || "public");
  const visibilities = isBitbucket ? BB_VISIBILITIES : VISIBILITIES;

  return (
    <Row
      title={
        isGitLab ? "Change project visibility" : "Change repository visibility"
      }
      desc={`Currently ${info.visibility || "unknown"}.`}
    >
      <DangerButton
        variant="outline"
        disabled={!isOwner}
        hint={isOwner ? undefined : OWNER_HINT}
        onClick={() => {
          setTarget(info.visibility || "public");
          setOpen(true);
        }}
      >
        Change visibility
      </DangerButton>
      <DangerDialog
        open={open}
        onOpenChange={setOpen}
        title="Change visibility"
        description={
          isGitLab
            ? "Making a project public exposes all code, issues, and history; making it private hides it from everyone without access and unlinks existing forks."
            : isBitbucket
              ? "Making a repository public exposes all code and history to anyone; making it private restricts it to people with access."
              : "Changing visibility erases this repo's stars and watchers. Making it public exposes all code and history; making it private detaches existing forks, unpublishes Pages, and disables push rulesets."
        }
        confirmPhrase={info.fullName}
        confirmLabel="Change visibility"
        disabled={target === info.visibility}
        pending={setVisibility.isPending}
        onConfirm={() =>
          setVisibility.mutate(target, {
            onSuccess: () => {
              toast.success(
                `${isGitLab ? "Project" : "Repository"} is now ${target}`,
              );
              setOpen(false);
            },
            onError: toastError,
          })
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="visibility-target" className="text-xs">
            New visibility
          </Label>
          <Select value={target} onValueChange={(v) => v && setTarget(v)}>
            <SelectTrigger id="visibility-target" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibilities.map((v) => (
                <SelectItem key={v} value={v} className="capitalize">
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isBitbucket && (
            <p className="text-[11px] text-muted-foreground">
              {isGitLab
                ? "“Internal” is limited to self-managed GitLab (gitlab.com disallows it for new projects)."
                : "“Internal” requires the organization to belong to an enterprise."}
            </p>
          )}
        </div>
      </DangerDialog>
    </Row>
  );
}

function TransferAction({
  repoPath,
  info,
  isGitLab,
  isBitbucket,
  isOwner,
}: {
  repoPath: string;
  info: DangerInfo;
  isGitLab: boolean;
  isBitbucket: boolean;
  isOwner: boolean;
}) {
  const transfer = useTransferRepo(repoPath);
  const [open, setOpen] = useState(false);
  const [newOwner, setNewOwner] = useState("");

  // Bitbucket's REST API can't transfer a repo — send the user to the web
  // admin page instead of offering a form that would only error.
  if (isBitbucket) {
    return (
      <Row
        title="Transfer ownership"
        desc="Bitbucket transfers happen on the web."
      >
        <DangerButton
          variant="outline"
          disabled={!isOwner || !info.webUrl}
          hint={isOwner ? undefined : OWNER_HINT}
          onClick={() => info.webUrl && openUrl(`${info.webUrl}/admin`)}
        >
          Transfer on Bitbucket…
        </DangerButton>
      </Row>
    );
  }

  return (
    <Row
      title="Transfer ownership"
      desc={
        isGitLab
          ? "Move this project to another group or user namespace."
          : "Move this repository to another user or organization."
      }
    >
      <DangerButton
        variant="outline"
        disabled={!isOwner}
        hint={isOwner ? undefined : OWNER_HINT}
        onClick={() => setOpen(true)}
      >
        Transfer
      </DangerButton>
      <DangerDialog
        open={open}
        onOpenChange={setOpen}
        title={isGitLab ? "Transfer project" : "Transfer repository"}
        description={
          isGitLab
            ? "Transferring moves the project (and its issues, merge requests, and settings) to the new namespace — a group you own or maintain. The project URL changes; old paths redirect."
            : "Transferring moves the repo (and its issues, PRs, stars, and settings) to the new owner. Transferring to a personal account requires them to accept; you'll lose admin access here."
        }
        confirmPhrase={info.fullName}
        confirmLabel="Transfer"
        disabled={!newOwner.trim()}
        pending={transfer.isPending}
        onConfirm={() =>
          transfer.mutate(
            { newOwner: newOwner.trim(), newName: null },
            {
              onSuccess: () => {
                toast.success(
                  isGitLab ? "Project transferred" : "Transfer requested",
                );
                setOpen(false);
              },
              onError: toastError,
            },
          )
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="transfer-owner" className="text-xs">
            {isGitLab
              ? "New namespace (group path or username)"
              : "New owner (user or organization)"}
          </Label>
          <Input
            id="transfer-owner"
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
            placeholder={
              isGitLab ? "group/subgroup or username" : "username-or-org"
            }
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </DangerDialog>
    </Row>
  );
}

function DeleteAction({
  repoPath,
  info,
  isGitLab,
  isBitbucket,
  isOwner,
  onRepoDeleted,
}: {
  repoPath: string;
  info: DangerInfo;
  isGitLab: boolean;
  isBitbucket: boolean;
  isOwner: boolean;
  onRepoDeleted: () => void;
}) {
  const del = useDeleteRepo(repoPath);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const noun = isGitLab ? "project" : "repository";
  const providerName = isGitLab
    ? "GitLab"
    : isBitbucket
      ? "Bitbucket"
      : "GitHub";

  return (
    <Row
      title={`Delete this ${noun}`}
      desc={`Permanently remove the ${noun} on ${providerName}.`}
    >
      <DangerButton
        variant="destructive"
        disabled={!isOwner}
        hint={isOwner ? undefined : OWNER_HINT}
        onClick={() => setOpen(true)}
      >
        Delete
      </DangerButton>
      <DangerDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${noun}`}
        description={
          isGitLab
            ? "This permanently deletes the GitLab project — its issues, merge requests, wiki, releases, and settings. gitlab.com may delay the deletion briefly (the project is scheduled for removal). Your local clone and its files are kept; the dangling 'origin' remote is removed so you can publish the repo again."
            : isBitbucket
              ? "This immediately and permanently deletes the Bitbucket repository — its pull requests, pipelines, and settings. Your local clone and its files are kept; the dangling 'origin' remote is removed so you can publish the repo again. This cannot be undone."
              : "This permanently deletes the GitHub repository — its issues, pull requests, wiki, releases, and settings. Your local clone and its files are kept; the dangling 'origin' remote is removed so you can publish the repo again. This cannot be undone."
        }
        confirmPhrase={info.fullName}
        confirmLabel="Delete forever"
        pending={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              toast.success(
                `${isGitLab ? "Project" : "Repository"} deleted on ${providerName}`,
              );
              setOpen(false);
              // The remote is gone — re-probe the repo's hosted panels so they
              // stop showing stale data, and close the settings dialog (it only
              // offers actions against a repo that no longer exists).
              queryClient.invalidateQueries({ queryKey: ["repo", repoPath] });
              onRepoDeleted();
            },
            onError: toastError,
          })
        }
      >
        {!isGitLab && !isBitbucket && (
          <ScopeRefreshHint
            scope="delete_repo"
            action="Deleting a repository"
          />
        )}
      </DangerDialog>
    </Row>
  );
}

/** Destructive lifecycle actions, at the bottom of the settings rail. Works for
 *  both providers: the mutations dispatch behind the abstraction, and GitLab's
 *  Owner-only actions (archive / visibility / transfer / delete) disable with
 *  an explanation for Maintainers. */
export function DangerZone({
  repoPath,
  open,
  provider,
  onRepoDeleted,
}: {
  repoPath: string;
  open: boolean;
  provider: "github" | "gitlab" | "bitbucket";
  /** Called after the remote repo is deleted — the dialog closes itself. */
  onRepoDeleted: () => void;
}) {
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  const isGitHub = !isGitLab && !isBitbucket;
  const gh = useRepoSettings(repoPath, open && isGitHub);
  const gl = useGlRepoSettings(repoPath, open && isGitLab);
  const bb = useBbRepoSettings(repoPath, open && isBitbucket);
  // Owner gating (GitLab / Bitbucket): the same probe the menu item used, so
  // it's cached. GitHub admin implies owner, so it doesn't need the probe.
  const admin = useRepoAdmin(repoPath, open && (isGitLab || isBitbucket));

  const info: DangerInfo | null = isGitLab
    ? gl.data
      ? {
          fullName: gl.data.fullName,
          currentName: gl.data.path,
          archived: gl.data.archived,
          visibility: gl.data.visibility,
          webUrl: "",
        }
      : null
    : isBitbucket
      ? bb.data
        ? {
            fullName: bb.data.fullName,
            currentName: bb.data.slug,
            archived: false,
            visibility: bb.data.isPrivate ? "private" : "public",
            webUrl: bb.data.webUrl,
          }
        : null
      : gh.data
        ? {
            fullName: gh.data.fullName,
            currentName: gh.data.fullName.split("/").pop() ?? "",
            archived: gh.data.archived,
            visibility: gh.data.visibility,
            webUrl: "",
          }
        : null;
  if (!info) return null;
  // GitHub admin implies owner; GitLab and Bitbucket both gate the owner-only
  // lifecycle powers on the probe's `admin` flag (owner == admin for Bitbucket).
  const isOwner =
    isGitHub || (isBitbucket ? admin.data?.admin : admin.data?.owner) || false;

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 p-3">
      <h3 className="text-xs font-semibold text-destructive">Danger zone</h3>
      <RenameAction
        repoPath={repoPath}
        info={info}
        isGitLab={isGitLab}
        isBitbucket={isBitbucket}
      />
      {/* Local detach — any provider, whenever an `upstream` remote exists. */}
      <RemoveUpstreamAction repoPath={repoPath} />
      {/* Leave-fork-network — every provider, gated on persisted fork
          provenance. The row itself branches three ways: an in-app,
          Owner-gated detach on GitLab (real API), and a link-out on GitHub
          (…/settings) and Bitbucket (…/admin), neither of which has a detach
          API. Independent of the upstream-remote gate: a detached fork may
          still have the remote; a remote-less fork may still be in the network. */}
      <LeaveForkNetworkAction
        repoPath={repoPath}
        fullName={info.fullName}
        provider={provider}
        isOwner={isOwner}
      />
      {/* Bitbucket can't archive over the API — hide the row (platform limit). */}
      {!isBitbucket && (
        <>
          <div className="border-t" />
          <ArchiveAction
            repoPath={repoPath}
            info={info}
            isGitLab={isGitLab}
            isOwner={isOwner}
          />
        </>
      )}
      <div className="border-t" />
      <VisibilityAction
        repoPath={repoPath}
        info={info}
        isGitLab={isGitLab}
        isBitbucket={isBitbucket}
        isOwner={isOwner}
      />
      <div className="border-t" />
      <TransferAction
        repoPath={repoPath}
        info={info}
        isGitLab={isGitLab}
        isBitbucket={isBitbucket}
        isOwner={isOwner}
      />
      <div className="border-t" />
      <DeleteAction
        repoPath={repoPath}
        info={info}
        isGitLab={isGitLab}
        isBitbucket={isBitbucket}
        isOwner={isOwner}
        onRepoDeleted={onRepoDeleted}
      />
    </div>
  );
}
