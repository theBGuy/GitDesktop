/**
 * The publish dialog's draft-keeping rule and the record transitions over the
 * draft store. Import-free at runtime on purpose: the node suites load it
 * straight from `src/` under Node's type stripping, which resolves no bundler
 * aliases. The one import must stay the statement form `import type`, which
 * type stripping erases; an inline `type` specifier keeps the statement.
 */
import type {
  FailedPublishDraft,
  PublishDraftsByRepo,
  PublishFormValues,
} from "@/lib/stores/publish-draft";

// Every transition takes an already-normalized repo key and never mutates its
// input. Returning the input itself means "no change": the store's setter then
// skips the notify, so a present key always yields a new record.

/** Records a failed draft for the repo, replacing any earlier one. */
export function stampDraft(
  byRepo: PublishDraftsByRepo,
  repoKey: string,
  provider: FailedPublishDraft["provider"],
  values: PublishFormValues,
): PublishDraftsByRepo {
  return { ...byRepo, [repoKey]: { repo: repoKey, provider, values } };
}

/** Drops the repo's draft; an absent key returns the record itself. */
export function clearDraft(
  byRepo: PublishDraftsByRepo,
  repoKey: string,
): PublishDraftsByRepo {
  if (!Object.hasOwn(byRepo, repoKey)) return byRepo;
  const { [repoKey]: _dropped, ...rest } = byRepo;
  return rest;
}

/** Replaces a present draft's values; never mints an entry. */
export function updateDraftValues(
  byRepo: PublishDraftsByRepo,
  repoKey: string,
  values: PublishFormValues,
): PublishDraftsByRepo {
  const draft = Object.hasOwn(byRepo, repoKey) ? byRepo[repoKey] : undefined;
  if (!draft) return byRepo;
  return { ...byRepo, [repoKey]: { ...draft, values } };
}

export function draftFor(
  byRepo: PublishDraftsByRepo,
  repoKey: string,
): FailedPublishDraft | null {
  return Object.hasOwn(byRepo, repoKey) ? byRepo[repoKey] : null;
}

export type DraftActionOnOpen = "keep" | "restore" | "reseed";

/** What an opening dialog does with its form. "keep": leave the submitting
 *  form untouched. "restore": reset the form from the stored failed draft
 *  (same repo, same provider). "reseed": reset to defaults and retire any
 *  stored draft for this repo. Arm order is the contract: a running submit's
 *  form is never reset under it. */
export function keepDraftOnOpen(input: {
  prevRepo: string;
  repo: string;
  submitting: boolean;
  failed: FailedPublishDraft | null;
  provider: FailedPublishDraft["provider"];
}): DraftActionOnOpen {
  const { prevRepo, repo, submitting, failed, provider } = input;
  if (prevRepo === repo && submitting) return "keep";
  if (failed !== null && failed.repo === repo && failed.provider === provider) {
    return "restore";
  }
  return "reseed";
}
