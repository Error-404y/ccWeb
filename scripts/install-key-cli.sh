#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin"
HOST=""
if [[ $# -gt 0 ]]; then
  [[ $# -eq 2 && "$1" == "--ssh" && "$2" =~ ^[A-Za-z0-9][A-Za-z0-9.@_-]*$ ]] || { echo "Usage: bash scripts/install-key-cli.sh [--ssh SSH_HOST_ALIAS]" >&2; exit 1; }
  HOST="$2"
fi
mkdir -p "$BIN"
for command in genKey listKeys findKey resetKey revokeKey genAdminKey findAccount keyStats extendKey; do
  target="$BIN/$command"
  if [[ -e "$target" && ! -f "$target" ]] || [[ -L "$target" ]]; then echo "Refusing to overwrite $target" >&2; exit 1; fi
  if [[ -f "$target" ]] && ! grep -qx '# qzu-key-cli managed wrapper' "$target"; then echo "Refusing to overwrite unrelated $target" >&2; exit 1; fi
  tmp="$(mktemp "$BIN/.qzu-cli.XXXXXXXX")"
  {
    printf '#!/usr/bin/env bash\n# qzu-key-cli managed wrapper\nset -euo pipefail\n'
    printf 'command=%q\n' "$command"
    if [[ -n "$HOST" ]]; then
      printf 'host=%q\n' "$HOST"
      cat <<'EOF'
# Single-quote every argument for the remote POSIX shell.
quote() { local s="$1"; printf "'%s'" "$(printf '%s' "$s" | sed "s/'/'\\\\''/g")"; }
remote='cd "$HOME/ccWeb" && node --env-file-if-exists=.env scripts/keys.mjs'
remote="$remote $(quote "$command")"
for arg in "$@"; do remote="$remote $(quote "$arg")"; done
exec ssh -T "$host" "$remote"
EOF
    else
      printf 'cd %q\n' "$ROOT"
      printf 'exec node --env-file-if-exists=.env scripts/keys.mjs "$command" "$@"\n'
    fi
  } > "$tmp"
  chmod 700 "$tmp"
  mv "$tmp" "$target"
done
echo 'qzu. commands installed in ~/.local/bin'
echo 'Add to your shell configuration: export PATH="$HOME/.local/bin:$PATH"'
echo 'Example: genKey - 1W'
