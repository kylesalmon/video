import { readSession } from './_youtube-session.mjs';
export default async function handler(request,response){
  if(!readSession(request))return response.status(401).json({error:'YouTube 채널을 먼저 연결해주세요.'});
  if(!process.env.VIDEO_WORKER_URL||!process.env.WORKER_API_SECRET)return response.status(503).json({error:'영상 처리 서버 설정이 없습니다.'});
  try{const payload=typeof request.body==='string'?JSON.parse(request.body):request.body;const r=await fetch(`${process.env.VIDEO_WORKER_URL.replace(/\/$/,'')}/edits`,{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${process.env.WORKER_API_SECRET}`},body:JSON.stringify(payload)});return response.status(r.status).json(await r.json());}catch(error){return response.status(502).json({error:error.message||'편집 서버에 연결하지 못했습니다.'});}
}
