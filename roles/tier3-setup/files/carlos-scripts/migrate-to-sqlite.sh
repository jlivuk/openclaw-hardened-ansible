#!/bin/bash
# One-time migration: parse existing markdown daily logs into SQLite.
# Run after init-db.sh: bash migrate-to-sqlite.sh
#
# Parses meals, hydration, and exercise from YYYY-MM-DD.md files.

set -euo pipefail

DB="$HOME/carlos-dashboard/carlos.db"
MEMORY_DIR="$HOME/.openclaw/workspace-carlos/memory"

if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB — run init-db.sh first"
  exit 1
fi

MEAL_COUNT=0
HYDRATION_COUNT=0
EXERCISE_COUNT=0
FILES_PROCESSED=0

for file in "$MEMORY_DIR"/????-??-??.md; do
  [ -f "$file" ] || continue
  date=$(basename "$file" .md)
  FILES_PROCESSED=$((FILES_PROCESSED + 1))

  section=""
  while IFS= read -r line; do
    # Detect section headers
    case "$line" in
      "## Meals"*) section="meals"; continue ;;
      "## Exercise"*) section="exercise"; continue ;;
      "## Hydration"*) section="hydration"; continue ;;
      "## "*) section=""; continue ;;
    esac

    # Skip non-table rows and header/separator rows
    [[ "$line" == \|* ]] || continue
    echo "$line" | grep -qiE "Time|---" && continue

    case "$section" in
      meals)
        # Parse: | Time | Meal | Calories | Protein | Carbs | Fat | Notes |
        IFS='|' read -ra cols <<< "$line"
        # cols[0] is empty (before first |), data starts at cols[1]
        time=$(echo "${cols[1]:-}" | xargs)
        meal=$(echo "${cols[2]:-}" | xargs)
        cal=$(echo "${cols[3]:-0}" | tr -dc '0-9')
        protein=$(echo "${cols[4]:-}" | xargs)
        carbs=$(echo "${cols[5]:-}" | xargs)
        fat=$(echo "${cols[6]:-}" | xargs)
        notes=$(echo "${cols[7]:-}" | xargs)

        [ -z "$meal" ] && continue
        cal=${cal:-0}

        # Escape single quotes for SQL
        meal="${meal//\'/\'\'}"
        protein="${protein//\'/\'\'}"
        carbs="${carbs//\'/\'\'}"
        fat="${fat//\'/\'\'}"
        notes="${notes//\'/\'\'}"
        time="${time//\'/\'\'}"

        sqlite3 "$DB" "INSERT INTO meals (date, time, meal, calories, protein, carbs, fat, notes) VALUES ('$date', '$time', '$meal', $cal, '$protein', '$carbs', '$fat', '$notes');"
        MEAL_COUNT=$((MEAL_COUNT + 1))
        ;;

      hydration)
        # Parse: | Time | Glass # |
        IFS='|' read -ra cols <<< "$line"
        time=$(echo "${cols[1]:-}" | xargs)
        glass=$(echo "${cols[2]:-0}" | tr -dc '0-9')

        [ -z "$glass" ] || [ "$glass" = "0" ] && continue
        time="${time//\'/\'\'}"

        sqlite3 "$DB" "INSERT INTO hydration (date, time, glass_num) VALUES ('$date', '$time', $glass);"
        HYDRATION_COUNT=$((HYDRATION_COUNT + 1))
        ;;

      exercise)
        # Parse: | Time | Activity | Duration | Calories Burned | Notes |
        IFS='|' read -ra cols <<< "$line"
        time=$(echo "${cols[1]:-}" | xargs)
        activity=$(echo "${cols[2]:-}" | xargs)
        duration=$(echo "${cols[3]:-}" | xargs)
        burned=$(echo "${cols[4]:-0}" | tr -dc '0-9')
        notes=$(echo "${cols[5]:-}" | xargs)

        [ -z "$activity" ] && continue
        burned=${burned:-0}

        activity="${activity//\'/\'\'}"
        duration="${duration//\'/\'\'}"
        notes="${notes//\'/\'\'}"
        time="${time//\'/\'\'}"

        sqlite3 "$DB" "INSERT INTO exercise (date, time, activity, duration, calories_burned, notes) VALUES ('$date', '$time', '$activity', '$duration', $burned, '$notes');"
        EXERCISE_COUNT=$((EXERCISE_COUNT + 1))
        ;;
    esac
  done < "$file"
done

echo "Migration complete!"
echo "Files processed: $FILES_PROCESSED"
echo "Meals imported:     $MEAL_COUNT"
echo "Hydration imported: $HYDRATION_COUNT"
echo "Exercise imported:  $EXERCISE_COUNT"
echo ""
echo "Verify with:"
echo "  sqlite3 $DB 'SELECT COUNT(*) FROM meals;'"
echo "  sqlite3 $DB 'SELECT COUNT(*) FROM hydration;'"
echo "  sqlite3 $DB 'SELECT COUNT(*) FROM exercise;'"
