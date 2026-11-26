const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('barApi', {
  refresh: () => ipcRenderer.send('dsh-webapp-bar', 'refresh'),
});
