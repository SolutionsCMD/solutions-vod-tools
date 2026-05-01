// Preload for the main window. Exposes a small, audited API to the renderer.
// Renderer cannot require() Node modules directly — everything goes through here.

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // Window controls
  windowMinimize:        () => ipcRenderer.send('win:minimize'),
  windowToggleMaximize:  () => ipcRenderer.send('win:toggle-maximize'),
  windowClose:           () => ipcRenderer.send('win:close'),

  // Settings
  getSettings:           () => ipcRenderer.invoke('settings:get'),
  setAutostart:          (enabled) => ipcRenderer.invoke('settings:set-autostart', !!enabled),

  // Actions
  openOutputFolder:      () => ipcRenderer.send('open:output-folder'),
  openExternal:          (url) => ipcRenderer.send('open:external', url),
  checkForUpdates:       () => ipcRenderer.invoke('updates:check'),
});
