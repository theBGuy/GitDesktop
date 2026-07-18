import { useCallback, useRef } from "react";

// Arrow-key roving focus for a vertical list of rows (repo convention: every
// selectable list gets keyboard nav). Each row registers its element by index;
// ArrowUp/Down move focus, Home/End jump to the ends. Enter/Space activation is
// left to the row itself (it's a real <button>/<a>).

export function useRovingList() {
  const rows = useRef<(HTMLElement | null)[]>([]);

  const register = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      rows.current[index] = el;
    },
    [],
  );

  const onKeyDown = useCallback((e: React.KeyboardEvent, index: number) => {
    const items = rows.current.filter(Boolean) as HTMLElement[];
    if (items.length === 0) return;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(index + 1, items.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    // `next` indexes the COMPACTED `items` array — focus through it, not the raw
    // ref array, whose indices could diverge if a middle row were ever null.
    items[next]?.focus();
  }, []);

  return { register, onKeyDown };
}
