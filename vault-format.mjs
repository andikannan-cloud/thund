import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const subtle = webcrypto.subtle;
export const getRandomValues = (buf) => webcrypto.getRandomValues(buf);

// Non-ASCII binary magic header so GitHub treats core.vlt as an opaque binary blob
const MAGIC = new Uint8Array([0x89, 0x56, 0x4c, 0x54]); // \x89VLT
const MASK_LEN = 32;

export function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function packVaultBinary(vaultObj) {
  const jsonBytes = new Uint8Array(Buffer.from(JSON.stringify(vaultObj), 'utf8'));
  const mask = getRandomValues(new Uint8Array(MASK_LEN));
  const out = new Uint8Array(MAGIC.length + MASK_LEN + jsonBytes.length);
  out.set(MAGIC, 0);
  out.set(mask, MAGIC.length);
  const offset = MAGIC.length + MASK_LEN;
  for (let i = 0; i < jsonBytes.length; i++) {
    out[offset + i] = jsonBytes[i] ^ mask[i % MASK_LEN];
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export function unpackVaultBinary(buffer) {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (
    bytes.length < MAGIC.length + MASK_LEN ||
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new Error('Invalid or corrupted vault core binary (core.vlt).');
  }
  const mask = bytes.subarray(MAGIC.length, MAGIC.length + MASK_LEN);
  const payload = bytes.subarray(MAGIC.length + MASK_LEN);
  const plain = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    plain[i] = payload[i] ^ mask[i % MASK_LEN];
  }
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}

export function loadVaultFile(vaultPath) {
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`Vault index not found at ${vaultPath}. Run setup-passkey.mjs first.`);
  }
  return unpackVaultBinary(fs.readFileSync(vaultPath));
}

export function saveVaultFile(vaultPath, vaultObj) {
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  fs.writeFileSync(vaultPath, packVaultBinary(vaultObj));
}

export async function deriveWrappingKey(passkey, saltBytes, iterations = 310000) {
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
    ['encrypt', 'decrypt']
  );
}
