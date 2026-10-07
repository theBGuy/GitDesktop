#!/usr/bin/env bash
# Run from the repo root. Reject bundled libwayland-client and $APPDIR-derived
# variables that the startup scripts or the launcher binary set and the app does
# not strip from spawned children.
# When the pin action exports them, require that the bundler ran the hash-pinned
# linuxdeploy and bundled the pinned AppRun; CI requires both pin exports.
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
# A CLI bump that renames a cached tool, or a moved tool directory, silently
# bypasses the seed. The pins must match the executed tool and bundled launcher.
if [ -n "${GD_LINUXDEPLOY_PIN:-}" ]; then
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
  linuxdeploy_files=()
  for tool in "$cache_dir"/linuxdeploy-*.AppImage; do
    [ -f "$tool" ] || continue
    case "${tool##*/}" in linuxdeploy-plugin-*) continue ;; esac
    linuxdeploy_files+=("${tool##*/}")
  done
  if [ "${#linuxdeploy_files[@]}" -ne 1 ] || [ "${linuxdeploy_files[0]}" != "$GD_LINUXDEPLOY_PIN" ]; then
    echo "FAIL: the bundler used a linuxdeploy other than the pinned $GD_LINUXDEPLOY_PIN:"
    if [ "${#linuxdeploy_files[@]}" -eq 0 ]; then
      echo "none"
    else
      printf '%s\n' "${linuxdeploy_files[@]}"
    fi
    exit 1
  fi
  if ! linuxdeploy_marker=$(od -An -tx1 -j8 -N3 "$cache_dir/$GD_LINUXDEPLOY_PIN" | awk '{$1=$1; print}') \
    || [ "$linuxdeploy_marker" != "00 00 00" ]; then
    echo "FAIL: the bundler did not run the pinned $GD_LINUXDEPLOY_PIN"
    exit 1
  fi
  echo "OK: the bundler ran the pinned $GD_LINUXDEPLOY_PIN"
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "FAIL: the pin-linuxdeploy action did not export GD_LINUXDEPLOY_PIN"
  exit 1
fi
if [ -n "${GD_APPRUN_SHA256:-}" ]; then
  launcher="$workdir/squashfs-root/AppRun.wrapped"
  if [ ! -e "$launcher" ] && [ ! -L "$launcher" ]; then
    launcher="$workdir/squashfs-root/AppRun"
  fi
  launcher_hash=$(sha256sum "$launcher" 2>/dev/null) || launcher_hash=none
  launcher_hash="${launcher_hash%% *}"
  if [ "$launcher_hash" != "$GD_APPRUN_SHA256" ]; then
    echo "FAIL: the bundled AppRun launcher is not the pinned build"
    echo "$launcher_hash"
    exit 1
  fi
  echo "OK: the bundled AppRun launcher is the pinned build"
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "FAIL: the pin-linuxdeploy action did not export GD_APPRUN_SHA256"
  exit 1
fi

# Every variable a startup script or the launcher binary points into the bundle
# must also be stripped from the environment of the tools we spawn. Twin of
# `APPDIR_PATHLIST_VARS` + `APPDIR_SCALAR_VARS` in src-tauri/src/agent.rs —
# extend both together.
# Scans the generated AppRun wrapper, its hooks, and the NAME=%s environment
# strings in the binary launcher (AppRun.wrapped, or AppRun itself when it is
# a binary). Script shape limit: only single-line `export NAME=…` is matched —
# `NAME=…; export NAME` and `declare -x` are out of scope (linuxdeploy emits
# single-line exports).
allowed=" LD_LIBRARY_PATH PATH XDG_DATA_DIRS GTK_PATH"
allowed="$allowed GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0"
allowed="$allowed GI_TYPELIB_PATH"
allowed="$allowed PYTHONHOME PYTHONPATH PERLLIB QT_PLUGIN_PATH"
allowed="$allowed GSETTINGS_SCHEMA_DIR GTK_EXE_PREFIX GTK_DATA_PREFIX"
allowed="$allowed GTK_IM_MODULE_FILE GDK_PIXBUF_MODULE_FILE"
allowed="$allowed GIO_EXTRA_MODULES GIO_MODULE_DIR"
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
launcher_vars=0
for launcher in "$workdir"/squashfs-root/AppRun "$workdir"/squashfs-root/AppRun.wrapped; do
  [ -e "$launcher" ] || continue
  if [ ! -r "$launcher" ]; then
    echo "FAIL: cannot read $launcher"
    exit 1
  fi
  if grep -Iq . "$launcher"; then
    continue
  elif [ $? -ne 1 ]; then
    echo "FAIL: cannot read $launcher"
    exit 1
  fi
  if ! exported=$( { grep -aoE '[A-Za-z_][A-Za-z0-9_]*=%s' "$launcher" || [ $? -eq 1 ]; } \
    | sed 's/=%s$//' | sort -u); then
    echo "FAIL: cannot read $launcher"
    exit 1
  fi
  if [ -z "$exported" ]; then
    if grep -aq LD_LIBRARY_PATH "$launcher"; then
      echo "FAIL: $(basename "$launcher") sets variables in a format this guard cannot parse"
      exit 1
    elif [ $? -ne 1 ]; then
      echo "FAIL: cannot read $launcher"
      exit 1
    fi
  fi
  for name in $exported; do
    launcher_vars=$((launcher_vars + 1))
    case "$allowed" in
      *" $name "*) ;;
      *) unknown="$unknown $name" ;;
    esac
  done
done
if [ -n "$unknown" ]; then
  echo "FAIL: the bundle sets \$APPDIR-derived var(s) the app does not strip:$unknown"
  echo "      add them to APPDIR_PATHLIST_VARS / APPDIR_SCALAR_VARS in src-tauri/src/agent.rs"
  exit 1
fi
echo "OK: every \$APPDIR-derived export in $scripts startup script(s) and $launcher_vars launcher binary variable(s) is stripped from child processes"
