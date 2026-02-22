#!/bin/bash
# Provision a new user — creates their DB and memory directory.
# Usage: init-user.sh <username>

set -euo pipefail

USERNAME="${1:?Usage: init-user.sh <username>}"
VERA_DATA_DIR="${VERA_DATA_DIR:-$HOME/vera-dashboard}"

# Check both possible memory locations (container mount vs local)
if [ -d "/opt/openclaw/workspace-vera/memory" ]; then
  VERA_MEMORY_BASE="/opt/openclaw/workspace-vera/memory"
else
  VERA_MEMORY_BASE="${VERA_MEMORY_BASE:-$HOME/.openclaw/workspace-vera/memory}"
fi

USER_DATA="${VERA_DATA_DIR}/${USERNAME}"
USER_MEMORY="${VERA_MEMORY_BASE}/${USERNAME}"

echo "Provisioning user: $USERNAME"
echo "  Data: $USER_DATA"
echo "  Memory: $USER_MEMORY"

mkdir -p "$USER_DATA"
mkdir -p "$USER_MEMORY"

# Init DB using the shared init-db.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERA_USER="$USERNAME" VERA_DATA_DIR="$VERA_DATA_DIR" bash "$SCRIPT_DIR/init-db.sh" "$USERNAME"

echo "User $USERNAME provisioned successfully."
