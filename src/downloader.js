import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import cliProgress from 'cli-progress';
import { log, sanitizeName, inferExtension, retry } from './utils.js';
import { STORAGE_STATE_PATH } from './auth.js';

const DOWNLOADS_DIR = path.resolve('downloads');

// Build a Cookie header string from storageState.json, filtered by domain
function buildCookieHeader(targetHostname) {
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
    const now = Date.now() / 1000;
    return (state.cookies || [])
      .filter((c) => {
        if (c.expires > 0 && c.expires < now) return false;
        const cd = c.domain.replace(/^\./, '');
        return targetHostname === cd || targetHostname.endsWith('.' + cd);
      })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

export async function downloadFile(
  { url, courseName, chapterName, title },
  { retryCount = 3, onProgress, signal } = {},
) {
  const dir = path.join(DOWNLOADS_DIR, sanitizeName(courseName), sanitizeName(chapterName));
  fs.mkdirSync(dir, { recursive: true });

  const ext = inferExtension(url, '.bin');
  const sanitized = sanitizeName(title);
  const filename = sanitized.toLowerCase().endsWith(ext.toLowerCase()) ? sanitized : sanitized + ext;
  const filePath = path.join(dir, filename);

  const hostname = new URL(url).hostname;
  const cookie = buildCookieHeader(hostname);
  const baseHeaders = cookie ? { Cookie: cookie } : {};

  // HEAD: get remote size + check Range support
  let remoteSize = 0;
  let acceptRanges = false;
  try {
    const headRes = await fetch(url, { method: 'HEAD', headers: baseHeaders, signal });
    if (headRes.ok) {
      remoteSize = parseInt(headRes.headers.get('content-length') || '0', 10);
      acceptRanges = (headRes.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }

  // Already-complete file → skip
  if (fs.existsSync(filePath)) {
    const localSize = fs.statSync(filePath).size;
    if (remoteSize > 0 && localSize === remoteSize) {
      log.skip(filename);
      onProgress?.({ event: 'skip', filename, size: localSize, reason: 'already downloaded' });
      return;
    }
    if (remoteSize === 0 && localSize > 0) {
      log.skip(`${filename} (exists; remote size unknown)`);
      onProgress?.({ event: 'skip', filename, size: localSize, reason: 'exists (size unknown)' });
      return;
    }
  }

  const existingSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const canResume = remoteSize > 0 && existingSize > 0 && existingSize < remoteSize && acceptRanges;

  const sizeMb = remoteSize ? ` (${(remoteSize / 1024 / 1024).toFixed(1)} MB)` : '';
  log.info(`${canResume ? '↻' : '↓'}  ${filename}${sizeMb}${canResume ? ` (从 ${(existingSize / 1024 / 1024).toFixed(1)} MB 续传)` : ''}`);

  const doDownload = async () => {
    let startByte = 0;
    let writeFlags = 'w';
    let fetchHeaders = { ...baseHeaders };

    // Try resume if we have a partial file
    if (canResume) {
      fetchHeaders.Range = `bytes=${existingSize}-`;
    }

    let res = await fetch(url, { headers: fetchHeaders, signal });
    if (canResume && res.status === 206) {
      // Server honored the Range request
      startByte = existingSize;
      writeFlags = 'a';
    } else if (canResume && res.status === 200) {
      // Server ignored Range — restart from 0
      log.warn(`  服务器忽略 Range 请求，将重新下载 ${filename}`);
      try { fs.unlinkSync(filePath); } catch {}
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const totalBytes = remoteSize || (parseInt(res.headers.get('content-length') || '0', 10) + startByte) || 1;
    onProgress?.({ event: 'start', filename, total: totalBytes, resumed: writeFlags === 'a' });

    const bar = onProgress
      ? null
      : new cliProgress.SingleBar(
          { format: '   {bar} {percentage}% | {value}/{total} B', clearOnComplete: true },
          cliProgress.Presets.shades_classic,
        );
    if (bar) bar.start(totalBytes, startByte);

    const writer = createWriteStream(filePath, { flags: writeFlags });
    let downloaded = startByte;

    try {
      for await (const chunk of res.body) {
        // honor cancellation between chunks
        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        writer.write(chunk);
        downloaded += chunk.length;
        if (bar) bar.update(downloaded);
        onProgress?.({ event: 'progress', filename, downloaded, total: totalBytes });
      }
      await new Promise((resolve, reject) => {
        writer.end();
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      if (bar) bar.stop();
      log.ok(`  ${filename}`);
      onProgress?.({ event: 'done', filename, size: downloaded });
    } catch (err) {
      if (bar) bar.stop();
      writer.destroy();
      // On abort: keep partial file for future resume
      if (err.name === 'AbortError' || signal?.aborted) {
        onProgress?.({ event: 'paused', filename, downloaded, total: totalBytes });
        throw err;
      }
      // Real error: drop the broken file so next retry starts clean
      try { fs.unlinkSync(filePath); } catch {}
      throw err;
    }
  };

  try {
    await retry(doDownload, { maxAttempts: retryCount, baseDelay: 2000 });
  } catch (err) {
    if (err.name === 'AbortError') throw err; // bubble up; don't log as error
    log.err(`  ${filename}: ${err.message} (after ${retryCount} attempts)`);
    onProgress?.({ event: 'error', filename, error: err.message });
  }
}
