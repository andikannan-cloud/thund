#!/usr/bin/env node
/**
 * Zero-Knowledge Google Drive Vault Sealer (.github/scripts/setup-gdrive.mjs)
 * Encrypts your Google Drive folder ID + API key (or Service Account JSON) into assets/core.vlt
 * using the vault's RSA-OAEP-2048 public key + AES-256-GCM.
 *
 * Notice: Does NOT even need your secret passkey (2690) to seal — only someone entering
 * your passkey on the website can unwrap the RSA private key to read it!
 */
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
} from './vault-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const VAULT_PATH = path.join(ROOT_DIR, 'assets', 'core.vlt');
const VIDEOS_DIR = path.join(ROOT_DIR, 'assets', 'videos');

function extractFolderId(raw) {
  const s = String(raw || '').trim();
  const m1 = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m2) return m2[1];
  return s;
}

function parseArgs(argv) {
  const out = {
    folder: process.env.GDRIVE_FOLDER || '',
    apiKey: process.env.GDRIVE_API_KEY || '',
    serviceAccountJson: process.env.GDRIVE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountPath: '',
    keepLocal: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--folder') out.folder = argv[++i];
    else if (arg === '--api-key') out.apiKey = argv[++i];
    else if (arg === '--service-account') out.serviceAccountPath = argv[++i];
    else if (arg === '--keep-local') out.keepLocal = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (
    !args.folder ||
    (!args.apiKey && !args.serviceAccountPath && !args.serviceAccountJson)
  ) {
    console.error(
      'Usage (Option 1 — Shared Folder Link + API Key):\n' +
        '  node .github/scripts/setup-gdrive.mjs --folder "<DRIVE_FOLDER_URL_OR_ID>" --api-key "<GOOGLE_API_KEY>"\n\n' +
        'Usage (Option 2 — Private Folder + Service Account JSON):\n' +
        '  node .github/scripts/setup-gdrive.mjs --folder "<DRIVE_FOLDER_URL_OR_ID>" --service-account ./service-account.json\n'
    );
    process.exit(1);
  }

  const vaultObj = loadVaultFile(VAULT_PATH);
  const publicKey = await subtle.importKey(
    'spki',
    fromBase64(vaultObj.pub),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

  const folderId = extractFolderId(args.folder);
  let driveConfig;

  if (args.serviceAccountPath || args.serviceAccountJson) {
    const rawJson = args.serviceAccountPath
      ? fs.readFileSync(args.serviceAccountPath, 'utf8')
      : args.serviceAccountJson;
    const sa = JSON.parse(rawJson);
    if (!sa.client_email || !sa.private_key) {
      throw new Error('Service Account JSON must contain client_email and private_key.');
    }
    driveConfig = {
      mode: 'service_account',
      folderId,
      clientEmail: sa.client_email,
      privateKeyPem: sa.private_key,
      tokenUri: sa.token_uri || 'https://oauth2.googleapis.com/token',
      includeLocalVault: args.keepLocal,
    };
  } else {
    driveConfig = {
      mode: 'apikey',
      folderId,
      apiKey: args.apiKey.trim(),
      includeLocalVault: args.keepLocal,
    };
  }

  // Seal driveConfig with AES-256-GCM + RSA-OAEP(publicKey)
  const gdKeyRaw = getRandomValues(new Uint8Array(32));
  const gdIv = getRandomValues(new Uint8Array(12));
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

  vaultObj.v = 3;
  vaultObj.gdrive = {
    k: toBase64(new Uint8Array(wrappedGdKeyBuf)),
    i: toBase64(gdIv),
    m: toBase64(new Uint8Array(sealedDriveBuf)),
  };

  if (!args.keepLocal) {
    vaultObj.entries = [];
    if (fs.existsSync(VIDEOS_DIR)) {
      for (const f of fs.readdirSync(VIDEOS_DIR)) {
        if (f === '.gitkeep') continue;
        const fp = path.join(VIDEOS_DIR, f);
        if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
      }
    }
  }

  saveVaultFile(VAULT_PATH, vaultObj);
  console.log('Google Drive permanently sealed into assets/core.vlt!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
