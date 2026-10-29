#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  subtle,
  getRandomValues,
  toBase64,
  fromBase64,
  loadVaultFile,
  saveVaultFile,
  deriveWrappingKey,
} from './vault-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const VAULT_PATH = path.join(ROOT_DIR, 'assets', 'core.vlt');
const PBKDF2_ITERATIONS = 310000;

async function main() {
  const newPasskey = process.argv[2];
  const oldPasskey = process.argv[3];

  if (!newPasskey) {
    console.error(
      'Usage:\n' +
        '  Initialize new vault : node .github/scripts/setup-passkey.mjs <NEW_PASSKEY>\n' +
        '  Rotate passkey       : node .github/scripts/setup-passkey.mjs <NEW_PASSKEY> <CURRENT_PASSKEY>'
    );
    process.exit(1);
  }

  let privateKeyBytes;
  let publicKeySpkiB64;
  let existingEntries = [];

  if (fs.existsSync(VAULT_PATH) && oldPasskey) {
    console.log('Rotating passkey on existing vault (keeping all encrypted videos intact)...');
    const currentVault = loadVaultFile(VAULT_PATH);
    const oldWrappingKey = await deriveWrappingKey(
      oldPasskey,
      fromBase64(currentVault.kdf.salt),
      currentVault.kdf.iter
    );
    try {
      const decryptedPriv = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(currentVault.kdf.iv) },
        oldWrappingKey,
        fromBase64(currentVault.wrappedPriv)
      );
      privateKeyBytes = new Uint8Array(decryptedPriv);
      publicKeySpkiB64 = currentVault.pub;
      existingEntries = currentVault.entries || [];
    } catch {
      console.error('Error: Current passkey is incorrect. Cannot unwrap private key.');
      process.exit(1);
    }
  } else {
    console.log('Generating fresh RSA-OAEP-2048 hybrid keypair...');
    const keyPair = await subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    );

    const spkiBuf = await subtle.exportKey('spki', keyPair.publicKey);
    const pkcs8Buf = await subtle.exportKey('pkcs8', keyPair.privateKey);
    publicKeySpkiB64 = toBase64(new Uint8Array(spkiBuf));
    privateKeyBytes = new Uint8Array(pkcs8Buf);
  }

  const salt = getRandomValues(new Uint8Array(16));
  const wrapIv = getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(newPasskey, salt, PBKDF2_ITERATIONS);

  const wrappedPrivBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv },
    wrappingKey,
    privateKeyBytes
  );

  const vaultObj = {
    v: 1,
    kdf: {
      salt: toBase64(salt),
      iv: toBase64(wrapIv),
      iter: PBKDF2_ITERATIONS,
    },
    wrappedPriv: toBase64(new Uint8Array(wrappedPrivBuf)),
    pub: publicKeySpkiB64,
    entries: existingEntries,
  };

  saveVaultFile(VAULT_PATH, vaultObj);
  console.log(`Vault initialized & sealed -> ${path.relative(ROOT_DIR, VAULT_PATH)}`);
  console.log(`Active encrypted media entries: ${existingEntries.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
