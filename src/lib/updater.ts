import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type { Update };

/** Checks the configured GitHub Releases endpoint; null = already up to date. */
export function checkForUpdate(): Promise<Update | null> {
  return check();
}

export interface DownloadProgress {
  downloaded: number;
  /** Total bytes, when the server reported a content length. */
  total: number | null;
}

/** Updates whose downloaded package the backend still holds, so a declined or
 *  failed install retries with those bytes instead of downloading again (a fresh
 *  `download()` would orphan the held copy). Only a SUCCESSFUL install consumes
 *  them backend-side and clears the JS handle, so only it leaves the set. */
const downloaded = new WeakSet<Update>();

/**
 * Downloads an update (reporting byte progress), asks `beforeInstall`, then
 * installs and relaunches into the new version, so an accepted install normally
 * does not return. Resolves `false` when `beforeInstall` declines; the download
 * is kept for the next attempt. The hook runs after the download because
 * Windows exits inside `install()`: it is the last point before the process
 * ends.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (p: DownloadProgress) => void,
  beforeInstall?: () => Promise<boolean>,
): Promise<boolean> {
  if (!downloaded.has(update)) {
    let received = 0;
    let total: number | null = null;
    await update.download((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? null;
          onProgress?.({ downloaded: 0, total });
          break;
        case "Progress":
          received += event.data.chunkLength;
          onProgress?.({ downloaded: received, total });
          break;
        case "Finished":
          onProgress?.({ downloaded: total ?? received, total });
          break;
      }
    });
    downloaded.add(update);
  }
  if (beforeInstall && !(await beforeInstall())) return false;
  await update.install();
  downloaded.delete(update);
  await relaunch();
  return true;
}
