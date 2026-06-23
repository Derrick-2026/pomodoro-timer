const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');

const NOTIFICATION_MESSAGES = {
  work:  { title: '专注完成！', body: '很棒！休息一下吧 ☕' },
  short: { title: '短休息结束', body: '继续加油！🍅' },
  long:  { title: '长休息结束', body: '元气满满，继续专注！💪' },
};
const notificationsSupported = Notification.isSupported();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    resizable: false,
    frame: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, 'icon.icns'),
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

ipcMain.on('timer-complete', (event, type) => {
  if (!notificationsSupported) return;
  const msg = NOTIFICATION_MESSAGES[type] || NOTIFICATION_MESSAGES.work;
  new Notification({ title: msg.title, body: msg.body }).show();
});

ipcMain.on('window-close', () => app.quit());
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
