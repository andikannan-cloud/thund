/**
 * CipherStream Service Worker v2 (sw.js)
 * Enables instant HTTP 206 Partial Content byte-range MP4 streaming from Google Drive API v3
 * on both Android and Windows:
 *   1. Synthesizes exact Content-Range headers stripped by Google's CORS Access-Control-Expose-Headers
 *   2. Auto-recovers credentials from active unlocked tabs if the browser suspends an idle worker
 */

const SW_VERSION = 2;
let driveAuth = null; // Held ONLY in volatile memory while vault is unlocked
const fileMetaCache = new Map(); // fileId -> { size: number, mimeType: string }

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_DRIVE_AUTH') {
    driveAuth = data.auth || null;
    event.ports?.[0]?.postMessage({ ok: true, swVersion: SW_VERSION });
  } else if (data.type === 'CLEAR_DRIVE_AUTH') {
    driveAuth = null;
    fileMetaCache.clear();
    event.ports?.[0]?.postMessage({ ok: true, swVersion: SW_VERSION });
  } else if (data.type === 'PING_DRIVE_SW') {
    event.ports?.[0]?.postMessage({
      ok: true,
      swVersion: SW_VERSION,
      hasAuth: Boolean(driveAuth),
    });
  }
});

/**
 * If Chrome/Android suspended the idle Service Worker after ~30s, pull auth back
 * transparently from any open unlocked CipherStream window.
 */
async function ensureWorkerAuth() {
  if (driveAuth && (driveAuth.apiKey || driveAuth.accessToken)) {
    return driveAuth;
  }

  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of clients) {
    const auth = await new Promise((resolve) => {
      try {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1200);
        ch.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(e.data?.auth || null);
        };
        client.postMessage({ type: 'SW_NEED_DRIVE_AUTH' }, [ch.port2]);
      } catch {
        resolve(null);
      }
    });

    if (auth && (auth.apiKey || auth.accessToken)) {
      driveAuth = auth;
      return driveAuth;
    }
  }

  return null;
}

function inferVideoMime(rawMime, fileName) {
  if (rawMime && rawMime.startsWith('video/')) {
    return rawMime;
  }
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.ogv')) return 'video/ogg';
  return 'video/mp4';
}

async function getKnownFileMeta(fileId, auth, hintSize, hintMime, fileName) {
  if (hintSize > 0) {
    const meta = {
      size: hintSize,
      mimeType: inferVideoMime(hintMime, fileName),
    };
    fileMetaCache.set(fileId, meta);
    return meta;
  }

  if (fileMetaCache.has(fileId)) {
    return fileMetaCache.get(fileId);
  }

  try {
    let metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?fields=size,mimeType&supportsAllDrives=true`;
    const headers = new Headers();
    if (auth.mode === 'apikey' && auth.apiKey) {
      metaUrl += `&key=${encodeURIComponent(auth.apiKey)}`;
    } else if (auth.accessToken) {
      headers.set('Authorization', `Bearer ${auth.accessToken}`);
    }
    const res = await fetch(metaUrl, { headers, credentials: 'omit' });
    if (res.ok) {
      const data = await res.json();
      const meta = {
        size: Number(data.size || 0),
        mimeType: inferVideoMime(data.mimeType || hintMime, fileName),
      };
      if (meta.size > 0) {
        fileMetaCache.set(fileId, meta);
      }
      return meta;
    }
  } catch {
    // ignore metadata probe errors; stream handler still computes range from Content-Length
  }

  return {
    size: 0,
    mimeType: inferVideoMime(hintMime, fileName),
  };
}

const STREAM_MARKER = '/__gdrive_stream__/';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const markerIdx = url.pathname.indexOf(STREAM_MARKER);
  if (markerIdx === -1) return;

  const rest = url.pathname.slice(markerIdx + STREAM_MARKER.length);
  const slashIdx = rest.indexOf('/');
  const fileId = decodeURIComponent(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
  const isDownload = url.searchParams.get('dl') === '1';
  const hintSize = Number(url.searchParams.get('sz') || 0);
  const hintMime = url.searchParams.get('mt') || '';
  const rawName = slashIdx === -1 ? `${fileId}.mp4` : decodeURIComponent(rest.slice(slashIdx + 1));

  if (!fileId) {
    event.respondWith(new Response('Missing Google Drive file ID.', { status: 400 }));
    return;
  }

  event.respondWith(
    handleDriveStream(event.request, fileId, rawName, isDownload, hintSize, hintMime)
  );
});

async function handleDriveStream(request, fileId, fileName, isDownload, hintSize, hintMime) {
  const auth = await ensureWorkerAuth();
  if (!auth) {
    return new Response('Vault locked or Google Drive session expired.', { status: 401 });
  }

  const fileMeta = await getKnownFileMeta(fileId, auth, hintSize, hintMime, fileName);

  let upstreamUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`;

  const headers = new Headers();
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    headers.set('Range', rangeHeader);
  }

  if (auth.mode === 'apikey' && auth.apiKey) {
    upstreamUrl += `&key=${encodeURIComponent(auth.apiKey)}`;
  } else if (auth.accessToken) {
    headers.set('Authorization', `Bearer ${auth.accessToken}`);
  } else {
    return new Response('Missing Google Drive credentials.', { status: 401 });
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method: 'GET',
    headers,
    credentials: 'omit',
  });

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return upstreamRes;
  }

  const outHeaders = new Headers();
  const upstreamType = upstreamRes.headers.get('content-type') || '';
  outHeaders.set(
    'Content-Type',
    upstreamType.startsWith('video/') ? upstreamType : fileMeta.mimeType
  );
  outHeaders.set('Accept-Ranges', 'bytes');
  outHeaders.set('Cache-Control', 'private, no-store');

  const clHeader = upstreamRes.headers.get('content-length');
  const chunkLen = clHeader ? Number(clHeader) : 0;

  // Google Drive's X-GUploader omits Content-Range from Access-Control-Expose-Headers on CORS fetches.
  // Reconstruct the exact byte range so Chromium/Android/Safari <video> demuxers never fail with Format Error!
  let contentRange = upstreamRes.headers.get('content-range');
  if (!contentRange && upstreamRes.status === 206 && rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/i.exec(rangeHeader);
    if (match) {
      const start = Number(match[1]);
      const reqEnd = match[2] ? Number(match[2]) : null;
      const total = fileMeta.size > 0 ? fileMeta.size : 0;

      let end;
      if (chunkLen > 0) {
        end = start + chunkLen - 1;
      } else if (reqEnd !== null && total > 0) {
        end = Math.min(total - 1, reqEnd);
      } else if (reqEnd !== null) {
        end = reqEnd;
      } else if (total > 0) {
        end = total - 1;
      } else {
        end = start;
      }

      const totalStr =
        total > 0
          ? String(total)
          : reqEnd === null && chunkLen > 0
          ? String(start + chunkLen)
          : '*';

      contentRange = `bytes ${start}-${end}/${totalStr}`;
      if (!clHeader && end >= start) {
        outHeaders.set('Content-Length', String(end - start + 1));
      }
    }
  }

  if (clHeader) {
    outHeaders.set('Content-Length', clHeader);
  }
  if (contentRange) {
    outHeaders.set('Content-Range', contentRange);
  }

  if (isDownload) {
    const safeName = fileName.replace(/["\r\n]/g, '_');
    outHeaders.set('Content-Disposition', `attachment; filename="${safeName}"`);
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: outHeaders,
  });
}
