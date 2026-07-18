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

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = rows.current.filter(Boolean) as HTMLElement[];
    if (items.length === 0) return;
    // Locate the row that fired the event IN the compacted array, so a null
    // middle ref can never skew the arithmetic — registration indices and
    // compacted positions diverge exactly then.
    const cur = items.indexOf(e.currentTarget as HTMLElement);
    if (cur === -1) return;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(cur + 1, items.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(cur - 1, 0);
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
    items[next]?.focus();
  }, []);

  return { register, onKeyDown };
}
