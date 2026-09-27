import { freshSession } from './_youtube-session.mjs';

export default async function handler(request, response) {
  // Browser uploads use handleUpload, which specifically needs the static token.
  const configured = Boolean(process.env.test_READ_WRITE_TOKEN);
  const session = await freshSession(request,response);
  return response.status(200).json({
    ready: configured && Boolean(session),
    configured,
    connected: Boolean(session),
    appOrigin: process.env.APP_ORIGIN || null,
  });
}
