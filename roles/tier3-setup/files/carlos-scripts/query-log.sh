#!/bin/bash
# Read-only query script for Carlos daily data from SQLite.
#
# Usage:
#   query-log.sh today              — show today's meals, hydration, exercise
#   query-log.sh <YYYY-MM-DD>       — show a specific day
#   query-log.sh week               — show last 7 days summary
#   query-log.sh history [N]        — show last N days of meals (default 3)

set -euo pipefail

CARLOS_USER="${CARLOS_USER:-john}"
CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
DB="${CARLOS_DATA_DIR}/${CARLOS_USER}/carlos.db"

# Use bundled sqlite3 if available (for Docker container), else system sqlite3
SQLITE="$HOME/carlos-dashboard/sqlite3"
[ -x "$SQLITE" ] || SQLITE="sqlite3"

if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB"
  exit 1
fi

ACTION="${1:-today}"

show_day() {
  local date="$1"

  echo "=== $date ==="
  echo ""

  # Meals
  local meals
  meals=$("$SQLITE" "$DB" "SELECT time, meal, calories, protein, carbs, fat, notes FROM meals WHERE date='$date' ORDER BY id;")
  if [ -n "$meals" ]; then
    echo "## Meals"
    echo "Time | Meal | Calories | Protein | Carbs | Fat | Notes"
    echo "$meals" | while IFS='|' read -r time meal cal protein carbs fat notes; do
      echo "$time | $meal | $cal cal | $protein | $carbs | $fat | $notes"
    done
    echo ""
    # Totals
    "$SQLITE" "$DB" "SELECT 'Total: ' || COALESCE(SUM(calories),0) || ' cal, ' || COALESCE(SUM(CAST(REPLACE(protein,'g','') AS INTEGER)),0) || 'g protein, ' || COALESCE(SUM(CAST(REPLACE(carbs,'g','') AS INTEGER)),0) || 'g carbs, ' || COALESCE(SUM(CAST(REPLACE(fat,'g','') AS INTEGER)),0) || 'g fat' FROM meals WHERE date='$date';"
    echo ""
  else
    echo "## Meals: none logged"
    echo ""
  fi

  # Hydration
  local glass_count
  glass_count=$("$SQLITE" "$DB" "SELECT COALESCE(MAX(glass_num), 0) FROM hydration WHERE date='$date';")
  echo "## Hydration: $glass_count glasses"
  echo ""

  # Exercise
  local exercise
  exercise=$("$SQLITE" "$DB" "SELECT time, activity, duration, calories_burned, notes FROM exercise WHERE date='$date' ORDER BY id;")
  if [ -n "$exercise" ]; then
    echo "## Exercise"
    echo "Time | Activity | Duration | Calories Burned | Notes"
    echo "$exercise" | while IFS='|' read -r time activity duration burned notes; do
      echo "$time | $activity | $duration | $burned cal | $notes"
    done
    echo ""
  else
    echo "## Exercise: none logged"
    echo ""
  fi

  # Sleep
  local sleep_row
  sleep_row=$("$SQLITE" "$DB" "SELECT duration_minutes, source, notes FROM sleep WHERE date='$date';")
  if [ -n "$sleep_row" ]; then
    local sleep_min sleep_src sleep_notes sleep_h sleep_m
    sleep_min=$(echo "$sleep_row" | cut -d'|' -f1)
    sleep_src=$(echo "$sleep_row" | cut -d'|' -f2)
    sleep_notes=$(echo "$sleep_row" | cut -d'|' -f3)
    sleep_h=$((sleep_min / 60))
    sleep_m=$((sleep_min % 60))
    echo "## Sleep: ${sleep_h}h ${sleep_m}m ($sleep_src)"
    [ -n "$sleep_notes" ] && echo "$sleep_notes"
    echo ""
  else
    echo "## Sleep: not logged"
    echo ""
  fi
}

case "$ACTION" in
  today)
    show_day "$(date +%Y-%m-%d)"
    ;;

  week)
    for i in 6 5 4 3 2 1 0; do
      date=$(date -d "-${i} days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d)
      cal=$("$SQLITE" "$DB" "SELECT COALESCE(SUM(calories),0) FROM meals WHERE date='$date';")
      protein=$("$SQLITE" "$DB" "SELECT COALESCE(SUM(CAST(REPLACE(protein,'g','') AS INTEGER)),0) FROM meals WHERE date='$date';")
      glasses=$("$SQLITE" "$DB" "SELECT COALESCE(MAX(glass_num),0) FROM hydration WHERE date='$date';")
      ex=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM exercise WHERE date='$date';")
      sleep_min=$("$SQLITE" "$DB" "SELECT COALESCE(duration_minutes,0) FROM sleep WHERE date='$date';")
      sleep_min="${sleep_min:-0}"
      if [ "$cal" -gt 0 ] || [ "$glasses" -gt 0 ] || [ "$ex" -gt 0 ] || [ "$sleep_min" -gt 0 ]; then
        sleep_h=$((sleep_min / 60)); sleep_m=$((sleep_min % 60))
        echo "$date: ${cal} cal, ${protein}g protein, ${glasses} glasses, ${ex} exercises, sleep ${sleep_h}h ${sleep_m}m"
      else
        echo "$date: no data"
      fi
    done
    ;;

  history)
    N="${2:-3}"
    if ! echo "$N" | grep -qE '^[0-9]+$' || [ "$N" -le 0 ]; then
      echo "ERROR: History days must be a positive integer."
      exit 1
    fi
    dates=$("$SQLITE" "$DB" "SELECT DISTINCT date FROM meals ORDER BY date DESC LIMIT $N;")
    if [ -z "$dates" ]; then
      echo "No meal history found."
      exit 0
    fi
    while IFS= read -r date; do
      show_day "$date"
      echo "---"
    done <<< "$dates"
    ;;

  ????-??-??)
    show_day "$ACTION"
    ;;

  *)
    echo "Usage: query-log.sh {today|week|history [N]|YYYY-MM-DD}"
    exit 1
    ;;
esac
