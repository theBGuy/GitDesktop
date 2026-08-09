- The Linux AppImage now starts on current distributions (Fedora 42+, Arch, and
  other systems with recent Mesa graphics drivers) instead of aborting with an
  EGL error or showing an empty window — it no longer bundles an outdated
  Wayland library that conflicted with the host's graphics drivers.
