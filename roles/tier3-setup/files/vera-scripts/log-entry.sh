#!/bin/bash
# Atomic logger for Vera home maintenance data — writes to SQLite.
# INSERT operations can never delete other rows.
#
# Usage:
#   log-entry.sh appliance <name> [location] [brand] [model] [serial] [purchase_date] [warranty] [notes]
#   log-entry.sh maintenance <date> <task> [appliance_name] [cost] [contractor] [notes]
#   log-entry.sh schedule <task> [appliance_name] <interval_days> <next_due> [notes]
#   log-entry.sh complete <schedule_id> [date] [cost] [contractor] [notes]
#   log-entry.sh preference <key> <value>
#   log-entry.sh preference-get <key>
#   log-entry.sh streak <type>
#   log-entry.sh undo
#   log-entry.sh delete <table> <col> <value> [col value ...]

set -euo pipefail

VERA_USER="${VERA_USER:-john}"
VERA_DATA_DIR="${VERA_DATA_DIR:-$HOME/vera-dashboard}"
DB="${VERA_DATA_DIR}/${VERA_USER}/vera.db"

TODAY=$(date +%Y-%m-%d)

# Use bundled sqlite3 if available (for Docker container), else system sqlite3
SQLITE="$HOME/vera-dashboard/sqlite3"
[ -x "$SQLITE" ] || SQLITE="sqlite3"

if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB — run init-db.sh first"
  exit 1
fi

# Resolve appliance name to ID (returns empty string if not found)
resolve_appliance_id() {
  local name="$1"
  if [ -z "$name" ]; then
    echo ""
    return
  fi
  local name_sql="${name//\'/\'\'}"
  "$SQLITE" "$DB" "SELECT id FROM appliances WHERE name='$name_sql';"
}

ACTION="${1:-}"
shift || true

