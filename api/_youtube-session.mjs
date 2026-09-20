import { createHmac, timingSafeEqual } from 'node:crypto';

const header = (request, name) => request.headers.get?.(name) || request.headers[name];
const cookie = (request, name) => (header(request, 'cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
const signature = (value) => createHmac('sha256', process.env.YOUTUBE_SESSION_SECRET || '').update(value).digest('base64url');

export function origin(request) {
  return process.env.APP_ORIGIN || `${header(request, 'x-forwarded-proto') || 'https'}://${header(request, 'host')}`;
}
export function readSession(request) {
  const signed = cookie(request, 'yt_session'); if (!signed || !process.env.YOUTUBE_SESSION_SECRET) return null;
  const [payload, sig] = signed.split('.'); if (!payload || !sig) return null;
  const expected = signature(payload); if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.expires_at > Date.now() ? data : null; } catch { return null; }
}
export function sessionCookie(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `yt_session=${payload}.${signature(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
}
export function clearSession() { return 'yt_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'; }
