// A forge-patch slot's whitespace mode: reads the file's two versions through
// the diff panes' one content source, runs `git diff -w` over them, and hands
// the slot the view forge-whitespace.ts picks. Imports nothing that reaches
// ./DiffSurface, so PR hosts stay off the diff chunk.
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { decodeBase64Utf8 } from "@/lib/git/api";
import { prWhitespaceHunksOptions } from "@/lib/git/queries";
import type { FileDiff } from "@/lib/git/types";
import { useHideWhitespace } from "@/lib/settings/hide-whitespace";
import {
  contentSourceKey,
  type DiffContentSource,
  FORGE_CONTENT_BUDGET_BYTES,
  useFileAtSource,
} from "./content-source";
import {
  proveForgeSides,
  reduceForgeWhitespace,
  WHITESPACE_INITIAL,
  type WhitespaceInputs,
  type WhitespaceRevs,
  type WhitespaceState,
  wantsReads,
  whitespaceCommandWanted,
  whitespaceHunksRead,
  whitespaceReadsKey,
  whitespaceSide,
  whitespaceSides,
} from "./forge-whitespace";
import { diffEditorOpen } from "./whitespace-mode";

/** A slot's revs, with the source as the content source names it. */
export type ForgeWhitespaceRevs =
  | Exclude<WhitespaceRevs, { state: "ready" }>
  | {
      state: "ready";
      oldRev: string | undefined;
      newRev: string;
      source: DiffContentSource;
    };

/** The marks `DIFF_EDITOR_SELECTOR` reads, as this hook's observer filter. */
const EDITOR_MARKS = [
  "data-diff-line-widget",
  "data-diff-anchor",
  "data-thread-editing",
  "data-diff-editor",
];

/** A comment edit open in a commit-comments row a `-w` view may drop: the
 *  whitespace probe's arm, read document-wide since the rows sit outside the
 *  slot's root (an edit open in a hidden tab holds too). */
const LISTED_EDIT = "[data-whitespace-row] [data-thread-editing]";

/** The marks `LISTED_EDIT` reads, as its observer filter. */
const LISTED_EDIT_MARKS = ["data-whitespace-row", "data-thread-editing"];

/** Whether an editor is open under `root`, or in a listed comment row, kept
 *  live by observers. */
function useEditorOpen(root: HTMLElement | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const observers = [new MutationObserver(onChange)];
      observers[0].observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: LISTED_EDIT_MARKS,
      });
      if (root !== null) {
        const observer = new MutationObserver(onChange);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: EDITOR_MARKS,
        });
        observers.push(observer);
      }
      return () => {
        for (const observer of observers) observer.disconnect();
      };
    },
    [root],
  );
  const snapshot = useCallback(
    () =>
      (root !== null && diffEditorOpen(root)) ||
      document.querySelector(LISTED_EDIT) !== null,
    [root],
  );
  return useSyncExternalStore(subscribe, snapshot);
}

const decoded = (b64: string | null | undefined) =>
  b64 ? decodeBase64Utf8(b64) : "";

/**
 * The view a forge-patch slot draws under the app-wide whitespace setting:
 * its forge section, or a proven `-w` diff of the section's two versions, or
 * the section under a note saying why it keeps its whitespace. Call it once
 * per slot, before any early return. `repo` undefined keeps the forge view.
 */
