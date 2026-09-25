import type { ForgeProvider } from "./forge";

/** One repo's background PR-sync readiness (`forge_background_statuses`). On a host
 *  the batch probe answered for, `ready` means "signed in on that host", not
 *  "`gh repo view` succeeded". */
export interface BackgroundRepoStatus {
  path: string;
  provider: ForgeProvider;
  host: string | null;
  ready: boolean;
  /** The signed-in login on the repo's host — the pr-open catch-up's viewer. */
  login: string | null;
}
