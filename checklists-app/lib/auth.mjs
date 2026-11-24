/**
 * Sign-up / sign-in with name + phone. Managers are the phone numbers in MANAGER_PHONES
 * (Netlify environment variable, comma separated); signing in as a manager also needs
 * MANAGER_PIN when it is set. TEAM_CODE (optional) is a code staff need to sign up.
 * The session is an HMAC-signed cookie; the role is re-checked on every request, so
 * removing a number from MANAGER_PHONES takes effect immediately.
 */
import crypto from 'node:crypto';

export const COOKIE = 'gonzo_cl';
const MAX_AGE = 60 * 86400;

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.LOCAL_STORE_DIR) return 'local-dev-secret';
  throw new HttpError(500, 'חסרה הגדרת SESSION_SECRET באתר (Netlify → Site configuration → Environment variables)');
}

/** "054-123 4567" / "+972541234567" → "0541234567" */
export function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  if (!/^0\d{8,9}$/.test(d)) return null;
  return d;
}

const managerPhones = () => new Set(String(process.env.MANAGER_PHONES || '').split(/[,;\n]+/).map(normalizePhone).filter(Boolean));
export const roleFor = phone => (managerPhones().has(phone) ? 'manager' : 'staff');

const sign = body => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

export function makeCookie(user, secure) {
  const body = Buffer.from(JSON.stringify({ phone: user.phone, name: user.name, exp: Date.now() + MAX_AGE * 1000 })).toString('base64url');
  return `${COOKIE}=${body}.${sign(body)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

export function readSession(req) {
  const raw = req.headers.get('cookie') || '';
  const tok = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!tok || !tok.includes('.')) return null;
  const [body, mac] = tok.split('.');
  if (!safeEqual(mac, sign(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!(p.exp > Date.now())) return null;
    return { phone: p.phone, name: p.name, role: roleFor(p.phone) };
  } catch { return null; }
}

/** Validates a sign-up / sign-in request; returns the user record to store. */
export function checkRegistration({ name, phone, code, pin }) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2) throw new HttpError(400, 'צריך למלא שם מלא');
  if (n.length > 60) throw new HttpError(400, 'השם ארוך מדי');
  const ph = normalizePhone(phone);
  if (!ph) throw new HttpError(400, 'מספר הטלפון לא תקין');
  const role = roleFor(ph);
  if (role === 'manager') {
    if (process.env.MANAGER_PIN && !safeEqual(String(pin || ''), process.env.MANAGER_PIN)) {
      throw new HttpError(401, pin ? 'קוד המנהל שגוי' : 'זה מספר של מנהל. צריך להזין קוד מנהל', { need: 'pin' });
    }
  } else if (process.env.TEAM_CODE && !safeEqual(String(code || '').trim(), process.env.TEAM_CODE)) {
    throw new HttpError(401, code ? 'קוד הצוות שגוי' : 'צריך להזין קוד צוות (מקבלים מהאחמ"ש)', { need: 'code' });
  }
  return { name: n, phone: ph, role };
}
