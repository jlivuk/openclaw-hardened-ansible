#!/bin/bash
# Initialize SQLite database for Carlos daily logging.
# Run once on the Pi: bash init-db.sh
#
# Creates ~/carlos-dashboard/carlos.db with tables for meals, hydration, exercise.

set -euo pipefail

CARLOS_USER="${1:-${CARLOS_USER:-john}}"
CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
DB_DIR="${CARLOS_DATA_DIR}/${CARLOS_USER}"
DB="$DB_DIR/carlos.db"

mkdir -p "$DB_DIR"

sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  meal TEXT NOT NULL,
  calories INTEGER DEFAULT 0,
  protein TEXT DEFAULT '',
  carbs TEXT DEFAULT '',
  fat TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hydration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  glass_num INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exercise (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  activity TEXT NOT NULL,
  duration TEXT DEFAULT '',
  calories_burned INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  distance TEXT DEFAULT '',
  avg_heart_rate INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  weight_lbs REAL NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sleep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  duration_minutes INTEGER NOT NULL,
  notes TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sleep_date ON sleep(date);

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

CREATE TABLE IF NOT EXISTS apple_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  steps INTEGER,
  active_cal INTEGER,
  basal_energy INTEGER,
  flights_climbed INTEGER,
  heart_rate INTEGER,
  hrv INTEGER,
  blood_oxygen REAL,
  walking_hr INTEGER,
  resting_hr INTEGER,
  vo2_max REAL,
  respiratory_rate REAL,
  distance_walking REAL,
  exercise_time INTEGER,
  sleep_minutes INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apple_health_date ON apple_health(date);

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

CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
CREATE INDEX IF NOT EXISTS idx_hydration_date ON hydration(date);
CREATE INDEX IF NOT EXISTS idx_exercise_date ON exercise(date);
CREATE INDEX IF NOT EXISTS idx_weight_date ON weight(date);
SQL

echo "Database created at $DB"
echo "Tables: meals, hydration, exercise, weight, sleep, apple_health, streaks"
sqlite3 "$DB" ".tables"
