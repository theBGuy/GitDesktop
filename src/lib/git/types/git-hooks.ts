/** State of one git hook in the repo's hooks directory. */
export interface HookEntry {
  name: string;
  description: string;
  /** "active" (installed + runs) | "disabled" (kept, renamed off) | "inactive". */
  state: "active" | "disabled" | "inactive";
  /** Whether git's stock `<name>.sample` is present. */
  hasSample: boolean;
  /** GitDesktop's own Keep local pre-push guard: the active `pre-push` in the
   *  folder the guard manages, carrying the app's marker. */
  managed: boolean;
}

export interface HooksInfo {
  /** Absolute path to the effective hooks directory. */
  hooksPath: string;
  /** True when `core.hooksPath` redirects hooks away from `.git/hooks`. */
  customHooksPath: boolean;
  /** A detected hook manager ("husky" | "pre-commit" | "lefthook"). */
  manager: string | null;
  /** Path to the manager's config file/dir, for an "Open config" affordance. */
  managerConfig: string | null;
  entries: HookEntry[];
}

/** Where the managed Keep local pre-push hook stands in a clone. */
export interface KeepLocalHookStatus {
  state: "installed" | "absent" | "blocked";
  /** Non-null exactly when `state` is "blocked". */
  blocked: "hookManager" | "customHooksPath" | "foreignHook" | null;
  /** Non-null exactly when `blocked` is "hookManager". */
  manager: "husky" | "pre-commit" | "lefthook" | null;
  /** GitDesktop's own marked pre-push file is in the clone's own hooks folder:
   *  always true when installed, false when absent, either when blocked. */
  managedHookPresent: boolean;
  /** <common>/hooks is a link, junction or other non-directory: nothing is written or deleted through it. */
  hooksDirRedirected: boolean;
  /** The effective hooks directory, absolute. */
  hooksPath: string;
  /** sh lines to paste into the user's own pre-push hook. */
  snippet: string;
}
