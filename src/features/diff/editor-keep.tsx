import type { DiffFile } from "@git-diff-view/react";
import {
  createContext,
  type ReactNode,
  use,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { focusIsLost } from "@/lib/focus-lost";
import { patchLines } from "@/lib/git/diff-split";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useDiffPaneHold } from "./diff-pane-hold";

type Side = "old" | "new";

/** The plain text of the lines an editor was written against and the line on
 *  each side of them, in the build it first opened on; null where that build
 *  has no real line (a placeholder composed in a gap, or past a hunk-only
 *  build's hunks), `FILE_EDGE` where it proves the file ends. */
export type LineTexts = readonly (string | typeof FILE_EDGE | null)[];

/** The lines an editor's comment is about: a line composer's resolved range
 *  (its "+" line may sit inside it), or an anchor row's own line. */
interface Span {
  side: Side;
  from: number;
  to: number;
}

/** The id both line composers keep their text under. The library holds one
 *  widget per diff, so the widget has one record under a constant key: its
 *  line is checked on restore, and a claim at another line replaces it. */
export const LINE_COMPOSER_KEEP_ID = "line";

/** Set on the element wrapping one comment's editor and controls, with that
 *  editor's keep id: a focus restore picks the control or field of the same
 *  comment, whatever else a held save added to the row meanwhile. */
export const KEEP_ID_ATTR = "data-keep-id";

/** A focused field or control: its label, the keep id of the comment it sits
 *  in (null outside a marked one), and its place among the row's same-labelled
 *  ones, the fallback when it has no id. */
interface FocusMark {
  label: string;
  id: string | null;
  index: number;
}

/** What `plainLine` reads where a build proves there is no line: before line
 *  1, or past the end of a side whose whole text the build holds. A symbol,
 *  since a line's text keeps its newline (a blank line reads exactly "\n"),
 *  so no string can stand for the edge. */
const FILE_EDGE: unique symbol = Symbol("file edge");

/** One claim of a record; the editor that took it acts on the record only
 *  while it is still the one kept under its key. */
export type KeptToken = KeptRecord;

interface KeptRecord {
  key: string;
  kind: "widget" | "anchor";
  side: Side;
  /** The anchor row's line; for the line composer, the line its widget sits
   *  under (the one `setWidget` reopens it on). */
  line: number;
  id: string;
  file: DiffFile;
  /** The keep scope of the build it was claimed on (path plus the host's
   *  record identity), or null on a host that names none. */
  record: string | null;
  /** The lines `lineTexts` covers; the comment posts on `span.to`. */
  span: Span;
  lineTexts: LineTexts;
  /** When the span sits on the other side from the anchor (a Unified press
   *  mapped into a range): the anchor line's own texts, read the same way, so
   *  the widget never reopens on an anchor whose line moved under the range. */
  anchorTexts: LineTexts | null;
  text: string;
  busy: boolean;
  /** `claimed`: an editor with this key is mounted. `released`: its editor
   *  unmounted in a commit not yet judged. `handover`: released in the commit
   *  that replaced the rows, kept for the remount that re-claims it. */
  state: "claimed" | "released" | "handover";
  /** The text field that held focus when its row unmounted. */
  focus: FocusMark | null;
}

interface KeptRowValue {
  keep: EditorKeep;
  kind: "widget" | "anchor";
  side: Side;
  line: number;
  file: DiffFile;
  record: string | null;
  /** The widget's resolved range; absent, the row's own line. */
  span?: Span;
}

function spanOf(row: KeptRowValue): Span {
  return row.span ?? { side: row.side, from: row.line, to: row.line };
}

const WIDGET_KEY = "widget";

function keyOf(
  kind: KeptRowValue["kind"],
  side: Side,
  line: number,
  id: string,
) {
  return kind === "widget" ? WIDGET_KEY : `${side}:${line}:${id}`;
}

function rowKeyOf(kind: KeptRowValue["kind"], side: Side, line: number) {
  return `${kind}:${side}:${line}`;
}

