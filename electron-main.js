// Electron 主进程
import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 51735;

// v1.0 Task 1.3: electron-updater 自动更新（动态 import 失败时静默 disable）
let autoUpdater = null;
async function initAutoUpdater() {
  try {
    const m = await import('electron-updater');
    autoUpdater = m.autoUpdater || (m.default && m.default.autoUpdater);
    if (!autoUpdater) return;
    autoUpdater.autoDownload = false;            // 询问用户再下载
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (err) => console.error('[updater]', err?.message));
    autoUpdater.on('update-available', async (info) => {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `Roundtable ${info.version} 已发布`,
        detail: '点击「立即下载」开始更新（下载完成后下次启动自动安装）',
      });
      if (r.response === 0) autoUpdater.downloadUpdate();
    });
    autoUpdater.on('update-downloaded', async (info) => {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即重启', '退出时安装'],
        defaultId: 0,
        title: '更新已下载',
        message: `Roundtable ${info.version} 已下载`,
        detail: '需重启 panel 完成安装',
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    });
    // 启动后 3s 静默检查
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  } catch (e) {
    console.warn('[electron-updater] 加载失败，自动更新关闭:', e.message);
  }
}

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
    title: 'Roundtable',
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
  // v1.0 Task 1.3: 启动自动更新
  initAutoUpdater().catch(() => {});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Roundtable', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: '检查更新', click: () => autoUpdater?.checkForUpdates().catch(() => {}) },
      { type: 'separator' },
      { role: 'quit' }
    ]},
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (serverProcess) try { serverProcess.kill('SIGTERM'); } catch {} });
