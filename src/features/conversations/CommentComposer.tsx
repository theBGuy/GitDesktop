import type { ReactNode, Ref } from "react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { formatBinding } from "@/lib/hotkeys/binding";

/** Platform-correct submit hint (Cmd+Enter on macOS, Ctrl+Enter else) — never a
 *  literal modifier (house platform-mod-key rule). */
export const SUBMIT_HINT = formatBinding("mod+enter");

/**
 * The bottom "leave a comment" bar every conversation surface ends with. The
 * draft lives in CALLER state — each view clears it when the entity it shows
 * changes, which a composer-owned draft would silently break — so this is a
 * fully controlled component. Per-surface extras (Approve, Close, Review…) ride
 * the `actions` slot rather than growing the prop list.
 */
export function CommentComposer({
  ref,
  value,
  onChange,
  onSubmit,
  onClear,
  submitLabel,
  ariaLabel,
  placeholder,
  busy,
  disabled,
  actions,
}: {
  /** The editor handle, so a caller can focus/fill the box from elsewhere
   *  (quote reply). */
  ref?: Ref<MarkdownEditorHandle>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Present to offer Clear — it shows only while the draft is non-empty. */
  onClear?: () => void;
  submitLabel: string;
  ariaLabel: string;
  placeholder: string;
  /** A submit is in flight: gates the chord, the submit button and Clear. */
  busy?: boolean;
  /** Freeze the text input too — only surfaces that block typing mid-submit
   *  pass it. */
  disabled?: boolean;
  /** Extra buttons rendered after submit, before Clear. */
  actions?: ReactNode;
}) {
  const hasDraft = value.trim().length > 0;
  return (
    <div className="space-y-2 border-t p-3">
      <MarkdownEditor
        ref={ref}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            // preventDefault unconditionally: `commit` is bound to mod+enter and
            // fires inside editable targets, so a chord this handler declines to
            // submit would otherwise reach the global action.
            e.preventDefault();
            if (hasDraft && !busy) onSubmit();
          }
        }}
        rows={2}
        disabled={disabled}
        textareaClassName="max-h-32 min-h-12 resize-y"
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasDraft || busy}
          onClick={onSubmit}
          title={SUBMIT_HINT}
        >
          {submitLabel}
        </Button>
        {actions}
        {onClear && hasDraft && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={busy}
            onClick={onClear}
            title="Discard this draft (e.g. a quote reply)"
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
