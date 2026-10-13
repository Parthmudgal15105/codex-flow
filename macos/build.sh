#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
APP="$HOME/Applications/Codex Flow.app"
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
cp assets/CodexFlow.icns "$APP/Contents/Resources/CodexFlow.icns"
rm -f "$APP/Contents/MacOS/applet"
codesign --force --sign - "$APP"
codesign --verify "$APP"
