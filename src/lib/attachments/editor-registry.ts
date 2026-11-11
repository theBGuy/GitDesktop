// The live attachments editors the `attach-image` palette action can target.
// Every live editor registers the same resolver, so whichever handler the
// hotkey registry runs opens the picker of the editor that last held focus.

export interface AttachEditorSlot {
  enabled: boolean;
  lastFocus: () => number;
  root: () => HTMLElement | null;
  open: () => void;
}

const slots: AttachEditorSlot[] = [];
let focusSeq = 0;

/** A rising stamp for "this editor held focus last". */
export function nextFocusSeq(): number {
  focusSeq += 1;
  return focusSeq;
}

export function registerAttachEditor(slot: AttachEditorSlot): () => void {
  slots.push(slot);
  return () => {
    const at = slots.indexOf(slot);
    if (at !== -1) slots.splice(at, 1);
  };
}

/** A root inside an inert, hidden or aria-hidden subtree is not on screen. */
function onScreen(root: HTMLElement | null): boolean {
  return (
    root !== null &&
    root.closest('[inert],[hidden],[aria-hidden="true"]') === null
  );
}

/** Opens the picker of the live editor focused last, else the newest one. */
export function runAttachImage() {
  let target: AttachEditorSlot | null = null;
  for (const slot of slots) {
    if (!slot.enabled || !onScreen(slot.root())) continue;
    if (target === null || slot.lastFocus() >= target.lastFocus())
      target = slot;
  }
  target?.open();
}
