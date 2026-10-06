/**
 * Local dev server: the static page from public/ and api/ask.ts on one port, like Vercel.
 *   DATABASE_URL=... npx tsx scripts/dev.ts      (keys from .env.local if present)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadEnv } from '../lib/env.ts';

loadEnv();
const { POST } = await import('../api/ask.ts');
const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const PORT = Number(process.env.PORT) || 4410;

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/ask') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const response = await POST(
        new Request(`http://localhost:${PORT}/api/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: `http://localhost:${PORT}` },
          body: Buffer.concat(chunks),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
      return;
    }
    const file = path.join(PUBLIC, req.url === '/' ? 'index.html' : (req.url ?? '').split('?')[0]);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
