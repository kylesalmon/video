import { handleUpload } from '@vercel/blob/client';
import { readSession } from './_youtube-session.mjs';

export default async function handler(request, response) {
  try {
    // Vercel's Node runtime parses JSON request bodies before this handler runs.
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (!body) throw new Error('업로드 권한 요청 본문이 비어 있습니다.');
    const json = await handleUpload({
      body,
      request,
      token: process.env.test_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!readSession(request)) throw new Error('대용량 업로드 전 YouTube 채널 연결이 필요합니다.');
        if (!pathname.startsWith('uploads/') || !pathname.toLowerCase().endsWith('.mp4')) throw new Error('MP4 파일만 업로드할 수 있습니다.');
        return { allowedContentTypes: ['video/mp4'], addRandomSuffix: true };
      },
    });
    return response.status(200).json(json);
  } catch (error) {
    return response.status(400).json({ error: error.message || '업로드 권한을 만들지 못했습니다.' });
  }
}
