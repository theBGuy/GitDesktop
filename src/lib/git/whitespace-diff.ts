// No runtime imports: scripts/hide-whitespace.test.mjs loads this under Node.

/** True when some line of a diff text opens a hunk. */
export function hasHunk(text: string): boolean {
  return text.startsWith("@@ ") || text.includes("\n@@ ");
}

/**
 * Reads a view diff in the whitespace mode and stamps the answer with it on
 * both reads, so every gate and arm follows the diff on screen rather than the
 * setting, and an unstamped answer is one that never came through here. A
 * hunkless `-w` answer gets a second, plain read: only that tells a file whose
 * changes were all whitespace from one with nothing to show.
 */
export async function readViewDiff<
  T extends { text: string; isBinary: boolean },
>(
  hide: boolean,
  read: (ignoreWhitespace: boolean) => Promise<T>,
): Promise<T & { whitespaceHidden?: boolean; whitespaceOnly?: boolean }> {
  if (!hide) return { ...(await read(false)), whitespaceHidden: false };
  const hidden = await read(true);
  if (hidden.isBinary || hasHunk(hidden.text))
    return { ...hidden, whitespaceHidden: true };
  const plain = await read(false);
  return hasHunk(plain.text)
    ? { ...hidden, whitespaceHidden: true, whitespaceOnly: true }
    : { ...hidden, whitespaceHidden: true };
}
