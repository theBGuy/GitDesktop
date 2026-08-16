- Context you expanded in a large diff now stays expanded when its
  background-thread syntax highlighting arrives. Highlighting for big
  TextMate-rendered files (Rust, TSX, Astro, Svelte, and the rest) paints into
  the diff already on screen, so the view keeps your expanded context and your
  place instead of snapping back to the collapsed layout.
