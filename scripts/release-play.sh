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
[[ -f "$KEYSTORE" ]] || { echo "Existing signing key required at $KEYSTORE. Do not replace it." >&2; exit 1; }
[[ -f android/app/google-services.json ]] || { echo "Install the Firebase Android configuration first." >&2; exit 1; }
node --input-type=module -e 'import {readFileSync} from "node:fs"; const config=JSON.parse(readFileSync("android/app/google-services.json","utf8"));if(!config.client?.some(c=>c.client_info?.android_client_info?.package_name==="cc.qzu.app"))throw Error("Firebase package mismatch");'
VERSION="$(node -p "require('./package.json').version")"
npm test
QZU_DISTRIBUTION=google-play npm run mobile:prepare -- android
(cd android && ./gradlew --no-daemon "-Dorg.gradle.java.home=$JAVA_HOME" :app:bundleRelease)
BUNDLE="android/app/build/outputs/bundle/release/app-release.aab"
[[ -f "$BUNDLE" ]] || { echo "Android App Bundle missing." >&2; exit 1; }
mkdir -p release-output
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
"$JAVA_HOME/bin/jarsigner" -keystore "$KEYSTORE" -signedjar "$TEMP/qzu.aab" "$BUNDLE" "$ALIAS"
"$JAVA_HOME/bin/jarsigner" -verify "$TEMP/qzu.aab"
DEST="release-output/qzu-$VERSION.aab"
if [[ -e "$DEST" ]]; then
  echo "Bundle already exists: $DEST. Preserve uploaded builds; bump the version before publishing a replacement." >&2
  exit 1
fi
mv "$TEMP/qzu.aab" "$DEST"
echo "Signed Android App Bundle: $PWD/$DEST"
echo "For Play Console draft/internal testing only until store policy requirements are addressed."
