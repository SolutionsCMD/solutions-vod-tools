// Chat capture for live recordings.
//
// All three platforms write to <sessionDir>/chat.jsonl in a normalized
// shape (one JSON object per line):
//   {ts, user, color?, badges?, text}
// where `ts` is Unix epoch milliseconds. This keeps the file replay-able
// later without platform-specific knowledge.
//
// Strategy per platform:
//   - twitch: WebSocket IRC (anonymous justinfan<n>) → live PRIVMSG → jsonl
//   - kick:   Pusher WebSocket subscribed to chatrooms.<id>.v2 → jsonl
//   - youtube: spawn yt-dlp --write-subs --sub-langs live_chat (writes its
//              own raw file). On stop, normalize it into chat.jsonl.
//
// Failures here are isolated — a chat connection drop or parse error must
// not crash the recording. Every entry point swallows errors and logs.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let WebSocketLib = null;
try { WebSocketLib = require('ws'); } catch (e) { /* installed at runtime */ }

const KICK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Pusher app key used by kick.com. This is published in their browser
// bundle; if Kick rotates it, chat will break and we'll need to update.
const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
const KICK_PUSHER_CLUSTER = 'us2';

// Append a line to chat.jsonl. Synchronous on purpose — chat is low-volume
// (a few messages per second at most) and we want ordering guarantees.
function appendChatLine(chatFile, entry) {
  try {
    fs.appendFileSync(chatFile, JSON.stringify(entry) + '\n');
  } catch (e) { /* ignore */ }
}

// ============================================================
// Twitch (IRC over WebSocket)
// ============================================================
function startTwitchChat(channel, sessionDir, log) {
  if (!WebSocketLib) {
    log(`[chat] twitch chat unavailable: 'ws' module not loaded`);
    return { stop: () => {} };
  }

  const chatFile = path.join(sessionDir, 'chat.jsonl');
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  const nick = 'justinfan' + Math.floor(Math.random() * 90000 + 10000);

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocketLib('wss://irc-ws.chat.twitch.tv:443');
    } catch (e) {
      log(`[chat] twitch ws ctor failed: ${e.message}`);
      return;
    }

    ws.on('open', () => {
      try {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send(`NICK ${nick}`);
        ws.send(`JOIN #${channel.toLowerCase()}`);
        log(`[chat] twitch connected as ${nick} -> #${channel}`);
      } catch (e) { log(`[chat] twitch handshake error: ${e.message}`); }
    });

    ws.on('message', (data) => {
      const text = data.toString();
      // Server sends multiple IRC lines per frame, separated by \r\n.
      for (const line of text.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) {
          try { ws.send('PONG ' + line.slice(5)); } catch (e) { /* ignore */ }
          continue;
        }
        const parsed = parseTwitchPrivmsg(line);
        if (parsed) appendChatLine(chatFile, parsed);
      }
    });

    ws.on('error', (err) => log(`[chat] twitch ws error: ${err.message}`));
    ws.on('close', () => {
      if (stopped) return;
      log(`[chat] twitch ws closed, reconnecting in 5s`);
      reconnectTimer = setTimeout(connect, 5000);
    });
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch (e) { /* ignore */ }
    },
  };
}

