/**
 * CipherStream Vault Crypto Engine
 * - Unpacks opaque binary core.vlt
 * - Derives AES-256-GCM wrapping key via PBKDF2-SHA256 (310,000 iterations)
 * - Unwraps RSA-OAEP-2048 private key in RAM only
 * - Unseals per-video metadata + thumbnails + symmetric file keys
 * - Decrypts obfuscated random blobs back into playable video/mp4 Blobs in memory
 * - Groups multi-part videos (e.g. something_00.mp4, something_01.mp4) automatically
 */

const MAGIC = [0x89, 0x56, 0x4c, 0x54]; // \x89VLT
const MASK_LEN = 32;

export class InvalidPasskeyError extends Error {
  constructor(message = 'Incorrect passkey. Decryption failed.') {
    super(message);
    this.name = 'InvalidPasskeyError';
  }
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
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

async function deriveWrappingKey(passkey, saltBytes, iterations) {
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
    ['decrypt']
  );
}

export function prettifyTitle(rawStem) {
  return rawStem
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Groups items sharing naming patterns like:
 *   something_00.mp4, something_01.mp4, something_02.mp4
 *   clip-1.mp4, clip-2.mp4
 *   series_part01.mp4, series_part02.mp4
 * Standalone files (or singletons where only 1 matching file exists) remain single videos.
 */
export function groupMediaItems(rawItems) {
  // Deduplicate exact same (folder + name) keeping the newest upload
  const dedupMap = new Map();
  for (const item of rawItems) {
    const fullKey = `${item.folder || ''}/${item.name}`.toLowerCase();
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
      // Multi-part grouped video!
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

      // Pick any valid poster template for the single group card
      const coverPart = parts.find((p) => p.poster) || parts[0];
      const totalDuration = parts.reduce((acc, p) => acc + (p.duration || 0), 0);
      const totalSize = parts.reduce((acc, p) => acc + (p.size || 0), 0);
      const latestAdded = Math.max(...parts.map((p) => p.addedAt || 0));

      catalog.push({
        id: `grp_${bucketKey.replace(/[^a-z0-9]+/gi, '_')}`,
        isGroup: true,
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
      // Only 1 file matched trailing number — treat as standalone single video
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

  // Sort: multi-part groups first or alphabetical/recent cleanly (groups highlighted, then alphabetical)
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
    this.blobCache = new Map(); // blobFile -> { url, blob }
    this.inflight = new Map(); // blobFile -> Promise
  }

  async unlock(vaultObj, passkey) {
    const subtle = window.crypto?.subtle;
    if (!subtle) {
      throw new Error('Secure context (HTTPS / localhost) required for WebCrypto.');
    }

    const wrappingKey = await deriveWrappingKey(
      passkey,
      fromBase64(vaultObj.kdf.salt),
      vaultObj.kdf.iter
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

    const entries = vaultObj.entries || [];
    const decryptedItems = await Promise.all(
      entries.map(async (entry) => {
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
          blobFile: entry.b,
        };
      })
    );

    this.rawEntriesCount = decryptedItems.length;
    this.catalog = groupMediaItems(decryptedItems);
    this.unlocked = true;
    return this.catalog;
  }

  /**
   * Fetches the obfuscated file from ./assets/videos/<blobFile>,
   * decrypts AES-256-GCM in RAM, and returns a playable video/mp4 ObjectURL.
   */
  async getPlayableMp4(part, onProgress) {
    if (this.blobCache.has(part.blobFile)) {
      onProgress?.(100, 'Ready');
      return this.blobCache.get(part.blobFile);
    }

    if (this.inflight.has(part.blobFile)) {
      const res = await this.inflight.get(part.blobFile);
      onProgress?.(100, 'Ready');
      return res;
    }

    const promise = (async () => {
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
      const entry = { url, blob, size: mp4Buffer.byteLength };
      this.blobCache.set(part.blobFile, entry);
      onProgress?.(100, 'MP4 Ready');
      return entry;
    })();

    this.inflight.set(part.blobFile, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(part.blobFile);
    }
  }

  lock() {
    for (const { url } of this.blobCache.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.blobCache.clear();
    this.inflight.clear();
    this.catalog = [];
    this.rawEntriesCount = 0;
    this.unlocked = false;
  }
}
