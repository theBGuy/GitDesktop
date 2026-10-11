/** Call-site class for a menu row whose disabled state can flip while the menu
 *  is open (a write starts, parks, or the connection drops). The vendored menu
 *  items carry `data-disabled:pointer-events-none`, so a hover-highlighted row
 *  that turns disabled stops being a hit target; the resulting pointerleave makes
 *  floating-ui's list navigation move focus to the popup. The override keeps the
 *  row a hit target, and Base UI's `useButton` still gates clicks on it. */
export const MENU_HELD_ROW_CLASS =
  "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed";
