#!/usr/bin/env node
/**
 * Local / Preview Server (dev-server.mjs)
 * - Serves the static GitHub Pages site on 0.0.0.0:8080
 * - Provides POST /__local_vault_save__ so pasting your Google Drive key ONCE in the preview
 *   writes directly to assets/core.vlt in the workspace permanently!
 * (On live GitHub Pages, the app commits directly to GitHub via API or GitHub Actions.)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // Health probe telling the UI that direct workspace persistence is available
  if (req.method === 'GET' && pathname.endsWith('/__local_vault_status__')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ writable: true }));
    return;
  }

  // Direct one-time save into assets/core.vlt (+ optional sample blob cleanup)
  if (req.method === 'POST' && pathname.endsWith('/__local_vault_save__')) {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total <= 15 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const b64 = body.coreVltBase64;
        if (!b64) throw new Error('Missing coreVltBase64 payload.');

        const rawBuf = Buffer.from(b64, 'base64');
        if (rawBuf.length < 40 || rawBuf[0] !== 0x89 || rawBuf[1] !== 0x56) {
          throw new Error('Invalid core.vlt binary signature.');
        }

        const vaultPath = path.join(ROOT, 'assets', 'core.vlt');
        fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
        fs.writeFileSync(vaultPath, rawBuf);

        // If user chose Google Drive only, clean out sample blobs from assets/videos/
        if (body.removeSampleBlobs) {
          const vidsDir = path.join(ROOT, 'assets', 'videos');
          if (fs.existsSync(vidsDir)) {
            for (const name of fs.readdirSync(vidsDir)) {
              if (name === '.gitkeep') continue;
              const p = path.join(vidsDir, name);
              if (fs.statSync(p).isFile()) fs.unlinkSync(p);
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, savedBytes: rawBuf.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let relPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(path.join(ROOT, relPath));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let targetPath = safePath;
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    targetPath = path.join(targetPath, 'index.html');
  }

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(targetPath);
  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (start < stat.size && end < stat.size && start <= end) {
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(targetPath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(targetPath).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CipherStream preview server listening on http://0.0.0.0:${PORT}`);
});
