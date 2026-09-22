import { readSession } from './_youtube-session.mjs';

export default async function handler(request, response) {
  if (!readSession(request)) return response.status(401).json({ error:'YouTube 채널 연결이 필요합니다.' });
  if (!process.env.VIDEO_WORKER_URL || !process.env.WORKER_API_SECRET) return response.status(503).json({ error:'영상 처리 서버 연결 정보가 없습니다.' });
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    const sourceProxyUrl = `https://${request.headers.host}/api/worker-source?url=${encodeURIComponent(body.sourceUrl)}`;
    const worker = await fetch(`${process.env.VIDEO_WORKER_URL.replace(/\/$/, '')}/jobs`, {
      method:'POST', headers:{'content-type':'application/json', Authorization:`Bearer ${process.env.WORKER_API_SECRET}`}, body:JSON.stringify({ ...body, sourceUrl:sourceProxyUrl })
    });
    const result = await worker.json();
    return response.status(worker.status).json(result);
  } catch (error) { return response.status(502).json({ error:error.message || '영상 처리 서버에 연결하지 못했습니다.' }); }
}
