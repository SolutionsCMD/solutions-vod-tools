/* ============================================================
   Solutions VOD Tools — application logic
   Adapted from kick-vod-tools for the new shell.
   Tab switching is driven by shell.js via window.navigateTo and
   the 'page-changed' event.
   ============================================================ */

// Dep check on load
function runDepCheck() {
  fetch('/api/check').then(r => r.json()).then(data => {
    const yt = document.getElementById('dep-ytdlp');
    const ff = document.getElementById('dep-ffmpeg');

    yt.className = 'dep-pill ' + (data.ytdlp.ok ? 'ok' : 'missing');
    yt.title = `Source: ${data.ytdlp.source}
Path: ${data.ytdlp.path}` +
      (data.ytdlp.version ? `
Version: ${data.ytdlp.version}` : '') +
      (data.ytdlp.error ? `
Error: ${data.ytdlp.error}` : '');

    ff.className = 'dep-pill ' + (data.ffmpeg.ok ? 'ok' : 'missing');
    ff.title = `Source: ${data.ffmpeg.source}
Path: ${data.ffmpeg.path}` +
      (data.ffmpeg.version ? `
Version: ${data.ffmpeg.version}` : '') +
      (data.ffmpeg.error ? `
Error: ${data.ffmpeg.error}` : '');

    const allOk = data.ytdlp.ok && data.ffmpeg.ok;
    if (window.statusBar) {
      window.statusBar.setServer(allOk ? 'ok' : 'warn', allOk ? 'ready' : 'missing dependencies');
      if (data.defaultOutput) window.statusBar.setOutputPath(data.defaultOutput);
    }

    const diag = document.getElementById('dep-diagnostic');
    const missing = [];
    if (!data.ytdlp.ok) missing.push({ name: 'yt-dlp', info: data.ytdlp });
    if (!data.ffmpeg.ok) missing.push({ name: 'ffmpeg', info: data.ffmpeg });

    if (missing.length === 0) {
      diag.classList.remove('visible');
    } else {
      let html = '<strong>Missing dependencies:</strong><br>';
      for (const m of missing) {
        html += `<br><strong>${m.name}</strong> — tried <code>${m.info.path}</code> (${m.info.source})`;
        if (m.info.exists === false) {
          html += '<br>&nbsp;&nbsp;• file does not exist at that path';
        } else if (m.info.exists === true) {
          html += '<br>&nbsp;&nbsp;• file exists but failed to run';
          if (m.info.error) html += ` (error: <code>${m.info.error}</code>)`;
        } else {
          html += '<br>&nbsp;&nbsp;• not found on PATH';
          if (m.info.error) html += ` (error: <code>${m.info.error}</code>)`;
        }
      }
      html += `<br><br>Fix: restart the app to re-run first-time setup.`;
      html += `<br>bin/ folder: <code>${data.binDir}</code> (${data.binDirExists ? 'exists' : 'missing'})`;
      diag.innerHTML = html;
      diag.classList.add('visible');
    }

    if (data.defaultOutput) {
      const od = document.getElementById('outputDir');
      const sf = document.getElementById('stitchFolder');
      if (od) od.placeholder = 'Default: ' + data.defaultOutput;
      if (sf) sf.placeholder = 'Default: ' + data.defaultOutput;
    }
  }).catch(err => {
    if (window.statusBar) window.statusBar.setServer('error', 'unreachable');
    console.error('[dep-check] failed:', err);
  });
}

runDepCheck();
document.getElementById('btn-recheck').addEventListener('click', runDepCheck);

function setStatus(tab, status, text) {
  const pill = document.getElementById('status-' + tab);
  pill.className = 'status-pill ' + status;
  pill.textContent = text;

  const phase = document.getElementById('phase-' + tab);
  if (phase) {
    phase.className = 'stats-phase' + (status === 'done' ? ' done' : status === 'error' ? ' error' : '');
    phase.textContent = text;
  }
}

const logBuffers = {};
const logScheduled = {};

function appendLog(tab, text) {
  const log = document.getElementById('log-' + tab);
  log.classList.add('visible');
  const lines = text.split(/\r\n|[\r\n]/);
  if (!logBuffers[tab]) logBuffers[tab] = [];
  for (const line of lines) {
    if (line) logBuffers[tab].push(line);
  }

  if (logScheduled[tab]) return;
  logScheduled[tab] = true;
  requestAnimationFrame(() => {
    logScheduled[tab] = false;
    const buffered = logBuffers[tab];
    logBuffers[tab] = [];
    if (buffered.length === 0) return;

    const frag = document.createDocumentFragment();
    for (const line of buffered) {
      const div = document.createElement('div');
      if (line.startsWith('[status]')) div.className = 'log-line-status';
      else if (line.startsWith('[info]')) div.className = 'log-line-info';
      else if (line.startsWith('[file]')) div.className = 'log-line-file';
      else if (line.startsWith('[error]')) div.className = 'log-line-error';
      else if (line.startsWith('[warn]')) div.className = 'log-line-warn';
      else if (line.startsWith('[cmd]')) div.className = 'log-line-cmd';
      div.textContent = line;
      frag.appendChild(div);
    }
    log.appendChild(frag);

    // Trim old log lines if too many (keeps DOM fast)
    while (log.childElementCount > 2000) {
      log.removeChild(log.firstChild);
    }

    log.scrollTop = log.scrollHeight;
  });
}

function clearLog(tab) {
  const log = document.getElementById('log-' + tab);
  log.innerHTML = '';
  log.classList.remove('visible');
  const result = document.getElementById('result-' + tab);
  result.classList.remove('visible', 'error');
  result.innerHTML = '';
}

function showResult(tab, text, isError) {
  const box = document.getElementById('result-' + tab);
  box.classList.add('visible');
  if (isError) box.classList.add('error');
  box.innerHTML = text;
}

// ---------- Stats parsing ----------
function parseSize(sizeStr) {
  if (!sizeStr) return null;
  const match = sizeStr.match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  const multipliers = { '': 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
  return num * (multipliers[unit] || 1);
}

function formatBytesShort(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  if (bytes < 1024) return bytes.toFixed(0) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function cleanUnit(str) {
  if (!str) return str;
  return str.replace(/iB/g, 'B');
}

function parseYtdlpLine(line) {
  if (!line.startsWith('[download]')) return null;
  const out = {};
  const pct = line.match(/(\d+(?:\.\d+)?)%/);
  if (pct) out.percent = parseFloat(pct[1]);
  const total = line.match(/of\s+~?\s*([\d.]+\s*[KMGT]?i?B)/i);
  if (total) out.totalSize = total[1];
  const speed = line.match(/at\s+([\d.]+\s*[KMGT]?i?B\/s|Unknown\s+B\/s)/i);
  if (speed) out.speed = speed[1];
  const eta = line.match(/ETA\s+([\d:]+|Unknown)/i);
  if (eta) out.eta = eta[1];
  const frag = line.match(/\(frag\s+(\d+)\/(\d+)\)/i);
  if (frag) { out.fragCurrent = parseInt(frag[1]); out.fragTotal = parseInt(frag[2]); }
  return out;
}

function parseFfmpegLine(line) {
  // frame=  123 fps=45 q=28 size=12345kB time=00:01:30.00 bitrate=... speed=2.5x
  if (!line.includes('time=') && !line.includes('size=')) return null;
  const out = {};
  const time = line.match(/time=(\d{2,}:\d{2}:\d{2}\.\d{2})/);
  if (time) out.time = time[1];
  const size = line.match(/size=\s*(\d+\s*[kKmM]?B)/);
  if (size) out.size = size[1].replace('kB', 'KB').replace('mB', 'MB');
  const speed = line.match(/speed=\s*([\d.]+x)/);
  if (speed) out.speed = speed[1];
  return out;
}

function updateDownloadStats(tab, progress) {
  if (progress.percent != null) {
    document.getElementById('percent-' + tab).textContent = progress.percent.toFixed(1) + '%';
    document.getElementById('bar-' + tab).style.width = Math.min(progress.percent, 100) + '%';
  }
  if (progress.speed) {
    document.getElementById('sp-speed-' + tab).textContent = cleanUnit(progress.speed);
  }
  if (progress.eta) {
    document.getElementById('sp-eta-' + tab).textContent = progress.eta;
  }
  if (progress.totalSize) {
    document.getElementById('sp-total-' + tab).textContent = cleanUnit(progress.totalSize);
  }
  if (progress.fragCurrent != null && progress.fragTotal != null) {
    document.getElementById('sp-frag-' + tab).textContent =
      progress.fragCurrent.toLocaleString() + ' / ' + progress.fragTotal.toLocaleString();
  }
  if (progress.percent != null && progress.totalSize) {
    const total = parseSize(progress.totalSize);
    if (total) {
      document.getElementById('sp-down-' + tab).textContent = formatBytesShort(total * progress.percent / 100);
    }
  }
}

function updateStitchStats(tab, progress) {
  if (progress.time) document.getElementById('sp-processed-' + tab).textContent = progress.time;
  if (progress.speed) document.getElementById('sp-speed-' + tab).textContent = progress.speed;
}

const elapsedTimers = {};

function startElapsed(tab) {
  const start = Date.now();
  clearInterval(elapsedTimers[tab]);
  elapsedTimers[tab] = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    const str = h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    const el = document.getElementById('sp-elapsed-' + tab);
    if (el) el.textContent = str;
  }, 1000);
}

function stopElapsed(tab) {
  clearInterval(elapsedTimers[tab]);
}

function resetStatsCard(tab) {
  // Stats card is optional — tabs that don't show one (e.g. cut-tab) won't
  // have these elements. Null-check everything.
  const stats = document.getElementById('stats-' + tab);
  if (stats) stats.classList.add('visible');
  const pct = document.getElementById('percent-' + tab);
  if (pct) pct.textContent = tab === 'stitch' ? '—' : '0.0%';
  const bar = document.getElementById('bar-' + tab);
  if (bar) bar.style.width = '0%';
  ['speed', 'eta', 'down', 'total', 'frag', 'processed'].forEach(k => {
    const el = document.getElementById('sp-' + k + '-' + tab);
    if (el) el.textContent = '—';
  });
  const elapsed = document.getElementById('sp-elapsed-' + tab);
  if (elapsed) elapsed.textContent = '00:00';
}

