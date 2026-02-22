#!/bin/bash
# One-time migration: move existing root-level data into john/ subdirectory.
# Run on the Pi after deploying the multi-user auth update.
#
# Before: ~/carlos-dashboard/carlos.db
# After:  ~/carlos-dashboard/john/carlos.db
#
# Before: ~/.openclaw/workspace-carlos/memory/*.md
# After:  ~/.openclaw/workspace-carlos/memory/john/*.md

set -euo pipefail

CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
CARLOS_MEMORY_BASE="${CARLOS_MEMORY_BASE:-$HOME/.openclaw/workspace-carlos/memory}"
TARGET_USER="${1:-john}"

echo "Migrating existing data to user: $TARGET_USER"
echo "  Data dir: $CARLOS_DATA_DIR"
echo "  Memory base: $CARLOS_MEMORY_BASE"
echo ""

# --- Migrate DB ---
SRC_DB="${CARLOS_DATA_DIR}/carlos.db"
DST_DIR="${CARLOS_DATA_DIR}/${TARGET_USER}"
DST_DB="${DST_DIR}/carlos.db"

if [ -f "$SRC_DB" ] && [ ! -f "$DST_DB" ]; then
  mkdir -p "$DST_DIR"
  echo "Moving DB: $SRC_DB -> $DST_DB"
  mv "$SRC_DB" "$DST_DB"
  # Move any other root-level DB files (journal, WAL)
  for ext in -journal -wal -shm; do
    [ -f "${SRC_DB}${ext}" ] && mv "${SRC_DB}${ext}" "${DST_DB}${ext}"
  done
  echo "  DB migrated."
elif [ -f "$DST_DB" ]; then
  echo "  DB already at $DST_DB — skipping."
elif [ ! -f "$SRC_DB" ]; then
  echo "  No root-level DB found — skipping."
fi

# --- Migrate memory files ---
DST_MEMORY="${CARLOS_MEMORY_BASE}/${TARGET_USER}"

if [ -d "$CARLOS_MEMORY_BASE" ] && [ ! -d "$DST_MEMORY" ]; then
  mkdir -p "$DST_MEMORY"
  # Move markdown files (daily logs, GOALS, WEIGHT, STREAKS, etc.)
  MOVED=0
  for f in "$CARLOS_MEMORY_BASE"/*.md; do
    [ -f "$f" ] || continue
    basename=$(basename "$f")
    echo "  Moving memory: $basename"
    mv "$f" "$DST_MEMORY/$basename"
    MOVED=$((MOVED + 1))
  done
  # Move backups directory if it exists at root level
  if [ -d "$CARLOS_MEMORY_BASE/backups" ]; then
    mv "$CARLOS_MEMORY_BASE/backups" "$DST_MEMORY/backups"
    echo "  Moved backups directory."
  fi
  echo "  Migrated $MOVED memory files."
elif [ -d "$DST_MEMORY" ]; then
  echo "  Memory dir already at $DST_MEMORY — skipping."
fi

# --- Migrate users.json if it doesn't exist ---
USERS_FILE="${CARLOS_DATA_DIR}/users.json"
if [ ! -f "$USERS_FILE" ]; then
  echo ""
  echo "No users.json found. Create users with:"
  echo "  bash manage-users.sh add $TARGET_USER <password> '<Display Name>'"
else
  echo ""
  echo "users.json already exists."
fi

echo ""
echo "Migration complete. Verify with:"
echo "  ls -la ${DST_DIR}/"
echo "  ls -la ${DST_MEMORY}/"
