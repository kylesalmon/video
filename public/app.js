import { upload } from 'https://esm.sh/@vercel/blob@2.8.0/client';

const $=selector=>document.querySelector(selector);
let sourceType='upload';let selectedYoutubeVideo=null;let taskMode='transcript';
function showStatus(message,error=false){const box=$('#status');box.textContent=message;box.classList.remove('hidden');box.classList.toggle('error',error);}
function switchSource(type){sourceType=type;$('#youtubeTab').classList.toggle('active',type==='youtube');$('#uploadTab').classList.toggle('active',type==='upload');$('#youtubePanel').classList.toggle('hidden',type!=='youtube');$('#uploadPanel').classList.toggle('hidden',type!=='upload');}
$('#youtubeTab').onclick=()=>switchSource('youtube');$('#uploadTab').onclick=()=>switchSource('upload');
function switchMode(mode){taskMode=mode;const transcript=mode==='transcript';$('#transcriptMode').classList.toggle('active',transcript);$('#editMode').classList.toggle('active',!transcript);$('#transcriptMode').setAttribute('aria-selected',String(transcript));$('#editMode').setAttribute('aria-selected',String(!transcript));$('#editOptions').classList.toggle('hidden',transcript);$('#modeDescription').textContent=transcript?'영상의 대사와 화자·시간 정보를 TXT 파일로 추출합니다.':'편집 요구사항을 적으면 전사부터 영상 제작까지 한 번에 진행합니다.';$('#transcribeButton').textContent=transcript?'대사 TXT 추출 시작 →':'영상 편집 시작 →';$('#transcriptSection').classList.add('hidden');$('#result').classList.add('hidden');}
$('#transcriptMode').onclick=()=>switchMode('transcript');$('#editMode').onclick=()=>switchMode('edit');
$('#videoFile').onchange=event=>{const file=event.target.files[0];$('#fileName').textContent=file?`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`:'MP4 원본을 선택하세요.';};
async function apiJson(url,options){const response=await fetch(url,options);const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{throw new Error(`서버가 올바른 응답을 주지 않았습니다. (${response.status})`);}if(!response.ok)throw new Error(data.error||`요청 실패 (${response.status})`);return data;}
const originReady=apiJson('/api/blob-status').then(data=>{if(data.appOrigin&&new URL(data.appOrigin).origin!==location.origin){location.replace(`${new URL(data.appOrigin).origin}${location.pathname}${location.search}${location.hash}`);}return data;}).catch(()=>null);
async function waitForJob(jobId,label){while(true){await new Promise(resolve=>setTimeout(resolve,3000));const job=await apiJson(`/api/job?id=${encodeURIComponent(jobId)}`);if(job.message)showStatus(`${label} · ${job.message}`);if(job.status==='failed')throw new Error(job.error||'작업에 실패했습니다.');if(job.status==='complete')return job;}}
const speakerLabel=id=>/^speaker-(\d+)$/.test(String(id||''))?`화자 ${id.match(/\d+/)[0]}`:'화자 미상';
async function showTranscript(id){const data=await apiJson(`/api/transcript?id=${encodeURIComponent(id)}`);$('#transcriptSection').classList.remove('hidden');$('#transcriptMeta').textContent=`영상 길이 ${Math.floor(data.duration/60)}분 ${Math.floor(data.duration%60)}초 · 발화 ${data.segments.length}개 · 화자 ${data.speakerCount||0}명`;$('#transcriptDownload').href=`/api/transcript?id=${encodeURIComponent(id)}&format=txt`;$('#transcriptPreview').textContent=data.segments.map(segment=>`[${new Date(Math.max(0,segment.start)*1000).toISOString().slice(11,19)}] ${speakerLabel(segment.speaker)}: ${segment.text}`).join('\n');}
async function loadYoutubeLibrary(){const response=await fetch('/api/youtube-videos');if(!response.ok){$('#captionStatus').textContent='YouTube 연결이 만료됐습니다. 다시 연결 버튼을 눌러주세요.';return;}const data=await response.json();$('#youtubeConnect').classList.add('hidden');$('#youtubeLibrary').classList.remove('hidden');const picker=$('#youtubeVideo');picker.innerHTML='<option value="">영상 선택</option>'+data.videos.map(video=>`<option value="${video.id}">${video.title.replace(/[<>]/g,'')}</option>`).join('');picker.onchange=async()=>{const id=picker.value;selectedYoutubeVideo=data.videos.find(video=>video.id===id)||null;if(!id)return;$('#captionStatus').textContent='자막 권한 확인 중입니다.';const captions=await apiJson(`/api/youtube-captions?videoId=${encodeURIComponent(id)}`);$('#captionStatus').textContent=captions.available?'사용 가능한 자막이 있습니다. 원본 MP4를 업로드해 전사를 시작하세요.':'자막이 없거나 접근할 수 없습니다. 원본 MP4에서 새로 전사할 수 있습니다.';};switchSource('upload');}
const params=new URLSearchParams(location.search);if(params.get('youtube')==='connected'){loadYoutubeLibrary();history.replaceState({},'',location.pathname);}if(params.get('youtube')==='error'){showStatus(params.get('message')||'YouTube 채널 연결에 실패했습니다.',true);history.replaceState({},'',location.pathname);}

