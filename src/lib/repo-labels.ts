/**
 * Accessible name for a repo-state glyph. One glyph stands for both states, so
 * the label names both; a plain repo stays unlabelled — nothing in the app
 * badges a repo "public".
 */
export function repoStateLabel(
  isPrivate: boolean,
  isFork: boolean,
): string | null {
  return isPrivate
    ? isFork
      ? "Private fork"
      : "Private repository"
    : isFork
      ? "Fork"
      : null;
}
