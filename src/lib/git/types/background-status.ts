/** One repo's background PR-sync readiness (`forge_background_statuses`). GitHub
 *  auth is judged once per host, so `ready` there means "signed in on this host",
 *  not "`gh repo view` succeeded". */
export interface BackgroundRepoStatus {
  path: string;
  /** `"github"` | `"gitlab"` | `"bitbucket"`. */
  provider: string;
  host: string | null;
  ready: boolean;
  /** The signed-in login on the repo's host — the pr-open catch-up's viewer. */
  login: string | null;
}