async function streamJob(tab, url, body) {
  clearLog(tab);
  resetStatsCard(tab);
  setStatus(tab, 'running', 'starting');
  document.getElementById('btn-start-' + tab).disabled = true;
  document.getElementById('btn-cancel-' + tab).disabled = false;
  startElapsed(tab);

  let lastStatus = 'running';
  const finalFiles = [];

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const err = await res.json();
      throw new Error(err.error || 'Request failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const lines = buffer.split(/\r\n|[\r\n]/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        appendLog(tab, line);

        // yt-dlp progress
        const yt = parseYtdlpLine(line);
        if (yt) updateDownloadStats(tab, yt);

        // ffmpeg progress (for cut/stitch)
        const ff = parseFfmpegLine(line);
        if (ff) {
          if (tab === 'stitch') updateStitchStats(tab, ff);
          // For download tab during cut phase, show processed time in the ETA slot
          if (tab === 'download' && ff.time) {
            const el = document.getElementById('sp-eta-download');
            if (el) el.textContent = ff.time;
          }
        }

        // Status transitions
        if (line.startsWith('[status]')) {
          const s = line.substring(8).trim();
          lastStatus = s;
          if (s === 'downloading') setStatus(tab, 'running', 'downloading');
          else if (s === 'stitching') setStatus(tab, 'running', 'stitching');
          else if (s === 'done') setStatus(tab, 'done', 'done');
          else if (s === 'error') setStatus(tab, 'error', 'error');
        }
        if (line.startsWith('[file]')) {
          finalFiles.push(line.substring(6).trim());
        }
      }
    }
    if (buffer) appendLog(tab, buffer);

    if (lastStatus === 'done') {
      const bar = document.getElementById('bar-' + tab);
      if (bar) bar.style.width = '100%';
      const fileList = finalFiles.length
        ? finalFiles.map(f => `<div style="margin-top:4px;"><strong>→</strong> ${f}</div>`).join('')
        : '';
      showResult(tab, '<strong>Done.</strong>' + fileList, false);
    } else if (lastStatus === 'error') {
      showResult(tab, '<strong>Job failed.</strong> See log below for details.', true);
    }
  } catch (err) {
    setStatus(tab, 'error', 'error');
    appendLog(tab, '[error] ' + err.message);
    showResult(tab, '<strong>Error:</strong> ' + err.message, true);
  } finally {
    stopElapsed(tab);
    document.getElementById('btn-start-' + tab).disabled = false;
    document.getElementById('btn-cancel-' + tab).disabled = true;
  }
}

// =================================================================
// Trim picker (Download form): smart text input + chips + dual-handle slider
// =================================================================
//
// State of the trim picker for the URL currently in the URL field.
const trimState = {
  url: '',         // last URL we probed
  durationSec: 0,  // total VOD length in seconds, 0 if unknown
  probing: false,
};

// Parse user-friendly time strings into seconds. Accepts:
//   "" / null            → null (no constraint)
//   "90"                 → 90 seconds
//   "1:30"               → 1 minute 30 seconds
//   "1:23:45"            → 1h 23m 45s
//   "5m" / "1h30m"       → 5 minutes / 1 hour 30 minutes
//   "1h30m45s"           → 1 hour 30 minutes 45 seconds
// Returns null for unparseable input so the caller can either show an error
// or silently ignore (and let the field be empty).
function parseTimeInput(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Plain integer → seconds
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // HH:MM:SS, MM:SS, M:SS — colon-separated
  if (/^\d+(?::\d+){1,2}$/.test(s)) {
    const parts = s.split(':').map(p => parseInt(p, 10));
    let total = 0;
    for (const p of parts) { total = total * 60 + (Number.isFinite(p) ? p : 0); }
    return total;
  }
  // "1h30m45s" / "5m" / "90s" — unit suffixes
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m && (m[1] || m[2] || m[3])) {
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const sec = parseInt(m[3] || '0', 10);
    return h * 3600 + min * 60 + sec;
  }
  return null;
}

function secondsToHms(total) {
  if (!Number.isFinite(total) || total < 0) return '';
  total = Math.round(total);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function setTrimDurationDisplay() {
  const el = document.getElementById('trim-duration-display');
  if (!el) return;
  if (trimState.durationSec > 0) {
    el.textContent = `total ${secondsToHms(trimState.durationSec)}`;
  } else {
    el.textContent = '—';
  }
}

function setTrimSliderEnabled(enabled) {
  const start = document.getElementById('trim-start-slider');
  const end = document.getElementById('trim-end-slider');
  if (!start || !end) return;
  start.disabled = !enabled;
  end.disabled = !enabled;
}

function updateTrimFillFromSliders() {
  const start = document.getElementById('trim-start-slider');
  const end = document.getElementById('trim-end-slider');
  const fill = document.getElementById('trim-fill');
  if (!start || !end || !fill) return;
  const max = parseInt(start.max, 10) || 1;
  const a = Math.min(parseInt(start.value, 10) || 0, parseInt(end.value, 10) || max);
  const b = Math.max(parseInt(start.value, 10) || 0, parseInt(end.value, 10) || max);
  fill.style.left = `${(a / max) * 100}%`;
  fill.style.right = `${100 - (b / max) * 100}%`;
}

// Wire the slider handles to the text inputs (and vice versa).
function syncSlidersFromInputs() {
  if (trimState.durationSec <= 0) return;
  const startSec = parseTimeInput(document.getElementById('start').value);
  const endSec = parseTimeInput(document.getElementById('end').value);
  const startSlider = document.getElementById('trim-start-slider');
  const endSlider = document.getElementById('trim-end-slider');
  if (startSlider) startSlider.value = startSec != null ? Math.min(startSec, trimState.durationSec) : 0;
  if (endSlider) endSlider.value = endSec != null ? Math.min(endSec, trimState.durationSec) : trimState.durationSec;
  updateTrimFillFromSliders();
}

function syncInputsFromSliders() {
  const startSlider = document.getElementById('trim-start-slider');
  const endSlider = document.getElementById('trim-end-slider');
  if (!startSlider || !endSlider) return;
  let a = parseInt(startSlider.value, 10) || 0;
  let b = parseInt(endSlider.value, 10) || trimState.durationSec;
  // Keep handles ordered (don't let start drag past end and vice versa).
  if (a > b) { const t = a; a = b; b = t; startSlider.value = a; endSlider.value = b; }
  document.getElementById('start').value = a > 0 ? secondsToHms(a) : '';
  document.getElementById('end').value = b < trimState.durationSec ? secondsToHms(b) : '';
  updateTrimFillFromSliders();
}

// Probe the URL via the server (yt-dlp --dump-json). Debounced — we don't
// want to hit it on every keystroke.
let probeTimer = null;
function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probeNow, 700);
}
function hideVodPreview() {
  const card = document.getElementById('vod-preview');
  if (card) card.hidden = true;
}

function renderVodPreview(body) {
  const card = document.getElementById('vod-preview');
  const thumbWrap = card?.querySelector('.vod-thumb-wrap');
  const thumb = document.getElementById('vod-thumb');
  const title = document.getElementById('vod-title');
  const uploader = document.getElementById('vod-uploader');
  const durBadge = document.getElementById('vod-duration-badge');
  const flags = document.getElementById('vod-flags');
  if (!card || !thumbWrap || !thumb || !title || !uploader || !durBadge || !flags) return;

  // Only show if we have at least a title or thumbnail to render — otherwise
  // an empty card looks broken.
  if (!body || (!body.title && !body.thumbnail)) {
    card.hidden = true;
    return;
  }

  // No thumbnail → hide the entire wrap (don't show a black box) and let the
  // meta column expand to fill the card via the .no-thumb class hook.
  if (body.thumbnail) {
    thumb.src = body.thumbnail;
    thumb.style.display = '';
    thumbWrap.style.display = '';
    card.classList.remove('no-thumb');
  } else {
    thumb.removeAttribute('src');
    thumbWrap.style.display = 'none';
    card.classList.add('no-thumb');
  }

  title.textContent = body.title || '(untitled)';
  uploader.textContent = body.uploader || '';
  uploader.style.display = body.uploader ? '' : 'none';
  durBadge.textContent = body.durationSec > 0 ? secondsToHms(body.durationSec) : '';
  durBadge.style.display = body.durationSec > 0 ? '' : 'none';

  flags.innerHTML = '';
  if (body.isLive) flags.innerHTML += `<span class="vod-flag live">live now</span>`;
  else if (body.wasLive) flags.innerHTML += `<span class="vod-flag was-live">was live</span>`;

  card.hidden = false;
}

async function probeNow() {
  const urlInput = document.getElementById('url');
  const status = document.getElementById('probe-status');
  if (!urlInput || !status) return;
  const url = urlInput.value.trim();
  if (!url) {
    trimState.url = '';
    trimState.durationSec = 0;
    status.textContent = '';
    setTrimSliderEnabled(false);
    setTrimDurationDisplay();
    hideVodPreview();
    return;
  }
  if (url === trimState.url) return; // already probed
  if (!/^https?:\/\//.test(url)) {
    status.textContent = 'URL must start with http:// or https://';
    hideVodPreview();
    return;
  }
  trimState.probing = true;
  status.textContent = 'Looking up VOD info…';
  hideVodPreview();
  try {
    const res = await fetch('/api/probe?url=' + encodeURIComponent(url));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status.textContent = `Couldn't read VOD info (${body.error || res.status}). You can still type times manually.`;
      trimState.url = url;
      trimState.durationSec = 0;
      setTrimSliderEnabled(false);
      setTrimDurationDisplay();
      return;
    }
    trimState.url = url;
    trimState.durationSec = body.durationSec || 0;

    renderVodPreview(body);

    if (body.isLive) {
      status.textContent = 'Live stream — duration unknown until it ends.';
      setTrimSliderEnabled(false);
    } else if (trimState.durationSec > 0) {
      // Preview card already shows duration; keep status minimal so it doesn't
      // duplicate what the card communicates.
      status.textContent = `Ready — drag the slider to trim, or leave full.`;
      const startSlider = document.getElementById('trim-start-slider');
      const endSlider = document.getElementById('trim-end-slider');
      if (startSlider) { startSlider.max = trimState.durationSec; startSlider.value = 0; }
      if (endSlider)   { endSlider.max   = trimState.durationSec; endSlider.value = trimState.durationSec; }
      setTrimSliderEnabled(true);
      updateTrimFillFromSliders();
    } else {
      status.textContent = 'Detected (duration unknown — type times manually if needed).';
      setTrimSliderEnabled(false);
    }
    setTrimDurationDisplay();
  } catch (err) {
    status.textContent = `Probe error: ${err.message}`;
  } finally {
    trimState.probing = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const urlEl = document.getElementById('url');
  if (urlEl) {
    urlEl.addEventListener('input', scheduleProbe);
    urlEl.addEventListener('paste', () => setTimeout(probeNow, 50));
  }

  const startInput = document.getElementById('start');
  const endInput = document.getElementById('end');
  const onTimeBlur = () => { syncSlidersFromInputs(); };
  if (startInput) startInput.addEventListener('blur', onTimeBlur);
  if (endInput) endInput.addEventListener('blur', onTimeBlur);

  const startSlider = document.getElementById('trim-start-slider');
  const endSlider = document.getElementById('trim-end-slider');
  if (startSlider) startSlider.addEventListener('input', syncInputsFromSliders);
  if (endSlider)   endSlider.addEventListener('input', syncInputsFromSliders);

  setTrimSliderEnabled(false);
});

