import { randomBytes, timingSafeEqual } from 'node:crypto';
import { origin, sessionCookie, clearSession } from './_youtube-session.mjs';

const getCookie = (request, name) => (request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
const fail = (response, message) => response.redirect(302, `/?youtube=error&message=${encodeURIComponent(message)}`);

export default async function handler(request, response) {
  const action = request.query.action; const appOrigin = origin(request); const redirectUri = `${appOrigin}/api/youtube-auth?action=callback`;
  if (action === 'begin') {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.YOUTUBE_SESSION_SECRET) return fail(response, 'YouTube OAuth 환경변수가 설정되지 않았습니다.');
    const state = randomBytes(24).toString('base64url');
    response.setHeader('Set-Cookie', `yt_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id:process.env.GOOGLE_CLIENT_ID, redirect_uri:redirectUri, response_type:'code', scope:'https://www.googleapis.com/auth/youtube.force-ssl', access_type:'offline', include_granted_scopes:'true', state }).toString();
    return response.redirect(302, url.toString());
  }
  if (action === 'callback') {
    const saved = getCookie(request, 'yt_oauth_state'); const state = request.query.state || '';
    if (!saved || saved.length !== state.length || !timingSafeEqual(Buffer.from(saved), Buffer.from(state))) return fail(response, 'YouTube 연결 검증에 실패했습니다. 다시 시도해주세요.');
    if (request.query.error) return fail(response, 'YouTube 연결이 취소되었습니다.');
    const token = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ code:request.query.code, client_id:process.env.GOOGLE_CLIENT_ID, client_secret:process.env.GOOGLE_CLIENT_SECRET, redirect_uri:redirectUri, grant_type:'authorization_code' }) }).then(r => r.json());
    if (!token.access_token) return fail(response, token.error_description || 'YouTube 토큰을 받지 못했습니다.');
    response.setHeader('Set-Cookie', [sessionCookie({access_token:token.access_token, expires_at:Date.now() + token.expires_in * 1000}), 'yt_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
    return response.redirect(302, '/?youtube=connected');
  }
  if (action === 'disconnect') { response.setHeader('Set-Cookie', clearSession()); return response.redirect(302, '/'); }
  response.status(400).json({ error:'지원하지 않는 요청입니다.' });
}
