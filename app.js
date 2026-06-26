'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const PORT = Number(config.server.port);
const HOST = config.server.host;
const ROOT = __dirname;
const DATA = config.data.root;
const FILES = config.files.root;
const USERS_FILE = path.join(DATA, 'users.json');
const INVITES_FILE = path.join(DATA, 'invites.json');
const REMOTE_SESSIONS_FILE = path.join(DATA, 'remote-sessions.json');
const AUDIT_JSON_FILE = path.join(DATA, 'audit-logs.json');
const SQLITE_FILE = path.join(DATA, 'portal.sqlite3');
const SQLITE_BIN = process.env.SQLITE3_BIN || 'sqlite3';
const REMOTE_MASTER_KEY_FILE = path.join(DATA, 'remote-master.key');
const AUDIT_FILE = path.join(DATA, 'audit.log');
const sessions = new Map();
const captchas = new Map();
const requestLimits = new Map();
const authAttempts = new Map();
const remoteReauthTokens = new Map();
const remoteReauthFailures = new Map();

fs.mkdirSync(DATA, { recursive: true, mode: 0o750 });
fs.mkdirSync(FILES, { recursive: true, mode: 0o750 });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]\n', { mode: 0o600 });
if (!fs.existsSync(INVITES_FILE)) fs.writeFileSync(INVITES_FILE, '[]\n', { mode: 0o600 });
if (!fs.existsSync(REMOTE_SESSIONS_FILE)) fs.writeFileSync(REMOTE_SESSIONS_FILE, '[]\n', { mode: 0o600 });
if (!fs.existsSync(REMOTE_MASTER_KEY_FILE)) fs.writeFileSync(REMOTE_MASTER_KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });

let sqliteReady = false;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(ROOT, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

function readJsonArrayFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function writeJsonArrayFile(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(String(value), 'utf8').toString('hex')}' AS TEXT)`;
}

