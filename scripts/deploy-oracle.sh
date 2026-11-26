#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
exec 9>"$HOME/.qzu-deploy.lock"
flock -n 9 || exit 0
[[ "$(git branch --show-current)" == main ]] || { echo "Deployment requires main."; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Tracked local changes; refusing deployment."; exit 1; }
OLD="$(git rev-parse HEAD)"
git fetch origin main
NEW="$(git rev-parse origin/main)"
[[ "$OLD" != "$NEW" ]] || { echo "Already current."; exit 0; }
git merge-base --is-ancestor "$OLD" "$NEW" || { echo "Non-fast-forward deployment rejected."; exit 1; }
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
git archive "$NEW" | tar -x -C "$TEMP"
node - "$TEMP/package.json" <<'NODE'
const fs = require('fs');
const current = JSON.parse(fs.readFileSync('package.json'));
const next = JSON.parse(fs.readFileSync(process.argv[2]));
if (JSON.stringify(current.dependencies) !== JSON.stringify(next.dependencies)) {
  console.error('Runtime dependencies changed; manual deployment required.');
  process.exit(1);
}
NODE
ln -s "$PWD/node_modules" "$TEMP/node_modules"
(cd "$TEMP" && npm test)
VERSION="$(node -p "require(process.argv[1]).version" "$TEMP/package.json")"
git merge --ff-only "$NEW"
if sudo -n systemctl restart qzu; then
  for attempt in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:3000/healthz | node -e 'let s=""; process.stdin.on("data", d=>s+=d); process.stdin.on("end",()=>{try{const x=JSON.parse(s);process.exit(x.ok&&x.version===process.argv[1]?0:1)}catch{process.exit(1)}})' "$VERSION"; then
      echo "Deployed $VERSION ($NEW)"
      exit 0
    fi
    sleep 2
  done
fi
echo "Health check failed; rolling back code to $OLD."
git reset --hard "$OLD"
sudo -n systemctl restart qzu
exit 1
