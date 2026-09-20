export default function handler(_request, response) {
  response.status(503).json({
    error: '영상 처리 서버가 아직 배포되지 않았습니다. Vercel은 화면과 업로드를 담당하고, FFmpeg 편집 서버를 별도로 연결해야 합니다.'
  });
}
