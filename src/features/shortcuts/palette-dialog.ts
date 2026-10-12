/**
 * DialogContent classes shared by the palette-style pickers (Command palette,
 * Run a task…). The box is pinned to a fixed top inset instead of centred, so
 * a filter that grows or shrinks the result list moves only the bottom edge
 * and the input never shifts under the user's typing. `origin-top` anchors the
 * vendored zoom-in to that edge; the cap keeps the input on screen at any
 * window height, with the list (`min-h-0`) as the member that shrinks.
 */
export const PALETTE_DIALOG_CLASS =
  "top-[12vh] flex max-h-[calc(100dvh-12vh-1rem)] translate-y-0 origin-top flex-col gap-0 p-0 sm:max-w-md";
