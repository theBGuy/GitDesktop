import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Markdown } from "@/components/markdown/markdown";
import { hostedImagesFor } from "@/components/markdown/markdown-images";
import type { MarkdownRefs } from "@/components/markdown/markdown-refs";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { DegradedListNotice } from "@/features/conversations/ConversationListPanel";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import { sectionReadNotice } from "@/features/conversations/remote-section-state";
import { Thread } from "@/features/conversations/Thread";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import {
  capDiffText,
  DIFF_LINE_CAP,
  DIFF_MEGA_LINE_CHARS,
  longestLineLength,
} from "@/features/diff/cap-diff";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import {
  SHOW_WHITESPACE_LABEL,
  WHITESPACE_COMPOSER_HELD,
  whitespaceComposerOpen,
} from "@/features/diff/whitespace-mode";
import { usePrCapabilities } from "@/features/pulls/usePrCapabilities";
import { clipTitleFromText } from "@/lib/clip-title";
import { diffLines, type splitUnifiedDiff } from "@/lib/git/diff-split";
import { useForgeGhHost } from "@/lib/git/host";
import {
  COMMIT_COMMENT_WRITES_FAMILY,
  type CommitCommentWriteVars,
  forgeReady,
  pendingWriteMatching,
  useCommitComments,
  useCommitFilePlainDiff,
  useCreateCommitComment,
  useDeleteCommitComment,
  useEditCommitComment,
  useForgeStatus,
  usePendingRepoWrites,
} from "@/lib/git/queries";
import type {
  CommitCommentOut,
  FileDiff,
  ForgeProvider,
  PrThreadOut,
  RemoteLens,
} from "@/lib/git/types";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import {
  COMMENT_DELETE_PENDING_REASON,
  COMMENT_POST_PENDING_REASON,
  pendingWriteReason,
} from "@/lib/offline-writes";
import {
  useHideWhitespace,
  useSetHideWhitespace,
} from "@/lib/settings/hide-whitespace";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";
import { useLatestRef } from "@/lib/use-latest-ref";

export type DiffSections = ReturnType<typeof splitUnifiedDiff>;

/** Whether a repo's commit-comment surface can light up at all: a ready forge
 *  whose provider takes commit comments. The on-remote verdict is read, and
 *  prefetched, only under it: each read spawns a `for-each-ref --contains`. */
export function useCommitCommentsGate(repoPath: string): boolean {
  const forge = useForgeStatus(repoPath);
  const { canCommentCommits } = usePrCapabilities(
    forge.data,
    forge.data?.provider,
  );
  return forgeReady(forge.data) && canCommentCommits;
}

/**
 * Derive the new-side (right) line a GitHub commit comment anchors to from its
 * diff `position`. GitHub sends `position` (1-based index of the line within the
 * file's patch, counting every hunk line after the first `@@` header, subsequent
 * hunk headers included) but often leaves `line` null, so the position must be walked
 * against the file's own diff section. Returns null when the section is absent, the
 * position is out of range, or the target isn't on the new side.
 *
 * `\ No newline at end of file` markers COUNT toward `position` but are not
 * content: they never advance the new-side counter and are never a valid anchor
 * (advancing on them would shift every line after the transition by one).
 */
export function lineFromPosition(
  section: string | undefined,
  position: number | null,
): number | null {
  if (!section || position == null || position < 1) return null;
  return patchPositions(section)[position - 1] ?? null;
}

/**
 * The inverse of {@link lineFromPosition}: given a new-side line number, return the
 * GitHub commit-comment `position` that anchors to it, walking the file's diff
 * section with the same counting rules forward. Returns null when the section is
 * absent, has no hunk header, or the line never appears on the new side (it wasn't
 * in this commit's diff for that file) — the caller then disables the post with a
 * visible reason. `\` lines count toward `position` but never anchor a comment.
 */
export function positionFromLine(
  section: string | undefined,
  line: number | null,
): number | null {
  if (!section || line == null || line < 1) return null;
  const at = patchPositions(section).indexOf(line);
  return at === -1 ? null : at + 1;
}

