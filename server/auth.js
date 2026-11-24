'use strict';
/**
 * Minimal password protection. Set APP_PASSWORD in the environment.
 * Without APP_PASSWORD the app runs open (fine on a private computer, not on the internet).
 */
const crypto = require('crypto');

const COOKIE = 'gonzo_session';
const MAX_AGE_DAYS = 30;

function secret() {
  return process.env.SESSION_SECRET || `gonzo:${process.env.APP_PASSWORD || ''}`;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function authEnabled() { return Boolean(process.env.APP_PASSWORD); }

function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  if (verify(readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'נדרשת התחברות' });
}

function login(req, res) {
  if (!authEnabled()) return res.json({ ok: true });
  const given = String(req.body?.password || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(process.env.APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'סיסמה שגויה' });
  const token = sign({ exp: Date.now() + MAX_AGE_DAYS * 864e5 });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_DAYS * 86400}${secure}`);
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

function status(req, res) {
  res.json({ authEnabled: authEnabled(), loggedIn: !authEnabled() || Boolean(verify(readCookie(req, COOKIE))) });
}

module.exports = { requireAuth, login, logout, status };
