import { create } from "zustand";

/**
 * Failed-publish drafts, one per checkout path, held in memory only: a restart
 * forgets them. Deliberately not cleared on a repo switch — a draft outliving
 * the detour is the point. A dumb holder: the record transitions live in
 * `features/repository/publish-draft.ts`, since lib must not import features.
 */

export interface PublishFormValues {
  name: string;
  description: string;
  homepage: string;
  topics: string;
  workspace: string;
  owner: string;
  isPrivate: boolean;
}

/** A draft whose publish failed. `repo` is the normalized repo key (normPath
 *  spelling), also the byRepo key it sits under. */
export interface FailedPublishDraft {
  repo: string;
  provider: "github" | "gitlab" | "bitbucket";
  values: PublishFormValues;
}

export type PublishDraftsByRepo = Record<string, FailedPublishDraft>;

interface PublishDraftState {
  byRepo: PublishDraftsByRepo;
}

export const usePublishDraftStore = create<PublishDraftState>()(() => ({
  byRepo: {},
}));

/** The one write path. A transition handing back the SAME record reference
 *  returns the existing state object, so zustand skips the notify. */
export function setPublishDrafts(
  fn: (byRepo: PublishDraftsByRepo) => PublishDraftsByRepo,
): void {
  usePublishDraftStore.setState((s) => {
    const next = fn(s.byRepo);
    return next === s.byRepo ? s : { byRepo: next };
  });
}
