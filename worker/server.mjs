import http from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { put } from '@vercel/blob';

const temp = '/tmp/clipnote'; await mkdir(temp, { recursive:true });
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
const run = (args) => new Promise((resolve,reject) => { const p=spawn('ffmpeg',args); let err=''; p.stderr.on('data',d=>err+=d); p.on('close',c=>c===0?resolve():reject(new Error(err.slice(-800)))); });
const body = (req) => new Promise((resolve,reject) => { let chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks)))); req.on('error',reject); });

http.createServer(async (req,res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res,200,{ok:true});
  if (req.method !== 'POST' || req.url !== '/jobs') return json(res,404,{error:'Not found'});
  if (req.headers.authorization !== `Bearer ${process.env.WORKER_API_SECRET}`) return json(res,401,{error:'Unauthorized'});
  const id=randomUUID(); const input=path.join(temp,`${id}.mp4`); const audio=path.join(temp,`${id}.mp3`);
  try {
    const { sourceUrl, instruction, duration } = await body(req);
    if (!sourceUrl || !instruction || !duration) throw new Error('sourceUrl, instruction, duration are required');
    const source = await fetch(sourceUrl,{headers:{Authorization:`Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`}});
    if (!source.ok) throw new Error('Could not read private source video'); await writeFile(input,Buffer.from(await source.arrayBuffer()));
    await run(['-y','-i',input,'-vn','-ac','1','-ar','16000',audio]);
    const form=new FormData(); form.append('file',new Blob([await readFile(audio)],{type:'audio/mpeg'}),'audio.mp3'); form.append('model','whisper-1'); form.append('response_format','verbose_json'); form.append('timestamp_granularities[]','segment');
    const transcript=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form}).then(r=>r.json());
    if (!transcript.segments?.length) throw new Error('Transcription failed');
    const planPrompt=`Pick chronological transcript segments totaling about ${duration} seconds for: ${instruction}. Return only JSON {"clips":[{"start":number,"end":number}]}. Segments: ${JSON.stringify(transcript.segments)}`;
    const planResponse=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1-mini',input:planPrompt})}).then(r=>r.json());
    const plan=JSON.parse(planResponse.output_text); const clips=plan.clips.filter(c=>c.end>c.start).slice(0,30); if(!clips.length) throw new Error('No edit clips selected');
    const output=path.join(temp,`${id}-edited.mp4`); const filters=clips.flatMap((c,i)=>[`[0:v]trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS[v${i}]`,`[0:a]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`]); filters.push(`${clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
    await run(['-y','-i',input,'-filter_complex',filters.join(';'),'-map','[v]','-map','[a]',output]);
    const uploaded=await put(`results/${id}.mp4`,await readFile(output),{access:'private',contentType:'video/mp4',token:process.env.BLOB_READ_WRITE_TOKEN});
    json(res,200,{resultUrl:uploaded.url,clips});
  } catch (e) { json(res,500,{error:e.message}); } finally { await rm(input,{force:true}); await rm(audio,{force:true}); }
}).listen(process.env.PORT||8080);
