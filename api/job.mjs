import { readSession } from './_youtube-session.mjs';
export default async function handler(request,response){
  if(!readSession(request))return response.status(401).json({error:'로그인이 필요합니다.'});
  const id=request.query.id;if(!id)return response.status(400).json({error:'작업 ID가 없습니다.'});
  try{const r=await fetch(`${process.env.VIDEO_WORKER_URL.replace(/\/$/,'')}/jobs/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${process.env.WORKER_API_SECRET}`}});const data=await r.json();if(data.status==='complete'&&data.resultId)data.resultUrl=`/api/result?id=${encodeURIComponent(data.resultId)}`;if(data.status==='complete'&&data.transcriptId){data.transcriptUrl=`/api/transcript?id=${encodeURIComponent(data.transcriptId)}`;data.transcriptTextUrl=`/api/transcript?id=${encodeURIComponent(data.transcriptId)}&format=txt`;}return response.status(r.status).json(data);}catch(error){return response.status(502).json({error:error.message||'작업 상태를 확인하지 못했습니다.'});}
}
