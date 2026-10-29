/**
 * CipherStream Vault Crypto Engine (js/crypto-engine.js)
 * - Unpacks & packs opaque binary core.vlt
 * - Derives AES-256-GCM wrapping key via PBKDF2-SHA256 (310,000 iterations)
 * - Unwraps RSA-OAEP-2048 private key in RAM only
 * - Unseals permanent Google Drive folder config AND/OR local encrypted blobs
 * - Persists one-time setup directly to workspace disk or GitHub repository
 */

import { GoogleDriveClient } from './gdrive-engine.js?v=3';

const MAGIC = [0x89, 0x56, 0x4c, 0x54]; // \x89VLT
const MASK_LEN = 32;

export class InvalidPasskeyError extends Error {
  constructor(message = 'Incorrect passkey. Decryption failed.') {
    super(message);
    this.name = 'InvalidPasskeyError';
  }
}

export function toBase64(bytes) {
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function packVaultBinary(vaultObj) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(vaultObj));
  const mask = window.crypto.getRandomValues(new Uint8Array(MASK_LEN));
  const out = new Uint8Array(MAGIC.length + MASK_LEN + jsonBytes.length);
  out.set(MAGIC, 0);
  out.set(mask, MAGIC.length);
  const offset = MAGIC.length + MASK_LEN;
  for (let i = 0; i < jsonBytes.length; i++) {
    out[offset + i] = jsonBytes[i] ^ mask[i % MASK_LEN];
  }
  return out;
}

export function unpackVaultBinary(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (
    bytes.length < MAGIC.length + MASK_LEN ||
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new Error('Vault index (assets/core.vlt) is missing or corrupted.');
  }
  const mask = bytes.subarray(MAGIC.length, MAGIC.length + MASK_LEN);
  const payload = bytes.subarray(MAGIC.length + MASK_LEN);
  const plain = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    plain[i] = payload[i] ^ mask[i % MASK_LEN];
  }
  const jsonText = new TextDecoder().decode(plain);
  return JSON.parse(jsonText);
}

export async function fetchVaultManifest() {
  const res = await fetch(`./assets/core.vlt?v=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Could not load encrypted vault index (HTTP ${res.status}).`);
  }
  const buf = await res.arrayBuffer();
  return unpackVaultBinary(buf);
}

export async function checkLocalWritableServer() {
  try {
    const res = await fetch(`./__local_vault_status__?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.writable);
  } catch {
    return false;
  }
}

export function inferGitHubRepoFromLocation() {
  const host = window.location.hostname || '';
  if (!host.endsWith('.github.io')) return '';
  const owner = host.slice(0, -'.github.io'.length);
  const seg = (window.location.pathname || '/').split('/').filter(Boolean)[0];
  if (seg) return `${owner}/${seg}`;
  return `${owner}/${owner}.github.io`;
}

/**
 * Commits the encrypted core.vlt directly into a GitHub repository via GitHub REST API
 * so every user visiting GitHub Pages permanently gets the connected Google Drive vault!
 */
export async function commitVaultToGitHubRepo({
  repoFullName,
  branch = 'main',
  token,
  packedBytes,
}) {
  const cleanRepo = String(repoFullName || '').trim().replace(/^\/+|\/+$/g, '');
  if (!cleanRepo.includes('/')) {
    throw new Error('Enter GitHub repository as owner/repo-name.');
  }
  const apiUrl = `https://api.github.com/repos/${cleanRepo}/contents/assets/core.vlt`;
  const authHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token.trim()}`,
  };

  // 1. Read existing file SHA if assets/core.vlt already exists on branch
  let existingSha = undefined;
  const getRes = await fetch(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`,
    { headers: authHeaders }
  );
  if (getRes.ok) {
    const meta = await getRes.json();
    existingSha = meta.sha;
  } else if (getRes.status !== 404) {
    const errBody = await getRes.json().catch(() => ({}));
    throw new Error(
      errBody.message || `GitHub API read error (HTTP ${getRes.status}). Check token & repo name.`
    );
  }

  // 2. Commit updated encrypted assets/core.vlt
  const putBody = {
    message: 'chore(vault): permanently seal encrypted Google Drive connector [vault-sync]',
    content: toBase64(packedBytes),
    branch,
  };
  if (existingSha) putBody.sha = existingSha;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const errBody = await putRes.json().catch(() => ({}));
    throw new Error(
      errBody.message || `GitHub commit failed (HTTP ${putRes.status}). Ensure token has Contents: Read & Write permission.`
    );
  }

  return await putRes.json();
}

