import { WarningIcon } from "@phosphor-icons/react";
import { formOptions } from "@tanstack/react-form";
import { useSelector } from "@tanstack/react-store";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
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
import { otherChangesSaved } from "@/lib/error-summary";
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

// Edit rules with `attach` (an item is its draft key): one save per item per
// instance, Save held on that item only; a reopen resumes the draft only while
// the form still holds its session, and a save failing while closed keeps its
// text and images for the first such reopen; a settle ends only the images its
// own save started with. Not covered: a host remount drops the hold and the
// keep, and a fresh form opened during a save shows the pre-save values.
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
  /** Image attachments (remote hosts only). The draft key, not the handle: the
   *  host builds its handle from this hook's `open` and `form`. */
  attach?: {
    draftKey: string;
    kind: ItemKind;
    /** The host's on-open body seeding; default identity. */
    seedBody?: (stored: string) => string;
    /** A save of the same session that kept failed images, or failed after
     *  saving its other changes. */
    onPartialSaved?: () => void;
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
      try {
        inFlightRef.current = savedFrom;
        const attach = opts.attach;
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
          if (keep) failedWhileClosedRef.current = savedFrom;
          else if (!shown) endLeftDraft(savedFrom, begun.gen);
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
          const seeded = attach.seedBody?.(body) ?? body;
          const missing = failed.filter(
            (name) => !referencesName(seeded, name),
          );
          form.setFieldValue(
            "body",
            missing.length === 0
              ? seeded
              : withFailedReferences(
                  seeded,
                  failedReferencesDraft(begun.finalBody, missing),
                ),
          );
          attach.onPartialSaved?.();
          return;
        }
        if (same) flushSync(() => setOpen(false));
        else endLeftDraft(savedFrom, begun.gen);
        toast.warning(updatedWarning(attach.kind, failed));
      } finally {
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

  return { form, open, setOpen, openEdit, resumeEdit, ownsDraft };
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
    // The shown item's running save, whichever session started it. form-core
    // clears `isSubmitting` on a reset and at any submission's end, so with
    // `attach` it adds only a validating submit; without it, the whole hold.
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
    // A running save of the shown item, from this session or an older one, and
    // an image still attaching hold Save with a reason, so it keeps focus and
    // says why. Other items' saves hold nothing here.
    const saveHold = useDisabledReason({
      disabled: attaching || saveRunning,
      reason: (() => {
        switch (true) {
          case saveRunning:
            return ACT_PENDING_REASON;
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
    function submit() {
      // The chord's and form submit's guard (a held Save refuses its own click):
      // the shown item's running save, from any session, or form-core's flag:
      // the whole guard without `attach`, only a validating submit with it.
      if (form.state.isSubmitting || shownSaveOf(ledger.get()).running) return;
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
          // mod+enter submits from anywhere in the dialog, and (when the consumer
          // has a Generate surface) the generate-commit-message chord runs its
          // Generate — parity with the create dialogs (CreateLocalPrDialog). It's
          // captured on DialogContent (the Popup), not the <form>: the X close
          // button renders as a form SIBLING inside the Popup, so a form-level
          // handler misses a chord pressed with focus on the X, which would then
          // leak to the global commit / generate-commit-message actions behind the
          // dialog. Capturing on the Popup covers the X and every field, so the
          // preventDefault here is what actually contains each chord: mod+enter
          // unconditionally, and the generate chord whenever it may fire for as
          // long as the consumer HAS a Generate (the hook mirrors the global
          // listener's own guards). A consumer that passes no `onGenerate`
          // (the issue views) lets it fall through untouched, which is safe:
          // the only global handler is CommitBox's, and it runs nothing unless
          // it is both mounted (Changes tab only) and enabled (never under
          // Hide-AI) — the listener runs the newest ENABLED handler or none.
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
              {(field) => <field.TextField label="Title" />}
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
                {/* disabled while generating: the mouse path must match the chord
                    path's !generating gate, or a click could persist a
                    half-streamed title/body (create dialogs do the same). */}
                {attachments ? (
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
                      className={ARIA_DISABLED_CLASS}
                      onKeyDown={ignoreHeldEnter}
                    >
                      Save
                    </form.SubmitButton>
                    {saveHold.blockedReason ? (
                      <span id={saveHold.reasonId} className="sr-only">
                        {saveHold.blockedReason}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <form.SubmitButton disabled={generating} title={SUBMIT_HINT}>
                    Save
                  </form.SubmitButton>
                )}
              </form.AppForm>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  },
});
