const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  notify: (args) => ipcRenderer.invoke('desktop:notify', args),
  onOpenFileDialog: () => ipcRenderer.invoke('desktop:open-file-dialog'),
  setBadgeCount: (count) => ipcRenderer.invoke('app:set-badge-count', count),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  onWindowStateChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('window:state-changed', handler);
    return () => ipcRenderer.removeListener('window:state-changed', handler);
  },

  onNavigateToChat: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:navigate-to-chat', handler);
    return () => ipcRenderer.removeListener('desktop:navigate-to-chat', handler);
  }
});