document.getElementById('btn-start-download').addEventListener('click', () => {
  const url = document.getElementById('url').value.trim();
  if (!url) { alert('Paste a VOD URL first (Kick, Twitch, or YouTube).'); return; }
  // Normalize the time inputs through the smart parser before sending so the
  // server always receives HH:MM:SS (or empty).
  const normalizedStart = parseTimeInput(document.getElementById('start').value);
  const normalizedEnd = parseTimeInput(document.getElementById('end').value);
  streamJob('download', '/api/download', {
    url,
    startTime: normalizedStart != null ? secondsToHms(normalizedStart) : '',
    endTime: normalizedEnd != null ? secondsToHms(normalizedEnd) : '',
    outputDir: document.getElementById('outputDir').value,
    qualityPreset: qualityState.downloadPreset,
    customFormat: qualityState.appSettings && qualityState.appSettings.customFormat,
    includeChatReplay: document.getElementById('dl-include-chat').checked,
  });
});

document.getElementById('btn-cancel-download').addEventListener('click', async () => {
  await fetch('/api/cancel', { method: 'POST' });
});

document.getElementById('btn-start-stitch').addEventListener('click', () => {
  const files = Array.from(document.querySelectorAll('.part-input'))
    .map(i => i.value.trim())
    .filter(Boolean);
  if (files.length < 2) { alert('Enter at least 2 filenames.'); return; }
  streamJob('stitch', '/api/stitch', {
    folder: document.getElementById('stitchFolder').value,
    files,
    outputName: document.getElementById('stitch-output-name').value,
  });
});

document.getElementById('btn-cancel-stitch').addEventListener('click', async () => {
  await fetch('/api/cancel', { method: 'POST' });
});

function addPart() {
  const list = document.getElementById('parts-list');
  const row = document.createElement('div');
  row.className = 'part-row';
  row.innerHTML = `
    <input type="text" placeholder="next-part.mp4" class="part-input">
    <button class="btn-remove" onclick="removePart(this)">×</button>
  `;
  list.appendChild(row);
}

function removePart(btn) {
  const list = document.getElementById('parts-list');
  if (list.children.length <= 2) return;
  btn.parentElement.remove();
}

// ---------- Cleanup tab ----------
let cachedVods = [];

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatRelative(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function renderVodList() {
  const keepCount = parseInt(document.getElementById('keep-count').value) || 0;
  const list = document.getElementById('vod-list');

  if (cachedVods.length === 0) {
    list.innerHTML = '';
    if (window.emptyState && window.icons) {
      list.appendChild(window.emptyState({
        icon: window.icons.cleanup,
        title: 'No VODs downloaded yet',
        body: 'When you download or record VODs, they\'ll appear here so you can manage disk space.',
      }));
    }
    document.getElementById('btn-cleanup').disabled = true;
    document.getElementById('btn-cleanup').textContent = 'Delete 0 older VODs';
    return;
  }

  const rows = cachedVods.map((v, i) => {
    const willDelete = i >= keepCount;
    return `
      <div class="vod-row ${willDelete ? 'delete' : 'keep'}">
        <div class="vod-name" title="${v.name.replace(/"/g, '&quot;')}">${v.name}</div>
        <div class="vod-meta">${formatBytes(v.sizeBytes)} · ${formatRelative(v.mtime)}</div>
        <div class="vod-status">${willDelete ? 'delete' : 'keep'}</div>
      </div>
    `;
  }).join('');

  list.innerHTML = `<div class="vod-list-wrap">${rows}</div>`;

  const toDelete = Math.max(0, cachedVods.length - keepCount);
  const freedBytes = cachedVods.slice(keepCount).reduce((sum, v) => sum + v.sizeBytes, 0);
  const btn = document.getElementById('btn-cleanup');
  btn.textContent = `Delete ${toDelete} older VOD${toDelete === 1 ? '' : 's'} (${formatBytes(freedBytes)})`;
  btn.disabled = toDelete === 0;
}

async function refreshVods() {
  const res = await fetch('/api/vods');
  const data = await res.json();
  cachedVods = data.vods;
  document.getElementById('total-size').textContent = formatBytes(data.totalBytes);
  document.getElementById('vods-folder-path').textContent = data.folder;
  renderVodList();
}

document.getElementById('btn-refresh-vods').addEventListener('click', refreshVods);
document.getElementById('keep-count').addEventListener('input', renderVodList);

document.getElementById('btn-cleanup').addEventListener('click', async () => {
  const keepCount = parseInt(document.getElementById('keep-count').value) || 0;
  const toDelete = Math.max(0, cachedVods.length - keepCount);
  const alsoResetArchive = document.getElementById('reset-archive').checked;

  const confirmMsg = `Delete ${toDelete} older VOD folder${toDelete === 1 ? '' : 's'}?` +
    (alsoResetArchive ? '\n\nALSO resetting archive.txt — deleted VODs will be re-downloadable.' : '') +
    '\n\nThis cannot be undone.';
  if (!confirm(confirmMsg)) return;

  const result = document.getElementById('result-cleanup');
  result.classList.remove('visible', 'error');
  result.innerHTML = '';

  try {
    const res = await fetch('/api/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepCount, alsoResetArchive }),
    });
    const data = await res.json();

    let html = `<strong>Deleted ${data.deleted.length} folder${data.deleted.length === 1 ? '' : 's'}, freed ${formatBytes(data.freedBytes)}.</strong>`;
    if (data.killedProcesses) {
      html += '<br><span style="font-size:12px;">Killed stuck yt-dlp/ffmpeg processes to release file locks.</span>';
    }
    if (data.failed && data.failed.length) {
      html += '<br><br>Failed to delete: ' + data.failed.map(f => f.name).join(', ');
    }
    result.innerHTML = html;
    result.classList.add('visible');
    if (data.failed && data.failed.length) result.classList.add('error');

    await refreshVods();
  } catch (err) {
    result.innerHTML = '<strong>Error:</strong> ' + err.message;
    result.classList.add('visible', 'error');
  }
});

// Auto-refresh vods when switching to the cleanup tab
window.addEventListener('page-changed', (e) => {
  if (e.detail.page === 'cleanup') refreshVods();
});

document.getElementById('btn-kill-stuck').addEventListener('click', async () => {
  if (!confirm('Kill any running yt-dlp.exe or ffmpeg.exe processes?\n\nThis will interrupt any active downloads. Use this only if you have stuck files that won\'t delete.')) return;
  const result = document.getElementById('result-cleanup');
  try {
    const res = await fetch('/api/kill-stray', { method: 'POST' });
    const data = await res.json();
    let msg = 'Process cleanup complete.';
    if (data.ytdlpKilled) msg += ' yt-dlp killed.';
    if (data.ffmpegKilled) msg += ' ffmpeg killed.';
    if (!data.ytdlpKilled && !data.ffmpegKilled) msg = 'No stuck processes found.';
    result.innerHTML = msg;
    result.classList.add('visible');
    result.classList.remove('error');
  } catch (err) {
    result.innerHTML = 'Error: ' + err.message;
    result.classList.add('visible', 'error');
  }
});

// ---------- Live capture tab ----------
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function formatTimeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  return Math.floor(diff / 3600000) + 'h ago';
}

async function refreshLive() {
  try {
    const res = await fetch('/api/live');
    const data = await res.json();
    renderLiveWatchers(data);
    updateCutCard(data.watchers);
  } catch (err) { /* ignore */ }

  // Report counts to status bar + sidebar badge
  try {
    const list = document.getElementById('watchers-list');
    const watcherEls = list ? list.querySelectorAll('.watcher') : [];
    const recording = list ? list.querySelectorAll('.status-pill.live').length : 0;
    if (window.statusBar) {
      window.statusBar.setWatchers(watcherEls.length);
      window.statusBar.setJobs(recording);
    }
    const badge = document.getElementById('badge-watchers');
    if (badge) {
      if (watcherEls.length > 0) { badge.style.display = ''; badge.textContent = watcherEls.length; }
      else { badge.style.display = 'none'; }
    }
  } catch (e) { /* best-effort */ }
}

// Track current cut-card file so we don't overwrite inputs while user is typing
let cutCardFile = null;

