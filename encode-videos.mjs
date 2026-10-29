#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const VIDEOS_DIR = path.join(ROOT_DIR, 'assets', 'videos');
const VAULT_PATH = path.join(ROOT_DIR, 'assets', 'core.vlt');

const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ts|mpeg|mpg|ogv)$/i;

const NAME_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const EXT_FIRST = 'qvzxrknbdfjw';
const EXT_MID = '23456789';
const EXT_LAST = 'xkmpbwvqtjnz';

function randomChoice(alphabet) {
  const b = getRandomValues(new Uint8Array(1))[0];
  return alphabet[b % alphabet.length];
}

function generateWeirdFilename(existingSet) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let stem = '';
    const rand = getRandomValues(new Uint8Array(16));
    for (let i = 0; i < 16; i++) {
      stem += NAME_CHARS[rand[i] % NAME_CHARS.length];
    }
    const ext =
      randomChoice(EXT_FIRST) + randomChoice(EXT_MID) + randomChoice(EXT_LAST);
    const filename = `${stem}.${ext}`;
    if (!existingSet.has(filename)) {
      existingSet.add(filename);
      return filename;
    }
  }
  throw new Error('Could not generate unique random filename.');
}

function hasCommand(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Pure-JS MP4 box fallback parser (used only if ffprobe is not installed)
function parseMp4Fallback(buf) {
  let duration = 0;
  let width = 0;
  let height = 0;

  function scanBoxes(start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = Number(buf.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) break;

      if (type === 'moov' || type === 'trak' || type === 'mdia') {
        scanBoxes(offset + headerSize, offset + size);
      } else if (type === 'mvhd') {
        const v = buf[offset + headerSize];
        if (v === 0 && offset + headerSize + 20 <= end) {
          const timescale = buf.readUInt32BE(offset + headerSize + 12);
          const dur = buf.readUInt32BE(offset + headerSize + 16);
          if (timescale > 0) duration = dur / timescale;
        } else if (v === 1 && offset + headerSize + 28 <= end) {
          const timescale = buf.readUInt32BE(offset + headerSize + 20);
          const dur = Number(buf.readBigUInt64BE(offset + headerSize + 24));
          if (timescale > 0) duration = dur / timescale;
        }
      } else if (type === 'tkhd') {
        const v = buf[offset + headerSize];
        const wOffset = offset + headerSize + (v === 1 ? 88 : 76);
        if (wOffset + 8 <= offset + size) {
          const w = buf.readUInt32BE(wOffset) / 65536;
          const h = buf.readUInt32BE(wOffset + 4) / 65536;
          if (w > 0 && h > 0) {
            width = Math.round(w);
            height = Math.round(h);
          }
        }
      }
      offset += size;
    }
  }

  try {
    scanBoxes(0, buf.length);
  } catch {
    // ignore malformed atoms
  }
  return { duration, width, height };
}

