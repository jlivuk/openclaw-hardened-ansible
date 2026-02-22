#!/bin/bash
# Syncs health data from Notion "Carlos — Health Log" database to Carlos's memory files
# Run via cron: */15 * * * * /home/baxter/carlos-dashboard/sync-notion.sh
#
# Requires: NOTION_API_KEY environment variable
# Database ID: 2ddae89f924e4b8d85181db0f45f3a53

NOTION_DB="2ddae89f924e4b8d85181db0f45f3a53"
MEMORY_DIR="$HOME/.openclaw/workspace-carlos/memory"
NOTION_API_KEY="${NOTION_API_KEY:-$(cat $HOME/.notion-key 2>/dev/null)}"

if [ -z "$NOTION_API_KEY" ]; then
  echo "Error: NOTION_API_KEY not set and ~/.notion-key not found"
  exit 1
fi

mkdir -p "$MEMORY_DIR"

# Query Notion database for entries from last 7 days
RESPONSE=$(curl -s -X POST "https://api.notion.com/v1/databases/$NOTION_DB/query" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "sorts": [{"property": "Date", "direction": "descending"}],
    "page_size": 30
  }')

# Parse and write to memory files using Node.js (available on Pi)
node -e "
const data = JSON.parse(process.argv[1]);
const fs = require('fs');
const path = require('path');
const memDir = '$MEMORY_DIR';

if (!data.results || !data.results.length) {
  console.log('No entries found in Notion');
  process.exit(0);
}

// Group entries by date
const byDate = {};
for (const page of data.results) {
  const props = page.properties;
  const dateObj = props['Date']?.date;
  if (!dateObj || !dateObj.start) continue;
  const date = dateObj.start.slice(0, 10);

  if (!byDate[date]) byDate[date] = [];
  byDate[date].push({
    entry: props['Entry']?.title?.[0]?.plain_text || 'Health Update',
    steps: props['Steps']?.number,
    activeCal: props['Active Calories']?.number,
    restingHR: props['Resting HR']?.number,
    sleepHours: props['Sleep Hours']?.number,
    weight: props['Weight']?.number,
    workouts: props['Workouts']?.rich_text?.[0]?.plain_text || '',
    notes: props['Notes']?.rich_text?.[0]?.plain_text || ''
  });
}

for (const [date, entries] of Object.entries(byDate)) {
  const file = path.join(memDir, date + '.md');
  let content = '';

  // Read existing file if it exists
  try { content = fs.readFileSync(file, 'utf8'); } catch {}

  // Check if Apple Health section already exists
  if (content.includes('## Apple Health')) continue;

  // Build Apple Health section
  let healthSection = '\n## Apple Health\n\n| Metric | Value |\n|--------|-------|\n';
  const latest = entries[0];
  if (latest.steps != null) healthSection += '| Steps | ' + latest.steps.toLocaleString() + ' |\n';
  if (latest.activeCal != null) healthSection += '| Active Calories | ' + latest.activeCal + ' |\n';
  if (latest.restingHR != null) healthSection += '| Resting Heart Rate | ' + latest.restingHR + ' bpm |\n';
  if (latest.sleepHours != null) healthSection += '| Sleep | ' + latest.sleepHours + 'h |\n';
  if (latest.weight != null) healthSection += '| Weight | ' + latest.weight + ' lbs |\n';
  if (latest.workouts) healthSection += '| Workouts | ' + latest.workouts + ' |\n';
  if (latest.notes) healthSection += '| Notes | ' + latest.notes + ' |\n';

  // Append or create file
  if (content) {
    // Insert before Daily Totals if exists, otherwise append
    if (content.includes('## Daily Totals')) {
      content = content.replace('## Daily Totals', healthSection + '\n## Daily Totals');
    } else {
      content += '\n' + healthSection;
    }
  } else {
    content = '# ' + date + '\n' + healthSection;
  }

  fs.writeFileSync(file, content);
  console.log('Updated ' + date);

  // Update weight log
  if (latest.weight != null) {
    const weightFile = path.join(memDir, 'WEIGHT.md');
    let weightContent = '';
    try { weightContent = fs.readFileSync(weightFile, 'utf8'); } catch {}
    if (!weightContent) {
      weightContent = '# Weight Log\n\n| Date | Weight | Notes |\n|------|--------|-------|\n';
    }
    if (!weightContent.includes(date)) {
      weightContent += '| ' + date + ' | ' + latest.weight + ' lbs | From Apple Health |\n';
      fs.writeFileSync(weightFile, weightContent);
    }
  }
}
" "$RESPONSE"