// Parse a Twitch IRC line with tags. Returns the unified entry or null.
function parseTwitchPrivmsg(line) {
  // Lines look like:
  //   @badges=sub/12;color=#FF0000;display-name=Foo;tmi-sent-ts=1730000000000;... :foo!foo@foo.tmi.twitch.tv PRIVMSG #channel :hello
  if (!line.includes(' PRIVMSG ')) return null;
  let tags = {};
  let rest = line;
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    const tagStr = line.slice(1, sp);
    rest = line.slice(sp + 1);
    for (const kv of tagStr.split(';')) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      tags[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  // rest = ":nick!user@host PRIVMSG #channel :message"
  const m = rest.match(/^:([^!]+)!\S+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return null;
  const user = tags['display-name'] || m[1];
  const text = m[2];
  const tsStr = tags['tmi-sent-ts'];
  const ts = tsStr ? parseInt(tsStr, 10) : Date.now();
  const entry = { ts, user, text };
  if (tags['color']) entry.color = tags['color'];
  if (tags['badges']) entry.badges = tags['badges'].split(',').filter(Boolean);
  return entry;
}

// ============================================================
// Kick (Pusher WebSocket)
// ============================================================

// yt-dlp's Kick extractor reaches the channels API server-side without the
// Cloudflare 403 we get from a direct fetch. Asking it for `--dump-json` on
// a Kick channel URL gets back a metadata blob whose shape varies by
// yt-dlp version. Returns { chatroomId?, channelId? } — chatroomId is the
// holy grail; channelId is a useful fallback we can pass to numeric-id
// API endpoints which sometimes have different Cloudflare protection.
function resolveViaYtdlp(ytdlpPath, channel, log) {
  return new Promise((resolve) => {
    const p = spawn(ytdlpPath, [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      '--no-playlist',
      `https://kick.com/${channel}`,
    ], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', (e) => {
      log(`[chat] kick: yt-dlp spawn failed: ${e.message}`);
      resolve(null);
    });
    p.on('close', (code) => {
      if (code !== 0 || !out.trim()) {
        log(`[chat] kick: yt-dlp exited ${code} with no JSON (stderr: ${err.trim().slice(-200)})`);
        resolve(null);
        return;
      }
      let info;
      try { info = JSON.parse(out.trim().split('\n')[0]); }
      catch (e) {
        log(`[chat] kick: yt-dlp JSON parse failed: ${e.message}`);
        resolve(null);
        return;
      }
      const chatroomId = findChatroomIdRecursive(info);
      const channelId = info?.channel_id ? parseInt(info.channel_id, 10) || null : null;
      if (chatroomId) {
        log(`[chat] kick: resolved chatroom_id ${chatroomId} via yt-dlp metadata`);
      } else {
        log(`[chat] kick: yt-dlp metadata had no chatroom-shaped field (top-level keys: ${Object.keys(info).slice(0,30).join(',')})${channelId ? ', will try numeric channel_id ' + channelId : ''}`);
      }
      resolve({ chatroomId, channelId });
    });
  });
}

// yt-dlp --write-pages dumps every HTTP response body to disk while doing
// extraction. The Kick extractor must hit /api/v2/channels/<channel> (or
// equivalent) to resolve the stream URL — that response WILL contain the
// chatroom info, even when --dump-json's output schema doesn't surface it.
// We spawn yt-dlp into a temp dir, scan the dumped pages for any matching
// chatroom_id pattern, then clean up.
function resolveChatroomIdViaWritePages(ytdlpPath, channel, log) {
  return new Promise((resolve) => {
    let tempDir;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-pages-'));
    } catch (e) {
      log(`[chat] kick: --write-pages tempdir creation failed: ${e.message}`);
      resolve(null);
      return;
    }

    const cleanup = () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    };

    const p = spawn(ytdlpPath, [
      '--write-pages',
      '--skip-download',
      '--no-warnings',
      '--no-playlist',
      '--paths', tempDir,
      // --write-pages dumps to the cwd, not -P, so also chdir there
      `https://kick.com/${channel}`,
    ], { windowsHide: true, cwd: tempDir });

    let stderr = '';
    p.stderr.on('data', d => stderr += d.toString());
    p.on('error', (e) => {
      log(`[chat] kick: --write-pages spawn failed: ${e.message}`);
      cleanup();
      resolve(null);
    });
    p.on('close', (code) => {
      let foundId = null;
      let scannedFiles = 0;
      try {
        // Walk the temp dir recursively; --write-pages may write into
        // subdirectories named after the extractor.
        const allFiles = walkDir(tempDir, []);
        scannedFiles = allFiles.length;
        for (const filePath of allFiles) {
          try {
            const stat = fs.statSync(filePath);
            // Skip very large files (recording fragments etc) and binary-ish
            // files with no text content.
            if (!stat.isFile() || stat.size > 5_000_000) continue;
            const content = fs.readFileSync(filePath, 'utf8');
            const m = content.match(/"chatroom"\s*:\s*\{[^}]*?"id"\s*:\s*(\d+)/) ||
                      content.match(/"chatroom_id"\s*:\s*(\d+)/) ||
                      content.match(/"chatroomId"\s*:\s*(\d+)/);
            if (m) {
              foundId = parseInt(m[1], 10);
              log(`[chat] kick: resolved chatroom_id ${foundId} via yt-dlp --write-pages (${path.basename(filePath)})`);
              break;
            }
          } catch (e) { /* ignore individual file errors */ }
        }
      } catch (e) {
        log(`[chat] kick: --write-pages scan failed: ${e.message}`);
      }

      if (!foundId) {
        log(`[chat] kick: --write-pages produced ${scannedFiles} files, none contained chatroom_id (yt-dlp exit ${code}, stderr tail: ${stderr.trim().slice(-200)})`);
      }
      cleanup();
      resolve(foundId);
    });
  });
}

