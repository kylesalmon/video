import { createHmac, timingSafeEqual } from 'node:crypto';

const header = (request, name) => request.headers.get?.(name) || request.headers[name];
const cookie = (request, name) => (header(request, 'cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
const signature = (value) => createHmac('sha256', process.env.YOUTUBE_SESSION_SECRET || '').update(value).digest('base64url');

export function origin(request) {
  return (process.env.APP_ORIGIN || `${header(request, 'x-forwarded-proto') || 'https'}://${header(request, 'host')}`).replace(/\/$/, '');
}
export function readSession(request) {
  const signed = cookie(request, 'yt_session'); if (!signed || !process.env.YOUTUBE_SESSION_SECRET) return null;
  const [payload, sig] = signed.split('.'); if (!payload || !sig) return null;
  const expected = signature(payload); if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return (data.session_expires_at || data.expires_at) > Date.now() ? data : null; } catch { return null; }
}
export function sessionCookie(data) {
  const session = { ...data, session_expires_at: data.session_expires_at || Date.now() + 30 * 24 * 60 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `yt_session=${payload}.${signature(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}
export function clearSession() { return 'yt_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'; }

export async function freshSession(request, response) {
  const session = readSession(request);
  if (!session) return null;
  if (session.expires_at > Date.now() + 60_000 || !session.refresh_token) return session;
  const refreshed = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({ client_id:process.env.GOOGLE_CLIENT_ID, client_secret:process.env.GOOGLE_CLIENT_SECRET, refresh_token:session.refresh_token, grant_type:'refresh_token' })
  }).then(result => result.json());
  if (!refreshed.access_token) { response.setHeader('Set-Cookie', clearSession()); return null; }
  const updated = { ...session, access_token:refreshed.access_token, expires_at:Date.now() + refreshed.expires_in * 1000, refresh_token:refreshed.refresh_token || session.refresh_token };
  response.setHeader('Set-Cookie', sessionCookie(updated));
  return updated;
}