export function useForgeWhitespaceDiff(args: {
  plain: FileDiff | undefined;
  placeholder: boolean;
  repo: string | undefined;
  entity: string;
  path: string;
  revs: ForgeWhitespaceRevs;
  /** The slot's diff root, observed for an open editor. */
  root: HTMLElement | null;
}): { data: FileDiff | undefined; pending: boolean; note: string | undefined } {
  const { plain, placeholder, repo, entity, path, revs, root } = args;
  const hide = useHideWhitespace();
  const editorOpen = useEditorOpen(root);
  const active = repo !== undefined && wantsReads(hide, plain, placeholder);
  const ready = revs.state === "ready" ? revs : null;
  const oldPath = plain?.oldPath ?? path;
  const oldRev = ready?.oldRev;
  const newRev = ready?.newRev;
  const source = ready?.source ?? "local";
  const oldQ = useFileAtSource({
    repo: repo ?? "",
    source,
    rev: oldRev ?? null,
    path: oldPath,
    enabled: active && ready !== null && oldRev !== undefined,
    maxBytes: FORGE_CONTENT_BUDGET_BYTES,
  });
  const newQ = useFileAtSource({
    repo: repo ?? "",
    source,
    rev: newRev ?? null,
    path,
    enabled: active && ready !== null,
    maxBytes: FORGE_CONTENT_BUDGET_BYTES,
  });
  // A side pends on a FIRST read only, so a failed read that refetches keeps
  // its fallback instead of re-blanking the pane.
  const oldFirstRead =
    oldQ.isPending &&
    oldQ.errorUpdateCount === 0 &&
    oldQ.fetchStatus === "fetching";
  const newFirstRead =
    newQ.isPending &&
    newQ.errorUpdateCount === 0 &&
    newQ.fetchStatus === "fetching";
  // Sides are judged only under ready revs: a disabled null-rev read shares
  // the working-tree key, so an absent side comes from its rev, never its data.
  const oldSide = whitespaceSide(ready === null ? undefined : oldRev, {
    data: oldQ.data,
    firstRead: oldFirstRead,
    paused: oldQ.fetchStatus === "paused",
  });
  const newSide = whitespaceSide(newRev, {
    data: newQ.data,
    firstRead: newFirstRead,
    paused: newQ.fetchStatus === "paused",
  });
  const reads = {
    repo: repo ?? "",
    sourceKey: contentSourceKey(source),
    oldRev,
    oldPath,
    newRev: newRev ?? "",
    path,
  };
  const readsKey = ready === null ? null : whitespaceReadsKey(reads);
  const sides = whitespaceSides(oldSide, newSide);
  const sidesReady = sides !== null;
  const plainText = plain?.text ?? "";
  const oldB64 = sides?.old;
  const newB64 = sides?.new;
  const oldText = useMemo(() => decoded(oldB64), [oldB64]);
  const newText = useMemo(() => decoded(newB64), [newB64]);
  const proof = useMemo(
    () =>
      active && readsKey !== null && sidesReady
        ? proveForgeSides(readsKey, plainText, oldText, newText)
        : null,
    [active, readsKey, sidesReady, plainText, oldText, newText],
  );
  const base: Omit<WhitespaceInputs, "hunks"> = {
    identity: JSON.stringify([repo ?? "", entity, path]),
    // No repo reads nothing, so the reducer stays on the forge view (rule 1).
    hide: hide && repo !== undefined,
    plain,
    placeholder,
    revs:
      revs.state === "ready"
        ? {
            state: "ready",
            oldRev: revs.oldRev,
            newRev: revs.newRev,
            sourceKey: reads.sourceKey,
          }
        : revs,
    readsKey,
    oldSide,
    newSide,
    budget: FORGE_CONTENT_BUDGET_BYTES,
    proof,
    editorOpen,
  };
  const wanted =
    active && whitespaceCommandWanted({ ...base, hunks: { kind: "idle" } });
  const hunksQ = useQuery({
    ...prWhitespaceHunksOptions(reads, sides ?? { old: null, new: null }),
    enabled: wanted,
  });
  const hunks = whitespaceHunksRead(wanted, readsKey, hunksQ);
  // The previous view, adjusted during render: the reducer only reads it.
  const [state, setState] = useState<WhitespaceState>(WHITESPACE_INITIAL);
  const { state: next, view } = reduceForgeWhitespace(state, {
    ...base,
    hunks,
  });
  if (next !== state) setState(next);
  return {
    data: view.data,
    pending: view.pending,
    note: view.note ?? undefined,
  };
}
