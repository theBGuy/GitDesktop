// Char budgets bounding the ONE-TIME synchronous tokenization on first paint.
// Measured warm cost on unique real content: highlight.js ≈0.37ms/KB (~150ms at
// the 400KB budget), Shiki ≈1ms/KB rust to ≈3.2ms/KB tsx (~150–480ms at the
// 150KB budget) — ~8× hljs, hence the tighter budget. Each importer picks its
// own over-budget path: the diff view tokenizes Shiki off-thread and keeps its
// hljs whole-buffer pass; the conflict region view renders plain text.
export const HIGHLIGHT_MAX_CHARS_HLJS = 400_000;
export const HIGHLIGHT_MAX_CHARS_SHIKI = 150_000;
