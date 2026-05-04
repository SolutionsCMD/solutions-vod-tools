const express = require('express');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PLATFORMS, getPlatform, watcherKey, parseWatcherKey } = require('./platforms');
const quality = require('./quality');
const { makeStore: makeSettingsStore } = require('./settings');
const { startChatCapture, normalizeVodChat, platformFromUrl } = require('./chat');

/**
 * Boot the Express server in-process.
 *
 * @param {object} options
 * @param {number} [options.port=3847]
 * @param {string} options.outputDir   - where VOD subfolders go (e.g. ~/Videos/Solutions VOD Tools)
 * @param {string} options.binDir      - where yt-dlp.exe / ffmpeg.exe / ffprobe.exe live
 * @param {string} options.stateFile   - path to live-watchers.json
 * @param {string} options.publicDir   - path to the static UI files
 * @returns {Promise<{httpServer, shutdown}>}
 */
function createServer(options = {}) {
  const PORT = options.port || 3847;
  const DEFAULT_OUTPUT = options.outputDir || path.join(__dirname, 'vods');
  const BIN_DIR = options.binDir || path.join(__dirname, 'bin');
  const PUBLIC_DIR = options.publicDir || path.join(__dirname, '..', 'public');

  if (!fs.existsSync(DEFAULT_OUTPUT)) fs.mkdirSync(DEFAULT_OUTPUT, { recursive: true });
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const SETTINGS_FILE = options.settingsFile || path.join(__dirname, 'app-settings.json');
  const settings = makeSettingsStore(SETTINGS_FILE);

  const app = express();

  function resolveBinary(cmd) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const local = path.join(BIN_DIR, cmd + ext);
    if (fs.existsSync(local)) return local;
    return cmd;
  }
  const YTDLP = resolveBinary('yt-dlp');
  const FFMPEG = resolveBinary('ffmpeg');
  const FFPROBE = resolveBinary('ffprobe');

  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(PUBLIC_DIR));

// Track running jobs so we can cancel
const runningJobs = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeLine(res, line) {
  res.write(line.endsWith('\n') ? line : line + '\n');
}

