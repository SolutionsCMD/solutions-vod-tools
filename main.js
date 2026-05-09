// Solutions VOD Tools — Electron main process
//
// Responsibilities:
//   - Single-instance lock
//   - First-run setup (download yt-dlp + ffmpeg)
//   - Boot the Express server in-process
//   - Native window pointed at the local server
//   - System tray with menu (Open / Browser / VODs / Run on startup / Restart / Quit)
//   - Autostart-on-login (default ON after first install)
//
// Closing the window does NOT quit; it hides. Quit only via tray "Quit".

const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { createServer } = require('./server/server');
const { ensureBinaries } = require('./setup/dependencies');
const { autoUpdater } = require('electron-updater');

// -------- Logging --------
// Pipe electron-updater logs to a file at:
//   %APPDATA%\Solutions VOD Tools\logs\main.log
// We set this up BEFORE the single-instance lock check so that even an
// instance that bails out immediately leaves a breadcrumb.
let log = null;
let logFilePath = null;
try {
  log = require('electron-log');
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
  autoUpdater.logger = log;
  // Resolve the file path the user can open from the tray.
  try { logFilePath = log.transports.file.getFile().path; } catch (e) { /* older electron-log */ }
} catch (err) {
  console.error('[boot] electron-log not available:', err && err.message);
}
function logInfo(msg)  { try { log && log.info(msg); }  catch (e) {} console.log(msg); }
function logWarn(msg)  { try { log && log.warn(msg); }  catch (e) {} console.warn(msg); }
function logError(msg) { try { log && log.error(msg); } catch (e) {} console.error(msg); }

logInfo(`[boot] starting v${app.getVersion()} pid=${process.pid} exe=${process.execPath}`);
logInfo(`[boot] argv=${JSON.stringify(process.argv)}`);

// We prompt the user before installing, instead of letting electron-updater
// silently install on quit (would surprise people mid-recording).
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

// We don't have a code-signing certificate. Without one, electron-updater's
// publisher-name check rejects every new installer on Windows, which silently
// killed every auto-update attempt from v1.0.3 → v1.1.1. The package.json
// build config no longer sets publisherName (so future builds skip the
// check by default), and we explicitly disable signature verification here
// in case any inherited setting still tries to enforce it.
//
// If we ever buy a code-signing cert, remove this override and put
// publisherName back in the build config.
autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);

// -------- Single-instance lock --------
if (!app.requestSingleInstanceLock()) {
  logWarn(`[boot] another instance has the single-instance lock — exiting pid=${process.pid}`);
  app.quit();
  process.exit(0);
}
logInfo(`[boot] acquired single-instance lock`);

// -------- Paths --------
const PORT = 3847;
const APP_URL = `http://localhost:${PORT}`;

const userData   = app.getPath('userData');
const binDir     = path.join(userData, 'bin');
const stateFile  = path.join(userData, 'live-watchers.json');
const settingsFile = path.join(userData, 'app-settings.json');
const flagFirstRun = path.join(userData, '.first-run-done');
const outputDir  = path.join(app.getPath('videos'), 'Solutions VOD Tools');
// Cookies for yt-dlp's --cookies flag. Imported via the Settings tab from a
// Netscape cookies.txt the user exports from their real browser using a
// "Get cookies.txt" extension. Sidesteps the DPAPI issues that break
// --cookies-from-browser for Chrome/Edge, and Google's WebView block that
// prevents in-app sign-in.
const cookiesFile = path.join(userData, 'cookies.txt');
const publicDir  = path.join(__dirname, 'public');
const iconPath   = path.join(__dirname, 'build', 'icon.ico');

