/* ============================================================
   Solutions VOD Tools — UI shell
   Sidebar nav, title bar, status bar, toasts, settings page.
   Loaded BEFORE app.js so app.js can call window.toast(), etc.
   ============================================================ */

(() => {

// -----------------------------------------------------------
// Sidebar navigation
// -----------------------------------------------------------
const navItems = document.querySelectorAll('.nav-item');
const pages    = document.querySelectorAll('.page');

function navigate(pageId) {
  navItems.forEach(b => b.classList.toggle('active', b.dataset.page === pageId));
  pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + pageId));
  // Fire a custom event so app.js can refresh tab-specific data
  window.dispatchEvent(new CustomEvent('page-changed', { detail: { page: pageId } }));
}
navItems.forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.page)));

// Expose for app.js (which previously referenced .tab-btn[data-tab=...])
window.navigateTo = navigate;

// -----------------------------------------------------------
// Title bar — window controls via IPC bridge
// -----------------------------------------------------------
// The preload script exposes window.electron with min/max/close.
// If preload isn't loaded (e.g. opened in browser), the buttons no-op.
const electronAPI = window.electron || null;

document.getElementById('win-min')?.addEventListener('click', () => electronAPI?.windowMinimize?.());
document.getElementById('win-max')?.addEventListener('click', () => electronAPI?.windowToggleMaximize?.());
document.getElementById('win-close')?.addEventListener('click', () => electronAPI?.windowClose?.());

// -----------------------------------------------------------
// Toast system — global API at window.toast(message, opts)
// -----------------------------------------------------------
const toastRegion = document.getElementById('toast-region');
let toastSeq = 0;

function toast(message, opts = {}) {
  const id = ++toastSeq;
  const variant = opts.type || 'info';            // info | success | error | warn
  const title   = opts.title || null;
  const ttl     = opts.duration ?? 4500;          // ms; pass 0 to make sticky

  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  el.dataset.id = id;

  const html = [];
  if (title) html.push(`<div class="toast-title">${escapeHtml(title)}</div>`);
  html.push(`<div class="toast-body">${escapeHtml(message)}</div>`);
  html.push(`<button class="toast-close" aria-label="Dismiss">&times;</button>`);
  el.innerHTML = html.join('');

  el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el));
  toastRegion.appendChild(el);

  if (ttl > 0) {
    setTimeout(() => dismissToast(el), ttl);
  }
  return id;
}
function dismissToast(el) {
  if (!el || el.classList.contains('exiting')) return;
  el.classList.add('exiting');
  setTimeout(() => el.remove(), 200);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
window.toast = toast;

// -----------------------------------------------------------
// Empty-state factory — used by app.js for empty lists
// -----------------------------------------------------------
window.emptyState = function emptyState({ icon, title, body }) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <div class="empty-state-icon">${icon || ''}</div>
    <div class="empty-state-title">${escapeHtml(title || '')}</div>
    <div class="empty-state-body">${escapeHtml(body || '')}</div>
  `;
  return wrap;
};

// SVG icons used across empty states (kept here so they're consistent)
window.icons = {
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  live:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 5a7 7 0 0 0-7 7"/><path d="M12 5a7 7 0 0 1 7 7"/></svg>`,
  stitch:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="6" height="12" rx="1"/><rect x="15" y="6" width="6" height="12" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/></svg>`,
  cleanup:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`,
};

// -----------------------------------------------------------
// Status bar
// -----------------------------------------------------------
const elServerDot     = document.getElementById('server-dot');
const elServerStatus  = document.getElementById('server-status');
const elJobsCount     = document.getElementById('jobs-count');
const elWatchersCount = document.getElementById('watchers-count');
const elOutputPath    = document.getElementById('status-output-path');
const elStatusOutput  = document.getElementById('status-output');

window.statusBar = {
  setServer(state, message) {
    elServerDot.className = 'statusbar-dot' + (state === 'warn' ? ' warn' : state === 'error' ? ' error' : '');
    elServerStatus.textContent = `Server: ${message || state}`;
  },
  setJobs(n) { elJobsCount.textContent = n; },
  setWatchers(n) { elWatchersCount.textContent = n; },
  setOutputPath(p) {
    elOutputPath.textContent = p || '—';
    elStatusOutput.title = p ? `Open: ${p}` : '';
  },
};

// Click status-bar output path → open folder
elStatusOutput.addEventListener('click', () => {
  if (electronAPI?.openOutputFolder) electronAPI.openOutputFolder();
});

// -----------------------------------------------------------
// Settings page
// -----------------------------------------------------------
async function loadSettingsPage() {
  if (!electronAPI?.getSettings) return;
  try {
    const s = await electronAPI.getSettings();
    document.getElementById('app-version').textContent      = 'v' + s.version;
    document.getElementById('about-version').textContent    = 'v' + s.version;
    document.getElementById('update-status').textContent    = 'v' + s.version;
    document.getElementById('setting-output-dir').value     = s.outputDir || '';
    document.getElementById('setting-autostart').checked    = !!s.autostart;
    window.statusBar.setOutputPath(s.outputDir);
  } catch (err) {
    console.error('[shell] settings load:', err);
  }
}

document.getElementById('setting-autostart')?.addEventListener('change', async (e) => {
  if (!electronAPI?.setAutostart) return;
  try {
    await electronAPI.setAutostart(e.target.checked);
    toast(e.target.checked ? 'App will run on startup' : 'Startup disabled', { type: 'success' });
  } catch (err) {
    toast('Failed to update setting: ' + err.message, { type: 'error' });
    e.target.checked = !e.target.checked;
  }
});

document.getElementById('btn-open-output')?.addEventListener('click', () => {
  electronAPI?.openOutputFolder?.();
});

document.getElementById('btn-check-update')?.addEventListener('click', async () => {
  if (!electronAPI?.checkForUpdates) return;
  toast('Checking for updates…', { type: 'info', duration: 2000 });
  try {
    await electronAPI.checkForUpdates();
  } catch (err) {
    toast('Update check failed: ' + err.message, { type: 'error' });
  }
});

document.getElementById('link-github')?.addEventListener('click', (e) => {
  e.preventDefault();
  electronAPI?.openExternal?.(e.target.href);
});

// Re-load settings whenever the user navigates to settings
window.addEventListener('page-changed', (e) => {
  if (e.detail.page === 'settings') loadSettingsPage();
});

// First-load: pull version from Electron (or fall back to fetching from server)
loadSettingsPage();

})(); // end IIFE
