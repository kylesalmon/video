import { upload } from 'https://esm.sh/@vercel/blob@2.8.0/client';

const $ = (selector) => document.querySelector(selector);
let sourceType = 'youtube';
let selectedYoutubeVideo = null;

function switchSource(type) {
  sourceType = type;
  $('#youtubeTab').classList.toggle('active', type === 'youtube');
  $('#uploadTab').classList.toggle('active', type === 'upload');
  $('#youtubePanel').classList.toggle('hidden', type !== 'youtube');
  $('#uploadPanel').classList.toggle('hidden', type !== 'upload');
}

$('#youtubeTab').onclick = () => switchSource('youtube');
$('#uploadTab').onclick = () => switchSource('upload');
$('#videoFile').onchange = (event) => {
  const file = event.target.files[0];
  $('#fileName').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '대용량 MP4 지원 · 비공개 저장소에 안전하게 보관됩니다';
};

async function loadYoutubeLibrary() {
  const r = await fetch('/api/youtube-videos');
  if (!r.ok) return;
  const data = await r.json();
  $('#youtubeConnect').classList.add('hidden'); $('#youtubeLibrary').classList.remove('hidden');
  const picker = $('#youtubeVideo');
  picker.innerHTML = '<option value="">내 영상 선택</option>' + data.videos.map(video => `<option value="${video.id}">${video.title}</option>`).join('');
  picker.onchange = async () => {
    const id = picker.value; selectedYoutubeVideo = data.videos.find(video => video.id === id) || null;
    if (!id) return;
    $('#captionStatus').textContent = '자막 권한을 확인하고 있습니다…';
    const captions = await fetch(`/api/youtube-captions?videoId=${encodeURIComponent(id)}`).then(r => r.json());
    $('#captionStatus').textContent = captions.available ? '자막을 확인했습니다. 원본 MP4를 올려 편집을 계속하세요.' : '사용 가능한 자막이 없습니다. 원본 MP4는 편집할 수 있습니다.';
  };
}
const pageParams = new URLSearchParams(location.search);
if (pageParams.get('youtube') === 'connected') loadYoutubeLibrary();
if (pageParams.get('youtube') === 'error') {
  showStatus(pageParams.get('message') || 'YouTube 채널을 연결하지 못했습니다.', true);
  history.replaceState({}, '', location.pathname);
}

function showStatus(message, error = false) {
  const box = $('#status');
  box.textContent = message;
  box.classList.remove('hidden');
  box.classList.toggle('error', error);
}

$('#runButton').onclick = async () => {
  const instruction = $('#instruction').value.trim();
  const duration = Number($('#duration').value);
  if (!instruction) return showStatus('먼저 만들고 싶은 영상에 대한 설명을 적어주세요.', true);
  if (!duration || duration < 15 || duration > 3600) return showStatus('길이는 15초에서 3,600초 사이로 입력해주세요.', true);

  const button = $('#runButton');
  button.disabled = true;
  $('#result').classList.add('hidden');
  try {
    let response;
    if (sourceType === 'upload') {
      const file = $('#videoFile').files[0];
      if (!file) throw new Error('MP4 파일을 선택해주세요.');
      const uploadStatus = await fetch('/api/blob-status').then(r => r.json());
      if (!uploadStatus.configured) throw new Error('Vercel Blob 연결 정보가 아직 배포에 반영되지 않았습니다. Vercel에서 한 번 Redeploy해주세요.');
      if (!uploadStatus.connected) throw new Error('대용량 업로드 전 YouTube 채널을 다시 연결해주세요. 연결 세션이 만료됐을 수 있습니다.');
      showStatus('영상을 비공개 저장소에 올리고 있습니다… 0%');
      const blob = await upload(`uploads/${Date.now()}-${file.name}`, file, {
        access: 'public', handleUploadUrl: '/api/upload', multipart: true,
        onUploadProgress: ({ percentage }) => showStatus(`영상을 비공개 저장소에 올리고 있습니다… ${Math.round(percentage)}%`)
      });
      showStatus('AI가 자막을 만들고 편집 구간을 고르고 있습니다… 영상 길이에 따라 몇 분 걸릴 수 있어요.');
      response = await fetch('/api/create', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({sourceUrl:blob.url, instruction, duration}) });
    } else {
      if (!selectedYoutubeVideo) throw new Error('먼저 내 YouTube 채널을 연결하고 영상을 선택해주세요.');
      throw new Error('선택한 영상의 원본 MP4를 올리기 탭에서 업로드해주세요. YouTube 자막 분석은 완료됐지만 영상 파일은 공식 API로 내려받을 수 없습니다.');
    }
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      throw new Error(`서버가 API 응답 대신 웹 페이지를 반환했습니다. 배포 설정을 확인해주세요. (${response.status})`);
    }
    if (!response.ok) throw new Error(data.error || '영상을 만들지 못했습니다.');
    if (data.jobId) {
      showStatus('영상 처리 중입니다. 긴 영상은 탭을 열어두세요.');
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const job = await fetch(`/api/job?id=${encodeURIComponent(data.jobId)}`).then(r => r.json());
        if (job.status === 'processing' && job.message) showStatus(job.message);
        if (job.status === 'failed') throw new Error(job.error || '영상 처리가 실패했습니다.');
        if (job.status === 'complete') { data = job; break; }
      }
    }
    showStatus('완성됐습니다. 아래에서 결과를 내려받을 수 있어요.');
    const downloadUrl = data.resultUrl || data.downloadUrl;
    if (!downloadUrl) throw new Error('완성 영상의 다운로드 주소를 받지 못했습니다. 다시 실행해주세요.');
    const time = value => `${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
    const selected = (data.clips || []).map(clip => `${time(clip.start)}–${time(clip.end)} ${clip.reason || ''}`).join('<br>');
    $('#result').innerHTML = `<strong>편집 완료</strong><br>선택 구간:<br>${selected}<br><a href="${downloadUrl}" download>완성된 MP4 다운로드 →</a>`;
    $('#result').classList.remove('hidden');
  } catch (error) { showStatus(error.message, true); }
  finally { button.disabled = false; }
};
