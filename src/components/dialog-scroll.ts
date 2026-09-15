/** Dialog body scrollers. `overflow-y-auto` makes overflow-x compute to `auto`,
 *  and in LTR the inline-start edge only clips (it can never scroll), so pad the
 *  box for the focus ring and pull it back by the same 4px — DialogContent's own
 *  p-4 absorbs the overhang, leaving content aligned with the pinned header. */
export const DIALOG_SCROLL = "-mx-1 overflow-y-auto px-1";

/** The same, for bodies whose shrink-to-fit content would otherwise let the
 *  vertical scrollbar's width tip them into a phantom horizontal one. */
export const DIALOG_SCROLL_X_HIDDEN =
  "-mx-1 overflow-x-hidden overflow-y-auto px-1";
