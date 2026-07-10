- **Long branch names no longer overflow the repository header.** A very long
  current-branch name used to push the header wider than the window, adding
  horizontal (and cascaded vertical) scrollbars and hiding the sync controls.
  The branch name now truncates with an ellipsis — hover it to see the full
  name — while the icons, detached badge, and Fetch/Pull/Publish controls stay
  fully visible.
