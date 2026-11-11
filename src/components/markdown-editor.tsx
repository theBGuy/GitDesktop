import {
  CodeIcon,
  type Icon,
  ImageIcon,
  InfoIcon,
  LinkIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextHIcon,
  TextItalicIcon,
  UploadSimpleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ignoreHeldEnter } from "@/components/confirm-swap-focus";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ImageLightbox } from "@/components/image-lightbox";
import { Markdown } from "@/components/markdown/markdown";
import { useMentionAutocomplete } from "@/components/mention-autocomplete";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import type { StagedRecord } from "@/lib/attachments/draft-attachments";
import {
  nextFocusSeq,
  registerAttachEditor,
  runAttachImage,
} from "@/lib/attachments/editor-registry";
import {
  type AttachSource,
  imageReference,
  insertionFor,
  referencedNames,
  removalSplice,
  uploadingReason,
} from "@/lib/attachments/references";
import {
  type DraftAttachmentsHandle,
  uploadActFor,
} from "@/lib/attachments/use-draft-attachments";
import { clipTitle } from "@/lib/clip-title";
import { formatBytes } from "@/lib/format-bytes";
import { formatBinding, hasChordModifier } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { isActivationKey } from "@/lib/use-disabled-reason";
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
  /** Canonical binding string (see @/lib/hotkeys/binding) — the labels format
   *  it per platform, so it must never be a literal modifier. */
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
      shortcut: "mod+b",
    },
    {
      id: "italic",
      label: "Italic",
      icon: TextItalicIcon,
      action: ITALIC,
      shortcut: "mod+i",
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
      shortcut: "mod+k",
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

const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

type AttachStatusKind = "warning" | "info" | "uploading";

const ATTACH_STATUS_ICON: Record<
  AttachStatusKind,
  { Glyph: Icon; className: string }
> = {
  warning: { Glyph: WarningIcon, className: "text-warning" },
  info: { Glyph: InfoIcon, className: "text-muted-foreground" },
  uploading: { Glyph: UploadSimpleIcon, className: "text-muted-foreground" },
};

/**
 * Registers the `attach-image` palette action for one attachments editor. The
 * editor mounts it only with the prop: `useHotkeyAction` registers an entry
 * even when disabled, so an editor without attachments must never call it.
 */
function AttachImageAction({
  enabled,
  rootRef,
  inputRef,
  lastFocusRef,
}: {
  enabled: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  lastFocusRef: RefObject<number>;
}) {
  useHotkeyAction("attach-image", runAttachImage, enabled);
  useLayoutEffect(
    () =>
      registerAttachEditor({
        enabled,
        lastFocus: () => lastFocusRef.current,
        root: () => rootRef.current,
        open: () => inputRef.current?.click(),
      }),
    [enabled, rootRef, inputRef, lastFocusRef],
  );
  return null;
}

/** The staged images the text references, as a named list of Tab stops. */
function AttachmentChips({
  images,
  removeDisabled,
  removeReason,
  onPreview,
  onRemove,
}: {
  images: readonly StagedRecord[];
  removeDisabled: boolean;
  removeReason: string | null;
  onPreview: (index: number) => void;
  onRemove: (name: string, index: number) => void;
}) {
  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-1.5">
      {images.map((image, i) => (
        <li
          key={image.name}
          className="flex max-w-64 min-w-0 items-center gap-1.5 border border-input p-0.5 text-xs"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-7 shrink-0 overflow-hidden p-0"
            aria-label={`Preview ${image.name}`}
            onClick={() => onPreview(i)}
          >
            <img src={image.url} alt="" className="size-full object-cover" />
          </Button>
          <span
            className="min-w-0 truncate"
            onMouseEnter={clipTitle(image.name)}
          >
            {image.name}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {formatBytes(image.size)}
          </span>
          <DisabledReasonButton
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${image.name}`}
            data-attachment-remove={image.name}
            disabled={removeDisabled}
            reason={removeReason}
            // Focus lands on the next chip's Remove: a held Enter stops here.
            onKeyDown={ignoreHeldEnter}
            onClick={() => onRemove(image.name, i)}
          >
            <XIcon />
          </DisabledReasonButton>
        </li>
      ))}
    </ul>
  );
}

/** The status line under the chips: an icon plus its sentence. Its words reach
 *  assistive tech through the editor's always-mounted status region, since a
 *  live region inserted together with its text is often not announced. */
function AttachmentStatusLine({
  kind,
  text,
}: {
  kind: AttachStatusKind;
  text: string;
}) {
  const { Glyph, className } = ATTACH_STATUS_ICON[kind];
  return (
    <p aria-hidden className="flex items-start gap-1.5 text-xs">
      <Glyph aria-hidden className={cn("mt-px size-3.5 shrink-0", className)} />
      <span>{text}</span>
    </p>
  );
}

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
  mentions,
  attachments,
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
  /** Grow the input (and Preview) to the parent flex column's spare height instead
   *  of the default capped box. Every fill-mode box keeps a min-height floor so a
   *  short window scrolls the parent rather than collapsing the editor. Only the
   *  textarea's floor is caller-tunable (`min-h-24`, overridden via
   *  `textareaClassName`); Preview's stays fixed at `min-h-24`, so a call site that
   *  raises the textarea's floor gets a slightly shorter minimum in Preview. */
  fill?: boolean;
  textareaClassName?: string;
  actions?: ReactNode;
  /** Opt in to `@`/`#`/`!` autocomplete. Omitted — as it is on every surface whose
   *  forge wouldn't autolink the result — the editor adds no listener, query or
   *  node for it. */
  mentions?: MentionSource;
  /** Opt in to image attachments (paste, the Attach button, chips, the palette
   *  action). Omitted, the editor adds no listener, node, subscription or
   *  hotkey handler for them. */
  attachments?: DraftAttachmentsHandle;
  "aria-label"?: string;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Selection to restore after a controlled-value update from a format action.
  const pendingSelection = useRef<[number, number] | null>(null);
  // A focus() requested while in Preview mode, honored once Write remounts.
  const pendingFocus = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef(0);
  // Where focus goes once a chip removal lands: the named chip's remove button,
  // else the textarea. Tagged with its draft, so a switch drops it.
  const pendingChipFocus = useRef<{
    draftKey: string;
    name: string | null;
  } | null>(null);
  // Read after a stage's await, so an insert targets what the editor shows THEN.
  const liveRef = useRef({
    draftKey: attachments?.draftKey,
    attachments,
    mode,
    onChange,
    mounted: false,
  });
  // Set while the editor inserts its own reference: that input event is no
  // user edit, so it retires no status line or partial-failure strip.
  const insertingRef = useRef(false);
  // The lightbox belongs to the draft it opened on; another draft shows it closed.
  const [lightbox, setLightbox] = useState<{
    draftKey: string;
    index: number;
  } | null>(null);
  useLayoutEffect(() => {
    liveRef.current.draftKey = attachments?.draftKey;
    liveRef.current.attachments = attachments;
    liveRef.current.mode = mode;
    liveRef.current.onChange = onChange;
  });
  // An `<Activity>` hide runs this cleanup too: a hidden editor takes no insert.
  useEffect(() => {
    liveRef.current.mounted = true;
    return () => {
      liveRef.current.mounted = false;
    };
  }, []);
  // The hold that gave a held attach's reason has ended: drop it from the
  // store, so the same hold returning later doesn't show it again unasked.
  const heldNoteStale = attachments?.heldNoteStale === true;
  useEffect(() => {
    if (heldNoteStale) liveRef.current.attachments?.retireHeldNote();
  }, [heldNoteStale]);

  const mention = useMentionAutocomplete({
    mentions,
    textareaRef,
    value,
    onChange,
    suspended: mode === "preview" || !!disabled,
  });

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
    // The suggestion popover owns arrows/Enter/Tab/Escape while a token is open,
    // between the formatting chords and the consumer's own handler.
    if (mention.onKeyDown(e)) return;
    onKeyDown?.(e);
  }

  // `document.execCommand` keeps the native undo stack; where it is missing or
  // refuses, a controlled rewrite applies the same edit off that stack.
  function spliceText(
    ta: HTMLTextAreaElement,
    start: number,
    end: number,
    replacement: string,
    caret: number | null,
  ) {
    const text = ta.value;
    if (typeof document.execCommand === "function") {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, end);
      const ok =
        replacement === ""
          ? document.execCommand("delete", false)
          : document.execCommand("insertText", false, replacement);
      if (ok) {
        if (caret !== null) ta.setSelectionRange(caret, caret);
        return;
      }
    }
    if (caret !== null) pendingSelection.current = [caret, caret];
    liveRef.current.onChange(
      text.slice(0, start) + replacement + text.slice(end),
    );
  }

  // A stage that resolves inserts at the caret only while this editor still
  // shows its draft in Write and focus is here (or on <body>, after a picker or
  // the palette); otherwise the started draft gains the reference at its end.
  function insertReference(handle: DraftAttachmentsHandle, reference: string) {
    const live = liveRef.current;
    const ta = textareaRef.current;
    const root = rootRef.current;
    const active = document.activeElement;
    const here =
      live.mounted &&
      live.mode === "write" &&
      live.draftKey === handle.draftKey &&
      ta !== null &&
      root !== null &&
      (active === null || active === document.body || root.contains(active));
    if (!here || ta === null) {
      handle.appendReference(reference);
      return;
    }
    const at = ta.selectionStart ?? ta.value.length;
    const { insert, caret } = insertionFor(ta.value, at, reference);
    insertingRef.current = true;
    try {
      spliceText(ta, at, at, insert, caret);
    } finally {
      insertingRef.current = false;
    }
  }

  // One pick or paste is one gesture. Each file re-reads the started draft's
  // live handle, so a hold or gate engaging mid-batch stops it, and a draft
  // that moved on (Clear, a post, a reseed) takes no later file. A file's own
  // refusal never stops the rest.
  async function attachFiles(files: File[], source: AttachSource) {
    const first = attachments;
    if (!first) return;
    let stillLive: (() => boolean) | null = null;
    for (const file of files) {
      const latest = liveRef.current.attachments;
      const handle = latest?.draftKey === first.draftKey ? latest : first;
      if (stillLive !== null && !stillLive()) return;
      if ((handle.holdReason ?? handle.gateReason) !== null) {
        handle.noteBlocked();
        return;
      }
      stillLive ??= handle.startAttach();
      const staged = await handle.stage(file, source);
      if (!staged) continue;
      insertReference(
        handle,
        imageReference(
          source,
          source === "picker" ? file.name : null,
          staged.name,
        ),
      );
    }
  }

  const attachReason = attachments
    ? (attachments.holdReason ?? attachments.gateReason)
    : null;

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const data = e.clipboardData;
    const files = Array.from(data?.files ?? []);
    if (
      files.length === 0 ||
      Array.from(data?.types ?? []).includes("text/plain")
    )
      return;
    e.preventDefault();
    if (attachReason !== null) {
      attachments?.noteBlocked();
      return;
    }
    void attachFiles(files, "paste");
  }

  function removeChip(name: string, index: number, names: string[]) {
    const ta = textareaRef.current;
    if (!ta || !attachments) return;
    const splice = removalSplice(ta.value, name);
    if (!splice) return;
    pendingChipFocus.current = {
      draftKey: attachments.draftKey,
      name: names[index + 1] ?? names[index - 1] ?? null,
    };
    if (mode === "write")
      spliceText(ta, splice.start, splice.end, splice.replacement, null);
    else
      onChange(
        ta.value.slice(0, splice.start) +
          splice.replacement +
          ta.value.slice(splice.end),
      );
    // A removal is the user's edit on every route, the input event's included.
    attachments.noteEdited();
  }

  // A chip removal's focus lands once the text without it has rendered: the
  // next chip's remove button, else the previous, else the input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger — the chips re-render only once the removal's controlled update has landed.
  useLayoutEffect(() => {
    const pending = pendingChipFocus.current;
    if (!pending) return;
    pendingChipFocus.current = null;
    if (pending.draftKey !== liveRef.current.draftKey) return;
    const chip =
      pending.name === null
        ? null
        : Array.from(
            rootRef.current?.querySelectorAll<HTMLElement>(
              "[data-attachment-remove]",
            ) ?? [],
          ).find((el) => el.dataset.attachmentRemove === pending.name);
    if (chip) chip.focus();
    else if (liveRef.current.mode === "write") textareaRef.current?.focus();
    else previewTabRef.current?.focus();
  }, [value]);

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

  const chipImages = attachments
    ? referencedNames(
        value,
        attachments.images.map((i) => i.name),
      ).flatMap((name) => attachments.images.filter((i) => i.name === name))
    : [];
  const chipNames = chipImages.map((i) => i.name);
  // A lightbox left open on another draft, or over chips that have since gone,
  // never reopens when that draft returns or its chips refill.
  if (
    lightbox !== null &&
    (lightbox.draftKey !== attachments?.draftKey || chipImages.length === 0)
  )
    setLightbox(null);
  const lightboxIndex =
    lightbox !== null && lightbox.draftKey === attachments?.draftKey
      ? Math.min(lightbox.index, Math.max(chipImages.length - 1, 0))
      : null;
  const statusLine: { kind: AttachStatusKind; text: string } | null = (() => {
    if (!attachments) return null;
    if (attachments.posting > 0) {
      // The host's hold names a parked post (offline) over the uploading text.
      const uploading = uploadingReason(
        attachments.posting,
        uploadActFor(attachments.draftKey),
      );
      const text = attachments.holdReason ?? uploading;
      return { kind: text === uploading ? "uploading" : "info", text };
    }
    const status = attachments.status;
    return status && { kind: status.tone, text: status.text };
  })();
  const removeReason = attachments?.holdReason ?? null;

  return (
    <div
      ref={rootRef}
      // No `min-h-0` on the fill root: `min-height: auto` floors it at its content
      // minimum, so a short window scrolls the parent instead of shrinking the
      // editor past the textarea's floor and painting it over the fields below.
      className={fill ? "flex flex-1 flex-col gap-1.5" : "space-y-1.5"}
      onFocus={
        attachments
          ? () => {
              lastFocusRef.current = nextFocusSeq();
            }
          : undefined
      }
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
          ref={previewTabRef}
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
                const hint = btn.shortcut && formatBinding(btn.shortcut);
                return (
                  <Button
                    key={btn.id}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled}
                    aria-label={hint ? `${btn.label} (${hint})` : btn.label}
                    title={hint ? `${btn.label} · ${hint}` : btn.label}
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
          {attachments && (
            <div className="flex items-center gap-0.5">
              <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              {/* A held button swallows its own press, so a pointer press falls
                  through to this wrapper and a bare Enter/Space bubbles to it:
                  either puts the reason on the status line. */}
              <span
                className="inline-flex"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (attachReason !== null) attachments.noteBlocked();
                }}
                onKeyDown={(e) => {
                  if (hasChordModifier(e)) return;
                  if (isActivationKey(e) && attachReason !== null)
                    attachments.noteBlocked();
                }}
              >
                <DisabledReasonButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Attach image"
                  title="Attach image"
                  disabled={!!disabled || attachReason !== null}
                  reason={attachReason}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon />
                </DisabledReasonButton>
              </span>
            </div>
          )}
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
        onChange={(e) => {
          onChange(e.target.value);
          if (!insertingRef.current) attachments?.noteEdited();
          mention.sync(
            e.target.value,
            e.target.selectionStart ?? e.target.value.length,
          );
        }}
        onKeyDown={handleKeyDown}
        rows={rows}
        disabled={disabled}
        className={cn(
          fill && "min-h-24 flex-1",
          textareaClassName,
          mode === "preview" && "hidden",
        )}
        {...mention.textareaProps}
        // After the spread, so the mention props can never drop it.
        onPaste={attachments ? handlePaste : undefined}
      />
      {mention.popover}
      {mode === "preview" && (
        <div
          className={cn(
            fill ? "min-h-24 flex-1" : "max-h-72 min-h-24",
            "overflow-y-auto border border-input px-3 py-2",
          )}
        >
          {value.trim() ? (
            // No refs: in-app navigation from inside an open editor closes the
            // host dialog via the identity-change reset and discards the draft.
            // Repository-relative links stay inert here for the same reason —
            // this preview is for reading your own draft, not for navigating.
            // Staged names resolve to this draft's own local copies, never the
            // repository; the text renders exactly as typed.
            <Markdown
              stagedImages={
                attachments
                  ? {
                      draftKey: attachments.draftKey,
                      owner: attachments.owner,
                    }
                  : undefined
              }
            >
              {value}
            </Markdown>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to preview</p>
          )}
        </div>
      )}
      {attachments && chipImages.length > 0 && (
        <AttachmentChips
          images={chipImages}
          removeDisabled={!!disabled || removeReason !== null}
          removeReason={removeReason}
          onPreview={(index) =>
            setLightbox({ draftKey: attachments.draftKey, index })
          }
          onRemove={(name, index) => removeChip(name, index, chipNames)}
        />
      )}
      {statusLine && (
        <AttachmentStatusLine kind={statusLine.kind} text={statusLine.text} />
      )}
      {attachments && (
        <>
          <span role="status" className="sr-only">
            {statusLine?.text}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            multiple
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length > 0) void attachFiles(files, "picker");
            }}
          />
          <ImageLightbox
            images={chipImages.map((i) => ({
              src: i.url,
              alt: i.name,
              label: i.name,
              naturalWidth: i.width,
              naturalHeight: i.height,
            }))}
            index={lightboxIndex ?? 0}
            onIndexChange={(index) =>
              setLightbox({ draftKey: attachments.draftKey, index })
            }
            open={lightboxIndex !== null && chipImages.length > 0}
            onOpenChange={(open) => {
              if (!open) setLightbox(null);
            }}
          />
          <AttachImageAction
            enabled={mode === "write" && !disabled && attachReason === null}
            rootRef={rootRef}
            inputRef={fileInputRef}
            lastFocusRef={lastFocusRef}
          />
        </>
      )}
    </div>
  );
}
