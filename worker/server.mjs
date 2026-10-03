import http from 'node:http';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { selectClips } from './selectClips.mjs';

const temp='/tmp/clipnote'; await mkdir(temp,{recursive:true});
const jobs=new Map(); const results=new Map();
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
const run=args=>new Promise((resolve,reject)=>{const p=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostats',...args]);let err='';p.stderr.on('data',d=>{err=(err+d).slice(-1200);});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(err||`ffmpeg exited with code ${c}`)));});
const probeDuration=file=>new Promise((resolve,reject)=>{const p=spawn('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>{const duration=Number(out.trim());c===0&&Number.isFinite(duration)?resolve(duration):reject(new Error(err||'영상 길이를 확인하지 못했습니다.'));});});
const body=req=>new Promise((resolve,reject)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)))}catch(e){reject(e)}});req.on('error',reject);});
const status=(id,message)=>jobs.set(id,{status:'processing',message});
const auth=req=>req.headers.authorization===`Bearer ${process.env.WORKER_API_SECRET}`;
const writeStream=async(url,file)=>{const response=await fetch(url);if(!response.ok||!response.body)throw new Error(`원본 다운로드 실패 (${response.status})`);await finished(Readable.fromWeb(response.body).pipe(createWriteStream(file)));};
const toAssTime=seconds=>{const centis=Math.floor(Math.max(0,seconds)*100)%100;const total=Math.floor(Math.max(0,seconds));return `${Math.floor(total/3600)}:${String(Math.floor(total%3600/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}.${String(centis).padStart(2,'0')}`;};
const safeAss=text=>String(text||'').replace(/[{}]/g,'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\N');
const prettySpeaker=id=>/^speaker-(\d+)$/.test(String(id||''))?`화자 ${id.match(/\d+/)[0]}`:'화자 미상';
const mergeSpeakerSegments=segments=>segments.sort((a,b)=>a.start-b.start).reduce((merged,segment)=>{const previous=merged.at(-1);if(previous&&previous.speaker===segment.speaker&&segment.start-previous.end<=1.1&&segment.end-previous.start<=25){previous.text=`${previous.text.trimEnd()} ${String(segment.text||'').trimStart()}`.trim();previous.end=segment.end;}else merged.push({...segment,text:String(segment.text||'').trim()});return merged;},[]);
const parseClock=value=>{const match=String(value||'').trim().match(/^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d+))?$/);return match?Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(`0.${match[4]||0}`):NaN;};
function parseTranscriptText(text,sourceUrl,id){
  if(typeof text!=='string'||text.length>4_000_000)throw new Error('TXT 파일이 너무 크거나 올바르지 않습니다.');
  const durationMatch=text.match(/^영상 길이\s*:\s*(\d{1,3}:\d{2}:\d{2}(?:[.,]\d+)?)/m),declaredDuration=durationMatch?parseClock(durationMatch[1]):NaN;
  const segments=[];
  for(const line of text.split(/\r?\n/)){
    const match=line.match(/^\[(\d{1,3}:\d{2}:\d{2}(?:[.,]\d+)?)(?:\s*[-–]\s*(\d{1,3}:\d{2}:\d{2}(?:[.,]\d+)?))?\]\s*(?:화자\s*(\d+)|speaker[- ]?(\d+)|([^:]{1,40})):\s*(.+)$/i);
    if(!match)continue;
    const start=parseClock(match[1]),explicitEnd=match[2]?parseClock(match[2]):NaN,text=match[6].trim();if(!Number.isFinite(start)||!text)continue;
    const speakerNumber=match[3]||match[4];const speaker=speakerNumber?`speaker-${speakerNumber}`:match[5].trim();
    segments.push({start,explicitEnd,text,speaker});
  }
  if(!segments.length)throw new Error('시간표시와 화자 정보가 있는 대사 TXT를 선택해주세요.');
  const inferredEnd=segments.at(-1).start+Math.max(1,Math.min(20,segments.at(-1).text.length/5));
  const duration=Number.isFinite(declaredDuration)&&declaredDuration>0?declaredDuration:inferredEnd;
  for(let index=0;index<segments.length;index++){
    const segment=segments[index],next=segments[index+1],estimate=Math.max(0.8,Math.min(20,segment.text.length/5));
    const upperBound=next&&next.start>segment.start?next.start:duration;
    segment.end=Number.isFinite(segment.explicitEnd)&&segment.explicitEnd>segment.start?Math.min(duration,segment.explicitEnd):Math.min(duration,Math.max(segment.start+0.2,Math.min(segment.start+estimate,upperBound)));
    delete segment.explicitEnd;
    segment.id=index;
  }
  const parsedUrl=new URL(sourceUrl);if(!parsedUrl.hostname.endsWith('.public.blob.vercel-storage.com'))throw new Error('공개 Blob에 업로드한 MP4 주소가 필요합니다.');
  return {id,sourceUrl,duration,segments,speakerCount:new Set(segments.map(segment=>segment.speaker)).size};
}

