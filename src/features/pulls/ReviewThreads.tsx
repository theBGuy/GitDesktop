import { CaretRightIcon, CopyIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Spinner } from "@/components/ui/spinner";
import { Thread } from "@/features/conversations/Thread";
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import { copyText } from "@/lib/clipboard";
import type {
  ApplyLinesResult,
  ForgeProvider,
  ReviewThreadOut,
} from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { synthesizeThreadHunk } from "./suggestion-utils";

/** Sets a hover title only when the element is actually clipped (measures
 *  `currentTarget`, not an inner span) — the file-group header truncates. */
const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? value : "";
};

/**
 * File:line-anchored review threads (Copilot/CodeRabbit/human line comments on
 * GitHub PRs, GitLab MR diff notes, Bitbucket inline comments), grouped by file
 * inside the PR Conversation tab. {@link ReviewThreadCard} is exported
 * standalone (with a `compact` prop) so the Files-tab diff anchors can render
 * the same card inline against a hunk without the block wrapper.
 */

interface ThreadCallbacks {
  /** Feed a thread comment's body into the main conversation composer. */
  onQuote?: (body: string) => void;
  /** Present when the viewer may reply into threads; posts the reply body. */
  onReply?: (threadId: string, body: string) => Promise<void>;
  /** Present when the viewer may resolve/unresolve; flips the thread state. */
  onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
  /** Present when the viewer may edit their own thread comments; saves the new
   *  body. Wired to a Thread's edit control only for a comment the viewer wrote. */
  onEditComment?: (commentId: string, body: string) => void;
  /** Present when the viewer may delete their own thread comments; opens the
   *  delete confirmation. Wired only for a comment the viewer wrote. */
  onDeleteComment?: (commentId: string) => void;
  /** Holds an ALREADY-OPEN comment editor's Save — withholding `onEditComment`
   *  only drops the menu entry, so a caller whose threads went stale sets this
   *  too. Threaded straight through to every card's Thread. */
  editHeld?: boolean;
}

/** The anchor label: "Lines a–b" for a range, "Line b" for a single line, "" at
 *  0 (unknown, e.g. an outdated thread). Exported for reuse by the timeline's
 *  compact thread-reply row (RemotePrView). */
export function lineLabel(startLine: number, line: number): string {
  if (line <= 0) return "";
  if (startLine > 0 && startLine !== line) return `Lines ${startLine}–${line}`;
  return `Line ${line}`;
}

/** Serialize a whole review thread — anchor + diff excerpt + every comment — to
 *  a self-contained markdown block (the per-comment "Copy markdown" copies just
 *  one body). Exported for testability. The diff uses a FOUR-backtick fence so a
 *  hunk from a markdown file that itself contains ``` lines can't break out. */
export function threadToMarkdown(thread: ReviewThreadOut): string {
  const label = lineLabel(thread.startLine, thread.line);
  const tags = [
    thread.isOutdated ? "outdated" : null,
    thread.isResolved ? "resolved" : null,
  ].filter(Boolean);
  const headerBits = [label, ...tags].filter(Boolean).join(" · ");
  const parts: string[] = [
    `**\`${thread.path}\`**${headerBits ? ` — ${headerBits}` : ""}`,
  ];
  if (thread.diffHunk !== "") {
    parts.push(`\`\`\`\`diff\n${thread.diffHunk}\n\`\`\`\``);
  }
  for (const c of thread.comments) {
    parts.push(`**${c.author || "unknown"}** (${c.date}):\n\n${c.body}`);
  }
  return parts.join("\n\n");
}

/** One rendered hunk line: its new-side number (blank for removed lines) and the
 *  raw content including the leading +/-/space marker. */
interface HunkLine {
  number: number | null;
  kind: "add" | "del" | "context";
  text: string;
}

/** The raw new-side text for lines `[from, to]` (inclusive, 1-based) of a hunk,
 *  markers stripped — the ORIGINAL lines a suggestion replaces. Returns null when
 *  the range isn't fully covered by the hunk (so the caller degrades instead of
 *  emitting a half-diff). Removed (`-`) lines carry no new-side number and are
 *  skipped; only additions + context lines have new-side line numbers. */
function newSideLines(
  parsed: HunkLine[],
  from: number,
  to: number,
): string[] | null {
  const byNumber = new Map<number, HunkLine>();
  for (const ln of parsed) if (ln.number !== null) byNumber.set(ln.number, ln);
  const picked: string[] = [];
  for (let n = from; n <= to; n += 1) {
    const hit = byNumber.get(n);
    if (!hit) return null; // gap — range not fully in the hunk
    // Strip the single leading marker (+ or space); del lines have no number.
    picked.push(hit.text.slice(1));
  }
  return picked;
}

/** One markdown run of a comment body, verbatim (between suggestion fences). */
interface MdSegment {
  kind: "md";
  text: string;
}

