const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.VERA_DATA_DIR || path.join(process.env.HOME, 'vera-dashboard');
const ADMIN_DB_PATH = path.join(DATA_DIR, 'vera-admin.db');

function getSecret() {
  const secretPath = path.join(DATA_DIR, 'jwt-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}

// --- SQLite helpers for admin DB ---

function adminDbExec(sql) {
  try {
    execFileSync('sqlite3', [ADMIN_DB_PATH, sql], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    console.error('adminDbExec error:', err.message);
    throw err;
  }
}

function adminDbQuery(sql) {
  try {
    const result = execFileSync('sqlite3', ['-json', ADMIN_DB_PATH, sql], {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
    if (!result) return [];
    return JSON.parse(result);
  } catch (err) {
    if (err.stdout && err.stdout.trim() === '') return [];
    if (err.status === 0) return [];
    console.error('adminDbQuery error:', err.message);
    return [];
  }
}

// --- Database initialization and migration ---

function initAdminDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  adminDbExec(`
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
  `);
  try {
    adminDbExec(`ALTER TABLE users ADD COLUMN is_onboarded INTEGER NOT NULL DEFAULT 0`);
  } catch (err) {
    if (err.message && !err.message.includes('duplicate column')) {
      console.error('Migration error (is_onboarded):', err.message);
    }
  }
  migrateFromJson();
}

function migrateFromJson() {
  const existing = adminDbQuery("SELECT COUNT(*) as cnt FROM users;");
  if (existing.length && existing[0].cnt > 0) return;

  const usersJsonPath = path.join(DATA_DIR, 'users.json');
  if (!fs.existsSync(usersJsonPath)) return;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
  } catch {
    return;
  }

  const users = config.users || {};
  for (const [username, user] of Object.entries(users)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) continue;
    const displayName = escapeSql(user.displayName || username);
    const passwordHash = escapeSql(user.passwordHash || '');
    const salt = escapeSql(user.salt || '');
    const apiKey = user.apiKey ? `'${escapeSql(user.apiKey)}'` : 'NULL';
    const role = username === 'john' ? 'admin' : 'user';
    try {
      adminDbExec(`INSERT OR IGNORE INTO users (username, display_name, password_hash, salt, api_key, role) VALUES ('${escapeSql(username)}', '${displayName}', '${passwordHash}', '${salt}', ${apiKey}, '${role}');`);
    } catch (err) {
      console.error(`Migration: failed to insert user ${username}:`, err.message);
    }
  }

  try {
    fs.renameSync(usersJsonPath, usersJsonPath + '.bak');
  } catch {}
}

function escapeSql(str) {
  return String(str).replace(/'/g, "''");
}

// --- User CRUD ---

function getUser(username) {
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return null;
  const rows = adminDbQuery(`SELECT username, display_name, password_hash, salt, api_key, role, is_onboarded FROM users WHERE username='${escapeSql(username)}';`);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    username: r.username,
    displayName: r.display_name,
    passwordHash: r.password_hash,
    salt: r.salt,
    apiKey: r.api_key,
    role: r.role,
    isOnboarded: !!r.is_onboarded
  };
}

function listUsers() {
  const rows = adminDbQuery("SELECT username, display_name, api_key, role, is_onboarded, created_at, updated_at FROM users ORDER BY id;");
  return rows.map(r => ({
    username: r.username,
    displayName: r.display_name,
    apiKey: r.api_key,
    role: r.role,
    isOnboarded: !!r.is_onboarded,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

function createUser(username, displayName, passwordHash, salt, role, apiKey) {
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) throw new Error('Invalid username');
  const apiKeyVal = apiKey ? `'${escapeSql(apiKey)}'` : 'NULL';
  adminDbExec(`INSERT INTO users (username, display_name, password_hash, salt, api_key, role) VALUES ('${escapeSql(username)}', '${escapeSql(displayName)}', '${escapeSql(passwordHash)}', '${escapeSql(salt)}', ${apiKeyVal}, '${escapeSql(role)}');`);
}

function updateUser(username, fields) {
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) throw new Error('Invalid username');
  const sets = [];
  if (fields.displayName !== undefined) sets.push(`display_name='${escapeSql(fields.displayName)}'`);
  if (fields.passwordHash !== undefined) sets.push(`password_hash='${escapeSql(fields.passwordHash)}'`);
  if (fields.salt !== undefined) sets.push(`salt='${escapeSql(fields.salt)}'`);
  if (fields.apiKey !== undefined) sets.push(`api_key='${escapeSql(fields.apiKey)}'`);
  if (fields.role !== undefined) sets.push(`role='${escapeSql(fields.role)}'`);
  if (fields.isOnboarded !== undefined) sets.push(`is_onboarded=${fields.isOnboarded ? 1 : 0}`);
  if (!sets.length) return;
  sets.push("updated_at=datetime('now')");
  adminDbExec(`UPDATE users SET ${sets.join(', ')} WHERE username='${escapeSql(username)}';`);
}

function deleteUser(username) {
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) throw new Error('Invalid username');
  adminDbExec(`DELETE FROM users WHERE username='${escapeSql(username)}';`);
}

// --- JWT ---

function base64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function signJwt(payload, expiresInDays = 1) {
  const secret = getSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInDays * 86400 };
  const segments = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(body)))
  ];
  const signature = crypto.createHmac('sha256', secret).update(segments.join('.')).digest();
  segments.push(base64url(signature));
  return segments.join('.');
}

function verifyJwt(token) {
  if (!token) return null;
  try {
    const secret = getSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const signature = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
    const expected = base64url(signature);
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(parts[2]);
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
    const payload = JSON.parse(base64urlDecode(parts[1]).toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Password hashing ---

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64);
  const hash = 'scrypt:' + derived.toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  if (storedHash.startsWith('scrypt:')) {
    const derived = crypto.scryptSync(password, storedSalt, 64);
    const expected = Buffer.from(storedHash.slice(7), 'hex');
    return crypto.timingSafeEqual(derived, expected);
  }
  const hash = crypto.createHash('sha256').update(storedSalt + password).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

// --- Auth helpers ---

function findUserByApiKey(apiKey) {
  if (!apiKey) return null;
  const users = listUsers();
  const apiKeyBuf = Buffer.from(apiKey);
  for (const user of users) {
    if (!user.apiKey) continue;
    const storedBuf = Buffer.from(user.apiKey);
    if (apiKeyBuf.length === storedBuf.length && crypto.timingSafeEqual(apiKeyBuf, storedBuf)) {
      return { username: user.username, displayName: user.displayName, role: user.role };
    }
  }
  return null;
}

function authenticateRequest(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = findUserByApiKey(apiKey);
    if (user) return { username: user.username, displayName: user.displayName, role: user.role };
    return null;
  }
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const payload = verifyJwt(match[1]);
  if (!payload || !payload.sub) return null;
  const dbUser = getUser(payload.sub);
  const role = dbUser ? dbUser.role : (payload.role || 'user');
  return { username: payload.sub, displayName: payload.name || payload.sub, role };
}

module.exports = {
  signJwt, verifyJwt, hashPassword, verifyPassword,
  findUserByApiKey, authenticateRequest,
  initAdminDb, getUser, listUsers, createUser, updateUser, deleteUser,
  escapeSql, ADMIN_DB_PATH
};
