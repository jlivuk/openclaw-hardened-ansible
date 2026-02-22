#!/bin/bash
# Syncs Carlos's nutrition memory files to the GitHub repo
# Run via cron: */5 * * * * /home/baxter/carlos-logs/sync-logs.sh

MEMORY_DIR="$HOME/.openclaw/workspace-carlos/memory"
REPO_DIR="$HOME/carlos-logs"
LOGS_DIR="$REPO_DIR/logs"

# Ensure repo exists
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone git@github.com:jlivuk/carlos-logs.git "$REPO_DIR" 2>/dev/null || \
  git clone https://github.com/jlivuk/carlos-logs.git "$REPO_DIR"
fi

mkdir -p "$LOGS_DIR"

# Copy memory files to logs/
if [ -d "$MEMORY_DIR" ]; then
  for f in "$MEMORY_DIR"/*.md; do
    [ -f "$f" ] && cp "$f" "$LOGS_DIR/"
  done
fi

cd "$REPO_DIR" || exit 1

# Check for changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0  # No changes
fi

git add -A
git commit -m "Update nutrition logs $(date +%Y-%m-%d\ %H:%M)" --author="Carlos <carlos@openclaw.local>" 2>/dev/null
git push origin main 2>/dev/null
