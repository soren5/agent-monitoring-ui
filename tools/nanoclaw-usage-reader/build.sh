#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP="$ROOT/NanoClawUsageReader.app"
SIGNING_IDENTITY="${NANOCLAW_USAGE_READER_SIGNING_IDENTITY:-NanoClaw Usage Reader Local Signing}"

rm -rf "$APP"
# This bundle has its own macOS privacy identity, so Accessibility can be
# granted to it rather than to Codex or Terminal.
mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
clang -fobjc-arc -framework AppKit -framework ApplicationServices "$ROOT/NanoClawUsageReader.m" -o "$APP/Contents/MacOS/NanoClawUsageReader"
codesign --force --sign "$SIGNING_IDENTITY" --timestamp=none "$APP"
printf '%s\n' "$APP"
