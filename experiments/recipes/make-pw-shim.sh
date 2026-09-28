#!/bin/bash
# usage: make-pw-shim.sh <chromium-revision> [out-root] [ffmpeg-revision]
# Exposes the pre-installed Chromium 1194 (/opt/pw-browsers) under another Playwright
# revision number. Point PLAYWRIGHT_BROWSERS_PATH at the printed directory.
# Handles both layouts:
#   Playwright <= 1.56: chromium-<rev>/chrome-linux/chrome, chromium_headless_shell-<rev>/chrome-linux/headless_shell
#   Playwright >= 1.57: chromium-<rev>/chrome-linux64/chrome, chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell
# A plain directory symlink is not enough for >= 1.57 (the executable is renamed), so the
# new-layout dirs are real directories of per-file symlinks. Chrome resolves its resources
# via /proc/self/exe, i.e. the real path under /opt/pw-browsers.
set -e
REV=$1; OUT=${2:-/home/user/shard/work/pw-browsers}; FF=${3:-1011}
SRC=/opt/pw-browsers
D=$OUT/r$REV
rm -rf "$D"; mkdir -p "$D"
mkdir -p "$D/chromium-$REV/chrome-linux64"
ln -s $SRC/chromium-1194/chrome-linux "$D/chromium-$REV/chrome-linux"
for f in $SRC/chromium-1194/chrome-linux/*; do ln -s "$f" "$D/chromium-$REV/chrome-linux64/"; done
touch "$D/chromium-$REV/INSTALLATION_COMPLETE" "$D/chromium-$REV/DEPENDENCIES_VALIDATED"
mkdir -p "$D/chromium_headless_shell-$REV/chrome-headless-shell-linux64"
ln -s $SRC/chromium_headless_shell-1194/chrome-linux "$D/chromium_headless_shell-$REV/chrome-linux"
for f in $SRC/chromium_headless_shell-1194/chrome-linux/*; do ln -s "$f" "$D/chromium_headless_shell-$REV/chrome-headless-shell-linux64/"; done
ln -s $SRC/chromium_headless_shell-1194/chrome-linux/headless_shell "$D/chromium_headless_shell-$REV/chrome-headless-shell-linux64/chrome-headless-shell"
touch "$D/chromium_headless_shell-$REV/INSTALLATION_COMPLETE" "$D/chromium_headless_shell-$REV/DEPENDENCIES_VALIDATED"
ln -s $SRC/ffmpeg-1011 "$D/ffmpeg-$FF"
echo "$D"
