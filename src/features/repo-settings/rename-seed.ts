// Pure, import-free: scripts/rename-seed.test.mjs imports this file through
// Node's type stripping, which resolves no aliases.

/** The rename field: what it shows, the server name it was last seeded from,
 *  and the name an in-flight or finished rename sent (null when none). */
export interface RenameField {
  name: string;
  seeded: string;
  sent: string | null;
}

/**
 * Follows a refreshed server name into the rename field. The field takes the
 * new name unless it holds an edit of its own: it still shows the name it was
 * seeded from, or the one a rename sent (which Bitbucket may read back as a
 * normalized slug). Returns null when the server name hasn't moved, so a
 * render-time caller sets nothing and can't loop.
 */
export function reseedRename(
  field: RenameField,
  current: string,
): RenameField | null {
  if (current === field.seeded) return null;
  const typed = field.name.trim();
  const follows = typed === field.seeded || typed === field.sent;
  return { name: follows ? current : field.name, seeded: current, sent: null };
}
