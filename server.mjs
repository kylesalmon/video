import http from 'node:http';
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const work = path.join(root, '.work');
const output = path.join(root, 'outputs');
await mkdir(work, { recursive: true }); await mkdir(output, { recursive: true });
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'application/javascript'] };

const send = (res, status, payload) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(payload)); };
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { windowsHide:true }); let stderr = '';
  p.stderr.on('data', d => stderr += d); p.on('error', e => reject(new Error(`${cmd} 실행 실패: ${e.message}`)));
  p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} 처리 실패: ${stderr.slice(-500)}`)));
});
const body = (req, limit = 1024 * 1024 * 1024) => new Promise((resolve, reject) => { let size=0, chunks=[]; req.on('data', c => { size+=c.length; if(size>limit) { reject(new Error('파일은 1GB까지 올릴 수 있습니다.')); req.destroy(); } else chunks.push(c); }); req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error', reject); });

async function transcribe(audioPath) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 설정되지 않았습니다. README의 설정 방법을 확인해주세요.');
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([audio], { type:'audio/mpeg' }), 'audio.mp3');
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'segment');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`}, body:form });
  const json = await r.json(); if (!r.ok) throw new Error(json.error?.message || '자막 생성에 실패했습니다.'); return json;
}
async function chooseClips(transcript, instruction, duration, framePaths) {
  const segments = transcript.segments.map(s => ({ start:+s.start.toFixed(2), end:+s.end.toFixed(2), text:s.text }));
  const prompt = `You are a precise video editor. Pick chronological, non-overlapping transcript segments to make one coherent edit. User request (Korean): ${instruction}\nTarget duration: about ${duration} seconds (within 15%). The attached images are chronological representative frames. Use them to avoid visual mismatch, but NEVER invent times: timestamps must come only from the source segments. Return ONLY JSON: {"summary":"Korean one-sentence summary","clips":[{"start":number,"end":number,"reason":"short Korean reason"}]}. Source segments:\n${JSON.stringify(segments)}`;
  const content = [{ type:'input_text', text:prompt }];
  for (const framePath of framePaths) {
    const image = await readFile(framePath);
    content.push({ type:'input_image', image_url:`data:image/jpeg;base64,${image.toString('base64')}`, detail:'low' });
  }
  const r = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'}, body:JSON.stringify({model:'gpt-4.1-mini', input:[{role:'user',content}]}) });
  const json = await r.json(); if (!r.ok) throw new Error(json.error?.message || 'AI 편집 계획 생성에 실패했습니다.');
  const text = json.output_text || json.output?.flatMap(x => x.content || []).map(x => x.text || '').join('') || '';
  try { const result = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')); if (!Array.isArray(result.clips) || !result.clips.length) throw new Error(); return result; } catch { throw new Error('AI가 유효한 편집 구간을 반환하지 않았습니다. 다시 시도해주세요.'); }
}
async function makeVideo(source, instruction, duration) {
  const id = randomUUID(); const audio = path.join(work, `${id}.mp3`); const result = path.join(output, `${id}.mp4`); const framePrefix = path.join(work, `${id}-frame-`);
  await run('ffmpeg', ['-y','-i',source,'-vn','-ac','1','-ar','16000','-b:a','64k',audio]);
  // Twelve compact frames keep the vision request useful without sending the whole video.
  await run('ffmpeg', ['-y','-i',source,'-vf','fps=1/30,scale=512:-2:force_original_aspect_ratio=decrease','-frames:v','12',`${framePrefix}%02d.jpg`]);
  const frames = (await readdir(work)).filter(name => name.startsWith(`${id}-frame-`)).sort().map(name => path.join(work,name));
  const transcript = await transcribe(audio); const plan = await chooseClips(transcript, instruction, duration, frames);
  const valid = plan.clips.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start).slice(0, 30);
  if (!valid.length) throw new Error('사용 가능한 편집 구간을 찾지 못했습니다.');
  const filters = valid.flatMap((c,i) => [`[0:v]trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS[v${i}]`,`[0:a]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`]);
  filters.push(`${valid.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${valid.length}:v=1:a=1[v][a]`);
  await run('ffmpeg', ['-y','-i',source,'-filter_complex',filters.join(';'),'-map','[v]','-map','[a]','-movflags','+faststart',result]);
  await Promise.allSettled([unlink(source), unlink(audio), ...frames.map(unlink)]);
  return { id, summary: plan.summary || `${valid.length}개 구간을 자연스럽게 편집했습니다.`, clips:valid };
}

http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && staticFiles[url.pathname]) { const [file,type] = staticFiles[url.pathname]; res.writeHead(200,{'content-type':type}); return res.end(await readFile(path.join(root,file))); }
    if (req.method === 'GET' && url.pathname.startsWith('/outputs/')) { const file=path.basename(url.pathname); res.writeHead(200,{'content-type':'video/mp4','content-disposition':`attachment; filename="edited-${file}"`}); return createReadStream(path.join(output,file)).pipe(res); }
    if (req.method === 'POST' && url.pathname === '/api/create') { const instruction=url.searchParams.get('instruction')?.trim(), duration=Number(url.searchParams.get('duration')); if(!instruction || !duration) return send(res,400,{error:'설명과 목표 길이가 필요합니다.'}); const name=decodeURIComponent(req.headers['x-file-name'] || 'upload.mp4'); if(!name.toLowerCase().endsWith('.mp4')) return send(res,400,{error:'MP4 파일만 올릴 수 있습니다.'}); const source=path.join(work,`${randomUUID()}.mp4`); await writeFile(source,await body(req)); const made=await makeVideo(source,instruction,duration); return send(res,200,{summary:made.summary,downloadUrl:`/outputs/${made.id}.mp4`,clips:made.clips}); }
    if (req.method === 'POST' && url.pathname === '/api/youtube') return send(res,501,{error:'YouTube 링크는 권한 확인을 위해 기본값으로 비활성화되어 있습니다. 직접 소유하거나 사용 권한이 있는 영상을 MP4로 올려주세요.'});
    send(res,404,{error:'찾을 수 없는 주소입니다.'});
  } catch (error) { console.error(error); send(res,500,{error:error.message || '처리 중 오류가 발생했습니다.'}); }
}).listen(3000, () => console.log('Clipnote running at http://localhost:3000'));
