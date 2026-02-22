#!/bin/bash
# Weekly fitness summary — sends report via Telegram every Sunday at 9am CST
# Cron: 0 15 * * 0  ~/carlos-dashboard/carlos-weekly.sh  (UTC = CST+6)
#
# Requires: ~/.telegram-token (bot token), ~/.telegram-chat-id (chat ID)

MEMORY_DIR="$HOME/.openclaw/workspace-carlos/memory"
BOT_TOKEN=$(cat "$HOME/.telegram-token" 2>/dev/null)
CHAT_ID=$(cat "$HOME/.telegram-chat-id" 2>/dev/null)

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: ~/.telegram-token or ~/.telegram-chat-id not found"
  exit 1
fi

send_telegram() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "parse_mode=Markdown" \
    -d "text=$1" > /dev/null
}

# Generate weekly report using Node.js
REPORT=$(node -e "
const fs = require('fs');
const path = require('path');
const memDir = '$MEMORY_DIR';

// Get last 7 dates
const dates = [];
for (let i = 6; i >= 0; i--) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  dates.push(d.toISOString().slice(0, 10));
}

// Read goals from user_preferences SQLite
let goals = {};
try {
  const { execSync } = require('child_process');
  const user = process.env.CARLOS_USER || 'john';
  const dbPath = process.env.CARLOS_DATA_DIR
    ? process.env.CARLOS_DATA_DIR + '/' + user + '/carlos.db'
    : process.env.HOME + '/carlos-dashboard/' + user + '/carlos.db';
  const result = execSync('sqlite3 "' + dbPath + '" "SELECT key, value FROM user_preferences WHERE key IN (\'daily_calorie_goal\', \'daily_protein_goal\', \'exercise_days_goal\');"').toString();
  for (const line of result.trim().split('\n')) {
    if (!line) continue;
    const [key, val] = line.split('|');
    if (key === 'daily_calorie_goal') goals['Daily Calories'] = parseFloat(val) || 0;
    if (key === 'daily_protein_goal') goals['Daily Protein'] = parseFloat(val) || 0;
    if (key === 'exercise_days_goal') goals['Exercise Days'] = parseFloat(val) || 0;
  }
} catch {}

const calTarget = goals['Daily Calories'] || 1800;
const proteinTarget = goals['Daily Protein'] || 150;
const exerciseTarget = goals['Exercise Days'] || 4;

// Parse each day
let totalCals = 0, totalProtein = 0, daysWithMeals = 0, exerciseDays = 0;
let weights = [];
const dailyData = [];

for (const date of dates) {
  try {
    const content = fs.readFileSync(path.join(memDir, date + '.md'), 'utf8');

    // Parse meals
    let dayCals = 0, dayProtein = 0, hasMeals = false;
    const mealRows = content.split('\n').filter(l => l.startsWith('|') && /\d+\s*(g|cal)?/i.test(l));

    // Find meals section
    const mealSection = content.split('## Meals')[1]?.split('##')[0] || '';
    const mRows = mealSection.split('\n').filter(l => l.startsWith('|') && !l.includes('Time') && !l.includes('---'));
    for (const row of mRows) {
      const cols = row.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 4) {
        dayCals += parseInt(cols[2]) || 0;
        dayProtein += parseInt(cols[3]) || 0;
        hasMeals = true;
      }
    }

    // Check exercise
    const exerciseSection = content.split('## Exercise')[1]?.split('##')[0] || '';
    const eRows = exerciseSection.split('\n').filter(l => l.startsWith('|') && !l.includes('Time') && !l.includes('---'));
    if (eRows.length > 0) exerciseDays++;

    // Check weight
    const healthSection = content.split('## Apple Health')[1]?.split('##')[0] || '';
    const weightMatch = healthSection.match(/Weight\s*\|\s*([\d.]+)/);
    if (weightMatch) weights.push({ date, weight: parseFloat(weightMatch[1]) });

    if (hasMeals) {
      daysWithMeals++;
      totalCals += dayCals;
      totalProtein += dayProtein;
    }

    dailyData.push({ date, cals: dayCals, protein: dayProtein, hasMeals, hasExercise: eRows.length > 0 });
  } catch {
    dailyData.push({ date, cals: 0, protein: 0, hasMeals: false, hasExercise: false });
  }
}

const avgCals = daysWithMeals ? Math.round(totalCals / daysWithMeals) : 0;
const avgProtein = daysWithMeals ? Math.round(totalProtein / daysWithMeals) : 0;

// Build report
let msg = '📊 *Weekly Fitness Report*\n';
msg += '(' + dates[0] + ' → ' + dates[6] + ')\n\n';

msg += '🔥 *Nutrition*\n';
msg += '• Avg calories: ' + avgCals + ' / ' + calTarget + ' cal';
msg += avgCals <= calTarget ? ' ✅\n' : ' ⚠️\n';
msg += '• Avg protein: ' + avgProtein + 'g / ' + proteinTarget + 'g';
msg += avgProtein >= proteinTarget ? ' ✅\n' : ' ⚠️\n';
msg += '• Days logged: ' + daysWithMeals + '/7\n\n';

msg += '💪 *Exercise*\n';
msg += '• Active days: ' + exerciseDays + ' / ' + exerciseTarget;
msg += exerciseDays >= exerciseTarget ? ' ✅\n' : ' ⚠️\n';

if (weights.length >= 2) {
  const change = (weights[weights.length - 1].weight - weights[0].weight).toFixed(1);
  const direction = change > 0 ? '+' : '';
  msg += '\n⚖️ *Weight*\n';
  msg += '• ' + weights[weights.length - 1].weight + ' lbs (' + direction + change + ' this week)\n';
} else if (weights.length === 1) {
  msg += '\n⚖️ *Weight*: ' + weights[0].weight + ' lbs\n';
}

// Pattern detection
msg += '\n📈 *Patterns*\n';
const weekdays = dailyData.filter(d => {
  const dow = new Date(d.date + 'T12:00:00').getDay();
  return dow >= 1 && dow <= 5 && d.hasMeals;
});
const weekends = dailyData.filter(d => {
  const dow = new Date(d.date + 'T12:00:00').getDay();
  return (dow === 0 || dow === 6) && d.hasMeals;
});

if (weekdays.length && weekends.length) {
  const wdAvg = Math.round(weekdays.reduce((s, d) => s + d.cals, 0) / weekdays.length);
  const weAvg = Math.round(weekends.reduce((s, d) => s + d.cals, 0) / weekends.length);
  const diff = weAvg - wdAvg;
  if (Math.abs(diff) > 150) {
    msg += '• Weekend cals ' + (diff > 0 ? 'higher' : 'lower') + ' than weekdays by ~' + Math.abs(diff) + '\n';
  } else {
    msg += '• Consistent intake weekday vs weekend 👍\n';
  }
}

const proteinDays = dailyData.filter(d => d.hasMeals && d.protein >= proteinTarget).length;
msg += '• Hit protein goal ' + proteinDays + '/' + daysWithMeals + ' days\n';

const exerciseNutrition = dailyData.filter(d => d.hasExercise && d.hasMeals);
if (exerciseNutrition.length) {
  const exProtein = Math.round(exerciseNutrition.reduce((s, d) => s + d.protein, 0) / exerciseNutrition.length);
  msg += '• Avg protein on workout days: ' + exProtein + 'g\n';
}

console.log(msg);
")

if [ -n "$REPORT" ]; then
  send_telegram "$REPORT"
  echo "Weekly report sent"
else
  echo "Error generating report"
  exit 1
fi
