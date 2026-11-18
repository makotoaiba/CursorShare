// CursorShare アプリ版（Electron）
// ・内蔵サーバーを起動してホスト画面を開く
// ・共有中の画面に、参加者のカーソル等を重ねる透明ウィンドウ（デスクトップ表示）を出す
//   このウィンドウはクリックを素通りさせ、画面共有の映像には映らない

const { app, BrowserWindow, session, desktopCapturer, ipcMain, screen, Menu, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';

if (!app.isPackaged) {
  process.env.CURSORSHARE_BASE = __dirname;
} else if (isMac) {
  // Mac：config.json は CursorShare.app と同じフォルダに置く（アプリの中は書き換えられないため）。
  // cloudflared はアプリの中（Contents/Resources）に同梱
  process.env.CURSORSHARE_BASE = path.resolve(process.execPath, '../../../..');
  const cf = path.join(process.resourcesPath, 'cloudflared');
  if (fs.existsSync(cf)) process.env.CURSORSHARE_CLOUDFLARED = cf;
} else {
  // Windows：設定ファイルと cloudflared.exe は exe と同じフォルダから読む
  process.env.CURSORSHARE_BASE = path.dirname(process.execPath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const server = require('./server.js');

  let port = 0;
  let hostWin = null;
  let overlay = null;
  let chosen = null; // { id, audio }
  let sharedDisplayId = null;
  let overlayEnabled = true;

  app.on('second-instance', () => {
    if (!hostWin) return;
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.focus();
  });

  function createHostWindow() {
    hostWin = new BrowserWindow({
      width: 1360,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: '#20242b',
      title: 'CursorShare',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false, // 最小化中も映像を送り続ける
      },
    });
    hostWin.loadURL(`http://localhost:${port}/host`);
    hostWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    hostWin.on('closed', () => {
      hostWin = null;
      app.quit();
    });
  }

  // ---------- デスクトップ表示 ----------
  function showOverlay() {
    hideOverlay();
    if (!overlayEnabled || !sharedDisplayId) return;
    const display = screen.getAllDisplays().find((d) => String(d.id) === sharedDisplayId) || screen.getPrimaryDisplay();
    const b = display.bounds;
    overlay = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { backgroundThrottling: false },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (isMac) overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // 全画面のアプリの上にも出す
    overlay.setIgnoreMouseEvents(true); // クリックは下のアプリへ
    overlay.setContentProtection(true); // 画面共有の映像に映り込まない
    overlay.loadURL(`http://localhost:${port}/overlay`);
    overlay.once('ready-to-show', () => {
      if (!overlay) return;
      overlay.setBounds(b); // DPIの異なるモニターでもぴったり合わせる
      overlay.showInactive();
    });
    overlay.on('closed', () => { overlay = null; });
  }

  function hideOverlay() {
    if (overlay) overlay.destroy();
    overlay = null;
  }


  // ---------- ホスト画面とのやりとり ----------
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 384, height: 216 },
    });
    const displays = screen.getAllDisplays();
    return sources
      .filter((s) => !(hostWin && s.id === hostWin.getMediaSourceId())) // 自分のウィンドウは除く
      .map((s, i) => ({
        id: s.id,
        isScreen: s.id.startsWith('screen:'),
        name: s.id.startsWith('screen:')
          ? `画面 ${displays.findIndex((d) => String(d.id) === s.display_id) + 1 || i + 1}`
          : s.name,
        displayId: s.display_id || null,
        thumbnail: s.thumbnail.toDataURL(),
      }));
  });

  // Mac：画面収録の許可の状態（granted / denied / restricted / not-determined）
  ipcMain.handle('screen-access', () => (isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted'));
  ipcMain.handle('open-screen-settings', () => {
    if (isMac) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  ipcMain.handle('relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('choose-source', (_e, id, audio) => {
    chosen = { id: String(id), audio: !!audio };
  });

  ipcMain.on('share-started', async () => {
    sharedDisplayId = null;
    if (chosen && chosen.id.startsWith('screen:')) {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find((s) => s.id === chosen.id);
      sharedDisplayId = src && src.display_id ? String(src.display_id) : String(screen.getPrimaryDisplay().id);
    }
    showOverlay();
  });

  ipcMain.on('share-stopped', () => {
    sharedDisplayId = null;
    hideOverlay();
  });

  ipcMain.handle('set-overlay', (_e, on) => {
    overlayEnabled = !!on;
    if (overlayEnabled) showOverlay();
    else hideOverlay();
  });

  app.whenReady().then(async () => {
    if (isMac) {
      // Mac はメニューバーが必須。コピー・貼り付け（⌘C / ⌘V）や終了（⌘Q）のために標準のメニューを付ける
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }

    // モニター構成や拡大率が変わったら合わせ直す
    screen.on('display-metrics-changed', () => { if (overlay) showOverlay(); });
    screen.on('display-removed', () => { if (overlay) showOverlay(); });

    // getDisplayMedia に、ホスト画面で選んだ画面/ウィンドウを渡す
    const deny = (callback) => { try { callback({}); } catch {} }; // 映像なしで返す＝共有の取り消し
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      const pick = chosen;
      if (!pick) return deny(callback);
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find((s) => s.id === pick.id);
      if (!src) return deny(callback);
      const res = { video: src };
      // PCで鳴っている音（Windows / macOS 13 以降。Mac では初回に「システムオーディオ録音」の許可が必要）
      if (pick.audio && (process.platform === 'win32' || isMac)) res.audio = 'loopback';
      callback(res);
    });

    port = await server.start();
    createHostWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    hideOverlay();
    server.stopTunnel();
  });
}
