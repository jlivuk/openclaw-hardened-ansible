// Sentry error tracking (graceful: null when package missing or no DSN)
let Sentry;
try {
  Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      sampleRate: 1.0,
      maxBreadcrumbs: 50,
    });
  } else { Sentry = null; }
} catch { Sentry = null; }

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  signJwt, verifyJwt, verifyPassword, hashPassword,
  authenticateRequest, initAdminDb,
  getUser, listUsers, createUser, updateUser, deleteUser, escapeSql
} = require('./auth');

// WebSocket for gateway communication (use ws package if available, else native)
let WebSocketImpl;
try { WebSocketImpl = require('ws'); } catch { WebSocketImpl = globalThis.WebSocket; }

const PORT = process.env.CARLOS_PORT || 8080;
const DATA_DIR = process.env.CARLOS_DATA_DIR || path.join(process.env.HOME, 'carlos-dashboard');
const MEMORY_BASE = process.env.CARLOS_MEMORY_BASE || path.join(process.env.HOME, '.openclaw/workspace-carlos/memory');
const DASHBOARD = path.join(__dirname, 'index.html');

// Legacy env var support (single-user mode fallback)
const LEGACY_DB = process.env.CARLOS_DB;
const LEGACY_MEMORY_DIR = process.env.CARLOS_MEMORY_DIR;

// Structured logger
const log = {
  _fmt(level, msg, data) {
    const entry = { time: new Date().toISOString(), level, msg };
    if (data) Object.assign(entry, data);
    return JSON.stringify(entry);
  },
  info(msg, data) { console.log(log._fmt('info', msg, data)); },
  warn(msg, data) { console.warn(log._fmt('warn', msg, data)); },
  error(msg, data) { console.error(log._fmt('error', msg, data)); }
};

// Static asset cache (avoids blocking readFileSync on every request)
let cachedDashboard = null;
let cachedLogo = null;
function loadStaticAssets() {
  try { cachedDashboard = fs.readFileSync(DASHBOARD, 'utf8'); } catch { cachedDashboard = null; }
  try { cachedLogo = fs.readFileSync(path.join(__dirname, 'Gemini_Generated_Image_ah6gabah6gabah6g.png')); } catch { cachedLogo = null; }
}
loadStaticAssets();
// Reload assets if files change (best-effort)
try { fs.watch(__dirname, (ev, fn) => { if (fn === 'index.html' || fn?.includes('ah6gab')) loadStaticAssets(); }); } catch {}

// SSE connections for live refresh (per-user)
const sseClients = new Map(); // username -> Set<Response>

function sseBroadcast(username, event, data) {
  const clients = sseClients.get(username);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// Per-user path resolution
function userPaths(username) {
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new Error('Invalid username');
  }
  if (LEGACY_DB && LEGACY_MEMORY_DIR) {
    // Legacy single-user mode — use env vars directly
    return { db: LEGACY_DB, memoryDir: LEGACY_MEMORY_DIR };
  }
  return {
    db: path.join(DATA_DIR, username, 'carlos.db'),
    memoryDir: path.join(MEMORY_BASE, username)
  };
}

// Helper: run a sqlite3 query and return parsed JSON rows
function dbQuery(sql, dbPath) {
  try {
    const result = execFileSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
    if (!result) return [];
    return JSON.parse(result);
  } catch (err) {
    log.error('DB query error', { error: err.message });
    if (Sentry) Sentry.captureException(err);
    return [];
  }
}