async function deriveWrappingKey(passkey, saltBytes, iterations, usages = ['decrypt']) {
  const subtle = window.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto API requires HTTPS or localhost (automatic on GitHub Pages).'
    );
  }
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(String(passkey)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

export function prettifyTitle(rawStem) {
  return rawStem
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function groupMediaItems(rawItems) {
  const dedupMap = new Map();
  for (const item of rawItems) {
    const fullKey = `${item.sourceType || 'local'}::${item.folder || ''}/${item.name}`.toLowerCase();
    const prev = dedupMap.get(fullKey);
    if (!prev || (item.addedAt || 0) >= (prev.addedAt || 0)) {
      dedupMap.set(fullKey, item);
    }
  }
  const items = Array.from(dedupMap.values());

  const partRegex = /^(.+?)(?:[_\-\s]+(?:part|pt|ep|ch|p)?|[_\-])(\d{1,4})$/i;
  const candidateBuckets = new Map();
  const standaloneItems = [];

  for (const item of items) {
    const stem = item.name.replace(/\.[^.]+$/, '');
    const match = stem.match(partRegex);
    if (match) {
      const baseRaw = match[1].trim();
      const partDigits = match[2];
      const partNum = parseInt(partDigits, 10);
      const bucketKey = `${(item.folder || '').toLowerCase()}::${baseRaw
        .toLowerCase()
        .replace(/[_\-\s]+/g, '_')}`;
      if (!candidateBuckets.has(bucketKey)) {
        candidateBuckets.set(bucketKey, {
          baseRaw,
          folder: item.folder || '',
          members: [],
        });
      }
      candidateBuckets.get(bucketKey).members.push({
        item,
        stem,
        partDigits,
        partNum,
      });
    } else {
      standaloneItems.push({ item, stem });
    }
  }

  const catalog = [];

  for (const [bucketKey, bucket] of candidateBuckets.entries()) {
    if (bucket.members.length >= 2) {
      bucket.members.sort((a, b) => {
        if (a.partNum !== b.partNum) return a.partNum - b.partNum;
        return a.item.name.localeCompare(b.item.name);
      });

      const parts = bucket.members.map((m, idx) => ({
        ...m.item,
        partIndex: idx,
        partNumber: idx + 1,
        partDigits: m.partDigits,
        partLabel: `Part ${String(idx + 1).padStart(2, '0')}`,
        shortCode: `_${m.partDigits}`,
      }));

      const coverPart = parts.find((p) => p.poster) || parts[0];
      const totalDuration = parts.reduce((acc, p) => acc + (p.duration || 0), 0);
      const totalSize = parts.reduce((acc, p) => acc + (p.size || 0), 0);
      const latestAdded = Math.max(...parts.map((p) => p.addedAt || 0));

      catalog.push({
        id: `grp_${bucketKey.replace(/[^a-z0-9]+/gi, '_')}`,
        isGroup: true,
        sourceType: coverPart.sourceType || 'local',
        title: prettifyTitle(bucket.baseRaw),
        rawBase: bucket.baseRaw,
        folder: bucket.folder,
        coverPoster: coverPart.poster || null,
        coverBlobFile: coverPart.blobFile,
        partCount: parts.length,
        totalDuration,
        totalSize,
        width: coverPart.width || 1280,
        height: coverPart.height || 720,
        addedAt: latestAdded,
        parts,
      });
    } else {
      const single = bucket.members[0];
      standaloneItems.push({ item: single.item, stem: single.stem });
    }
  }

  for (const { item, stem } of standaloneItems) {
    const singlePart = {
      ...item,
      partIndex: 0,
      partNumber: 1,
      partDigits: '00',
      partLabel: 'Full Video',
      shortCode: '',
    };
    catalog.push({
      id: `vid_${item.id}`,
      isGroup: false,
      sourceType: item.sourceType || 'local',
      title: prettifyTitle(stem),
      rawBase: stem,
      folder: item.folder || '',
      coverPoster: item.poster || null,
      coverBlobFile: item.blobFile,
      partCount: 1,
      totalDuration: item.duration || 0,
      totalSize: item.size || 0,
      width: item.width || 1280,
      height: item.height || 720,
      addedAt: item.addedAt || 0,
      parts: [singlePart],
    });
  }

  catalog.sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return catalog;
}

export class VaultSession {
  constructor() {
    this.unlocked = false;
    this.catalog = [];
    this.rawEntriesCount = 0;
    this.localItems = [];
    this.driveItems = [];
    this.driveConfig = null;
    this.driveClient = null;
    this.driveError = null;

    this.blobCache = new Map();
    this.inflight = new Map();
  }

  hasGoogleDrive() {
    return Boolean(this.driveClient && this.driveConfig);
  }

  async unlock(vaultObj, passkey) {
    const subtle = window.crypto?.subtle;
    if (!subtle) {
      throw new Error('Secure context (HTTPS / localhost) required for WebCrypto.');
    }

    const wrappingKey = await deriveWrappingKey(
      passkey,
      fromBase64(vaultObj.kdf.salt),
      vaultObj.kdf.iter,
      ['decrypt']
    );

    let pkcs8Buf;
    try {
      pkcs8Buf = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(vaultObj.kdf.iv) },
        wrappingKey,
        fromBase64(vaultObj.wrappedPriv)
      );
    } catch {
      throw new InvalidPasskeyError();
    }

    const privateKey = await subtle.importKey(
      'pkcs8',
      pkcs8Buf,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );

    // 1. Unseal permanent Google Drive config if present in core.vlt
    this.driveConfig = null;
    this.driveClient = null;
    this.driveItems = [];
    this.driveError = null;

    if (vaultObj.gdrive) {
      let gdrivePlainBuf;
      if (vaultObj.gdrive.k && vaultObj.gdrive.i && vaultObj.gdrive.m) {
        // Hybrid RSA-OAEP + AES-256-GCM envelope
        const gdKeyRaw = await subtle.decrypt(
          { name: 'RSA-OAEP' },
          privateKey,
          fromBase64(vaultObj.gdrive.k)
        );
        const gdKey = await subtle.importKey(
          'raw',
          gdKeyRaw,
          { name: 'AES-GCM' },
          false,
          ['decrypt']
        );
        gdrivePlainBuf = await subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(vaultObj.gdrive.i) },
          gdKey,
          fromBase64(vaultObj.gdrive.m)
        );
      } else if (vaultObj.gdrive.sealed && vaultObj.gdrive.iv) {
        // Direct wrappingKey envelope fallback
        gdrivePlainBuf = await subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(vaultObj.gdrive.iv) },
          wrappingKey,
          fromBase64(vaultObj.gdrive.sealed)
        );
      }

      if (gdrivePlainBuf) {
        this.driveConfig = JSON.parse(new TextDecoder().decode(gdrivePlainBuf));
        this.driveClient = new GoogleDriveClient(this.driveConfig);
        try {
          this.driveItems = await this.driveClient.listVideos();
        } catch (err) {
          this.driveError = err.message || 'Failed to list Google Drive folder.';
        }
      }
    }

    // 2. Decrypt local vault blobs unless Drive config replaced them
    this.localItems = [];
    const includeLocal = !this.driveConfig || this.driveConfig.includeLocalVault !== false;

    if (includeLocal && (vaultObj.entries || []).length > 0) {
      this.localItems = await Promise.all(
        vaultObj.entries.map(async (entry) => {
          const entryKeyRaw = await subtle.decrypt(
            { name: 'RSA-OAEP' },
            privateKey,
            fromBase64(entry.k)
          );
          const entryKey = await subtle.importKey(
            'raw',
            entryKeyRaw,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
          );
          const metaPlainBuf = await subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(entry.i) },
            entryKey,
            fromBase64(entry.m)
          );
          const meta = JSON.parse(new TextDecoder().decode(metaPlainBuf));
          return {
            ...meta,
            sourceType: 'local',
            blobFile: entry.b,
          };
        })
      );
    }

    this.rebuildCatalog();
    this.unlocked = true;
    return this.catalog;
  }

  rebuildCatalog() {
    const combined = [...this.driveItems, ...this.localItems];
    this.rawEntriesCount = combined.length;
    this.catalog = groupMediaItems(combined);
  }

  async refreshGoogleDrive() {
    if (!this.driveClient) return this.catalog;
    this.driveError = null;
    this.driveItems = await this.driveClient.listVideos();
    this.rebuildCatalog();
    return this.catalog;
  }

  /**
   * Tests live Google Drive connection, seals it with RSA-OAEP(vaultObj.pub) + AES-256-GCM,
   * AND saves it permanently (either directly to workspace assets/core.vlt or directly to GitHub repo!).
   */
  async connectAndPersistGoogleDrive(vaultObj, driveConfig, persistenceOpts = {}) {
    if (!this.unlocked) {
      throw new Error('Unlock the vault first.');
    }

    // 1. Verify Google Drive folder & API key / Service Account work right now
    const testClient = new GoogleDriveClient(driveConfig);
    const fetchedVideos = await testClient.listVideos();

    // 2. Encrypt driveConfig using vault's RSA-OAEP public key + AES-256-GCM
    const subtle = window.crypto.subtle;
    const publicKey = await subtle.importKey(
      'spki',
      fromBase64(vaultObj.pub),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );

    const gdKeyRaw = window.crypto.getRandomValues(new Uint8Array(32));
    const gdIv = window.crypto.getRandomValues(new Uint8Array(12));
    const gdKey = await subtle.importKey(
      'raw',
      gdKeyRaw,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const sealedDriveBuf = await subtle.encrypt(
      { name: 'AES-GCM', iv: gdIv },
      gdKey,
      new TextEncoder().encode(JSON.stringify(driveConfig))
    );

    const wrappedGdKeyBuf = await subtle.encrypt(
      { name: 'RSA-OAEP' },
      publicKey,
      gdKeyRaw
    );

    const updatedVault = {
      ...vaultObj,
      v: 3,
      entries: driveConfig.includeLocalVault ? vaultObj.entries || [] : [],
      gdrive: {
        k: toBase64(new Uint8Array(wrappedGdKeyBuf)),
        i: toBase64(gdIv),
        m: toBase64(new Uint8Array(sealedDriveBuf)),
      },
    };

    const packedBytes = packVaultBinary(updatedVault);
    let savedWhere = 'downloaded';

    // 3A. If local/preview writable server is active, write directly to assets/core.vlt on disk!
    if (persistenceOpts.localWritable) {
      const saveRes = await fetch('./__local_vault_save__', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coreVltBase64: toBase64(packedBytes),
          removeSampleBlobs: !driveConfig.includeLocalVault,
        }),
      });
      const saveJson = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok || !saveJson.ok) {
        throw new Error(saveJson.error || 'Failed to write assets/core.vlt on server.');
      }
      savedWhere = 'workspace';
    } else if (persistenceOpts.githubToken && persistenceOpts.githubRepo) {
      // 3B. On live GitHub Pages: commit directly to GitHub repo via GitHub REST API!
      await commitVaultToGitHubRepo({
        repoFullName: persistenceOpts.githubRepo,
        branch: persistenceOpts.githubBranch || 'main',
        token: persistenceOpts.githubToken,
        packedBytes,
      });
      savedWhere = 'github';
    }

    // 4. Activate live in the current session immediately
    this.driveConfig = driveConfig;
    this.driveClient = testClient;
    this.driveItems = fetchedVideos;
    this.driveError = null;
    if (!driveConfig.includeLocalVault) {
      this.localItems = [];
    }
    this.rebuildCatalog();

    return {
      packedBytes,
      updatedVault,
      videoCount: fetchedVideos.length,
      savedWhere,
    };
  }

  async getPlayableMp4(part, onProgress) {
    const cacheKey =
      part.sourceType === 'gdrive' ? `gd:${part.driveFileId}` : `loc:${part.blobFile}`;

    if (this.blobCache.has(cacheKey)) {
      const cached = this.blobCache.get(cacheKey);
      if (part.sourceType === 'gdrive' && cached.isDirectStream && this.driveClient) {
        await this.driveClient.syncServiceWorker();
      }
      onProgress?.(100, 'Ready');
      return cached;
    }

    if (this.inflight.has(cacheKey)) {
      const res = await this.inflight.get(cacheKey);
      onProgress?.(100, 'Ready');
      return res;
    }

    const promise = (async () => {
      if (part.sourceType === 'gdrive') {
        if (!this.driveClient) {
          throw new Error('Google Drive client is not initialized.');
        }
        const resolved = await this.driveClient.resolveStream(part, onProgress);
        if (!resolved.isDirectStream) {
          this.blobCache.set(cacheKey, resolved);
        }
        return resolved;
      }

      onProgress?.(4, 'Fetching encrypted blob...');
      const response = await fetch(`./assets/videos/${encodeURIComponent(part.blobFile)}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${part.blobFile} (HTTP ${response.status})`);
      }

      const contentLength = Number(response.headers.get('content-length')) || part.size || 0;
      let encryptedBytes;

      if (response.body && contentLength > 0) {
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          const pct = Math.min(86, Math.round((received / contentLength) * 84) + 4);
          onProgress?.(pct, 'Streaming encrypted chunks...');
        }
        encryptedBytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          encryptedBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        const ab = await response.arrayBuffer();
        encryptedBytes = new Uint8Array(ab);
        onProgress?.(85, 'Decrypting...');
      }

      if (encryptedBytes.byteLength < 28) {
        throw new Error(`Corrupted encrypted blob: ${part.blobFile}`);
      }

      onProgress?.(92, 'Restoring MP4 stream in RAM...');
      const fileIv = encryptedBytes.subarray(0, 12);
      const ciphertext = encryptedBytes.subarray(12);

      const fileKey = await window.crypto.subtle.importKey(
        'raw',
        fromBase64(part.key),
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      const mp4Buffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fileIv },
        fileKey,
        ciphertext
      );

      const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const entry = { url, downloadUrl: url, blob, size: mp4Buffer.byteLength };
      this.blobCache.set(cacheKey, entry);
      onProgress?.(100, 'MP4 Ready');
      return entry;
    })();

    this.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  async getDriveBlobFallback(part, onProgress) {
    if (part.sourceType !== 'gdrive' || !this.driveClient) {
      throw new Error('No fallback stream available.');
    }
    const cacheKey = `gd:${part.driveFileId}`;
    if (this.blobCache.has(cacheKey)) {
      const cached = this.blobCache.get(cacheKey);
      if (!cached.isDirectStream) return cached;
    }
    const blobEntry = await this.driveClient.fetchBlobOrDiagnose(part, onProgress);
    this.blobCache.set(cacheKey, blobEntry);
    return blobEntry;
  }

  lock() {
    if (this.driveClient) {
      this.driveClient.clearServiceWorkerAuth().catch(() => {});
    }
    for (const { url, isDirectStream } of this.blobCache.values()) {
      if (!isDirectStream && url) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
    this.blobCache.clear();
    this.inflight.clear();
    this.catalog = [];
    this.localItems = [];
    this.driveItems = [];
    this.driveConfig = null;
    this.driveClient = null;
    this.driveError = null;
    this.rawEntriesCount = 0;
    this.unlocked = false;
  }
}
