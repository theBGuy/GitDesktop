import { invoke } from "@/lib/tauri/invoke";
import type {
  GeneratedNotes,
  ReleaseDetails,
  ReleaseInfo,
  TagInfo,
} from "../types";

export const gitTag = (repoPath: string, name: string, hash: string) =>
  invoke<void>("git_tag", { repoPath, name, hash });

export const gitPushTag = (repoPath: string, name: string) =>
  invoke<void>("git_push_tag", { repoPath, name });

export const gitDeleteTag = (
  repoPath: string,
  name: string,
  onRemote: boolean,
) => invoke<void>("git_delete_tag", { repoPath, name, onRemote });

/** Every tag in the repo, newest first (for the Tags list). */
export const gitListTags = (repoPath: string) =>
  invoke<TagInfo[]>("git_list_tags", { repoPath });

// ── Releases ────────────────────────────────────────────────────────────────
//
// Reads and writes go through the provider-neutral `forge_release_*`. Two pieces stay
// `gh_*`: notes generation (GitHub's changelog API) and asset download (GitLab assets
// are links the browser opens).

export const forgeReleaseList = (repoPath: string) =>
  invoke<ReleaseInfo[]>("forge_release_list", { repoPath });

export const forgeReleaseView = (repoPath: string, tag: string) =>
  invoke<ReleaseDetails>("forge_release_view", { repoPath, tag });

export const forgeReleaseCreate = (
  repoPath: string,
  tag: string,
  title: string,
  notes: string,
  target: string,
  prerelease: boolean,
  draft: boolean,
  latest: boolean,
) =>
  invoke<string>("forge_release_create", {
    repoPath,
    tag,
    title,
    notes,
    target,
    prerelease,
    draft,
    latest,
  });

export const forgeReleaseEdit = (
  repoPath: string,
  tag: string,
  title: string,
  notes: string,
  prerelease: boolean,
  draft: boolean,
  // Tri-state: `undefined` omits `--latest` so GitHub keeps/decides Latest natively
  // (a draft's Latest is structurally false — sending it strips Latest on publish).
  latest: boolean | undefined,
) =>
  invoke<void>("forge_release_edit", {
    repoPath,
    tag,
    title,
    notes,
    prerelease,
    draft,
    latest,
  });

/** The release asset Tauri's updater polls. KEEP IN SYNC with `UPDATER_MANIFEST`
 *  in src-tauri/src/github/release.rs — the sync command matches on this name. */
export const UPDATER_MANIFEST_NAME = "latest.json";

/** Re-points the release's `latest.json` updater manifest at `notes`, leaving its
 *  version, dates and platform signatures untouched. GitHub-only. */
export const forgeReleaseSyncUpdaterNotes = (
  repoPath: string,
  tag: string,
  notes: string,
) => invoke<void>("forge_release_sync_updater_notes", { repoPath, tag, notes });

/** GitHub's auto-generated release notes (suggested title + body), for preview. */
export const ghReleaseGenerateNotes = (
  repoPath: string,
  tag: string,
  target: string,
  previousTag: string,
) =>
  invoke<GeneratedNotes>("gh_release_generate_notes", {
    repoPath,
    tag,
    target,
    previousTag,
  });

export const forgeReleaseDelete = (
  repoPath: string,
  tag: string,
  cleanupTag: boolean,
) => invoke<void>("forge_release_delete", { repoPath, tag, cleanupTag });

export const forgeReleaseUploadAsset = (
  repoPath: string,
  tag: string,
  filePath: string,
) => invoke<void>("forge_release_upload_asset", { repoPath, tag, filePath });

export const forgeReleaseDeleteAsset = (
  repoPath: string,
  tag: string,
  assetName: string,
) => invoke<void>("forge_release_delete_asset", { repoPath, tag, assetName });

export const ghReleaseDownloadAsset = (
  repoPath: string,
  tag: string,
  assetName: string,
  dir: string,
) =>
  invoke<void>("gh_release_download_asset", { repoPath, tag, assetName, dir });
