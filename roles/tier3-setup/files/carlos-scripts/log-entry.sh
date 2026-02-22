#!/bin/bash
# Atomic logger for Carlos daily data — writes to SQLite + managed markdown files.
# INSERT operations can never delete other rows. Markdown meta-files use safe append/update.
#
# Usage:
#   log-entry.sh meal <time> <meal> <calories> <protein> <carbs> <fat> [notes]
#   log-entry.sh hydration [time]
#   log-entry.sh exercise <time> <activity> <duration> <calories_burned> [notes]
#   log-entry.sh sleep <duration_minutes> [notes] [source]
#   log-entry.sh streak <type>                        — update streak (meal|exercise|hydration)
#   log-entry.sh weight <weight_lbs> [notes]          — append to WEIGHT.md
#   log-entry.sh goals show                           — display current goals
#   log-entry.sh goals set <goal> <target> <unit>     — update a goal
#   log-entry.sh preference <key> <value>             — set or update a user preference
#   log-entry.sh preference-get <key>                 — get a user preference value
#   log-entry.sh undo                                 — delete the most recently inserted row across all tables

set -euo pipefail

CARLOS_USER="${CARLOS_USER:-john}"
CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
DB="${CARLOS_DATA_DIR}/${CARLOS_USER}/carlos.db"

# Check both possible memory locations (container mount vs local)
if [ -d "/opt/openclaw/workspace-carlos/memory" ]; then
  CARLOS_MEMORY_BASE="/opt/openclaw/workspace-carlos/memory"
else
  CARLOS_MEMORY_BASE="${CARLOS_MEMORY_BASE:-$HOME/.openclaw/workspace-carlos/memory}"
fi
MEMORY_DIR="${CARLOS_MEMORY_BASE}/${CARLOS_USER}"
TODAY=$(date +%Y-%m-%d)

# Use bundled sqlite3 if available (for Docker container), else system sqlite3
SQLITE="$HOME/carlos-dashboard/sqlite3"
[ -x "$SQLITE" ] || SQLITE="sqlite3"

if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB — run init-db.sh first"
  exit 1
fi

# Milestone detection — outputs MILESTONE: line if threshold reached
check_milestone() {
  local TYPE="$1"    # e.g., "meal", "exercise", "streak_meal", "streak_exercise", "streak_hydration"
  local COUNT="$2"   # current count
  local LABEL="$3"   # human-readable label, e.g., "meals logged", "workouts completed"

  # Bail out if COUNT is not a valid integer
  [[ "$COUNT" =~ ^[0-9]+$ ]] || return 0

  # Define thresholds per type
  local THRESHOLDS
  case "$TYPE" in
    meal)          THRESHOLDS="10 25 50 100 250 500 1000" ;;
    exercise)      THRESHOLDS="10 25 50 100 250 500" ;;
    streak_*)      THRESHOLDS="3 7 10 14 21 30 50 100" ;;
    *)             return ;;
  esac

  local T
  for T in $THRESHOLDS; do
    if [ "$COUNT" -eq "$T" ]; then
      echo "MILESTONE: $COUNT $LABEL!"
      return
    fi
  done
}

ACTION="${1:-}"
shift || true

