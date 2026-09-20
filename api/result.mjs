import { get } from '@vercel/blob';
import { Readable } from 'node:stream';
import { readSession } from './_youtube-session.mjs';

export default async function handler(request, response) {
  if (!readSession(request)) return response.status(401).json({ error:'로그인이 필요합니다.' });
  const url = request.query.url; if (!url) return response.status(400).json({ error:'결과 주소가 없습니다.' });
  const result = await get(url, { access:'private' });
  if (!result || result.statusCode !== 200) return response.status(404).json({ error:'결과 파일을 찾지 못했습니다.' });
  response.setHeader('Content-Type','video/mp4'); response.setHeader('Content-Disposition','attachment; filename="clipnote-result.mp4"');
  Readable.fromWeb(result.stream).pipe(response);
}
