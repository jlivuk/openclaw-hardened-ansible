#!/bin/bash
# Syncs recent Strava activities to Carlos's memory files
# Run via cron: */15 * * * * /home/baxter/carlos-dashboard/sync-strava.sh
#
# Requires: ~/.strava-creds (JSON with client_id, client_secret, refresh_token)

MEMORY_DIR="$HOME/.openclaw/workspace-carlos/memory"
CREDS_FILE="$HOME/.strava-creds"

if [ ! -f "$CREDS_FILE" ]; then
  echo "Error: $CREDS_FILE not found"
  exit 1
fi

mkdir -p "$MEMORY_DIR"

CLIENT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS_FILE','utf8')).client_id)")
CLIENT_SECRET=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS_FILE','utf8')).client_secret)")
REFRESH_TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS_FILE','utf8')).refresh_token)")

# Refresh the access token
TOKEN_RESPONSE=$(curl -s -X POST "https://www.strava.com/oauth/token" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "refresh_token=$REFRESH_TOKEN" \
  -d "grant_type=refresh_token")

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.access_token||'')")
NEW_REFRESH=$(echo "$TOKEN_RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.refresh_token||'')")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Error: Failed to get access token"
  exit 1
fi

# Update refresh token if it changed
if [ -n "$NEW_REFRESH" ] && [ "$NEW_REFRESH" != "$REFRESH_TOKEN" ]; then
  node -e "
    const fs = require('fs');
    const creds = JSON.parse(fs.readFileSync('$CREDS_FILE','utf8'));
    creds.refresh_token = '$NEW_REFRESH';
    fs.writeFileSync('$CREDS_FILE', JSON.stringify(creds, null, 2));
  "
fi

# Fetch activities from the last 7 days
AFTER=$(date -d '7 days ago' +%s 2>/dev/null || date -v-7d +%s)
ACTIVITIES=$(curl -s "https://www.strava.com/api/v3/athlete/activities?after=$AFTER&per_page=30" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

# Parse and write to memory files
node -e "
const data = JSON.parse(process.argv[1]);
const fs = require('fs');
const path = require('path');
const memDir = '$MEMORY_DIR';

if (!Array.isArray(data) || !data.length) {
  console.log('No recent Strava activities');
  process.exit(0);
}

for (const act of data) {
  const date = act.start_date_local.slice(0, 10);
  const file = path.join(memDir, date + '.md');

  // Read existing file
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch {}

  // Skip if this activity is already logged (check by name + time)
  const timeStr = new Date(act.start_date_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (content.includes(act.name) && content.includes(timeStr)) continue;

  // Map Strava type to friendly name
  const typeMap = { Run: 'Running', Ride: 'Cycling', Swim: 'Swimming', Walk: 'Walking', Hike: 'Hiking', WeightTraining: 'Weight Training', Yoga: 'Yoga', Workout: 'Workout' };
  const activity = typeMap[act.type] || act.type || 'Exercise';
  const durationMin = Math.round((act.moving_time || act.elapsed_time) / 60);
  const calories = act.calories ? Math.round(act.calories) : Math.round(durationMin * 8); // fallback estimate
  const distMi = act.distance ? (act.distance / 1609.34).toFixed(1) + ' mi' : '';
  const notes = [act.name, distMi].filter(Boolean).join(', ');

  // Build exercise row
  const row = '| ' + timeStr + ' | ' + activity + ' | ' + durationMin + ' min | ' + calories + ' | ' + notes + ' (Strava) |';

  if (content.includes('## Exercise')) {
    // Find the exercise table and append row before next section
    const lines = content.split('\n');
    let inserted = false;
    const result = [];
    for (let i = 0; i < lines.length; i++) {
      result.push(lines[i]);
      // Insert after the last table row in Exercise section
      if (!inserted && lines[i].startsWith('|') && i > 0) {
        // Check we're in Exercise section
        const above = lines.slice(0, i + 1).join('\n');
        if (above.includes('## Exercise') && (!above.includes('## Daily Totals') || above.lastIndexOf('## Exercise') > above.lastIndexOf('## Daily Totals'))) {
          // Check if next line is NOT a table row
          if (i + 1 >= lines.length || !lines[i + 1].startsWith('|')) {
            result.push(row);
            inserted = true;
          }
        }
      }
    }
    if (!inserted) {
      // Fallback: append after exercise header + table header + separator
      const idx = content.indexOf('## Exercise');
      const afterIdx = content.indexOf('\n', content.indexOf('\n', content.indexOf('\n', idx) + 1) + 1);
      content = content.slice(0, afterIdx) + '\n' + row + content.slice(afterIdx);
      fs.writeFileSync(file, content);
    } else {
      fs.writeFileSync(file, result.join('\n'));
    }
  } else if (content) {
    // No exercise section yet — add one before Daily Totals or at end
    const exerciseSection = '\n## Exercise\n\n| Time | Activity | Duration | Calories Burned | Notes |\n|------|----------|----------|-----------------|-------|\n' + row + '\n';
    if (content.includes('## Daily Totals')) {
      content = content.replace('## Daily Totals', exerciseSection + '\n## Daily Totals');
    } else {
      content += '\n' + exerciseSection;
    }
    fs.writeFileSync(file, content);
  } else {
    // New file
    const exerciseSection = '# ' + date + '\n\n## Exercise\n\n| Time | Activity | Duration | Calories Burned | Notes |\n|------|----------|----------|-----------------|-------|\n' + row + '\n';
    fs.writeFileSync(file, exerciseSection);
  }

  console.log('Added Strava activity: ' + act.name + ' on ' + date);
}
" "$ACTIVITIES"
