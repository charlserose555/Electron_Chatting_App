const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  startHost: (args) => ipcRenderer.invoke('desktop:start-host', args),
  stopHost: () => ipcRenderer.invoke('desktop:stop-host'),
  notify: (args) => ipcRenderer.invoke('desktop:notify', args),
  onOpenFileDialog: () => ipcRenderer.invoke('desktop:open-file-dialog'),

  onNavigateToChat: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:navigate-to-chat', handler);
    return () => ipcRenderer.removeListener('desktop:navigate-to-chat', handler);
  }
});