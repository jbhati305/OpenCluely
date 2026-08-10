'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  report: (payload) => ipcRenderer.send('probe-result', payload)
});