case "$ACTION" in
  appliance)
    NAME="${1:?appliance name required}"
    LOCATION="${2:-}"
    BRAND="${3:-}"
    MODEL="${4:-}"
    SERIAL="${5:-}"
    PURCHASE_DATE="${6:-}"
    WARRANTY="${7:-}"
    NOTES="${8:-}"

    # Escape single quotes for SQL
    NAME_SQL="${NAME//\'/\'\'}"
    LOCATION_SQL="${LOCATION//\'/\'\'}"
    BRAND_SQL="${BRAND//\'/\'\'}"
    MODEL_SQL="${MODEL//\'/\'\'}"
    SERIAL_SQL="${SERIAL//\'/\'\'}"
    PURCHASE_DATE_SQL="${PURCHASE_DATE//\'/\'\'}"
    WARRANTY_SQL="${WARRANTY//\'/\'\'}"
    NOTES_SQL="${NOTES//\'/\'\'}"

    # UPSERT on name
    "$SQLITE" "$DB" "INSERT INTO appliances (name, location, brand, model, serial_number, purchase_date, warranty_expires, notes)
      VALUES ('$NAME_SQL', '$LOCATION_SQL', '$BRAND_SQL', '$MODEL_SQL', '$SERIAL_SQL', '$PURCHASE_DATE_SQL', '$WARRANTY_SQL', '$NOTES_SQL')
      ON CONFLICT(name) DO UPDATE SET
        location='$LOCATION_SQL',
        brand='$BRAND_SQL',
        model='$MODEL_SQL',
        serial_number='$SERIAL_SQL',
        purchase_date='$PURCHASE_DATE_SQL',
        warranty_expires='$WARRANTY_SQL',
        notes='$NOTES_SQL',
        updated_at=datetime('now');"

    # Check if this was an insert or update
    APPLIANCE_ID=$("$SQLITE" "$DB" "SELECT id FROM appliances WHERE name='$NAME_SQL';")
    TOTAL_APPLIANCES=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM appliances;")

    echo "Appliance saved: $NAME (ID: $APPLIANCE_ID)"
    [ -n "$LOCATION" ] && echo "  Location: $LOCATION"
    [ -n "$BRAND" ] && echo "  Brand: $BRAND"
    [ -n "$MODEL" ] && echo "  Model: $MODEL"
    [ -n "$WARRANTY" ] && echo "  Warranty expires: $WARRANTY"
    echo "Total appliances: $TOTAL_APPLIANCES"
    ;;

  maintenance)
    DATE="${1:?date required (YYYY-MM-DD)}"
    TASK="${2:?task description required}"
    APPLIANCE_NAME="${3:-}"
    COST="${4:-0}"
    CONTRACTOR="${5:-}"
    NOTES="${6:-}"

    # Validate date format
    if ! echo "$DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      echo "ERROR: Date must be in YYYY-MM-DD format."
      exit 1
    fi

    # Validate cost is a number
    if ! echo "$COST" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
      echo "ERROR: Cost must be a non-negative number."
      exit 1
    fi

    # Resolve appliance ID if name provided
    APPLIANCE_ID=""
    if [ -n "$APPLIANCE_NAME" ]; then
      APPLIANCE_ID=$(resolve_appliance_id "$APPLIANCE_NAME")
      if [ -z "$APPLIANCE_ID" ]; then
        echo "WARNING: Appliance '$APPLIANCE_NAME' not found — logging without appliance link."
      fi
    fi

    TASK_SQL="${TASK//\'/\'\'}"
    CONTRACTOR_SQL="${CONTRACTOR//\'/\'\'}"
    NOTES_SQL="${NOTES//\'/\'\'}"

    if [ -n "$APPLIANCE_ID" ]; then
      "$SQLITE" "$DB" "INSERT INTO maintenance_log (date, task, appliance_id, cost, contractor, notes) VALUES ('$DATE', '$TASK_SQL', $APPLIANCE_ID, $COST, '$CONTRACTOR_SQL', '$NOTES_SQL');"
    else
      "$SQLITE" "$DB" "INSERT INTO maintenance_log (date, task, appliance_id, cost, contractor, notes) VALUES ('$DATE', '$TASK_SQL', NULL, $COST, '$CONTRACTOR_SQL', '$NOTES_SQL');"
    fi

    echo "Logged maintenance: $TASK on $DATE"
    [ -n "$APPLIANCE_NAME" ] && [ -n "$APPLIANCE_ID" ] && echo "  Appliance: $APPLIANCE_NAME"
    [ "$COST" != "0" ] && echo "  Cost: \$$COST"
    [ -n "$CONTRACTOR" ] && echo "  Contractor: $CONTRACTOR"

    # Show month cost total
    MONTH_START=$(echo "$DATE" | sed 's/-[0-9]*$/-01/')
    MONTH_COST=$("$SQLITE" "$DB" "SELECT COALESCE(SUM(cost), 0) FROM maintenance_log WHERE date >= '$MONTH_START' AND date < date('$MONTH_START', '+1 month');")
    echo "Month maintenance cost: \$$MONTH_COST"
    ;;

  schedule)
    TASK="${1:?task description required}"
    APPLIANCE_NAME="${2:-}"
    INTERVAL_DAYS="${3:?interval in days required}"
    NEXT_DUE="${4:?next due date required (YYYY-MM-DD)}"
    NOTES="${5:-}"

    # Validate interval is a positive integer
    if ! echo "$INTERVAL_DAYS" | grep -qE '^[0-9]+$' || [ "$INTERVAL_DAYS" -le 0 ]; then
      echo "ERROR: Interval must be a positive integer (days)."
      exit 1
    fi

    # Validate next_due date format
    if ! echo "$NEXT_DUE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      echo "ERROR: Next due date must be in YYYY-MM-DD format."
      exit 1
    fi

    # Resolve appliance ID if name provided
    APPLIANCE_ID=""
    if [ -n "$APPLIANCE_NAME" ]; then
      APPLIANCE_ID=$(resolve_appliance_id "$APPLIANCE_NAME")
      if [ -z "$APPLIANCE_ID" ]; then
        echo "WARNING: Appliance '$APPLIANCE_NAME' not found — scheduling without appliance link."
      fi
    fi

    TASK_SQL="${TASK//\'/\'\'}"
    NOTES_SQL="${NOTES//\'/\'\'}"

    if [ -n "$APPLIANCE_ID" ]; then
      "$SQLITE" "$DB" "INSERT INTO maintenance_schedule (task, appliance_id, interval_days, next_due, notes) VALUES ('$TASK_SQL', $APPLIANCE_ID, $INTERVAL_DAYS, '$NEXT_DUE', '$NOTES_SQL');"
    else
      "$SQLITE" "$DB" "INSERT INTO maintenance_schedule (task, appliance_id, interval_days, next_due, notes) VALUES ('$TASK_SQL', NULL, $INTERVAL_DAYS, '$NEXT_DUE', '$NOTES_SQL');"
    fi

    SCHEDULE_ID=$("$SQLITE" "$DB" "SELECT last_insert_rowid();")
    echo "Scheduled: $TASK every $INTERVAL_DAYS days (next due: $NEXT_DUE, ID: $SCHEDULE_ID)"
    [ -n "$APPLIANCE_NAME" ] && [ -n "$APPLIANCE_ID" ] && echo "  Appliance: $APPLIANCE_NAME"
    ;;

  complete)
    SCHEDULE_ID="${1:?schedule ID required}"
    DATE="${2:-$TODAY}"
    COST="${3:-0}"
    CONTRACTOR="${4:-}"
    NOTES="${5:-}"

    # Validate schedule ID is a positive integer
    if ! echo "$SCHEDULE_ID" | grep -qE '^[0-9]+$'; then
      echo "ERROR: Schedule ID must be a positive integer."
      exit 1
    fi

    # Validate cost
    if ! echo "$COST" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
      echo "ERROR: Cost must be a non-negative number."
      exit 1
    fi

    # Fetch schedule details
    SCHEDULE_ROW=$("$SQLITE" "$DB" "SELECT task, appliance_id, interval_days FROM maintenance_schedule WHERE id=$SCHEDULE_ID;")
    if [ -z "$SCHEDULE_ROW" ]; then
      echo "ERROR: Schedule ID $SCHEDULE_ID not found."
      exit 1
    fi

    TASK=$(echo "$SCHEDULE_ROW" | cut -d'|' -f1)
    APPLIANCE_ID=$(echo "$SCHEDULE_ROW" | cut -d'|' -f2)
    INTERVAL_DAYS=$(echo "$SCHEDULE_ROW" | cut -d'|' -f3)

    CONTRACTOR_SQL="${CONTRACTOR//\'/\'\'}"
    NOTES_SQL="${NOTES//\'/\'\'}"

    # Calculate next due date
    NEXT_DUE=$(date -d "$DATE + $INTERVAL_DAYS days" +%Y-%m-%d 2>/dev/null || date -v+"${INTERVAL_DAYS}d" -j -f "%Y-%m-%d" "$DATE" +%Y-%m-%d)

    # Log the maintenance entry
    if [ -n "$APPLIANCE_ID" ]; then
      "$SQLITE" "$DB" "INSERT INTO maintenance_log (date, task, appliance_id, cost, contractor, notes) VALUES ('$DATE', '${TASK//\'/\'\'}', $APPLIANCE_ID, $COST, '$CONTRACTOR_SQL', '$NOTES_SQL');"
    else
      "$SQLITE" "$DB" "INSERT INTO maintenance_log (date, task, appliance_id, cost, contractor, notes) VALUES ('$DATE', '${TASK//\'/\'\'}', NULL, $COST, '$CONTRACTOR_SQL', '$NOTES_SQL');"
    fi

    # Update the schedule: set last_completed and advance next_due
    "$SQLITE" "$DB" "UPDATE maintenance_schedule SET last_completed='$DATE', next_due='$NEXT_DUE' WHERE id=$SCHEDULE_ID;"

    echo "Completed: $TASK on $DATE"
    [ "$COST" != "0" ] && echo "  Cost: \$$COST"
    [ -n "$CONTRACTOR" ] && echo "  Contractor: $CONTRACTOR"
    echo "  Next due: $NEXT_DUE"
    ;;

  preference)
    PREF_KEY="${1:?preference key required}"
    PREF_VAL="${2:?preference value required}"

    # Validate key: must start with a letter or underscore, alphanumeric/underscore only
    if ! echo "$PREF_KEY" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
      echo "ERROR: Invalid preference key '$PREF_KEY'. Use letters, digits, and underscores only (must start with a letter or underscore)."
      exit 1
    fi

    # Enforce max length
    MAX_LEN=1024
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

  streak)
    TYPE="${1:?streak type required (maintenance)}"

    case "$TYPE" in
      maintenance) METRIC="maintenance"; LABEL="Maintenance" ;;
      *) echo "Unknown streak type: $TYPE (use maintenance)"; exit 1 ;;
    esac

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
      echo "Streak $LABEL: $CURRENT days (already updated today)"
    elif [ "$LAST_ACTIVE" = "$YESTERDAY" ]; then
      NEW_CURRENT=$((CURRENT + 1))
      NEW_BEST=$BEST
      [ "$NEW_CURRENT" -gt "$BEST" ] && NEW_BEST=$NEW_CURRENT
      "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('$METRIC', $NEW_CURRENT, $NEW_BEST, '$TODAY') ON CONFLICT(metric) DO UPDATE SET current=$NEW_CURRENT, best=$NEW_BEST, last_active='$TODAY';"
      echo "Streak $LABEL: $NEW_CURRENT days (best: $NEW_BEST)"
    else
      # Streak broken — reset to 1
      NEW_BEST=$BEST
      [ 1 -gt "$BEST" ] && NEW_BEST=1
      "$SQLITE" "$DB" "INSERT INTO streaks (metric, current, best, last_active) VALUES ('$METRIC', 1, $NEW_BEST, '$TODAY') ON CONFLICT(metric) DO UPDATE SET current=1, best=$NEW_BEST, last_active='$TODAY';"
      echo "Streak $LABEL: 1 day (reset — best: $NEW_BEST)"
    fi
    ;;

  undo)
    # Find the most recently inserted row across domain tables using created_at
    LATEST_ROW=$("$SQLITE" "$DB" "
      SELECT tbl, rowid FROM (
        SELECT 'appliances'         AS tbl, rowid, created_at FROM appliances
        UNION ALL
        SELECT 'maintenance_log',          rowid, created_at FROM maintenance_log
        UNION ALL
        SELECT 'maintenance_schedule',     rowid, created_at FROM maintenance_schedule
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

    # Fetch key fields and build a description
    case "$LATEST_TABLE" in
      appliances)
        ROW=$("$SQLITE" "$DB" "SELECT name, location FROM appliances WHERE rowid=$LATEST_ROWID;")
        UNDO_NAME=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_LOC=$(echo "$ROW" | cut -d'|' -f2)
        DESCRIPTION="appliance \"$UNDO_NAME\" ($UNDO_LOC)"
        ;;
      maintenance_log)
        ROW=$("$SQLITE" "$DB" "SELECT date, task, cost FROM maintenance_log WHERE rowid=$LATEST_ROWID;")
        UNDO_DATE=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_TASK=$(echo "$ROW" | cut -d'|' -f2)
        UNDO_COST=$(echo "$ROW" | cut -d'|' -f3)
        DESCRIPTION="maintenance \"$UNDO_TASK\" (\$$UNDO_COST) on $UNDO_DATE"
        ;;
      maintenance_schedule)
        ROW=$("$SQLITE" "$DB" "SELECT task, interval_days, next_due FROM maintenance_schedule WHERE rowid=$LATEST_ROWID;")
        UNDO_TASK=$(echo "$ROW" | cut -d'|' -f1)
        UNDO_INTERVAL=$(echo "$ROW" | cut -d'|' -f2)
        UNDO_DUE=$(echo "$ROW" | cut -d'|' -f3)
        DESCRIPTION="schedule \"$UNDO_TASK\" every ${UNDO_INTERVAL}d (next due: $UNDO_DUE)"
        ;;
    esac

    "$SQLITE" "$DB" "DELETE FROM $LATEST_TABLE WHERE rowid=$LATEST_ROWID;"
    echo "Undone: Removed $DESCRIPTION"
    ;;

  delete)
    TABLE="${1:?table required (appliances|maintenance_log|maintenance_schedule)}"
    # Validate table name to prevent injection
    case "$TABLE" in
      appliances|maintenance_log|maintenance_schedule|seasonal_checklists|checklist_items) ;;
      *) echo "ERROR: Invalid table '$TABLE'. Use: appliances, maintenance_log, maintenance_schedule, seasonal_checklists, checklist_items"; exit 1 ;;
    esac

    shift
    # Build WHERE clause from remaining args
    if [ $# -eq 0 ]; then
      echo "ERROR: At least one filter required. Examples:"
      echo "  log-entry.sh delete appliances name 'HVAC Unit'"
      echo "  log-entry.sh delete maintenance_log date 2026-02-17"
      exit 1
    fi

    WHERE=""
    while [ $# -ge 2 ]; do
      COL="$1"; VAL="$2"; shift 2
      # Validate column name against allowlist to prevent injection
      case "$COL" in
        id|name|location|brand|model|serial_number|purchase_date|warranty_expires|notes|date|task|appliance_id|cost|contractor|interval_days|last_completed|next_due|slug|season|is_template|template_id|year|completed_at|checklist_id|sort_order) ;;
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

  checklist-activate)
    SLUG="${1:?template slug required}"
    YEAR="${2:?year required}"

    # Validate year is a 4-digit number
    if ! echo "$YEAR" | grep -qE '^[0-9]{4}$'; then
      echo "ERROR: Year must be a 4-digit number."
      exit 1
    fi

    SLUG_SQL="${SLUG//\'/\'\'}"

    # Verify template exists
    TEMPLATE_ROW=$("$SQLITE" "$DB" "SELECT id, name FROM seasonal_checklists WHERE slug='$SLUG_SQL' AND is_template=1;")
    if [ -z "$TEMPLATE_ROW" ]; then
      echo "ERROR: Template '$SLUG' not found."
      exit 1
    fi

    TEMPLATE_ID=$(echo "$TEMPLATE_ROW" | cut -d'|' -f1)
    TEMPLATE_NAME=$(echo "$TEMPLATE_ROW" | cut -d'|' -f2)

    # Check if already activated for this year
    EXISTING=$("$SQLITE" "$DB" "SELECT id FROM seasonal_checklists WHERE template_id=$TEMPLATE_ID AND year=$YEAR AND is_template=0;")
    if [ -n "$EXISTING" ]; then
      echo "Already activated: $TEMPLATE_NAME for $YEAR (ID: $EXISTING)"
      exit 0
    fi

    # Create user instance (combine INSERT + SELECT in one process so last_insert_rowid works)
    CHECKLIST_ID=$("$SQLITE" "$DB" "INSERT INTO seasonal_checklists (name, season, is_template, template_id, year) SELECT name, season, 0, id, $YEAR FROM seasonal_checklists WHERE id=$TEMPLATE_ID; SELECT last_insert_rowid();")

    # Copy items from template
    "$SQLITE" "$DB" "INSERT INTO checklist_items (checklist_id, task, sort_order) SELECT $CHECKLIST_ID, task, sort_order FROM checklist_items WHERE checklist_id=$TEMPLATE_ID ORDER BY sort_order;"

    ITEM_COUNT=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM checklist_items WHERE checklist_id=$CHECKLIST_ID;")
    echo "Activated: $TEMPLATE_NAME for $YEAR (ID: $CHECKLIST_ID, $ITEM_COUNT items)"
    ;;

  checklist-check)
    ITEM_ID="${1:?item ID required}"

    # Validate item ID
    if ! echo "$ITEM_ID" | grep -qE '^[0-9]+$'; then
      echo "ERROR: Item ID must be a positive integer."
      exit 1
    fi

    # Verify item exists and belongs to a user checklist (not a template)
    ITEM_ROW=$("$SQLITE" "$DB" "SELECT ci.task, sc.id, sc.name, sc.is_template FROM checklist_items ci JOIN seasonal_checklists sc ON ci.checklist_id=sc.id WHERE ci.id=$ITEM_ID;")
    if [ -z "$ITEM_ROW" ]; then
      echo "ERROR: Item $ITEM_ID not found."
      exit 1
    fi

    IS_TEMPLATE=$(echo "$ITEM_ROW" | cut -d'|' -f4)
    if [ "$IS_TEMPLATE" = "1" ]; then
      echo "ERROR: Cannot check items on a template. Activate it first."
      exit 1
    fi

    ITEM_TASK=$(echo "$ITEM_ROW" | cut -d'|' -f1)
    CHECKLIST_ID=$(echo "$ITEM_ROW" | cut -d'|' -f2)
    CHECKLIST_NAME=$(echo "$ITEM_ROW" | cut -d'|' -f3)

    "$SQLITE" "$DB" "UPDATE checklist_items SET completed_at=datetime('now') WHERE id=$ITEM_ID;"
    echo "Checked: $ITEM_TASK"

    # Auto-complete checklist if all items are done
    REMAINING=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM checklist_items WHERE checklist_id=$CHECKLIST_ID AND completed_at IS NULL;")
    if [ "$REMAINING" -eq 0 ]; then
      "$SQLITE" "$DB" "UPDATE seasonal_checklists SET completed_at=datetime('now') WHERE id=$CHECKLIST_ID;"
      echo "Checklist complete: $CHECKLIST_NAME"
    else
      TOTAL=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM checklist_items WHERE checklist_id=$CHECKLIST_ID;")
      DONE=$((TOTAL - REMAINING))
      echo "Progress: $DONE/$TOTAL"
    fi
    ;;

  checklist-uncheck)
    ITEM_ID="${1:?item ID required}"

    # Validate item ID
    if ! echo "$ITEM_ID" | grep -qE '^[0-9]+$'; then
      echo "ERROR: Item ID must be a positive integer."
      exit 1
    fi

    # Verify item exists and belongs to a user checklist
    ITEM_ROW=$("$SQLITE" "$DB" "SELECT ci.task, sc.id, sc.is_template FROM checklist_items ci JOIN seasonal_checklists sc ON ci.checklist_id=sc.id WHERE ci.id=$ITEM_ID;")
    if [ -z "$ITEM_ROW" ]; then
      echo "ERROR: Item $ITEM_ID not found."
      exit 1
    fi

    IS_TEMPLATE=$(echo "$ITEM_ROW" | cut -d'|' -f3)
    if [ "$IS_TEMPLATE" = "1" ]; then
      echo "ERROR: Cannot uncheck items on a template."
      exit 1
    fi

    ITEM_TASK=$(echo "$ITEM_ROW" | cut -d'|' -f1)
    CHECKLIST_ID=$(echo "$ITEM_ROW" | cut -d'|' -f2)

    "$SQLITE" "$DB" "UPDATE checklist_items SET completed_at=NULL WHERE id=$ITEM_ID;"

    # If checklist was completed, un-complete it
    "$SQLITE" "$DB" "UPDATE seasonal_checklists SET completed_at=NULL WHERE id=$CHECKLIST_ID AND completed_at IS NOT NULL;"

    echo "Unchecked: $ITEM_TASK"
    ;;

  *)
    echo "Usage: log-entry.sh {appliance|maintenance|schedule|complete|preference|preference-get|streak|undo|delete|checklist-activate|checklist-check|checklist-uncheck} [args...]"
    echo ""
    echo "  appliance <name> [location] [brand] [model] [serial] [purchase_date] [warranty] [notes]"
    echo "  maintenance <date> <task> [appliance_name] [cost] [contractor] [notes]"
    echo "  schedule <task> [appliance_name] <interval_days> <next_due> [notes]"
    echo "  complete <schedule_id> [date] [cost] [contractor] [notes]"
    echo "  preference <key> <value>   — set or update a user preference"
    echo "  preference-get <key>       — get a user preference value (exits 1 if not found)"
    echo "  streak <type>              — update streak (maintenance)"
    echo "  undo                       — delete the most recently inserted row"
    echo "  delete <table> <col> <val> — delete matching rows"
    echo "  checklist-activate <slug> <year> — activate a seasonal checklist template"
    echo "  checklist-check <item_id>  — mark a checklist item complete"
    echo "  checklist-uncheck <item_id> — unmark a checklist item"
    exit 1
    ;;
esac
