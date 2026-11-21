import { WarningIcon } from "@phosphor-icons/react";
import { formOptions } from "@tanstack/react-form";
import {
  isCancelledError,
  matchQuery,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { ignoreHeldEnter } from "@/components/confirm-swap-focus";
import type { MarkdownHostedImages } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type ItemKind,
  partialEditNotice,
  updatedWarning,
  withFailedReferences,
} from "@/lib/attachments/comment-post";
import {
  ATTACHING_REASON,
  type AttachmentRefs,
  failedAttachmentsOf,
  failedReferencesDraft,
  referencesName,
  savedBodyOf,
  uploadingReason,
} from "@/lib/attachments/references";
import {
  beginAttachmentPost,
  draftEntry,
  endDraftAttachments,
  type PostTicket,
  settleAttachmentPost,
} from "@/lib/attachments/store";
import type { DraftAttachmentsHandle } from "@/lib/attachments/use-draft-attachments";
import { mayHaveLanded, otherChangesSaved } from "@/lib/error-summary";
import { required, useAppForm, withForm } from "@/lib/form";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import {
  ACT_PENDING_REASON,
  AI_DRAFT_PENDING_REASON,
} from "@/lib/offline-writes";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";
import type { MentionSource } from "./useMentionCandidates";

/** Shared form shape so the hook's `useAppForm` and the `withForm` dialog agree. */
export const editTitleBodyFormOpts = formOptions({
  defaultValues: { title: "", body: "" },
});

/** One open of the dialog, with the item (draft key) it edits. */
type EditSession = { draftKey: string | null };

/** An open form's follow state: per field, the value it was last seeded with
 *  and the last `fresh` value the session saw. */
interface FollowRecord {
  readonly session: EditSession;
  readonly seeded: { title: string; body: string };
  readonly seen: { title: string | undefined; body: string | undefined };
}

/** The session each item's running save belongs to, and the session last
 *  committed on screen. Replaced on every change, so it is its own snapshot. */
interface SaveLedgerState {
  readonly running: ReadonlyMap<string, EditSession>;
  readonly shown: EditSession | null;
}

function createSaveLedger() {
  let state: SaveLedgerState = { running: new Map(), shown: null };
  const listeners = new Set<() => void>();
  const write = (next: SaveLedgerState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show: (shown: EditSession | null) => {
      if (state.shown !== shown) write({ ...state, shown });
    },
    /** Records `session`'s save of its item; false when that item has one. */
    start: (session: EditSession | null): boolean => {
      const key = session?.draftKey ?? null;
      if (session === null || key === null) return true;
      if (state.running.has(key)) return false;
      write({ ...state, running: new Map(state.running).set(key, session) });
      return true;
    },
    /** Drops `session`'s record, only while it is still that item's. */
    finish: (session: EditSession | null) => {
      const key = session?.draftKey ?? null;
      if (key === null || state.running.get(key) !== session) return;
      const running = new Map(state.running);
      running.delete(key);
      write({ ...state, running });
    },
  };
}

// Keyed by the hook's form, the one stable object hosts hand the dialog, so
// the ledger travels with it.
const saveLedgers = new WeakMap<object, ReturnType<typeof createSaveLedger>>();

function saveLedgerOf(form: object) {
  let ledger = saveLedgers.get(form);
  if (ledger === undefined) {
    ledger = createSaveLedger();
    saveLedgers.set(form, ledger);
  }
  return ledger;
}

/** Whether the shown session's item has a running save, and whether that save
 *  is the shown session's own. */
function shownSaveOf({ running, shown }: SaveLedgerState) {
  const saver =
    shown?.draftKey == null ? undefined : running.get(shown.draftKey);
  return { running: saver !== undefined, own: saver === shown };
}

/** How long a re-read another write cancelled waits for a fetched answer: a
 *  cancelling write normally settles within seconds; a slower one unlocks Save
 *  into the edit contract's not-covered case. */
