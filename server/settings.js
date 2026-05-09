// Persistent app settings (quality defaults, chat capture toggles, custom
// yt-dlp format string). Backed by a JSON file at
// %APPDATA%/Solutions VOD Tools/app-settings.json.
//
// The store is in-memory once loaded; writes are synchronous and atomic
// enough for our purposes (single process, no concurrent writers).

const fs = require('fs');
const { DEFAULT_PRESET, PRESETS } = require('./quality');

const DEFAULTS = {
  // Quality
  qualityDefault: DEFAULT_PRESET,           // preset id used when nothing else specified
  qualityPerPlatform: {                      // optional per-platform overrides for live recording
    kick: null,
    twitch: null,
    youtube: null,
  },
  customFormat: '',                          // raw yt-dlp -f string (used when preset='custom')
  advancedQualityEnabled: false,             // shows the custom -f field in Settings

  // Chat
  chatLiveEnabled: true,                     // capture chat during live recordings
  chatVodReplayEnabled: true,                // pull chat replay when downloading VODs (Twitch/YouTube)
};

function makeStore(filePath) {
  let state = { ...DEFAULTS };

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Shallow merge so a new field added in code defaults correctly even
      // if the persisted file is older.
      state = {
        ...DEFAULTS,
        ...raw,
        qualityPerPlatform: {
          ...DEFAULTS.qualityPerPlatform,
          ...(raw.qualityPerPlatform || {}),
        },
      };
    } catch (e) {
      console.error('[settings] failed to load, using defaults:', e.message);
      state = { ...DEFAULTS };
    }
  }

  function save() {
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[settings] failed to save:', e.message);
    }
  }

  // Validates and applies a partial settings update. Unknown fields are
  // silently dropped. Returns the new state.
  function update(patch) {
    if (!patch || typeof patch !== 'object') return state;

    if (typeof patch.qualityDefault === 'string' && PRESETS[patch.qualityDefault]) {
      state.qualityDefault = patch.qualityDefault;
    }
    if (patch.qualityPerPlatform && typeof patch.qualityPerPlatform === 'object') {
      for (const k of Object.keys(state.qualityPerPlatform)) {
        if (k in patch.qualityPerPlatform) {
          const v = patch.qualityPerPlatform[k];
          if (v === null || v === '' || v === undefined) {
            state.qualityPerPlatform[k] = null;
          } else if (typeof v === 'string' && PRESETS[v]) {
            state.qualityPerPlatform[k] = v;
          }
        }
      }
    }
    if (typeof patch.customFormat === 'string') {
      state.customFormat = patch.customFormat;
    }
    if (typeof patch.advancedQualityEnabled === 'boolean') {
      state.advancedQualityEnabled = patch.advancedQualityEnabled;
    }
    if (typeof patch.chatLiveEnabled === 'boolean') {
      state.chatLiveEnabled = patch.chatLiveEnabled;
    }
    if (typeof patch.chatVodReplayEnabled === 'boolean') {
      state.chatVodReplayEnabled = patch.chatVodReplayEnabled;
    }
    save();
    return state;
  }

  function get() {
    return state;
  }

  // For a given platform, returns the preset id we'd use as the default
  // (per-platform override > global default).
  function defaultPresetFor(platformId) {
    const override = state.qualityPerPlatform?.[platformId];
    if (override && PRESETS[override]) return override;
    return state.qualityDefault;
  }

  load();
  return { get, update, defaultPresetFor, DEFAULTS };
}

module.exports = { makeStore, DEFAULTS };