function streamProcess(proc, res, label) {
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', d => res.write(d));
    proc.stderr.on('data', d => res.write(d));
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

// -------- Download (with optional section) --------
app.post('/api/download', async (req, res) => {
  const { url, startTime, endTime, outputDir, qualityPreset, customFormat, includeChatReplay } = req.body;

  if (!url) {
    res.status(400).json({ error: 'URL required' });
    return;
  }

  const targetDir = outputDir && outputDir.trim() ? outputDir.trim() : DEFAULT_OUTPUT;
  ensureDir(targetDir);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const jobId = 'job_' + Date.now();
  writeLine(res, `[job] ${jobId}`);
  writeLine(res, `[status] starting`);
  writeLine(res, `[info] Output folder: ${targetDir}`);
  writeLine(res, `[info] URL: ${url}`);

  const start = (startTime && startTime.trim()) || null;
  const end = (endTime && endTime.trim()) || null;
  const hasSection = start || end;

  const formatStr = quality.resolveFormat(
    { preset: qualityPreset, custom: customFormat },
    settings.get().qualityDefault,
  );
  writeLine(res, `[info] Format: ${formatStr}`);

  // Decide whether to pull chat replay. The setting is the global default;
  // includeChatReplay in the request is the per-job override (true/false/undef).
  const wantChat = includeChatReplay === undefined
    ? !!settings.get().chatVodReplayEnabled
    : !!includeChatReplay;
  const urlPlatform = platformFromUrl(url);
  // Only Twitch + YouTube have documented VOD chat we can pull.
  const captureChat = wantChat && (urlPlatform === 'twitch' || urlPlatform === 'youtube');

  const ytArgs = [
    '-f', formatStr,
    '--hls-prefer-native',
    '-N', '16',
    '--merge-output-format', 'mp4',
    '--write-info-json',
    '--newline',
    '-o', '%(uploader)s - %(title)s [%(upload_date)s]/%(uploader)s - %(title)s [%(upload_date)s].%(ext)s',
    '--download-archive', path.join(targetDir, 'archive.txt'),
    '-P', targetDir,
  ];

  if (captureChat) {
    if (urlPlatform === 'twitch') {
      // --write-comments triggers Twitch GQL chat replay download into info.json.
      // Slow on long VODs (paginates), but we already have --write-info-json.
      ytArgs.push('--write-comments');
      writeLine(res, `[info] Chat replay: enabled (Twitch comments)`);
    } else if (urlPlatform === 'youtube') {
      // YouTube live broadcasts that have replay keep the chat as a sub track.
      ytArgs.push('--write-subs', '--sub-langs', 'live_chat');
      writeLine(res, `[info] Chat replay: enabled (YouTube live_chat)`);
    }
  } else if (wantChat && urlPlatform === 'kick') {
    writeLine(res, `[info] Chat replay: skipped (no VOD chat endpoint for Kick)`);
  }

  if (hasSection) {
    const startStr = start || '0';
    const endStr = end || 'inf';
    ytArgs.push('--download-sections', `*${startStr}-${endStr}`);
    writeLine(res, `[info] Section: ${startStr} to ${endStr} (partial download)`);
  }

  ytArgs.push(url);

  writeLine(res, `[status] downloading`);
  writeLine(res, `[cmd] ${path.basename(YTDLP)} ${ytArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  let finalFilePath = null;
  const yt = spawn(YTDLP, ytArgs, { windowsHide: true });
  runningJobs.set(jobId, yt);

  let stdoutBuf = '';
  yt.stdout.on('data', d => {
    const text = d.toString();
    stdoutBuf += text;
    res.write(text);
    const lines = stdoutBuf.split(/\r\n|[\r\n]/);
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      const merger = line.match(/\[Merger\] Merging formats into "([^"]+)"/);
      if (merger) {
        finalFilePath = merger[1];
        continue;
      }
      const dest = line.match(/\[download\] Destination: (.+\.mp4)\s*$/);
      if (dest) {
        finalFilePath = dest[1].trim();
      }
      const already = line.match(/\[download\] (.+\.mp4) has already been downloaded/);
      if (already) {
        finalFilePath = already[1].trim();
      }
    }
  });

  try {
    await new Promise((resolve, reject) => {
      yt.stderr.on('data', d => res.write(d));
      yt.on('error', reject);
      yt.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exited with code ${code}`));
      });
    });
  } catch (err) {
    runningJobs.delete(jobId);
    writeLine(res, `\n[status] error`);
    writeLine(res, `[error] ${err.message}`);
    res.end();
    return;
  }

  runningJobs.delete(jobId);

  if (!finalFilePath || !fs.existsSync(finalFilePath)) {
    try {
      const candidates = [];
      const scan = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) scan(p);
          else if (entry.name.endsWith('.mp4')) {
            candidates.push({ path: p, mtime: fs.statSync(p).mtimeMs });
          }
        }
      };
      scan(targetDir);
      candidates.sort((a, b) => b.mtime - a.mtime);
      if (candidates.length > 0) finalFilePath = candidates[0].path;
    } catch (err) { /* ignore */ }
  }

  if (!finalFilePath) {
    writeLine(res, `\n[warn] Could not determine downloaded file path.`);
  } else {
    writeLine(res, `\n[file] ${finalFilePath}`);
  }

  // Normalize VOD chat into chat.jsonl alongside the video.
  if (captureChat && finalFilePath) {
    try {
      const dir = path.dirname(finalFilePath);
      const base = path.basename(finalFilePath, path.extname(finalFilePath));
      // yt-dlp writes companion files using the SAME stem as the video.
      const infoJson = path.join(dir, base + '.info.json');
      const liveChat = path.join(dir, base + '.live_chat.json');
      const outFile  = path.join(dir, 'chat.jsonl');
      const count = normalizeVodChat({
        platform: urlPlatform,
        infoJsonPath: fs.existsSync(infoJson) ? infoJson : null,
        liveChatPath: fs.existsSync(liveChat) ? liveChat : null,
        outFile,
      }, (msg) => writeLine(res, msg));
      if (count > 0) writeLine(res, `[info] Wrote ${count} chat messages to ${outFile}`);
      else writeLine(res, `[info] No chat messages found in download artifacts`);
    } catch (err) {
      writeLine(res, `[warn] Chat normalize failed: ${err.message}`);
    }
  }

  writeLine(res, `\n[status] done`);
  res.end();
});

