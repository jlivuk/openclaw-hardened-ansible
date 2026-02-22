#!/bin/bash
# Provision a new user — creates their DB and memory directory.
# Usage: init-user.sh <username>

set -euo pipefail

USERNAME="${1:?Usage: init-user.sh <username>}"
CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"

# Check both possible memory locations (container mount vs local)
if [ -d "/opt/openclaw/workspace-carlos/memory" ]; then
  CARLOS_MEMORY_BASE="/opt/openclaw/workspace-carlos/memory"
else
  CARLOS_MEMORY_BASE="${CARLOS_MEMORY_BASE:-$HOME/.openclaw/workspace-carlos/memory}"
fi

USER_DATA="${CARLOS_DATA_DIR}/${USERNAME}"
USER_MEMORY="${CARLOS_MEMORY_BASE}/${USERNAME}"

echo "Provisioning user: $USERNAME"
echo "  Data: $USER_DATA"
echo "  Memory: $USER_MEMORY"

mkdir -p "$USER_DATA"
mkdir -p "$USER_MEMORY"

# Init DB using the shared init-db.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CARLOS_USER="$USERNAME" CARLOS_DATA_DIR="$CARLOS_DATA_DIR" bash "$SCRIPT_DIR/init-db.sh" "$USERNAME"

echo "User $USERNAME provisioned successfully."