function updateCutCard(watchers) {
  // Pick the most recent watcher with a latestOutput that's NOT actively recording
  const candidates = (watchers || []).filter(w => w.latestOutput && !w.isRecording);
  if (candidates.length === 0) {
    document.getElementById('cut-card').style.display = 'none';
    cutCardFile = null;
    cutCardWatcher = null;
    return;
  }
  candidates.sort((a, b) => (b.recordingStoppedAt || b.recordingStartedAt || 0) - (a.recordingStoppedAt || a.recordingStartedAt || 0));
  const latest = candidates[0];

  document.getElementById('cut-card').style.display = 'block';
  cutCardWatcher = { platform: latest.platform, channel: latest.channel };

  const fileChanged = latest.latestOutput !== cutCardFile;
  if (fileChanged) {
    cutCardFile = latest.latestOutput;
    document.getElementById('cut-file-path').textContent = latest.latestOutput;
    onFileChange(latest.latestOutput);
  }

  // Duration + size
  let durationText = '';
  if (latest.recordingStartedAt && latest.recordingStoppedAt) {
    durationText = 'Recorded duration: ~' + formatDuration(latest.recordingStoppedAt - latest.recordingStartedAt);
  }
  let size = 0;
  try { /* no-op */ } catch (e) {}
  // Get file size - not in response for stitched files, so we estimate from recordingSize for recordings
  const sizeText = latest.recordingSize ? 'Size: ' + formatBytes(latest.recordingSize) : '';
  document.getElementById('cut-file-meta').textContent = [durationText, sizeText].filter(Boolean).join(' • ');

  // Auto-stitch button
  const stitchBtn = document.getElementById('btn-auto-stitch');
  const related = latest.relatedRecordings || [];
  // Only show if the latestOutput is one of the individual recordings (not already stitched)
  // and there are 2+ related parts
  const isStitched = latest.latestOutput && latest.latestOutput.includes('-stitched-');
  if (related.length >= 2 && !isStitched) {
    stitchBtn.style.display = 'inline-block';
    stitchBtn.textContent = `Auto-stitch ${related.length} parts first`;
    stitchBtn.dataset.platform = latest.platform;
    stitchBtn.dataset.channel = latest.channel;
    stitchBtn.dataset.count = related.length;
  } else {
    stitchBtn.style.display = 'none';
  }
}

let cutCardWatcher = null;
let fileDuration = 0;