/** The same-labelled fields (textareas) or controls (anything else) in `node`. */
function labelled(node: Element, label: string, field: boolean): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>("[aria-label]")].filter(
    (el) =>
      el.getAttribute("aria-label") === label &&
      el instanceof HTMLTextAreaElement === field,
  );
}

function keepIdOf(el: Element): string | null {
  return el.closest(`[${KEEP_ID_ATTR}]`)?.getAttribute(KEEP_ID_ATTR) ?? null;
}

function markOf(node: Element, el: HTMLElement, label: string): FocusMark {
  const field = el instanceof HTMLTextAreaElement;
  return {
    label,
    id: keepIdOf(el),
    index: labelled(node, label, field).indexOf(el),
  };
}

/** The element a mark names in `node`: by its comment's keep id when it had
 *  one (none when that comment is gone), else by its place. */
function findMark(
  node: Element,
  mark: FocusMark,
  field: boolean,
): HTMLElement | undefined {
  const all = labelled(node, mark.label, field);
  return mark.id === null
    ? all[mark.index]
    : all.find((el) => keepIdOf(el) === mark.id);
}

function plainLine(
  file: DiffFile,
  side: Side,
  line: number,
): LineTexts[number] {
  if (line < 1) return FILE_EDGE;
  const bundle = file.getBundle();
  const placeholders =
    side === "old"
      ? bundle.oldFilePlaceholderLines
      : bundle.newFilePlaceholderLines;
  if (placeholders?.[line]) return null;
  // Past the last line (where the library still answers an empty line): the
  // file's end only when the build holds whole files. A hunk-only build
  // composes both sides from its hunks (`composeByDiff`), so it knows nothing
  // past them.
  const whole = side === "old" ? file._oldFileContent : file._newFileContent;
  if (line > lineCountOf(file, side, whole ?? ""))
    return bundle.composeByDiff || bundle.composeByRange || !whole
      ? null
      : FILE_EDGE;
  const got: { value: string } | undefined =
    side === "old" ? file.getOldPlainLine(line) : file.getNewPlainLine(line);
  return got?.value ?? null;
}

const lineCounts = new WeakMap<DiffFile, Partial<Record<Side, number>>>();

/** The lines in a build's side text, cached per build: a judge reads several. */
function lineCountOf(file: DiffFile, side: Side, text: string): number {
  const counts = lineCounts.get(file) ?? {};
  let n = counts[side];
  if (n === undefined) {
    n = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
      n++;
    if (text !== "" && !text.endsWith("\n")) n++;
    counts[side] = n;
    lineCounts.set(file, counts);
  }
  return n;
}

function lineTextsOf(file: DiffFile, span: Span): LineTexts {
  const texts: LineTexts[number][] = [];
  for (let n = span.from - 1; n <= span.to + 1; n++)
    texts.push(plainLine(file, span.side, n));
  return texts;
}

function anchorTextsOf(
  file: DiffFile,
  side: Side,
  line: number,
  span: Span,
): LineTexts | null {
  return span.side === side
    ? null
    : lineTextsOf(file, { side, from: line, to: line });
}

function sameTexts(was: LineTexts, now: LineTexts): boolean {
  return was.every((t, i) => t !== null && t === now[i]);
}

/** `file` reads the text a record took over its span and both neighbours (and
 *  over its anchor line, when that sits on the other side). A provable file
 *  edge matches itself; a line either build has no real text for (a gap
 *  placeholder, past a hunk-only build's hunks) never matches, so a composer
 *  is never restored onto code it was not written against. The texts are the
 *  DRAWN ones, shortened past `DIFF_MAX_LINE_CHARS`: a change past the cut on
 *  a longer line restores, since that tail is never displayed anywhere. */
function textsPlaced(r: KeptRecord, file: DiffFile): boolean {
  return (
    sameTexts(r.lineTexts, lineTextsOf(file, r.span)) &&
    (r.anchorTexts === null ||
      sameTexts(
        r.anchorTexts,
        lineTextsOf(file, { side: r.side, from: r.line, to: r.line }),
      ))
  );
}