async function transcribe(id,payload){
  const sourceUrl=new URL(payload.sourceUrl);
  if(!sourceUrl.hostname.endsWith('.public.blob.vercel-storage.com'))throw new Error('공개 Blob에 업로드된 MP4 주소가 아닙니다.');
  const input=path.join(temp,`${id}.mp4`),audio=path.join(temp,`${id}.mp3`),chunkPrefix=`${id}-chunk-`,speakerRefs=[];
  try{
    status(id,'원본 영상을 내려받는 중입니다.');await writeStream(sourceUrl,input);
    status(id,'말소리가 잘 드러나도록 음성 대역을 정리하는 중입니다.');await run(['-y','-i',input,'-vn','-af','highpass=f=100,lowpass=f=7500','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','16k',audio]);
    const duration=await probeDuration(audio),coreSeconds=900,overlapSeconds=5,totalChunks=Math.ceil(duration/coreSeconds),segments=[];let nextSpeaker=1;
    for(let i=0;i<totalChunks;i++){
      const coreStart=i*coreSeconds,coreEnd=Math.min(duration,(i+1)*coreSeconds),chunkStart=Math.max(0,coreStart-overlapSeconds),chunkEnd=Math.min(duration,coreEnd+overlapSeconds),file=path.join(temp,`${chunkPrefix}${String(i).padStart(3,'0')}.mp3`);
      status(id,`화자와 대사를 분석 중입니다. (${i+1}/${totalChunks})`);
      await run(['-y','-ss',chunkStart.toFixed(3),'-i',audio,'-t',(chunkEnd-chunkStart).toFixed(3),'-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','24k',file]);
      const form=new FormData();form.append('file',new Blob([await readFile(file)],{type:'audio/mpeg'}),path.basename(file));form.append('model','gpt-4o-transcribe-diarize');form.append('response_format','diarized_json');form.append('chunking_strategy','auto');
      for(const ref of speakerRefs){form.append('known_speaker_names[]',ref.name);form.append('known_speaker_references[]',ref.dataUrl);}
      const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form});const data=await r.json();
      if(!r.ok)throw new Error(`OpenAI 화자 전사: ${data.error?.message||r.status}`);
      const localSpeakers=new Map(),sampled=new Set();
      for(const s of data.segments||[]){const label=String(s.speaker||'').trim(),text=String(s.text||'').trim();if(!label||!text||/^\[(music|applause|noise|sound|laughter)\]$/i.test(text))continue;
        let speaker;if(speakerRefs.some(ref=>ref.name===label))speaker=label;else if(localSpeakers.has(label))speaker=localSpeakers.get(label);else{speaker=`speaker-${nextSpeaker++}`;localSpeakers.set(label,speaker);}
        const localStart=Number(s.start),localEnd=Number(s.end),start=localStart+chunkStart,end=localEnd+chunkStart,midpoint=(start+end)/2;
        if(midpoint>=coreStart&&(midpoint<coreEnd||i===totalChunks-1&&midpoint<=coreEnd+0.25))segments.push({start,end,text,speaker});
        if(!sampled.has(speaker)&&!speakerRefs.some(ref=>ref.name===speaker)&&speakerRefs.length<4&&localEnd-localStart>=2){
          const refFile=path.join(temp,`${id}-${speaker}-ref.wav`),sampleDuration=Math.min(8,localEnd-localStart);
          await run(['-y','-ss',localStart.toFixed(3),'-i',file,'-t',sampleDuration.toFixed(3),'-ac','1','-ar','16000','-c:a','pcm_s16le',refFile]);
          const refData=(await readFile(refFile)).toString('base64');speakerRefs.push({name:speaker,dataUrl:`data:audio/wav;base64,${refData}`});sampled.add(speaker);await rm(refFile,{force:true});
        }
      }
      await rm(file,{force:true});
    }
    if(!segments.length)throw new Error('음성에서 전사할 대사를 찾지 못했습니다.');
    const merged=mergeSpeakerSegments(segments);merged.forEach((segment,index)=>segment.id=index);
    const transcript={id,sourceUrl:payload.sourceUrl,duration,segments:merged,speakerCount:new Set(merged.map(s=>s.speaker)).size};await writeFile(path.join(temp,`${id}.json`),JSON.stringify(transcript));
    jobs.set(id,{status:'complete',transcriptId:id,duration,segmentCount:merged.length,speakerCount:transcript.speakerCount});
    setTimeout(async()=>{await rm(path.join(temp,`${id}.json`),{force:true});jobs.delete(id);},24*60*60*1000).unref();
  }catch(error){console.error('Transcription job failed:',error);jobs.set(id,{status:'failed',error:error.message});}
  finally{await rm(input,{force:true});await rm(audio,{force:true});for(const name of await readdir(temp)){if(name.startsWith(chunkPrefix))await rm(path.join(temp,name),{force:true});}}
}