// ---- Time helpers ----
function secondsToTimestamp(secs) {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function timestampToSeconds(str) {
  if (!str) return 0;
  const parts = str.trim().split(':').map(p => parseFloat(p) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function clampSeconds(secs) {
  return Math.max(0, Math.min(fileDuration || 0, Math.round(secs)));
}

// ---- When the trim card's target file changes, set up sliders ----
async function onFileChange(filePath) {
  fileDuration = 0;
  const startSlider = document.getElementById('cut-start-slider');
  const endSlider = document.getElementById('cut-end-slider');
  const startInput = document.getElementById('cut-start');
  const endInput = document.getElementById('cut-end');
  const startLabel = document.getElementById('cut-start-label');
  const endLabel = document.getElementById('cut-end-label');

  // Reset visuals while fetching
  startSlider.max = 0; startSlider.value = 0;
  endSlider.max = 0; endSlider.value = 0;
  startInput.value = '00:00:00';
  endInput.value = '';
  startLabel.textContent = '00:00:00';
  endLabel.textContent = '--:--:--';

  try {
    const res = await fetch(`/api/file-duration?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data && data.duration && data.duration > 0) {
      fileDuration = Math.ceil(data.duration);
    }
  } catch (e) {
    fileDuration = 0;
  }

  if (fileDuration > 0) {
    startSlider.max = fileDuration;
    endSlider.max = fileDuration;
    startSlider.value = 0;
    endSlider.value = fileDuration;
    startInput.value = '00:00:00';
    endInput.value = secondsToTimestamp(fileDuration);
    startLabel.textContent = '00:00:00';
    endLabel.textContent = secondsToTimestamp(fileDuration);
  }

  updatePreview('start');
  updatePreview('end');
}

// ---- Debounced preview ----
const previewTimers = {};
function updatePreview(which) {
  if (!cutCardFile) return;
  const img = document.getElementById('cut-preview-' + which);
  const timeEl = document.getElementById('cut-' + which);
  let time = (timeEl.value || '').trim();
  if (which === 'start' && !time) time = '0';
  if (which === 'end' && !time) time = 'end';

  img.classList.add('loading');
  img.classList.remove('empty');
  const url = `/api/frame?path=${encodeURIComponent(cutCardFile)}&time=${encodeURIComponent(time)}`;
  img.onload = () => img.classList.remove('loading');
  img.onerror = () => { img.classList.remove('loading'); img.classList.add('empty'); };
  img.src = url;
}

function schedulePreview(which, delay = 300) {
  clearTimeout(previewTimers[which]);
  previewTimers[which] = setTimeout(() => updatePreview(which), delay);
}

// ---- Sync between slider, text input, and time label ----
function setTime(which, seconds, source) {
  const secs = clampSeconds(seconds);
  const slider = document.getElementById('cut-' + which + '-slider');
  const input = document.getElementById('cut-' + which);
  const label = document.getElementById('cut-' + which + '-label');
  const ts = secondsToTimestamp(secs);

  if (source !== 'slider') slider.value = secs;
  if (source !== 'input') input.value = ts;
  label.textContent = ts;
}

// Slider drag: update label + input immediately, debounce frame fetch
document.getElementById('cut-start-slider').addEventListener('input', (e) => {
  setTime('start', parseInt(e.target.value, 10), 'slider');
  schedulePreview('start', 250);
});
document.getElementById('cut-end-slider').addEventListener('input', (e) => {
  setTime('end', parseInt(e.target.value, 10), 'slider');
  schedulePreview('end', 250);
});

// Text input: parse to seconds, update slider, debounce frame fetch
document.getElementById('cut-start').addEventListener('input', (e) => {
  if (fileDuration > 0) {
    setTime('start', timestampToSeconds(e.target.value), 'input');
  }
  schedulePreview('start', 500);
});
document.getElementById('cut-end').addEventListener('input', (e) => {
  if (fileDuration > 0) {
    setTime('end', timestampToSeconds(e.target.value), 'input');
  }
  schedulePreview('end', 500);
});


document.getElementById('btn-auto-stitch').addEventListener('click', async () => {
  const btn = document.getElementById('btn-auto-stitch');
  const platform = btn.dataset.platform;
  const channel = btn.dataset.channel;
  const count = btn.dataset.count;
  if (!platform || !channel) return;
  if (!confirm(`Stitch the last ${count} recording parts for ${channel} into one file?\n\nThe originals will be kept. The combined file will appear in the trim card above.`)) return;

  const pill = document.getElementById('status-cut');
  const result = document.getElementById('result-cut');
  btn.disabled = true;
  pill.className = 'status-pill running';
  pill.textContent = 'stitching';
  result.innerHTML = '';
  result.classList.remove('visible', 'error');

  let finalFile = null;
  let errorMsg = null;
  let lastStatus = 'running';

  try {
    const res = await fetch('/api/live/auto-stitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, channel }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|[\r\n]/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('[file]')) finalFile = line.substring(6).trim();
        if (line.startsWith('[error]')) errorMsg = line.substring(7).trim();
        if (line.startsWith('[status]')) lastStatus = line.substring(8).trim();
      }
    }

    if (lastStatus === 'done' && finalFile) {
      pill.className = 'status-pill done';
      pill.textContent = 'stitched';
      result.innerHTML = `<strong>Stitched ${count} parts.</strong><div style="margin-top:4px;"><strong>→</strong> ${escapeHtmlStr(finalFile)}</div>`;
      result.classList.add('visible');
      // Force refresh so the trim card picks up the new latestOutput
      setTimeout(refreshLive, 500);
    } else {
      pill.className = 'status-pill error';
      pill.textContent = 'error';
      result.innerHTML = '<strong>Stitch failed.</strong>' + (errorMsg ? '<br>' + escapeHtmlStr(errorMsg) : '');
      result.classList.add('visible', 'error');
    }
  } catch (err) {
    pill.className = 'status-pill error';
    pill.textContent = 'error';
    result.innerHTML = '<strong>Error:</strong> ' + escapeHtmlStr(err.message);
    result.classList.add('visible', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-cut-file').addEventListener('click', async () => {
  if (!cutCardFile) return;
  const btn = document.getElementById('btn-cut-file');
  const pill = document.getElementById('status-cut');
  const result = document.getElementById('result-cut');
  const keepOriginal = document.getElementById('cut-keep-original').checked;

  btn.disabled = true;
  pill.className = 'status-pill running';
  pill.textContent = 'cutting';
  result.innerHTML = '';
  result.classList.remove('visible', 'error');

  let finalFile = null;
  let errorMsg = null;
  let lastStatus = 'running';

  try {
    const res = await fetch('/api/cut-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: cutCardFile,
        startTime: document.getElementById('cut-start').value,
        endTime: document.getElementById('cut-end').value,
        keepOriginal,
      }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|[\r\n]/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('[file]')) finalFile = line.substring(6).trim();
        if (line.startsWith('[error]')) errorMsg = line.substring(7).trim();
        if (line.startsWith('[status]')) lastStatus = line.substring(8).trim();
      }
    }

    if (lastStatus === 'done' && finalFile) {
      pill.className = 'status-pill done';
      pill.textContent = 'done';
      result.innerHTML = `<strong>Done.</strong><div style="margin-top:4px;"><strong>→</strong> ${escapeHtmlStr(finalFile)}</div>`;
      result.classList.add('visible');
      // Reset inputs after successful cut
      document.getElementById('cut-start').value = '';
      document.getElementById('cut-end').value = '';
      // Refresh to update file path (old one may have been deleted)
      setTimeout(refreshLive, 500);
    } else {
      pill.className = 'status-pill error';
      pill.textContent = 'error';
      result.innerHTML = '<strong>Cut failed.</strong>' + (errorMsg ? '<br>' + escapeHtmlStr(errorMsg) : '');
      result.classList.add('visible', 'error');
    }
  } catch (err) {
    pill.className = 'status-pill error';
    pill.textContent = 'error';
    result.innerHTML = '<strong>Error:</strong> ' + escapeHtmlStr(err.message);
    result.classList.add('visible', 'error');
  } finally {
    btn.disabled = false;
  }
});

function renderLiveWatchers(data) {
  const list = document.getElementById('watchers-list');
  if (!data.watchers || data.watchers.length === 0) {
    list.innerHTML = '';
    if (window.emptyState && window.icons) {
      list.appendChild(window.emptyState({
        icon: window.icons.live,
        title: 'No channels being watched',
        body: 'Pick a platform and add a channel name above to start auto-recording streams the moment they go live.',
      }));
    }
    return;
  }

  let html = '';
  for (const w of data.watchers) {
    const isRec = w.isRecording;
    const isPaused = w.paused && !isRec;
    const cardClass = isRec ? 'watcher-card recording' : 'watcher-card';

    let pillClass, pillText;
    if (isRec) { pillClass = 'watcher-state-pill recording'; pillText = 'Recording'; }
    else if (isPaused) { pillClass = 'watcher-state-pill paused'; pillText = 'Paused'; }
    else { pillClass = 'watcher-state-pill polling'; pillText = 'Watching'; }

    let stats = '';
    stats += `<div><div class="watcher-stat-label">Last check</div><div class="watcher-stat-value">${w.lastCheck ? formatTimeAgo(w.lastCheck) : '—'}</div></div>`;

    if (isRec && w.recordingStartedAt) {
      stats += `<div><div class="watcher-stat-label">Recording for</div><div class="watcher-stat-value">${formatDuration(Date.now() - w.recordingStartedAt)}</div></div>`;
      stats += `<div><div class="watcher-stat-label">File size</div><div class="watcher-stat-value">${formatBytes(w.recordingSize || 0)}</div></div>`;
    } else if (isPaused) {
      const liveNow = w.lastStatus?.live;
      let pausedText = `Paused${liveNow ? ' (stream is live)' : ''}`;
      if (w.skipUntil) {
        const remainSec = Math.max(0, Math.round((w.skipUntil - Date.now()) / 1000));
        pausedText = `Skip-resume in ${secondsToHms(remainSec)}`;
      }
      stats += `<div><div class="watcher-stat-label">Auto-record</div><div class="watcher-stat-value" style="color: var(--warn);">${pausedText}</div></div>`;
    } else {
      const ls = w.lastStatus || {};
      const pollSec = w.pollIntervalMs ? Math.round(w.pollIntervalMs / 1000) : '—';
      if (ls.live === false && ls.error) {
        stats += `<div><div class="watcher-stat-label">Status</div><div class="watcher-stat-value" style="color: var(--danger);">Error: ${ls.error}</div></div>`;
      } else if (ls.live === false && ls.exists === false) {
        stats += `<div><div class="watcher-stat-label">Status</div><div class="watcher-stat-value" style="color: var(--danger);">Channel not found</div></div>`;
      } else {
        stats += `<div><div class="watcher-stat-label">Status</div><div class="watcher-stat-value">Offline (poll every ${pollSec}s)</div></div>`;
      }
      if (ls.viewers != null && ls.live) {
        stats += `<div><div class="watcher-stat-label">Viewers</div><div class="watcher-stat-value">${ls.viewers.toLocaleString()}</div></div>`;
      }
    }

    if (isRec && w.lastStatus?.title) {
      stats += `<div style="grid-column: 1 / -1;"><div class="watcher-stat-label">Current stream title</div><div class="watcher-stat-value">${escapeHtmlStr(w.lastStatus.title)}</div></div>`;
    } else if (!isRec && w.lastStatus?.live && w.lastStatus?.title) {
      stats += `<div style="grid-column: 1 / -1;"><div class="watcher-stat-label">Stream title</div><div class="watcher-stat-value">${escapeHtmlStr(w.lastStatus.title)}</div></div>`;
    }

    const platformAttr = `data-platform="${escapeHtmlStr(w.platform)}" data-channel="${escapeHtmlStr(w.channel)}"`;
    let buttons = '';
    if (isRec) {
      // Split: keep recording, just chunk the file. Most common while live.
      buttons += `<button class="watcher-btn primary" data-action="split" ${platformAttr} title="Finalize this file and immediately start a new one — auto-record stays on">✂ Split here</button>`;
      // Skip: stop now, auto-resume after N minutes (defaults to 15).
      buttons += `<span class="watcher-skip-inline" title="Stop recording, auto-resume in N minutes">`
        + `<input type="number" min="1" max="1440" step="1" value="15" ${platformAttr} data-role="skip-minutes">`
        + `<span>min</span>`
        + `<button data-action="skip" ${platformAttr}>Skip</button>`
        + `</span>`;
      // Stop: full halt, also pauses auto-record.
      buttons += `<button class="watcher-btn danger" data-action="stop-recording" ${platformAttr}>Stop &amp; pause</button>`;
    } else if (isPaused) {
      buttons += `<button class="watcher-btn primary" data-action="resume" ${platformAttr}>${w.skipUntil ? 'Resume now' : 'Resume auto-record'}</button>`;
    }
    buttons += `<button class="watcher-btn" data-action="unwatch" ${platformAttr}>Unwatch</button>`;

    const badgeClass = `platform-badge ${w.platform}`;
    const badgeText = escapeHtmlStr(w.platformDisplayName || w.platform);

    html += `
      <div class="${cardClass}">
        <div class="watcher-header">
          <div class="watcher-name"><span class="${badgeClass}">${badgeText}</span>${escapeHtmlStr(w.channel)}</div>
          <div class="${pillClass}">${pillText}</div>
        </div>
        <div class="watcher-body">${stats}</div>
        ${w.currentFile && isRec ? `<div class="watcher-file">${escapeHtmlStr(w.currentFile)}</div>` : ''}
        <div class="watcher-actions">${buttons}</div>
      </div>
    `;
  }
  list.innerHTML = html;
}

function escapeHtmlStr(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function stopRecording(platform, channel) {
  if (!confirm(`Stop the current recording of ${channel}?\n\nThe file so far will be kept. Auto-recording will be paused until you hit Resume.`)) return;
  await fetch('/api/live/stop-recording', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, channel }),
  });
  refreshLive();
}

async function splitRecording(platform, channel) {
  // No confirmation — split is a quick, non-destructive operation; the user
  // just wants to chunk the file. The previous chunk is preserved on disk.
  const res = await fetch('/api/live/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, channel }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert('Split failed: ' + (body.error || res.status));
  }
  refreshLive();
}

async function skipRecording(platform, channel, minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    alert('Enter how many minutes to skip (positive number).');
    return;
  }
  if (!confirm(`Stop recording now and auto-resume in ${minutes} min?\n\nUseful for skipping known segments. You can also resume sooner via the Resume button.`)) return;
  const res = await fetch('/api/live/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, channel, minutes }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert('Skip failed: ' + (body.error || res.status));
  }
  refreshLive();
}

async function resumeWatcher(platform, channel) {
  await fetch('/api/live/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, channel }),
  });
  refreshLive();
}

async function unwatchChannel(platform, channel) {
  if (!confirm(`Stop watching ${channel}?\n\nAny ongoing recording will be stopped and the file kept.`)) return;
  await fetch('/api/live/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, channel, killRecording: true }),
  });
  refreshLive();
}

// Delegated click handler for watcher action buttons
document.getElementById('watchers-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const platform = btn.dataset.platform;
  const channel = btn.dataset.channel;
  if (!platform || !channel) return;
  if (action === 'stop-recording') stopRecording(platform, channel);
  else if (action === 'resume') resumeWatcher(platform, channel);
  else if (action === 'unwatch') unwatchChannel(platform, channel);
  else if (action === 'split') splitRecording(platform, channel);
  else if (action === 'skip') {
    // Pull the minutes value from the sibling input on the same watcher card.
    const wrap = btn.closest('.watcher-skip-inline');
    const minutesInput = wrap ? wrap.querySelector('input[data-role="skip-minutes"]') : null;
    const minutes = minutesInput ? parseFloat(minutesInput.value) : 15;
    skipRecording(platform, channel, minutes);
  }
});

// Per-platform input hint and placeholder so the user knows what to paste.
const PLATFORM_HINTS = {
  kick: {
    placeholder: 'Channel name (e.g. mizkif)',
    hint: 'The app polls Kick every 5s for live status. Recording starts automatically when the stream goes live.',
  },
  twitch: {
    placeholder: 'Twitch login or twitch.tv URL',
    hint: 'The app polls Twitch every 30s via yt-dlp. Recording starts automatically when the stream goes live.',
  },
  youtube: {
    placeholder: '@handle, channel ID, or YouTube URL',
    hint: 'The app polls YouTube every 30s for a live broadcast on this channel. Recording starts automatically when one starts.',
  },
};

function applyPlatformHint() {
  const platform = document.getElementById('live-platform').value;
  const cfg = PLATFORM_HINTS[platform] || PLATFORM_HINTS.kick;
  document.getElementById('live-username').placeholder = cfg.placeholder;
  document.getElementById('live-input-hint').textContent = cfg.hint;
}
document.getElementById('live-platform').addEventListener('change', applyPlatformHint);
applyPlatformHint();

document.getElementById('btn-add-watcher').addEventListener('click', async () => {
  const input = document.getElementById('live-username');
  const platform = document.getElementById('live-platform').value;
  const channel = input.value.trim();
  if (!channel) { alert('Enter a channel name first.'); return; }

  try {
    const res = await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, channel }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert('Error: ' + (err.error || 'unknown'));
      return;
    }
    input.value = '';
    refreshLive();
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

document.getElementById('live-username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-add-watcher').click();
});

// Refresh every 2 seconds while on the Live tab, every 10 seconds otherwise
let liveRefreshInterval = null;
function setLiveRefreshRate(fast) {
  if (liveRefreshInterval) clearInterval(liveRefreshInterval);
  liveRefreshInterval = setInterval(refreshLive, fast ? 2000 : 10000);
}

window.addEventListener('page-changed', (e) => {
  if (e.detail.page === 'live') {
    refreshLive();
    setLiveRefreshRate(true);
  } else if (['download', 'stitch', 'cleanup', 'settings'].includes(e.detail.page)) {
    setLiveRefreshRate(false);
  }
});



// ---------- Quality presets + settings ----------
// State shared across the three chip surfaces (download form, live form,
// settings page). The download chip is per-job (kept only in memory). The
// live + settings chips read from / write to /api/settings.
const qualityState = {
  presets: [],            // [{id, label}]
  appSettings: null,      // last fetched settings object
  downloadPreset: null,   // not persisted; resets to settings.qualityDefault on load
};

const PLATFORM_LIST = [
  { id: 'kick', label: 'Kick' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'youtube', label: 'YouTube' },
];

function findPreset(id) {
  return qualityState.presets.find(p => p.id === id);
}

function renderChipRow(targetEl, selectedId, onSelect) {
  if (!targetEl) return;
  targetEl.innerHTML = '';
  for (const p of qualityState.presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quality-chip' + (p.id === selectedId ? ' active' : '');
    btn.textContent = p.label;
    btn.dataset.preset = p.id;
    btn.addEventListener('click', () => onSelect(p.id));
    targetEl.appendChild(btn);
  }
}

function renderDownloadChips() {
  renderChipRow(
    document.getElementById('quality-chips-download'),
    qualityState.downloadPreset,
    (id) => { qualityState.downloadPreset = id; renderDownloadChips(); updateDownloadHint(); },
  );
}

function updateDownloadHint() {
  const el = document.getElementById('quality-hint-download');
  if (!el) return;
  const p = findPreset(qualityState.downloadPreset);
  el.textContent = p ? `${p.label} — used for this download only.` : '';
}

function renderLiveChips() {
  const settings = qualityState.appSettings || {};
  renderChipRow(
    document.getElementById('quality-chips-live'),
    settings.qualityDefault,
    async (id) => {
      // Live tab chip change updates the global default. Per-platform overrides
      // (set in Settings) still take precedence at recording time.
      await saveSettings({ qualityDefault: id });
      renderAllQualityUI();
    },
  );
  const el = document.getElementById('quality-hint-live');
  if (el) {
    const p = findPreset(settings.qualityDefault);
    el.textContent = p
      ? `${p.label} — applies to new recordings. Existing recordings aren't affected. Per-platform overrides in Settings take precedence.`
      : '';
  }
}

function renderSettingsQualityChips() {
  const settings = qualityState.appSettings || {};
  renderChipRow(
    document.getElementById('quality-chips-settings'),
    settings.qualityDefault,
    async (id) => {
      await saveSettings({ qualityDefault: id });
      renderAllQualityUI();
    },
  );
  const el = document.getElementById('quality-hint-settings');
  if (el) {
    const p = findPreset(settings.qualityDefault);
    el.textContent = p ? `Default: ${p.label}` : '';
  }
}

function renderPerPlatformOverrides() {
  const wrap = document.getElementById('quality-per-platform');
  if (!wrap) return;
  const settings = qualityState.appSettings || {};
  const overrides = settings.qualityPerPlatform || {};
  wrap.innerHTML = '';
  for (const plat of PLATFORM_LIST) {
    const row = document.createElement('div');
    row.className = 'quality-per-platform-row';
    const badge = document.createElement('span');
    badge.className = `platform-badge ${plat.id}`;
    badge.textContent = plat.label;
    row.appendChild(badge);

    const sel = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— use default —';
    sel.appendChild(noneOpt);
    for (const p of qualityState.presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    sel.value = overrides[plat.id] || '';
    sel.addEventListener('change', async () => {
      const next = { ...overrides, [plat.id]: sel.value || null };
      await saveSettings({ qualityPerPlatform: next });
      renderAllQualityUI();
    });
    row.appendChild(sel);
    wrap.appendChild(row);
  }
}

function renderAdvancedQualityToggle() {
  const settings = qualityState.appSettings || {};
  const toggle = document.getElementById('setting-advanced-quality');
  const field = document.getElementById('custom-format-field');
  const input = document.getElementById('setting-custom-format');
  if (!toggle || !field || !input) return;
  toggle.checked = !!settings.advancedQualityEnabled;
  field.style.display = settings.advancedQualityEnabled ? '' : 'none';
  input.value = settings.customFormat || '';
}

function renderChatToggles() {
  const settings = qualityState.appSettings || {};
  const live = document.getElementById('setting-chat-live');
  const vod  = document.getElementById('setting-chat-vod');
  if (live) live.checked = !!settings.chatLiveEnabled;
  if (vod)  vod.checked  = !!settings.chatVodReplayEnabled;
  // Mirror the per-job download checkbox to the saved default so the user
  // doesn't have to tick it every time.
  const dlChat = document.getElementById('dl-include-chat');
  if (dlChat) dlChat.checked = !!settings.chatVodReplayEnabled;
}

// ---------- Cookies.txt import ----------
async function refreshCookiesStatus() {
  const pill = document.getElementById('cookies-status');
  const clearBtn = document.getElementById('btn-cookies-clear');
  const importBtn = document.getElementById('btn-cookies-import');
  if (!pill || !clearBtn || !importBtn) return;
  if (!window.electron || !window.electron.cookiesStatus) {
    pill.textContent = 'unavailable';
    return;
  }
  try {
    const status = await window.electron.cookiesStatus();
    if (status && status.exists) {
      const ago = friendlyAgo(status.savedAtMs);
      pill.textContent = `imported (${ago})`;
      pill.style.color = 'var(--accent)';
      clearBtn.style.display = '';
      importBtn.textContent = 'Re-import cookies.txt';
    } else {
      pill.textContent = 'no cookies imported';
      pill.style.color = '';
      clearBtn.style.display = 'none';
      importBtn.textContent = 'Import cookies.txt';
    }
  } catch (err) {
    pill.textContent = 'error';
    console.error('[cookies] status check failed', err);
  }
}

function friendlyAgo(ms) {
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function renderAllQualityUI() {
  renderDownloadChips();
  updateDownloadHint();
  renderLiveChips();
  renderSettingsQualityChips();
  renderPerPlatformOverrides();
  renderAdvancedQualityToggle();
  renderChatToggles();
}

async function saveSettings(patch) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    qualityState.appSettings = await res.json();
  } catch (err) {
    console.error('[settings] save failed:', err);
  }
}

async function loadQualityAndSettings() {
  try {
    const [presetsRes, settingsRes] = await Promise.all([
      fetch('/api/quality/presets').then(r => r.json()),
      fetch('/api/settings').then(r => r.json()),
    ]);
    qualityState.presets = presetsRes.presets || [];
    qualityState.appSettings = settingsRes;
    // Download tab always defaults to 'source' regardless of the global default
    // (which controls live recording). Source = highest available, no compromises.
    qualityState.downloadPreset = 'source';
    renderAllQualityUI();
  } catch (err) {
    console.error('[quality] failed to load presets/settings:', err);
  }
}

// Wire settings page toggles (advanced quality + custom format + chat).
document.addEventListener('DOMContentLoaded', () => {
  const advToggle = document.getElementById('setting-advanced-quality');
  if (advToggle) {
    advToggle.addEventListener('change', async () => {
      await saveSettings({ advancedQualityEnabled: advToggle.checked });
      renderAdvancedQualityToggle();
    });
  }
  const customInput = document.getElementById('setting-custom-format');
  if (customInput) {
    let timer = null;
    customInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => saveSettings({ customFormat: customInput.value }), 400);
    });
  }
  const chatLive = document.getElementById('setting-chat-live');
  if (chatLive) chatLive.addEventListener('change', () => saveSettings({ chatLiveEnabled: chatLive.checked }));
  const chatVod = document.getElementById('setting-chat-vod');
  if (chatVod) chatVod.addEventListener('change', () => saveSettings({ chatVodReplayEnabled: chatVod.checked }));
  const importBtn = document.getElementById('btn-cookies-import');
  if (importBtn && window.electron && window.electron.cookiesImport) {
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      try {
        const result = await window.electron.cookiesImport();
        if (result && result.ok) {
          alert(`Imported ${result.count || 0} cookies. yt-dlp will use them on the next download.`);
        } else if (result && result.canceled) {
          // User canceled the file picker — say nothing.
        } else if (result && !result.ok) {
          alert('Import failed: ' + (result.error || 'unknown'));
        }
      } catch (err) {
        alert('Import error: ' + err.message);
      } finally {
        importBtn.disabled = false;
        refreshCookiesStatus();
      }
    });
  }

  const clearCookiesBtn = document.getElementById('btn-cookies-clear');
  if (clearCookiesBtn && window.electron && window.electron.cookiesClear) {
    clearCookiesBtn.addEventListener('click', async () => {
      if (!confirm('Clear the imported cookies? yt-dlp will fall back to no cookies (or your browser-cookies dropdown if set).')) return;
      try {
        await window.electron.cookiesClear();
      } catch (err) {
        alert('Clear failed: ' + err.message);
      }
      refreshCookiesStatus();
    });
  }

  // Open the "where to get the extension" links in the user's real browser
  // (clicking inside Electron's main window would just navigate the app away).
  document.querySelectorAll('a[data-extlink]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = a.getAttribute('data-extlink');
      if (url && window.electron && window.electron.openExternal) {
        window.electron.openExternal(url);
      }
    });
  });

  refreshCookiesStatus();
});