// Helper: run a sqlite3 query and return a single value
function dbValue(sql, dbPath) {
  try {
    return execFileSync('sqlite3', [dbPath, sql], {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
  } catch (err) {
    if (Sentry) Sentry.captureException(err);
    return '';
  }
}

// Helper: parse Apple Health data from a daily markdown file
function parseHealthFromMarkdown(memDir, date) {
  const health = {};
  try {
    const md = fs.readFileSync(path.join(memDir, `${date}.md`), 'utf8');
    const healthSection = md.split('## Apple Health')[1]?.split('##')[0] || '';
    const hRows = healthSection.split('\n').filter(l => l.startsWith('|') && !l.includes('Metric') && !l.includes('---'));
    for (const row of hRows) {
      const cols = row.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 2) health[cols[0]] = cols[1];
    }
  } catch {}
  return health;
}

// --- RBAC ---
const ROLE_LEVELS = { readonly: 1, user: 2, admin: 3 };

function hasMinRole(userRole, requiredRole) {
  return (ROLE_LEVELS[userRole] || 0) >= (ROLE_LEVELS[requiredRole] || 0);
}

// --- Initialize admin DB and migrate from JSON ---
initAdminDb();

// Auto-provision: create user DBs/dirs on startup
function provisionUsers() {
  const users = listUsers();
  for (const user of users) {
    provisionSingleUser(user.username);
    const { db, memoryDir } = userPaths(user.username);
    ensureAppleHealthTable(db);
    ensureExerciseColumns(db);
    ensureFeedbackTable(db);
    ensureStreaksTable(db);
    backfillHealthFromMarkdown(db, memoryDir);
  }
}

function provisionSingleUser(username) {
  const { db, memoryDir } = userPaths(username);
  try { fs.mkdirSync(path.dirname(db), { recursive: true }); } catch {}
  try { fs.mkdirSync(memoryDir, { recursive: true }); } catch {}
  if (!fs.existsSync(db)) {
    try {
      execFileSync('sqlite3', [db, `
        CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT NOT NULL, meal TEXT NOT NULL, calories INTEGER DEFAULT 0, protein TEXT DEFAULT '', carbs TEXT DEFAULT '', fat TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS hydration (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT NOT NULL, glass_num INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS exercise (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT NOT NULL, activity TEXT NOT NULL, duration TEXT DEFAULT '', calories_burned INTEGER DEFAULT 0, notes TEXT DEFAULT '', source TEXT DEFAULT 'manual', distance TEXT DEFAULT '', avg_heart_rate INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS weight (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, weight_lbs REAL NOT NULL, notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, session_key TEXT, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, message TEXT NOT NULL, page TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
        CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
        CREATE INDEX IF NOT EXISTS idx_hydration_date ON hydration(date);
        CREATE INDEX IF NOT EXISTS idx_exercise_date ON exercise(date);
        CREATE INDEX IF NOT EXISTS idx_weight_date ON weight(date);
        CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_key);
        CREATE TABLE IF NOT EXISTS apple_health (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, steps INTEGER, active_cal INTEGER, basal_energy INTEGER, flights_climbed INTEGER, heart_rate INTEGER, hrv INTEGER, blood_oxygen REAL, walking_hr INTEGER, resting_hr INTEGER, vo2_max REAL, respiratory_rate REAL, distance_walking REAL, exercise_time INTEGER, sleep_minutes INTEGER, created_at TEXT DEFAULT (datetime('now')));
        CREATE INDEX IF NOT EXISTS idx_apple_health_date ON apple_health(date);
        CREATE TABLE IF NOT EXISTS streaks (metric TEXT PRIMARY KEY, current INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_active TEXT NOT NULL DEFAULT '—');
        CREATE TABLE IF NOT EXISTS sleep (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, duration_minutes INTEGER NOT NULL, notes TEXT DEFAULT '', source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now')));
        CREATE INDEX IF NOT EXISTS idx_sleep_date ON sleep(date);
      `], { timeout: 5000 });
      log.info('Provisioned DB', { user: username });
    } catch (err) {
      log.error('Failed to provision DB', { user: username, error: err.message });
    }
  }
}

// --- Apple Health SQLite table migration ---
function ensureAppleHealthTable(dbPath) {
  try {
    execFileSync('sqlite3', [dbPath, `
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
    `], { timeout: 5000 });
    // Idempotent column additions for future-proofing
    const newCols = [
      ['resting_hr', 'INTEGER'], ['vo2_max', 'REAL'], ['respiratory_rate', 'REAL'],
      ['distance_walking', 'REAL'], ['exercise_time', 'INTEGER'], ['sleep_minutes', 'INTEGER']
    ];
    for (const [col, type] of newCols) {
      try { execFileSync('sqlite3', [dbPath, `ALTER TABLE apple_health ADD COLUMN ${col} ${type};`], { timeout: 5000 }); } catch {}
    }
  } catch (err) {
    log.error('Failed to ensure apple_health table', { error: err.message });
  }
}

// --- Exercise columns migration ---
function ensureExerciseColumns(dbPath) {
  const newCols = [['source', "TEXT DEFAULT 'manual'"], ['distance', "TEXT DEFAULT ''"], ['avg_heart_rate', 'INTEGER DEFAULT 0']];
  for (const [col, type] of newCols) {
    try { execFileSync('sqlite3', [dbPath, `ALTER TABLE exercise ADD COLUMN ${col} ${type};`], { timeout: 5000 }); } catch {}
  }
}

// --- Streaks table migration ---
function ensureStreaksTable(dbPath) {
  try {
    execFileSync('sqlite3', [dbPath, `
      CREATE TABLE IF NOT EXISTS streaks (
        metric TEXT PRIMARY KEY,
        current INTEGER NOT NULL DEFAULT 0,
        best INTEGER NOT NULL DEFAULT 0,
        last_active TEXT NOT NULL DEFAULT '\u2014'
      );
    `], { timeout: 5000 });
  } catch (err) {
    log.error('Failed to ensure streaks table', { error: err.message });
  }
}

// --- Feedback table migration ---
function ensureFeedbackTable(dbPath) {
  try {
    execFileSync('sqlite3', [dbPath, `
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        page TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `], { timeout: 5000 });
  } catch (err) {
    log.error('Failed to ensure feedback table', { error: err.message });
  }
}

// Convert markdown health display values back to numbers for SQLite
function markdownHealthToRow(health) {
  const row = {};
  const num = (s) => { if (!s) return null; const n = parseFloat(String(s).replace(/,/g, '').replace(/[^0-9.\-]/g, ' ').trim()); return isNaN(n) ? null : n; };
  row.steps = num(health['Steps']);
  row.active_cal = num(health['Active Calories']);
  row.basal_energy = num(health['Basal Energy']);
  row.flights_climbed = num(health['Flights Climbed']);
  row.heart_rate = num(health['Avg Heart Rate']);
  row.hrv = num(health['HRV']);
  row.blood_oxygen = num(health['Blood Oxygen']);
  row.walking_hr = num(health['Walking HR Avg']);
  row.resting_hr = num(health['Resting HR']);
  row.vo2_max = num(health['VO2 Max']);
  row.respiratory_rate = num(health['Resp Rate']);
  row.distance_walking = num(health['Distance']);
  row.exercise_time = num(health['Exercise']);
  // Sleep: parse "Xh Ym" -> minutes
  const sleepStr = health['Sleep'];
  if (sleepStr) {
    const hm = String(sleepStr).match(/(\d+)h\s*(\d+)m/);
    if (hm) row.sleep_minutes = parseInt(hm[1]) * 60 + parseInt(hm[2]);
    else { const mins = num(sleepStr); if (mins) row.sleep_minutes = Math.round(mins); }
  }
  return row;
}

// Backfill apple_health from existing markdown files (one-time migration)
function backfillHealthFromMarkdown(dbPath, memDir) {
  try {
    const files = fs.readdirSync(memDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    let backfilled = 0;
    for (const file of files) {
      const date = file.replace('.md', '');
      const health = parseHealthFromMarkdown(memDir, date);
      if (!Object.keys(health).length) continue;
      const row = markdownHealthToRow(health);
      const cols = Object.keys(row).filter(k => row[k] != null);
      if (!cols.length) continue;
      const colNames = ['date', ...cols].join(', ');
      const colVals = [`'${date}'`, ...cols.map(k => typeof row[k] === 'number' ? row[k] : `'${row[k]}'`)].join(', ');
      try {
        execFileSync('sqlite3', [dbPath, `INSERT OR IGNORE INTO apple_health (${colNames}) VALUES (${colVals});`], { timeout: 5000 });
        backfilled++;
      } catch {}
    }
    if (backfilled > 0) log.info('Backfilled apple_health from markdown', { count: backfilled });
  } catch (err) {
    if (err.code !== 'ENOENT') log.error('Health backfill error', { error: err.message });
  }
}

// Read health data from SQLite apple_health table, formatted with units for API responses
function readHealthFromSqlite(dbPath, date) {
  const rows = dbQuery(`SELECT * FROM apple_health WHERE date='${date}'`, dbPath);
  if (!rows.length) return null;
  const r = rows[0];
  const health = {};
  if (r.steps != null) health['Steps'] = Number(r.steps).toLocaleString();
  if (r.active_cal != null) health['Active Calories'] = `${r.active_cal} cal`;
  if (r.basal_energy != null) health['Basal Energy'] = `${r.basal_energy} cal`;
  if (r.flights_climbed != null) health['Flights Climbed'] = String(r.flights_climbed);
  if (r.heart_rate != null) health['Avg Heart Rate'] = `${r.heart_rate} bpm`;
  if (r.hrv != null) health['HRV'] = `${r.hrv} ms`;
  if (r.blood_oxygen != null) health['Blood Oxygen'] = `${r.blood_oxygen}%`;
  if (r.walking_hr != null) health['Walking HR Avg'] = `${r.walking_hr} bpm`;
  if (r.resting_hr != null) health['Resting HR'] = `${r.resting_hr} bpm`;
  if (r.vo2_max != null) health['VO2 Max'] = `${r.vo2_max} mL/kg/min`;
  if (r.respiratory_rate != null) health['Resp Rate'] = `${r.respiratory_rate} br/min`;
  if (r.distance_walking != null) health['Distance'] = `${r.distance_walking} mi`;
  if (r.exercise_time != null) health['Exercise'] = `${r.exercise_time} min`;
  if (r.sleep_minutes != null) {
    const h = Math.floor(r.sleep_minutes / 60);
    const m = r.sleep_minutes % 60;
    health['Sleep'] = `${h}h ${m}m`;
  }
  return Object.keys(health).length ? health : null;
}

// Backup a single memory file if it has grown (or warn if it shrank significantly)
function backupMemoryFile(username, memoryDir, backupDir, filename) {
  try {
    const src = path.join(memoryDir, filename);
    const backupPath = path.join(backupDir, filename);
    const content = fs.readFileSync(src, 'utf8');
    let backupSize = 0;
    try { backupSize = fs.readFileSync(backupPath, 'utf8').length; } catch {}
    if (content.length > backupSize) {
      fs.writeFileSync(backupPath, content);
      log.info('Backup updated', { user: username, file: filename, bytes: content.length });
    } else if (content.length < backupSize * 0.5) {
      log.warn('Memory file shrank — backup preserved', { user: username, file: filename, from: backupSize, to: content.length });
    }
  } catch (err) {
    log.error('Backup error', { user: username, file: filename, error: err.message });
  }
}

// Auto-backup: watch memory files per user + periodic polling fallback
function setupBackupWatchers() {
  const users = listUsers();
  for (const user of users) {
    const { memoryDir } = userPaths(user.username);
    const backupDir = path.join(memoryDir, 'backups');
    try { fs.mkdirSync(backupDir, { recursive: true }); } catch {}
    // fs.watch for immediate backup on change (best-effort, may be unreliable)
    try {
      fs.watch(memoryDir, (eventType, filename) => {
        if (!filename || !/^\d{4}-\d{2}-\d{2}\.md$/.test(filename)) return;
        backupMemoryFile(user.username, memoryDir, backupDir, filename);
      });
    } catch {}
    // Periodic polling fallback every 5 minutes (reliable across all platforms)
    setInterval(() => {
      try {
        const files = fs.readdirSync(memoryDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        for (const filename of files) {
          backupMemoryFile(user.username, memoryDir, backupDir, filename);
        }
      } catch {}
    }, 5 * 60 * 1000);
  }
}

provisionUsers();
setupBackupWatchers();

// --- Apple Health workout type mapping ---
// iPhone Shortcut must export a "workouts" array in payload.data alongside "metrics".
// Each workout object fields:
//   start       (string, required) — ISO 8601 datetime, e.g. "2026-02-22T07:30:00-06:00"
//   end         (string, optional) — ISO 8601 datetime
//   type        (string, required) — HKWorkoutActivityType* string or friendly name (see mapping below)
//   name        (string, optional) — workout name/label, e.g. "Morning Run"
//   duration    (number, required) — duration in minutes (must be > 0)
//   calories    (number, optional) — total calories burned (default 0)
//   distance    (number, optional) — distance value (default: omitted)
//   distance_unit (string, optional) — "mi" or "km" (default "mi")
//   heart_rate_avg (number, optional) — average heart rate in bpm (default 0)
//
// Supported HKWorkoutActivityType strings:
//   HKWorkoutActivityTypeRunning, HKWorkoutActivityTypeCycling,
//   HKWorkoutActivityTypeSwimming, HKWorkoutActivityTypeWalking,
//   HKWorkoutActivityTypeHiking, HKWorkoutActivityTypeTraditionalStrengthTraining,
//   HKWorkoutActivityTypeYoga, HKWorkoutActivityTypeHighIntensityIntervalTraining,
//   HKWorkoutActivityTypePilates, HKWorkoutActivityTypeDance,
//   HKWorkoutActivityTypeRowing, HKWorkoutActivityTypeElliptical,
//   HKWorkoutActivityTypeStairClimbing, HKWorkoutActivityTypeCoreTraining,
//   HKWorkoutActivityTypeFunctionalStrengthTraining, HKWorkoutActivityTypeCooldown
// Friendly names (Running, Cycling, etc.) are also accepted directly.
// Unrecognized types are inserted as-is.
const WORKOUT_TYPES = {
  'HKWorkoutActivityTypeRunning': 'Running',
  'HKWorkoutActivityTypeCycling': 'Cycling',
  'HKWorkoutActivityTypeSwimming': 'Swimming',
  'HKWorkoutActivityTypeWalking': 'Walking',
  'HKWorkoutActivityTypeHiking': 'Hiking',
  'HKWorkoutActivityTypeTraditionalStrengthTraining': 'Weight Training',
  'HKWorkoutActivityTypeYoga': 'Yoga',
  'HKWorkoutActivityTypeHighIntensityIntervalTraining': 'HIIT',
  'HKWorkoutActivityTypePilates': 'Pilates',
  'HKWorkoutActivityTypeDance': 'Dance',
  'HKWorkoutActivityTypeRowing': 'Rowing',
  'HKWorkoutActivityTypeElliptical': 'Elliptical',
  'HKWorkoutActivityTypeStairClimbing': 'Stair Climbing',
  'HKWorkoutActivityTypeCoreTraining': 'Core Training',
  'HKWorkoutActivityTypeFunctionalStrengthTraining': 'Functional Training',
  'HKWorkoutActivityTypeCooldown': 'Cooldown',
  'Running': 'Running', 'Cycling': 'Cycling', 'Swimming': 'Swimming',
  'Walking': 'Walking', 'Hiking': 'Hiking', 'Yoga': 'Yoga',
  'HIIT': 'HIIT', 'Weight Training': 'Weight Training',
  'Pilates': 'Pilates', 'Dance': 'Dance', 'Rowing': 'Rowing',
  'Elliptical': 'Elliptical', 'Stair Climbing': 'Stair Climbing',
  'Core Training': 'Core Training', 'Functional Training': 'Functional Training',
  'Cooldown': 'Cooldown'
};

// Login rate limiting: max 5 failed attempts per IP per 15 minutes
const loginAttempts = new Map();
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  // Prune expired attempts
  entry.times = entry.times.filter(t => now - t < LOGIN_WINDOW_MS);
  if (!entry.times.length) { loginAttempts.delete(ip); return true; }
  return entry.times.length < LOGIN_MAX;
}
function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { times: [] };
  entry.times.push(Date.now());
  loginAttempts.set(ip, entry);
}
// Clean up stale entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    entry.times = entry.times.filter(t => now - t < LOGIN_WINDOW_MS);
    if (!entry.times.length) loginAttempts.delete(ip);
  }
}, LOGIN_WINDOW_MS);

