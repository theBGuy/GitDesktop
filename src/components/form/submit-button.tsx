import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useFormContext } from "@/lib/form-context";

/**
 * Submit button bound to the surrounding form (use inside `<form.AppForm>`):
 * disabled until the form can submit, spinner while submitting. Extra
 * `disabled` reasons (e.g. an AI generation in flight) are OR'd in, and every
 * other prop reaches the Button — a caller explaining a disabled submit points
 * `aria-describedby` at its own hint.
 */
export function SubmitButton({
  children,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { children: ReactNode }) {
  const form = useFormContext();
  return (
    <form.Subscribe
      selector={(state) => [state.canSubmit, state.isSubmitting] as const}
    >
      {([canSubmit, isSubmitting]) => (
        <Button
          type="submit"
          disabled={!canSubmit || isSubmitting || disabled}
          {...props}
        >
          {isSubmitting && <Spinner data-icon="inline-start" />}
          {children}
        </Button>
      )}
    </form.Subscribe>
  );
}