// -------- Stitch parts --------
app.post('/api/stitch', async (req, res) => {
  const { folder, files, outputName } = req.body;

  if (!Array.isArray(files) || files.length < 2) {
    res.status(400).json({ error: 'Need at least 2 files' });
    return;
  }

  const workDir = folder && folder.trim() ? folder.trim() : DEFAULT_OUTPUT;
  const outName = (outputName && outputName.trim()) || 'stitched.mp4';
  const outPath = path.isAbsolute(outName) ? outName : path.join(workDir, outName);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.flushHeaders();

  const jobId = 'stitch_' + Date.now();
  writeLine(res, `[job] ${jobId}`);
  writeLine(res, `[status] starting`);
  writeLine(res, `[info] Working folder: ${workDir}`);

  // Resolve each filename to an absolute path and verify it exists
  const absolutePaths = [];
  for (const f of files) {
    const candidate = path.isAbsolute(f) ? f : path.join(workDir, f);
    if (!fs.existsSync(candidate)) {
      writeLine(res, `[status] error`);
      writeLine(res, `[error] File not found: ${candidate}`);
      res.end();
      return;
    }
    absolutePaths.push(candidate);
    writeLine(res, `[info] Part: ${candidate}`);
  }

  // Write concat list with escaped paths
  const listPath = path.join(workDir, `concat-list-${Date.now()}.txt`);
  const listContent = absolutePaths
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent, 'utf8');
  writeLine(res, `[info] Wrote concat list: ${listPath}`);

  writeLine(res, `[status] stitching`);
  writeLine(res, `[info] Output: ${outPath}`);

  const ffArgs = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-fflags', '+genpts',
    '-i', listPath,
    '-c', 'copy',
    outPath,
  ];
  writeLine(res, `[cmd] ${path.basename(FFMPEG)} ${ffArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  const ff = spawn(FFMPEG, ffArgs, { windowsHide: true });
  runningJobs.set(jobId, ff);

  try {
    await streamProcess(ff, res, 'ffmpeg');
    runningJobs.delete(jobId);
    try { fs.unlinkSync(listPath); } catch (e) { /* ignore */ }
    writeLine(res, `\n[file] ${outPath}`);
    writeLine(res, `[status] done`);
  } catch (err) {
    runningJobs.delete(jobId);
    writeLine(res, `\n[status] error`);
    writeLine(res, `[error] ${err.message}`);
  }

  res.end();
});

// -------- Cancel a running job --------
app.post('/api/cancel', (req, res) => {
  let killed = 0;
  for (const [id, proc] of runningJobs.entries()) {
    try {
      // On Windows, need tree-kill behavior — spawn taskkill
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', proc.pid, '/f', '/t'], { windowsHide: true });
      } else {
        proc.kill('SIGTERM');
      }
      killed++;
    } catch (e) { /* ignore */ }
    runningJobs.delete(id);
  }
  res.json({ killed });
});

// -------- List VOD folders --------
function getFolderSize(folderPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(folderPath, e.name);
      if (e.isDirectory()) size += getFolderSize(p);
      else {
        try { size += fs.statSync(p).size; } catch (err) { /* ignore */ }
      }
    }
  } catch (err) { /* ignore */ }
  return size;
}

function listVods() {
  if (!fs.existsSync(DEFAULT_OUTPUT)) return [];
  const entries = fs.readdirSync(DEFAULT_OUTPUT, { withFileTypes: true })
    .filter(e => e.isDirectory());

  const vods = entries.map(e => {
    const folderPath = path.join(DEFAULT_OUTPUT, e.name);
    let mtime;
    try { mtime = fs.statSync(folderPath).mtime; } catch (err) { mtime = new Date(0); }
    return {
      name: e.name,
      path: folderPath,
      mtime: mtime.toISOString(),
      mtimeMs: mtime.getTime(),
      sizeBytes: getFolderSize(folderPath),
    };
  });

  vods.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return vods;
}

app.get('/api/vods', (req, res) => {
  const vods = listVods();
  const totalBytes = vods.reduce((sum, v) => sum + v.sizeBytes, 0);
  res.json({ vods, totalBytes, folder: DEFAULT_OUTPUT });
});

app.post('/api/cleanup', async (req, res) => {
  const { keepCount, alsoResetArchive } = req.body;
  if (typeof keepCount !== 'number' || keepCount < 0) {
    res.status(400).json({ error: 'keepCount must be a non-negative number' });
    return;
  }

  const vods = listVods();
  const toDelete = vods.slice(keepCount);
  const deleted = [];
  const failed = [];
  let freedBytes = 0;
  let killedProcesses = false;

  const tryDelete = async (folderPath) => {
    try {
      await fs.promises.rm(folderPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      return err;
    }
  };

  for (const v of toDelete) {
    let result = await tryDelete(v.path);
    if (result === true) {
      deleted.push(v.name);
      freedBytes += v.sizeBytes;
      continue;
    }

    // Delete failed. On Windows this is usually because of a stuck yt-dlp.exe
    // or ffmpeg.exe holding file handles. Kill them and retry once.
    if (!killedProcesses && process.platform === 'win32' &&
        (result.code === 'EBUSY' || result.code === 'EPERM' || result.code === 'ENOTEMPTY')) {
      const { spawnSync } = require('child_process');
      spawnSync('taskkill', ['/f', '/im', 'yt-dlp.exe'], { windowsHide: true });
      spawnSync('taskkill', ['/f', '/im', 'ffmpeg.exe'], { windowsHide: true });
      killedProcesses = true;
      await new Promise(r => setTimeout(r, 1500));

      result = await tryDelete(v.path);
      if (result === true) {
        deleted.push(v.name);
        freedBytes += v.sizeBytes;
        continue;
      }
    }

    failed.push({ name: v.name, error: result.message || String(result) });
  }

  if (alsoResetArchive) {
    const archivePath = path.join(DEFAULT_OUTPUT, 'archive.txt');
    try { fs.unlinkSync(archivePath); } catch (err) { /* ignore */ }
  }

  res.json({ deleted, failed, freedBytes, killedProcesses });
});

// -------- Manually kill stray download/encoder processes --------
app.post('/api/kill-stray', (req, res) => {
  if (process.platform !== 'win32') {
    res.json({ killed: 0, note: 'Only supported on Windows' });
    return;
  }
  const { spawnSync } = require('child_process');
  const yt = spawnSync('taskkill', ['/f', '/im', 'yt-dlp.exe'], { windowsHide: true });
  const ff = spawnSync('taskkill', ['/f', '/im', 'ffmpeg.exe'], { windowsHide: true });
  res.json({
    ytdlpKilled: yt.status === 0,
    ffmpegKilled: ff.status === 0,
  });
});



// -------- Live capture / stream monitoring --------
const LIVE_STATE_FILE = options.stateFile || path.join(__dirname, 'live-watchers.json');

// Map<watcherKey, watcher> — key is `${platform}:${channel}` (see platforms.js).
const liveWatchers = new Map();

// Shared context handed to platform.checkLive — gives platforms access to
// yt-dlp + spawn + fetch without each one re-importing.
const platformCtx = {
  ytdlpPath: YTDLP,
  spawn,
  fetch: (url, opts) => fetch(url, opts),
};

function saveLiveState() {
  const toSave = [];
  for (const [, w] of liveWatchers) {
    toSave.push({
      platform: w.platform,
      channel: w.channel,
      enabled: w.enabled,
      paused: !!w.paused,
    });
  }
  try { fs.writeFileSync(LIVE_STATE_FILE, JSON.stringify(toSave, null, 2)); } catch (e) { /* ignore */ }
}

function startRecording(key) {
  const watcher = liveWatchers.get(key);
  if (!watcher || watcher.recordingProcess) return;
  const platform = getPlatform(watcher.platform);
  if (!platform) return;

  ensureDir(DEFAULT_OUTPUT);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Channel can contain '@' for YouTube handles — strip it for the directory
  // name so the path stays sane on Windows.
  const safeChannel = watcher.channel.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const sessionDir = path.join(DEFAULT_OUTPUT, `live-${watcher.platform}-${safeChannel}-${timestamp}`);
  ensureDir(sessionDir);
  const outputPath = path.join(sessionDir, 'recording.mp4');
  const infoPath = path.join(sessionDir, 'info.json');
  const titlesPath = path.join(sessionDir, 'titles.log');

  const initialTitle = watcher.lastStatus?.title || null;
  const startedIso = new Date().toISOString();

  // Write initial info.json
  const info = {
    platform: watcher.platform,
    channel: watcher.channel,
    sessionDir,
    recordingStartedAt: startedIso,
    recordingEndedAt: null,
    initialTitle,
    titleHistory: initialTitle ? [{ at: startedIso, title: initialTitle }] : [],
  };
  try {
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
    if (initialTitle) {
      fs.appendFileSync(titlesPath, `${startedIso} | ${initialTitle}\n`);
    }
  } catch (e) { /* ignore */ }

  // Quality: per-watcher choice > per-platform default > global default.
  const presetId = watcher.qualityPreset || settings.defaultPresetFor(watcher.platform);
  const formatStr = quality.resolveFormat({ preset: presetId }, settings.get().qualityDefault);

  const args = [
    '-f', formatStr,
    '--hls-prefer-native',
    '-N', '16',
    '--merge-output-format', 'mp4',
    '--hls-use-mpegts',
    '--fragment-retries', '100',
    '--retry-sleep', 'fragment:5',
    '--no-part',
    '-o', outputPath,
    platform.streamUrl(watcher.channel),
  ];

  console.log(`[live] Starting recording for ${key} (quality=${presetId}) -> ${outputPath}`);
  const proc = spawn(YTDLP, args, { windowsHide: true });
  watcher.recordingProcess = proc;
  watcher.currentFile = outputPath;
  watcher.recordingStartedAt = Date.now();
  watcher.state = 'recording';
  watcher.logTail = [];
  watcher.sessionDir = sessionDir;
  watcher.currentInfoPath = infoPath;
  watcher.currentTitlesPath = titlesPath;
  watcher.lastRecordedTitle = initialTitle;

  // Start chat capture in parallel. Failures here don't affect the recording.
  if (settings.get().chatLiveEnabled) {
    try {
      watcher.chatHandle = startChatCapture({
        platform: watcher.platform,
        channel: watcher.channel,
        sessionDir,
        lastStatus: watcher.lastStatus,
        streamUrl: platform.streamUrl(watcher.channel),
        ytdlpPath: YTDLP,
      }, (msg) => {
        // Pipe chat log lines into the watcher's logTail so they show in the UI.
        watcher.logTail.push(msg);
        if (watcher.logTail.length > 50) watcher.logTail.shift();
      });
    } catch (e) {
      console.error(`[chat] failed to start for ${key}:`, e.message);
    }
  }

  if (!watcher.recordingHistory) watcher.recordingHistory = [];
  watcher.recordingHistory.push({
    sessionDir,
    file: outputPath,
    infoFile: infoPath,
    startedAt: Date.now(),
    endedAt: null,
  });
  while (watcher.recordingHistory.length > 30) watcher.recordingHistory.shift();

  const pushLog = (text) => {
    const lines = text.toString().split(/\r\n|[\r\n]/).filter(Boolean);
    for (const l of lines) {
      watcher.logTail.push(l);
      if (watcher.logTail.length > 50) watcher.logTail.shift();
    }
  };
  proc.stdout.on('data', pushLog);
  proc.stderr.on('data', pushLog);

  proc.on('close', (code) => {
    console.log(`[live] Recording ended for ${key} (exit ${code})`);
    const endedAt = Date.now();
    const endedIso = new Date(endedAt).toISOString();
    if (watcher.recordingStartedAt) {
      watcher.recordingStoppedAt = endedAt;
    }

    // Stop chat capture (closes WebSockets, normalizes YT raw, etc.)
    if (watcher.chatHandle) {
      try { watcher.chatHandle.stop(); } catch (e) { /* ignore */ }
      watcher.chatHandle = null;
    }

    // Update recordingHistory
    const hist = watcher.recordingHistory?.[watcher.recordingHistory.length - 1];
    if (hist && !hist.endedAt) {
      hist.endedAt = endedAt;
      hist.exitCode = code;
    }

    // Update info.json
    if (watcher.currentInfoPath && fs.existsSync(watcher.currentInfoPath)) {
      try {
        const infoData = JSON.parse(fs.readFileSync(watcher.currentInfoPath, 'utf8'));
        infoData.recordingEndedAt = endedIso;
        fs.writeFileSync(watcher.currentInfoPath, JSON.stringify(infoData, null, 2));
      } catch (e) { /* ignore */ }
    }

    // Mark this as the latest completed output
    watcher.lastCompletedOutput = watcher.currentFile;

    watcher.recordingProcess = null;
    watcher.lastExitCode = code;
    if (watcher.enabled) watcher.state = 'polling';
    else {
      liveWatchers.delete(key);
      saveLiveState();
    }
  });
  proc.on('error', (err) => {
    watcher.error = err.message;
  });
}

async function pollWatcher(key) {
  const watcher = liveWatchers.get(key);
  if (!watcher || !watcher.enabled) return;
  const platform = getPlatform(watcher.platform);
  if (!platform) return;

  watcher.lastCheck = Date.now();
  const status = await platform.checkLive(watcher.channel, platformCtx);
  watcher.lastStatus = status;

  if (status.live && !watcher.recordingProcess && !watcher.paused) {
    startRecording(key);
  }

  // While recording, log any title changes
  if (watcher.recordingProcess && status.title && status.title !== watcher.lastRecordedTitle) {
    const nowIso = new Date().toISOString();
    try {
      if (watcher.currentTitlesPath) {
        fs.appendFileSync(watcher.currentTitlesPath, `${nowIso} | ${status.title}\n`);
      }
      if (watcher.currentInfoPath && fs.existsSync(watcher.currentInfoPath)) {
        const infoData = JSON.parse(fs.readFileSync(watcher.currentInfoPath, 'utf8'));
        infoData.titleHistory = infoData.titleHistory || [];
        infoData.titleHistory.push({ at: nowIso, title: status.title });
        fs.writeFileSync(watcher.currentInfoPath, JSON.stringify(infoData, null, 2));
      }
    } catch (e) { /* ignore */ }
    watcher.lastRecordedTitle = status.title;
  }
}

function startWatching(platformId, channel) {
  const platform = getPlatform(platformId);
  if (!platform) throw new Error(`Unknown platform: ${platformId}`);
  const normalized = platform.normalize(channel);
  if (!normalized) throw new Error(`Invalid ${platform.displayName} channel: ${channel}`);

  const key = watcherKey(platformId, normalized);
  if (liveWatchers.has(key)) {
    const w = liveWatchers.get(key);
    w.enabled = true;
    if (!w.interval) w.interval = setInterval(() => pollWatcher(key), platform.pollIntervalMs);
    saveLiveState();
    return key;
  }

  const watcher = {
    platform: platformId,
    channel: normalized,
    enabled: true,
    paused: false,
    state: 'polling',
    recordingProcess: null,
    lastCheck: 0,
    lastStatus: null,
    currentFile: null,
    recordingStartedAt: null,
    logTail: [],
    interval: null,
  };
  liveWatchers.set(key, watcher);
  saveLiveState();

  pollWatcher(key); // immediate first check
  watcher.interval = setInterval(() => pollWatcher(key), platform.pollIntervalMs);
  return key;
}

function stopWatching(platformId, channel, alsoKillRecording = false) {
  const platform = getPlatform(platformId);
  if (!platform) return;
  const normalized = platform.normalize(channel) || channel;
  const key = watcherKey(platformId, normalized);
  const watcher = liveWatchers.get(key);
  if (!watcher) return;

  watcher.enabled = false;
  if (watcher.interval) {
    clearInterval(watcher.interval);
    watcher.interval = null;
  }

  if (watcher.recordingProcess && alsoKillRecording) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawnSync('taskkill', ['/pid', watcher.recordingProcess.pid, '/f', '/t'], { windowsHide: true });
      } else {
        watcher.recordingProcess.kill('SIGTERM');
      }
    } catch (e) { /* ignore */ }
  }

  if (!watcher.recordingProcess) {
    liveWatchers.delete(key);
  }
  saveLiveState();
}

function loadLiveState() {
  try {
    if (!fs.existsSync(LIVE_STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LIVE_STATE_FILE, 'utf8'));
    for (const item of data) {
      if (!item.enabled) continue;
      // Migration: legacy entries had `username` (Kick-only). Treat as kick.
      const platformId = item.platform || 'kick';
      const channel = item.channel || item.username;
      if (!channel) continue;
      try {
        const key = startWatching(platformId, channel);
        if (item.paused) {
          const w = liveWatchers.get(key);
          if (w) w.paused = true;
        }
      } catch (e) {
        console.error(`[live] failed to restore watcher ${platformId}:${channel}`, e.message);
      }
    }
  } catch (e) { /* ignore */ }
}

const SESSION_GAP_MS = 15 * 60 * 1000; // recordings within 15 min of each other = same session

function findRelatedRecordings(watcher) {
  const history = (watcher.recordingHistory || []).filter(r => fs.existsSync(r.file));
  if (history.length === 0) return [];

  // Sort newest first by ending time (or start time if no end)
  const sorted = [...history].sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));

  const related = [];
  let prevStart = null;
  for (const rec of sorted) {
    if (prevStart === null) {
      related.push(rec);
      prevStart = rec.startedAt;
      continue;
    }
    // Gap between this recording's end and next one's start
    const gap = prevStart - (rec.endedAt || rec.startedAt);
    if (gap >= 0 && gap <= SESSION_GAP_MS) {
      related.push(rec);
      prevStart = rec.startedAt;
    } else {
      break;
    }
  }
  return related.reverse(); // chronological order
}

// Helper: pull {platform, channel} out of req body, validate, return key.
// Returns { ok: true, platform, channel, key, watcher } or { ok: false, error, status }.
function resolveWatcherFromBody(req) {
  const { platform: platformId, channel } = req.body || {};
  if (!platformId || !channel) {
    return { ok: false, status: 400, error: 'platform and channel required' };
  }
  const platform = getPlatform(platformId);
  if (!platform) {
    return { ok: false, status: 400, error: `Unknown platform: ${platformId}` };
  }
  const normalized = platform.normalize(channel);
  if (!normalized) {
    return { ok: false, status: 400, error: `Invalid ${platform.displayName} channel` };
  }
  const key = watcherKey(platformId, normalized);
  return { ok: true, platform: platformId, channel: normalized, key, watcher: liveWatchers.get(key) };
}

// Expose the platform list (id, display name, poll interval) so the UI can
// render the platform selector without hardcoding it.
app.get('/api/platforms', (req, res) => {
  const list = Object.values(PLATFORMS).map(p => ({
    id: p.id,
    displayName: p.displayName,
    pollIntervalMs: p.pollIntervalMs,
  }));
  res.json({ platforms: list });
});

// Quality preset list (used by chip rows + settings page).
app.get('/api/quality/presets', (req, res) => {
  res.json({ presets: quality.listPresets() });
});

// App settings (quality defaults, chat toggles, custom -f).
app.get('/api/settings', (req, res) => {
  res.json(settings.get());
});

app.post('/api/settings', (req, res) => {
  const updated = settings.update(req.body || {});
  res.json(updated);
});

app.get('/api/live', (req, res) => {
  const watchers = [];
  for (const [key, w] of liveWatchers) {
    let recordingSize = 0;
    if (w.currentFile) {
      try { recordingSize = fs.statSync(w.currentFile).size; } catch (e) { /* ignore */ }
    }
    const related = findRelatedRecordings(w);
    // The "latest completed file" for trim card purposes
    let latestOutput = null;
    if (w.recordingProcess) {
      latestOutput = w.currentFile;
    } else if (w.lastCompletedOutput && fs.existsSync(w.lastCompletedOutput)) {
      latestOutput = w.lastCompletedOutput;
    } else if (w.currentFile && fs.existsSync(w.currentFile)) {
      latestOutput = w.currentFile;
    }

    const platform = getPlatform(w.platform);
    watchers.push({
      key,
      platform: w.platform,
      platformDisplayName: platform ? platform.displayName : w.platform,
      channel: w.channel,
      enabled: w.enabled,
      paused: !!w.paused,
      state: w.state,
      lastCheck: w.lastCheck,
      lastStatus: w.lastStatus,
      currentFile: w.currentFile,
      currentFileExists: w.currentFile ? fs.existsSync(w.currentFile) : false,
      latestOutput,
      recordingStartedAt: w.recordingStartedAt,
      recordingStoppedAt: w.recordingStoppedAt,
      recordingSize,
      isRecording: !!w.recordingProcess,
      pollIntervalMs: platform ? platform.pollIntervalMs : null,
      relatedRecordings: related.map(r => ({
        file: r.file,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
      logTail: w.logTail.slice(-10),
    });
  }
  res.json({ watchers });
});

app.post('/api/live/start', (req, res) => {
  const r = resolveWatcherFromBody(req);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  try {
    startWatching(r.platform, r.channel);
    res.json({ ok: true, platform: r.platform, channel: r.channel });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/live/stop', (req, res) => {
  const r = resolveWatcherFromBody(req);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  stopWatching(r.platform, r.channel, !!req.body.killRecording);
  res.json({ ok: true });
});

// Stop the current recording and pause auto-recording (watcher keeps polling)
app.post('/api/live/stop-recording', (req, res) => {
  const r = resolveWatcherFromBody(req);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (!r.watcher) return res.status(404).json({ error: 'not watching' });

  r.watcher.paused = true;
  if (r.watcher.recordingProcess) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawnSync('taskkill', ['/pid', r.watcher.recordingProcess.pid, '/f', '/t'], { windowsHide: true });
      } else {
        r.watcher.recordingProcess.kill('SIGTERM');
      }
    } catch (e) { /* ignore */ }
  }
  saveLiveState();
  res.json({ ok: true });
});

// Unpause — will auto-record again when live detected
app.post('/api/live/resume', (req, res) => {
  const r = resolveWatcherFromBody(req);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (!r.watcher) return res.status(404).json({ error: 'not watching' });
  r.watcher.paused = false;
  saveLiveState();
  res.json({ ok: true });
});

// Stitch the last N related recordings for a watcher into one file
app.post('/api/live/auto-stitch', async (req, res) => {
  const r = resolveWatcherFromBody(req);
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  if (!r.watcher) { res.status(404).json({ error: 'not watching' }); return; }

  const related = findRelatedRecordings(r.watcher);
  if (related.length < 2) { res.status(400).json({ error: 'need 2+ related recordings' }); return; }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.flushHeaders();

  const jobId = 'autostitch_' + Date.now();
  writeLine(res, `[job] ${jobId}`);
  writeLine(res, `[status] stitching`);
  writeLine(res, `[info] Stitching ${related.length} parts for ${r.platform}:${r.channel}`);
  for (const rec of related) writeLine(res, `[info] Part: ${rec.file}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeChannel = r.channel.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const outputDir = path.join(DEFAULT_OUTPUT, `live-${r.platform}-${safeChannel}-stitched-${timestamp}`);
  ensureDir(outputDir);
  const outputPath = path.join(outputDir, 'stitched.mp4');

  const listPath = path.join(outputDir, 'concat-list.txt');
  const listContent = related
    .map(rec => `file '${rec.file.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent, 'utf8');

  // Merge all info.json files from source parts into a combined one
  const combinedInfo = {
    platform: r.platform,
    channel: r.channel,
    sessionDir: outputDir,
    stitchedAt: new Date().toISOString(),
    stitchedFrom: related.map(rec => rec.file),
    recordingStartedAt: null,
    recordingEndedAt: null,
    initialTitle: null,
    titleHistory: [],
  };
  for (const rec of related) {
    try {
      const partInfoPath = path.join(path.dirname(rec.file), 'info.json');
      if (fs.existsSync(partInfoPath)) {
        const partInfo = JSON.parse(fs.readFileSync(partInfoPath, 'utf8'));
        if (!combinedInfo.recordingStartedAt) combinedInfo.recordingStartedAt = partInfo.recordingStartedAt;
        if (partInfo.recordingEndedAt) combinedInfo.recordingEndedAt = partInfo.recordingEndedAt;
        if (!combinedInfo.initialTitle && partInfo.initialTitle) combinedInfo.initialTitle = partInfo.initialTitle;
        if (Array.isArray(partInfo.titleHistory)) combinedInfo.titleHistory.push(...partInfo.titleHistory);
      }
    } catch (e) { /* ignore */ }
  }

  const ffArgs = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-fflags', '+genpts',
    '-i', listPath,
    '-c', 'copy',
    outputPath,
  ];
  writeLine(res, `[cmd] ${path.basename(FFMPEG)} ${ffArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  const ff = spawn(FFMPEG, ffArgs, { windowsHide: true });
  runningJobs.set(jobId, ff);

  try {
    await streamProcess(ff, res, 'ffmpeg');
    runningJobs.delete(jobId);

    // Write combined info.json and titles.log
    try {
      fs.writeFileSync(path.join(outputDir, 'info.json'), JSON.stringify(combinedInfo, null, 2));
      const titlesText = combinedInfo.titleHistory
        .map(t => `${t.at} | ${t.title}`)
        .join('\n');
      fs.writeFileSync(path.join(outputDir, 'titles.log'), titlesText + '\n');
    } catch (e) { /* ignore */ }

    try { fs.unlinkSync(listPath); } catch (e) { /* ignore */ }
    if (r.watcher) r.watcher.lastCompletedOutput = outputPath;
    writeLine(res, `\n[file] ${outputPath}`);
    writeLine(res, `[status] done`);
  } catch (err) {
    runningJobs.delete(jobId);
    writeLine(res, `\n[status] error`);
    writeLine(res, `[error] ${err.message}`);
  }
  res.end();
});

// -------- Get video duration via ffprobe --------
app.get('/api/file-duration', (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ];
  const p = spawn(FFPROBE, args, { windowsHide: true });
  let output = '';
  p.stdout.on('data', d => output += d.toString());
  let errored = false;
  p.on('error', (err) => {
    errored = true;
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  p.on('close', code => {
    if (errored) return;
    if (code === 0) {
      const duration = parseFloat(output.trim());
      res.json({ duration: isNaN(duration) ? null : duration });
    } else {
      res.status(500).json({ error: 'ffprobe exited with code ' + code });
    }
  });
});

// -------- Extract a single frame as JPEG for preview --------
app.get('/api/frame', (req, res) => {
  const { path: filePath, time } = req.query;

  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).send('File not found');
    return;
  }

  const ffArgs = [];
  // -sseof -N means "seek N seconds from end of file"
  // Otherwise -ss with a timestamp seeks to that point
  if (!time || time === 'end') {
    ffArgs.push('-sseof', '-1');
  } else {
    ffArgs.push('-ss', String(time));
  }
  ffArgs.push(
    '-i', filePath,
    '-vframes', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '4',
    '-f', 'mjpeg',
    'pipe:1'
  );

  const ff = spawn(FFMPEG, ffArgs, { windowsHide: true });

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=600');

  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {}); // ffmpeg stderr is noisy, suppress
  ff.on('error', () => {
    if (!res.headersSent) res.status(500).end();
  });
});

