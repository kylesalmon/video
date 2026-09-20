import { readSession } from './_youtube-session.mjs';
export default async function handler(request, response) {
  const session = readSession(request); if (!session) return response.status(401).json({error:'YouTube 채널 연결이 필요합니다.'});
  const channel = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', {headers:{Authorization:`Bearer ${session.access_token}`}}).then(r => r.json());
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads; if (!uploads) return response.status(404).json({error:'연결된 YouTube 채널을 찾지 못했습니다.'});
  const list = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploads}&maxResults=25`, {headers:{Authorization:`Bearer ${session.access_token}`}}).then(r => r.json());
  response.status(200).json({ videos:(list.items || []).map(item => ({id:item.contentDetails.videoId, title:item.snippet.title, publishedAt:item.contentDetails.videoPublishedAt})) });
}
