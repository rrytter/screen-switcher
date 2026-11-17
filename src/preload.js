const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  hardware: () => ipcRenderer.invoke('hardware'),
  apply: (id) => ipcRenderer.invoke('apply', id),
  save: (patch) => ipcRenderer.invoke('save', patch),
  autostart: (on) => ipcRenderer.invoke('autostart', on),
  capture: (on) => ipcRenderer.invoke('capture', on),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onHardware: (cb) => ipcRenderer.on('hardware', (_e, h) => cb(h)),
});