// -------- Cut a local file (lossless, ffmpeg -c copy) --------
app.post('/api/cut-file', async (req, res) => {
  const { path: inputPath, startTime, endTime, keepOriginal } = req.body;

  if (!inputPath) {
    res.status(400).json({ error: 'path required' });
    return;
  }
  if (!fs.existsSync(inputPath)) {
    res.status(400).json({ error: 'File does not exist: ' + inputPath });
    return;
  }

  const start = (startTime && startTime.trim()) || '00:00:00';
  const end = endTime && endTime.trim();

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.flushHeaders();

  const jobId = 'cut_' + Date.now();
  writeLine(res, `[job] ${jobId}`);
  writeLine(res, `[status] cutting`);

  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  const cutPath = path.join(dir, `${base} - CUT${ext}`);

  const ffArgs = ['-y', '-ss', start];
  if (end) ffArgs.push('-to', end);
  ffArgs.push('-i', inputPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', cutPath);

  writeLine(res, `[info] Input: ${inputPath}`);
  writeLine(res, `[info] Output: ${cutPath}`);
  writeLine(res, `[info] Range: ${start}${end ? ' to ' + end : ' to end'}`);
  writeLine(res, `[cmd] ${path.basename(FFMPEG)} ${ffArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  const ff = spawn(FFMPEG, ffArgs, { windowsHide: true });
  runningJobs.set(jobId, ff);

  try {
    await streamProcess(ff, res, 'ffmpeg');
    runningJobs.delete(jobId);
    writeLine(res, `\n[file] ${cutPath}`);

    if (!keepOriginal) {
      try {
        fs.unlinkSync(inputPath);
        writeLine(res, `[info] Deleted original: ${path.basename(inputPath)}`);
      } catch (e) {
        writeLine(res, `[warn] Could not delete original: ${e.message}`);
      }
    }

    writeLine(res, `[status] done`);
  } catch (err) {
    runningJobs.delete(jobId);
    writeLine(res, `\n[status] error`);
    writeLine(res, `[error] ${err.message}`);
  }
  res.end();
});

// Load persisted watchers on startup
loadLiveState();

// -------- Dependency check --------
app.get('/api/check', async (req, res) => {
  const check = (cmdPath, versionArg) => new Promise(resolve => {
    const isAbsolute = cmdPath.includes(path.sep) || /^[A-Z]:\\/i.test(cmdPath);
    const exists = isAbsolute ? fs.existsSync(cmdPath) : null;

    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve({ ...result, path: cmdPath, exists });
    };

    try {
      const p = spawn(cmdPath, [versionArg], { windowsHide: true });
      let output = '';
      p.stdout.on('data', d => output += d.toString());
      p.stderr.on('data', d => output += d.toString());
      p.on('error', err => done({ ok: false, version: null, error: err.code || err.message }));
      p.on('close', code => done({
        ok: code === 0,
        version: output.trim().split('\n')[0] || null,
        error: code !== 0
          ? `exit code ${code}${output.trim() ? ' - ' + output.trim().slice(0, 200) : ''}`
          : null,
      }));
    } catch (err) {
      done({ ok: false, version: null, error: err.message });
    }
  });

  const [ytdlp, ffmpeg] = await Promise.all([
    check(YTDLP, '--version'),
    check(FFMPEG, '-version'),
  ]);
  res.json({
    ytdlp: { ...ytdlp, source: YTDLP === 'yt-dlp' ? 'PATH' : 'local bin/' },
    ffmpeg: { ...ffmpeg, source: FFMPEG === 'ffmpeg' ? 'PATH' : 'local bin/' },
    defaultOutput: DEFAULT_OUTPUT,
    binDir: BIN_DIR,
    binDirExists: fs.existsSync(BIN_DIR),
  });
});

// --- Boot ---
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(PORT, () => {
      console.log(`[server] Solutions VOD Tools listening on http://localhost:${PORT}`);
      console.log(`[server] Output: ${DEFAULT_OUTPUT}`);
      console.log(`[server] yt-dlp: ${YTDLP}`);
      console.log(`[server] ffmpeg: ${FFMPEG}`);

      const performShutdown = async () => {
        // Stop live watcher polling intervals + chat captures
        for (const [, w] of liveWatchers) {
          if (w.interval) clearInterval(w.interval);
          if (w.chatHandle) {
            try { w.chatHandle.stop(); } catch (e) { /* ignore */ }
            w.chatHandle = null;
          }
        }
        // Kill all tracked child jobs (yt-dlp downloads, ffmpeg encodes, recordings)
        for (const [, proc] of runningJobs.entries()) {
          try {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/pid', proc.pid, '/f', '/t'], { windowsHide: true });
            } else {
              proc.kill('SIGKILL');
            }
          } catch (e) { /* ignore */ }
        }
        // Kill any orphan downloaders/encoders so file handles are released
        if (process.platform === 'win32') {
          try {
            spawnSync('taskkill', ['/f', '/im', 'yt-dlp.exe'], { windowsHide: true });
            spawnSync('taskkill', ['/f', '/im', 'ffmpeg.exe'], { windowsHide: true });
          } catch (e) { /* ignore */ }
        }
        // Close the HTTP listener
        await new Promise(r => httpServer.close(() => r()));
      };

      resolve({ httpServer, shutdown: performShutdown });
    });
    httpServer.on('error', reject);
  });
} // end createServer

module.exports = { createServer };
