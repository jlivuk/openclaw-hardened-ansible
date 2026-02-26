// Sentry error tracking (graceful: null when package missing or no DSN)
let Sentry;
try {
  Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'production',
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

const PORT = process.env.VERA_PORT || 8081;
const DATA_DIR = process.env.VERA_DATA_DIR || path.join(process.env.HOME, 'vera-dashboard');
const MEMORY_BASE = process.env.VERA_MEMORY_BASE || path.join(process.env.HOME, '.openclaw/workspace-vera/memory');
const DASHBOARD = path.join(__dirname, 'index.html');

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

// Static asset cache
let cachedDashboard = null;
function loadStaticAssets() {
  try { cachedDashboard = fs.readFileSync(DASHBOARD, 'utf8'); } catch { cachedDashboard = null; }
}
loadStaticAssets();
try { fs.watch(__dirname, (ev, fn) => { if (fn === 'index.html') loadStaticAssets(); }); } catch {}

// SSE connections for live refresh (per-user)
const sseClients = new Map();

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
  return {
    db: path.join(DATA_DIR, username, 'vera.db'),
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
  } catch {
    return '';
  }
}

// Helper: build a greeting string with time-of-day and summary
function buildGreeting(displayName, data) {
  const hour = new Date().getHours();
  const timeOfDay = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : 'evening';
  const name = displayName || 'there';
  let summary;
  if (data.overdueCount > 0) {
    summary = `You have ${data.overdueCount} overdue item${data.overdueCount > 1 ? 's' : ''}.`;
  } else if (data.todayCount > 0) {
    summary = `You have ${data.todayCount} task${data.todayCount > 1 ? 's' : ''} scheduled today.`;
  } else if (data.upcomingCount > 0 && data.nextUpcoming) {
    const dueDate = new Date(data.nextUpcoming.next_due + 'T00:00:00');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    summary = `${data.nextUpcoming.task} is coming up on ${days[dueDate.getDay()]}.`;
  } else {
    summary = "Everything's on track.";
  }
  return `Good ${timeOfDay}, ${name}. ${summary}`;
}

// Home Assistant API client
async function haFetch(baseUrl, token, path, opts = {}) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url.toString(), {
      ...opts,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, status: resp.status, error: text || resp.statusText };
    }
    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'Connection timed out' : err.message };
  }
}

// Helper: get Home Assistant credentials from user preferences
function getHaCredentials(db) {
  const rows = dbQuery("SELECT key, value FROM user_preferences WHERE key IN ('ha_url', 'ha_token')", db);
  const prefs = {};
  for (const r of rows) prefs[r.key] = r.value;
  return { url: prefs.ha_url || '', token: prefs.ha_token || '' };
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
  }
}

