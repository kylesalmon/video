import { Readable } from 'node:stream';
import { readSession } from './_youtube-session.mjs';
export default async function handler(request,response){
  if(!readSession(request))return response.status(401).json({error:'로그인이 필요합니다.'});
  const id=request.query.id;if(!id)return response.status(400).json({error:'결과 ID가 없습니다.'});
  try{const r=await fetch(`${process.env.VIDEO_WORKER_URL.replace(/\/$/,'')}/results/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${process.env.WORKER_API_SECRET}`}});if(!r.ok||!r.body)return response.status(r.status).json({error:'완성 영상을 찾지 못했습니다. 다시 편집해주세요.'});response.setHeader('Content-Type','video/mp4');response.setHeader('Content-Disposition','attachment; filename="edited-video.mp4"');return Readable.fromWeb(r.body).pipe(response);}catch(error){return response.status(502).json({error:error.message||'완성 영상을 가져오지 못했습니다.'});}
}
