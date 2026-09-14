/** Normalize a path/key for comparison: forward slashes, no trailing slash,
 *  lower-cased (Windows paths differ in case in the wild). A leaf module so
 *  every side of a relocate — the app-data migration, the live plan/research
 *  stores, task scopes — compares keys by exactly the same rule without
 *  importing each other. */
export function norm(s: string): string {
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
