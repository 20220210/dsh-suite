const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('barApi', {
  call: (action) => ipcRenderer.send('dsh-webapp-bar', action),
});
