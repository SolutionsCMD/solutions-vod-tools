// Platform dispatch table for live capture.
//
// Each platform implements the same shape:
//   - id: string identifier ('kick' | 'twitch' | 'youtube')
//   - displayName: shown in UI
//   - normalize(input): user input → canonical channel identifier (or null if invalid)
//   - validate(channel): boolean — channel is well-formed for this platform
//   - streamUrl(channel): the URL we hand to yt-dlp for both detection and recording
//   - checkLive(channel, ctx): { live, exists?, title?, viewers?, error? }
//   - pollIntervalMs: how often the watcher polls
//
// ctx exposes shared helpers the platform might need:
//   ctx.ytdlpPath, ctx.spawn, ctx.fetch

const KICK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- Generic yt-dlp probe ----------
// Slow (3-5s) but works for any site yt-dlp supports without API credentials.
// Used as the primary detector for Twitch/YouTube and as Kick's Cloudflare fallback.
function ytdlpProbe(url, ctx) {
  return new Promise((resolve) => {
    const p = ctx.spawn(ctx.ytdlpPath, [
      '--dump-json',
      '--no-download',
      '--quiet',
      '--no-warnings',
      '--no-playlist',
      url,
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('error', () => resolve({ live: false, error: 'probe failed' }));
    p.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const info = JSON.parse(stdout.trim().split('\n')[0]);
          resolve({
            live: info.is_live !== false,
            exists: true,
            title: info.title || info.fulltitle || null,
            viewers: info.concurrent_view_count || info.view_count || 0,
          });
        } catch (e) {
          resolve({ live: false, error: 'probe parse failed' });
        }
      } else {
        // yt-dlp exits non-zero when stream is offline / not found. We treat
        // "no such channel" the same as "offline" — the watcher card shows
        // last error if any, so it's not silent.
        const errText = stderr.trim().slice(-200);
        if (/not currently live|is offline|This live event will begin/i.test(errText)) {
          resolve({ live: false, exists: true });
        } else if (/Unable to (download|extract)|HTTP Error 404|404 Not Found/i.test(errText)) {
          resolve({ live: false, exists: false });
        } else {
          resolve({ live: false, exists: true });
        }
      }
    });
  });
}

// ---------- Kick ----------
async function checkKickLive(channel, ctx) {
  try {
    const res = await ctx.fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, {
      headers: {
        'User-Agent': KICK_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://kick.com/',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    if (res.status === 404) return { live: false, exists: false };
    if (res.status === 403) {
      // Cloudflare blocked — fall back to yt-dlp which handles this properly
      return await ytdlpProbe(`https://kick.com/${channel}`, ctx);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      live: !!data.livestream,
      exists: true,
      title: data.livestream?.session_title || null,
      startedAt: data.livestream?.created_at || null,
      viewers: data.livestream?.viewer_count || 0,
      // Used by chat capture to subscribe to the right Pusher channel.
      chatroomId: data.chatroom?.id || data.id || null,
    };
  } catch (err) {
    return { live: false, error: err.message };
  }
}

// ---------- Twitch ----------
function checkTwitchLive(channel, ctx) {
  return ytdlpProbe(`https://twitch.tv/${channel}`, ctx);
}

// ---------- YouTube ----------
// Accepts either a bare handle ("@channel") or a fully-qualified URL the user
// pasted. We normalize to a /live URL because that's the most reliable input
// for yt-dlp to resolve a "currently broadcasting" stream.
function youtubeStreamUrl(channel) {
  const c = channel.trim();
  if (/^https?:\/\//i.test(c)) {
    // User pasted a full URL — try to honor it, but make sure it ends in /live
    const trimmed = c.replace(/\/+$/, '');
    if (/\/live\b/i.test(trimmed)) return trimmed;
    return trimmed + '/live';
  }
  const handle = c.startsWith('@') ? c : '@' + c;
  return `https://www.youtube.com/${handle}/live`;
}

function checkYoutubeLive(channel, ctx) {
  return ytdlpProbe(youtubeStreamUrl(channel), ctx);
}

// ---------- Validators ----------
function validKick(channel) {
  return typeof channel === 'string' && /^[a-zA-Z0-9_.-]{1,50}$/.test(channel);
}

function validTwitch(channel) {
  // Twitch login: 3-25 chars, lowercase letters, numbers, underscore.
  return typeof channel === 'string' && /^[a-zA-Z0-9_]{3,25}$/.test(channel);
}

function validYoutube(channel) {
  if (typeof channel !== 'string' || !channel.trim()) return false;
  const c = channel.trim();
  // Accept full URLs to youtube.com/youtu.be
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(c)) return true;
  // Accept @handle (with or without @)
  if (/^@?[a-zA-Z0-9._-]{2,50}$/.test(c)) return true;
  // Accept channel ID (UC...)
  if (/^UC[a-zA-Z0-9_-]{20,24}$/.test(c)) return true;
  return false;
}

// ---------- Normalizers ----------
// Take whatever the user typed, return the canonical form we'll persist as
// the channel identifier. Returning null means "invalid input."
function normalizeKick(input) {
  if (!input || typeof input !== 'string') return null;
  const c = input.trim().toLowerCase();
  return validKick(c) ? c : null;
}

function normalizeTwitch(input) {
  if (!input || typeof input !== 'string') return null;
  let c = input.trim();
  // Strip a pasted URL down to the channel name
  const m = c.match(/^https?:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{3,25})/i);
  if (m) c = m[1];
  c = c.toLowerCase();
  return validTwitch(c) ? c : null;
}