for (const d of [userData, binDir, outputDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// -------- State --------
let mainWindow   = null;
let setupWindow  = null;
let tray         = null;
let serverHandle = null;
let isQuitting   = false;
let updateDownloaded = false;

// -------- Main window --------
function createMainWindow() {
  if (mainWindow) {
    showMainWindow();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    icon: iconPath,
    title: 'Solutions VOD Tools',
    backgroundColor: '#0e0e10',
    show: false,
    frame: false,                  // custom title bar — see public/index.html .titlebar
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(APP_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Closing the window hides it; the app keeps running in the tray.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// -------- Tray --------
function buildTrayMenu() {
  const loginSettings = app.getLoginItemSettings();
  const items = [];

  // If an update has been downloaded, surface it at the top of the menu.
  if (updateDownloaded) {
    items.push({
      label: 'Restart to install update',
      click: () => {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      },
    });
    items.push({ type: 'separator' });
  }

  items.push(
    { label: 'Open', click: showMainWindow },
    { label: 'Open in browser', click: () => shell.openExternal(APP_URL) },
    { label: 'Open VODs folder',  click: () => shell.openPath(outputDir) },
    { type: 'separator' },
    {
      label: 'Run on startup',
      type: 'checkbox',
      checked: loginSettings.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: true,
        });
      },
    },
    { type: 'separator' },
    { label: 'Restart server', click: restartServer },
    { label: 'Check for updates', click: checkForUpdatesManually },
  );

  // If the last update attempt failed, surface it so the user can act on it
  // without having to dig through log files.
  if (lastUpdateError) {
    items.push({
      label: 'Last update error: ' + lastUpdateError.slice(0, 60) + (lastUpdateError.length > 60 ? '…' : ''),
      click: () => {
        dialog.showMessageBox({
          type: 'warning',
          title: 'Last update error',
          message: 'Auto-updater hit this error:',
          detail: lastUpdateError + '\n\nTry "Check for updates" again, or open the log file for context.',
          buttons: ['OK'],
        });
      },
    });
  }

  // Diagnostics — give the user one-click access to the log file. Critical
  // when "nothing happens" symptoms show up, since we can't reach into their
  // shell to grep it.
  items.push({ type: 'separator' });
  items.push({
    label: 'Open log file',
    enabled: !!logFilePath,
    click: () => {
      if (logFilePath) shell.openPath(logFilePath);
    },
  });
  items.push({
    label: 'Open log folder',
    click: () => {
      if (logFilePath) shell.showItemInFolder(logFilePath);
      else shell.openPath(path.join(userData, 'logs'));
    },
  });

  items.push({ type: 'separator' });
  items.push(
    { label: `Solutions VOD Tools v${app.getVersion()}`, enabled: false },
    { label: 'Quit', click: quitApp },
  );

  return Menu.buildFromTemplate(items);
}

function createTray() {
  tray = new Tray(iconPath);
  tray.setToolTip('Solutions VOD Tools');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', showMainWindow);
  tray.on('click', () => {
    // On Windows a single left-click on the tray icon also shows the window
    // (matches behavior most users expect from chat apps, etc.)
    showMainWindow();
  });
}

// -------- Server lifecycle --------
async function startServer() {
  serverHandle = await createServer({
    port: PORT,
    outputDir,
    binDir,
    stateFile,
    settingsFile,
    publicDir,
    cookiesFile,
  });
  console.log('[main] server up');
}

async function stopServer() {
  if (!serverHandle) return;
  try { await serverHandle.shutdown(); } catch (err) { console.error('[main] shutdown error', err); }
  serverHandle = null;
}

async function restartServer() {
  await stopServer();
  await startServer();
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.reload();
}

async function quitApp() {
  isQuitting = true;
  await stopServer();
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
}

// -------- Auto-updater --------
let manualCheckInProgress = false;
// Track whether we've already started downloading an update during this run.
// If we have, an `error` event after that point means the download failed —
// historically we silently swallowed it; v1.1.1 surfaces it.
let downloadStarted = false;
// Last updater error we saw, exposed via the tray menu so users can copy it.
let lastUpdateError = null;

autoUpdater.on('error', (err) => {
  const msg = (err && err.message) || String(err);
  logError(`[updater] error: ${msg}`);
  lastUpdateError = msg;
  if (tray) tray.setContextMenu(buildTrayMenu());

  if (manualCheckInProgress) {
    manualCheckInProgress = false;
    if (!isNoReleaseYetError(err)) {
      dialog.showErrorBox('Update check failed', msg);
    } else {
      dialog.showMessageBox({
        type: 'info',
        title: 'Up to date',
        message: `You're on the latest version (${app.getVersion()}).`,
      });
    }
    return;
  }

  // Background path: a download was in flight and just failed. Don't bug the
  // user every time, but DO surface it once so they don't sit waiting forever
  // for an "Update ready" prompt that will never come.
  if (downloadStarted && !isNoReleaseYetError(err)) {
    downloadStarted = false;
    dialog.showMessageBox({
      type: 'warning',
      title: 'Update download failed',
      message: 'The update download did not complete.',
      detail:
        msg +
        '\n\nYou can try again from the tray menu (Check for updates), ' +
        'or download the new installer directly from GitHub releases. ' +
        'Open the log file from the tray menu for full details.',
      buttons: ['OK'],
    });
  }
});

autoUpdater.on('checking-for-update', () => {
  console.log('[updater] checking-for-update');
});

autoUpdater.on('update-available', (info) => {
  logInfo(`[updater] update available: ${info && info.version}`);
  // autoDownload is true, so the download starts immediately after this fires.
  downloadStarted = true;
  if (manualCheckInProgress) {
    manualCheckInProgress = false;
    dialog.showMessageBox({
      type: 'info',
      title: 'Update found',
      message: `Solutions VOD Tools ${info.version} is being downloaded`,
      detail: 'You\'ll see another prompt when the download finishes (typically 10-30 seconds).',
      buttons: ['OK'],
    });
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[updater] no update available, current:', app.getVersion(), 'latest:', info && info.version);
  if (manualCheckInProgress) {
    manualCheckInProgress = false;
    dialog.showMessageBox({
      type: 'info',
      title: 'Up to date',
      message: `You're on the latest version (${app.getVersion()}).`,
    });
  }
});

autoUpdater.on('download-progress', (p) => {
  logInfo(`[updater] downloading ${Math.round(p.percent)}% (${Math.round(p.bytesPerSecond/1024)} KB/s)`);
});

autoUpdater.on('update-downloaded', (info) => {
  logInfo(`[updater] update downloaded: ${info && info.version}`);
  updateDownloaded = true;
  downloadStarted = false;
  lastUpdateError = null;
  if (tray) tray.setContextMenu(buildTrayMenu());

  dialog.showMessageBox({
    type: 'info',
    title: 'Update ready',
    message: `Solutions VOD Tools ${info.version} is ready to install`,
    detail: 'Restart now to apply the update? You can also choose Later and install via the tray menu when convenient.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
});

// Treat "no published release yet" as up-to-date instead of as an error.
// Covers the chicken-and-egg moment between shipping vN.0.0 and vN.0.1, and
// any time GitHub returns 404 on the /releases/latest endpoint.
function isNoReleaseYetError(err) {
  const msg = (err && err.message) || String(err || '');
  return /Cannot find latest\.yml|HttpError: 404|status: 404|404 Not Found/i.test(msg);
}

// Manual check from tray menu / settings — relies on the events above for feedback,
// since checkForUpdates() resolves before download/error events fire.
async function checkForUpdatesManually() {
  if (manualCheckInProgress) {
    console.log('[updater] manual check already in progress, ignoring');
    return;
  }
  manualCheckInProgress = true;
  console.log('[updater] manual check requested');
  try {
    await autoUpdater.checkForUpdates();
    // Don't show any dialog here — the update-available / update-not-available /
    // error event handlers above will do it. We just kick the check.
    // Safety timeout: if no event fires within 30s, surface that explicitly.
    setTimeout(() => {
      if (manualCheckInProgress) {
        manualCheckInProgress = false;
        dialog.showErrorBox(
          'Update check timed out',
          'No response from GitHub within 30 seconds. Check your internet connection and try again.',
        );
      }
    }, 30000);
  } catch (err) {
    manualCheckInProgress = false;
    if (isNoReleaseYetError(err)) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Up to date',
        message: `You're on the latest version (${app.getVersion()}).`,
      });
    } else {
      dialog.showErrorBox('Update check failed', err.message || String(err));
    }
  }
}

// -------- Setup window (only shown on first run while binaries download) --------
function showSetupWindow() {
  if (setupWindow) return setupWindow;
  setupWindow = new BrowserWindow({
    width: 460,
    height: 220,
    icon: iconPath,
    title: 'Solutions VOD Tools — first-time setup',
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'setup', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'setup', 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
  return setupWindow;
}

function pushSetupProgress(msg) {
  if (setupWindow && setupWindow.webContents) {
    setupWindow.webContents.send('setup-progress', msg);
  }
}

// -------- IPC handlers (renderer → main) --------

// Window controls
ipcMain.on('win:minimize', () => { mainWindow?.minimize(); });
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => { mainWindow?.close(); });

// Settings
ipcMain.handle('settings:get', () => {
  const loginSettings = app.getLoginItemSettings();
  return {
    version:   app.getVersion(),
    outputDir,
    binDir,
    autostart: loginSettings.openAtLogin,
  };
});
ipcMain.handle('settings:set-autostart', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
  // Refresh tray menu so its "Run on startup" checkbox reflects the change
  if (tray) tray.setContextMenu(buildTrayMenu());
  return true;
});

// Open output folder / external links
ipcMain.on('open:output-folder', () => { shell.openPath(outputDir); });
ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});

