/**
 * CipherStream — Google Drive Live Video Connector (js/gdrive-engine.js)
 * Connects directly to any Google Account's "videos" folder via Google Drive API v3.
 * Supports:
 *   1. API Key + Shared Folder Link ("Anyone with the link" — fastest 2-min setup)
 *   2. Service Account JSON + Private Restricted Folder (100% private folder)
 * Credentials are RSA-OAEP + AES-256-GCM encrypted inside assets/core.vlt behind your passkey.
 */

const VIDEO_NAME_RE = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ts|mpeg|mpg|ogv)$/i;
const REQUIRED_SW_VERSION = 2;

let activeDriveClientInstance = null;
let swAuthListenerBound = false;

function ensureGlobalSwAuthResponder() {
  if (swAuthListenerBound || !('serviceWorker' in navigator)) return;
  swAuthListenerBound = true;

  navigator.serviceWorker.addEventListener('message', async (event) => {
    if (event.data?.type !== 'SW_NEED_DRIVE_AUTH') return;
    const replyPort = event.ports?.[0];
    if (!replyPort) return;

    if (!activeDriveClientInstance) {
      replyPort.postMessage({ auth: null });
      return;
    }

    try {
      const auth = await activeDriveClientInstance.ensureValidAuth();
      replyPort.postMessage({ auth });
    } catch {
      replyPort.postMessage({ auth: null });
    }
  });
}

export function extractDriveFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];

  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch) return idParamMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;

  return '';
}

function base64UrlEncodeBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeJson(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return base64UrlEncodeBytes(bytes);
}

