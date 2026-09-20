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
  $('#fileName').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '최대 1GB · 파일은 처리 후 삭제됩니다';
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
if (new URLSearchParams(location.search).get('youtube') === 'connected') loadYoutubeLibrary();

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
      showStatus('영상을 올리고 있습니다…');
      response = await fetch(`/api/create?instruction=${encodeURIComponent(instruction)}&duration=${duration}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file
      });
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
    showStatus('완성됐습니다. 아래에서 결과를 내려받을 수 있어요.');
    $('#result').innerHTML = `<strong>편집 완료</strong><br>${data.summary}<br><a href="${data.downloadUrl}" download>완성된 MP4 다운로드 →</a>`;
    $('#result').classList.remove('hidden');
  } catch (error) { showStatus(error.message, true); }
  finally { button.disabled = false; }
};
