import { readSession } from './_youtube-session.mjs';

export default function handler(request, response) {
  // Browser uploads use handleUpload, which specifically needs the static token.
  const configured = Boolean(process.env.test_READ_WRITE_TOKEN);
  return response.status(200).json({
    ready: configured && Boolean(readSession(request)),
    configured,
    connected: Boolean(readSession(request)),
  });
}