function probeAndNormalizeVideo(inputPath, useFfmpeg, tmpDir) {
  if (!useFfmpeg) {
    const rawBuf = fs.readFileSync(inputPath);
    const info = parseMp4Fallback(rawBuf);
    return {
      mp4Bytes: new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength),
      duration: info.duration || 0,
      width: info.width || 1280,
      height: info.height || 720,
      poster: null,
    };
  }

  let duration = 0;
  let width = 1280;
  let height = 720;
  let videoCodec = '';
  let pixFmt = '';
  let audioCodec = '';

  try {
    const probeJson = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath,
      ],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(probeJson);
    duration = parseFloat(data.format?.duration || '0') || 0;
    const vStream = (data.streams || []).find((s) => s.codec_type === 'video');
    const aStream = (data.streams || []).find((s) => s.codec_type === 'audio');
    if (vStream) {
      width = vStream.width || 1280;
      height = vStream.height || 720;
      videoCodec = (vStream.codec_name || '').toLowerCase();
      pixFmt = (vStream.pix_fmt || '').toLowerCase();
      if (!duration && vStream.duration) {
        duration = parseFloat(vStream.duration) || 0;
      }
    }
    if (aStream) {
      audioCodec = (aStream.codec_name || '').toLowerCase();
    }
  } catch (err) {
    console.warn(`Warning: ffprobe failed on ${path.basename(inputPath)}:`, err.message);
  }

  const ext = path.extname(inputPath).toLowerCase();
  const isBrowserReadyMp4 =
    ext === '.mp4' &&
    videoCodec === 'h264' &&
    (pixFmt === 'yuv420p' || pixFmt === 'yuvj420p') &&
    (!audioCodec || audioCodec === 'aac' || audioCodec === 'mp3');

  const normalizedPath = path.join(
    tmpDir,
    `norm_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`
  );

  try {
    if (isBrowserReadyMp4) {
      // Lossless faststart remux for instant playback on Android & Windows
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-i',
          inputPath,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          normalizedPath,
        ],
        { stdio: 'pipe' }
      );
    } else {
      // Transcode non-standard formats (.mov, .mkv, .webm, HEVC, etc.) to universal H.264 + AAC MP4
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-i',
          inputPath,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          normalizedPath,
        ],
        { stdio: 'pipe' }
      );
    }
  } catch {
    // Fallback to raw copy if ffmpeg remux had an issue
    fs.copyFileSync(inputPath, normalizedPath);
  }

  // Extract encrypted thumbnail IN MEMORY (zero image files ever written to repo!)
  let poster = null;
  try {
    const seekSec = duration > 1.2 ? Math.min(duration * 0.48, 6.0) : 0;
    const thumbBuf = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        seekSec.toFixed(2),
        '-i',
        normalizedPath,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(480,iw)':-2",
        '-q:v',
        '5',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );
    if (thumbBuf && thumbBuf.length > 0) {
      poster = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
    }
  } catch {
    poster = null;
  }

  const finalBuf = fs.readFileSync(normalizedPath);
  fs.rmSync(normalizedPath, { force: true });

  return {
    mp4Bytes: new Uint8Array(finalBuf.buffer, finalBuf.byteOffset, finalBuf.byteLength),
    duration: Math.round(duration * 100) / 100,
    width,
    height,
    poster,
  };
}

function collectRawVideos(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...collectRawVideos(fullPath, baseDir));
    } else if (item.isFile() && VIDEO_EXT_RE.test(item.name)) {
      const relName = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      results.push({ fullPath, relName });
    }
  }
  return results.sort((a, b) => a.relName.localeCompare(b.relName));
}

