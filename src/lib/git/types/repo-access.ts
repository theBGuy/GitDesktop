/** Whether the viewer can manage this repo's settings (`admin`) and whether
 *  they hold the owner-only lifecycle powers (`owner`). GitHub admin implies
 *  both; GitLab distinguishes Maintainer from Owner. */
export interface ForgeRepoAdmin {
  admin: boolean;
  owner: boolean;
}

/** Viewer write-permission on the repo behind the lens. A null `canPush` /
 *  `canTriage` means the probe couldn't answer that axis (`repo` and
 *  `unknownReason` may still be set) — consumers must FAIL OPEN on null
 *  (leave controls enabled). */
export interface ForgeRepoWriteAccess {
  canPush: boolean | null;
  /** Triage tier and above, which grants labels, assignees, milestones, review
   *  requests, hiding comments and close/reopen WITHOUT push (GitHub triage;
   *  GitLab Reporter) — a separate axis, not implied by `canPush`. Pin is
   *  write-tier; locking is write-tier on GitHub but Reporter (triage) on
   *  GitLab. */
  canTriage: boolean | null;
  role: string | null;
  /** The probed repo identity ("owner/repo") for UI copy. */
  repo: string | null;
  unknownReason: string | null;
}
