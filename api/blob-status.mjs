import { readSession } from './_youtube-session.mjs';

export default function handler(request) {
  const configured = Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));
  return Response.json({
    ready: configured && Boolean(readSession(request)),
    configured,
    connected: Boolean(readSession(request)),
  });
}
