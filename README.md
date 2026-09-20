# Clipnote MVP

원본 MP4에서 AI가 요청에 맞는 대화 구간을 고르고, 새 MP4로 이어 붙이는 로컬 웹앱입니다.

## 준비물

- Node.js 20 이상
- FFmpeg (`winget install Gyan.FFmpeg` 후 새 터미널을 열어주세요)
- OpenAI API 키

PowerShell에서 아래를 실행합니다.

```powershell
$env:OPENAI_API_KEY = "발급받은_API_키"
node server.mjs
```

그 후 브라우저에서 `http://localhost:3000`을 여세요.

## 처리 과정

1. MP4에서 음성을 분리합니다.
2. OpenAI 음성 인식으로 시간 정보가 포함된 자막을 만들고, 영상에서 최대 12장의 대표 프레임을 뽑습니다.
3. 멀티모달 OpenAI 모델이 자막·대표 프레임·설명·목표 길이를 함께 보고 구간을 고릅니다.
4. FFmpeg가 선택 구간을 순서대로 이어 결과 MP4를 만듭니다.

처리 파일은 `.work`에 잠시 저장되고 완료 뒤 삭제됩니다. 결과는 `outputs`에 저장됩니다.

## YouTube 링크

YouTube 링크의 영상 데이터를 임의로 내려받는 기능은 넣지 않았습니다. 링크 영상에 대한 이용 권한과 플랫폼 약관 확인이 필요하기 때문입니다. 현재는 본인이 소유하거나 사용 허가받은 원본을 MP4로 올려 처리하세요. 향후 YouTube Data API와 OAuth로 본인 채널의 자막·메타데이터를 가져오는 연결은 추가할 수 있습니다.
