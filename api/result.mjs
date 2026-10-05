import { createHmac } from 'node:crypto';
import { readSession } from './_youtube-session.mjs';
export default async function handler(request,response){
  if(!readSession(request))return response.status(401).json({error:'로그인이 필요합니다.'});
  const id=request.query.id;if(!id)return response.status(400).json({error:'결과 ID가 없습니다.'});
  try{const base=process.env.VIDEO_WORKER_URL.replace(/\/$/,''),exp=Math.floor(Date.now()/1000)+600,sig=createHmac('sha256',process.env.WORKER_API_SECRET||'').update(`${id}.${exp}`).digest('hex');return response.redirect(302,`${base}/results/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`);}catch(error){return response.status(502).json({error:error.message||'완성 영상을 가져오지 못했습니다.'});}
}
