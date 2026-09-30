import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useFormContext } from "@/lib/form-context";
import { passThroughNonActivationKeys } from "@/lib/use-disabled-reason";

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
      {([canSubmit, isSubmitting]) => {
        const held = !canSubmit || isSubmitting || disabled;
        return (
          <Button
            type="submit"
            disabled={held}
            {...props}
            // Same pass-through, and the same stop on keyboard-synthesized
            // clicks, as DisabledReasonButton for a caller's reasoned hold; no
            // `type` on it, which would override "submit".
            render={
              held && props.focusableWhenDisabled ? (
                <button
                  onKeyDown={passThroughNonActivationKeys}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                props.render
              )
            }
          >
            {isSubmitting && <Spinner data-icon="inline-start" />}
            {children}
          </Button>
        );
      }}
    </form.Subscribe>
  );
}
