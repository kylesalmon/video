import http from 'node:http';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const temp='/tmp/clipnote'; await mkdir(temp,{recursive:true});
const jobs=new Map(); const results=new Map();
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
const run=args=>new Promise((resolve,reject)=>{const p=spawn('ffmpeg',args);let err='';p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(err.slice(-1200))));});
const body=req=>new Promise((resolve,reject)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)))}catch(e){reject(e)}});req.on('error',reject);});
const status=(id,message)=>jobs.set(id,{status:'processing',message});
const auth=req=>req.headers.authorization===`Bearer ${process.env.WORKER_API_SECRET}`;
const writeStream=async(url,file)=>{const response=await fetch(url);if(!response.ok||!response.body)throw new Error(`원본 다운로드 실패 (${response.status})`);await finished(Readable.fromWeb(response.body).pipe(createWriteStream(file)));};
const toAssTime=seconds=>{const centis=Math.floor(Math.max(0,seconds)*100)%100;const total=Math.floor(Math.max(0,seconds));return `${Math.floor(total/3600)}:${String(Math.floor(total%3600/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}.${String(centis).padStart(2,'0')}`;};
const safeAss=text=>String(text||'').replace(/[{}]/g,'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\N');
const outputText=data=>data.output_text||data.output?.flatMap(item=>item.content||[]).find(item=>item.type==='output_text')?.text;

async function transcribe(id,payload){
  const sourceUrl=new URL(payload.sourceUrl);
  if(!sourceUrl.hostname.endsWith('.public.blob.vercel-storage.com'))throw new Error('공개 Blob에 업로드된 MP4 주소가 아닙니다.');
  const input=path.join(temp,`${id}.mp4`),audio=path.join(temp,`${id}.mp3`),chunkPrefix=`${id}-chunk-`;
  try{
    status(id,'원본 영상을 내려받는 중입니다.');await writeStream(sourceUrl,input);
    status(id,'자막용 음성을 준비하는 중입니다.');await run(['-y','-i',input,'-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','16k',audio]);
    const pattern=path.join(temp,`${chunkPrefix}%03d.mp3`);await run(['-y','-i',audio,'-f','segment','-segment_time','900','-c','copy',pattern]);
    const chunks=(await readdir(temp)).filter(name=>name.startsWith(chunkPrefix)&&name.endsWith('.mp3')).sort();
    const segments=[];let offset=0;
    for(let i=0;i<chunks.length;i++){
      status(id,`자막 분석 중입니다. (${i+1}/${chunks.length})`);
      const file=path.join(temp,chunks[i]);const form=new FormData();form.append('file',new Blob([await readFile(file)],{type:'audio/mpeg'}),chunks[i]);form.append('model','whisper-1');form.append('response_format','verbose_json');form.append('timestamp_granularities[]','segment');
      const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form});const data=await r.json();
      if(!r.ok)throw new Error(`OpenAI transcription: ${data.error?.message||r.status}`);
      segments.push(...(data.segments||[]).map(s=>({...s,start:Number(s.start)+offset,end:Number(s.end)+offset})));
      offset+=Number(data.duration)||900;await rm(file,{force:true});
    }
    if(!segments.length)throw new Error('음성에서 전사할 대사를 찾지 못했습니다.');
    const transcript={id,sourceUrl:payload.sourceUrl,duration:offset,segments};await writeFile(path.join(temp,`${id}.json`),JSON.stringify(transcript));
    jobs.set(id,{status:'complete',transcriptId:id,duration:offset,segmentCount:segments.length});
    setTimeout(async()=>{await rm(path.join(temp,`${id}.json`),{force:true});jobs.delete(id);},24*60*60*1000).unref();
  }catch(error){console.error('Transcription job failed:',error);jobs.set(id,{status:'failed',error:error.message});}
  finally{await rm(input,{force:true});await rm(audio,{force:true});for(const name of await readdir(temp)){if(name.startsWith(chunkPrefix))await rm(path.join(temp,name),{force:true});}}
}