/** One top-level ```suggestion fence: its replacement lines plus, for GitLab's
 *  `suggestion:-N+M`, the range shift around the anchored line. */
interface SuggestionSegment {
  kind: "suggestion";
  replacement: string[];
  /** GitLab's `suggestion:-N+M` — `above` lines up, `below` lines down from the
   *  anchored line. Absent for a plain ```suggestion (both 0). */
  glRange?: { above: number; below: number };
}

export type BodySegment = MdSegment | SuggestionSegment;

/**
 * Split a comment body into ordered markdown / suggestion segments — the render
 * data behind GitHub's "Suggested changeset". Pure (no thread coupling), exported
 * for testability; copying still uses the RAW body.
 *
 * The fence scan is line-based and fence-depth aware: only a ```suggestion /
 * ```suggestion:-N+M fence opened at TOP LEVEL becomes a suggestion segment; one
 * nested inside a longer ````-quoted example stays verbatim markdown; an
 * unterminated suggestion fence runs to EOF. Bodies are LF (GitHub/GitLab
 * normalize). Consecutive markdown lines coalesce; empty `md` runs are dropped.
 */
export function splitSuggestionSegments(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  // Buffer of pending markdown lines; flushed as one `md` segment before each
  // suggestion and at the end (dropped when it holds no visible text).
  let mdBuf: string[] = [];
  const flushMd = () => {
    if (mdBuf.length === 0) return;
    const text = mdBuf.join("\n");
    if (text.trim() !== "") segments.push({ kind: "md", text });
    mdBuf = [];
  };

  const lines = body.split("\n");
  let i = 0;
  // The backtick run that opened the current NON-suggestion fence (0 = not in
  // one) — we only close on a lone run at least as long.
  let openFenceTicks = 0;

  while (i < lines.length) {
    const line = lines[i];
    const ticks = line.match(/^(`{3,})/)?.[1];

    if (openFenceTicks > 0) {
      // Inside a plain fence: pass through; close on a lone run of >= ticks.
      mdBuf.push(line);
      if (ticks && ticks.length >= openFenceTicks && line.trim() === ticks) {
        openFenceTicks = 0;
      }
      i += 1;
      continue;
    }

    // A top-level `suggestion` fence: `suggestion` or `suggestion:-N+M`.
    const sug = line.match(/^(`{3,})suggestion(:-(\d+)\+(\d+))?\s*$/);
    if (sug) {
      const openLen = sug[1].length;
      const above = sug[3] ? Number(sug[3]) : 0;
      const below = sug[4] ? Number(sug[4]) : 0;
      // Collect the replacement content up to the matching (>= length) close.
      const replacement: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const inner = lines[j].match(/^(`{3,})\s*$/)?.[1];
        if (inner && inner.length >= openLen) {
          closed = true;
          break;
        }
        replacement.push(lines[j]);
        j += 1;
      }
      flushMd();
      segments.push({
        kind: "suggestion",
        replacement,
        ...(above || below ? { glRange: { above, below } } : {}),
      });
      i = closed ? j + 1 : j;
      continue;
    }

    // Some other top-level fence opens — track its depth so a nested
    // ```suggestion inside it is NOT transformed.
    if (ticks) openFenceTicks = ticks.length;
    mdBuf.push(line);
    i += 1;
  }

  flushMd();
  return segments;
}

/** The original new-side lines a suggestion replaces, plus the 1-based start line
 *  for the apply write. Null when they can't be recovered (no hunk — the thread's
 *  own or one synthesized from the file's diff section — or a range that hunk
 *  doesn't fully cover): the caller degrades to a replacement-only block with no
 *  Apply. GitHub range = `[startLine>0 ? startLine : line, line]`; GitLab's
 *  `glRange` shifts it `above` up / `below` down around the anchored line. */
function recoverOriginals(
  thread: ReviewThreadOut,
  parsed: HunkLine[] | null,
  glRange: { above: number; below: number } | undefined,
  provider: ForgeProvider,
): { lines: string[]; startLine: number } | null {
  const anchor = thread.line;
  // Bare-fence (no `:-N+M`) semantics DIFFER per forge, and only the fence author's
  // provider disambiguates them:
  //  • GitHub: a bare fence in a ranged review comment replaces the WHOLE
  //    `startLine..line` range (documented GitHub behavior) — base = startLine.
  //  • GitLab: fence offsets are ALWAYS anchor-relative; a bare fence means exactly
  //    `:-0+0` — it replaces ONLY the anchored (end) line, whatever the comment's
  //    line_range says.
  // So normalize a GitLab bare fence to `{above:0, below:0}` and let the shared base
  // logic anchor it; every other provider keeps `undefined` → the startLine base.
  const effectiveGlRange =
    glRange ?? (provider === "gitlab" ? { above: 0, below: 0 } : undefined);
  const above = effectiveGlRange?.above ?? 0;
  const below = effectiveGlRange?.below ?? 0;
  // The base the fence range extends from. A GitLab `suggestion:-N+M` range is
  // ANCHOR-relative, so whenever a fence range is present the base is `anchor`, never
  // `startLine` (subtracting `above` from startLine would double-count the range and
  // Apply to the wrong lines). Only the bare-fence GitHub path uses `startLine`.
  const base = effectiveGlRange
    ? anchor
    : thread.startLine > 0
      ? thread.startLine
      : anchor;
  const from = base - above;
  const to = anchor + below;
  if (!parsed || anchor <= 0 || from <= 0) return null;
  const lines = newSideLines(parsed, from, to);
  return lines ? { lines, startLine: from } : null;
}

/** Parse a unified-diff hunk fragment into numbered lines. The first line is the
 *  `@@ -a,b +c,d @@` header; new-side numbers advance on context + added lines
 *  (removed lines carry no new-side number). Returns null when the fragment has
 *  no parseable header (render nothing rather than guess). */
function parseHunk(hunk: string): HunkLine[] | null {
  const lines = hunk.split("\n");
  const header = lines[0]?.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!header) return null;
  let newNo = Number(header[1]);
  const out: HunkLine[] = [];
  for (const raw of lines.slice(1)) {
    // GitHub's diffHunk has no trailing empty line, but guard anyway.
    if (raw === "" && out.length === 0) continue;
    const marker = raw[0];
    // `\ No newline at end of file` annotates the PREVIOUS line — it is not
    // content, so it gets no new-side number and must not advance the counter
    // (otherwise every line after a no-trailing-newline transition shifts by one,
    // and Apply's expected_lines/startLine — which now rely on this numbering —
    // would refuse a legitimate suggestion).
    if (marker === "\\") continue;
    if (marker === "+") {
      out.push({ number: newNo, kind: "add", text: raw });
      newNo += 1;
    } else if (marker === "-") {
      out.push({ number: null, kind: "del", text: raw });
    } else {
      // Context line (leading space) — or a stray blank; both advance new-side.
      out.push({ number: newNo, kind: "context", text: raw });
      newNo += 1;
    }
  }
  return out;
}

/**
 * One rendered diff row — the shared shape behind {@link HunkExcerpt} and
 * {@link SuggestionBlock}: a fixed-width gutter (new-side line number, or a +/-
 * marker) and mono content. The gutter marker/number keeps add/del legible without
 * relying on color (house "never color alone" rule).
 */
function DiffRow({
  kind,
  gutter,
  text,
}: {
  kind: "add" | "del" | "context";
  /** The new-side line number (HunkExcerpt) or the +/- marker (SuggestionBlock). */
  gutter: ReactNode;
  text: string;
}) {
  return (
    <div
      className={cn(
        "flex",
        kind === "add" && "bg-success/10 text-success",
        kind === "del" && "bg-destructive/10 text-destructive",
        kind === "context" && "text-muted-foreground",
      )}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right tabular-nums text-muted-foreground/70">
        {gutter}
      </span>
      <span className="whitespace-pre-wrap break-all pr-2">{text || " "}</span>
    </div>
  );
}

/**
 * The anchored code context above a thread's comments — GitHub's "Comment on
 * lines …" excerpt. Mono + diff +/- coloring via semantic tokens (the +/-
 * characters carry the meaning), no syntax highlighting (the fragment lacks
 * full-file context). Capped height, scrolled to the bottom on mount (the anchored
 * line is the hunk's tail). `ph-no-capture` because the Conversation ScrollArea is
 * NOT redacted (only the diff pane is) and this shows user code.
 */
function HunkExcerpt({ hunk, label }: { hunk: string; label: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const parsed = parseHunk(hunk);
  // Show the tail — the anchored line sits at the hunk's end, like GitHub.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  if (!parsed || parsed.length === 0) return null;
  return (
    <div className="ph-no-capture overflow-hidden rounded border text-xs">
      {label && (
        <div className="border-b bg-muted/30 px-2 py-1 font-mono text-muted-foreground">
          {label}
        </div>
      )}
      <div ref={scrollRef} className="max-h-40 overflow-y-auto font-mono">
        {parsed.map((ln, i) => (
          <DiffRow
            key={`${i}-${ln.number ?? "d"}`}
            kind={ln.kind}
            gutter={ln.number ?? ""}
            // Keep the leading +/-/space marker so the meaning isn't color-alone.
            text={ln.text}
          />
        ))}
      </div>
    </div>
  );
}

/** Gating inputs + the write for a suggestion's Apply affordance. Absent (no
 *  `apply` prop) = no Apply shown at all. */
export interface SuggestionApply {
  /** The PR head branch — Apply only makes sense while it's checked out. */
  headRefName: string;
  /** The repo's current branch (null when detached/unknown). */
  currentBranch: string | null;
  /** Writes the suggestion to the working tree; resolves with the stage result. */
  onApply: (args: {
    filePath: string;
    startLine: number;
    expectedLines: string[];
    replacementLines: string[];
  }) => Promise<ApplyLinesResult>;
}

/**
 * One ```suggestion block as GitHub's "Suggested change": a bordered card whose
 * body is the red/green line diff (originals as `-` rows, replacement as `+`),
 * plus an Apply that writes the suggestion to the local working tree.
 *
 * Apply shows only when the originals were recovered — the thread's own hunk
 * (GitHub) or one synthesized from the file's diff section (GitLab/Bitbucket) must
 * fully cover the range — AND an `apply` prop is present; otherwise it degrades to
 * a labeled replacement-only block.
 */
function SuggestionBlock({
  thread,
  parsed,
  segment,
  provider,
  apply,
  applied,
  onApplied,
}: {
  thread: ReviewThreadOut;
  parsed: HunkLine[] | null;
  segment: SuggestionSegment;
  /** The fence author's forge — disambiguates bare-fence Apply scope (GitHub =
   *  whole range, GitLab = anchored line only). See {@link recoverOriginals}. */
  provider: ForgeProvider;
  apply?: SuggestionApply;
  /** Whether this block was already applied in THIS view (dedupes a confusing
   *  second click; the backend content-verify would reject a real re-apply). */
  applied: boolean;
  onApplied: () => void;
}) {
  const [pending, setPending] = useState(false);
  const originals = recoverOriginals(thread, parsed, segment.glRange, provider);

  async function runApply() {
    if (!apply || !originals || pending) return;
    setPending(true);
    try {
      const result = await apply.onApply({
        filePath: thread.path,
        startLine: originals.startLine,
        expectedLines: originals.lines,
        replacementLines: segment.replacement,
      });
      if (result.staged) {
        toast.success("Suggestion applied and staged");
      } else if (result.hadLocalChanges) {
        toast.success(
          `Suggestion applied — not staged: ${thread.path} has other local changes`,
        );
      } else {
        toast.success("Suggestion applied");
      }
      onApplied();
    } catch (e) {
      toastError(e);
    } finally {
      setPending(false);
    }
  }

  const onWrongBranch =
    apply != null && apply.currentBranch !== apply.headRefName;
  const disabledReason = applied
    ? "This suggestion is already applied."
    : thread.isOutdated
      ? "This suggestion is outdated — the code has changed."
      : onWrongBranch
        ? `Check out ${apply?.headRefName} to apply.`
        : null;

  return (
    <div className="ph-no-capture overflow-hidden rounded border text-xs">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-2 py-1">
        <span className="font-mono text-muted-foreground">
          Suggested change
        </span>
        {originals && apply && (
          <>
            <span className="flex-1" />
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={pending || applied || disabledReason !== null}
              reason={disabledReason}
              onClick={runApply}
            >
              {pending && <Spinner className="size-3" />}
              {applied ? "Applied ✓" : "Apply"}
            </DisabledReasonButton>
          </>
        )}
      </div>
      <div className="font-mono">
        {/* Originals as `-` rows (destructive) — omitted when not recovered. */}
        {originals?.lines.map((l, i) => (
          <DiffRow key={`o-${i}`} kind="del" gutter="-" text={l} />
        ))}
        {/* Replacement as `+` rows (success). An empty suggestion = pure deletion. */}
        {segment.replacement.map((l, i) => (
          <DiffRow key={`r-${i}`} kind="add" gutter="+" text={l} />
        ))}
      </div>
    </div>
  );
}

/**
 * A single review thread. Collapsible: the header button toggles the body. When
 * `compact` (rendered inside a diff hunk) the padding tightens. `expanded` and
 * `onToggleExpand` are controlled by the caller so keyboard nav in the block can
 * drive the same collapse state the header click does.
 */
export function ReviewThreadCard({
  thread,
  expanded,
  onToggleExpand,
  onQuote,
  onReply,
  onResolve,
  onEditComment,
  editHeld,
  onDeleteComment,
  compact = false,
  onRowFocus,
  provider = "github",
  apply,
  fileDiffLookup,
  mentions,
  revealTarget = false,
  onRevealed,
}: {
  thread: ReviewThreadOut;
  expanded: boolean;
  onToggleExpand: () => void;
  compact?: boolean;
  /** Fired when the header button gains focus (keeps list activeIndex in sync). */
  onRowFocus?: () => void;
  /** True when this card is the target of a pending "reveal" (a timeline "View
   *  thread" jump). The card scrolls ITSELF via a layout effect on its own ref, so a
   *  card that only just mounted still scrolls on the first click; then it calls
   *  `onRevealed`. */
  revealTarget?: boolean;
  /** Cleared by the card once it has scrolled itself into view for a reveal. */
  onRevealed?: () => void;
  /** The fence author's forge — disambiguates bare-fence Apply scope (GitHub =
   *  whole range, GitLab = anchored line only). Defaults to "github". */
  provider?: ForgeProvider;
  /** Gating inputs + the write for the per-suggestion Apply affordance. Absent =
   *  no Apply is shown (the diff-anchor call site and any unwired surface). */
  apply?: SuggestionApply;
  /** Returns a path's unified-diff section. When a thread has no `diffHunk`
   *  (GitLab/Bitbucket) and isn't outdated, a hunk is synthesized from it so the
   *  excerpt + Apply gating work as they do for GitHub. Absent = no synthesis. */
  fileDiffLookup?: (path: string) => string | undefined;
  /** Opt in to `@`/`#`/`!` autocomplete in the reply and edit-in-place editors —
   *  only surfaces whose forge autolinks the completed reference pass one. */
  mentions?: MentionSource;
} & ThreadCallbacks) {
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyPending, setReplyPending] = useState(false);
  const [resolvePending, setResolvePending] = useState(false);
  // Mount-driven reveal: a layout effect keyed on `revealTarget` fires after the DOM
  // commit, so `rootRef` is live even for a card that mounted on this same click (its
  // resolved-group expander just opened) — no frame racing. Cleared via `onRevealed`
  // only once the scroll actually ran.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!revealTarget) return;
    const node = rootRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "nearest", behavior: "auto" });
    onRevealed?.();
  }, [revealTarget, onRevealed]);
  // Suggestion blocks applied in THIS view, keyed `${commentId}:${blockIndex}` — a
  // confusing re-click is prevented (the backend content-verify would reject a real
  // re-apply).
  const [appliedBlocks, setAppliedBlocks] = useState<Set<string>>(
    () => new Set(),
  );
  // The hunk this thread renders/gates Apply against: the provider's own `diffHunk`
  // when present (GitHub), else one synthesized from the file's current diff section
  // (GitLab/Bitbucket return none). Outdated threads keep the degraded render — never
  // synthesize against a diff the thread may no longer match.
  const effectiveHunk =
    thread.diffHunk !== ""
      ? thread.diffHunk
      : !thread.isOutdated && fileDiffLookup
        ? (synthesizeThreadHunk(fileDiffLookup(thread.path) ?? "", thread) ??
          "")
        : "";
  // Parse the anchored hunk once for every suggestion block in this thread's
  // comments to recover the originals it replaces (null when there's no hunk).
  const parsedHunk = effectiveHunk !== "" ? parseHunk(effectiveHunk) : null;
  const anchorLabel = lineLabel(thread.startLine, thread.line);
  // The excerpt only makes sense outside a diff (in compact mode the card already
  // sits under the real lines); absent when there's no hunk.
  const showExcerpt = !compact && effectiveHunk !== "";

  async function submitReply() {
    if (!onReply || !replyBody.trim() || replyPending) return;
    setReplyPending(true);
    try {
      await onReply(thread.id, replyBody.trim());
      // Clear only after the reply lands — a failure keeps the draft so the
      // user doesn't lose what they typed.
      setReplyBody("");
      setReplying(false);
    } catch (e) {
      toastError(e);
    } finally {
      setReplyPending(false);
    }
  }

  async function toggleResolve() {
    if (!onResolve || resolvePending) return;
    setResolvePending(true);
    try {
      await onResolve(thread.id, !thread.isResolved);
    } catch (e) {
      toastError(e);
    } finally {
      setResolvePending(false);
    }
  }

  return (
    <div ref={rootRef} className={cn("border", compact ? "text-xs" : "")}>
      <div
        className={cn(
          "flex items-center gap-2",
          compact ? "px-2 py-1" : "px-3 py-1.5",
        )}
      >
        <button
          type="button"
          data-thread-id={thread.id}
          aria-expanded={expanded}
          onClick={onToggleExpand}
          onFocus={onRowFocus}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          <CaretRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              expanded ? "rotate-90" : "",
            )}
          />
          {/* Line-range chip only — the file-group header (conversation) or the
              anchored diff line (compact) already carries the path. */}
          {anchorLabel && (
            <span className="truncate font-mono text-muted-foreground">
              {anchorLabel}
            </span>
          )}
          {thread.isOutdated && (
            <Badge variant="outline" className="shrink-0 text-warning">
              Outdated
            </Badge>
          )}
          {thread.isResolved && (
            <Badge variant="secondary" className="shrink-0 text-success">
              Resolved
            </Badge>
          )}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy thread as Markdown"
          title="Copy thread as Markdown"
          className="shrink-0 text-muted-foreground"
          // The header row toggles expand on click — stop the bubble so copying
          // doesn't also collapse the card (clickable-header row-bubble gotcha).
          onClick={(e) => {
            e.stopPropagation();
            copyText(threadToMarkdown(thread), "Markdown copied");
          }}
        >
          <CopyIcon className="size-3.5" />
        </Button>
        {onResolve && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            disabled={resolvePending}
            onClick={toggleResolve}
          >
            {resolvePending && <Spinner className="size-3" />}
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        )}
      </div>

      {expanded && (
        <div
          className={cn(
            "space-y-3 border-t",
            compact ? "px-2 py-2" : "px-3 py-2",
          )}
        >
          {showExcerpt && (
            <HunkExcerpt hunk={effectiveHunk} label={anchorLabel} />
          )}
          {thread.comments.map((c) => {
            const commentKey = c.id || `${c.author}-${c.date}`;
            return (
              <Thread
                key={commentKey}
                thread={c}
                onQuote={onQuote ? () => onQuote(c.body) : undefined}
                // Edit/delete only for a comment the viewer authored (the temp id
                // would 404 otherwise); the block passes the handlers only when the
                // provider + capability allow it.
                onSaveEdit={
                  onEditComment && c.viewerDidAuthor
                    ? (body) => onEditComment(c.id, body)
                    : undefined
                }
                editHeld={editHeld}
                onDelete={
                  onDeleteComment && c.viewerDidAuthor
                    ? () => onDeleteComment(c.id)
                    : undefined
                }
                mentions={mentions}
                // Splice SuggestionBlocks between markdown segments — quote and copy
                // still act on the RAW body, so only the render changes.
                renderBody={(body) => (
                  <div className="space-y-3">
                    {splitSuggestionSegments(body).map((seg, i) =>
                      seg.kind === "md" ? (
                        <Markdown key={i}>{seg.text}</Markdown>
                      ) : (
                        <SuggestionBlock
                          key={i}
                          thread={thread}
                          parsed={parsedHunk}
                          segment={seg}
                          provider={provider}
                          apply={apply}
                          applied={appliedBlocks.has(`${commentKey}:${i}`)}
                          onApplied={() =>
                            setAppliedBlocks((prev) =>
                              new Set(prev).add(`${commentKey}:${i}`),
                            )
                          }
                        />
                      ),
                    )}
                  </div>
                )}
              />
            );
          })}
          {onReply &&
            (replying ? (
              <div className="space-y-2">
                <MarkdownEditor
                  aria-label="Reply to review thread"
                  placeholder="Reply…"
                  value={replyBody}
                  onChange={setReplyBody}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      // preventDefault unconditionally: `commit` is bound to
                      // mod+enter and fires inside editable targets, so a chord
                      // this handler declines to submit would otherwise reach
                      // the global action.
                      e.preventDefault();
                      if (replyBody.trim() && !replyPending) submitReply();
                    }
                  }}
                  rows={2}
                  textareaClassName="max-h-32 min-h-12 resize-y"
                  mentions={mentions}
                />
                <div className="flex items-center gap-2">
                  <DisabledReasonButton
                    variant="outline"
                    size="sm"
                    disabled={!replyBody.trim() || replyPending}
                    reason={!replyBody.trim() ? "Write a reply first" : null}
                    title={SUBMIT_HINT}
                    onClick={submitReply}
                  >
                    {replyPending && <Spinner className="size-3" />}
                    Reply
                  </DisabledReasonButton>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={replyPending}
                    onClick={() => {
                      setReplying(false);
                      setReplyBody("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={() => setReplying(true)}
              >
                Reply…
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Threads grouped by path, preserving first-seen order. */
function groupByPath(
  threads: ReviewThreadOut[],
): [string, ReviewThreadOut[]][] {
  const groups = new Map<string, ReviewThreadOut[]>();
  for (const t of threads) {
    const bucket = groups.get(t.path);
    if (bucket) bucket.push(t);
    else groups.set(t.path, [t]);
  }
  return [...groups.entries()];
}

/** The per-file "✓ n resolved" expander that hides resolved threads until opened. */
function ResolvedExpander({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
    >
      <CaretRightIcon
        className={cn("size-3 transition-transform", open ? "rotate-90" : "")}
      />
      <span className="text-success">✓</span> {count} resolved
    </button>
  );
}

/**
 * The grouped, keyboard-navigable list of file:line review threads — by file,
 * unresolved-open / resolved-behind-an-expander, with every per-thread affordance
 * (reply, resolve, apply, copy, edit/delete). Rendered both inline under a review
 * event in the timeline and inside {@link ReviewThreadsBlock}. Owns its own expand
 * + arrow/Enter nav state, so each instance navigates on its own. The caller guards
 * emptiness.
 */
export function ReviewThreadList({
  threads,
  onQuote,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  editHeld,
  provider = "github",
  apply,
  fileDiffLookup,
  mentions,
  revealThreadId,
  onRevealed,
}: {
  threads: ReviewThreadOut[];
  /** The forge the threads came from — disambiguates bare-fence Apply scope,
   *  threaded to every card. Defaults to "github". */
  provider?: ForgeProvider;
  /** Gating inputs + the write for the per-suggestion Apply affordance, threaded
   *  straight to every card. Absent = no Apply shown. */
  apply?: SuggestionApply;
  /** File-section lookup for synthesizing a hunk on hunk-less providers, threaded
   *  to every card. Absent = no synthesis. */
  fileDiffLookup?: (path: string) => string | undefined;
  /** Opt in to `@`/`#`/`!` autocomplete in every card's editors. Absent = no
   *  autocomplete (any unwired surface). */
  mentions?: MentionSource;
  /** A thread id the parent wants revealed (e.g. a timeline "View thread" jump). When
   *  it matches one of THIS list's threads, the list opens that thread's
   *  resolved-group expander + expands the card so a resolved/collapsed target isn't
   *  a dead click. Ignored when the id isn't in this list. */
  revealThreadId?: string | null;
  /** Called once this list has acted on `revealThreadId`, so the parent can clear
   *  the request and it never re-fires. Only the list that owns the id calls it. */
  onRevealed?: () => void;
} & ThreadCallbacks) {
  // Which threads are expanded (unresolved default-open, resolved default-closed).
  const [collapsedUnresolved, setCollapsedUnresolved] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedResolved, setExpandedResolved] = useState<Set<string>>(
    () => new Set(),
  );
  // Which files have their resolved-threads expander open.
  const [openResolvedGroups, setOpenResolvedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeIndex, setActiveIndex] = useState(-1);

  const isExpanded = (t: ReviewThreadOut) =>
    t.isResolved ? expandedResolved.has(t.id) : !collapsedUnresolved.has(t.id);

  const toggleExpand = (t: ReviewThreadOut) => {
    const flip = (set: Set<string>) => {
      const next = new Set(set);
      if (next.has(t.id)) next.delete(t.id);
      else next.add(t.id);
      return next;
    };
    if (t.isResolved) setExpandedResolved(flip);
    else setCollapsedUnresolved(flip);
  };

  const toggleResolvedGroup = (path: string) =>
    setOpenResolvedGroups((set) => {
      const next = new Set(set);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // A reveal request from the parent: only the list that owns the id acts. This
  // effect only opens the STATE the target card needs to mount+expand (resolved cards
  // aren't mounted until their expander opens) — the card scrolls ITSELF and clears
  // via `onRevealed`, so the scroll is mount-driven, not frame-timed.
  // `threads`/`onRevealed` get fresh identities every parent render, so the ref keeps
  // the state opens idempotent per request id (and resets when it clears).
  const handledRevealRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealThreadId) {
      handledRevealRef.current = null;
      return;
    }
    if (handledRevealRef.current === revealThreadId) return;
    const target = threads.find((t) => t.id === revealThreadId);
    // Not in this list — leave the request for the sibling list that owns it.
    if (!target) return;
    handledRevealRef.current = revealThreadId;
    if (target.isResolved) {
      setOpenResolvedGroups((set) =>
        set.has(target.path) ? set : new Set(set).add(target.path),
      );
      setExpandedResolved((set) =>
        set.has(target.id) ? set : new Set(set).add(target.id),
      );
    } else {
      // Unresolved cards are open by default; if the user collapsed this one,
      // drop it from the collapsed set so it's expanded when the card scrolls.
      setCollapsedUnresolved((set) => {
        if (!set.has(target.id)) return set;
        const next = new Set(set);
        next.delete(target.id);
        return next;
      });
    }
  }, [revealThreadId, threads]);

  const groups = groupByPath(threads);

  // Flat, document-order list of thread headers the arrow keys walk across (over
  // file groups). Resolved threads inside a closed expander aren't focusable, so
  // they're excluded from the nav order.
  const navThreads: ReviewThreadOut[] = [];
  for (const [path, groupThreads] of groups) {
    const groupResolvedOpen = openResolvedGroups.has(path);
    for (const t of groupThreads) {
      if (t.isResolved && !groupResolvedOpen) continue;
      navThreads.push(t);
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter/Space on a focused header toggles that thread's collapse.
    if (e.key === "Enter" || e.key === " ") {
      const el = document.activeElement as HTMLElement | null;
      const id = el?.getAttribute("data-thread-id");
      if (id) {
        const t = navThreads.find((x) => x.id === id);
        if (t) {
          e.preventDefault();
          toggleExpand(t);
          return;
        }
      }
    }
    // Arrow keys inside the reply textarea move the cursor — don't hijack them
    // for list nav (listKeyboardNav preventDefault()s and steals focus).
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    listKeyboardNav({
      items: navThreads,
      activeIndex,
      onActivate: (_item, to) => setActiveIndex(to),
      rowKey: (t) => t.id,
      rowAttr: "data-thread-id",
    })(e);
  };

  // Arrow/Enter nav is captured here and dispatched to the focused row button
  // (each carries data-thread-id); the buttons are the interactive elements, so
  // no click-without-key handler lives on this wrapper.
  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      {groups.map(([path, groupThreads]) => {
        const unresolved = groupThreads.filter((t) => !t.isResolved);
        const resolved = groupThreads.filter((t) => t.isResolved);
        const resolvedOpen = openResolvedGroups.has(path);
        return (
          <div key={path} className="space-y-1.5">
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              onMouseEnter={clipTitle(path)}
            >
              {path}
            </p>
            <div className="space-y-1.5">
              {unresolved.map((t) => (
                <ReviewThreadCard
                  key={t.id}
                  thread={t}
                  expanded={isExpanded(t)}
                  onToggleExpand={() => toggleExpand(t)}
                  onRowFocus={() =>
                    setActiveIndex(navThreads.findIndex((x) => x.id === t.id))
                  }
                  onQuote={onQuote}
                  onReply={onReply}
                  onResolve={onResolve}
                  onEditComment={onEditComment}
                  onDeleteComment={onDeleteComment}
                  editHeld={editHeld}
                  provider={provider}
                  apply={apply}
                  fileDiffLookup={fileDiffLookup}
                  mentions={mentions}
                  revealTarget={t.id === revealThreadId}
                  onRevealed={onRevealed}
                />
              ))}
              {resolved.length > 0 && (
                <div className="space-y-1.5">
                  <ResolvedExpander
                    count={resolved.length}
                    open={resolvedOpen}
                    onToggle={() => toggleResolvedGroup(path)}
                  />
                  {resolvedOpen &&
                    resolved.map((t) => (
                      <ReviewThreadCard
                        key={t.id}
                        thread={t}
                        expanded={isExpanded(t)}
                        onToggleExpand={() => toggleExpand(t)}
                        onRowFocus={() =>
                          setActiveIndex(
                            navThreads.findIndex((x) => x.id === t.id),
                          )
                        }
                        onQuote={onQuote}
                        onReply={onReply}
                        onResolve={onResolve}
                        onEditComment={onEditComment}
                        onDeleteComment={onDeleteComment}
                        editHeld={editHeld}
                        provider={provider}
                        apply={apply}
                        fileDiffLookup={fileDiffLookup}
                        mentions={mentions}
                        revealTarget={t.id === revealThreadId}
                        onRevealed={onRevealed}
                      />
                    ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The residual "Review comments" block for the Conversation tab: the threads NOT
 * shown inline under a review — all threads on GitLab/Bitbucket (which don't model
 * reviews), plus standalone line comments on GitHub. Renders nothing when there are
 * none or while loading (the data arrives after the PR body, so a spinner would
 * only cause layout shift); a quiet muted line on error. `heading` lets the caller
 * retitle it when reviews DID claim threads above.
 */
export function ReviewThreadsBlock({
  threads,
  isError,
  heading = "Review comments",
  onQuote,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  editHeld,
  provider = "github",
  apply,
  fileDiffLookup,
  mentions,
  revealThreadId,
  onRevealed,
}: {
  threads: ReviewThreadOut[] | undefined;
  isError: boolean;
  /** Section heading — "Review comments" by default; callers pass e.g. "Other line
   *  comments" when some threads render inline under reviews above. */
  heading?: string;
  /** The forge the threads came from — disambiguates bare-fence Apply scope,
   *  threaded to every card. Defaults to "github". */
  provider?: ForgeProvider;
  /** Gating inputs + the write for the per-suggestion Apply affordance, threaded
   *  straight to every card. Absent = no Apply shown. */
  apply?: SuggestionApply;
  /** File-section lookup for synthesizing a hunk on hunk-less providers. Absent =
   *  no synthesis. */
  fileDiffLookup?: (path: string) => string | undefined;
  /** Opt in to `@`/`#`/`!` autocomplete in every card's editors. Absent = no
   *  autocomplete. */
  mentions?: MentionSource;
  /** A thread id to reveal (timeline "View thread" jump) — passed straight to the
   *  inner list, which acts only if the id is one of these residual threads. */
  revealThreadId?: string | null;
  /** Cleared once the inner list reveals the thread. */
  onRevealed?: () => void;
} & ThreadCallbacks) {
  if (isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn't load review comments.
      </p>
    );
  }
  // Nothing while loading (undefined) or when there are no threads — no noise.
  if (!threads || threads.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Total residual count — a "(0)" beside a visible resolved thread reads
          broken; the per-file "✓ n resolved" expander conveys resolved state. */}
      <h3 className="text-xs font-medium text-muted-foreground">
        {heading} ({threads.length})
      </h3>
      <ReviewThreadList
        threads={threads}
        onQuote={onQuote}
        onReply={onReply}
        onResolve={onResolve}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        editHeld={editHeld}
        provider={provider}
        apply={apply}
        fileDiffLookup={fileDiffLookup}
        mentions={mentions}
        revealThreadId={revealThreadId}
        onRevealed={onRevealed}
      />
    </div>
  );
}
