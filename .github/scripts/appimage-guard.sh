#!/usr/bin/env bash
# Fails the build when the AppImage bundles libwayland-client: a bundled copy
# shadows the host's and breaks EGL on Mesa 25+ systems. Run from the repo
# root — the bundle path is relative to it.
set -euo pipefail

appimage=$(find src-tauri/target/release/bundle/appimage -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)
if [ -z "$appimage" ]; then
  echo "No AppImage found under src-tauri/target/release/bundle/appimage"
  exit 1
fi
workdir=$(mktemp -d)
cp "$appimage" "$workdir/app.AppImage"
chmod +x "$workdir/app.AppImage"
# --appimage-extract avoids FUSE, which GitHub runners don't provide.
(cd "$workdir" && ./app.AppImage --appimage-extract >/dev/null)
# Match any soname: a bundled copy breaks EGL wherever it is placed.
found=$(find "$workdir/squashfs-root" -name 'libwayland-client.so*' -print -quit)
if [ -n "$found" ]; then
  echo "FAIL: $(basename "$appimage") bundles $found"
  exit 1
fi
echo "OK: $(basename "$appimage") does not bundle libwayland-client"
