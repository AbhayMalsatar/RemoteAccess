#!/bin/sh
# Install Chrome Native Messaging host manifest for common browsers on macOS.
# Usage:
#   EXTENSION_ID=xxxxxxxx ./native/install_native_messaging_mac.sh
# Or edit native/com.remote.control.json allowed_origins first, then:
#   ./native/install_native_messaging_mac.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/com.remote.control.json"

if test ! -f "$SRC"; then
  echo "Missing: $SRC"
  exit 1
fi

DEST_NAME="com.remote.control.json"

install_one() {
  dir="$1"
  if test -z "$dir"; then
    return 0
  fi
  dest="$dir/$DEST_NAME"
  mkdir -p "$dir"
  cp "$SRC" "$dest"
  echo "Installed: $dest"
}

# If EXTENSION_ID set, rewrite allowed_origins in a temp file (optional)
if test -n "$EXTENSION_ID"; then
  TMP="$SCRIPT_DIR/.com.remote.control.json.tmp.$$"
  ORIGIN="chrome-extension://${EXTENSION_ID}/"
  python3 <<PY
import json, sys
p = r"$SRC"
out = r"$TMP"
with open(p) as f:
    d = json.load(f)
d["allowed_origins"] = ["$ORIGIN"]
with open(out, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PY
  SRC="$TMP"
  trap 'rm -f "$TMP"' EXIT
fi

BASE="$HOME/Library/Application Support"

install_one "$BASE/Google/Chrome/NativeMessagingHosts"
install_one "$BASE/Google/Chrome Canary/NativeMessagingHosts"
install_one "$BASE/Chromium/NativeMessagingHosts"
install_one "$BASE/Microsoft Edge/NativeMessagingHosts"
install_one "$BASE/BraveSoftware/Brave-Browser/NativeMessagingHosts"
install_one "$BASE/Vivaldi/NativeMessagingHosts"
install_one "$BASE/Arc/User Data/NativeMessagingHosts"

BINARY="$SCRIPT_DIR/host-macos"
if test ! -x "$BINARY"; then
  echo "WARNING: $BINARY missing or not executable. Run: $SCRIPT_DIR/build_mac.sh"
else
  echo "Binary OK: $BINARY"
fi

echo ""
echo "Next: Quit the browser completely (Cmd+Q), reopen, then reload the extension."
echo "Verify extension ID matches allowed_origins in: $SRC"
