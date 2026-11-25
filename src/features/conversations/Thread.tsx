import { DotsThreeIcon, LockIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Markdown } from "@/components/markdown/markdown";
import { hostedImagesFor } from "@/components/markdown/markdown-images";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useKeptDraft, useKeptOpen } from "@/features/diff/editor-keep";
import { clipTitleFromText } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import { focusIsLost } from "@/lib/focus-lost";
import type { MinimizeReason } from "@/lib/git/api";
import { displayLogin } from "@/lib/git/bot-login";
import { useActiveForgeGhHost, useActiveGhHost } from "@/lib/git/host";
import type { PrThreadOut, Reaction, RepoLabel } from "@/lib/git/types";
import { useLatestRef } from "@/lib/use-latest-ref";
import { CommentEditor } from "./CommentEditor";
import { ReactionBar } from "./ReactionBar";
import type { MentionSource } from "./useMentionCandidates";

/**
 * Shared conversation primitives for any GitHub thread surface (pull requests,
 * issues, discussions). The comment shape (`PrThreadOut`) and the GraphQL
 * comment mutations are PR-agnostic — they key off node ids — so issues and
 * discussions render and edit comments through these same components.
 */

/**
 * Whether a thread body renders any visible content. Raw HTML is disabled in
 * our Markdown component, so a body that is only HTML comments (e.g. an
 * unfilled PR/issue template) displays as nothing.
 */
export function hasVisibleBody(body: string): boolean {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
}

/** Hide reasons GitHub accepts: menu label → ReportedContentClassifiers value. */
export const HIDE_REASONS: [string, MinimizeReason][] = [
  ["Off-topic", "OFF_TOPIC"],
  ["Outdated", "OUTDATED"],
  ["Resolved", "RESOLVED"],
  ["Duplicate", "DUPLICATE"],
  ["Spam", "SPAM"],
  ["Abuse", "ABUSE"],
];

/** "OFF_TOPIC" -> "off-topic" for the "hidden · <reason>" label. */
export function formatReason(reason: string): string {
  return reason.toLowerCase().replace(/_/g, "-");
}

/** A user's avatar that links to their profile. Prefers the provider's real
 *  `avatarUrl` (GitLab/Bitbucket); with none, derives it from the login on the open
 *  repo's host (`<host>/<login>.png` — correct for GitHub/Enterprise). CSP is
 *  unrestricted so images load directly, and the Avatar primitive falls back to the
 *  initial if the image can't load (e.g. a GitLab user with no avatar). */
export function AuthorAvatar({
  login,
  avatarUrl,
}: {
  login: string;
  /** The provider's real avatar URL when known (GitLab/Bitbucket). When absent,
   *  the avatar is derived from the login on the open repo's host — correct for
   *  GitHub, and a graceful fall-through to the initial elsewhere. */
  avatarUrl?: string;
}) {
  const host = useActiveGhHost();
  const ghHost = useActiveForgeGhHost();
  if (!login) return null;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={() => openUrl(`https://${host}/${login}`)}
      title={`@${login} on ${host}`}
      aria-label={`@${login} on ${host}`}
      className="shrink-0 rounded-full hover:opacity-80 cursor-pointer"
    >
      <ForgeUserAvatar login={login} avatarUrl={avatarUrl} ghHost={ghHost} />
    </Button>
  );
}

// Restates src/lib/focus-lost.ts's fallback: jsdom has no checkVisibility.
function isRendered(el: Element): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  for (let node: Element | null = el; node !== null; node = node.parentElement)
    if (getComputedStyle(node).display === "none") return false;
  return true;
}

function mayTakeFocus(root: HTMLElement | null): boolean {
  if (root === null || !root.isConnected || !isRendered(root)) return false;
  return root.contains(document.activeElement) || focusIsLost();
}

/** Lands focus on a comment's "Comment actions" trigger as its inline editor
 *  closes. `arm()` before the close reads the focus at that moment: it takes
 *  focus only from inside the comment or from nowhere, and never while the
 *  comment is hidden, since a save can settle after the user moved on or while
 *  its tab is hidden. The landing rides the commit that remounts the trigger,
 *  re-checking first. */
export function useEditorCloseLanding(editing: boolean) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const armed = useRef(false);
  useLayoutEffect(() => {
    const land = armed.current;
    armed.current = false;
    if (!editing && land && mayTakeFocus(rootRef.current))
      triggerRef.current?.focus();
  }, [editing]);
  return {
    rootRef,
    triggerRef,
    arm: () => {
      armed.current = mayTakeFocus(rootRef.current);
    },
  };
}

