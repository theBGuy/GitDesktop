import type { AppSettings } from "@/lib/settings/api";

/** The layout a diff view draws: Unified where its host forces it (a pane
 *  under Split's floor), else the setting, Unified until it loads. The session
 *  column's step marks report a step's layout through this too, so what they
 *  report is what the rows draw. */
export function drawnLayout(
  forceUnified: boolean | undefined,
  mode: AppSettings["diffViewMode"] | undefined,
): AppSettings["diffViewMode"] {
  return forceUnified ? "unified" : (mode ?? "unified");
}
