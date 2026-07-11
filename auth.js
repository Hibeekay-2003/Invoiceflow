// auth.js — Shared-password authentication for InvoiceFlow
//
// Design notes:
// - One shared password (not per-user accounts), set via env var.
// - Sessions are stateless signed tokens (HMAC-SHA256), not stored server-side,
//   so logins survive server restarts/redeploys on Railway.
// - No external dependencies — plain Node `crypto`.
//
// Required env vars (set these in Railway → Variables):
//   INVOICEFLOW_PASSWORD   the shared login password
//   SESSION_SECRET         a long random string, e.g. `openssl rand -hex 32`
//
// If SESSION_SECRET isn't set, a random one is generated at boot as a fallback —
// that works, but every restart invalidates existing sessions, so set it explicitly.

const crypto = require('crypto');

const AUTH_PASSWORD = process.env.INVOICEFLOW_PASSWORD || 'changeme';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'invoiceflow_session';

if (!process.env.INVOICEFLOW_PASSWORD) {
  console.warn('[auth] WARNING: INVOICEFLOW_PASSWORD is not set — using the default "changeme". Set it in your environment.');
}

const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] WARNING: SESSION_SECRET is not set — sessions will be invalidated on every restart. Set it in your environment.');
}

function sign(data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---- Session tokens (stateless) ----

function createSessionToken() {
  const expires = Date.now() + SESSION_DURATION_MS;
  const payload = Buffer.from(JSON.stringify({ exp: expires })).toString('base64url');
  const signature = sign(payload);
  return { token: `${payload}.${signature}`, expires };
}

function isValidToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expectedSignature = sign(payload);
  if (!timingSafeStringEqual(signature, expectedSignature)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch {
    return false;
  }
}

// ---- Cookie helpers ----

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function setSessionCookie(res, token, expires) {
  const expiresStr = new Date(expires).toUTCString();
  const secureFlag = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Expires=${expiresStr}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return isValidToken(cookies[COOKIE_NAME]);
}

// ---- Password check ----

function checkPassword(candidate) {
  return timingSafeStringEqual(String(candidate || ''), AUTH_PASSWORD);
}

// ---- Basic brute-force throttling (in-memory, per-IP) ----

const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function isRateLimited(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetAt) {
    attempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const record = attempts.get(ip);
  if (!record || Date.now() > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  } else {
    record.count += 1;
  }
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of attempts.entries()) {
    if (now > record.resetAt) attempts.delete(ip);
  }
}, 60 * 60 * 1000).unref();

module.exports = {
  COOKIE_NAME,
  createSessionToken,
  isValidToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  isAuthenticated,
  checkPassword,
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
};
