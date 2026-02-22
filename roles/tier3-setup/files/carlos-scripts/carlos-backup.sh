#!/bin/bash
# Daily backup of Carlos workspace + media, with media size monitoring
# Cron: 30 3 * * *  ~/carlos-dashboard/carlos-backup.sh >> /tmp/carlos-backup.log 2>&1
#
# What it does:
# 1. Backs up workspace-carlos (memory, config) to Seagate
# 2. Backs up media/inbound (food photos) to Seagate
# 3. If media exceeds size threshold, archives old photos to Seagate and removes from container
# 4. Keeps last 14 daily backups, prunes older ones

BACKUP_ROOT="/mnt/seagate/backups"
WORKSPACE_DIR="$HOME/.openclaw/workspace-carlos"
AGENTS_DIR="$HOME/.openclaw/agents/carlos"
MEDIA_DIR="$HOME/.openclaw/media/inbound"
MEDIA_ARCHIVE="$BACKUP_ROOT/media-archive"
MAX_MEDIA_MB=500  # alert/archive threshold in MB
KEEP_DAYS=14      # daily backups to retain

DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)

# Ensure backup dirs exist
mkdir -p "$BACKUP_ROOT" "$MEDIA_ARCHIVE"

# --- 1. Workspace + agent config backup ---
BACKUP_DIR="$BACKUP_ROOT/carlos-$DATE"
if [ -d "$BACKUP_DIR" ]; then
  # Already backed up today — update in place
  rm -rf "$BACKUP_DIR"
fi
mkdir -p "$BACKUP_DIR"
cp -r "$WORKSPACE_DIR" "$BACKUP_DIR/workspace-carlos"
cp -r "$AGENTS_DIR" "$BACKUP_DIR/agents-carlos"
echo "$(date -Iseconds) [backup] workspace backed up to $BACKUP_DIR ($(du -sh "$BACKUP_DIR" | cut -f1))"

# --- 2. Media backup ---
if [ -d "$MEDIA_DIR" ] && [ "$(ls -A "$MEDIA_DIR" 2>/dev/null)" ]; then
  # Copy new photos to archive (skip already archived)
  COPIED=0
  for f in "$MEDIA_DIR"/*; do
    fname=$(basename "$f")
    if [ ! -f "$MEDIA_ARCHIVE/$fname" ]; then
      cp "$f" "$MEDIA_ARCHIVE/"
      COPIED=$((COPIED + 1))
    fi
  done
  echo "$(date -Iseconds) [backup] $COPIED new photos archived to $MEDIA_ARCHIVE"

  # --- 3. Media size check ---
  MEDIA_SIZE_KB=$(du -sk "$MEDIA_DIR" 2>/dev/null | cut -f1)
  MEDIA_SIZE_MB=$((MEDIA_SIZE_KB / 1024))
  echo "$(date -Iseconds) [backup] media dir: ${MEDIA_SIZE_MB}MB / ${MAX_MEDIA_MB}MB limit"

  if [ "$MEDIA_SIZE_MB" -gt "$MAX_MEDIA_MB" ]; then
    echo "$(date -Iseconds) [backup] WARNING: media exceeds ${MAX_MEDIA_MB}MB — pruning old photos"
    # Remove photos older than 30 days (they're already archived on Seagate)
    PRUNED=0
    find "$MEDIA_DIR" -type f -mtime +30 | while read -r oldfile; do
      fname=$(basename "$oldfile")
      # Verify it's archived before removing
      if [ -f "$MEDIA_ARCHIVE/$fname" ]; then
        rm "$oldfile"
        PRUNED=$((PRUNED + 1))
      fi
    done
    NEW_SIZE_KB=$(du -sk "$MEDIA_DIR" 2>/dev/null | cut -f1)
    echo "$(date -Iseconds) [backup] media after prune: $((NEW_SIZE_KB / 1024))MB"

    # Send alert via Telegram if still over limit
    NEW_SIZE_MB=$((NEW_SIZE_KB / 1024))
    if [ "$NEW_SIZE_MB" -gt "$MAX_MEDIA_MB" ]; then
      BOT_TOKEN=$(cat "$HOME/.telegram-token" 2>/dev/null)
      CHAT_ID=$(cat "$HOME/.telegram-chat-id" 2>/dev/null)
      if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
        curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
          -d "chat_id=${CHAT_ID}" \
          -d "text=⚠️ Carlos media storage is at ${NEW_SIZE_MB}MB (limit: ${MAX_MEDIA_MB}MB). Old photos pruned but still over threshold." > /dev/null
      fi
    fi
  fi
else
  echo "$(date -Iseconds) [backup] no media files to archive"
fi

# --- 4. Prune old daily backups ---
PRUNED_BACKUPS=0
find "$BACKUP_ROOT" -maxdepth 1 -name "carlos-????-??-??" -type d -mtime +$KEEP_DAYS | while read -r old_backup; do
  rm -rf "$old_backup"
  PRUNED_BACKUPS=$((PRUNED_BACKUPS + 1))
  echo "$(date -Iseconds) [backup] pruned old backup: $(basename "$old_backup")"
done

echo "$(date -Iseconds) [backup] done"
