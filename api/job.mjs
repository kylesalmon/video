import { readSession } from './_youtube-session.mjs';
export default async function handler(request,response){
  if(!readSession(request)) return response.status(401).json({error:'Login required'});
  const id=request.query.id; if(!id) return response.status(400).json({error:'Job ID required'});
  const r=await fetch(`${process.env.VIDEO_WORKER_URL.replace(/\/$/,'')}/jobs/${encodeURIComponent(id)}`); const data=await r.json(); return response.status(r.status).json(data);
}
