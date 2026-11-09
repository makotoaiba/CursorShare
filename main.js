// CursorShare アプリ版（Electron）
// ・内蔵サーバーを起動してホスト画面を開く
// ・共有中の画面に、参加者のカーソル等を重ねる透明ウィンドウ（デスクトップ表示）を出す
//   このウィンドウはクリックを素通りさせ、画面共有の映像には映らない

const { app, BrowserWindow, session, desktopCapturer, ipcMain, screen, Menu } = require('electron');
const path = require('path');

// 設定ファイルと cloudflared.exe は exe と同じフォルダから読む
process.env.CURSORSHARE_BASE = app.isPackaged ? path.dirname(process.execPath) : __dirname;

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
      width: 1280,
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
    Menu.setApplicationMenu(null);

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
      if (pick.audio && process.platform === 'win32') res.audio = 'loopback'; // PCで鳴っている音
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
