// Pure value logic for the settings form's Save. Runtime-import-free so
// scripts/settings-save-reset.test.mjs imports it directly.

/** JSON with object keys sorted, so the dirty check is insensitive to key
 *  order. The Tauri store round-trips nested objects (e.g. an imported
 *  TextMate grammar) with reordered keys, which would otherwise leave the
 *  Save bar stuck on "unsaved changes" forever. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

/** Whether a Save resets the form to the values it just wrote. Only when the
 *  form still holds exactly those values, so an edit that landed during the
 *  write stays on screen for the next Save; or when a Discard ran since the
 *  press, which put back the pre-save values that would now read as unsaved. */
export function resetsAfterSave({
  discarded,
  current,
  written,
}: {
  discarded: boolean;
  current: unknown;
  written: unknown;
}): boolean {
  return discarded || stableStringify(current) === stableStringify(written);
}
