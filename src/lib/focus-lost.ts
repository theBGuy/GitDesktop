// Whether an element is rendered: it and every ancestor lay out.
export function isRendered(el: Element): boolean {
  // jsdom has no checkVisibility, and its layout reads answer "hidden" for
  // every element, so the fallback walks computed `display` instead.
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  for (let node: Element | null = el; node !== null; node = node.parentElement)
    if (getComputedStyle(node).display === "none") return false;
  return true;
}

// Whether keyboard focus is somewhere the user can't continue from: nowhere,
// on <body>, on a detached node, or on an element that isn't rendered. The last
// is the `<Activity>` reveal case: the commit that hides the old tab sets
// `display: none` on it while focus still sits there, and the browser drops it
// to <body> only later. Callers only ever TAKE lost focus with it.
export function focusIsLost(): boolean {
  const el = document.activeElement;
  if (el === null || el === document.body || !el.isConnected) return true;
  return !isRendered(el);
}
