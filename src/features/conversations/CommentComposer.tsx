import type { ReactNode, Ref } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";

/**
 * The bottom "leave a comment" bar every conversation surface ends with. Fully
 * controlled: the draft lives in CALLER state, keyed there per entity so a
 * switch retains it, which a composer-owned draft could not do. Per-surface
 * extras (Approve, Close, Review…) ride the `actions` slot rather than growing
 * the prop list.
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
  reason,
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
  /** Why `busy` holds — announced and shown on the buttons it disables. An empty
   *  draft is an ordinary form affordance and needs none. */
  reason?: string | null;
  /** Freeze the text input too — only surfaces that block typing mid-submit
   *  pass it. */
  disabled?: boolean;
  /** Extra buttons rendered after submit, before Clear. */
  actions?: ReactNode;
}) {
  const hasDraft = value.trim().length > 0;
  // Only the `busy` hold gets words: an empty draft explains itself, and a reason
  // there would add a tab stop for every viewer who simply hasn't typed yet.
  const blockedReason = busy ? (reason ?? null) : null;
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
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled={!hasDraft || busy}
          reason={blockedReason}
          onClick={onSubmit}
          title={SUBMIT_HINT}
        >
          {submitLabel}
        </DisabledReasonButton>
        {actions}
        {onClear && hasDraft && (
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            wrapperClassName="ml-auto"
            disabled={busy}
            reason={blockedReason}
            onClick={onClear}
            title="Discard this draft (e.g. a quote reply)"
          >
            Clear
          </DisabledReasonButton>
        )}
      </div>
    </div>
  );
}
