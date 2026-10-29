/**
 * CipherStream — Google Drive Live Video Connector (js/gdrive-engine.js)
 * Connects directly to any Google Account's "videos" folder via Google Drive API v3.
 * Supports:
 *   1. API Key + Shared Folder Link ("Anyone with the link" — fastest 2-min setup)
 *   2. Service Account JSON + Private Restricted Folder (100% private folder)
 * Credentials are AES-256-GCM encrypted inside assets/core.vlt behind your passkey.
 */

const VIDEO_NAME_RE = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ts|mpeg|mpg|ogv)$/i;

export function extractDriveFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  // Match /folders/<ID>
  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];

  // Match ?id=<ID> or &id=<ID>
  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch) return idParamMatch[1];

  // Raw ID directly
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
    this.config = config; // { mode: 'apikey' | 'service_account', folderId, apiKey?, clientEmail?, privateKeyPem?, tokenUri?, includeLocalVault? }
    this.tokenInfo = null;
    this.swReady = false;
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
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;

      // Wait briefly if controller hasn't claimed on very first install
      if (!navigator.serviceWorker.controller && reg.active) {
        await new Promise((r) => setTimeout(r, 120));
      }

      const targetSw = navigator.serviceWorker.controller || reg.active;
      if (!targetSw) {
        this.swReady = false;
        return false;
      }

      const auth = await this.ensureValidAuth();
      const ack = await sendSwMessage(targetSw, { type: 'SET_DRIVE_AUTH', auth });
      this.swReady = Boolean(ack.ok && navigator.serviceWorker.controller);
      return this.swReady;
    } catch {
      this.swReady = false;
      return false;
    }
  }

  async clearServiceWorkerAuth() {
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
   * Returns a playable stream URL (and optional download URL) for CipherPlayer.
   * Uses the local Service Worker HTTP 206 byte-range stream when active (instant start for any file size!),
   * with automatic direct/fetch fallback if Service Workers are disabled.
   */
  async resolveStream(part, onProgress) {
    const auth = await this.ensureValidAuth();
    const swActive = await this.syncServiceWorker();

    if (swActive && navigator.serviceWorker?.controller) {
      onProgress?.(100, 'Streaming from Google Drive');
      const safeName = encodeURIComponent(part.name || `${part.driveFileId}.mp4`);
      const streamUrl = `./__gdrive_stream__/${encodeURIComponent(
        part.driveFileId
      )}/${safeName}`;
      return {
        url: streamUrl,
        downloadUrl: `${streamUrl}?dl=1`,
        isDirectStream: true,
      };
    }

    // Fallback 1: API Key direct range-capable Google Drive media URL
    if (auth.mode === 'apikey') {
      onProgress?.(100, 'Streaming from Google Drive');
      const directUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        part.driveFileId
      )}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true&key=${encodeURIComponent(
        auth.apiKey
      )}`;
      return {
        url: directUrl,
        downloadUrl: directUrl,
        isDirectStream: true,
      };
    }

    // Fallback 2: Service Account without Service Worker -> fetch with Bearer token into Blob
    onProgress?.(6, 'Streaming from Google Drive...');
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        part.driveFileId
      )}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        credentials: 'omit',
      }
    );
    if (!res.ok) {
      throw new Error(`Drive stream failed (HTTP ${res.status})`);
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
          Math.min(96, Math.round((loaded / total) * 90) + 6),
          'Buffering from Google Drive...'
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

    const blob = new Blob([bytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    onProgress?.(100, 'MP4 Ready');
    return {
      url: blobUrl,
      downloadUrl: blobUrl,
      blob,
      isDirectStream: false,
    };
  }
}
