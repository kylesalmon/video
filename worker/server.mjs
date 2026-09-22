import http from 'node:http';
import { mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const temp = '/tmp/clipnote'; await mkdir(temp, { recursive:true });
const results = new Map();
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
const run = (args) => new Promise((resolve,reject) => { const p=spawn('ffmpeg',args); let err=''; p.stderr.on('data',d=>err+=d); p.on('close',c=>c===0?resolve():reject(new Error(err.slice(-800)))); });
const body = (req) => new Promise((resolve,reject) => { let chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks)))); req.on('error',reject); });

const server = http.createServer(async (req,res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res,200,{ok:true});
  if (req.method === 'GET' && req.url.startsWith('/results/')) {
    const id=decodeURIComponent(req.url.slice('/results/'.length)); const output=results.get(id);
    if (!output) return json(res,404,{error:'Result not found'});
    res.writeHead(200,{'content-type':'video/mp4','content-disposition':'attachment; filename="clipnote-result.mp4"'});
    return Readable.from(await readFile(output)).pipe(res);
  }
  if (req.method !== 'POST' || req.url !== '/jobs') return json(res,404,{error:'Not found'});
  if (req.headers.authorization !== `Bearer ${process.env.WORKER_API_SECRET}`) return json(res,401,{error:'Unauthorized'});
  const id=randomUUID(); const input=path.join(temp,`${id}.mp4`); const audio=path.join(temp,`${id}.mp3`);
  try {
    const { sourceUrl, instruction, duration } = await body(req);
    if (!sourceUrl || !instruction || !duration) throw new Error('sourceUrl, instruction, duration are required');
    const source = await fetch(sourceUrl);
    if (!source.ok || !source.body) throw new Error('Could not read source video');
    await finished(Readable.fromWeb(source.body).pipe(createWriteStream(input)));
    await run(['-y','-i',input,'-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','16k',audio]);
    const chunkPattern=path.join(temp,`${id}-chunk-%03d.mp3`);
    await run(['-y','-i',audio,'-f','segment','-segment_time','900','-c','copy',chunkPattern]);
    const chunks=(await readdir(temp)).filter(name=>name.startsWith(`${id}-chunk-`) && name.endsWith('.mp3')).sort();
    const segments=[];
    for (let index=0;index<chunks.length;index++) {
      const form=new FormData(); form.append('file',new Blob([await readFile(path.join(temp,chunks[index]))],{type:'audio/mpeg'}),chunks[index]); form.append('model','whisper-1'); form.append('response_format','verbose_json'); form.append('timestamp_granularities[]','segment');
      const transcriptionResponse=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form});
      const transcript=await transcriptionResponse.json();
      if (!transcriptionResponse.ok) throw new Error(`OpenAI transcription: ${transcript.error?.message || transcriptionResponse.status}`);
      segments.push(...(transcript.segments||[]).map(segment=>({...segment,start:segment.start+index*900,end:segment.end+index*900})));
    }
    if (!segments.length) throw new Error('OpenAI transcription returned no speech segments');
    const planPrompt=`Pick chronological transcript segments totaling about ${duration} seconds for: ${instruction}. Return only JSON {"clips":[{"start":number,"end":number}]}. Segments: ${JSON.stringify(segments)}`;
    const planningResponse=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1-mini',input:planPrompt})});
    const planResponse=await planningResponse.json();
    if (!planningResponse.ok) throw new Error(`OpenAI edit planning: ${planResponse.error?.message || planningResponse.status}`);
    const planText=planResponse.output_text || planResponse.output?.flatMap(item=>item.content||[]).find(item=>item.type==='output_text')?.text;
    if (!planText) throw new Error('OpenAI edit planning returned no text output');
    const plan=JSON.parse(planText.replace(/^```(?:json)?\s*|\s*```$/g,'')); const clips=plan.clips.filter(c=>c.end>c.start).slice(0,30); if(!clips.length) throw new Error('No edit clips selected');
    const output=path.join(temp,`${id}-edited.mp4`); const filters=clips.flatMap((c,i)=>[`[0:v]trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS[v${i}]`,`[0:a]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`]); filters.push(`${clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
    await run(['-y','-i',input,'-filter_complex',filters.join(';'),'-map','[v]','-map','[a]',output]);
    results.set(id,output);
    setTimeout(async()=>{if(results.get(id)===output){results.delete(id);await rm(output,{force:true});}},60*60*1000).unref();
    const protocol=req.headers['x-forwarded-proto']||'https';
    json(res,200,{resultUrl:`${protocol}://${req.headers.host}/results/${id}`,clips});
  } catch (e) { console.error('Video job failed:', e); json(res,500,{error:e.message}); } finally { await rm(input,{force:true}); await rm(audio,{force:true}); }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0', () => console.log(`Video worker listening on ${port}`));
server.on('error', (error) => {
  console.error('Video worker could not start:', error);
  process.exitCode = 1;
});
