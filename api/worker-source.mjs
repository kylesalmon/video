import { get } from '@vercel/blob';
import { Readable } from 'node:stream';
export default async function handler(request,response) {
  if (request.headers.authorization !== `Bearer ${process.env.WORKER_API_SECRET}`) return response.status(401).json({error:'Unauthorized'});
  try {
    const url=request.query.url; const parsed=new URL(url);
    if (!parsed.hostname.endsWith('.private.blob.vercel-storage.com')) throw new Error('Invalid source URL');
    const blob=await get(url,{access:'private'});
    if (!blob || blob.statusCode!==200) return response.status(404).json({error:'Source not found'});
    response.setHeader('Content-Type',blob.blob.contentType||'video/mp4'); Readable.fromWeb(blob.stream).pipe(response);
  } catch (error) { return response.status(400).json({error:error.message}); }
}
