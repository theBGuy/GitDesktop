import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MarkdownHostedImages } from "@/components/markdown/markdown";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { focusIsLost } from "@/lib/focus-lost";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import {
  ARIA_DISABLED_CLASS,
  heldButtonRender,
} from "@/lib/use-disabled-reason";
import type { MentionSource } from "./useMentionCandidates";

/**
 * The inline comment editor: a markdown box with Save/Cancel swapped in for a
 * rendered comment body. Shared by the PR/issue/discussion, local, Jira and
 * pending-review-draft comment surfaces.
 *
 * Controlled and close-agnostic: the caller owns the draft and decides when to
 * leave edit mode. Every host holds the editor open and `pending` until its
 * write lands, and keeps it open with the text when the write fails.
 */
export function CommentEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  canSubmit,
  pending,
  ariaLabel,
  textareaClassName,
  mentions,
  hostedImages,
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  /** A returned promise resolving `false`, or rejecting, says the save failed:
   *  the field takes focus back whether or not a pending frame rendered. */
  onSubmit: () => void | Promise<boolean>;
  onCancel: () => void;
  /** Whether the draft is savable — the caller derives it (empty / unchanged). */
  canSubmit: boolean;
  /** A save is in flight: freezes the editor and both buttons, which stay
   *  focusable. */
  pending?: boolean;
  ariaLabel?: string;
  textareaClassName?: string;
  /** Opt in to `@`/`#`/`!` autocomplete — only surfaces whose forge autolinks the
   *  completed reference pass one. */
  mentions?: MentionSource;
  /** Preview's hosted-image source; see `MarkdownEditor`. */
  hostedImages?: MarkdownHostedImages;
  /** Focus the field on mount. Off for an editor a diff remounted with its
   *  text, which takes focus back only if it had it. */
  autoFocus?: boolean;
}) {
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Focus one frame LATE: the actions DropdownMenu that opened this editor
  // returns focus to its trigger as it closes, landing AFTER the textarea mounts
  // and stealing it.
  useEffect(() => {
    if (!autoFocus) return;
    const raf = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);

  // Focus never falls to <body> across a save: the freeze disables the field
  // and toolbar, so focus on one moves to the held Save, and a save that ends
  // with the editor still open hands it back to the field, caret at the end.
  // Both read the focus at that commit, so focus the user moved out stays.
  const rootRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  // A failed save's own signal: a rejection can settle before its pending
  // frame ever renders, so the edge above is never seen.
  const [failures, setFailures] = useState(0);
  const failedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `failures` is the commit of a failed save, read through `failedRef`
  useLayoutEffect(() => {
    const was = wasPending.current;
    wasPending.current = !!pending;
    const failed = failedRef.current && !pending;
    if (failed) failedRef.current = false;
    const root = rootRef.current;
    const active = document.activeElement;
    const inside = root !== null && active !== null && root.contains(active);
    if (pending && !was) {
      if (inside && active?.matches(":disabled")) saveRef.current?.focus();
    } else if ((failed || (!pending && was)) && (inside || focusIsLost())) {
      editorRef.current?.focus();
      const field = root?.querySelector("textarea");
      field?.setSelectionRange(field.value.length, field.value.length);
    }
  }, [pending, failures]);
  const submit = () => {
    const result = onSubmit();
    if (result === undefined) return;
    const fail = () => {
      failedRef.current = true;
      setFailures((n) => n + 1);
    };
    result.then((saved) => {
      if (!saved) fail();
    }, fail);
  };

  return (
    <div ref={rootRef} className="space-y-2" aria-busy={pending || undefined}>
      <MarkdownEditor
        ref={editorRef}
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if (eventToBinding(e) === "mod+enter") {
            // preventDefault unconditionally: `commit` is bound to mod+enter and
            // fires inside editable targets, so a chord this handler declines to
            // submit would otherwise reach the global action.
            e.preventDefault();
            if (canSubmit && !pending) submit();
          }
        }}
        rows={3}
        disabled={pending}
        textareaClassName={textareaClassName}
        mentions={mentions}
        hostedImages={hostedImages}
      />
      <div className="flex items-center gap-2">
        <Button
          ref={saveRef}
          size="xs"
          variant="outline"
          disabled={!canSubmit || pending}
          focusableWhenDisabled={!!pending}
          render={heldButtonRender(!!pending)}
          className={ARIA_DISABLED_CLASS}
          onClick={submit}
          title={SUBMIT_HINT}
        >
          Save
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          focusableWhenDisabled={!!pending}
          render={heldButtonRender(!!pending)}
          className={ARIA_DISABLED_CLASS}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
