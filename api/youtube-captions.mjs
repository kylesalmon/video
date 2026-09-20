import { readSession } from './_youtube-session.mjs';
export default async function handler(request, response) {
  const session = readSession(request); if (!session) return response.status(401).json({error:'YouTube 채널 연결이 필요합니다.'});
  const videoId = request.query.videoId; if (!videoId) return response.status(400).json({error:'videoId가 필요합니다.'});
  const result = await fetch(`https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`, {headers:{Authorization:`Bearer ${session.access_token}`}}).then(r => r.json());
  if (result.error) return response.status(result.error.code || 500).json({error:result.error.message});
  response.status(200).json({available:(result.items || []).length > 0, tracks:(result.items || []).map(track => ({id:track.id, language:track.snippet.language, name:track.snippet.name}))});
}