/** A record rides onto `row`'s build: the same line of the same build, or of
 *  a rebuild under the same keep scope that still reads the same there. */
function rides(r: KeptRecord, row: KeptRowValue): boolean {
  if (r.side !== row.side || r.line !== row.line) return false;
  if (r.file === row.file) return r.record === row.record;
  return (
    r.record !== null && r.record === row.record && textsPlaced(r, row.file)
  );
}

export type EditorKeep = ReturnType<typeof createEditorKeep>;

/**
 * The texts of the editors open in one diff's rows, kept across a remount of
 * those rows. An external store: claims, releases and busy flips notify, text
 * writes never do, so typing re-renders no part of the library's table.
 */
export function createEditorKeep() {
  const records = new Map<string, KeptRecord>();
  const rowFocus = new Map<string, FocusMark>();
  const pendingFocus = new Map<string, FocusMark>();
  // A labelled control other than a text field that held focus as its row
  // unmounted.
  const rowControl = new Map<string, FocusMark>();
  const listeners = new Set<() => void>();
  let version = 0;
  let mountedFile: DiffFile | null = null;
  let mountedRecord: string | null = null;
  let sweepQueued = false;
  let focusLeft = false;
  const notify = () => {
    version++;
    for (const l of listeners) l();
  };
  // A release no rows replacement claimed by the end of its commit is an
  // editor that went away by itself.
  const sweep = () => {
    sweepQueued = false;
    focusLeft = false;
    rowFocus.clear();
    rowControl.clear();
    let dropped = false;
    for (const [key, r] of records)
      if (r.state === "released") {
        records.delete(key);
        dropped = true;
      }
    if (dropped) notify();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    /** The record a remounted editor at `row` seeds from: one that rides onto
     *  its build, by the same test the restore decision passed. */
    seedFor(row: KeptRowValue, id: string): KeptRecord | null {
      const r = records.get(keyOf(row.kind, row.side, row.line, id));
      return r !== undefined && rides(r, row) ? r : null;
    },
    claim(row: KeptRowValue, id: string, text: string): KeptToken {
      const key = keyOf(row.kind, row.side, row.line, id);
      const prev = records.get(key);
      const span = spanOf(row);
      // The library moves its single widget without an onClose, so a widget
      // claimed at another line replaces the record rather than joining it.
      if (prev !== undefined && rides(prev, row)) {
        if (prev.state !== "claimed" && prev.focus !== null)
          pendingFocus.set(rowKeyOf(row.kind, row.side, row.line), prev.focus);
        // A re-claim on the build it was read from takes the range the widget
        // resolves to now; a rebuild keeps the texts it was written against.
        if (prev.file === row.file) {
          prev.span = span;
          prev.lineTexts = lineTextsOf(row.file, span);
          prev.anchorTexts = anchorTextsOf(row.file, row.side, row.line, span);
        }
        prev.state = "claimed";
        prev.focus = null;
        prev.text = text;
        prev.file = row.file;
        prev.record = row.record;
        notify();
        return prev;
      }
      const made: KeptRecord = {
        key,
        kind: row.kind,
        side: row.side,
        line: row.line,
        id,
        file: row.file,
        record: row.record,
        span,
        lineTexts: lineTextsOf(row.file, span),
        anchorTexts: anchorTextsOf(row.file, row.side, row.line, span),
        text,
        busy: false,
        state: "claimed",
        focus: null,
      };
      records.set(key, made);
      notify();
      return made;
    },
    release(r: KeptToken) {
      if (records.get(r.key) !== r || r.state !== "claimed") return;
      r.state = "released";
      r.focus = rowFocus.get(rowKeyOf(r.kind, r.side, r.line)) ?? null;
      if (!sweepQueued) {
        sweepQueued = true;
        queueMicrotask(sweep);
      }
      notify();
    },
    write(r: KeptToken, text: string) {
      if (records.get(r.key) === r) r.text = text;
    },
    setBusy(r: KeptToken, busy: boolean) {
      if (records.get(r.key) !== r || r.busy === busy) return;
      r.busy = busy;
      notify();
    },
    /** A no-op once another claim holds the key (the widget moved to another
     *  line or diff), so a late settle never drops that editor's record.
     *  False then: the caller no longer owns what it would close. */
    forget(r: KeptToken): boolean {
      if (records.get(r.key) !== r) return false;
      records.delete(r.key);
      notify();
      return true;
    },
    /** A row unmounting with focus in it: the focused text field's mark
     *  (label, keep id, place) goes to the editors it releases next, and a
     *  focused control's to the row's next mount, to refocus it on a restore.
     *  An element without an `aria-label` is not recorded. */
    noteRowLeaving(rowKey: string, node: HTMLElement | null) {
      const active = document.activeElement;
      if (node === null || active === null || !node.contains(active)) return;
      focusLeft = true;
      const label = active.getAttribute("aria-label");
      if (label === null || !(active instanceof HTMLElement)) return;
      const mark = markOf(node, active, label);
      if (active instanceof HTMLTextAreaElement) rowFocus.set(rowKey, mark);
      else rowControl.set(rowKey, mark);
    },
    takePendingFocus(rowKey: string): FocusMark | null {
      const mark = pendingFocus.get(rowKey) ?? null;
      pendingFocus.delete(rowKey);
      return mark;
    },
    /** The control that held focus as this row's earlier mount went, in the
     *  commit that remounts it. */
    takeLeftControl(rowKey: string): FocusMark | null {
      const control = rowControl.get(rowKey) ?? null;
      rowControl.delete(rowKey);
      return control;
    },
    /** Called in the layout phase of every commit that replaced the rows or
     *  moved their record: another record (another path or keep scope, even
     *  over the same build, or any new build where it has none) clears every
     *  record; a remount of the same record keeps this commit's releases for
     *  re-claiming. Answers whether focus was in a row this commit took away. */
    rowsReplaced(
      file: DiffFile | null,
      _layout: "split" | "unified",
      record: string | null,
    ): boolean {
      if (
        file === null ||
        record !== mountedRecord ||
        (file !== mountedFile && record === null)
      ) {
        records.clear();
        pendingFocus.clear();
      } else {
        for (const [key, r] of records)
          if (r.state === "handover") records.delete(key);
          else if (r.state === "released") r.state = "handover";
      }
      mountedFile = file;
      mountedRecord = record;
      rowControl.clear();
      const hadFocus = focusLeft;
      focusLeft = false;
      notify();
      return hadFocus;
    },
    /** Drops hand-over records no editor re-claimed: called once the new
     *  rows mounted and the widget reopen ran. */
    dropHandOver() {
      let dropped = false;
      for (const [key, r] of records)
        if (r.state === "handover") {
          records.delete(key);
          dropped = true;
        }
      if (dropped) notify();
    },
    /** Whether an editor is open in the rows: one the DOM shows, or one the
     *  store holds claimed. */
    editing(_version: number, openEditors: number): boolean {
      if (openEditors > 0) return true;
      for (const r of records.values()) if (r.state === "claimed") return true;
      return false;
    },
    /** The ids of the anchor-row editors open at `row` that ride onto its
     *  build, claimed by the rows a remount replaces or handed over. */
    keptIds(_version: number, row: KeptRowValue): string[] {
      const ids: string[] = [];
      for (const r of records.values())
        if (r.kind === "anchor" && r.state !== "released" && rides(r, row))
          ids.push(r.id);
      return ids;
    },
    /** The line composer's record, claimed or handed over. */
    widgetRecord(): { side: Side; line: number } | null {
      const r = records.get(WIDGET_KEY);
      return r === undefined || r.state === "released" ? null : r;
    },
    /** Whether new rows of the same record may go through now: every claimed
     *  or handed-over record is placed in them, none is mid-submit, and every
     *  editor the DOM shows is one the store holds. Anything else holds the
     *  rows, so across rebuilds within one record an editor that never adopted
     *  the keep is held, never dropped; a record move, or a new build on a
     *  host that names no record, drops it.
     *  `file` is the new build when it differs from the one on screen: its
     *  text must read the same at each record's line and both neighbours. */
    placed(
      _version: number,
      input: {
        openEditors: number;
        file: DiffFile | null;
        shown: string;
        anchors: readonly {
          side: Side;
          line: number;
          ids?: readonly string[];
        }[];
        widgetEnabled: boolean;
      },
    ): boolean {
      // A release from an earlier commit is an editor that went away by
      // itself, even when the re-render deciding here beat the sweep's
      // microtask: it must not be handed over to the rows this lets through.
      for (const [key, r] of records)
        if (r.state === "released") records.delete(key);
      const live = [...records.values()];
      const claimed = live.filter((r) => r.state === "claimed").length;
      if (input.openEditors === 0 && claimed === 0) return true;
      if (input.openEditors > claimed) return false;
      const drawn = patchLines(input.shown);
      return live.every((r) => {
        // A host that turned its widget off swaps the view, so the composer
        // goes whatever is decided: its record never holds the rows.
        if (r.kind === "widget" && !input.widgetEnabled) return true;
        if (r.busy) return false;
        for (let n = r.span.from; n <= r.span.to; n++)
          if (!drawn[r.span.side].has(n)) return false;
        if (r.anchorTexts !== null && !drawn[r.side].has(r.line)) return false;
        if (input.file !== null && !textsPlaced(r, input.file)) return false;
        if (r.kind === "widget") return input.widgetEnabled;
        return input.anchors.some(
          (a) =>
            a.side === r.side && a.line === r.line && a.ids?.includes(r.id),
        );
      });
    },
  };
}