function sqliteExec(sql) {
  return execFileSync(SQLITE_BIN, [SQLITE_FILE], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

function sqliteGetText(key) {
  const hex = sqliteExec(`SELECT hex(value) FROM app_kv WHERE key = ${sqlString(key)};\n`).trim();
  return hex ? Buffer.from(hex, 'hex').toString('utf8') : null;
}

function sqliteSetText(key, value) {
  sqliteExec(`BEGIN IMMEDIATE;
INSERT OR REPLACE INTO app_kv(key, value, updatedAt) VALUES (${sqlString(key)}, ${sqlText(value)}, datetime('now'));
COMMIT;\n`);
}

function initializeSqliteStorage() {
  try {
    execFileSync(SQLITE_BIN, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sqliteExec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);\n`);
    [
      ['users', USERS_FILE],
      ['invites', INVITES_FILE],
      ['remoteSessions', REMOTE_SESSIONS_FILE],
      ['auditLogs', AUDIT_JSON_FILE]
    ].forEach(([key, file]) => {
      if (sqliteGetText(key) === null) {
        const seed = fs.existsSync(file)
          ? fs.readFileSync(file, 'utf8')
          : key === 'auditLogs' && fs.existsSync(AUDIT_FILE)
            ? `${JSON.stringify(parseAuditLogFile(), null, 2)}\n`
            : '[]\n';
        sqliteSetText(key, seed.trim() ? seed : '[]\n');
      }
    });
    try { fs.chmodSync(SQLITE_FILE, 0o600); } catch (_) {}
    sqliteReady = true;
  } catch (error) {
    sqliteReady = false;
    console.error(`[storage] sqlite unavailable, falling back to JSON files: ${error.message}`);
  }
}

function readStoreArray(key, file) {
  if (sqliteReady) {
    try {
      const data = JSON.parse(sqliteGetText(key) || '[]');
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error(`[storage] failed to read ${key} from sqlite: ${error.message}`);
      return [];
    }
  }
  return readJsonArrayFile(file);
}

function writeStoreArray(key, file, value) {
  if (sqliteReady) {
    sqliteSetText(key, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  writeJsonArrayFile(file, value);
}

initializeSqliteStorage();

function readUsers() {
  return readStoreArray('users', USERS_FILE);
}

function visibleUsers(users = readUsers()) {
  return users.filter(user => !user.deletedAt);
}

function writeUsers(users) {
  writeStoreArray('users', USERS_FILE, users);
}

function readInvites() {
  return readStoreArray('invites', INVITES_FILE);
}

function writeInvites(invites) {
  writeStoreArray('invites', INVITES_FILE, invites);
}

function readRemoteSessions() {
  return readStoreArray('remoteSessions', REMOTE_SESSIONS_FILE);
}

function writeRemoteSessions(remoteSessions) {
  writeStoreArray('remoteSessions', REMOTE_SESSIONS_FILE, remoteSessions);
}

function readAuditLogs() {
  return readStoreArray('auditLogs', AUDIT_JSON_FILE);
}

function writeAuditLogs(logs) {
  writeStoreArray('auditLogs', AUDIT_JSON_FILE, logs);
}

function encryptSecret(value) {
  if (!value) return null;
  const key = fs.readFileSync(REMOTE_MASTER_KEY_FILE);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptSecret(secret) {
  if (!secret) return '';
  const key = fs.readFileSync(REMOTE_MASTER_KEY_FILE);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]).toString('utf8');
}

function remoteSessionView(item, users, includeGrants = false) {
  const result = {
    id: item.id,
    name: item.name,
    groupPath: item.groupPath || '',
    host: item.host,
    port: item.port,
    username: item.username,
    authType: item.authType,
    connectionMode: item.connectionMode === 'jump' ? 'jump' : 'direct',
    jumpSessionId: item.jumpSessionId || '',
    credentialRequired: item.authType === 'password' && !item.credential,
    active: item.active,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
  if (includeGrants) {
    result.allowedUserIds = item.allowedUserIds || [];
    result.allowedGroupPaths = (item.allowedGroupPaths || []).map(normalizeUserGroupPath).filter(Boolean);
    result.allowedUsers = users.filter(user => !user.deletedAt && result.allowedUserIds.includes(user.id)).map(publicUser);
  }
  return result;
}

function enrichRemoteSessionViews(sessions, users, includeGrants = false, nameSource = sessions) {
  const names = new Map(nameSource.map(item => [item.id, item.name]));
  return sessions.map(item => ({
    ...remoteSessionView(item, users, includeGrants),
    jumpSessionName: item.jumpSessionId ? names.get(item.jumpSessionId) || '' : ''
  }));
}

function normalizeRemoteGroupPath(value = '') {
  return String(value)
    .replace(/\\/g, '/')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('/')
    .slice(0, 120);
}

const normalizeUserGroupPath = normalizeRemoteGroupPath;

function userInAllowedGroup(userGroupPath = '', allowedGroupPaths = []) {
  const userGroup = normalizeUserGroupPath(userGroupPath);
  return (allowedGroupPaths || []).some(group => {
    const normalized = normalizeUserGroupPath(group);
    return normalized && (userGroup === normalized || userGroup.startsWith(`${normalized}/`));
  });
}

function isValidSshHost(host) {
  return Boolean(host) && host.length <= 255 && !/[\s/@:]/.test(host);
}

function normalizeConnectionMode(value) {
  return value === 'jump' ? 'jump' : 'direct';
}

function normalizeJumpSessionId(value, mode) {
  return mode === 'jump' ? String(value || '').trim() : '';
}

function normalizeHostForCompare(host) {
  return String(host || '').trim().replace(/\.$/, '').toLowerCase();
}

function isPublicDirectHostAllowed(host) {
  const normalized = normalizeHostForCompare(host);
  return (config.remote.allowPublicDirectHosts || [])
    .map(normalizeHostForCompare)
    .includes(normalized);
}

function hasJumpCycle(remoteSessions, sessionId, jumpSessionId) {
  if (!sessionId || !jumpSessionId) return false;
  const byId = new Map(remoteSessions.map(item => [item.id, item]));
  const seen = new Set([sessionId]);
  let current = byId.get(jumpSessionId);
  while (current) {
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    current = current.jumpSessionId ? byId.get(current.jumpSessionId) : null;
  }
  return false;
}

function hasSavedCredential(session) {
  return Boolean(session && session.credential);
}

function isUsedAsJump(remoteSessions, sessionId) {
  return remoteSessions.some(item => item.jumpSessionId === sessionId);
}

function validateRemoteSessionInput({ name, host, port, username, credential, authType, connectionMode, jumpSessionId, remoteSessions, sessionId = '' }) {
  if (!name || name.length > 60) return '会话名称不能为空且不能超过 60 个字符';
  if (!isValidSshHost(host)) return '主机地址无效';
  if (connectionMode === 'direct' && !isPrivateHost(host) && !isPublicDirectHostAllowed(host)) return '直接连接仅允许配置本机、内网 IP 或已加入白名单的公网地址；访问本服务器建议填写 127.0.0.1';
  if (!username || port < 1 || port > 65535) return '主机、端口或用户名无效';
  if (authType === 'privateKey' && credential === '') return '请输入私钥';
  if (connectionMode === 'jump') {
    const jumpSession = remoteSessions.find(item => item.id === jumpSessionId && item.active);
    if (!jumpSession) return '请选择有效的跳板会话';
    if (!hasSavedCredential(jumpSession)) return '所选跳板会话必须保存密码或私钥，不能使用连接时临时输入';
    if (sessionId && jumpSessionId === sessionId) return '不能选择自身作为跳板会话';
    if (hasJumpCycle(remoteSessions, sessionId, jumpSessionId)) return '跳板会话不能形成循环引用';
  }
  return '';
}

function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const raw = [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function issueInvites(ownerUserId, count, invites = readInvites()) {
  const existing = new Set(invites.map(item => item.code));
  for (let index = 0; index < count; index += 1) {
    let code;
    do { code = newInviteCode(); } while (existing.has(code));
    existing.add(code);
    invites.push({
      id: crypto.randomUUID(),
      code,
      ownerUserId,
      active: true,
      createdAt: new Date().toISOString(),
      usedByUserId: null,
      usedAt: null
    });
  }
  return invites;
}

function bootstrapInvites() {
  const users = readUsers();
  const invites = readInvites();
  if (!users.length || invites.length) return;
  visibleUsers(users).forEach(user => issueInvites(user.id, user.role === 'admin' ? config.registration.adminInviteCount : config.registration.userInviteCount, invites));
  writeInvites(invites);
}

bootstrapInvites();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex') };
}

function verifyPassword(password, user) {
  const candidate = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function parseAuditLogFile() {
  try {
    return fs.readFileSync(AUDIT_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-5000)
      .map(line => {
        const [createdAt, username, action, ...detail] = line.split('\t');
        return {
          id: crypto.createHash('sha1').update(line).digest('hex'),
          createdAt,
          username: username === '-' ? '' : username,
          action,
          detail: detail.join('\t'),
          ip: '',
          userAgent: ''
        };
      })
      .filter(item => item.createdAt && item.action);
  } catch (_) {
    return [];
  }
}

function requestMeta(req) {
  if (!req) return { ip: '', userAgent: '' };
  return {
    ip: req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket?.remoteAddress || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0, 240)
  };
}

function audit(actor, action, detail = '', req = null) {
  const username = typeof actor === 'object' && actor ? actor.username : actor;
  const safe = String(detail || '').replace(/[\r\n]/g, ' ').slice(0, 800);
  const meta = requestMeta(req);
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    username: username || '',
    action,
    detail: safe,
    ip: meta.ip,
    userAgent: meta.userAgent
  };
  fs.appendFile(AUDIT_FILE, `${record.createdAt}\t${record.username || '-'}\t${record.action}\t${record.detail}\n`, () => {});
  try {
    const logs = readAuditLogs();
    logs.push(record);
    if (logs.length > 20000) logs.splice(0, logs.length - 20000);
    writeAuditLogs(logs);
  } catch (error) {
    console.error(`[audit] failed to write audit log: ${error.message}`);
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
}

function requestIdentity(req) {
  return `${req.socket.remoteAddress || '-'}|${req.headers['user-agent'] || '-'}`;
}

function remoteReauthFailureKey(user, purpose, req) {
  return `${user.id}|${purpose}|${requestMeta(req).ip || '-'}`;
}

function remoteReauthLocked(user, purpose, req) {
  const record = remoteReauthFailures.get(remoteReauthFailureKey(user, purpose, req));
  return Boolean(record && record.lockedUntil && record.lockedUntil > Date.now());
}

function recordRemoteReauthFailure(user, purpose, req) {
  const key = remoteReauthFailureKey(user, purpose, req);
  const now = Date.now();
  const record = remoteReauthFailures.get(key) || { count: 0, resetAt: now + 10 * 60 * 1000, lockedUntil: 0 };
  if (record.resetAt <= now) {
    record.count = 0;
    record.resetAt = now + 10 * 60 * 1000;
    record.lockedUntil = 0;
  }
  record.count += 1;
  if (record.count >= 5) record.lockedUntil = now + 10 * 60 * 1000;
  remoteReauthFailures.set(key, record);
}

function clearRemoteReauthFailures(user, purpose, req) {
  remoteReauthFailures.delete(remoteReauthFailureKey(user, purpose, req));
}

function remoteReauthVerifier(user) {
  const auth2 = visibleUsers(readUsers()).find(item => item.active && item.username.toLowerCase() === 'auth2');
  return auth2 || user;
}

function verifyRemoteReauthPassword(password, user) {
  const verifier = remoteReauthVerifier(user);
  return {
    ok: verifyPassword(password, verifier),
    verifier
  };
}

function createRemoteReauthToken(req, user, purpose, sessionId = '') {
  const token = crypto.randomBytes(32).toString('hex');
  const ttlMs = Math.max(30 * 1000, Number(config.reauth.tokenTtlMs) || 30 * 60 * 1000);
  remoteReauthTokens.set(token, {
    userId: user.id,
    sid: cookies(req).sid || '',
    identity: requestIdentity(req),
    purpose,
    sessionId,
    expiresAt: Date.now() + ttlMs
  });
  return { token, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

function verifyRemoteReauthToken(req, user, purpose, sessionId = '', token = '', consume = false) {
  const record = remoteReauthTokens.get(String(token || ''));
  if (!record) return false;
  const ok = record.expiresAt > Date.now() &&
    record.userId === user.id &&
    record.sid === (cookies(req).sid || '') &&
    record.identity === requestIdentity(req) &&
    record.purpose === purpose &&
    (!record.sessionId || record.sessionId === sessionId);
  if (consume || !ok) remoteReauthTokens.delete(String(token || ''));
  return ok;
}

function remoteAdminReauth(req, res, next) {
  const token = req.headers['x-remote-reauth-token'] || req.query.reauthToken || req.body?.reauthToken;
  if (!verifyRemoteReauthToken(req, req.user, 'remote-admin', '', token, false)) {
    audit(req.user.username, 'REMOTE_ADMIN_REAUTH_REQUIRED', req.path, req);
    return res.status(403).json({ error: '远程会话配置需要二次认证，请重新打开配置会话' });
  }
  next();
}

function fileReauth(req, res, next) {
  const token = req.headers['x-file-reauth-token'] || req.headers['x-reauth-token'] || req.query.reauthToken || req.body?.reauthToken;
  if (!verifyRemoteReauthToken(req, req.user, 'file', '', token, false)) {
    audit(req.user.username, 'FILE_REAUTH_REQUIRED', req.path, req);
    return res.status(403).json({ error: '文件操作需要二次认证，请重新验证后再试' });
  }
  next();
}

function rateLimit(bucket, limit, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}|${req.socket.remoteAddress || '-'}`;
    const now = Date.now();
    const record = requestLimits.get(key);
    if (!record || record.resetAt <= now) {
      requestLimits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    record.count += 1;
    if (record.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }
    next();
  };
}

function captchaCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(5);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
}

function captchaSvg(code) {
  const colors = ['#315fd4', '#6a4fc8', '#16856a', '#ad4d58', '#3e587f'];
  const chars = [...code].map((char, index) => {
    const x = 21 + index * 27;
    const y = 31 + (crypto.randomBytes(1)[0] % 9) - 4;
    const rotate = (crypto.randomBytes(1)[0] % 25) - 12;
    return `<text x="${x}" y="${y}" fill="${colors[index]}" font-size="25" font-weight="700" font-family="monospace" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
  }).join('');
  const noise = Array.from({ length: 7 }, (_, index) => {
    const bytes = crypto.randomBytes(4);
    return `<line x1="${bytes[0] % 150}" y1="${bytes[1] % 44}" x2="${bytes[2] % 150}" y2="${bytes[3] % 44}" stroke="${colors[index % colors.length]}" stroke-opacity=".28" stroke-width="1"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="44" viewBox="0 0 150 44"><rect width="150" height="44" rx="7" fill="#f2f5fa"/>${noise}${chars}</svg>`;
}

function verifyCaptcha(req, res, next) {
  const token = String(req.body.captchaToken || '');
  const answer = String(req.body.captchaCode || '').trim().toUpperCase();
  const item = captchas.get(token);
  captchas.delete(token);
  if (!item || item.expiresAt < Date.now() || item.identity !== requestIdentity(req)) {
    return res.status(400).json({ error: '动态码已过期，请刷新后重试', captchaError: true });
  }
  const actual = crypto.createHash('sha256').update(answer).digest();
  const expected = Buffer.from(item.answerHash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(400).json({ error: '动态码不正确，请重新输入', captchaError: true });
  }
  next();
}

function authAttemptKey(kind, req) {
  return `${kind}|${requestIdentity(req)}`;
}

function currentAuthAttempt(kind, req) {
  const key = authAttemptKey(kind, req);
  const record = authAttempts.get(key);
  if (!record || record.resetAt <= Date.now()) return null;
  return record;
}

function captchaRequired(kind, req) {
  const record = currentAuthAttempt(kind, req);
  return Boolean(record && (record.failures >= 2 || record.attempts >= 2));
}

function requireCaptchaWhenRisky(kind) {
  return (req, res, next) => {
    if (!captchaRequired(kind, req)) return next();
    return verifyCaptcha(req, res, next);
  };
}

function trackAuthAttempt(kind) {
  return (req, res, next) => {
    const key = authAttemptKey(kind, req);
    const now = Date.now();
    const record = currentAuthAttempt(kind, req) || { attempts: 0, failures: 0, resetAt: now + 10 * 60 * 1000 };
    record.attempts += 1;
    authAttempts.set(key, record);
    res.on('finish', () => {
      const latest = authAttempts.get(key);
      if (!latest) return;
      if (res.statusCode >= 400) latest.failures += 1;
      else authAttempts.delete(key);
    });
    next();
  };
}

app.get('/api/captcha-policy', rateLimit('captcha-policy', 80, 60 * 1000), (req, res) => {
  const type = req.query.type === 'register' ? 'register' : 'login';
  res.setHeader('Cache-Control', 'no-store');
  res.json({ required: captchaRequired(type, req), freeAttempts: 2 });
});

app.get('/api/captcha', rateLimit('captcha', 40, 60 * 1000), (req, res) => {
  const code = captchaCode();
  const token = crypto.randomBytes(24).toString('hex');
  captchas.set(token, {
    answerHash: crypto.createHash('sha256').update(code).digest('hex'),
    identity: requestIdentity(req),
    expiresAt: Date.now() + 3 * 60 * 1000
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    token,
    image: `data:image/svg+xml;base64,${Buffer.from(captchaSvg(code)).toString('base64')}`,
    expiresIn: 180
  });
});

function auth(req, res, next) {
  const session = sessions.get(cookies(req).sid);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: '请先登录' });
  const user = readUsers().find(item => item.id === session.userId && item.active && !item.deletedAt);
  if (!user) return res.status(401).json({ error: '登录已失效' });
  session.expires = Date.now() + config.session.timeoutMs;
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, groupPath: user.groupPath || '', active: user.active, createdAt: user.createdAt };
}

function canViewResources(user) {
  return user.role === 'admin' || config.resources.allowUsers !== false;
}

function diskUsage(targetPath) {
  try {
    const output = execFileSync('df', ['-Pk', targetPath], { encoding: 'utf8', timeout: 3000 }).trim().split('\n').pop();
    const parts = output.trim().split(/\s+/);
    const size = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const available = Number(parts[3]) * 1024;
    return { path: targetPath, size, used, available, percent: size ? Math.round((used / size) * 1000) / 10 : 0 };
  } catch (error) {
    return { path: targetPath, error: error.message };
  }
}

function directoryStats(root) {
  const stats = { path: root, files: 0, directories: 0, size: 0 };
  if (!fs.existsSync(root)) return stats;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stats.directories += 1;
          stack.push(full);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          stats.files += 1;
          stats.size += stat.size;
        }
      } catch (_) {}
    }
  }
  return stats;
}

function serverResources() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const cpus = os.cpus();
  const loadAverage = os.loadavg();
  const processMemory = process.memoryUsage();
  return {
    collectedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: os.uptime()
    },
    cpu: {
      model: cpus[0]?.model || 'unknown',
      cores: cpus.length,
      loadAverage,
      loadPercent: cpus.length ? Math.round((loadAverage[0] / cpus.length) * 1000) / 10 : 0
    },
    memory: {
      total: totalMemory,
      used: usedMemory,
      free: freeMemory,
      percent: totalMemory ? Math.round((usedMemory / totalMemory) * 1000) / 10 : 0
    },
    disk: diskUsage(FILES),
    userFiles: directoryStats(path.join(FILES, 'users')),
    process: {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      rss: processMemory.rss,
      heapUsed: processMemory.heapUsed,
      heapTotal: processMemory.heapTotal
    }
  };
}

app.post('/api/register', rateLimit('register', 12, 10 * 60 * 1000), requireCaptchaWhenRisky('register'), trackAuthAttempt('register'), (req, res) => {
  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');
  const inviteCode = String(req.body.inviteCode || '').trim().toUpperCase();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({ error: '用户名需为 3-32 位字母、数字或 ._-' });
  if (displayName.length < 2 || displayName.length > 40) return res.status(400).json({ error: '姓名需为 2-40 个字符' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
  const users = readUsers();
  if (users.some(item => item.username.toLowerCase() === username.toLowerCase() && !item.deletedAt)) return res.status(409).json({ error: '用户名已存在' });
  const firstUser = visibleUsers(users).length === 0;
  const invites = readInvites();
  let invitation = null;
  if (!firstUser) {
    if (!inviteCode) return res.status(400).json({ error: '请输入推荐码' });
    invitation = invites.find(item => item.code === inviteCode);
    if (!invitation || !invitation.active || invitation.usedByUserId) return res.status(400).json({ error: '推荐码无效、已停用或已被使用' });
    if (!users.some(item => item.id === invitation.ownerUserId && item.active && !item.deletedAt)) return res.status(400).json({ error: '推荐码所属用户已停用' });
  }
  const secured = hashPassword(password);
  const user = {
    id: crypto.randomUUID(), username, displayName,
    passwordHash: secured.hash, salt: secured.salt,
    role: firstUser ? 'admin' : 'user',
    groupPath: '',
    active: true,
    invitedByUserId: invitation ? invitation.ownerUserId : null,
    inviteCodeId: invitation ? invitation.id : null,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  if (invitation) {
    invitation.usedByUserId = user.id;
    invitation.usedAt = new Date().toISOString();
  }
  issueInvites(user.id, firstUser ? config.registration.adminInviteCount : config.registration.userInviteCount, invites);
  writeUsers(users);
  writeInvites(invites);
  audit(username, 'REGISTER', user.role, req);
  res.status(201).json({ message: firstUser ? `管理员账号已创建，并获得 ${config.registration.adminInviteCount} 个推荐码` : `账号已创建，并获得 ${config.registration.userInviteCount} 个推荐码` });
});

app.get('/api/registration-status', (req, res) => {
  res.json({ firstUser: visibleUsers().length === 0, adminInviteCount: config.registration.adminInviteCount, userInviteCount: config.registration.userInviteCount });
});

app.post('/api/login', rateLimit('login', 20, 10 * 60 * 1000), requireCaptchaWhenRisky('login'), trackAuthAttempt('login'), (req, res) => {
  const username = String(req.body.username || '').trim();
  const user = readUsers().find(item => item.username.toLowerCase() === username.toLowerCase() && !item.deletedAt);
  if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user)) {
    audit(username, 'LOGIN_FAILED', '', req);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { userId: user.id, expires: Date.now() + config.session.timeoutMs });
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.session.timeoutMs / 1000)}`);
  audit(username, 'LOGIN', '', req);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
  sessions.delete(cookies(req).sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  audit(req.user.username, 'LOGOUT', '', req);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), features: { resources: canViewResources(req.user) } }));

app.get('/api/server-resources', auth, (req, res) => {
  if (!canViewResources(req.user)) return res.status(403).json({ error: '当前账号无权查看服务器资源' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(serverResources());
});

app.put('/api/me/password', auth, (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!verifyPassword(current, req.user)) return res.status(400).json({ error: '当前密码不正确' });
  if (next.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  const users = readUsers();
  const user = users.find(item => item.id === req.user.id);
  const secured = hashPassword(next);
  user.salt = secured.salt;
  user.passwordHash = secured.hash;
  writeUsers(users);
  audit(user.username, 'PASSWORD_CHANGED', '修改自己的密码', req);
  res.json({ message: '密码已修改' });
});

app.get('/api/users', auth, adminOnly, (req, res) => {
  const allUsers = readUsers();
  const users = visibleUsers(allUsers);
  const invites = readInvites();
  const query = String(req.query.q || '').trim().toLowerCase();
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
  const filtered = query
    ? users.filter(user => user.username.toLowerCase().includes(query) || user.displayName.toLowerCase().includes(query) || (user.groupPath || '').toLowerCase().includes(query))
    : users;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(req.query.page) || 1));
  const pageUsers = filtered.slice((page - 1) * pageSize, page * pageSize);
  res.json({
    users: pageUsers.map(user => {
      const inviter = allUsers.find(item => item.id === user.invitedByUserId);
      const invitation = invites.find(item => item.id === user.inviteCodeId);
      return {
        ...publicUser(user),
        inviter: inviter ? publicUser(inviter) : null,
        inviteCode: invitation ? invitation.code : null
      };
    }),
    pagination: { page, pageSize, total, totalPages }
  });
});

app.get('/api/user-options', auth, adminOnly, (req, res) => {
  const users = readUsers()
    .filter(user => user.active && !user.deletedAt)
    .map(user => ({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, groupPath: user.groupPath || '' }));
  const groups = [...new Set(users.map(user => normalizeUserGroupPath(user.groupPath)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  res.json({
    users,
    groups
  });
});

app.get('/api/admin/audit-logs', auth, adminOnly, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const username = String(req.query.username || '').trim().toLowerCase();
  const action = String(req.query.action || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 30));
  const allLogs = readAuditLogs().slice().reverse();
  const filtered = allLogs.filter(item => {
    const createdAt = item.createdAt || '';
    if (username && String(item.username || '').toLowerCase() !== username) return false;
    if (action && item.action !== action) return false;
    if (from && createdAt < from) return false;
    if (to && createdAt > to) return false;
    if (query) {
      const text = `${item.username || ''} ${item.action || ''} ${item.detail || ''} ${item.ip || ''} ${item.userAgent || ''}`.toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  });
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(req.query.page) || 1));
  const actions = [...new Set(readAuditLogs().map(item => item.action).filter(Boolean))].sort();
  res.json({
    logs: filtered.slice((page - 1) * pageSize, page * pageSize),
    actions,
    pagination: { page, pageSize, total, totalPages }
  });
});

app.get('/api/users/:id/referral-chain', auth, adminOnly, (req, res) => {
  const users = readUsers();
  const invites = readInvites();
  const target = users.find(item => item.id === req.params.id && !item.deletedAt);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  const fullChain = [];
  const visited = new Set();
  let current = target;
  const maxDepth = 5000;
  while (current && !visited.has(current.id) && fullChain.length < maxDepth) {
    visited.add(current.id);
    const invitation = invites.find(item => item.id === current.inviteCodeId);
    fullChain.push({
      user: publicUser(current),
      inviteCode: invitation ? invitation.code : null,
      registeredAt: current.createdAt
    });
    current = current.invitedByUserId ? users.find(item => item.id === current.invitedByUserId) : null;
  }

  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 30));
  res.json({
    chain: fullChain.slice(offset, offset + limit),
    pagination: {
      offset,
      limit,
      total: fullChain.length,
      hasMore: offset + limit < fullChain.length
    },
    cycleDetected: Boolean(current && visited.has(current.id)),
    truncated: Boolean(current && !visited.has(current.id) && fullChain.length >= maxDepth)
  });
});

