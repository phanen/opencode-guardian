#!/usr/bin/env bash
# Installs this Guardian plugin globally for the current user.
#
# - Registers the plugin via `opencode plugin -g` (handles opencode.json patching).
# - Copies commands/*.md into ~/.config/opencode/commands/ (slash command registration).
#
# Idempotent: existing command files are left untouched.
# Use `DRY_RUN=1` to print the actions without executing them.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GLOBAL_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
COMMANDS_SRC="$REPO_ROOT/commands"
COMMANDS_DST="$GLOBAL_CONFIG_DIR/commands"

run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if [ ! -d "$GLOBAL_CONFIG_DIR" ]; then
  echo "ERROR: Global config dir $GLOBAL_CONFIG_DIR does not exist" >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: opencode CLI not found on PATH" >&2
  exit 1
fi

echo ">> opencode plugin -g $REPO_ROOT"
run opencode plugin -g "$REPO_ROOT"

run mkdir -p "$COMMANDS_DST"
if [ -d "$COMMANDS_SRC" ]; then
  for src in "$COMMANDS_SRC"/*.md; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    dst="$COMMANDS_DST/$name"
    if [ -e "$dst" ]; then
      echo "OK: $name already present — skipping"
      continue
    fi
    run cp "$src" "$dst"
    echo "OK: deployed $name -> $dst"
  done
fi

echo ""
echo "Guardian plugin is now installed globally."
echo "Restart OpenCode for the changes to take effect."

