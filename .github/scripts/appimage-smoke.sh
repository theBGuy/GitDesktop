#!/usr/bin/env bash
# Runtime smoke test for the Linux AppImage, run inside a modern-Mesa container
# (fedora:44) against $APPIMAGE. The full gtk3 closure is required: linuxdeploy
# excludes those libs from the bundle, so without them the app dies on a missing
# host lib (e.g. libfribidi) long before EGL is reached. Three criteria, each
# catching what the others miss: alive at the timeout (early crash), a live
# WebKitWebProcess at 20s and no EGL-failure line (an EGL abort kills only the
# web process, leaving the shell alive and sometimes silent).
set -u

: "${APPIMAGE:?APPIMAGE must point at the AppImage to test}"

dnf -y -q install mesa-dri-drivers mesa-libEGL mesa-libGL libglvnd-egl libglvnd-glx \
  gtk3 xorg-x11-server-Xvfb dbus-daemon procps-ng >/tmp/dnf.log 2>&1 || {
  echo "DNF INSTALL FAILED"
  tail -n 40 /tmp/dnf.log || true
  exit 1
}

cp "$APPIMAGE" /tmp/gd.AppImage || {
  echo "COPY FAILED: cannot read $APPIMAGE (check the container mount)"
  exit 1
}
chmod +x /tmp/gd.AppImage || exit 1
cd /tmp || exit 1
./gd.AppImage --appimage-extract >/tmp/extract.log 2>&1 || {
  echo "EXTRACT FAILED"
  tail -n 40 /tmp/extract.log || true
  exit 1
}

export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p /tmp/xdg
chmod 700 /tmp/xdg
export HOME=/tmp/home
mkdir -p /tmp/home

fail() {
  echo "SMOKE FAILED: $1"
  echo "--- last 40 log lines ---"
  tail -n 40 /tmp/run.log || true
  exit 1
}

timeout -k 5 30 xvfb-run -a ./squashfs-root/AppRun >/tmp/run.log 2>&1 &
run_pid=$!

sleep 20
pgrep -f WebKitWebProcess >/dev/null || fail "no WebKitWebProcess at 20s (the app may also have exited early — see the log tail)"

wait "$run_pid"
code=$?

# 124 = timeout fired; 137 = the -k KILL backstop fired on a TERM-blocking app.
# Both mean the app was still alive at 30s.
if [ "$code" -ne 124 ] && [ "$code" -ne 137 ]; then
  fail "app exited with code $code before the 30s timeout (expected 124 or 137)"
fi
if grep -Eqi 'Could not create default EGL display|EGL_BAD_PARAMETER|Failed to create EGL display' /tmp/run.log; then
  fail "EGL initialization error in the log"
fi

echo "SMOKE OK: alive at the 30s timeout, web process running at 20s, no EGL failure"
