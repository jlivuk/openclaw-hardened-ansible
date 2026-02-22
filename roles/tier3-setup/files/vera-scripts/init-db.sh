#!/bin/bash
# Initialize SQLite database for Vera home maintenance tracking.
# Run once on the Pi: bash init-db.sh
#
# Creates ~/vera-dashboard/$USER/vera.db with tables for appliances, maintenance, schedules.

set -euo pipefail

VERA_USER="${1:-${VERA_USER:-john}}"
VERA_DATA_DIR="${VERA_DATA_DIR:-$HOME/vera-dashboard}"
DB_DIR="${VERA_DATA_DIR}/${VERA_USER}"
DB="$DB_DIR/vera.db"

mkdir -p "$DB_DIR"

sqlite3 "$DB" <<'SQL'
-- Domain tables
CREATE TABLE IF NOT EXISTS appliances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  location TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  model TEXT DEFAULT '',
  serial_number TEXT DEFAULT '',
  purchase_date TEXT DEFAULT '',
  warranty_expires TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  appliance_id INTEGER,
  interval_days INTEGER NOT NULL,
  last_completed TEXT,
  next_due TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (appliance_id) REFERENCES appliances(id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_next_due ON maintenance_schedule(next_due);

CREATE TABLE IF NOT EXISTS maintenance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  task TEXT NOT NULL,
  appliance_id INTEGER,
  cost REAL DEFAULT 0,
  contractor TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (appliance_id) REFERENCES appliances(id)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_log_date ON maintenance_log(date);

-- Generic tables (shared pattern from Carlos)
CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  session_key TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_key);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  page TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS streaks (
  metric TEXT PRIMARY KEY,
  current INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  last_active TEXT NOT NULL DEFAULT '—'
);
SQL

echo "Database created at $DB"
echo "Tables: appliances, maintenance_schedule, maintenance_log, user_preferences, chat_history, feedback, streaks"
sqlite3 "$DB" ".tables"