const HUNK_COUNTS = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The new-side line at each GitHub `position` of a file's diff section (index 0
 * is position 1; null for a later hunk header, a `\` marker or a removed line).
 * Both position functions read this one walk, so they stay each other's inverse.
 * Each hunk is bounded by its header's counts, as {@link newSideLines} reads
 * them: a line past the last hunk, or a joined section's second file header,
 * is no line of any hunk and has no position.
 */
function patchPositions(section: string): (number | null)[] {
  const at: (number | null)[] = [];
  let hunks = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  // The line before was a hunk's own, so a `\` marker here is still its.
  let afterHunkLine = false;
  for (const l of diffLines(section)) {
    if (oldLeft <= 0 && newLeft <= 0) {
      if (afterHunkLine && l.startsWith("\\")) {
        at.push(null);
        continue;
      }
      afterHunkLine = false;
      const m = HUNK_COUNTS.exec(l);
      if (!m) continue;
      // Position 1 is the line after the first header; each later one counts.
      if (hunks > 0) at.push(null);
      hunks += 1;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLine = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
      continue;
    }
    afterHunkLine = true;
    // `\ No newline…`: counts toward position, never advances the new-side counter.
    if (l.startsWith("\\")) {
      at.push(null);
      continue;
    }
    // Removed line: no new-side number.
    if (l.startsWith("-")) {
      oldLeft--;
      at.push(null);
      continue;
    }
    // Context (" ") or added ("+") line takes the next new-side number.
    if (!l.startsWith("+")) oldLeft--;
    newLeft--;
    at.push(newLine);
    newLine += 1;
  }
  return at;
}

/**
 * The new-side line numbers a unified diff text can draw, counted as
 * {@link lineFromPosition} counts them. Each hunk is bounded by its header's
 * counts (an omitted count is 1), so a second file's header inside a joined
 * section is never read as a line.
 */
export function newSideLines(text: string): Set<number> {
  const out = new Set<number>();
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const l of diffLines(text)) {
    if (oldLeft <= 0 && newLeft <= 0) {
      const m = HUNK_COUNTS.exec(l);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLine = Number(m[2]);
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
      }
      continue;
    }
    if (l.startsWith("\\")) continue;
    if (l.startsWith("-")) {
      oldLeft--;
      continue;
    }
    if (!l.startsWith("+")) oldLeft--;
    if (newLeft > 0) out.add(newLine);
    newLine++;
    newLeft--;
  }
  return out;
}

/** A truncated read's text minus its last line, which the cut may have split. */
function withoutLastLine(text: string): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.slice(0, body.lastIndexOf("\n") + 1);
}

/** The new-side lines the pane draws by default from a whitespace-shown read:
 *  line-capped, none for a binary or generated-looking file. */
function linesShownByDefault(plain: FileDiff | undefined): Set<number> {
  if (
    plain === undefined ||
    plain.isBinary ||
    longestLineLength(plain.text) > DIFF_MEGA_LINE_CHARS
  )
    return new Set();
  const text = plain.isTruncated ? withoutLastLine(plain.text) : plain.text;
  return newSideLines(capDiffText(text, DIFF_LINE_CAP).text);
}

/** The note a listed comment on the open file carries. */
type HiddenReason = "unplaced" | "whitespace";
const HIDDEN_REASON_COPY: Record<HiddenReason, string> = {
  unplaced: " · couldn't place in this diff",
  whitespace: " · on a line hidden by Hide whitespace",
};

/** How long a Show whitespace press waits for its thread to draw inline,
 *  counted from the press: a flip that never renders its shown mode (rolled
 *  back or coalesced) must not leave the landing armed for a later flip. */
const LANDING_TIMEOUT_MS = 2000;

/** Watches anywhere for what `whitespaceComposerOpen` reads: a line composer
 *  mounting or unmounting, and the marks on composer wrappers, row wrappers and
 *  Thread roots changing. The probe is a DOM query, and none of those changes
 *  this component's React state. */
function subscribeBodyMutations(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-diff-line-widget",
      "data-whitespace-row",
      "data-thread-editing",
      "data-diff-anchor",
      "data-diff-editor",
    ],
  });
  return () => observer.disconnect();
}
const subscribeNothing = () => () => undefined;
const notHeld = () => false;

/**
 * The inline diff anchors for a commit's line-anchored comments on ONE file:
 * every comment on `path` that resolves to a new-side line, grouped by that line
 * into a single stacked {@link DiffLineAnchor} (DiffSurface keeps one entry per
 * line/side, so same-line comments MUST be pre-grouped). A comment's line is its
 * own `line` when present, else recovered from `position` via
 * {@link lineFromPosition}; unresolvable comments are dropped here and surface in
 * {@link CommitComments}' labelled group instead. A ranged comment gets a small
 * mono range chip.
 */
export function useCommitLineAnchors(
  comments: CommitCommentOut[] | undefined,
  sections: DiffSections | undefined,
  path: string | null,
  refs?: MarkdownRefs,
): DiffLineAnchor[] {
  // Held by field, not by object: `useMentionCandidates` rebuilds `refs` every
  // render, and DiffSurface keys its widgets on anchor identity — an object dep
  // would re-identify every anchor on every pass.
  const refProvider = refs?.provider;
  const refRepoPath = refs?.repoPath;
  const refLens = refs?.lens;
  // Without refs, the open repo's forge-status key: one the view already
  // observes, so no probe runs on an empty path. Its answer goes unused then.
  const openRepo = useUiStore((s) => s.repoPath);
  const ghHost = useForgeGhHost(refRepoPath ?? openRepo ?? "");
  return useMemo<DiffLineAnchor[]>(() => {
    if (!path) return [];
    const bodyRefs: MarkdownRefs | undefined =
      refProvider && refRepoPath && refLens
        ? { provider: refProvider, repoPath: refRepoPath, lens: refLens }
        : undefined;
    const bodyHosted = hostedImagesFor(refRepoPath, ghHost);
    const byLine = new Map<number, CommitCommentOut[]>();
    for (const c of comments ?? []) {
      if (c.path !== path) continue;
      const line = c.line ?? lineFromPosition(sections?.get(path), c.position);
      if (line == null) continue;
      const bucket = byLine.get(line);
      if (bucket) bucket.push(c);
      else byLine.set(line, [c]);
    }
    return [...byLine.entries()].map(([line, group]) => ({
      side: "new" as const,
      line,
      // A programmatic focus target (the Show whitespace landing), never a tab stop.
      render: () => (
        <div
          tabIndex={-1}
          role="group"
          aria-label={`Comments on line ${line}`}
          data-commit-comment-line={line}
          className="space-y-2 outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          {group.map((c) => (
            <div key={c.id} data-commit-comment-id={c.id} className="space-y-1">
              <div className="flex items-center gap-1.5">
                {c.startLine != null && c.startLine !== line && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    Lines {c.startLine}–{line}
                  </span>
                )}
                <p className="text-[11px] font-medium">{c.author}</p>
              </div>
              <Markdown refs={bodyRefs} hostedImages={bodyHosted}>
                {c.body}
              </Markdown>
            </div>
          ))}
        </div>
      ),
    }));
  }, [comments, sections, path, refProvider, refRepoPath, refLens, ghHost]);
}

/** Map a flat commit comment onto the {@link Thread} prop shape — commit
 *  comments carry no review state / minimize / permalink, so those go empty. */
function toThread(c: CommitCommentOut): PrThreadOut {
  return {
    author: c.author,
    // The commit-comment payload carries no avatar URL on any provider, so pass "" —
    // ForgeUserAvatar derives one from the login on GitHub and falls back to initials
    // elsewhere.
    authorAvatarUrl: "",
    state: "",
    body: c.body,
    date: c.createdAt,
    id: c.id,
    url: "",
    viewerDidAuthor: c.viewerDidAuthor,
    isMinimized: false,
    minimizedReason: "",
    // Commit comments belong to no review.
    reviewId: "",
  };
}

/**
 * The comment surface for a single commit: whole-commit comments as a flat thread
 * list, line-anchored comments grouped by `path:line`, and a whole-commit composer.
 * Inline rendering in the diff pane needs BOTH the selected file and a resolved
 * new-side line: selected-file comments that miss lead the group below, marked
 * couldn't-place once `diffReady` says the file's patch was actually walked, and
 * every other anchored comment follows under its path — so none is silently dropped.
 *
 * It owns its pane sizing: a bottom pane capped at 45% of its flex-column parent,
 * so a caller drops it in as a sibling rather than wrapping it.
 */
export function CommitComments({
  repoPath,
  sha,
  canComment,
  remoteLabel,
  diffSections,
  selectedPath,
  selectedBinary = false,
  onSelectFile,
  lens,
  stale = false,
  held = false,
  enabled = true,
  diffReady = true,
  drawnDiff,
  whitespaceShownDiff,
}: {
  repoPath: string;
  sha: string;
  canComment: boolean;
  remoteLabel: string;
  /** Per-file diff sections, so line-anchored comments can resolve their line. */
  diffSections?: DiffSections;
  /** The file currently open in the diff pane — its resolvable anchored comments
   *  render inline there, so they're excluded from the labelled group below. */
  selectedPath?: string | null;
  /** The selected file renders through the binary arm, which draws no line
   *  anchors, so its anchored comments stay in the labelled group. */
  selectedBinary?: boolean;
  /** Selects a file in the sidebar; makes each group's path label a button that
   *  jumps to that file's diff. Absent = the label is plain text. */
  onSelectFile?: (path: string) => void;
  /** Which repo the commit's comments live on: "origin" (the History surface, or
   *  a non-fork) or the parent under the upstream lens (PR-commit context). */
  lens: RemoteLens;
  /** The parent is mid-switch, showing placeholder data while another commit
   *  loads — pass it so writes hold until the shown commit settles. */
  stale?: boolean;
  /** `enabled` is the PREVIOUS commit's held verdict, not yet confirmed for `sha`:
   *  the pane stays mounted, but the read and every write hold until it settles. */
  held?: boolean;
  /** Whether this commit takes comments at all. False renders nothing, but the
   *  component STAYS MOUNTED so per-commit drafts survive a commit that doesn't
   *  (yet) support them; the read is disabled with it. */
  enabled?: boolean;
  /** Whether `diffSections` reflects a settled read of THIS commit's patch. False
   *  (loading, errored, or another commit's placeholder) makes a `position`-derived
   *  line unresolvable, so the couldn't-place marker is withheld rather than blaming
   *  the comment for a missing patch. */
  diffReady?: boolean;
  /** The diff the selected file's pane draws, on a host that draws the local
   *  commit view diff (which follows Hide whitespace): its settled read for
   *  exactly `sha` + `selectedPath`, or null while that isn't known. Omitted =
   *  the pane draws `diffSections`' section. */
  drawnDiff?: FileDiff | null;
  /** The selected file's whitespace-shown diff, on a host that already holds
   *  it (a forge patch's section): replaces the local read, which fails for a
   *  commit this clone lacks. Omitted = read it locally. */
  whitespaceShownDiff?: FileDiff;
}) {
  const comments = useCommitComments(
    repoPath,
    enabled && !held ? sha : null,
    lens,
  );
  const createComment = useCreateCommitComment(repoPath, lens);
  const editComment = useEditCommitComment(repoPath, lens);
  const deleteComment = useDeleteCommitComment(repoPath, lens);
  // This commit's own writes, from the cache: neither host keys this pane on the
  // commit, so another commit's write never holds it, nor one under the other
  // lens (the key carries it). Only a whole-commit create holds the composer; a
  // line comment's create always carries its `path`.
  const commentWrites = usePendingRepoWrites(
    COMMIT_COMMENT_WRITES_FAMILY,
    repoPath,
    [lens],
  );
  const creating = pendingWriteMatching(
    commentWrites,
    "create",
    (v: CommitCommentWriteVars["create"]) => v.sha === sha && v.path == null,
  );
  const editing = pendingWriteMatching(
    commentWrites,
    "edit",
    (v: CommitCommentWriteVars["edit"]) => v.sha === sha,
  );
  const deleting = pendingWriteMatching(
    commentWrites,
    "delete",
    (v: CommitCommentWriteVars["delete"]) => v.sha === sha,
  );
  // The pane takes `remoteLabel`, not the provider, and which triggers autolink
  // is a per-forge fact — read it from the shared forge status.
  const forge = useForgeStatus(repoPath);
  const mentions = useMentionCandidates({
    repoPath,
    lens,
    provider: forge.data?.provider,
  });

  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Identity is the same triple the comments are read and written under.
  const commitIdentity = `${repoPath}#${lens}#${sha}`;
  const draft = useKeyedEntityState(commitIdentity, "");
  // Neither call site keys this component on the commit, so a different commit
  // must never inherit the previous one's pending delete confirm — a render-time
  // state adjustment, not an effect.
  const [lastIdentity, setLastIdentity] = useState(commitIdentity);
  if (commitIdentity !== lastIdentity) {
    setLastIdentity(commitIdentity);
    setDeletingId(null);
  }

  const list = comments.data ?? [];
  const notice = sectionReadNotice({
    noun: "comments",
    loadFailed: "Couldn't load comments for this commit.",
    rowCount: comments.data?.length,
    isError: comments.isError,
    isPaused: comments.isPaused,
    isFetching: comments.isFetching,
  });
  const whole = list.filter((c) => c.path == null);
  const anchored = list.filter((c) => c.path != null);

  // While a commit's comments load, the pane keeps the height it last had with
  // an answer (a list or a notice), so the diff above moves once, when the list
  // lands, instead of collapsing to the loading line first. Measured after each
  // render that shows an answer; the loading edge sets the floor in a layout
  // effect, whose re-render lands before the collapsed frame paints.
  const paneRef = useRef<HTMLDivElement>(null);
  const answeredHeight = useRef<number | null>(null);
  const [loadingFloor, setLoadingFloor] = useState<number | null>(null);
  const listLoading = enabled && comments.data === undefined && notice === null;
  useLayoutEffect(() => {
    if (!enabled) {
      answeredHeight.current = null;
    } else if (!listLoading) {
      answeredHeight.current = paneRef.current?.offsetHeight ?? null;
      setLoadingFloor(null);
    } else if (answeredHeight.current !== null) {
      setLoadingFloor(answeredHeight.current);
    }
  });

  // What the selected file's pane draws, or null when that isn't known. A `-w`
  // read while the setting is already off is a flip in flight: the pane stops
  // painting it then, so it judges nothing.
  const hide = useHideWhitespace();
  const drawn = (() => {
    if (drawnDiff === undefined) {
      const section = selectedPath
        ? diffSections?.get(selectedPath)
        : undefined;
      return diffReady && section !== undefined
        ? { text: section, fromHost: false, whitespaceHidden: false }
        : null;
    }
    if (drawnDiff === null || (drawnDiff.whitespaceHidden === true && !hide))
      return null;
    return {
      text: drawnDiff.text,
      fromHost: true,
      // A truncated read can't prove a line missing for whitespace's sake.
      whitespaceHidden:
        drawnDiff.whitespaceHidden === true && drawnDiff.isTruncated !== true,
    };
  })();
  const drawnText = drawn?.text;
  const drawnLines = useMemo(
    () => (drawnText === undefined ? null : newSideLines(drawnText)),
    [drawnText],
  );
  const whitespaceCanExplain =
    drawn !== null && drawn.fromHost && drawn.whitespaceHidden;

  // Anchored comments NOT visible inline: one renders inline only when it's on the
  // selected file, resolves to a new-side line the pane draws (any resolved line
  // while that's unknown), and the file isn't drawn by the
  // binary arm (which draws no lines). Everything else surfaces below
  // under its `path:line` label, with the resolved line when we have one. Until
  // `diffReady`, no patch-derived line counts as resolved — its inline anchor doesn't
  // exist yet, so excluding the comment here would hide it. A server-provided `line`
  // never depends on the patch and stays resolved throughout.
  // Selected-file entries lead the group: they're retained only when their line
  // didn't resolve or the binary arm drew the file, and under a cross-file label
  // they read as another file's comment.
  const orderedHidden = useMemo(() => {
    const retained = anchored
      .map((c) => {
        const path = c.path as string;
        const line =
          c.line ??
          (diffReady
            ? lineFromPosition(diffSections?.get(path), c.position)
            : null);
        return { comment: c, path, line, startLine: c.startLine };
      })
      .filter(
        ({ path, line }) =>
          !(
            path === selectedPath &&
            line != null &&
            !selectedBinary &&
            (drawnLines === null || drawnLines.has(line))
          ),
      );
    return [
      ...retained.filter(({ path }) => path === selectedPath),
      ...retained.filter(({ path }) => path !== selectedPath),
    ];
  }, [
    anchored,
    diffSections,
    selectedPath,
    selectedBinary,
    diffReady,
    drawnLines,
  ]);

  // The whitespace-shown read is positive evidence a listed line is hidden by
  // the mode; read only while a listed comment could be one.
  const needsPlain =
    whitespaceCanExplain &&
    !selectedBinary &&
    orderedHidden.some(
      ({ path, line }) => path === selectedPath && line != null,
    );
  const plainDiff = useCommitFilePlainDiff(
    repoPath,
    sha,
    selectedPath ?? null,
    needsPlain && whitespaceShownDiff === undefined,
  );
  const plainData = whitespaceShownDiff ?? plainDiff.data;
  const plainFailed = whitespaceShownDiff === undefined && plainDiff.isError;
  const shownLines = useMemo(() => linesShownByDefault(plainData), [plainData]);
  // The note on a listed comment of the open file; null = no note yet.
  // A resolved line here is one the drawn diff lacks, so it needs no forge patch.
  const reasonFor = (line: number | null): HiddenReason | null => {
    if (line == null || selectedBinary) return diffReady ? "unplaced" : null;
    if (!whitespaceCanExplain) return "unplaced";
    if (plainData !== undefined)
      return shownLines.has(line) ? "whitespace" : "unplaced";
    return plainFailed ? "unplaced" : null;
  };
  const rows = orderedHidden.map((r) => ({
    ...r,
    reason: r.path === selectedPath ? reasonFor(r.line) : null,
  }));
  const showsWhitespaceRow =
    enabled &&
    comments.data !== undefined &&
    rows.some((r) => r.reason === "whitespace");
  // On a host whose diff follows the setting (the one passing `drawnDiff`),
  // any selected-file row with a resolved line may leave on a flip, so an edit
  // open in one holds it. Turning the setting off leaves the `-w` read in hand
  // judging nothing until the shown read lands; turning it on draws a `-w` read
  // whose hunks git can align over lines no shown hunk covers, or past a
  // truncated shown read's cut. Null is that host before its read settles.
  const flipDropsRows = drawnDiff !== undefined && !selectedBinary;

  // Live while a Show whitespace button is mounted: a composer can open or
  // close under a button that stays.
  const composerHeld = useSyncExternalStore(
    showsWhitespaceRow ? subscribeBodyMutations : subscribeNothing,
    showsWhitespaceRow ? whitespaceComposerOpen : notHeld,
  );
  const listRef = useRef<HTMLDivElement>(null);
  // A flip by another route (palette, gear sheet, another window) unmounts a
  // focused button; only that edge is rescued. Blur from a node being removed
  // keeps the flag, since the rescue needs it.
  const buttonFocused = useRef(false);
  useFocusOnControlsSwap(showsWhitespaceRow, listRef, buttonFocused);
  const labelIdBase = useId();
  const setHideWhitespace = useSetHideWhitespace();
  const landing = useRef<{
    identity: string;
    path: string | null;
    commentId: string;
    deadline: number;
  } | null>(null);
  const live = useLatestRef({ commitIdentity, selectedPath });

  function showWhitespace(commentId: string) {
    if (whitespaceComposerOpen()) {
      toast.info(WHITESPACE_COMPOSER_HELD);
      return;
    }
    // The pressed button leaves with its row; the list holds focus until the
    // thread draws inline.
    listRef.current?.focus({ preventScroll: true });
    landing.current = {
      identity: commitIdentity,
      path: selectedPath ?? null,
      commentId,
      deadline: performance.now() + LANDING_TIMEOUT_MS,
    };
    setHideWhitespace(false);
  }

  // Lands focus on the thread once the whitespace-shown diff draws it. Any
  // commit or file change drops the landing, re-checked when the node appears,
  // since a mutation callback can run before this effect re-keys.
  useEffect(() => {
    const armed = landing.current;
    if (armed === null) return;
    if (
      armed.identity !== commitIdentity ||
      armed.path !== (selectedPath ?? null)
    ) {
      landing.current = null;
      return;
    }
    if (hide) return;
    const remaining = armed.deadline - performance.now();
    if (remaining <= 0) {
      landing.current = null;
      return;
    }
    const root = paneRef.current?.parentElement;
    const sink = listRef.current;
    if (!root) {
      landing.current = null;
      return;
    }
    const tryLand = (): boolean => {
      const now = live.current;
      if (
        landing.current !== armed ||
        performance.now() > armed.deadline ||
        now.commitIdentity !== armed.identity ||
        (now.selectedPath ?? null) !== armed.path
      ) {
        if (landing.current === armed) landing.current = null;
        return true;
      }
      const target = Array.from(
        root.querySelectorAll<HTMLElement>("[data-commit-comment-id]"),
      ).find(
        (el) =>
          el.dataset.commitCommentId === armed.commentId &&
          el.closest("[inert]") === null,
      );
      const group = target?.closest<HTMLElement>("[data-commit-comment-line]");
      if (!group) return false;
      landing.current = null;
      const active = document.activeElement;
      if (active === sink || active === document.body || active === null)
        group.focus();
      return true;
    };
    if (tryLand()) return;
    const observer = new MutationObserver(() => {
      if (tryLand()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      if (landing.current === armed) landing.current = null;
      observer.disconnect();
    }, remaining);
    // A re-key (the mode flipping back, a commit or file change) ends this
    // landing; a later flip by another route must not land it.
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      if (landing.current === armed) landing.current = null;
    };
  }, [hide, commitIdentity, selectedPath]);
  useEffect(
    () => () => {
      landing.current = null;
    },
    [],
  );

  // Parents serve the previous commit's content (or on-remote verdict) as
  // placeholder while arrowing through history, so hold writes until the shown
  // commit is the addressed one.
  const writesHeld = stale || held;
  const busy =
    creating !== undefined ||
    editing !== undefined ||
    deleting !== undefined ||
    writesHeld;
  // Which term of `busy` the composer names, ranked: the switch window outranks a
  // write the viewer started, being the hold they can't have caused themselves.
  // A write pressed offline is parked, not running, until the connection returns.
  // The delete's arm is also the Delete comment dialog's own reason.
  const deleteCommentReason = pendingWriteReason(
    deleting?.paused ?? false,
    COMMENT_DELETE_PENDING_REASON,
  );
  const composerReason = (() => {
    switch (true) {
      case stale:
        return "Loading this commit…";
      case held:
        return "Checking whether this commit is pushed…";
      case creating !== undefined:
        return pendingWriteReason(creating.paused, COMMENT_POST_PENDING_REASON);
      case editing !== undefined:
        return pendingWriteReason(editing.paused, "Saving a comment edit…");
      case deleting !== undefined:
        return deleteCommentReason;
      default:
        return undefined;
    }
  })();

  // These continuations ride the awaited promise, never per-call mutate
  // callbacks: an `<Activity>` tab hide tears this observer's subscription down
  // mid-write, and react-query drops per-call callbacks once an observer has no
  // listeners — the toast and the draft restore would silently never run.
  async function submit() {
    const text = draft.value.trim();
    if (!text || writesHeld) return;
    // Clear the draft immediately (perceived-speed win); the hook appends the
    // synthetic comment optimistically. On error restore the draft, but only if
    // that commit's composer is still empty so newly-typed text is never clobbered.
    const submittedFor = commitIdentity;
    draft.set("");
    try {
      await createComment.mutateAsync({ sha, body: text });
      toast.success("Comment added");
    } catch (e) {
      draft.setFor(submittedFor, (prev) => (prev.trim() ? prev : text));
      toastError(e);
    }
  }

  async function saveEdit(commentId: string, next: string) {
    // The comment id is the previous commit's while the write addresses `sha`,
    // so a mismatched pair would edit against a commit that never showed it.
    if (writesHeld) return;
    try {
      await editComment.mutateAsync({ sha, commentId, body: next });
      toast.success("Comment updated");
    } catch (e) {
      toastError(e);
    }
  }

  async function confirmDelete(commentId: string) {
    try {
      await deleteComment.mutateAsync({ sha, commentId });
      toast.success("Comment deleted");
    } catch (e) {
      toastError(e);
    } finally {
      setDeletingId(null);
    }
  }

  // After every hook: an unsupported commit renders nothing, but the mounted
  // component keeps this surface's per-commit drafts alive across it.
  if (!enabled) return null;

  return (
    <div
      ref={paneRef}
      // The 16rem arm keeps a line of the list plus the composer inside the
      // pane on a short window, where 45% is less than the composer alone;
      // the host's scroll region then reaches it.
      className="flex max-h-[max(45%,16rem)] min-h-0 shrink-0 flex-col border-t"
      // Capped like `max-h`, live, so a window shrink mid-load can't let the
      // floor outgrow the pane's cap.
      style={
        listLoading && loadingFloor !== null
          ? { minHeight: `min(${loadingFloor}px, max(45%, 16rem))` }
          : undefined
      }
    >
      <div
        ref={listRef}
        tabIndex={-1}
        role="group"
        aria-label="Commit comments"
        className="min-h-10 flex-1 space-y-4 overflow-y-auto p-3"
        aria-busy={held || undefined}
      >
        <DegradedListNotice
          noun="comments"
          degraded={notice !== null}
          message={notice?.message}
          retryLabel={notice?.retryLabel}
          onRetry={notice?.retry ? () => void comments.refetch() : undefined}
          className="px-0 pb-0"
        />
        {comments.data !== undefined && (
          <>
            {whole.map((c) => (
              <Thread
                key={c.id}
                thread={toThread(c)}
                onSaveEdit={
                  c.viewerDidAuthor && !writesHeld
                    ? (next) => void saveEdit(c.id, next)
                    : undefined
                }
                // Withholding the handler only drops the menu entry; an editor
                // already open when the commit changed needs its Save held too.
                editHeld={writesHeld}
                onDelete={
                  c.viewerDidAuthor && !writesHeld
                    ? () => setDeletingId(c.id)
                    : undefined
                }
                mentions={mentions}
              />
            ))}

            {rows.length > 0 && (
              <div className="space-y-3">
                {rows.map(
                  ({ comment: c, path, line, startLine, reason }, i) => {
                    // A valid range labels `path:start–end`; a single line (or an
                    // unresolved line) keeps `path:line` / `path`.
                    const lineLabel =
                      line == null
                        ? ""
                        : startLine != null && startLine !== line
                          ? `:${startLine}–${line}`
                          : `:${line}`;
                    const label = `${path}${lineLabel}`;
                    // The open file never offers a jump (it's already shown), and
                    // carries a note only once its reason is known (`reason`).
                    const ownFile = path === selectedPath;
                    const note =
                      reason === null ? null : HIDDEN_REASON_COPY[reason];
                    const labelId = `${labelIdBase}-${i}`;
                    const labelNode = (() => {
                      switch (true) {
                        case ownFile && note !== null: {
                          // The annotation is the point of this label, so only the
                          // path truncates — it keeps its own clipped-text tooltip.
                          const annotated = (
                            <p
                              id={labelId}
                              className="flex min-w-0 items-baseline text-[11px] text-muted-foreground"
                            >
                              <span
                                className="min-w-0 truncate font-mono"
                                onMouseEnter={clipTitleFromText}
                              >
                                {path}
                              </span>
                              {lineLabel && (
                                <span className="shrink-0 font-mono">
                                  {lineLabel}
                                </span>
                              )}
                              <span className="shrink-0 font-sans">{note}</span>
                            </p>
                          );
                          if (reason !== "whitespace") return annotated;
                          return (
                            <div className="flex items-center gap-2">
                              {annotated}
                              <DisabledReasonButton
                                variant="ghost"
                                size="xs"
                                className="shrink-0"
                                disabled={composerHeld}
                                reason={
                                  composerHeld ? WHITESPACE_COMPOSER_HELD : null
                                }
                                aria-describedby={labelId}
                                onFocus={() => {
                                  buttonFocused.current = true;
                                }}
                                onBlur={(e) => {
                                  if (e.currentTarget.isConnected)
                                    buttonFocused.current = false;
                                }}
                                onClick={() => showWhitespace(c.id)}
                              >
                                {SHOW_WHITESPACE_LABEL}
                              </DisabledReasonButton>
                            </div>
                          );
                        }
                        case ownFile:
                          return (
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {label}
                            </p>
                          );
                        case onSelectFile !== undefined:
                          return (
                            <button
                              type="button"
                              onClick={() => onSelectFile(path)}
                              className="block max-w-full cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                              title={`Open ${label} in the diff`}
                            >
                              {label}
                            </button>
                          );
                        default:
                          return (
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {label}
                            </p>
                          );
                      }
                    })();
                    return (
                      // A row the flip may drop marks itself, so its open editor
                      // holds the flip (`whitespaceComposerOpen`).
                      <div
                        key={c.id}
                        className="space-y-1"
                        data-whitespace-row={
                          (flipDropsRows &&
                            path === selectedPath &&
                            line != null) ||
                          undefined
                        }
                      >
                        {labelNode}
                        <Thread
                          thread={toThread(c)}
                          onSaveEdit={
                            c.viewerDidAuthor && !writesHeld
                              ? (next) => void saveEdit(c.id, next)
                              : undefined
                          }
                          editHeld={writesHeld}
                          onDelete={
                            c.viewerDidAuthor && !writesHeld
                              ? () => setDeletingId(c.id)
                              : undefined
                          }
                          mentions={mentions}
                        />
                      </div>
                    );
                  },
                )}
              </div>
            )}

            {list.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No comments on this commit yet.
              </p>
            )}
          </>
        )}
        {/* The empty line's exact element, so its arrival swaps in place. */}
        {comments.data === undefined && notice === null && (
          <p className="text-xs text-muted-foreground">Loading comments…</p>
        )}
      </div>

      {canComment && (
        <CommentComposer
          toastClearance
          ariaLabel="Comment on this commit"
          placeholder="Leave a comment…"
          value={draft.value}
          onChange={draft.set}
          onSubmit={() => void submit()}
          submitLabel="Comment"
          mentions={mentions}
          hostedImages={hostedImagesFor(
            mentions.refs?.repoPath,
            mentions.ghHost,
          )}
          busy={busy}
          reason={composerReason}
        />
      )}

      <DeleteCommentDialog
        commentId={deletingId}
        onClose={() => setDeletingId(null)}
        pending={deleting !== undefined}
        reason={deleteCommentReason}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) => void confirmDelete(commentId)}
      />
    </div>
  );
}