// Updates
ipcMain.handle('updates:check', async () => {
  await checkForUpdatesManually();
  return true;
});

// -------- Cookies.txt import (for yt-dlp's --cookies flag) --------
// User exports a Netscape cookies.txt from their real browser via a free
// extension ("Get cookies.txt LOCALLY" / "cookies.txt") and imports it here.
// We validate the format and copy it into userData where yt-dlp can read it.
// Why not --cookies-from-browser? DPAPI / app-bound encryption on recent
// Chrome/Edge breaks that path. Why not embedded sign-in? Google blocks
// sign-ins from any embedded Chromium regardless of UA spoofing.

// Validate that a file looks like a Netscape cookies.txt:
//   - Either has the standard header line, OR
//   - Has at least one non-blank, non-comment line with 7 tab-separated fields
// We don't require Google domains specifically — yt-dlp uses cookies for any
// site, so a generic cookies.txt is fine for non-YouTube use too.
function looksLikeCookiesTxt(content) {
  if (typeof content !== 'string') return false;
  if (/^#\s*Netscape HTTP Cookie File/m.test(content)) return true;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length >= 7) return true;
  }
  return false;
}

ipcMain.handle('cookies:import', async () => {
  // Pop a native file picker. User exports cookies.txt from their browser
  // using a free extension (recommended in the Settings hint), then picks
  // the file here. We validate the format and copy it into userData where
  // yt-dlp can read it via --cookies.
  const result = await dialog.showOpenDialog(mainWindow || null, {
    title: 'Pick a cookies.txt file (Netscape format)',
    properties: ['openFile'],
    filters: [
      { name: 'Cookies file', extensions: ['txt', 'cookies'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  const sourcePath = result.filePaths[0];
  try {
    const content = await fs.promises.readFile(sourcePath, 'utf8');
    if (!looksLikeCookiesTxt(content)) {
      return { ok: false, error: 'That file does not look like a Netscape cookies.txt. Make sure you exported it with a "Get cookies.txt" browser extension.' };
    }
    const lineCount = content.split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.split('\t').length >= 7).length;
    await fs.promises.writeFile(cookiesFile, content, 'utf8');
    logInfo(`[cookies] imported ${lineCount} cookies from ${sourcePath}`);
    return { ok: true, count: lineCount, path: cookiesFile };
  } catch (err) {
    logError(`[cookies] import failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cookies:status', async () => {
  try {
    if (!fs.existsSync(cookiesFile)) return { exists: false };
    const stat = fs.statSync(cookiesFile);
    return {
      exists: true,
      savedAtMs: stat.mtimeMs,
      sizeBytes: stat.size,
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
});

ipcMain.handle('cookies:clear', async () => {
  try {
    if (fs.existsSync(cookiesFile)) fs.unlinkSync(cookiesFile);
  } catch (e) { /* ignore */ }
  return { ok: true };
});

// -------- Lifecycle --------
app.on('second-instance', showMainWindow);

// Don't auto-quit when all windows are closed — we live in the tray.
app.on('window-all-closed', (e) => {
  // No-op. Quit only via tray.
});

app.on('before-quit', () => { isQuitting = true; });

app.whenReady().then(async () => {
  createTray();

  // Default autostart ON for fresh installs (one-shot — respects later toggling).
  if (!fs.existsSync(flagFirstRun)) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    try { fs.writeFileSync(flagFirstRun, ''); } catch (e) { /* ignore */ }
  } else {
    // If autostart is currently enabled, refresh the registered EXE path on
    // every launch. This fixes a class of "won't auto-start" / "ghost
    // already-running" bugs where the autostart registry entry points at an
    // old install location (e.g. after a manual reinstall to a different
    // directory).
    const cur = app.getLoginItemSettings();
    if (cur.openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
      logInfo(`[boot] refreshed autostart entry for current exe path`);
    }
  }

  // Download yt-dlp + ffmpeg on first run (or after manual deletion).
  try {
    await ensureBinaries(
      binDir,
      pushSetupProgress,
      showSetupWindow,
    );
  } catch (err) {
    if (setupWindow) setupWindow.close();
    dialog.showErrorBox(
      'Setup failed',
      `Failed to download dependencies:\n\n${err.message}\n\nCheck your internet connection and restart the app.`,
    );
    app.quit();
    return;
  }
  if (setupWindow) {
    pushSetupProgress({ stage: 'done', message: 'Ready' });
    setTimeout(() => { if (setupWindow) setupWindow.close(); }, 600);
  }

  await startServer();

  // Kick off an update check in the background. If we're in dev mode
  // (running via `npm start`, not a packaged build), electron-updater logs
  // a warning and no-ops, which is fine.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      // Background-check errors are deliberately silent — we only surface
      // updater problems when the user explicitly clicks "Check for updates".
      // The most common case is "no release published yet" (404), which is
      // not actually a problem.
      console.error('[updater] background check failed:', err && err.message);
    });
  }, 5000);

  // If we were launched at login (via openAsHidden), don't pop a window —
  // the user wants this running quietly in the background.
  const launchInfo = app.getLoginItemSettings();
  if (!launchInfo.wasOpenedAtLogin) {
    createMainWindow();
  }
});

app.on('will-quit', async (e) => {
  if (serverHandle) {
    e.preventDefault();
    await stopServer();
    app.exit(0);
  }
});
