import { DotsThreeIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useState } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
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
import { Markdown } from "@/components/ui/markdown";
import { copyText } from "@/lib/clipboard";
import type { MinimizeReason } from "@/lib/git/api";
import { displayLogin } from "@/lib/git/bot-login";
import { useActiveForgeGhHost, useActiveGhHost } from "@/lib/git/host";
import type { PrThreadOut, Reaction, RepoLabel } from "@/lib/git/types";
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

export function Thread({
  thread,
  onQuote,
  onSaveEdit,
  editHeld = false,
  onDelete,
  onHide,
  onUnhide,
  reactions,
  onToggleReaction,
  reactionsHeld = false,
  reactionsReason,
  renderBody,
  copyMarkdown,
  disabledReason,
  mentions,
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
  /** Present when the viewer may edit this comment; saves the new body. */
  onSaveEdit?: (body: string) => void;
  /** Holds an ALREADY-OPEN editor's Save without claiming a write is running —
   *  withholding `onSaveEdit` only removes the menu's Edit entry, so an editor
   *  opened before the caller went stale would otherwise save into nothing and
   *  close, discarding the text. */
  editHeld?: boolean;
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
  /** Opt in to `@`/`#`/`!` autocomplete in the edit-in-place editor — only
   *  surfaces whose forge autolinks the completed reference pass one. */
  mentions?: MentionSource;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const minimized = thread.isMinimized;
  const disabledSuffix = disabledReason ? ` — ${disabledReason}` : "";
  return (
    <div className="group space-y-1">
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
                    onClick={() => {
                      setDraft(thread.body);
                      setEditing(true);
                    }}
                  >
                    Edit
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
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </p>
      {editing ? (
        <CommentEditor
          ariaLabel="Edit comment"
          value={draft}
          onChange={setDraft}
          canSubmit={
            !!draft.trim() && draft.trim() !== thread.body.trim() && !editHeld
          }
          onSubmit={() => {
            // Return BEFORE closing: a held save must keep the draft on screen
            // rather than swallow it.
            if (editHeld) return;
            onSaveEdit?.(draft.trim());
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          textareaClassName="max-h-48 min-h-16 resize-y font-mono"
          mentions={mentions}
        />
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
              <Markdown>{thread.body}</Markdown>
            ))}
        </>
      )}
      {onToggleReaction && !editing && (
        <ReactionBar
          reactions={reactions ?? []}
          disabled={reactionsHeld}
          reason={reactionsReason}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}

export function LabelChip({ label }: { label: RepoLabel }) {
  return (
    <span className="flex items-center gap-1 border px-1.5 py-0.5 text-[11px]">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `#${label.color}` }}
      />
      {label.name}
    </span>
  );
}
