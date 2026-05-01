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

// -------- Single-instance lock --------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// -------- Paths --------
const PORT = 3847;
const APP_URL = `http://localhost:${PORT}`;

const userData   = app.getPath('userData');
const binDir     = path.join(userData, 'bin');
const stateFile  = path.join(userData, 'live-watchers.json');
const flagFirstRun = path.join(userData, '.first-run-done');
const outputDir  = path.join(app.getPath('videos'), 'Solutions VOD Tools');
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

// -------- Main window --------
function createMainWindow() {
  if (mainWindow) {
    showMainWindow();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    title: 'Solutions VOD Tools',
    backgroundColor: '#0a0a0a',
    show: false,
    autoHideMenuBar: true,
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
  return Menu.buildFromTemplate([
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
    { label: `Solutions VOD Tools v${app.getVersion()}`, enabled: false },
    { label: 'Quit', click: quitApp },
  ]);
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
    publicDir,
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
