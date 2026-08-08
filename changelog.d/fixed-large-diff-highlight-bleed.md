- Syntax highlighting in a large file's diff no longer paints everything after a
  hunk as one long comment or string. Each hunk is now highlighted on its own, so
  a comment, template literal, or parameter list the hunk cuts in half can't
  bleed color across the collapsed gaps between hunks.
