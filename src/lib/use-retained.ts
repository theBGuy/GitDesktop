import { useState } from "react";

/**
 * Latest value, retained through a dialog's close fade: updates only while
 * `retain` holds (default: value is non-nullish), so copy/appearance reads
 * stay populated while the live discriminant nulls at close. Render-only —
 * dispatch handlers and open= gates keep reading the live value.
 */
export function useRetained<T>(value: T, retain: boolean = value != null): T {
  const [shown, setShown] = useState(value);
  if (retain && value !== shown) setShown(value);
  return shown;
}
