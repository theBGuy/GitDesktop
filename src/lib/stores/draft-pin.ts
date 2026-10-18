// Import-free on purpose: scripts/draft-pin.test.mjs loads this file straight
// from `src/` under Node's type stripping.

/** The branch a commit-draft key names, read past its repo prefix (the
 *  `${repoPath}:${branch}` form `commitDraftKey` builds); null for a key of
 *  another repo. Never split on `:`, which a Windows repo path contains. */
export function draftKeyBranch(repoPath: string, key: string): string | null {
  const prefix = `${repoPath}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** An amend's branch pin carried across a draft re-key (a branch rename): it
 *  follows the rename only when it named the branch the old key belonged to. */
export function retargetAmendPin(
  pin: string | null,
  repoPath: string | null,
  fromKey: string,
  toKey: string,
): string | null {
  if (pin === null || repoPath === null || fromKey === toKey) return pin;
  const from = draftKeyBranch(repoPath, fromKey);
  const to = draftKeyBranch(repoPath, toKey);
  return from !== null && to !== null && pin === from ? to : pin;
}
