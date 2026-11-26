#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
HOST="${QZU_DEPLOY_HOST:?Set QZU_DEPLOY_HOST}"
SSH=(ssh)
SCP=(scp)
if [[ -n "${QZU_SSH_KEY:-}" ]]; then
  SSH+=(-i "$QZU_SSH_KEY")
  SCP+=(-i "$QZU_SSH_KEY")
fi
ORIGIN="${QZU_PUBLIC_ORIGIN:-https://qzu.duckdns.org}"
[[ "$ORIGIN" == https://* ]] || exit 1
[[ "$(git branch --show-current)" == main && -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Clean main branch required."; exit 1; }
git fetch origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "Pull latest main first."; exit 1; }
COMMIT="$(git rev-parse HEAD)"
VERSION="$(node -p "require('./package.json').version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
APK="release-output/qzu-$VERSION.apk"
if [[ "${QZU_USE_EXISTING_APK:-0}" != 1 ]]; then
  npm run release:android
fi
[[ -f "$APK" ]] || { echo "Signed APK missing."; exit 1; }
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
TOOLS="$(find "$SDK/build-tools" -name apksigner -type f | sort | tail -1)"
[[ -n "$TOOLS" ]] || exit 1
TOOLS="$(dirname "$TOOLS")"
SIGNATURE="$("$TOOLS/apksigner" verify --verbose --print-certs "$APK")"
printf '%s\n' "$SIGNATURE"
CERT="$(printf '%s\n' "$SIGNATURE" | awk '/Signer #1 certificate SHA-256 digest:/ {print $NF}')"
[[ "$CERT" == 3903cec62a53267e380f0ace3eec630ad056e970c8fc2fb233b0051c122e8ae8 ]] || { echo "Unexpected release certificate."; exit 1; }
BADGING="$("$TOOLS/aapt" dump badging "$APK")"
PACKAGE="$(printf '%s\n' "$BADGING" | sed -n '1p')"
EXPECTED_CODE="$(node -e 'const [a,b,c]=process.argv[1].split(".").map(Number);console.log(1+a*1000000+b*1000+c)' "$VERSION")"
[[ "$PACKAGE" == *"name='cc.qzu.app'"* && "$PACKAGE" == *"versionName='$VERSION'"* && "$PACKAGE" == *"versionCode='$EXPECTED_CODE'"* ]] || { echo "APK package or version mismatch."; exit 1; }
HASH="$(shasum -a 256 "$APK" | awk '{print $1}')"
STAGE="$("${SSH[@]}" "$HOST" 'umask 077; mkdir -p ~/ccWeb/data/releases; mktemp ~/ccWeb/data/releases/.upload.XXXXXXXX')"
[[ "$STAGE" =~ ^/home/ubuntu/ccWeb/data/releases/\.upload\.[A-Za-z0-9]+$ ]] || { echo "Unexpected upload directory."; exit 1; }
trap '"${SSH[@]}" "$HOST" "rm -f -- $STAGE" >/dev/null 2>&1 || true' EXIT
"${SCP[@]}" "$APK" "$HOST:$STAGE"
"${SSH[@]}" "$HOST" "bash -s -- '$VERSION' '$COMMIT' '$HASH' '$STAGE'" <<'REMOTE'
set -euo pipefail
umask 077
VERSION="$1"
COMMIT="$2"
HASH="$3"
STAGE="$4"
cd "$HOME/ccWeb"
exec 9>"$HOME/.qzu-deploy.lock"
flock -n 9 || { echo "Another deployment is running."; exit 1; }
[[ "$(git branch --show-current)" == main && -z "$(git status --porcelain --untracked-files=no)" ]] || exit 1
[[ "$(sha256sum "$STAGE" | awk '{print $1}')" == "$HASH" ]] || { echo "Upload checksum mismatch."; exit 1; }
git fetch origin main
[[ "$(git rev-parse origin/main)" == "$COMMIT" ]] || { echo "GitHub changed during publication. Retry."; exit 1; }
OLD="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$OLD" "$COMMIT" || exit 1
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
git archive "$COMMIT" | tar -x -C "$TEMP"
node - "$TEMP/package.json" "$VERSION" <<'NODE'
const fs=require('fs');
const current=JSON.parse(fs.readFileSync('package.json'));
const candidate=JSON.parse(fs.readFileSync(process.argv[2]));
if(candidate.version!==process.argv[3]||JSON.stringify(current.dependencies)!==JSON.stringify(candidate.dependencies))process.exit(1);
NODE
ln -s "$PWD/node_modules" "$TEMP/node_modules"
(cd "$TEMP" && npm test)
DEST="$PWD/data/releases/qzu-$VERSION.apk"
if [[ -f "$DEST" ]]; then
  [[ "$(sha256sum "$DEST" | awk '{print $1}')" == "$HASH" ]] || { echo "Release already published with different bytes. Bump version."; exit 1; }
else
  chmod 600 "$STAGE"
  mv "$STAGE" "$DEST"
fi
git merge --ff-only "$COMMIT"
if sudo -n systemctl restart qzu; then
  for attempt in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:3000/healthz | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const x=JSON.parse(s);process.exit(x.ok&&x.version===process.argv[1]?0:1)}catch{process.exit(1)}})' "$VERSION"; then
      echo "Server running $VERSION"
      exit 0
    fi
    sleep 2
  done
fi
echo "Health check failed; restoring previous server code."
git reset --hard "$OLD"
sudo -n systemctl restart qzu
exit 1
REMOTE
URL="$ORIGIN/downloads/qzu-$VERSION.apk"
REMOTE_HASH="$(curl -fsSL --max-time 180 "$URL" | shasum -a 256 | awk '{print $1}')"
[[ "$REMOTE_HASH" == "$HASH" ]] || { echo "Public download checksum mismatch."; exit 1; }
echo "Published and verified: $URL"
