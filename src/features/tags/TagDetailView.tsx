import {
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import {
  checkoutDetachedConfirm,
  checkoutTagSuccessToast,
} from "@/features/history/commit-confirms";
import { formatBytes } from "@/features/repository/insights/primitives";
import { presentError } from "@/lib/error-summary";
import { UPDATER_MANIFEST_NAME } from "@/lib/git/api";
import {
  forgeFeatureReady,
  useCheckoutCommit,
  useDeleteRelease,
  useDeleteReleaseAsset,
  useDeleteTag,
  useDownloadReleaseAsset,
  useEditRelease,
  useForgeStatus,
  usePushTag,
  useReleaseDetails,
  useReleaseList,
  useRepoWriteAccess,
  useSyncUpdaterNotes,
  useTagList,
  useUploadReleaseAsset,
  writeAccessReason,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn, PLACEHOLDER_FADE } from "@/lib/utils";
import { CreateReleaseDialog } from "./CreateReleaseDialog";

export function TagDetailView({
  repoPath,
  tag,
}: {
  repoPath: string;
  tag: string;
}) {
  const gh = useForgeStatus(repoPath);
  // Release reads are provider-neutral; a tag with no release stays just a tag.
  const ghReady = forgeFeatureReady(gh.data, "releases");
  // Release WRITES are SHARED controls: `canWrite || forgeFeatureReady` keeps
  // GitHub's buttons up while forge-status is pending and positively enables a
  // ready GitLab repo. GitLab has no draft/pre-release/latest concepts, so those
  // toggles hide there (`isGitLab`), and its assets stay link-style rows.
  const provider = gh.data?.provider;
  const isGitLab = provider === "gitlab";
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const canManage = canWrite || forgeFeatureReady(gh.data, "releaseEdit");
  const canCreate = canWrite || forgeFeatureReady(gh.data, "releaseCreate");
  // Publishing a release is a repo write: an explicitly read-only viewer keeps
  // the buttons (disabled, with the reason). Releases are repo-wide — no lens.
  const writeAccess = useRepoWriteAccess(repoPath, undefined, !!provider);
  const writeReason = writeAccessReason(writeAccess.data);
  const writeBlocked = writeAccess.data?.canPush === false;
  const remoteLabel = providerLabel(provider);
  // Release notes autolink the same `@`/`#`/`!` references a comment does.
  // Releases are repo-wide, so the candidate lists come off origin.
  const mentions = useMentionCandidates({ repoPath, lens: "origin", provider });
  // Ask the provider for a release only when connected; otherwise it's just a tag.
  const release = useReleaseDetails(repoPath, ghReady ? tag : null);
  const tagList = useTagList(repoPath);
  const releaseList = useReleaseList(repoPath, ghReady);
  const editRelease = useEditRelease(repoPath);
  const syncUpdaterNotes = useSyncUpdaterNotes(repoPath);
  const deleteRelease = useDeleteRelease(repoPath);
  const uploadAsset = useUploadReleaseAsset(repoPath);
  const deleteAsset = useDeleteReleaseAsset(repoPath);
  const downloadAsset = useDownloadReleaseAsset(repoPath);
  const pushTag = usePushTag(repoPath);
  const deleteTag = useDeleteTag(repoPath);
  const checkout = useCheckoutCommit(repoPath);
  const selectTag = useUiStore((s) => s.selectTag);

  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editPrerelease, setEditPrerelease] = useState(false);
  const [editLatest, setEditLatest] = useState(false);
  const [editSyncUpdater, setEditSyncUpdater] = useState(true);
  // The submitted decision, captured at submit. The live checkbox can't stand in for
  // it: phase 1's invalidation refetches the release mid-save, and a `latest.json`
  // that the clobber has momentarily deleted would flip the gate and drop the latch
  // while the upload is still running.
  const [syncArmed, setSyncArmed] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cleanupTag, setCleanupTag] = useState(false);
  const [createReleaseOpen, setCreateReleaseOpen] = useState(false);
  const [deleteTagOpen, setDeleteTagOpen] = useState(false);
  const [deleteTagRemote, setDeleteTagRemote] = useState(false);

  const onError = (e: unknown) => toastError(e);
  const rel = release.data;
  const tagInfo = tagList.data?.find((t) => t.name === tag);
  const isLatest =
    (releaseList.data ?? []).find((r) => r.tagName === tag)?.isLatest ?? false;
  // A tag switch keeps the PREVIOUS tag's release painted (the query's placeholder
  // frees the tag key axis), so every release write holds until the two agree —
  // this is the only gate that covers it: with placeholder data present the query
  // reads as success (never `isLoading`), and a disabled query still serves it.
  const relStale = release.isPlaceholderData;
  const staleDim = relStale && "opacity-80";
  // Why the rendered release can't be acted on at all — it gates DOWNLOAD too,
  // which a read-only viewer is otherwise free to use. Not-ready outranks stale
  // and never resolves on its own: a not-ready forge disables the query, which
  // goes on serving placeholder data, so "loading" would be a wait with no end.
  // Wording mirrors TagsPanel's release affordance.
  const readReason = (() => {
    switch (true) {
      case !ghReady:
        return isGitLab
          ? "Sign in with the GitLab CLI (glab) to manage this release."
          : "Connect this repository to GitHub or GitLab to manage this release.";
      case relStale:
        return "Loading this tag's release…";
      default:
        return null;
    }
  })();
  // Writes take the read-only viewer's reason ahead of those: theirs never lifts
  // either, and it's the one that still applies once the release is current.
  const blockReason = writeBlocked ? writeReason : readReason;

  if (release.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  async function onUpload() {
    const file = await openDialog({ multiple: false });
    if (typeof file !== "string") return;
    uploadAsset.mutate(
      { tag, filePath: file },
      { onSuccess: () => toast.success("Asset uploaded"), onError },
    );
  }

  async function onDownload(assetName: string) {
    // Fresh `tag`, placeholder-derived name: two releases sharing an asset name
    // would silently fetch the wrong file.
    if (relStale) return;
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    downloadAsset.mutate(
      { tag, assetName, dir },
      { onSuccess: () => toast.success(`Downloaded ${assetName}`), onError },
    );
  }

  // Shared by both provider arms, which differ in what is actually lost: GitHub's
  // uploaded binary is gone for good, while a GitLab asset link can be re-added.
  async function onDeleteAsset(assetName: string, kind: "asset" | "link") {
    // The name comes off the rendered release, which is the previous tag's
    // during a switch — refuse before the confirm can name the wrong asset.
    if (relStale) return;
    const ok = await useConfirm.getState().ask({
      title: `Delete ${assetName}?`,
      body:
        kind === "asset"
          ? "Removes this asset from the release. This cannot be undone."
          : "Removes this link from the release.",
      confirmLabel: "Delete",
      confirmVariant: "destructive",
    });
    if (!ok) return;
    deleteAsset.mutate(
      { tag, assetName },
      { onSuccess: () => toast.success("Asset deleted"), onError },
    );
  }

  // Checking out a tag detaches HEAD exactly as checking out its commit does, so
  // it asks the History surface's question with the tag's name in it. The target
  // sha is read before the prompt, so a tag list refetched under the open dialog
  // can't redirect the checkout the user confirmed.
  async function onCheckout() {
    const target = tagInfo?.target;
    if (!target) return;
    const ok = await useConfirm
      .getState()
      .ask(checkoutDetachedConfirm("tag", tag));
    if (!ok) return;
    checkout.mutate(target, {
      onSuccess: () => toast.success(checkoutTagSuccessToast(tag)),
      onError,
    });
  }

  // ── Release view ───────────────────────────────────────────────────────────
  if (rel) {
    // The updater manifest is a GitHub-only Tauri asset, so the sync affordance only
    // makes sense on a release that actually ships one. Deliberately STRICTER than
    // the other release writes (`canManage` also opens on a ready GitLab repo):
    // there is no GitLab arm to fall back to here.
    const canSyncUpdater =
      canWrite && rel.assets.some((a) => a.name === UPDATER_MANIFEST_NAME);
    // An armed sync makes Save two-phase; dismissing between the phases would fire the
    // manifest upload at a closed dialog, so the whole operation latches. A plain edit
    // (nothing armed) stays dismissible exactly as it always was.
    const savePending = editRelease.isPending || syncUpdaterNotes.isPending;
    const saveLatched = syncArmed && savePending;
    return (
      <div className="flex h-full flex-col" aria-busy={Boolean(staleDim)}>
        <header className="space-y-2 border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <h2
              className={cn("text-sm font-medium", PLACEHOLDER_FADE, staleDim)}
            >
              {rel.name || rel.tagName}
            </h2>
            <span className="flex-1" />
            {/* Publish only ever shows on GitHub (GitLab has no drafts). */}
            {canManage && (
              <>
                {rel.isDraft && (
                  <DisabledReasonButton
                    variant="outline"
                    size="xs"
                    disabled={editRelease.isPending || writeBlocked || relStale}
                    reason={blockReason}
                    onClick={() => {
                      // `prerelease` rides the rendered release's flag, so a stale
                      // one would really flip the new release's state on the forge.
                      if (relStale) return;
                      editRelease.mutate(
                        {
                          tag,
                          title: "",
                          notes: "",
                          prerelease: rel.isPrerelease,
                          draft: false,
                          // Omit --latest so GitHub applies its default (a newly
                          // published stable release becomes Latest, like the web UI).
                          // A draft's isLatest is structurally false — sending it here
                          // was the bug that stripped Latest on publish.
                          latest: undefined,
                        },
                        {
                          onSuccess: () => toast.success("Published"),
                          onError,
                        },
                      );
                    }}
                  >
                    Publish
                  </DisabledReasonButton>
                )}
                <DisabledReasonButton
                  variant="outline"
                  size="xs"
                  disabled={writeBlocked || relStale}
                  reason={blockReason}
                  onClick={() => {
                    // The seed outlives the stale window — a dialog opened here
                    // would still save the previous release's text once it closes.
                    if (relStale) return;
                    setEditTitle(rel.name);
                    setEditNotes(rel.body);
                    setEditPrerelease(rel.isPrerelease);
                    setEditLatest(isLatest);
                    setEditSyncUpdater(true);
                    setSyncArmed(false);
                    setEditOpen(true);
                  }}
                >
                  Edit
                </DisabledReasonButton>
                <DisabledReasonButton
                  variant="outline"
                  size="xs"
                  disabled={writeBlocked || relStale}
                  reason={blockReason}
                  onClick={() => {
                    setCleanupTag(false);
                    setDeleteOpen(true);
                  }}
                >
                  Delete
                </DisabledReasonButton>
              </>
            )}
            {rel.url && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => openUrl(rel.url)}
                className="cursor-pointer"
              >
                <ArrowSquareOutIcon data-icon="inline-start" />
                {remoteLabel}
              </Button>
            )}
          </div>
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 text-xs text-muted-foreground",
              PLACEHOLDER_FADE,
              staleDim,
            )}
          >
            <span className="font-mono">{rel.tagName}</span>
            {isLatest && <Badge variant="default">Latest</Badge>}
            {rel.isPrerelease && <Badge variant="secondary">Pre-release</Badge>}
            {rel.isDraft && <Badge variant="secondary">Draft</Badge>}
            {rel.author && <span>• {rel.author}</span>}
            {parseableDate(rel.publishedAt) && (
              <span>
                • released <RelativeTime date={rel.publishedAt} />
              </span>
            )}
          </div>
        </header>
        {/* overflow-hidden contains the content's natural height (vendored Root is
            `relative`-only) so long release notes can't leak a window scrollbar. */}
        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          <div className={cn("space-y-4 p-4", PLACEHOLDER_FADE, staleDim)}>
            {rel.body.trim() ? (
              <Markdown>{rel.body}</Markdown>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No release notes.
              </p>
            )}

            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Assets ({rel.assets.length})
                </h3>
                <span className="flex-1" />
                {/* GitHub attaches a binary; GitLab uploads + links the file. */}
                {canManage && (
                  <DisabledReasonButton
                    variant="ghost"
                    size="xs"
                    disabled={uploadAsset.isPending || writeBlocked || relStale}
                    reason={blockReason}
                    onClick={onUpload}
                  >
                    {uploadAsset.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <UploadSimpleIcon data-icon="inline-start" />
                    )}
                    Upload
                  </DisabledReasonButton>
                )}
              </div>
              {rel.assets.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No assets attached.
                </p>
              ) : (
                rel.assets.map((a) => (
                  <div key={a.name} className="flex items-center gap-2 text-xs">
                    <span
                      className="min-w-0 flex-1 truncate font-mono"
                      title={a.name}
                    >
                      {a.name}
                    </span>
                    {canWrite ? (
                      <>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {formatBytes(a.size)} · {a.downloadCount} ↓
                        </span>
                        <DisabledReasonButton
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Download ${a.name}`}
                          disabled={relStale}
                          reason={readReason}
                          onClick={() => onDownload(a.name)}
                        >
                          <DownloadSimpleIcon />
                        </DisabledReasonButton>
                        <DisabledReasonButton
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Delete ${a.name}`}
                          disabled={
                            deleteAsset.isPending || writeBlocked || relStale
                          }
                          reason={blockReason}
                          className="text-muted-foreground"
                          onClick={() => onDeleteAsset(a.name, "asset")}
                        >
                          <TrashIcon />
                        </DisabledReasonButton>
                      </>
                    ) : (
                      // GitLab asset links carry no size/download count — open the
                      // link in the browser rather than show GitHub-style stats.
                      // Deleting the link is still offered once writes are ready.
                      <>
                        {a.url && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Open ${a.name}`}
                            className="cursor-pointer"
                            onClick={() => openUrl(a.url)}
                          >
                            <ArrowSquareOutIcon />
                          </Button>
                        )}
                        {canManage && (
                          <DisabledReasonButton
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Delete ${a.name}`}
                            disabled={
                              deleteAsset.isPending || writeBlocked || relStale
                            }
                            reason={blockReason}
                            className="text-muted-foreground"
                            onClick={() => onDeleteAsset(a.name, "link")}
                          >
                            <TrashIcon />
                          </DisabledReasonButton>
                        )}
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </ScrollArea>

        <Dialog
          open={editOpen}
          onOpenChange={(o) => {
            if (!saveLatched) setEditOpen(o);
          }}
        >
          {/* A fixed height (not a cap): release bodies routinely run thousands of
              lines, so the notes editor claims the dialog's whole spare height. */}
          <DialogContent className="flex h-[85vh] flex-col sm:max-w-2xl">
            <form
              className="flex min-h-0 flex-1 flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                // `draft`/`latest` below are read off the rendered release at
                // submit time, so a switch behind the open dialog holds the save.
                if (relStale) return;
                // Empty notes leave the body untouched (the edit skips `--notes`),
                // so there's nothing to carry into the manifest either.
                const syncManifest =
                  canSyncUpdater && editSyncUpdater && !!editNotes.trim();
                setSyncArmed(syncManifest);
                editRelease.mutate(
                  {
                    tag,
                    title: editTitle.trim(),
                    notes: editNotes,
                    prerelease: editPrerelease,
                    draft: rel.isDraft,
                    // Only round-trip Latest for published releases (real user intent
                    // on an eligible release). A draft can't be Latest, so omit the flag
                    // and let GitHub decide on publish.
                    latest: rel.isDraft ? undefined : editLatest,
                  },
                  {
                    onSuccess: () => {
                      if (!syncManifest) {
                        setSyncArmed(false);
                        toast.success("Release updated");
                        setEditOpen(false);
                        return;
                      }
                      // The body edit has already landed, so a manifest failure is
                      // partial state, not a failed save: close and disclose it —
                      // re-submitting would only repeat the edit.
                      syncUpdaterNotes.mutate(
                        { tag, notes: editNotes.trim() },
                        {
                          onSuccess: () => {
                            setSyncArmed(false);
                            toast.success("Release updated");
                            setEditOpen(false);
                          },
                          onError: (err) => {
                            setSyncArmed(false);
                            // Which stage failed decides what recovery is possible —
                            // only a failed upload leaves a parked copy — so the
                            // summary stays arm-neutral and the backend's own text
                            // (carried into Details by toastError) names the specifics.
                            toastError(
                              new Error(
                                `Release updated, but the updater manifest may not have been.\n\n${presentError(err).fullText}`,
                              ),
                            );
                            setEditOpen(false);
                          },
                        },
                      );
                    },
                    // The capture dies with the save it was taken for — phase 1
                    // failing means no phase 2 will ever consume it.
                    onError: (e) => {
                      setSyncArmed(false);
                      onError(e);
                    },
                  },
                );
              }}
            >
              <DialogHeader>
                <DialogTitle>Edit release</DialogTitle>
                <DialogDescription>
                  Updates {tag} on {remoteLabel}.
                </DialogDescription>
              </DialogHeader>
              {/* Fields scroll; header and submit footer stay pinned. */}
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Title"
                />
                <div className="flex flex-1 flex-col">
                  <MarkdownEditor
                    aria-label="Release notes"
                    value={editNotes}
                    onChange={setEditNotes}
                    placeholder="Notes…"
                    fill
                    // No `rows`/`resize-y` in fill mode: the explicit floor plus
                    // `flex-1` set the height, and a manual drag fights the flex
                    // sizing.
                    textareaClassName="min-h-24 font-mono"
                    mentions={mentions}
                  />
                </div>
                {/* GitLab has neither pre-release nor a per-release latest flag. */}
                {!isGitLab && (
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                      <Switch
                        checked={editPrerelease}
                        onCheckedChange={setEditPrerelease}
                      />
                      Pre-release
                    </label>
                    {/* Latest applies only to published releases — GitHub sets it on
                        publish and ignores it on a draft. Disable + explain in visible
                        helper text (a title on a disabled control never shows). */}
                    <div className="flex flex-col gap-1">
                      <label
                        className={`flex items-center gap-2 text-xs ${
                          rel.isDraft
                            ? "cursor-not-allowed opacity-60"
                            : "cursor-pointer"
                        }`}
                      >
                        <Switch
                          checked={rel.isDraft ? false : editLatest}
                          onCheckedChange={setEditLatest}
                          disabled={rel.isDraft}
                        />
                        Latest release
                      </label>
                      {rel.isDraft && (
                        <p className="text-muted-foreground text-[11px]">
                          GitHub sets Latest when the release is published —
                          this release will become Latest by default on publish.
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {canSyncUpdater && (
                  <div className="flex flex-col gap-1">
                    <label
                      className={`flex items-center gap-2 text-xs ${
                        savePending
                          ? "cursor-not-allowed opacity-60"
                          : "cursor-pointer"
                      }`}
                    >
                      {/* Frozen while saving: toggling mid-flight would misreport the
                          state of a save whose decision was already captured. */}
                      <Checkbox
                        checked={editSyncUpdater}
                        disabled={savePending}
                        onCheckedChange={(c) => setEditSyncUpdater(c === true)}
                      />
                      Also update the updater manifest (latest.json)
                    </label>
                    <p className="text-muted-foreground text-[11px]">
                      Keeps the notes installed apps see on update in sync with
                      this edit.
                    </p>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saveLatched}
                  onClick={() => setEditOpen(false)}
                >
                  Cancel
                </Button>
                {/* An in-flight save says so with the spinner, so only the
                    held arms carry a reason. */}
                <DisabledReasonButton
                  type="submit"
                  disabled={savePending || relStale}
                  reason={savePending ? null : blockReason}
                >
                  {savePending && <Spinner data-icon="inline-start" />}
                  Save
                </DisabledReasonButton>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent>
            <DialogHeader>
              {/* Labelled from the `tag` PROP, which is also what the delete
                  targets — the rendered release can be the previous tag's. */}
              <DialogTitle>Delete release {tag}?</DialogTitle>
              <DialogDescription>
                Removes the {remoteLabel} release. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={cleanupTag}
                onCheckedChange={(c) => setCleanupTag(c === true)}
              />
              Also delete the <span className="font-mono">{tag}</span> tag
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <DisabledReasonButton
                variant="destructive"
                disabled={deleteRelease.isPending || relStale}
                reason={blockReason}
                onClick={() =>
                  deleteRelease.mutate(
                    { tag, cleanupTag },
                    {
                      onSuccess: () => {
                        toast.success("Release deleted");
                        setDeleteOpen(false);
                        selectTag(null);
                      },
                      onError: (e) => {
                        onError(e);
                        setDeleteOpen(false);
                      },
                    },
                  )
                }
              >
                {deleteRelease.isPending && (
                  <Spinner data-icon="inline-start" />
                )}
                Delete
              </DisabledReasonButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Plain tag view (no release) ────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="font-mono text-sm font-medium">{tag}</h2>
          <span className="flex-1" />
          {ghReady && canCreate && (
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={writeBlocked}
              reason={writeReason}
              onClick={() => setCreateReleaseOpen(true)}
            >
              Create release
            </DisabledReasonButton>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {tagInfo?.annotated && <Badge variant="secondary">annotated</Badge>}
          {tagInfo?.target && (
            <span className="font-mono">{tagInfo.target.slice(0, 7)}</span>
          )}
          {tagInfo?.date && parseableDate(tagInfo.date) && (
            <span>
              • <RelativeTime date={tagInfo.date} />
            </span>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-4 p-4">
        {tagInfo?.subject ? (
          <p className="text-sm">{tagInfo.subject}</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            No description for this tag.
          </p>
        )}
        {!ghReady && (
          <p className="text-[11px] text-muted-foreground">
            Connect this repository to GitHub or GitLab to publish a release for
            this tag.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t p-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!tagInfo?.target || checkout.isPending}
          onClick={onCheckout}
        >
          Checkout
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pushTag.isPending}
          onClick={() =>
            pushTag.mutate(tag, {
              onSuccess: () => toast.success(`Pushed ${tag}`),
              onError,
            })
          }
        >
          Push tag
        </Button>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDeleteTagRemote(false);
            setDeleteTagOpen(true);
          }}
        >
          Delete tag
        </Button>
      </div>

      <CreateReleaseDialog
        repoPath={repoPath}
        open={createReleaseOpen}
        onOpenChange={setCreateReleaseOpen}
        initialTag={tag}
      />

      <Dialog open={deleteTagOpen} onOpenChange={setDeleteTagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete tag {tag}?</DialogTitle>
            <DialogDescription>
              Deletes the local tag. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={deleteTagRemote}
              onCheckedChange={(c) => setDeleteTagRemote(c === true)}
            />
            Also delete it from <span className="font-mono">origin</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTagOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteTag.isPending}
              onClick={() =>
                deleteTag.mutate(
                  { name: tag, onRemote: deleteTagRemote },
                  {
                    onSuccess: () => {
                      toast.success(`Deleted ${tag}`);
                      setDeleteTagOpen(false);
                      selectTag(null);
                    },
                    onError: (e) => {
                      onError(e);
                      setDeleteTagOpen(false);
                    },
                  },
                )
              }
            >
              {deleteTag.isPending && <Spinner data-icon="inline-start" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
