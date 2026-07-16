- Large diffs in TextMate-highlighted languages (Rust, TSX, Astro, Svelte, and
  other Shiki-rendered or custom-grammar languages) no longer lose their
  VSCode-fidelity highlighting past the size budget in commit, history, and
  pull-request diffs — they now tokenize in a background thread and fill in when
  ready, with standard highlighting shown in the interim.