case "$ACTION" in
  meal)
    TIME="${1:-$(date +"%I:%M %p")}"
    MEAL="${2:?meal name required}"
    CAL="${3:?calories required}"
    PROTEIN="${4:?protein required}"
    CARBS="${5:?carbs required}"
    FAT="${6:?fat required}"
    NOTES="${7:-}"

    # Validate numeric fields
    if ! echo "$CAL" | grep -qE '^[0-9]+$'; then
      echo "ERROR: Calories must be a positive integer."
      exit 1
    fi

    # Escape single quotes for SQL
    MEAL="${MEAL//\'/\'\'}"
    PROTEIN="${PROTEIN//\'/\'\'}"
    CARBS="${CARBS//\'/\'\'}"
    FAT="${FAT//\'/\'\'}"
    NOTES="${NOTES//\'/\'\'}"
    TIME="${TIME//\'/\'\'}"

    "$SQLITE" "$DB" "INSERT INTO meals (date, time, meal, calories, protein, carbs, fat, notes) VALUES ('$TODAY', '$TIME', '$MEAL', $CAL, '$PROTEIN', '$CARBS', '$FAT', '$NOTES');"

    # Calculate daily totals from DB
    TOTALS=$("$SQLITE" "$DB" "SELECT COALESCE(SUM(calories),0), COALESCE(SUM(CAST(REPLACE(protein,'g','') AS INTEGER)),0), COALESCE(SUM(CAST(REPLACE(carbs,'g','') AS INTEGER)),0), COALESCE(SUM(CAST(REPLACE(fat,'g','') AS INTEGER)),0) FROM meals WHERE date='$TODAY';" | tr '|' ' ')
    read -r TOTAL_CAL TOTAL_P TOTAL_C TOTAL_F <<< "$TOTALS"

    # Count meals today
    MEAL_COUNT=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM meals WHERE date='$TODAY';")
    # Check meal count milestone
    TOTAL_MEALS=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM meals;")
    check_milestone "meal" "$TOTAL_MEALS" "meals logged"
    # Hydration count
    WATER=$("$SQLITE" "$DB" "SELECT COALESCE(MAX(glass_num),0) FROM hydration WHERE date='$TODAY';")
    # Exercise count
    EX_COUNT=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM exercise WHERE date='$TODAY';")

    echo "Logged meal: $MEAL ($CAL cal, $PROTEIN protein) at $TIME"
    echo "Daily totals: ${TOTAL_CAL} cal | ${TOTAL_P}g protein | ${TOTAL_C}g carbs | ${TOTAL_F}g fat"
    echo "Today: ${MEAL_COUNT} meals | ${WATER} glasses water | ${EX_COUNT} exercises"

    # Auto-update meal streak via SQLite
    YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
    STREAK_ROW=$("$SQLITE" "$DB" "SELECT current, best, last_active FROM streaks WHERE metric='meal_logging';")
    if [ -z "$STREAK_ROW" ]; then
      "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('meal_logging', 1, 1, '$TODAY');"
      check_milestone "streak_meal" "1" "day Meal Logging streak"
      echo "Streak: 1 day"
    else
      CURRENT=$(echo "$STREAK_ROW" | cut -d'|' -f1)
      BEST=$(echo "$STREAK_ROW" | cut -d'|' -f2)
      LAST_ACTIVE=$(echo "$STREAK_ROW" | cut -d'|' -f3)
      if [ "$LAST_ACTIVE" = "$TODAY" ]; then
        echo "Streak: ${CURRENT} days"
      elif [ "$LAST_ACTIVE" = "$YESTERDAY" ]; then
        NEW=$((CURRENT + 1)); NB=$BEST; [ "$NEW" -gt "$BEST" ] && NB=$NEW
        "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('meal_logging', $NEW, $NB, '$TODAY') ON CONFLICT(metric) DO UPDATE SET current=$NEW, best=$NB, last_active='$TODAY';"
        check_milestone "streak_meal" "$NEW" "day Meal Logging streak"
        echo "Streak: ${NEW} days (best: $NB)"
      else
        NB=$BEST; [ 1 -gt "$BEST" ] && NB=1
        "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('meal_logging', 1, $NB, '$TODAY') ON CONFLICT(metric) DO UPDATE SET current=1, best=$NB, last_active='$TODAY';"
        echo "Streak: 1 day (reset)"
      fi
    fi

    # Show calorie budget from user_preferences
    CAL_GOAL_RAW=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='daily_calorie_goal';")
    if [ -n "$CAL_GOAL_RAW" ]; then
      # Strip any unit suffix (e.g. "2000 cal" → "2000")
      CAL_GOAL=$(echo "$CAL_GOAL_RAW" | awk '{print $1}')
      REMAINING=$((CAL_GOAL - TOTAL_CAL))
      echo "Calorie budget: ${REMAINING} cal remaining (goal: ${CAL_GOAL})"
    fi
    ;;

  hydration)
    TIME="${1:-$(date +"%I:%M %p")}"
    TIME="${TIME//\'/\'\'}"

    # Get next glass number
    GLASS_COUNT=$("$SQLITE" "$DB" "SELECT COALESCE(MAX(glass_num), 0) FROM hydration WHERE date='$TODAY';")
    NEXT_GLASS=$((GLASS_COUNT + 1))

    "$SQLITE" "$DB" "INSERT INTO hydration (date, time, glass_num) VALUES ('$TODAY', '$TIME', $NEXT_GLASS);"

    echo "Logged glass #$NEXT_GLASS at $TIME"
    ;;

  exercise)
    TIME="${1:-$(date +"%I:%M %p")}"
    ACTIVITY="${2:?activity required}"
    DURATION="${3:?duration required}"
    BURNED="${4:-0}"
    NOTES="${5:-}"

    # Validate numeric field
    if ! echo "$BURNED" | grep -qE '^[0-9]+$'; then
      echo "ERROR: Calories burned must be a non-negative integer."
      exit 1
    fi

    ACTIVITY="${ACTIVITY//\'/\'\'}"
    DURATION="${DURATION//\'/\'\'}"
    NOTES="${NOTES//\'/\'\'}"
    TIME="${TIME//\'/\'\'}"

    "$SQLITE" "$DB" "INSERT INTO exercise (date, time, activity, duration, calories_burned, notes) VALUES ('$TODAY', '$TIME', '$ACTIVITY', '$DURATION', $BURNED, '$NOTES');"

    echo "Logged exercise: $ACTIVITY ($DURATION, $BURNED cal burned) at $TIME"
    # Check workout count milestone
    TOTAL_EXERCISES=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM exercise;")
    check_milestone "exercise" "$TOTAL_EXERCISES" "workouts completed"
    ;;

  sleep)
    DURATION_MIN="${1:?duration in minutes required}"
    NOTES="${2:-}"
    SOURCE="${3:-manual}"

    if ! echo "$DURATION_MIN" | grep -qE '^[0-9]+$' || [ "$DURATION_MIN" -le 0 ]; then
      echo "ERROR: Duration must be a positive integer (minutes)."
      exit 1
    fi

    NOTES_SQL="${NOTES//\'/\'\'}"
    SOURCE_SQL="${SOURCE//\'/\'\'}"

    "$SQLITE" "$DB" "INSERT INTO sleep (date, duration_minutes, notes, source) VALUES ('$TODAY', $DURATION_MIN, '$NOTES_SQL', '$SOURCE_SQL')
      ON CONFLICT(date) DO UPDATE SET duration_minutes=$DURATION_MIN, notes='$NOTES_SQL', source='$SOURCE_SQL';"

    HOURS=$((DURATION_MIN / 60))
    MINS=$((DURATION_MIN % 60))
    echo "Logged sleep: ${HOURS}h ${MINS}m on $TODAY"
    ;;

  streak)
    TYPE="${1:?streak type required (meal|exercise|hydration)}"
    STREAKS_FILE="$MEMORY_DIR/STREAKS.md"

    # Map type to metric key and display label
    case "$TYPE" in
      meal)      METRIC="meal_logging"; LABEL="Meal Logging" ;;
      exercise)  METRIC="exercise";     LABEL="Exercise" ;;
      hydration) METRIC="hydration";    LABEL="Hydration" ;;
      *) echo "Unknown streak type: $TYPE (use meal|exercise|hydration)"; exit 1 ;;
    esac

    # One-time migration: if STREAKS.md exists and this metric is not yet in SQLite, import it
    METRIC_COUNT=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM streaks WHERE metric='$METRIC';")
    if [ -f "$STREAKS_FILE" ] && [ "$METRIC_COUNT" -eq 0 ]; then
      while IFS= read -r line; do
        case "$line" in
          *"| Meal Logging |"*)
            MC=$(echo "$line" | awk -F'|' '{print $3}' | tr -d ' ')
            MB=$(echo "$line" | awk -F'|' '{print $4}' | tr -d ' ')
            [[ "$MC" =~ ^[0-9]+$ ]] || MC=0
            [[ "$MB" =~ ^[0-9]+$ ]] || MB=0
            MLA=$(echo "$line" | awk -F'|' '{print $5}' | tr -d ' ')
            MLA_SQL="${MLA//\'/\'\'}"
            "$SQLITE" "$DB" "INSERT OR IGNORE INTO streaks (metric, current, best, last_active) VALUES ('meal_logging', $MC, $MB, '$MLA_SQL');"
            ;;
          *"| Exercise |"*)
            EC=$(echo "$line" | awk -F'|' '{print $3}' | tr -d ' ')
            EB=$(echo "$line" | awk -F'|' '{print $4}' | tr -d ' ')
            [[ "$EC" =~ ^[0-9]+$ ]] || EC=0
            [[ "$EB" =~ ^[0-9]+$ ]] || EB=0
            ELA=$(echo "$line" | awk -F'|' '{print $5}' | tr -d ' ')
            ELA_SQL="${ELA//\'/\'\'}"
            "$SQLITE" "$DB" "INSERT OR IGNORE INTO streaks (metric, current, best, last_active) VALUES ('exercise', $EC, $EB, '$ELA_SQL');"
            ;;
          *"| Hydration |"*)
            HC=$(echo "$line" | awk -F'|' '{print $3}' | tr -d ' ')
            HB=$(echo "$line" | awk -F'|' '{print $4}' | tr -d ' ')
            [[ "$HC" =~ ^[0-9]+$ ]] || HC=0
            [[ "$HB" =~ ^[0-9]+$ ]] || HB=0
            HLA=$(echo "$line" | awk -F'|' '{print $5}' | tr -d ' ')
            HLA_SQL="${HLA//\'/\'\'}"
            "$SQLITE" "$DB" "INSERT OR IGNORE INTO streaks (metric, current, best, last_active) VALUES ('hydration', $HC, $HB, '$HLA_SQL');"
            ;;
        esac
      done < "$STREAKS_FILE"
    fi

    # Calculate yesterday's date
    YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)

    # Read current values from SQLite
    STREAK_ROW=$("$SQLITE" "$DB" "SELECT current, best, last_active FROM streaks WHERE metric='$METRIC';")
    if [ -z "$STREAK_ROW" ]; then
      CURRENT=0; BEST=0; LAST_ACTIVE="—"
    else
      CURRENT=$(echo "$STREAK_ROW" | cut -d'|' -f1)
      BEST=$(echo "$STREAK_ROW" | cut -d'|' -f2)
      LAST_ACTIVE=$(echo "$STREAK_ROW" | cut -d'|' -f3)
    fi

    # Update streak: increment if last active was yesterday, reset to 1 otherwise
    if [ "$LAST_ACTIVE" = "$TODAY" ]; then
      # Already updated today — no change
      echo "Streak $LABEL: $CURRENT days (already updated today)"
    elif [ "$LAST_ACTIVE" = "$YESTERDAY" ]; then
      NEW_CURRENT=$((CURRENT + 1))
      NEW_BEST=$BEST
      [ "$NEW_CURRENT" -gt "$BEST" ] && NEW_BEST=$NEW_CURRENT
      "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('$METRIC', $NEW_CURRENT, $NEW_BEST, '$TODAY') ON CONFLICT(metric) DO UPDATE SET current=$NEW_CURRENT, best=$NEW_BEST, last_active='$TODAY';"
      check_milestone "streak_$TYPE" "$NEW_CURRENT" "day $LABEL streak"
      echo "Streak $LABEL: $NEW_CURRENT days (best: $NEW_BEST)"
    else
      # Streak broken — reset to 1
      NEW_BEST=$BEST
      [ 1 -gt "$BEST" ] && NEW_BEST=1
      "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('$METRIC', 1, $NEW_BEST, '$TODAY') ON CONFLICT(metric) DO UPDATE SET current=1, best=$NEW_BEST, last_active='$TODAY';"
      echo "Streak $LABEL: 1 day (reset — best: $NEW_BEST)"
    fi
    ;;

  weight)
    WEIGHT="${1:?weight in lbs required}"
    NOTES="${2:-}"

    # Validate weight is a positive number (integer or decimal)
    if ! echo "$WEIGHT" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
      echo "ERROR: Weight must be a positive number."
      exit 1
    fi

    NOTES_SQL="${NOTES//\'/\'\'}"

    # Write to SQLite (primary storage) — INSERT OR REPLACE handles one-entry-per-day
    "$SQLITE" "$DB" "INSERT INTO weight (date, weight_lbs, notes) VALUES ('$TODAY', $WEIGHT, '$NOTES_SQL')
      ON CONFLICT(date) DO UPDATE SET weight_lbs=$WEIGHT, notes='$NOTES_SQL';"

    # Also update WEIGHT.md as backup/readable log
    WEIGHT_FILE="$MEMORY_DIR/WEIGHT.md"
    if [ ! -f "$WEIGHT_FILE" ]; then
      cat > "$WEIGHT_FILE" << 'EOF'