/** What a dragged range collapses to, per provider. Only GitLab commit discussions
 *  carry a real range; GitHub/Bitbucket commit comments are single-line APIs
 *  anchored at the END line, so they disclose the collapse rather than let it pass
 *  silently. */
const RANGE_HINT: Record<ForgeProvider, (line: number) => string | null> = {
  github: (line) =>
    `GitHub commit comments anchor to a single line — this posts on line ${line}.`,
  bitbucket: (line) =>
    `Bitbucket commit comments anchor to a single line — this posts on line ${line}.`,
  gitlab: () => null,
};

/**
 * The inline composer in a commit-diff line-widget slot: a compact MarkdownEditor +
 * Comment that creates a line-anchored commit comment. Commit comments anchor to
 * the NEW side only, so an old-side line is disabled with a visible reason. On
 * GitHub the `position` is recovered from the file's diff section via
 * {@link positionFromLine}; a line not in this commit's diff yields null and the
 * post is disabled with a reason. GitLab commit notes anchor by `line` alone.
 * Posting is optimistic, so the slot closes immediately.
 */
export function CommitLineComposer({
  repoPath,
  sha,
  path,
  side,
  line,
  fromLine,
  provider,
  fileSection,
  onClose,
  lens,
  patchOnly = false,
}: {
  repoPath: string;
  sha: string;
  path: string;
  side: "new" | "old";
  /** The anchored (end) line of the comment. */
  line: number;
  /** Range start when a range was drag-selected; absent for a single line. */
  fromLine?: number;
  provider: "github" | "gitlab" | "bitbucket";
  /** This file's unified-diff section, for recovering the GitHub `position`. */
  fileSection: string | undefined;
  onClose: () => void;
  /** Which repo the commit lives on (origin vs upstream lens). */
  lens: RemoteLens;
  /** Refuse a line the section doesn't draw on every provider, for a host
   *  whose diff can draw lines outside its patch. GitHub always refuses one. */
  patchOnly?: boolean;
}) {
  const createLineComment = useCreateCommitComment(repoPath, lens);
  const mentions = useMentionCandidates({ repoPath, lens, provider });
  const [body, setBody] = useState("");

  // The multi-line range, normalized: [from, line] with from <= line.
  const rangeFrom = fromLine !== undefined && fromLine < line ? fromLine : line;
  const isRange = rangeFrom !== line;

  // GitHub needs the diff `position`; null means the line isn't on the new side of
  // this commit's diff for the file → disable with a reason. The position is always
  // the END line (GitHub/Bitbucket commit comments are single-line APIs).
  const position =
    provider === "github" ? positionFromLine(fileSection, line) : null;
  const drawn = patchOnly ? newSideLines(fileSection ?? "") : null;
  const offPatch =
    provider === "github"
      ? position === null
      : drawn !== null && !drawn.has(line);
  // A GitLab range posts its start line too, so under `patchOnly` both ends
  // must be lines the patch draws.
  const startOffPatch =
    provider === "gitlab" && isRange && drawn !== null && !drawn.has(rangeFrom);
  const disabledReason = (() => {
    switch (true) {
      case side === "old":
        return "Commit comments anchor to the new side — pick a line on the right.";
      case offPatch:
        return "This line isn't in the commit's diff for this file.";
      case startOffPatch:
        return "This range starts on a line that isn't in the commit's diff for this file.";
      default:
        return null;
    }
  })();
  const canPost = disabledReason === null;

  const rangeHint = isRange ? RANGE_HINT[provider](line) : null;

  function submit() {
    const text = body.trim();
    if (!text || !canPost) return;
    // Optimistic: the hook appends the synthetic comment, so close right away.
    // The outcome rides the promise (detached, so the close still happens on this
    // tick): closing unmounts this composer, and react-query drops per-call mutate
    // callbacks with the observer.
    void createLineComment
      .mutateAsync({
        sha,
        body: text,
        path,
        line,
        // GitLab commit discussions support ranges; send startLine only for a
        // real GitLab range. GitHub/Bitbucket stay end-anchored (single-line).
        ...(provider === "gitlab" && isRange ? { startLine: rangeFrom } : {}),
        ...(position !== null ? { position } : {}),
      })
      .then(() => toast.success("Comment added"))
      .catch((e) => toastError(e));
    onClose();
  }

  const anchorLabel = isRange
    ? `Lines ${rangeFrom}–${line} · ${path}`
    : `Line ${line} · ${path}`;

  return (
    <div className="space-y-2">
      <span className="block min-w-0 truncate font-mono text-[11px] text-muted-foreground">
        {anchorLabel}
      </span>
      {rangeHint && (
        <p className="text-[11px] text-muted-foreground">{rangeHint}</p>
      )}
      <MarkdownEditor
        aria-label={`Comment on ${anchorLabel}`}
        placeholder="Leave a comment…"
        value={body}
        onChange={setBody}
        onKeyDown={(e) => {
          if (eventToBinding(e) === "mod+enter") {
            // preventDefault unconditionally: `commit` is bound to mod+enter and
            // fires inside editable targets, so a chord this handler declines to
            // submit would otherwise reach the global action.
            e.preventDefault();
            if (canPost && !createLineComment.isPending) submit();
          } else if (e.key === "Escape") {
            // Close only this widget — don't leak Escape to global handlers.
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        autoFocus
        rows={3}
        textareaClassName="max-h-48 min-h-16 resize-y"
        mentions={mentions}
        hostedImages={hostedImagesFor(mentions.refs?.repoPath, mentions.ghHost)}
      />
      <div className="flex items-center gap-2">
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled={!body.trim() || !canPost || createLineComment.isPending}
          reason={
            disabledReason ?? (!body.trim() ? "Write a comment first" : null)
          }
          title={SUBMIT_HINT}
          onClick={submit}
        >
          Comment
        </DisabledReasonButton>
        <Button
          variant="ghost"
          size="sm"
          disabled={createLineComment.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