export function Thread({
  thread,
  onQuote,
  onSaveEdit,
  editHeld = false,
  editHeldReason = null,
  onDelete,
  onHide,
  onUnhide,
  reactions,
  onToggleReaction,
  reactionsHeld = false,
  reactionsReason,
  reactionPickerHeld = false,
  renderBody,
  copyMarkdown,
  disabledReason,
  mentions,
  onEditingChange,
}: {
  thread: PrThreadOut;
  onQuote?: () => void;
  /** Overrides how the (non-editing, non-minimized) body is rendered. Absent =
   *  the default `<Markdown>` render, byte-identical to before — issues and
   *  discussions never pass it; the PR review card uses it to splice suggestion
   *  blocks in between markdown segments. */
  renderBody?: (body: string) => ReactNode;
  /** Override for the Copy-markdown action — used by PR reviews to append their
   *  file-anchored threads. Absent = copies `thread.body`, byte-identical to
   *  before. */
  copyMarkdown?: string;
  /** Present when the viewer may edit this comment; saves the new body and
   *  resolves whether it saved. The editor stays open, frozen, until it settles,
   *  and `false` keeps it open with the draft. */
  onSaveEdit?: (body: string) => boolean | Promise<boolean>;
  /** Holds an ALREADY-OPEN editor's Save without claiming a write is running —
   *  withholding `onSaveEdit` only removes the menu's Edit entry, so an editor
   *  opened before the caller went stale would otherwise save into nothing and
   *  close, discarding the text. */
  editHeld?: boolean;
  /** Why the forge won't take an edit or a delete of this comment (null = it
   *  will): the Edit and Delete rows stay shown but disabled, and an open editor
   *  keeps its text while its Save holds with this reason. */
  editHeldReason?: string | null;
  /** Present when the viewer may delete this comment. */
  onDelete?: () => void;
  /** Hide (minimize) the comment with a reason. */
  onHide?: (classifier: MinimizeReason) => void;
  /** Unhide a previously hidden comment. */
  onUnhide?: () => void;
  /** Set when the viewer may not hide comments — a TRIAGE-tier action, so
   *  callers feed this from the triage axis rather than push. The hide/unhide
   *  items stay visible but disabled, with this text appended to their label (a
   *  disabled item drops pointer events, so a tooltip would never show). */
  disabledReason?: string;
  /** Current reactions on this comment (only used when onToggleReaction set). */
  reactions?: Reaction[];
  /** Present to enable the reaction bar; toggles the viewer's reaction. */
  onToggleReaction?: (content: string, active: boolean) => void;
  /** Holds the reaction toggles while the caller's entity is the previous one:
   *  the chips stay visible (a read) but can't fire a write whose subject id and
   *  target entity would disagree. Same posture as `editHeld`. */
  reactionsHeld?: boolean;
  /** Why `reactionsHeld` holds — the bar shows and announces it on every control
   *  it disables. Absent leaves a plain disable no viewer can interrogate. */
  reactionsReason?: string | null;
  /** Closes an open emoji picker: the caller's view is holding this thread on
   *  screen while another item loads (see ReactionBar's `held`). */
  reactionPickerHeld?: boolean;
  /** Opt in to `@`/`#`/`!` autocomplete in the edit-in-place editor — only
   *  surfaces whose forge autolinks the completed reference pass one. */
  mentions?: MentionSource;
  /** Told whether the edit-in-place editor is open, in a layout effect: as it
   *  opens or closes, and as the thread mounts or shows again. Never from a
   *  cleanup, which an `<Activity>` hide runs with the editor still open; a
   *  thread that unmounts with it open is told nothing. */
  onEditingChange?: (editing: boolean) => void;
}) {
  // An edit open in a diff row comes back, with its text, when the rows
  // remount around it.
  const keptId = `edit:${thread.id}`;
  const reopened = useKeptOpen(keptId);
  const [editing, setEditing] = useState(reopened);
  const editingChange = useLatestRef(onEditingChange);
  useLayoutEffect(() => {
    editingChange.current?.(editing);
  }, [editing]);
  const kept = useKeptDraft(editing ? keptId : null);
  const draft = kept.text;
  const setDraft = kept.setText;
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  // The ref gates a second submit fired before the `saving` render lands.
  const savingRef = useRef(false);
  const landing = useEditorCloseLanding(editing);
  function closeEditor() {
    landing.arm();
    setEditing(false);
  }
  async function save() {
    // Returns BEFORE closing: a held save keeps the draft on screen rather than
    // swallow it.
    if (editHeld || editHeldReason !== null || savingRef.current) return;
    if (!onSaveEdit) return;
    savingRef.current = true;
    setSaving(true);
    kept.setBusy(true);
    let saved = false;
    try {
      saved = await onSaveEdit(draft.trim());
    } catch {
      // A saver that rejects saved nothing: the editor keeps the draft.
      saved = false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      kept.setBusy(false);
    }
    if (saved) {
      kept.forget();
      closeEditor();
    }
  }
  const minimized = thread.isMinimized;
  const disabledSuffix = disabledReason ? ` — ${disabledReason}` : "";
  return (
    // The open-editor mark is what the whitespace probe (whitespace-mode.ts)
    // finds under a host whose rows a whitespace flip replaces.
    <div
      ref={landing.rootRef}
      className="group space-y-1"
      data-thread-editing={editing || undefined}
    >
      <p className="flex items-center gap-2 text-xs">
        <AuthorAvatar
          login={thread.author}
          avatarUrl={thread.authorAvatarUrl}
        />
        <span className="font-medium">
          {thread.author ? displayLogin(thread.author) : "unknown"}
        </span>
        {thread.state && (
          <Badge variant="secondary">{thread.state.toLowerCase()}</Badge>
        )}
        <span className="text-muted-foreground">
          {thread.date && <RelativeTime date={thread.date} />}
        </span>
        {minimized && (
          <span className="text-[11px] text-muted-foreground italic">
            hidden
            {thread.minimizedReason
              ? ` · ${formatReason(thread.minimizedReason)}`
              : ""}
          </span>
        )}
        {!editing && (
          <>
            <span className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger
                ref={landing.triggerRef}
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Comment actions"
                    className="text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                  />
                }
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {thread.url && (
                  <DropdownMenuItem
                    onClick={() => copyText(thread.url, "Link copied")}
                  >
                    Copy link
                  </DropdownMenuItem>
                )}
                {onQuote && (
                  <DropdownMenuItem onClick={onQuote}>
                    Quote reply
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() =>
                    copyText(copyMarkdown ?? thread.body, "Markdown copied")
                  }
                >
                  Copy markdown
                </DropdownMenuItem>
                {onSaveEdit && (
                  <DropdownMenuItem
                    disabled={editHeldReason !== null}
                    className={MENU_HELD_ROW_CLASS}
                    onClick={() => {
                      setDraft(thread.body);
                      setEditing(true);
                    }}
                  >
                    Edit
                    {editHeldReason !== null && ` — ${editHeldReason}`}
                  </DropdownMenuItem>
                )}
                {onUnhide && minimized && (
                  <DropdownMenuItem
                    disabled={!!disabledReason}
                    onClick={onUnhide}
                  >
                    Unhide{disabledSuffix}
                  </DropdownMenuItem>
                )}
                {onHide && !minimized && (
                  <DropdownMenuSub>
                    {/* The vendored sub-trigger carries no disabled styling of
                        its own (unlike menu items), so the dim rides a
                        call-site class. */}
                    <DropdownMenuSubTrigger
                      disabled={!!disabledReason}
                      className="data-disabled:opacity-50"
                    >
                      Hide…{disabledSuffix}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {HIDE_REASONS.map(([label, classifier]) => (
                        <DropdownMenuItem
                          key={classifier}
                          onClick={() => onHide(classifier)}
                        >
                          {label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {onDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={editHeldReason !== null}
                    className={MENU_HELD_ROW_CLASS}
                    onClick={onDelete}
                  >
                    Delete
                    {editHeldReason !== null && ` — ${editHeldReason}`}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </p>
      {editing ? (
        <>
          {/* Not a live region: the always-mounted span below announces it. */}
          {editHeldReason !== null && (
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <LockIcon aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>
                <span className="font-medium text-foreground">
                  {editHeldReason}
                </span>
                {draft.trim() && " Your edit is kept; Cancel discards it."}
              </span>
            </p>
          )}
          <span aria-live="polite" className="sr-only">
            {editHeldReason ?? ""}
          </span>
          <CommentEditor
            ariaLabel="Edit comment"
            value={draft}
            onChange={setDraft}
            autoFocus={!kept.restored}
            canSubmit={
              !!draft.trim() &&
              draft.trim() !== thread.body.trim() &&
              !editHeld &&
              editHeldReason === null
            }
            pending={saving}
            onSubmit={() => void save()}
            onCancel={() => {
              if (savingRef.current) return;
              kept.forget();
              closeEditor();
            }}
            textareaClassName="max-h-48 min-h-16 resize-y font-mono"
            mentions={mentions}
            hostedImages={hostedImagesFor(
              mentions?.refs?.repoPath,
              mentions?.ghHost,
            )}
          />
        </>
      ) : minimized && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Show hidden comment
        </button>
      ) : (
        <>
          {minimized && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Hide comment
            </button>
          )}
          {thread.body.trim() &&
            (renderBody ? (
              renderBody(thread.body)
            ) : (
              <Markdown
                refs={mentions?.refs}
                hostedImages={hostedImagesFor(
                  mentions?.refs?.repoPath,
                  mentions?.ghHost,
                )}
                // Only the optimistic row of a post carries its token, so no
                // other body can reach the user's local images.
                stagedImages={
                  thread.postToken === undefined
                    ? undefined
                    : { postToken: thread.postToken }
                }
              >
                {thread.body}
              </Markdown>
            ))}
        </>
      )}
      {onToggleReaction && !editing && (
        <ReactionBar
          reactions={reactions ?? []}
          disabled={reactionsHeld}
          reason={reactionsReason}
          held={reactionPickerHeld}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}

/** A repo label as a chip. Bounded by its container so one long name can't set a
 *  narrow column's min-content width; the tooltip appears only once cut. */
export function LabelChip({ label }: { label: RepoLabel }) {
  return (
    <span className="flex max-w-full items-center gap-1 border px-1.5 py-0.5 text-[11px]">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `#${label.color}` }}
      />
      <span className="truncate" onMouseEnter={clipTitleFromText}>
        {label.name}
      </span>
    </span>
  );
}
