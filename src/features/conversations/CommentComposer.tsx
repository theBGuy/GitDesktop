import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode, Ref } from "react";
import { useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useComposerCollapsed } from "./useComposerCollapsed";
import type { MentionSource } from "./useMentionCandidates";

/**
 * The scroll region the composer docks under, searched depth-first from the
 * sibling above it (every surface lays the composer out as an in-flow sibling
 * below its scrolling conversation). Null when there is none — the anchoring it
 * feeds is best-effort.
 */
function findScrollRegion(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  const { overflowY } = getComputedStyle(el);
  if (
    (overflowY === "auto" || overflowY === "scroll") &&
    el.scrollHeight > el.clientHeight
  ) {
    return el;
  }
  for (const child of el.children) {
    const found = findScrollRegion(child);
    if (found) return found;
  }
  return null;
}

/**
 * The bottom "leave a comment" bar every conversation surface ends with. Fully
 * controlled: the draft lives in CALLER state, keyed there per entity so a
 * switch retains it, which a composer-owned draft could not do. Per-surface
 * extras (Approve, Close, Review…) ride the `actions`/`leadingActions` slots
 * rather than growing the prop list — and they keep rendering while the box is
 * collapsed, since they are the surface's primary write actions.
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
  leadingActions,
  mentions,
}: {
  /** The editor handle, so a caller can focus/fill the box from elsewhere
   *  (quote reply). Both methods expand a collapsed box first. */
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
  /** Extra buttons rendered before submit — for a surface whose submit is not
   *  the row's first action. Everything up to that boundary is the caller's to
   *  lay out, spacers included. */
  leadingActions?: ReactNode;
  /** Opt in to `@`/`#`/`!` autocomplete — only surfaces whose forge autolinks the
   *  completed reference pass one. */
  mentions?: MentionSource;
}) {
  const hasDraft = value.trim().length > 0;
  // Only the `busy` hold gets words: an empty draft explains itself, and a reason
  // there would add a tab stop for every viewer who simply hasn't typed yet.
  const blockedReason = busy ? (reason ?? null) : null;
  const showClear = !!onClear && hasDraft;
  const editorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  // Set by an expand that started with the conversation scrolled to its bottom,
  // consumed by the layout effect that re-pins it.
  const repinRef = useRef(false);
  // What the expanded/collapsed render owes the user once it commits. The
  // un-hide rides a react-query cache notify, whose batching can land after any
  // frame we might have scheduled, so every follow-up is keyed on the render
  // that actually flipped `collapsed` — never on wall clock.
  const pendingRef = useRef<"focus" | "preview" | null>(null);
  const pendingPeekRef = useRef(false);

  const { collapsed, setCollapsed, toggle } = useComposerCollapsed(
    () => expand("focus"),
    collapse,
  );

  /** Reveal the box, and record what the expanded render owes: focus, or the
   *  Preview tab. */
  function expand(then: "focus" | "preview") {
    // Growing the box shrinks the scroll region above it, which would carry the
    // last comment off-screen for a reader sitting at the bottom.
    const region = findScrollRegion(
      rootRef.current?.previousElementSibling ?? null,
    );
    const pinned =
      !!region &&
      region.scrollHeight - region.scrollTop - region.clientHeight <= 8;
    // Arm follow-ups only on a real transition: a write the hook declined leaves
    // no commit to consume them, and a stale flag would fire on a later expand.
    const changed = setCollapsed(false);
    repinRef.current = changed && pinned;
    pendingRef.current = changed ? then : null;
  }

  function collapse() {
    // Both collapse routes destroy the control that fired them (the caret button
    // unmounts with the expanded row; the palette closes), so focus would fall to
    // <body> without re-homing it on the peek strip.
    pendingPeekRef.current = setCollapsed(true);
  }

  // No dependency list: the handle closes over `collapsed` and over locals the
  // compiler re-creates, and re-attaching it each render is cheaper than the
  // stale-closure risk of pinning it.
  useImperativeHandle(ref, () => ({
    focus() {
      if (collapsed) expand("focus");
      else editorRef.current?.focus();
    },
    showPreview() {
      if (collapsed) expand("preview");
      else editorRef.current?.showPreview();
    },
  }));

  // The collapse commit. Focus stranded inside the now-`display:none` editor is
  // blurred first, so anything anchored to it (an open autocomplete popover)
  // takes its own blur-dismiss path rather than relying on browser behavior.
  useLayoutEffect(() => {
    if (!collapsed) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      editorWrapRef.current?.contains(active)
    ) {
      active.blur();
    }
    if (!pendingPeekRef.current) return;
    pendingPeekRef.current = false;
    // One frame, inside the commit that mounted the strip: the palette dialog
    // returns focus to its trigger as it closes, and would otherwise win.
    requestAnimationFrame(() => peekRef.current?.focus());
  }, [collapsed]);

  // The expand commit. Re-pin before focusing — and the two can't fight anyway:
  // the scroll region is the composer's SIBLING, not an ancestor, so the
  // editor's `scrollIntoView({block:"nearest"})` cannot reach it.
  useLayoutEffect(() => {
    if (collapsed) return;
    if (repinRef.current) {
      repinRef.current = false;
      const region = findScrollRegion(
        rootRef.current?.previousElementSibling ?? null,
      );
      if (region) region.scrollTop = region.scrollHeight;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    // One frame, inside the commit that revealed the editor: a quote reply fires
    // from a Base UI menu whose close-time focus-return would otherwise steal it.
    requestAnimationFrame(() => {
      if (pending === "preview") editorRef.current?.showPreview();
      else editorRef.current?.focus();
    });
  }, [collapsed]);

  return (
    <div ref={rootRef} className="border-t p-3">
      {/* Hidden, not unmounted: the editor keeps its textarea mounted so a
          collapse round-trip can't wipe the native undo stack, and `hidden` also
          takes it out of the tab order and the accessibility tree. */}
      <div
        ref={editorWrapRef}
        id={editorId}
        hidden={collapsed}
        className="mb-2"
      >
        <MarkdownEditor
          ref={editorRef}
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
          mentions={mentions}
          textareaClassName="max-h-32 min-h-12 resize-y"
        />
      </div>
      {/* One row in both states, so the caller's actions mount once and keep
          their own state across a collapse — and the disclosure control holds the
          same left-edge slot either way, so collapsing leaves the pointer on the
          affordance that expands again rather than on a docked action. */}
      <div className="flex items-center gap-2">
        {collapsed && (
          <>
            <button
              ref={peekRef}
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground text-xs hover:text-foreground"
              aria-expanded={false}
              aria-controls={editorId}
              onClick={toggle}
            >
              <CaretRightIcon className="size-3 shrink-0" />
              {hasDraft && (
                <span className="shrink-0 rounded border px-1">Draft</span>
              )}
              <span className="truncate">
                {hasDraft ? value.trim().split("\n", 1)[0] : placeholder}
              </span>
            </button>
            {blockedReason && (
              <span className="shrink-0 text-muted-foreground text-xs">
                {blockedReason}
              </span>
            )}
          </>
        )}
        {!collapsed && (
          <button
            type="button"
            className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
            aria-expanded
            aria-controls={editorId}
            aria-label="Collapse the comment box"
            title="Collapse the comment box"
            onClick={collapse}
          >
            <CaretDownIcon className="size-3" />
          </button>
        )}
        {leadingActions}
        {!collapsed && (
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
        )}
        {actions}
        {!collapsed && showClear && (
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