function inviteView(invite, users) {
  const owner = users.find(item => item.id === invite.ownerUserId);
  const usedBy = users.find(item => item.id === invite.usedByUserId);
  return {
    ...invite,
    owner: owner ? publicUser(owner) : null,
    usedBy: usedBy ? publicUser(usedBy) : null,
    status: invite.usedByUserId ? 'used' : invite.active ? 'available' : 'disabled'
  };
}

app.get('/api/invites/mine', auth, (req, res) => {
  const users = readUsers();
  const invites = readInvites().filter(item => item.ownerUserId === req.user.id).map(item => inviteView(item, users));
  res.json({ invites });
});

app.get('/api/invites', auth, adminOnly, (req, res) => {
  const users = readUsers();
  const allInvites = readInvites();
  const pageSize = Math.min(100, Math.max(20, Number(req.query.pageSize) || 50));
  const total = allInvites.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(req.query.page) || 1));
  res.json({
    invites: allInvites.slice((page - 1) * pageSize, page * pageSize).map(item => inviteView(item, users)),
    pagination: { page, pageSize, total, totalPages }
  });
});

app.post('/api/invites', auth, adminOnly, (req, res) => {
  const count = Number(req.body.count || 1);
  const ownerUserId = String(req.body.ownerUserId || req.user.id);
  const users = readUsers();
  const owner = users.find(item => item.id === ownerUserId && !item.deletedAt);
  if (!owner) return res.status(404).json({ error: '所属用户不存在' });
  if (!Number.isInteger(count) || count < 1 || count > 20) return res.status(400).json({ error: '每次可生成 1-20 个推荐码' });
  const invites = readInvites();
  issueInvites(ownerUserId, count, invites);
  writeInvites(invites);
  audit(req.user.username, 'INVITES_CREATED', `${owner.username} x${count}`, req);
  res.status(201).json({ message: `已为 ${owner.displayName} 生成 ${count} 个推荐码` });
});

