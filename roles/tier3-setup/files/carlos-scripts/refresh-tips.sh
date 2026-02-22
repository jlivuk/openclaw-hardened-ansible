#!/bin/bash
# Fetches health tips from reputable RSS feeds and saves to JSON for the dashboard
# Cron: 0 6 * * 1  ~/carlos-dashboard/refresh-tips.sh >> /tmp/refresh-tips.log 2>&1
#
# Sources: ScienceDaily, Precision Nutrition, Stronger by Science, NutritionFacts,
#          MyFitnessPal, Nerd Fitness, Eat This Not That, BBC Health

TIPS_FILE="$HOME/carlos-dashboard/tips.json"

node -e "
const https = require('https');
const http = require('http');

const feeds = [
  { url: 'https://www.sciencedaily.com/rss/health_medicine/fitness.xml', source: 'ScienceDaily Fitness' },
  { url: 'https://www.sciencedaily.com/rss/health_medicine/nutrition.xml', source: 'ScienceDaily Nutrition' },
  { url: 'https://www.precisionnutrition.com/feed', source: 'Precision Nutrition' },
  { url: 'https://www.strongerbyscience.com/feed/', source: 'Stronger by Science' },
  { url: 'https://nutritionfacts.org/feed/', source: 'NutritionFacts.org' },
  { url: 'https://blog.myfitnesspal.com/feed/', source: 'MyFitnessPal' },
  { url: 'https://www.nerdfitness.com/feed/', source: 'Nerd Fitness' },
  { url: 'https://www.eatthis.com/feed/', source: 'Eat This, Not That' },
  { url: 'https://feeds.bbci.co.uk/news/health/rss.xml', source: 'BBC Health' },
];

function fetchFeed(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Carlos-Dashboard/1.0)' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchFeed(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(''));
    }).on('error', () => resolve(''));
  });
}

function parseItems(xml) {
  const items = [];
  if (!xml.includes('<item')) return items;
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '';
    const desc = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '';
    const link = block.match(/<link[^>]*>(.*?)<\/link>/)?.[1] || block.match(/<link[^>]*href=[\"']([^\"']+)/)?.[1] || '';
    if (title) {
      const clean = desc.replace(/<[^>]*>/g, '').replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      items.push({ title: title.trim(), desc: clean, link: link.trim() });
    }
  }
  return items;
}

async function main() {
  const allItems = [];
  const results = await Promise.allSettled(feeds.map(async (feed) => {
    const xml = await fetchFeed(feed.url);
    const items = parseItems(xml);
    console.log(feed.source + ': ' + items.length + ' items');
    return { feed, items };
  }));

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.items.length) {
      for (const item of r.value.items.slice(0, 8)) {
        allItems.push({ ...item, source: r.value.feed.source });
      }
    }
  }

  console.log('Total items: ' + allItems.length);

  // Filter to health/fitness/nutrition relevant items
  const healthWords = /diet|nutrition|exercise|fitness|weight|protein|calori|heart|sleep|vitamin|supplement|muscle|workout|running|walk|health|sugar|fat|cholesterol|blood|mental|stress|hydrat|water|food|eat|meal|brain|gut|immune|cancer|diabet|strength|cardio|recovery|body|lean|macro|fiber|energy|endurance/i;
  const filtered = allItems.filter(t => healthWords.test(t.title) || healthWords.test(t.desc));
  const source = filtered.length >= 5 ? filtered : allItems;
  console.log('After filter: ' + source.length + ' items');

  // Shuffle and pick 20
  for (let i = source.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [source[i], source[j]] = [source[j], source[i]];
  }
  const tips = source.slice(0, 20).map(t => ({
    text: t.title,
    detail: t.desc,
    source: t.source,
    link: t.link,
  }));

  if (tips.length === 0) {
    console.log('No tips fetched — keeping existing file');
    process.exit(0);
  }

  const output = { updated: new Date().toISOString(), tips };
  require('fs').writeFileSync('$TIPS_FILE', JSON.stringify(output, null, 2));
  console.log('Saved ' + tips.length + ' tips to $TIPS_FILE');
}

main().catch(console.error);
"
