import { Readable } from 'node:stream';
import { readSession } from './_youtube-session.mjs';
export default async function handler(request,response){
  if(!readSession(request))return response.status(401).json({error:'로그인이 필요합니다.'});
  const id=request.query.id;if(!id)return response.status(400).json({error:'전사 ID가 없습니다.'});
  try{const format=request.query.format==='txt'?'txt':'';const r=await fetch(`${process.env.VIDEO_WORKER_URL.replace(/\/$/,'')}/transcripts/${encodeURIComponent(id)}${format?'.txt':''}`,{headers:{Authorization:`Bearer ${process.env.WORKER_API_SECRET}`}});if(!r.ok||!r.body)return response.status(r.status).json({error:'전사 파일을 찾지 못했습니다.'});response.setHeader('Content-Type',format?'text/plain; charset=utf-8':'application/json; charset=utf-8');if(format)response.setHeader('Content-Disposition','attachment; filename="transcript.txt"');return Readable.fromWeb(r.body).pipe(response);}catch(error){return response.status(502).json({error:error.message||'전사 결과를 가져오지 못했습니다.'});}
}
