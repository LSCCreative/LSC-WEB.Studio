#!/bin/sh
# Builds "LSC Publisher.app" into desktop-publisher/dist/ (gitignored).
#   sh build-app.sh            release build
#   sh build-app.sh --open     …and open it
# The build itself goes in ~/Library/Caches, not this folder: it sits in Google Drive.
set -eu
cd "$(dirname "$0")"

BUILD="${LSC_PUBLISHER_BUILD:-$HOME/Library/Caches/lsc-publisher-build}"
APP="dist/LSC Publisher.app"

swift build -c release --scratch-path "$BUILD"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/release/LSCPublisher" "$APP/Contents/MacOS/LSCPublisher"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# Signed for this Mac only (ad hoc): it was built here, so Gatekeeper lets it open.
codesign --force --sign - "$APP"

echo "Built $(pwd)/$APP"
if [ "${1:-}" = "--open" ]; then open "$APP"; fi