function removeEmptySubdirs(dir, rootStop) {
  if (!fs.existsSync(dir) || dir === rootStop) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      removeEmptySubdirs(path.join(dir, item.name), rootStop);
    }
  }
  if (dir !== rootStop && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

async function main() {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const vault = loadVaultFile(VAULT_PATH);

  const publicKey = await subtle.importKey(
    'spki',
    fromBase64(vault.pub),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

  // 1. Prune entries whose transformed blob was deleted from assets/videos/
  const beforeCount = (vault.entries || []).length;
  vault.entries = (vault.entries || []).filter((entry) =>
    fs.existsSync(path.join(VIDEOS_DIR, entry.b))
  );
  const prunedCount = beforeCount - vault.entries.length;

  const existingFiles = new Set(fs.readdirSync(VIDEOS_DIR));
  const rawVideos = collectRawVideos(VIDEOS_DIR);

  if (rawVideos.length === 0 && prunedCount === 0) {
    console.log('No new raw video files found in assets/videos/ and no orphan blobs to prune.');
    return;
  }

  const useFfmpeg = hasCommand('ffmpeg') && hasCommand('ffprobe');
  console.log(
    `Found ${rawVideos.length} raw video(s) to transform | ffmpeg=${useFfmpeg} | pruned=${prunedCount}`
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-enc-'));

  try {
    for (const vid of rawVideos) {
      // Normalize extension to .mp4 in virtual metadata name since output inside site is MP4
      const normalizedOrigName = vid.relName.replace(VIDEO_EXT_RE, '.mp4');
      console.log(`Transforming: ${vid.relName} ...`);

      const { mp4Bytes, duration, width, height, poster } = probeAndNormalizeVideo(
        vid.fullPath,
        useFfmpeg,
        tmpDir
      );

      // Generate random AES-256-GCM key + 12B IV for the video payload
      const fileKeyRaw = getRandomValues(new Uint8Array(32));
      const fileIv = getRandomValues(new Uint8Array(12));
      const fileKey = await subtle.importKey(
        'raw',
        fileKeyRaw,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      const encryptedVideoBuf = await subtle.encrypt(
        { name: 'AES-GCM', iv: fileIv },
        fileKey,
        mp4Bytes
      );

      const encryptedVideoBytes = new Uint8Array(encryptedVideoBuf);
      const blobPayload = new Uint8Array(fileIv.length + encryptedVideoBytes.length);
      blobPayload.set(fileIv, 0);
      blobPayload.set(encryptedVideoBytes, fileIv.length);

      const weirdFilename = generateWeirdFilename(existingFiles);
      fs.writeFileSync(
        path.join(VIDEOS_DIR, weirdFilename),
        Buffer.from(blobPayload.buffer, blobPayload.byteOffset, blobPayload.byteLength)
      );

      // Seal metadata + fileKey + encrypted poster inside AES-256-GCM + RSA-OAEP envelope
      const entryMeta = {
        id: weirdFilename.split('.')[0],
        name: path.basename(normalizedOrigName),
        folder: path.dirname(normalizedOrigName) === '.' ? '' : path.dirname(normalizedOrigName),
        size: mp4Bytes.byteLength,
        duration,
        width,
        height,
        addedAt: Date.now(),
        key: toBase64(fileKeyRaw),
        poster,
      };

      const entryKeyRaw = getRandomValues(new Uint8Array(32));
      const metaIv = getRandomValues(new Uint8Array(12));
      const entryKey = await subtle.importKey(
        'raw',
        entryKeyRaw,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      const sealedMetaBuf = await subtle.encrypt(
        { name: 'AES-GCM', iv: metaIv },
        entryKey,
        new TextEncoder().encode(JSON.stringify(entryMeta))
      );

      const wrappedEntryKeyBuf = await subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        entryKeyRaw
      );

      vault.entries.push({
        b: weirdFilename,
        k: toBase64(new Uint8Array(wrappedEntryKeyBuf)),
        i: toBase64(metaIv),
        m: toBase64(new Uint8Array(sealedMetaBuf)),
      });

      // Delete the raw .mp4 file so GitHub only sees the unrecognizable blob!
      fs.unlinkSync(vid.fullPath);
      console.log(
        `  -> Sealed as assets/videos/${weirdFilename} (${(blobPayload.byteLength / 1024).toFixed(1)} KB, ${duration}s, ${width}x${height})`
      );
    }

    // Clean up any empty subdirectories left behind in assets/videos/
    for (const item of fs.readdirSync(VIDEOS_DIR, { withFileTypes: true })) {
      if (item.isDirectory()) {
        removeEmptySubdirs(path.join(VIDEOS_DIR, item.name), VIDEOS_DIR);
      }
    }

    // Ensure .gitkeep exists so empty assets/videos/ folder always stays tracked in git
    const gitkeepPath = path.join(VIDEOS_DIR, '.gitkeep');
    if (!fs.existsSync(gitkeepPath)) {
      fs.writeFileSync(gitkeepPath, '');
    }

    saveVaultFile(VAULT_PATH, vault);
    console.log(
      `Success! Vault updated (${vault.entries.length} total encrypted video streams).`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
