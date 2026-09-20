import { readSession } from './_youtube-session.mjs';

export default function handler(request) {
  // Browser uploads use handleUpload, which specifically needs the static token.
  const configured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  return Response.json({
    ready: configured && Boolean(readSession(request)),
    configured,
    connected: Boolean(readSession(request)),
  });
}
