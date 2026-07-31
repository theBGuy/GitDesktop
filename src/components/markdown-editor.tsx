import {
  CodeIcon,
  type Icon,
  LinkIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextHIcon,
  TextItalicIcon,
} from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface MarkdownEditorHandle {
  /** Focus the input, switching to the Write tab first if needed. */
  focus: () => void;
  /** Switch to the Preview tab (e.g. after generating content into it). */
  showPreview: () => void;
}

/** A formatting operation a toolbar button (or shortcut) performs. */
type FormatAction =
  | { kind: "wrap"; before: string; after: string; placeholder: string }
  | { kind: "line"; prefix: string }
  | { kind: "link" };

/**
 * A splice: replace `[rangeStart, rangeEnd)` with `replacement`, then select
 * `[selStart, selEnd)`. Expressed as a *local* edit (not a whole-value rewrite)
 * so it can be applied through `document.execCommand("insertText")`, which is
 * the only API that keeps the textarea's native undo stack intact.
 */
interface SpliceEdit {
  rangeStart: number;
  rangeEnd: number;
  replacement: string;
  selStart: number;
  selEnd: number;
}

/** Wrap the selection with `before`/`after` (or insert a placeholder at the caret). */
function applyWrap(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): SpliceEdit {
  const selected = value.slice(start, end) || placeholder;
  const selStart = start + before.length;
  return {
    rangeStart: start,
    rangeEnd: end,
    replacement: before + selected + after,
    selStart,
    selEnd: selStart + selected.length,
  };
}

/** Toggle a line prefix (`> `, `- `, `1. `, `- [ ] `, `### `) on every spanned line. */
function applyLine(
  value: string,
  start: number,
  end: number,
  prefix: string,
): SpliceEdit {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = value.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = value.length;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => {
      if (allPrefixed) return l.slice(prefix.length);
      return l.startsWith(prefix) ? l : prefix + l;
    })
    .join("\n");
  return {
    rangeStart: lineStart,
    rangeEnd: lineEnd,
    replacement: next,
    selStart: lineStart,
    selEnd: lineStart + next.length,
  };
}

/** Insert a markdown link, selecting the part the user should fill in next. */
function applyLink(value: string, start: number, end: number): SpliceEdit {
  const selected = value.slice(start, end);
  if (selected) {
    const selStart = start + selected.length + 3; // past "[selected]("
    return {
      rangeStart: start,
      rangeEnd: end,
      replacement: `[${selected}](url)`,
      selStart,
      selEnd: selStart + 3,
    };
  }
  return {
    rangeStart: start,
    rangeEnd: end,
    replacement: "[](url)",
    selStart: start + 1,
    selEnd: start + 1,
  };
}

const BOLD: FormatAction = {
  kind: "wrap",
  before: "**",
  after: "**",
  placeholder: "bold text",
};
const ITALIC: FormatAction = {
  kind: "wrap",
  before: "_",
  after: "_",
  placeholder: "italic text",
};
const LINK: FormatAction = { kind: "link" };

/** Toolbar buttons, grouped (a divider renders between groups). */
const TOOLBAR_GROUPS: {
  id: string;
  label: string;
  icon: Icon;
  action: FormatAction;
  shortcut?: string;
}[][] = [
  [
    {
      id: "heading",
      label: "Heading",
      icon: TextHIcon,
      action: { kind: "line", prefix: "### " },
    },
  ],
  [
    {
      id: "bold",
      label: "Bold",
      icon: TextBIcon,
      action: BOLD,
      shortcut: "Ctrl+B",
    },
    {
      id: "italic",
      label: "Italic",
      icon: TextItalicIcon,
      action: ITALIC,
      shortcut: "Ctrl+I",
    },
  ],
  [
    {
      id: "quote",
      label: "Quote",
      icon: QuotesIcon,
      action: { kind: "line", prefix: "> " },
    },
    {
      id: "code",
      label: "Inline code",
      icon: CodeIcon,
      action: { kind: "wrap", before: "`", after: "`", placeholder: "code" },
    },
    {
      id: "link",
      label: "Link",
      icon: LinkIcon,
      action: LINK,
      shortcut: "Ctrl+K",
    },
  ],
  [
    {
      id: "bulleted-list",
      label: "Bulleted list",
      icon: ListBulletsIcon,
      action: { kind: "line", prefix: "- " },
    },
    {
      id: "numbered-list",
      label: "Numbered list",
      icon: ListNumbersIcon,
      action: { kind: "line", prefix: "1. " },
    },
    {
      id: "task-list",
      label: "Task list",
      icon: ListChecksIcon,
      action: { kind: "line", prefix: "- [ ] " },
    },
  ],
];