function walkDir(dir, acc) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(p, acc);
      else acc.push(p);
    }
  } catch (e) { /* ignore */ }
  return acc;
}

function findChatroomIdRecursive(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [key, val] of Object.entries(obj)) {
    if (val == null) continue;
    if ((typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val))) &&
        /chat.?room.?id|chatroomid/i.test(key)) {
      return typeof val === 'number' ? val : parseInt(val, 10);
    }
    if (typeof val === 'object') {
      const found = findChatroomIdRecursive(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function startKickChat(channel, sessionDir, log, lastStatus, ytdlpPath) {
  if (!WebSocketLib) {
    log(`[chat] kick chat unavailable: 'ws' module not loaded`);
    return { stop: () => {} };
  }

  const chatFile = path.join(sessionDir, 'chat.jsonl');
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let resolveAttempts = 0;
  let firstMessageLogged = false;
  // Cap chatroom_id resolution attempts so we don't poll forever for a
  // channel whose API is fully Cloudflare-blocked.
  const MAX_RESOLVE_ATTEMPTS = 5;

  // Headers that look more browser-y to dodge Cloudflare's basic bot
  // heuristics. We'd be doing this in checkKickLive too, but that path
  // already has its own header set; this is the chat-specific resolver.
  const browserHeaders = {
    'User-Agent': KICK_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': `https://kick.com/${channel}`,
  };

  // We need the chatroom_id from the channel info. Try multiple sources in
  // order, logging each step so future failures are debuggable. Without
  // detailed logging "could not resolve chatroom_id" was a black box.
  async function resolveChatroomId() {
    if (lastStatus && lastStatus.chatroomId) {
      log(`[chat] kick: using chatroom_id ${lastStatus.chatroomId} from live-check`);
      return lastStatus.chatroomId;
    }

    // 1) v2 channels API
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, {
        headers: browserHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        const id = data?.chatroom?.id || data?.chatroom_id || data?.id || null;
        if (id) {
          log(`[chat] kick: resolved chatroom_id ${id} via v2 API`);
          return id;
        }
        log(`[chat] kick: v2 API 200 OK but no chatroom_id in payload (keys: ${Object.keys(data || {}).join(',')})`);
      } else {
        log(`[chat] kick: v2 API returned ${res.status} ${res.statusText}`);
      }
    } catch (e) {
      log(`[chat] kick: v2 API fetch threw: ${e.message}`);
    }

    // 2) v1 channels API (sometimes less aggressively protected than v2)
    try {
      const res = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(channel)}`, {
        headers: browserHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        const id = data?.chatroom?.id || data?.chatroom_id || data?.id || null;
        if (id) {
          log(`[chat] kick: resolved chatroom_id ${id} via v1 API`);
          return id;
        }
        log(`[chat] kick: v1 API 200 OK but no chatroom_id (keys: ${Object.keys(data || {}).join(',')})`);
      } else {
        log(`[chat] kick: v1 API returned ${res.status}`);
      }
    } catch (e) {
      log(`[chat] kick: v1 API fetch threw: ${e.message}`);
    }

    // 3) Channel page HTML — Kick embeds a __NEXT_DATA__ blob with channel
    //    metadata including chatroom_id. Less Cloudflare-friction than the
    //    JSON API endpoints.
    try {
      const res = await fetch(`https://kick.com/${encodeURIComponent(channel)}`, {
        headers: { ...browserHeaders, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      });
      if (res.ok) {
        const html = await res.text();
        // The structure can be `"chatroom":{...,"id":12345,...}` or
        // `"chatroom_id":12345` depending on rendering. Match either.
        const m = html.match(/"chatroom"\s*:\s*\{[^}]*?"id"\s*:\s*(\d+)/) ||
                  html.match(/"chatroom_id"\s*:\s*(\d+)/);
        if (m) {
          const id = parseInt(m[1], 10);
          log(`[chat] kick: resolved chatroom_id ${id} via channel page HTML`);
          return id;
        }
        log(`[chat] kick: channel page HTML loaded (${html.length} bytes) but no chatroom_id pattern matched`);
      } else {
        log(`[chat] kick: channel page HTML returned ${res.status}`);
      }
    } catch (e) {
      log(`[chat] kick: channel page HTML fetch threw: ${e.message}`);
    }

    // 4) yt-dlp --dump-json — yt-dlp's Kick extractor clearly bypasses
    //    Cloudflare (recordings work). Older versions don't surface
    //    chatroom_id in --dump-json output, but newer ones do.
    if (ytdlpPath) {
      try {
        const result = await resolveViaYtdlp(ytdlpPath, channel, log);
        if (result?.chatroomId) return result.chatroomId;
      } catch (e) {
        log(`[chat] kick: yt-dlp dump-json resolve threw: ${e.message}`);
      }
    } else {
      log(`[chat] kick: ytdlpPath not provided, skipping yt-dlp fallbacks`);
      return null;
    }

    // 5) yt-dlp --write-pages — the silver bullet when --dump-json doesn't
    //    expose chatroom_id. yt-dlp must be fetching the channels API
    //    successfully to get the stream URL; --write-pages dumps every
    //    HTTP response body to disk. We grep those for chatroom_id.
    try {
      const id = await resolveChatroomIdViaWritePages(ytdlpPath, channel, log);
      if (id) return id;
    } catch (e) {
      log(`[chat] kick: yt-dlp --write-pages threw: ${e.message}`);
    }

    return null;
  }

  async function connect() {
    if (stopped) return;
    const chatroomId = await resolveChatroomId();
    if (!chatroomId) {
      resolveAttempts++;
      if (resolveAttempts >= MAX_RESOLVE_ATTEMPTS) {
        log(`[chat] kick: gave up resolving chatroom_id after ${resolveAttempts} attempts. Chat will not be captured for this recording.`);
        return;
      }
      log(`[chat] kick: chatroom_id resolution failed (attempt ${resolveAttempts}/${MAX_RESOLVE_ATTEMPTS}), retrying in 30s`);
      reconnectTimer = setTimeout(connect, 30000);
      return;
    }
    // Reset the counter once we successfully resolved — websocket failures
    // shouldn't burn through the resolve budget.
    resolveAttempts = 0;

    const url = `wss://ws-${KICK_PUSHER_CLUSTER}.pusher.com/app/${KICK_PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;
    try {
      ws = new WebSocketLib(url);
    } catch (e) {
      log(`[chat] kick ws ctor failed: ${e.message}`);
      return;
    }

    ws.on('open', () => {
      log(`[chat] kick connected, subscribing to chatrooms.${chatroomId}.v2`);
      try {
        ws.send(JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
        }));
      } catch (e) { /* ignore */ }
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      let frame;
      try { frame = JSON.parse(text); } catch (e) { return; }
      // Pusher wraps messages: { event, channel, data: <stringified JSON> }
      if (frame.event !== 'App\\Events\\ChatMessageEvent') {
        // Log non-chat events once-each so we can see what Pusher is sending
        // (subscription_succeeded, etc.) — useful for diagnosing why we
        // might be subscribed but not receiving chat.
        return;
      }
      let payload;
      try { payload = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data; }
      catch (e) { return; }
      const entry = {
        ts: payload.created_at ? new Date(payload.created_at).getTime() : Date.now(),
        user: payload.sender?.username || 'unknown',
        text: payload.content || '',
      };
      const color = payload.sender?.identity?.color;
      if (color) entry.color = color;
      const badges = payload.sender?.identity?.badges;
      if (Array.isArray(badges) && badges.length) {
        entry.badges = badges.map(b => b.type).filter(Boolean);
      }
      appendChatLine(chatFile, entry);
      if (!firstMessageLogged) {
        firstMessageLogged = true;
        log(`[chat] kick: first message received from ${entry.user} — chat is flowing`);
      }
    });

    ws.on('error', (err) => log(`[chat] kick ws error: ${err.message}`));
    ws.on('close', (code, reason) => {
      if (stopped) return;
      log(`[chat] kick ws closed (code=${code} reason=${reason || ''}), reconnecting in 5s`);
      reconnectTimer = setTimeout(connect, 5000);
    });
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch (e) { /* ignore */ }
    },
  };
}

// ============================================================
// YouTube (yt-dlp live_chat sub track)
// ============================================================
// yt-dlp writes a .live_chat.json file with one action object per line. On
// stop we normalize it into chat.jsonl (unified format).
function startYoutubeChat(streamUrl, sessionDir, log, ytdlpPath, cookiesFromBrowser) {
  const rawTemplate = path.join(sessionDir, 'yt-chat');
  const chatFile = path.join(sessionDir, 'chat.jsonl');
  // yt-dlp writes <template>.<lang>.<ext> — for live_chat that's:
  //   yt-chat.live_chat.json
  const rawFile = rawTemplate + '.live_chat.json';

  const args = [
    '--skip-download',
    '--no-warnings',
    '--write-subs',
    '--sub-langs', 'live_chat',
    '-o', rawTemplate,
  ];
  // Cookies for age-gated / members-only / login-walled YouTube live streams.
  if (cookiesFromBrowser) {
    args.push('--cookies-from-browser', cookiesFromBrowser);
  }
  args.push(streamUrl);

  let stopped = false;
  let proc = null;
  try {
    proc = spawn(ytdlpPath, args, { windowsHide: true });
  } catch (e) {
    log(`[chat] youtube spawn failed: ${e.message}`);
    return { stop: () => {} };
  }

  proc.on('error', (err) => log(`[chat] youtube proc error: ${err.message}`));
  proc.on('close', (code) => {
    if (stopped) return;
    if (code !== 0 && code !== null) log(`[chat] youtube yt-dlp exited ${code}`);
  });

  return {
    stop: () => {
      stopped = true;
      try {
        if (process.platform === 'win32' && proc.pid) {
          require('child_process').spawnSync('taskkill', ['/pid', proc.pid, '/f', '/t'], { windowsHide: true });
        } else if (proc) {
          proc.kill('SIGTERM');
        }
      } catch (e) { /* ignore */ }
      // Normalize what yt-dlp wrote into chat.jsonl.
      normalizeYoutubeRaw(rawFile, chatFile, log);
    },
  };
}

function normalizeYoutubeRaw(rawFile, chatFile, log) {
  if (!fs.existsSync(rawFile)) return;
  let count = 0;
  try {
    const text = fs.readFileSync(rawFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      const entries = extractYoutubeChatEntries(obj);
      for (const e of entries) {
        out.push(JSON.stringify(e));
        count++;
      }
    }
    if (out.length) fs.appendFileSync(chatFile, out.join('\n') + '\n');
  } catch (e) {
    log(`[chat] youtube normalize failed: ${e.message}`);
  }
  log(`[chat] youtube normalized ${count} messages -> ${path.basename(chatFile)}`);
}

// Walk a yt-dlp live_chat action object and pull out any text messages.
// Both live and replay shapes are handled.
function extractYoutubeChatEntries(obj) {
  const out = [];
  // Replay shape: { replayChatItemAction: { actions: [...] } }
  let actions = [];
  if (obj.replayChatItemAction && Array.isArray(obj.replayChatItemAction.actions)) {
    actions = obj.replayChatItemAction.actions;
  } else if (obj.addChatItemAction) {
    actions = [{ addChatItemAction: obj.addChatItemAction }];
  } else if (Array.isArray(obj.actions)) {
    actions = obj.actions;
  }
  for (const a of actions) {
    const item = a.addChatItemAction?.item;
    if (!item) continue;
    const r = item.liveChatTextMessageRenderer;
    if (!r) continue;
    const tsUsec = r.timestampUsec ? parseInt(r.timestampUsec, 10) : null;
    const ts = tsUsec ? Math.floor(tsUsec / 1000) : Date.now();
    const user = r.authorName?.simpleText || 'unknown';
    const runs = r.message?.runs || [];
    const text = runs.map(run => run.text || (run.emoji?.shortcuts?.[0] || '')).join('');
    if (!text.trim()) continue;
    const entry = { ts, user, text };
    const badges = (r.authorBadges || []).map(b => b.liveChatAuthorBadgeRenderer?.tooltip).filter(Boolean);
    if (badges.length) entry.badges = badges;
    out.push(entry);
  }
  return out;
}

// ============================================================
// Public API
// ============================================================
function startChatCapture({ platform, channel, sessionDir, lastStatus, streamUrl, ytdlpPath, cookiesFromBrowser }, log) {
  // Write a per-session chat.log file alongside chat.jsonl so failures are
  // visible after the fact. Without this, chat capture errors only existed
  // in the in-memory watcher logTail, which vanishes the moment the app
  // restarts — making "where's chat.jsonl?" undebuggable.
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch (e) { /* ignore */ }
  const chatLogPath = path.join(sessionDir, 'chat.log');
  const safeLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try { fs.appendFileSync(chatLogPath, line + '\n'); } catch (e) { /* ignore */ }
    try { log(msg); console.log(msg); } catch (e) { /* ignore */ }
  };

  // Always emit a startup line so we can prove chat capture was at least
  // attempted, even if the platform-specific code dies before writing
  // anything else.
  safeLog(`[chat] starting capture: platform=${platform} channel=${channel} ws=${WebSocketLib ? 'available' : 'MISSING'}`);

  switch (platform) {
    case 'twitch':  return startTwitchChat(channel, sessionDir, safeLog);
    case 'kick':    return startKickChat(channel, sessionDir, safeLog, lastStatus, ytdlpPath);
    case 'youtube': return startYoutubeChat(streamUrl, sessionDir, safeLog, ytdlpPath, cookiesFromBrowser);
    default:
      safeLog(`[chat] no chat capture for platform '${platform}'`);
      return { stop: () => {} };
  }
}

// ============================================================
// VOD chat replay normalization (post-download)
// ============================================================
// After a VOD download finishes, yt-dlp may have left:
//   - <base>.info.json with a `comments` array (Twitch, with --write-comments)
//   - <base>.live_chat.json with action lines (YouTube, with --write-subs)
// This function looks at both and writes a unified chat.jsonl alongside.
//
// `infoJsonPath` and `liveChatPath` may be null/missing — we just skip those.
function normalizeVodChat({ platform, infoJsonPath, liveChatPath, outFile }, log = () => {}) {
  let count = 0;
  const out = [];

  if (platform === 'twitch' && infoJsonPath && fs.existsSync(infoJsonPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
      const comments = Array.isArray(info.comments) ? info.comments : [];
      for (const c of comments) {
        const entry = normalizeTwitchVodComment(c);
        if (entry) { out.push(JSON.stringify(entry)); count++; }
      }
    } catch (e) {
      log(`[chat] vod twitch parse failed: ${e.message}`);
    }
  }

  if (platform === 'youtube' && liveChatPath && fs.existsSync(liveChatPath)) {
    try {
      const text = fs.readFileSync(liveChatPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        const entries = extractYoutubeChatEntries(obj);
        for (const e of entries) { out.push(JSON.stringify(e)); count++; }
      }
    } catch (e) {
      log(`[chat] vod youtube parse failed: ${e.message}`);
    }
  }

  if (out.length) {
    try { fs.writeFileSync(outFile, out.join('\n') + '\n'); }
    catch (e) { log(`[chat] vod write failed: ${e.message}`); }
  }
  return count;
}

// Twitch VOD comments come in this shape (from GQL via yt-dlp):
//   { created_at, content_offset_seconds, commenter: {display_name, name},
//     message: { body, user_color, user_badges: [{_id,version}] } }
function normalizeTwitchVodComment(c) {
  if (!c || typeof c !== 'object') return null;
  const text = c.message?.body || c.message?.fragments?.map(f => f.text).join('') || '';
  if (!text) return null;
  const ts = c.created_at ? new Date(c.created_at).getTime() : Date.now();
  const entry = {
    ts,
    user: c.commenter?.display_name || c.commenter?.name || 'unknown',
    text,
  };
  if (c.content_offset_seconds != null) entry.offsetMs = Math.round(c.content_offset_seconds * 1000);
  if (c.message?.user_color) entry.color = c.message.user_color;
  const badges = c.message?.user_badges;
  if (Array.isArray(badges) && badges.length) {
    entry.badges = badges.map(b => b._id || b.id).filter(Boolean);
  }
  return entry;
}

// Detect the platform from a VOD URL. Returns 'kick' | 'twitch' | 'youtube'
// | null if it doesn't look like one of those.
function platformFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/(?:^|\/\/)(?:www\.)?kick\.com\//i.test(url)) return 'kick';
  if (/(?:^|\/\/)(?:www\.)?twitch\.tv\//i.test(url)) return 'twitch';
  if (/(?:^|\/\/)(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) return 'youtube';
  return null;
}

module.exports = { startChatCapture, normalizeVodChat, platformFromUrl };
