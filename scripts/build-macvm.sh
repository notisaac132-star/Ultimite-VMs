#!/bin/sh
# Builds the Mac VM helper (mac/macvm/main.swift) as one universal binary: mac/build/macvm.
# The Mac app bundles it (see electron-builder.yml); it needs the virtualization entitlement to run.
set -e
cd "$(dirname "$0")/.."
mkdir -p mac/build
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos13" mac/macvm/main.swift -o "mac/build/macvm-$arch"
done
lipo -create -output mac/build/macvm mac/build/macvm-arm64 mac/build/macvm-x86_64
rm mac/build/macvm-arm64 mac/build/macvm-x86_64
codesign --force --sign - --entitlements build/entitlements.mac.plist mac/build/macvm
