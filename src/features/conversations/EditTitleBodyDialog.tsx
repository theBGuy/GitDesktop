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
import { toastError } from "@/lib/toast";

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
  }) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={contentClassName}>
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
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <form.AppForm>
                <form.SubmitButton>Save</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  },
});
