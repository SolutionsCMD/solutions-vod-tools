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
function startKickChat(channel, sessionDir, log, lastStatus) {
  if (!WebSocketLib) {
    log(`[chat] kick chat unavailable: 'ws' module not loaded`);
    return { stop: () => {} };
  }

  const chatFile = path.join(sessionDir, 'chat.jsonl');
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;

  // We need the chatroom_id from the channel info. Prefer the value already
  // returned by checkKickLive(), fall back to fetching it ourselves.
  async function resolveChatroomId() {
    if (lastStatus && lastStatus.chatroomId) return lastStatus.chatroomId;
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, {
        headers: { 'User-Agent': KICK_UA, 'Accept': 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.chatroom?.id || data.id || null;
    } catch (e) { return null; }
  }

  async function connect() {
    if (stopped) return;
    const chatroomId = await resolveChatroomId();
    if (!chatroomId) {
      log(`[chat] kick: could not resolve chatroom_id, retrying in 30s`);
      reconnectTimer = setTimeout(connect, 30000);
      return;
    }

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
      if (frame.event !== 'App\\Events\\ChatMessageEvent') return;
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
    });

    ws.on('error', (err) => log(`[chat] kick ws error: ${err.message}`));
    ws.on('close', () => {
      if (stopped) return;
      log(`[chat] kick ws closed, reconnecting in 5s`);
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
function startYoutubeChat(streamUrl, sessionDir, log, ytdlpPath) {
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
    streamUrl,
  ];

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
function startChatCapture({ platform, channel, sessionDir, lastStatus, streamUrl, ytdlpPath }, log) {
  const safeLog = (msg) => { try { log(msg); console.log(msg); } catch (e) { /* ignore */ } };
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch (e) { /* ignore */ }

  switch (platform) {
    case 'twitch':  return startTwitchChat(channel, sessionDir, safeLog);
    case 'kick':    return startKickChat(channel, sessionDir, safeLog, lastStatus);
    case 'youtube': return startYoutubeChat(streamUrl, sessionDir, safeLog, ytdlpPath);
    default:
      safeLog(`[chat] no chat capture for platform '${platform}'`);
      return { stop: () => {} };
  }
}

module.exports = { startChatCapture };
