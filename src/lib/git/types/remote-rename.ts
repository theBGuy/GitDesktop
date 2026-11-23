import type { AppError } from "@/lib/tauri/invoke";
import type { ForgeProvider } from "./forge";

/** Why a branch can't also be renamed on its remote; nothing was renamed, here
 *  or there. `unreachable` carries git's own reason. */
export type RemoteRenameRefusal =
  | { code: "notTracking" }
  | { code: "keepLocal" }
  | { code: "mirror" }
  | { code: "pushUrlDiffers" }
  | { code: "caseOnly" }
  | { code: "unreachable"; detail: string }
  | { code: "remoteDefault" }
  | { code: "remoteGone" }
  | { code: "moved" }
  | { code: "newExists" }
  | { code: "remoteAhead" };

export type RemoteRenameRefusalCode = RemoteRenameRefusal["code"];

/** The remote rename's verdict before anything changes. `oldTip` is the
 *  remote's tip of the old name, the pin the act's delete leases. */
export type RemoteRenameCheck =
  | { status: "clear"; oldTip: string }
  | { status: "refused"; refusal: RemoteRenameRefusal };

/** Why the old remote branch was left in place after the new name was pushed:
 *  the pushed branch lacked the old tip (no delete was tried), the old branch
 *  moved, the remote refused (`detail` verbatim), the pushed copy couldn't be
 *  compared with it, so no delete was tried, or the delete or a read after it
 *  failed. */
export type OldKeptCause =
  | { reason: "notInPush" }
  | { reason: "moved" }
  | { reason: "rejected"; detail: string }
  /** The pushed copy couldn't be compared with the old remote tip, so no
   *  delete was tried. */
  | { reason: "unverified" }
  | { reason: "failed"; error: AppError };

/** What a remote rename did. Every status but `refused` renamed the branch
 *  here; `warning` is the local rename's, or says the push didn't set the
 *  upstream (`Couldn't set {new}'s upstream to {remote}/{new}.`). `renamed`:
 *  the new name is pushed and the old remote branch was deleted or already
 *  gone. After a push timeout, whether the new name exists on the remote is
 *  unknown. */
export type RemoteRenameOutcome =
  | { status: "refused"; refusal: RemoteRenameRefusal }
  | { status: "pushFailed"; warning: string | null; error: AppError }
  | { status: "oldKept"; warning: string | null; cause: OldKeptCause }
  | { status: "renamed"; warning: string | null };

/** Where an open pull or merge request was looked up: the repository the
 *  remote points at, or the repository it was forked from. */
export type PullScope = "repository" | "parent";

/** An open pull or merge request headed on the branch; `repo` is the
 *  `owner/name` (or GitLab full path) it lives in. */
export interface RemoteBranchPull {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  scope: PullScope;
  repo: string;
}

/** A scope whose lookup couldn't run or failed; never read as "none open". */
export interface UncheckedScope {
  scope: PullScope;
  error: AppError;
}

/** Open pull or merge requests on a remote branch: `noForge` for a remote with
 *  no host, `unidentified` for a host no signed-in forge serves. */
export type RemoteBranchPulls =
  | { status: "noForge" }
  | { status: "unidentified"; host: string }
  | {
      status: "checked";
      provider: ForgeProvider;
      items: RemoteBranchPull[];
      unchecked: UncheckedScope[];
    };
