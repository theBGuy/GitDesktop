import { useEffect, useState, useSyncExternalStore } from "react";
import type { StagedImage } from "./api";
import type { DraftStatus, StagedRecord } from "./draft-attachments";
import {
  ATTACHING_REASON,
  type AttachSource,
  appendReferenceText,
  type UploadAct,
} from "./references";
import {
  type AttachmentSurface,
  draftEntry,
  mintAttachmentOwner,
  noteAttachBlocked,
  noteDraftEdited,
  retireHeldNote,
  stageAttachment,
  stagesInFlight,
  startAttachGesture,
  subscribeAttachments,
  sweepOtherOwners,
} from "./store";

/** The `attachments` prop of the editor and the composer: one draft's staged
 *  images and the actions on them. */
export interface DraftAttachmentsHandle {
  draftKey: string;
  /** The host instance this draft belongs to; Preview resolves its images
   *  only through the entry this owner holds. */
  owner: object;
  images: readonly StagedRecord[];
  gateReason: string | null;
  holdReason: string | null;
  status: DraftStatus | null;
  notice: { failed: string[] } | null;
  /** How many names ride this draft's in-flight post; 0 when none. */
  posting: number;
  /** A stage for this draft is in flight: every control that posts the draft
   *  holds with `ATTACHING_REASON` until it settles. */
  attaching: boolean;
  /** Puts `ATTACHING_REASON` on the status line for a held keyboard submit; it
   *  retires once no stage is in flight. */
  noteSubmitHeld(): void;
  stage(file: File, source: AttachSource): Promise<StagedImage | null>;
  /** Starts one attach gesture (clears the status line once); the result says
   *  whether the draft is still the one it started on. */
  startAttach(): () => boolean;
  /** Appends a reference to THIS handle's draft, moving no focus. */
  appendReference(text: string): void;
  noteBlocked(): void;
  noteEdited(): void;
  /** Whether the stored status is a held attach's reason this handle's hold no
   *  longer gives; `status` already reads null for it. */
  heldNoteStale: boolean;
  /** Drops that stale reason from the store. */
  retireHeldNote(): void;
  /** This handle with a host's own hold laid over it (it outranks the handle's
   *  `holdReason`); `stage` and `noteBlocked` honor it, not just the display. */
  withHold(reason: string | null): DraftAttachmentsHandle;
}

const NO_IMAGES: readonly StagedRecord[] = [];

const UPLOAD_ACT: Record<AttachmentSurface, UploadAct> = {
  "issue-comment": "posting",
  "pr-comment": "posting",
  "pr-create": "creating",
};

/** What a draft's in-flight post is doing, named from its key's surface. */
export function uploadActFor(draftKey: string): UploadAct {
  const surface = draftKey.slice(0, draftKey.indexOf("|"));
  return UPLOAD_ACT[surface as AttachmentSurface] ?? "posting";
}

/**
 * One host instance's owner token. With `sweep`, its mount releases every entry
 * and held copy of its surface another owner left behind, or, given `host`,
 * only those another instance of that same host left; an `<Activity>` re-show
 * replays the sweep with the same owner, so it frees nothing of its own.
 */
export function useAttachmentOwner(
  surface: AttachmentSurface,
  sweep: boolean,
  host?: string,
): object {
  const [owner] = useState(() => mintAttachmentOwner(host));
  useEffect(() => {
    if (sweep) sweepOtherOwners(surface, owner);
  }, [surface, owner, sweep]);
  return owner;
}

/**
 * The handle for one draft. `writeDraft` is the host's identity-pinned text
 * writer: `appendReference` writes through it to the draft this handle was made
 * for, whatever the host shows by then.
 */
export function useDraftAttachments({
  draftKey,
  owner,
  gateReason,
  holdReason,
  writeDraft,
}: {
  draftKey: string;
  owner: object;
  gateReason: string | null;
  holdReason: string | null;
  writeDraft: (draftKey: string, update: (prev: string) => string) => void;
}): DraftAttachmentsHandle {
  const entry = useSyncExternalStore(subscribeAttachments, () =>
    draftEntry(draftKey),
  );
  const attaching = useSyncExternalStore(
    subscribeAttachments,
    () => stagesInFlight(draftKey) > 0,
  );
  const own = entry?.owner === owner ? entry : undefined;
  const make = (hold: string | null): DraftAttachmentsHandle => {
    const blocked = hold ?? gateReason;
    const noted = blocked ?? (attaching ? ATTACHING_REASON : null);
    const stored = own?.status ?? null;
    // A held attach's reason lives only as long as the hold that gave it.
    const heldNoteStale = stored?.held === true && stored.text !== noted;
    return {
      draftKey,
      owner,
      images: own?.images ?? NO_IMAGES,
      gateReason,
      holdReason: hold,
      status: heldNoteStale ? null : stored,
      heldNoteStale,
      retireHeldNote: () => retireHeldNote(draftKey, owner, noted),
      notice: own?.notice ?? null,
      posting: own?.posting.length ?? 0,
      attaching,
      noteSubmitHeld: () => {
        if (attaching) noteAttachBlocked(draftKey, owner, ATTACHING_REASON);
      },
      stage: (file, source) =>
        stageAttachment({
          draftKey,
          owner,
          file,
          source,
          blockedReason: blocked,
        }),
      startAttach: () => startAttachGesture(draftKey, owner),
      appendReference: (text) =>
        writeDraft(draftKey, (prev) => appendReferenceText(prev, text)),
      noteBlocked: () => {
        if (blocked !== null) noteAttachBlocked(draftKey, owner, blocked);
      },
      noteEdited: () => noteDraftEdited(draftKey, owner),
      withHold: (reason) => make(reason ?? hold),
    };
  };
  return make(holdReason);
}
