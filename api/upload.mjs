import { handleUpload } from '@vercel/blob/client';
import { readSession } from './_youtube-session.mjs';

export default async function handler(request) {
  try {
    const body = await request.json();
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!readSession(request)) throw new Error('대용량 업로드 전 YouTube 채널 연결이 필요합니다.');
        if (!pathname.startsWith('uploads/') || !pathname.toLowerCase().endsWith('.mp4')) throw new Error('MP4 파일만 업로드할 수 있습니다.');
        return { allowedContentTypes: ['video/mp4'], addRandomSuffix: true };
      },
      onUploadCompleted: async ({ blob }) => console.log(`Video upload completed: ${blob.pathname}`),
    });
    return Response.json(json);
  } catch (error) {
    return Response.json({ error: error.message || '업로드 권한을 만들지 못했습니다.' }, { status: 400 });
  }
}
