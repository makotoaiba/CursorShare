// ホスト画面にだけ渡すアプリ機能
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cursorShareApp', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  chooseSource: (id, audio) => ipcRenderer.invoke('choose-source', id, audio),
  shareStarted: () => ipcRenderer.send('share-started'),
  shareStopped: () => ipcRenderer.send('share-stopped'),
  setOverlay: (on) => ipcRenderer.invoke('set-overlay', on),
  platform: process.platform,
  screenAccess: () => ipcRenderer.invoke('screen-access'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  relaunch: () => ipcRenderer.invoke('relaunch'),
});