loadQualityAndSettings();

// Initial load
refreshLive();
setLiveRefreshRate(false);

// =================================================================
// REPLAY TAB — save the last N seconds of an active recording as a
//              standalone clip. Shows one card per active recording
//              + a list of recent replays at the bottom.
// =================================================================
const replayState = {
  duration: 30,        // currently-selected duration in seconds (per UI)
  busy: new Set(),     // watcher keys currently extracting (prevents double-click)
  activeKeys: [],      // tracks which active-recording keys we've rendered
};

function renderReplayActiveList(watchers) {
  const container = document.getElementById('replay-active-list');
  if (!container) return;

  const recording = watchers.filter(w => w.isRecording);
  if (recording.length === 0) {
    container.innerHTML = `
      <div class="replay-active-card idle">
        <div style="font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">Nothing's recording right now</div>
        <div style="font-size: var(--fs-sm); color: var(--text-tertiary);">Replays save the last few seconds of an active recording. Start a watcher in <strong>Live capture</strong> and come back here.</div>
      </div>
    `;
    return;
  }

  let html = '';
  for (const w of recording) {
    const elapsed = w.recordingStartedAt ? formatDuration(Date.now() - w.recordingStartedAt) : '—';
    const sizeBit = w.recordingSize ? ` · ${formatBytes(w.recordingSize)}` : '';
    const platformAttr = `data-platform="${escapeHtmlStr(w.platform)}" data-channel="${escapeHtmlStr(w.channel)}"`;
    const key = w.platform + ':' + w.channel;
    const busy = replayState.busy.has(key);
    html += `
      <div class="replay-active-card">
        <div class="replay-active-head">
          <span class="platform-badge ${escapeHtmlStr(w.platform)}">${escapeHtmlStr(w.platformDisplayName || w.platform)}</span>
          <span class="replay-active-name">${escapeHtmlStr(w.channel)}</span>
          <span class="replay-active-meta">recording ${elapsed}${sizeBit}</span>
        </div>
        <div class="replay-actions">
          <button class="replay-btn" data-action="save" ${platformAttr} ${busy ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            ${busy ? 'Saving…' : `Save last ${replayState.duration}s`}
          </button>
          <div class="replay-duration-picker" role="tablist" aria-label="Replay duration">
            <button data-duration="15" class="${replayState.duration === 15 ? 'active' : ''}">15s</button>
            <button data-duration="30" class="${replayState.duration === 30 ? 'active' : ''}">30s</button>
            <button data-duration="60" class="${replayState.duration === 60 ? 'active' : ''}">60s</button>
            <button data-duration="120" class="${replayState.duration === 120 ? 'active' : ''}">2m</button>
          </div>
          <span class="replay-feedback" data-feedback ${platformAttr}></span>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

async function refreshReplayHistory(watchers) {
  // Aggregate replays from every recording watcher's session(s). The
  // /api/live/replays endpoint already de-dupes across recordingHistory.
  const list = document.getElementById('replay-history-list');
  if (!list) return;
  const all = [];
  for (const w of watchers) {
    try {
      const res = await fetch(`/api/live/replays?platform=${encodeURIComponent(w.platform)}&channel=${encodeURIComponent(w.channel)}`);
      const body = await res.json();
      for (const r of (body.replays || [])) {
        all.push({ ...r, channel: w.channel, platform: w.platform });
      }
    } catch (e) { /* ignore per-watcher errors */ }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (all.length === 0) {
    list.innerHTML = `<div class="hint" style="padding: 20px 0;">No replays saved yet. Hit a button above while a recording is active.</div>`;
    return;
  }

  let html = '';
  for (const r of all.slice(0, 50)) {
    const ago = formatTimeAgo ? formatTimeAgo(r.mtimeMs) : new Date(r.mtimeMs).toLocaleString();
    const safePath = escapeHtmlStr(r.path);
    html += `
      <div class="replay-row">
        <div class="replay-row-name" title="${safePath}">${escapeHtmlStr(r.name)}</div>
        <div class="replay-row-meta">${escapeHtmlStr(r.channel)}</div>
        <div class="replay-row-meta">${formatBytes(r.sizeBytes)}</div>
        <div class="replay-row-meta">${escapeHtmlStr(ago)}</div>
        <button data-action="play" data-path="${safePath}" title="Play in default player">▶ Play</button>
      </div>
    `;
  }
  list.innerHTML = html;
}

async function refreshReplayTab() {
  // Pull the current watcher list (Live capture endpoint, already shared)
  // so the active card list is in sync with what's actually recording.
  try {
    const res = await fetch('/api/live');
    const data = await res.json();
    const watchers = data.watchers || [];
    renderReplayActiveList(watchers);
    refreshReplayHistory(watchers);
  } catch (err) {
    const c = document.getElementById('replay-active-list');
    if (c) c.innerHTML = `<div class="replay-active-card idle"><div style="color: var(--danger);">Failed to load: ${escapeHtmlStr(err.message)}</div></div>`;
  }
}

async function saveReplay(platform, channel, durationSec, btn) {
  const key = platform + ':' + channel;
  if (replayState.busy.has(key)) return;
  replayState.busy.add(key);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }
  // Locate the feedback span on this card so we can show success/error inline.
  const card = btn ? btn.closest('.replay-active-card') : null;
  const feedback = card ? card.querySelector('[data-feedback]') : null;
  if (feedback) { feedback.classList.remove('visible', 'error'); feedback.textContent = ''; }

  try {
    const res = await fetch('/api/live/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, channel, durationSec }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (feedback) {
        feedback.classList.add('visible', 'error');
        feedback.textContent = `Failed: ${body.error || res.status}`;
      } else {
        alert('Replay failed: ' + (body.error || res.status));
      }
      return;
    }
    if (feedback) {
      feedback.classList.add('visible');
      feedback.textContent = `Saved ${formatBytes(body.sizeBytes)} ✓`;
      setTimeout(() => feedback.classList.remove('visible'), 4000);
    }
  } catch (err) {
    if (feedback) {
      feedback.classList.add('visible', 'error');
      feedback.textContent = `Error: ${err.message}`;
    }
  } finally {
    replayState.busy.delete(key);
    refreshReplayTab();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const activeList = document.getElementById('replay-active-list');
  if (activeList) {
    // Save button click + duration picker click handled with delegation since
    // the cards are re-rendered on each refresh.
    activeList.addEventListener('click', (e) => {
      const durBtn = e.target.closest('.replay-duration-picker button[data-duration]');
      if (durBtn) {
        replayState.duration = parseInt(durBtn.dataset.duration, 10) || 30;
        refreshReplayTab();
        return;
      }
      const saveBtn = e.target.closest('.replay-btn[data-action="save"]');
      if (saveBtn) {
        saveReplay(saveBtn.dataset.platform, saveBtn.dataset.channel, replayState.duration, saveBtn);
      }
    });
  }

  const historyList = document.getElementById('replay-history-list');
  if (historyList) {
    historyList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="play"]');
      if (!btn) return;
      const filePath = btn.dataset.path;
      if (filePath && window.electron && window.electron.libraryOpenFile) {
        window.electron.libraryOpenFile(filePath);
      }
    });
  }
});

// Reload the Replay tab when entering it, and tick periodically while it's
// the active page so the "recording for X" timer updates without a refresh.
let replayTickInterval = null;
window.addEventListener('page-changed', (e) => {
  if (!e.detail) return;
  if (e.detail.page === 'replay') {
    refreshReplayTab();
    if (replayTickInterval) clearInterval(replayTickInterval);
    replayTickInterval = setInterval(refreshReplayTab, 3000);
  } else if (replayTickInterval) {
    clearInterval(replayTickInterval);
    replayTickInterval = null;
  }
});

// =================================================================
// LIBRARY TAB — grid view of every video in the output folder,
//               with lazy-loaded thumbnails and a right-click menu.
// =================================================================
const libraryState = {
  items: [],
  filtered: [],
  search: '',
  sort: 'newest',
  ctxTarget: null, // path of the right-clicked card
};

function formatBytesShortLib(n) {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function libraryDateString(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function applyLibraryFilters() {
  const term = libraryState.search.trim().toLowerCase();
  let arr = libraryState.items;
  if (term) {
    arr = arr.filter(it =>
      (it.title || '').toLowerCase().includes(term) ||
      (it.filename || '').toLowerCase().includes(term) ||
      (it.subtitle || '').toLowerCase().includes(term)
    );
  }
  switch (libraryState.sort) {
    case 'newest':   arr = arr.slice().sort((a, b) => b.mtimeMs - a.mtimeMs); break;
    case 'oldest':   arr = arr.slice().sort((a, b) => a.mtimeMs - b.mtimeMs); break;
    case 'largest':  arr = arr.slice().sort((a, b) => b.sizeBytes - a.sizeBytes); break;
    case 'smallest': arr = arr.slice().sort((a, b) => a.sizeBytes - b.sizeBytes); break;
    case 'title':    arr = arr.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
  }
  libraryState.filtered = arr;
  renderLibraryGrid();
}

function escapeHtmlSimple(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderLibraryGrid() {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  const count = document.getElementById('library-count');
  if (!grid || !empty || !count) return;

  const items = libraryState.filtered;
  count.textContent = items.length === libraryState.items.length
    ? `${items.length} video${items.length === 1 ? '' : 's'}`
    : `${items.length} of ${libraryState.items.length}`;

  if (items.length === 0) {
    grid.innerHTML = '';
    empty.hidden = libraryState.items.length === 0 ? false : true;
    if (libraryState.items.length > 0 && libraryState.search) {
      // We have items, but the search filtered them all out — show an empty
      // state inline rather than the "no videos yet" message.
      empty.hidden = false;
      empty.querySelector('.library-empty-title').textContent = 'No matches';
      empty.querySelector('.library-empty-hint').textContent = `Nothing matches "${libraryState.search}".`;
    } else {
      empty.querySelector('.library-empty-title').textContent = 'No videos yet';
      empty.querySelector('.library-empty-hint').textContent = "Your output folder is empty. Download or record something and it'll show up here.";
    }
    return;
  }
  empty.hidden = true;

  // Build cards. We don't include thumbnails inline — IntersectionObserver
  // populates them lazily so a 500-video library doesn't fire 500 ffmpeg
  // probes on first render.
  let html = '';
  for (const it of items) {
    const platformClass = it.platform ? `library-card-platform ${escapeHtmlSimple(it.platform)}` : 'library-card-platform';
    const platformLabel = it.platform || '';
    html += `
      <div class="library-card" data-path="${escapeHtmlSimple(it.path)}">
        <div class="library-card-thumb" data-thumb-path="${escapeHtmlSimple(it.path)}">
          <div class="library-card-thumb-placeholder">loading…</div>
          ${platformLabel ? `<span class="${platformClass}">${escapeHtmlSimple(platformLabel)}</span>` : ''}
          <span class="library-card-size">${formatBytesShortLib(it.sizeBytes)}</span>
        </div>
        <div class="library-card-body">
          <div class="library-card-title">${escapeHtmlSimple(it.title || it.filename)}</div>
          ${it.subtitle ? `<div class="library-card-subtitle">${escapeHtmlSimple(it.subtitle)}</div>` : ''}
          <div class="library-card-meta">${libraryDateString(it.mtimeMs)}</div>
        </div>
      </div>
    `;
  }
  grid.innerHTML = html;
  observeLibraryThumbs();
}

// IntersectionObserver: load thumbnails only as cards scroll into view.
let libraryThumbObserver = null;
function observeLibraryThumbs() {
  if (libraryThumbObserver) libraryThumbObserver.disconnect();
  libraryThumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      libraryThumbObserver.unobserve(wrap);
      const filePath = wrap.dataset.thumbPath;
      if (!filePath) continue;
      const img = new Image();
      img.onload = () => {
        // Replace the placeholder with the real image.
        const placeholder = wrap.querySelector('.library-card-thumb-placeholder');
        if (placeholder) placeholder.remove();
        wrap.insertBefore(img, wrap.firstChild);
      };
      img.onerror = () => {
        // Leave the "loading…" placeholder text in place but make it say
        // "no preview" so the user knows generation failed (e.g. file gone,
        // codec ffmpeg can't read).
        const placeholder = wrap.querySelector('.library-card-thumb-placeholder');
        if (placeholder) placeholder.textContent = 'no preview';
      };
      img.src = '/api/library/thumbnail?path=' + encodeURIComponent(filePath);
    }
  }, { rootMargin: '200px 0px' });

  document.querySelectorAll('.library-card-thumb[data-thumb-path]').forEach(el => {
    libraryThumbObserver.observe(el);
  });
}

async function loadLibrary() {
  const grid = document.getElementById('library-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="library-empty-hint" style="padding: 24px;">Scanning…</div>';
  try {
    const res = await fetch('/api/library/list');
    const body = await res.json();
    libraryState.items = body.items || [];
  } catch (err) {
    grid.innerHTML = `<div class="library-empty-hint" style="padding: 24px; color: var(--danger);">Failed to load: ${err.message}</div>`;
    return;
  }
  applyLibraryFilters();
}

// Right-click context menu plumbing.
function showLibraryCtx(x, y, filePath) {
  const ctx = document.getElementById('library-ctx');
  if (!ctx) return;
  libraryState.ctxTarget = filePath;
  ctx.hidden = false;
  // Position, then constrain to viewport so it doesn't clip off screen.
  ctx.style.left = x + 'px';
  ctx.style.top = y + 'px';
  const rect = ctx.getBoundingClientRect();
  if (rect.right > window.innerWidth)  ctx.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) ctx.style.top = (window.innerHeight - rect.height - 4) + 'px';
}
function hideLibraryCtx() {
  const ctx = document.getElementById('library-ctx');
  if (ctx) ctx.hidden = true;
  libraryState.ctxTarget = null;
}

async function libraryAction(action, filePath) {
  if (!filePath) return;
  if (action === 'play') {
    if (window.electron && window.electron.libraryOpenFile) {
      const r = await window.electron.libraryOpenFile(filePath);
      if (!r.ok) alert('Open failed: ' + (r.error || 'unknown'));
    }
  } else if (action === 'reveal') {
    if (window.electron && window.electron.libraryRevealFile) {
      await window.electron.libraryRevealFile(filePath);
    }
  } else if (action === 'cut') {
    // Switch to Cut tab and pre-load the file.
    const cutNav = document.querySelector('.nav-item[data-page="cut"]');
    if (cutNav) cutNav.click();
    setTimeout(() => loadCutTabFile(filePath), 50);
  } else if (action === 'delete') {
    if (!confirm(`Delete this video and its companion files?\n\n${filePath}\n\nThis can't be undone.`)) return;
    try {
      const res = await fetch('/api/library/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const body = await res.json();
      if (!res.ok) {
        alert('Delete failed: ' + (body.error || res.status));
      }
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
    loadLibrary();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('btn-library-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadLibrary);

  const search = document.getElementById('library-search');
  if (search) {
    search.addEventListener('input', () => {
      libraryState.search = search.value;
      applyLibraryFilters();
    });
  }
  const sort = document.getElementById('library-sort');
  if (sort) {
    sort.addEventListener('change', () => {
      libraryState.sort = sort.value;
      applyLibraryFilters();
    });
  }

  // Click on a card → play. Right-click → context menu.
  const grid = document.getElementById('library-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.library-card');
      if (!card) return;
      libraryAction('play', card.dataset.path);
    });
    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.library-card');
      if (!card) return;
      e.preventDefault();
      showLibraryCtx(e.clientX, e.clientY, card.dataset.path);
    });
  }

  // Context menu item click + global dismiss handlers.
  const ctx = document.getElementById('library-ctx');
  if (ctx) {
    ctx.addEventListener('click', (e) => {
      const btn = e.target.closest('.library-ctx-item');
      if (!btn) return;
      const action = btn.dataset.action;
      const filePath = libraryState.ctxTarget;
      hideLibraryCtx();
      libraryAction(action, filePath);
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.library-ctx')) hideLibraryCtx();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideLibraryCtx();
  });
  window.addEventListener('blur', hideLibraryCtx);
});

