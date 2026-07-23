- Terminal settings gained a **Custom command…** mode — give a full command with a
  `{path}` placeholder (for example `wt -d {path}` or `tmux new-window -c {path}`) for
  multiplexers, wrappers, or any terminal the auto-detection doesn't know. The command
  runs shell-free, and macOS "Custom…" now also launches plain (non-`.app`) executables
  correctly.
