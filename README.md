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

## Vercel 대용량 업로드

Vercel 함수는 4.5MB까지만 직접 받을 수 있어 대용량 MP4는 Vercel Blob으로 브라우저에서 직접 전송합니다. Vercel 프로젝트의 **Storage → Blob**에서 비공개 Blob 저장소를 연결하세요. 연결하면 `BLOB_READ_WRITE_TOKEN`이 자동으로 환경변수에 추가됩니다. 업로드는 연결된 YouTube 채널 세션이 있는 사용자만 허용됩니다.

## YouTube 링크

내 채널의 영상과 자막을 확인하려면 Google Cloud Console에서 **YouTube Data API v3**를 활성화하고 웹 OAuth 클라이언트를 만드세요. Vercel 환경변수에 아래 값을 추가합니다.

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
YOUTUBE_SESSION_SECRET=길고_무작위인_문자열
APP_ORIGIN=https://내-도메인
```

OAuth 클라이언트의 승인된 리디렉션 URI에는 정확히 아래 주소를 등록합니다.

```text
https://내-도메인/api/youtube-auth?action=callback
```

YouTube Data API는 편집 권한이 있는 영상의 자막을 확인하는 데 사용합니다. YouTube 영상 파일을 임의로 내려받지는 않습니다. 원본은 YouTube Studio에서 내려받아 MP4로 올려 처리하세요.