app.patch('/api/invites/:id', auth, adminOnly, (req, res) => {
  const invites = readInvites();
  const invite = invites.find(item => item.id === req.params.id);
  if (!invite) return res.status(404).json({ error: '推荐码不存在' });
  if (invite.usedByUserId) return res.status(400).json({ error: '已使用的推荐码不能修改' });
  if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: '状态参数无效' });
  invite.active = req.body.active;
  writeInvites(invites);
  audit(req.user.username, invite.active ? 'INVITE_ENABLED' : 'INVITE_DISABLED', invite.code, req);
  res.json({ message: invite.active ? '推荐码已启用' : '推荐码已停用' });
});

app.patch('/api/users/:id', auth, adminOnly, (req, res) => {
  const users = readUsers();
  const user = users.find(item => item.id === req.params.id && !item.deletedAt);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.id === req.user.id && req.body.active === false) return res.status(400).json({ error: '不能停用当前账号' });
  if (['admin', 'user'].includes(req.body.role)) user.role = req.body.role;
  if (typeof req.body.active === 'boolean') user.active = req.body.active;
  if (typeof req.body.displayName === 'string' && req.body.displayName.trim()) user.displayName = req.body.displayName.trim().slice(0, 40);
  if (typeof req.body.groupPath === 'string') user.groupPath = normalizeUserGroupPath(req.body.groupPath);
  let passwordReset = false;
  if (typeof req.body.newPassword === 'string' && req.body.newPassword) {
    if (req.body.newPassword.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
    const secured = hashPassword(req.body.newPassword);
    user.salt = secured.salt;
    user.passwordHash = secured.hash;
    passwordReset = true;
  }
  writeUsers(users);
  audit(req.user.username, 'USER_UPDATED', user.username, req);
  if (passwordReset) audit(req.user.username, 'USER_PASSWORD_RESET', user.username, req);
  res.json({ user: publicUser(user) });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const users = readUsers();
  const user = users.find(item => item.id === req.params.id && !item.deletedAt);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.id === req.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
  const activeAdmins = users.filter(item => item.role === 'admin' && item.active && !item.deletedAt);
  if (user.role === 'admin' && activeAdmins.length <= 1) return res.status(400).json({ error: '不能删除最后一个可用管理员' });

  user.active = false;
  user.deletedAt = new Date().toISOString();
  writeUsers(users);

  const invites = readInvites();
  invites.forEach(invite => {
    if (invite.ownerUserId === user.id && !invite.usedByUserId) invite.active = false;
  });
  writeInvites(invites);

  const remoteSessions = readRemoteSessions();
  remoteSessions.forEach(item => {
    item.allowedUserIds = (item.allowedUserIds || []).filter(id => id !== user.id);
  });
  writeRemoteSessions(remoteSessions);

  for (const [sid, session] of sessions) if (session.userId === user.id) sessions.delete(sid);
  audit(req.user.username, 'USER_DELETED', user.username, req);
  res.json({ message: '用户已删除' });
});

