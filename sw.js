/**
 * CipherStream Service Worker (sw.js)
 * Enables instant HTTP 206 Partial Content byte-range MP4 streaming from Google Drive API v3
 * on both Android and Windows without exposing Drive credentials in URLs or GitHub code.
 */

let driveAuth = null; // Held ONLY in volatile memory while vault is unlocked

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
    event.ports?.[0]?.postMessage({ ok: true });
  } else if (data.type === 'CLEAR_DRIVE_AUTH') {
    driveAuth = null;
    event.ports?.[0]?.postMessage({ ok: true });
  } else if (data.type === 'PING_DRIVE_SW') {
    event.ports?.[0]?.postMessage({ ok: true, hasAuth: Boolean(driveAuth) });
  }
});

const STREAM_MARKER = '/__gdrive_stream__/';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const markerIdx = url.pathname.indexOf(STREAM_MARKER);
  if (markerIdx === -1) return;

  const rest = url.pathname.slice(markerIdx + STREAM_MARKER.length);
  const slashIdx = rest.indexOf('/');
  const fileId = decodeURIComponent(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
  const isDownload = url.searchParams.get('dl') === '1';
  const rawName = slashIdx === -1 ? `${fileId}.mp4` : decodeURIComponent(rest.slice(slashIdx + 1));

  if (!fileId || !driveAuth) {
    event.respondWith(
      new Response('Vault locked or Google Drive session expired.', { status: 401 })
    );
    return;
  }

  event.respondWith(handleDriveStream(event.request, fileId, rawName, isDownload));
});

async function handleDriveStream(request, fileId, fileName, isDownload) {
  let upstreamUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`;

  const headers = new Headers();
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    headers.set('Range', rangeHeader);
  }

  if (driveAuth.mode === 'apikey' && driveAuth.apiKey) {
    upstreamUrl += `&key=${encodeURIComponent(driveAuth.apiKey)}`;
  } else if (driveAuth.accessToken) {
    headers.set('Authorization', `Bearer ${driveAuth.accessToken}`);
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
  outHeaders.set('Content-Type', 'video/mp4');
  outHeaders.set('Accept-Ranges', 'bytes');
  outHeaders.set('Cache-Control', 'private, no-store');

  const contentLength = upstreamRes.headers.get('content-length');
  if (contentLength) outHeaders.set('Content-Length', contentLength);

  const contentRange = upstreamRes.headers.get('content-range');
  if (contentRange) outHeaders.set('Content-Range', contentRange);

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
