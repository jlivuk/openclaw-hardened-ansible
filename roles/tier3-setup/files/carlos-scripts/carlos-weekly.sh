#!/usr/bin/env bash
# Weekly fitness summary — gathers 7 days of data from SQLite, calls AI for coaching,
# and delivers the report via Telegram every Sunday at 9am CST.
# Cron: 0 15 * * 0  ~/carlos-dashboard/carlos-weekly.sh  (UTC = CST+6)
#
# Usage:
#   carlos-weekly.sh              — gather data, call AI, send Telegram
#   carlos-weekly.sh --dry-run    — print gathered data to stdout and exit

set -euo pipefail

CARLOS_USER="${CARLOS_USER:-john}"
CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
CARLOS_PORT="${CARLOS_PORT:-8080}"
DB_PATH="$CARLOS_DATA_DIR/$CARLOS_USER/carlos.db"

# Detect sqlite3 binary
if command -v sqlite3 &>/dev/null; then
  SQLITE=sqlite3
else
  echo "Error: sqlite3 not found"
  exit 1
fi

# Validate DB exists
if [ ! -f "$DB_PATH" ]; then
  echo "Error: Database not found at $DB_PATH"
  exit 1
fi

# Parse flags
DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

gather_weekly_data() {
  # Compute 7 dates (today back to 6 days ago)
  local dates=()
  local i
  for i in 6 5 4 3 2 1 0; do
    local d
    d=$(date -d "-${i} days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d)
    dates+=("$d")
  done

  local date_start="${dates[0]}"
  local date_end="${dates[6]}"

  # Build SQL IN clause
  local in_clause=""
  for d in "${dates[@]}"; do
    [ -n "$in_clause" ] && in_clause="${in_clause},"
    in_clause="${in_clause}'$d'"
  done

  # Read goals from user_preferences (with defaults)
  local cal_goal protein_goal exercise_goal
  cal_goal=$("$SQLITE" "$DB_PATH" "SELECT value FROM user_preferences WHERE key='daily_calorie_goal';" 2>/dev/null || true)
  cal_goal="${cal_goal:-1800}"
  protein_goal=$("$SQLITE" "$DB_PATH" "SELECT value FROM user_preferences WHERE key='daily_protein_goal';" 2>/dev/null || true)
  protein_goal="${protein_goal:-150}"
  exercise_goal=$("$SQLITE" "$DB_PATH" "SELECT value FROM user_preferences WHERE key='exercise_days_goal';" 2>/dev/null || true)
  exercise_goal="${exercise_goal:-4}"

  # Query daily meal summaries
  local meals_data
  meals_data=$("$SQLITE" "$DB_PATH" "SELECT date, COALESCE(SUM(calories),0), COALESCE(SUM(CAST(REPLACE(protein,'g','') AS INTEGER)),0), COALESCE(SUM(CAST(REPLACE(carbs,'g','') AS INTEGER)),0), COALESCE(SUM(CAST(REPLACE(fat,'g','') AS INTEGER)),0) FROM meals WHERE date IN ($in_clause) GROUP BY date ORDER BY date;" 2>/dev/null || true)

  # Query daily hydration
  local hydration_data
  hydration_data=$("$SQLITE" "$DB_PATH" "SELECT date, COUNT(*) FROM hydration WHERE date IN ($in_clause) GROUP BY date ORDER BY date;" 2>/dev/null || true)

  # Query exercise
  local exercise_data
  exercise_data=$("$SQLITE" "$DB_PATH" "SELECT date, activity, duration, calories_burned FROM exercise WHERE date IN ($in_clause) ORDER BY date;" 2>/dev/null || true)

  # Query weight
  local weight_data
  weight_data=$("$SQLITE" "$DB_PATH" "SELECT date, weight_lbs FROM weight WHERE date IN ($in_clause) ORDER BY date;" 2>/dev/null || true)

  # Query sleep
  local sleep_data
  sleep_data=$("$SQLITE" "$DB_PATH" "SELECT date, duration_minutes FROM sleep WHERE date IN ($in_clause) ORDER BY date;" 2>/dev/null || true)

  # Output structured text
  echo "=== WEEKLY FITNESS DATA ($date_start to $date_end) ==="
  echo "GOALS: calories=${cal_goal}/day, protein=${protein_goal}g/day, exercise=${exercise_goal} days/week"
  echo ""
  echo "DAILY MEALS (date|calories|protein_g|carbs_g|fat_g):"
  if [ -n "$meals_data" ]; then
    echo "$meals_data"
  else
    echo "(no meals logged)"
  fi
  echo ""
  echo "DAILY HYDRATION (date|glasses):"
  if [ -n "$hydration_data" ]; then
    echo "$hydration_data"
  else
    echo "(no hydration logged)"
  fi
  echo ""
  echo "EXERCISE (date|activity|duration|calories_burned):"
  if [ -n "$exercise_data" ]; then
    echo "$exercise_data"
  else
    echo "(no exercise logged)"
  fi
  echo ""
  echo "WEIGHT (date|weight_lbs):"
  if [ -n "$weight_data" ]; then
    echo "$weight_data"
  else
    echo "(no weight logged)"
  fi
  echo ""
  echo "SLEEP (date|duration_minutes):"
  if [ -n "$sleep_data" ]; then
    echo "$sleep_data"
  else
    echo "(no sleep logged)"
  fi
}

# Gather data
WEEKLY_DATA=$(gather_weekly_data)

# --dry-run: print data and exit
if [ "$DRY_RUN" = true ]; then
  echo "$WEEKLY_DATA"
  exit 0
fi

# --- AI call and Telegram delivery (Task 2) ---

# Telegram setup
BOT_TOKEN=$(cat "$HOME/.telegram-token" 2>/dev/null || true)
CHAT_ID=$(cat "$HOME/.telegram-chat-id" 2>/dev/null || true)

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: ~/.telegram-token or ~/.telegram-chat-id not found"
  exit 1
fi

send_telegram() {
  local text="$1"
  # Truncate to 4000 chars (Telegram limit is 4096)
  text="${text:0:4000}"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=$text" > /dev/null
}

# AI prompt
PROMPT="System: You are Carlos, an AI fitness coach. Write a personalized weekly coaching summary for Telegram.

Rules:
- Use Telegram Markdown (*bold*, _italic_)
- Keep under 3500 chars
- Start with an overall assessment
- Highlight wins and areas for improvement
- Compare actual vs goals
- Note patterns across the week
- End with 2-3 actionable recommendations for next week
- Be encouraging but honest
- No tables or code blocks

Here is the user's data for the past 7 days:

$WEEKLY_DATA"

# API key retrieval
ADMIN_DB="$CARLOS_DATA_DIR/carlos-admin.db"
API_KEY=$("$SQLITE" "$ADMIN_DB" "SELECT api_key FROM users WHERE username='${CARLOS_USER//\'/\'\'}'" 2>/dev/null || true)

# AI call function
call_ai() {
  if [ -z "$API_KEY" ]; then
    return 1
  fi

  local json_prompt
  json_prompt=$(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8')))" <<< "$PROMPT")

  local tmp_response
  tmp_response=$(mktemp /tmp/weekly-ai-response.XXXXXX)

  local http_code
  http_code=$(curl -s -o "$tmp_response" -w "%{http_code}" \
    --max-time 120 \
    -X POST "http://localhost:${CARLOS_PORT}/api/chat" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${API_KEY}" \
    -d "{\"message\": ${json_prompt}}" 2>/dev/null) || { rm -f "$tmp_response"; return 1; }

  if [ "$http_code" != "200" ]; then
    rm -f "$tmp_response"
    return 1
  fi

  # Parse SSE response: look for done event with full reply
  local reply=""
  while IFS= read -r line; do
    # Strip "data: " prefix
    case "$line" in
      data:\ *)
        local data="${line#data: }"
        local parsed
        parsed=$(node -e "const d=JSON.parse(process.argv[1]); if(d.reply) process.stdout.write(d.reply)" "$data" 2>/dev/null) || true
        if [ -n "$parsed" ]; then
          reply="$parsed"
        fi
        ;;
    esac
  done < "$tmp_response"

  rm -f "$tmp_response"

  # Require meaningful response (>20 chars)
  if [ ${#reply} -gt 20 ]; then
    echo "$reply"
    return 0
  fi

  return 1
}

# Main flow
AI_RESPONSE=$(call_ai) || AI_RESPONSE=""

if [ -n "$AI_RESPONSE" ]; then
  send_telegram "$AI_RESPONSE"
  echo "Weekly report sent (AI)"
else
  # Fallback: stats-only
  FALLBACK_MSG="📊 *Weekly Fitness Report*
$(echo "$WEEKLY_DATA" | head -25)"
  send_telegram "$FALLBACK_MSG"
  echo "Weekly report sent (fallback)"
fi
