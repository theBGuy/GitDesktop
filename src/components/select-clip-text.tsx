import { clipTitleFromText } from "@/lib/clip-title";

/**
 * Popup-row text for the vendored Select, ellipsized to the row and titled on
 * hover only when actually clipped. The popup hard-clips overflow and
 * ItemText's `min-width: auto` floor grows it with its nowrap content, so a
 * bare `truncate` child never engages; `w-0` collapses that floor and
 * `min-w-full` re-expands the span to the row's real width — including under
 * call-site popup `max-w` overrides, which a `--anchor-width` bound would miss.
 * Must be the row's SOLE child: `min-w-full` claims ItemText's whole content
 * box, so a sibling icon or badge would be pushed past the popup's clip edge.
 */
export function SelectClipText({ children }: { children: string }) {
  return (
    <span onMouseEnter={clipTitleFromText} className="w-0 min-w-full truncate">
      {children}
    </span>
  );
}
