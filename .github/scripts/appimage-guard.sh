#!/usr/bin/env bash
# Fails the build when the AppImage bundles libwayland-client (a bundled copy
# shadows the host's and breaks EGL on Mesa 25+ systems), or when a startup
# script exports a $APPDIR-derived variable the app doesn't strip from spawned
# children. Run from the repo root — the bundle path is relative to it.
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

# Every variable a startup script points into the bundle must also be stripped
# from the environment of the tools we spawn. Twin of `APPDIR_PATHLIST_VARS` +
# `APPDIR_SCALAR_VARS` in src-tauri/src/agent.rs — extend both together.
# Scans the generated AppRun wrapper and the hooks it sources; AppRun.wrapped is
# skipped as a binary that sets LD_LIBRARY_PATH programmatically.
# Shape limit: only single-line `export NAME=…` is matched — `NAME=…; export
# NAME` and `declare -x` are out of scope (linuxdeploy emits single-line exports).
allowed=" LD_LIBRARY_PATH PATH XDG_DATA_DIRS GTK_PATH"
allowed="$allowed GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0"
allowed="$allowed GSETTINGS_SCHEMA_DIR GTK_EXE_PREFIX GTK_DATA_PREFIX"
allowed="$allowed GTK_IM_MODULE_FILE GDK_PIXBUF_MODULE_FILE GIO_EXTRA_MODULES"
allowed="$allowed APPDIR " # the hook's own re-export
scripts=0
unknown=""
for script in "$workdir"/squashfs-root/AppRun "$workdir"/squashfs-root/apprun-hooks/*.sh; do
  [ -f "$script" ] || continue
  scripts=$((scripts + 1))
  # -I so a binary AppRun yields no matches instead of "Binary file matches".
  exported=$(grep -IE '^[[:space:]]*export[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=.*\$\{?APPDIR' "$script" \
    | sed -E 's/^[[:space:]]*export[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)=.*/\1/' || true)
  for name in $exported; do
    case "$allowed" in
      *" $name "*) ;;
      *) unknown="$unknown $name" ;;
    esac
  done
done
if [ -n "$unknown" ]; then
  echo "FAIL: startup script exports \$APPDIR-derived var(s) the app does not strip:$unknown"
  echo "      add them to APPDIR_PATHLIST_VARS / APPDIR_SCALAR_VARS in src-tauri/src/agent.rs"
  exit 1
fi
echo "OK: every \$APPDIR-derived export in $scripts startup script(s) is stripped from child processes"