app.get('/api/remote-sessions', auth, (req, res) => {
  const users = readUsers();
  const allSessions = readRemoteSessions();
  const remoteSessions = enrichRemoteSessionViews(
    allSessions.filter(item => item.active && (
      req.user.role === 'admin' ||
      (item.allowedUserIds || []).includes(req.user.id) ||
      userInAllowedGroup(req.user.groupPath, item.allowedGroupPaths)
    )),
    users,
    req.user.role === 'admin',
    allSessions
  );
  res.json({ sessions: remoteSessions });
});

function canUseRemoteSession(user, savedSession) {
  return savedSession && savedSession.active && (
    user.role === 'admin' ||
    (savedSession.allowedUserIds || []).includes(user.id) ||
    userInAllowedGroup(user.groupPath, savedSession.allowedGroupPaths)
  );
}

app.post('/api/remote-reauth', auth, rateLimit('remote-reauth', 30, 10 * 60 * 1000), (req, res) => {
  const requestedPurpose = String(req.body.purpose || '');
  const purpose = requestedPurpose === 'admin' || requestedPurpose === 'remote-admin'
    ? 'remote-admin'
    : requestedPurpose === 'file' || requestedPurpose === 'file-access'
      ? 'file'
      : 'remote-connect';
  const sessionId = String(req.body.sessionId || '');
  const password = String(req.body.password || '');
  if (remoteReauthLocked(req.user, purpose, req)) {
    audit(req.user.username, 'REMOTE_REAUTH_LOCKED', purpose, req);
    return res.status(429).json({ error: '二次认证失败次数过多，请 10 分钟后再试' });
  }
  const passwordCheck = verifyRemoteReauthPassword(password, req.user);
  if (!passwordCheck.ok) {
    recordRemoteReauthFailure(req.user, purpose, req);
    audit(req.user.username, 'REMOTE_REAUTH_FAILED', purpose === 'remote-connect' ? sessionId : purpose, req);
    return res.status(400).json({ error: '二次认证密码不正确' });
  }
  if (purpose === 'remote-admin') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可配置远程会话' });
  } else if (purpose === 'remote-connect') {
    const savedSession = readRemoteSessions().find(item => item.id === sessionId);
    if (!canUseRemoteSession(req.user, savedSession)) return res.status(403).json({ error: '远程会话不存在或未授权' });
  }
  clearRemoteReauthFailures(req.user, purpose, req);
  const token = createRemoteReauthToken(req, req.user, purpose, purpose === 'remote-connect' ? sessionId : '');
  audit(req.user.username, 'REMOTE_REAUTH_SUCCESS', `${purpose === 'remote-connect' ? sessionId : purpose} verifier=${passwordCheck.verifier.username}`, req);
  res.json(token);
});
app.get('/api/admin/remote-sessions', auth, adminOnly, remoteAdminReauth, (req, res) => {
  const users = readUsers();
  const query = String(req.query.q || '').trim().toLowerCase();
  const group = normalizeRemoteGroupPath(req.query.group || '');
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
  const allSessions = readRemoteSessions();
  const filtered = allSessions.filter(item => {
    const itemGroup = item.groupPath || '';
    const matchesGroup = !group || itemGroup === group || itemGroup.startsWith(`${group}/`);
    const text = `${item.name || ''} ${itemGroup} ${item.username || ''} ${item.host || ''} ${item.port || ''}`.toLowerCase();
    return matchesGroup && (!query || text.includes(query));
  });
  filtered.sort((a, b) => `${a.groupPath || ''}/${a.name || ''}`.localeCompare(`${b.groupPath || ''}/${b.name || ''}`, 'zh-CN'));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(req.query.page) || 1));
  const groups = [...new Set(allSessions.map(item => item.groupPath || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  res.json({
    sessions: enrichRemoteSessionViews(filtered.slice((page - 1) * pageSize, page * pageSize), users, true, allSessions),
    groups,
    pagination: { page, pageSize, total, totalPages }
  });
});

app.get('/api/admin/remote-session-options', auth, adminOnly, remoteAdminReauth, (req, res) => {
  const excludeId = String(req.query.excludeId || '');
  const sessions = readRemoteSessions()
    .filter(item => item.active && item.id !== excludeId && hasSavedCredential(item))
    .sort((a, b) => `${a.groupPath || ''}/${a.name || ''}`.localeCompare(`${b.groupPath || ''}/${b.name || ''}`, 'zh-CN'))
    .map(item => ({
      id: item.id,
      name: item.name,
      groupPath: item.groupPath || '',
      host: item.host,
      port: item.port,
      username: item.username
    }));
  res.json({ sessions });
});

app.post('/api/admin/remote-sessions', auth, adminOnly, remoteAdminReauth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const groupPath = normalizeRemoteGroupPath(req.body.groupPath || '');
  const host = String(req.body.host || '').trim();
  const port = Number(req.body.port || 22);
  const username = String(req.body.username || '').trim();
  const authType = req.body.authType === 'privateKey' ? 'privateKey' : 'password';
  const connectionMode = normalizeConnectionMode(req.body.connectionMode);
  const jumpSessionId = normalizeJumpSessionId(req.body.jumpSessionId, connectionMode);
  const credential = String(req.body.credential || '');
  const users = readUsers();
  const allowedUserIds = [...new Set(Array.isArray(req.body.allowedUserIds) ? req.body.allowedUserIds.map(String) : [])]
    .filter(id => users.some(user => user.id === id && !user.deletedAt));
  const allowedGroupPaths = [...new Set(Array.isArray(req.body.allowedGroupPaths) ? req.body.allowedGroupPaths.map(normalizeUserGroupPath) : [])].filter(Boolean);
  const remoteSessions = readRemoteSessions();
  const validationError = validateRemoteSessionInput({ name, host, port, username, credential, authType, connectionMode, jumpSessionId, remoteSessions });
  if (validationError) return res.status(400).json({ error: validationError });
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    name, groupPath, host, port, username, authType, connectionMode, jumpSessionId,
    credential: credential ? encryptSecret(credential) : null,
    allowedUserIds,
    allowedGroupPaths,
    active: req.body.active !== false,
    createdAt: now,
    updatedAt: now
  };
  remoteSessions.push(item);
  writeRemoteSessions(remoteSessions);
  audit(req.user.username, 'REMOTE_SESSION_CREATED', `${groupPath ? `${groupPath}/` : ''}${name} ${username}@${host}:${port}${connectionMode === 'jump' ? ` via ${jumpSessionId}` : ''}`, req);
  res.status(201).json({ session: remoteSessionView(item, users, true) });
});

