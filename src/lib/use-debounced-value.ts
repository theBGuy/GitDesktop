import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value (typically a search input) so it only
 * reaches its query hook once it settles. Returns the last value that held
 * steady for `delayMs`.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