function pemToPkcs8Bytes(pem) {
  const cleaned = String(pem || '')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Signs an RS256 JWT in browser WebCrypto and exchanges it for a Google Drive OAuth2 token.
 */
async function mintServiceAccountToken(clientEmail, privateKeyPem, tokenUri) {
  const subtle = window.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API required for Service Account JWT signing.');
  }

  const pkcs8 = pemToPkcs8Bytes(privateKeyPem);
  const signingKey = await subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const aud = tokenUri || 'https://oauth2.googleapis.com/token';
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud,
    iat: now - 30,
    exp: now + 3540,
  };

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const sigBuf = await subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(sigBuf))}`;

  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )}&assertion=${encodeURIComponent(jwt)}`,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Service Account token exchange failed (HTTP ${res.status}).`
    );
  }

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 3500) - 180) * 1000,
  };
}

function sendSwMessage(sw, payload) {
  return new Promise((resolve) => {
    try {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve({ ok: false }), 1500);
      channel.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data || { ok: true });
      };
      sw.postMessage(payload, [channel.port2]);
    } catch {
      resolve({ ok: false });
    }
  });
}

export class GoogleDriveClient {
  constructor(config) {
    this.config = config;
    this.tokenInfo = null;
    this.swReady = false;
    activeDriveClientInstance = this;
    ensureGlobalSwAuthResponder();
  }

  async ensureValidAuth() {
    if (this.config.mode === 'apikey') {
      if (!this.config.apiKey) {
        throw new Error('Google Drive API Key is empty.');
      }
      return { mode: 'apikey', apiKey: this.config.apiKey };
    }

    if (this.config.mode === 'service_account') {
      if (
        !this.tokenInfo ||
        !this.tokenInfo.accessToken ||
        Date.now() >= this.tokenInfo.expiresAt
      ) {
        this.tokenInfo = await mintServiceAccountToken(
          this.config.clientEmail,
          this.config.privateKeyPem,
          this.config.tokenUri
        );
      }
      return { mode: 'service_account', accessToken: this.tokenInfo.accessToken };
    }

    throw new Error(`Unsupported Google Drive auth mode: ${this.config.mode}`);
  }

  async syncServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      this.swReady = false;
      return false;
    }

    try {
      const reg = await navigator.serviceWorker.register('./sw.js?v=2', {
        scope: './',
        updateViaCache: 'none',
      });
      // Kick off update check in case an older sw.js v1 was previously installed
      reg.update().catch(() => {});
      await navigator.serviceWorker.ready;

      // Wait briefly if newly installed v2 worker is claiming the client
      if (
        !navigator.serviceWorker.controller ||
        !navigator.serviceWorker.controller.scriptURL.includes('v=2')
      ) {
        await new Promise((r) => setTimeout(r, 180));
      }

      const targetSw = navigator.serviceWorker.controller || reg.active;
      if (!targetSw) {
        this.swReady = false;
        return false;
      }

      const auth = await this.ensureValidAuth();
      const ack = await sendSwMessage(targetSw, { type: 'SET_DRIVE_AUTH', auth });
      this.swReady = Boolean(
        ack.ok &&
          Number(ack.swVersion || 0) >= REQUIRED_SW_VERSION &&
          navigator.serviceWorker.controller
      );
      return this.swReady;
    } catch {
      this.swReady = false;
      return false;
    }
  }

  async clearServiceWorkerAuth() {
    if (activeDriveClientInstance === this) {
      activeDriveClientInstance = null;
    }
    if (!('serviceWorker' in navigator)) return;
    try {
      const sw = navigator.serviceWorker.controller;
      if (sw) {
        await sendSwMessage(sw, { type: 'CLEAR_DRIVE_AUTH' });
      }
    } catch {
      // ignore
    }
  }

  buildDirectDriveMediaUrl(fileId, apiKey) {
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true&key=${encodeURIComponent(
      apiKey
    )}`;
  }

  async fetchFolderChildren(folderId) {
    const auth = await this.ensureValidAuth();
    const allFiles = [];
    let pageToken = '';

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields:
          'nextPageToken,files(id,name,mimeType,size,thumbnailLink,videoMediaMetadata,modifiedTime)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        orderBy: 'name',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const headers = {};
      if (auth.mode === 'apikey') {
        params.set('key', auth.apiKey);
      } else {
        headers.Authorization = `Bearer ${auth.accessToken}`;
      }

      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        { headers, credentials: 'omit' }
      );
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          body?.error?.message ||
          `Google Drive API error (HTTP ${res.status}). Check Folder sharing & API Key.`;
        throw new Error(msg);
      }

      if (Array.isArray(body.files)) {
        allFiles.push(...body.files);
      }
      pageToken = body.nextPageToken || '';
    } while (pageToken);

    return allFiles;
  }

  /**
   * Lists all video files inside the configured Google Drive "videos" folder
   * (plus up to 2 levels of subfolders automatically).
   */
  async listVideos() {
    activeDriveClientInstance = this;
    await this.syncServiceWorker();
    const rootId = extractDriveFolderId(this.config.folderId);
    if (!rootId) {
      throw new Error('Invalid Google Drive Folder ID or URL.');
    }

    const collected = [];

    const scanFolder = async (folderId, relFolder, depth) => {
      const children = await this.fetchFolderChildren(folderId);
      const subfolders = [];

      for (const f of children) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (depth < 2) {
            const subPath = relFolder ? `${relFolder}/${f.name}` : f.name;
            subfolders.push({ id: f.id, subPath });
          }
          continue;
        }

        const isVideo =
          (f.mimeType && f.mimeType.startsWith('video/')) || VIDEO_NAME_RE.test(f.name || '');
        if (!isVideo) continue;

        const cleanMp4Name = VIDEO_NAME_RE.test(f.name)
          ? f.name.replace(VIDEO_NAME_RE, '.mp4')
          : `${f.name}.mp4`;

        const durationMs = Number(f.videoMediaMetadata?.durationMillis || 0);
        const duration = durationMs > 0 ? Math.round((durationMs / 1000) * 100) / 100 : 0;
        const width = Number(f.videoMediaMetadata?.width || 1280);
        const height = Number(f.videoMediaMetadata?.height || 720);
        const size = Number(f.size || 0);

        let poster = null;
        if (f.thumbnailLink) {
          poster = f.thumbnailLink.replace(/=s\d+$/, '=s640');
        }

        collected.push({
          id: `gd_${f.id}`,
          sourceType: 'gdrive',
          driveFileId: f.id,
          mimeType: f.mimeType || 'video/mp4',
          blobFile: `gdrive://${f.id.slice(0, 12)}…`,
          name: cleanMp4Name,
          rawDriveName: f.name,
          folder: relFolder,
          size,
          duration,
          width,
          height,
          addedAt: f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now(),
          poster,
        });
      }

      if (subfolders.length > 0) {
        await Promise.all(
          subfolders.map((sf) => scanFolder(sf.id, sf.subPath, depth + 1))
        );
      }
    };

    await scanFolder(rootId, '', 0);
    return collected;
  }

  /**
   * Returns a primary playable stream URL PLUS automatic fallback candidates
   * so videos never get stuck buffering on any browser/device.
   */
  async resolveStream(part, onProgress) {
    activeDriveClientInstance = this;
    const auth = await this.ensureValidAuth();
    const swActive = await this.syncServiceWorker();

    const candidateUrls = [];
    let downloadUrl = '';

    if (swActive && navigator.serviceWorker?.controller) {
      const safeName = encodeURIComponent(part.rawDriveName || part.name || `${part.driveFileId}.mp4`);
      const qs = new URLSearchParams();
      if (part.size > 0) qs.set('sz', String(part.size));
      if (part.mimeType) qs.set('mt', part.mimeType);
      const swUrl = `./__gdrive_stream__/${encodeURIComponent(
        part.driveFileId
      )}/${safeName}${qs.toString() ? `?${qs.toString()}` : ''}`;

      candidateUrls.push(swUrl);
      const dlQs = new URLSearchParams(qs);
      dlQs.set('dl', '1');
      downloadUrl = `./__gdrive_stream__/${encodeURIComponent(
        part.driveFileId
      )}/${safeName}?${dlQs.toString()}`;
    }

    if (auth.mode === 'apikey' && auth.apiKey) {
      const directUrl = this.buildDirectDriveMediaUrl(part.driveFileId, auth.apiKey);
      candidateUrls.push(directUrl);
      if (!downloadUrl) downloadUrl = directUrl;
    }

    if (candidateUrls.length > 0) {
      onProgress?.(100, 'Streaming from Google Drive');
      return {
        url: candidateUrls[0],
        fallbackUrls: candidateUrls.slice(1),
        downloadUrl,
        isDirectStream: true,
      };
    }

    // Service Account mode when Service Workers are completely disabled -> fetch into Blob
    return this.fetchBlobOrDiagnose(part, onProgress);
  }

  /**
   * Fallback 3 / Diagnostic fetcher:
   * Fetches directly via Fetch API (streaming progress into a local Blob for <video>)
   * OR extracts Google Drive's exact JSON error message (e.g. quota, sharing, API key referrer)
   * if Google Drive rejected the media download.
   */
  async fetchBlobOrDiagnose(part, onProgress) {
    const auth = await this.ensureValidAuth();
    let mediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      part.driveFileId
    )}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`;

    const headers = {};
    if (auth.mode === 'apikey') {
      mediaUrl += `&key=${encodeURIComponent(auth.apiKey)}`;
    } else {
      headers.Authorization = `Bearer ${auth.accessToken}`;
    }

    // If file is very large (> 180 MB), probe first 1 KB with Range to catch any 403/404 JSON error cleanly
    // without downloading 500 MB into RAM.
    const LARGE_LIMIT = 180 * 1024 * 1024;
    if (part.size > LARGE_LIMIT) {
      const probeRes = await fetch(mediaUrl, {
        headers: { ...headers, Range: 'bytes=0-1023' },
        credentials: 'omit',
      });
      if (!probeRes.ok && probeRes.status !== 206) {
        const errBody = await probeRes.json().catch(() => ({}));
        const reason = errBody?.error?.errors?.[0]?.reason || '';
        const msg =
          errBody?.error?.message || `Google Drive HTTP ${probeRes.status}`;
        throw new Error(reason ? `${msg} (${reason})` : msg);
      }
      throw new Error(
        'Browser could not decode this video stream directly (check that video codec is H.264 MP4 rather than HEVC/MKV).'
      );
    }

    onProgress?.(6, 'Buffering video from Google Drive');
    const res = await fetch(mediaUrl, {
      headers,
      credentials: 'omit',
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const reason = errBody?.error?.errors?.[0]?.reason || '';
      const msg = errBody?.error?.message || `Google Drive stream failed (HTTP ${res.status})`;
      throw new Error(reason ? `${msg} (${reason})` : msg);
    }

    const total = Number(res.headers.get('content-length')) || part.size || 0;
    let bytes;
    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.(
          Math.min(97, Math.round((loaded / total) * 90) + 6),
          'Buffering video'
        );
      }
      bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }

    const mime =
      part.mimeType && part.mimeType.startsWith('video/') ? part.mimeType : 'video/mp4';
    const blob = new Blob([bytes], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    onProgress?.(100, 'Ready');
    return {
      url: blobUrl,
      fallbackUrls: [],
      downloadUrl: blobUrl,
      blob,
      isDirectStream: false,
    };
  }
}
