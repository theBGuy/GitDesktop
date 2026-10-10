import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ComponentProps, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
  invalidateRepoAfterWrite,
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
import { clearRepoLensCache } from "@/lib/repo-lens/queries";
import { deleteRepoLens } from "@/lib/repo-lens/store";
import { settingsKeys, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useOnline } from "@/lib/use-online";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import {
  ACT_PENDING_REASON,
  InlineConfirm,
  OFFLINE_WRITE_REASON,
  useConfirmSwapFocus,
} from "./parts";
import { reseedRename } from "./rename-seed";
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
  disabledReason,
  heldReason,
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
  /** Why the caller's own fields hold the confirm (no target picked, say); a
   *  hold is only ever given as a reason, so the confirm never drops focus. */
  disabledReason?: string;
  /** Why the confirm is held whatever is typed, as its hover text and
   *  accessible description; unset leaves it to the phrase, `disabledReason`,
   *  and `pending`. */
  heldReason?: string;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useSeedOnOpen(open, () => setTyped(""));

  const matches = typed.trim() === confirmPhrase;
  const confirmHeldReason =
    heldReason ??
    (pending ? ACT_PENDING_REASON : undefined) ??
    disabledReason ??
    (matches ? undefined : `Type ${confirmPhrase} to confirm`);

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
          <DisabledReasonButton
            variant="destructive"
            disabled={confirmHeldReason !== undefined}
            reason={confirmHeldReason}
            onClick={onConfirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </DisabledReasonButton>
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

/** Every per-provider string in the danger zone, grouped by the action that
 *  shows it, so one provider's whole voice is read and edited in one place.
 *  Two groups are unreachable for Bitbucket — the transfer dialog (its row
 *  links out first) and the "Internal" note (hidden for Bitbucket) — and carry
 *  what the GitHub arm produced for it. */
const DANGER_COPY: Record<
  ForgeProvider,
  {
    rename: {
      desc: string;
      toast: (name: string) => string;
      /** Why Rename is held on a name the provider would reject. */
      invalid: string;
    };
    forkDesc: string;
    visibility: {
      dialogDesc: string;
      toast: (target: string) => string;
      internalNote: string;
    };
    transfer: {
      desc: string;
      dialogTitle: string;
      dialogDesc: string;
      toast: string;
      ownerLabel: string;
      ownerPlaceholder: string;
      /** Why Transfer is held with no destination typed. */
      ownerMissing: string;
    };
    delete: { dialogDesc: string; toast: string };
  }
> = {
  github: {
    rename: {
      desc: "Old links and clones keep working.",
      toast: (name) => `Renamed to ${name} — links redirect`,
      invalid: "Use only letters, digits, '.', '-', and '_'",
    },
    forkDesc:
      "Permanently detaches this repository from its fork network on GitHub — this cannot be undone. GitHub requires the fork be public, under 1 GB, and have no child forks. Your code and history are kept; issues, PRs, stars, and watchers are lost.",
    visibility: {
      dialogDesc:
        "Changing visibility erases this repo's stars and watchers. Making it public exposes all code and history; making it private detaches existing forks, unpublishes Pages, and disables push rulesets.",
      toast: (target) => `Repository is now ${target}`,
      internalNote:
        "“Internal” requires the organization to belong to an enterprise.",
    },
    transfer: {
      desc: "Move this repository to another user or organization.",
      dialogTitle: "Transfer repository",
      dialogDesc:
        "Transferring moves the repo (and its issues, PRs, stars, and settings) to the new owner. Transferring to a personal account requires them to accept; you'll lose admin access here.",
      toast: "Transfer requested",
      ownerLabel: "New owner (user or organization)",
      ownerPlaceholder: "username-or-org",
      ownerMissing: "Enter the new owner",
    },
    delete: {
      dialogDesc:
        "This permanently deletes the GitHub repository — its issues, pull requests, wiki, releases, and settings. Your local clone and its files are kept; the dangling 'origin' remote is removed so you can publish the repo again. This cannot be undone.",
      toast: "Repository deleted on GitHub",
    },
  },
  gitlab: {
    rename: {
      desc: "Renaming changes the name and path; GitDesktop will update your local 'origin' remote automatically.",
      toast: (name) => `Renamed to ${name} — origin remote updated`,
      invalid:
        "Start with a letter or digit, then use only letters, digits, '.', '-', and '_'",
    },
    forkDesc:
      "Removes the fork relationship on GitLab. Open merge requests to the parent are closed — they stay closed even if the relationship is later re-established via the GitLab API. Your code and history are kept. Requires the Owner role.",
    visibility: {
      dialogDesc:
        "Making a project public exposes all code, issues, and history; making it private hides it from everyone without access and unlinks existing forks.",
      toast: (target) => `Project is now ${target}`,
      internalNote:
        "“Internal” is limited to self-managed GitLab (gitlab.com disallows it for new projects).",
    },
    transfer: {
      desc: "Move this project to another group or user namespace.",
      dialogTitle: "Transfer project",
      dialogDesc:
        "Transferring moves the project (and its issues, merge requests, and settings) to the new namespace — a group you own or maintain. The project URL changes; GitDesktop will update your local 'origin' remote automatically.",
      toast: "Project transferred — origin remote updated",
      ownerLabel: "New namespace (group path or username)",
      ownerPlaceholder: "group/subgroup or username",
      ownerMissing: "Enter the new namespace",
    },
    delete: {
      dialogDesc:
        "This permanently deletes the GitLab project — its issues, merge requests, wiki, releases, and settings. gitlab.com may delay the deletion briefly (the project is scheduled for removal). Your local clone and its files are kept; the dangling 'origin' remote is removed so you can publish the repo again.",
      toast: "Project deleted on GitLab",
    },
  },
  bitbucket: {
    rename: {
      desc: "Renaming changes the repository URL; GitDesktop will update your local 'origin' remote automatically.",
      toast: (name) => `Renamed to ${name} — origin remote updated`,
      invalid: "Use only letters, digits, '.', '-', and '_'",
    },
    forkDesc:
      "Bitbucket has no API for this — detach on bitbucket.org under Repository settings → Repository details → Manage repository → Detach fork. A one-time action that cannot be undone. Existing pull requests to the parent stay viewable; new ones can't be created.",
    visibility: {
      dialogDesc:
        "Making a repository public exposes all code and history to anyone; making it private restricts it to people with access.",
      toast: (target) => `Repository is now ${target}`,
      internalNote:
        "“Internal” requires the organization to belong to an enterprise.",
    },
    transfer: {
      desc: "Move this repository to another user or organization.",
      dialogTitle: "Transfer repository",
      dialogDesc:
        "Transferring moves the repo (and its issues, PRs, stars, and settings) to the new owner. Transferring to a personal account requires them to accept; you'll lose admin access here.",
      toast: "Transfer requested",
      ownerLabel: "New owner (user or organization)",
      ownerPlaceholder: "username-or-org",
      ownerMissing: "Enter the new owner",
    },
    delete: {
      dialogDesc:
        "This immediately and permanently deletes the Bitbucket repository — its pull requests, pipelines, and settings. Your local clone and its files are kept; the dangling 'origin' remote is removed so you can publish the repo again. This cannot be undone.",
      toast: "Repository deleted on Bitbucket",
    },
  },
};

/** A danger-zone trigger whose disabled state still explains itself. `className`
 *  stays the row's layout hook (it lands on the wrapper, as it always has). */
function DangerButton({
  hint,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "className"> & {
  hint?: string;
  className?: string;
}) {
  return (
    <DisabledReasonButton
      size="sm"
      reason={hint}
      wrapperClassName={className}
      {...props}
    />
  );
}

function RenameAction({
  repoPath,
  info,
  provider,
}: {
  repoPath: string;
  info: DangerInfo;
  provider: ForgeProvider;
}) {
  const rename = useRenameRepo(repoPath);
  const online = useOnline();
  const current = info.currentName;
  const [name, setName] = useState(current);
  // Reseeded in render per `reseedRename`, never by a remount, which would drop
  // focus from the field or the button.
  const [seededName, setSeededName] = useState(current);
  const [sentName, setSentName] = useState<string | null>(null);
  const reseed = reseedRename(
    { name, seeded: seededName, sent: sentName },
    current,
  );
  if (reseed !== null) {
    setName(reseed.name);
    setSeededName(reseed.seeded);
    setSentName(reseed.sent);
  }
  const isGitLab = provider === "gitlab";
  const copy = DANGER_COPY[provider].rename;
  // GitLab paths must start alphanumeric; GitHub/Bitbucket allow a leading
  // `.`/`_`/`-` (".github" is a standard repo name) — the check branches so
  // they keep their fuller grammar.
  const valid = isGitLab
    ? /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim())
    : /^[A-Za-z0-9._-]+$/.test(name.trim());
  const changed = name.trim() !== current;
  // Every hold carries a reason, so Rename keeps focus through the write and the
  // refetch that brings the new name back.
  const renameHeldReason = (() => {
    switch (true) {
      case !online:
        return OFFLINE_WRITE_REASON;
      case rename.isPending:
        return ACT_PENDING_REASON;
      case !name.trim():
        return "Enter a new name";
      case !valid:
        return copy.invalid;
      case !changed:
        return "Enter a new name";
      default:
        return undefined;
    }
  })();

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user. The sent name is recorded before
  // the await: the refetch can land the new name before the call resolves.
  async function handleRename() {
    const next = name.trim();
    setSentName(next);
    try {
      await rename.mutateAsync(next);
      toast.success(copy.toast(next));
    } catch (e) {
      setSentName(null);
      toastError(e);
    }
  }

  return (
    <Row
      title={isGitLab ? "Rename project" : "Rename repository"}
      desc={copy.desc}
    >
      <div className="flex shrink-0 items-center gap-2">
        <Input
          data-confirm-fallback
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-44 font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled={renameHeldReason !== undefined}
          reason={renameHeldReason}
          onClick={handleRename}
        >
          {rename.isPending && <Spinner data-icon="inline-start" />}
          Rename
        </DisabledReasonButton>
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
  const online = useOnline();
  const [confirming, setConfirming] = useState(false);
  const swapFocus = useConfirmSwapFocus();
  const archived = info.archived;
  // Sentence-cased for toasts, lowercase mid-sentence — GitHub copy unchanged.
  const noun = isGitLab ? "project" : "repository";
  const nounCap = isGitLab ? "Project" : "Repository";

  async function handleArchive() {
    try {
      await setArchived.mutateAsync(!archived);
      toast.success(archived ? `${nounCap} unarchived` : `${nounCap} archived`);
      setConfirming(false);
    } catch (e) {
      toastError(e);
    }
  }

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
            heldReason={online ? undefined : OFFLINE_WRITE_REASON}
            swapFocusRef={swapFocus()}
            onCancel={() => setConfirming(false)}
            onAct={handleArchive}
          />
        </div>
      ) : (
        <DangerButton
          ref={swapFocus()}
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
  const queryClient = useQueryClient();
  const remotes = useRemotes(repoPath);
  const removeRemote = useRemoveRemote(repoPath);
  const [confirming, setConfirming] = useState(false);
  const swapFocus = useConfirmSwapFocus();

  async function handleRemoveUpstream() {
    try {
      await removeRemote.mutateAsync({ name: "upstream" });
      // Hygiene: the persisted "upstream" lens no longer applies.
      // Fire-and-forget — the lens read safe-defaults to origin,
      // so a failure here is harmless. The CACHED lens drops with
      // it: its key sits outside the repo subtree this mutation
      // invalidates, so re-adding upstream in the same session
      // would otherwise resurrect the preference just deleted.
      deleteRepoLens(repoPath).catch(() => undefined);
      clearRepoLensCache(queryClient, repoPath);
      // Removing upstream collapses the lens to origin, so a still-
      // selected remote number would resolve against the other repo:
      // the same non-bumping prune a lens flip runs, and only while
      // this repo is the open one (the selections are global).
      const ui = useUiStore.getState();
      if (ui.repoPath === repoPath) ui.clearRemoteSelections();
      toast.success("Upstream remote removed");
      setConfirming(false);
    } catch (e) {
      toastError(e);
    }
  }

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
              swapFocusRef={swapFocus()}
              onCancel={() => setConfirming(false)}
              onAct={handleRemoveUpstream}
            />
          </div>
        ) : (
          <DangerButton
            ref={swapFocus()}
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
  const online = useOnline();
  const [rechecking, setRechecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const swapFocus = useConfirmSwapFocus();
  const record = settings.data?.recentRepos.find((r) => r.path === repoPath);

  if (record?.isFork !== true) return null;

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

  const handleRemoveFork = async () => {
    try {
      await removeFork.mutateAsync(undefined);
      toast.success("Fork relationship removed");
      setConfirming(false);
      // Re-probe to flip the persisted badge; the row unmounts
      // itself once `isFork` reads false.
      reprobe();
    } catch (e) {
      toastError(e);
    }
  };

  // The provider's own way out of the network: GitLab detaches in-app behind an
  // inline confirm, the others link out to the page that owns the action.
  const forkAction: Record<ForgeProvider, () => ReactNode> = {
    github: () => (
      <Button
        variant="destructive"
        size="sm"
        onClick={() => openUrl(`https://${ghHost}/${fullName}/settings`)}
      >
        Leave on GitHub…
      </Button>
    ),
    gitlab: () =>
      confirming ? (
        // The stacked column stretches the act button's wrapper span, but not
        // the button inside it — the confirm takes its own row, like Archive's.
        <div className="flex items-center gap-2">
          <InlineConfirm
            actLabel="Remove"
            pending={removeFork.isPending}
            heldReason={online ? undefined : OFFLINE_WRITE_REASON}
            swapFocusRef={swapFocus()}
            onCancel={() => setConfirming(false)}
            onAct={handleRemoveFork}
          />
        </div>
      ) : (
        <DangerButton
          ref={swapFocus()}
          variant="destructive"
          disabled={!isOwner}
          hint={isOwner ? undefined : OWNER_HINT}
          onClick={() => setConfirming(true)}
        >
          Remove fork relationship
        </DangerButton>
      ),
    bitbucket: () => (
      <Button
        variant="destructive"
        size="sm"
        onClick={() => openUrl(`https://${bbHost}/${fullName}/admin`)}
      >
        Detach on Bitbucket…
      </Button>
    ),
  };

  return (
    <>
      <div className="border-t" />
      <Row title="Leave fork network" desc={DANGER_COPY[provider].forkDesc}>
        {/* Stacked so the description keeps its width — two side-by-side
            buttons squeezed the copy into a tall, narrow column. */}
        <div className="flex shrink-0 flex-col gap-2">
          {forkAction[provider]()}
          {/* No offline rung: a read probe that fails loudly, never a parked
              write. `w-full` keeps the button spanning the stacked column. */}
          <DisabledReasonButton
            variant="outline"
            size="sm"
            className="w-full"
            disabled={rechecking}
            reason={rechecking ? "Checking fork status…" : undefined}
            onClick={recheck}
          >
            {rechecking && <Spinner data-icon="inline-start" />}
            Re-check fork status
          </DisabledReasonButton>
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
  provider,
  isOwner,
}: {
  repoPath: string;
  info: DangerInfo;
  provider: ForgeProvider;
  isOwner: boolean;
}) {
  const setVisibility = useSetVisibility(repoPath);
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(info.visibility || "public");
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  const copy = DANGER_COPY[provider].visibility;
  const visibilities = isBitbucket ? BB_VISIBILITIES : VISIBILITIES;

  async function handleChangeVisibility() {
    try {
      await setVisibility.mutateAsync(target);
      toast.success(copy.toast(target));
      setOpen(false);
    } catch (e) {
      toastError(e);
    }
  }

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
        description={copy.dialogDesc}
        confirmPhrase={info.fullName}
        confirmLabel="Change visibility"
        disabledReason={
          target === info.visibility ? "Pick a different visibility" : undefined
        }
        heldReason={online ? undefined : OFFLINE_WRITE_REASON}
        pending={setVisibility.isPending}
        onConfirm={handleChangeVisibility}
      >
        <div className="space-y-1.5">
          <Label htmlFor="visibility-target" className="text-xs">
            New visibility
          </Label>
          <Select value={target} onValueChange={(v) => v && setTarget(v)}>
            <SelectTrigger id="visibility-target" className="w-40">
              <SelectValue className="capitalize" />
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
              {copy.internalNote}
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
  provider,
  isOwner,
}: {
  repoPath: string;
  info: DangerInfo;
  provider: ForgeProvider;
  isOwner: boolean;
}) {
  const transfer = useTransferRepo(repoPath);
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const copy = DANGER_COPY[provider].transfer;

  async function handleTransfer() {
    try {
      await transfer.mutateAsync({ newOwner: newOwner.trim(), newName: null });
      toast.success(copy.toast);
      setOpen(false);
    } catch (e) {
      toastError(e);
    }
  }

  // Bitbucket's REST API can't transfer a repo — send the user to the web
  // admin page instead of offering a form that would only error.
  if (provider === "bitbucket") {
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
    <Row title="Transfer ownership" desc={copy.desc}>
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
        title={copy.dialogTitle}
        description={copy.dialogDesc}
        confirmPhrase={info.fullName}
        confirmLabel="Transfer"
        disabledReason={newOwner.trim() ? undefined : copy.ownerMissing}
        heldReason={online ? undefined : OFFLINE_WRITE_REASON}
        pending={transfer.isPending}
        onConfirm={handleTransfer}
      >
        <div className="space-y-1.5">
          <Label htmlFor="transfer-owner" className="text-xs">
            {copy.ownerLabel}
          </Label>
          <Input
            id="transfer-owner"
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
            placeholder={copy.ownerPlaceholder}
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
  provider,
  isOwner,
  onRepoDeleted,
}: {
  repoPath: string;
  info: DangerInfo;
  provider: ForgeProvider;
  isOwner: boolean;
  onRepoDeleted: () => void;
}) {
  const del = useDeleteRepo(repoPath);
  const online = useOnline();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  const copy = DANGER_COPY[provider].delete;
  const noun = isGitLab ? "project" : "repository";

  async function handleDelete() {
    try {
      await del.mutateAsync(undefined);
      toast.success(copy.toast);
      setOpen(false);
      // The remote is gone — re-probe the repo's hosted panels so they
      // stop showing stale data, and close the settings dialog (it only
      // offers actions against a repo that no longer exists).
      void invalidateRepoAfterWrite(queryClient, repoPath);
      onRepoDeleted();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <Row
      title={`Delete this ${noun}`}
      desc={`Permanently remove the ${noun} on ${providerLabel(provider)}.`}
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
        description={copy.dialogDesc}
        confirmPhrase={info.fullName}
        confirmLabel="Delete forever"
        heldReason={online ? undefined : OFFLINE_WRITE_REASON}
        pending={del.isPending}
        onConfirm={handleDelete}
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

  // Each provider's settings read, normalized to the neutral shape; null until
  // the active provider's query has data.
  const infoFor: Record<ForgeProvider, () => DangerInfo | null> = {
    github: () =>
      gh.data
        ? {
            fullName: gh.data.fullName,
            currentName: gh.data.fullName.split("/").pop() ?? "",
            archived: gh.data.archived,
            visibility: gh.data.visibility,
            webUrl: "",
          }
        : null,
    gitlab: () =>
      gl.data
        ? {
            fullName: gl.data.fullName,
            currentName: gl.data.path,
            archived: gl.data.archived,
            visibility: gl.data.visibility,
            webUrl: "",
          }
        : null,
    bitbucket: () =>
      bb.data
        ? {
            fullName: bb.data.fullName,
            currentName: bb.data.slug,
            archived: false,
            visibility: bb.data.isPrivate ? "private" : "public",
            webUrl: bb.data.webUrl,
          }
        : null,
  };
  const info = infoFor[provider]();
  if (!info) return null;
  // GitHub admin implies owner; GitLab and Bitbucket both gate the owner-only
  // lifecycle powers on the probe's `admin` flag (owner == admin for Bitbucket).
  const isOwner =
    isGitHub || (isBitbucket ? admin.data?.admin : admin.data?.owner) || false;

  // The confirm-swap section: a row that removes itself (the upstream remote,
  // the fork relationship) hands focus to the rename field at its top.
  return (
    <div
      data-confirm-section
      className="space-y-3 rounded-md border border-destructive/40 p-3"
    >
      <h3 className="text-xs font-semibold text-destructive">Danger zone</h3>
      <RenameAction repoPath={repoPath} info={info} provider={provider} />
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
        provider={provider}
        isOwner={isOwner}
      />
      <div className="border-t" />
      <TransferAction
        repoPath={repoPath}
        info={info}
        provider={provider}
        isOwner={isOwner}
      />
      <div className="border-t" />
      <DeleteAction
        repoPath={repoPath}
        info={info}
        provider={provider}
        isOwner={isOwner}
        onRepoDeleted={onRepoDeleted}
      />
    </div>
  );
}
