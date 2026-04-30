const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  dialog,
  Tray,
  Menu,
  nativeImage
} = require('electron');
const path = require('node:path');

const APP_ID = 'com.lanchat.desktop';

let mainWindow;
let tray = null;
let isQuitting = false;

function getAssetPath(...parts) {
  return path.join(__dirname, 'assets', ...parts);
}

function getWindowIconPath() {
  if (process.platform === 'win32') {
    return getAssetPath('tray-icon.ico');
  }
  return getAssetPath('tray-icon.png');
}

function getTrayImage() {
  const candidates =
    process.platform === 'win32'
      ? [getAssetPath('tray-icon.ico'), getAssetPath('tray-icon.png')]
      : [getAssetPath('tray-icon.png')];

  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      return image;
    }
  }

  return nativeImage.createEmpty();
}

function emitWindowState() {
  if (!mainWindow) return;

  mainWindow.webContents.send('window:state-changed', {
    isMaximized: mainWindow.isMaximized()
  });
}

function showMainWindow() {
  if (!mainWindow) return;

  mainWindow.setSkipTaskbar(false);

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow) return;

  mainWindow.hide();
  mainWindow.setSkipTaskbar(true);
}

function quitAppFully() {
  isQuitting = true;

  if (tray) {
    tray.destroy();
    tray = null;
  }

  app.quit();
}

function createTray() {
  if (tray) return;

  const trayImage = getTrayImage();
  tray = new Tray(trayImage);
  tray.setToolTip('LAN Chat');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show app',
      click: () => {
        showMainWindow();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit app',
      click: () => {
        quitAppFully();
      }
    }
  ]);

  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (!mainWindow) return;

    if (mainWindow.isVisible()) {
      mainWindow.focus();
      return;
    }

    showMainWindow();
  });

  tray.on('double-click', () => {
    showMainWindow();
  });
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
    icon: getWindowIconPath(),
    frame: false,
    titleBarStyle: 'hidden',
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    emitWindowState();
  });

  mainWindow.on('maximize', emitWindowState);
  mainWindow.on('unmaximize', emitWindowState);
  mainWindow.on('enter-full-screen', emitWindowState);
  mainWindow.on('leave-full-screen', emitWindowState);

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    event.preventDefault();
    hideMainWindow();
  });

  const startUrl = process.env.ELECTRON_START_URL;

  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    await mainWindow.loadFile(
      path.join(app.getAppPath(), 'client', 'dist', 'index.html')
    );
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId(APP_ID);

  if (process.platform === 'darwin') {
    const dockIcon = getTrayImage();
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  ipcMain.handle('desktop:get-config', () => ({
    platform: process.platform,
    appVersion: app.getVersion()
  }));

  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return { isMaximized: false };

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }

    return { isMaximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', () => {
    if (!mainWindow) return;
    hideMainWindow();
  });

  ipcMain.handle('window:is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
  });

  ipcMain.handle('desktop:notify', async (_event, args) => {
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title: args.title,
      body: args.body
    });

    notification.on('click', () => {
      showMainWindow();

      if (args.userId && mainWindow) {
        mainWindow.webContents.send('desktop:navigate-to-chat', {
          userId: args.userId,
          kind: args.kind || 'message'
        });
      }
    });

    notification.show();
  });

  ipcMain.handle('app:set-badge-count', async (_event, count) => {
    if (typeof app.setBadgeCount === 'function') {
      app.setBadgeCount(count);
    }
  });

  ipcMain.handle('desktop:open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Images and Files',
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'gif',
            'webp',
            'pdf',
            'txt',
            'doc',
            'docx',
            'xls',
            'xlsx',
            'zip'
          ]
        }
      ]
    });

    if (result.canceled) return null;
    return result.filePaths;
  });

  await createMainWindow();
  createTray();

  app.on('activate', async () => {
    if (mainWindow) {
      showMainWindow();
      return;
    }

    await createMainWindow();
    createTray();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});