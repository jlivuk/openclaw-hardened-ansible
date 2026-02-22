#!/bin/bash
# Watchdog: restarts OpenClaw container if Telegram bot stops responding
# Cron: */5 * * * * /home/baxter/carlos-dashboard/carlos-watchdog.sh >> /tmp/carlos-watchdog.log 2>&1
#
# How it works:
# 1. Calls Telegram getMe API to confirm the bot token is valid
# 2. Checks if the container has produced any telegram log lines in the last 10 minutes
# 3. If both checks fail, restarts the container

BOT_TOKEN=$(cat "$HOME/.telegram-token" 2>/dev/null)
CONTAINER="openclaw-docker-openclaw-gateway-1"
COMPOSE_DIR="$HOME/openclaw-docker"
STALE_MINUTES=10

if [ -z "$BOT_TOKEN" ]; then
  echo "$(date -Iseconds) [watchdog] no bot token found"
  exit 1
fi

# Check 1: Can the bot reach Telegram API?
API_OK=$(curl -s --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | grep -c '"ok":true')

if [ "$API_OK" = "1" ]; then
  # Telegram API is reachable — now check if the container is actually polling
  RECENT_LOGS=$(docker logs --since "${STALE_MINUTES}m" "$CONTAINER" 2>&1 | grep -c "\[telegram\]")

  if [ "$RECENT_LOGS" -gt 0 ]; then
    # All good — container is active and producing telegram logs
    exit 0
  fi

  # No telegram activity — check if the container is even running
  RUNNING=$(docker ps --filter "name=$CONTAINER" --format "{{.Status}}" 2>/dev/null)
  if [ -z "$RUNNING" ]; then
    echo "$(date -Iseconds) [watchdog] container not running — starting"
    cd "$COMPOSE_DIR" && docker compose up -d
    exit 0
  fi

  # Container is running but no telegram logs — likely stuck
  echo "$(date -Iseconds) [watchdog] no telegram activity in ${STALE_MINUTES}m — restarting container"
  cd "$COMPOSE_DIR" && docker compose restart
else
  # Telegram API unreachable — could be a network blip, don't restart yet
  # Write a flag file; only restart if it persists across 2 consecutive checks
  FLAG="/tmp/carlos-watchdog-api-fail"
  if [ -f "$FLAG" ]; then
    LAST_FAIL=$(cat "$FLAG")
    NOW=$(date +%s)
    DIFF=$(( NOW - LAST_FAIL ))
    if [ "$DIFF" -gt 240 ]; then
      echo "$(date -Iseconds) [watchdog] telegram API unreachable for 2+ checks — restarting container"
      cd "$COMPOSE_DIR" && docker compose restart
      rm -f "$FLAG"
    fi
  else
    date +%s > "$FLAG"
    echo "$(date -Iseconds) [watchdog] telegram API unreachable — flagged, will retry next check"
  fi
  exit 0
fi
