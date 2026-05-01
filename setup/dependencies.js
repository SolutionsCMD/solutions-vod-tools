// First-run setup: download yt-dlp.exe and the ffmpeg essentials build
// into the user's binDir. Idempotent — does nothing if all three are present.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const YTDLP_URL  = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

/**
 * Ensure yt-dlp.exe, ffmpeg.exe, ffprobe.exe exist in binDir.
 * Calls onSetupNeeded() the first time it has to download anything,
 * so the caller can pop a setup window. Calls onProgress({stage,message,percent})
 * as work proceeds.
 */
async function ensureBinaries(binDir, onProgress = () => {}, onSetupNeeded = () => {}) {
  if (process.platform !== 'win32') {
    // Non-Windows: assume system PATH yt-dlp / ffmpeg. server.js falls back to PATH.
    return;
  }
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  const ytdlp   = path.join(binDir, 'yt-dlp.exe');
  const ffmpeg  = path.join(binDir, 'ffmpeg.exe');
  const ffprobe = path.join(binDir, 'ffprobe.exe');

  const needYtdlp  = !fs.existsSync(ytdlp);
  const needFfmpeg = !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe);

  if (!needYtdlp && !needFfmpeg) return;

  onSetupNeeded();
  // Yield so the setup window can paint before we start hammering the network.
  await sleep(50);

  if (needYtdlp) {
    onProgress({ stage: 'yt-dlp', message: 'Downloading yt-dlp...', percent: 0 });
    await downloadFile(YTDLP_URL, ytdlp, (pct) => {
      onProgress({ stage: 'yt-dlp', message: `Downloading yt-dlp... ${pct}%`, percent: pct });
    });
    onProgress({ stage: 'yt-dlp', message: 'yt-dlp installed', percent: 100 });
  }

  if (needFfmpeg) {
    const tmpZip     = path.join(binDir, '_ffmpeg.zip');
    const extractDir = path.join(binDir, '_ffmpeg-extract');

    onProgress({ stage: 'ffmpeg', message: 'Downloading ffmpeg (~40 MB)...', percent: 0 });
    await downloadFile(FFMPEG_URL, tmpZip, (pct) => {
      onProgress({ stage: 'ffmpeg', message: `Downloading ffmpeg... ${pct}%`, percent: pct });
    });

    onProgress({ stage: 'ffmpeg', message: 'Extracting ffmpeg...', percent: null });

    // Use PowerShell's Expand-Archive — present on every Windows 10+.
    // -NoProfile keeps it fast; we don't care about user PS profiles loading.
    const r = spawnSync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -Path '${tmpZip.replace(/'/g, "''")}' ` +
      `-DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true });
    if (r.status !== 0) {
      cleanup(tmpZip, extractDir);
      throw new Error('Failed to extract ffmpeg zip');
    }

    const foundFfmpeg  = findFile(extractDir, 'ffmpeg.exe');
    const foundFfprobe = findFile(extractDir, 'ffprobe.exe');
    if (!foundFfmpeg || !foundFfprobe) {
      cleanup(tmpZip, extractDir);
      throw new Error('ffmpeg.exe / ffprobe.exe not found in archive');
    }

    fs.copyFileSync(foundFfmpeg, ffmpeg);
    fs.copyFileSync(foundFfprobe, ffprobe);

    cleanup(tmpZip, extractDir);
    onProgress({ stage: 'ffmpeg', message: 'ffmpeg installed', percent: 100 });
  }

  onProgress({ stage: 'done', message: 'All set!', percent: 100 });
}

// -------- helpers --------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function downloadFile(url, dest, onPercent) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let received = 0;
    let total = 0;
    let lastReportedPct = -1;

    const get = (u, redirects = 0) => {
      if (redirects > 10) { reject(new Error('Too many redirects')); return; }
      https.get(u, { headers: { 'User-Agent': 'Solutions-VOD-Tools' } }, (res) => {
        // Follow 301 / 302 / 307 / 308 redirects (GitHub release URLs always redirect)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastReportedPct) {
              lastReportedPct = pct;
              try { onPercent && onPercent(pct); } catch (e) { /* ignore */ }
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
        file.on('error', (err) => { try { fs.unlinkSync(dest); } catch (e) {} reject(err); });
      }).on('error', reject);
    };

    get(url);
  });
}

function findFile(rootDir, basename) {
  if (!fs.existsSync(rootDir)) return null;
  const target = basename.toLowerCase();
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.toLowerCase() === target) return p;
    }
  }
  return null;
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
  }
}

module.exports = { ensureBinaries };
