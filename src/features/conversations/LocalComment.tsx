import { DotsThreeIcon, RobotIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/ui/markdown";
import { copyText } from "@/lib/clipboard";
import { CommentEditor } from "./CommentEditor";
import type { MentionSource } from "./useMentionCandidates";

/**
 * A comment on a local (offline) PR or issue. Local comments aren't tied to
 * GitHub node ids, so hiding is a local "collapsed" flag and editing/deleting
 * just rewrites the stored array. Shared by LocalPrView and LocalIssueView.
 */
export function LocalComment({
  comment,
  onQuote,
  onSaveEdit,
  onDelete,
  onHide,
  onUnhide,
  mentions,
}: {
  comment: {
    body: string;
    createdAt: string;
    author?: string;
    hidden?: boolean;
  };
  onQuote?: () => void;
  /** Replaces the comment body in local storage. */
  onSaveEdit: (body: string) => void;
  /** Removes the comment from local storage. */
  onDelete: () => void;
  /** Collapses the comment (sets its hidden flag). */
  onHide: () => void;
  /** Un-collapses the comment. */
  onUnhide: () => void;
  /** The surface's forge context: drives `@`/`#`/`!` autocomplete while editing
   *  and linkifies the same references in the rendered body. */
  mentions?: MentionSource;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const hidden = comment.hidden ?? false;
  return (
    <div className="group space-y-1">
      <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {comment.author && (
          <>
            <Avatar size="sm" className="shrink-0">
              <AvatarFallback>
                <RobotIcon aria-hidden className="size-3" />
              </AvatarFallback>
            </Avatar>
            <span className="font-medium text-foreground">
              {comment.author}
            </span>
          </>
        )}
        <RelativeTime date={comment.createdAt} />
        {hidden && <span className="italic">hidden</span>}
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
                {onQuote && (
                  <DropdownMenuItem onClick={onQuote}>
                    Quote reply
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => copyText(comment.body, "Markdown copied")}
                >
                  Copy markdown
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setDraft(comment.body);
                    setEditing(true);
                  }}
                >
                  Edit
                </DropdownMenuItem>
                {hidden ? (
                  <DropdownMenuItem onClick={onUnhide}>Unhide</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={onHide}>Hide</DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  Delete
                </DropdownMenuItem>
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
          canSubmit={!!draft.trim() && draft.trim() !== comment.body.trim()}
          onSubmit={() => {
            onSaveEdit(draft.trim());
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          textareaClassName="max-h-48 min-h-16 resize-y"
          mentions={mentions}
        />
      ) : hidden && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Show hidden comment
        </button>
      ) : (
        <>
          {hidden && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Hide comment
            </button>
          )}
          <Markdown refs={mentions?.refs}>{comment.body}</Markdown>
        </>
      )}
    </div>
  );
}