/**
 * A description editor with GitHub-style Write/Preview tabs and a formatting
 * toolbar. Preview renders through the same Markdown component PR bodies use,
 * so what you see is what the conversation view will show. `actions` renders on
 * the right of the tab row (e.g. an AI Generate button).
 */
export function MarkdownEditor({
  ref,
  id,
  value,
  onChange,
  onKeyDown,
  placeholder,
  rows = 7,
  disabled,
  autoFocus,
  fill,
  textareaClassName,
  actions,
  "aria-label": ariaLabel,
}: {
  ref?: Ref<MarkdownEditorHandle>;
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Grow the input (and Preview) to the parent flex column's spare height,
   *  instead of the default capped box. The caller owns a `min-h-0` column. */
  fill?: boolean;
  textareaClassName?: string;
  actions?: ReactNode;
  "aria-label"?: string;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Selection to restore after a controlled-value update from a format action.
  const pendingSelection = useRef<[number, number] | null>(null);
  // A focus() requested while in Preview mode, honored once Write remounts.
  const pendingFocus = useRef(false);

  // Focus the textarea without the native scroll-alignment jump ("flash"), then
  // bring it into view only if it's actually off-screen, by the minimum distance
  // (`nearest` is a no-op when already visible, so no jump). Used for the
  // autofocus mount and the imperative handle focus() — the latter can be
  // triggered from a quote-reply button far from the composer, so the
  // bring-into-view is load-bearing there; a fully-visible composer stays put.
  const focusIntoView = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    ta.scrollIntoView({ block: "nearest" });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        // The textarea stays mounted in Preview (just hidden) but can't take
        // focus while hidden, so switch to Write first and focus on remount.
        if (mode === "preview") {
          pendingFocus.current = true;
          setMode("write");
        } else {
          focusIntoView();
        }
      },
      showPreview() {
        setMode("preview");
      },
    }),
    [mode, focusIntoView],
  );

  // Restore the caret/selection after a format action rewrites the value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger — the selection must be re-applied only once the controlled update has landed.
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (!pending) return;
    pendingSelection.current = null;
    const ta = textareaRef.current;
    if (ta) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(pending[0], pending[1]);
    }
  }, [value]);

  function runAction(action: FormatAction) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const edit =
      action.kind === "wrap"
        ? applyWrap(
            value,
            start,
            end,
            action.before,
            action.after,
            action.placeholder,
          )
        : action.kind === "line"
          ? applyLine(value, start, end, action.prefix)
          : applyLink(value, start, end);
    // Restore the resulting selection once the value update has landed.
    pendingSelection.current = [edit.selStart, edit.selEnd];
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(edit.rangeStart, edit.rangeEnd);
    // execCommand is the only API that writes through the document while keeping
    // the textarea's native undo stack intact, so Ctrl+Z reverts a toolbar edit
    // and prior typing alike. Deprecated, but supported in WebView2 + WKWebView
    // (all we ship); its input event keeps the controlled `value` in sync.
    const ok = document.execCommand("insertText", false, edit.replacement);
    if (!ok) {
      // Fallback (not expected on our webviews): a plain controlled rewrite. The
      // edit still applies; only this action won't be on the native undo stack.
      onChange(
        value.slice(0, edit.rangeStart) +
          edit.replacement +
          value.slice(edit.rangeEnd),
      );
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        runAction(BOLD);
        return;
      }
      if (key === "i") {
        e.preventDefault();
        runAction(ITALIC);
        return;
      }
      if (key === "k") {
        e.preventDefault();
        runAction(LINK);
        return;
      }
    }
    onKeyDown?.(e);
  }

  // Honor a focus() that arrived while Preview was showing, once Write remounts.
  useEffect(() => {
    if (mode === "write" && pendingFocus.current) {
      pendingFocus.current = false;
      focusIntoView();
    }
  }, [mode, focusIntoView]);

  // Autofocus on mount WITHOUT the native `autoFocus` attribute's aggressive
  // scroll-alignment. Native autofocus scrolls the textarea into view by aligning
  // it, which — for a composer that mounts inside the diff's overflow-auto
  // container, below the clicked line — yanks the diff by a couple of rows (the
  // "flash"). focusIntoView() instead focuses with preventScroll then
  // scrollIntoView({ block: "nearest" }), so a fully-visible composer doesn't move
  // at all while a genuinely below-the-fold one still comes into view. Mount-only:
  // this replaces a one-shot attribute, and a StrictMode double-invoke is a no-op
  // (re-focusing an already-focused element + nearest on an in-view element does
  // nothing). Matches the app's focus/scroll idiom (PlanQuestions, list-keyboard-nav).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only autofocus — `autoFocus`/`mode` are read once at mount, deliberately not re-run on change.
  useEffect(() => {
    if (autoFocus && mode === "write") focusIntoView();
  }, [focusIntoView]);

  return (
    <div
      // No `min-h-0` on the fill root: `min-height: auto` floors it at its content
      // minimum, so a short window scrolls the parent instead of shrinking the
      // editor past the textarea's floor and painting it over the fields below.
      className={fill ? "flex flex-1 flex-col gap-1.5" : "space-y-1.5"}
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant={mode === "write" ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={mode === "write"}
          onClick={() => setMode("write")}
        >
          Write
        </Button>
        <Button
          type="button"
          variant={mode === "preview" ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={mode === "preview"}
          onClick={() => setMode("preview")}
        >
          Preview
        </Button>
        {actions && (
          <>
            <span className="flex-1" />
            {actions}
          </>
        )}
      </div>
      {mode === "write" && (
        <div className="flex flex-wrap items-center gap-0.5">
          {TOOLBAR_GROUPS.map((group, i) => (
            <div key={group[0].id} className="flex items-center gap-0.5">
              {i > 0 && (
                <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              )}
              {group.map((btn) => {
                const Glyph = btn.icon;
                return (
                  <Button
                    key={btn.id}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled}
                    aria-label={
                      btn.shortcut
                        ? `${btn.label} (${btn.shortcut})`
                        : btn.label
                    }
                    title={
                      btn.shortcut
                        ? `${btn.label} · ${btn.shortcut}`
                        : btn.label
                    }
                    // Keep the textarea focused/selected when clicking a button.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runAction(btn.action)}
                  >
                    <Glyph />
                  </Button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {/* The textarea stays mounted across the Preview toggle (hidden, not
          unmounted) so its native undo/redo history isn't wiped on each
          round-trip. */}
      <Textarea
        ref={textareaRef}
        id={id}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={rows}
        disabled={disabled}
        className={cn(
          fill && "min-h-0 flex-1",
          textareaClassName,
          mode === "preview" && "hidden",
        )}
      />
      {mode === "preview" && (
        <div
          className={cn(
            fill ? "min-h-24 flex-1" : "max-h-72 min-h-24",
            "overflow-y-auto border border-input px-3 py-2",
          )}
        >
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to preview</p>
          )}
        </div>
      )}
    </div>
  );
}
