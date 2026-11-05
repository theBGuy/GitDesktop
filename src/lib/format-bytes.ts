/** A byte count in base-1024 units: whole bytes below 1 KB, one decimal below
 *  100 of a unit, whole numbers above. Units step on the ROUNDED value, so no
 *  unit below TB prints 1024 and no decimal prints "100.0". Import-free:
 *  diff-split.ts loads it under Node type stripping. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (Math.round(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const tenths = value.toFixed(1);
  return `${Number(tenths) >= 100 ? Math.round(value) : tenths} ${units[unit]}`;
}
