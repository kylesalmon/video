export default function handler(_request, response) {
  response.status(501).json({
    error: 'YouTube 영상 처리는 아직 연결되지 않았습니다. 본인이 사용 권한을 가진 MP4를 올려주세요.'
  });
}
