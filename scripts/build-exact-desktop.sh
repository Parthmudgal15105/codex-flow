#!/bin/bash
set -euo pipefail
BASE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$BASE/vendor/codex-plus-plus"
STAGE="$BASE/.testing/exact-scheduler/Codex++.app"
CURRENT="$HOME/Applications/Codex++.app"
DEST_APP="$STAGE"
source "$REPO/install/mac/install.sh"
prepare_signing
# Stage is a copy of CURRENT, so both integrity layers must be updated from it.
node "$REPO/patch/mac-integrity.mjs" "$STAGE/Contents/Info.plist" "$CURRENT/Contents/Resources/app.asar" "$STAGE/Contents/Resources/app.asar"
python3 "$REPO/tools/update-mac-framework-integrity.py" "$CURRENT" "$STAGE"
ditto "$REPO/hub" "$STAGE/Contents/Resources/hub"
write_entitlements
sign_bundle