// Reload the library each time the user navigates to the Library tab so it
// reflects fresh recordings without needing a manual refresh.
window.addEventListener('page-changed', (e) => {
  if (e.detail && e.detail.page === 'library') {
    loadLibrary();
  }
});

// =================================================================
// CUT TAB — pick a local video, dual-handle slider, ffmpeg trim
// =================================================================
//
// State for the Cut tab. Independent from the Download trim picker so they
// can both be used without stepping on each other.
const cutTabState = {
  filePath: null,
  durationSec: 0,
};

function setCutTabSliderEnabled(enabled) {
  const start = document.getElementById('cut-tab-start-slider');
  const end = document.getElementById('cut-tab-end-slider');
  if (start) start.disabled = !enabled;
  if (end) end.disabled = !enabled;
  const btn = document.getElementById('btn-start-cut-tab');
  if (btn) btn.disabled = !enabled;
}

function updateCutTabFill() {
  const start = document.getElementById('cut-tab-start-slider');
  const end = document.getElementById('cut-tab-end-slider');
  const fill = document.getElementById('cut-tab-fill');
  if (!start || !end || !fill) return;
  const max = parseInt(start.max, 10) || 1;
  const a = Math.min(parseInt(start.value, 10) || 0, parseInt(end.value, 10) || max);
  const b = Math.max(parseInt(start.value, 10) || 0, parseInt(end.value, 10) || max);
  fill.style.left = `${(a / max) * 100}%`;
  fill.style.right = `${100 - (b / max) * 100}%`;
}

