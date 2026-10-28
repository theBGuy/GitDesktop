import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useFormContext } from "@/lib/form-context";
import { heldButtonRender } from "@/lib/use-disabled-reason";

/**
 * Submit button bound to the surrounding form (use inside `<form.AppForm>`):
 * disabled until the form can submit, spinner while submitting. Extra
 * `disabled` reasons (e.g. an AI generation in flight) are OR'd in, and every
 * other prop reaches the Button — a caller explaining a disabled submit points
 * `aria-describedby` at its own hint. The exception is `render`, which a
 * reasoned hold replaces while it stands (no caller passes one).
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
      {([canSubmit, isSubmitting]) => {
        const held = !canSubmit || isSubmitting || disabled;
        return (
          <Button
            type="submit"
            disabled={held}
            {...props}
            // A caller's reasoned hold keeps every key but activation
            // reaching the app, as on DisabledReasonButton.
            render={heldButtonRender(
              Boolean(held && props.focusableWhenDisabled),
              props.render,
            )}
          >
            {isSubmitting && <Spinner data-icon="inline-start" />}
            {children}
          </Button>
        );
      }}
    </form.Subscribe>
  );
}
