/** State of one git hook in the repo's hooks directory. */
export interface HookEntry {
  name: string;
  description: string;
  /** "active" (installed + runs) | "disabled" (kept, renamed off) | "inactive". */
  state: "active" | "disabled" | "inactive";
  /** Whether git's stock `<name>.sample` is present. */
  hasSample: boolean;
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
