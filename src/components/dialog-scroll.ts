/** Dialog body scrollers. `overflow-y-auto` makes overflow-x compute to `auto`,
 *  and in LTR the inline-start edge only clips (it can never scroll), so pad the
 *  box for the focus ring and pull it back by the same 4px — DialogContent's own
 *  p-4 absorbs the overhang, leaving content aligned with the pinned header.
 *  The bottom pair holds a last Checkbox, Radio or Switch's 8px hit-area
 *  overhang inside the box and pulls it back so layout doesn't move. */
export const DIALOG_SCROLL = "-mx-1 -mb-2 overflow-y-auto px-1 pb-2";

/** The same, for bodies whose shrink-to-fit content would otherwise let the
 *  vertical scrollbar's width tip them into a phantom horizontal one. */
export const DIALOG_SCROLL_X_HIDDEN =
  "-mx-1 -mb-2 overflow-x-hidden overflow-y-auto px-1 pb-2";
