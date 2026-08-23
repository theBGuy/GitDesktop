// Ported from Component/textarea-caret-position (MIT licensed, © 2015 Jonathan Ong
// et al.), trimmed to the textarea case we need. The technique: mirror the textarea
// into a hidden div carrying its exact typography and box metrics, then measure where
// a span placed after `position` characters lands.

/** Style properties the mirror must copy for its wrapping to match the textarea's. */
const MIRRORED_PROPERTIES = [
  "direction",
  "box-sizing",
  "width",
  "height",
  "overflow-x",
  "overflow-y",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-size",
  "font-size-adjust",
  "line-height",
  "font-family",
  "text-align",
  "text-transform",
  "text-indent",
  "text-decoration",
  "letter-spacing",
  "word-spacing",
  "tab-size",
] as const;

export interface CaretCoordinates {
  top: number;
  left: number;
  height: number;
}

/**
 * Where the caret sits when it is at `position`, in pixels **relative to the
 * textarea's unscrolled content origin**. Callers subtract the element's
 * `scrollTop`/`scrollLeft` and add its `getBoundingClientRect()` origin to reach
 * viewport coordinates.
 */
export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  const computed = getComputedStyle(element);
  const mirror = document.createElement("div");
  const style = mirror.style;
  style.position = "absolute";
  style.top = "0";
  style.left = "-9999px";
  style.visibility = "hidden";
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  // `overflow-x`/`overflow-y` ride the copy loop below: reproducing the textarea's
  // own scrollbar gutter is what keeps the mirror's wrapping faithful.
  for (const prop of MIRRORED_PROPERTIES) {
    style.setProperty(prop, computed.getPropertyValue(prop));
  }

  mirror.textContent = element.value.slice(0, position);
  const marker = document.createElement("span");
  // A non-empty span: a caret at the very end of the value would otherwise have no
  // box to measure. The remaining text also keeps the last line's wrapping honest.
  marker.textContent = element.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  // `line-height: normal` resolves to the keyword, not a length — fall back to the
  // usual ~1.2× font-size so a themed textarea can't yield NaN coordinates.
  const fontSize = Number.parseFloat(computed.fontSize) || 0;
  const lineHeight =
    Number.parseFloat(computed.lineHeight) || Math.round(fontSize * 1.2);
  const coordinates = {
    top: marker.offsetTop + (Number.parseFloat(computed.borderTopWidth) || 0),
    left:
      marker.offsetLeft + (Number.parseFloat(computed.borderLeftWidth) || 0),
    height: lineHeight,
  };
  document.body.removeChild(mirror);
  return coordinates;
}