app.patch('/api/admin/remote-sessions/:id', auth, adminOnly, remoteAdminReauth, (req, res) => {
  const remoteSessions = readRemoteSessions();
  const item = remoteSessions.find(session => session.id === req.params.id);
  if (!item) return res.status(404).json({ error: '远程会话不存在' });
  const users = readUsers();
  const name = String(req.body.name || '').trim();
  const groupPath = normalizeRemoteGroupPath(req.body.groupPath || '');
  const host = String(req.body.host || '').trim();
  const port = Number(req.body.port || 22);
  const username = String(req.body.username || '').trim();
  const authType = req.body.authType === 'privateKey' ? 'privateKey' : 'password';
  const previousAuthType = item.authType;
  const connectionMode = normalizeConnectionMode(req.body.connectionMode);
  const jumpSessionId = normalizeJumpSessionId(req.body.jumpSessionId, connectionMode);
  const credential = typeof req.body.credential === 'string' ? req.body.credential : '';
  const credentialAction = ['keep', 'update', 'clear'].includes(req.body.credentialAction) ? req.body.credentialAction : (credential ? 'update' : 'keep');
  const willKeepExisting = credentialAction === 'keep' && authType === previousAuthType;
  const willUpdateCredential = credentialAction === 'update' && Boolean(credential);
  const willClearCredential = credentialAction === 'clear' || (credentialAction === 'keep' && authType !== previousAuthType);
  const validationCredential = authType === 'privateKey' && !willKeepExisting && !willUpdateCredential ? '' : 'ok';
  const validationError = validateRemoteSessionInput({
    name,
    host,
    port,
    username,
    credential: validationCredential,
    authType,
    connectionMode,
    jumpSessionId,
    remoteSessions,
    sessionId: item.id
  });
  if (validationError) return res.status(400).json({ error: validationError });
  if (credentialAction === 'update' && !credential) return res.status(400).json({ error: '请选择更新凭据时必须填写新密码或新私钥' });
  const willHaveCredential = willUpdateCredential || (willKeepExisting && Boolean(item.credential));
  if (authType === 'privateKey' && !willHaveCredential) return res.status(400).json({ error: '私钥认证必须保存私钥' });
  if (authType === 'password' && !willHaveCredential && isUsedAsJump(remoteSessions, item.id)) {
    return res.status(400).json({ error: '该会话正在作为跳板使用，必须保存 SSH 密码' });
  }
  item.name = name;
  item.groupPath = groupPath;
  item.host = host;
  item.port = port;
  item.username = username;
  item.authType = authType;
  item.connectionMode = connectionMode;
  item.jumpSessionId = jumpSessionId;
  item.allowedUserIds = [...new Set(Array.isArray(req.body.allowedUserIds) ? req.body.allowedUserIds.map(String) : [])]
    .filter(id => users.some(user => user.id === id && !user.deletedAt));
  item.allowedGroupPaths = [...new Set(Array.isArray(req.body.allowedGroupPaths) ? req.body.allowedGroupPaths.map(normalizeUserGroupPath) : [])].filter(Boolean);
  item.active = req.body.active !== false;
  if (willUpdateCredential) item.credential = encryptSecret(credential);
  else if (willClearCredential) item.credential = null;
  item.updatedAt = new Date().toISOString();
  writeRemoteSessions(remoteSessions);
  audit(req.user.username, 'REMOTE_SESSION_UPDATED', `${groupPath ? `${groupPath}/` : ''}${name} ${username}@${host}:${port}${connectionMode === 'jump' ? ` via ${jumpSessionId}` : ''}`, req);
  res.json({ session: remoteSessionView(item, users, true) });
});
app.delete('/api/admin/remote-sessions/:id', auth, adminOnly, remoteAdminReauth, (req, res) => {
  const remoteSessions = readRemoteSessions();
  const index = remoteSessions.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: '远程会话不存在' });
  const usedBy = remoteSessions.find(item => item.jumpSessionId === req.params.id);
  if (usedBy) return res.status(400).json({ error: `该会话正在被「${usedBy.name}」作为跳板使用，请先修改引用关系` });
  const [removed] = remoteSessions.splice(index, 1);
  writeRemoteSessions(remoteSessions);
  audit(req.user.username, 'REMOTE_SESSION_DELETED', removed.name, req);
  res.json({ message: '远程会话已删除' });
});

