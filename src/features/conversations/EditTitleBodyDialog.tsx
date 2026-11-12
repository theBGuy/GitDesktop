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
  const [session, setSession] = useState<{ draftKey: string | null } | null>(
    null,
  );
  const sessionRef = useLatestRef(session);
  const setOpen: Dispatch<SetStateAction<boolean>> = (action) => {
    const next = typeof action === "function" ? action(open) : action;
    if (!next) setSession(null);
    setOpenState(next);
  };
  const form = useAppForm({
    ...editTitleBodyFormOpts,
    onSubmit: async ({ value }) => {
      const savedFrom = sessionRef.current;
      const attach = opts.attach;
      const begun: { ticket: PostTicket | null; finalBody: string } = {
        ticket: null,
        finalBody: value.body,
      };
      const begin = attach
        ? (finalBody: string) => {
            begun.ticket = beginAttachmentPost(
              attach.draftKey,
              finalBody,
              false,
            );
            begun.finalBody = finalBody;
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
        if (begun.ticket)
          settleAttachmentPost(begun.ticket, { posted: false, failed: [] });
        if (sessionRef.current === savedFrom && otherChangesSaved(e))
          attach?.onPartialSaved?.();
        toastError(e);
        return;
      }
      const same = sessionRef.current === savedFrom;
      const failed = attach ? failedAttachmentsOf(outcome) : [];
      if (attach === undefined || failed.length === 0) {
        if (begun.ticket)
          settleAttachmentPost(begun.ticket, { posted: true, failed: [] });
        // flushSync: the close must commit before form-core clears
        // `isSubmitting`, which the dialog's focus hand-back keys on.
        if (same) flushSync(() => setOpen(false));
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
        const missing = failed.filter((name) => !referencesName(seeded, name));
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
      toast.warning(updatedWarning(attach.kind, failed));
    },
  });

  function openEdit(seed: { title: string; body: string }) {
    const draftKey = opts.attach?.draftKey ?? null;
    if (draftKey !== null) endDraftAttachments(draftKey);
    // keepDefaultValues: otherwise the per-render options sync clobbers the
    // seeded values back to empty (untouched form).
    form.reset(seed, { keepDefaultValues: true });
    setSession({ draftKey });
    setOpenState(true);
  }

  // Ends a closed session's staged images on the open→closed edge only, so an
  // <Activity> replay ends nothing; a save in flight defers it to its settle.
  const lastSessionRef = useRef(session);
  useEffect(() => {
    const previous = lastSessionRef.current;
    lastSessionRef.current = session;
    if (previous !== null && previous !== session && previous.draftKey !== null)
      endDraftAttachments(previous.draftKey);
  }, [session]);

  /** Whether `draftKey` is the open session's draft: the handle's writer writes
   *  the form's body only then. */
  function ownsDraft(draftKey: string): boolean {
    return sessionRef.current?.draftKey === draftKey;
  }

  return { form, open, setOpen, openEdit, ownsDraft };
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
    // A generation rewrites the body and a running save already sent it, so
    // both hold Attach and chip Remove.
    const descAttachments = attachments?.withHold(
      (() => {
        switch (true) {
          case generating:
            return AI_DRAFT_PENDING_REASON;
          case attachments.posting > 0:
            return uploadingReason(attachments.posting, "saving");
          case isSubmitting:
            return ACT_PENDING_REASON;
          default:
            return null;
        }
      })(),
    );
    const attaching = attachments?.attaching === true;
    const saveHold = useDisabledReason({
      disabled: attaching,
      reason: attaching ? ATTACHING_REASON : null,
      title: SUBMIT_HINT,
    });
    const notice = attachments?.notice
      ? partialEditNotice(attachments.notice.failed)
      : null;
    // A save disables the control that started it (Save, or the description
    // while images ride it), dropping focus out of the form; the settle that
    // leaves the dialog open hands it back once that control is enabled again.
    const formRef = useRef<HTMLFormElement>(null);
    const focusAtSubmitRef = useRef<Element | null>(null);
    const wasSubmittingRef = useRef(isSubmitting);
    useLayoutEffect(() => {
      const was = wasSubmittingRef.current;
      wasSubmittingRef.current = isSubmitting;
      if (!was || isSubmitting) return;
      const target = focusAtSubmitRef.current;
      focusAtSubmitRef.current = null;
      // A save that closes the dialog commits that close (flushSync) before
      // form-core clears `isSubmitting`, so this edge reads `open` false and
      // never focuses inside the closing popup.
      if (!open) return;
      const root = formRef.current;
      if (!(target instanceof HTMLElement) || !root?.contains(target)) return;
      if (!root.contains(document.activeElement)) target.focus();
    }, [isSubmitting, open]);
    function submit() {
      // form-core does not refuse a submit while one is running (its can-submit
      // gate covers only a first attempt), so this return is the only guard
      // against a second write.
      if (form.state.isSubmitting) return;
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
                  // A partial save re-seeds the description, so text typed
                  // during an image-carrying save would be lost.
                  disabled={attachments ? isSubmitting : undefined}
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
                      disabled={generating || attaching}
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
