#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
APP="${CODEX_FLOW_APP_DESTINATION:-$HOME/Applications/Codex Flow.app}"
FLOW_NODE_EXECUTABLE="$(command -v node)"
FLOW_CODEX_EXECUTABLE="$(command -v codex)"
FLOW_SOURCE_ROOT="$PWD"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -parse-as-library macos/FlowApp.swift macos/FlowModel.swift -o "$APP/Contents/MacOS/CodexFlow" -framework SwiftUI -framework AppKit -framework WebKit -framework PDFKit
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.parth.codex-flow</string>
<key>CFBundleName</key><string>Codex Flow</string>
<key>CFBundleDisplayName</key><string>Codex Flow</string>
<key>CFBundleIconFile</key><string>CodexFlow</string>
<key>CFBundleExecutable</key><string>CodexFlow</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.3.0</string>
<key>CFBundleVersion</key><string>3</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/libexec/PlistBuddy -c "Add :FlowNodeExecutable string $FLOW_NODE_EXECUTABLE" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :FlowCodexExecutable string $FLOW_CODEX_EXECUTABLE" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :FlowCLIPath string $FLOW_SOURCE_ROOT/src/cli.js" "$APP/Contents/Info.plist"
cp assets/CodexFlow.icns "$APP/Contents/Resources/CodexFlow.icns"
rm -f "$APP/Contents/MacOS/applet"
codesign --force --sign - "$APP"
codesign --verify "$APP"