function safeRelative(input = '') {
  const normalized = path.posix.normalize(`/${String(input).replace(/\\/g, '/')}`).slice(1);
  if (normalized.startsWith('..') || normalized.includes('/../')) throw new Error('非法路径');
  return normalized;
}

function userFileRoot(user) {
  const root = path.resolve(FILES, 'users', user.id);
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  return root;
}

function allUsersFileRoot() {
  const root = path.resolve(FILES, 'users');
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  return root;
}

function fileScope(req) {
  const requested = req.user.role === 'admin' && req.query.scope === 'all' ? 'all' : 'mine';
  return requested;
}

function fileRootForScope(user, scope) {
  return scope === 'all' && user.role === 'admin' ? allUsersFileRoot() : userFileRoot(user);
}

function filePathForScope(user, scope, relative = '') {
  const root = fileRootForScope(user, scope);
  const target = path.resolve(root, safeRelative(relative));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('非法路径');
  return target;
}

function publicFileName(name, scope, relative, users) {
  if (scope !== 'all' || relative) return name;
  const user = users.find(item => item.id === name);
  return user ? `${user.displayName}（@${user.username}）` : name;
}

app.get('/api/files', auth, async (req, res) => {
  try {
    const scope = fileScope(req);
    if (scope === 'all' && !verifyRemoteReauthToken(req, req.user, 'file', '', req.headers['x-file-reauth-token'] || req.headers['x-reauth-token'] || req.query.reauthToken, false)) {
      audit(req.user.username, 'FILE_REAUTH_REQUIRED', 'list-all-users', req);
      return res.status(403).json({ error: '查看全部用户文件需要二次认证' });
    }
    const relative = safeRelative(req.query.path || '');
    const target = filePathForScope(req.user, scope, relative);
    if (scope === 'all' && !relative) {
      visibleUsers().forEach(user => userFileRoot(user));
    }
    const users = scope === 'all' && !relative ? visibleUsers() : [];
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const items = await Promise.all(entries.filter(e => !e.name.startsWith('.')).map(async entry => {
      const stat = await fsp.stat(path.join(target, entry.name));
      return { name: entry.name, displayName: publicFileName(entry.name, scope, relative, users), type: entry.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }));
    items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'directory' ? -1 : 1);
    res.json({ path: relative, scope, items });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const scope = fileScope(req);
        const relative = safeRelative(req.query.path || '');
        if (scope === 'all' && !relative) throw new Error('请先进入某个用户目录再上传文件');
        cb(null, filePathForScope(req.user, scope, relative));
      } catch (e) { cb(e); }
    },
    filename: (req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).replace(/[\x00-\x1f]/g, '_'))
  }),
  limits: { fileSize: config.files.maxUploadBytes, files: config.files.maxUploadFiles }
});

app.post('/api/files/upload', auth, fileReauth, upload.array('files', 10), (req, res) => {
  audit(req.user.username, 'FILES_UPLOADED', `${fileScope(req)}:${safeRelative(req.query.path || '') || '/'} ${(req.files || []).map(f => f.filename).join(',')}`, req);
  res.json({ message: `已上传 ${(req.files || []).length} 个文件` });
});

app.post('/api/files/folder', auth, fileReauth, async (req, res) => {
  try {
    const scope = req.user.role === 'admin' && req.body.scope === 'all' ? 'all' : 'mine';
    const relative = safeRelative(req.body.path || '');
    if (scope === 'all' && !relative) throw new Error('请先进入某个用户目录再新建文件夹');
    const name = path.basename(String(req.body.name || '').trim());
    if (!name || name === '.' || name === '..') throw new Error('文件夹名称无效');
    await fsp.mkdir(filePathForScope(req.user, scope, path.posix.join(relative, name)), { recursive: false });
    audit(req.user.username, 'FOLDER_CREATED', `${scope}:${path.posix.join(relative, name)}`, req);
    res.json({ message: '文件夹已创建' });
  } catch (error) { res.status(400).json({ error: error.code === 'EEXIST' ? '文件夹已存在' : error.message }); }
});

app.get('/api/files/download', auth, fileReauth, (req, res) => {
  try {
    const scope = fileScope(req);
    const target = filePathForScope(req.user, scope, req.query.path || '');
    if (!fs.statSync(target).isFile()) throw new Error('只能下载文件');
    audit(req.user.username, 'FILE_DOWNLOADED', `${scope}:${safeRelative(req.query.path || '')}`, req);
    res.download(target);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/files', auth, fileReauth, async (req, res) => {
  try {
    const scope = fileScope(req);
    const relative = safeRelative(req.query.path || '');
    if (!relative) throw new Error('不能删除根目录');
    const target = filePathForScope(req.user, scope, relative);
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) await fsp.rmdir(target);
    else await fsp.unlink(target);
    audit(req.user.username, 'FILE_DELETED', `${scope}:${relative}`, req);
    res.json({ message: '已删除' });
  } catch (error) { res.status(400).json({ error: error.code === 'ENOTEMPTY' ? '文件夹非空，不能删除' : error.message }); }
});