function syncCutTabSlidersFromInputs() {
  if (cutTabState.durationSec <= 0) return;
  const startSec = parseTimeInput(document.getElementById('cut-tab-start').value);
  const endSec = parseTimeInput(document.getElementById('cut-tab-end').value);
  const startSlider = document.getElementById('cut-tab-start-slider');
  const endSlider = document.getElementById('cut-tab-end-slider');
  if (startSlider) startSlider.value = startSec != null ? Math.min(startSec, cutTabState.durationSec) : 0;
  if (endSlider)   endSlider.value   = endSec   != null ? Math.min(endSec,   cutTabState.durationSec) : cutTabState.durationSec;
  updateCutTabFill();
}

function syncCutTabInputsFromSliders() {
  const startSlider = document.getElementById('cut-tab-start-slider');
  const endSlider = document.getElementById('cut-tab-end-slider');
  if (!startSlider || !endSlider) return;
  let a = parseInt(startSlider.value, 10) || 0;
  let b = parseInt(endSlider.value, 10) || cutTabState.durationSec;
  // Keep handles ordered so the user can't drag start past end.
  if (a > b) { const t = a; a = b; b = t; startSlider.value = a; endSlider.value = b; }
  document.getElementById('cut-tab-start').value = a > 0 ? secondsToHms(a) : '';
  document.getElementById('cut-tab-end').value   = b < cutTabState.durationSec ? secondsToHms(b) : '';
  updateCutTabFill();
}

async function loadCutTabFile(filePath) {
  cutTabState.filePath = filePath;
  cutTabState.durationSec = 0;
  document.getElementById('cut-tab-file-path').value = filePath;
  document.getElementById('cut-tab-file-meta').textContent = 'Probing…';
  document.getElementById('cut-tab-trim-section').style.display = 'none';
  setCutTabSliderEnabled(false);

  try {
    const res = await fetch('/api/probe-file?path=' + encodeURIComponent(filePath));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      document.getElementById('cut-tab-file-meta').textContent = `Probe failed: ${body.error || res.status}`;
      return;
    }
    cutTabState.durationSec = body.durationSec || 0;
    const meta = [];
    if (body.durationSec)               meta.push(secondsToHms(Math.round(body.durationSec)));
    if (body.width && body.height)      meta.push(`${body.width}×${body.height}`);
    if (body.videoCodec)                meta.push(body.videoCodec);
    if (body.sizeBytes)                 meta.push(formatBytes(body.sizeBytes));
    document.getElementById('cut-tab-file-meta').textContent = meta.join(' · ') || 'Loaded.';

    if (cutTabState.durationSec > 0) {
      const startSlider = document.getElementById('cut-tab-start-slider');
      const endSlider = document.getElementById('cut-tab-end-slider');
      startSlider.max = cutTabState.durationSec;
      startSlider.value = 0;
      endSlider.max = cutTabState.durationSec;
      endSlider.value = cutTabState.durationSec;
      document.getElementById('cut-tab-start').value = '';
      document.getElementById('cut-tab-end').value = '';
      document.getElementById('cut-tab-duration-display').textContent = `total ${secondsToHms(Math.round(cutTabState.durationSec))}`;
      document.getElementById('cut-tab-trim-section').style.display = '';
      setCutTabSliderEnabled(true);
      updateCutTabFill();
    }
  } catch (err) {
    document.getElementById('cut-tab-file-meta').textContent = `Probe error: ${err.message}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const pickBtn = document.getElementById('btn-cut-tab-pick');
  if (pickBtn) {
    pickBtn.addEventListener('click', async () => {
      if (!window.electron || !window.electron.pickVideoFile) {
        alert('File picker unavailable — make sure you are running the latest installed build.');
        return;
      }
      const filePath = await window.electron.pickVideoFile();
      if (filePath) loadCutTabFile(filePath);
    });
  }

  const startSlider = document.getElementById('cut-tab-start-slider');
  const endSlider = document.getElementById('cut-tab-end-slider');
  if (startSlider) startSlider.addEventListener('input', syncCutTabInputsFromSliders);
  if (endSlider)   endSlider.addEventListener('input', syncCutTabInputsFromSliders);

  const startInput = document.getElementById('cut-tab-start');
  const endInput = document.getElementById('cut-tab-end');
  if (startInput) startInput.addEventListener('blur', syncCutTabSlidersFromInputs);
  if (endInput)   endInput.addEventListener('blur', syncCutTabSlidersFromInputs);

  const cutBtn = document.getElementById('btn-start-cut-tab');
  if (cutBtn) {
    cutBtn.addEventListener('click', () => {
      if (!cutTabState.filePath) { alert('Pick a file first.'); return; }
      const startSec = parseTimeInput(document.getElementById('cut-tab-start').value);
      const endSec = parseTimeInput(document.getElementById('cut-tab-end').value);
      const keepOriginal = document.getElementById('cut-tab-keep-original').checked;
      streamJob('cut-tab', '/api/cut-file', {
        path: cutTabState.filePath,
        startTime: startSec != null ? secondsToHms(startSec) : '',
        endTime:   endSec   != null ? secondsToHms(endSec)   : '',
        keepOriginal,
      });
    });
  }

  const cancelBtn = document.getElementById('btn-cancel-cut-tab');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      await fetch('/api/cancel', { method: 'POST' });
    });
  }
});


