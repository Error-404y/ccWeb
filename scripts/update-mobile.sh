#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/java21.sh
if ! qzu_java21; then
  if [[ "${QZU_INSTALL_JAVA:-0}" == 1 ]] && command -v brew >/dev/null 2>&1; then
    brew install openjdk@21
    qzu_java21
  else
    exit 1
  fi
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
VERSION="$(node -p "require('./package.json').version")"
npm test
npm run mobile:prepare -- android
(cd android && ./gradlew --no-daemon "-Dorg.gradle.java.home=$JAVA_HOME" :app:assembleDebug)
APK="$PWD/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$APK" ]] || { echo "Android APK missing."; exit 1; }
cp "$APK" "$HOME/Desktop/qzu-v$VERSION.apk"
echo "APK: $HOME/Desktop/qzu-v$VERSION.apk"
npm run mobile:prepare -- ios
IOS_BUILD="$HOME/Library/Caches/qzu-build"
if [[ -d ios/App/App.xcworkspace ]]; then
  PROJECT=(-workspace ios/App/App.xcworkspace)
else
  PROJECT=(-project ios/App/App.xcodeproj)
fi
IPHONE="${QZU_IOS_DEVICE:-}"
if [[ "$IPHONE" == skip ]]; then
  IPHONE=""
elif [[ -z "$IPHONE" ]]; then
  DEVICE_LIST="$(xcrun devicectl list devices)"
  printf '%s\n' "$DEVICE_LIST"
  IOS_DEVICES="$(printf '%s\n' "$DEVICE_LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{for(const line of s.split(/\r?\n/)){if(!/\bavailable\s*\(paired\)/i.test(line)||!/\biPhone\b/i.test(line))continue;const m=line.match(/\b([0-9a-f]{8}-[0-9a-f]{16}|[0-9a-f]{40})\s*\(UDID\)/i);if(m)console.log(m[1]);}})')"
  IOS_COUNT="$(printf '%s\n' "$IOS_DEVICES" | awk 'NF {n++} END {print n+0}')"
  if [[ "$IOS_COUNT" == 1 ]]; then
    IPHONE="$IOS_DEVICES"
    echo "Detected one available iPhone."
  else
    echo "No unique available iPhone detected. Building without installing. Set QZU_IOS_DEVICE to select a device."
  fi
fi
DEST="generic/platform=iOS"
if [[ -n "$IPHONE" ]]; then
  if [[ ! "$IPHONE" =~ ^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$ ]]; then
    echo "QZU_IOS_DEVICE must be an Xcode device UDID or skip." >&2
    exit 1
  fi
  DEST="platform=iOS,id=$IPHONE"
fi
xcodebuild "${PROJECT[@]}" -scheme App -configuration Debug -destination "$DEST" -derivedDataPath "$IOS_BUILD" -allowProvisioningUpdates build
if [[ -n "${QZU_DEPLOY_HOST:-}" ]]; then
  SSH=(ssh)
  if [[ -n "${QZU_SSH_KEY:-}" ]]; then SSH+=(-i "$QZU_SSH_KEY"); fi
  "${SSH[@]}" "$QZU_DEPLOY_HOST" 'cd ~/ccWeb && git pull --ff-only origin main && npm test && sudo systemctl restart qzu && sleep 3 && curl -fsS http://127.0.0.1:3000/healthz'
  echo
fi
if command -v adb >/dev/null 2>&1; then
  DEVICES="$(adb devices | awk '$2=="device" {print $1}')"
  COUNT="$(printf '%s\n' "$DEVICES" | awk 'NF {n++} END {print n+0}')"
  if [[ "$COUNT" == 1 ]]; then
    adb -s "$DEVICES" install -r "$APK"
  else
    adb devices
    echo "No single Android device selected. APK saved to Desktop."
  fi
fi
if [[ -n "$IPHONE" ]]; then
  xcrun devicectl device install app --device "$IPHONE" "$IOS_BUILD/Build/Products/Debug-iphoneos/App.app"
fi
echo "qzu. v$VERSION builds complete."