function isPrivateHost(host) {
  if (host === 'localhost') return true;
  const version = net.isIP(host);
  if (version === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  }
  return version === 6 && (host === '::1' || host.toLowerCase().startsWith('fd') || host.toLowerCase().startsWith('fc'));
}

function buildSshConfig(savedSession, sock = null, runtimeCredential = '') {
  const { host, port, username } = savedSession;
  const sshConfig = { host, port, username, readyTimeout: 12000, keepaliveInterval: 10000 };
  if (sock) sshConfig.sock = sock;
  const credential = savedSession.credential ? decryptSecret(savedSession.credential) : runtimeCredential;
  if (!credential) throw new Error(savedSession.authType === 'privateKey' ? 'SSH 私钥未配置' : '请输入本次 SSH 登录密码');
  if (savedSession.authType === 'privateKey') sshConfig.privateKey = credential;
  else sshConfig.password = credential;
  return sshConfig;
}

function connectSshClient(savedSession, sock = null, runtimeCredential = '') {
  return new Promise((resolve, reject) => {
    const sshClient = new Client();
    let settled = false;
    sshClient.once('ready', () => {
      settled = true;
      resolve(sshClient);
    });
    sshClient.once('error', error => {
      if (!settled) reject(error);
    });
    try {
      sshClient.connect(buildSshConfig(savedSession, sock, runtimeCredential));
    } catch (error) {
      reject(error);
    }
  });
}

function forwardThroughJump(jumpClient, targetSession) {
  return new Promise((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, targetSession.host, targetSession.port, (error, channel) => {
      if (error) return reject(error);
      resolve(channel);
    });
  });
}

async function openSshSession(savedSession, allRemoteSessions, depth = 0, visited = new Set(), runtimeCredentials = new Map()) {
  if (depth > 3) throw new Error('跳板层级过深，最多支持 3 层');
  if (visited.has(savedSession.id)) throw new Error('跳板会话存在循环引用');
  visited.add(savedSession.id);

  if (savedSession.connectionMode === 'jump') {
    const jumpSession = allRemoteSessions.find(item => item.id === savedSession.jumpSessionId && item.active);
    if (!jumpSession) throw new Error('跳板会话不存在或未启用');
    const jump = await openSshSession(jumpSession, allRemoteSessions, depth + 1, visited, runtimeCredentials);
    const tunnel = await forwardThroughJump(jump.client, savedSession);
    const client = await connectSshClient(savedSession, tunnel, runtimeCredentials.get(savedSession.id) || '');
    return {
      client,
      chain: [client, ...jump.chain],
      via: [...jump.via, jumpSession.name]
    };
  }

  const client = await connectSshClient(savedSession, null, runtimeCredentials.get(savedSession.id) || '');
  return { client, chain: [client], via: [] };
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws/terminal') return socket.destroy();
  const session = sessions.get(cookies(req).sid);
  const user = session && readUsers().find(item => item.id === session.userId && item.active && !item.deletedAt);
  if (!user) return socket.destroy();
  req.user = user;
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  let client;
  let chainClients = [];
  let stream;
  let connected = false;
  ws.on('message', async raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    if (message.type === 'connect' && !connected) {
      const allRemoteSessions = readRemoteSessions();
      const savedSession = allRemoteSessions.find(item => item.id === String(message.sessionId || ''));
      const authorized = savedSession && savedSession.active &&
        (
          req.user.role === 'admin' ||
          (savedSession.allowedUserIds || []).includes(req.user.id) ||
          userInAllowedGroup(req.user.groupPath, savedSession.allowedGroupPaths)
        );
      if (!authorized) return ws.send(JSON.stringify({ type: 'error', message: '远程会话不存在或未授权' }));
      if (!verifyRemoteReauthToken(req, req.user, 'remote-connect', savedSession.id, message.reauthToken, false)) {
        audit(req.user.username, 'REMOTE_REAUTH_TOKEN_INVALID', savedSession.name, req);
        return ws.send(JSON.stringify({ type: 'error', message: '远程会话二次认证已失效，请重新连接' }));
      }
      const { host, port, username } = savedSession;
      connected = true;
      try {
        const runtimeCredentials = new Map();
        if (!savedSession.credential) {
          const sshPassword = String(message.sshPassword || '');
          if (savedSession.authType !== 'password' || !sshPassword) throw new Error('请输入本次 SSH 登录密码');
          runtimeCredentials.set(savedSession.id, sshPassword);
        }
        const opened = await openSshSession(savedSession, allRemoteSessions, 0, new Set(), runtimeCredentials);
        client = opened.client;
        chainClients = opened.chain;
        client.on('error', error => {
          audit(req.user.username, 'SSH_FAILED', `${savedSession.name} ${username}@${host}:${port} ${error.message}`, req);
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: error.message }));
          connected = false;
        });
        client.shell({ term: 'xterm-256color', cols: message.cols || 100, rows: message.rows || 28 }, (error, channel) => {
          if (error) return ws.send(JSON.stringify({ type: 'error', message: error.message }));
          stream = channel;
          const viaText = opened.via.length ? ` via ${opened.via.join(' -> ')}` : '';
          audit(req.user.username, 'SSH_CONNECTED', `${savedSession.name} ${username}@${host}:${port}${viaText}`, req);
          ws.send(JSON.stringify({ type: 'ready', name: savedSession.name, target: `${username}@${host}${viaText}` }));
          stream.on('data', data => ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') })));
          stream.stderr.on('data', data => ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') })));
          stream.on('close', () => ws.close());
        });
      } catch (error) {
        connected = false;
        audit(req.user.username, 'SSH_FAILED', `${savedSession.name} ${username}@${host}:${port} ${error.message}`, req);
        return ws.send(JSON.stringify({ type: 'error', message: error.message.includes('Unsupported state') ? '会话凭据无法解密，请联系管理员重新保存' : error.message }));
      }
    } else if (message.type === 'data' && stream) stream.write(String(message.data || ''));
    else if (message.type === 'resize' && stream) stream.setWindow(Number(message.rows) || 28, Number(message.cols) || 100, 0, 0);
  });
  ws.on('close', () => {
    if (stream) stream.end();
    [...new Set(chainClients)].forEach(item => item.end());
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) if (session.expires < now) sessions.delete(sid);
  for (const [token, captcha] of captchas) if (captcha.expiresAt < now) captchas.delete(token);
  for (const [key, record] of requestLimits) if (record.resetAt < now) requestLimits.delete(key);
  for (const [token, record] of remoteReauthTokens) if (record.expiresAt < now) remoteReauthTokens.delete(token);
  for (const [key, record] of remoteReauthFailures) if (record.resetAt < now && (!record.lockedUntil || record.lockedUntil < now)) remoteReauthFailures.delete(key);
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Control portal listening on http://${HOST}:${PORT}`);
});