function provisionSingleUser(username) {
  const { db, memoryDir } = userPaths(username);
  try { fs.mkdirSync(path.dirname(db), { recursive: true }); } catch {}
  try { fs.mkdirSync(memoryDir, { recursive: true }); } catch {}
  if (!fs.existsSync(db)) {
    try {
      execFileSync('sqlite3', [db, `
        CREATE TABLE IF NOT EXISTS appliances (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, location TEXT DEFAULT '', brand TEXT DEFAULT '', model TEXT DEFAULT '', serial_number TEXT DEFAULT '', purchase_date TEXT DEFAULT '', warranty_expires TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS maintenance_schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, appliance_id INTEGER, interval_days INTEGER NOT NULL, last_completed TEXT, next_due TEXT NOT NULL, notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (appliance_id) REFERENCES appliances(id));
        CREATE INDEX IF NOT EXISTS idx_schedule_next_due ON maintenance_schedule(next_due);
        CREATE TABLE IF NOT EXISTS maintenance_log (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, task TEXT NOT NULL, appliance_id INTEGER, cost REAL DEFAULT 0, contractor TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (appliance_id) REFERENCES appliances(id));
        CREATE INDEX IF NOT EXISTS idx_maintenance_log_date ON maintenance_log(date);
        CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, session_key TEXT, created_at TEXT DEFAULT (datetime('now')));
        CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_key);
        CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, message TEXT NOT NULL, page TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS streaks (metric TEXT PRIMARY KEY, current INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_active TEXT NOT NULL DEFAULT '\u2014');
        CREATE TABLE IF NOT EXISTS seasonal_checklists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE, season TEXT NOT NULL DEFAULT '', is_template INTEGER NOT NULL DEFAULT 0, template_id INTEGER, year INTEGER, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (template_id) REFERENCES seasonal_checklists(id));
        CREATE TABLE IF NOT EXISTS checklist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, checklist_id INTEGER NOT NULL, task TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, completed_at TEXT, FOREIGN KEY (checklist_id) REFERENCES seasonal_checklists(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id);
        INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Winterization', 'winterization', 'fall', 1);
        INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Spring Check-up', 'spring-checkup', 'spring', 1);
        INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Hurricane Prep', 'hurricane-prep', 'summer', 1);
        INSERT OR IGNORE INTO seasonal_checklists (name, slug, season, is_template) VALUES ('Fall Fire Prevention', 'fall-fire-prevention', 'fall', 1);
      `], { timeout: 5000 });
      // Seed checklist items (separate call to use subqueries)
      try {
        const seedItems = [
          ['winterization', ['Insulate exposed pipes','Disconnect and drain outdoor hoses','Schedule furnace inspection','Clean gutters and downspouts','Check weather stripping on doors and windows','Test heating system and replace filter','Reverse ceiling fan direction to clockwise','Seal gaps and cracks in foundation','Stock winter emergency supplies']],
          ['spring-checkup', ['Inspect roof for winter damage','Service AC unit before summer','Check exterior paint and siding for damage','Test smoke and CO detectors','Clean gutters and check drainage','Inspect deck and fence for rot or damage','Check window and door screens','Test sprinkler system and outdoor faucets','Apply pre-emergent weed treatment to lawn']],
          ['hurricane-prep', ['Test and install storm shutters','Test generator and stock fuel','Trim trees and remove dead branches','Stock emergency water and food supplies','Secure outdoor furniture and loose items','Clear storm drains and gutters','Review insurance policies and document valuables','Prepare evacuation plan and emergency kit']],
          ['fall-fire-prevention', ['Schedule chimney cleaning and inspection','Test all smoke detectors and replace batteries','Clean dryer vent and lint trap','Inspect electrical cords and outlets','Check fire extinguishers (charge and expiry)','Clear leaves and debris from roof and gutters','Review and practice family fire escape plan','Store firewood at least 30 feet from house']]
        ];
        let seedSql = '';
        for (const [slug, items] of seedItems) {
          for (let i = 0; i < items.length; i++) {
            const task = items[i].replace(/'/g, "''");
            seedSql += `INSERT OR IGNORE INTO checklist_items (checklist_id, task, sort_order) SELECT id, '${task}', ${i + 1} FROM seasonal_checklists WHERE slug='${slug}' AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE checklist_id=(SELECT id FROM seasonal_checklists WHERE slug='${slug}') AND task='${task}');\n`;
          }
        }
        execFileSync('sqlite3', [db, seedSql], { timeout: 5000 });
      } catch (seedErr) {
        log.warn('Checklist seed skipped', { user: username, error: seedErr.message });
      }
      log.info('Provisioned DB', { user: username });
    } catch (err) {
      log.error('Failed to provision DB', { user: username, error: err.message });
    }
  }
}

provisionUsers();

// Login rate limiting: max 5 failed attempts per IP per 15 minutes
const loginAttempts = new Map();
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  entry.times = entry.times.filter(t => now - t < LOGIN_WINDOW_MS);
  if (!entry.times.length) { loginAttempts.delete(ip); return true; }
  return entry.times.length < LOGIN_MAX;
}
function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { times: [] };
  entry.times.push(Date.now());
  loginAttempts.set(ip, entry);
}
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
    });
    res.end();
    return;
  }

  // --- Static files ---
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

  if (req.url === '/vera.png') {
    try {
      const img = fs.readFileSync(path.join(__dirname, 'vera.png'));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // --- POST /api/login ---
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

  // --- POST /api/change-password ---
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

  // --- GET /api/events — SSE stream ---
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
      req.url === '/api/chat' ||
      req.url.startsWith('/api/chat/') ||
      (req.url === '/api/preferences' && req.method === 'POST') ||
      (req.url === '/api/feedback' && req.method === 'POST') ||
      (req.url === '/api/appliances' && req.method === 'POST') ||
      (req.url === '/api/schedule' && req.method === 'POST') ||
      (req.url === '/api/maintenance' && req.method === 'POST') ||
      (req.url === '/api/ha/call-service' && req.method === 'POST') ||
      (req.url === '/api/checklists/activate' && req.method === 'POST') ||
      req.url.match(/^\/api\/checklists\/\d+\/check\/\d+$/) ||
      req.url.match(/^\/api\/checklists\/\d+\/uncheck\/\d+$/) ||
      (req.url.match(/^\/api\/checklists\/\d+$/) && req.method === 'DELETE') ||
      req.url.match(/^\/api\/appliances\/\d+$/) ||
      req.url.match(/^\/api\/schedule\/\d+$/) ||
      (req.url.match(/^\/api\/schedule\/\d+\/complete$/) && req.method === 'POST')
    )) {
      jsonResp(res, 403, { error: 'Insufficient permissions' });
      return;
    }

    // --- Admin routes ---
    if (req.url.startsWith('/api/admin/')) {
      if (!hasMinRole(userRole, 'admin')) {
        jsonResp(res, 403, { error: 'Admin access required' });
        return;
      }

      if (req.url === '/api/admin/users' && req.method === 'GET') {
        const users = listUsers().map(u => { const { apiKey, ...safe } = u; return safe; });
        jsonResp(res, 200, { users });
        return;
      }

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
          const newRole = validRoles.includes(role) ? role : 'user';
          if (getUser(username)) {
            jsonResp(res, 409, { error: 'User already exists' });
            return;
          }
          const { hash, salt } = hashPassword(password);
          const apiKey = crypto.randomBytes(24).toString('hex');
          createUser(username, displayName || username, hash, salt, newRole, apiKey);
          provisionSingleUser(username);
          log.info('User created', { user: username, role: newRole, by: authUser.username });
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

      const adminUserMatch = req.url.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)(\/reset-password)?$/);
      if (adminUserMatch) {
        const targetUsername = adminUserMatch[1];
        const isResetPassword = adminUserMatch[2] === '/reset-password';

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

        if (!isResetPassword && req.method === 'DELETE') {
          const target = getUser(targetUsername);
          if (!target) {
            jsonResp(res, 404, { error: 'User not found' });
            return;
          }
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

      jsonResp(res, 404, { error: 'Not found' });
      return;
    }

    const { db, memoryDir } = userPaths(authUser.username);

    // --- GET /api/me ---
    if (req.url === '/api/me') {
      const meUser = getUser(authUser.username);
      jsonResp(res, 200, { username: authUser.username, displayName: authUser.displayName, role: userRole, isOnboarded: meUser ? !!meUser.isOnboarded : false });
      return;
    }

    // --- GET /api/onboarding-status ---
    if (req.url === '/api/onboarding-status') {
      const obUser = getUser(authUser.username);
      const rows = dbQuery("SELECT key, value FROM user_preferences", db);
      const prefs = {};
      for (const r of rows) prefs[r.key] = r.value;
      jsonResp(res, 200, { isOnboarded: obUser ? !!obUser.isOnboarded : false, preferences: prefs });
      return;
    }

    // --- POST /api/onboarding-complete ---
    if (req.url === '/api/onboarding-complete' && req.method === 'POST') {
      if (!hasMinRole(userRole, 'user')) {
        jsonResp(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      updateUser(authUser.username, { isOnboarded: true });
      jsonResp(res, 200, { ok: true });
      return;
    }

    // --- GET /api/preferences ---
    if (req.url === '/api/preferences' && req.method === 'GET') {
      const rows = dbQuery("SELECT key, value FROM user_preferences", db);
      const prefs = {};
      for (const r of rows) prefs[r.key] = r.value;
      jsonResp(res, 200, prefs);
      return;
    }

    // --- POST /api/preferences ---
    if (req.url === '/api/preferences' && req.method === 'POST') {
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
        if (value.length > 1024) {
          jsonResp(res, 400, { error: 'Value too long (max 1024 characters)' });
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

    // --- POST /api/feedback ---
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

    // --- GET /api/chat/history ---
    if (req.url.startsWith('/api/chat/history')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 200));
      const rows = dbQuery(`SELECT role, content, session_key, created_at FROM chat_history ORDER BY id DESC LIMIT ${limit}`, db);
      jsonResp(res, 200, rows.reverse());
      return;
    }

    // ════════════════════════════════════════════════════════════
    // VERA DOMAIN ENDPOINTS
    // ════════════════════════════════════════════════════════════

    // --- GET /api/appliances ---
    if (req.url === '/api/appliances' && req.method === 'GET') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const rows = dbQuery("SELECT id, name, location, brand, model, serial_number, purchase_date, warranty_expires, notes, created_at, updated_at FROM appliances ORDER BY name", db);
        const appliances = rows.map(r => {
          let warrantyStatus = 'unknown';
          if (r.warranty_expires) {
            if (r.warranty_expires < today) warrantyStatus = 'expired';
            else {
              // Check if expiring within 90 days
              const expDate = new Date(r.warranty_expires);
              const now = new Date(today);
              const daysLeft = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
              warrantyStatus = daysLeft <= 90 ? 'expiring' : 'active';
            }
          }
          return { ...r, warrantyStatus };
        });
        jsonResp(res, 200, { appliances });
      } catch (err) {
        log.error('Appliances error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load appliances' });
      }
      return;
    }

    // --- POST /api/appliances ---
    if (req.url === '/api/appliances' && req.method === 'POST') {
      try {
        const body = await readBody(req, 4096);
        const { name, location, brand, model, serial_number, purchase_date, warranty_expires, notes } = JSON.parse(body);
        if (!name || typeof name !== 'string' || !name.trim()) {
          jsonResp(res, 400, { error: 'Appliance name is required' });
          return;
        }
        const n = escapeSql(name.trim());
        const loc = escapeSql((location || '').slice(0, 200));
        const br = escapeSql((brand || '').slice(0, 200));
        const mod = escapeSql((model || '').slice(0, 200));
        const sn = escapeSql((serial_number || '').slice(0, 200));
        const pd = escapeSql((purchase_date || '').slice(0, 10));
        const we = escapeSql((warranty_expires || '').slice(0, 10));
        const nt = escapeSql((notes || '').slice(0, 1000));

        execFileSync('sqlite3', [db, `INSERT INTO appliances (name, location, brand, model, serial_number, purchase_date, warranty_expires, notes) VALUES ('${n}', '${loc}', '${br}', '${mod}', '${sn}', '${pd}', '${we}', '${nt}') ON CONFLICT(name) DO UPDATE SET location='${loc}', brand='${br}', model='${mod}', serial_number='${sn}', purchase_date='${pd}', warranty_expires='${we}', notes='${nt}', updated_at=datetime('now');`], { timeout: 5000 });

        const idRows = dbQuery(`SELECT id FROM appliances WHERE name='${n}'`, db);
        const id = idRows.length ? idRows[0].id : null;
        jsonResp(res, 200, { ok: true, id, name: name.trim() });
        sseBroadcast(authUser.username, 'data-updated', { source: 'appliance' });
      } catch (err) {
        log.error('Add appliance error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to save appliance' });
      }
      return;
    }

    // --- DELETE /api/appliances/:id ---
    const appDeleteMatch = req.url.match(/^\/api\/appliances\/(\d+)$/);
    if (appDeleteMatch && req.method === 'DELETE') {
      const appId = parseInt(appDeleteMatch[1]);
      try {
        const existing = dbQuery(`SELECT id FROM appliances WHERE id=${appId}`, db);
        if (!existing.length) {
          jsonResp(res, 404, { error: 'Appliance not found' });
          return;
        }
        execFileSync('sqlite3', [db, `DELETE FROM appliances WHERE id=${appId};`], { timeout: 5000 });
        jsonResp(res, 200, { ok: true });
        sseBroadcast(authUser.username, 'data-updated', { source: 'appliance' });
      } catch (err) {
        log.error('Delete appliance error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to delete appliance' });
      }
      return;
    }

    // --- GET /api/schedule ---
    if (req.url === '/api/schedule' && req.method === 'GET') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const rows = dbQuery(`SELECT ms.id, ms.task, ms.appliance_id, COALESCE(a.name, '') AS appliance_name, ms.interval_days, ms.last_completed, ms.next_due, ms.notes FROM maintenance_schedule ms LEFT JOIN appliances a ON ms.appliance_id = a.id ORDER BY ms.next_due ASC`, db);
        const schedule = rows.map(r => ({
          ...r,
          is_overdue: r.next_due < today
        }));
        jsonResp(res, 200, { schedule });
      } catch (err) {
        log.error('Schedule error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load schedule' });
      }
      return;
    }

    // --- POST /api/schedule ---
    if (req.url === '/api/schedule' && req.method === 'POST') {
      try {
        const body = await readBody(req, 4096);
        const { task, appliance_id, interval_days, next_due, notes } = JSON.parse(body);
        if (!task || typeof task !== 'string' || !task.trim()) {
          jsonResp(res, 400, { error: 'Task description is required' });
          return;
        }
        if (!interval_days || typeof interval_days !== 'number' || interval_days <= 0) {
          jsonResp(res, 400, { error: 'interval_days must be a positive number' });
          return;
        }
        if (!next_due || !/^\d{4}-\d{2}-\d{2}$/.test(next_due)) {
          jsonResp(res, 400, { error: 'next_due must be a valid date (YYYY-MM-DD)' });
          return;
        }
        const t = escapeSql(task.trim().slice(0, 500));
        const nt = escapeSql((notes || '').slice(0, 1000));
        const appId = appliance_id ? parseInt(appliance_id) : null;

        const appIdSql = appId ? `${appId}` : 'NULL';
        execFileSync('sqlite3', [db, `INSERT INTO maintenance_schedule (task, appliance_id, interval_days, next_due, notes) VALUES ('${t}', ${appIdSql}, ${interval_days}, '${escapeSql(next_due)}', '${nt}');`], { timeout: 5000 });

        const id = dbValue("SELECT last_insert_rowid();", db);
        jsonResp(res, 201, { ok: true, id: parseInt(id) });
        sseBroadcast(authUser.username, 'data-updated', { source: 'schedule' });
      } catch (err) {
        log.error('Add schedule error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to create schedule' });
      }
      return;
    }

    // --- DELETE /api/schedule/:id ---
    const schedDeleteMatch = req.url.match(/^\/api\/schedule\/(\d+)$/);
    if (schedDeleteMatch && req.method === 'DELETE') {
      const schedId = parseInt(schedDeleteMatch[1]);
      try {
        const existing = dbQuery(`SELECT id FROM maintenance_schedule WHERE id=${schedId}`, db);
        if (!existing.length) {
          jsonResp(res, 404, { error: 'Schedule not found' });
          return;
        }
        execFileSync('sqlite3', [db, `DELETE FROM maintenance_schedule WHERE id=${schedId};`], { timeout: 5000 });
        jsonResp(res, 200, { ok: true });
        sseBroadcast(authUser.username, 'data-updated', { source: 'schedule' });
      } catch (err) {
        log.error('Delete schedule error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to delete schedule' });
      }
      return;
    }

    // --- POST /api/schedule/:id/complete ---
    const completeMatch = req.url.match(/^\/api\/schedule\/(\d+)\/complete$/);
    if (completeMatch && req.method === 'POST') {
      try {
        const schedId = parseInt(completeMatch[1]);
        const row = dbQuery(`SELECT task, appliance_id, interval_days FROM maintenance_schedule WHERE id=${schedId}`, db);
        if (!row.length) {
          jsonResp(res, 404, { error: 'Schedule not found' });
          return;
        }
        const { task, appliance_id, interval_days } = row[0];
        const body = await readBody(req, 4096);
        const parsed = body ? JSON.parse(body) : {};
        const cost = (typeof parsed.cost === 'number' && parsed.cost >= 0) ? parsed.cost : 0;
        const escapedTask = escapeSql(task);
        const notes = escapeSql((parsed.notes || '').slice(0, 1000));
        const today = new Date().toISOString().slice(0, 10);
        const appIdSql = appliance_id ? `${appliance_id}` : 'NULL';

        // Log maintenance entry
        execFileSync('sqlite3', [db, `INSERT INTO maintenance_log (date, task, appliance_id, cost, notes) VALUES ('${today}', '${escapedTask}', ${appIdSql}, ${cost}, '${notes}');`], { timeout: 5000 });
        const maintenanceId = parseInt(dbValue("SELECT last_insert_rowid();", db));

        // Advance schedule: last_completed = today, next_due = today + interval_days
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + interval_days);
        const nextDue = nextDate.toISOString().slice(0, 10);
        execFileSync('sqlite3', [db, `UPDATE maintenance_schedule SET last_completed='${today}', next_due='${nextDue}' WHERE id=${schedId};`], { timeout: 5000 });

        jsonResp(res, 200, { ok: true, maintenance_id: maintenanceId, next_due: nextDue });
        sseBroadcast(authUser.username, 'data-updated', { source: 'schedule' });
      } catch (err) {
        log.error('Complete schedule error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to complete schedule' });
      }
      return;
    }

    // --- GET /api/maintenance ---
    if ((req.url === '/api/maintenance' || req.url.startsWith('/api/maintenance?')) && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const range = parseInt(url.searchParams.get('range') || '30');
        const daysBack = (range > 0 && range <= 3650) ? range : 30;
        const d = new Date();
        d.setDate(d.getDate() - daysBack);
        const startDate = d.toISOString().slice(0, 10);

        const rows = dbQuery(`SELECT ml.id, ml.date, ml.task, ml.appliance_id, COALESCE(a.name, '') AS appliance_name, ml.cost, ml.contractor, ml.notes FROM maintenance_log ml LEFT JOIN appliances a ON ml.appliance_id = a.id WHERE ml.date >= '${startDate}' ORDER BY ml.date DESC, ml.id DESC`, db);
        jsonResp(res, 200, { entries: rows, range: daysBack });
      } catch (err) {
        log.error('Maintenance log error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load maintenance log' });
      }
      return;
    }

    // --- POST /api/maintenance ---
    if (req.url === '/api/maintenance' && req.method === 'POST') {
      try {
        const body = await readBody(req, 4096);
        const { date, task, appliance_id, cost, contractor, notes } = JSON.parse(body);
        if (!task || typeof task !== 'string' || !task.trim()) {
          jsonResp(res, 400, { error: 'Task description is required' });
          return;
        }
        const logDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
        const logCost = (typeof cost === 'number' && cost >= 0) ? cost : 0;
        const t = escapeSql(task.trim().slice(0, 500));
        const c = escapeSql((contractor || '').slice(0, 200));
        const nt = escapeSql((notes || '').slice(0, 1000));
        const appId = appliance_id ? parseInt(appliance_id) : null;
        const appIdSql = appId ? `${appId}` : 'NULL';

        execFileSync('sqlite3', [db, `INSERT INTO maintenance_log (date, task, appliance_id, cost, contractor, notes) VALUES ('${escapeSql(logDate)}', '${t}', ${appIdSql}, ${logCost}, '${c}', '${nt}');`], { timeout: 5000 });

        const id = dbValue("SELECT last_insert_rowid();", db);
        jsonResp(res, 201, { ok: true, id: parseInt(id) });
        sseBroadcast(authUser.username, 'data-updated', { source: 'maintenance' });
      } catch (err) {
        log.error('Log maintenance error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to log maintenance' });
      }
      return;
    }

    // ════════════════════════════════════════════════════════════
    // SEASONAL CHECKLISTS
    // ════════════════════════════════════════════════════════════

    // --- GET /api/checklists ---
    if (req.url === '/api/checklists' && req.method === 'GET') {
      try {
        const templates = dbQuery(`SELECT sc.id, sc.name, sc.slug, sc.season, COUNT(ci.id) AS item_count FROM seasonal_checklists sc LEFT JOIN checklist_items ci ON ci.checklist_id = sc.id WHERE sc.is_template = 1 GROUP BY sc.id ORDER BY sc.name`, db);
        const active = dbQuery(`SELECT sc.id, sc.name, sc.season, sc.year, sc.template_id, sc.completed_at, COUNT(ci.id) AS total_items, SUM(CASE WHEN ci.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed_items FROM seasonal_checklists sc LEFT JOIN checklist_items ci ON ci.checklist_id = sc.id WHERE sc.is_template = 0 GROUP BY sc.id ORDER BY sc.completed_at IS NOT NULL, sc.year DESC, sc.name`, db);
        jsonResp(res, 200, { templates, active });
      } catch (err) {
        log.error('Checklists error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load checklists' });
      }
      return;
    }

    // --- POST /api/checklists/activate ---
    if (req.url === '/api/checklists/activate' && req.method === 'POST') {
      try {
        const body = await readBody(req, 4096);
        const { slug, year } = JSON.parse(body);
        if (!slug || typeof slug !== 'string') {
          jsonResp(res, 400, { error: 'Template slug is required' });
          return;
        }
        if (!year || typeof year !== 'number' || year < 2000 || year > 2100) {
          jsonResp(res, 400, { error: 'Valid year is required' });
          return;
        }
        const slugSafe = escapeSql(slug);
        const template = dbQuery(`SELECT id, name FROM seasonal_checklists WHERE slug='${slugSafe}' AND is_template=1`, db);
        if (!template.length) {
          jsonResp(res, 404, { error: 'Template not found' });
          return;
        }
        const tmplId = template[0].id;
        // Check if already activated
        const existing = dbQuery(`SELECT id FROM seasonal_checklists WHERE template_id=${tmplId} AND year=${year} AND is_template=0`, db);
        if (existing.length) {
          jsonResp(res, 200, { ok: true, id: existing[0].id, already_existed: true });
          return;
        }
        // Create user instance + copy items (single process so last_insert_rowid works)
        const newIdStr = execFileSync('sqlite3', [db,
          `INSERT INTO seasonal_checklists (name, season, is_template, template_id, year) SELECT name, season, 0, id, ${year} FROM seasonal_checklists WHERE id=${tmplId}; SELECT last_insert_rowid();`
        ], { encoding: 'utf8', timeout: 5000 }).trim();
        const newId = parseInt(newIdStr);
        execFileSync('sqlite3', [db, `INSERT INTO checklist_items (checklist_id, task, sort_order) SELECT ${newId}, task, sort_order FROM checklist_items WHERE checklist_id=${tmplId} ORDER BY sort_order;`], { timeout: 5000 });
        jsonResp(res, 201, { ok: true, id: newId });
        sseBroadcast(authUser.username, 'data-updated', { source: 'checklist' });
      } catch (err) {
        log.error('Checklist activate error', { error: err.message });
        jsonResp(res, 400, { error: 'Failed to activate checklist' });
      }
      return;
    }

    // --- GET /api/checklists/:id ---
    const checklistDetailMatch = req.url.match(/^\/api\/checklists\/(\d+)$/);
    if (checklistDetailMatch && req.method === 'GET') {
      const clId = parseInt(checklistDetailMatch[1]);
      try {
        const cl = dbQuery(`SELECT id, name, season, is_template, year, completed_at FROM seasonal_checklists WHERE id=${clId}`, db);
        if (!cl.length) {
          jsonResp(res, 404, { error: 'Checklist not found' });
          return;
        }
        const items = dbQuery(`SELECT id, task, sort_order, completed_at FROM checklist_items WHERE checklist_id=${clId} ORDER BY sort_order`, db);
        jsonResp(res, 200, { checklist: cl[0], items });
      } catch (err) {
        log.error('Checklist detail error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load checklist' });
      }
      return;
    }

    // --- POST /api/checklists/:id/check/:itemId ---
    const checkItemMatch = req.url.match(/^\/api\/checklists\/(\d+)\/check\/(\d+)$/);
    if (checkItemMatch && req.method === 'POST') {
      const clId = parseInt(checkItemMatch[1]);
      const itemId = parseInt(checkItemMatch[2]);
      try {
        // Verify item belongs to this non-template checklist
        const item = dbQuery(`SELECT ci.id FROM checklist_items ci JOIN seasonal_checklists sc ON ci.checklist_id=sc.id WHERE ci.id=${itemId} AND sc.id=${clId} AND sc.is_template=0`, db);
        if (!item.length) {
          jsonResp(res, 404, { error: 'Item not found in this checklist' });
          return;
        }
        execFileSync('sqlite3', [db, `UPDATE checklist_items SET completed_at=datetime('now') WHERE id=${itemId};`], { timeout: 5000 });
        // Auto-complete if all done
        const remaining = parseInt(dbValue(`SELECT COUNT(*) FROM checklist_items WHERE checklist_id=${clId} AND completed_at IS NULL`, db)) || 0;
        if (remaining === 0) {
          execFileSync('sqlite3', [db, `UPDATE seasonal_checklists SET completed_at=datetime('now') WHERE id=${clId};`], { timeout: 5000 });
        }
        jsonResp(res, 200, { ok: true, checklist_completed: remaining === 0 });
        sseBroadcast(authUser.username, 'data-updated', { source: 'checklist' });
      } catch (err) {
        log.error('Check item error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to check item' });
      }
      return;
    }

    // --- POST /api/checklists/:id/uncheck/:itemId ---
    const uncheckItemMatch = req.url.match(/^\/api\/checklists\/(\d+)\/uncheck\/(\d+)$/);
    if (uncheckItemMatch && req.method === 'POST') {
      const clId = parseInt(uncheckItemMatch[1]);
      const itemId = parseInt(uncheckItemMatch[2]);
      try {
        const item = dbQuery(`SELECT ci.id FROM checklist_items ci JOIN seasonal_checklists sc ON ci.checklist_id=sc.id WHERE ci.id=${itemId} AND sc.id=${clId} AND sc.is_template=0`, db);
        if (!item.length) {
          jsonResp(res, 404, { error: 'Item not found in this checklist' });
          return;
        }
        execFileSync('sqlite3', [db, `UPDATE checklist_items SET completed_at=NULL WHERE id=${itemId}; UPDATE seasonal_checklists SET completed_at=NULL WHERE id=${clId};`], { timeout: 5000 });
        jsonResp(res, 200, { ok: true });
        sseBroadcast(authUser.username, 'data-updated', { source: 'checklist' });
      } catch (err) {
        log.error('Uncheck item error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to uncheck item' });
      }
      return;
    }

    // --- DELETE /api/checklists/:id ---
    if (checklistDetailMatch && req.method === 'DELETE') {
      const clId = parseInt(checklistDetailMatch[1]);
      try {
        const cl = dbQuery(`SELECT id, is_template FROM seasonal_checklists WHERE id=${clId}`, db);
        if (!cl.length) {
          jsonResp(res, 404, { error: 'Checklist not found' });
          return;
        }
        if (cl[0].is_template) {
          jsonResp(res, 400, { error: 'Cannot delete a template' });
          return;
        }
        execFileSync('sqlite3', [db, `DELETE FROM checklist_items WHERE checklist_id=${clId}; DELETE FROM seasonal_checklists WHERE id=${clId};`], { timeout: 5000 });
        jsonResp(res, 200, { ok: true });
        sseBroadcast(authUser.username, 'data-updated', { source: 'checklist' });
      } catch (err) {
        log.error('Delete checklist error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to delete checklist' });
      }
      return;
    }

    // --- GET /api/summary ---
    if (req.url === '/api/summary') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = today.slice(0, 8) + '01';

        const overdueCount = parseInt(dbValue(`SELECT COUNT(*) FROM maintenance_schedule WHERE next_due < '${today}'`, db)) || 0;

        // Upcoming in next 7 days
        const d7 = new Date(); d7.setDate(d7.getDate() + 7);
        const weekEnd = d7.toISOString().slice(0, 10);
        const upcomingCount = parseInt(dbValue(`SELECT COUNT(*) FROM maintenance_schedule WHERE next_due >= '${today}' AND next_due <= '${weekEnd}'`, db)) || 0;

        const applianceCount = parseInt(dbValue("SELECT COUNT(*) FROM appliances", db)) || 0;

        const monthCost = parseFloat(dbValue(`SELECT COALESCE(SUM(cost), 0) FROM maintenance_log WHERE date >= '${monthStart}'`, db)) || 0;

        // Overdue items for list
        const overdueItems = dbQuery(`SELECT ms.id, ms.task, COALESCE(a.name, '') AS appliance_name, ms.next_due FROM maintenance_schedule ms LEFT JOIN appliances a ON ms.appliance_id = a.id WHERE ms.next_due < '${today}' ORDER BY ms.next_due ASC LIMIT 10`, db);

        // Recently completed (last 5)
        const recentCompleted = dbQuery(`SELECT ml.date, ml.task, COALESCE(a.name, '') AS appliance_name, ml.cost FROM maintenance_log ml LEFT JOIN appliances a ON ml.appliance_id = a.id ORDER BY ml.date DESC, ml.id DESC LIMIT 5`, db);

        jsonResp(res, 200, {
          overdueCount,
          upcomingCount,
          applianceCount,
          monthCost,
          overdueItems,
          recentCompleted
        });
      } catch (err) {
        log.error('Summary error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load summary' });
      }
      return;
    }

    // --- GET /api/briefing ---
    if (req.url === '/api/briefing' && req.method === 'GET') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = today.slice(0, 8) + '01';
        const d7 = new Date(); d7.setDate(d7.getDate() + 7);
        const weekEnd = d7.toISOString().slice(0, 10);

        // Overdue items
        const needsAttention = dbQuery(`SELECT ms.id, ms.task, COALESCE(a.name, '') AS appliance, ms.next_due, CAST(julianday('${today}') - julianday(ms.next_due) AS INTEGER) AS daysOverdue FROM maintenance_schedule ms LEFT JOIN appliances a ON ms.appliance_id = a.id WHERE ms.next_due < '${today}' ORDER BY ms.next_due ASC`, db);

        // Today's tasks
        const todayItems = dbQuery(`SELECT ms.id, ms.task, COALESCE(a.name, '') AS appliance FROM maintenance_schedule ms LEFT JOIN appliances a ON ms.appliance_id = a.id WHERE ms.next_due = '${today}' ORDER BY ms.task`, db);

        // Stats
        const overdueCount = needsAttention.length;
        const upcomingCount = parseInt(dbValue(`SELECT COUNT(*) FROM maintenance_schedule WHERE next_due > '${today}' AND next_due <= '${weekEnd}'`, db)) || 0;
        const applianceCount = parseInt(dbValue("SELECT COUNT(*) FROM appliances", db)) || 0;
        const monthCost = parseFloat(dbValue(`SELECT COALESCE(SUM(cost), 0) FROM maintenance_log WHERE date >= '${monthStart}'`, db)) || 0;
        const activeChecklists = parseInt(dbValue("SELECT COUNT(*) FROM seasonal_checklists WHERE is_template = 0 AND completed_at IS NULL", db)) || 0;

        // Next upcoming (for greeting)
        const nextUpcoming = dbQuery(`SELECT task, next_due FROM maintenance_schedule WHERE next_due > '${today}' ORDER BY next_due ASC LIMIT 1`, db);

        const greeting = buildGreeting(authUser.displayName, {
          overdueCount,
          todayCount: todayItems.length,
          upcomingCount,
          nextUpcoming: nextUpcoming.length ? nextUpcoming[0] : null
        });

        jsonResp(res, 200, {
          greeting,
          needsAttention,
          today: todayItems,
          stats: { overdueCount, upcomingCount, applianceCount, monthCost, activeChecklists }
        });
      } catch (err) {
        log.error('Briefing error', { error: err.message });
        jsonResp(res, 500, { error: 'Failed to load briefing' });
      }
      return;
    }

    // --- GET /api/export ---
    if (req.url?.startsWith('/api/export') && req.method === 'GET') {
      if (!hasMinRole(authUser.role, 'user')) { jsonResp(res, 403, { error: 'Forbidden' }); return; }
      try {
        const rows = dbQuery(`SELECT ml.date, ml.task, COALESCE(a.name, '') AS appliance, ml.cost, ml.contractor, ml.notes FROM maintenance_log ml LEFT JOIN appliances a ON ml.appliance_id = a.id ORDER BY ml.date DESC, ml.id DESC`, db);

        let csv = 'Date,Task,Appliance,Cost,Contractor,Notes\n';
        for (const r of rows) {
          csv += `${r.date},"${(r.task || '').replace(/"/g, '""')}","${(r.appliance || '').replace(/"/g, '""')}",${r.cost || 0},"${(r.contractor || '').replace(/"/g, '""')}","${(r.notes || '').replace(/"/g, '""')}"\n`;
        }
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="vera-maintenance-export.csv"' });
        res.end(csv);
      } catch (err) {
        log.error('Export error', { error: err.message });
        jsonResp(res, 500, { error: 'Export failed' });
      }
      return;
    }

    // --- POST /api/chat — proxy to OpenClaw Gateway via WebSocket (SSE streaming) ---
    if (req.url === '/api/chat' && req.method === 'POST') {
      try {
        const body = await readBody(req, 1 * 1024 * 1024);
        const { message, image, sessionKey: clientSessionKey } = JSON.parse(body);
        if ((!message || !message.trim()) && !image) {
          jsonResp(res, 400, { error: 'Message or image is required' });
          return;
        }

        let sessionKey;
        const expectedPrefix = `agent:vera:${authUser.username}-`;
        if (clientSessionKey && clientSessionKey.startsWith(expectedPrefix) && /^[a-zA-Z0-9:_-]+$/.test(clientSessionKey)) {
          sessionKey = clientSessionKey;
        } else {
          sessionKey = `${expectedPrefix}${Date.now()}`;
        }

        const chatMessage = (message || (image ? 'What is this?' : '')).trim();

        try {
          execFileSync('sqlite3', [db, `INSERT INTO chat_history (role, content, session_key) VALUES ('user', '${escapeSql(chatMessage)}', '${escapeSql(sessionKey)}');`], { timeout: 5000 });
        } catch (err) {
          log.error('Failed to save user chat message', { error: err.message });
        }

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
          sseEnd('error', { error: 'Vera took too long to respond. Try again.' });
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
                client: { id: 'openclaw-control-ui', displayName: 'Vera Dashboard', version: '1.0', platform: 'linux', mode: 'ui' },
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
              sseEnd('error', { error: p.errorMessage || p.error || 'Vera encountered an error.' });
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
          ws.onerror = (e) => { clearTimeout(chatTimeout); if (Sentry) Sentry.captureException(e.error || new Error('WebSocket gateway error')); sseEnd('error', { error: 'Could not reach Vera. Is OpenClaw running?' }); };
          ws.onclose = () => { clearTimeout(chatTimeout); sseEnd('error', { error: 'Gateway connection closed unexpectedly.' }); };
        } else {
          ws.on('message', onMsg);
          ws.on('error', (err) => { clearTimeout(chatTimeout); if (Sentry) Sentry.captureException(err); sseEnd('error', { error: 'Could not reach Vera. Is OpenClaw running?' }); });
          ws.on('close', () => { clearTimeout(chatTimeout); sseEnd('error', { error: 'Gateway connection closed unexpectedly.' }); });
        }
      } catch (err) {
        if (!res.headersSent) {
          jsonResp(res, 400, { error: 'Invalid request body' });
        }
      }
      return;
    }

    // ════════════════════════════════════════════════════════════
    // HOME ASSISTANT INTEGRATION
    // ════════════════════════════════════════════════════════════

    // --- GET /api/ha/status ---
    if (req.url === '/api/ha/status' && req.method === 'GET') {
      const ha = getHaCredentials(db);
      if (!ha.url || !ha.token) {
        jsonResp(res, 200, { configured: false, connected: false, message: 'Home Assistant not configured. Add your HA URL and token in settings.' });
        return;
      }
      const result = await haFetch(ha.url, ha.token, '/api/');
      if (result.ok) {
        jsonResp(res, 200, { configured: true, connected: true, message: result.data.message || 'Connected' });
      } else {
        jsonResp(res, 200, { configured: true, connected: false, message: result.error || 'Connection failed' });
      }
      return;
    }

    // --- GET /api/ha/entities ---
    if ((req.url === '/api/ha/entities' || req.url.startsWith('/api/ha/entities?')) && req.method === 'GET') {
      const ha = getHaCredentials(db);
      if (!ha.url || !ha.token) { jsonResp(res, 400, { error: 'Home Assistant not configured' }); return; }
      const result = await haFetch(ha.url, ha.token, '/api/states');
      if (!result.ok) { jsonResp(res, 502, { error: result.error || 'Failed to reach Home Assistant' }); return; }
      let entities = result.data || [];
      const url = new URL(req.url, 'http://localhost');
      const domain = url.searchParams.get('domain');
      if (domain) {
        entities = entities.filter(e => e.entity_id.startsWith(domain + '.'));
      }
      // Return simplified entity list
      const simplified = entities.map(e => ({
        entity_id: e.entity_id,
        state: e.state,
        name: (e.attributes && e.attributes.friendly_name) || e.entity_id,
        domain: e.entity_id.split('.')[0],
        last_changed: e.last_changed
      }));
      jsonResp(res, 200, { entities: simplified });
      return;
    }

    // --- GET /api/ha/entity/:id ---
    const haEntityMatch = req.url.match(/^\/api\/ha\/entity\/([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)$/);
    if (haEntityMatch && req.method === 'GET') {
      const ha = getHaCredentials(db);
      if (!ha.url || !ha.token) { jsonResp(res, 400, { error: 'Home Assistant not configured' }); return; }
      const entityId = haEntityMatch[1];
      const result = await haFetch(ha.url, ha.token, `/api/states/${entityId}`);
      if (!result.ok) { jsonResp(res, result.status === 404 ? 404 : 502, { error: result.error || 'Entity not found' }); return; }
      jsonResp(res, 200, result.data);
      return;
    }

    // --- GET /api/ha/history/:entity_id ---
    const haHistoryMatch = req.url.match(/^\/api\/ha\/history\/([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(\?.*)?$/);
    if (haHistoryMatch && req.method === 'GET') {
      const ha = getHaCredentials(db);
      if (!ha.url || !ha.token) { jsonResp(res, 400, { error: 'Home Assistant not configured' }); return; }
      const entityId = haHistoryMatch[1];
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = await haFetch(ha.url, ha.token, `/api/history/period/${since}?filter_entity_id=${entityId}&minimal_response`);
      if (!result.ok) { jsonResp(res, 502, { error: result.error || 'Failed to fetch history' }); return; }
      jsonResp(res, 200, { history: result.data || [] });
      return;
    }

    // --- GET /api/ha/services ---
    if (req.url === '/api/ha/services' && req.method === 'GET') {
      const ha = getHaCredentials(db);
      if (!ha.url || !ha.token) { jsonResp(res, 400, { error: 'Home Assistant not configured' }); return; }
      const result = await haFetch(ha.url, ha.token, '/api/services');
      if (!result.ok) { jsonResp(res, 502, { error: result.error || 'Failed to fetch services' }); return; }
      jsonResp(res, 200, { services: result.data || [] });
      return;
    }

    // --- POST /api/ha/call-service ---
    if (req.url === '/api/ha/call-service' && req.method === 'POST') {
      if (!hasMinRole(userRole, 'user')) { jsonResp(res, 403, { error: 'Insufficient permissions' }); return; }
      const ha = getHaCredentials(db);
      if (!ha.url || !ha.token) { jsonResp(res, 400, { error: 'Home Assistant not configured' }); return; }
      try {
        const body = await readBody(req, 4096);
        const { domain, service, entity_id, data: serviceData } = JSON.parse(body);
        if (!domain || !service) { jsonResp(res, 400, { error: 'domain and service are required' }); return; }
        if (!/^[a-zA-Z_]+$/.test(domain) || !/^[a-zA-Z_]+$/.test(service)) {
          jsonResp(res, 400, { error: 'Invalid domain or service name' });
          return;
        }
        const payload = { ...(serviceData || {}) };
        if (entity_id) payload.entity_id = entity_id;
        const result = await haFetch(ha.url, ha.token, `/api/services/${domain}/${service}`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (!result.ok) { jsonResp(res, 502, { error: result.error || 'Service call failed' }); return; }
        jsonResp(res, 200, { ok: true, result: result.data });
      } catch (err) {
        jsonResp(res, 400, { error: 'Invalid request' });
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

const HOST = process.env.VERA_HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  log.info('Vera dashboard started', { host: HOST, port: PORT, dataDir: DATA_DIR, memoryBase: MEMORY_BASE });
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
