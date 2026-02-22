#!/bin/bash
# User management CLI for Carlos dashboard (SQLite backend).
# Usage:
#   manage-users.sh add <username> <password> <display_name> [role]
#   manage-users.sh remove <username>
#   manage-users.sh list
#   manage-users.sh reset-password <username> <password>
#   manage-users.sh set-api-key <username>
#   manage-users.sh set-role <username> <role>

set -euo pipefail

CARLOS_DATA_DIR="${CARLOS_DATA_DIR:-$HOME/carlos-dashboard}"
ADMIN_DB="${CARLOS_DATA_DIR}/carlos-admin.db"

# Ensure data dir exists
mkdir -p "$CARLOS_DATA_DIR"

# Auto-create schema if DB doesn't exist
if [ ! -f "$ADMIN_DB" ]; then
  sqlite3 "$ADMIN_DB" "
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      api_key TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'readonly')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
fi

ACTION="${1:-}"
shift || true

# Validate username: alphanumeric, hyphens, underscores only
validate_username() {
  local username="$1"
  if ! echo "$username" | grep -qE '^[a-zA-Z0-9_-]+$'; then
    echo "Error: Invalid username. Use only letters, numbers, hyphens, underscores." >&2
    exit 1
  fi
}

# Escape single quotes for SQLite
escape_sql() {
  echo "$1" | sed "s/'/''/g"
}

hash_password() {
  local password="$1"
  node -e "
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(process.argv[1], salt, 64);
    const hash = 'scrypt:' + derived.toString('hex');
    console.log(JSON.stringify({ hash, salt }));
  " "$password"
}

case "$ACTION" in
  add)
    USERNAME="${1:?Usage: manage-users.sh add <username> <password> <display_name> [role]}"
    PASSWORD="${2:?Password required}"
    DISPLAY_NAME="${3:-$USERNAME}"
    ROLE="${4:-user}"

    validate_username "$USERNAME"

    # Validate role
    if [[ "$ROLE" != "admin" && "$ROLE" != "user" && "$ROLE" != "readonly" ]]; then
      echo "Error: Invalid role '$ROLE'. Must be admin, user, or readonly." >&2
      exit 1
    fi

    # Check if user already exists
    EXISTING=$(sqlite3 "$ADMIN_DB" "SELECT COUNT(*) FROM users WHERE username='$(escape_sql "$USERNAME")';")
    if [ "$EXISTING" -gt 0 ]; then
      echo "Error: User $USERNAME already exists" >&2
      exit 1
    fi

    HASH_DATA=$(hash_password "$PASSWORD")
    HASH=$(echo "$HASH_DATA" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).hash))")
    SALT=$(echo "$HASH_DATA" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).salt))")
    API_KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")

    sqlite3 "$ADMIN_DB" "INSERT INTO users (username, display_name, password_hash, salt, api_key, role) VALUES ('$(escape_sql "$USERNAME")', '$(escape_sql "$DISPLAY_NAME")', '$(escape_sql "$HASH")', '$(escape_sql "$SALT")', '$(escape_sql "$API_KEY")', '$(escape_sql "$ROLE")');"

    echo "Added user: $USERNAME ($DISPLAY_NAME) [role: $ROLE]"
    echo "API key: $API_KEY"

    # Provision data directories
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    bash "$SCRIPT_DIR/init-user.sh" "$USERNAME"
    ;;

  remove)
    USERNAME="${1:?Usage: manage-users.sh remove <username>}"
    validate_username "$USERNAME"

    EXISTING=$(sqlite3 "$ADMIN_DB" "SELECT COUNT(*) FROM users WHERE username='$(escape_sql "$USERNAME")';")
    if [ "$EXISTING" -eq 0 ]; then
      echo "Error: User $USERNAME not found" >&2
      exit 1
    fi

    sqlite3 "$ADMIN_DB" "DELETE FROM users WHERE username='$(escape_sql "$USERNAME")';"

    echo "Removed user: $USERNAME"
    echo "Note: data directories were NOT deleted. Remove manually if needed:"
    echo "  rm -rf ${CARLOS_DATA_DIR}/${USERNAME}"
    ;;

  list)
    sqlite3 -header -column "$ADMIN_DB" "SELECT username, display_name AS display, role, COALESCE(SUBSTR(api_key, 1, 8) || '...', 'none') AS api_key_prefix, created_at FROM users ORDER BY id;"
    ;;

  reset-password)
    USERNAME="${1:?Usage: manage-users.sh reset-password <username> <password>}"
    PASSWORD="${2:?Password required}"
    validate_username "$USERNAME"

    EXISTING=$(sqlite3 "$ADMIN_DB" "SELECT COUNT(*) FROM users WHERE username='$(escape_sql "$USERNAME")';")
    if [ "$EXISTING" -eq 0 ]; then
      echo "Error: User $USERNAME not found" >&2
      exit 1
    fi

    HASH_DATA=$(hash_password "$PASSWORD")
    HASH=$(echo "$HASH_DATA" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).hash))")
    SALT=$(echo "$HASH_DATA" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).salt))")

    sqlite3 "$ADMIN_DB" "UPDATE users SET password_hash='$(escape_sql "$HASH")', salt='$(escape_sql "$SALT")', updated_at=datetime('now') WHERE username='$(escape_sql "$USERNAME")';"

    echo "Password reset for: $USERNAME"
    ;;

  set-api-key)
    USERNAME="${1:?Usage: manage-users.sh set-api-key <username>}"
    validate_username "$USERNAME"

    EXISTING=$(sqlite3 "$ADMIN_DB" "SELECT COUNT(*) FROM users WHERE username='$(escape_sql "$USERNAME")';")
    if [ "$EXISTING" -eq 0 ]; then
      echo "Error: User $USERNAME not found" >&2
      exit 1
    fi

    API_KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")

    sqlite3 "$ADMIN_DB" "UPDATE users SET api_key='$(escape_sql "$API_KEY")', updated_at=datetime('now') WHERE username='$(escape_sql "$USERNAME")';"

    echo "API key for $USERNAME: $API_KEY"
    ;;

  set-role)
    USERNAME="${1:?Usage: manage-users.sh set-role <username> <role>}"
    ROLE="${2:?Role required (admin, user, readonly)}"
    validate_username "$USERNAME"

    # Validate role
    if [[ "$ROLE" != "admin" && "$ROLE" != "user" && "$ROLE" != "readonly" ]]; then
      echo "Error: Invalid role '$ROLE'. Must be admin, user, or readonly." >&2
      exit 1
    fi

    EXISTING=$(sqlite3 "$ADMIN_DB" "SELECT COUNT(*) FROM users WHERE username='$(escape_sql "$USERNAME")';")
    if [ "$EXISTING" -eq 0 ]; then
      echo "Error: User $USERNAME not found" >&2
      exit 1
    fi

    sqlite3 "$ADMIN_DB" "UPDATE users SET role='$(escape_sql "$ROLE")', updated_at=datetime('now') WHERE username='$(escape_sql "$USERNAME")';"

    echo "Role for $USERNAME set to: $ROLE"
    ;;

  *)
    echo "Usage: manage-users.sh {add|remove|list|reset-password|set-api-key|set-role} [args...]"
    exit 1
    ;;
esac
