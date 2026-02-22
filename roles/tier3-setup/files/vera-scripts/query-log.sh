#!/bin/bash
# Read-only query script for Vera home maintenance data from SQLite.
#
# Usage:
#   query-log.sh today                — show today's completed maintenance
#   query-log.sh overdue              — show all past-due scheduled tasks
#   query-log.sh upcoming [N]         — show next N days of scheduled maintenance (default 7)
#   query-log.sh appliance <name>     — show appliance details + associated schedules
#   query-log.sh history [N]          — show last N maintenance log entries (default 10)

set -euo pipefail

VERA_USER="${VERA_USER:-john}"
VERA_DATA_DIR="${VERA_DATA_DIR:-$HOME/vera-dashboard}"
DB="${VERA_DATA_DIR}/${VERA_USER}/vera.db"

# Use bundled sqlite3 if available (for Docker container), else system sqlite3
SQLITE="$HOME/vera-dashboard/sqlite3"
[ -x "$SQLITE" ] || SQLITE="sqlite3"

if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB"
  exit 1
fi

ACTION="${1:-today}"

case "$ACTION" in
  today)
    TODAY=$(date +%Y-%m-%d)
    echo "=== Maintenance completed on $TODAY ==="
    echo ""

    ENTRIES=$("$SQLITE" "$DB" "
      SELECT ml.task, COALESCE(a.name, '—'), ml.cost, ml.contractor, ml.notes
      FROM maintenance_log ml
      LEFT JOIN appliances a ON ml.appliance_id = a.id
      WHERE ml.date = '$TODAY'
      ORDER BY ml.id;
    ")

    if [ -n "$ENTRIES" ]; then
      echo "Task | Appliance | Cost | Contractor | Notes"
      echo "$ENTRIES" | while IFS='|' read -r task appliance cost contractor notes; do
        echo "$task | $appliance | \$$cost | $contractor | $notes"
      done
    else
      echo "No maintenance logged today."
    fi

    echo ""

    # Also show what's due today
    DUE_TODAY=$("$SQLITE" "$DB" "
      SELECT ms.task, COALESCE(a.name, '—'), ms.next_due
      FROM maintenance_schedule ms
      LEFT JOIN appliances a ON ms.appliance_id = a.id
      WHERE ms.next_due = '$TODAY'
      ORDER BY ms.id;
    ")

    if [ -n "$DUE_TODAY" ]; then
      echo "## Due today:"
      echo "$DUE_TODAY" | while IFS='|' read -r task appliance due; do
        echo "  - $task ($appliance)"
      done
    fi
    ;;

  overdue)
    TODAY=$(date +%Y-%m-%d)
    echo "=== Overdue maintenance tasks ==="
    echo ""

    OVERDUE=$("$SQLITE" "$DB" "
      SELECT ms.id, ms.task, COALESCE(a.name, '—'), ms.next_due, ms.interval_days,
        CAST(julianday('$TODAY') - julianday(ms.next_due) AS INTEGER) AS days_overdue
      FROM maintenance_schedule ms
      LEFT JOIN appliances a ON ms.appliance_id = a.id
      WHERE ms.next_due < '$TODAY'
      ORDER BY ms.next_due ASC;
    ")

    if [ -n "$OVERDUE" ]; then
      echo "ID | Task | Appliance | Due | Interval | Days Overdue"
      echo "$OVERDUE" | while IFS='|' read -r id task appliance due interval days_overdue; do
        echo "$id | $task | $appliance | $due | every ${interval}d | ${days_overdue}d overdue"
      done
    else
      echo "No overdue tasks. Everything is on track!"
    fi
    ;;

  upcoming)
    N="${2:-7}"
    if ! echo "$N" | grep -qE '^[0-9]+$' || [ "$N" -le 0 ]; then
      echo "ERROR: Days must be a positive integer."
      exit 1
    fi

    TODAY=$(date +%Y-%m-%d)
    END_DATE=$(date -d "+${N} days" +%Y-%m-%d 2>/dev/null || date -v+${N}d +%Y-%m-%d)

    echo "=== Upcoming maintenance (next $N days) ==="
    echo ""

    UPCOMING=$("$SQLITE" "$DB" "
      SELECT ms.id, ms.task, COALESCE(a.name, '—'), ms.next_due, ms.interval_days
      FROM maintenance_schedule ms
      LEFT JOIN appliances a ON ms.appliance_id = a.id
      WHERE ms.next_due >= '$TODAY' AND ms.next_due <= '$END_DATE'
      ORDER BY ms.next_due ASC;
    ")

    if [ -n "$UPCOMING" ]; then
      echo "ID | Task | Appliance | Due | Interval"
      echo "$UPCOMING" | while IFS='|' read -r id task appliance due interval; do
        echo "$id | $task | $appliance | $due | every ${interval}d"
      done
    else
      echo "No maintenance scheduled in the next $N days."
    fi
    ;;

  appliance)
    NAME="${2:?appliance name required}"
    NAME_SQL="${NAME//\'/\'\'}"

    echo "=== Appliance: $NAME ==="
    echo ""

    ROW=$("$SQLITE" "$DB" "SELECT id, name, location, brand, model, serial_number, purchase_date, warranty_expires, notes FROM appliances WHERE name='$NAME_SQL';")
    if [ -z "$ROW" ]; then
      echo "Appliance '$NAME' not found."
      exit 1
    fi

    ID=$(echo "$ROW" | cut -d'|' -f1)
    echo "  Location: $(echo "$ROW" | cut -d'|' -f3)"
    echo "  Brand: $(echo "$ROW" | cut -d'|' -f4)"
    echo "  Model: $(echo "$ROW" | cut -d'|' -f5)"
    echo "  Serial: $(echo "$ROW" | cut -d'|' -f6)"
    echo "  Purchased: $(echo "$ROW" | cut -d'|' -f7)"
    echo "  Warranty expires: $(echo "$ROW" | cut -d'|' -f8)"
    echo "  Notes: $(echo "$ROW" | cut -d'|' -f9)"
    echo ""

    # Associated schedules
    SCHEDULES=$("$SQLITE" "$DB" "SELECT id, task, interval_days, next_due, last_completed FROM maintenance_schedule WHERE appliance_id=$ID ORDER BY next_due;")
    if [ -n "$SCHEDULES" ]; then
      echo "## Scheduled maintenance:"
      echo "$SCHEDULES" | while IFS='|' read -r sid task interval due last; do
        echo "  [$sid] $task — every ${interval}d, next due: $due (last: ${last:-never})"
      done
    else
      echo "## No scheduled maintenance."
    fi
    echo ""

    # Recent maintenance log entries
    HISTORY=$("$SQLITE" "$DB" "SELECT date, task, cost, contractor, notes FROM maintenance_log WHERE appliance_id=$ID ORDER BY date DESC LIMIT 5;")
    if [ -n "$HISTORY" ]; then
      echo "## Recent maintenance history:"
      echo "$HISTORY" | while IFS='|' read -r date task cost contractor notes; do
        echo "  $date — $task (\$$cost) ${contractor:+by $contractor} ${notes:+— $notes}"
      done
    else
      echo "## No maintenance history."
    fi
    ;;

  history)
    N="${2:-10}"
    if ! echo "$N" | grep -qE '^[0-9]+$' || [ "$N" -le 0 ]; then
      echo "ERROR: History count must be a positive integer."
      exit 1
    fi

    echo "=== Last $N maintenance entries ==="
    echo ""

    ENTRIES=$("$SQLITE" "$DB" "
      SELECT ml.date, ml.task, COALESCE(a.name, '—'), ml.cost, ml.contractor, ml.notes
      FROM maintenance_log ml
      LEFT JOIN appliances a ON ml.appliance_id = a.id
      ORDER BY ml.date DESC, ml.id DESC
      LIMIT $N;
    ")

    if [ -n "$ENTRIES" ]; then
      echo "Date | Task | Appliance | Cost | Contractor | Notes"
      echo "$ENTRIES" | while IFS='|' read -r date task appliance cost contractor notes; do
        echo "$date | $task | $appliance | \$$cost | $contractor | $notes"
      done
    else
      echo "No maintenance history found."
    fi
    ;;

  ha-status)
    # Check Home Assistant connection via Vera dashboard API
    HA_URL=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='ha_url';")
    HA_TOKEN=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='ha_token';")

    if [ -z "$HA_URL" ] || [ -z "$HA_TOKEN" ]; then
      echo "Home Assistant not configured."
      echo "Set ha_url and ha_token in user preferences via the dashboard settings."
      exit 0
    fi

    echo "=== Home Assistant Status ==="
    echo "  URL: $HA_URL"

    RESP=$(curl -s -m 10 -H "Authorization: Bearer $HA_TOKEN" "${HA_URL}/api/" 2>/dev/null)
    if echo "$RESP" | grep -q '"message"'; then
      MSG=$(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
      echo "  Status: Connected ($MSG)"
    else
      echo "  Status: Not reachable"
    fi
    ;;

  ha-entities)
    # List Home Assistant entities (optionally filtered by domain)
    HA_URL=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='ha_url';")
    HA_TOKEN=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='ha_token';")

    if [ -z "$HA_URL" ] || [ -z "$HA_TOKEN" ]; then
      echo "Home Assistant not configured."
      exit 0
    fi

    DOMAIN="${2:-}"
    RESP=$(curl -s -m 10 -H "Authorization: Bearer $HA_TOKEN" "${HA_URL}/api/states" 2>/dev/null)

    if [ -z "$RESP" ]; then
      echo "ERROR: Could not reach Home Assistant."
      exit 1
    fi

    echo "=== Home Assistant Entities ==="
    # Parse JSON with simple grep/sed — extract entity_id, state, friendly_name
    echo "$RESP" | tr ',' '\n' | grep '"entity_id"' | while read -r line; do
      ENT_ID=$(echo "$line" | grep -o '"entity_id":"[^"]*"' | cut -d'"' -f4)
      if [ -n "$DOMAIN" ] && ! echo "$ENT_ID" | grep -q "^${DOMAIN}\."; then
        continue
      fi
      echo "  $ENT_ID"
    done
    ;;

  ha-entity)
    # Get single Home Assistant entity state
    ENTITY_ID="${2:?entity_id required (e.g. sensor.temperature)}"
    HA_URL=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='ha_url';")
    HA_TOKEN=$("$SQLITE" "$DB" "SELECT value FROM user_preferences WHERE key='ha_token';")

    if [ -z "$HA_URL" ] || [ -z "$HA_TOKEN" ]; then
      echo "Home Assistant not configured."
      exit 0
    fi

    RESP=$(curl -s -m 10 -H "Authorization: Bearer $HA_TOKEN" "${HA_URL}/api/states/${ENTITY_ID}" 2>/dev/null)

    if echo "$RESP" | grep -q '"entity_id"'; then
      STATE=$(echo "$RESP" | grep -o '"state":"[^"]*"' | head -1 | cut -d'"' -f4)
      NAME=$(echo "$RESP" | grep -o '"friendly_name":"[^"]*"' | head -1 | cut -d'"' -f4)
      CHANGED=$(echo "$RESP" | grep -o '"last_changed":"[^"]*"' | head -1 | cut -d'"' -f4)
      echo "=== $ENTITY_ID ==="
      echo "  Name: ${NAME:-$ENTITY_ID}"
      echo "  State: $STATE"
      echo "  Last changed: ${CHANGED:-unknown}"
    else
      echo "Entity '$ENTITY_ID' not found."
      exit 1
    fi
    ;;

  *)
    echo "Usage: query-log.sh {today|overdue|upcoming [N]|appliance <name>|history [N]|ha-status|ha-entities [domain]|ha-entity <id>}"
    exit 1
    ;;
esac
