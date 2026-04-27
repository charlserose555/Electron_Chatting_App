const { app, BrowserWindow, ipcMain, shell, Notification, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

let mainWindow;
let lanServer;

function getLanAddresses(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const [name, records] of Object.entries(interfaces)) {
    if (!records) continue;
    for (const record of records) {
      if (record.family === 'IPv4' && !record.internal) {
        urls.push(`http://${record.address}:${port}`);
      }
    }
  }
  return urls;
}

async function ensureServerModule() {
  const file = path.join(app.getAppPath(), 'server', 'createServer.cjs');
  return require(file);
}

async function startHostInternal(port) {
  if (lanServer) {
    return { serverUrl: `http://127.0.0.1:${lanServer.port}`, addresses: getLanAddresses(lanServer.port) };
  }
  const mod = await ensureServerModule();
  lanServer = mod.createLanServer({
    port,
    userDataPath: app.getPath('userData')
  });
  await lanServer.start('0.0.0.0');
  return {
    serverUrl: `http://127.0.0.1:${lanServer.port}`,
    addresses: getLanAddresses(lanServer.port)
  };
}

async function stopHostInternal() {
  if (lanServer) {
    await lanServer.stop();
    lanServer = null;
  }
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 920,
    minWidth: 1280,
    minHeight: 760,
    backgroundColor: '#07162b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'client', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('desktop:get-config', () => ({
    platform: process.platform,
    appVersion: app.getVersion()
  }));

  ipcMain.handle('desktop:start-host', async (_event, args) => {
    return await startHostInternal(Number(args?.port || 4000));
  });

  ipcMain.handle('desktop:stop-host', async () => {
    await stopHostInternal();
  });

  ipcMain.handle('desktop:notify', async (_event, args) => {
    if (!Notification.isSupported()) return;
  
    const n = new Notification({
      title: args.title,
      body: args.body
    });
  
    n.on('click', () => {
      if (!mainWindow) return;
  
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
  
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
  
      mainWindow.focus();
  
      if (args.userId) {
        mainWindow.webContents.send('desktop:navigate-to-chat', {
          userId: args.userId,
          kind: args.kind || 'message'
        });
      }
    });
  
    n.show();
  });

  ipcMain.handle('app:set-badge-count', async (_event, count) => {
    if (app.setBadgeCount) {
      app.setBadgeCount(count);
    }
  });

  ipcMain.handle('desktop:open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images and Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'zip'] }
      ]
    });
    if (result.canceled) return null;
    return result.filePaths;
  });

  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  await stopHostInternal();
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});
