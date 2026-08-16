- A small change deep in a very large file now shows its diff immediately.
  Diffs whose line numbers run past the highlighter's ceiling skip the grammar
  download and the background tokenizing pass entirely — work whose result the
  renderer would discard — instead of leaving the pane blank while it finished.