function normalizeYoutube(input) {
  if (!input || typeof input !== 'string') return null;
  let c = input.trim();
  // If it's a YT URL, extract @handle or channel ID
  const handleMatch = c.match(/youtube\.com\/(@[a-zA-Z0-9._-]+)/i);
  if (handleMatch) return handleMatch[1];
  const channelIdMatch = c.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,24})/i);
  if (channelIdMatch) return channelIdMatch[1];
  const customMatch = c.match(/youtube\.com\/c\/([a-zA-Z0-9._-]+)/i);
  if (customMatch) return '@' + customMatch[1];
  // Bare @handle
  if (/^@[a-zA-Z0-9._-]{2,50}$/.test(c)) return c;
  // Bare handle without @
  if (/^[a-zA-Z0-9._-]{2,50}$/.test(c)) return '@' + c;
  // Bare channel ID
  if (/^UC[a-zA-Z0-9_-]{20,24}$/.test(c)) return c;
  return null;
}

// ---------- Dispatch table ----------
const PLATFORMS = {
  kick: {
    id: 'kick',
    displayName: 'Kick',
    normalize: normalizeKick,
    validate: validKick,
    streamUrl: (channel) => `https://kick.com/${channel}`,
    checkLive: checkKickLive,
    pollIntervalMs: 5000,
  },
  twitch: {
    id: 'twitch',
    displayName: 'Twitch',
    normalize: normalizeTwitch,
    validate: validTwitch,
    streamUrl: (channel) => `https://twitch.tv/${channel}`,
    checkLive: checkTwitchLive,
    pollIntervalMs: 30000,
  },
  youtube: {
    id: 'youtube',
    displayName: 'YouTube',
    normalize: normalizeYoutube,
    validate: validYoutube,
    streamUrl: youtubeStreamUrl,
    checkLive: checkYoutubeLive,
    pollIntervalMs: 30000,
  },
};

function getPlatform(id) {
  return PLATFORMS[id] || null;
}

function watcherKey(platform, channel) {
  return `${platform}:${channel}`;
}

function parseWatcherKey(key) {
  const idx = key.indexOf(':');
  if (idx < 0) return null;
  return { platform: key.slice(0, idx), channel: key.slice(idx + 1) };
}

module.exports = {
  PLATFORMS,
  getPlatform,
  watcherKey,
  parseWatcherKey,
};
