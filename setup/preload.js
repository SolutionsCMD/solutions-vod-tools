// Preload for setup window. Exposes a tiny, safe API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onProgress: (handler) => {
    ipcRenderer.on('setup-progress', (_event, msg) => handler(msg));
  },
});
