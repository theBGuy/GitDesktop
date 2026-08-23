import { formOptions } from "@tanstack/react-form";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { required, useAppForm, withForm } from "@/lib/form";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { toastError } from "@/lib/toast";
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
  /** Persists the edit (title is pre-trimmed; body is sent as typed). */
  onSave: (value: { title: string; body: string }) => Promise<void>;
  /** Shown after a successful save (remote views); omitted for local views. */
  successToast?: string;
}) {
  const [open, setOpen] = useState(false);
  const form = useAppForm({
    ...editTitleBodyFormOpts,
    onSubmit: async ({ value }) => {
      try {
        await opts.onSave({ title: value.title.trim(), body: value.body });
        setOpen(false);
        if (opts.successToast) toast.success(opts.successToast);
      } catch (e) {
        toastError(e);
      }
    },
  });

  function openEdit(seed: { title: string; body: string }) {
    // keepDefaultValues: otherwise the per-render options sync clobbers the
    // seeded values back to empty (untouched form).
    form.reset(seed, { keepDefaultValues: true });
    setOpen(true);
  }

  return { form, open, setOpen, openEdit };
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
   *  composer below the thread. The local views omit it (nothing autolinks a
   *  local body). */
  mentions?: MentionSource;
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
  }) {
    // Context-sensitive reuse of the `generate-commit-message` binding while
    // this dialog is open. This dialog is shared with the ISSUE views, which
    // pass no `onGenerate` (they have no Generate) — the chord then falls
    // through untouched instead of being swallowed for nothing.
    const generateChord = useGenerateChord({
      enabled: !generating && !generateDisabled,
      run: onGenerate,
    });
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
          // unconditionally, and the generate chord on every match for as long as
          // the consumer HAS a Generate. A consumer that passes no `onGenerate`
          // (the issue views) lets it fall through untouched, which is safe:
          // the only global handler is CommitBox's, and it runs nothing unless
          // it is both mounted (Changes tab only) and enabled (never under
          // Hide-AI) — the listener runs the newest ENABLED handler or none.
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              // While generating, swallow but don't submit — matches the create
              // dialogs. Field validators still gate an invalid submit.
              if (!generating) form.handleSubmit();
              return;
            }
            generateChord.onKeyDown(e);
          }}
        >
          {/* min-w-0: DialogContent is a grid; without this the form's content
              (long titles, code in the editor) can't shrink and overflows. */}
          <form
            className="min-w-0 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
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
                <form.SubmitButton disabled={generating} title={SUBMIT_HINT}>
                  Save
                </form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  },
});
