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

-- Seasonal checklists (templates + user instances)
CREATE TABLE IF NOT EXISTS seasonal_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  season TEXT NOT NULL DEFAULT '',
  is_template INTEGER NOT NULL DEFAULT 0,
  template_id INTEGER,
  year INTEGER,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (template_id) REFERENCES seasonal_checklists(id)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  FOREIGN KEY (checklist_id) REFERENCES seasonal_checklists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id);

-- Seed seasonal checklist templates
INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Winterization', 'winterization', 'fall', 1);
INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Spring Check-up', 'spring-checkup', 'spring', 1);
INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Hurricane Prep', 'hurricane-prep', 'summer', 1);
INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Fall Fire Prevention', 'fall-fire-prevention', 'fall', 1);

-- Winterization items
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Insulate exposed pipes', 1 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Insulate exposed pipes');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Disconnect and drain outdoor hoses', 2 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Disconnect and drain outdoor hoses');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Schedule furnace inspection', 3 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Schedule furnace inspection');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Clean gutters and downspouts', 4 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Clean gutters and downspouts');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Check weather stripping on doors and windows', 5 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Check weather stripping on doors and windows');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Test heating system and replace filter', 6 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Test heating system and replace filter');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Reverse ceiling fan direction to clockwise', 7 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Reverse ceiling fan direction to clockwise');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Seal gaps and cracks in foundation', 8 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Seal gaps and cracks in foundation');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Stock winter emergency supplies', 9 FROM seasonal_checklists WHERE slug='winterization'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='winterization') AND task='Stock winter emergency supplies');

-- Spring Check-up items
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Inspect roof for winter damage', 1 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Inspect roof for winter damage');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Service AC unit before summer', 2 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Service AC unit before summer');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Check exterior paint and siding for damage', 3 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Check exterior paint and siding for damage');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Test smoke and CO detectors', 4 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Test smoke and CO detectors');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Clean gutters and check drainage', 5 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Clean gutters and check drainage');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Inspect deck and fence for rot or damage', 6 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Inspect deck and fence for rot or damage');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Check window and door screens', 7 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Check window and door screens');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Test sprinkler system and outdoor faucets', 8 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Test sprinkler system and outdoor faucets');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Apply pre-emergent weed treatment to lawn', 9 FROM seasonal_checklists WHERE slug='spring-checkup'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='spring-checkup') AND task='Apply pre-emergent weed treatment to lawn');

-- Hurricane Prep items
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Test and install storm shutters', 1 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Test and install storm shutters');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Test generator and stock fuel', 2 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Test generator and stock fuel');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Trim trees and remove dead branches', 3 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Trim trees and remove dead branches');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Stock emergency water and food supplies', 4 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Stock emergency water and food supplies');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Secure outdoor furniture and loose items', 5 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Secure outdoor furniture and loose items');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Clear storm drains and gutters', 6 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Clear storm drains and gutters');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Review insurance policies and document valuables', 7 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Review insurance policies and document valuables');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Prepare evacuation plan and emergency kit', 8 FROM seasonal_checklists WHERE slug='hurricane-prep'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='hurricane-prep') AND task='Prepare evacuation plan and emergency kit');

-- Fall Fire Prevention items
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Schedule chimney cleaning and inspection', 1 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Schedule chimney cleaning and inspection');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Test all smoke detectors and replace batteries', 2 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Test all smoke detectors and replace batteries');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Clean dryer vent and lint trap', 3 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Clean dryer vent and lint trap');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Inspect electrical cords and outlets', 4 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Inspect electrical cords and outlets');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Check fire extinguishers (charge and expiry)', 5 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Check fire extinguishers (charge and expiry)');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Clear leaves and debris from roof and gutters', 6 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Clear leaves and debris from roof and gutters');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Review and practice family fire escape plan', 7 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Review and practice family fire escape plan');
INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order)
  SELECT id, 'Store firewood at least 30 feet from house', 8 FROM seasonal_checklists WHERE slug='fall-fire-prevention'
  AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='fall-fire-prevention') AND task='Store firewood at least 30 feet from house');
SQL

echo "Database created at $DB"
echo "Tables: appliances, maintenance_schedule, maintenance_log, user_preferences, chat_history, feedback, streaks, seasonal_checklists, checklist_items"
sqlite3 "$DB" ".tables"
