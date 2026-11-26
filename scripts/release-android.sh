#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source scripts/java21.sh
qzu_java21
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
KEYSTORE="${QZU_ANDROID_KEYSTORE:-$HOME/.qzu-signing/release.jks}"
ALIAS="${QZU_ANDROID_ALIAS:-qzu-release}"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "No signing key at $KEYSTORE. Generate a release key first; do not overwrite an existing key."
  exit 1
fi
SDK_TOOLS="$(find "$ANDROID_HOME/build-tools" -name apksigner -type f | sort | tail -1)"
[[ -n "$SDK_TOOLS" ]] || { echo "Android SDK build-tools missing."; exit 1; }
SDK_TOOLS="$(dirname "$SDK_TOOLS")"
VERSION="$(node -p "require('./package.json').version")"
npm test
npm run mobile:prepare -- android
(cd android && ./gradlew --no-daemon "-Dorg.gradle.java.home=$JAVA_HOME" :app:assembleRelease)
UNSIGNED="android/app/build/outputs/apk/release/app-release-unsigned.apk"
[[ -f "$UNSIGNED" ]] || { echo "Unsigned APK missing; inspect Android Studio release configuration."; exit 1; }
mkdir -p release-output
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
"$SDK_TOOLS/zipalign" -P 16 -f 4 "$UNSIGNED" "$TEMP/aligned.apk"
"$SDK_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "$ALIAS" --out "$TEMP/signed.apk" "$TEMP/aligned.apk"
"$SDK_TOOLS/apksigner" verify --verbose --print-certs "$TEMP/signed.apk"
"$SDK_TOOLS/aapt" dump badging "$TEMP/signed.apk" | head -n 1
mv "$TEMP/signed.apk" "release-output/qzu-$VERSION.apk"
echo "Signed APK: release-output/qzu-$VERSION.apk"
