import { CaretRightIcon, CopyIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Spinner } from "@/components/ui/spinner";
import { Thread } from "@/features/conversations/Thread";
import { copyText } from "@/lib/clipboard";
import type { ApplyLinesResult, ReviewThreadOut } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Platform-correct submit-shortcut hint (⌘+Enter on macOS, Ctrl+Enter else) —
 *  never hardcode the modifier (house platform-mod-key rule). */
const SUBMIT_HINT = formatBinding("mod+enter");

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
}

/** The anchor label: "Lines a–b" for a range, "Line b" for a single line, "" at
 *  0 (unknown, e.g. an outdated thread). */
function lineLabel(startLine: number, line: number): string {
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
  const picked: string[] = [];
  for (let n = from; n <= to; n += 1) {
    const hit = parsed.find((ln) => ln.number === n);
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
 * data behind GitHub's "Suggested changeset" (the card renders `md` runs through
 * {@link Markdown} and each `suggestion` through {@link SuggestionBlock}). A pure
 * function (no thread coupling), exported for testability alongside
 * {@link threadToMarkdown}; that function keeps copying the RAW body.
 *
 * Fence scan is line-based and fence-depth aware, with the SAME semantics the old
 * markdown transform used: only a ```suggestion / ```suggestion:-N+M fence opened
 * at TOP LEVEL becomes a suggestion segment; a ```suggestion nested inside a
 * longer ````-quoted example stays verbatim markdown; an unterminated suggestion
 * fence runs to EOF. Bodies are LF (GitHub/GitLab normalize). Consecutive
 * markdown lines coalesce into one `md` segment; empty `md` runs are dropped.
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
      // Advance past the close fence (or to EOF for an unterminated fence).
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
 *  for the apply write — recovered from the thread's anchored hunk. Null when they
 *  can't be recovered (GitLab/Bitbucket, no hunk, or a range the hunk doesn't
 *  fully cover): the caller degrades to a replacement-only block with no Apply.
 *  GitHub range = `[startLine>0 ? startLine : line, line]`; GitLab's `glRange`
 *  shifts it `above` lines up / `below` lines down around the anchored line. */
function recoverOriginals(
  thread: ReviewThreadOut,
  parsed: HunkLine[] | null,
  glRange: { above: number; below: number } | undefined,
): { lines: string[]; startLine: number } | null {
  const anchor = thread.line;
  const above = glRange?.above ?? 0;
  const below = glRange?.below ?? 0;
  const from = (thread.startLine > 0 ? thread.startLine : anchor) - above;
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
 * One rendered diff row — the shared row shape behind {@link HunkExcerpt} and
 * {@link SuggestionBlock}: a fixed-width gutter (the new-side line number, or a
 * +/- marker for suggestion rows) and the mono content. Semantic tokens carry the
 * add/del/context color; the gutter marker/number keeps the meaning legible
 * without relying on color (house "never color alone" rule).
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
 * lines …" excerpt. Honest render: mono + diff +/- coloring via semantic tokens
 * (never color alone — the +/- characters carry the meaning), no syntax
 * highlighting (the fragment lacks full-file context). Capped height, scrolled
 * to the bottom on mount (the anchored line is the hunk's tail). `ph-no-capture`
 * because the Conversation ScrollArea is NOT redacted (only the diff pane is),
 * and this shows user code.
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
            // The raw hunk line keeps its leading +/- /space marker (as before),
            // so the +/- meaning stays legible in the content, not just color.
            text={ln.text}
          />
        ))}
      </div>
    </div>
  );
}

/** Gating inputs + the write for a suggestion's Apply affordance. Absent (the card
 *  receives no `apply` prop) = no Apply shown at all — the graceful default for the
 *  diff-anchor call site and any surface that hasn't wired the working-tree write. */
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
 * One ```suggestion block rendered as GitHub's "Suggested change": a bordered
 * card (visually consistent with {@link HunkExcerpt}) whose body is the red/green
 * line diff — the originals as `-` rows, the replacement as `+` rows — plus an
 * Apply affordance that writes the suggestion to the local working tree.
 *
 * Apply shows ONLY when the originals were recovered (implies GitHub + full hunk
 * coverage) AND an `apply` prop is present. When originals aren't recoverable
 * (GitLab/Bitbucket, or an uncovered range) it degrades to a labeled
 * replacement-only block with no Apply — never less than before. Every disabled
 * state explains WHY via a wrapping `<span title>` (a native-disabled button
 * swallows its own tooltip).
 */
function SuggestionBlock({
  thread,
  parsed,
  segment,
  apply,
  applied,
  onApplied,
}: {
  thread: ReviewThreadOut;
  parsed: HunkLine[] | null;
  segment: SuggestionSegment;
  apply?: SuggestionApply;
  /** Whether this block was already applied in THIS view (dedupes a confusing
   *  second click; the backend content-verify would reject a real re-apply). */
  applied: boolean;
  onApplied: () => void;
}) {
  const [pending, setPending] = useState(false);
  const originals = recoverOriginals(thread, parsed, segment.glRange);

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

  // Determine the Apply affordance state (only relevant once originals recovered).
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
            {/* Wrap the (possibly) disabled Button so its `title` still shows —
                a native-disabled button swallows the tooltip. */}
            <span title={disabledReason ?? undefined}>
              <Button
                variant="outline"
                size="xs"
                disabled={pending || applied || disabledReason !== null}
                onClick={runApply}
              >
                {pending && <Spinner className="size-3" />}
                {applied ? "Applied ✓" : "Apply"}
              </Button>
            </span>
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
  compact = false,
  onRowFocus,
  apply,
}: {
  thread: ReviewThreadOut;
  expanded: boolean;
  onToggleExpand: () => void;
  compact?: boolean;
  /** Fired when the header button gains focus (keeps list activeIndex in sync). */
  onRowFocus?: () => void;
  /** Gating inputs + the write for the per-suggestion Apply affordance. Absent =
   *  no Apply is shown (the diff-anchor call site and any unwired surface). */
  apply?: SuggestionApply;
} & ThreadCallbacks) {
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyPending, setReplyPending] = useState(false);
  const [resolvePending, setResolvePending] = useState(false);
  // Suggestion blocks applied in THIS view, keyed `${commentId}:${blockIndex}`,
  // so the Apply button becomes a disabled "Applied ✓" and a confusing re-click
  // is prevented (the backend content-verify would reject a real re-apply anyway).
  const [appliedBlocks, setAppliedBlocks] = useState<Set<string>>(
    () => new Set(),
  );
  // Parse the anchored hunk once for every suggestion block in this thread's
  // comments to recover the originals it replaces (null for GitLab/Bitbucket).
  const parsedHunk = thread.diffHunk !== "" ? parseHunk(thread.diffHunk) : null;
  const anchorLabel = lineLabel(thread.startLine, thread.line);
  // The anchored-code excerpt only makes sense in the conversation (non-compact)
  // context; inside a diff the card already sits under the real lines. Absent
  // when the provider has no hunk (GitLab/Bitbucket) — graceful degradation.
  const showExcerpt = !compact && thread.diffHunk !== "";

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
    <div className={cn("border", compact ? "text-xs" : "")}>
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
            <HunkExcerpt hunk={thread.diffHunk} label={anchorLabel} />
          )}
          {thread.comments.map((c) => {
            const commentKey = c.id || `${c.author}-${c.date}`;
            return (
              <Thread
                key={commentKey}
                thread={c}
                onQuote={onQuote ? () => onQuote(c.body) : undefined}
                // Splice real SuggestionBlocks between markdown segments — quote
                // and copy still act on the RAW body (Thread passes `thread.body`
                // to both), so only the on-screen render changes.
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
                    if (
                      (e.ctrlKey || e.metaKey) &&
                      e.key === "Enter" &&
                      replyBody.trim() &&
                      !replyPending
                    ) {
                      e.preventDefault();
                      submitReply();
                    }
                  }}
                  rows={2}
                  textareaClassName="max-h-32 min-h-12 resize-y"
                />
                <div className="flex items-center gap-2">
                  {/* Wrap the disabled Button so its `title` (the "why") still
                      shows — a natively-disabled button swallows the tooltip. */}
                  <span
                    title={
                      !replyBody.trim() ? "Write a reply first" : SUBMIT_HINT
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!replyBody.trim() || replyPending}
                      onClick={submitReply}
                    >
                      {replyPending && <Spinner className="size-3" />}
                      Reply
                    </Button>
                  </span>
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
 * The grouped "Review comments" block for the Conversation tab. Renders nothing
 * when there are no threads (or while loading — the data arrives after the PR
 * body, so a spinner would only cause layout shift); a quiet muted line on
 * error. Header count is the total thread count.
 */
export function ReviewThreadsBlock({
  threads,
  isError,
  onQuote,
  onReply,
  onResolve,
  apply,
}: {
  threads: ReviewThreadOut[] | undefined;
  isError: boolean;
  /** Gating inputs + the write for the per-suggestion Apply affordance, threaded
   *  straight to every card. Absent = no Apply shown. */
  apply?: SuggestionApply;
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

  if (isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn't load review comments.
      </p>
    );
  }
  // Nothing while loading (undefined) or when there are no threads — no noise.
  if (!threads || threads.length === 0) return null;

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

  return (
    <div className="space-y-3">
      {/* Total thread count — a "(0)" beside a visible resolved thread reads
          broken; the per-file "✓ n resolved" expander conveys resolved state. */}
      <h3 className="text-xs font-medium text-muted-foreground">
        Review comments ({threads.length})
      </h3>
      {/* Arrow/Enter nav is captured here and dispatched to the focused row
          button (each carries data-thread-id); the buttons are the interactive
          elements, so no click-without-key handler lives on this wrapper. */}
      <div className="space-y-4" onKeyDown={onKeyDown}>
        {groups.map(([path, groupThreads]) => {
          const unresolved = groupThreads.filter((t) => !t.isResolved);
          const resolved = groupThreads.filter((t) => t.isResolved);
          const resolvedOpen = openResolvedGroups.has(path);
          return (
            <div key={path} className="space-y-1.5">
              <p className="truncate font-mono text-xs text-muted-foreground">
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
                    apply={apply}
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
                          apply={apply}
                        />
                      ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
