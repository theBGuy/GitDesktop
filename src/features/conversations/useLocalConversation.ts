import { useRef, useState } from "react";
import type { MarkdownEditorHandle } from "@/components/markdown-editor";
import { makeQuoteReply } from "./quoteReply";

/** A comment on a local (offline) PR or issue. */
export interface LocalConvComment {
  id: string;
  body: string;
  createdAt: string;
  hidden?: boolean;
}

/** The minimal shape both LocalPr and LocalIssue share for conversation CRUD. */
export interface LocalConvEntity {
  id: string;
  title: string;
  body: string;
  labels: string[];
  comments: LocalConvComment[];
}

/**
 * Comment + label CRUD and composer state shared by LocalPrView and
 * LocalIssueView. Every mutation spreads the WHOLE entity and replaces one
 * field via `save.mutate`, so freshness comes from the list query's refetch —
 * comments are never held in local state. `entity` may be undefined while the
 * parent is mid-unmount, so every handler guards on it.
 *
 * `openEdit`/`editForm` stay at the call site (they need the per-view title);
 * this hook owns only conversation/label/composer state.
 */
export function useLocalConversation<T extends LocalConvEntity>(
  entity: T | undefined,
  save: { mutate: (entity: T) => void },
) {
  const [comment, setComment] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const composerRef = useRef<MarkdownEditorHandle>(null);
  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of every component consuming this hook (refs-in-render
  // rule).
  const quoteReply = (body: string) =>
    makeQuoteReply({ composerRef, setBody: setComment })(body);

  // Spread the whole entity, override one field. `as T` works around TS not
  // assigning a generic spread back to its own type parameter.
  const patch = (next: Partial<T>): T => ({ ...(entity as T), ...next });

  function addComment() {
    if (!entity || !comment.trim()) return;
    save.mutate(
      patch({
        comments: [
          ...entity.comments,
          {
            id: crypto.randomUUID(),
            body: comment.trim(),
            createdAt: new Date().toISOString(),
          },
        ],
      } as Partial<T>),
    );
    setComment("");
  }

  function editComment(commentId: string, body: string) {
    if (!entity) return;
    save.mutate(
      patch({
        comments: entity.comments.map((c) =>
          c.id === commentId ? { ...c, body } : c,
        ),
      } as Partial<T>),
    );
  }

  function deleteComment(commentId: string) {
    if (!entity) return;
    save.mutate(
      patch({
        comments: entity.comments.filter((c) => c.id !== commentId),
      } as Partial<T>),
    );
  }

  function setCommentHidden(commentId: string, hidden: boolean) {
    if (!entity) return;
    save.mutate(
      patch({
        comments: entity.comments.map((c) =>
          c.id === commentId ? { ...c, hidden } : c,
        ),
      } as Partial<T>),
    );
  }

  function addLabel() {
    const name = labelInput.trim();
    if (!entity || !name) return;
    if (!entity.labels.includes(name)) {
      save.mutate(patch({ labels: [...entity.labels, name] } as Partial<T>));
    }
    setLabelInput("");
  }

  function removeLabel(label: string) {
    if (!entity) return;
    save.mutate(
      patch({
        labels: entity.labels.filter((l) => l !== label),
      } as Partial<T>),
    );
  }

  return {
    comment,
    setComment,
    labelInput,
    setLabelInput,
    deletingCommentId,
    setDeletingCommentId,
    composerRef,
    quoteReply,
    addComment,
    editComment,
    deleteComment,
    setCommentHidden,
    addLabel,
    removeLabel,
  };
}