export const REREAD_WAIT_MS = 15_000;

/**
 * The hosts' `attach.reread`: one read of `queryKey`, settling once a fetch of
 * it answered or failed after the call (a cache write is no answer). A read
 * another write cancelled starts no fetch of its own, since a GET landing
 * before that write would put the old item back over its optimistic patch: it
 * waits through any further cancel for the next fetched answer, at most
 * `REREAD_WAIT_MS`. It also settles when the read starts paused or is parked
 * during that wait, the query leaves the cache, or nothing enabled observes the
 * key; those releases count only while it waits. Reads only the key it was given.
 */
export async function rereadEditedItem(
  client: QueryClient,
  queryKey: QueryKey,
): Promise<void> {
  const cache = client.getQueryCache();
  let answered = false;
  // An observer leaving and returning during the first read must not end a
  // later wait, so the subscriber releases only once this is set.
  let waiting = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const idle = () => {
    const query = cache.find({ queryKey, exact: true });
    return (
      query === undefined ||
      query.state.fetchStatus === "paused" ||
      !query.isActive()
    );
  };
  const unsubscribe = cache.subscribe((event) => {
    if (!matchQuery({ queryKey, exact: true }, event.query)) return;
    if (event.type === "updated") {
      const { action } = event;
      if (
        (action.type === "success" && !action.manual) ||
        (action.type === "error" && !isCancelledError(action.error))
      )
        answered = true;
    }
    if (waiting && (answered || event.type === "removed" || idle())) release();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client
      .refetchQueries(
        { queryKey, exact: true, type: "active" },
        { cancelRefetch: false },
      )
      .catch(() => undefined);
    waiting = true;
    if (answered || idle()) return;
    timer = setTimeout(release, REREAD_WAIT_MS);
    await released;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

// Edit rules with `attach` (an item is its draft key): one save per item per
// instance, Save held on that item only, from the save's start until it settled
// and the host's re-read of the item answered, failed or was parked offline (a
// read that hangs holds for the read's own timeout; once another write cancels
// it, the hold waits at most `REREAD_WAIT_MS` for the next fetched answer, then
// Save unlocks into the not-covered case below); a settle skips that wait
// when its session is still on screen or, for a failure, when its draft was
// kept, unless the failure may have landed; a reopen resumes the draft only
// while the form still holds its session, and a save failing while closed keeps
// its text and images for the first such reopen; a settle ends only the images
// its own save started with. An open form follows `fresh` per field while the
// field still equals what it was seeded with; a changed field is never
// replaced. Not covered: a host remount drops the hold and the keep; a Save
// pressed before the item's re-read answers sends the seeded values wherever
// the save's cache patch did not cover them.
/**
 * The "Edit title + description" form/dialog shared by the local and remote
 * PR and issue views. The hook owns the form + open state + the seed-on-open
 * helper; the dialog is a `withForm` component rendered with `form={edit.form}`.
 */
export function useEditTitleBody(opts: {
  /** Persists the edit (title is pre-trimmed; body is sent as typed). `begin`
   *  (present only with `attach`) starts the image post on the body actually
   *  sent and returns its refs; remote hosts return the mutation's outcome. */
  onSave: (
    value: { title: string; body: string },
    begin?: (finalBody: string) => AttachmentRefs | undefined,
  ) => Promise<unknown>;
  /** Shown after a successful save (remote views); omitted for local views. */
  successToast?: string;
  /** The item's current values in the form's shape, or null while the host
   *  holds no copy it trusts for the item its draft key names. */
  fresh?: { title: string; body: string } | null;
  /** Image attachments (remote hosts only). The draft key, not the handle: the
   *  host builds its handle from this hook's `open` and `form`. */
  attach?: {
    draftKey: string;
    kind: ItemKind;
    /** The item's lower-case noun when its forge names it differently from
     *  `kind`'s default ("merge request"). */
    noun?: string;
    /** A partial save's read-back as the description text, given the text that
     *  save submitted; default identity. */
    seedBody?: (stored: string, submitted: string) => string;
    /** A save of the same session that kept failed images, or failed after
     *  saving its other changes. */
    onPartialSaved?: () => void;
    /** Settles once the host's read of this item has answered: joins the read
     *  in flight or starts one, settling at once when nothing observes the
     *  item or the read is parked offline. Captured at submit. */
    reread?: () => Promise<unknown>;
  };
}) {
  const [open, setOpenState] = useState(false);
  // The open dialog's session: minted by `openEdit`, dropped by every close. The
  // views keep this dialog mounted across entity switches, so a save closes only
  // the session it was submitted from. State, not a ref: views close it in render.
  // It carries the draft key it opened with, which an entity switch has moved
  // on from by the time the close edge ends that draft.
  const [session, setSession] = useState<EditSession | null>(null);
  const sessionRef = useLatestRef(session);
  const setOpen: Dispatch<SetStateAction<boolean>> = (action) => {
    const next = typeof action === "function" ? action(open) : action;
    if (!next) setSession(null);
    setOpenState(next);
  };
  // The session whose draft the form holds: a close leaves it, a reset replaces it.
  const formSessionRef = useRef(session);
  // The session a save is awaiting for. Its settle clears it only while it still
  // names that session: a later item's save may have taken it over.
  const inFlightRef = useRef<typeof session>(null);
  // Set when a save of the form's draft failed while the dialog was closed, so
  // the next open shows that draft again; any next open consumes it.
  const failedWhileClosedRef = useRef<typeof session>(null);
  // The settle arms' "shown" and "open", both written by the layout effect
  // below: a render-time ref can hold a render React later throws away.
  const openRef = useRef(open);
  const shownRef = useRef(session);
  /** Ends a settled save's images unless the open session took over its draft,
   *  and only while the key still holds the entry (`gen`) that save started
   *  with: after a host remount the key can hold a newer instance's draft. */
  function endLeftDraft(savedFrom: typeof session, gen: object | undefined) {
    const draftKey = savedFrom?.draftKey ?? null;
    if (draftKey === null || shownRef.current?.draftKey === draftKey) return;
    if (gen !== undefined && draftEntry(draftKey)?.gen === gen)
      endDraftAttachments(draftKey);
  }
  const form = useAppForm({
    ...editTitleBodyFormOpts,
    onSubmit: async ({ value }) => {
      const savedFrom = sessionRef.current;
      // One save per item at a time. submit() refuses a second submit before
      // form-core; this backstops a submit whose render-time session differs
      // from the one last committed.
      if (!ledger.start(savedFrom)) return;
      const attach = opts.attach;
      let keptForReopen = false;
      let landedUnknown = false;
      try {
        inFlightRef.current = savedFrom;
        // `gen`: the entry this save started with, re-read after its begin
        // (which re-gens the entry); undefined when the draft had none.
        const begun: {
          ticket: PostTicket | null;
          finalBody: string;
          gen: object | undefined;
        } = {
          ticket: null,
          finalBody: value.body,
          gen: attach ? draftEntry(attach.draftKey)?.gen : undefined,
        };
        const begin = attach
          ? (finalBody: string) => {
              begun.ticket = beginAttachmentPost(
                attach.draftKey,
                finalBody,
                false,
              );
              begun.finalBody = finalBody;
              begun.gen = draftEntry(attach.draftKey)?.gen;
              return begun.ticket?.refs;
            }
          : undefined;
        let outcome: unknown;
        try {
          outcome = await opts.onSave(
            { title: value.title.trim(), body: value.body },
            begin,
          );
        } catch (e) {
          if (inFlightRef.current === savedFrom) inFlightRef.current = null;
          landedUnknown = mayHaveLanded(e);
          if (begun.ticket)
            settleAttachmentPost(begun.ticket, { posted: false, failed: [] });
          const shown = shownRef.current === savedFrom;
          // A draft whose posted images went with its entry is not kept: its
          // text would come back referencing images nothing can send.
          // draftEntry ignores the owner: after a remount another instance's
          // entry can answer, harmless as only the marking instance reads it.
          const keep =
            !shown &&
            !openRef.current &&
            savedFrom?.draftKey != null &&
            formSessionRef.current === savedFrom &&
            (begun.ticket === null ||
              draftEntry(savedFrom.draftKey) !== undefined);
          if (keep) {
            failedWhileClosedRef.current = savedFrom;
            keptForReopen = true;
          } else if (!shown) endLeftDraft(savedFrom, begun.gen);
          if ((shown || keep) && otherChangesSaved(e))
            attach?.onPartialSaved?.();
          toastError(e);
          return;
        }
        if (inFlightRef.current === savedFrom) inFlightRef.current = null;
        const same = shownRef.current === savedFrom;
        const failed = attach ? failedAttachmentsOf(outcome) : [];
        if (attach === undefined || failed.length === 0) {
          if (begun.ticket)
            settleAttachmentPost(begun.ticket, { posted: true, failed: [] });
          // flushSync: the close must commit before this save's record clears
          // (the finally below), which the dialog's focus hand-back keys on.
          if (same) flushSync(() => setOpen(false));
          else endLeftDraft(savedFrom, begun.gen);
          if (opts.successToast) toast.success(opts.successToast);
          return;
        }
        // Only a read-back of this same session may replace its text; any other
        // case ends the draft and says so in a toast.
        const body = savedBodyOf(outcome);
        const reseed = body !== null && same;
        const kept =
          begun.ticket !== null &&
          settleAttachmentPost(begun.ticket, {
            posted: true,
            failed,
            discardFailed: !reseed,
          });
        if (body !== null && reseed && kept) {
          const seeded = attach.seedBody?.(body, value.body) ?? body;
          const missing = failed.filter(
            (name) => !referencesName(seeded, name),
          );
          const reseeded =
            missing.length === 0
              ? seeded
              : withFailedReferences(
                  seeded,
                  failedReferencesDraft(begun.finalBody, missing),
                );
          form.setFieldValue("body", reseeded);
          if (savedFrom !== null)
            reseededRef.current = { session: savedFrom, body: reseeded };
          attach.onPartialSaved?.();
          return;
        }
        if (same) flushSync(() => setOpen(false));
        else endLeftDraft(savedFrom, begun.gen);
        toast.warning(updatedWarning(attach.kind, failed, attach.noun));
      } finally {
        // A form opened on the item after its save left the screen was seeded
        // from the cache, so the record holds Save until that copy is re-read.
        // A session still on screen or a kept draft holds the user's own text,
        // unless its failure may have landed: only the re-read tells what the
        // forge holds, so every failure arm waits on it then.
        const reread = attach?.reread;
        if (
          reread !== undefined &&
          savedFrom?.draftKey != null &&
          (landedUnknown || (shownRef.current !== savedFrom && !keptForReopen))
        ) {
          await reread().catch(() => undefined);
        }
        ledger.finish(savedFrom);
      }
    },
  });
  const ledger = saveLedgerOf(form);
  useLayoutEffect(() => {
    openRef.current = open;
    shownRef.current = session;
    ledger.show(session);
  }, [open, session, ledger]);

  // Follows `fresh` per field into an open form. A field is tested only when
  // its own fresh value moved (the open counts as the first move), never on
  // typing, so a field typed back to its seed is replaced only by a later move.
  // No listeners run: a follow is not an edit, so it retires no partial-save line.
  const followRef = useRef<FollowRecord | null>(null);
  const freshTitle = opts.fresh?.title;
  const freshBody = opts.fresh?.body;
  const liveDraftKey = opts.attach?.draftKey ?? null;
  useLayoutEffect(() => {
    const record = followRef.current;
    if (record === null || session === null || record.session !== session)
      return;
    if (formSessionRef.current !== session || session.draftKey !== liveDraftKey)
      return;
    if (freshTitle === undefined || freshBody === undefined) return;
    const arrived = { title: freshTitle, body: freshBody };
    for (const name of ["title", "body"] as const) {
      const value = arrived[name];
      if (record.seen[name] === value) continue;
      record.seen[name] = value;
      const seeded = record.seeded[name];
      if (value === seeded || form.getFieldValue(name) !== seeded) continue;
      form.setFieldValue(name, value, { dontRunListeners: true });
      record.seeded[name] = value;
    }
  }, [session, liveDraftKey, freshTitle, freshBody, form]);

  // The description a partial save of a session re-seeded, a baseline only
  // `untouchedBaseline` reads: were the follow to read it, a `fresh` move would
  // replace the re-seed and drop the failed images' references it appended.
  const reseededRef = useRef<{ session: EditSession; body: string } | null>(
    null,
  );

  /** Which baseline the shown session's `name` field still holds: "seeded" for
   *  what it was seeded with or last followed to (the follow's own test),
   *  "reseeded" for the description a partial save of that session re-seeded
   *  it to; null when edited or with no record for that session. Reads refs
   *  and form state: effects and handlers only. */
  function untouchedBaseline(
    name: "title" | "body",
  ): "seeded" | "reseeded" | null {
    const record = followRef.current;
    if (record === null || record.session !== shownRef.current) return null;
    const value = form.getFieldValue(name);
    if (value === record.seeded[name]) return "seeded";
    const reseeded = reseededRef.current;
    return name === "body" &&
      reseeded !== null &&
      reseeded.session === record.session &&
      value === reseeded.body
      ? "reseeded"
      : null;
  }

  /** Reopens the form's draft of this item when a save of it is still running
   *  or failed while closed, keeping its text, images and session (a running
   *  save's settle closes only the session it captured). False otherwise. */
  function resumeEdit(): boolean {
    const draftKey = opts.attach?.draftKey ?? null;
    const held = formSessionRef.current;
    if (draftKey === null || held === null || held.draftKey !== draftKey)
      return false;
    if (inFlightRef.current !== held && failedWhileClosedRef.current !== held)
      return false;
    failedWhileClosedRef.current = null;
    setSession(held);
    setOpenState(true);
    return true;
  }

  function openEdit(seed: { title: string; body: string }) {
    if (resumeEdit()) return;
    const draftKey = opts.attach?.draftKey ?? null;
    const kept = failedWhileClosedRef.current?.draftKey ?? null;
    failedWhileClosedRef.current = null;
    if (kept !== null) endDraftAttachments(kept);
    if (draftKey !== null) endDraftAttachments(draftKey);
    // keepDefaultValues: otherwise the per-render options sync clobbers the
    // seeded values back to empty (untouched form).
    form.reset(seed, { keepDefaultValues: true });
    const next = { draftKey };
    formSessionRef.current = next;
    followRef.current = {
      session: next,
      seeded: { title: seed.title, body: seed.body },
      seen: { title: undefined, body: undefined },
    };
    setSession(next);
    setOpenState(true);
  }

  // Ends a closed session's staged images on the open→closed edge only, so an
  // <Activity> replay ends nothing. A save in flight keeps them (a landed settle
  // ends them; a failed one leaves them only with a draft it shows or keeps), as
  // does a failure kept before a close edge that runs after it.
  const lastSessionRef = useRef(session);
  useEffect(() => {
    const previous = lastSessionRef.current;
    lastSessionRef.current = session;
    if (previous === null || previous === session || previous.draftKey === null)
      return;
    if (
      previous !== inFlightRef.current &&
      previous !== failedWhileClosedRef.current
    )
      endDraftAttachments(previous.draftKey);
  }, [session]);

  /** Whether `draftKey` is the open session's draft: the handle's writer writes
   *  the form's body only then. */
  function ownsDraft(draftKey: string): boolean {
    return sessionRef.current?.draftKey === draftKey;
  }

  return {
    form,
    open,
    setOpen,
    openEdit,
    resumeEdit,
    ownsDraft,
    untouchedBaseline,
  };
}

/** Render props for the dialog. `withForm` infers required render props from the
 *  keys of the `props` object literal, so a truly-optional prop must be declared
 *  here with `?` and the literal cast to this type — otherwise every caller
 *  (the issue views) would be forced to pass `bodyActions`. */
interface EditTitleBodyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  contentClassName: string | undefined;
  bodyTextareaClassName: string;
  /** Optional actions rendered in the description field header (e.g. an AI
   *  "Generate" button). Absent ⇒ the field renders exactly as before. */
  bodyActions?: ReactNode;
  /** Runs the consumer's AI Generate. Present ONLY when the consumer has a live
   *  Generate surface (AI enabled); its presence is the gate for intercepting the
   *  generate chord. The issue views omit it (no Generate), so the chord falls
   *  through there untouched. */
  onGenerate?: () => void;
  /** True while a generation is in flight (undefined ⇒ false): the generate chord
   *  swallows without re-triggering, and mod+enter swallows without submitting. */
  generating?: boolean;
  /** Mirrors the Generate button's disabled state (undefined ⇒ false): the chord
   *  still swallows but doesn't run. */
  generateDisabled?: boolean;
  /** Optional content rendered between the body field and the footer (e.g. the
   *  linked-issue chip cluster on the PR edit paths). Optional exactly like
   *  `onGenerate` — the issue views omit it, so they compile untouched and render
   *  byte-identically. */
  belowBody?: ReactNode;
  /** Opt in to `@`/`#`/`!` autocomplete in the description field, matching the
   *  composer below the thread. Local views pass it because their rendered bodies
   *  linkify those references; the editor's own preview deliberately doesn't. */
  mentions?: MentionSource;
  /** Opt in to image attachments in the description (the remote views, with
   *  `attach` on the hook). Absent ⇒ the dialog renders exactly as before. */
  attachments?: DraftAttachmentsHandle;
  /** The description Preview's hosted-image source; see `MarkdownEditor`. */
  hostedImages?: MarkdownHostedImages;
}

export const EditTitleBodyDialog = withForm({
  ...editTitleBodyFormOpts,
  props: {
    open: false,
    onOpenChange: (_open: boolean) => {
      // Default no-op for type inference; callers always pass a real handler.
    },
    title: "",
    description: null as ReactNode,
    contentClassName: undefined as string | undefined,
    bodyTextareaClassName: "max-h-72",
    bodyActions: undefined as ReactNode,
    onGenerate: undefined as (() => void) | undefined,
    generating: undefined as boolean | undefined,
    generateDisabled: undefined as boolean | undefined,
    belowBody: undefined as ReactNode,
    mentions: undefined as MentionSource | undefined,
    attachments: undefined as DraftAttachmentsHandle | undefined,
    hostedImages: undefined as MarkdownHostedImages | undefined,
  } as EditTitleBodyDialogProps,
  render: function EditTitleBodyDialogRender({
    form,
    open,
    onOpenChange,
    title,
    description,
    contentClassName,
    bodyTextareaClassName,
    bodyActions,
    onGenerate,
    generating,
    generateDisabled,
    belowBody,
    mentions,
    attachments,
    hostedImages,
  }) {
    // Context-sensitive reuse of the `generate-commit-message` binding while
    // this dialog is open. This dialog is shared with the ISSUE views, which
    // pass no `onGenerate` (they have no Generate) — the chord then falls
    // through untouched instead of being swallowed for nothing.
    const generateChord = useGenerateChord({
      enabled: !generating && !generateDisabled,
      run: onGenerate,
    });
    const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
    // The shown item's save record (its save, then any re-read it waits on),
    // whichever session started it. form-core clears `isSubmitting` on a reset
    // and at any submission's end, so with `attach` it adds only a validating
    // submit; without it, the whole hold.
    const ledger = saveLedgerOf(form);
    const shownSave = shownSaveOf(
      useSyncExternalStore(ledger.subscribe, ledger.get),
    );
    const saveRunning = shownSave.running || isSubmitting;
    // A generation rewrites the body and a running save already sent it, so
    // both hold Attach and chip Remove.
    const descAttachments = attachments?.withHold(
      (() => {
        switch (true) {
          case generating:
            return AI_DRAFT_PENDING_REASON;
          case attachments.posting > 0:
            return uploadingReason(attachments.posting, "saving");
          case saveRunning:
            return ACT_PENDING_REASON;
          default:
            return null;
        }
      })(),
    );
    const attaching = attachments?.attaching === true;
    // A generation, an image still attaching and, with `attach`, the shown
    // item's save record from any session hold Save with a reason, so it keeps
    // focus and says why. Other items' saves hold nothing here.
    const saveHold = useDisabledReason({
      disabled: generating || attaching || saveRunning,
      reason: (() => {
        switch (true) {
          case saveRunning && !!attachments:
            return ACT_PENDING_REASON;
          case generating:
            return AI_DRAFT_PENDING_REASON;
          case attaching:
            return ATTACHING_REASON;
          default:
            return null;
        }
      })(),
      title: SUBMIT_HINT,
    });
    const notice = attachments?.notice
      ? partialEditNotice(attachments.notice.failed)
      : null;
    // A save carrying images disables the description, dropping focus out of the
    // form; the settle that leaves the dialog open hands it back once that
    // control is enabled again.
    const formRef = useRef<HTMLFormElement>(null);
    const focusAtSubmitRef = useRef<Element | null>(null);
    const wasSavingRef = useRef(saveRunning);
    useLayoutEffect(() => {
      const was = wasSavingRef.current;
      wasSavingRef.current = saveRunning;
      if (!was || saveRunning) return;
      const target = focusAtSubmitRef.current;
      focusAtSubmitRef.current = null;
      // A save that closes the dialog commits that close (flushSync) before
      // its record clears, so this edge reads `open` false and never focuses
      // inside the closing popup.
      if (!open) return;
      const root = formRef.current;
      if (!(target instanceof HTMLElement) || !root?.contains(target)) return;
      if (!root.contains(document.activeElement)) target.focus();
    }, [saveRunning, open]);
    // A reasoned hold keeps Save focusable. When it ends on a Save the form
    // still disables natively (an invalid title, a validating submit), the
    // engine drops that focus to the page, so it moves to Title, the field the
    // user must act on. Only from Save (tracked by its own focus events, not by
    // what the engine reports after the disable), never into a closing dialog.
    const titleId = useId();
    const canSubmit = useSelector(form.store, (s) => s.canSubmit);
    const saveHeld = !!saveHold.blockedReason;
    const saveDisabled =
      !!generating || attaching || saveRunning || !canSubmit || isSubmitting;
    const saveFocusRef = useRef<HTMLElement | null>(null);
    const wasHeldRef = useRef(saveHeld);
    useLayoutEffect(() => {
      const was = wasHeldRef.current;
      wasHeldRef.current = saveHeld;
      if (!was || saveHeld || !saveDisabled || !open) return;
      const save = saveFocusRef.current;
      if (!save?.isConnected) return;
      const active = document.activeElement;
      if (active !== save && formRef.current?.contains(active)) return;
      document.getElementById(titleId)?.focus();
    }, [saveHeld, saveDisabled, open, titleId]);
    function submit() {
      // The chord's and form submit's guard (a held Save refuses its own click):
      // a generation, the shown item's save record from any session (its save,
      // then any re-read it waits on), or
      // form-core's flag (all of it without `attach`, a validating submit with).
      if (
        generating ||
        form.state.isSubmitting ||
        shownSaveOf(ledger.get()).running
      )
        return;
      if (attaching) {
        attachments?.noteSubmitHeld();
        return;
      }
      if (attachments) focusAtSubmitRef.current = document.activeElement;
      form.handleSubmit();
    }
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={contentClassName}
          // Captured on DialogContent (the Popup), not the <form>: the X close is
          // a form SIBLING, so only a Popup-level handler lets mod+enter submit
          // and, when the consumer has a Generate, the generate chord run from
          // every field and the X (parity with CreateLocalPrDialog). A consumer
          // without `onGenerate` (the issue views) lets the generate chord through;
          // under this modal the listener reaches only the modal's own entries.
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              // While generating, swallow but don't submit — matches the create
              // dialogs. Field validators still gate an invalid submit. A held
              // chord's autorepeat never submits.
              if (!generating && !e.repeat) submit();
              return;
            }
            generateChord.onKeyDown(e);
          }}
        >
          {/* min-w-0: DialogContent is a grid; without this the form's content
              (long titles, code in the editor) can't shrink and overflows. */}
          <form
            ref={formRef}
            className="min-w-0 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle className="pr-8">{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            {/* The line's words reach assistive tech through the always-mounted
                region below: a live region inserted with its text is often not
                announced. */}
            {notice && (
              <p aria-hidden className="flex items-start gap-1.5 text-xs">
                <WarningIcon className="mt-px size-3.5 shrink-0 text-warning" />
                <span>{notice}</span>
              </p>
            )}
            {attachments && (
              <span aria-live="polite" className="sr-only">
                {notice}
              </span>
            )}
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
              listeners={
                attachments
                  ? { onChange: () => attachments.noteEdited() }
                  : undefined
              }
            >
              {(field) => <field.TextField label="Title" id={titleId} />}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Description"
                  rows={8}
                  textareaClassName={bodyTextareaClassName}
                  actions={bodyActions}
                  mentions={mentions}
                  attachments={descAttachments}
                  hostedImages={hostedImages}
                  // Locked while this session's own save carries images, whose
                  // partial outcome re-seeds it. Text typed during a save without
                  // images is dropped when it lands, as the title's always was.
                  disabled={
                    attachments
                      ? shownSave.own && attachments.posting > 0
                      : undefined
                  }
                />
              )}
            </form.AppField>
            {belowBody}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <form.AppForm>
                {/* Held while generating: the mouse path must match the chord
                    path's !generating gate, or a click could persist a
                    half-streamed title/body (create dialogs do the same). */}
                <span
                  className={cn(
                    "inline-flex",
                    saveHold.blockedReason && "cursor-not-allowed",
                  )}
                  title={saveHold.wrapperTitle}
                >
                  <form.SubmitButton
                    focusableWhenDisabled={!!saveHold.blockedReason}
                    disabled={generating || attaching || saveRunning}
                    pending={shownSave.running}
                    aria-describedby={saveHold.describedBy}
                    // The shortcut hint describes Save unless a reason holds it; the
                    // reason then takes its description and the wrapper's hover.
                    title={saveHold.blockedReason ? undefined : SUBMIT_HINT}
                    className={ARIA_DISABLED_CLASS}
                    onKeyDown={ignoreHeldEnter}
                    onFocus={(e) => {
                      saveFocusRef.current = e.currentTarget;
                    }}
                    onBlur={() => {
                      saveFocusRef.current = null;
                    }}
                  >
                    Save
                  </form.SubmitButton>
                  {saveHold.blockedReason ? (
                    <span id={saveHold.reasonId} className="sr-only">
                      {saveHold.blockedReason}
                    </span>
                  ) : null}
                </span>
              </form.AppForm>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  },
});