async function editVideo(id,payload){
  let transcript;
  if(payload.transcriptText){transcript=parseTranscriptText(payload.transcriptText,payload.sourceUrl,id);}
  else{const transcriptPath=path.join(temp,`${payload.transcriptId}.json`);try{transcript=JSON.parse(await readFile(transcriptPath,'utf8'));}catch{throw new Error('전사 파일이 만료됐습니다. 대사 TXT를 불러오거나 전사를 다시 해주세요.');}}
  const duration=Number(payload.duration);if(!Number.isFinite(duration)||duration<15||duration>3600)throw new Error('목표 길이는 15~3600초로 입력해주세요.');
  const input=path.join(temp,`${id}.mp4`),output=path.join(temp,`${id}-edited.mp4`),listPath=path.join(temp,`${id}-clips.txt`),clipPaths=[];
  try{
    status(id,'AI가 실제 발화 ID를 기준으로 편집 구간을 고르는 중입니다.');
    const clips=await selectClips({transcript,payload,duration});
    status(id,'선택된 편집 구간의 원본 영상을 불러오는 중입니다.');await writeStream(transcript.sourceUrl,input);
    const portrait=payload.aspectRatio==='9:16',width=portrait?720:1280,height=portrait?1280:720;
    for(let index=0;index<clips.length;index++){
      const clip=clips[index],clipPath=path.join(temp,`${id}-part-${String(index).padStart(3,'0')}.mp4`),assPath=path.join(temp,`${id}-part-${String(index).padStart(3,'0')}.ass`);clipPaths.push(clipPath);
      let videoFilter=`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
      if(payload.subtitles!==false){
        const dialogues=transcript.segments.flatMap(segment=>{const start=Math.max(clip.start,Number(segment.start)),end=Math.min(clip.end,Number(segment.end));return end>start&&segment.text?.trim()?[`Dialogue: 0,${toAssTime(start-clip.start)},${toAssTime(end-clip.start)},Default,,0,0,0,,${safeAss(`${prettySpeaker(segment.speaker)}: ${segment.text.trim()}`)}`]:[];});
        const fontSize=portrait?48:36,margin=portrait?100:40;
        const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Italic,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Noto Sans CJK KR,${fontSize},&H00FFFFFF,&H00000000,&H99000000,1,0,1,3,1,2,40,40,${margin},1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues.join('\n')}\n`;
        await writeFile(assPath,ass);videoFilter+=`,subtitles=${assPath}`;
      }
      status(id,`선택 구간 렌더링 중입니다. (${index+1}/${clips.length})`);
      await run(['-y','-ss',clip.start.toFixed(3),'-i',input,'-t',(clip.end-clip.start).toFixed(3),'-map','0:v:0','-map','0:a:0?','-vf',videoFilter,'-c:v','libx264','-preset','ultrafast','-crf','24','-c:a','aac','-b:a','128k',clipPath]);
      await rm(assPath,{force:true});
    }
    await writeFile(listPath,clipPaths.map(file=>`file '${file}'`).join('\n')+'\n');
    status(id,'영상 구간을 이어 붙이고 있습니다.');
    await run(['-y','-f','concat','-safe','0','-i',listPath,'-c','copy','-movflags','+faststart',output]);
    results.set(id,output);const protocol='https';jobs.set(id,{status:'complete',resultId:id,clips,outputDuration:clips.reduce((sum,c)=>sum+c.end-c.start,0)});
    setTimeout(async()=>{if(results.get(id)===output){results.delete(id);await rm(output,{force:true});}},60*60*1000).unref();
  }catch(error){console.error('Video edit job failed:',error);jobs.set(id,{status:'failed',error:error.message});}
  finally{await rm(input,{force:true});await rm(listPath,{force:true});for(const file of clipPaths)await rm(file,{force:true});}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true});
  if(!auth(req))return json(res,401,{error:'Unauthorized'});
  if(req.method==='GET'&&url.pathname.startsWith('/jobs/'))return json(res,jobs.has(url.pathname.slice(6))?200:404,jobs.get(url.pathname.slice(6))||{error:'Job not found'});
  if(req.method==='GET'&&url.pathname.startsWith('/transcripts/')){
    const id=path.basename(url.pathname).replace(/\.txt$/,'');try{const transcript=JSON.parse(await readFile(path.join(temp,`${id}.json`),'utf8'));if(url.pathname.endsWith('.txt')){const dialogue=transcript.segments.map(s=>`[${toAssTime(s.start).slice(0,8)}-${toAssTime(s.end).slice(0,8)}] ${prettySpeaker(s.speaker)}: ${s.text}`).join('\n');res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename="transcript-${id}.txt"`});return res.end(`영상 길이: ${toAssTime(transcript.duration).slice(0,8)}\n감지 화자 수: ${transcript.speakerCount||0}\n\n대사 (화자별 발화 단위, 시작-종료 시각)\n${dialogue}`);}return json(res,200,{id,duration:transcript.duration,segments:transcript.segments,speakerCount:transcript.speakerCount||0});}catch{return json(res,404,{error:'Transcript not found'});}
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
