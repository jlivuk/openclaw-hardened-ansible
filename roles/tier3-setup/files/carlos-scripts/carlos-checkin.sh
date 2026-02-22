#!/usr/bin/env bash
# Hourly check-in — fires once at the configured check-in hour, sends nutrition nudge via Telegram
# Cron: 0 * * * *  ~/carlos-dashboard/carlos-checkin.sh  (runs every hour; script gates on checkin_hour)
#
# Requires: ~/.telegram-token (bot token), ~/.telegram-chat-id (chat ID)

set -euo pipefail

CARLOS_USER="${CARLOS_USER:-john}"
CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
DB_PATH="$CARLOS_DATA_DIR/$CARLOS_USER/carlos.db"

BOT_TOKEN=$(cat "$HOME/.telegram-token" 2>/dev/null || true)
CHAT_ID=$(cat "$HOME/.telegram-chat-id" 2>/dev/null || true)

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: ~/.telegram-token or ~/.telegram-chat-id not found"
  exit 1
fi

# Detect sqlite3 binary
if command -v sqlite3 &>/dev/null; then
  SQLITE=sqlite3
else
  echo "Error: sqlite3 not found"
  exit 1
fi

# --- Hour gate ---
# Read desired check-in hour from user_preferences (default: 18 = 6pm)
CHECKIN_HOUR=$("$SQLITE" "$DB_PATH" "SELECT value FROM user_preferences WHERE key='checkin_hour'" 2>/dev/null || true)
CHECKIN_HOUR=${CHECKIN_HOUR:-18}

# Validate: must be an integer 0-23, else fall back to default
if ! [[ "$CHECKIN_HOUR" =~ ^[0-9]{1,2}$ ]] || [ "$CHECKIN_HOUR" -gt 23 ]; then
  CHECKIN_HOUR=18
fi

CURRENT_HOUR=$(TZ=America/Chicago date +%-H)

if [ "$CURRENT_HOUR" -ne "$CHECKIN_HOUR" ]; then
  # Not our hour — exit silently
  exit 0
fi

# --- Goals from user_preferences (with sensible defaults) ---
CAL_TARGET=$("$SQLITE" "$DB_PATH" "SELECT value FROM user_preferences WHERE key='daily_calorie_goal'" 2>/dev/null || true)
CAL_TARGET=${CAL_TARGET:-1800}

PROTEIN_TARGET=$("$SQLITE" "$DB_PATH" "SELECT value FROM user_preferences WHERE key='daily_protein_goal'" 2>/dev/null || true)
PROTEIN_TARGET=${PROTEIN_TARGET:-150}

HYDRATION_TARGET=8

# --- Today's date in Chicago time ---
TODAY=$(TZ=America/Chicago date +%Y-%m-%d)

# --- Read today's data from SQLite ---
# Returns two values separated by |
MEAL_ROW=$("$SQLITE" "$DB_PATH" \
  "SELECT COALESCE(SUM(calories),0), COALESCE(SUM(CAST(REPLACE(protein,'g','') AS INTEGER)),0) FROM meals WHERE date='$TODAY'" \
  2>/dev/null || echo "0|0")

TOTAL_CALS=$(echo "$MEAL_ROW" | cut -d'|' -f1)
TOTAL_PROTEIN=$(echo "$MEAL_ROW" | cut -d'|' -f2)

HYDRATION_COUNT=$("$SQLITE" "$DB_PATH" \
  "SELECT COUNT(*) FROM hydration WHERE date='$TODAY'" \
  2>/dev/null || echo "0")

# --- Build Telegram message ---
send_telegram() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=$1" > /dev/null
}

# No meals logged yet
if [ "$TOTAL_CALS" -eq 0 ]; then
  send_telegram "*$(TZ=America/Chicago date +%I:%M\ %p) Check-in*

Hey! No meals logged today yet. Still time to track dinner!"
  echo "Check-in sent (no meals)"
  exit 0
fi

# Build nudge messages
MSGS=""

CAL_REMAINING=$((CAL_TARGET - TOTAL_CALS))
PROTEIN_REMAINING=$((PROTEIN_TARGET - TOTAL_PROTEIN))

if [ "$PROTEIN_REMAINING" -gt 30 ]; then
  MSGS="${MSGS}Protein check: ${TOTAL_PROTEIN}g so far — ${PROTEIN_REMAINING}g to go. A chicken breast or protein shake would get you there!

"
fi

if [ "$CAL_REMAINING" -gt 400 ]; then
  MSGS="${MSGS}You've got ~${CAL_REMAINING} cal left in your budget — plenty of room for a good dinner.

"
elif [ "$CAL_REMAINING" -lt 0 ]; then
  OVER=$(( -CAL_REMAINING ))
  MSGS="${MSGS}You're at ${TOTAL_CALS} cal (${OVER} over target). Maybe go light for the rest of the evening.

"
fi

HYDRATION_THRESHOLD=$((HYDRATION_TARGET - 2))
if [ "$HYDRATION_COUNT" -lt "$HYDRATION_THRESHOLD" ]; then
  MSGS="${MSGS}Only ${HYDRATION_COUNT}/${HYDRATION_TARGET} glasses of water — try to squeeze in a few more before bed!

"
fi

if [ -z "$MSGS" ]; then
  MSGS="Looking good today! ${TOTAL_CALS} cal, ${TOTAL_PROTEIN}g protein — right on track. Keep it up!"
fi

CHECKIN_LABEL=$(TZ=America/Chicago date +%I:%M\ %p)
send_telegram "*${CHECKIN_LABEL} Check-in*

${MSGS}"
echo "Check-in sent"