// Helper: parse request body
function readBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) { reject(new Error('Body too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Helper: send JSON response
function jsonResp(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Security headers
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");

  // CORS: only allow same-origin (the dashboard SPA is served from this server)
  const origin = req.headers.origin;
  if (origin) {
    try {
      const reqHost = new URL(origin).hostname;
      const serverHost = req.headers.host?.split(':')[0];
      if (reqHost === serverHost || reqHost === 'localhost' || reqHost === '127.0.0.1') {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } catch {}
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
    });
    res.end();
    return;
  }

  // --- Static files: no auth required, served from cache ---
  if (req.url === '/' || req.url === '/index.html') {
    if (cachedDashboard) {
      let html = cachedDashboard;
      if (Sentry && process.env.SENTRY_DSN) {
        html = html.replace('</head>',
          `<script>window.__SENTRY_DSN__="${process.env.SENTRY_DSN}";</script></head>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(500);
      res.end('Dashboard not found');
    }
    return;
  }

  if (req.url === '/carlos-logo.png') {
    if (cachedLogo) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(cachedLogo);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // --- POST /api/login: authenticate and return JWT ---
  if (req.url === '/api/login' && req.method === 'POST') {
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkLoginRate(clientIp)) {
      jsonResp(res, 429, { error: 'Too many login attempts. Try again later.' });
      return;
    }
    try {
      const body = await readBody(req, 4096);
      const { username, password } = JSON.parse(body);
      if (!username || !password) {
        jsonResp(res, 400, { error: 'Username and password required' });
        return;
      }
      const user = getUser(username);
      if (!user || !verifyPassword(password, user.passwordHash, user.salt)) {
        recordLoginFailure(clientIp);
        jsonResp(res, 401, { error: 'Invalid credentials' });
        return;
      }
      const token = signJwt({ sub: username, name: user.displayName || username, role: user.role });
      jsonResp(res, 200, { token, username, displayName: user.displayName || username, role: user.role, isOnboarded: !!user.isOnboarded });
    } catch (err) {
      jsonResp(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  // --- POST /api/change-password: change authenticated user's password ---
  if (req.url === '/api/change-password' && req.method === 'POST') {
    const authUser = authenticateRequest(req);
    if (!authUser) {
      jsonResp(res, 401, { error: 'Authentication required' });
      return;
    }
    try {
      const body = await readBody(req, 4096);
      const { currentPassword, newPassword } = JSON.parse(body);
      if (!currentPassword || !newPassword) {
        jsonResp(res, 400, { error: 'Current password and new password are required' });
        return;
      }
      if (newPassword.length < 6) {
        jsonResp(res, 400, { error: 'New password must be at least 6 characters' });
        return;
      }
      const user = getUser(authUser.username);
      if (!user || !verifyPassword(currentPassword, user.passwordHash, user.salt)) {
        jsonResp(res, 403, { error: 'Current password is incorrect' });
        return;
      }
      const { hash, salt } = hashPassword(newPassword);
      updateUser(authUser.username, { passwordHash: hash, salt });
      log.info('Password changed', { user: authUser.username });
      jsonResp(res, 200, { ok: true });
    } catch (err) {
      jsonResp(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  // --- GET /api/events — SSE stream (handled before general auth gate; uses query param token) ---
  if (req.url?.startsWith('/api/events') && req.method === 'GET') {
    const evtParams = new URL(req.url, 'http://localhost').searchParams;
    const qToken = evtParams.get('token');
    let evtUser = authenticateRequest(req);
    if (!evtUser && qToken) {
      const payload = verifyJwt(qToken);
      if (payload?.sub) {
        const dbUser = getUser(payload.sub);
        if (dbUser) evtUser = { username: payload.sub, displayName: dbUser.displayName || payload.sub, role: dbUser.role };
      }
    }
    if (!evtUser) { jsonResp(res, 401, { error: 'Authentication required' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('event: connected\ndata: {}\n\n');
    if (!sseClients.has(evtUser.username)) sseClients.set(evtUser.username, new Set());
    sseClients.get(evtUser.username).add(res);
    req.on('close', () => {
      const clients = sseClients.get(evtUser.username);
      if (clients) { clients.delete(res); if (!clients.size) sseClients.delete(evtUser.username); }
    });
    return;
  }

  // --- All other /api/* routes require authentication ---
  if (req.url.startsWith('/api/')) {
    const authUser = authenticateRequest(req);
    if (!authUser) {
      jsonResp(res, 401, { error: 'Authentication required' });
      return;
    }

    const userRole = authUser.role || 'user';

    // --- RBAC: block readonly from write endpoints ---
    if (!hasMinRole(userRole, 'user') && (
      req.url === '/api/health-sync' ||
      req.url === '/api/chat' ||
      req.url.startsWith('/api/chat/') ||
      (req.url === '/api/preferences' && req.method === 'POST') ||
      (req.url === '/api/feedback' && req.method === 'POST') ||
      (req.url === '/api/templates' && req.method === 'POST') ||
      (req.url.startsWith('/api/entry/') && req.method === 'DELETE')
    )) {
      jsonResp(res, 403, { error: 'Insufficient permissions' });
      return;
    }

    // --- Admin routes: require admin role ---
    if (req.url.startsWith('/api/admin/')) {
      if (!hasMinRole(userRole, 'admin')) {
        jsonResp(res, 403, { error: 'Admin access required' });
        return;
      }

      // GET /api/admin/users — list all users
      if (req.url === '/api/admin/users' && req.method === 'GET') {
        const users = listUsers().map(u => { const { apiKey, ...safe } = u; return safe; });
        jsonResp(res, 200, { users });
        return;
      }

      // POST /api/admin/users — create user
      if (req.url === '/api/admin/users' && req.method === 'POST') {
        try {
          const body = await readBody(req, 4096);
          const { username, password, displayName, role } = JSON.parse(body);
          if (!username || !password) {
            jsonResp(res, 400, { error: 'Username and password required' });
            return;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            jsonResp(res, 400, { error: 'Invalid username (letters, numbers, hyphens, underscores only)' });
            return;
          }
          if (password.length < 6) {
            jsonResp(res, 400, { error: 'Password must be at least 6 characters' });
            return;
          }
          const validRoles = ['admin', 'user', 'readonly'];
          const userRole = validRoles.includes(role) ? role : 'user';
          if (getUser(username)) {
            jsonResp(res, 409, { error: 'User already exists' });
            return;
          }
          const { hash, salt } = hashPassword(password);
          const apiKey = crypto.randomBytes(24).toString('hex');
          createUser(username, displayName || username, hash, salt, userRole, apiKey);
          provisionSingleUser(username);
          const newUserPaths = userPaths(username);
          ensureAppleHealthTable(newUserPaths.db);
          ensureExerciseColumns(newUserPaths.db);
          ensureStreaksTable(newUserPaths.db);
          log.info('User created', { user: username, role: userRole, by: authUser.username });
          jsonResp(res, 201, { ok: true, username, apiKey });
        } catch (err) {
          log.error('Create user error', { error: err.message });
          jsonResp(res, 400, { error: 'Failed to create user' });
        }
        return;
      }

      if (req.url === '/api/admin/feedback' && req.method === 'GET') {
        try {
          const allFeedback = [];
          const users = listUsers();
          for (const user of users) {
            const uDb = userPaths(user.username).db;
            try {
              const rows = dbQuery("SELECT id, category, message, page, created_at FROM feedback ORDER BY id DESC LIMIT 100", uDb);
              for (const row of rows) {
                allFeedback.push({ ...row, username: user.username });
              }
            } catch {}
          }
          allFeedback.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
          jsonResp(res, 200, { feedback: allFeedback.slice(0, 200) });
        } catch (err) {
          log.error('Admin feedback error', { error: err.message });
          jsonResp(res, 500, { error: 'Failed to load feedback' });
        }
        return;
      }

      // Routes with :username in path
      const adminUserMatch = req.url.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)(\/reset-password)?$/);
      if (adminUserMatch) {
        const targetUsername = adminUserMatch[1];
        const isResetPassword = adminUserMatch[2] === '/reset-password';

        // POST /api/admin/users/:username/reset-password
        if (isResetPassword && req.method === 'POST') {
          try {
            const body = await readBody(req, 4096);
            const { newPassword } = JSON.parse(body);
            if (!newPassword || newPassword.length < 6) {
              jsonResp(res, 400, { error: 'New password must be at least 6 characters' });
              return;
            }
            const target = getUser(targetUsername);
            if (!target) {
              jsonResp(res, 404, { error: 'User not found' });
              return;
            }
            const { hash, salt } = hashPassword(newPassword);
            updateUser(targetUsername, { passwordHash: hash, salt });
            log.info('Password reset by admin', { user: targetUsername, by: authUser.username });
            jsonResp(res, 200, { ok: true });
          } catch (err) {
            jsonResp(res, 400, { error: 'Invalid request' });
          }
          return;
        }

        // PUT /api/admin/users/:username — edit role/displayName
        if (!isResetPassword && req.method === 'PUT') {
          try {
            const body = await readBody(req, 4096);
            const { displayName, role } = JSON.parse(body);
            const target = getUser(targetUsername);
            if (!target) {
              jsonResp(res, 404, { error: 'User not found' });
              return;
            }
            const fields = {};
            if (displayName !== undefined) fields.displayName = displayName;
            if (role !== undefined) {
              const validRoles = ['admin', 'user', 'readonly'];
              if (!validRoles.includes(role)) {
                jsonResp(res, 400, { error: 'Invalid role' });
                return;
              }
              fields.role = role;
            }
            if (Object.keys(fields).length === 0) {
              jsonResp(res, 400, { error: 'No fields to update' });
              return;
            }
            updateUser(targetUsername, fields);
            log.info('User updated', { user: targetUsername, fields: Object.keys(fields), by: authUser.username });
            jsonResp(res, 200, { ok: true });
          } catch (err) {
            jsonResp(res, 400, { error: 'Invalid request' });
          }
          return;
        }

        // DELETE /api/admin/users/:username — delete user
        if (!isResetPassword && req.method === 'DELETE') {
          const target = getUser(targetUsername);
          if (!target) {
            jsonResp(res, 404, { error: 'User not found' });
            return;
          }
          // Prevent deleting yourself
          if (targetUsername === authUser.username) {
            jsonResp(res, 400, { error: 'Cannot delete your own account' });
            return;
          }
          deleteUser(targetUsername);
          log.info('User deleted', { user: targetUsername, by: authUser.username });
          jsonResp(res, 200, { ok: true });
          return;
        }
      }

      // Unknown admin route
      jsonResp(res, 404, { error: 'Not found' });
      return;
    }

    const { db, memoryDir } = userPaths(authUser.username);

    // DELETE /api/entry/:table/:id — delete a single entry by ID
    const deleteMatch = req.url.match(/^\/api\/entry\/(meals|exercise|weight|sleep|hydration)\/(\d+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      if (!hasMinRole(userRole, 'user')) {
        jsonResp(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const table = deleteMatch[1];
      const id = parseInt(deleteMatch[2], 10);
      if (isNaN(id)) {
        jsonResp(res, 400, { error: 'Invalid id' });
        return;
      }
      try {
        const existing = dbQuery(`SELECT id FROM ${table} WHERE id=${id}`, db);
        if (!existing.length) {
          jsonResp(res, 404, { error: 'Entry not found' });
          return;
        }
        execFileSync('sqlite3', [db, `DELETE FROM ${table} WHERE id=${id}`], { timeout: 5000 });
        log.info('Entry deleted', { table, id, user: authUser.username });
        sseBroadcast(authUser.username, 'refresh', { table });
        jsonResp(res, 200, { ok: true });
      } catch (err) {
        log.error('Delete failed', { table, id, error: err.message });
        jsonResp(res, 500, { error: 'Delete failed' });
      }
      return;
    }

    // Reject DELETE to /api/entry/ with invalid table
    if (req.url.startsWith('/api/entry/') && req.method === 'DELETE') {
      jsonResp(res, 400, { error: 'Invalid table' });
      return;
    }

    // GET /api/me — return current user info
    if (req.url === '/api/me') {
      const meUser = getUser(authUser.username);
      jsonResp(res, 200, { username: authUser.username, displayName: authUser.displayName, role: userRole, isOnboarded: meUser ? !!meUser.isOnboarded : false });
      return;
    }

    // GET /api/onboarding-status — check if user has completed onboarding + preferences
    if (req.url === '/api/onboarding-status') {
      const obUser = getUser(authUser.username);
      const rows = dbQuery("SELECT key, value FROM user_preferences", db);
      const prefs = {};
      for (const r of rows) prefs[r.key] = r.value;
      jsonResp(res, 200, { isOnboarded: obUser ? !!obUser.isOnboarded : false, preferences: prefs });
      return;
    }

    // POST /api/onboarding-complete — mark user as onboarded
    if (req.url === '/api/onboarding-complete' && req.method === 'POST') {
      if (!hasMinRole(userRole, 'user')) {
        jsonResp(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      updateUser(authUser.username, { isOnboarded: true });
      jsonResp(res, 200, { ok: true });
      return;
    }

    // GET /api/preferences — return all user preferences from per-user DB
    if (req.url === '/api/preferences' && req.method === 'GET') {
      const rows = dbQuery("SELECT key, value FROM user_preferences", db);
      const prefs = {};
      for (const r of rows) prefs[r.key] = r.value;
      jsonResp(res, 200, prefs);
      return;
    }

    // POST /api/preferences — set a single user preference
    if (req.url === '/api/preferences' && req.method === 'POST') {
      // Defense-in-depth: also checked centrally in RBAC block above
      if (!hasMinRole(userRole, 'user')) {
        jsonResp(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      try {
        const body = await readBody(req, 16384);
        const { key, value } = JSON.parse(body);
        if (!key || typeof key !== 'string' || typeof value !== 'string') {
          jsonResp(res, 400, { error: 'Key and value are required strings' });
          return;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          jsonResp(res, 400, { error: 'Invalid preference key' });
          return;
        }
        if (key.length > 128) {
          jsonResp(res, 400, { error: 'Key too long (max 128 characters)' });
          return;
        }
        const maxValueLen = key === 'meal_templates' ? 8192 : 1024;
        if (value.length > maxValueLen) {
          jsonResp(res, 400, { error: `Value too long (max ${maxValueLen} characters)` });
          return;
        }
        // Validate known preference keys
        const PREF_VALIDATORS = {
          checkin_hour: v => /^\d{1,2}$/.test(v) && parseInt(v) >= 0 && parseInt(v) <= 23,
          daily_calorie_goal: v => /^\d+$/.test(v) && parseInt(v) > 0 && parseInt(v) <= 10000,
          daily_protein_goal: v => /^\d+$/.test(v) && parseInt(v) > 0 && parseInt(v) <= 1000,
          meal_templates: v => {
            try {
              const arr = JSON.parse(v);
              if (!Array.isArray(arr) || arr.length > 20) return false;
              return arr.every(t => typeof t.id === 'string' && /^t_\d+$/.test(t.id) && typeof t.name === 'string' && t.name.length > 0 && t.name.length <= 200 && typeof t.calories === 'number' && typeof t.protein === 'number' && typeof t.carbs === 'number' && typeof t.fat === 'number' && isFinite(t.calories) && isFinite(t.protein) && isFinite(t.carbs) && isFinite(t.fat) && t.calories >= 0 && t.protein >= 0 && t.carbs >= 0 && t.fat >= 0);
            } catch { return false; }
          },
        };
        if (PREF_VALIDATORS[key] && !PREF_VALIDATORS[key](value)) {
          jsonResp(res, 400, { error: 'Invalid value for ' + key });
          return;
        }
        execFileSync('sqlite3', [db, `INSERT INTO user_preferences(key, value) VALUES('${escapeSql(key)}', '${escapeSql(value)}') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now');`], { timeout: 5000 });
        jsonResp(res, 200, { ok: true });
      } catch (err) {
        log.error('Set preference error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to save preference' });
      }
      return;
    }

    // GET /api/templates — read meal templates from user_preferences
    if (req.url === '/api/templates' && req.method === 'GET') {
      try {
        const rows = dbQuery("SELECT value FROM user_preferences WHERE key='meal_templates'", db);
        const templates = rows.length ? JSON.parse(rows[0].value) : [];
        jsonResp(res, 200, { templates });
      } catch {
        jsonResp(res, 200, { templates: [] });
      }
      return;
    }

    // POST /api/templates — save meal templates array
    if (req.url === '/api/templates' && req.method === 'POST') {
      if (!hasMinRole(userRole, 'user')) {
        jsonResp(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      try {
        const body = await readBody(req, 16384);
        const { templates } = JSON.parse(body);
        if (!Array.isArray(templates)) {
          jsonResp(res, 400, { error: 'templates must be an array' });
          return;
        }
        if (templates.length > 20) {
          jsonResp(res, 400, { error: 'Maximum 20 templates allowed' });
          return;
        }
        for (const t of templates) {
          if (typeof t.id !== 'string' || !/^t_\d+$/.test(t.id)) {
            jsonResp(res, 400, { error: 'Invalid template ID format' });
            return;
          }
          if (typeof t.name !== 'string' || !t.name || t.name.length > 200) {
            jsonResp(res, 400, { error: 'Template name must be a string (max 200 chars)' });
            return;
          }
          if (t.description !== undefined && (typeof t.description !== 'string' || t.description.length > 500)) {
            jsonResp(res, 400, { error: 'Template description must be a string (max 500 chars)' });
            return;
          }
          if (typeof t.calories !== 'number' || typeof t.protein !== 'number' || typeof t.carbs !== 'number' || typeof t.fat !== 'number' ||
              !isFinite(t.calories) || !isFinite(t.protein) || !isFinite(t.carbs) || !isFinite(t.fat) ||
              t.calories < 0 || t.protein < 0 || t.carbs < 0 || t.fat < 0) {
            jsonResp(res, 400, { error: 'Template macros must be finite non-negative numbers' });
            return;
          }
        }
        const clean = templates.map(t => ({ id: t.id, name: t.name, description: t.description || '', calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat }));
        const serialized = JSON.stringify(clean);
        if (serialized.length > 8192) {
          jsonResp(res, 400, { error: 'Templates data too large (max 8192 characters)' });
          return;
        }
        execFileSync('sqlite3', [db, `INSERT INTO user_preferences(key, value) VALUES('meal_templates', '${escapeSql(serialized)}') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now');`], { timeout: 5000 });
        jsonResp(res, 200, { ok: true, templates: clean });
      } catch (err) {
        log.error('Save templates error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to save templates' });
      }
      return;
    }

    if (req.url === '/api/feedback' && req.method === 'POST') {
      if (!hasMinRole(userRole, 'user')) {
        jsonResp(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      try {
        const body = await readBody(req, 4096);
        const { category, message, page } = JSON.parse(body);
        if (!message || typeof message !== 'string' || !message.trim()) {
          jsonResp(res, 400, { error: 'Message is required' });
          return;
        }
        const validCategories = ['bug', 'feature', 'other'];
        const cat = validCategories.includes(category) ? category : 'other';
        const msg = message.trim().slice(0, 2000);
        const pg = (typeof page === 'string' ? page : '').slice(0, 100);
        execFileSync('sqlite3', [db, `INSERT INTO feedback (category, message, page) VALUES ('${escapeSql(cat)}', '${escapeSql(msg)}', '${escapeSql(pg)}');`], { timeout: 5000 });
        log.info('Feedback submitted', { user: authUser.username, category: cat });
        jsonResp(res, 201, { ok: true });
      } catch (err) {
        log.error('Feedback error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to submit feedback' });
      }
      return;
    }

    // GET /api/chat/history — return recent chat messages
    if (req.url.startsWith('/api/chat/history')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 200));
      const rows = dbQuery(`SELECT role, content, session_key, created_at FROM chat_history ORDER BY id DESC LIMIT ${limit}`, db);
      jsonResp(res, 200, rows.reverse());
      return;
    }

    // GET /api/logs — list available log dates (newest first)
    if (req.url === '/api/logs') {
      try {
        const sqlDates = dbQuery(
          "SELECT DISTINCT date FROM (SELECT date FROM meals UNION SELECT date FROM hydration UNION SELECT date FROM exercise) ORDER BY date DESC",
          db
        ).map(r => r.date);

        let mdDates = [];
        try {
          mdDates = fs.readdirSync(memoryDir)
            .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
            .map(f => f.replace('.md', ''));
        } catch {}

        const allDates = [...new Set([...sqlDates, ...mdDates])].sort().reverse();
        jsonResp(res, 200, allDates);
      } catch {
        jsonResp(res, 200, []);
      }
      return;
    }

    // GET /api/logs/YYYY-MM-DD — fetch a specific day's data
    const logMatch = req.url.match(/^\/api\/logs\/(\d{4}-\d{2}-\d{2})$/);
    if (logMatch) {
      const date = logMatch[1];
      try {
        const meals = dbQuery(`SELECT id, time, meal, calories, protein, carbs, fat, notes FROM meals WHERE date='${date}' ORDER BY CASE WHEN time LIKE '%AM' THEN 0 ELSE 1 END, CAST(REPLACE(SUBSTR(time,1,INSTR(time,':')-1),'12','0') AS INTEGER) + CASE WHEN time LIKE '%PM' THEN 12 ELSE 0 END, SUBSTR(time,INSTR(time,':')+1,2)`, db);
        const hydration = dbQuery(`SELECT id, time, glass_num FROM hydration WHERE date='${date}' ORDER BY glass_num`, db);
        const exercise = dbQuery(`SELECT id, time, activity, duration, calories_burned, notes, source, distance, avg_heart_rate FROM exercise WHERE date='${date}' ORDER BY CASE WHEN time LIKE '%AM' THEN 0 ELSE 1 END, CAST(REPLACE(SUBSTR(time,1,INSTR(time,':')-1),'12','0') AS INTEGER) + CASE WHEN time LIKE '%PM' THEN 12 ELSE 0 END, SUBSTR(time,INSTR(time,':')+1,2)`, db);

        const sleepRows = dbQuery(`SELECT duration_minutes, notes, source FROM sleep WHERE date='${date}'`, db);
        const health = readHealthFromSqlite(db, date) || parseHealthFromMarkdown(memoryDir, date);

        jsonResp(res, 200, { meals, hydration, exercise, sleep: sleepRows, health });
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // GET /api/nutrition/summary — aggregated daily nutrition for trend charts
    if (req.url.startsWith('/api/nutrition/summary')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const range = url.searchParams.get('range') || '1m';
        const validRanges = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };
        const daysBack = validRanges[range] || 30;
        const d = new Date();
        d.setDate(d.getDate() - daysBack);
        const startDate = d.toISOString().slice(0, 10);
        const todayStr = new Date().toISOString().slice(0, 10);

        const rows = dbQuery(`SELECT date, SUM(calories) AS calories, SUM(CAST(REPLACE(protein,'g','') AS INTEGER)) AS protein, SUM(CAST(REPLACE(carbs,'g','') AS INTEGER)) AS carbs, SUM(CAST(REPLACE(fat,'g','') AS INTEGER)) AS fat FROM meals WHERE date >= '${startDate}' GROUP BY date ORDER BY date ASC`, db);

        const days = rows.map(r => ({
          date: r.date,
          calories: r.calories || 0,
          protein: r.protein || 0,
          carbs: r.carbs || 0,
          fat: r.fat || 0
        }));

        // Averages exclude today
        const past = days.filter(d => d.date !== todayStr);
        const avgCal = past.length ? Math.round(past.reduce((s, d) => s + d.calories, 0) / past.length) : 0;
        const avgProtein = past.length ? Math.round(past.reduce((s, d) => s + d.protein, 0) / past.length) : 0;

        jsonResp(res, 200, { days, avgCal, avgProtein, daysLogged: past.length, range });
      } catch (err) {
        log.error('Nutrition summary error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load nutrition summary' });
      }
      return;
    }

    // GET /api/weight — weight history
    if (req.url === '/api/weight' || req.url.startsWith('/api/weight?')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const range = url.searchParams.get('range') || '';
        const validRanges = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };
        let startDate = null;
        if (validRanges[range]) {
          const d = new Date();
          d.setDate(d.getDate() - validRanges[range]);
          startDate = d.toISOString().slice(0, 10);
        }

        const whereClause = startDate ? ` WHERE date >= '${startDate}'` : '';
        let entries = dbQuery(`SELECT id, date, weight_lbs AS weight, notes FROM weight${whereClause} ORDER BY date ASC`, db);

        if (!entries.length) {
          try {
            const content = fs.readFileSync(path.join(memoryDir, 'WEIGHT.md'), 'utf8');
            const rows = content.split('\n').filter(l => l.startsWith('|') && /\d{4}-\d{2}-\d{2}/.test(l));
            entries = rows.map(r => {
              const cols = r.split('|').map(c => c.trim()).filter(Boolean);
              return { date: cols[0], weight: parseFloat(cols[1]) || null, notes: cols[2] || '' };
            }).filter(e => e.weight);
          } catch {}
        }

        const latest = entries.length ? entries[entries.length - 1] : { weight: null, date: null };
        jsonResp(res, 200, { weight: latest.weight, date: latest.date, history: entries });
      } catch {
        jsonResp(res, 200, { weight: null, date: null, history: [] });
      }
      return;
    }

    // GET /api/exercise — exercise history and stats
    if (req.url === '/api/exercise') {
      try {
        // 1. Recent exercises (last 30)
        const recent = dbQuery("SELECT id, date, time, activity, duration, calories_burned AS calories, notes, source, distance, avg_heart_rate FROM exercise ORDER BY date DESC, rowid DESC LIMIT 30", db);

        // 2. This week's stats (last 7 days)
        const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
        const weekStartStr = weekStart.toISOString().split('T')[0];
        const weeklyStats = dbQuery(`SELECT COUNT(*) AS workouts, COALESCE(SUM(calories_burned),0) AS totalCal, COUNT(DISTINCT activity) AS activities FROM exercise WHERE date >= '${weekStartStr}'`, db);

        // 3. Activity type breakdown (all time)
        const activities = dbQuery("SELECT activity, COUNT(*) AS count, COALESCE(SUM(calories_burned),0) AS totalCal FROM exercise GROUP BY activity ORDER BY count DESC", db);

        // 4. Weekly history for chart (last 8 weeks) — single query
        const eightWeeksAgo = new Date(); eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 55);
        const eightWeeksStr = eightWeeksAgo.toISOString().split('T')[0];
        const weekRows = dbQuery(`SELECT (julianday(date) - julianday('${eightWeeksStr}')) / 7 AS weekNum, MIN(date) AS weekOf, COUNT(*) AS workouts, COALESCE(SUM(calories_burned),0) AS calories FROM exercise WHERE date >= '${eightWeeksStr}' GROUP BY CAST((julianday(date) - julianday('${eightWeeksStr}')) / 7 AS INTEGER) ORDER BY weekNum`, db);
        const weeks = [];
        for (let i = 0; i < 8; i++) {
          const row = weekRows.find(r => Math.floor(r.weekNum) === i);
          const d = new Date(eightWeeksAgo); d.setDate(d.getDate() + i * 7);
          weeks.push({ weekOf: d.toISOString().split('T')[0], workouts: row ? row.workouts : 0, calories: row ? row.calories : 0 });
        }

        jsonResp(res, 200, {
          recent,
          weeklyStats: weeklyStats[0] || { workouts: 0, totalCal: 0, activities: 0 },
          activities,
          weeklyHistory: weeks
        });
      } catch (err) {
        log.error('Exercise data error', { error: err.message });
        jsonResp(res, 200, { recent: [], weeklyStats: { workouts: 0, totalCal: 0, activities: 0 }, activities: [], weeklyHistory: [] });
      }
      return;
    }

    // GET /api/sleep — sleep history and stats
    if (req.url === '/api/sleep' || req.url.startsWith('/api/sleep?')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const range = url.searchParams.get('range') || '1m';
        const validRanges = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };
        const daysBack = validRanges[range] || 30;
        const d = new Date();
        d.setDate(d.getDate() - daysBack);
        const startDate = d.toISOString().slice(0, 10);

        const manualEntries = dbQuery(`SELECT id, date, duration_minutes, notes, source FROM sleep WHERE date >= '${startDate}' ORDER BY date DESC`, db);
        const manualDates = new Set(manualEntries.map(e => e.date));

        const ahEntries = dbQuery(`SELECT date, sleep_minutes FROM apple_health WHERE sleep_minutes IS NOT NULL AND sleep_minutes > 0 AND date >= '${startDate}' ORDER BY date DESC`, db);
        const ahFiltered = ahEntries.filter(e => !manualDates.has(e.date));

        const entries = [
          ...manualEntries.map(e => ({ date: e.date, duration: e.duration_minutes, source: e.source || 'manual', notes: e.notes || '' })),
          ...ahFiltered.map(e => ({ date: e.date, duration: e.sleep_minutes, source: 'apple_health', notes: '' }))
        ].sort((a, b) => b.date.localeCompare(a.date));

        const durations = entries.map(e => e.duration);
        const stats = {
          avgMinutes: durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0,
          minSleep: durations.length ? Math.min(...durations) : 0,
          maxSleep: durations.length ? Math.max(...durations) : 0,
          daysTracked: durations.length
        };

        jsonResp(res, 200, { entries, stats, range });
      } catch (err) {
        log.error('Sleep data error', { error: err.message });
        jsonResp(res, 200, { entries: [], stats: { avgMinutes: 0, minSleep: 0, maxSleep: 0, daysTracked: 0 }, range: '1m' });
      }
      return;
    }

    // GET /api/health/vo2-max — VO2 Max trend data
    if (req.url === '/api/health/vo2-max' || req.url.startsWith('/api/health/vo2-max?')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const range = url.searchParams.get('range') || '3m';
        const validRanges = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };
        const daysBack = validRanges[range] || 90;
        const d = new Date();
        d.setDate(d.getDate() - daysBack);
        const startDate = d.toISOString().slice(0, 10);

        const entries = dbQuery(`SELECT date, vo2_max AS value FROM apple_health WHERE vo2_max IS NOT NULL AND vo2_max > 0 AND date >= '${startDate}' ORDER BY date DESC`, db);
        const values = entries.map(e => e.value);
        const current = values.length ? values[0] : null;
        const avg = values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length * 10) / 10 : null;

        // change7d: difference between latest and value from ~7 days ago
        let change7d = null;
        if (entries.length >= 2) {
          const latest = entries[0];
          const cutoff = new Date(latest.date);
          cutoff.setDate(cutoff.getDate() - 7);
          const cutStr = cutoff.toISOString().slice(0, 10);
          const older = entries.find(e => e.date <= cutStr);
          if (older) change7d = Math.round((latest.value - older.value) * 10) / 10;
        }

        const stats = {
          current,
          avg,
          min: values.length ? Math.round(Math.min(...values) * 10) / 10 : null,
          max: values.length ? Math.round(Math.max(...values) * 10) / 10 : null,
          daysTracked: values.length,
          change7d
        };

        jsonResp(res, 200, { entries, stats, range });
      } catch (err) {
        log.error('VO2 Max data error', { error: err.message });
        jsonResp(res, 200, { entries: [], stats: { current: null, avg: null, min: null, max: null, daysTracked: 0, change7d: null }, range: '3m' });
      }
      return;
    }

    // POST /api/health-sync — receive Apple Health data
    if (req.url === '/api/health-sync' && req.method === 'POST') {
      try {
        const body = await readBody(req, 5 * 1024 * 1024);
        const payload = JSON.parse(body);
        const metrics = payload?.data?.metrics || [];
        const workouts = payload?.data?.workouts || [];
        if (!metrics.length && !workouts.length) {
          jsonResp(res, 400, { ok: false, error: 'No metrics or workouts found' });
          return;
        }

        const byDate = {};
        for (const metric of metrics) {
          const name = metric.name;
          const units = metric.units;
          for (const entry of (metric.data || [])) {
            const date = entry.date?.slice(0, 10);
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            if (!byDate[date]) byDate[date] = {};
            if (!byDate[date][name]) byDate[date][name] = { units, values: [] };
            const val = entry.qty ?? entry.Avg ?? entry.avg ?? null;
            if (val != null) byDate[date][name].values.push(val);
          }
        }

        const synced = [];
        for (const [date, data] of Object.entries(byDate).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
          const agg = {};
          const vals = (n) => data[n]?.values.filter(v => typeof v === 'number' && !isNaN(v)) || [];
          const sum = (n) => vals(n).length ? Math.round(vals(n).reduce((a, b) => a + b, 0)) : null;
          const avg = (n) => vals(n).length ? Math.round(vals(n).reduce((a, b) => a + b, 0) / vals(n).length) : null;
          const last = (n) => vals(n).length ? vals(n)[vals(n).length - 1] : null;
          const kjToCal = (n) => vals(n).length ? Math.round(vals(n).reduce((a, b) => a + b, 0) / 4.184) : null;

          agg.steps = sum('step_count');
          agg.activeCal = kjToCal('active_energy');
          agg.basalEnergy = kjToCal('basal_energy_burned');
          agg.flightsClimbed = sum('flights_climbed');
          agg.heartRate = avg('heart_rate');
          agg.hrv = avg('heart_rate_variability');
          agg.bloodOxygen = last('blood_oxygen_saturation');
          agg.walkingHR = avg('walking_heart_rate_average');
          agg.restingHR = avg('resting_heart_rate');
          agg.vo2Max = last('vo2_max');
          agg.respiratoryRate = (() => { const v = vals('respiratory_rate'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; })();
          agg.distanceWalking = (() => { const v = vals('distance_walking_running'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10 : null; })();
          agg.exerciseTime = sum('apple_exercise_time');
          agg.sleepMinutes = sum('sleep_analysis');

          let section = '\n## Apple Health\n\n| Metric | Value |\n|--------|-------|\n';
          if (agg.steps != null) section += `| Steps | ${agg.steps.toLocaleString()} |\n`;
          if (agg.activeCal != null) section += `| Active Calories | ${agg.activeCal} cal |\n`;
          if (agg.basalEnergy != null) section += `| Basal Energy | ${agg.basalEnergy} cal |\n`;
          if (agg.flightsClimbed != null) section += `| Flights Climbed | ${agg.flightsClimbed} |\n`;
          if (agg.heartRate != null) section += `| Avg Heart Rate | ${agg.heartRate} bpm |\n`;
          if (agg.walkingHR != null) section += `| Walking HR Avg | ${agg.walkingHR} bpm |\n`;
          if (agg.restingHR != null) section += `| Resting HR | ${agg.restingHR} bpm |\n`;
          if (agg.hrv != null) section += `| HRV | ${agg.hrv} ms |\n`;
          if (agg.bloodOxygen != null) section += `| Blood Oxygen | ${agg.bloodOxygen}% |\n`;
          if (agg.vo2Max != null) section += `| VO2 Max | ${agg.vo2Max} mL/kg/min |\n`;
          if (agg.respiratoryRate != null) section += `| Resp Rate | ${agg.respiratoryRate} br/min |\n`;
          if (agg.distanceWalking != null) section += `| Distance | ${agg.distanceWalking} mi |\n`;
          if (agg.exerciseTime != null) section += `| Exercise | ${agg.exerciseTime} min |\n`;
          if (agg.sleepMinutes != null) {
            const sh = Math.floor(agg.sleepMinutes / 60);
            const sm = agg.sleepMinutes % 60;
            section += `| Sleep | ${sh}h ${sm}m |\n`;
          }

          // Add workouts sub-section to markdown if any exist for this date
          const dateWorkouts = workouts.filter(w => w.start?.slice(0, 10) === date);
          if (dateWorkouts.length) {
            section += '\n### Workouts\n| Time | Activity | Duration | Calories | Distance | HR |\n|------|----------|----------|----------|----------|----|\n';
            for (const w of dateWorkouts) {
              const wDate = new Date(w.start);
              const wHour = wDate.getHours();
              const wMin = wDate.getMinutes();
              const wAmPm = wHour >= 12 ? 'PM' : 'AM';
              const wH12 = wHour % 12 || 12;
              const wTimeStr = `${wH12}:${String(wMin).padStart(2, '0')} ${wAmPm}`;
              const mdSafe = (s) => String(s).replace(/[|\n\r]/g, ' ');
              const wActivity = mdSafe((WORKOUT_TYPES[w.type] || w.type || 'Other').slice(0, 100));
              const wDur = w.duration > 0 ? `${Math.round(w.duration)} min` : '--';
              const wCal = w.calories > 0 ? `${Math.round(w.calories)} cal` : '--';
              const wDistUnit = ['mi', 'km'].includes(w.distance_unit) ? w.distance_unit : 'mi';
              const wDist = w.distance > 0 ? `${Math.round(w.distance * 10) / 10} ${wDistUnit}` : '--';
              const wHr = w.heart_rate_avg > 0 ? `${Math.round(w.heart_rate_avg)} bpm` : '--';
              section += `| ${wTimeStr} | ${wActivity} | ${wDur} | ${wCal} | ${wDist} | ${wHr} |\n`;
            }
          }

          const filePath = path.join(memoryDir, `${date}.md`);
          let content = '';
          try { content = fs.readFileSync(filePath, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') log.warn('Health sync file read error', { file: filePath, error: err.message }); }

          if (content) {
            if (content.includes('## Apple Health')) {
              content = content.replace(/\n## Apple Health\n[\s\S]*?(?=\n## |\n$|$)/, section);
            } else if (content.includes('## Daily Totals')) {
              content = content.replace('## Daily Totals', section + '\n## Daily Totals');
            } else {
              content += section;
            }
          } else {
            content = `# ${date}\n${section}`;
          }

          fs.writeFileSync(filePath, content);

          // Upsert into apple_health SQLite table
          try {
            const cols = ['date'];
            const vals = [`'${date}'`];
            const updates = [];
            const addCol = (name, val) => { if (val != null) { cols.push(name); vals.push(val); updates.push(`${name}=${val}`); } };
            addCol('steps', agg.steps);
            addCol('active_cal', agg.activeCal);
            addCol('basal_energy', agg.basalEnergy);
            addCol('flights_climbed', agg.flightsClimbed);
            addCol('heart_rate', agg.heartRate);
            addCol('hrv', agg.hrv);
            addCol('blood_oxygen', agg.bloodOxygen);
            addCol('walking_hr', agg.walkingHR);
            addCol('resting_hr', agg.restingHR);
            addCol('vo2_max', agg.vo2Max);
            addCol('respiratory_rate', agg.respiratoryRate);
            addCol('distance_walking', agg.distanceWalking);
            addCol('exercise_time', agg.exerciseTime);
            addCol('sleep_minutes', agg.sleepMinutes);
            if (updates.length) {
              const sql = `INSERT INTO apple_health (${cols.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT(date) DO UPDATE SET ${updates.join(', ')};`;
              execFileSync('sqlite3', [db, sql], { timeout: 5000 });
            }
          } catch (err) {
            log.warn('Health sync SQLite insert failed', { date, error: err.message });
          }

          synced.push(date);
        }

        // Handle workout data from Apple Health
        let workoutsSynced = 0;
        const workoutDates = new Set();
        if (workouts.length) {
          // Helper: parse time string like "7:30 AM" to minutes since midnight
          const timeToMinutes = (t) => {
            const m = String(t).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
            if (!m) return -1;
            let h = parseInt(m[1]);
            const min = parseInt(m[2]);
            const ampm = m[3].toUpperCase();
            if (ampm === 'PM' && h !== 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            return h * 60 + min;
          };

          // Helper: extract numeric value from flat number or nested {qty, units} object
          const numVal = (v) => { if (v == null) return 0; if (typeof v === 'object' && v.qty != null) return parseFloat(v.qty); return parseFloat(v); };
          const strUnit = (v, fallback) => { if (v && typeof v === 'object' && v.units) return v.units; return fallback; };

          for (const w of workouts) {
            const wDate = w.start?.slice(0, 10);
            if (!wDate || !/^\d{4}-\d{2}-\d{2}$/.test(wDate)) continue;
            // Health Auto Export uses "name" for activity; our doc uses "type"
            const rawType = w.name || w.type || '';
            const wType = (WORKOUT_TYPES[rawType] || String(rawType)).slice(0, 100);
            if (!wType) continue;
            let dur = parseFloat(w.duration);
            if (!isFinite(dur) || dur <= 0) continue;
            // Health Auto Export sends duration in seconds; convert if > 200 (heuristic: no workout is 200+ minutes but many are 200+ seconds)
            if (dur > 200) dur = dur / 60;

            // Format time from start — handles both ISO 8601 and "YYYY-MM-DD HH:MM:SS +0000"
            const startDt = new Date(w.start);
            if (isNaN(startDt.getTime())) continue;
            const sHour = startDt.getHours();
            const sMin = startDt.getMinutes();
            const sAmPm = sHour >= 12 ? 'PM' : 'AM';
            const sH12 = sHour % 12 || 12;
            const wTime = `${sH12}:${String(sMin).padStart(2, '0')} ${sAmPm}`;
            const wMinutes = sHour * 60 + sMin;

            const wDuration = `${Math.round(dur)} min`;
            // Calories: check activeEnergyBurned, activeEnergy, totalEnergyBurned, totalEnergy, or flat calories
            // Health Auto Export sends energy in kJ; convert to kcal (1 kcal = 4.184 kJ)
            const calSource = [w.activeEnergyBurned, w.activeEnergy, w.totalEnergyBurned, w.totalEnergy].find(v => numVal(v) > 0);
            const calUnits = calSource && typeof calSource === 'object' ? calSource.units : '';
            let rawCal = calSource ? numVal(calSource) : numVal(w.calories);
            if (calUnits && calUnits.toLowerCase() === 'kj') rawCal = rawCal / 4.184;
            const wCal = isFinite(rawCal) && rawCal > 0 ? Math.round(rawCal) : 0;
            // Distance: check distance.qty or flat distance
            const rawDist = numVal(w.distance);
            const rawDistUnit = strUnit(w.distance, w.distance_unit || 'mi');
            const wDistUnit = ['mi', 'km', 'yd', 'm'].includes(rawDistUnit) ? rawDistUnit : 'mi';
            const wDist = isFinite(rawDist) && rawDist > 0 ? `${Math.round(rawDist * 10) / 10} ${wDistUnit}` : '';
            // Heart rate: check heartRateAvg, avgHeartRate, or heart_rate_avg (flat or nested)
            const rawHr = numVal(w.heartRateAvg) || numVal(w.avgHeartRate) || numVal(w.heart_rate_avg);
            const wHr = isFinite(rawHr) && rawHr > 0 ? Math.round(rawHr) : 0;
            const wNotes = (w.name || '').slice(0, 200);

            // Dedup: check existing exercise rows for same date
            try {
              const existing = dbQuery(`SELECT time, activity FROM exercise WHERE date='${escapeSql(wDate)}'`, db);
              let isDup = false;
              for (const row of existing) {
                if (row.activity.toLowerCase() === wType.toLowerCase()) {
                  const existingMin = timeToMinutes(row.time);
                  if (existingMin >= 0 && Math.abs(existingMin - wMinutes) <= 30) {
                    isDup = true;
                    break;
                  }
                }
              }
              if (isDup) continue;
            } catch {}

            // Insert workout into exercise table
            try {
              execFileSync('sqlite3', [db, `INSERT INTO exercise (date, time, activity, duration, calories_burned, notes, source, distance, avg_heart_rate) VALUES ('${escapeSql(wDate)}', '${escapeSql(wTime)}', '${escapeSql(wType)}', '${escapeSql(wDuration)}', ${wCal}, '${escapeSql(wNotes)}', 'apple_health', '${escapeSql(wDist)}', ${wHr});`], { timeout: 5000 });
              workoutsSynced++;
              workoutDates.add(wDate);
            } catch (err) {
              log.warn('Health sync workout insert failed', { date: wDate, activity: wType, error: err.message });
            }
          }
          if (workoutsSynced > 0) {
            log.info('Health sync workouts', { user: authUser.username, count: workoutsSynced, dates: [...workoutDates] });
          }
        }

        // Handle weight data
        const weightMetric = metrics.find(m => m.name === 'body_mass' || m.name === 'weight');
        if (weightMetric) {
          for (const entry of (weightMetric.data || [])) {
            const date = entry.date?.slice(0, 10);
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const lbs = weightMetric.units === 'kg' ? Math.round(entry.qty * 2.20462 * 10) / 10 : Math.round(entry.qty * 10) / 10;
            if (!isFinite(lbs) || lbs <= 0) continue;
            if (date && lbs) {
              try {
                execFileSync('sqlite3', [db, `INSERT INTO weight (date, weight_lbs, notes) VALUES ('${escapeSql(date)}', ${lbs}, 'From Apple Health') ON CONFLICT(date) DO UPDATE SET weight_lbs=${lbs}, notes='From Apple Health';`], { timeout: 5000 });
              } catch (err) { log.warn('Health sync weight insert failed', { date, lbs, error: err.message }); }
            }
          }

          const weightFile = path.join(memoryDir, 'WEIGHT.md');
          let weightContent = '';
          try { weightContent = fs.readFileSync(weightFile, 'utf8'); } catch {}
          if (!weightContent) {
            weightContent = '# Weight Log\n\n| Date | Weight | Notes |\n|------|--------|-------|\n';
          }
          for (const entry of (weightMetric.data || [])) {
            const date = entry.date?.slice(0, 10);
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const lbs = weightMetric.units === 'kg' ? Math.round(entry.qty * 2.20462 * 10) / 10 : Math.round(entry.qty * 10) / 10;
            if (date && lbs && !weightContent.includes(date)) {
              weightContent += `| ${date} | ${lbs} lbs | From Apple Health |\n`;
            }
          }
          fs.writeFileSync(weightFile, weightContent);
        }

        jsonResp(res, 200, { ok: true, synced, count: synced.length });
        sseBroadcast(authUser.username, 'data-updated', { source: 'health-sync' });
        log.info('Health sync complete', { user: authUser.username, days: synced.length, dates: synced });
      } catch (err) {
        log.error('Health sync error', { error: err.message });
        jsonResp(res, 500, { ok: false, error: 'Health sync failed' });
      }
      return;
    }

    // GET /api/goals — current goals from user_preferences
    if (req.url === '/api/goals') {
      try {
        const rows = execFileSync('sqlite3', [db, "SELECT key, value FROM user_preferences WHERE key LIKE '%_goal' OR key LIKE 'primary_%' ORDER BY key;"], { timeout: 5000 }).toString().trim();
        const goals = {};
        const keyMap = {
          'daily_calorie_goal': 'Daily Calories',
          'daily_protein_goal': 'Daily Protein',
          'exercise_days_goal': 'Exercise Days'
        };
        for (const line of rows.split('\n')) {
          if (!line) continue;
          const [key, val] = line.split('|');
          const displayName = keyMap[key] || key;
          const numVal = parseFloat(val) || 0;
          // Infer unit from key name
          let unit = '';
          if (key.includes('calorie')) unit = 'cal';
          else if (key.includes('protein')) unit = 'g';
          else if (key.includes('days')) unit = 'days/week';
          goals[displayName] = { target: numVal, unit };
        }
        jsonResp(res, 200, goals);
      } catch {
        jsonResp(res, 200, {});
      }
      return;
    }

    // GET /api/streaks — current streaks from SQLite
    if (req.url === '/api/streaks') {
      try {
        const rows = execFileSync('sqlite3', [db, "SELECT metric, current, best, last_active FROM streaks ORDER BY metric;"], { timeout: 5000 }).toString().trim();
        const streaks = [];
        const nameMap = { 'meal_logging': 'Meal Logging', 'exercise': 'Exercise', 'hydration': 'Hydration' };
        for (const line of rows.split('\n')) {
          if (!line) continue;
          const parts = line.split('|');
          streaks.push({
            metric: nameMap[parts[0]] || parts[0],
            current: parseInt(parts[1]) || 0,
            best: parseInt(parts[2]) || 0,
            lastActive: parts[3] || '\u2014'
          });
        }
        jsonResp(res, 200, { streaks });
      } catch {
        jsonResp(res, 200, { streaks: [] });
      }
      return;
    }

    // GET /api/export — CSV or JSON export of all user data
    if (req.url?.startsWith('/api/export') && req.method === 'GET') {
      if (!hasMinRole(authUser.role, 'user')) { jsonResp(res, 403, { error: 'Forbidden' }); return; }
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const format = params.get('format') || 'json';
        const meals = dbQuery('SELECT date, time, meal, calories, protein, carbs, fat, notes FROM meals ORDER BY date, time', db);
        const hydration = dbQuery('SELECT date, time, glass_num FROM hydration ORDER BY date, time', db);
        const exercise = dbQuery('SELECT date, time, activity, duration, calories_burned, notes, source, distance, avg_heart_rate FROM exercise ORDER BY date, time', db);
        const weight = dbQuery('SELECT date, weight_lbs, notes FROM weight ORDER BY date', db);
        const sleep = dbQuery('SELECT date, duration_minutes, notes, source FROM sleep ORDER BY date', db);

        if (format === 'csv') {
          let csv = 'Table,Date,Time,Name,Calories,Protein,Carbs,Fat,Notes,Source,Distance,AvgHeartRate\n';
          for (const m of meals) csv += `Meal,${m.date},${m.time},"${(m.meal || '').replace(/"/g, '""')}",${m.calories || 0},${m.protein || ''},${m.carbs || ''},${m.fat || ''},"${(m.notes || '').replace(/"/g, '""')}",,,\n`;
          for (const h of hydration) csv += `Hydration,${h.date},${h.time},Glass ${h.glass_num},,,,,,,,\n`;
          for (const e of exercise) csv += `Exercise,${e.date},${e.time},"${(e.activity || '').replace(/"/g, '""')}",${e.calories_burned || ''},,,,"${(e.notes || '').replace(/"/g, '""')}",${e.source || 'manual'},"${(e.distance || '').replace(/"/g, '""')}",${e.avg_heart_rate || 0}\n`;
          for (const w of weight) csv += `Weight,${w.date},,${w.weight_lbs} lbs,,,,"${(w.notes || '').replace(/"/g, '""')}",,,\n`;
          for (const s of sleep) csv += `Sleep,${s.date},,${s.duration_minutes} min,,,,,"${(s.notes || '').replace(/"/g, '""')}",,,\n`;
          res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="carlos-export.csv"' });
          res.end(csv);
        } else {
          jsonResp(res, 200, { meals, hydration, exercise, weight, sleep });
        }
      } catch (err) {
        log.error('Export error', { error: err.message });
        jsonResp(res, 500, { error: 'Export failed' });
      }
      return;
    }

    // GET /api/summary — weekly summary
    if (req.url === '/api/summary') {
      try {
        const dates = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(); d.setDate(d.getDate() - i);
          dates.push(d.toISOString().slice(0, 10));
        }

        const days = [];
        for (const date of dates) {
          const day = { date, calories: 0, protein: 0, carbs: 0, fat: 0, hasMeals: false, hasExercise: false, hydration: 0, health: {} };

          const meals = dbQuery(`SELECT calories, protein, carbs, fat FROM meals WHERE date='${date}'`, db);
          for (const m of meals) {
            day.calories += m.calories || 0;
            day.protein += parseInt(String(m.protein).replace(/[^0-9]/g, '')) || 0;
            day.carbs += parseInt(String(m.carbs).replace(/[^0-9]/g, '')) || 0;
            day.fat += parseInt(String(m.fat).replace(/[^0-9]/g, '')) || 0;
            day.hasMeals = true;
          }

          const exerciseCount = dbValue(`SELECT COUNT(*) FROM exercise WHERE date='${date}'`, db);
          if (parseInt(exerciseCount) > 0) day.hasExercise = true;

          const hydrationCount = dbValue(`SELECT COUNT(*) FROM hydration WHERE date='${date}'`, db);
          day.hydration = parseInt(hydrationCount) || 0;

          const sleepRow = dbQuery(`SELECT duration_minutes FROM sleep WHERE date='${date}'`, db);
          if (sleepRow.length) {
            day.sleepMinutes = sleepRow[0].duration_minutes;
          } else {
            const ahSleep = dbQuery(`SELECT sleep_minutes FROM apple_health WHERE date='${date}' AND sleep_minutes IS NOT NULL AND sleep_minutes > 0`, db);
            day.sleepMinutes = ahSleep.length ? ahSleep[0].sleep_minutes : 0;
          }

          day.health = readHealthFromSqlite(db, date) || parseHealthFromMarkdown(memoryDir, date);

          days.push(day);
        }

        const todayStr = dates[dates.length - 1];
        const pastWithMeals = days.filter(d => d.hasMeals && d.date !== todayStr);
        const avgCal = pastWithMeals.length ? Math.round(pastWithMeals.reduce((s, d) => s + d.calories, 0) / pastWithMeals.length) : 0;
        const avgProtein = pastWithMeals.length ? Math.round(pastWithMeals.reduce((s, d) => s + d.protein, 0) / pastWithMeals.length) : 0;
        const exerciseDays = days.filter(d => d.hasExercise).length;
        const today = days[days.length - 1];

        jsonResp(res, 200, { days, today, avgCal, avgProtein, exerciseDays, daysLogged: pastWithMeals.length });
      } catch (err) {
        log.error('Summary error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load summary' });
      }
      return;
    }

    // POST /api/chat — proxy to OpenClaw Gateway via WebSocket (SSE streaming)
    if (req.url === '/api/chat' && req.method === 'POST') {
      try {
        const body = await readBody(req, 1 * 1024 * 1024);
        const { message, image, sessionKey: clientSessionKey } = JSON.parse(body);
        if ((!message || !message.trim()) && !image) {
          jsonResp(res, 400, { error: 'Message or image is required' });
          return;
        }

        // Use client-provided sessionKey for conversation continuity, or generate a new one
        // Validate client key: must match expected prefix and safe characters only
        let sessionKey;
        const expectedPrefix = `agent:carlos:${authUser.username}-`;
        if (clientSessionKey && clientSessionKey.startsWith(expectedPrefix) && /^[a-zA-Z0-9:_-]+$/.test(clientSessionKey)) {
          sessionKey = clientSessionKey;
        } else {
          sessionKey = `${expectedPrefix}${Date.now()}`;
        }

        const chatMessage = (message || (image ? 'What is this?' : '')).trim();

        // Save user message to chat history
        try {
          execFileSync('sqlite3', [db, `INSERT INTO chat_history (role, content, session_key) VALUES ('user', '${escapeSql(chatMessage)}', '${escapeSql(sessionKey)}');`], { timeout: 5000 });
        } catch (err) {
          log.error('Failed to save user chat message', { error: err.message });
        }

        // Parse image data URL into gateway attachment format
        let attachments;
        if (image) {
          const match = String(image).match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            attachments = [{ type: 'image', mimeType: match[1], content: match[2] }];
          }
        }

        const gwHost = process.env.OPENCLAW_GATEWAY_HOST || 'localhost';
        const gwPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
        const gwToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
        const gwUrl = `ws://${gwHost}:${gwPort}`;

        // Start SSE stream
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        let finished = false;
        const sseSend = (event, data) => {
          if (finished) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const sseEnd = (event, data) => {
          if (finished) return;
          finished = true;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          res.end();
        };

        const gwOrigin = `http://${gwHost}:${gwPort}`;
        const ws = (WebSocketImpl !== globalThis.WebSocket)
          ? new WebSocketImpl(gwUrl, { origin: gwOrigin })
          : new WebSocketImpl(gwUrl);

        const chatTimeout = setTimeout(() => {
          sseEnd('error', { error: 'Carlos took too long to respond. Try again.' });
          try { ws.close(); } catch {}
        }, 180000);

        let lastText = '';

        const onMsg = (raw) => {
          const data = typeof raw === 'string' ? raw : (raw.data || raw.toString());
          let msg;
          try { msg = JSON.parse(data); } catch { return; }

          if (msg.event === 'connect.challenge') {
            ws.send(JSON.stringify({
              type: 'req', id: crypto.randomUUID(), method: 'connect',
              params: {
                minProtocol: 3, maxProtocol: 3,
                client: { id: 'openclaw-control-ui', displayName: 'Carlos Dashboard', version: '1.0', platform: 'linux', mode: 'ui' },
                caps: [], auth: { token: gwToken }, role: 'operator',
                scopes: ['operator.admin', 'operator.write', 'operator.read']
              }
            }));
            return;
          }

          if (msg.ok === true && msg.payload?.type === 'hello-ok') {
            sseSend('status', { status: 'connected' });
            const chatParams = {
              sessionKey,
              message: chatMessage,
              idempotencyKey: crypto.randomUUID()
            };
            if (attachments) chatParams.attachments = attachments;
            ws.send(JSON.stringify({
              type: 'req', id: crypto.randomUUID(), method: 'chat.send',
              params: chatParams
            }));
            return;
          }

          if (msg.event === 'agent') {
            const p = msg.payload;
            if (p?.stream === 'assistant' && p?.data?.text) {
              const fullText = p.data.text;
              if (fullText.length > lastText.length) {
                const delta = fullText.slice(lastText.length);
                sseSend('delta', { delta });
                lastText = fullText;
              }
            }
            if (p?.stream === 'lifecycle' && p?.data?.phase === 'start') {
              sseSend('status', { status: 'thinking' });
            }
            return;
          }

          if (msg.event === 'chat') {
            const p = msg.payload;
            if (p?.state === 'final') {
              let finalText = lastText;
              const contents = p?.message?.content || [];
              for (const c of contents) {
                if (c.type === 'text' && c.text) finalText = c.text;
              }
              if (finalText.length > lastText.length) {
                sseSend('delta', { delta: finalText.slice(lastText.length) });
              }
              // Save assistant message to chat history (truncate to 50KB)
              try {
                const replyToSave = (finalText || 'No response received.').slice(0, 50000);
                execFileSync('sqlite3', [db, `INSERT INTO chat_history (role, content, session_key) VALUES ('assistant', '${escapeSql(replyToSave)}', '${escapeSql(sessionKey)}');`], { timeout: 5000 });
              } catch (err) {
                log.error('Failed to save assistant chat message', { error: err.message });
              }
              clearTimeout(chatTimeout);
              sseEnd('done', { reply: finalText || 'No response received.', sessionKey });
              sseBroadcast(authUser.username, 'data-updated', { source: 'chat' });
              try { ws.close(); } catch {}
            } else if (p?.state === 'error') {
              clearTimeout(chatTimeout);
              sseEnd('error', { error: p.errorMessage || p.error || 'Carlos encountered an error.' });
              try { ws.close(); } catch {}
            }
            return;
          }

          if (msg.ok === false && msg.error) {
            clearTimeout(chatTimeout);
            sseEnd('error', { error: `Gateway error: ${msg.error.message || msg.error.code || 'Unknown'}` });
            try { ws.close(); } catch {}
          }
        };

        if (WebSocketImpl === globalThis.WebSocket) {
          ws.onmessage = onMsg;
          ws.onerror = (e) => { clearTimeout(chatTimeout); if (Sentry) Sentry.captureException(e.error || new Error('WebSocket gateway error')); sseEnd('error', { error: 'Could not reach Carlos. Is OpenClaw running?' }); };
          ws.onclose = () => { clearTimeout(chatTimeout); sseEnd('error', { error: 'Gateway connection closed unexpectedly.' }); };
        } else {
          ws.on('message', onMsg);
          ws.on('error', (err) => { clearTimeout(chatTimeout); if (Sentry) Sentry.captureException(err); sseEnd('error', { error: 'Could not reach Carlos. Is OpenClaw running?' }); });
          ws.on('close', () => { clearTimeout(chatTimeout); sseEnd('error', { error: 'Gateway connection closed unexpectedly.' }); });
        }
      } catch (err) {
        if (!res.headersSent) {
          jsonResp(res, 400, { error: 'Invalid request body' });
        }
      }
      return;
    }

    // GET /api/tips — health tips from RSS feeds
    if (req.url === '/api/tips') {
      const tipsFile = path.join(__dirname, 'tips.json');
      try {
        const content = fs.readFileSync(tipsFile, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(content);
      } catch {
        jsonResp(res, 200, { tips: [] });
      }
      return;
    }

    // Unknown API route
    jsonResp(res, 404, { error: 'Not found' });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Process-level error handlers (Sentry capture + structured log)
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  if (Sentry) { Sentry.captureException(err); Sentry.flush(2000).then(() => process.exit(1)); }
  else process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { error: String(reason) });
  if (Sentry) Sentry.captureException(reason);
});

const HOST = process.env.CARLOS_HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  log.info('Carlos dashboard started', { host: HOST, port: PORT, dataDir: DATA_DIR, memoryBase: MEMORY_BASE });
});
