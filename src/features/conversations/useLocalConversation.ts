import { useRef, useState } from "react";
import type { MarkdownEditorHandle } from "@/components/markdown-editor";
import { toastError } from "@/lib/toast";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";
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
 * LocalIssueView. Every mutation is handed to `apply` as a function of the
 * CURRENT record; the view routes it through updateLocalPr/updateLocalIssue,
 * which reload disk first — so a concurrent external write to the same entity
 * is merged, not clobbered — and comments are never held in local state.
 * `entity` may be undefined while the parent is mid-unmount, so every handler
 * guards on it. `apply` resolves once the write lands and rejects when it
 * fails; every failure toasts here, and a failed comment keeps its draft.
 *
 * `openEdit`/`editForm` stay at the call site (they need the per-view title);
 * this hook owns only conversation/label/composer state. The comment draft is
 * keyed on `id` — the same identity the views reset on — so each entity keeps
 * its own unsent text while the view stays mounted.
 */
export function useLocalConversation<T extends LocalConvEntity>(
  id: string,
  entity: T | undefined,
  apply: (mutate: (cur: T) => T) => Promise<void>,
) {
  const draft = useKeyedEntityState(id, "");
  const comment = draft.value;
  const setComment = draft.set;
  const [labelInput, setLabelInput] = useState("");
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const composerRef = useRef<MarkdownEditorHandle>(null);
  // Entities with a comment write in flight: the draft stays until the write
  // lands, so a second submit meanwhile would post it twice.
  const postingRef = useRef(new Set<string>());
  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of every component consuming this hook (refs-in-render
  // rule).
  const quoteReply = (body: string) =>
    makeQuoteReply({ composerRef, setBody: setComment })(body);

  // Merge a field patch onto the CURRENT record — whatever `apply` reloaded from
  // disk — not a stale snapshot, so a concurrent external write to the same entity
  // (e.g. an MCP-appended comment) survives. `as T` works around TS not assigning a
  // generic spread back to its own type parameter.
  const patch = (cur: T, next: Partial<T>): T => ({ ...cur, ...next }) as T;

  const write = (mutate: (cur: T) => T) => {
    void apply(mutate).catch(toastError);
  };

  function addComment() {
    if (!entity || !comment.trim() || postingRef.current.has(id)) return;
    const key = id;
    const c = {
      id: crypto.randomUUID(),
      body: comment.trim(),
      createdAt: new Date().toISOString(),
    };
    postingRef.current.add(key);
    apply((cur) => patch(cur, { comments: [...cur.comments, c] } as Partial<T>))
      .then(
        // Keyed on the entity it was typed for, and only if untouched since:
        // text typed while the write ran survives it.
        () => draft.setFor(key, (prev) => (prev.trim() === c.body ? "" : prev)),
        toastError,
      )
      .finally(() => postingRef.current.delete(key));
  }

  function editComment(commentId: string, body: string) {
    if (!entity) return;
    write((cur) =>
      patch(cur, {
        comments: cur.comments.map((c) =>
          c.id === commentId ? { ...c, body } : c,
        ),
      } as Partial<T>),
    );
  }

  function deleteComment(commentId: string) {
    if (!entity) return;
    write((cur) =>
      patch(cur, {
        comments: cur.comments.filter((c) => c.id !== commentId),
      } as Partial<T>),
    );
  }

  function setCommentHidden(commentId: string, hidden: boolean) {
    if (!entity) return;
    write((cur) =>
      patch(cur, {
        comments: cur.comments.map((c) =>
          c.id === commentId ? { ...c, hidden } : c,
        ),
      } as Partial<T>),
    );
  }

  function addLabel() {
    const name = labelInput.trim();
    if (!entity || !name) return;
    write((cur) =>
      cur.labels.includes(name)
        ? cur
        : patch(cur, { labels: [...cur.labels, name] } as Partial<T>),
    );
    setLabelInput("");
  }

  function removeLabel(label: string) {
    if (!entity) return;
    write((cur) =>
      patch(cur, {
        labels: cur.labels.filter((l) => l !== label),
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
