const $ = (selector) => document.querySelector(selector);
let sourceType = 'youtube';

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
      const url = $('#youtubeUrl').value.trim();
      if (!url) throw new Error('YouTube 링크를 입력해주세요.');
      showStatus('링크의 영상을 준비하고 있습니다…');
      response = await fetch('/api/youtube', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ url, instruction, duration }) });
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
