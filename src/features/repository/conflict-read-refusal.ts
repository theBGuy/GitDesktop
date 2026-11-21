import { appErrorDetail } from "@/lib/error-summary";
import { conflictMarkerScan } from "@/lib/git/conflict";
import {
  MARKER_SCAN_TIMED_OUT,
  sidesRefusal,
} from "@/lib/git/conflict-prefilter";
import { isAppError } from "@/lib/tauri/invoke";
import type { MarkerFlag } from "./conflict-confirms";

/** The backend's two refusals to read a working file as text. Matched through
 *  the prefilter's twins of conflict.rs's sentences, never the error kind alone:
 *  path-gate refusals share `invalidArgument`, and staging is no answer there. */
export type ReadRefusal = "tooLarge" | "binary";

/** Classifies a rejected sides read as one of those refusals, or null. */
export function readRefusalOf(error: unknown): ReadRefusal | null {
  if (!isAppError(error) || error.kind !== "invalidArgument") return null;
  const refusal = sidesRefusal(appErrorDetail(error.kind, error.message), null);
  return refusal === "tooLarge" || refusal === "binary" ? refusal : null;
}

/** The stage prompt's flag for a file whose sides read rejected with `error`,
 *  or null when it needs none. A too-large refusal falls back to the capless
 *  marker scan, so only a file that still has markers (or that the scan can't
 *  answer for) asks; a binary refusal never scans; any other rejection is
 *  flagged without a cause. Only a scan that ran out of its budget keeps the
 *  too-large cause; a scan failing otherwise (permissions, a vanished folder)
 *  says nothing of the file's size. */
export async function refusedReadFlag(
  repoPath: string,
  path: string,
  name: string,
  error: unknown,
): Promise<MarkerFlag | null> {
  const refusal = readRefusalOf(error);
  if (refusal === null) return { name, unchecked: true };
  if (refusal === "binary") return { name, unchecked: true, cause: "binary" };
  try {
    const scan = await conflictMarkerScan(repoPath, path);
    if (!scan.exists) return null;
    if (scan.binary) return { name, unchecked: true, cause: "binary" };
    return scan.markers ? { name, unchecked: false } : null;
  } catch (scanError) {
    return isAppError(scanError) &&
      scanError.kind === "io" &&
      appErrorDetail(scanError.kind, scanError.message) ===
        MARKER_SCAN_TIMED_OUT
      ? { name, unchecked: true, cause: "tooLarge" }
      : { name, unchecked: true };
  }
}
