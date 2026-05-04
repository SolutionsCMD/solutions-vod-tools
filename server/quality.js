// yt-dlp quality presets.
//
// Each preset returns the `-f` selector string we hand to yt-dlp. We keep
// these as fallback chains (`/`-separated) so that picking 1080p on a 480p
// source still works (it'll fall back to whatever's available).
//
// The `youtube-upload` preset prefers H.264 + AAC at 1080p60, which is what
// YouTube's ingestion pipeline is happiest with. No re-encoding — we just
// pick the right pre-encoded rendition if the source has one, then fall
// back to "best 1080p".

const PRESETS = {
  source:    { label: 'Source',          format: 'bv*+ba/b' },
  '1080p60': { label: '1080p60',         format: 'bv*[height<=1080][fps<=60]+ba/b[height<=1080]' },
  '1080p':   { label: '1080p',           format: 'bv*[height<=1080][fps<=30]+ba/b[height<=1080]' },
  '720p':    { label: '720p',            format: 'bv*[height<=720]+ba/b[height<=720]' },
  '480p':    { label: '480p',            format: 'bv*[height<=480]+ba/b[height<=480]' },
  audio:     { label: 'Audio only',      format: 'ba/b' },
  'youtube-upload': {
    label: 'YouTube upload',
    format: 'bv*[height<=1080][fps<=60][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080][fps<=60]+ba/b[height<=1080]',
  },
};

const DEFAULT_PRESET = 'source';

// The complete preset list, in display order. Used by the UI to render the
// chip row.
const PRESET_ORDER = ['source', '1080p60', '1080p', '720p', '480p', 'audio', 'youtube-upload'];

function listPresets() {
  return PRESET_ORDER.map(id => ({ id, label: PRESETS[id].label }));
}

// Resolve a quality choice to a yt-dlp -f string.
//   choice: { preset?: string, custom?: string }
//   fallback: preset id used when choice is missing / invalid (settings default)
function resolveFormat(choice, fallback) {
  if (choice && typeof choice.custom === 'string' && choice.custom.trim()) {
    return choice.custom.trim();
  }
  if (choice && typeof choice.preset === 'string' && PRESETS[choice.preset]) {
    return PRESETS[choice.preset].format;
  }
  if (fallback && PRESETS[fallback]) return PRESETS[fallback].format;
  return PRESETS[DEFAULT_PRESET].format;
}

// True if the preset id (or 'custom') is recognized.
function isValidChoice(choice) {
  if (!choice) return false;
  if (typeof choice.custom === 'string' && choice.custom.trim()) return true;
  return typeof choice.preset === 'string' && !!PRESETS[choice.preset];
}

module.exports = {
  PRESETS,
  PRESET_ORDER,
  DEFAULT_PRESET,
  listPresets,
  resolveFormat,
  isValidChoice,
};