const KeptRowContext = createContext<KeptRowValue | null>(null);

/**
 * One diff row that can host an editor (an anchor row, or the line widget),
 * for the editors under it to key their kept text by. Its hidden span finds
 * the row's element, so focus in it is noted as the row unmounts and given
 * back to the same field when a restore remounts it.
 */
export function KeptRow({
  keep,
  kind,
  side,
  line,
  file,
  record,
  span,
  children,
}: KeptRowValue & { children: ReactNode }) {
  const probe = useRef<HTMLSpanElement>(null);
  const interactive = useLatestRef(useDiffPaneHold().interactive);
  const row = { keep, kind, side, line, file, record, span };
  useLayoutEffect(() => {
    const node = probe.current?.parentElement ?? null;
    const rowKey = rowKeyOf(kind, side, line);
    const mark = keep.takePendingFocus(rowKey);
    if (node !== null && mark !== null && interactive.current) {
      const field = findMark(node, mark, true);
      if (field instanceof HTMLTextAreaElement) {
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
    // A control focused in the rows a rebuild replaced (a closed editor's
    // actions trigger) lands on its twin in the same row, before the diff's
    // own rescue sends lost focus to the diff group.
    const control = keep.takeLeftControl(rowKey);
    if (
      node !== null &&
      control !== null &&
      interactive.current &&
      focusIsLost()
    )
      findMark(node, control, false)?.focus({ preventScroll: true });
    return () => keep.noteRowLeaving(rowKey, node);
  }, [keep, kind, side, line]);
  return (
    <KeptRowContext value={row}>
      <span ref={probe} hidden />
      {children}
    </KeptRowContext>
  );
}

/** Re-renders on every claim, release and busy flip of `keep`. */
export function useEditorKeepVersion(keep: EditorKeep): number {
  return useSyncExternalStore(keep.subscribe, keep.version);
}

/** Whether the editor `id` was open in this row before its rows remounted:
 *  an anchor-row editor initialises its open flag from it. False outside a
 *  kept row. */
export function useKeptOpen(id: string | null): boolean {
  const row = use(KeptRowContext);
  const [open] = useState(
    () => row !== null && id !== null && row.keep.seedFor(row, id) !== null,
  );
  return open;
}

/** The ids of the editors open in this row before its rows remounted, read
 *  once at mount: a host whose own state decides whether an editor's card
 *  shows seeds that state from them. Empty outside a kept row. */
export function useKeptIds(): readonly string[] {
  const row = use(KeptRowContext);
  const [ids] = useState(() =>
    row === null ? [] : row.keep.keptIds(row.keep.version(), row),
  );
  return ids;
}

const NO_KEEP = { subscribe: () => () => undefined, version: () => 0 };

/** The ids of the editors open in this row now, re-read on every claim and
 *  release: a host that would hide an editor's card on a live change (a
 *  thread resolved elsewhere) keeps it shown while its editor is open. Empty
 *  outside a kept row. */
export function useOpenKeptIds(): readonly string[] {
  const row = use(KeptRowContext);
  const store = row?.keep ?? NO_KEEP;
  const version = useSyncExternalStore(store.subscribe, store.version);
  return row === null ? [] : row.keep.keptIds(version, row);
}

export interface KeptDraft {
  text: string;
  setText: (next: string | ((prev: string) => string)) => void;
  /** This editor was open, with this text, before its rows remounted. */
  restored: boolean;
  /** Drops the record: for a direct post as it sends, for an add, an edit or
   *  a reply once its save lands, and on Cancel or close. False when another
   *  claim took the key meanwhile (a late settle must not close that editor);
   *  true outside a kept row. */
  forget: () => boolean;
  setBusy: (busy: boolean) => void;
}

/**
 * An editor's text, kept by its diff row while `id` is non-null (the editor
 * is mounted): a remount of the rows that keeps the row seeds it back. Plain
 * state outside a kept row, so the same editor off a diff behaves as before.
 */
export function useKeptDraft(id: string | null): KeptDraft {
  const row = use(KeptRowContext);
  const [seed] = useState(() =>
    row !== null && id !== null ? row.keep.seedFor(row, id) : null,
  );
  // Consumed when the editor closes, so its host's next opening takes focus.
  const [restored, setRestored] = useState(seed !== null);
  if (restored && id === null) setRestored(false);
  const [text, setTextState] = useState(seed?.text ?? "");
  const textRef = useRef(text);
  const tokenRef = useRef<KeptToken | null>(null);
  const keep = row?.keep;
  const kind = row?.kind;
  const side = row?.side;
  const line = row?.line;
  const file = row?.file;
  const record = row?.record ?? null;
  const spanSide = row?.span?.side;
  const spanFrom = row?.span?.from;
  const spanTo = row?.span?.to;
  useLayoutEffect(() => {
    if (
      keep === undefined ||
      kind === undefined ||
      side === undefined ||
      line === undefined ||
      file === undefined ||
      id === null
    )
      return;
    const span =
      spanSide === undefined || spanFrom === undefined || spanTo === undefined
        ? undefined
        : { side: spanSide, from: spanFrom, to: spanTo };
    const token = keep.claim(
      { keep, kind, side, line, file, record, span },
      id,
      textRef.current,
    );
    tokenRef.current = token;
    return () => keep.release(token);
  }, [keep, kind, side, line, file, record, id, spanSide, spanFrom, spanTo]);
  return {
    text,
    setText: (next) => {
      const value = typeof next === "function" ? next(textRef.current) : next;
      textRef.current = value;
      setTextState(value);
      if (keep !== undefined && tokenRef.current !== null)
        keep.write(tokenRef.current, value);
    },
    restored,
    forget: () =>
      keep === undefined || tokenRef.current === null
        ? true
        : keep.forget(tokenRef.current),
    setBusy: (busy) => {
      if (keep !== undefined && tokenRef.current !== null)
        keep.setBusy(tokenRef.current, busy);
    },
  };
}

/** Provided by the diff around its rows: true while they are held for an open
 *  editor over an earlier text than the diff's newest build. */
export const DiffRowsHeldContext = createContext(false);

/** The rows a diff draws are an earlier text's, held for an open editor; a
 *  hold kept for a layout swap or an anchors-only change reads false, since
 *  its rows still draw the same text. Read only by the line composers. */
export function useDiffRowsHeld(): boolean {
  return use(DiffRowsHeldContext);
}