# Weight Log

| Date | Weight | Notes |
|------|--------|-------|
EOF
    fi
    if grep -q "| $TODAY |" "$WEIGHT_FILE"; then
      sed -i "s/| $TODAY |.*|/| $TODAY | $WEIGHT lbs | ${NOTES:-Updated} |/" "$WEIGHT_FILE"
    else
      echo "| $TODAY | $WEIGHT lbs | ${NOTES:-} |" >> "$WEIGHT_FILE"
    fi

    echo "Logged weight: $WEIGHT lbs on $TODAY (saved to DB + WEIGHT.md)"
    ;;

  goals)
    SUB="${1:-show}"

    if [ "$SUB" = "show" ]; then
      GOALS_RESULT=$("$SQLITE" "$DB" "SELECT key, value FROM user_preferences WHERE key LIKE '%_goal' OR key LIKE 'primary_%' ORDER BY key;")
      if [ -z "$GOALS_RESULT" ]; then
        echo "No goals set."
      else
        echo "# Goals"
        echo ""
        echo "| Goal | Target |"
        echo "|------|--------|"
        while IFS='|' read -r KEY VAL; do
          [ -z "$KEY" ] && continue
          # Map preference keys to friendly display names
          case "$KEY" in
            daily_calorie_goal) DISPLAY="Daily Calories" ;;
            daily_protein_goal) DISPLAY="Daily Protein" ;;
            exercise_days_goal) DISPLAY="Exercise Days" ;;
            *) DISPLAY="$KEY" ;;
          esac
          echo "| $DISPLAY | $VAL |"
        done <<< "$GOALS_RESULT"
      fi
    elif [ "$SUB" = "set" ]; then
      GOAL="${2:?goal name required}"
      TARGET="${3:?target value required}"
      UNIT="${4:?unit required}"

      # Map friendly goal names to preference keys
      case "$GOAL" in
        "Daily Calories") PREF_KEY="daily_calorie_goal" ;;
        "Daily Protein")  PREF_KEY="daily_protein_goal" ;;
        "Exercise Days")  PREF_KEY="exercise_days_goal" ;;
        *)
          # Convert to snake_case and append _goal
          PREF_KEY=$(echo "$GOAL" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | sed 's/[^a-z0-9_]//g')
          PREF_KEY="${PREF_KEY}_goal"
          ;;
      esac

      # Validate key format (defense-in-depth — sed already strips non-alnum)
      if ! echo "$PREF_KEY" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
        echo "ERROR: Invalid goal key '$PREF_KEY'."
        exit 1
      fi

      # Check if preference already exists
      EXISTING=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='$PREF_KEY';")
      TARGET_SQL="${TARGET//\'/\'\'}"
      "$SQLITE" "$DB" "INSERT INTO user_preferences (key, value) VALUES ('$PREF_KEY', '$TARGET_SQL') ON CONFLICT(key) DO UPDATE SET value='$TARGET_SQL', updated_at=datetime('now');"

      if [ -n "$EXISTING" ]; then
        echo "Updated goal: $GOAL → $TARGET $UNIT"
      else
        echo "Added goal: $GOAL → $TARGET $UNIT"
      fi
    else
      echo "Usage: log-entry.sh goals {show|set <goal> <target> <unit>}"
      exit 1
    fi
    ;;

  preference)
    PREF_KEY="${1:?preference key required}"
    PREF_VAL="${2:?preference value required}"

    # Validate key: must start with a letter or underscore, alphanumeric/underscore only
    if ! echo "$PREF_KEY" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
      echo "ERROR: Invalid preference key '$PREF_KEY'. Use letters, digits, and underscores only (must start with a letter or underscore)."
      exit 1
    fi

    # Enforce max length (key-dependent)
    if [ "$PREF_KEY" = "meal_templates" ]; then
      MAX_LEN=8192
    else
      MAX_LEN=1024
    fi
    if [ ${#PREF_VAL} -gt $MAX_LEN ]; then
      echo "ERROR: Preference value too long (max $MAX_LEN chars)."
      exit 1
    fi

    PREF_VAL_SQL="${PREF_VAL//\'/\'\'}"

    "$SQLITE" "$DB" "INSERT INTO user_preferences (key, value) VALUES ('$PREF_KEY', '$PREF_VAL_SQL')
      ON CONFLICT(key) DO UPDATE SET value='$PREF_VAL_SQL', updated_at=datetime('now');"

    echo "Preference set: $PREF_KEY = $PREF_VAL"
    ;;

  preference-get)
    PREF_KEY="${1:?preference key required}"

    # Validate key
    if ! echo "$PREF_KEY" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
      echo "ERROR: Invalid preference key '$PREF_KEY'."
      exit 1
    fi

    PREF_RESULT=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='$PREF_KEY';")
    if [ -z "$PREF_RESULT" ]; then
      exit 1
    fi
    echo "$PREF_RESULT"
    ;;

  undo)
    # Find the most recently inserted row across all four tables using created_at
    # A per-table MAX(rowid) comparison is wrong because rowids are independent counters.
    LATEST_ROW=$("$SQLITE" "$DB" "
      SELECT tbl, rowid FROM (
        SELECT 'meals'     AS tbl, rowid, created_at FROM meals
        UNION ALL
        SELECT 'hydration',        rowid, created_at FROM hydration
        UNION ALL
        SELECT 'exercise',         rowid, created_at FROM exercise
        UNION ALL
        SELECT 'weight',           rowid, created_at FROM weight
        UNION ALL
        SELECT 'sleep',            rowid, created_at FROM sleep
      )
      ORDER BY created_at DESC
      LIMIT 1;
    ")

    if [ -z "$LATEST_ROW" ]; then
      echo "Nothing to undo."
      exit 0
    fi

    LATEST_TABLE=$(echo "$LATEST_ROW" | cut -d'|' -f1)
    LATEST_ROWID=$(echo "$LATEST_ROW" | cut -d'|' -f2)

    # Fetch key fields and build a description depending on the table
    case "$LATEST_TABLE" in
      meals)
        ROW=$("$SQLITE" "$DB" "SELECT date, meal, calories FROM meals WHERE rowid=$LATEST_ROWID;")
        UNDO_DATE=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_MEAL=$(echo "$ROW" | cut -d'|' -f2)
        UNDO_CAL=$(echo "$ROW" | cut -d'|' -f3)
        DESCRIPTION="\"$UNDO_MEAL\" ($UNDO_CAL cal) from meals on $UNDO_DATE"
        ;;
      hydration)
        ROW=$("$SQLITE" "$DB" "SELECT date, time, glass_num FROM hydration WHERE rowid=$LATEST_ROWID;")
        UNDO_DATE=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_TIME=$(echo "$ROW" | cut -d'|' -f2)
        UNDO_GLASS=$(echo "$ROW" | cut -d'|' -f3)
        DESCRIPTION="Glass #$UNDO_GLASS hydration ($UNDO_TIME) from $UNDO_DATE"
        ;;
      exercise)
        ROW=$("$SQLITE" "$DB" "SELECT date, activity, duration FROM exercise WHERE rowid=$LATEST_ROWID;")
        UNDO_DATE=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_ACTIVITY=$(echo "$ROW" | cut -d'|' -f2)
        UNDO_DURATION=$(echo "$ROW" | cut -d'|' -f3)
        DESCRIPTION="\"$UNDO_ACTIVITY\" ($UNDO_DURATION) from exercise on $UNDO_DATE"
        ;;
      weight)
        ROW=$("$SQLITE" "$DB" "SELECT date, weight_lbs FROM weight WHERE rowid=$LATEST_ROWID;")
        UNDO_DATE=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_LBS=$(echo "$ROW" | cut -d'|' -f2)
        DESCRIPTION="weight entry $UNDO_LBS lbs from $UNDO_DATE"
        ;;
      sleep)
        ROW=$("$SQLITE" "$DB" "SELECT date, duration_minutes FROM sleep WHERE rowid=$LATEST_ROWID;")
        UNDO_DATE=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_MIN=$(echo "$ROW" | cut -d'|' -f2)
        UNDO_H=$((UNDO_MIN / 60)); UNDO_M=$((UNDO_MIN % 60))
        DESCRIPTION="sleep ${UNDO_H}h ${UNDO_M}m on $UNDO_DATE"
        ;;
    esac

    "$SQLITE" "$DB" "DELETE FROM $LATEST_TABLE WHERE rowid=$LATEST_ROWID;"
    echo "Undone: Removed $DESCRIPTION"
    ;;

  delete)
    TABLE="${1:?table required (meals|hydration|exercise|weight|sleep)}"
    # Validate table name to prevent injection
    case "$TABLE" in
      meals|hydration|exercise|weight|sleep) ;;
      *) echo "ERROR: Invalid table '$TABLE'. Use: meals, hydration, exercise, weight, sleep"; exit 1 ;;
    esac

    shift
    # Build WHERE clause from remaining args
    if [ $# -eq 0 ]; then
      echo "ERROR: At least one filter required. Examples:"
      echo "  log-entry.sh delete meals date 2026-02-17"
      echo "  log-entry.sh delete meals date 2026-02-17 meal 'Scrambled eggs'"
      exit 1
    fi

    WHERE=""
    while [ $# -ge 2 ]; do
      COL="$1"; VAL="$2"; shift 2
      # Validate column name against allowlist to prevent injection
      case "$COL" in
        date|time|meal|activity|duration|calories|calories_burned|notes|glass_num|weight_lbs|duration_minutes|source) ;;
        *) echo "ERROR: Invalid column name '$COL'"; exit 1 ;;
      esac
      # Escape single quotes
      VAL="${VAL//\'/\'\'}"
      [ -n "$WHERE" ] && WHERE="$WHERE AND "
      WHERE="${WHERE}${COL} LIKE '%${VAL}%'"
    done

    # Show what will be deleted
    MATCHES=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM $TABLE WHERE $WHERE;")
    if [ "$MATCHES" -eq 0 ]; then
      echo "No matching rows found in $TABLE."
      exit 0
    fi

    # Show matching rows
    "$SQLITE" -header "$DB" "SELECT rowid, * FROM $TABLE WHERE $WHERE;"
    echo ""

    # Delete
    "$SQLITE" "$DB" "DELETE FROM $TABLE WHERE $WHERE;"
    echo "Deleted $MATCHES row(s) from $TABLE."
    ;;

  *)
    echo "Usage: log-entry.sh {meal|hydration|exercise|sleep|streak|weight|goals|preference|preference-get|delete|undo} [args...]"
    echo ""
    echo "  preference <key> <value>   — set or update a user preference"
    echo "  preference-get <key>       — get a user preference value (exits 1 if not found)"
    exit 1
    ;;
esac
