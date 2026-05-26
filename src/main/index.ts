import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { getAppPaths } from './paths';
import type { DatabaseWorkerClient } from './workerClient';

let workerClient: DatabaseWorkerClient | undefined;

function createWindow(): void {
  const paths = getAppPaths();
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1100,
    minHeight: 720,
    title: 'CorpusViewer Standard',
    backgroundColor: '#f7f8fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  workerClient = registerIpc(mainWindow, paths);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  workerClient?.close();
});