function showEditResult(job){const downloadUrl=`/api/result?id=${encodeURIComponent(job.resultId)}`;const result=$('#result');result.replaceChildren();const heading=document.createElement('strong');heading.textContent='영상 편집 완료';result.append(heading);const detail=document.createElement('p');detail.textContent=`완성 길이 약 ${Math.round(job.outputDuration)}초 · 선택한 장면:`;result.append(detail);for(const clip of job.clips||[]){const line=document.createElement('p');line.textContent=`${Math.floor(clip.start/60)}:${String(Math.floor(clip.start%60)).padStart(2,'0')}–${Math.floor(clip.end/60)}:${String(Math.floor(clip.end%60)).padStart(2,'0')} ${clip.reason||''}`;result.append(line);}const link=document.createElement('a');link.href=downloadUrl;link.download='edited-video.mp4';link.textContent='완성된 MP4 다운로드 →';result.append(link);result.classList.remove('hidden');result.scrollIntoView({behavior:'smooth',block:'center'});}

$('#transcribeButton').onclick=async()=>{
  const button=$('#transcribeButton'),instruction=$('#instruction').value.trim(),timeline=$('#timeline').value.trim(),duration=Number($('#duration').value);
  if(taskMode==='edit'&&!instruction&&!timeline)return showStatus('편집할 내용이나 타임라인을 입력해주세요.',true);
  if(taskMode==='edit'&&(!Number.isFinite(duration)||duration<15||duration>3600))return showStatus('목표 길이는 15초~3600초로 입력해주세요.',true);
  button.disabled=true;$('#transcriptMode').disabled=true;$('#editMode').disabled=true;$('#result').classList.add('hidden');$('#transcriptSection').classList.add('hidden');
  try{
    await originReady;
    if(sourceType!=='upload')throw new Error('MP4 업로드 탭을 선택하고 원본 영상을 올려주세요.');
    const file=$('#videoFile').files[0];if(!file)throw new Error('MP4 파일을 선택해주세요.');
    const readiness=await apiJson('/api/blob-status');if(!readiness.configured)throw new Error('Vercel Blob 저장소 연결이 아직 배포에 반영되지 않았습니다.');
    if(!readiness.connected){showStatus('YouTube 계정 연결이 필요합니다. 연결 화면으로 이동합니다.');location.assign('/api/youtube-auth?action=begin');return;}
    showStatus('원본 영상을 저장소에 올리는 중입니다. 0%');
    const blob=await upload(`uploads/${Date.now()}-${file.name}`,file,{access:'public',handleUploadUrl:'/api/upload',multipart:true,onUploadProgress:({percentage})=>showStatus(`원본 업로드 중 · ${Math.round(percentage)}%`)});
    showStatus('대사와 화자를 분석 중입니다.');
    const started=await apiJson('/api/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceUrl:blob.url})});
    const transcriptJob=await waitForJob(started.jobId,'대사 추출');
    if(taskMode==='transcript'){
      await showTranscript(transcriptJob.transcriptId);showStatus('대사 TXT 추출이 완료됐습니다. 파일을 다운로드할 수 있어요.');
      $('#transcriptSection').scrollIntoView({behavior:'smooth',block:'start'});return;
    }
    showStatus('대사 분석이 끝났습니다. 입력한 요구사항으로 영상 구간을 고르는 중입니다.');
    const editStarted=await apiJson('/api/edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({transcriptId:transcriptJob.transcriptId,instruction,timeline,duration,aspectRatio:$('#aspectRatio').value,subtitles:$('#subtitles').checked})});
    const editJob=await waitForJob(editStarted.jobId,'영상 편집');showEditResult(editJob);showStatus('영상 편집이 완료됐습니다.');
  }catch(error){showStatus(error.message,true);}finally{button.disabled=false;$('#transcriptMode').disabled=false;$('#editMode').disabled=false;}
};