async function editVideo(id,payload){
  const transcriptPath=path.join(temp,`${payload.transcriptId}.json`);let transcript;
  try{transcript=JSON.parse(await readFile(transcriptPath,'utf8'));}catch{throw new Error('전사 파일이 만료됐습니다. 1단계 전사를 다시 해주세요.');}
  const duration=Number(payload.duration);if(!Number.isFinite(duration)||duration<15||duration>3600)throw new Error('목표 길이는 15~3600초로 입력해주세요.');
  const input=path.join(temp,`${id}.mp4`),output=path.join(temp,`${id}-edited.mp4`),assPath=path.join(temp,`${id}.ass`);
  try{
    status(id,'원본 영상을 다시 불러오는 중입니다.');await writeStream(transcript.sourceUrl,input);
    status(id,'AI가 전사와 타임라인 요구사항을 바탕으로 구간을 고르는 중입니다.');
    const prompt=`당신은 영상 편집자입니다. 사용자의 편집 요구사항과 타임라인을 우선 반영하세요.\n요구사항:\n${payload.instruction||'타임라인 지시를 따르세요.'}\n타임라인 지시:\n${payload.timeline||'지정 없음. 요구사항과 대사를 기준으로 구성하세요.'}\n\n목표 완성 길이: ${duration}초. 선택 구간의 총합은 ${duration}초를 넘지 말고 가능한 한 목표에 가깝게 만드세요.\n원본 전체 길이: ${transcript.duration}초.\n전사 시간은 원본 영상 기준 초입니다. 타임라인에 지정한 각 주제의 대사를 우선 고르세요. 관련도가 높은 구간을 고르고, 순서는 원본 시간순으로 유지하세요. 각 구간마다 짧은 한국어 이유를 적으세요.\nJSON만 반환: {"clips":[{"start":초,"end":초,"reason":"이유"}]}\n전사:\n${JSON.stringify(transcript.segments)}`;
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1-mini',input:prompt})});const response=await r.json();
    if(!r.ok)throw new Error(`OpenAI 편집 구간 선택: ${response.error?.message||r.status}`);
    const text=outputText(response);if(!text)throw new Error('AI가 편집 구간을 반환하지 않았습니다.');
    const plan=JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,''));let remaining=duration;const clips=[];
    for(const raw of (plan.clips||[]).filter(c=>Number.isFinite(Number(c.start))&&Number.isFinite(Number(c.end))&&Number(c.end)>Number(c.start)).sort((a,b)=>a.start-b.start).slice(0,60)){
      if(remaining<=0)break;const start=Math.max(0,Number(raw.start));const end=Math.min(Number(raw.end),transcript.duration,start+remaining);if(end>start){clips.push({start,end,reason:String(raw.reason||'')});remaining-=end-start;}
    }
    if(!clips.length)throw new Error('편집할 구간을 고르지 못했습니다. 요구사항을 조금 더 구체적으로 적어주세요.');
    const filters=clips.flatMap((c,i)=>[`[0:v]trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS[v${i}]`,`[0:a]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`]);
    filters.push(`${clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
    const portrait=payload.aspectRatio==='9:16',width=portrait?1080:1920,height=portrait?1920:1080;let videoFilter=`[vcat]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
    if(payload.subtitles!==false){
      let elapsed=0;const dialogues=[];
      for(const clip of clips){for(const segment of transcript.segments){const start=Math.max(clip.start,Number(segment.start)),end=Math.min(clip.end,Number(segment.end));if(end>start&&segment.text?.trim())dialogues.push(`Dialogue: 0,${toAssTime(elapsed+start-clip.start)},${toAssTime(elapsed+end-clip.start)},Default,,0,0,0,,${safeAss(segment.text.trim())}`);}elapsed+=clip.end-clip.start;}
      const fontSize=portrait?54:48,margin=portrait?150:60;
      const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Italic,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Noto Sans CJK KR,${fontSize},&H00FFFFFF,&H00000000,&H99000000,1,0,1,3,1,2,60,60,${margin},1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues.join('\n')}\n`;
      await writeFile(assPath,ass);videoFilter+=`,ass=${assPath}`;
    }
    filters.push(`${videoFilter}[vout]`);status(id,'선택한 구간과 자막으로 영상을 렌더링 중입니다.');
    await run(['-y','-i',input,'-filter_complex',filters.join(';'),'-map','[vout]','-map','[acat]','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k',output]);
    results.set(id,output);const protocol='https';jobs.set(id,{status:'complete',resultId:id,clips,outputDuration:clips.reduce((sum,c)=>sum+c.end-c.start,0)});
    setTimeout(async()=>{if(results.get(id)===output){results.delete(id);await rm(output,{force:true});}},60*60*1000).unref();
  }catch(error){console.error('Video edit job failed:',error);jobs.set(id,{status:'failed',error:error.message});}
  finally{await rm(input,{force:true});await rm(assPath,{force:true});}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true});
  if(!auth(req))return json(res,401,{error:'Unauthorized'});
  if(req.method==='GET'&&url.pathname.startsWith('/jobs/'))return json(res,jobs.has(url.pathname.slice(6))?200:404,jobs.get(url.pathname.slice(6))||{error:'Job not found'});
  if(req.method==='GET'&&url.pathname.startsWith('/transcripts/')){
    const id=path.basename(url.pathname).replace(/\.txt$/,'');try{const transcript=JSON.parse(await readFile(path.join(temp,`${id}.json`),'utf8'));if(url.pathname.endsWith('.txt')){res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename="transcript-${id}.txt"`});return res.end(transcript.segments.map(s=>`[${toAssTime(s.start).slice(0,8)}] ${s.text}`).join('\n'));}return json(res,200,{id,duration:transcript.duration,segments:transcript.segments});}catch{return json(res,404,{error:'Transcript not found'});}
  }
  if(req.method==='GET'&&url.pathname.startsWith('/results/')){const id=path.basename(url.pathname);const output=results.get(id);if(!output)return json(res,404,{error:'Result not found'});res.writeHead(200,{'content-type':'video/mp4','content-disposition':'attachment; filename="edited-video.mp4"'});return createReadStream(output).pipe(res);}
  if(req.method!=='POST')return json(res,404,{error:'Not found'});
  try{
    const payload=await body(req);
    if(url.pathname==='/transcriptions'||url.pathname==='/edits'){
      const id=randomUUID();jobs.set(id,{status:'processing',message:'작업을 준비하는 중입니다.'});json(res,202,{jobId:id});
      if(url.pathname==='/transcriptions')void transcribe(id,payload).catch(error=>{console.error('Transcription setup failed:',error);jobs.set(id,{status:'failed',error:error.message});});else void editVideo(id,payload).catch(error=>{console.error('Video edit setup failed:',error);jobs.set(id,{status:'failed',error:error.message});});
      return;
    }
    return json(res,404,{error:'Not found'});
  }catch(error){return json(res,400,{error:error.message});}
});
const port=Number(process.env.PORT||8080);server.listen(port,'0.0.0.0',()=>console.log(`Video worker listening on ${port}`));server.on('error',error=>{console.error('Video worker could not start:',error);process.exitCode=1;});
