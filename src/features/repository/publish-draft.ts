/**
 * The publish dialog's draft-keeping rule. Import-free at runtime on purpose:
 * `scripts/publish-pending.test.mjs` loads it straight from `src/` under Node's
 * type stripping, which resolves no bundler aliases.
 */

/** A draft whose publish failed: the repo and provider it targeted, and the
 *  seed generation the form held when it was submitted. */
export interface FailedPublishDraft {
  repo: string;
  gen: number;
  provider: "github" | "gitlab" | "bitbucket";
}

/** Whether an opening dialog keeps its draft instead of reseeding. Only this
 *  repo's draft survives: while its publish runs, or after it failed when
 *  reopened for the same provider with no reseed since. Another repo's draft
 *  always reseeds, so that publish's settle can't close or overwrite this one. */
export function keepDraftOnOpen(input: {
  prevRepo: string;
  repo: string;
  submitting: boolean;
  failed: FailedPublishDraft | null;
  gen: number;
  provider: FailedPublishDraft["provider"];
}): boolean {
  const { prevRepo, repo, submitting, failed, gen, provider } = input;
  if (prevRepo !== repo) return false;
  if (submitting) return true;
  return (
    failed !== null &&
    failed.repo === repo &&
    failed.gen === gen &&
    failed.provider === provider
  );
}
