import { useEffect, useRef } from "react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";

/**
 * The inline comment editor: a markdown box with Save/Cancel swapped in for a
 * rendered comment body. Shared by the PR/issue/discussion, local, Jira and
 * pending-review-draft comment surfaces.
 *
 * Controlled and close-agnostic — the caller owns the draft and decides when to
 * leave edit mode, so a fire-and-forget saver and a mutation-driven one (which
 * holds the editor open and `pending` until the write lands) both fit.
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Whether the draft is savable — the caller derives it (empty / unchanged). */
  canSubmit: boolean;
  /** A save is in flight: freezes the editor and both buttons. Mutation-driven
   *  callers pass it; fire-and-forget ones leave it unset. */
  pending?: boolean;
  ariaLabel?: string;
  textareaClassName?: string;
}) {
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Focus one frame LATE: the actions DropdownMenu that opened this editor
  // returns focus to its trigger as it closes, landing AFTER the textarea mounts
  // and stealing it.
  useEffect(() => {
    const raf = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="space-y-2">
      <MarkdownEditor
        ref={editorRef}
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            // preventDefault unconditionally: `commit` is bound to mod+enter and
            // fires inside editable targets, so a chord this handler declines to
            // submit would otherwise reach the global action.
            e.preventDefault();
            if (canSubmit && !pending) onSubmit();
          }
        }}
        rows={3}
        disabled={pending}
        textareaClassName={textareaClassName}
      />
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!canSubmit || pending}
          onClick={onSubmit}
          title={SUBMIT_HINT}
        >
          Save
        </Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
