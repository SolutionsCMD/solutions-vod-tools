# Solutions VOD Tools

Desktop app for downloading, recording, trimming, and stitching Kick VODs.

Wraps the existing kick-vod-tools Express server in an Electron shell — same UI
in a native window, real Tray API, autostart-on-login, NSIS installer.

## For end users

Download `Solutions VOD Tools Setup X.Y.Z.exe`, double-click, follow the wizard.

On first launch the app downloads yt-dlp and ffmpeg into `%APPDATA%\Solutions VOD Tools\bin\`
(~40 MB, one-time). VODs save to `%USERPROFILE%\Videos\Solutions VOD Tools\` by default.

The app lives in the system tray. Closing the window hides it; to actually quit,
right-click the tray icon → Quit. Run-on-startup is on by default — toggle it from
the same menu.

## For development

```
npm install
npm start
```

That boots Electron, which boots the Express server in-process and opens a window
pointed at `http://localhost:3847`.

## Building the installer

```
npm install
npm run build
```

Output: `dist/Solutions VOD Tools Setup 1.0.0.exe` (NSIS installer, ~80 MB
because Electron itself bundles Node and Chromium).

For a faster smoke-test build that doesn't pack into NSIS:

```
npm run build:dir
```

Produces an unpacked app in `dist/win-unpacked/` — useful for verifying the bundle
contents without waiting for installer compression.

## Project layout

```
solutions-vod-tools/
├── main.js                    # Electron main process (tray, window, lifecycle)
├── server/
│   └── server.js              # Express server, exports createServer({...})
├── public/
│   └── index.html             # The web UI (unchanged from kick-vod-tools)
├── setup/
│   ├── dependencies.js        # First-run downloader for yt-dlp + ffmpeg
│   ├── setup.html             # First-run progress window
│   └── preload.js             # IPC bridge for setup window
├── build/
│   └── icon.ico               # App icon (used by tray, taskbar, installer)
└── package.json               # Includes electron-builder NSIS config
```

## What changed vs kick-vod-tools

The Express server is the same code — it's wrapped in `createServer({...})` so
the Electron main process can boot it in-process instead of as a child shell job.
Hardcoded paths (`__dirname/vods`, `__dirname/bin`, `__dirname/live-watchers.json`)
become parameters; the Electron main supplies platform-correct locations:

| What             | kick-vod-tools                    | Solutions VOD Tools                                  |
| ---------------- | --------------------------------- | ---------------------------------------------------- |
| VOD output       | `kick-vod-tools/vods/`            | `%USERPROFILE%\Videos\Solutions VOD Tools\`          |
| yt-dlp / ffmpeg  | `kick-vod-tools/bin/`             | `%APPDATA%\Solutions VOD Tools\bin\`                 |
| Live state       | `kick-vod-tools/live-watchers.json` | `%APPDATA%\Solutions VOD Tools\live-watchers.json` |
| Process management | start.bat / tray.ps1             | Electron main process                                |
| Autostart        | Startup-folder shortcut           | `app.setLoginItemSettings({ openAtLogin: true })`    |
| First-run deps   | install-deps.bat (winget + curl)  | setup/dependencies.js (Node https + PowerShell unzip) |

The signal handlers (SIGINT/SIGTERM) and the auto-browser-open at the end of
the original `app.listen()` are removed — Electron owns the lifecycle now.

## Code signing

The build is currently unsigned. Windows SmartScreen will warn users on first
launch ("Windows protected your PC — More info → Run anyway"). To remove that:

1. Get a code-signing cert (sectigo / digicert / ssl.com — ~$200/yr for OV).
2. Add to `package.json` build config:
   ```json
   "win": {
     "certificateFile": "path/to/cert.pfx",
     "certificatePassword": "..."
   }
   ```
3. Or use environment variables `CSC_LINK` and `CSC_KEY_PASSWORD`.

## Auto-update (later)

`electron-builder` ships with `electron-updater`. Wiring it up needs:

1. A GitHub release with the installer attached.
2. `"publish": [{ "provider": "github", "owner": "SolutionsCMD", "repo": "solutions-vod-tools" }]`
   added to the build config.
3. A `checkForUpdatesAndNotify()` call in `main.js` after `app.whenReady()`.

Skipped for v1.
