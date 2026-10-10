#!/bin/bash
# Puts Chromium (CEF) into the .app `pnpm tauri build` made: the framework and
# the helper apps its renderer, GPU and other processes run as. Tauri's bundler
# does neither. Usage: scripts/bundle-cef.sh [release|debug]
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-release}"
APP="target/$PROFILE/bundle/macos/Shosai.app"
CEF="${CEF_PATH:-$HOME/.local/share/cef}"
FRAMEWORK="Chromium Embedded Framework.framework"
MAIN="todo-sessions-app"
ID="dev.mr04vv.todo-sessions"

[ -d "$APP" ] || { echo "no $APP: run pnpm tauri build first" >&2; exit 1; }
[ -d "$CEF/$FRAMEWORK" ] || { echo "no $CEF/$FRAMEWORK: cargo run -p export-cef-dir -- --force \$HOME/.local/share/cef (in cef-rs)" >&2; exit 1; }

if [ "$PROFILE" = release ]; then
  cargo build --release -p todo-sessions-app --bin todo-sessions-helper
else
  cargo build -p todo-sessions-app --bin todo-sessions-helper
fi

FW="$APP/Contents/Frameworks"
mkdir -p "$FW"
rm -rf "${FW:?}/$FRAMEWORK"
cp -R "$CEF/$FRAMEWORK" "$FW/"

# Chromium looks for these by name: "<executable> Helper", "... (GPU)" and so on.
for kind in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  name="$MAIN Helper$kind"
  suffix=$(echo "$kind" | tr -d ' ()')
  contents="$FW/$name.app/Contents"
  rm -rf "$FW/$name.app"
  mkdir -p "$contents/MacOS"
  cp "target/$PROFILE/todo-sessions-helper" "$contents/MacOS/$name"
  cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>$ID.helper${suffix:+.$suffix}</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><string>1</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>学ぶ時間の右の ChatGPT で音声モードを使うときに、マイクを使います。</string>
  <key>NSCameraUsageDescription</key><string>$name</string>
</dict>
</plist>
PLIST
done

# Signed with the user's own code signing certificate when there is one, so
# a rebuild stays the same app to the Keychain (its items kept for Shosai
# alone); ad hoc without one, as Tauri signs it. The new parts need it too.
# The identity is SHOSAI_SIGNING_IDENTITY, else the first Apple Development one.
IDENTITY="${SHOSAI_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: .*\)"$/\1/p' | head -1)}"
if [ -n "$IDENTITY" ] && security find-identity -p codesigning | grep -qF "\"$IDENTITY\""; then SIGN="$IDENTITY"; else SIGN=-; fi
echo "signing with: $SIGN"
codesign --force --deep --sign "$SIGN" "$APP"
echo "$APP"
