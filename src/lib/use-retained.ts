import { useState } from "react";

/**
 * Latest value, retained through a dialog's close fade: updates only while
 * `retain` holds (default: value is non-nullish), so copy/appearance reads
 * stay populated while the live discriminant nulls at close. Render-only by
 * default — a dispatch that must hand over exactly what the user sees may read
 * it too; open= gates never do.
 */
export function useRetained<T>(value: T, retain: boolean = value != null): T {
  const [shown, setShown] = useState(value);
  if (retain && value !== shown) setShown(value);
  return shown;
}
