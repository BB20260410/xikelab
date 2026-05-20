// Electron 主进程
import { app, BrowserWindow, Menu, shell } from 'electron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 51735;

let serverProcess = null;
let mainWindow = null;

function startServer() {
  serverProcess = spawn(process.execPath, [join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProcess.stderr.on('data', d => process.stderr.write('[server-err] ' + d));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F4F1EA',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    title: 'Claude Panel',
  });

  const tryLoad = (retries = 20) => {
    fetch(`http://localhost:${PORT}/api/sessions`)
      .then(() => mainWindow.loadURL(`http://localhost:${PORT}`))
      .catch(() => {
        if (retries > 0) setTimeout(() => tryLoad(retries - 1), 200);
        else mainWindow.loadURL(`data:text/html,Server%20启动失败`);
      });
  };
  tryLoad();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Claude Panel', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (serverProcess) try { serverProcess.kill('SIGTERM'); } catch {} });
